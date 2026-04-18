import { mkdirSync } from "node:fs";
import { MatrixClient, SimpleFsStorageProvider } from "matrix-bot-sdk";
import { db, getSecret, getSetting } from "../db.js";
import { bus } from "../bus.js";
import { openPullRequest } from "../git.js";
import { findTicketByMatrixThread, handleTicketReply } from "../tickets.js";
import { handleAdminCommand } from "../deploy/admin-commands.js";
import { getSelfProject } from "../self-project-query.js";
import type { ChatChannel } from "./index.js";

function isAdminRoom(roomId: string): boolean {
  if (getSetting("primary_channel") !== "matrix") return false;
  const self = getSelfProject();
  return !!self?.matrix_room_id && self.matrix_room_id === roomId;
}

const MATRIX_STORE_DIR = process.env.MATRIX_STORE_DIR ?? "/data/matrix-store";

type MatrixSettings = {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  spaceId: string;
  inviteUserId: string | null;
};

function readSettings(): MatrixSettings | null {
  const homeserverUrl = getSetting("matrix_homeserver_url");
  const userId = getSetting("matrix_user_id");
  const accessToken = getSecret("matrix_access_token");
  const spaceId = getSetting("matrix_space_id");
  const inviteUserId = getSetting("matrix_invite_user_id");
  if (!homeserverUrl || !userId || !accessToken || !spaceId) return null;
  return { homeserverUrl, userId, accessToken, spaceId, inviteUserId };
}

function serverNameOf(userOrRoomId: string): string {
  const idx = userOrRoomId.indexOf(":");
  return idx >= 0 ? userOrRoomId.slice(idx + 1) : "";
}

const POLICY_EMOJIS: Record<string, string> = {
  "1️⃣": "read-only",
  "2️⃣": "safe",
  "3️⃣": "dev",
  "4️⃣": "full-auto",
};

const PERM_EMOJIS: Record<string, "allow" | "allow_remember" | "deny"> = {
  "✅": "allow",
  "💾": "allow_remember",
  "❌": "deny",
};

let client: MatrixClient | null = null;
const pendingPerm = new Map<string, string>(); // eventId -> requestId
const pendingPolicy = new Map<string, string>(); // eventId -> projectId

function ensureStoreDir(): void {
  mkdirSync(MATRIX_STORE_DIR, { recursive: true });
}

function buildClient(s: MatrixSettings): MatrixClient {
  ensureStoreDir();
  const storage = new SimpleFsStorageProvider(`${MATRIX_STORE_DIR}/bot.json`);
  return new MatrixClient(s.homeserverUrl, s.accessToken, storage);
}

async function getRoomPolicy(roomId: string): Promise<{ projectId: string; policy: string } | null> {
  const row = db
    .prepare<[string], { id: string; policy: string }>(
      "SELECT id, policy FROM projects WHERE matrix_room_id = ?"
    )
    .get(roomId);
  return row ? { projectId: row.id, policy: row.policy } : null;
}

async function handleFreeText(roomId: string, body: string): Promise<void> {
  if (!body || body.startsWith("/")) return;
  const project = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM projects WHERE matrix_room_id = ?"
    )
    .get(roomId);
  if (!project) return;
  const worker = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM workers WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(project.id);
  if (!worker) {
    if (client) {
      await client.sendText(roomId, "Kein aktiver Worker in diesem Projekt.");
    }
    return;
  }
  bus.emit({
    type: "user_prompt",
    workerId: worker.id,
    projectId: project.id,
    text: body,
    origin: "matrix",
  });
}

async function handlePolicyCommand(roomId: string): Promise<void> {
  if (!client) return;
  const cur = await getRoomPolicy(roomId);
  if (!cur) return;
  const html =
    `🔧 <b>Policy</b> — aktuell: <code>${cur.policy}</code><br/>` +
    `1️⃣ read-only · 2️⃣ safe · 3️⃣ dev · 4️⃣ full-auto<br/>` +
    `<i>Auf das passende Emoji tippen.</i>`;
  const eventId = await client.sendHtmlText(roomId, html);
  pendingPolicy.set(eventId, cur.projectId);
  for (const emoji of Object.keys(POLICY_EMOJIS)) {
    try {
      await sendReaction(roomId, eventId, emoji);
    } catch {
      // ignore
    }
  }
}

async function handlePrCommand(roomId: string, title: string): Promise<void> {
  if (!client) return;
  const project = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM projects WHERE matrix_room_id = ?"
    )
    .get(roomId);
  if (!project) return;
  if (!title) {
    await client.sendText(roomId, "Nutzung: /pr <titel>");
    return;
  }
  try {
    const res = await openPullRequest(project.id, title);
    await client.sendHtmlText(
      roomId,
      `✅ PR #${res.number} erstellt: <a href="${res.url}">${res.url}</a><br/>` +
        `Neuer Branch: <code>${res.newBranch}</code>`
    );
  } catch (e) {
    await client.sendText(roomId, `❌ ${(e as Error).message}`);
  }
}

async function handleStopCommand(roomId: string): Promise<void> {
  const project = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM projects WHERE matrix_room_id = ?"
    )
    .get(roomId);
  if (!project) return;
  const worker = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM workers WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(project.id);
  if (!worker) return;
  bus.emit({
    type: "policy_changed",
    workerId: worker.id,
    projectId: project.id,
    policy: "__stop__",
  });
  if (client) await client.sendText(roomId, "Stop-Signal gesendet.");
}

async function sendReaction(
  roomId: string,
  eventId: string,
  emoji: string
): Promise<void> {
  if (!client) return;
  await client.sendEvent(roomId, "m.reaction", {
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: eventId,
      key: emoji,
    },
  });
}

function attachListeners(c: MatrixClient, botUserId: string): void {
  c.on("room.message", async (roomId: string, event: any) => {
    try {
      if (!event?.content) return;
      if (event.sender === botUserId) return;
      if (event.content.msgtype !== "m.text") return;
      const body: string = event.content.body ?? "";

      // Thread-Reply? → Ticket-Reply-Pfad
      const rel = event.content["m.relates_to"];
      if (rel?.rel_type === "m.thread" && rel.event_id) {
        const project = db
          .prepare<[string], { id: string }>(
            "SELECT id FROM projects WHERE matrix_room_id = ?"
          )
          .get(roomId);
        if (project) {
          const ticket = findTicketByMatrixThread(project.id, rel.event_id);
          if (ticket) {
            await handleTicketReply(ticket.id, body, "matrix");
            return;
          }
        }
      }

      if (body.startsWith("/") && isAdminRoom(roomId)) {
        const reply = await handleAdminCommand(body);
        if (reply && client) {
          await client.sendText(roomId, reply);
          return;
        }
      }

      if (body === "/policy") return handlePolicyCommand(roomId);
      if (body === "/stop") return handleStopCommand(roomId);
      if (body.startsWith("/pr ") || body === "/pr")
        return handlePrCommand(roomId, body.slice(3).trim());
      await handleFreeText(roomId, body);
    } catch (err) {
      console.error("[matrix] room.message handler error", err);
    }
  });

  c.on("room.event", async (roomId: string, event: any) => {
    try {
      if (event?.type !== "m.reaction") return;
      if (event.sender === botUserId) return;
      const rel = event.content?.["m.relates_to"];
      if (!rel || rel.rel_type !== "m.annotation") return;
      const targetId: string = rel.event_id;
      const key: string = rel.key;
      if (pendingPerm.has(targetId)) {
        const requestId = pendingPerm.get(targetId)!;
        const action = PERM_EMOJIS[key];
        if (!action) return;
        const allow = action === "allow" || action === "allow_remember";
        bus.emit({ type: "permission_resolved", requestId, allow });
        pendingPerm.delete(targetId);
        return;
      }
      if (pendingPolicy.has(targetId)) {
        const projectId = pendingPolicy.get(targetId)!;
        const policy = POLICY_EMOJIS[key];
        if (!policy) return;
        db.prepare("UPDATE projects SET policy = ?, updated_at = ? WHERE id = ?").run(
          policy,
          Date.now(),
          projectId
        );
        const worker = db
          .prepare<[string], { id: string }>(
            "SELECT id FROM workers WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
          )
          .get(projectId);
        if (worker) {
          bus.emit({
            type: "policy_changed",
            workerId: worker.id,
            projectId,
            policy,
          });
        }
        pendingPolicy.delete(targetId);
        if (client) {
          await client.sendText(roomId, `Policy gesetzt auf: ${policy}`);
        }
      }
    } catch (err) {
      console.error("[matrix] room.event handler error", err);
    }
  });

  c.on("room.invite", async (roomId: string) => {
    try {
      await c.joinRoom(roomId);
    } catch (err) {
      console.error(`[matrix] auto-join failed for ${roomId}`, err);
    }
  });
}

export const matrixChannel: ChatChannel & {
  createTicketThread: (
    roomId: string,
    ticketId: string,
    title: string,
    description: string | null,
    priority: number
  ) => Promise<string | null>;
  sendInThread: (
    roomId: string,
    threadRootEventId: string,
    text: string
  ) => Promise<string | null>;
} = {
  id: "matrix",

  isConfigured() {
    return readSettings() !== null;
  },

  async start() {
    if (client) {
      try {
        client.stop();
      } catch {
        // ignore
      }
      client = null;
    }
    const s = readSettings();
    if (!s) return;
    const c = buildClient(s);
    attachListeners(c, s.userId);
    try {
      await c.start();
      client = c;
      console.log("[matrix] bot started");
    } catch (err) {
      console.error("[matrix] start failed", err);
      client = null;
    }
  },

  async stop() {
    if (!client) return;
    try {
      client.stop();
    } catch {
      // ignore
    }
    client = null;
  },

  async sendTestMessage() {
    const s = readSettings();
    if (!s) return { ok: false, error: "Matrix nicht konfiguriert" };
    try {
      const probe = new MatrixClient(
        s.homeserverUrl,
        s.accessToken,
        new SimpleFsStorageProvider(`${MATRIX_STORE_DIR}/probe.json`)
      );
      const whoami = await probe.getUserId();
      if (whoami !== s.userId) {
        return {
          ok: false,
          error: `Token gehört zu ${whoami}, nicht zu ${s.userId}.`,
        };
      }
      await probe.getRoomStateEvent(s.spaceId, "m.room.create", "");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async createProjectChannel(_projectId, name) {
    if (!client) throw new Error("Matrix-Bot nicht gestartet");
    const s = readSettings();
    if (!s) throw new Error("Matrix nicht konfiguriert");
    const via = serverNameOf(s.spaceId);
    const invites = s.inviteUserId ? [s.inviteUserId] : [];
    const roomId = await client.createRoom({
      name: `📂 ${name}`,
      preset: "private_chat",
      visibility: "private",
      invite: invites,
      initial_state: [
        {
          type: "m.space.parent",
          state_key: s.spaceId,
          content: { canonical: true, via: via ? [via] : [] },
        },
      ],
    });
    try {
      await client.sendStateEvent(s.spaceId, "m.space.child", roomId, {
        via: via ? [via] : [],
        suggested: false,
      });
    } catch (err) {
      console.error(
        `[matrix] could not add ${roomId} as space-child of ${s.spaceId}`,
        err
      );
    }
    return roomId;
  },

  async deleteProjectChannel(ref) {
    if (!client) return;
    const s = readSettings();
    if (s) {
      try {
        await client.sendStateEvent(s.spaceId, "m.space.child", ref, {});
      } catch {
        // ignore
      }
    }
    try {
      await client.leaveRoom(ref);
    } catch {
      // ignore
    }
  },

  async renameProjectChannel(ref, newName) {
    if (!client) throw new Error("Matrix-Bot nicht gestartet");
    await client.sendStateEvent(ref, "m.room.name", "", {
      name: `📂 ${newName}`,
    });
  },

  async sendMessage(ref, text, opts = {}) {
    if (!client) throw new Error("Matrix-Bot nicht gestartet");
    if (opts.markdown) {
      await client.sendHtmlText(ref, markdownToHtml(text));
    } else {
      await client.sendText(ref, text);
    }
  },

  async sendPermissionRequest(ref, requestId, tool, summary) {
    if (!client) throw new Error("Matrix-Bot nicht gestartet");
    const html =
      `🔐 <b>Permission Request</b> — <code>${escapeHtml(tool)}</code><br/>` +
      `${markdownToHtml(summary)}<br/>` +
      `<i>✅ erlauben · 💾 erlauben + merken · ❌ ablehnen</i>`;
    const eventId = await client.sendHtmlText(ref, html);
    pendingPerm.set(eventId, requestId);
    for (const emoji of Object.keys(PERM_EMOJIS)) {
      try {
        await sendReaction(ref, eventId, emoji);
      } catch {
        // ignore
      }
    }
  },

  async createTicketThread(roomId, ticketId, title, description, priority) {
    if (!client) return null;
    const prioTag =
      priority <= 30 ? "🔴 hoch" : priority >= 70 ? "🟢 niedrig" : "🟡 mittel";
    const html =
      `🎫 <b>T-${escapeHtml(ticketId)}: ${escapeHtml(title)}</b> · <i>${prioTag}</i>` +
      (description ? `<br/>${markdownToHtml(description)}` : "");
    return await client.sendHtmlText(roomId, html);
  },

  async sendInThread(roomId, threadRootEventId, text) {
    if (!client) return null;
    return await client.sendEvent(roomId, "m.room.message", {
      msgtype: "m.text",
      body: text,
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: threadRootEventId,
      },
    });
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Minimal markdown-to-HTML: fenced code, inline code, bold, italic, line breaks.
function markdownToHtml(md: string): string {
  const codeBlocks: string[] = [];
  let s = md.replace(/```([\s\S]*?)```/g, (_m, body) => {
    codeBlocks.push(`<pre><code>${escapeHtml(body)}</code></pre>`);
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, (_m, body) => `<code>${body}</code>`);
  s = s.replace(/\*([^*]+)\*/g, (_m, body) => `<b>${body}</b>`);
  s = s.replace(/_([^_]+)_/g, (_m, body) => `<i>${body}</i>`);
  s = s.replace(/\n/g, "<br/>");
  s = s.replace(/\u0000CB(\d+)\u0000/g, (_m, idx) => codeBlocks[Number(idx)]);
  return s;
}

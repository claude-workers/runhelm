import { nanoid } from "nanoid";
import { db, getSetting } from "./db.js";
import { bus, type BusEvent } from "./bus.js";
import {
  removeContainer,
  startWorkerContainer,
  stopContainer,
  containerStatus,
} from "./docker.js";
import {
  addCollaborator,
  createRepo,
  deleteRepo,
  forkRepo,
  parseRepoRef,
} from "./github.js";
import { cloneInto, fetchInRepo, gitInRepo } from "./git.js";
import { resolveRepoHostPath, config } from "./config.js";
import {
  channels,
  parseChannels,
  refFor,
  type ChannelId,
} from "./channels/index.js";

export { openPullRequest } from "./git.js";

// ---------- project CRUD ----------

export type Policy = "read-only" | "safe" | "dev" | "full-auto";

export type Project = {
  id: string;
  slug: string;
  key: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  policy: Policy;
  tg_topic_id: number | null;
  matrix_room_id: string | null;
  channels: string; // JSON-encoded ChannelId[]
  upstream_repo: string | null; // "owner/name" of upstream; null for non-fork
  upstream_default_branch: string | null;
  current_branch: string | null;
  system_prompt: string | null;
  is_self: number; // 1 for the self-managed orchestrator project
  created_at: number;
  updated_at: number;
};

function normalizeKey(raw: string): string {
  return (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 3);
}

function generateUniqueKey(fromName: string): string {
  let base = normalizeKey(fromName);
  if (base.length < 3) base = (base + "XYZ").slice(0, 3);
  let candidate = base;
  let i = 1;
  while (db.prepare("SELECT 1 FROM projects WHERE key = ?").get(candidate)) {
    candidate = (base.slice(0, 2) + i).toUpperCase().slice(0, 3);
    i++;
    if (i > 999) {
      // extreme fallback
      candidate = Math.random().toString(36).slice(2, 5).toUpperCase();
      if (!db.prepare("SELECT 1 FROM projects WHERE key = ?").get(candidate))
        return candidate;
    }
  }
  return candidate;
}

export { generateUniqueKey, normalizeKey };

/** Concatenate global + project system-prompt addenda for the worker. */
export function effectiveSystemPrompt(p: Pick<Project, "system_prompt">): string {
  const global = (getSetting("global_system_prompt") ?? "").trim();
  const proj = (p.system_prompt ?? "").trim();
  return [global, proj].filter(Boolean).join("\n\n");
}

function projectChannels(p: Pick<Project, "channels">): ChannelId[] {
  return parseChannels(p.channels);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function listProjects(): Project[] {
  return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as Project[];
}

export function getProject(id: string): Project | null {
  return (
    (db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined) ??
    null
  );
}

export async function createProject(input: {
  name: string;
  description?: string;
  policy: Policy;
  channels?: ChannelId[];
  upstream?: string; // "owner/repo" or GitHub URL; if set → fork mode
}): Promise<Project> {
  const id = nanoid(12);
  let slug = slugify(input.name);
  if (!slug) slug = id;
  const collision = db
    .prepare("SELECT 1 FROM projects WHERE slug = ?")
    .get(slug);
  if (collision) slug = `${slug}-${id.slice(0, 4)}`;

  const selected: ChannelId[] = (input.channels ?? ["telegram"]).filter(
    (c) => channels[c]?.isConfigured()
  );
  if (selected.length === 0) {
    throw new Error(
      "Kein konfigurierter Chat-Channel ausgewählt (Telegram oder Matrix benötigt)."
    );
  }

  let repoUrl: string;
  let cloneUrl: string;
  let repoFullName: string;
  let upstreamFullName: string | null = null;
  let upstreamDefaultBranch: string | null = null;
  let currentBranch: string | null = null;

  if (input.upstream) {
    const { owner, repo } = parseRepoRef(input.upstream);
    const fork = await forkRepo(owner, repo);
    repoUrl = fork.url;
    cloneUrl = fork.clone_url;
    repoFullName = fork.full_name;
    upstreamFullName = `${owner}/${repo}`;
    upstreamDefaultBranch = fork.upstream_default_branch;
    currentBranch = `claude/work-${id.slice(0, 6)}`;
  } else {
    const repo = await createRepo(slug, input.description);
    repoUrl = repo.url;
    cloneUrl = repo.clone_url;
    repoFullName = repo.full_name;
  }

  const collaborators = (getSetting("github_collaborators") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const user of collaborators) {
    try {
      await addCollaborator(repoFullName, user, "admin");
    } catch (e) {
      console.error(`[github] addCollaborator ${user} -> ${repoFullName} failed`, e);
    }
  }

  let tgTopicId: number | null = null;
  let matrixRoomId: string | null = null;

  if (selected.includes("telegram")) {
    const ref = await channels.telegram.createProjectChannel(id, input.name);
    tgTopicId = Number(ref);
  }
  if (selected.includes("matrix")) {
    matrixRoomId = await channels.matrix.createProjectChannel(id, input.name);
  }

  await cloneInto(cloneUrl, slug);
  if (input.upstream && upstreamFullName) {
    await gitInRepo(slug, [
      "remote",
      "add",
      "upstream",
      `https://github.com/${upstreamFullName}.git`,
    ]);
    await fetchInRepo(slug, ["fetch", "upstream"]);
    await gitInRepo(slug, [
      "switch",
      "-c",
      currentBranch!,
      `upstream/${upstreamDefaultBranch}`,
    ]);
  }

  const now = Date.now();
  const key = generateUniqueKey(input.name);
  db.prepare(
    `INSERT INTO projects(id,slug,key,name,description,repo_url,policy,tg_topic_id,matrix_room_id,channels,upstream_repo,upstream_default_branch,current_branch,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    slug,
    key,
    input.name,
    input.description ?? null,
    repoUrl,
    input.policy,
    tgTopicId,
    matrixRoomId,
    JSON.stringify(selected),
    upstreamFullName,
    upstreamDefaultBranch,
    currentBranch,
    now,
    now
  );

  const created = getProject(id)!;
  const welcome = welcomeText(created);
  for (const ch of selected) {
    const ref = refFor(ch, created);
    if (!ref) continue;
    try {
      await channels[ch].sendMessage(ref, welcome, { markdown: true });
    } catch (err) {
      console.error(`[${ch}] welcome message failed`, err);
    }
  }

  return created;
}

function welcomeText(p: Project): string {
  const repo = p.repo_url ?? "—";
  const upstreamLine = p.upstream_repo
    ? `Fork von: https://github.com/${p.upstream_repo}\nBranch: \`${p.current_branch ?? "?"}\`\n`
    : "";
  return (
    `🚀 Projekt *${p.name}* bereit.\n` +
    `Repo: ${repo}\n` +
    upstreamLine +
    `Policy: \`${p.policy}\`\n\n` +
    `Schreib eine Nachricht, um einen Turn zu starten.`
  );
}


export async function deleteProject(id: string, alsoDeleteRepo = false): Promise<void> {
  const p = getProject(id);
  if (!p) return;
  if (p.is_self) {
    throw new Error("Orchestrator-Self-Projekt kann nicht gelöscht werden.");
  }

  const workers = db
    .prepare<[string], Worker>("SELECT * FROM workers WHERE project_id = ?")
    .all(id) as Worker[];
  for (const w of workers) {
    await stopWorker(w.id);
  }

  const activeChannels = projectChannels(p);
  for (const ch of activeChannels) {
    const ref = refFor(ch, p);
    if (!ref) continue;
    try {
      await channels[ch].deleteProjectChannel(ref);
    } catch (err) {
      console.error(`[${ch}] deleteProjectChannel ${ref} failed`, err);
    }
  }
  if (alsoDeleteRepo && p.repo_url) {
    const full = p.repo_url.replace(/^https:\/\/github\.com\//, "");
    try {
      await deleteRepo(full);
    } catch {
      // ignore — PAT may lack delete_repo scope
    }
  }
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export async function updateProject(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    policy?: Policy;
    channels?: ChannelId[];
    deleteRefs?: Partial<Record<ChannelId, boolean>>;
    system_prompt?: string | null;
    key?: string;
  }
): Promise<Project> {
  const p = getProject(id);
  if (!p) throw new Error("project not found");

  const nextName = patch.name?.trim() || p.name;
  const nextDescription =
    patch.description === undefined ? p.description : patch.description;
  const nextPolicy: Policy = patch.policy ?? p.policy;
  const nextSystemPrompt =
    patch.system_prompt === undefined
      ? p.system_prompt
      : (patch.system_prompt?.trim() || null);
  let nextKey = p.key;
  if (patch.key !== undefined) {
    const normalized = normalizeKey(patch.key);
    if (normalized.length !== 3)
      throw new Error("Key muss genau 3 Zeichen (A-Z / 0-9) haben");
    if (normalized !== p.key) {
      const collision = db
        .prepare("SELECT 1 FROM projects WHERE key = ? AND id != ?")
        .get(normalized, id);
      if (collision) throw new Error(`Key "${normalized}" ist bereits vergeben`);
      nextKey = normalized;
    }
  }
  if (!["read-only", "safe", "dev", "full-auto"].includes(nextPolicy)) {
    throw new Error(`invalid policy: ${nextPolicy}`);
  }

  const current = projectChannels(p);
  let nextChannels = current;
  let toAdd: ChannelId[] = [];
  let toRemove: ChannelId[] = [];

  if (patch.channels) {
    const unique = Array.from(new Set(patch.channels));
    if (unique.length === 0) throw new Error("mindestens ein Kanal erforderlich");
    for (const c of unique) {
      if (c !== "telegram" && c !== "matrix") throw new Error(`unknown channel: ${c}`);
    }
    toAdd = unique.filter((c) => !current.includes(c));
    toRemove = current.filter((c) => !unique.includes(c));
    for (const c of toAdd) {
      if (!channels[c].isConfigured()) {
        throw new Error(`${c} nicht konfiguriert`);
      }
    }
    nextChannels = unique;
  }

  let tgTopicId: number | null = p.tg_topic_id;
  let matrixRoomId: string | null = p.matrix_room_id;

  for (const c of toAdd) {
    const ref = await channels[c].createProjectChannel(p.id, nextName);
    if (c === "telegram") tgTopicId = Number(ref);
    else matrixRoomId = ref;
  }

  const deleteRefs = patch.deleteRefs ?? {};
  for (const c of toRemove) {
    const shouldDelete = deleteRefs[c] !== false;
    if (shouldDelete) {
      const ref = refFor(c, p);
      if (ref) {
        try {
          await channels[c].deleteProjectChannel(ref);
        } catch (err) {
          console.error(`[${c}] deleteProjectChannel ${ref} failed`, err);
        }
      }
    }
    if (c === "telegram") tgTopicId = null;
    else matrixRoomId = null;
  }

  const renamed = nextName !== p.name;
  if (renamed) {
    const keptChannels = nextChannels.filter((c) => !toAdd.includes(c));
    for (const c of keptChannels) {
      const ref =
        c === "telegram"
          ? tgTopicId != null
            ? String(tgTopicId)
            : null
          : matrixRoomId;
      if (!ref) continue;
      try {
        await channels[c].renameProjectChannel(ref, nextName);
      } catch (err) {
        console.error(`[${c}] renameProjectChannel failed`, err);
      }
    }
  }

  const now = Date.now();
  db.prepare(
    `UPDATE projects
        SET name = ?, description = ?, policy = ?,
            tg_topic_id = ?, matrix_room_id = ?, channels = ?,
            system_prompt = ?, key = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    nextName,
    nextDescription,
    nextPolicy,
    tgTopicId,
    matrixRoomId,
    JSON.stringify(nextChannels),
    nextSystemPrompt,
    nextKey,
    now,
    id
  );

  const updated = getProject(id)!;

  if (nextPolicy !== p.policy) {
    const worker = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM workers WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(id);
    if (worker) {
      bus.emit({
        type: "policy_changed",
        workerId: worker.id,
        projectId: id,
        policy: nextPolicy,
      });
    }
  }

  if (toAdd.length > 0) {
    const welcome = welcomeText(updated);
    for (const c of toAdd) {
      const ref = refFor(c, updated);
      if (!ref) continue;
      try {
        await channels[c].sendMessage(ref, welcome, { markdown: true });
      } catch (err) {
        console.error(`[${c}] welcome message failed`, err);
      }
    }
  }

  return updated;
}

// ---------- worker lifecycle ----------

export type WorkerStatus =
  | "starting"
  | "idle"
  | "running"
  | "waiting_permission"
  | "error"
  | "stopped";

export type Worker = {
  id: string;
  project_id: string;
  container_id: string | null;
  status: WorkerStatus;
  session_id: string | null;
  last_seen: number | null;
  created_at: number;
};

export function listWorkers(projectId?: string): Worker[] {
  if (projectId) {
    return db
      .prepare("SELECT * FROM workers WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as Worker[];
  }
  return db.prepare("SELECT * FROM workers ORDER BY created_at DESC").all() as Worker[];
}

export function getWorker(id: string): Worker | null {
  return (
    (db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as Worker | undefined) ??
    null
  );
}

export async function startWorker(projectId: string): Promise<Worker> {
  const project = getProject(projectId);
  if (!project) throw new Error("project not found");

  // reuse existing running worker if any
  const existing = db
    .prepare<[string], Worker>(
      "SELECT * FROM workers WHERE project_id = ? AND status NOT IN ('stopped','error')"
    )
    .get(projectId) as Worker | undefined;
  if (existing) return existing;

  const id = nanoid(12);
  db.prepare(
    `INSERT INTO workers(id,project_id,status,created_at) VALUES(?,?,?,?)`
  ).run(id, projectId, "starting", Date.now());

  try {
    const cid = await startWorkerContainer({
      workerId: id,
      projectId,
      projectSlug: project.slug,
      policy: project.policy,
      tgTopicId: project.tg_topic_id,
      systemPrompt: effectiveSystemPrompt(project),
    });
    db.prepare("UPDATE workers SET container_id = ? WHERE id = ?").run(cid, id);
  } catch (e) {
    db.prepare("UPDATE workers SET status = 'error' WHERE id = ?").run(id);
    throw e;
  }
  return getWorker(id)!;
}

export async function stopWorker(id: string): Promise<void> {
  const w = getWorker(id);
  if (!w) return;
  sendToWorker(id, { type: "stop" });
  if (w.container_id) {
    await stopContainer(w.container_id);
    await removeContainer(w.container_id);
  }
  db.prepare("UPDATE workers SET status = 'stopped' WHERE id = ?").run(id);
}

export async function restartWorker(id: string): Promise<void> {
  const w = getWorker(id);
  if (!w) return;
  await stopWorker(id);
  await startWorker(w.project_id);
}

// ---------- WS registry ----------

type Sink = (payload: unknown) => void;
const workerSinks = new Map<string, Sink>();

export function registerWorkerSink(workerId: string, sink: Sink): () => void {
  workerSinks.set(workerId, sink);
  db.prepare("UPDATE workers SET last_seen = ? WHERE id = ?").run(Date.now(), workerId);
  return () => {
    if (workerSinks.get(workerId) === sink) workerSinks.delete(workerId);
  };
}

export function sendToWorker(workerId: string, payload: unknown): boolean {
  const sink = workerSinks.get(workerId);
  if (!sink) return false;
  sink(payload);
  return true;
}

export function handleWorkerMessage(workerId: string, msg: any): void {
  const w = getWorker(workerId);
  if (!w) return;
  switch (msg.type) {
    case "hello":
      db.prepare("UPDATE workers SET status = 'idle', last_seen = ? WHERE id = ?").run(
        Date.now(),
        workerId
      );
      bus.emit({
        type: "worker_status",
        workerId,
        projectId: w.project_id,
        status: "idle",
      });
      break;
    case "status":
      db.prepare("UPDATE workers SET status = ?, last_seen = ? WHERE id = ?").run(
        msg.status,
        Date.now(),
        workerId
      );
      bus.emit({
        type: "worker_status",
        workerId,
        projectId: w.project_id,
        status: msg.status,
      });
      break;
    case "log":
      bus.emit({
        type: "worker_log",
        workerId,
        projectId: w.project_id,
        line: msg.line,
      });
      break;
    case "message":
      bus.emit({
        type: "worker_message",
        workerId,
        projectId: w.project_id,
        role: msg.role,
        text: msg.text,
      });
      break;
    case "permission_request":
      bus.emit({
        type: "permission_request",
        workerId,
        projectId: w.project_id,
        requestId: msg.requestId,
        tool: msg.tool,
        input: msg.input,
      });
      break;
    case "session":
      if (msg.session_id) {
        db.prepare("UPDATE workers SET session_id = ? WHERE id = ?").run(
          msg.session_id,
          workerId
        );
      }
      break;
  }
}

// ---------- bus bridging: worker/telegram ----------

bus.on(async (e: BusEvent) => {
  try {
    await bridge(e);
  } catch (err) {
    console.error("[bus] bridge error", err);
  }
});

async function fanOut(
  project: Project,
  send: (ch: ChannelId, ref: string) => Promise<void>
): Promise<void> {
  for (const ch of projectChannels(project)) {
    const ref = refFor(ch, project);
    if (!ref) continue;
    try {
      await send(ch, ref);
    } catch (err) {
      console.error(`[${ch}] fan-out failed`, err);
    }
  }
}

async function bridge(e: BusEvent): Promise<void> {
  if (e.type === "permission_request") {
    const project = getProject(e.projectId);
    if (!project) return;
    const summary = formatToolInput(e.tool, e.input);
    await fanOut(project, (ch, ref) =>
      channels[ch].sendPermissionRequest(ref, e.requestId, e.tool, summary)
    );
    return;
  }

  if (e.type === "permission_resolved") {
    for (const [wid] of workerSinks) {
      sendToWorker(wid, {
        type: "permission_resolved",
        requestId: e.requestId,
        allow: e.allow,
        note: e.note,
      });
    }
    return;
  }

  if (e.type === "user_prompt") {
    sendToWorker(e.workerId, { type: "user_prompt", text: e.text });
    if (e.origin === "scheduler") return; // ticket prompts: no channel echo
    if (e.origin === "ui") return; // UI is its own channel, don't fan out
    const project = getProject(e.projectId);
    if (project) {
      const others = projectChannels(project).filter((c) => c !== e.origin);
      for (const ch of others) {
        const ref = refFor(ch, project);
        if (!ref) continue;
        try {
          await channels[ch].sendMessage(ref, `👤 ${e.text}`);
        } catch (err) {
          console.error(`[${ch}] echo user prompt failed`, err);
        }
      }
    }
    return;
  }

  if (e.type === "policy_changed") {
    if (e.policy === "__stop__") {
      await stopWorker(e.workerId);
      return;
    }
    sendToWorker(e.workerId, { type: "policy", policy: e.policy });
    return;
  }

  if (e.type === "worker_message") {
    if (e.role !== "assistant") return;
    // if a ticket is active, assistant output goes into the ticket thread
    // (handled by scheduler.addComment) — do NOT also fan out to channels
    const hasActive = db
      .prepare(
        "SELECT 1 FROM tickets WHERE project_id = ? AND status = 'in_progress' LIMIT 1"
      )
      .get(e.projectId);
    if (hasActive) return;
    if (!e.text.includes("?")) return;
    const project = getProject(e.projectId);
    if (!project) return;
    await fanOut(project, (ch, ref) => channels[ch].sendMessage(ref, e.text));
  }
}

function formatToolInput(tool: string, input: unknown): string {
  try {
    const obj = input as Record<string, unknown>;
    switch (tool) {
      case "Bash":
        return "```\n" + String(obj.command ?? "") + "\n```";
      case "Write":
      case "Edit":
        return `Datei: \`${obj.file_path ?? "?"}\``;
      case "Read":
        return `Datei: \`${obj.file_path ?? "?"}\``;
      default:
        return "```\n" + JSON.stringify(obj, null, 2).slice(0, 1500) + "\n```";
    }
  } catch {
    return String(input).slice(0, 1500);
  }
}

// ---------- status reconciliation on boot ----------

export async function reconcileOnBoot(): Promise<void> {
  const workers = db
    .prepare<[], Worker>("SELECT * FROM workers WHERE container_id IS NOT NULL")
    .all() as Worker[];
  for (const w of workers) {
    if (!w.container_id) continue;
    const s = await containerStatus(w.container_id);
    if (s === "running") {
      // supervisor will re-hello when it reconnects
      continue;
    }
    db.prepare("UPDATE workers SET status = 'stopped' WHERE id = ?").run(w.id);
  }
}

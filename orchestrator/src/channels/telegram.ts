import { Bot, InlineKeyboard } from "grammy";
import { db, getSecret, getSetting, setSetting } from "../db.js";
import { bus } from "../bus.js";
import { openPullRequest } from "../git.js";
import { handleAdminCommand } from "../deploy/admin-commands.js";
import type { ChatChannel } from "./index.js";

let bot: Bot | null = null;

function getChatId(): number {
  const raw = getSetting("telegram_chat_id");
  if (!raw) throw new Error("Telegram chat_id not set");
  return Number(raw);
}

async function restartBot(): Promise<void> {
  if (bot) {
    try {
      await bot.stop();
    } catch {
      // ignore
    }
    bot = null;
  }
  const token = getSecret("telegram_token");
  if (!token) return;

  const b = new Bot(token);

  b.command("start", (ctx) => {
    return ctx.reply(
      "Claude-Orchestrator verbunden. Diese Gruppe wird für Worker-Topics genutzt."
    );
  });

  b.on("message:text", async (ctx) => {
    const msg = ctx.message;
    // Admin commands live at the root of the supergroup (no thread), and only
    // when Telegram is the configured primary channel.
    if (!msg.message_thread_id) {
      if (getSetting("primary_channel") !== "telegram") return;
      if (!msg.text.startsWith("/")) return;
      try {
        const reply = await handleAdminCommand(msg.text);
        if (reply) await ctx.reply(reply, { parse_mode: "Markdown" });
      } catch (err) {
        console.error("[telegram] admin command failed", err);
      }
      return;
    }
    if (msg.text.startsWith("/")) return;
    const project = db
      .prepare<[number], { id: string }>(
        "SELECT id FROM projects WHERE tg_topic_id = ?"
      )
      .get(msg.message_thread_id);
    if (!project) return;
    const worker = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM workers WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(project.id);
    if (!worker) {
      await ctx.reply("Kein aktiver Worker in diesem Projekt.", {
        message_thread_id: msg.message_thread_id,
      });
      return;
    }
    bus.emit({
      type: "user_prompt",
      workerId: worker.id,
      projectId: project.id,
      text: msg.text,
      origin: "telegram",
    });
  });

  b.command("policy", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const row = db
      .prepare<[number], { id: string; policy: string }>(
        "SELECT id, policy FROM projects WHERE tg_topic_id = ?"
      )
      .get(threadId);
    if (!row) return;
    const kb = new InlineKeyboard()
      .text("read-only", `pol:${row.id}:read-only`)
      .text("safe", `pol:${row.id}:safe`)
      .row()
      .text("dev", `pol:${row.id}:dev`)
      .text("full-auto", `pol:${row.id}:full-auto`);
    await ctx.reply(`Aktuelle Policy: *${row.policy}*\n\nNeue Policy wählen:`, {
      parse_mode: "Markdown",
      message_thread_id: threadId,
      reply_markup: kb,
    });
  });

  b.command("pr", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const row = db
      .prepare<[number], { id: string }>(
        "SELECT id FROM projects WHERE tg_topic_id = ?"
      )
      .get(threadId);
    if (!row) return;
    const title = (ctx.match ?? "").trim();
    if (!title) {
      await ctx.reply("Nutzung: /pr <titel>", { message_thread_id: threadId });
      return;
    }
    try {
      const res = await openPullRequest(row.id, title);
      await ctx.reply(
        `✅ PR #${res.number} erstellt: ${res.url}\nNeuer Branch: ${res.newBranch}`,
        { message_thread_id: threadId }
      );
    } catch (e) {
      await ctx.reply(`❌ ${(e as Error).message}`, {
        message_thread_id: threadId,
      });
    }
  });

  b.command("stop", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;
    const row = db
      .prepare<[number], { id: string }>(
        "SELECT id FROM projects WHERE tg_topic_id = ?"
      )
      .get(threadId);
    if (!row) return;
    const worker = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM workers WHERE project_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(row.id);
    if (!worker) return;
    bus.emit({
      type: "policy_changed",
      workerId: worker.id,
      projectId: row.id,
      policy: "__stop__",
    });
    await ctx.reply("Stop-Signal gesendet.", { message_thread_id: threadId });
  });

  b.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("perm:")) {
      const [, requestId, action, ...rest] = data.split(":");
      const allow = action === "allow" || action === "allow_remember";
      const note = rest.join(":") || undefined;
      bus.emit({
        type: "permission_resolved",
        requestId,
        allow,
        note,
      });
      await ctx.answerCallbackQuery({
        text: allow ? "✅ erlaubt" : "❌ abgelehnt",
      });
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // ignore
      }
      return;
    }
    if (data.startsWith("pol:")) {
      const [, projectId, policy] = data.split(":");
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
      await ctx.answerCallbackQuery({ text: `Policy: ${policy}` });
      try {
        await ctx.editMessageText(`Policy gesetzt auf: *${policy}*`, {
          parse_mode: "Markdown",
        });
      } catch {
        // ignore
      }
      return;
    }
  });

  await b.init();
  b.start({ drop_pending_updates: true }).catch((err) => {
    console.error("[telegram] bot crashed", err);
  });
  bot = b;
  console.log("[telegram] bot started");
}

function splitForTelegram(text: string, max = 3800): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    parts.push(text.slice(i, i + max));
    i += max;
  }
  return parts;
}

async function sendToTopic(
  topicId: number,
  text: string,
  opts: { markdown?: boolean; keyboard?: InlineKeyboard } = {}
): Promise<void> {
  if (!bot) throw new Error("Bot not initialized");
  const chunks = splitForTelegram(text);
  for (const chunk of chunks) {
    await bot.api.sendMessage(getChatId(), chunk, {
      message_thread_id: topicId,
      parse_mode: opts.markdown ? "Markdown" : undefined,
      reply_markup: opts.keyboard,
    });
  }
}

export const telegramChannel: ChatChannel = {
  id: "telegram",

  isConfigured() {
    return !!getSecret("telegram_token") && !!getSetting("telegram_chat_id");
  },

  async start() {
    await restartBot();
  },

  async stop() {
    if (bot) {
      try {
        await bot.stop();
      } catch {
        // ignore
      }
      bot = null;
    }
  },

  async sendTestMessage() {
    try {
      if (!bot) throw new Error("Bot not initialized");
      await bot.api.sendMessage(getChatId(), "✅ Verbindung zum Claude-Orchestrator steht.");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async createProjectChannel(_projectId, name) {
    if (!bot) throw new Error("Bot not initialized");
    const res = await bot.api.createForumTopic(getChatId(), `📂 ${name}`);
    return String(res.message_thread_id);
  },

  async deleteProjectChannel(ref) {
    if (!bot) return;
    const topicId = Number(ref);
    if (!topicId) return;
    try {
      await bot.api.closeForumTopic(getChatId(), topicId);
    } catch {
      // ignore
    }
    try {
      await bot.api.deleteForumTopic(getChatId(), topicId);
    } catch {
      // ignore
    }
  },

  async renameProjectChannel(ref, newName) {
    if (!bot) throw new Error("Bot not initialized");
    const topicId = Number(ref);
    if (!topicId) return;
    await bot.api.editForumTopic(getChatId(), topicId, {
      name: `📂 ${newName}`,
    });
  },

  async sendMessage(ref, text, opts = {}) {
    const topicId = Number(ref);
    await sendToTopic(topicId, text, { markdown: opts.markdown });
  },

  async sendPermissionRequest(ref, requestId, tool, summary) {
    const topicId = Number(ref);
    const kb = new InlineKeyboard()
      .text("✅ Allow", `perm:${requestId}:allow`)
      .text("✅ + merken", `perm:${requestId}:allow_remember`)
      .row()
      .text("❌ Deny", `perm:${requestId}:deny`);
    await sendToTopic(
      topicId,
      `🔐 *Permission Request* — \`${tool}\`\n\n${summary}`,
      { markdown: true, keyboard: kb }
    );
  },
};

export function markTelegramConfigured(token: string, chatId: number): void {
  setSetting("telegram_chat_id", String(chatId));
  void token;
}

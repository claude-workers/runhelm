import type { FastifyInstance } from "fastify";
import { getSetupStatus, setSecret, setSetting, clearSecret, getSetting } from "../db.js";
import { validatePat } from "../github.js";
import { restartBot, sendTestMessage } from "../telegram.js";
import { matrixChannel } from "../channels/matrix.js";
import { startLoginContainer, containerStatus } from "../docker.js";
import { DEFAULT_GIT_NAME, DEFAULT_GIT_EMAIL, getGitIdentity } from "../git-identity.js";
import { ensureSelfProject } from "../self-project.js";

export default async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async () => getSetupStatus());

  app.post<{ Body: { token: string } }>(
    "/api/setup/github",
    async (req, reply) => {
      const { token } = req.body ?? {};
      if (!token) return reply.code(400).send({ error: "token required" });
      const res = await validatePat(token);
      if (!res.ok) return reply.code(400).send({ error: res.error });
      setSecret("github_pat", token);
      if (res.login) setSetting("github_login", res.login);
      ensureSelfProject().catch((e) =>
        req.log.error({ err: e }, "ensureSelfProject (after PAT) failed")
      );
      return { ok: true, login: res.login, scopes: res.scopes };
    }
  );

  app.delete("/api/setup/github", async () => {
    clearSecret("github_pat");
    return { ok: true };
  });

  app.get("/api/setup/github/collaborators", async () => ({
    collaborators: getSetting("github_collaborators") ?? "",
  }));

  app.put<{ Body: { collaborators: string } }>(
    "/api/setup/github/collaborators",
    async (req) => {
      const v = (req.body?.collaborators ?? "").trim();
      setSetting("github_collaborators", v);
      return { ok: true, collaborators: v };
    }
  );

  app.post<{ Body: { token: string; chat_id: number | string } }>(
    "/api/setup/telegram",
    async (req, reply) => {
      const { token, chat_id } = req.body ?? {};
      if (!token || chat_id === undefined)
        return reply.code(400).send({ error: "token and chat_id required" });
      setSecret("telegram_token", token);
      setSetting("telegram_chat_id", String(chat_id));
      await restartBot();
      const test = await sendTestMessage();
      if (!test.ok) return reply.code(400).send({ error: test.error });
      return { ok: true };
    }
  );

  app.post<{
    Body: {
      homeserver_url: string;
      user_id: string;
      access_token: string;
      space_id: string;
      invite_user_id?: string;
    };
  }>("/api/setup/matrix", async (req, reply) => {
    const { homeserver_url, user_id, access_token, space_id, invite_user_id } =
      req.body ?? ({} as any);
    if (!homeserver_url || !user_id || !access_token || !space_id) {
      return reply
        .code(400)
        .send({ error: "homeserver_url, user_id, access_token, space_id required" });
    }
    setSetting("matrix_homeserver_url", homeserver_url);
    setSetting("matrix_user_id", user_id);
    setSetting("matrix_space_id", space_id);
    if (invite_user_id) setSetting("matrix_invite_user_id", invite_user_id);
    else setSetting("matrix_invite_user_id", "");
    setSecret("matrix_access_token", access_token);
    const test = await matrixChannel.sendTestMessage();
    if (!test.ok) return reply.code(400).send({ error: test.error });
    await matrixChannel.start();
    return { ok: true };
  });

  app.delete("/api/setup/matrix", async () => {
    clearSecret("matrix_access_token");
    setSetting("matrix_homeserver_url", "");
    setSetting("matrix_user_id", "");
    setSetting("matrix_space_id", "");
    setSetting("matrix_invite_user_id", "");
    await matrixChannel.stop();
    return { ok: true };
  });

  app.get("/api/setup/git-identity", async () => {
    const id = getGitIdentity();
    return {
      name: id.name,
      email: id.email,
      defaults: { name: DEFAULT_GIT_NAME, email: DEFAULT_GIT_EMAIL },
    };
  });

  app.put<{ Body: { name?: string; email?: string } }>(
    "/api/setup/git-identity",
    async (req, reply) => {
      const name = (req.body?.name ?? "").trim();
      const email = (req.body?.email ?? "").trim();
      if (!name || !email)
        return reply.code(400).send({ error: "name and email required" });
      if (!email.includes("@"))
        return reply.code(400).send({ error: "invalid email" });
      setSetting("git_author_name", name);
      setSetting("git_author_email", email);
      return { ok: true, name, email };
    }
  );

  app.get("/api/setup/system-prompt", async () => ({
    prompt: getSetting("global_system_prompt") ?? "",
  }));

  app.get("/api/setup/status-colors", async () => {
    const raw = getSetting("ticket_status_colors");
    const defaults = {
      backlog: "#64748b",
      in_progress: "#3b82f6",
      awaiting_reply: "#f59e0b",
      ready_for_testing: "#a855f7",
      done: "#22c55e",
      cancelled: "#ef4444",
    };
    if (!raw) return { colors: defaults, defaults };
    try {
      const parsed = JSON.parse(raw);
      return { colors: { ...defaults, ...parsed }, defaults };
    } catch {
      return { colors: defaults, defaults };
    }
  });

  app.put<{ Body: { colors: Record<string, string> } }>(
    "/api/setup/status-colors",
    async (req, reply) => {
      const colors = req.body?.colors;
      if (!colors || typeof colors !== "object")
        return reply.code(400).send({ error: "colors object required" });
      for (const [k, v] of Object.entries(colors)) {
        if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) {
          return reply
            .code(400)
            .send({ error: `invalid color for ${k}: ${v}` });
        }
      }
      setSetting("ticket_status_colors", JSON.stringify(colors));
      return { ok: true, colors };
    }
  );

  app.put<{ Body: { prompt: string } }>(
    "/api/setup/system-prompt",
    async (req) => {
      const prompt = (req.body?.prompt ?? "").trim();
      setSetting("global_system_prompt", prompt);
      return { ok: true, prompt };
    }
  );

  app.post("/api/setup/claude/start", async () => {
    const id = await startLoginContainer();
    return { container_id: id };
  });

  app.get<{ Params: { id: string } }>(
    "/api/setup/claude/status/:id",
    async (req) => {
      return { status: await containerStatus(req.params.id) };
    }
  );

  app.post("/api/setup/claude/complete", async () => {
    setSetting("claude_auth_ready", "1");
    return { ok: true };
  });

  app.get("/api/setup/primary-channel", async () => {
    const raw = getSetting("primary_channel") ?? "";
    const channel = raw === "telegram" || raw === "matrix" ? raw : null;
    return { channel };
  });

  app.put<{ Body: { channel: "telegram" | "matrix" | null } }>(
    "/api/setup/primary-channel",
    async (req, reply) => {
      const ch = req.body?.channel ?? null;
      if (ch !== null && ch !== "telegram" && ch !== "matrix") {
        return reply
          .code(400)
          .send({ error: "channel must be 'telegram', 'matrix', or null" });
      }
      const status = getSetupStatus();
      if (ch === "telegram" && !status.telegram) {
        return reply.code(400).send({ error: "telegram is not configured" });
      }
      if (ch === "matrix" && !status.matrix) {
        return reply.code(400).send({ error: "matrix is not configured" });
      }
      setSetting("primary_channel", ch ?? "");
      return { ok: true, channel: ch };
    }
  );
}

import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  listWorkers,
  openPullRequest,
  updateProject,
  type Policy,
} from "../workers.js";
import { db, getSetupStatus } from "../db.js";
import { config } from "../config.js";
import type { ChannelId } from "../channels/index.js";

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
};

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

export default async function projectRoutes(app: FastifyInstance) {
  app.get("/api/projects", async () => {
    const rows = listProjects();
    return rows.map((p) => ({ ...p, workers: listWorkers(p.id) }));
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const p = getProject(req.params.id);
      if (!p) return reply.code(404).send({ error: "not found" });
      return { ...p, workers: listWorkers(p.id) };
    }
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/projects/:id/chat",
    async (req, reply) => {
      const p = getProject(req.params.id);
      if (!p) return reply.code(404).send({ error: "not found" });
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit ?? 500)));
      const rows = db
        .prepare<[string, number], { id: number; type: string; payload: string; ts: number }>(
          `SELECT id, type, payload, ts FROM events
            WHERE project_id = ?
              AND type IN ('user_prompt','worker_message','permission_request','permission_resolved')
            ORDER BY ts DESC LIMIT ?`
        )
        .all(req.params.id, limit);
      return rows
        .map((r) => ({ id: r.id, type: r.type, ts: r.ts, payload: JSON.parse(r.payload) }))
        .reverse();
    }
  );

  app.post<{
    Body: {
      name: string;
      description?: string;
      policy: Policy;
      channels?: ChannelId[];
      upstream?: string;
    };
  }>("/api/projects", async (req, reply) => {
    if (!getSetupStatus().done)
      return reply.code(400).send({ error: "setup not complete" });
    const { name, description, policy, channels, upstream } =
      req.body ?? ({} as any);
    if (!name || !policy)
      return reply.code(400).send({ error: "name and policy required" });
    const chans = Array.isArray(channels)
      ? (channels.filter(
          (c) => c === "telegram" || c === "matrix"
        ) as ChannelId[])
      : undefined;
    try {
      const p = await createProject({
        name,
        description,
        policy,
        channels: chans,
        upstream: upstream?.trim() || undefined,
      });
      return p;
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { id: string; "*": string } }>(
    "/api/projects/:id/files/*",
    async (req, reply) => {
      const p = getProject(req.params.id);
      if (!p) return reply.code(404).send({ error: "project not found" });
      const rel = (req.params as any)["*"] as string;
      if (!rel) return reply.code(400).send({ error: "path required" });
      const repoRoot = pathResolve(config.reposContainerPath, p.slug);
      const target = pathResolve(repoRoot, rel);
      if (!target.startsWith(repoRoot + "/") && target !== repoRoot) {
        return reply.code(400).send({ error: "invalid path" });
      }
      try {
        const s = await stat(target);
        if (!s.isFile())
          return reply.code(404).send({ error: "not a file" });
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      reply
        .header("Content-Type", mimeFor(target))
        .header("Cache-Control", "no-store")
        .header("X-Frame-Options", "SAMEORIGIN");
      return reply.send(createReadStream(target));
    }
  );

  app.post<{
    Params: { id: string };
    Body: { title: string; body?: string };
  }>("/api/projects/:id/pr", async (req, reply) => {
    const { title, body } = req.body ?? ({} as any);
    if (!title || !title.trim())
      return reply.code(400).send({ error: "title required" });
    try {
      const res = await openPullRequest(req.params.id, title.trim(), body);
      return res;
    } catch (e) {
      req.log.error(e);
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { deleteRepo?: string } }>(
    "/api/projects/:id",
    async (req) => {
      await deleteProject(req.params.id, req.query.deleteRepo === "1");
      return { ok: true };
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string | null;
      policy?: Policy;
      channels?: ChannelId[];
      deleteRefs?: Partial<Record<ChannelId, boolean>>;
      system_prompt?: string | null;
      key?: string;
    };
  }>("/api/projects/:id", async (req, reply) => {
    const p = getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: "not found" });
    const { name, description, policy, channels, deleteRefs, system_prompt, key } =
      req.body ?? ({} as any);
    const filteredChannels = Array.isArray(channels)
      ? (channels.filter(
          (c) => c === "telegram" || c === "matrix"
        ) as ChannelId[])
      : undefined;
    try {
      const updated = await updateProject(req.params.id, {
        name,
        description,
        policy,
        channels: filteredChannels,
        deleteRefs,
        system_prompt,
        key,
      });
      return { ...updated, workers: listWorkers(updated.id) };
    } catch (e) {
      req.log.error(e);
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}

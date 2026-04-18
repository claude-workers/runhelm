import type { FastifyInstance } from "fastify";
import {
  getWorker,
  listWorkers,
  restartWorker,
  startWorker,
  stopWorker,
} from "../workers.js";
import { bus } from "../bus.js";
import { db } from "../db.js";

export default async function workerRoutes(app: FastifyInstance) {
  app.get("/api/workers", async () => listWorkers());

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/worker/start",
    async (req, reply) => {
      try {
        const w = await startWorker(req.params.id);
        return w;
      } catch (e) {
        return reply.code(500).send({ error: (e as Error).message });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/workers/:id/stop",
    async (req, reply) => {
      const w = getWorker(req.params.id);
      if (!w) return reply.code(404).send({ error: "not found" });
      await stopWorker(w.id);
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/workers/:id/restart",
    async (req, reply) => {
      const w = getWorker(req.params.id);
      if (!w) return reply.code(404).send({ error: "not found" });
      await restartWorker(w.id);
      return { ok: true };
    }
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/workers/:id/events",
    async (req) => {
      const limit = Math.min(1000, Number(req.query.limit ?? 200));
      const rows = db
        .prepare(
          "SELECT * FROM events WHERE worker_id = ? ORDER BY ts DESC LIMIT ?"
        )
        .all(req.params.id, limit);
      return rows;
    }
  );

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/api/workers/:id/prompt",
    async (req, reply) => {
      const w = getWorker(req.params.id);
      if (!w) return reply.code(404).send({ error: "not found" });
      const text = (req.body?.text ?? "").trim();
      if (!text) return reply.code(400).send({ error: "text required" });
      bus.emit({
        type: "user_prompt",
        workerId: w.id,
        projectId: w.project_id,
        text,
        origin: "ui",
      });
      return { ok: true };
    }
  );

  app.post<{
    Params: { requestId: string };
    Body: { allow: boolean; note?: string };
  }>("/api/permissions/:requestId/resolve", async (req, reply) => {
    if (typeof req.body?.allow !== "boolean")
      return reply.code(400).send({ error: "allow required" });
    bus.emit({
      type: "permission_resolved",
      requestId: req.params.requestId,
      allow: req.body.allow,
      note: req.body.note,
    });
    return { ok: true };
  });
}

import type { FastifyInstance } from "fastify";
import { listBackups, backupDbSize } from "../deploy/backup.js";
import {
  getConsecutiveFailures,
  getLastSeenSha,
  getPollIntervalSeconds,
  isAutoDeployPaused,
  setAutoDeployPaused,
  setConsecutiveFailures,
  setPollIntervalSeconds,
} from "../deploy/poller.js";
import { startRestore } from "../deploy/deployer.js";
import { db } from "../db.js";

export default async function deployRoutes(app: FastifyInstance) {
  app.get("/api/deploy/backups", async () => {
    return listBackups().map((b) => ({ ...b, dbSize: backupDbSize(b) }));
  });

  app.get("/api/deploy/runs", async () => {
    return db
      .prepare(
        "SELECT * FROM deploy_runs ORDER BY started_at DESC LIMIT 50"
      )
      .all();
  });

  app.get("/api/deploy/settings", async () => ({
    poll_interval_s: getPollIntervalSeconds(),
    paused: isAutoDeployPaused(),
    last_sha: getLastSeenSha(),
    consecutive_failures: getConsecutiveFailures(),
  }));

  app.put<{ Body: { poll_interval_s?: number; paused?: boolean } }>(
    "/api/deploy/settings",
    async (req, reply) => {
      const body = req.body ?? {};
      if (body.poll_interval_s !== undefined) {
        try {
          setPollIntervalSeconds(Number(body.poll_interval_s));
        } catch (e) {
          return reply.code(400).send({ error: (e as Error).message });
        }
      }
      if (body.paused !== undefined) {
        setAutoDeployPaused(Boolean(body.paused));
      }
      return {
        poll_interval_s: getPollIntervalSeconds(),
        paused: isAutoDeployPaused(),
        last_sha: getLastSeenSha(),
        consecutive_failures: getConsecutiveFailures(),
      };
    }
  );

  app.post("/api/deploy/resume", async () => {
    setAutoDeployPaused(false);
    setConsecutiveFailures(0);
    return { ok: true };
  });

  app.post<{ Body: { backup_id: string } }>(
    "/api/deploy/rollback",
    async (req, reply) => {
      const id = (req.body?.backup_id ?? "").trim();
      if (!id) return reply.code(400).send({ error: "backup_id required" });
      const exists = listBackups().some((b) => b.id === id);
      if (!exists) return reply.code(404).send({ error: "backup not found" });
      try {
        const r = await startRestore(id);
        return { ok: true, ...r };
      } catch (e) {
        return reply.code(500).send({ error: (e as Error).message });
      }
    }
  );
}

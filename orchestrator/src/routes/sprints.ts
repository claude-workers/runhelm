import type { FastifyInstance } from "fastify";
import {
  createSprint,
  deleteSprint,
  getSprint,
  listSprints,
  sprintTicketStats,
  updateSprint,
} from "../sprints.js";
import { listTicketsForSprint } from "../tickets.js";
import { releaseSprint, startSprint } from "../scheduler.js";
import { getProject } from "../workers.js";

export default async function sprintRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/sprints",
    async (req, reply) => {
      const p = getProject(req.params.id);
      if (!p) return reply.code(404).send({ error: "project not found" });
      const sprints = listSprints(p.id);
      return sprints.map((s) => ({
        ...s,
        stats: sprintTicketStats(s.id),
      }));
    }
  );

  app.post<{
    Params: { id: string };
    Body: { name: string };
  }>("/api/projects/:id/sprints", async (req, reply) => {
    const p = getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const name = (req.body?.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "name required" });
    const s = createSprint({ projectId: p.id, name });
    return s;
  });

  app.get<{ Params: { id: string; sid: string } }>(
    "/api/projects/:id/sprints/:sid",
    async (req, reply) => {
      const s = getSprint(req.params.sid);
      if (!s || s.project_id !== req.params.id)
        return reply.code(404).send({ error: "sprint not found" });
      return {
        ...s,
        stats: sprintTicketStats(s.id),
        tickets: listTicketsForSprint(s.id),
      };
    }
  );

  app.patch<{
    Params: { id: string; sid: string };
    Body: { name?: string };
  }>("/api/projects/:id/sprints/:sid", async (req, reply) => {
    const s = getSprint(req.params.sid);
    if (!s || s.project_id !== req.params.id)
      return reply.code(404).send({ error: "sprint not found" });
    const updated = updateSprint(s.id, { name: req.body?.name });
    return updated;
  });

  app.post<{ Params: { id: string; sid: string } }>(
    "/api/projects/:id/sprints/:sid/start",
    async (req, reply) => {
      const s = getSprint(req.params.sid);
      if (!s || s.project_id !== req.params.id)
        return reply.code(404).send({ error: "sprint not found" });
      try {
        await startSprint(s.id);
        return { ok: true, sprint: getSprint(s.id) };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
  );

  app.post<{
    Params: { id: string; sid: string };
    Body: { title?: string; body?: string };
  }>("/api/projects/:id/sprints/:sid/release", async (req, reply) => {
    const s = getSprint(req.params.sid);
    if (!s || s.project_id !== req.params.id)
      return reply.code(404).send({ error: "sprint not found" });
    try {
      const pr = await releaseSprint(s.id, req.body?.title, req.body?.body);
      return { ok: true, pr, sprint: getSprint(s.id) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete<{ Params: { id: string; sid: string } }>(
    "/api/projects/:id/sprints/:sid",
    async (req, reply) => {
      const s = getSprint(req.params.sid);
      if (!s || s.project_id !== req.params.id)
        return reply.code(404).send({ error: "sprint not found" });
      if (s.status === "active" || s.status === "pending_release")
        return reply
          .code(400)
          .send({ error: "aktive/release-pending Sprints können nicht gelöscht werden" });
      deleteSprint(s.id);
      return { ok: true };
    }
  );
}

import { nanoid } from "nanoid";
import { db, nextNumberFor } from "./db.js";
import { bus } from "./bus.js";

export type SprintStatus =
  | "planning"
  | "active"
  | "pending_release"
  | "released"
  | "merged"
  | "cancelled";

export type Sprint = {
  id: string;
  number: number;
  project_id: string;
  name: string;
  status: SprintStatus;
  branch: string;
  pr_url: string | null;
  pr_number: number | null;
  created_at: number;
  started_at: number | null;
  released_at: number | null;
  merged_at: number | null;
};

export function listSprints(projectId: string): Sprint[] {
  return db
    .prepare(
      `SELECT * FROM sprints
         WHERE project_id = ?
         ORDER BY
           CASE status
             WHEN 'active'          THEN 0
             WHEN 'pending_release' THEN 1
             WHEN 'planning'        THEN 2
             WHEN 'released'        THEN 3
             WHEN 'merged'          THEN 4
             WHEN 'cancelled'       THEN 5
           END,
           created_at DESC`
    )
    .all(projectId) as Sprint[];
}

export function getSprint(id: string): Sprint | null {
  return (
    (db.prepare("SELECT * FROM sprints WHERE id = ?").get(id) as Sprint | undefined) ??
    null
  );
}

export function getActiveSprint(projectId: string): Sprint | null {
  return (
    (db
      .prepare(
        "SELECT * FROM sprints WHERE project_id = ? AND status = 'active' LIMIT 1"
      )
      .get(projectId) as Sprint | undefined) ?? null
  );
}

export function createSprint(input: {
  projectId: string;
  name: string;
}): Sprint {
  const id = nanoid(8);
  const number = nextNumberFor("sprints", input.projectId);
  const now = Date.now();
  const branch = `sprint/s-${number}-${slugifyName(input.name)}`;
  db.prepare(
    `INSERT INTO sprints(id,number,project_id,name,status,branch,created_at)
       VALUES(?,?,?,?, 'planning', ?, ?)`
  ).run(id, number, input.projectId, input.name, branch, now);
  bus.emit({ type: "sprint_changed", projectId: input.projectId, sprintId: id });
  return getSprint(id)!;
}

export function updateSprint(
  id: string,
  patch: { name?: string; status?: SprintStatus; pr_url?: string; pr_number?: number }
): Sprint | null {
  const s = getSprint(id);
  if (!s) return null;
  const cols: string[] = [];
  const vals: any[] = [];
  if (patch.name !== undefined) {
    cols.push("name = ?");
    vals.push(patch.name);
  }
  if (patch.status !== undefined) {
    cols.push("status = ?");
    vals.push(patch.status);
    if (patch.status === "active" && !s.started_at) {
      cols.push("started_at = ?");
      vals.push(Date.now());
    }
    if (patch.status === "released" && !s.released_at) {
      cols.push("released_at = ?");
      vals.push(Date.now());
    }
    if (patch.status === "merged" && !s.merged_at) {
      cols.push("merged_at = ?");
      vals.push(Date.now());
    }
  }
  if (patch.pr_url !== undefined) {
    cols.push("pr_url = ?");
    vals.push(patch.pr_url);
  }
  if (patch.pr_number !== undefined) {
    cols.push("pr_number = ?");
    vals.push(patch.pr_number);
  }
  if (cols.length === 0) return s;
  vals.push(id);
  db.prepare(`UPDATE sprints SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  bus.emit({ type: "sprint_changed", projectId: s.project_id, sprintId: id });
  return getSprint(id);
}

export function deleteSprint(id: string): void {
  const s = getSprint(id);
  if (!s) return;
  // unassign any tickets
  db.prepare("UPDATE tickets SET sprint_id = NULL WHERE sprint_id = ?").run(id);
  db.prepare("DELETE FROM sprints WHERE id = ?").run(id);
  bus.emit({ type: "sprint_changed", projectId: s.project_id, sprintId: id });
}

export function sprintTicketStats(sprintId: string): {
  total: number;
  done: number;
  open: number;
} {
  const total = (db
    .prepare("SELECT COUNT(*) AS n FROM tickets WHERE sprint_id = ?")
    .get(sprintId) as { n: number }).n;
  const done = (db
    .prepare(
      "SELECT COUNT(*) AS n FROM tickets WHERE sprint_id = ? AND status = 'done'"
    )
    .get(sprintId) as { n: number }).n;
  return { total, done, open: total - done };
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "s";
}

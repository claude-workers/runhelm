import { nanoid } from "nanoid";
import { db, nextNumberFor } from "./db.js";
import { bus } from "./bus.js";
import { matrixChannel } from "./channels/matrix.js";

export type TicketStatus =
  | "backlog"
  | "in_progress"
  | "awaiting_reply"
  | "ready_for_testing"
  | "done"
  | "cancelled";

export type TicketType = "task" | "bug";

export type Ticket = {
  id: string;
  number: number;
  project_id: string;
  sprint_id: string | null;
  type: TicketType;
  title: string;
  description: string | null;
  priority: number;
  status: TicketStatus;
  branch: string | null;
  matrix_thread_root_id: string | null;
  auto_resume_queued: number;
  awaiting_since: number | null;
  paused_at: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
};

export type TicketComment = {
  id: number;
  ticket_id: string;
  role: "user" | "assistant" | "system" | "permission";
  text: string;
  origin: string | null;
  matrix_event_id: string | null;
  ts: number;
};

export function listTickets(projectId: string): Ticket[] {
  return db
    .prepare(
      `SELECT * FROM tickets
         WHERE project_id = ?
         ORDER BY
           CASE status
             WHEN 'in_progress'       THEN 0
             WHEN 'awaiting_reply'    THEN 1
             WHEN 'ready_for_testing' THEN 2
             WHEN 'backlog'           THEN 3
             WHEN 'done'              THEN 4
             WHEN 'cancelled'         THEN 5
           END,
           priority ASC,
           created_at ASC`
    )
    .all(projectId) as Ticket[];
}

export function listTicketsForSprint(sprintId: string): Ticket[] {
  return db
    .prepare("SELECT * FROM tickets WHERE sprint_id = ? ORDER BY priority ASC, created_at ASC")
    .all(sprintId) as Ticket[];
}

export function getTicket(id: string): Ticket | null {
  return (
    (db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Ticket | undefined) ??
    null
  );
}

export function getNextBacklog(projectId: string, sprintId: string): Ticket | null {
  return (
    (db
      .prepare(
        `SELECT * FROM tickets
           WHERE project_id = ? AND sprint_id = ? AND status = 'backlog'
             AND (paused_at IS NULL OR paused_at = 0)
           ORDER BY priority ASC, created_at ASC LIMIT 1`
      )
      .get(projectId, sprintId) as Ticket | undefined) ?? null
  );
}

export function setTicketPaused(id: string, pausedAt: number | null): void {
  db.prepare("UPDATE tickets SET paused_at = ?, updated_at = ? WHERE id = ?").run(
    pausedAt,
    Date.now(),
    id
  );
}

export function getNextResumable(projectId: string, sprintId: string): Ticket | null {
  return (
    (db
      .prepare(
        `SELECT * FROM tickets
           WHERE project_id = ? AND sprint_id = ? AND status = 'awaiting_reply' AND auto_resume_queued = 1
           ORDER BY priority ASC, awaiting_since ASC LIMIT 1`
      )
      .get(projectId, sprintId) as Ticket | undefined) ?? null
  );
}

export function getActiveTicket(projectId: string): Ticket | null {
  return (
    (db
      .prepare(
        `SELECT * FROM tickets
           WHERE project_id = ? AND status IN ('in_progress', 'awaiting_reply')
           ORDER BY
             CASE status WHEN 'in_progress' THEN 0 ELSE 1 END,
             updated_at DESC LIMIT 1`
      )
      .get(projectId) as Ticket | undefined) ?? null
  );
}

export async function createTicket(input: {
  projectId: string;
  title: string;
  description?: string;
  priority?: number;
  type?: TicketType;
}): Promise<Ticket> {
  const id = nanoid(8);
  const number = nextNumberFor("tickets", input.projectId);
  const now = Date.now();
  db.prepare(
    `INSERT INTO tickets(id,number,project_id,type,title,description,priority,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?, 'backlog', ?, ?)`
  ).run(
    id,
    number,
    input.projectId,
    input.type ?? "task",
    input.title,
    input.description ?? null,
    input.priority ?? 50,
    now,
    now
  );

  try {
    const project = db
      .prepare<[string], { matrix_room_id: string | null }>(
        "SELECT matrix_room_id FROM projects WHERE id = ?"
      )
      .get(input.projectId);
    if (project?.matrix_room_id && matrixChannel.isConfigured()) {
      const eventId = await matrixChannel.createTicketThread(
        project.matrix_room_id,
        String(number),
        input.title,
        input.description ?? null,
        input.priority ?? 50
      );
      if (eventId) {
        db.prepare(
          "UPDATE tickets SET matrix_thread_root_id = ?, updated_at = ? WHERE id = ?"
        ).run(eventId, Date.now(), id);
      }
    }
  } catch (err) {
    console.error("[tickets] matrix thread create failed", err);
  }

  bus.emit({ type: "ticket_changed", projectId: input.projectId, ticketId: id });
  return getTicket(id)!;
}

export function updateTicket(
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    priority?: number;
    status?: TicketStatus;
    sprint_id?: string | null;
  }
): Ticket | null {
  const t = getTicket(id);
  if (!t) return null;
  const next = {
    title: patch.title ?? t.title,
    description:
      patch.description === undefined ? t.description : patch.description,
    priority: patch.priority ?? t.priority,
    status: patch.status ?? t.status,
    sprint_id: patch.sprint_id === undefined ? t.sprint_id : patch.sprint_id,
  };
  db.prepare(
    "UPDATE tickets SET title=?, description=?, priority=?, status=?, sprint_id=?, updated_at=? WHERE id=?"
  ).run(
    next.title,
    next.description,
    next.priority,
    next.status,
    next.sprint_id,
    Date.now(),
    id
  );
  bus.emit({ type: "ticket_changed", projectId: t.project_id, ticketId: id });
  return getTicket(id);
}

export function setTicketStatus(
  id: string,
  status: TicketStatus,
  extra?: {
    branch?: string | null;
    awaitingSince?: number | null;
    startedAt?: number | null;
    completedAt?: number | null;
    autoResume?: number;
  }
): void {
  const t = getTicket(id);
  if (!t) return;
  const cols: string[] = ["status = ?"];
  const vals: any[] = [status];
  if (extra?.branch !== undefined) {
    cols.push("branch = ?");
    vals.push(extra.branch);
  }
  if (extra?.awaitingSince !== undefined) {
    cols.push("awaiting_since = ?");
    vals.push(extra.awaitingSince);
  }
  if (extra?.startedAt !== undefined) {
    cols.push("started_at = ?");
    vals.push(extra.startedAt);
  }
  if (extra?.completedAt !== undefined) {
    cols.push("completed_at = ?");
    vals.push(extra.completedAt);
  }
  if (extra?.autoResume !== undefined) {
    cols.push("auto_resume_queued = ?");
    vals.push(extra.autoResume);
  }
  cols.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(id);
  db.prepare(`UPDATE tickets SET ${cols.join(", ")} WHERE id = ?`).run(...vals);
  bus.emit({ type: "ticket_changed", projectId: t.project_id, ticketId: id });
}

export function cancelTicket(id: string): void {
  setTicketStatus(id, "cancelled", { completedAt: Date.now() });
}

export function listComments(ticketId: string): TicketComment[] {
  return db
    .prepare("SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY ts ASC")
    .all(ticketId) as TicketComment[];
}

export async function addComment(
  ticketId: string,
  role: "user" | "assistant" | "system" | "permission",
  text: string,
  origin: string,
  matrixEventId?: string | null
): Promise<void> {
  const t = getTicket(ticketId);
  if (!t) return;
  const ts = Date.now();
  let mxEventId: string | null = matrixEventId ?? null;

  if (!mxEventId && origin !== "matrix" && t.matrix_thread_root_id) {
    try {
      const project = db
        .prepare<[string], { matrix_room_id: string | null }>(
          "SELECT matrix_room_id FROM projects WHERE id = ?"
        )
        .get(t.project_id);
      if (project?.matrix_room_id && matrixChannel.isConfigured()) {
        const prefix = roleEmoji(role);
        mxEventId = await matrixChannel.sendInThread(
          project.matrix_room_id,
          t.matrix_thread_root_id,
          `${prefix} ${text}`
        );
      }
    } catch (err) {
      console.error("[tickets] matrix thread post failed", err);
    }
  }

  db.prepare(
    "INSERT INTO ticket_comments(ticket_id, role, text, origin, matrix_event_id, ts) VALUES(?,?,?,?,?,?)"
  ).run(ticketId, role, text, origin, mxEventId, ts);

  bus.emit({
    type: "ticket_comment_added",
    projectId: t.project_id,
    ticketId,
    role,
    text,
    origin,
    ts,
  });
}

function roleEmoji(role: string): string {
  switch (role) {
    case "user":
      return "👤";
    case "assistant":
      return "🤖";
    case "permission":
      return "🔐";
    default:
      return "ℹ️";
  }
}

export async function handleTicketReply(
  ticketId: string,
  text: string,
  origin: "ui" | "matrix" | "telegram"
): Promise<void> {
  const t = getTicket(ticketId);
  if (!t) return;
  await addComment(ticketId, "user", text, origin);
  if (t.status === "awaiting_reply") {
    setTicketStatus(ticketId, "awaiting_reply", { autoResume: 1 });
  }
}

export function findTicketByMatrixThread(
  projectId: string,
  threadRootEventId: string
): Ticket | null {
  return (
    (db
      .prepare(
        "SELECT * FROM tickets WHERE project_id = ? AND matrix_thread_root_id = ?"
      )
      .get(projectId, threadRootEventId) as Ticket | undefined) ?? null
  );
}

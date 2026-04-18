export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as any) };
  if (init.body != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export type SetupStatus = {
  github: boolean;
  telegram: boolean;
  matrix: boolean;
  claude: boolean;
  done: boolean;
};

export type ChannelId = "telegram" | "matrix";

export type Project = {
  id: string;
  slug: string;
  key: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  policy: string;
  tg_topic_id: number | null;
  matrix_room_id: string | null;
  channels: string;
  upstream_repo: string | null;
  upstream_default_branch: string | null;
  current_branch: string | null;
  system_prompt: string | null;
  is_self: number;
  created_at: number;
  workers: Worker[];
};

export type Worker = {
  id: string;
  project_id: string;
  container_id: string | null;
  status: string;
  session_id: string | null;
  last_seen: number | null;
  created_at: number;
};

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
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
};

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
  stats?: { total: number; done: number; open: number };
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

export type TicketWithComments = Ticket & { comments: TicketComment[] };

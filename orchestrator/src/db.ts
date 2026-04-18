import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { decrypt, encrypt } from "./secrets.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
// Rollback-journal mode. WAL left stale -shm/-wal sidecar files in the
// bind mount after deploy-triggered container recreates, which made
// SQLite refuse to reopen the DB (SQLITE_CANTOPEN). `DELETE` is
// single-process-clean and plays nicer with the deployer's stop-start
// cycle; the online `.backup()` API for deploy snapshots still works.
db.pragma("journal_mode = DELETE");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  slug           TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  repo_url       TEXT,
  policy         TEXT NOT NULL DEFAULT 'safe',
  tg_topic_id    INTEGER,
  matrix_room_id TEXT,
  channels       TEXT NOT NULL DEFAULT '["telegram"]',
  is_self        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  container_id TEXT,
  status      TEXT NOT NULL DEFAULT 'stopped',
  session_id  TEXT,
  last_seen   INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_id  TEXT,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project_ts ON events(project_id, ts DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL DEFAULT 'task',
  title                 TEXT NOT NULL,
  description           TEXT,
  priority              INTEGER NOT NULL DEFAULT 50,
  status                TEXT NOT NULL DEFAULT 'backlog',
  branch                TEXT,
  matrix_thread_root_id TEXT,
  auto_resume_queued    INTEGER NOT NULL DEFAULT 0,
  awaiting_since        INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  started_at            INTEGER,
  completed_at          INTEGER
);
CREATE INDEX IF NOT EXISTS tickets_project_priority
  ON tickets(project_id, status, priority, created_at);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  text            TEXT NOT NULL,
  origin          TEXT,
  matrix_event_id TEXT,
  ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_comments_ticket_ts
  ON ticket_comments(ticket_id, ts);

CREATE TABLE IF NOT EXISTS deploy_runs (
  id           TEXT PRIMARY KEY,
  sha          TEXT NOT NULL,
  status       TEXT NOT NULL,
  phase        TEXT,
  backup_id    TEXT,
  attempt      INTEGER NOT NULL DEFAULT 1,
  log_tail     TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS deploy_runs_sha ON deploy_runs(sha, started_at DESC);

CREATE TABLE IF NOT EXISTS sprints (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'planning',
  branch       TEXT NOT NULL,
  pr_url       TEXT,
  pr_number    INTEGER,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  released_at  INTEGER,
  merged_at    INTEGER
);
CREATE INDEX IF NOT EXISTS sprints_project_status
  ON sprints(project_id, status);
`);

// Migrations for existing DBs (no-op if columns already exist)
function hasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}
if (!hasColumn("projects", "matrix_room_id")) {
  db.exec(`ALTER TABLE projects ADD COLUMN matrix_room_id TEXT`);
}
if (!hasColumn("projects", "channels")) {
  db.exec(`ALTER TABLE projects ADD COLUMN channels TEXT NOT NULL DEFAULT '["telegram"]'`);
}
if (!hasColumn("projects", "upstream_repo")) {
  db.exec(`ALTER TABLE projects ADD COLUMN upstream_repo TEXT`);
}
if (!hasColumn("projects", "upstream_default_branch")) {
  db.exec(`ALTER TABLE projects ADD COLUMN upstream_default_branch TEXT`);
}
if (!hasColumn("projects", "current_branch")) {
  db.exec(`ALTER TABLE projects ADD COLUMN current_branch TEXT`);
}
if (!hasColumn("tickets", "sprint_id")) {
  db.exec(`ALTER TABLE tickets ADD COLUMN sprint_id TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS tickets_sprint ON tickets(sprint_id)`);
}
if (!hasColumn("tickets", "type")) {
  db.exec(`ALTER TABLE tickets ADD COLUMN type TEXT NOT NULL DEFAULT 'task'`);
}
if (!hasColumn("tickets", "paused_at")) {
  db.exec(`ALTER TABLE tickets ADD COLUMN paused_at INTEGER`);
}
if (!hasColumn("projects", "system_prompt")) {
  db.exec(`ALTER TABLE projects ADD COLUMN system_prompt TEXT`);
}
if (!hasColumn("projects", "is_self")) {
  db.exec(`ALTER TABLE projects ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0`);
}
if (!hasColumn("projects", "key")) {
  db.exec(`ALTER TABLE projects ADD COLUMN key TEXT`);
  // Backfill from name
  const all = db.prepare("SELECT id, name FROM projects").all() as Array<{
    id: string;
    name: string;
  }>;
  const used = new Set<string>();
  const upd = db.prepare("UPDATE projects SET key = ? WHERE id = ?");
  for (const p of all) {
    let base = (p.name ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 3);
    if (base.length < 3) base = (base + "XXX").slice(0, 3);
    let candidate = base;
    let i = 1;
    while (used.has(candidate)) {
      candidate = (base.slice(0, 2) + i).toUpperCase().slice(0, 3);
      i++;
    }
    used.add(candidate);
    upd.run(candidate, p.id);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS projects_key ON projects(key)`);
}

// Per-project sequential display numbers for tickets + sprints.
if (!hasColumn("tickets", "number")) {
  db.exec(`ALTER TABLE tickets ADD COLUMN number INTEGER`);
  // Backfill in creation order, per project
  const projs = db.prepare("SELECT DISTINCT project_id AS pid FROM tickets").all() as Array<{ pid: string }>;
  const upd = db.prepare("UPDATE tickets SET number = ? WHERE id = ?");
  for (const { pid } of projs) {
    const rows = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM tickets WHERE project_id = ? ORDER BY created_at ASC, id ASC"
      )
      .all(pid);
    rows.forEach((r, i) => upd.run(i + 1, r.id));
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tickets_project_number ON tickets(project_id, number)`);
}
if (!hasColumn("sprints", "number")) {
  db.exec(`ALTER TABLE sprints ADD COLUMN number INTEGER`);
  const projs = db.prepare("SELECT DISTINCT project_id AS pid FROM sprints").all() as Array<{ pid: string }>;
  const upd = db.prepare("UPDATE sprints SET number = ? WHERE id = ?");
  for (const { pid } of projs) {
    const rows = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM sprints WHERE project_id = ? ORDER BY created_at ASC, id ASC"
      )
      .all(pid);
    rows.forEach((r, i) => upd.run(i + 1, r.id));
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS sprints_project_number ON sprints(project_id, number)`);
}

/** Allocate the next per-project number for the given table. */
export function nextNumberFor(table: "tickets" | "sprints", projectId: string): number {
  const row = db
    .prepare<[string], { m: number | null }>(
      `SELECT MAX(number) AS m FROM ${table} WHERE project_id = ?`
    )
    .get(projectId);
  return (row?.m ?? 0) + 1;
}

// ---- settings helpers (encrypted) ----

const stmtGet = db.prepare<[string], { value: string }>(
  "SELECT value FROM settings WHERE key = ?"
);
const stmtSet = db.prepare(
  "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
);
const stmtDel = db.prepare("DELETE FROM settings WHERE key = ?");

export function getSecret(key: string): string | null {
  const row = stmtGet.get(key);
  if (!row) return null;
  try {
    return decrypt(row.value);
  } catch {
    return null;
  }
}

export function setSecret(key: string, value: string): void {
  stmtSet.run(key, encrypt(value));
}

export function clearSecret(key: string): void {
  stmtDel.run(key);
}

export function getSetting(key: string): string | null {
  return stmtGet.get(key)?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  stmtSet.run(key, value);
}

// ---- setup status ----

export type SetupStatus = {
  github: boolean;
  telegram: boolean;
  matrix: boolean;
  claude: boolean;
  done: boolean;
};

export function getSetupStatus(): SetupStatus {
  const github = !!getSecret("github_pat");
  const telegram = !!getSecret("telegram_token") && !!getSetting("telegram_chat_id");
  const matrix =
    !!getSecret("matrix_access_token") &&
    !!getSetting("matrix_homeserver_url") &&
    !!getSetting("matrix_user_id") &&
    !!getSetting("matrix_space_id");
  const claude = getSetting("claude_auth_ready") === "1";
  // At least one chat channel must be configured (telegram or matrix)
  const anyChat = telegram || matrix;
  return { github, telegram, matrix, claude, done: github && anyChat && claude };
}

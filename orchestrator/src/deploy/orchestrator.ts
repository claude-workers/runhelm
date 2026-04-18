import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { db } from "../db.js";
import { addComment, createTicket, type Ticket } from "../tickets.js";
import { getSelfProject } from "../self-project-query.js";
import { createSprint, getActiveSprint, updateSprint } from "../sprints.js";
import { sendAdminAlert } from "./alerts.js";
import { getBackup, listBackups, setPreviousAlias } from "./backup.js";
import {
  setConsecutiveFailures,
  setAutoDeployPaused,
  getConsecutiveFailures,
} from "./state.js";
import type { DeployRunRow } from "./deployer.js";

const MAX_ATTEMPTS = 3;

export type FailureReport = {
  run_id: string;
  mode: "deploy" | "restore";
  sha: string;
  attempt: number;
  phase: string;
  reason: string;
  prev_backup: string;
  log_tail: string;
  finished_at: number;
};

/** Ensure the self-project always has an active sprint for auto-generated bugs. */
function ensureSelfSprint(projectId: string): string {
  const active = getActiveSprint(projectId);
  if (active) return active.id;
  const s = createSprint({ projectId, name: "Self-deploy bugs" });
  updateSprint(s.id, { status: "active" });
  return s.id;
}

async function createSelfDeployBug(
  sha: string,
  phase: string,
  reason: string,
  logTail: string
): Promise<Ticket | null> {
  const self = getSelfProject();
  if (!self) {
    console.error("[deploy] cannot create bug: self-project missing");
    return null;
  }

  // Prevent duplicates: if an open bug for this sha already exists, just comment
  const existing = db
    .prepare(
      `SELECT * FROM tickets
         WHERE project_id = ? AND type = 'bug'
           AND status IN ('backlog','in_progress','awaiting_reply','ready_for_testing')
           AND description LIKE ?
         ORDER BY created_at DESC LIMIT 1`
    )
    .get(self.id, `%${sha}%`) as Ticket | undefined;
  if (existing) {
    await addComment(
      existing.id,
      "system",
      `🔁 Weiterer Deploy-Fail — Phase: ${phase}\n${reason}\n\n\`\`\`\n${logTail.slice(-3000)}\n\`\`\``,
      "deployer"
    );
    return existing;
  }

  const sprintId = ensureSelfSprint(self.id);
  const title = `Self-Deploy fail (${phase}) @ ${sha.slice(0, 7)}`;
  const description = [
    `Automatisch erzeugt aus fehlgeschlagenem Self-Deploy.`,
    ``,
    `**Commit:** \`${sha}\``,
    `**Phase:** ${phase}`,
    `**Grund:** ${reason}`,
    ``,
    `### Log-Auszug (letzte 200 Zeilen)`,
    "```",
    logTail.slice(-8000),
    "```",
    ``,
    `Ziel: Ursache finden und per PR beheben. Nach Merge auf \`main\` läuft Auto-Deploy automatisch weiter.`,
  ].join("\n");
  const t = await createTicket({
    projectId: self.id,
    type: "bug",
    title,
    description,
    priority: 20,
  });
  db.prepare("UPDATE tickets SET sprint_id = ? WHERE id = ?").run(sprintId, t.id);
  return t;
}

/**
 * Process a completed deployer run: update counters, promote successful image
 * to :previous, or create bug + escalate on failure. Called once per run.
 */
export async function handleDeployResult(
  row: DeployRunRow,
  sha: string,
  attempt: number
): Promise<void> {
  if (row.status === "success") {
    setConsecutiveFailures(0);
    // Promote the backup that was created pre-deploy → :previous for future rollbacks
    if (row.backup_id) {
      const b = getBackup(row.backup_id);
      if (b) {
        try {
          await setPreviousAlias(b);
        } catch (err) {
          console.error("[deploy] setPreviousAlias failed", err);
        }
      }
    }
    return;
  }

  // Failure path
  const failure = readFailureReport(row.id);
  const phase = failure?.phase ?? row.phase ?? "unknown";
  const reason = failure?.reason ?? "deploy failed";
  const logTail = failure?.log_tail ?? row.log_tail ?? "";

  setConsecutiveFailures(attempt);

  await createSelfDeployBug(sha, phase, reason, logTail);

  if (attempt >= MAX_ATTEMPTS) {
    setAutoDeployPaused(true);
    const prevId =
      failure?.prev_backup ||
      listBackups().find((b) => b.id !== row.backup_id)?.id ||
      null;
    const msg = [
      `🚨 *Self-Deploy* — nach ${MAX_ATTEMPTS} Fixversuchen fehlgeschlagen`,
      ``,
      `Letzter Commit: \`${sha}\``,
      `Phase: ${phase}`,
      `Grund: ${reason}`,
      prevId ? `Rollback auf Backup: \`${prevId}\`` : `Kein Backup zum Rollback verfügbar!`,
      ``,
      `Auto-Deploy ist pausiert. Befehle:`,
      `• \`/resume-deploy\` — Versuche wieder freigeben`,
      `• \`/rollback <backup-id>\` — auf anderen Backup zurück`,
      `• \`/backups\` — Liste anzeigen`,
    ].join("\n");
    try {
      await sendAdminAlert(msg);
    } catch (err) {
      console.error("[deploy] admin alert failed", err);
    }
  }

  if (failure) markFailureProcessed(row.id);
}

function readFailureReport(runId: string): FailureReport | null {
  const p = join(config.backupsContainerPath, "failures", `${runId}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FailureReport;
  } catch {
    return null;
  }
}

function markFailureProcessed(runId: string): void {
  const dir = join(config.backupsContainerPath, "failures");
  const src = join(dir, `${runId}.json`);
  const processedDir = join(dir, "processed");
  try {
    if (!existsSync(processedDir)) mkdirSync(processedDir, { recursive: true });
    renameSync(src, join(processedDir, `${runId}.json`));
  } catch (err) {
    console.error("[deploy] markFailureProcessed failed", err);
  }
}

/**
 * Scan failures dir for reports not already associated with a tracked deploy_run.
 * Called on boot: picks up failures that arrived while the orchestrator was
 * not running (e.g. hard-rollback happened in the deployer but orchestrator
 * never heard about it).
 */
export async function scanFailuresOnBoot(): Promise<void> {
  const dir = join(config.backupsContainerPath, "failures");
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const runId = f.replace(/\.json$/, "");
    // If we've seen this run id already in DB and handled it, skip.
    const row = db
      .prepare("SELECT * FROM deploy_runs WHERE id = ?")
      .get(runId) as DeployRunRow | undefined;
    const failure = readFailureReport(runId);
    if (!failure) continue;

    if (row && row.status !== "running") {
      // Already processed — move to processed/
      markFailureProcessed(runId);
      continue;
    }

    // Unhandled: record it + run the full handler path.
    if (!row) {
      db.prepare(
        `INSERT INTO deploy_runs(id, sha, status, phase, backup_id, attempt, log_tail, started_at, finished_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      ).run(
        runId,
        failure.sha ?? "",
        "failed",
        failure.phase,
        null,
        failure.attempt ?? getConsecutiveFailures() + 1,
        failure.log_tail?.slice(-20_000) ?? null,
        failure.finished_at ?? Date.now(),
        failure.finished_at ?? Date.now()
      );
    }
    const syntheticRow: DeployRunRow = {
      id: runId,
      sha: failure.sha ?? "",
      status: "failed",
      phase: failure.phase,
      backup_id: null,
      attempt: failure.attempt ?? getConsecutiveFailures() + 1,
      log_tail: failure.log_tail ?? null,
      started_at: failure.finished_at ?? Date.now(),
      finished_at: failure.finished_at ?? Date.now(),
    };
    await handleDeployResult(syntheticRow, failure.sha ?? "", syntheticRow.attempt);
  }
}

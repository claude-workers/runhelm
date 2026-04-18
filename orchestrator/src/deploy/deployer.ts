import { nanoid } from "nanoid";
import { config } from "../config.js";
import { db } from "../db.js";
import { docker } from "../docker.js";
import {
  clearAlertCredentials,
  writeAlertCredentials,
} from "./alerts.js";
import { createBackup, listBackups, pruneBackups } from "./backup.js";

export type DeployMode = "deploy" | "restore";

export type DeployRunStatus = "running" | "success" | "failed" | "rolled_back";

export type DeployRunRow = {
  id: string;
  sha: string;
  status: DeployRunStatus;
  phase: string | null;
  backup_id: string | null;
  attempt: number;
  log_tail: string | null;
  started_at: number;
  finished_at: number | null;
};

const DEPLOYER_IMAGE = process.env.DEPLOYER_IMAGE ?? "runhelm-deployer:latest";
const BACKUPS_KEEP = Number(process.env.BACKUPS_KEEP ?? 5);

function hostBackupsPath(): string {
  return `${config.stackHostPath}/data/backups`;
}
function hostDbPath(): string {
  return `${config.stackHostPath}/data/db`;
}
function composeProjectName(): string {
  const base = config.stackHostPath.replace(/\/+$/, "").split("/").pop();
  // compose sanitizes project names to [a-z0-9_-] — stack dir is already that.
  return (base ?? "claude-workers").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/**
 * Spawn a one-shot deployer container. Caller should `await waitForDeployer(id)`
 * if it needs to know the outcome; otherwise it runs detached and logs into
 * /data/backups/failures/<run_id>.json on failure.
 */
export async function spawnDeployer(opts: {
  mode: DeployMode;
  sha: string;
  attempt: number;
  /** id of the just-taken snapshot (deploy mode) or target backup (restore mode) */
  backupId: string;
  /** id of the last known-good backup to roll back to on failure */
  prevBackupId: string | null;
}): Promise<{ runId: string; containerId: string }> {
  const runId = `run-${nanoid(10)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO deploy_runs(id, sha, status, phase, backup_id, attempt, started_at)
     VALUES(?,?,?,?,?,?,?)`
  ).run(runId, opts.sha, "running", opts.mode, opts.backupId, opts.attempt, now);

  // Drop one-shot admin-alert credentials so the deployer can post to the
  // primary channel even if the orchestrator becomes unreachable post-rollback.
  try {
    writeAlertCredentials();
  } catch (err) {
    console.error("[deployer] writeAlertCredentials failed", err);
  }

  const container = await docker.createContainer({
    name: `runhelm-deployer-${runId}`,
    Image: DEPLOYER_IMAGE,
    Labels: { "claude.role": "deployer", "claude.run_id": runId },
    Env: [
      `RUN_ID=${runId}`,
      `MODE=${opts.mode}`,
      `SHA=${opts.sha}`,
      `ATTEMPT=${opts.attempt}`,
      `BACKUP_ID=${opts.backupId}`,
      `PREV_BACKUP_ID=${opts.prevBackupId ?? ""}`,
      `STACK_DIR=/stack`,
      `BACKUPS_DIR=/backups`,
      `DB_DIR=/db`,
      `ORCHESTRATOR_IMAGE=${config.orchestratorImage}`,
      // Use the orchestrator's container_name directly (set in compose). The
      // compose service alias "orchestrator" is not always visible to
      // non-compose containers attached to the network; the container_name
      // is registered as a DNS record on any user-defined network.
      `HEALTH_URL=http://runhelm:8787/healthz`,
      `COMPOSE_PROJECT=${composeProjectName()}`,
    ],
    HostConfig: {
      Binds: [
        `/var/run/docker.sock:/var/run/docker.sock:rw`,
        `${config.stackHostPath}:/stack:rw`,
        `${hostBackupsPath()}:/backups:rw`,
        `${hostDbPath()}:/db:rw`,
      ],
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [config.workerNetwork]: {},
      },
    },
  });

  await container.start();
  return { runId, containerId: container.id };
}

/**
 * Wait for a deployer container to exit. Updates the deploy_runs row with
 * the result and returns it. If the container cannot be found any more,
 * the row is marked as `failed`.
 */
export async function waitForDeployer(
  runId: string,
  containerId: string
): Promise<DeployRunRow> {
  let exitCode = -1;
  let logTail = "";
  try {
    const c = docker.getContainer(containerId);
    const res = await c.wait();
    exitCode = res.StatusCode ?? -1;
    try {
      const logsBuf = (await c.logs({
        stdout: true,
        stderr: true,
        tail: 200,
      })) as unknown as Buffer;
      logTail = logsBuf.toString("utf8");
    } catch {
      // ignore
    }
    try {
      await c.remove({ force: true });
    } catch {
      // ignore
    }
  } catch (err) {
    console.error(`[deployer] wait failed for ${runId}`, err);
  }

  const status: DeployRunStatus = exitCode === 0 ? "success" : "failed";
  db.prepare(
    `UPDATE deploy_runs
       SET status = ?, log_tail = ?, finished_at = ?
     WHERE id = ?`
  ).run(status, logTail.slice(-20_000), Date.now(), runId);

  try {
    clearAlertCredentials();
  } catch {
    // ignore
  }
  return (
    (db
      .prepare("SELECT * FROM deploy_runs WHERE id = ?")
      .get(runId) as DeployRunRow | undefined) ??
    ({
      id: runId,
      sha: "",
      status,
      phase: null,
      backup_id: null,
      attempt: 0,
      log_tail: logTail,
      started_at: 0,
      finished_at: Date.now(),
    } as DeployRunRow)
  );
}

/**
 * High-level "deploy" entry point: snapshot → spawn deployer → return IDs.
 * Caller should await `waitForDeployer` if synchronous outcome is needed.
 * Fails fast if the deployer image is missing.
 */
export async function startDeploy(sha: string, attempt = 1): Promise<{
  runId: string;
  containerId: string;
  backupId: string;
  prevBackupId: string | null;
}> {
  try {
    await docker.getImage(DEPLOYER_IMAGE).inspect();
  } catch {
    throw new Error(
      `Deployer image "${DEPLOYER_IMAGE}" missing. Build it once with: ` +
        `docker build -t ${DEPLOYER_IMAGE} ${config.stackHostPath}/deployer`
    );
  }

  const existing = listBackups();
  const prev = existing.length > 0 ? existing[0] : null;
  const fresh = await createBackup(`pre-deploy ${sha}`);
  await pruneBackups(BACKUPS_KEEP);

  const { runId, containerId } = await spawnDeployer({
    mode: "deploy",
    sha,
    attempt,
    backupId: fresh.id,
    prevBackupId: prev?.id ?? null,
  });
  return { runId, containerId, backupId: fresh.id, prevBackupId: prev?.id ?? null };
}

/** Trigger a restore to a specific backup id (admin-initiated rollback). */
export async function startRestore(backupId: string): Promise<{
  runId: string;
  containerId: string;
}> {
  try {
    await docker.getImage(DEPLOYER_IMAGE).inspect();
  } catch {
    throw new Error(`Deployer image "${DEPLOYER_IMAGE}" missing`);
  }
  return spawnDeployer({
    mode: "restore",
    sha: "",
    attempt: 1,
    backupId,
    prevBackupId: backupId,
  });
}

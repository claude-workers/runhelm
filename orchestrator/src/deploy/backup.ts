import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db.js";
import { config } from "../config.js";
import { docker } from "../docker.js";

export type BackupInfo = {
  id: string;           // timestamp string, e.g. "2026-04-18T10-22-15-123Z"
  createdAt: number;    // epoch ms
  dbFile: string;       // filename in backupsContainerPath, e.g. "db-<id>.sqlite"
  imageTag: string;     // full docker tag, e.g. "runhelm:backup-<id>"
  label: string | null; // optional free-form label
};

const META_SUFFIX = ".json";
const DB_PREFIX = "db-";
const IMAGE_TAG_PREFIX = "backup-";
const PREVIOUS_ALIAS = "previous";

function nowId(): string {
  // file-system-safe ISO: replace ":" and "." with "-"
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(): void {
  if (!existsSync(config.backupsContainerPath)) {
    mkdirSync(config.backupsContainerPath, { recursive: true });
  }
}

function metaPath(id: string): string {
  return join(config.backupsContainerPath, `${id}${META_SUFFIX}`);
}

function dbFileName(id: string): string {
  return `${DB_PREFIX}${id}.sqlite`;
}

function dbFilePath(id: string): string {
  return join(config.backupsContainerPath, dbFileName(id));
}

function imageRepo(): string {
  const [repo] = config.orchestratorImage.split(":");
  return repo || "runhelm";
}

function imageTagFor(id: string): string {
  return `${imageRepo()}:${IMAGE_TAG_PREFIX}${id}`;
}

/**
 * Create a full snapshot (DB + image tag) of the currently running orchestrator.
 * Safe to call while the orchestrator is serving requests — uses the SQLite
 * online backup API for a consistent copy.
 */
export async function createBackup(label?: string): Promise<BackupInfo> {
  ensureDir();
  const id = nowId();
  const info: BackupInfo = {
    id,
    createdAt: Date.now(),
    dbFile: dbFileName(id),
    imageTag: imageTagFor(id),
    label: label ?? null,
  };

  // 1) DB snapshot via SQLite online backup
  await (db as any).backup(dbFilePath(id));

  // 2) Tag current orchestrator image
  try {
    const img = docker.getImage(config.orchestratorImage);
    const [repo, tag] = info.imageTag.split(":");
    await img.tag({ repo, tag });
  } catch (err) {
    // If image-tag fails, remove the DB snapshot to avoid half-backups
    try {
      unlinkSync(dbFilePath(id));
    } catch {
      // ignore
    }
    throw new Error(
      `image tag failed: ${(err as Error).message} — backup aborted`
    );
  }

  writeFileSync(metaPath(id), JSON.stringify(info, null, 2));
  return info;
}

/**
 * Move the `:previous` alias to point at the given backup image, so the
 * deployer always has a one-hop rollback target.
 */
export async function setPreviousAlias(backup: BackupInfo): Promise<void> {
  const img = docker.getImage(backup.imageTag);
  await img.tag({ repo: imageRepo(), tag: PREVIOUS_ALIAS });
}

export function listBackups(): BackupInfo[] {
  ensureDir();
  const entries = readdirSync(config.backupsContainerPath);
  const infos: BackupInfo[] = [];
  for (const f of entries) {
    if (!f.endsWith(META_SUFFIX)) continue;
    try {
      const raw = readFileSync(join(config.backupsContainerPath, f), "utf8");
      infos.push(JSON.parse(raw) as BackupInfo);
    } catch {
      // ignore corrupt metadata
    }
  }
  return infos.sort((a, b) => b.createdAt - a.createdAt);
}

export function getBackup(id: string): BackupInfo | null {
  try {
    const raw = readFileSync(metaPath(id), "utf8");
    return JSON.parse(raw) as BackupInfo;
  } catch {
    return null;
  }
}

/**
 * Keep the most recent `keep` backups; delete the rest (DB file, metadata,
 * docker image tag). Returns the ids removed.
 */
export async function pruneBackups(keep: number): Promise<string[]> {
  const all = listBackups();
  if (all.length <= keep) return [];
  const toDelete = all.slice(keep);
  const removed: string[] = [];
  for (const b of toDelete) {
    try {
      const p = join(config.backupsContainerPath, b.dbFile);
      if (existsSync(p)) unlinkSync(p);
    } catch (err) {
      console.error(`[backup] unlink db ${b.id} failed`, err);
    }
    try {
      unlinkSync(metaPath(b.id));
    } catch (err) {
      console.error(`[backup] unlink meta ${b.id} failed`, err);
    }
    try {
      await docker.getImage(b.imageTag).remove({ noprune: false });
    } catch {
      // image may already be gone or still be referenced — ignore
    }
    removed.push(b.id);
  }
  return removed;
}

/** Size (bytes) of the db file on disk, for UI display. */
export function backupDbSize(b: BackupInfo): number {
  try {
    return statSync(join(config.backupsContainerPath, b.dbFile)).size;
  } catch {
    return 0;
  }
}

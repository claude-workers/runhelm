import { nanoid } from "nanoid";
import { db, getSetting, setSetting } from "./db.js";
import { cloneInto } from "./git.js";
import { channels, parseChannels, refFor, type ChannelId } from "./channels/index.js";
import { generateUniqueKey, type Project } from "./workers.js";

const SELF_SLUG = "runhelm";
const SELF_NAME = "Runhelm";
const DEFAULT_SELF_REPO_URL =
  "https://github.com/runhelm/runhelm.git";

export function getSelfRepoUrl(): string {
  const override = (getSetting("orchestrator_self_repo_url") ?? "").trim();
  return override || DEFAULT_SELF_REPO_URL;
}

export function setSelfRepoUrl(url: string): void {
  setSetting("orchestrator_self_repo_url", url.trim());
}

export function getSelfProject(): Project | null {
  return (
    (db
      .prepare("SELECT * FROM projects WHERE is_self = 1 LIMIT 1")
      .get() as Project | undefined) ?? null
  );
}

/**
 * Create the orchestrator self-project on first boot if it doesn't exist yet.
 * Chat channels are only attached if at least one is configured — otherwise the
 * project is created without channels and can be wired up later via the normal
 * project-edit UI.
 */
export async function ensureSelfProject(): Promise<Project | null> {
  const existing = getSelfProject();
  if (existing) return existing;

  const repoUrl = getSelfRepoUrl();
  const id = nanoid(12);

  try {
    await cloneInto(repoUrl, SELF_SLUG);
  } catch (err) {
    console.error("[self-project] clone failed", err);
    return null;
  }

  const selected: ChannelId[] = (["telegram", "matrix"] as const).filter((c) =>
    channels[c].isConfigured()
  );

  let tgTopicId: number | null = null;
  let matrixRoomId: string | null = null;
  for (const c of selected) {
    try {
      const ref = await channels[c].createProjectChannel(id, SELF_NAME);
      if (c === "telegram") tgTopicId = Number(ref);
      else matrixRoomId = ref;
    } catch (err) {
      console.error(`[self-project] create ${c} channel failed`, err);
    }
  }

  const now = Date.now();
  const key = generateUniqueKey(SELF_NAME);
  db.prepare(
    `INSERT INTO projects(
       id, slug, key, name, description, repo_url, policy,
       tg_topic_id, matrix_room_id, channels,
       upstream_repo, upstream_default_branch, current_branch,
       is_self, created_at, updated_at
     )
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 1, ?, ?)`
  ).run(
    id,
    SELF_SLUG,
    key,
    SELF_NAME,
    "Self-managed orchestrator code — PRs on main trigger auto-deploy.",
    repoUrl,
    "dev",
    tgTopicId,
    matrixRoomId,
    JSON.stringify(selected.length > 0 ? selected : ["telegram"]),
    null,
    null,
    null,
    now,
    now
  );

  const created = getSelfProject()!;

  const welcome = [
    `🔁 Self-Project *${SELF_NAME}* bereit.`,
    `Repo: ${repoUrl}`,
    `PR → main löst Auto-Deploy aus. Fehlschläge werden als Bug-Tickets hier aufgenommen.`,
  ].join("\n");
  for (const c of parseChannels(created.channels)) {
    const ref = refFor(c, created);
    if (!ref) continue;
    try {
      await channels[c].sendMessage(ref, welcome, { markdown: true });
    } catch (err) {
      console.error(`[self-project] welcome on ${c} failed`, err);
    }
  }

  return created;
}

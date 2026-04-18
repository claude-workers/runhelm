import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { db, getSecret } from "./db.js";
import { createPullRequest } from "./github.js";
import { getGitIdentity } from "./git-identity.js";

/** Build the `http.extraheader` flag carrying a short-lived Basic-auth
 *  so the PAT never lands in `.git/config`. Returns an empty array when no
 *  PAT is configured (public repos still work). */
function authHeaderFlags(): string[] {
  const token = getSecret("github_pat");
  if (!token) return [];
  const b64 = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return ["-c", `http.extraheader=Authorization: Basic ${b64}`];
}

type ProjectRow = {
  id: string;
  slug: string;
  repo_url: string | null;
  upstream_repo: string | null;
  upstream_default_branch: string | null;
  current_branch: string | null;
};

export async function cloneInto(cloneUrl: string, slug: string): Promise<void> {
  const path = `${config.reposContainerPath}/${slug}`;
  if (existsSync(path)) return;
  mkdirSync(config.reposContainerPath, { recursive: true });
  // IMPORTANT: never embed the PAT into the stored remote URL. Supply it only
  // via an http.extraheader for this single invocation so it doesn't end up in
  // `.git/config` where `git remote -v` would print it.
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      "git",
      [...authHeaderFlags(), "clone", cloneUrl, path],
      { stdio: "inherit" }
    );
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`git clone exited ${code}`))
    );
  });
}

export async function hasUncommitted(slug: string): Promise<boolean> {
  const out = await gitInRepo(slug, ["status", "--porcelain"]);
  return out.trim().length > 0;
}

export async function currentBranch(slug: string): Promise<string> {
  return await gitInRepo(slug, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function switchToTicketBranch(
  slug: string,
  branch: string,
  baseRef: string
): Promise<void> {
  try {
    await gitInRepo(slug, ["switch", branch]);
  } catch {
    await gitInRepo(slug, ["switch", "-c", branch, baseRef]);
  }
}

export async function commitWip(slug: string, msg: string): Promise<boolean> {
  if (!(await hasUncommitted(slug))) return false;
  const id = getGitIdentity();
  await gitInRepo(slug, ["add", "-A"]);
  await gitInRepo(slug, [
    "-c", `user.email=${id.email}`,
    "-c", `user.name=${id.name}`,
    "commit", "-m", msg,
  ]);
  return true;
}

export async function pushBranch(slug: string, branch: string): Promise<void> {
  await gitInRepo(slug, [...authHeaderFlags(), "push", "-u", "origin", branch]);
}

/** Helper for read-side remote ops (fetch/pull). */
export async function fetchInRepo(slug: string, args: string[]): Promise<string> {
  return gitInRepo(slug, [...authHeaderFlags(), ...args]);
}

export async function commitWipAndPush(
  slug: string,
  branch: string,
  msg: string
): Promise<boolean> {
  const did = await commitWip(slug, msg);
  try {
    await pushBranch(slug, branch);
  } catch (err) {
    console.error(`[git] push ${branch} failed`, err);
  }
  return did;
}

export async function mergeBranchInto(
  slug: string,
  source: string,
  target: string,
  commitMsg: string
): Promise<void> {
  const id = getGitIdentity();
  await fetchInRepo(slug, ["fetch", "origin"]);
  // ensure target branch exists locally and is up-to-date with origin
  try {
    await gitInRepo(slug, ["switch", target]);
    await fetchInRepo(slug, ["pull", "--ff-only", "origin", target]);
  } catch {
    await gitInRepo(slug, ["switch", "-c", target, `origin/${target}`]);
  }
  await gitInRepo(slug, [
    "-c", `user.email=${id.email}`,
    "-c", `user.name=${id.name}`,
    "merge", "--no-ff", "-m", commitMsg, source,
  ]);
  await pushBranch(slug, target);
}

export async function ensureBranchFromBase(
  slug: string,
  branch: string,
  baseRef: string
): Promise<void> {
  await fetchInRepo(slug, ["fetch", "--all", "--prune"]);
  try {
    await gitInRepo(slug, ["switch", branch]);
  } catch {
    await gitInRepo(slug, ["switch", "-c", branch, baseRef]);
  }
  await pushBranch(slug, branch);
}

export async function gitInRepo(slug: string, args: string[]): Promise<string> {
  const cwd = `${config.reposContainerPath}/${slug}`;
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const p = spawn(
      "git",
      ["-c", "safe.directory=*", ...args],
      { cwd, stdio: ["ignore", "pipe", "pipe"] }
    );
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8").trim());
      else
        reject(
          new Error(
            `git ${args.join(" ")} exited ${code}: ${Buffer.concat(err).toString("utf8")}`
          )
        );
    });
  });
}

export async function openPullRequest(
  projectId: string,
  title: string,
  body?: string
): Promise<{ url: string; number: number; newBranch: string }> {
  const p = db
    .prepare<[string], ProjectRow>(
      "SELECT id, slug, repo_url, upstream_repo, upstream_default_branch, current_branch FROM projects WHERE id = ?"
    )
    .get(projectId);
  if (!p) throw new Error("project not found");
  if (!p.upstream_repo || !p.upstream_default_branch || !p.current_branch) {
    throw new Error("Projekt ist kein Fork — kein PR möglich.");
  }

  const branch = p.current_branch;
  await pushBranch(p.slug, branch);

  const [upstreamOwner, upstreamRepo] = p.upstream_repo.split("/");
  const forkOwner = extractForkOwner(p.repo_url);
  const head = `${forkOwner}:${branch}`;
  const pr = await createPullRequest(
    upstreamOwner,
    upstreamRepo,
    head,
    p.upstream_default_branch,
    title,
    body
  );

  const newBranch = `claude/work-${nanoid(6)}`;
  await fetchInRepo(p.slug, ["fetch", "upstream"]);
  await gitInRepo(p.slug, [
    "switch",
    "-c",
    newBranch,
    `upstream/${p.upstream_default_branch}`,
  ]);
  db.prepare("UPDATE projects SET current_branch = ?, updated_at = ? WHERE id = ?").run(
    newBranch,
    Date.now(),
    projectId
  );

  return { url: pr.url, number: pr.number, newBranch };
}

function extractForkOwner(repoUrl: string | null): string {
  if (!repoUrl) throw new Error("Fork-Repo-URL fehlt");
  const m = repoUrl.match(/github\.com\/([^/]+)\/[^/]+$/);
  if (!m) throw new Error(`unerwartete Repo-URL: ${repoUrl}`);
  return m[1];
}

function parseRepoFromUrl(repoUrl: string): { owner: string; repo: string } {
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`unerwartete Repo-URL: ${repoUrl}`);
  return { owner: m[1], repo: m[2] };
}

/**
 * Open a PR from a sprint branch into the project's main/default branch.
 * For fork projects: PR goes to upstream. For own repos: PR within same repo.
 */
export async function openSprintPullRequest(
  projectId: string,
  sprintBranch: string,
  title: string,
  body?: string
): Promise<{ url: string; number: number }> {
  const p = db
    .prepare<[string], ProjectRow>(
      "SELECT id, slug, repo_url, upstream_repo, upstream_default_branch, current_branch FROM projects WHERE id = ?"
    )
    .get(projectId);
  if (!p) throw new Error("project not found");
  if (!p.repo_url) throw new Error("Projekt hat keine Repo-URL");

  await pushBranch(p.slug, sprintBranch);

  if (p.upstream_repo && p.upstream_default_branch) {
    const [upstreamOwner, upstreamRepo] = p.upstream_repo.split("/");
    const forkOwner = extractForkOwner(p.repo_url);
    const head = `${forkOwner}:${sprintBranch}`;
    return await createPullRequest(
      upstreamOwner,
      upstreamRepo,
      head,
      p.upstream_default_branch,
      title,
      body
    );
  }

  // Non-fork: PR within the project's own repo
  const { owner, repo } = parseRepoFromUrl(p.repo_url);
  let base = "main";
  try {
    const head = await gitInRepo(p.slug, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    const m = head.match(/refs\/remotes\/origin\/(.+)$/);
    if (m) base = m[1];
  } catch {
    // ignore
  }
  return await createPullRequest(owner, repo, sprintBranch, base, title, body);
}

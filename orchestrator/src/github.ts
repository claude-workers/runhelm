import { Octokit } from "@octokit/rest";
import { getSecret } from "./db.js";

function client(): Octokit {
  const token = getSecret("github_pat");
  if (!token) throw new Error("GitHub PAT not configured");
  return new Octokit({ auth: token });
}

export async function validatePat(token: string): Promise<{
  ok: boolean;
  login?: string;
  scopes?: string[];
  error?: string;
}> {
  try {
    const o = new Octokit({ auth: token });
    const res = await o.request("GET /user");
    const scopes = (res.headers["x-oauth-scopes"] as string | undefined) ?? "";
    return {
      ok: true,
      login: (res.data as { login: string }).login,
      scopes: scopes.split(",").map((s) => s.trim()).filter(Boolean),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function createRepo(name: string, description?: string): Promise<{
  url: string;
  clone_url: string;
  full_name: string;
  default_branch: string;
}> {
  const o = client();
  const res = await o.repos.createForAuthenticatedUser({
    name,
    description,
    private: true,
    auto_init: true,
  });
  return {
    url: res.data.html_url,
    clone_url: res.data.clone_url,
    full_name: res.data.full_name,
    default_branch: res.data.default_branch ?? "main",
  };
}

export function parseRepoRef(input: string): { owner: string; repo: string } {
  let s = input.trim();
  s = s.replace(/^https?:\/\/github\.com\//, "");
  s = s.replace(/\.git$/, "");
  s = s.replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`ungültige Repo-Referenz: "${input}" (erwartet "owner/repo" oder URL)`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export async function forkRepo(
  upstreamOwner: string,
  upstreamRepo: string
): Promise<{
  url: string;
  clone_url: string;
  full_name: string;
  owner: string;
  default_branch: string;
  upstream_default_branch: string;
}> {
  const o = client();
  const upstream = await o.repos.get({ owner: upstreamOwner, repo: upstreamRepo });
  const fork = await o.repos.createFork({ owner: upstreamOwner, repo: upstreamRepo });
  return {
    url: fork.data.html_url,
    clone_url: fork.data.clone_url,
    full_name: fork.data.full_name,
    owner: fork.data.owner.login,
    default_branch: fork.data.default_branch ?? "main",
    upstream_default_branch: upstream.data.default_branch ?? "main",
  };
}

export async function createPullRequest(
  upstreamOwner: string,
  upstreamRepo: string,
  head: string, // "forkOwner:branch"
  base: string, // upstream default branch
  title: string,
  body?: string
): Promise<{ url: string; number: number }> {
  const o = client();
  const res = await o.pulls.create({
    owner: upstreamOwner,
    repo: upstreamRepo,
    title,
    body,
    head,
    base,
  });
  return { url: res.data.html_url, number: res.data.number };
}

export async function deleteRepo(fullName: string): Promise<void> {
  const [owner, repo] = fullName.split("/");
  const o = client();
  await o.repos.delete({ owner, repo });
}

export async function addCollaborator(
  fullName: string,
  username: string,
  permission: "pull" | "triage" | "push" | "maintain" | "admin" = "admin"
): Promise<void> {
  const [owner, repo] = fullName.split("/");
  const o = client();
  await o.repos.addCollaborator({ owner, repo, username, permission });
}

/** Latest commit SHA on a branch (default "main"). */
export async function getBranchHead(
  owner: string,
  repo: string,
  branch: string = "main"
): Promise<string> {
  const o = client();
  const res = await o.repos.getBranch({ owner, repo, branch });
  return res.data.commit.sha;
}


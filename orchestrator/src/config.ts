import { resolve } from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  secretKey: required("SECRET_KEY"),
  uiBasicAuth: process.env.UI_BASIC_AUTH ?? "",
  workerImage: process.env.WORKER_IMAGE ?? "runhelm-worker:latest",
  workerNetwork: process.env.WORKER_NETWORK ?? "claude-workers_workers",
  reposHostPath: required("REPOS_HOST_PATH"),
  claudeAuthHostPath: required("CLAUDE_AUTH_HOST_PATH"),
  orchestratorInternalUrl:
    process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8787",
  dbPath: process.env.DB_PATH ?? "/data/db/orchestrator.sqlite",
  reposContainerPath: process.env.REPOS_CONTAINER_PATH ?? "/data/repos",
  claudeAuthContainerPath:
    process.env.CLAUDE_AUTH_CONTAINER_PATH ?? "/data/claude-auth",
  backupsContainerPath: process.env.BACKUPS_CONTAINER_PATH ?? "/data/backups",
  workerPuid: Number(process.env.WORKER_PUID ?? 1000),
  workerPgid: Number(process.env.WORKER_PGID ?? 1000),
  workerDockerGid: Number(process.env.WORKER_DOCKER_GID ?? 989),
  stackHostPath: process.env.STACK_HOST_PATH ?? "/opt/docker/stacks/claude-workers",
  orchestratorImage:
    process.env.ORCHESTRATOR_IMAGE ?? "runhelm:latest",
};

export function resolveRepoHostPath(slug: string): string {
  return resolve(config.reposHostPath, slug);
}

export function resolveRepoContainerPath(slug: string): string {
  return resolve(config.reposContainerPath, slug);
}

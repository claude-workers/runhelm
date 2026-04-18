import Docker from "dockerode";
import { config, resolveRepoHostPath } from "./config.js";
import { getGitIdentity } from "./git-identity.js";

export const docker = new Docker({ socketPath: "/var/run/docker.sock" });

export type WorkerRunOpts = {
  workerId: string;
  projectId: string;
  projectSlug: string;
  policy: string;
  tgTopicId: number | null;
  systemPrompt?: string;
};

const LABEL_ROLE = "claude.role";
const LABEL_WORKER = "claude.worker";
const LABEL_PROJECT = "claude.project";

export async function ensureNetwork(): Promise<void> {
  try {
    await docker.getNetwork(config.workerNetwork).inspect();
  } catch {
    await docker.createNetwork({ Name: config.workerNetwork, Driver: "bridge" });
  }
}

export async function startWorkerContainer(opts: WorkerRunOpts): Promise<string> {
  await ensureNetwork();

  const name = `runhelm-worker-${opts.projectSlug}-${opts.workerId.slice(0, 8)}`;
  const repoHostPath = resolveRepoHostPath(opts.projectSlug);

  const container = await docker.createContainer({
    name,
    Image: config.workerImage,
    Labels: {
      [LABEL_ROLE]: "worker",
      [LABEL_WORKER]: opts.workerId,
      [LABEL_PROJECT]: opts.projectId,
    },
    Env: (() => {
      const id = getGitIdentity();
      const env = [
        `WORKER_ID=${opts.workerId}`,
        `PROJECT_ID=${opts.projectId}`,
        `PROJECT_SLUG=${opts.projectSlug}`,
        `POLICY=${opts.policy}`,
        `TG_TOPIC_ID=${opts.tgTopicId ?? ""}`,
        `ORCHESTRATOR_URL=${config.orchestratorInternalUrl}`,
        `HOME=/home/worker`,
        `CLAUDE_CONFIG_DIR=/home/worker/.claude`,
        `GIT_AUTHOR_NAME=${id.name}`,
        `GIT_AUTHOR_EMAIL=${id.email}`,
        `GIT_COMMITTER_NAME=${id.name}`,
        `GIT_COMMITTER_EMAIL=${id.email}`,
      ];
      if (opts.systemPrompt && opts.systemPrompt.trim()) {
        env.push(`SYSTEM_PROMPT_APPEND=${opts.systemPrompt}`);
      }
      return env;
    })(),
    HostConfig: {
      Binds: [
        `${repoHostPath}:/workspace:rw`,
        `${config.claudeAuthHostPath}:/home/worker/.claude:rw`,
        `/var/run/docker.sock:/var/run/docker.sock:rw`,
      ],
      NetworkMode: config.workerNetwork,
      RestartPolicy: { Name: "unless-stopped" },
      AutoRemove: false,
      GroupAdd: [String(config.workerDockerGid)],
    },
    User: `${config.workerPuid}:${config.workerPgid}`,
    WorkingDir: "/workspace",
  });

  await container.start();
  return container.id;
}

export async function stopContainer(id: string): Promise<void> {
  try {
    const c = docker.getContainer(id);
    await c.stop({ t: 10 });
  } catch {
    // ignore
  }
}

export async function removeContainer(id: string): Promise<void> {
  try {
    const c = docker.getContainer(id);
    await c.remove({ force: true });
  } catch {
    // ignore
  }
}

export async function containerStatus(id: string): Promise<string> {
  try {
    const info = await docker.getContainer(id).inspect();
    return info.State.Status;
  } catch {
    return "gone";
  }
}

/**
 * Start a short-lived container for `claude login`. The container runs
 * interactively; the caller attaches via /attach/:id to the docker stream.
 */
export async function startLoginContainer(): Promise<string> {
  await ensureNetwork();

  const container = await docker.createContainer({
    name: `claude-login-${Date.now()}`,
    Image: config.workerImage,
    Labels: { [LABEL_ROLE]: "login" },
    Env: [
      `HOME=/home/worker`,
      `CLAUDE_CONFIG_DIR=/home/worker/.claude`,
    ],
    Tty: true,
    OpenStdin: true,
    HostConfig: {
      Binds: [`${config.claudeAuthHostPath}:/home/worker/.claude:rw`],
      NetworkMode: config.workerNetwork,
      AutoRemove: true,
    },
    User: `${config.workerPuid}:${config.workerPgid}`,
    Entrypoint: ["/bin/bash"],
    Cmd: ["-lc", "echo 'login container ready'; sleep 3600"],
  });
  await container.start();
  return container.id;
}

export async function attachContainer(id: string): Promise<NodeJS.ReadWriteStream> {
  const c = docker.getContainer(id);
  const stream = await c.attach({
    stream: true,
    stdin: true,
    stdout: true,
    stderr: true,
    hijack: true,
  });
  return stream as unknown as NodeJS.ReadWriteStream;
}

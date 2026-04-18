import { getSetupStatus } from "../db.js";
import { getBranchHead, parseRepoRef } from "../github.js";
import { getSelfProject } from "../self-project.js";
import { startDeploy, waitForDeployer } from "./deployer.js";
import { handleDeployResult } from "./orchestrator.js";
import {
  getConsecutiveFailures,
  getLastSeenSha,
  getPollIntervalSeconds,
  isAutoDeployPaused,
  setLastSeenSha,
} from "./state.js";

export {
  getConsecutiveFailures,
  getLastSeenSha,
  getPollIntervalSeconds,
  isAutoDeployPaused,
  setAutoDeployPaused,
  setConsecutiveFailures,
  setLastSeenSha,
  setPollIntervalSeconds,
} from "./state.js";

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** Start the background poller. Idempotent. */
export function startSelfDeployPoller(): void {
  if (timer) return;
  const schedule = () => {
    const ms = getPollIntervalSeconds() * 1000;
    timer = setTimeout(async () => {
      try {
        await tick();
      } catch (err) {
        console.error("[self-deploy] poller tick failed", err);
      }
      schedule();
    }, ms);
  };
  schedule();
}

export function stopSelfDeployPoller(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (isAutoDeployPaused()) return;
    if (!getSetupStatus().github) return;

    const self = getSelfProject();
    if (!self || !self.repo_url) return;

    // parse "https://github.com/owner/repo(.git)" out of the repo_url
    let owner: string;
    let repo: string;
    try {
      ({ owner, repo } = parseRepoRef(self.repo_url));
    } catch {
      return;
    }

    let head: string;
    try {
      head = await getBranchHead(owner, repo, "main");
    } catch (err) {
      console.error("[self-deploy] getBranchHead failed", err);
      return;
    }

    const last = getLastSeenSha();
    if (last === head) return;

    // First sighting ever: don't deploy — just mark as baseline.
    if (!last) {
      setLastSeenSha(head);
      return;
    }

    const failures = getConsecutiveFailures();
    if (failures >= 3) return; // escalation in place, waiting for /resume-deploy

    console.log(`[self-deploy] new main sha ${head} (was ${last}) — deploying`);
    const attempt = failures + 1;
    let runId: string | null = null;
    let containerId: string | null = null;
    try {
      const r = await startDeploy(head, attempt);
      runId = r.runId;
      containerId = r.containerId;
    } catch (err) {
      console.error("[self-deploy] startDeploy failed", err);
      // Don't touch last_sha — we'll retry on next tick.
      return;
    }

    setLastSeenSha(head);

    // Fire-and-forget completion handler so the poller returns immediately
    waitForDeployer(runId!, containerId!)
      .then((row) => handleDeployResult(row, head, attempt))
      .catch((err) => console.error("[self-deploy] handleDeployResult failed", err));
  } finally {
    ticking = false;
  }
}

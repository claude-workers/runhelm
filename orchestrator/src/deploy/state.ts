import { getSetting, setSetting } from "../db.js";

const DEFAULT_INTERVAL_S = 60;

export function getPollIntervalSeconds(): number {
  const raw = getSetting("self_deploy_poll_interval_s");
  const v = raw ? Number(raw) : DEFAULT_INTERVAL_S;
  if (!Number.isFinite(v) || v < 10) return DEFAULT_INTERVAL_S;
  return v;
}

export function setPollIntervalSeconds(v: number): void {
  if (!Number.isFinite(v) || v < 10) {
    throw new Error("intervall muss eine Zahl ≥ 10 sein");
  }
  setSetting("self_deploy_poll_interval_s", String(Math.round(v)));
}

export function isAutoDeployPaused(): boolean {
  return getSetting("auto_deploy_paused") === "1";
}

export function setAutoDeployPaused(paused: boolean): void {
  setSetting("auto_deploy_paused", paused ? "1" : "0");
}

export function getConsecutiveFailures(): number {
  const raw = getSetting("consecutive_deploy_failures");
  const v = raw ? Number(raw) : 0;
  return Number.isFinite(v) ? v : 0;
}

export function setConsecutiveFailures(n: number): void {
  setSetting("consecutive_deploy_failures", String(Math.max(0, Math.round(n))));
}

export function getLastSeenSha(): string | null {
  return getSetting("self_deploy_last_sha");
}

export function setLastSeenSha(sha: string): void {
  setSetting("self_deploy_last_sha", sha);
}

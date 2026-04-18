import { getSetting } from "./db.js";

export const DEFAULT_GIT_NAME = "Runhelm-Worker";
export const DEFAULT_GIT_EMAIL = "runhelm-worker@xxxxxxxx.xyz";

export function getGitIdentity(): { name: string; email: string } {
  return {
    name: getSetting("git_author_name") || DEFAULT_GIT_NAME,
    email: getSetting("git_author_email") || DEFAULT_GIT_EMAIL,
  };
}

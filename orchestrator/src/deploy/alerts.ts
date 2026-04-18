import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { getSecret, getSetting } from "../db.js";
import { getSelfProject } from "../self-project-query.js";
import { telegramChannel } from "../channels/telegram.js";
import { matrixChannel } from "../channels/matrix.js";

export type AdminChannel = "telegram" | "matrix";

export function getPrimaryChannel(): AdminChannel | null {
  const raw = getSetting("primary_channel");
  if (raw === "telegram" || raw === "matrix") return raw;
  return null;
}

/**
 * Post an admin alert on the configured primary channel. Falls back silently
 * if no primary channel is set. Uses a "root" chat ref, not a project thread.
 */
export async function sendAdminAlert(text: string): Promise<void> {
  const channel = getPrimaryChannel();
  if (!channel) {
    console.warn("[alerts] no primary_channel configured — dropping alert");
    return;
  }

  if (channel === "telegram") {
    const chatId = getSetting("telegram_chat_id");
    if (!chatId || !telegramChannel.isConfigured()) {
      console.warn("[alerts] telegram not configured");
      return;
    }
    // Send to supergroup root (no message_thread_id).
    await telegramChannel.sendMessage(chatId, text, { markdown: true });
    return;
  }

  // matrix: prefer the self-project's room as the admin feed
  const self = getSelfProject();
  const roomId = self?.matrix_room_id ?? null;
  if (!roomId || !matrixChannel.isConfigured()) {
    console.warn("[alerts] matrix admin room not available");
    return;
  }
  await matrixChannel.sendMessage(roomId, text);
}

/**
 * Drop a one-shot credentials file the deployer sidecar can read when it has
 * to alert on its own (orchestrator unreachable after a failed rollback).
 * Removed after deployer finishes.
 */
export function writeAlertCredentials(): void {
  const channel = getPrimaryChannel();
  if (!channel) return;

  const payload: Record<string, unknown> = { channel };
  if (channel === "telegram") {
    const token = getSecret("telegram_token");
    const chatId = getSetting("telegram_chat_id");
    if (!token || !chatId) return;
    payload.telegram_token = token;
    payload.telegram_chat_id = chatId;
  } else {
    const token = getSecret("matrix_access_token");
    const hs = getSetting("matrix_homeserver_url");
    const self = getSelfProject();
    const roomId = self?.matrix_room_id ?? null;
    if (!token || !hs || !roomId) return;
    payload.matrix_access_token = token;
    payload.matrix_homeserver_url = hs;
    payload.matrix_room_id = roomId;
  }

  if (!existsSync(config.backupsContainerPath)) {
    mkdirSync(config.backupsContainerPath, { recursive: true });
  }
  writeFileSync(
    join(config.backupsContainerPath, "alert-credentials.json"),
    JSON.stringify(payload),
    { mode: 0o600 }
  );
}

export function clearAlertCredentials(): void {
  const p = join(config.backupsContainerPath, "alert-credentials.json");
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

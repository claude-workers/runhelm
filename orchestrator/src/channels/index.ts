export type ChannelId = "telegram" | "matrix";

export interface ChatChannel {
  readonly id: ChannelId;
  isConfigured(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendTestMessage(): Promise<{ ok: boolean; error?: string }>;
  createProjectChannel(projectId: string, name: string): Promise<string>;
  deleteProjectChannel(ref: string): Promise<void>;
  renameProjectChannel(ref: string, newName: string): Promise<void>;
  sendMessage(ref: string, text: string, opts?: { markdown?: boolean }): Promise<void>;
  sendPermissionRequest(
    ref: string,
    requestId: string,
    tool: string,
    summary: string
  ): Promise<void>;
}

import { telegramChannel } from "./telegram.js";
import { matrixChannel } from "./matrix.js";

export const channels: Record<ChannelId, ChatChannel> = {
  telegram: telegramChannel,
  matrix: matrixChannel,
};

export function parseChannels(raw: string | null | undefined): ChannelId[] {
  if (!raw) return ["telegram"];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return ["telegram"];
    return arr.filter(
      (x): x is ChannelId => x === "telegram" || x === "matrix"
    );
  } catch {
    return ["telegram"];
  }
}

export function refFor(
  channel: ChannelId,
  project: { tg_topic_id: number | null; matrix_room_id: string | null }
): string | null {
  if (channel === "telegram")
    return project.tg_topic_id != null ? String(project.tg_topic_id) : null;
  return project.matrix_room_id ?? null;
}

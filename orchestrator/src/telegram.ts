// Compatibility shim: the telegram implementation moved to channels/telegram.ts.
// Keep the old entrypoints alive so server.ts / setup routes do not need to care.
import { telegramChannel, markTelegramConfigured } from "./channels/telegram.js";

export async function restartBot(): Promise<void> {
  await telegramChannel.start();
}

export async function sendTestMessage(): Promise<{ ok: boolean; error?: string }> {
  return telegramChannel.sendTestMessage();
}

export { markTelegramConfigured };

import { listBackups, backupDbSize } from "./backup.js";
import { startRestore } from "./deployer.js";
import {
  getConsecutiveFailures,
  getLastSeenSha,
  isAutoDeployPaused,
  setAutoDeployPaused,
  setConsecutiveFailures,
} from "./poller.js";

export type AdminReply = string;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** Parse and handle an admin-channel command. Returns reply text, or null if
 *  the input is not a recognized admin command. */
export async function handleAdminCommand(input: string): Promise<AdminReply | null> {
  const line = input.trim();
  if (!line.startsWith("/")) return null;
  const [rawCmd, ...rest] = line.split(/\s+/);
  // Strip trailing "@botname" that Telegram may append
  const cmd = rawCmd.split("@")[0].toLowerCase();

  switch (cmd) {
    case "/deploy-status": {
      const lines = [
        `*Self-Deploy Status*`,
        `• paused: ${isAutoDeployPaused() ? "🛑 ja" : "✅ nein"}`,
        `• consecutive_failures: ${getConsecutiveFailures()}`,
        `• last_sha: \`${getLastSeenSha() ?? "—"}\``,
      ];
      return lines.join("\n");
    }

    case "/resume-deploy": {
      setAutoDeployPaused(false);
      setConsecutiveFailures(0);
      return "✅ Auto-Deploy fortgesetzt. Nächster Poll-Tick triggert ggf. einen neuen Versuch.";
    }

    case "/backups": {
      const all = listBackups();
      if (all.length === 0) return "Keine Backups vorhanden.";
      const lines = all.slice(0, 20).map((b) => {
        const size = fmtSize(backupDbSize(b));
        const label = b.label ? ` — ${b.label}` : "";
        return `• \`${b.id}\` (${fmtDate(b.createdAt)}, DB ${size})${label}`;
      });
      return `*Backups (neueste zuerst):*\n${lines.join("\n")}`;
    }

    case "/rollback": {
      const id = rest[0];
      if (!id) {
        return "Nutzung: `/rollback <backup-id>` — IDs mit `/backups` auflisten.";
      }
      const exists = listBackups().some((b) => b.id === id);
      if (!exists) return `❌ Backup \`${id}\` nicht gefunden.`;
      try {
        const r = await startRestore(id);
        return `↩️ Rollback auf \`${id}\` gestartet (run \`${r.runId}\`).`;
      } catch (e) {
        return `❌ Rollback-Start fehlgeschlagen: ${(e as Error).message}`;
      }
    }

    case "/deploy-help": {
      return [
        "*Deploy-Admin-Kommandos*",
        "`/deploy-status` — Status anzeigen",
        "`/resume-deploy` — Pause aufheben, Zähler zurücksetzen",
        "`/backups` — Backups auflisten",
        "`/rollback <id>` — Rollback auf Backup-ID",
      ].join("\n");
    }

    default:
      return null;
  }
}

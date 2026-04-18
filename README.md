# Runhelm

Selbstgehostete WebUI, die mehrere AI-Agents pro Projekt in Docker-Containern
betreibt, mit Telegram-/Matrix-Kontrolle und einem Self-Deploy-Pfad, der sich
selbst weiterentwickelt.

Der Name: „at the helm of the run" — du sitzt am Steuer der laufenden Agent-Flotte.

## Voraussetzungen

- Docker + Docker Compose
- GitHub-Account mit Personal Access Token (`repo`-Scope, optional `delete_repo`)
- Telegram-Account, um Bot + Supergroup anzulegen
- Claude-Abo (Pro/Max) — Auth läuft über `claude login`

## Einmal-Setup

```bash
cd /opt/docker/stacks/claude-workers
cp .env.example .env
# SECRET_KEY generieren:
openssl rand -base64 32
# in .env eintragen, ggf. UI_BASIC_AUTH anpassen
# STACK_HOST_PATH prüfen (Default: /opt/docker/stacks/claude-workers) —
# muss auf den absoluten Pfad dieses Verzeichnisses zeigen, damit der
# Deployer-Sidecar compose build gegen die Host-Dateien ausführen kann.

# Worker-Image bauen (UID/GID = Host-User, Default 1000:1000)
docker build \
  --build-arg PUID=$(id -u) \
  --build-arg PGID=$(id -g) \
  -t runhelm-worker:latest ./worker-image

# Deployer-Image (für Self-Deploy) einmalig bauen
docker build -t runhelm-deployer:latest ./deployer

# Orchestrator starten (baut auch sein Image beim ersten Mal)
docker compose up -d --build
```

Öffne http://localhost:8787 (bzw. den gewählten Port). Der Wizard führt durch:

1. **GitHub-PAT** — Token einfügen
2. **Telegram**
   - Bot via [@BotFather](https://t.me/BotFather) anlegen
   - **Supergroup** erstellen, in Gruppen-Einstellungen **„Topics" aktivieren**
   - Bot einladen, als **Admin** mit Recht **„Manage Topics"**
   - Bot einmal in der Gruppe erwähnen (`/start`), dann `chat.id` per
     `https://api.telegram.org/bot<TOKEN>/getUpdates` holen (beginnt mit `-100…`)
3. **Claude-Login** — Button „Login-Container starten", dann auf dem Host:
   ```bash
   docker exec -it <container> claude login
   ```
   OAuth-Link im Browser öffnen, anmelden, fertig. Credentials landen im Volume
   `./data/claude-auth/` und werden von allen Workern gelesen.

## Projekt anlegen

- Dashboard → „Neues Projekt" → Name + Default-Policy
- Orchestrator legt privates GitHub-Repo an, cloned nach `./data/repos/<slug>/`,
  und erzeugt ein Telegram-Topic mit dem Projektnamen
- „Start" → Worker-Container läuft, Telegram-Topic empfängt Nachrichten

## Policies

| Policy       | Auto-erlaubt                                                |
|--------------|-------------------------------------------------------------|
| `read-only`  | Read, Glob, Grep, WebFetch, WebSearch                       |
| `safe`       | + Bash                                                      |
| `dev`        | + Edit, Write, NotebookEdit                                 |
| `full-auto`  | alles (bypassPermissions)                                   |

Zur Laufzeit änderbar: im Telegram-Topic `/policy`, oder über die WebUI.

## Telegram-Commands (pro Topic)

- freier Text → nächster User-Prompt für den Worker
- `/policy` → Policy umschalten
- `/stop` → Worker stoppen

## Self-Deploy

Der Orchestrator legt sich selbst als Projekt an (`SELF`-Badge im Dashboard,
Repo: `runhelm/runhelm`). Änderungen landen per normalem
Ticket- + PR-Flow auf GitHub. Ein Poller beobachtet `main` und löst bei neuem
Commit automatisch einen Deploy aus:

```
neuer SHA → Backup (Image-Tag + SQLite-Snapshot)
          → git pull + compose build + compose up -d --force-recreate
          → Healthcheck auf /healthz
          → OK: :previous-Alias umhängen, fertig
          → Fehler: Rollback auf vorheriges Backup, Bug-Ticket im ORC-Projekt
```

Nach 3 aufeinanderfolgenden Deploy-Fehlschlägen pausiert Auto-Deploy und
postet einen Alarm auf dem **Hauptkanal** (in den Einstellungen wählbar:
Telegram-Root oder Matrix-ORC-Raum). Admin-Kommandos im Hauptkanal:

- `/deploy-status` — Pause-Status + Fehlerzähler + letzter SHA
- `/resume-deploy` — Pause aufheben, Fehlerzähler zurücksetzen
- `/backups` — verfügbare Backups auflisten
- `/rollback <id>` — manueller Rollback auf ein Backup
- `/deploy-help` — Kurzhilfe

Poll-Intervall + Pause-Status sind im Setup-Wizard unter „Self-Deploy"
einstellbar.

## Datenablage

- `./data/db/` — SQLite mit Projekten/Workern/Events/Deploy-Runs
- `./data/repos/` — geklonte Git-Repos (per Worker bind-gemountet)
- `./data/claude-auth/` — geteiltes `~/.claude/` (Token aus `claude login`)
- `./data/backups/` — Self-Deploy Backups (DB-Snapshots + Failure-Reports)

## Architektur kurz

```
   ┌──────────────┐            ┌──────────────┐
   │  Browser UI  │◀─REST/WS──▶│ Orchestrator │──dockerode──▶  Worker-Container
   └──────────────┘            │   (Node/TS)  │                 │
                               │  SQLite      │                 │ Claude Agent SDK
                   Telegram◀───┤  grammY-Bot  │                 │ canUseTool → WS
                               │  Octokit     │                 ▼
                               └──────────────┘         /workspace (git repo)
                                                        /home/worker/.claude (ro)
                                                        /var/run/docker.sock
```

## Entwicklung

```bash
# im Orchestrator-Verzeichnis
cd orchestrator
npm install
npm run dev   # api :8787 + vite :5173 mit proxy
```

## Hinweis zur Claude-Auth

Der SDK nutzt denselben Binary wie die CLI und liest `~/.claude/.credentials.json`.
Läuft damit über dein persönliches Abo. Das ist **Eigenbedarf** — für öffentliche
Distribution verlangt Anthropic API-Key-Auth (siehe Agent-SDK-Docs).

<!-- deploy smoke test 2026-04-18T21:46:07Z -->

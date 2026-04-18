import { useEffect, useState } from "react";
import { api, type SetupStatus } from "../api";

type Props = {
  onChange: (s: SetupStatus) => void;
};

export function Setup({ onChange }: Props) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const refresh = () =>
    api<SetupStatus>("/api/setup/status").then((s) => {
      setStatus(s);
      onChange(s);
    });

  useEffect(() => {
    refresh();
  }, []);

  if (!status) return <div className="container">lade…</div>;

  return (
    <div className="container">
      <h1>Setup</h1>
      <p className="muted">
        GitHub-PAT, mind. ein Chat-Channel (Telegram und/oder Matrix), Claude-Login.
      </p>

      <GithubStep done={status.github} refresh={refresh} />
      <TelegramStep done={status.telegram} refresh={refresh} />
      <MatrixStep done={status.matrix} refresh={refresh} />
      <ClaudeStep done={status.claude} refresh={refresh} />
      <GitIdentityStep />
      <GlobalSystemPromptStep />
      <StatusColorsStep />
      <PrimaryChannelStep
        telegramReady={status.telegram}
        matrixReady={status.matrix}
      />
      <SelfDeployStep />

      {status.done && (
        <div className="card">
          <h2>✅ Setup abgeschlossen</h2>
          <a href="#/">Zum Dashboard</a>
        </div>
      )}
    </div>
  );
}

function GithubStep({ done, refresh }: { done: boolean; refresh: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  const [collaborators, setCollaborators] = useState<string>("");
  const [collabSaved, setCollabSaved] = useState(false);

  useEffect(() => {
    api<{ collaborators: string }>("/api/setup/github/collaborators")
      .then((r) => setCollaborators(r.collaborators))
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ login: string }>("/api/setup/github", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setLogin(res.login);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveCollab = async () => {
    await api("/api/setup/github/collaborators", {
      method: "PUT",
      body: JSON.stringify({ collaborators }),
    });
    setCollabSaved(true);
    setTimeout(() => setCollabSaved(false), 2000);
  };

  return (
    <div className="card">
      <h2>
        1. GitHub {done ? <span className="badge ok">erledigt</span> : <span className="badge warn">offen</span>}
      </h2>
      <p className="muted">
        Personal Access Token mit Scope <code>repo</code> (optional{" "}
        <code>delete_repo</code> falls Projekte später entfernt werden sollen).
      </p>
      <p className="muted">
        Erstellen:{" "}
        <a href="https://github.com/settings/tokens/new" target="_blank">
          github.com/settings/tokens/new
        </a>
      </p>
      <div className="field">
        <label>Token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_..."
        />
      </div>
      <div className="row">
        <button className="primary" disabled={busy || !token} onClick={save}>
          {busy ? "prüfe…" : "speichern"}
        </button>
        {login && <span className="muted">eingeloggt als @{login}</span>}
        {err && <span className="badge err">{err}</span>}
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label>
          Default-Collaborators (komma-separiert, werden als <b>admin</b> zu jedem
          neuen Repo hinzugefügt)
        </label>
        <input
          value={collaborators}
          onChange={(e) => setCollaborators(e.target.value)}
          placeholder="mcules, otherfriend"
        />
      </div>
      <div className="row">
        <button onClick={saveCollab}>Collaborators speichern</button>
        {collabSaved && <span className="badge ok">gespeichert</span>}
      </div>
    </div>
  );
}

function TelegramStep({ done, refresh }: { done: boolean; refresh: () => void }) {
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/setup/telegram", {
        method: "POST",
        body: JSON.stringify({ token, chat_id: Number(chatId) }),
      });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>
        2. Telegram {done ? <span className="badge ok">erledigt</span> : <span className="badge warn">offen</span>}
      </h2>
      <ol className="muted">
        <li>Bot via <a href="https://t.me/BotFather" target="_blank">@BotFather</a> anlegen → Token kopieren</li>
        <li>Neue <b>Supergroup</b> anlegen (nicht normale Gruppe!) und in den Gruppen-Einstellungen <b>„Topics"</b> aktivieren</li>
        <li>Bot in die Gruppe einladen und als <b>Admin</b> mit Recht <b>„Manage Topics"</b> setzen</li>
        <li>Bot eine Nachricht in der Gruppe schreiben lassen (z.B. <code>/start</code>), dann in <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> die <code>chat.id</code> rauskopieren (beginnt meist mit <code>-100…</code>)</li>
      </ol>
      <div className="field">
        <label>Bot-Token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="123456789:AA..."
        />
      </div>
      <div className="field">
        <label>Chat-ID (Supergroup)</label>
        <input
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="-1001234567890"
        />
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy || !token || !chatId}
          onClick={save}
        >
          {busy ? "teste…" : "speichern + Test"}
        </button>
        {err && <span className="badge err">{err}</span>}
      </div>
    </div>
  );
}

function MatrixStep({ done, refresh }: { done: boolean; refresh: () => void }) {
  const [homeserver, setHomeserver] = useState("");
  const [userId, setUserId] = useState("");
  const [token, setToken] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [inviteUserId, setInviteUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/setup/matrix", {
        method: "POST",
        body: JSON.stringify({
          homeserver_url: homeserver,
          user_id: userId,
          access_token: token,
          space_id: spaceId,
          invite_user_id: inviteUserId || undefined,
        }),
      });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>
        3. Matrix (optional){" "}
        {done ? (
          <span className="badge ok">erledigt</span>
        ) : (
          <span className="badge">offen</span>
        )}
      </h2>
      <ol className="muted">
        <li>
          Bot-Account auf deinem Homeserver anlegen, Access-Token via{" "}
          <code>POST /_matrix/client/v3/login</code> holen.
        </li>
        <li>Einen Matrix-Space anlegen, Bot dort einladen + Rechte geben (Räume anlegen).</li>
        <li>
          Optional: Mensch-User-ID angeben, die in jeden neuen Projekt-Raum
          eingeladen werden soll (sonst nur der Bot selbst).
        </li>
      </ol>
      <div className="field">
        <label>Homeserver-URL</label>
        <input
          value={homeserver}
          onChange={(e) => setHomeserver(e.target.value)}
          placeholder="https://matrix.example.org"
        />
      </div>
      <div className="field">
        <label>Bot-User-ID</label>
        <input
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="@claudebot:example.org"
        />
      </div>
      <div className="field">
        <label>Access-Token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="syt_..."
        />
      </div>
      <div className="field">
        <label>Space-ID</label>
        <input
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
          placeholder="!abc123:example.org"
        />
      </div>
      <div className="field">
        <label>Dein Mensch-User (optional, wird in neue Räume eingeladen)</label>
        <input
          value={inviteUserId}
          onChange={(e) => setInviteUserId(e.target.value)}
          placeholder="@mcules:example.org"
        />
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy || !homeserver || !userId || !token || !spaceId}
          onClick={save}
        >
          {busy ? "teste…" : "speichern + Test"}
        </button>
        {err && <span className="badge err">{err}</span>}
      </div>
    </div>
  );
}

function ClaudeStep({ done, refresh }: { done: boolean; refresh: () => void }) {
  const [containerId, setContainerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const startLogin = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ container_id: string }>(
        "/api/setup/claude/start",
        { method: "POST" }
      );
      setContainerId(res.container_id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const markDone = async () => {
    await api("/api/setup/claude/complete", { method: "POST" });
    await refresh();
  };

  return (
    <div className="card">
      <h2>
        4. Claude-Login {done ? <span className="badge ok">erledigt</span> : <span className="badge warn">offen</span>}
      </h2>
      <p className="muted">
        Startet einen kurzlebigen Container, in dem <code>claude login</code> läuft.
        Folge dem Link, melde dich mit deinem Abo-Account an, dann diesen Schritt
        als erledigt markieren.
      </p>
      {!containerId && (
        <button className="primary" disabled={busy} onClick={startLogin}>
          {busy ? "…" : "Login-Container starten"}
        </button>
      )}
      {containerId && (
        <div>
          <p>
            Container läuft: <code>{containerId.slice(0, 12)}</code>
          </p>
          <p className="muted">
            Jetzt im Terminal auf dem Host:
          </p>
          <pre>docker exec -it -u worker {containerId.slice(0, 12)} claude login</pre>
          <p className="muted">
            (Browser-Login-URL wird dort angezeigt; nach dem Login Button unten
            klicken.)
          </p>
          <button className="primary" onClick={markDone}>
            ✅ Login war erfolgreich
          </button>
        </div>
      )}
      {err && <span className="badge err">{err}</span>}
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  in_progress: "Läuft",
  awaiting_reply: "Wartet",
  ready_for_testing: "Ready for Testing",
  done: "Done",
  cancelled: "Abgebrochen",
};

function StatusColorsStep() {
  const [colors, setColors] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ colors: Record<string, string>; defaults: Record<string, string> }>(
      "/api/setup/status-colors"
    )
      .then((r) => {
        setColors(r.colors);
        setDefaults(r.defaults);
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/setup/status-colors", {
        method: "PUT",
        body: JSON.stringify({ colors }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => setColors({ ...defaults });

  return (
    <div className="card">
      <h2>7. Status-Farben</h2>
      <p className="muted">
        Farben für die Status-Badges der Tickets. Gelten sofort nach Speichern.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {Object.keys(STATUS_LABELS).map((s) => (
          <div key={s} className="row" style={{ gap: 8 }}>
            <span
              className="badge"
              style={{
                background: colors[s] ?? "#888",
                color: "#fff",
                border: "none",
                minWidth: 140,
                justifyContent: "center",
              }}
            >
              {STATUS_LABELS[s]}
            </span>
            <input
              type="color"
              value={colors[s] ?? "#888888"}
              onChange={(e) =>
                setColors((c) => ({ ...c, [s]: e.target.value }))
              }
              style={{ width: 48, height: 28, padding: 0, border: "1px solid var(--border)" }}
            />
            <code style={{ fontSize: 11 }}>{colors[s]}</code>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="primary" disabled={busy} onClick={save}>
          {busy ? "…" : "speichern"}
        </button>
        <button className="ghost" onClick={reset}>zurücksetzen</button>
        {saved && <span className="badge ok">gespeichert</span>}
        {err && <span className="badge err">{err}</span>}
      </div>
    </div>
  );
}

function GlobalSystemPromptStep() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ prompt: string }>("/api/setup/system-prompt")
      .then((r) => setPrompt(r.prompt))
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/setup/system-prompt", {
        method: "PUT",
        body: JSON.stringify({ prompt }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>6. Globaler System-Prompt</h2>
      <p className="muted">
        Wird an den eingebauten <code>claude_code</code>-Preset angehängt und
        gilt für <em>alle</em> Worker-Container. Projekte können zusätzlich
        projektspezifische Ergänzungen hinzufügen. Greift erst bei neu
        gestarteten Workern.
      </p>
      <div className="field">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          placeholder="z.B. 'Schreibe alle Commits auf Deutsch. Prüfe vor Änderungen immer das aktuelle Test-Setup.'"
        />
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={save}>
          {busy ? "…" : "speichern"}
        </button>
        {saved && <span className="badge ok">gespeichert</span>}
        {err && <span className="badge err">{err}</span>}
      </div>
    </div>
  );
}

function GitIdentityStep() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [defaults, setDefaults] = useState<{ name: string; email: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<{ name: string; email: string; defaults: { name: string; email: string } }>(
      "/api/setup/git-identity"
    )
      .then((r) => {
        setName(r.name);
        setEmail(r.email);
        setDefaults(r.defaults);
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/setup/git-identity", {
        method: "PUT",
        body: JSON.stringify({ name, email }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>5. Git-Identität</h2>
      <p className="muted">
        Wird als <code>GIT_AUTHOR_*</code>/<code>GIT_COMMITTER_*</code> in jeden
        neuen Worker-Container injiziert und für orchestrator-eigene WIP-Commits
        verwendet. Greift erst bei <em>neu gestarteten</em> Workern.
      </p>
      <div className="field">
        <label>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaults?.name ?? "Claude-Worker"}
        />
      </div>
      <div className="field">
        <label>Email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={defaults?.email ?? "runhelm-worker@xxxxxxxx.xyz"}
        />
      </div>
      <div className="row">
        <button className="primary" disabled={busy || !name || !email} onClick={save}>
          {busy ? "…" : "speichern"}
        </button>
        {saved && <span className="badge ok">gespeichert</span>}
        {err && <span className="badge err">{err}</span>}
      </div>
    </div>
  );
}

type DeploySettings = {
  poll_interval_s: number;
  paused: boolean;
  last_sha: string | null;
  consecutive_failures: number;
};

function SelfDeployStep() {
  const [settings, setSettings] = useState<DeploySettings | null>(null);
  const [interval_, setIntervalS] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () =>
    api<DeploySettings>("/api/deploy/settings")
      .then((s) => {
        setSettings(s);
        setIntervalS(s.poll_interval_s);
      })
      .catch(() => {});

  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api("/api/deploy/settings", {
        method: "PUT",
        body: JSON.stringify({ poll_interval_s: Number(interval_) }),
      });
      setSaved(true);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/deploy/resume", { method: "POST" });
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Self-Deploy</h2>
      <p className="muted">
        Poller checkt GitHub-main des Orchestrator-Repos. Neuer Commit → Backup
        → Build → Recreate → Healthcheck. 3 Fehlversuche hintereinander pausieren
        Auto-Deploy und rollen auf das letzte Backup zurück.
      </p>
      {settings && (
        <div className="row" style={{ gap: 12, flexWrap: "wrap", fontSize: 12 }}>
          <span className={`badge ${settings.paused ? "err" : "ok"}`}>
            {settings.paused ? "pausiert" : "aktiv"}
          </span>
          <span className="muted">
            Fehlversuche: <b>{settings.consecutive_failures}</b>
          </span>
          <span className="muted" style={{ wordBreak: "break-all" }}>
            last_sha: <code>{settings.last_sha ?? "—"}</code>
          </span>
        </div>
      )}
      <div className="field" style={{ marginTop: 8 }}>
        <label>Poll-Intervall (Sekunden)</label>
        <input
          type="number"
          min={10}
          value={interval_}
          onChange={(e) => setIntervalS(Number(e.target.value))}
          style={{ width: 120 }}
        />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="primary" disabled={busy} onClick={save}>
          {busy ? "…" : "speichern"}
        </button>
        {settings?.paused && (
          <button disabled={busy} onClick={resume}>
            Auto-Deploy fortsetzen
          </button>
        )}
        {saved && <span className="badge ok">gespeichert</span>}
        {err && <span className="badge err">{err}</span>}
      </div>
    </div>
  );
}

function PrimaryChannelStep({
  telegramReady,
  matrixReady,
}: {
  telegramReady: boolean;
  matrixReady: boolean;
}) {
  const [channel, setChannel] = useState<"telegram" | "matrix" | "">("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ channel: "telegram" | "matrix" | null }>(
      "/api/setup/primary-channel"
    )
      .then((r) => setChannel(r.channel ?? ""))
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api("/api/setup/primary-channel", {
        method: "PUT",
        body: JSON.stringify({ channel: channel || null }),
      });
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Hauptkanal</h2>
      <p className="muted">
        Admin-Alarme (z.B. nach 3 fehlgeschlagenen Self-Deploys) gehen auf
        diesen Kanal.
      </p>
      <div className="field">
        <label>Kanal</label>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as "telegram" | "matrix" | "")}
        >
          <option value="">— keiner —</option>
          <option value="telegram" disabled={!telegramReady}>
            Telegram{!telegramReady ? " (nicht konfiguriert)" : ""}
          </option>
          <option value="matrix" disabled={!matrixReady}>
            Matrix{!matrixReady ? " (nicht konfiguriert)" : ""}
          </option>
        </select>
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={save}>
          {busy ? "…" : "speichern"}
        </button>
        {saved && <span className="badge ok">gespeichert</span>}
        {err && <span className="badge err">{err}</span>}
      </div>
    </div>
  );
}

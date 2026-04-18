import { useEffect, useState } from "react";
import { api, type ChannelId, type Project, type SetupStatus } from "../api";
import { useWS } from "../useWS";
import { Icon } from "../Icon";

export function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = () =>
    api<Project[]>("/api/projects").then(setProjects).catch(console.error);

  useEffect(() => {
    refresh();
  }, []);

  useWS("/ws/ui", (msg) => {
    if (msg.type === "worker_status") refresh();
  });

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <h1>Projekte</h1>
          <div className="page-subtitle">
            Claude-Worker, einer pro Repository. Über Telegram, Matrix oder direkt hier steuerbar.
          </div>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={15} />
          Neues Projekt
        </button>
      </div>

      {creating && (
        <NewProjectCard
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}

      {projects.length === 0 && !creating && (
        <div className="empty">
          <div className="empty-icon">
            <Icon name="sparkles" size={24} />
          </div>
          <h2>Noch keine Projekte</h2>
          <p>Lege ein neues Repo an oder forke ein bestehendes, um loszulegen.</p>
          <button className="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={15} />
            Projekt erstellen
          </button>
        </div>
      )}

      <div className="grid">
        {projects.map((p) => (
          <ProjectTile key={p.id} p={p} onChange={refresh} />
        ))}
      </div>
    </div>
  );
}

function statusLabel(s: string | undefined): { label: string; badge: string; pulse?: boolean } {
  switch (s) {
    case "idle":              return { label: "idle",    badge: "ok" };
    case "running":           return { label: "running", badge: "ok", pulse: true };
    case "waiting_permission":return { label: "wartet",  badge: "warn", pulse: true };
    case "starting":          return { label: "startet", badge: "info", pulse: true };
    case "error":             return { label: "fehler",  badge: "err" };
    default:                  return { label: "stopped", badge: "" };
  }
}

function ProjectTile({ p, onChange }: { p: Project; onChange: () => void }) {
  const worker = p.workers[0];
  const st = statusLabel(worker?.status);

  const start = async () => {
    await api(`/api/projects/${p.id}/worker/start`, { method: "POST" });
    onChange();
  };
  const stop = async () => {
    if (!worker) return;
    await api(`/api/workers/${worker.id}/stop`, { method: "POST" });
    onChange();
  };

  return (
    <div className="card project-card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <a href={`#/projects/${p.id}`} className="project-link">
          {p.name}
          {p.is_self ? (
            <span
              className="badge"
              style={{ marginLeft: 6, fontSize: 9, background: "var(--accent)", color: "#fff" }}
              title="Self-managed orchestrator project"
            >
              SELF
            </span>
          ) : null}
        </a>
        <span className={`badge ${st.badge} ${st.pulse ? "badge-pulse" : ""}`}>{st.label}</span>
      </div>

      <div className="project-meta">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Icon name="lock" size={12} />
          {p.policy}
        </span>
        {p.upstream_repo && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }} title={`Fork von ${p.upstream_repo}`}>
            <Icon name="git-branch" size={12} />
            fork
          </span>
        )}
      </div>

      <div className="project-foot">
        {worker && worker.status !== "stopped" ? (
          <button onClick={stop}>
            <Icon name="square" size={13} />
            Stop
          </button>
        ) : (
          <button className="primary" onClick={start}>
            <Icon name="play" size={13} />
            Start
          </button>
        )}
        {p.repo_url && (
          <a href={p.repo_url} target="_blank" className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            Repo <Icon name="external" size={12} />
          </a>
        )}
      </div>
    </div>
  );
}

function NewProjectCard({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [policy, setPolicy] = useState("safe");
  const [channels, setChannels] = useState<ChannelId[]>([]);
  const [repoMode, setRepoMode] = useState<"new" | "fork">("new");
  const [upstream, setUpstream] = useState("");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<SetupStatus>("/api/setup/status")
      .then((s) => {
        setSetup(s);
        const pre: ChannelId[] = [];
        if (s.telegram) pre.push("telegram");
        if (s.matrix) pre.push("matrix");
        setChannels(pre);
      })
      .catch(() => {});
  }, []);

  const toggle = (id: ChannelId) =>
    setChannels((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          policy,
          channels,
          upstream: repoMode === "fork" ? upstream : undefined,
        }),
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Neues Projekt</h2>
        <button className="ghost icon-only" onClick={onCancel} title="Abbrechen">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My cool project" />
      </div>
      <div className="field">
        <label>Beschreibung (optional)</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="field">
        <label>Repository</label>
        <div className="row">
          <label className="row" style={{ gap: 6 }}>
            <input
              type="radio"
              name="repo-mode"
              checked={repoMode === "new"}
              onChange={() => setRepoMode("new")}
            />
            Neu anlegen
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="radio"
              name="repo-mode"
              checked={repoMode === "fork"}
              onChange={() => setRepoMode("fork")}
            />
            Bestehendes forken
          </label>
        </div>
      </div>
      {repoMode === "fork" && (
        <div className="field">
          <label>Upstream-Repo</label>
          <input
            value={upstream}
            onChange={(e) => setUpstream(e.target.value)}
            placeholder="owner/repo oder https://github.com/owner/repo"
          />
          <div className="hint">
            Wird in den PAT-Account geforkt. Worker arbeitet auf einem Feature-Branch, PR später per Button oder <code>/pr</code>.
          </div>
        </div>
      )}

      <div className="field">
        <label>Default-Policy</label>
        <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="read-only">read-only — nur Read/Glob/Grep auto</option>
          <option value="safe">safe — + ungefährliches Bash</option>
          <option value="dev">dev — + Edit/Write</option>
          <option value="full-auto">full-auto — alles auto</option>
        </select>
      </div>

      <div className="field">
        <label>Chat-Kanäle</label>
        <div className="row">
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={channels.includes("telegram")}
              disabled={!setup?.telegram}
              onChange={() => toggle("telegram")}
            />
            Telegram {!setup?.telegram && <span className="subtle">(nicht konfiguriert)</span>}
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={channels.includes("matrix")}
              disabled={!setup?.matrix}
              onChange={() => toggle("matrix")}
            />
            Matrix {!setup?.matrix && <span className="subtle">(nicht konfiguriert)</span>}
          </label>
        </div>
      </div>

      <div className="row">
        <button
          className="primary"
          disabled={
            !name ||
            busy ||
            channels.length === 0 ||
            (repoMode === "fork" && !upstream.trim())
          }
          onClick={create}
        >
          {busy ? "erstelle…" : (<><Icon name="check" size={14} />Erstellen</>)}
        </button>
        <button className="ghost" onClick={onCancel}>Abbrechen</button>
        {err && <span className="badge err">{err}</span>}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { api, type Project, type Sprint, type SprintStatus } from "../api";
import { Icon } from "../Icon";

export function SprintsSection({
  projectId,
  version,
}: {
  projectId: string;
  version: number;
}) {
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () =>
    api<Sprint[]>(`/api/projects/${projectId}/sprints`)
      .then(setSprints)
      .catch(console.error);

  useEffect(() => {
    refresh();
    api<Project>(`/api/projects/${projectId}`)
      .then(setProject)
      .catch(() => {});
  }, [projectId, version]);

  const key = project?.key ?? "";

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/sprints`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setName("");
      setCreating(false);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async (s: Sprint) => {
    if (!confirm(`Sprint "${s.name}" jetzt starten?`)) return;
    try {
      await api(`/api/projects/${projectId}/sprints/${s.id}/start`, {
        method: "POST",
      });
      refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const release = async (s: Sprint) => {
    if (
      !confirm(
        `Sprint "${s.name}" freigeben? Merget \`${s.branch}\` → main und startet ggf. Self-Deploy.`
      )
    )
      return;
    try {
      const res = await api<{ mergedInto: string }>(
        `/api/projects/${projectId}/sprints/${s.id}/release`,
        { method: "POST" }
      );
      alert(`Sprint gemerged → \`${res.mergedInto}\`.`);
      refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const remove = async (s: Sprint) => {
    if (!confirm(`Sprint "${s.name}" löschen? Tickets bleiben, sind aber sprint-los.`))
      return;
    try {
      await api(`/api/projects/${projectId}/sprints/${s.id}`, {
        method: "DELETE",
      });
      refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const active = sprints.filter(
    (s) => s.status === "active" || s.status === "pending_release"
  );
  const planning = sprints.filter((s) => s.status === "planning");
  const closed = sprints.filter(
    (s) =>
      s.status === "released" ||
      s.status === "merged" ||
      s.status === "cancelled"
  );

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 10, justifyContent: "flex-end" }}>
        <button onClick={() => setCreating((v) => !v)}>
          <Icon name="plus" size={13} /> Neu
        </button>
      </div>

      {creating && (
        <div className="row" style={{ marginBottom: 12, gap: 8 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sprint-Name (z.B. 'Login-Refactor')"
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
            style={{ flex: 1 }}
          />
          <button className="primary" disabled={busy || !name.trim()} onClick={create}>
            {busy ? "…" : "Anlegen"}
          </button>
          {err && <span className="badge err">{err}</span>}
        </div>
      )}

      {sprints.length === 0 && (
        <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>
          Keine Sprints. Tickets werden erst gestartet, wenn sie einem aktiven Sprint zugeordnet sind.
        </div>
      )}

      {active.length > 0 && (
        <div className="ticket-list">
          {active.map((s) => (
            <SprintRow
              key={s.id}
              s={s}
              projectKey={key}
              onStart={() => start(s)}
              onRelease={() => release(s)}
              onDelete={() => remove(s)}
            />
          ))}
        </div>
      )}

      {planning.length > 0 && (
        <>
          <h3 style={{ marginTop: 16, marginBottom: 8 }}>
            Planung <span className="subtle">({planning.length})</span>
          </h3>
          <div className="ticket-list">
            {planning.map((s) => (
              <SprintRow
                key={s.id}
                s={s}
                onStart={() => start(s)}
                onRelease={() => release(s)}
                onDelete={() => remove(s)}
              />
            ))}
          </div>
        </>
      )}

      {closed.length > 0 && (
        <>
          <h3 style={{ marginTop: 16, marginBottom: 8 }}>
            Abgeschlossen <span className="subtle">({closed.length})</span>
          </h3>
          <div className="ticket-list">
            {closed.map((s) => (
              <SprintRow
                key={s.id}
                s={s}
                onStart={() => start(s)}
                onRelease={() => release(s)}
                onDelete={() => remove(s)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function statusBadge(s: SprintStatus): { label: string; cls: string; pulse?: boolean } {
  switch (s) {
    case "planning":        return { label: "Planung",       cls: "" };
    case "active":          return { label: "aktiv",         cls: "ok", pulse: true };
    case "pending_release": return { label: "freigabe?",     cls: "warn", pulse: true };
    case "released":        return { label: "released (PR)", cls: "info" };
    case "merged":          return { label: "merged",        cls: "info" };
    case "cancelled":       return { label: "abgebrochen",   cls: "err" };
  }
}

function SprintRow({
  s,
  projectKey,
  onStart,
  onRelease,
  onDelete,
}: {
  s: Sprint;
  projectKey: string;
  onStart: () => void;
  onRelease: () => void;
  onDelete: () => void;
}) {
  const st = statusBadge(s.status);
  const stats = s.stats ?? { total: 0, done: 0, open: 0 };
  return (
    <div className="ticket-row" style={{ cursor: "default" }}>
      <div className="ticket-main">
        <div className="ticket-title">
          <code className="ticket-id">{projectKey}-S{s.number}</code>
          <span>{s.name}</span>
        </div>
        <div className="ticket-branch">
          <Icon name="git-branch" size={11} />
          <code>{s.branch}</code>
          <span className="subtle" style={{ marginLeft: 8 }}>
            {stats.done}/{stats.total} done
          </span>
          {s.pr_url && (
            <a
              href={s.pr_url}
              target="_blank"
              rel="noreferrer"
              style={{ marginLeft: 8 }}
            >
              PR #{s.pr_number}
            </a>
          )}
        </div>
      </div>
      <div className="ticket-actions" style={{ display: "flex", gap: 6 }}>
        <span className={`badge ${st.cls} ${st.pulse ? "badge-pulse" : ""}`}>
          {st.label}
        </span>
        {s.status === "planning" && (
          <>
            <button className="primary" onClick={onStart}>
              <Icon name="play" size={12} /> Starten
            </button>
            <button className="danger" onClick={onDelete}>
              <Icon name="trash" size={12} />
            </button>
          </>
        )}
        {s.status === "pending_release" && (
          <button className="primary" onClick={onRelease}>
            <Icon name="check" size={12} /> Freigeben → PR
          </button>
        )}
        {s.status === "active" && stats.open === 0 && stats.total > 0 && (
          <button className="primary" onClick={onRelease}>
            <Icon name="check" size={12} /> Freigeben → PR
          </button>
        )}
      </div>
    </div>
  );
}

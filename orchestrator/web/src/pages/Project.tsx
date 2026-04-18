import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type ChannelId, type Project, type SetupStatus } from "../api";
import { useWS } from "../useWS";
import { Icon } from "../Icon";
import { TicketsSection, TicketDetailView } from "./TicketsSection";
import { SprintsSection } from "./SprintsSection";
import { renderMessageContent } from "../previews";

type Origin = "ui" | "telegram" | "matrix";

function parseChannels(raw: string | null | undefined): ChannelId[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x: unknown): x is ChannelId => x === "telegram" || x === "matrix"
    );
  } catch {
    return [];
  }
}

type PermStatus = "pending" | "allowed" | "denied";

type ChatEntry =
  | { kind: "user"; ts: number; text: string; origin?: Origin }
  | { kind: "assistant"; ts: number; text: string }
  | { kind: "tool"; ts: number; text: string }
  | { kind: "system"; ts: number; text: string }
  | {
      kind: "perm";
      ts: number;
      requestId: string;
      tool: string;
      input: unknown;
      status: PermStatus;
    };

type ChatHistoryItem = {
  id: number;
  type:
    | "user_prompt"
    | "worker_message"
    | "permission_request"
    | "permission_resolved";
  ts: number;
  payload: any;
};

function historyToEntries(items: ChatHistoryItem[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const permIndex = new Map<string, number>();
  for (const it of items) {
    if (it.type === "user_prompt") {
      entries.push({
        kind: "user",
        ts: it.ts,
        text: it.payload.text ?? "",
        origin: it.payload.origin,
      });
    } else if (it.type === "worker_message") {
      const role = it.payload.role;
      const text = it.payload.text ?? "";
      if (role === "assistant") entries.push({ kind: "assistant", ts: it.ts, text });
      else if (role === "tool") entries.push({ kind: "tool", ts: it.ts, text });
      else entries.push({ kind: "system", ts: it.ts, text });
    } else if (it.type === "permission_request") {
      permIndex.set(it.payload.requestId, entries.length);
      entries.push({
        kind: "perm",
        ts: it.ts,
        requestId: it.payload.requestId,
        tool: it.payload.tool,
        input: it.payload.input,
        status: "pending",
      });
    } else if (it.type === "permission_resolved") {
      const idx = permIndex.get(it.payload.requestId);
      if (idx !== undefined) {
        const prev = entries[idx];
        if (prev && prev.kind === "perm") {
          entries[idx] = { ...prev, status: it.payload.allow ? "allowed" : "denied" };
        }
      }
    }
  }
  return entries;
}

function statusLabel(s: string | undefined): { label: string; badge: string; pulse?: boolean } {
  switch (s) {
    case "idle":               return { label: "idle",    badge: "ok" };
    case "running":            return { label: "running", badge: "ok", pulse: true };
    case "waiting_permission": return { label: "wartet",  badge: "warn", pulse: true };
    case "starting":           return { label: "startet", badge: "info", pulse: true };
    case "error":              return { label: "fehler",  badge: "err" };
    default:                   return { label: "stopped", badge: "" };
  }
}

export function ProjectPage({
  id,
  tab: initialTab = "tickets",
  openTicketNumber,
}: {
  id: string;
  tab?: "tickets" | "sprints" | "chat";
  openTicketNumber?: number;
}) {
  const [p, setP] = useState<Project | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [ticketsVersion, setTicketsVersion] = useState(0);
  const tab = initialTab;
  const setTab = (t: "tickets" | "sprints" | "chat") => {
    location.hash = `/projects/${id}/${t}`;
  };
  const [topbarSlot, setTopbarSlot] = useState<HTMLElement | null>(null);
  const [metaSlot, setMetaSlot] = useState<HTMLElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setTopbarSlot(document.getElementById("topbar-actions"));
    setMetaSlot(document.getElementById("topbar-meta"));
  }, []);
  const historyReadyRef = useRef(false);
  const liveQueueRef = useRef<Array<(prev: ChatEntry[]) => ChatEntry[]>>([]);

  const refresh = () =>
    api<Project>(`/api/projects/${id}`).then(setP).catch(console.error);

  useEffect(() => {
    refresh();
    historyReadyRef.current = false;
    liveQueueRef.current = [];
    setEntries([]);
    api<ChatHistoryItem[]>(`/api/projects/${id}/chat?limit=500`)
      .then((items) => {
        const initial = historyToEntries(items);
        setEntries(() => {
          let next = initial;
          for (const update of liveQueueRef.current) next = update(next);
          liveQueueRef.current = [];
          historyReadyRef.current = true;
          return next;
        });
      })
      .catch((err) => {
        console.error("chat history load failed", err);
        historyReadyRef.current = true;
      });
  }, [id]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, tab]);

  const applyOrQueue = (update: (prev: ChatEntry[]) => ChatEntry[]) => {
    if (!historyReadyRef.current) {
      liveQueueRef.current.push(update);
      return;
    }
    setEntries(update);
  };

  const append = (e: ChatEntry) =>
    applyOrQueue((prev) => [...prev.slice(-500), e]);

  useWS("/ws/ui", (msg) => {
    if (msg.projectId && msg.projectId !== id) {
      if (msg.type !== "permission_resolved") return;
    }
    const ts = Date.now();
    switch (msg.type) {
      case "worker_status":
        refresh();
        break;
      case "user_prompt":
        append({ kind: "user", ts, text: msg.text, origin: msg.origin });
        break;
      case "worker_message":
        if (msg.role === "assistant")
          append({ kind: "assistant", ts, text: msg.text });
        else if (msg.role === "tool")
          append({ kind: "tool", ts, text: msg.text });
        else append({ kind: "system", ts, text: msg.text });
        break;
      case "permission_request":
        append({
          kind: "perm",
          ts,
          requestId: msg.requestId,
          tool: msg.tool,
          input: msg.input,
          status: "pending",
        });
        break;
      case "permission_resolved":
        applyOrQueue((prev) =>
          prev.map((e) =>
            e.kind === "perm" && e.requestId === msg.requestId
              ? { ...e, status: msg.allow ? "allowed" : "denied" }
              : e
          )
        );
        break;
      case "worker_log":
        break;
      case "ticket_changed":
      case "ticket_comment_added":
      case "sprint_changed":
        setTicketsVersion((v) => v + 1);
        break;
    }
  });

  if (!p) return <div className="container muted">lade…</div>;
  const worker = p.workers[0];
  const st = statusLabel(worker?.status);

  const start = async () => {
    await api(`/api/projects/${p.id}/worker/start`, { method: "POST" });
    refresh();
  };
  const stop = async () => {
    if (!worker) return;
    await api(`/api/workers/${worker.id}/stop`, { method: "POST" });
    refresh();
  };
  const restart = async () => {
    if (!worker) return;
    await api(`/api/workers/${worker.id}/restart`, { method: "POST" });
    refresh();
  };
  const remove = async () => {
    if (!confirm(`Projekt "${p.name}" löschen? (Repo bleibt auf GitHub)`)) return;
    await api(`/api/projects/${p.id}`, { method: "DELETE" });
    location.hash = "/";
  };

  const send = async () => {
    if (!worker || !input.trim()) return;
    const text = input.trim();
    setSending(true);
    try {
      await api(`/api/workers/${worker.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      setInput("");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const resolvePerm = async (requestId: string, allow: boolean) => {
    await api(`/api/permissions/${requestId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ allow }),
    });
  };

  const actions = (
    <>
      <span className={`badge ${st.badge} ${st.pulse ? "badge-pulse" : ""}`}>{st.label}</span>
      {p.upstream_repo && (
        <button onClick={() => setPrOpen(true)} title="Pull Request erstellen">
          <Icon name="git-pull" size={14} /> PR
        </button>
      )}
      {worker?.status && worker.status !== "stopped" ? (
        <>
          <button onClick={stop} title="Stop">
            <Icon name="square" size={14} /> Stop
          </button>
          <button onClick={restart} title="Restart">
            <Icon name="refresh" size={14} /> Restart
          </button>
        </>
      ) : (
        <button className="primary" onClick={start}>
          <Icon name="play" size={14} /> Start
        </button>
      )}
      <button className="ghost icon-only" title="Projekt bearbeiten" onClick={() => setEditing(true)}>
        <Icon name="pencil" size={15} />
      </button>
      {!p.is_self && (
        <button className="danger icon-only" title="Projekt löschen" onClick={remove}>
          <Icon name="trash" size={15} />
        </button>
      )}
    </>
  );

  const meta = (
    <>
      {p.repo_url && (
        <span className="meta-item">
          <Icon name="github" size={12} />
          <a href={p.repo_url} target="_blank">
            {p.repo_url.replace("https://github.com/", "")}
          </a>
        </span>
      )}
      {p.upstream_repo && (
        <span className="meta-item" title={`Upstream: ${p.upstream_repo}`}>
          <Icon name="git-pull" size={12} />
          <a href={`https://github.com/${p.upstream_repo}`} target="_blank">
            {p.upstream_repo}
          </a>
        </span>
      )}
      {p.current_branch && (
        <span className="meta-item">
          <Icon name="git-branch" size={12} />
          <code>{p.current_branch}</code>
        </span>
      )}
      <span className="meta-item">
        <Icon name="lock" size={12} />
        {p.policy}
      </span>
      {p.tg_topic_id != null && (
        <span className="meta-item" title="Telegram-Topic">
          <Icon name="message" size={12} />
          tg
        </span>
      )}
      {p.matrix_room_id && (
        <span className="meta-item" title={p.matrix_room_id}>
          <Icon name="message" size={12} />
          matrix
        </span>
      )}
    </>
  );

  return (
    <div className="container">
      {topbarSlot && createPortal(actions, topbarSlot)}
      {metaSlot && createPortal(meta, metaSlot)}

      {p.description && (
        <div className="page-subtitle" style={{ marginBottom: 14 }}>{p.description}</div>
      )}

      {openTicketNumber === undefined && (
        <div className="tabs">
          <button
            className={`tab ${tab === "chat" ? "active" : ""}`}
            onClick={() => setTab("chat")}
          >
            <Icon name="message" size={14} /> Chat
            {entries.length > 0 && (
              <span className="tab-count">{entries.length}</span>
            )}
          </button>
          <button
            className={`tab ${tab === "tickets" ? "active" : ""}`}
            onClick={() => setTab("tickets")}
          >
            <Icon name="folder" size={14} /> Tickets
          </button>
          <button
            className={`tab ${tab === "sprints" ? "active" : ""}`}
            onClick={() => setTab("sprints")}
          >
            <Icon name="git-branch" size={14} /> Sprints
          </button>
        </div>
      )}

      {openTicketNumber !== undefined && (
        <TicketDetailView
          projectId={p.id}
          ticketNumber={openTicketNumber}
          version={ticketsVersion}
          onChanged={() => setTicketsVersion((v) => v + 1)}
        />
      )}

      {openTicketNumber === undefined && tab === "tickets" && (
        <TicketsSection projectId={p.id} version={ticketsVersion} />
      )}

      {openTicketNumber === undefined && tab === "sprints" && (
        <SprintsSection projectId={p.id} version={ticketsVersion} />
      )}

      {openTicketNumber === undefined && tab === "chat" && (
        <div className="card">
          <div className="chat" ref={logRef}>
            {entries.length === 0 && (
              <div className="chat-empty">
                <div className="icon-blob">
                  <Icon name="message" size={20} />
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  Noch keine Nachrichten.
                </div>
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  Schreib unten einen Prompt — oder direkt in Telegram/Matrix.
                </div>
              </div>
            )}
            {entries.map((e, i) => (
              <ChatItem
                key={i}
                entry={e}
                projectId={p.id}
                onResolve={resolvePerm}
              />
            ))}
          </div>
          <div className="chat-input">
            <textarea
              value={input}
              onChange={(ev) => setInput(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
                  ev.preventDefault();
                  send();
                }
              }}
              placeholder={
                worker
                  ? "Nachricht an den Worker — Ctrl/⌘+Enter zum Senden"
                  : "Worker ist gestoppt — oben starten"
              }
              disabled={!worker || sending}
              rows={3}
            />
            <button
              className="primary"
              disabled={!worker || !input.trim() || sending}
              onClick={send}
            >
              {sending ? "…" : <><Icon name="send" size={15} /> Senden</>}
            </button>
          </div>
        </div>
      )}

      {prOpen && p.upstream_repo && (
        <PrDialog
          project={p}
          onClose={() => setPrOpen(false)}
          onCreated={refresh}
        />
      )}

      {editing && (
        <EditProjectCard
          project={p}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function PrDialog({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<{ url: string; number: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ url: string; number: number; newBranch: string }>(
        `/api/projects/${project.id}/pr`,
        { method: "POST", body: JSON.stringify({ title, body }) }
      );
      setLast({ url: res.url, number: res.number });
      setTitle("");
      setBody("");
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Icon name="git-pull" size={16} /> Pull Request
            </span>
          </h2>
          <button className="ghost icon-only" onClick={onClose} title="Schließen">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="subtle" style={{ fontSize: 12, marginBottom: 14 }}>
          <code>{project.current_branch}</code> → <code>{project.upstream_repo}:{project.upstream_default_branch}</code>
        </div>
        <div className="field">
          <label>Titel</label>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="z.B. Fix: Login-Redirect"
          />
        </div>
        <div className="field">
          <label>Beschreibung (optional)</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
          />
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {err && <span className="badge err" style={{ marginRight: "auto" }}>{err}</span>}
          {last && (
            <a href={last.url} target="_blank" className="badge ok" style={{ marginRight: "auto" }}>
              PR #{last.number}
            </a>
          )}
          <button className="ghost" onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={busy || !title.trim()} onClick={create}>
            {busy ? "erstelle…" : <><Icon name="check" size={14} /> PR erstellen</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditProjectCard({
  project,
  onSaved,
  onCancel,
}: {
  project: Project;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const currentChannels = parseChannels(project.channels);
  const [name, setName] = useState(project.name);
  const [key, setKey] = useState(project.key ?? "");
  const [description, setDescription] = useState(project.description ?? "");
  const [policy, setPolicy] = useState(project.policy);
  const [systemPrompt, setSystemPrompt] = useState(project.system_prompt ?? "");
  const [selected, setSelected] = useState<ChannelId[]>(currentChannels);
  const [deleteRefs, setDeleteRefs] = useState<Record<ChannelId, boolean>>({
    telegram: true,
    matrix: true,
  });
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<SetupStatus>("/api/setup/status").then(setSetup).catch(() => {});
  }, []);

  const toggle = (id: ChannelId) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const removedChannels = currentChannels.filter((c) => !selected.includes(c));
  const addedChannels = selected.filter((c) => !currentChannels.includes(c));
  const channelsChanged = removedChannels.length > 0 || addedChannels.length > 0;
  const metaChanged =
    name.trim() !== project.name ||
    key.trim().toUpperCase() !== (project.key ?? "") ||
    (description || null) !== (project.description ?? null) ||
    policy !== project.policy ||
    (systemPrompt || null) !== (project.system_prompt ?? null);
  const unchanged = !channelsChanged && !metaChanged;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: any = {};
      if (name.trim() !== project.name) body.name = name.trim();
      if (key.trim().toUpperCase() !== (project.key ?? ""))
        body.key = key.trim().toUpperCase();
      if ((description || null) !== (project.description ?? null))
        body.description = description || null;
      if (policy !== project.policy) body.policy = policy;
      if ((systemPrompt || null) !== (project.system_prompt ?? null))
        body.system_prompt = systemPrompt.trim() || null;
      if (channelsChanged) {
        body.channels = selected;
        if (removedChannels.length > 0) {
          body.deleteRefs = {};
          for (const c of removedChannels) body.deleteRefs[c] = deleteRefs[c];
        }
      }
      await api(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
      <div className="card-head">
        <h2>Projekt bearbeiten</h2>
        <button className="ghost icon-only" onClick={onCancel} title="Schließen">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <div className="hint">
          Betrifft Anzeige + Topic-/Raum-Titel. GitHub-Repo und Slug bleiben unverändert.
        </div>
      </div>

      <div className="field">
        <label>Key (3 Zeichen, A–Z / 0–9)</label>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase().slice(0, 3))}
          maxLength={3}
          style={{ fontFamily: "var(--mono)", letterSpacing: "0.1em", width: 80 }}
        />
        <div className="hint">
          Prefix für Ticket- und Sprint-IDs: z.B. <code>{key || "UNI"}-T1</code>,
          <code> {key || "UNI"}-S1</code>.
        </div>
      </div>

      <div className="field">
        <label>Beschreibung</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Policy</label>
        <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="read-only">read-only</option>
          <option value="safe">safe</option>
          <option value="dev">dev</option>
          <option value="full-auto">full-auto</option>
        </select>
      </div>

      <div className="field">
        <label>System-Prompt (Projekt-Ergänzung)</label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={5}
          placeholder="Wird zusätzlich zum globalen System-Prompt angehängt. Greift erst bei neu gestartetem Worker."
        />
      </div>

      <div className="field">
        <label>Chat-Kanäle</label>
        <div className="row">
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={selected.includes("telegram")}
              disabled={!setup?.telegram && !currentChannels.includes("telegram")}
              onChange={() => toggle("telegram")}
            />
            Telegram {!setup?.telegram && <span className="subtle">(nicht konfiguriert)</span>}
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={selected.includes("matrix")}
              disabled={!setup?.matrix && !currentChannels.includes("matrix")}
              onChange={() => toggle("matrix")}
            />
            Matrix {!setup?.matrix && <span className="subtle">(nicht konfiguriert)</span>}
          </label>
        </div>
      </div>

      {removedChannels.length > 0 && (
        <div className="field">
          <label>Entfernte Kanäle</label>
          {removedChannels.map((c) => (
            <div key={c}>
              <label className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={deleteRefs[c]}
                  onChange={(e) =>
                    setDeleteRefs((prev) => ({ ...prev, [c]: e.target.checked }))
                  }
                />
                {c === "telegram" ? "Telegram-Topic" : "Matrix-Raum"} dabei löschen
              </label>
            </div>
          ))}
        </div>
      )}

      {addedChannels.length > 0 && (
        <div className="hint" style={{ marginBottom: 12 }}>
          Neu: {addedChannels.join(", ")} — Raum/Topic wird angelegt und Welcome-Message gepostet.
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-end" }}>
        {err && <span className="badge err" style={{ marginRight: "auto" }}>{err}</span>}
        <button className="ghost" onClick={onCancel}>Abbrechen</button>
        <button
          className="primary"
          disabled={busy || unchanged || selected.length === 0 || !name.trim()}
          onClick={save}
        >
          {busy ? "speichere…" : <><Icon name="check" size={14} /> Speichern</>}
        </button>
      </div>
      </div>
    </div>
  );
}

function ChatItem({
  entry,
  projectId,
  onResolve,
}: {
  entry: ChatEntry;
  projectId: string;
  onResolve: (requestId: string, allow: boolean) => void;
}) {
  const time = new Date(entry.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (entry.kind === "system") {
    return (
      <div className="msg-row system">
        <div className="msg">
          <div className="msg-body">
            {renderMessageContent(entry.text, projectId)}
          </div>
        </div>
      </div>
    );
  }

  if (entry.kind === "perm") {
    return (
      <div className="msg-row assistant">
        <div className="avatar ai"><Icon name="lock" size={14} /></div>
        <div className="msg perm" style={{ maxWidth: "100%", flex: 1 }}>
          <div className="msg-time">
            {time} · Permission Request · <code>{entry.tool}</code>
          </div>
          <pre>
            {JSON.stringify(entry.input, null, 2).slice(0, 1500)}
          </pre>
          {entry.status === "pending" ? (
            <div className="row" style={{ marginTop: 4 }}>
              <button
                className="primary"
                onClick={() => onResolve(entry.requestId, true)}
              >
                <Icon name="check" size={14} /> Allow
              </button>
              <button
                className="danger"
                onClick={() => onResolve(entry.requestId, false)}
              >
                <Icon name="x" size={14} /> Deny
              </button>
            </div>
          ) : (
            <span className={`badge ${entry.status === "allowed" ? "ok" : "err"}`}>
              {entry.status === "allowed" ? "erlaubt" : "abgelehnt"}
            </span>
          )}
        </div>
      </div>
    );
  }

  const avatar =
    entry.kind === "user" ? (
      <div className="avatar user"><Icon name="user" size={14} /></div>
    ) : entry.kind === "tool" ? (
      <div className="avatar tool"><Icon name="wrench" size={13} /></div>
    ) : (
      <div className="avatar ai"><Icon name="sparkles" size={13} /></div>
    );

  const label =
    entry.kind === "user" ? "du" : entry.kind === "tool" ? "tool" : "claude";

  const origin = entry.kind === "user" ? entry.origin : undefined;

  return (
    <div className={`msg-row ${entry.kind}`}>
      {avatar}
      <div className="msg">
        <div className="msg-time">
          {time} · {label}
          {origin && <OriginTag origin={origin} />}
        </div>
        <div className="msg-body">
          {renderMessageContent(entry.text, projectId)}
        </div>
      </div>
    </div>
  );
}

function OriginTag({ origin }: { origin: Origin }) {
  if (origin === "ui") return null;
  return (
    <span className={`origin-tag ${origin}`}>
      <Icon name="message" size={10} />
      {origin}
    </span>
  );
}

import { useEffect, useState } from "react";
import { api, type Project, type SetupStatus } from "./api";
import { Icon } from "./Icon";
import { Setup } from "./pages/Setup";
import { Dashboard } from "./pages/Dashboard";
import { ProjectPage } from "./pages/Project";

type Tab = "chat" | "tickets" | "sprints";

type Route =
  | { name: "setup" }
  | { name: "dashboard" }
  | { name: "project"; id: string; tab: Tab }
  | { name: "ticket"; projectId: string; ticketNumber: number };

function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "") || "/";
  if (h === "/" || h === "") return { name: "dashboard" };
  if (h === "/setup") return { name: "setup" };
  const ticketMatch = h.match(/^\/projects\/([^/]+)\/tickets\/(\d+)$/);
  if (ticketMatch)
    return {
      name: "ticket",
      projectId: ticketMatch[1],
      ticketNumber: Number(ticketMatch[2]),
    };
  const tabMatch = h.match(/^\/projects\/([^/]+)\/(chat|tickets|sprints)$/);
  if (tabMatch) return { name: "project", id: tabMatch[1], tab: tabMatch[2] as Tab };
  const simple = h.match(/^\/projects\/([^/]+)$/);
  if (simple) return { name: "project", id: simple[1], tab: "tickets" };
  return { name: "dashboard" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute(location.hash));
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    api<SetupStatus>("/api/setup/status").then(setSetup).catch(console.error);
  }, [route]);

  useEffect(() => {
    if (!setup?.done) return;
    api<Project[]>("/api/projects").then(setProjects).catch(() => {});
  }, [route, setup?.done]);

  if (!setup) {
    return (
      <div className="shell">
        <div className="main">
          <div className="container muted">lade…</div>
        </div>
      </div>
    );
  }

  if (!setup.done && route.name !== "setup") {
    location.hash = "/setup";
    return null;
  }

  const activeProjectId =
    route.name === "project"
      ? route.id
      : route.name === "ticket"
        ? route.projectId
        : null;
  const activeProject = activeProjectId
    ? projects.find((p) => p.id === activeProjectId)
    : null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark" />
          <div className="col" style={{ gap: 0 }}>
            <div className="brand-text">Claude</div>
            <div className="brand-sub">ORCHESTRATOR</div>
          </div>
        </div>

        <a
          href="#/"
          className={`nav-item ${
            route.name === "dashboard" ||
            route.name === "project" ||
            route.name === "ticket"
              ? "active"
              : ""
          }`}
        >
          <Icon name="home" size={16} />
          Dashboard
        </a>
        <a
          href="#/setup"
          className={`nav-item ${route.name === "setup" ? "active" : ""}`}
        >
          <Icon name="settings" size={16} />
          Setup
        </a>

        {setup.done && projects.length > 0 && (
          <div className="nav-section">
            <h3>Projekte</h3>
            {projects.slice(0, 12).map((p) => {
              const isActive =
                (route.name === "project" && route.id === p.id) ||
                (route.name === "ticket" && route.projectId === p.id);
              const w = p.workers[0];
              const statusOk =
                w?.status === "idle" ||
                w?.status === "running" ||
                w?.status === "waiting_permission";
              return (
                <a
                  key={p.id}
                  href={`#/projects/${p.id}`}
                  className={`nav-item ${isActive ? "active" : ""}`}
                  title={p.name}
                >
                  <Icon name="folder" size={15} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {p.name}
                  </span>
                  {statusOk && (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        background: "var(--ok)",
                        boxShadow: "0 0 6px rgba(74,222,128,.6)",
                      }}
                    />
                  )}
                </a>
              );
            })}
          </div>
        )}

        <div className="sidebar-footer">
          <span
            className={`badge ${setup.done ? "ok" : "warn"}`}
            style={{ fontSize: 10 }}
          >
            {setup.done ? "bereit" : "Setup offen"}
          </span>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="breadcrumb">
            <a href="#/">Dashboard</a>
            {route.name === "setup" && (
              <>
                <span className="sep">
                  <Icon name="chevron-right" size={14} />
                </span>
                <span className="current">Setup</span>
              </>
            )}
            {route.name === "project" && (
              <>
                <span className="sep">
                  <Icon name="chevron-right" size={14} />
                </span>
                <a href={`#/projects/${route.id}`} className="current">
                  {activeProject?.name ?? route.id}
                </a>
              </>
            )}
            {route.name === "ticket" && (
              <>
                <span className="sep">
                  <Icon name="chevron-right" size={14} />
                </span>
                <a href={`#/projects/${route.projectId}/tickets`}>
                  {activeProject?.name ?? route.projectId}
                </a>
                <span className="sep">
                  <Icon name="chevron-right" size={14} />
                </span>
                <span className="current">
                  {activeProject?.key ?? ""}-T{route.ticketNumber}
                </span>
              </>
            )}
          </div>
          <div id="topbar-meta" className="topbar-meta" />
          <div id="topbar-actions" className="topbar-actions" />
        </div>

        {route.name === "setup" && <Setup onChange={setSetup} />}
        {route.name === "dashboard" && <Dashboard />}
        {route.name === "project" && (
          <ProjectPage id={route.id} tab={route.tab} />
        )}
        {route.name === "ticket" && (
          <ProjectPage
            id={route.projectId}
            tab="tickets"
            openTicketNumber={route.ticketNumber}
          />
        )}
      </div>
    </div>
  );
}

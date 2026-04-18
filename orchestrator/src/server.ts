import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { restartBot } from "./telegram.js";
import { matrixChannel } from "./channels/matrix.js";
import { reconcileOnBoot } from "./workers.js";
import { db } from "./db.js";
import { docker } from "./docker.js";
import { startHistoryRecorder } from "./history.js";
import { startScheduler } from "./scheduler.js";
import { ensureSelfProject } from "./self-project.js";
import { getSetupStatus } from "./db.js";
import { scanFailuresOnBoot } from "./deploy/orchestrator.js";
import { startSelfDeployPoller } from "./deploy/poller.js";
import setupRoutes from "./routes/setup.js";
import projectRoutes from "./routes/projects.js";
import ticketRoutes from "./routes/tickets.js";
import sprintRoutes from "./routes/sprints.js";
import workerRoutes from "./routes/workers.js";
import wsRoutes from "./routes/ws.js";
import deployRoutes from "./routes/deploy.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 2 * 1024 * 1024,
});

// --- basic auth (optional) ---
if (config.uiBasicAuth) {
  const expected = "Basic " + Buffer.from(config.uiBasicAuth).toString("base64");
  app.addHook("onRequest", async (req, reply) => {
    // allow worker WS without auth (inside docker network)
    if (req.url.startsWith("/ws/worker/")) return;
    // health probe is used by the deployer sidecar and must bypass auth
    if (req.url === "/healthz") return;
    const h = req.headers.authorization;
    if (h === expected) return;
    reply
      .code(401)
      .header("WWW-Authenticate", 'Basic realm="runhelm"')
      .send({ error: "unauthorized" });
  });
}

app.get("/healthz", async (_req, reply) => {
  const checks: Record<string, boolean> = {};
  try {
    db.prepare("SELECT 1").get();
    checks.db = true;
  } catch {
    checks.db = false;
  }
  try {
    await docker.ping();
    checks.docker = true;
  } catch {
    checks.docker = false;
  }
  const ok = Object.values(checks).every(Boolean);
  reply.code(ok ? 200 : 503).send({ ok, checks });
});

startHistoryRecorder();
startScheduler();

await app.register(fastifyWebsocket);
await app.register(setupRoutes);
await app.register(projectRoutes);
await app.register(ticketRoutes);
await app.register(sprintRoutes);
await app.register(workerRoutes);
await app.register(deployRoutes);
await app.register(wsRoutes);

// --- static frontend (built assets) ---
const here = dirname(fileURLToPath(import.meta.url));
// dist layout: dist/server.js + web/dist at ../web/dist relative to repo root
const candidates = [
  join(here, "..", "web", "dist"),
  join(here, "..", "..", "web", "dist"),
];
const webRoot = candidates.find((p) => existsSync(p));
if (webRoot) {
  await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/ws/")) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.sendFile("index.html", webRoot);
  });
} else {
  app.log.warn("Web UI bundle not found; API-only mode");
}

// --- boot ---
try {
  await restartBot();
} catch (e) {
  app.log.error({ err: e }, "failed to start telegram bot");
}
try {
  await matrixChannel.start();
} catch (e) {
  app.log.error({ err: e }, "failed to start matrix bot");
}
await reconcileOnBoot();

try {
  if (getSetupStatus().github) {
    await ensureSelfProject();
  }
} catch (e) {
  app.log.error({ err: e }, "ensureSelfProject failed");
}

try {
  await scanFailuresOnBoot();
} catch (e) {
  app.log.error({ err: e }, "scanFailuresOnBoot failed");
}

startSelfDeployPoller();

const port = Number(process.env.PORT ?? 8787);
await app.listen({ host: "0.0.0.0", port });
app.log.info(`orchestrator listening on :${port}`);

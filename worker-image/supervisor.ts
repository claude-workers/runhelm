import { query } from "@anthropic-ai/claude-agent-sdk";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

// ---------- env ----------
const WORKER_ID = must("WORKER_ID");
const ORCH_URL = must("ORCHESTRATOR_URL");
const WORKSPACE = "/workspace";
let POLICY = (process.env.POLICY ?? "safe") as Policy;
const SYSTEM_PROMPT_APPEND = (process.env.SYSTEM_PROMPT_APPEND ?? "").trim();

type Policy = "read-only" | "safe" | "dev" | "full-auto";

// ---------- connection ----------
const wsUrl = ORCH_URL.replace(/^http/, "ws") + `/ws/worker/${WORKER_ID}`;

let ws: WebSocket | null = null;
let sessionId: string | null = null;
const promptQueue: string[] = [];
let processing = false;
let shouldStop = false;

const pendingPermissions = new Map<string, (r: PermissionResult) => void>();

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(1);
  }
  return v;
}

function sendWS(payload: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function log(...args: unknown[]): void {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  console.log(line);
  sendWS({ type: "log", line });
}

function setStatus(status: string): void {
  sendWS({ type: "status", status });
}

// ---------- policy ----------
const ALLOW_BY_POLICY: Record<Policy, string[]> = {
  "read-only": ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
  safe: ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Bash"],
  dev: [
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
  ],
  "full-auto": [],
};

function isAutoAllowed(tool: string): boolean {
  if (POLICY === "full-auto") return true;
  return ALLOW_BY_POLICY[POLICY].includes(tool);
}

// ---------- connection handling ----------
function connect(): void {
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    log(`[supervisor] connected as ${WORKER_ID}`);
    sendWS({ type: "hello", workerId: WORKER_ID });
    setStatus("idle");
  });

  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleInbound(msg);
  });

  ws.on("close", () => {
    if (shouldStop) return;
    log("[supervisor] ws closed, reconnecting in 2s");
    setTimeout(connect, 2000);
  });

  ws.on("error", (err) => {
    log("[supervisor] ws error", (err as Error).message);
  });
}

function handleInbound(msg: any): void {
  switch (msg.type) {
    case "user_prompt":
      promptQueue.push(msg.text);
      processQueue();
      break;
    case "permission_resolved": {
      const resolver = pendingPermissions.get(msg.requestId);
      if (!resolver) return;
      pendingPermissions.delete(msg.requestId);
      if (msg.allow) {
        resolver({ behavior: "allow", updatedInput: undefined as any });
      } else {
        resolver({
          behavior: "deny",
          message: msg.note ?? "abgelehnt",
          interrupt: false,
        });
      }
      break;
    }
    case "policy":
      POLICY = msg.policy as Policy;
      log(`[supervisor] policy changed -> ${POLICY}`);
      break;
    case "stop":
      log("[supervisor] stop requested");
      shouldStop = true;
      setStatus("stopped");
      setTimeout(() => process.exit(0), 500);
      break;
    case "reset_session":
      sessionId = null;
      log("[supervisor] session reset");
      break;
  }
}

// ---------- permission callback ----------
async function canUseTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  if (isAutoAllowed(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }
  const requestId = randomUUID();
  setStatus("waiting_permission");
  sendWS({
    type: "permission_request",
    requestId,
    tool: toolName,
    input,
  });
  // wait for resolution (no timeout for MVP — user keeps it running)
  return new Promise<PermissionResult>((resolve) => {
    pendingPermissions.set(requestId, (r) => {
      setStatus("running");
      resolve(r);
    });
  });
}

// ---------- turn processing ----------
async function processQueue(): Promise<void> {
  if (processing) return;
  if (promptQueue.length === 0) return;
  processing = true;
  try {
    while (promptQueue.length > 0 && !shouldStop) {
      const prompt = promptQueue.shift()!;
      await runTurn(prompt);
    }
  } finally {
    processing = false;
    if (!shouldStop) setStatus("idle");
  }
}

async function runTurn(prompt: string): Promise<void> {
  setStatus("running");
  log(`[turn] prompt: ${prompt.slice(0, 120)}`);

  const stderrBuf: string[] = [];
  const options: any = {
    cwd: WORKSPACE,
    canUseTool,
    permissionMode: POLICY === "full-auto" ? "bypassPermissions" : "default",
    resume: sessionId ?? undefined,
    stderr: (data: string) => {
      stderrBuf.push(data);
      console.error("[sdk-stderr]", data);
    },
  };
  if (SYSTEM_PROMPT_APPEND) {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: SYSTEM_PROMPT_APPEND,
    };
  }

  try {
    const gen = query({ prompt, options });
    for await (const msg of gen as AsyncIterable<any>) {
      handleSdkMessage(msg);
    }
  } catch (e) {
    const err = e as Error & { stderr?: string; stdout?: string };
    const capturedStderr = stderrBuf.join("");
    const detail = [
      err.message,
      capturedStderr ? `stderr:\n${capturedStderr}` : "",
      err.stderr ? `err.stderr:\n${err.stderr}` : "",
      err.stdout ? `err.stdout:\n${err.stdout}` : "",
      err.stack ? `stack:\n${err.stack}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    log("[turn] error", detail);
    console.error("[turn] raw error", e);
    setStatus("error");
    sendWS({
      type: "message",
      role: "assistant",
      text: `⚠️ Fehler im Turn:\n\`\`\`\n${detail}\n\`\`\``,
    });
    setStatus("idle");
  }
}

function handleSdkMessage(msg: any): void {
  // SDK message types: system/init, assistant, user, tool_use, tool_result, result
  if (msg.type === "system" && msg.subtype === "init") {
    if (msg.session_id) {
      sessionId = msg.session_id;
      sendWS({ type: "session", session_id: sessionId });
    }
    return;
  }
  if (msg.type === "assistant") {
    const content = msg.message?.content ?? [];
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        sendWS({ type: "message", role: "assistant", text: block.text });
      } else if (block.type === "tool_use") {
        sendWS({
          type: "message",
          role: "tool",
          text: `🔧 ${block.name}`,
        });
      }
    }
    return;
  }
  if (msg.type === "result") {
    sendWS({ type: "log", line: `[turn end] ${msg.subtype ?? "ok"}` });
    return;
  }
  // Other message types: ignore verbose details (tool_result, user echoes)
}

// ---------- boot ----------
process.on("SIGTERM", () => {
  shouldStop = true;
  process.exit(0);
});

connect();

import { db } from "./db.js";
import { bus, type BusEvent } from "./bus.js";

const insert = db.prepare(
  "INSERT INTO events(project_id,worker_id,type,payload,ts) VALUES(?,?,?,?,?)"
);

const findProjectForRequest = db.prepare<[string], { project_id: string }>(
  `SELECT project_id FROM events
    WHERE type = 'permission_request'
      AND json_extract(payload,'$.requestId') = ?
    ORDER BY ts DESC LIMIT 1`
);

export function startHistoryRecorder(): void {
  bus.on((e: BusEvent) => {
    try {
      record(e);
    } catch (err) {
      console.error("[history] record failed", err);
    }
  });
}

function record(e: BusEvent): void {
  const ts = Date.now();
  switch (e.type) {
    case "user_prompt":
      insert.run(
        e.projectId,
        e.workerId,
        "user_prompt",
        JSON.stringify({ text: e.text, origin: e.origin }),
        ts
      );
      return;
    case "worker_message":
      insert.run(
        e.projectId,
        e.workerId,
        "worker_message",
        JSON.stringify({ role: e.role, text: e.text }),
        ts
      );
      return;
    case "permission_request":
      insert.run(
        e.projectId,
        e.workerId,
        "permission_request",
        JSON.stringify({ requestId: e.requestId, tool: e.tool, input: e.input }),
        ts
      );
      return;
    case "permission_resolved": {
      const row = findProjectForRequest.get(e.requestId);
      if (!row) return;
      insert.run(
        row.project_id,
        null,
        "permission_resolved",
        JSON.stringify({ requestId: e.requestId, allow: e.allow }),
        ts
      );
      return;
    }
    default:
      return;
  }
}

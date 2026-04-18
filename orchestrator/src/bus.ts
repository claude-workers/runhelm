import { EventEmitter } from "node:events";

export type BusEvent =
  | { type: "worker_status"; workerId: string; projectId: string; status: string }
  | { type: "worker_log"; workerId: string; projectId: string; line: string }
  | {
      type: "worker_message";
      workerId: string;
      projectId: string;
      role: "assistant" | "tool" | "system";
      text: string;
    }
  | {
      type: "permission_request";
      workerId: string;
      projectId: string;
      requestId: string;
      tool: string;
      input: unknown;
    }
  | { type: "permission_resolved"; requestId: string; allow: boolean; note?: string }
  | {
      type: "user_prompt";
      workerId: string;
      projectId: string;
      text: string;
      origin: "ui" | "telegram" | "matrix" | "scheduler";
      ticketId?: string;
    }
  | { type: "policy_changed"; workerId: string; projectId: string; policy: string }
  | { type: "ticket_changed"; projectId: string; ticketId: string }
  | { type: "sprint_changed"; projectId: string; sprintId: string }
  | {
      type: "ticket_comment_added";
      projectId: string;
      ticketId: string;
      role: "user" | "assistant" | "system" | "permission";
      text: string;
      origin: string;
      ts: number;
    };

export interface Bus {
  emit(e: BusEvent): void;
  on(fn: (e: BusEvent) => void): () => void;
}

const EVT = "evt";

class BusImpl implements Bus {
  private ee = new EventEmitter();
  emit(e: BusEvent): void {
    this.ee.emit(EVT, e);
  }
  on(fn: (e: BusEvent) => void): () => void {
    this.ee.on(EVT, fn);
    return () => this.ee.off(EVT, fn);
  }
}

export const bus: Bus = new BusImpl();

import type { FastifyInstance } from "fastify";
import { bus } from "../bus.js";
import {
  handleWorkerMessage,
  registerWorkerSink,
  getWorker,
} from "../workers.js";

export default async function wsRoutes(app: FastifyInstance) {
  // UI live feed — receives all bus events
  app.get("/ws/ui", { websocket: true }, (socket) => {
    const off = bus.on((e) => {
      try {
        socket.send(JSON.stringify(e));
      } catch {
        // ignore
      }
    });
    socket.on("close", off);
    socket.on("error", off);
  });

  // Worker supervisor WS
  app.get<{ Params: { id: string } }>(
    "/ws/worker/:id",
    { websocket: true },
    (socket, req) => {
      const workerId = (req.params as { id: string }).id;
      const w = getWorker(workerId);
      if (!w) {
        socket.close(4004, "unknown worker");
        return;
      }
      const off = registerWorkerSink(workerId, (payload) => {
        try {
          socket.send(JSON.stringify(payload));
        } catch {
          // ignore
        }
      });
      socket.on("message", (raw: Buffer | string) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        handleWorkerMessage(workerId, msg);
      });
      socket.on("close", off);
      socket.on("error", off);
    }
  );
}

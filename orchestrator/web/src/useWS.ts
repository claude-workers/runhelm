import { useEffect, useRef } from "react";

export function useWS(path: string, onMessage: (msg: any) => void): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}${path}`;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    const connect = () => {
      ws = new WebSocket(url);
      ws.onmessage = (e) => {
        try {
          handlerRef.current(JSON.parse(e.data));
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        if (closed) return;
        retry = Math.min(retry + 1, 5);
        setTimeout(connect, 500 * retry);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [path]);
}

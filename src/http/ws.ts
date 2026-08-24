import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerEvent } from "../types.js";

/** Broadcasts ServerEvent payloads to every connected dashboard client. */
export class WsHub {
  private wss: WebSocketServer;

  constructor(httpServer: HttpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    this.wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        if (raw.toString() === "ping") socket.send("pong");
      });
    });
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  clientCount(): number {
    return this.wss.clients.size;
  }
}

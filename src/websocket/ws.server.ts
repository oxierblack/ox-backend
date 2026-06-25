import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger";

interface WSClient {
  ws: WebSocket;
  userId?: string;
  subscribedSymbols: Set<string>;
}

const clients: Set<WSClient> = new Set();

export function createWSServer(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const client: WSClient = { ws, subscribedSymbols: new Set() };
    clients.add(client);
    logger.info({ ip: req.socket.remoteAddress }, "WS client connected");

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; token?: string; symbols?: string[] };

        if (msg.type === "auth" && msg.token) {
          const secret = process.env["JWT_SECRET"] || "default_secret";
          try {
            const decoded = jwt.verify(msg.token, secret) as { id: string };
            client.userId = decoded.id;
            ws.send(JSON.stringify({ type: "auth_success" }));
          } catch {
            ws.send(JSON.stringify({ type: "auth_error", error: "Invalid token" }));
          }
          return;
        }

        if (msg.type === "subscribe" && msg.symbols) {
          for (const sym of msg.symbols) client.subscribedSymbols.add(sym);
          return;
        }

        if (msg.type === "unsubscribe" && msg.symbols) {
          for (const sym of msg.symbols) client.subscribedSymbols.delete(sym);
          return;
        }
      } catch {
        logger.warn("Invalid WS message");
      }
    });

    ws.on("close", () => {
      clients.delete(client);
    });

    ws.on("error", (err) => {
      logger.error({ err }, "WS error");
      clients.delete(client);
    });

    ws.send(JSON.stringify({ type: "connected", message: "OXIER WebSocket ready" }));
  });
}

export function broadcast(event: string, data: unknown, targetUserId?: string): void {
  const message = JSON.stringify({ type: event, data, timestamp: Date.now() });

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    if (targetUserId && client.userId !== targetUserId) continue;

    if (event === "price_update" || event === "signal") {
      const symbol = (data as { symbol?: string }).symbol;
      if (symbol && client.subscribedSymbols.size > 0 && !client.subscribedSymbols.has(symbol)) continue;
    }

    try {
      client.ws.send(message);
    } catch {
      clients.delete(client);
    }
  }
}

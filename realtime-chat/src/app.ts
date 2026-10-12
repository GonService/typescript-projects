import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { ChatHub } from "./chat.js";
import type { Config } from "./config.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

export async function buildApp(config: Config, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const hub = new ChatHub(config);
  const alive = new WeakMap<WebSocket, boolean>();

  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 } });
  await app.register(fastifyStatic, { root: PUBLIC_DIR });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/api/rooms", async () => ({ rooms: hub.listRooms() }));

  app.get("/ws", { websocket: true }, (socket, req) => {
    const conn = {
      send: (data: string) => {
        if (socket.readyState === socket.OPEN) socket.send(data);
      },
      close: (code: number, reason: string) => socket.close(code, reason),
    };
    hub.connect(conn);
    alive.set(socket, true);
    req.log.info("websocket connected");

    socket.on("pong", () => alive.set(socket, true));
    socket.on("message", (data, isBinary) => {
      if (isBinary) return conn.close(1003, "text frames only");
      hub.receive(conn, data.toString());
    });
    socket.on("close", () => hub.disconnect(conn));
  });

  // Drop connections that stop answering pings (closed laptops, dead mobile networks).
  const heartbeat = setInterval(() => {
    for (const socket of app.websocketServer.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const socket of app.websocketServer.clients) socket.close(1001, "server shutting down");
  });

  return app;
}

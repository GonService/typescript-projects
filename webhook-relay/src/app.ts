import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { verify } from "./signature.js";
import type { DeliveryStatus, Store } from "./store.js";

const STATUSES: DeliveryStatus[] = ["pending", "delivered", "failed"];
const EVENT_ID_HEADERS = ["x-event-id", "x-request-id", "x-github-delivery", "idempotency-key"];

function eventIdOf(req: FastifyRequest, body: Buffer): string {
  for (const h of EVENT_ID_HEADERS) {
    const v = req.headers[h];
    if (typeof v === "string" && v.length > 0 && v.length <= 200) return v;
  }
  // No id from the provider: identical payloads are treated as the same event.
  return "sha256:" + createHash("sha256").update(body).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildApp(config: Config, store: Store, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  const received = new Map<string, number>();
  const rejected = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  // Keep the raw bytes: the signature is computed over the exact body the provider sent.
  // Fastify's built-in JSON parser would discard them, so it is replaced by a raw-buffer parser.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post<{ Params: { source: string } }>("/webhooks/:source", async (req, reply) => {
    const name = req.params.source;
    const source = config.sources[name];
    if (!source) return reply.code(404).send({ error: "unknown_source" });

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = req.headers[source.signatureHeader ?? "x-signature"];
    if (!verify(source.secret, body, typeof header === "string" ? header : undefined)) {
      bump(rejected, name);
      req.log.warn({ source: name }, "invalid signature");
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const eventId = eventIdOf(req, body);
    const isNew = store.enqueue({
      source: name,
      eventId,
      target: source.target,
      payload: body.toString("utf8"),
      contentType: req.headers["content-type"] ?? "application/json",
    });
    bump(received, name);
    return reply.code(202).send({ accepted: true, duplicate: !isNew, eventId });
  });

  // ---- Admin API (Bearer token) ----
  app.register(async (admin) => {
    admin.addHook("onRequest", async (req, reply) => {
      const auth = req.headers.authorization ?? "";
      if (!safeEqual(auth, `Bearer ${config.adminToken}`)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    });

    admin.get<{ Querystring: { status?: string; limit?: string } }>("/deliveries", async (req, reply) => {
      const { status } = req.query;
      if (status && !STATUSES.includes(status as DeliveryStatus)) {
        return reply.code(400).send({ error: "invalid_status" });
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
      return { items: store.list(status as DeliveryStatus | undefined, limit), counts: store.counts() };
    });

    admin.post<{ Params: { id: string } }>("/deliveries/:id/retry", async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: "invalid_id" });
      if (!store.retry(id)) return reply.code(409).send({ error: "not_failed_or_missing" });
      return { requeued: true, id };
    });
  }, { prefix: "/admin" });

  // ---- Prometheus metrics ----
  app.get("/metrics", async (_req, reply) => {
    const lines: string[] = [];
    lines.push("# HELP webhook_relay_received_total Webhooks accepted per source.", "# TYPE webhook_relay_received_total counter");
    for (const [s, n] of received) lines.push(`webhook_relay_received_total{source="${s}"} ${n}`);
    lines.push("# HELP webhook_relay_rejected_total Webhooks rejected for invalid signature.", "# TYPE webhook_relay_rejected_total counter");
    for (const [s, n] of rejected) lines.push(`webhook_relay_rejected_total{source="${s}"} ${n}`);
    lines.push("# HELP webhook_relay_deliveries Deliveries by status.", "# TYPE webhook_relay_deliveries gauge");
    for (const [status, n] of Object.entries(store.counts())) lines.push(`webhook_relay_deliveries{status="${status}"} ${n}`);
    return reply.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });

  return app;
}

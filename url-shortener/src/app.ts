import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { homePage, statsPage } from "./html.js";
import { randomSlug, referrerHost, uaFamily, validateAlias, validateTargetUrl } from "./links.js";
import type { Link, Store } from "./store.js";

interface CreateBody {
  url: string;
  alias?: string;
  expiresAt?: string;
  expiresInDays?: number;
}

const createSchema = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    url: { type: "string", minLength: 1, maxLength: 2048 },
    alias: { type: "string", minLength: 1, maxLength: 40 },
    expiresAt: { type: "string", format: "date-time" },
    expiresInDays: { type: "integer", minimum: 1, maximum: 3650 },
  },
} as const;

const slugParams = {
  type: "object",
  required: ["slug"],
  properties: { slug: { type: "string", maxLength: 64 } },
} as const;

const sha = (s: string) => createHash("sha256").update(s).digest();

export function buildApp(config: Config, store: Store, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024, trustProxy: true });
  const shortUrl = (slug: string) => `${config.baseUrl}/${slug}`;
  const view = (l: Link) => ({ ...l, shortUrl: shortUrl(l.slug), statsUrl: `${config.baseUrl}/stats/${l.slug}` });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: "validation_error", message: err.message });
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: "error", message: err.message });
  });

  const requireToken = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.apiToken) return;
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!timingSafeEqual(sha(given), sha(config.apiToken))) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid API token" });
    }
  };

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(homePage(Boolean(config.apiToken))));

  app.post<{ Body: CreateBody }>("/api/links", { onRequest: requireToken, schema: { body: createSchema } }, async (req, reply) => {
    const { alias, expiresAt, expiresInDays } = req.body;
    const target = validateTargetUrl(req.body.url, config.baseUrl);
    if ("error" in target) return reply.code(400).send({ error: "invalid_url", message: target.error });

    if (expiresAt && expiresInDays) {
      return reply.code(400).send({ error: "validation_error", message: "use expiresAt or expiresInDays, not both" });
    }
    let expiry: number | null = null;
    if (expiresAt) expiry = Date.parse(expiresAt);
    if (expiresInDays) expiry = Date.now() + expiresInDays * 86_400_000;
    if (expiry !== null && expiry <= Date.now()) {
      return reply.code(400).send({ error: "validation_error", message: "expiresAt must be in the future" });
    }

    if (alias !== undefined) {
      const problem = validateAlias(alias);
      if (problem) return reply.code(400).send({ error: "invalid_alias", message: problem });
      const link = store.create({ slug: alias, url: target.url, expiresAt: expiry });
      if (!link) return reply.code(409).send({ error: "alias_taken", message: `alias "${alias}" is already in use` });
      return reply.code(201).send(view(link));
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const link = store.create({ slug: randomSlug(config.slugLength), url: target.url, expiresAt: expiry });
      if (link) return reply.code(201).send(view(link));
    }
    throw new Error("could not generate a unique slug");
  });

  app.get<{ Params: { slug: string } }>("/api/links/:slug", { schema: { params: slugParams } }, async (req, reply) => {
    const link = store.get(req.params.slug);
    if (!link) return reply.code(404).send({ error: "not_found" });
    return view(link);
  });

  app.delete<{ Params: { slug: string } }>(
    "/api/links/:slug",
    { onRequest: requireToken, schema: { params: slugParams } },
    async (req, reply) => {
      if (!store.delete(req.params.slug)) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { slug: string }; Querystring: { days: number } }>(
    "/api/links/:slug/stats",
    {
      schema: {
        params: slugParams,
        querystring: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 365, default: 30 } } },
      },
    },
    async (req, reply) => {
      const stats = store.stats(req.params.slug, req.query.days);
      if (!stats) return reply.code(404).send({ error: "not_found" });
      return { slug: req.params.slug, ...stats };
    },
  );

  app.get<{ Params: { slug: string } }>("/stats/:slug", { schema: { params: slugParams } }, async (req, reply) => {
    const link = store.get(req.params.slug);
    const stats = link && store.stats(link.slug, 30);
    if (!link || !stats) return reply.code(404).type("text/plain").send("Link not found");
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(statsPage(link, stats, shortUrl(link.slug)));
  });

  app.get<{ Params: { slug: string } }>("/:slug", { schema: { params: slugParams } }, async (req, reply) => {
    const link = store.get(req.params.slug);
    if (!link) return reply.code(404).type("text/plain").send("Link not found");
    if (link.expired) return reply.code(410).type("text/plain").send("This link has expired");
    if (req.method === "GET") {
      store.recordClick(link.slug, {
        at: Date.now(),
        referrerHost: referrerHost(req.headers.referer),
        uaFamily: uaFamily(req.headers["user-agent"]),
      });
    }
    // 302 + no-store: browsers come back every time, so every click is counted.
    return reply.header("cache-control", "no-store").redirect(link.url, 302);
  });

  return app;
}

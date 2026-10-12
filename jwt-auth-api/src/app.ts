import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Config } from "./config.js";
import type { Role, Store, User } from "./store.js";
import { hashToken, newRefreshToken } from "./tokens.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: Role };
    user: { sub: string; role: Role; iat: number; exp: number };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (role: Role) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// ---- JSON schemas: used for validation, response serialization and the OpenAPI document ----
const userSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    name: { type: "string" },
    role: { type: "string", enum: ["user", "admin"] },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "email", "name", "role", "createdAt"],
} as const;

const tokenPairSchema = {
  type: "object",
  properties: {
    tokenType: { type: "string", enum: ["Bearer"] },
    accessToken: { type: "string", description: "JWT (HS256), send as Authorization: Bearer <token>" },
    expiresIn: { type: "integer", description: "Access token lifetime in seconds" },
    refreshToken: { type: "string", description: "Opaque, single use; exchange at /auth/refresh" },
  },
  required: ["tokenType", "accessToken", "expiresIn", "refreshToken"],
} as const;

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
  required: ["error"],
} as const;

const credentialsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email", maxLength: 254 },
    password: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

const registerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password", "name"],
  properties: {
    email: { type: "string", format: "email", maxLength: 254 },
    password: { type: "string", minLength: 10, maxLength: 128, description: "10 to 128 characters" },
    name: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

const refreshBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["refreshToken"],
  properties: { refreshToken: { type: "string", minLength: 20, maxLength: 200 } },
} as const;

const bearer = [{ bearerAuth: [] }];

interface Credentials {
  email: string;
  password: string;
}

export async function buildApp(
  config: Config,
  store: Store,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });

  // Hash used when the e-mail does not exist, so a failed login takes the same time either way.
  const dummyHash = await bcrypt.hash(randomUUID(), config.bcryptRounds);

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "jwt-auth-api",
        description:
          "Authentication service: short-lived access JWTs, rotating refresh tokens with reuse detection, roles.",
        version: "1.0.0",
      },
      tags: [
        { name: "auth", description: "Register, login, refresh and logout" },
        { name: "account", description: "Authenticated user" },
        { name: "admin", description: "Requires the admin role" },
      ],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: false, defaultModelsExpandDepth: -1 },
    theme: { title: "jwt-auth-api docs", css: [{ filename: "theme.css", content: ".swagger-ui .topbar { display: none }" }] },
  });

  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { algorithm: "HS256", expiresIn: config.accessTtlSeconds, iss: config.jwtIssuer },
    verify: { algorithms: ["HS256"], allowedIss: config.jwtIssuer },
  });

  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err.validation) {
      return reply.code(400).send({ error: "validation_error", message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status === 429 ? "too_many_requests" : "error", message: err.message });
  });

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized", message: "Missing, invalid or expired access token" });
    }
  });

  app.decorate("requireRole", (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user.role !== role) {
      return reply.code(403).send({ error: "forbidden", message: `Requires role ${role}` });
    }
  });

  const issueTokens = (user: Pick<User, "id" | "role">, familyId: string = randomUUID()) => {
    const refreshToken = newRefreshToken();
    const id = store.insertRefreshToken({
      userId: user.id,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: Date.now() + config.refreshTtlDays * 86_400_000,
    });
    const accessToken = app.jwt.sign({ sub: user.id, role: user.role });
    return { id, pair: { tokenType: "Bearer", accessToken, expiresIn: config.accessTtlSeconds, refreshToken } };
  };

  app.get("/healthz", { schema: { hide: true } }, async () => ({ status: "ok" }));

  app.post<{ Body: { email: string; password: string; name: string } }>(
    "/auth/register",
    {
      schema: {
        tags: ["auth"],
        summary: "Create an account",
        body: registerSchema,
        response: { 201: userSchema, 400: errorSchema, 409: errorSchema },
      },
    },
    async (req, reply) => {
      const { email, password, name } = req.body;
      const role: Role = config.adminEmails.includes(email.toLowerCase()) ? "admin" : "user";
      const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
      const user = store.createUser({ email, name: name.trim(), role, passwordHash });
      if (!user) return reply.code(409).send({ error: "email_taken", message: "E-mail already registered" });
      return reply.code(201).send(user);
    },
  );

  app.post<{ Body: Credentials }>(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: config.loginMaxAttempts,
          timeWindow: config.loginWindowMs,
          // Runs after body parsing so the key can include the e-mail.
          hook: "preHandler",
          // Per client and account: slows down guessing without locking out the real owner elsewhere.
          keyGenerator: (req: FastifyRequest) => {
            const body = req.body as Partial<Credentials> | undefined;
            return `${req.ip}|${String(body?.email ?? "").toLowerCase()}`;
          },
        },
      },
      schema: {
        tags: ["auth"],
        summary: "Exchange e-mail and password for tokens",
        description: `Rate limited to ${config.loginMaxAttempts} attempts per ${config.loginWindowMs / 1000}s per IP and e-mail.`,
        body: credentialsSchema,
        response: { 200: tokenPairSchema, 401: errorSchema, 429: errorSchema },
      },
    },
    async (req, reply) => {
      const user = store.findUserByEmail(req.body.email);
      const ok = await bcrypt.compare(req.body.password, user?.passwordHash ?? dummyHash);
      if (!user || !ok) return reply.code(401).send({ error: "invalid_credentials" });
      return issueTokens(user).pair;
    },
  );

  app.post<{ Body: { refreshToken: string } }>(
    "/auth/refresh",
    {
      schema: {
        tags: ["auth"],
        summary: "Rotate a refresh token",
        description:
          "Returns a new token pair and invalidates the token sent. Presenting an already used token revokes the whole session (reuse detection).",
        body: refreshBodySchema,
        response: { 200: tokenPairSchema, 401: errorSchema },
      },
    },
    async (req, reply) => {
      const row = store.findRefreshToken(hashToken(req.body.refreshToken));
      if (!row) return reply.code(401).send({ error: "invalid_refresh_token" });
      if (row.revoked_at !== null) {
        // A rotated token came back: it may have been stolen. Kill the whole session.
        store.revokeFamily(row.family_id);
        req.log.warn({ userId: row.user_id, familyId: row.family_id }, "refresh token reuse detected");
        return reply.code(401).send({ error: "refresh_token_reused" });
      }
      if (row.expires_at <= Date.now()) return reply.code(401).send({ error: "refresh_token_expired" });
      const user = store.findUserById(row.user_id);
      if (!user) return reply.code(401).send({ error: "invalid_refresh_token" });

      const result = store.transaction(() => {
        const next = issueTokens(user, row.family_id);
        if (!store.markRotated(row.id, next.id)) throw Object.assign(new Error("concurrent refresh"), { statusCode: 401 });
        return next.pair;
      });
      return result;
    },
  );

  app.post<{ Body: { refreshToken: string } }>(
    "/auth/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Revoke the session of a refresh token",
        body: refreshBodySchema,
        response: { 204: { type: "null", description: "Session revoked (also returned for unknown tokens)" } },
      },
    },
    async (req, reply) => {
      const row = store.findRefreshToken(hashToken(req.body.refreshToken));
      if (row) store.revokeFamily(row.family_id);
      return reply.code(204).send();
    },
  );

  app.post(
    "/auth/logout-all",
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ["auth"],
        summary: "Revoke every session of the current user",
        security: bearer,
        response: { 200: { type: "object", properties: { revoked: { type: "integer" } } }, 401: errorSchema },
      },
    },
    async (req) => ({ revoked: store.revokeAllForUser(req.user.sub) }),
  );

  app.get(
    "/me",
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ["account"],
        summary: "Current user",
        security: bearer,
        response: {
          200: {
            type: "object",
            properties: { ...userSchema.properties, activeSessions: { type: "integer" } },
            required: [...userSchema.required, "activeSessions"],
          },
          401: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const user = store.findUserById(req.user.sub);
      if (!user) return reply.code(401).send({ error: "unauthorized", message: "User no longer exists" });
      return { ...user, activeSessions: store.activeSessions(user.id) };
    },
  );

  app.get(
    "/admin/users",
    {
      onRequest: [app.authenticate, app.requireRole("admin")],
      schema: {
        tags: ["admin"],
        summary: "List users",
        security: bearer,
        response: {
          200: { type: "object", properties: { items: { type: "array", items: userSchema } } },
          401: errorSchema,
          403: errorSchema,
        },
      },
    },
    async () => ({ items: store.listUsers() }),
  );

  return app;
}

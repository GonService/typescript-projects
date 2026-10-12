export interface SourceConfig {
  /** Shared secret used to verify the HMAC-SHA256 signature sent by the provider. */
  secret: string;
  /** URL that receives the webhook after it is validated. */
  target: string;
  /** Header that carries the signature. Default: x-signature */
  signatureHeader?: string;
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  adminToken: string;
  maxAttempts: number;
  baseBackoffMs: number;
  deliveryTimeoutMs: number;
  pollIntervalMs: number;
  sources: Record<string, SourceConfig>;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseSources(raw: string | undefined): Record<string, SourceConfig> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("WEBHOOK_SOURCES must be a JSON object: {\"name\": {\"secret\": \"...\", \"target\": \"https://...\"}}");
  }
  const out: Record<string, SourceConfig> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, Partial<SourceConfig>>)) {
    if (!/^[a-z0-9_-]{1,40}$/.test(name)) throw new Error(`Invalid source name: ${name}`);
    if (!value?.secret || !value?.target) throw new Error(`Source ${name} needs "secret" and "target"`);
    new URL(value.target); // throws on invalid URL
    out[name] = { secret: value.secret, target: value.target, signatureHeader: value.signatureHeader?.toLowerCase() };
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adminToken = env.ADMIN_TOKEN ?? "";
  if (adminToken.length < 16) {
    throw new Error("ADMIN_TOKEN must be set with at least 16 characters");
  }
  return {
    port: int(env.PORT, 8080),
    host: env.HOST ?? "0.0.0.0",
    dbPath: env.DB_PATH ?? "data/relay.db",
    adminToken,
    maxAttempts: int(env.MAX_ATTEMPTS, 8),
    baseBackoffMs: int(env.BASE_BACKOFF_MS, 2000),
    deliveryTimeoutMs: int(env.DELIVERY_TIMEOUT_MS, 10000),
    pollIntervalMs: int(env.POLL_INTERVAL_MS, 1000),
    sources: parseSources(env.WEBHOOK_SOURCES),
  };
}

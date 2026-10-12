export interface Config {
  port: number;
  host: string;
  dbPath: string;
  /** Public origin used to build short URLs, e.g. https://go.example.com */
  baseUrl: string;
  /** When set, creating and deleting links requires `Authorization: Bearer <token>`. */
  apiToken: string | undefined;
  /** Length of generated slugs. */
  slugLength: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = int(env.PORT, 8080);
  const baseUrl = (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const parsed = new URL(baseUrl); // throws on an invalid BASE_URL
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("BASE_URL must be http(s)");
  const apiToken = env.API_TOKEN || undefined;
  if (apiToken !== undefined && apiToken.length < 16) throw new Error("API_TOKEN must have at least 16 characters");
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    dbPath: env.DB_PATH ?? "data/links.db",
    baseUrl,
    apiToken,
    slugLength: Math.min(int(env.SLUG_LENGTH, 7), 32),
  };
}

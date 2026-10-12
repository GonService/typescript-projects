export interface Config {
  port: number;
  host: string;
  dbPath: string;
  /** HMAC secret for access tokens (HS256). */
  jwtSecret: string;
  jwtIssuer: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  bcryptRounds: number;
  /** Login attempts allowed per IP + e-mail in each window. */
  loginMaxAttempts: number;
  loginWindowMs: number;
  /** E-mails that receive the admin role when they register. */
  adminEmails: string[];
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET ?? "";
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be set with at least 32 characters (openssl rand -hex 32)");
  }
  return {
    port: int(env.PORT, 8080),
    host: env.HOST ?? "0.0.0.0",
    dbPath: env.DB_PATH ?? "data/auth.db",
    jwtSecret,
    jwtIssuer: env.JWT_ISSUER ?? "jwt-auth-api",
    accessTtlSeconds: int(env.ACCESS_TTL_SECONDS, 900),
    refreshTtlDays: int(env.REFRESH_TTL_DAYS, 30),
    bcryptRounds: int(env.BCRYPT_ROUNDS, 12),
    loginMaxAttempts: int(env.LOGIN_MAX_ATTEMPTS, 5),
    loginWindowMs: int(env.LOGIN_WINDOW_MS, 60_000),
    adminEmails: (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  };
}

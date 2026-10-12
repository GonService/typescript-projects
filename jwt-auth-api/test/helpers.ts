import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { Store } from "../src/store.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    jwtSecret: "test-secret-0123456789-0123456789-abcdef",
    jwtIssuer: "jwt-auth-api-test",
    accessTtlSeconds: 900,
    refreshTtlDays: 30,
    bcryptRounds: 4,
    loginMaxAttempts: 5,
    loginWindowMs: 60_000,
    adminEmails: ["boss@example.com"],
    ...overrides,
  };
}

export interface TestContext {
  app: FastifyInstance;
  store: Store;
  register: (email: string, password?: string, name?: string) => Promise<{ statusCode: number; body: any }>;
  login: (email: string, password?: string) => Promise<{ statusCode: number; body: any }>;
}

export const PASSWORD = "correct horse battery";

export async function setup(overrides: Partial<Config> = {}): Promise<TestContext> {
  const store = new Store(":memory:");
  const app = await buildApp(testConfig(overrides), store);
  const call = async (url: string, payload: unknown) => {
    const res = await app.inject({ method: "POST", url, payload: payload as object });
    return { statusCode: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return {
    app,
    store,
    register: (email, password = PASSWORD, name = "Test User") => call("/auth/register", { email, password, name }),
    login: (email, password = PASSWORD) => call("/auth/login", { email, password }),
  };
}

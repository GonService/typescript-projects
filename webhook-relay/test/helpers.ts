import type { Config } from "../src/config.js";

export const SECRET = "test-secret-123";
export const ADMIN = "admin-token-0123456789";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    adminToken: ADMIN,
    maxAttempts: 3,
    baseBackoffMs: 1000,
    deliveryTimeoutMs: 2000,
    pollIntervalMs: 1000,
    sources: { shop: { secret: SECRET, target: "http://target.test/hook" } },
    ...overrides,
  };
}

export const silentLog = { info: () => {}, warn: () => {} };

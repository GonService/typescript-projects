import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { Store } from "../src/store.js";

export const TOKEN = "test-api-token-0123456789";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    baseUrl: "https://sho.rt",
    apiToken: undefined,
    slugLength: 7,
    ...overrides,
  };
}

export function setup(overrides: Partial<Config> = {}): { app: FastifyInstance; store: Store } {
  const store = new Store(":memory:");
  return { app: buildApp(testConfig(overrides), store), store };
}

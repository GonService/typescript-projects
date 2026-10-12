import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sign } from "../src/signature.js";
import { Store } from "../src/store.js";
import { ADMIN, SECRET, testConfig } from "./helpers.js";

describe("HTTP API", () => {
  let store: Store;
  let app: FastifyInstance;

  beforeEach(() => {
    store = new Store(":memory:");
    app = buildApp(testConfig(), store);
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const post = (payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/webhooks/shop",
      payload,
      headers: { "content-type": "application/json", "x-signature": sign(SECRET, payload), ...headers },
    });

  it("accepts a signed webhook and queues it", async () => {
    const res = await post('{"order":1}', { "x-event-id": "evt_1" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true, duplicate: false, eventId: "evt_1" });
    expect(store.counts().pending).toBe(1);
    expect(store.list()[0]).toMatchObject({ source: "shop", payload: '{"order":1}', target: "http://target.test/hook" });
  });

  it("rejects an invalid signature", async () => {
    const res = await post('{"order":1}', { "x-signature": sign("wrong", '{"order":1}') });
    expect(res.statusCode).toBe(401);
    expect(store.counts().pending).toBe(0);
  });

  it("returns 404 for an unknown source", async () => {
    const res = await app.inject({ method: "POST", url: "/webhooks/nope", payload: "{}" });
    expect(res.statusCode).toBe(404);
  });

  it("deduplicates the same event id", async () => {
    await post('{"order":1}', { "x-event-id": "evt_1" });
    const res = await post('{"order":1}', { "x-event-id": "evt_1" });
    expect(res.json()).toMatchObject({ duplicate: true });
    expect(store.counts().pending).toBe(1);
  });

  it("deduplicates identical payloads without an event id", async () => {
    await post('{"order":2}');
    const res = await post('{"order":2}');
    expect(res.json().duplicate).toBe(true);
  });

  it("protects the admin API with the bearer token", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/deliveries" })).statusCode).toBe(401);
    await post('{"order":3}', { "x-event-id": "evt_3" });
    const res = await app.inject({ method: "GET", url: "/admin/deliveries?status=pending", headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().counts).toEqual({ pending: 1, delivered: 0, failed: 0 });
  });

  it("exposes Prometheus metrics", async () => {
    await post('{"order":4}');
    await post('{"order":4}', { "x-signature": "sha256=bad" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain('webhook_relay_received_total{source="shop"} 1');
    expect(res.body).toContain('webhook_relay_rejected_total{source="shop"} 1');
    expect(res.body).toContain('webhook_relay_deliveries{status="pending"} 1');
  });

  it("answers the health check", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
  });
});

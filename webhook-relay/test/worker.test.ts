import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { backoff, Worker } from "../src/worker.js";
import { ADMIN, silentLog, testConfig } from "./helpers.js";
import { buildApp } from "../src/app.js";

const ok = () => new Response("ok", { status: 200 });
const fail = () => new Response("boom", { status: 500 });

describe("delivery worker", () => {
  let store: Store;
  const config = testConfig();

  beforeEach(() => {
    store = new Store(":memory:");
    store.enqueue({ source: "shop", eventId: "evt_1", target: "http://target.test/hook", payload: '{"a":1}', contentType: "application/json" }, 0);
  });

  afterEach(() => store.close());

  it("delivers due events with relay headers", async () => {
    const fetchMock = vi.fn(async () => ok());
    const worker = new Worker(store, config, silentLog, fetchMock as unknown as typeof fetch);

    expect(await worker.tick(1000)).toBe(1);

    expect(store.get(1)).toMatchObject({ status: "delivered", attempts: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://target.test/hook");
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toMatchObject({ "x-relay-event-id": "evt_1", "x-relay-attempt": "1", "content-type": "application/json" });
  });

  it("retries with backoff and then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fail()).mockResolvedValueOnce(ok());
    const worker = new Worker(store, config, silentLog, fetchMock as unknown as typeof fetch);

    await worker.tick(1000);
    const afterFirst = store.get(1)!;
    expect(afterFirst).toMatchObject({ status: "pending", attempts: 1, lastError: "HTTP 500" });
    expect(afterFirst.nextAttemptAt).toBeGreaterThan(1000);

    expect(await worker.tick(1000)).toBe(0); // not due yet
    await worker.tick(afterFirst.nextAttemptAt);
    expect(store.get(1)).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("marks the delivery as failed after max attempts and allows a manual replay", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const worker = new Worker(store, config, silentLog, fetchMock as unknown as typeof fetch);

    let now = 1000;
    for (let i = 0; i < config.maxAttempts; i++) {
      await worker.tick(now);
      now = store.get(1)!.nextAttemptAt + 1;
    }
    expect(store.get(1)).toMatchObject({ status: "failed", attempts: 3, lastError: "connect ECONNREFUSED" });

    const app = buildApp(config, store);
    const res = await app.inject({ method: "POST", url: "/admin/deliveries/1/retry", headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.statusCode).toBe(200);
    expect(store.get(1)?.status).toBe("pending");
    await app.close();
  });
});

describe("backoff", () => {
  it("grows exponentially with jitter and never goes below the base", () => {
    expect(backoff(1, 1000, () => 0)).toBe(1000);
    expect(backoff(4, 1000, () => 0.999)).toBe(7992);
    expect(backoff(30, 1000, () => 1)).toBe(60 * 60 * 1000);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Store } from "../src/store.js";
import { setup, TOKEN } from "./helpers.js";

describe("HTTP API", () => {
  let app: FastifyInstance;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = setup());
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const create = (payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/api/links", payload, headers });

  it("creates a link with a generated slug", async () => {
    const res = await create({ url: "https://example.com/very/long/path?utm_source=x" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slug).toMatch(/^[A-Za-z0-9]{7}$/);
    expect(body).toMatchObject({
      url: "https://example.com/very/long/path?utm_source=x",
      shortUrl: `https://sho.rt/${body.slug}`,
      statsUrl: `https://sho.rt/stats/${body.slug}`,
      expiresAt: null,
      clicks: 0,
    });
  });

  it("accepts a custom alias and rejects duplicates case-insensitively", async () => {
    expect((await create({ url: "https://example.com", alias: "promo" })).statusCode).toBe(201);
    const dup = await create({ url: "https://example.org", alias: "PROMO" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("alias_taken");
  });

  it("rejects invalid URLs, aliases and bodies", async () => {
    expect((await create({ url: "javascript:alert(1)" })).json().error).toBe("invalid_url");
    expect((await create({ url: "https://example.com", alias: "stats" })).json().error).toBe("invalid_alias");
    expect((await create({ alias: "x" })).statusCode).toBe(400);
    expect((await create({ url: "https://example.com", expiresAt: "2001-01-01T00:00:00Z" })).statusCode).toBe(400);
    expect((await create({ url: "https://example.com", expiresInDays: 0 })).statusCode).toBe(400);
  });

  it("redirects and counts clicks with referrer and browser", async () => {
    await create({ url: "https://example.com/landing", alias: "launch" });
    const chrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36";
    const res = await app.inject({
      method: "GET",
      url: "/launch",
      headers: { referer: "https://www.linkedin.com/feed/", "user-agent": chrome },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://example.com/landing");
    expect(res.headers["cache-control"]).toBe("no-store");
    await app.inject({ method: "GET", url: "/launch", headers: { "user-agent": "curl/8.5.0" } });
    await app.inject({ method: "HEAD", url: "/launch" }); // link previews must not count

    const stats = (await app.inject({ method: "GET", url: "/api/links/launch/stats?days=7" })).json();
    expect(stats.total).toBe(2);
    expect(stats.days).toHaveLength(7);
    expect(stats.days.at(-1)).toEqual({ date: new Date().toISOString().slice(0, 10), clicks: 2 });
    expect(stats.referrers).toEqual(
      expect.arrayContaining([{ host: "linkedin.com", clicks: 1 }, { host: "(direct)", clicks: 1 }]),
    );
    expect(stats.browsers).toEqual(expect.arrayContaining([{ family: "Chrome", clicks: 1 }, { family: "curl", clicks: 1 }]));
    expect((await app.inject({ method: "GET", url: "/api/links/launch" })).json().clicks).toBe(2);
  });

  it("aggregates clicks per day over the requested window", () => {
    const link = store.create({ slug: "daily", url: "https://example.com", expiresAt: null })!;
    const day = 86_400_000;
    const now = Date.parse("2026-10-12T12:00:00Z");
    for (const offset of [0, 0, 1, 5, 40]) {
      store.recordClick(link.slug, { at: now - offset * day, referrerHost: null, uaFamily: "Firefox" });
    }
    const stats = store.stats("daily", 7, now)!;
    expect(stats.total).toBe(5);
    expect(stats.days.map((d) => d.clicks)).toEqual([0, 1, 0, 0, 0, 1, 2]);
    expect(stats.browsers).toEqual([{ family: "Firefox", clicks: 4 }]);
  });

  it("returns 410 for expired links and 404 for unknown ones", async () => {
    await create({ url: "https://example.com", alias: "old-promo", expiresInDays: 1 });
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 86_400_000;
    try {
      expect((await app.inject({ method: "GET", url: "/old-promo" })).statusCode).toBe(410);
    } finally {
      Date.now = realNow;
    }
    expect((await app.inject({ method: "GET", url: "/nothing-here" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/links/nothing-here/stats" })).statusCode).toBe(404);
  });

  it("renders the stats page with an SVG chart and escaped values", async () => {
    await create({ url: "https://example.com/?q=<script>", alias: "page" });
    await app.inject({ method: "GET", url: "/page", headers: { referer: "https://news.ycombinator.com/" } });
    const res = await app.inject({ method: "GET", url: "/stats/page" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<svg");
    expect(res.body).toContain("news.ycombinator.com");
    expect(res.body).not.toContain("<script>\"");
    expect(res.body).toContain("%3Cscript%3E");
  });

  it("deletes links", async () => {
    await create({ url: "https://example.com", alias: "tmp-link" });
    expect((await app.inject({ method: "DELETE", url: "/api/links/tmp-link" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/tmp-link" })).statusCode).toBe(404);
  });

  it("serves the home page and health check", async () => {
    expect((await app.inject({ method: "GET", url: "/" })).body).toContain("<form");
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
  });
});

describe("API token", () => {
  it("protects create and delete when API_TOKEN is set", async () => {
    const { app, store } = setup({ apiToken: TOKEN });
    const payload = { url: "https://example.com", alias: "secure" };
    expect((await app.inject({ method: "POST", url: "/api/links", payload })).statusCode).toBe(401);
    const bad = { authorization: "Bearer wrong-token-0123456789" };
    expect((await app.inject({ method: "POST", url: "/api/links", payload, headers: bad })).statusCode).toBe(401);
    const ok = { authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: "POST", url: "/api/links", payload, headers: ok })).statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: "/api/links/secure" })).statusCode).toBe(401);
    // Redirects stay public.
    expect((await app.inject({ method: "GET", url: "/secure" })).statusCode).toBe(302);
    await app.close();
    store.close();
  });
});

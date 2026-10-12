import { describe, expect, it } from "vitest";
import { randomSlug, referrerHost, uaFamily, validateAlias, validateTargetUrl } from "../src/links.js";
import { clicksChart, escapeHtml, niceMax } from "../src/html.js";

describe("validateTargetUrl", () => {
  it("accepts and normalizes http(s) URLs", () => {
    expect(validateTargetUrl("  https://Example.com/a b?x=1 ")).toEqual({ url: "https://example.com/a%20b?x=1" });
  });

  it.each([
    ["not a url", "valid absolute URL"],
    ["javascript:alert(1)", "http and https"],
    ["ftp://example.com/file", "http and https"],
    ["http://intranet/", "fully qualified"],
    ["https://user:pass@example.com/", "credentials"],
    ["https://sho.rt/abc", "this shortener"],
  ])("rejects %s", (raw, message) => {
    const res = validateTargetUrl(raw, "https://sho.rt");
    expect("error" in res && res.error).toContain(message);
  });
});

describe("aliases and slugs", () => {
  it("validates aliases", () => {
    expect(validateAlias("black-friday_2026")).toBeNull();
    expect(validateAlias("ab")).toMatch(/3-40/);
    expect(validateAlias("-start")).toMatch(/3-40/);
    expect(validateAlias("has space")).toMatch(/3-40/);
    expect(validateAlias("API")).toMatch(/reserved/);
  });

  it("generates slugs without ambiguous characters", () => {
    const slugs = new Set(Array.from({ length: 500 }, () => randomSlug(7)));
    expect(slugs.size).toBe(500);
    for (const s of slugs) expect(s).toMatch(/^[a-zA-HJ-NP-Z2-9]{7}$/);
  });
});

describe("click attributes", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/129.0 Safari/537.36", "Chrome"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/129.0 Safari/537.36 Edg/129.0", "Edge"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", "Safari"],
    ["curl/8.5.0", "curl"],
    ["Googlebot/2.1 (+http://www.google.com/bot.html)", "Bot"],
    [undefined, "Unknown"],
  ])("detects the browser family of %s", (ua, family) => {
    expect(uaFamily(ua)).toBe(family);
  });

  it("extracts the referrer host", () => {
    expect(referrerHost("https://www.linkedin.com/feed/")).toBe("linkedin.com");
    expect(referrerHost("garbage")).toBeNull();
    expect(referrerHost(undefined)).toBeNull();
  });
});

describe("html helpers", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("rounds chart maximums to nice numbers", () => {
    expect([0, 3, 7, 13, 21, 48, 130].map(niceMax)).toEqual([4, 4, 10, 20, 50, 50, 200]);
  });

  it("draws one bar per day with clicks", () => {
    const svg = clicksChart([
      { date: "2026-10-01", clicks: 3 },
      { date: "2026-10-02", clicks: 0 },
      { date: "2026-10-03", clicks: 1 },
    ]);
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg).toContain("Oct 1: 3 clicks");
    expect(svg).toContain('aria-label="4 clicks in the last 3 days"');
  });
});

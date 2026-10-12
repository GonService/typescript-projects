import { describe, expect, it } from "vitest";
import { checkSecurityHeaders, grade } from "../src/headers.js";
import { SECURE_HEADERS } from "./servers.js";

const byId = (headers: Record<string, string>, https = true) =>
  Object.fromEntries(checkSecurityHeaders(headers, https).checks.map((c) => [c.id, c]));

describe("checkSecurityHeaders", () => {
  it("gives 100 and grade A to a fully hardened HTTPS response", () => {
    expect(checkSecurityHeaders(SECURE_HEADERS, true)).toMatchObject({ score: 100, grade: "A" });
  });

  it("gives 0 and grade F to plain HTTP without headers", () => {
    const r = checkSecurityHeaders({}, false);
    expect(r).toMatchObject({ score: 0, grade: "F" });
    expect(r.checks.every((c) => c.level === "fail")).toBe(true);
  });

  it("does not credit HSTS sent over plain HTTP", () => {
    expect(byId(SECURE_HEADERS, false).hsts!.level).toBe("fail");
  });

  it("warns about short HSTS, unsafe CSP and leaky referrer policies", () => {
    const c = byId({
      "strict-transport-security": "max-age=86400",
      "content-security-policy": "script-src 'self' 'unsafe-inline'",
      "referrer-policy": "no-referrer, unsafe-url",
      "x-frame-options": "ALLOW-FROM https://example.com",
    });
    expect(c.hsts).toMatchObject({ level: "warn", points: 12, detail: expect.stringContaining("1 days") });
    expect(c.csp).toMatchObject({ level: "warn", points: 12 });
    expect(c["referrer-policy"]).toMatchObject({ level: "warn", detail: expect.stringContaining("unsafe-url") });
    expect(c["x-frame-options"]!.level).toBe("warn");
  });

  it("accepts CSP frame-ancestors instead of X-Frame-Options", () => {
    expect(byId({ "content-security-policy": "frame-ancestors 'self'" })["x-frame-options"]!.level).toBe("pass");
  });

  it("maps scores to grades", () => {
    expect([100, 90, 89, 75, 60, 40, 39].map(grade)).toEqual(["A", "A", "B", "B", "C", "D", "F"]);
  });
});

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditAll, auditUrl, normalizeUrl } from "../src/audit.js";
import { probe } from "../src/probe.js";
import { createCa, selfSigned } from "./certs.js";
import { routes, SECURE_HEADERS, startHttp, startHttps, type Running } from "./servers.js";

describe("audit against local servers", () => {
  const ca = createCa();
  const servers: Running[] = [];
  let trusted: Running, expiring: Running, untrusted: Running, plain: Running, hanging: Running;

  beforeAll(async () => {
    trusted = await startHttps(ca.sign("localhost", 90), routes({ "/": () => [200, SECURE_HEADERS] }));
    expiring = await startHttps(ca.sign("localhost", 5), routes({ "/": () => [200, SECURE_HEADERS] }));
    untrusted = await startHttps(selfSigned(), routes({ "/": () => [200, { "x-content-type-options": "nosniff" }] }));
    plain = await startHttp(
      routes({
        "/": () => [200, {}],
        "/to-https": () => [301, { location: `${trusted.url}/` }],
        "/hop1": () => [302, { location: "/hop2" }],
        "/hop2": () => [302, { location: "/hop3" }],
        "/hop3": () => [302, { location: `${trusted.url}/` }],
        "/loop": () => [302, { location: "/loop" }],
      }),
    );
    hanging = await startHttp(() => {}); // accepts the request and never answers
    servers.push(trusted, expiring, untrusted, plain, hanging);
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  it("reads the certificate of a trusted HTTPS site", async () => {
    const r = await auditUrl(`${trusted.url}/`, { ca: [ca.cert] });
    expect(r.status).toBe("pass");
    expect(r.httpStatus).toBe(200);
    expect(r.tls).toMatchObject({ trusted: true, error: null, issuer: "Site Audit Test CA", subject: "localhost", daysLeft: 89 });
    expect(r.tls!.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(r).toMatchObject({ score: 100, grade: "A", issues: [] });
    expect(r.timeMs).toBeGreaterThanOrEqual(0);
  });

  it("flags certificates from unknown issuers", async () => {
    const withoutCa = await auditUrl(`${trusted.url}/`);
    expect(withoutCa.tls).toMatchObject({ trusted: false, error: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    expect(withoutCa.status).toBe("fail");

    const self = await auditUrl(`${untrusted.url}/`, { ca: [ca.cert] });
    expect(self.tls).toMatchObject({ trusted: false, error: "DEPTH_ZERO_SELF_SIGNED_CERT", daysLeft: 29 });
    expect(self.issues).toContainEqual({ level: "fail", message: "Certificate not trusted (DEPTH_ZERO_SELF_SIGNED_CERT)" });
    // Status and headers are still checked.
    expect(self.httpStatus).toBe(200);
    expect(self.checks.find((c) => c.id === "x-content-type-options")!.level).toBe("pass");
  });

  it("warns when the certificate is about to expire", async () => {
    const r = await auditUrl(`${expiring.url}/`, { ca: [ca.cert], warnDays: 21 });
    expect(r.status).toBe("warn");
    expect(r.issues).toEqual([{ level: "warn", message: "Certificate expires in 4 days" }]);
  });

  it("follows redirects from HTTP to HTTPS and records each hop", async () => {
    const r = await auditUrl(`${plain.url}/to-https`, { ca: [ca.cert] });
    expect(r.redirects).toEqual([{ url: `${plain.url}/to-https`, status: 301, location: `${trusted.url}/`, timeMs: expect.any(Number) }]);
    expect(r).toMatchObject({ finalUrl: `${trusted.url}/`, httpStatus: 200, status: "pass", score: 100 });
    expect(r.tls?.trusted).toBe(true);
  });

  it("warns about long redirect chains and resolves relative locations", async () => {
    const r = await auditUrl(`${plain.url}/hop1`, { ca: [ca.cert] });
    expect(r.redirects.map((h) => h.status)).toEqual([302, 302, 302]);
    expect(r.issues).toContainEqual({ level: "warn", message: "3 redirects before the final page" });
  });

  it("fails plain HTTP pages without headers and HTTP errors", async () => {
    const r = await auditUrl(`${plain.url}/`);
    expect(r).toMatchObject({ status: "fail", score: 0, grade: "F", tls: null });
    expect(r.issues.map((i) => i.message)).toEqual(["HTTP is not redirected to HTTPS", "Security headers score 0/100"]);

    const missing = await auditUrl(`${plain.url}/missing`);
    expect(missing.httpStatus).toBe(404);
    expect(missing.issues[0]).toEqual({ level: "fail", message: "HTTP 404" });
  });

  it("reports network errors, redirect loops and timeouts", async () => {
    const closed = await startHttp(() => {});
    const url = `${closed.url}/`;
    await closed.close();
    expect(await auditUrl(url)).toMatchObject({ status: "fail", error: "ECONNREFUSED", score: 0 });
    expect((await auditUrl(`${plain.url}/loop`, { maxRedirects: 3 })).error).toBe("more than 3 redirects");
    expect((await auditUrl(`${hanging.url}/`, { timeoutMs: 200 })).error).toBe("timeout after 200 ms");
  });

  it("audits many URLs in parallel and keeps the input order", async () => {
    const urls = [`${plain.url}/`, `${trusted.url}/`, `${expiring.url}/`, `${plain.url}/missing`];
    const report = await auditAll(urls, { ca: [ca.cert], concurrency: 2 });
    expect(report.results.map((r) => r.url)).toEqual(urls);
    expect(report.summary).toEqual({ total: 4, pass: 1, warn: 1, fail: 2, averageScore: 50 });
  });

  it("sends a descriptive user agent", async () => {
    let seen = "";
    const ua = await startHttp((req: http.IncomingMessage, res: http.ServerResponse) => {
      seen = req.headers["user-agent"] ?? "";
      res.end();
    });
    await probe(`${ua.url}/`);
    await ua.close();
    expect(seen).toMatch(/^site-audit\/1\.0/);
  });
});

describe("normalizeUrl", () => {
  it("adds https:// and rejects other schemes", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
    expect(normalizeUrl(" http://example.com/a ")).toBe("http://example.com/a");
    expect(() => normalizeUrl("ftp://example.com")).toThrow(/only http/);
  });
});

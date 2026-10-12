import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { createCa } from "./certs.js";
import { routes, SECURE_HEADERS, startHttp, startHttps, type Running } from "./servers.js";

describe("cli", () => {
  const ca = createCa("Local Test CA");
  let dir: string, caFile: string, good: Running, bad: Running;
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "site-audit-"));
    caFile = join(dir, "ca.pem");
    await writeFile(caFile, ca.cert);
    good = await startHttps(ca.sign("localhost", 60), routes({ "/": () => [200, SECURE_HEADERS] }));
    bad = await startHttp(routes({ "/": () => [200, { "x-frame-options": "SAMEORIGIN" }] }));
  });

  afterAll(async () => {
    await Promise.all([good.close(), bad.close()]);
    await rm(dir, { recursive: true, force: true });
  });

  it("writes self-contained HTML and JSON reports", async () => {
    const outDir = join(dir, "report");
    const res = await run([`${good.url}/`, "--ca", caFile, "-o", outDir]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/PASS\s+200\s+\d+ms\s+59d\s+A 100\s+https:\/\/localhost/);

    const json = JSON.parse(await readFile(join(outDir, "report.json"), "utf8"));
    expect(json.summary).toMatchObject({ total: 1, pass: 1 });
    expect(json.results[0].tls).toMatchObject({ issuer: "Local Test CA", trusted: true });

    const html = await readFile(join(outDir, "report.html"), "utf8");
    expect(html).toContain("Site audit report");
    expect(html).toContain("59 days left");
    expect(html).not.toMatch(/<script|<link|src="http/); // nothing external
  });

  it("exits with 1 when a URL fails, and reads URLs from a file", async () => {
    const list = join(dir, "urls.txt");
    await writeFile(list, `# sites\n${good.url}/\n\n${bad.url}/   # legacy\n${good.url}/\n`);
    const res = await run(["--file", list, "--ca", caFile, "-o", join(dir, "r2"), "--json"]);
    expect(res.code).toBe(1);
    const report = JSON.parse(res.out);
    expect(report.results).toHaveLength(2); // duplicates removed
    expect(report.results[1]).toMatchObject({ status: "fail", score: 15, grade: "F" });
  });

  it("applies --fail-under to the security score", async () => {
    const outDir = join(dir, "r3");
    expect((await run([`${good.url}/`, "--ca", caFile, "-o", outDir, "--fail-under", "100"])).code).toBe(0);
    const leaky = await startHttps(ca.sign("localhost", 60), routes({ "/": () => [200, { ...SECURE_HEADERS, "referrer-policy": "unsafe-url" }] }));
    const res = await run([`${leaky.url}/`, "--ca", caFile, "-o", outDir, "--fail-under", "100"]);
    await leaky.close();
    expect(res.code).toBe(1);
  });

  it("prints help and rejects bad usage with exit code 2", async () => {
    expect((await run(["--help"])).out).toContain("Usage: site-audit");
    expect((await run([])).code).toBe(2);
    expect((await run(["--nope"])).code).toBe(2);
    expect((await run(["ftp://example.com"])).err).toContain("only http");
    expect((await run(["https://example.com", "--timeout", "abc"])).err).toContain("--timeout");
  });
});

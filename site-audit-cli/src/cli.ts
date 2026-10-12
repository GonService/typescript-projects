import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { auditAll, normalizeUrl } from "./audit.js";
import { renderHtml, renderTable } from "./report.js";

export const VERSION = "1.0.0";

export const HELP = `Usage: site-audit [options] <url...>

Checks each URL: HTTP status and redirects, response time, TLS certificate
(days left, issuer, trust) and security headers, then writes report.html
and report.json.

Options:
  -f, --file <path>        Read URLs from a file (one per line, # for comments)
  -o, --out <dir>          Output directory (default: site-audit-report)
      --timeout <ms>       Timeout per request (default: 10000)
      --max-redirects <n>  Redirects to follow (default: 5)
      --concurrency <n>    URLs checked in parallel (default: 4)
      --ca <path>          Extra trusted CA certificate (PEM); repeatable
      --warn-days <n>      Warn when a certificate expires sooner (default: 21)
      --fail-under <n>     Exit with code 1 if any security score is below n
      --json               Print the JSON report to stdout instead of the table
  -h, --help               Show this help
  -v, --version            Show the version

Exit codes: 0 all good or warnings only, 1 failures, 2 usage error.`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  now?: () => number;
}

const defaultIo: Io = { out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n") };

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

/** Runs the CLI and returns the exit code. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        file: { type: "string", short: "f" },
        out: { type: "string", short: "o", default: "site-audit-report" },
        timeout: { type: "string" },
        "max-redirects": { type: "string" },
        concurrency: { type: "string" },
        ca: { type: "string", multiple: true },
        "warn-days": { type: "string" },
        "fail-under": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: v, positionals } = opts;
  if (v.help) return io.out(HELP), 0;
  if (v.version) return io.out(VERSION), 0;

  let urls: string[];
  let settings;
  try {
    const raw = [...positionals];
    if (v.file) {
      const text = await readFile(v.file, "utf8");
      raw.push(...text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));
    }
    if (!raw.length) throw new Error("no URLs given");
    urls = [...new Set(raw.map(normalizeUrl))];
    settings = {
      timeoutMs: positiveInt("timeout", v.timeout, 10_000),
      maxRedirects: positiveInt("max-redirects", v["max-redirects"], 5),
      concurrency: Math.max(1, positiveInt("concurrency", v.concurrency, 4)),
      warnDays: positiveInt("warn-days", v["warn-days"], 21),
      failUnder: v["fail-under"] === undefined ? undefined : positiveInt("fail-under", v["fail-under"], 0),
      ca: await Promise.all((v.ca ?? []).map((p) => readFile(p, "utf8"))),
    };
  } catch (err) {
    io.err(`site-audit: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  const report = await auditAll(urls, { ...settings, now: io.now });
  const outDir = resolve(v.out!);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(outDir, "report.html"), renderHtml(report));

  if (v.json) io.out(JSON.stringify(report, null, 2));
  else io.out(`${renderTable(report)}\nReport: ${join(outDir, "report.html")}`);

  const belowThreshold = settings.failUnder !== undefined && report.results.some((r) => r.score < settings.failUnder!);
  return report.summary.fail > 0 || belowThreshold ? 1 : 0;
}

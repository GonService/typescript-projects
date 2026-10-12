import { checkSecurityHeaders, type HeaderCheck, type Level } from "./headers.js";
import { probe, type Hop, type ProbeOptions, type TlsInfo } from "./probe.js";

export interface Issue {
  level: Exclude<Level, "pass">;
  message: string;
}

export interface AuditResult {
  url: string;
  status: Level;
  error: string | null;
  httpStatus: number | null;
  finalUrl: string | null;
  redirects: Hop[];
  timeMs: number | null;
  totalMs: number | null;
  tls: TlsInfo | null;
  score: number;
  grade: string;
  checks: HeaderCheck[];
  issues: Issue[];
}

export interface AuditOptions extends ProbeOptions {
  /** Certificates expiring in fewer days than this produce a warning. */
  warnDays?: number;
  /** Responses slower than this (ms) produce a warning. */
  slowMs?: number;
}

export interface Report {
  generatedAt: string;
  summary: { total: number; pass: number; warn: number; fail: number; averageScore: number };
  results: AuditResult[];
}

/** Adds https:// when the scheme is missing and validates the URL. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`only http and https URLs: ${raw}`);
  return u.href;
}

export async function auditUrl(url: string, options: AuditOptions = {}): Promise<AuditResult> {
  const warnDays = options.warnDays ?? 21;
  const slowMs = options.slowMs ?? 1500;
  let res;
  try {
    res = await probe(url, options);
  } catch (err) {
    const message = err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err);
    return {
      url, status: "fail", error: message, httpStatus: null, finalUrl: null, redirects: [], timeMs: null, totalMs: null,
      tls: null, score: 0, grade: "F", checks: [], issues: [{ level: "fail", message: `Request failed: ${message}` }],
    };
  }

  const isHttps = res.finalUrl.startsWith("https:");
  const { checks, score, grade } = checkSecurityHeaders(res.headers, isHttps);
  const issues: Issue[] = [];

  if (res.status >= 400) issues.push({ level: "fail", message: `HTTP ${res.status}` });
  if (res.tls) {
    if (!res.tls.trusted) issues.push({ level: "fail", message: `Certificate not trusted (${res.tls.error})` });
    if (res.tls.daysLeft < 0) issues.push({ level: "fail", message: `Certificate expired ${-res.tls.daysLeft} days ago` });
    else if (res.tls.daysLeft < warnDays) issues.push({ level: "warn", message: `Certificate expires in ${res.tls.daysLeft} days` });
  }
  if (url.startsWith("http:") && !isHttps) issues.push({ level: "warn", message: "HTTP is not redirected to HTTPS" });
  if (res.hops.length > 2) issues.push({ level: "warn", message: `${res.hops.length - 1} redirects before the final page` });
  if (res.timeMs > slowMs) issues.push({ level: "warn", message: `Slow response: ${res.timeMs} ms` });
  if (score < 40) issues.push({ level: "fail", message: `Security headers score ${score}/100` });
  else if (score < 75) issues.push({ level: "warn", message: `Security headers score ${score}/100` });

  return {
    url,
    status: issues.some((i) => i.level === "fail") ? "fail" : issues.length ? "warn" : "pass",
    error: null,
    httpStatus: res.status,
    finalUrl: res.finalUrl,
    redirects: res.hops.slice(0, -1),
    timeMs: res.timeMs,
    totalMs: res.totalMs,
    tls: res.tls,
    score,
    grade,
    checks,
    issues,
  };
}

/** Audits every URL with limited concurrency; results keep the input order. */
export async function auditAll(urls: string[], options: AuditOptions & { concurrency?: number } = {}): Promise<Report> {
  const results: AuditResult[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      results[i] = await auditUrl(urls[i]!, options);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, urls.length)) }, worker));
  const count = (l: Level) => results.filter((r) => r.status === l).length;
  return {
    generatedAt: new Date((options.now ?? Date.now)()).toISOString(),
    summary: {
      total: results.length,
      pass: count("pass"),
      warn: count("warn"),
      fail: count("fail"),
      averageScore: results.length ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 0,
    },
    results,
  };
}

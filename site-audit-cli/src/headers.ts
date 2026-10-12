export type Level = "pass" | "warn" | "fail";

export interface HeaderCheck {
  id: "https" | "hsts" | "csp" | "x-content-type-options" | "x-frame-options" | "referrer-policy";
  label: string;
  level: Level;
  points: number;
  max: number;
  value: string | null;
  detail: string;
}

const SAFE_REFERRER = new Set([
  "no-referrer",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "no-referrer-when-downgrade",
  "origin",
  "origin-when-cross-origin",
]);

const HALF_YEAR = 15_552_000;

/** Scores the security headers of a response (0-100). `headers` keys must be lower case. */
export function checkSecurityHeaders(
  headers: Record<string, string>,
  isHttps: boolean,
): { checks: HeaderCheck[]; score: number; grade: string } {
  const checks: HeaderCheck[] = [];
  const add = (c: Omit<HeaderCheck, "points"> & { points?: number }) =>
    checks.push({ ...c, points: c.points ?? (c.level === "pass" ? c.max : c.level === "warn" ? Math.floor(c.max / 2) : 0) });

  add({
    id: "https",
    label: "HTTPS",
    max: 10,
    value: isHttps ? "yes" : "no",
    level: isHttps ? "pass" : "fail",
    detail: isHttps ? "Final page served over HTTPS" : "Final page served over plain HTTP",
  });

  const hsts = headers["strict-transport-security"] ?? null;
  const maxAge = Number(/max-age=(\d+)/i.exec(hsts ?? "")?.[1] ?? NaN);
  add({
    id: "hsts",
    label: "Strict-Transport-Security",
    max: 25,
    value: hsts,
    level: !isHttps || !hsts || !(maxAge > 0) ? "fail" : maxAge >= HALF_YEAR ? "pass" : "warn",
    detail: !isHttps
      ? "Not applicable over HTTP: the site is not using HTTPS"
      : !hsts
        ? "Missing: browsers may still try HTTP first"
        : !(maxAge > 0)
          ? "Invalid or zero max-age"
          : maxAge >= HALF_YEAR
            ? `max-age ${Math.round(maxAge / 86_400)} days`
            : `max-age ${Math.round(maxAge / 86_400)} days, recommended 180 or more`,
  });

  const csp = headers["content-security-policy"] ?? null;
  const unsafe = csp ? /'unsafe-inline'|'unsafe-eval'|(^|[\s;])\*([\s;]|$)/.test(csp) : false;
  add({
    id: "csp",
    label: "Content-Security-Policy",
    max: 25,
    value: csp,
    level: !csp ? "fail" : unsafe ? "warn" : "pass",
    detail: !csp ? "Missing: no protection against injected scripts" : unsafe ? "Present, but allows unsafe-inline, unsafe-eval or *" : "Present",
  });

  const xcto = headers["x-content-type-options"] ?? null;
  add({
    id: "x-content-type-options",
    label: "X-Content-Type-Options",
    max: 15,
    value: xcto,
    level: xcto?.trim().toLowerCase() === "nosniff" ? "pass" : "fail",
    detail: xcto?.trim().toLowerCase() === "nosniff" ? "nosniff" : xcto ? "Should be nosniff" : "Missing",
  });

  const xfo = headers["x-frame-options"] ?? null;
  const frameAncestors = csp ? /frame-ancestors\s/i.test(csp) : false;
  const xfoOk = /^(deny|sameorigin)$/i.test(xfo?.trim() ?? "");
  add({
    id: "x-frame-options",
    label: "X-Frame-Options",
    max: 15,
    value: xfo,
    level: xfoOk || frameAncestors ? "pass" : xfo ? "warn" : "fail",
    detail: xfoOk ? xfo!.toUpperCase() : frameAncestors ? "Covered by CSP frame-ancestors" : xfo ? "Should be DENY or SAMEORIGIN" : "Missing: page can be framed (clickjacking)",
  });

  const rp = headers["referrer-policy"] ?? null;
  const last = rp?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).at(-1) ?? "";
  add({
    id: "referrer-policy",
    label: "Referrer-Policy",
    max: 10,
    value: rp,
    level: !rp ? "fail" : SAFE_REFERRER.has(last) ? "pass" : "warn",
    detail: !rp ? "Missing: browser default applies" : SAFE_REFERRER.has(last) ? last : `"${last}" leaks full URLs to other sites`,
  });

  const score = checks.reduce((s, c) => s + c.points, 0);
  return { checks, score, grade: grade(score) };
}

export function grade(score: number): string {
  return score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
}

import type { AuditResult, Report } from "./audit.js";
import type { Level } from "./headers.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const LABEL: Record<Level, string> = { pass: "Pass", warn: "Warning", fail: "Fail" };
const chip = (level: Level, text = LABEL[level]) => `<span class="chip ${level}">${escapeHtml(text)}</span>`;

function tlsCell(r: AuditResult): string {
  if (!r.tls) return r.finalUrl?.startsWith("http:") ? `<span class="muted">No TLS (plain HTTP)</span>` : `<span class="muted">-</span>`;
  const t = r.tls;
  const level: Level = !t.trusted || t.daysLeft < 0 ? "fail" : r.issues.some((i) => i.message.startsWith("Certificate expires")) ? "warn" : "pass";
  return `<strong class="${level}-text">${t.daysLeft} days left</strong><br><span class="muted">${escapeHtml(t.issuer || "unknown issuer")} · ${escapeHtml(t.protocol ?? "")}${t.trusted ? "" : ` · untrusted: ${escapeHtml(t.error ?? "")}`}</span>`;
}

function redirectsCell(r: AuditResult): string {
  if (!r.redirects.length) return `<span class="muted">None</span>`;
  return `<div class="hops">` + r.redirects
    .map((h) => `<span class="hop"><code>${h.status}</code> ${escapeHtml(h.url)}</span>`)
    .join("") + `<span class="hop final"><code>${r.httpStatus}</code> ${escapeHtml(r.finalUrl ?? "")}</span></div>`;
}

function card(r: AuditResult): string {
  const statusLevel: Level = r.httpStatus === null || r.httpStatus >= 400 ? "fail" : r.httpStatus >= 300 ? "warn" : "pass";
  const meta = r.error
    ? `<p class="error-msg">${escapeHtml(r.issues[0]?.message ?? r.error)}</p>`
    : `<div class="meta">
  <div><span>HTTP status</span><strong class="${statusLevel}-text">${r.httpStatus}</strong></div>
  <div><span>Response time</span><strong>${r.timeMs} ms</strong>${r.redirects.length ? `<br><span class="muted">${r.totalMs} ms with redirects</span>` : ""}</div>
  <div><span>Certificate</span>${tlsCell(r)}</div>
  <div class="wide"><span>Redirects</span>${redirectsCell(r)}</div>
</div>
<table><colgroup><col style="width:28%"><col style="width:12%"><col><col style="width:10%"></colgroup><thead><tr><th>Header</th><th>Result</th><th>Details</th><th class="pts">Points</th></tr></thead><tbody>
${r.checks.map((c) => `<tr><td>${escapeHtml(c.label)}</td><td>${chip(c.level, c.level === "pass" ? "Pass" : c.level === "warn" ? "Weak" : c.id === "https" ? "No" : c.value ? "Invalid" : "Missing")}</td><td>${escapeHtml(c.detail)}</td><td class="pts">${c.points}/${c.max}</td></tr>`).join("\n")}
</tbody></table>`;
  const issues = r.issues.length
    ? `<ul class="issues">${r.issues.map((i) => `<li class="${i.level}">${escapeHtml(i.message)}</li>`).join("")}</ul>`
    : "";
  return `<article class="card">
<header><div class="title">${chip(r.status)}<h2>${escapeHtml(r.url)}</h2></div>
<div class="grade g-${r.grade}" title="Security headers score"><b>${r.grade}</b><span>${r.score}/100</span></div></header>
${meta}${r.error ? "" : issues}
</article>`;
}

const STYLE = `
:root{--bg:#f5f6f8;--card:#fff;--text:#1c2331;--muted:#677084;--line:#e3e6ec;--pass:#13795b;--pass-bg:#e3f4ec;--warn:#9a5b00;--warn-bg:#fdf1dc;--fail:#b42318;--fail-bg:#fde8e6;--accent:#2f5bea}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 20px 48px}
.top{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:8px;margin-bottom:18px}
h1{margin:0;font-size:24px}.muted{color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:20px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.kpi span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}.kpi strong{font-size:26px;font-variant-numeric:tabular-nums}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:16px}
.card>header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:14px}
.title{display:flex;align-items:center;gap:10px;min-width:0}h2{font-size:16px;margin:0;word-break:break-all}
.chip{display:inline-block;font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px;white-space:nowrap}
.chip.pass{background:var(--pass-bg);color:var(--pass)}.chip.warn{background:var(--warn-bg);color:var(--warn)}.chip.fail{background:var(--fail-bg);color:var(--fail)}
.pass-text{color:var(--pass)}.warn-text{color:var(--warn)}.fail-text{color:var(--fail)}
.grade{display:flex;flex-direction:column;align-items:center;justify-content:center;width:64px;height:64px;border-radius:12px;flex:none;border:2px solid}
.grade b{font-size:24px;line-height:1}.grade span{font-size:11px}
.g-A,.g-B{color:var(--pass);border-color:#9fd8c2;background:var(--pass-bg)}.g-C,.g-D{color:var(--warn);border-color:#f1cf94;background:var(--warn-bg)}.g-F{color:var(--fail);border-color:#f3b4ad;background:var(--fail-bg)}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px 20px;margin-bottom:14px}
.meta>div>span:first-child{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.meta strong{font-size:16px}.meta .wide{grid-column:1/-1}
.hop{display:block;word-break:break-all}.hop::before{content:"\\2192  ";color:var(--muted)}.hops .hop:first-child::before{content:""}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef0f4;border-radius:4px;padding:1px 5px}
table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{text-align:left;padding:7px 8px;border-top:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;border-top:0}
td:first-child{font-weight:500}.pts{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.issues{margin:12px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px}
.issues li{font-size:13px;padding:3px 10px;border-radius:6px}.issues .warn{background:var(--warn-bg);color:var(--warn)}.issues .fail{background:var(--fail-bg);color:var(--fail)}
.error-msg{color:var(--fail);margin:0}
footer{color:var(--muted);font-size:12px;margin-top:24px}
@media (max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}.meta{grid-template-columns:1fr}td:first-child{white-space:normal}}
`;

/** Self-contained HTML report: inline CSS, no scripts, no external requests. */
export function renderHtml(report: Report): string {
  const s = report.summary;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site audit report</title><style>${STYLE}</style></head><body><main>
<div class="top"><h1>Site audit report</h1><span class="muted">Generated ${escapeHtml(report.generatedAt.replace("T", " ").slice(0, 16))} UTC</span></div>
<div class="kpis">
<div class="kpi"><span>URLs</span><strong>${s.total}</strong></div>
<div class="kpi"><span>Pass</span><strong class="pass-text">${s.pass}</strong></div>
<div class="kpi"><span>Warnings</span><strong class="warn-text">${s.warn}</strong></div>
<div class="kpi"><span>Failed</span><strong class="fail-text">${s.fail}</strong></div>
<div class="kpi"><span>Average score</span><strong>${s.averageScore}</strong></div>
</div>
${report.results.map(card).join("\n")}
<footer>Score: HTTPS 10, Strict-Transport-Security 25, Content-Security-Policy 25, X-Content-Type-Options 15, X-Frame-Options 15, Referrer-Policy 10. Generated by site-audit.</footer>
</main></body></html>
`;
}

/** Plain-text table for the terminal. */
export function renderTable(report: Report): string {
  const rows = report.results.map((r) => [
    r.status.toUpperCase(),
    r.httpStatus === null ? "-" : String(r.httpStatus),
    r.timeMs === null ? "-" : `${r.timeMs}ms`,
    r.tls ? `${r.tls.daysLeft}d${r.tls.trusted ? "" : "!"}` : "-",
    `${r.grade} ${r.score}`,
    r.url,
  ]);
  const head = ["RESULT", "HTTP", "TIME", "TLS", "SCORE", "URL"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  const s = report.summary;
  return [line(head), ...rows.map(line), "", `${s.total} URLs: ${s.pass} pass, ${s.warn} warning, ${s.fail} failed · average score ${s.averageScore}`].join("\n");
}

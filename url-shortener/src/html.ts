import type { Link, Stats } from "./store.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Smallest "nice" number (1, 2, 5 x 10^n) that is >= value. */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 5, 10]) if (m * exp >= value) return m * exp;
  return 10 * exp;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** Bar chart of clicks per day, drawn as plain SVG. */
export function clicksChart(days: Stats["days"]): string {
  const W = 760, H = 260, left = 40, right = 8, top = 12, bottom = 30;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = niceMax(Math.max(0, ...days.map((d) => d.clicks)));
  const step = plotW / Math.max(days.length, 1);
  const barW = Math.max(2, step * 0.68);
  const y = (v: number) => top + plotH - (v / max) * plotH;

  // 4 or 5 intervals, whichever gives whole-number ticks (50 -> 0,10,..,50; 20 -> 0,5,..,20).
  const intervals = max % 4 === 0 ? 4 : 5;
  const grid = Array.from({ length: intervals + 1 }, (_, i) => (max / intervals) * i)
    .map((v) => {
      const yy = y(v).toFixed(1);
      return `<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" class="grid"/>` +
        `<text x="${left - 8}" y="${yy}" class="ylabel" dy="0.32em">${v}</text>`;
    })
    .join("");

  const labelEvery = Math.ceil(days.length / 8);
  const bars = days
    .map((d, i) => {
      const x = left + i * step + (step - barW) / 2;
      const h = (d.clicks / max) * plotH;
      const bar = d.clicks > 0
        ? `<rect x="${x.toFixed(1)}" y="${y(d.clicks).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="bar"><title>${shortDate(d.date)}: ${d.clicks} click${d.clicks === 1 ? "" : "s"}</title></rect>`
        : "";
      const showLabel = (days.length - 1 - i) % labelEvery === 0;
      const label = showLabel
        ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 10}" class="xlabel">${shortDate(d.date)}</text>`
        : "";
      return bar + label;
    })
    .join("");

  const total = days.reduce((s, d) => s + d.clicks, 0);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${total} clicks in the last ${days.length} days">${grid}${bars}<line x1="${left}" x2="${W - right}" y1="${top + plotH}" y2="${top + plotH}" class="axis"/></svg>`;
}

function breakdown(title: string, rows: { label: string; clicks: number }[], total: number): string {
  const body = rows.length
    ? rows
        .map((r) => {
          const pct = total ? (r.clicks / total) * 100 : 0;
          return `<li><div class="row"><span>${escapeHtml(r.label)}</span><span class="num">${r.clicks}<small>${pct.toFixed(0)}%</small></span></div><div class="meter"><div style="width:${pct.toFixed(1)}%"></div></div></li>`;
        })
        .join("")
    : `<li class="empty">No clicks yet</li>`;
  return `<section class="card"><h2>${title}</h2><ul class="list">${body}</ul></section>`;
}

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2433;--muted:#667085;--line:#e4e7ec;--accent:#2f5bea;--accent-soft:#dbe4fd}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 48px}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:20px}
h1{font-size:22px;margin:0}h1 code{font:inherit;color:var(--accent)}
header>div{min-width:0;flex:1 1 400px}.target{color:var(--muted);margin:4px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.target a{color:inherit}
.badge{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;color:var(--muted);background:var(--card)}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
.kpi,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.kpi span{display:block;color:var(--muted);font-size:13px}.kpi strong{font-size:26px;font-variant-numeric:tabular-nums}
h2{font-size:14px;margin:0 0 12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.chart{width:100%;height:auto;display:block}
.chart .grid{stroke:var(--line)}.chart .axis{stroke:#c9ced8}.chart .bar{fill:var(--accent)}.chart .bar:hover{fill:#1d3fb8}
.chart text{fill:var(--muted);font-size:11px}.chart .ylabel{text-anchor:end}.chart .xlabel{text-anchor:middle}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.list{list-style:none;margin:0;padding:0}.list li{margin-bottom:10px}
.row{display:flex;justify-content:space-between;font-size:14px}.num{font-variant-numeric:tabular-nums}.num small{color:var(--muted);margin-left:8px}
.meter{height:6px;background:var(--accent-soft);border-radius:3px;margin-top:4px}.meter div{height:100%;background:var(--accent);border-radius:3px}
.empty{color:var(--muted)}
footer{margin-top:20px;color:var(--muted);font-size:13px}footer a{color:inherit}
form{display:flex;gap:8px;flex-wrap:wrap}input{flex:1 1 220px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit}
button{padding:10px 18px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
#result{margin-top:14px;word-break:break-all}.kpi .target{display:inline}
@media (max-width:640px){.kpis,.cols{grid-template-columns:1fr}}
`;

const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

export function statsPage(link: Link & { expired: boolean }, stats: Stats, shortUrl: string): string {
  const periodTotal = stats.days.reduce((s, d) => s + d.clicks, 0);
  const best = stats.days.reduce((a, d) => (d.clicks > a.clicks ? d : a), { date: "", clicks: 0 });
  const status = link.expired
    ? "Expired"
    : link.expiresAt
      ? `Expires ${link.expiresAt.slice(0, 10)}`
      : "No expiry";
  return layout(
    `Stats for /${link.slug}`,
    `<header><div><h1>Stats for <code>${escapeHtml(shortUrl.replace(/^https?:\/\//, ""))}</code></h1>
<p class="target">Redirects to <a href="${escapeHtml(link.url)}" rel="noopener noreferrer">${escapeHtml(link.url)}</a></p></div>
<span class="badge">${status} · created ${link.createdAt.slice(0, 10)}</span></header>
<div class="kpis"><div class="kpi"><span>Total clicks</span><strong>${stats.total}</strong></div>
<div class="kpi"><span>Last ${stats.days.length} days</span><strong>${periodTotal}</strong></div>
<div class="kpi"><span>Busiest day</span><strong>${best.clicks ? `${best.clicks}` : "-"}</strong>${best.clicks ? ` <small class="target">${shortDate(best.date)}</small>` : ""}</div></div>
<section class="card"><h2>Clicks per day (UTC)</h2>${clicksChart(stats.days)}</section>
<div class="cols">${breakdown("Referrers", stats.referrers.map((r) => ({ label: r.host, clicks: r.clicks })), periodTotal)}
${breakdown("Browsers", stats.browsers.map((b) => ({ label: b.family, clicks: b.clicks })), periodTotal)}</div>
<footer>JSON: <a href="/api/links/${encodeURIComponent(link.slug)}/stats">/api/links/${escapeHtml(link.slug)}/stats</a></footer>`,
  );
}

export function homePage(requiresToken: boolean): string {
  return layout(
    "url-shortener",
    `<header><div><h1>url-shortener</h1><p class="target">Short links with expiry and click statistics.</p></div></header>
<section class="card"><form id="f">
<input name="url" type="url" required placeholder="https://example.com/a/very/long/path" aria-label="URL">
<input name="alias" placeholder="custom alias (optional)" aria-label="Alias" style="flex:0 1 200px">
${requiresToken ? `<input name="token" type="password" placeholder="API token" aria-label="API token" style="flex:0 1 160px">` : ""}
<button>Shorten</button></form><div id="result"></div></section>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target), out = document.getElementById("result");
  const body = { url: f.get("url") };
  if (f.get("alias")) body.alias = f.get("alias");
  const headers = { "content-type": "application/json" };
  if (f.get("token")) headers.authorization = "Bearer " + f.get("token");
  const res = await fetch("/api/links", { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json();
  out.textContent = "";
  if (!res.ok) { out.textContent = data.message || data.error; return; }
  const a = document.createElement("a"); a.href = data.shortUrl; a.textContent = data.shortUrl;
  const s = document.createElement("a"); s.href = "/stats/" + data.slug; s.textContent = "stats";
  out.append(a, " · ", s);
});
</script>`,
  );
}

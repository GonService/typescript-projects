import http from "node:http";
import https from "node:https";
import tls, { type PeerCertificate, type TLSSocket } from "node:tls";
import { performance } from "node:perf_hooks";

export interface TlsInfo {
  /** Chain and host name verified against the trusted CAs. */
  trusted: boolean;
  error: string | null;
  issuer: string;
  subject: string;
  validFrom: string;
  validTo: string;
  daysLeft: number;
  protocol: string | null;
}

export interface Hop {
  url: string;
  status: number;
  location: string | null;
  timeMs: number;
}

export interface ProbeResult {
  hops: Hop[];
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  /** Time to response headers of the final request. */
  timeMs: number;
  /** Total time including redirects. */
  totalMs: number;
  /** Certificate of the final URL when it is https. */
  tls: TlsInfo | null;
}

export interface ProbeOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  /** Extra trusted CA certificates (PEM), added to Node's bundled roots. */
  ca?: string[];
  userAgent?: string;
  now?: () => number;
}

interface Single {
  status: number;
  headers: Record<string, string>;
  timeMs: number;
  tls: TlsInfo | null;
}

function tlsInfo(socket: TLSSocket, now: number): TlsInfo {
  const cert: PeerCertificate = socket.getPeerCertificate();
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const name = (o: PeerCertificate["issuer"] | undefined) => (o ? first(o.O) || first(o.CN) : "");
  const validTo = new Date(cert.valid_to);
  return {
    trusted: socket.authorized,
    error: socket.authorized ? null : String(socket.authorizationError ?? "unknown"),
    issuer: name(cert.issuer),
    subject: first(cert.subject?.CN),
    validFrom: new Date(cert.valid_from).toISOString(),
    validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo.getTime() - now) / 86_400_000),
    protocol: socket.getProtocol(),
  };
}

function request(url: URL, opts: Required<Omit<ProbeOptions, "ca">> & { ca?: string[] }): Promise<Single> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const isHttps = url.protocol === "https:";
    const options: https.RequestOptions = {
      method: "GET",
      agent: false, // fresh connection every time, so the TLS handshake (and its certificate) is always seen
      headers: { "user-agent": opts.userAgent, accept: "text/html,*/*" },
      timeout: opts.timeoutMs,
    };
    if (isHttps) {
      // Untrusted certificates are reported, not fatal: the audit still checks status and headers.
      options.rejectUnauthorized = false;
      if (opts.ca?.length) options.ca = [...tls.rootCertificates, ...opts.ca];
    }
    const req = (isHttps ? https : http).request(url, options, (res) => {
      const timeMs = performance.now() - started;
      const info = isHttps ? tlsInfo(res.socket as TLSSocket, opts.now()) : null;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      res.resume(); // the body is not needed
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers, timeMs, tls: info }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

/** Requests `input`, following redirects manually so every hop is recorded. */
export async function probe(input: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const opts = {
    timeoutMs: options.timeoutMs ?? 10_000,
    maxRedirects: options.maxRedirects ?? 5,
    userAgent: options.userAgent ?? "site-audit/1.0 (+https://gonserviceit.com.br)",
    now: options.now ?? Date.now,
    ca: options.ca,
  };
  const hops: Hop[] = [];
  let url = new URL(input);
  const started = performance.now();

  for (;;) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported protocol ${url.protocol}`);
    const res = await request(url, opts);
    const location = res.status >= 300 && res.status < 400 ? (res.headers.location ?? null) : null;
    hops.push({ url: url.href, status: res.status, location, timeMs: Math.round(res.timeMs) });
    if (!location) {
      return {
        hops,
        finalUrl: url.href,
        status: res.status,
        headers: res.headers,
        timeMs: Math.round(res.timeMs),
        totalMs: Math.round(performance.now() - started),
        tls: res.tls,
      };
    }
    if (hops.length > opts.maxRedirects) throw new Error(`more than ${opts.maxRedirects} redirects`);
    url = new URL(location, url);
  }
}

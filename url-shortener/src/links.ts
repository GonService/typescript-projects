import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/l/I
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

/** Paths used by the service itself; an alias can never take them. */
export const RESERVED = new Set(["api", "stats", "healthz", "docs", "favicon.ico", "robots.txt", "static", "admin"]);

export function randomSlug(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function validateAlias(alias: string): string | null {
  if (!ALIAS_RE.test(alias)) return "alias must be 3-40 characters: letters, digits, '-' or '_', starting with a letter or digit";
  if (RESERVED.has(alias.toLowerCase())) return `alias "${alias}" is reserved`;
  return null;
}

/** Returns a normalized URL or an error message. Only public http(s) URLs without credentials are accepted. */
export function validateTargetUrl(raw: string, ownOrigin?: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "url is not a valid absolute URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "only http and https URLs can be shortened" };
  if (!u.hostname.includes(".") && u.hostname !== "localhost") return { error: "url must have a fully qualified host name" };
  if (u.username || u.password) return { error: "url must not contain credentials" };
  if (ownOrigin && u.origin === new URL(ownOrigin).origin) return { error: "url points to this shortener" };
  return { url: u.href };
}

/** Short user-agent family for statistics. Order matters: Edge and Opera also say "Chrome". */
export function uaFamily(ua: string | undefined): string {
  if (!ua) return "Unknown";
  if (/bot|crawler|spider|slurp|preview|facebookexternalhit/i.test(ua)) return "Bot";
  if (/curl\//i.test(ua)) return "curl";
  if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
  return "Other";
}

/** Host of the Referer header, without "www.", or null for direct visits. */
export function referrerHost(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

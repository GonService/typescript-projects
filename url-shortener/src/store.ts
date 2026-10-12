import Database from "better-sqlite3";

export interface Link {
  slug: string;
  url: string;
  createdAt: string;
  expiresAt: string | null;
  clicks: number;
}

interface LinkRow {
  id: number;
  slug: string;
  url: string;
  created_at: number;
  expires_at: number | null;
  clicks: number;
}

export interface Click {
  at: number;
  referrerHost: string | null;
  uaFamily: string;
}

export interface Stats {
  total: number;
  days: { date: string; clicks: number }[];
  referrers: { host: string; clicks: number }[];
  browsers: { family: string; clicks: number }[];
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const toLink = (r: LinkRow): Link => ({
  slug: r.slug,
  url: r.url,
  createdAt: new Date(r.created_at).toISOString(),
  expiresAt: iso(r.expires_at),
  clicks: r.clicks,
});

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        id         INTEGER PRIMARY KEY,
        slug       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        url        TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        clicks     INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS clicks (
        id            INTEGER PRIMARY KEY,
        link_id       INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        at            INTEGER NOT NULL,
        day           TEXT NOT NULL,
        referrer_host TEXT,
        ua_family     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clicks_link_day ON clicks(link_id, day);
    `);
  }

  /** Inserts a link; returns null when the slug already exists. */
  create(input: { slug: string; url: string; expiresAt: number | null }): Link | null {
    const now = Date.now();
    const res = this.db
      .prepare("INSERT INTO links (slug, url, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING")
      .run(input.slug, input.url, now, input.expiresAt);
    if (res.changes !== 1) return null;
    return { slug: input.slug, url: input.url, createdAt: new Date(now).toISOString(), expiresAt: iso(input.expiresAt), clicks: 0 };
  }

  get(slug: string): (Link & { expired: boolean }) | undefined {
    const r = this.db.prepare("SELECT * FROM links WHERE slug = ?").get(slug) as LinkRow | undefined;
    if (!r) return undefined;
    return { ...toLink(r), expired: r.expires_at !== null && r.expires_at <= Date.now() };
  }

  delete(slug: string): boolean {
    return this.db.prepare("DELETE FROM links WHERE slug = ?").run(slug).changes === 1;
  }

  recordClick(slug: string, click: Click): void {
    const day = new Date(click.at).toISOString().slice(0, 10);
    this.db.transaction(() => {
      const r = this.db.prepare("UPDATE links SET clicks = clicks + 1 WHERE slug = ? RETURNING id").get(slug) as
        | { id: number }
        | undefined;
      if (!r) return;
      this.db
        .prepare("INSERT INTO clicks (link_id, at, day, referrer_host, ua_family) VALUES (?, ?, ?, ?, ?)")
        .run(r.id, click.at, day, click.referrerHost, click.uaFamily);
    })();
  }

  /** Click statistics for the last `days` days (UTC), with zero-filled days. */
  stats(slug: string, days: number, now = Date.now()): Stats | undefined {
    const link = this.db.prepare("SELECT id, clicks FROM links WHERE slug = ?").get(slug) as
      | { id: number; clicks: number }
      | undefined;
    if (!link) return undefined;
    const end = new Date(now);
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      dates.push(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - i)).toISOString().slice(0, 10));
    }
    const from = dates[0]!;
    const perDay = new Map(
      (
        this.db
          .prepare("SELECT day, COUNT(*) AS n FROM clicks WHERE link_id = ? AND day >= ? GROUP BY day")
          .all(link.id, from) as { day: string; n: number }[]
      ).map((r) => [r.day, r.n]),
    );
    const referrers = this.db
      .prepare(
        `SELECT COALESCE(referrer_host, '(direct)') AS host, COUNT(*) AS clicks FROM clicks
         WHERE link_id = ? AND day >= ? GROUP BY host ORDER BY clicks DESC, host LIMIT 10`,
      )
      .all(link.id, from) as { host: string; clicks: number }[];
    const browsers = this.db
      .prepare(
        `SELECT ua_family AS family, COUNT(*) AS clicks FROM clicks
         WHERE link_id = ? AND day >= ? GROUP BY family ORDER BY clicks DESC, family LIMIT 10`,
      )
      .all(link.id, from) as { family: string; clicks: number }[];
    return {
      total: link.clicks,
      days: dates.map((date) => ({ date, clicks: perDay.get(date) ?? 0 })),
      referrers,
      browsers,
    };
  }

  close(): void {
    this.db.close();
  }
}

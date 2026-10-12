import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type Role = "user" | "admin";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  created_at: string;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: number;
  revoked_at: number | null;
  replaced_by: string | null;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at });

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name          TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('user', 'admin')),
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        family_id   TEXT NOT NULL,
        token_hash  TEXT NOT NULL UNIQUE,
        expires_at  INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        revoked_at  INTEGER,
        replaced_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
    `);
  }

  createUser(input: { email: string; name: string; role: Role; passwordHash: string }): User | null {
    const row: UserRow = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      name: input.name,
      role: input.role,
      password_hash: input.passwordHash,
      created_at: new Date().toISOString(),
    };
    const res = this.db
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, created_at)
         VALUES (@id, @email, @name, @role, @password_hash, @created_at) ON CONFLICT(email) DO NOTHING`,
      )
      .run(row);
    return res.changes === 1 ? toUser(row) : null;
  }

  findUserByEmail(email: string): (User & { passwordHash: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as UserRow | undefined;
    return r ? { ...toUser(r), passwordHash: r.password_hash } : undefined;
  }

  findUserById(id: string): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return r ? toUser(r) : undefined;
  }

  listUsers(limit = 100): User[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at LIMIT ?").all(limit) as UserRow[];
    return rows.map(toUser);
  }

  insertRefreshToken(input: { userId: string; familyId: string; tokenHash: string; expiresAt: number }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.userId, input.familyId, input.tokenHash, input.expiresAt, Date.now());
    return id;
  }

  findRefreshToken(tokenHash: string): RefreshTokenRow | undefined {
    return this.db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(tokenHash) as
      | RefreshTokenRow
      | undefined;
  }

  /** Atomically revokes `id` (only if still active) and links it to its replacement. */
  markRotated(id: string, replacedBy: string): boolean {
    const res = this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ? AND revoked_at IS NULL")
      .run(Date.now(), replacedBy, id);
    return res.changes === 1;
  }

  revokeFamily(familyId: string): number {
    return this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
      .run(Date.now(), familyId).changes;
  }

  revokeAllForUser(userId: string): number {
    return this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(Date.now(), userId).changes;
  }

  activeSessions(userId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?")
      .get(userId, Date.now()) as { n: number };
    return r.n;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

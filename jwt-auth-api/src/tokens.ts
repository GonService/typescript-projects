import { createHash, randomBytes } from "node:crypto";

/** Opaque refresh token: 256 random bits, URL-safe. Only its hash is stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

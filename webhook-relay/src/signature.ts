import { createHmac, timingSafeEqual } from "node:crypto";

/** Signature in the "sha256=<hex>" format used by GitHub, many payment providers and this relay. */
export function sign(secret: string, body: Buffer | string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time comparison of the received signature with the expected one. */
export function verify(secret: string, body: Buffer, received: string | undefined): boolean {
  if (!received) return false;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(received.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

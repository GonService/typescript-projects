import { describe, expect, it } from "vitest";
import { sign, verify } from "../src/signature.js";

describe("signature", () => {
  const body = Buffer.from('{"order":42}');

  it("accepts the correct signature", () => {
    expect(verify("s3cret", body, sign("s3cret", body))).toBe(true);
  });

  it("rejects a wrong secret, a tampered body and a missing header", () => {
    expect(verify("s3cret", body, sign("other", body))).toBe(false);
    expect(verify("s3cret", Buffer.from('{"order":43}'), sign("s3cret", body))).toBe(false);
    expect(verify("s3cret", body, undefined)).toBe(false);
    expect(verify("s3cret", body, "sha256=short")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { loadConfig, parseSources } from "../src/config.js";

describe("config", () => {
  it("parses sources from JSON", () => {
    const s = parseSources('{"stripe":{"secret":"x","target":"https://erp.example.com/hooks","signatureHeader":"Stripe-Signature"}}');
    expect(s.stripe).toEqual({ secret: "x", target: "https://erp.example.com/hooks", signatureHeader: "stripe-signature" });
  });

  it("rejects incomplete or invalid sources", () => {
    expect(() => parseSources('{"a":{"secret":"x"}}')).toThrow(/needs/);
    expect(() => parseSources('{"a":{"secret":"x","target":"not a url"}}')).toThrow();
    expect(() => parseSources('{"Bad Name":{"secret":"x","target":"https://a.b"}}')).toThrow(/Invalid source/);
  });

  it("requires a strong admin token", () => {
    expect(() => loadConfig({ ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
    expect(loadConfig({ ADMIN_TOKEN: "a".repeat(16), PORT: "3000" }).port).toBe(3000);
  });
});

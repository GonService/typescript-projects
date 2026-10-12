import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("requires a long JWT secret", () => {
    expect(() => loadConfig({ JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  it("applies defaults and parses admin e-mails", () => {
    const c = loadConfig({ JWT_SECRET: "x".repeat(32), ADMIN_EMAILS: " Boss@Example.com, ,ops@example.com" });
    expect(c).toMatchObject({ port: 8080, accessTtlSeconds: 900, refreshTtlDays: 30, bcryptRounds: 12 });
    expect(c.adminEmails).toEqual(["boss@example.com", "ops@example.com"]);
  });
});

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({})).toMatchObject({ port: 8080, baseUrl: "http://localhost:8080", apiToken: undefined, slugLength: 7 });
  });

  it("trims the base URL and validates the token", () => {
    expect(loadConfig({ BASE_URL: "https://go.example.com/" }).baseUrl).toBe("https://go.example.com");
    expect(() => loadConfig({ BASE_URL: "ftp://x" })).toThrow(/BASE_URL/);
    expect(() => loadConfig({ API_TOKEN: "short" })).toThrow(/API_TOKEN/);
  });
});

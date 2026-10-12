import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({})).toMatchObject({ port: 8080, historySize: 50, burst: 5, refillPerSecond: 1, maxViolations: 10 });
  });

  it("parses overrides and caps the history size", () => {
    expect(loadConfig({ FLOOD_REFILL_PER_SECOND: "0.5", HISTORY_SIZE: "9999", PORT: "abc" })).toMatchObject({
      refillPerSecond: 0.5,
      historySize: 500,
      port: 8080,
    });
  });
});

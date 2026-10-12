import WebSocket from "ws";
import type { Config } from "../src/config.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    historySize: 50,
    burst: 5,
    refillPerSecond: 1,
    maxViolations: 10,
    maxMessageLength: 1000,
    heartbeatMs: 30_000,
    ...overrides,
  };
}

export type Event = Record<string, any>;

/** Real WebSocket client that records every event and can wait for a specific one. */
export class TestClient {
  readonly events: Event[] = [];
  private waiters: { match: (e: Event) => boolean; resolve: (e: Event) => void }[] = [];
  closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const event = JSON.parse(data.toString()) as Event;
      this.events.push(event);
      this.waiters = this.waiters.filter((w) => (w.match(event) ? (w.resolve(event), false) : true));
    });
    this.closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static async open(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new TestClient(ws);
  }

  send(obj: unknown): void {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  /** Resolves with the first already received or future event matching `match`. */
  next(match: (e: Event) => boolean, timeoutMs = 2000): Promise<Event> {
    const seen = this.events.find(match);
    if (seen) {
      this.events.splice(this.events.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for event")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (e) => {
          clearTimeout(timer);
          this.events.splice(this.events.indexOf(e), 1);
          resolve(e);
        },
      });
    });
  }

  async join(room: string, nick: string): Promise<Event> {
    this.send({ type: "join", room, nick });
    return this.next((e) => e.type === "joined" || e.type === "error");
  }

  close(): void {
    this.ws.close();
  }
}

export const type = (t: string, extra: (e: Event) => boolean = () => true) => (e: Event) => e.type === t && extra(e);

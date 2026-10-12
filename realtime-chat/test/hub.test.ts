import { describe, expect, it } from "vitest";
import { ChatHub, type Connection } from "../src/chat.js";
import { TokenBucket } from "../src/rate.js";
import { testConfig } from "./helpers.js";

class FakeConn implements Connection {
  sent: Record<string, unknown>[] = [];
  closedWith?: [number, string];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number, reason: string) {
    this.closedWith = [code, reason];
  }
}

describe("TokenBucket", () => {
  it("allows a burst and then refills over time", () => {
    let now = 0;
    const b = new TokenBucket(3, 1, () => now);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    now = 999;
    expect(b.take()).toBe(false);
    now = 2000;
    expect(b.take()).toBe(true);
    now = 60_000; // never above the burst size
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
  });
});

describe("ChatHub", () => {
  it("keeps history after everyone leaves and drops empty rooms without history", () => {
    const hub = new ChatHub(testConfig());
    const a = new FakeConn();
    hub.connect(a);
    hub.receive(a, JSON.stringify({ type: "join", room: "quiet", nick: "ana" }));
    hub.receive(a, JSON.stringify({ type: "join", room: "busy", nick: "ana" }));
    hub.receive(a, JSON.stringify({ type: "message", text: "hello" }));
    hub.disconnect(a);
    expect(hub.listRooms()).toEqual([]);

    const b = new FakeConn();
    hub.connect(b);
    hub.receive(b, JSON.stringify({ type: "join", room: "busy", nick: "bia" }));
    expect(b.sent[0]).toMatchObject({ type: "joined", history: [{ nick: "ana", text: "hello" }] });
    hub.receive(b, JSON.stringify({ type: "join", room: "quiet", nick: "bia" }));
    expect((b.sent.at(-1) as { history: unknown[] }).history).toEqual([]);
  });

  it("does not count typing notifications against the message budget", () => {
    let now = 0;
    const hub = new ChatHub(testConfig({ burst: 2 }), () => now);
    const a = new FakeConn();
    hub.connect(a);
    hub.receive(a, JSON.stringify({ type: "join", room: "r", nick: "ana" }));
    for (let i = 0; i < 10; i++) hub.receive(a, JSON.stringify({ type: "typing", typing: true }));
    hub.receive(a, JSON.stringify({ type: "message", text: "still allowed" }));
    expect(a.sent.at(-1)).toMatchObject({ type: "message", text: "still allowed" });
    expect(a.closedWith).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { TestClient, testConfig, type } from "./helpers.js";

describe("WebSocket chat (real connections)", () => {
  let app: FastifyInstance;
  let url: string;
  const clients: TestClient[] = [];

  const start = async (overrides: Partial<Config> = {}) => {
    app = await buildApp(testConfig(overrides));
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    url = address.replace("http", "ws") + "/ws";
  };
  const open = async () => {
    const c = await TestClient.open(url);
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    await start();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await app.close();
  });

  it("joins a room and broadcasts presence to the others", async () => {
    const ana = await open();
    expect(await ana.join("general", "ana")).toMatchObject({ type: "joined", room: "general", members: ["ana"], history: [] });
    const bia = await open();
    expect((await bia.join("general", "bia")).members).toEqual(["ana", "bia"]);
    expect(await ana.next(type("presence"))).toMatchObject({ event: "join", nick: "bia", members: ["ana", "bia"] });

    bia.close();
    expect(await ana.next(type("presence"))).toMatchObject({ event: "leave", nick: "bia", members: ["ana"] });
  });

  it("delivers messages to everyone in the room and nobody outside it", async () => {
    const [ana, bia, caio] = await Promise.all([open(), open(), open()]);
    await ana.join("dev", "ana");
    await bia.join("dev", "bia");
    await caio.join("sales", "caio");

    ana.send({ type: "message", text: "  deploy is green  " });
    const forBia = await bia.next(type("message"));
    const echo = await ana.next(type("message"));
    expect(forBia).toMatchObject({ room: "dev", nick: "ana", text: "deploy is green" });
    expect(echo.id).toBe(forBia.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(caio.events.filter((e) => e.type === "message")).toHaveLength(0);
  });

  it("sends the last 50 messages of the room to whoever joins", async () => {
    await app.close();
    await start({ burst: 100 });
    const ana = await open();
    await ana.join("history", "ana");
    for (let i = 1; i <= 55; i++) ana.send({ type: "message", text: `msg ${i}` });
    await ana.next(type("message", (e) => e.text === "msg 55"));

    const bia = await open();
    const joined = await bia.join("history", "bia");
    expect(joined.history).toHaveLength(50);
    expect(joined.history[0].text).toBe("msg 6");
    expect(joined.history.at(-1).text).toBe("msg 55");
  });

  it("relays typing indicators to the other members only", async () => {
    const [ana, bia] = await Promise.all([open(), open()]);
    await ana.join("general", "ana");
    await bia.join("general", "bia");
    ana.send({ type: "typing", typing: true });
    expect(await bia.next(type("typing"))).toMatchObject({ nick: "ana", typing: true });
    ana.send({ type: "typing", typing: false });
    expect(await bia.next(type("typing"))).toMatchObject({ nick: "ana", typing: false });
    expect(ana.events.some((e) => e.type === "typing")).toBe(false);
  });

  it("rejects duplicate nicknames and invalid input", async () => {
    const [ana, other] = await Promise.all([open(), open()]);
    await ana.join("general", "ana");
    expect(await other.join("general", "ANA")).toMatchObject({ type: "error", code: "nick_taken" });
    expect(await other.join("Bad Room!", "zed")).toMatchObject({ type: "error", code: "invalid_room" });
    expect(await other.join("general", "x")).toMatchObject({ type: "error", code: "invalid_nick" });
    other.send({ type: "message", text: "hi" });
    expect(await other.next(type("error"))).toMatchObject({ code: "not_joined" });
    other.send("not json");
    expect(await other.next(type("error"))).toMatchObject({ code: "bad_request" });
    ana.send({ type: "message", text: "x".repeat(1001) });
    expect(await ana.next(type("error"))).toMatchObject({ code: "message_too_long" });
  });

  it("rate limits floods and disconnects persistent flooders", async () => {
    const ana = await open();
    await ana.join("general", "ana"); // uses 1 of the 5 tokens
    for (let i = 0; i < 6; i++) ana.send({ type: "message", text: `spam ${i}` });
    expect(await ana.next(type("error"))).toMatchObject({ code: "rate_limited" });
    const delivered = ana.events.filter((e) => e.type === "message").length;
    expect(delivered).toBeLessThanOrEqual(4);

    for (let i = 0; i < 20; i++) ana.send({ type: "message", text: "more spam" });
    expect(await ana.closed).toEqual({ code: 1008, reason: "flooding" });
  });

  it("switches rooms on a new join", async () => {
    const [ana, bia] = await Promise.all([open(), open()]);
    await ana.join("general", "ana");
    await bia.join("general", "bia");
    expect((await ana.join("random", "ana")).room).toBe("random");
    expect(await bia.next(type("presence"))).toMatchObject({ event: "leave", nick: "ana", members: ["bia"] });
  });

  it("lists active rooms and serves the web client", async () => {
    const [ana, bia] = await Promise.all([open(), open()]);
    await ana.join("general", "ana");
    await bia.join("dev", "bia");
    const { rooms } = (await app.inject({ method: "GET", url: "/api/rooms" })).json();
    expect(rooms).toEqual([
      { room: "dev", members: 1 },
      { room: "general", members: 1 },
    ]);
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<script src="/app.js">');
    expect((await app.inject({ method: "GET", url: "/app.js" })).statusCode).toBe(200);
  });
});

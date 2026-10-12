import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, setup, type TestContext } from "./helpers.js";

describe("auth flow", () => {
  let t: TestContext;

  beforeEach(async () => {
    t = await setup();
  });

  afterEach(async () => {
    await t.app.close();
    t.store.close();
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    t.app.inject({ method: "POST", url, payload, headers });

  it("registers a user without exposing the password hash", async () => {
    const res = await t.register("Ana@Example.com");
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ email: "ana@example.com", name: "Test User", role: "user" });
    expect(JSON.stringify(res.body)).not.toContain("hash");
  });

  it("stores a bcrypt hash, never the plain password", async () => {
    await t.register("ana@example.com");
    const row = t.store.findUserByEmail("ana@example.com");
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$04\$/);
    expect(row?.passwordHash).not.toContain(PASSWORD);
  });

  it("rejects a duplicate e-mail (case insensitive)", async () => {
    await t.register("ana@example.com");
    const res = await t.register("ANA@example.com");
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("email_taken");
  });

  it.each([
    [{ email: "not-an-email", password: PASSWORD, name: "X" }, "email"],
    [{ email: "a@example.com", password: "short", name: "X" }, "password"],
    [{ email: "a@example.com", password: PASSWORD }, "name"],
  ])("validates input %#", async (payload, hint) => {
    const res = await post("/auth/register", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
    expect(res.json().message.toLowerCase()).toContain(hint);
  });

  it("ignores fields outside the schema, so a client cannot pick its role", async () => {
    const res = await post("/auth/register", { email: "eve@example.com", password: PASSWORD, name: "Eve", role: "admin" });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("user");
  });

  it("logs in and returns an access JWT and a refresh token", async () => {
    await t.register("ana@example.com");
    const res = await t.login("ana@example.com");
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ tokenType: "Bearer", expiresIn: 900 });
    expect(res.body.accessToken.split(".")).toHaveLength(3);
    const payload = t.app.jwt.decode<{ sub: string; role: string; exp: number; iat: number; iss: string }>(
      res.body.accessToken,
    );
    expect(payload).toMatchObject({ role: "user", iss: "jwt-auth-api-test" });
    expect(payload!.exp - payload!.iat).toBe(900);
  });

  it("rejects wrong passwords and unknown e-mails with the same error", async () => {
    await t.register("ana@example.com");
    const wrong = await t.login("ana@example.com", "wrong password!!");
    const unknown = await t.login("nobody@example.com");
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("rate limits login attempts per IP and e-mail", async () => {
    await t.register("ana@example.com");
    for (let i = 0; i < 5; i++) expect((await t.login("ana@example.com", "bad password 123")).statusCode).toBe(401);
    const blocked = await t.login("ana@example.com");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body.error).toBe("too_many_requests");
    // A different account from the same IP is not affected.
    await t.register("bia@example.com");
    expect((await t.login("bia@example.com")).statusCode).toBe(200);
  });

  it("returns the current user on /me with a valid token", async () => {
    await t.register("ana@example.com");
    const { body } = await t.login("ana@example.com");
    const me = await t.app.inject({ method: "GET", url: "/me", headers: bearer(body.accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: "ana@example.com", activeSessions: 1 });
  });

  it("rejects missing, tampered and expired access tokens", async () => {
    expect((await t.app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    await t.register("ana@example.com");
    const { body } = await t.login("ana@example.com");
    const tampered = body.accessToken.slice(0, -2) + (body.accessToken.endsWith("A") ? "BB" : "AA");
    expect((await t.app.inject({ method: "GET", url: "/me", headers: bearer(tampered) })).statusCode).toBe(401);
    const user = t.store.findUserByEmail("ana@example.com")!;
    const expired = t.app.jwt.sign({ sub: user.id, role: "user" }, { expiresIn: -10 });
    expect((await t.app.inject({ method: "GET", url: "/me", headers: bearer(expired) })).statusCode).toBe(401);
  });

  it("rotates refresh tokens", async () => {
    await t.register("ana@example.com");
    const first = (await t.login("ana@example.com")).body;
    const res = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await t.app.inject({ method: "GET", url: "/me", headers: bearer(second.accessToken) })).statusCode).toBe(200);
    // The new token works once more.
    expect((await post("/auth/refresh", { refreshToken: second.refreshToken })).statusCode).toBe(200);
  });

  it("detects refresh token reuse and revokes the whole session", async () => {
    await t.register("ana@example.com");
    const first = (await t.login("ana@example.com")).body;
    const second = (await post("/auth/refresh", { refreshToken: first.refreshToken })).json();
    const reuse = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error).toBe("refresh_token_reused");
    // The legitimate latest token is now revoked too.
    expect((await post("/auth/refresh", { refreshToken: second.refreshToken })).statusCode).toBe(401);
  });

  it("rejects expired refresh tokens", async () => {
    await t.app.close();
    t.store.close();
    t = await setup({ refreshTtlDays: 1 });
    await t.register("ana@example.com");
    const { body } = await t.login("ana@example.com");
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 86_400_000;
    try {
      const res = await post("/auth/refresh", { refreshToken: body.refreshToken });
      expect(res.json().error).toBe("refresh_token_expired");
    } finally {
      Date.now = realNow;
    }
  });

  it("only stores hashes of refresh tokens", async () => {
    await t.register("ana@example.com");
    const { body } = await t.login("ana@example.com");
    expect(t.store.findRefreshToken(body.refreshToken)).toBeUndefined();
  });

  it("logs out one session and keeps the others", async () => {
    await t.register("ana@example.com");
    const laptop = (await t.login("ana@example.com")).body;
    const phone = (await t.login("ana@example.com")).body;
    expect((await post("/auth/logout", { refreshToken: laptop.refreshToken })).statusCode).toBe(204);
    expect((await post("/auth/refresh", { refreshToken: laptop.refreshToken })).statusCode).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: phone.refreshToken })).statusCode).toBe(200);
  });

  it("logs out everywhere", async () => {
    await t.register("ana@example.com");
    const a = (await t.login("ana@example.com")).body;
    const b = (await t.login("ana@example.com")).body;
    const res = await post("/auth/logout-all", {}, bearer(a.accessToken));
    expect(res.json()).toEqual({ revoked: 2 });
    expect((await post("/auth/refresh", { refreshToken: b.refreshToken })).statusCode).toBe(401);
  });
});

describe("roles", () => {
  let t: TestContext;

  beforeEach(async () => {
    t = await setup();
    await t.register("boss@example.com");
    await t.register("ana@example.com");
  });

  afterEach(async () => {
    await t.app.close();
    t.store.close();
  });

  const listUsers = (token: string) =>
    t.app.inject({ method: "GET", url: "/admin/users", headers: { authorization: `Bearer ${token}` } });

  it("grants admin to configured e-mails", async () => {
    const { body } = await t.login("boss@example.com");
    const res = await listUsers(body.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((u: { email: string }) => u.email)).toEqual(["boss@example.com", "ana@example.com"]);
  });

  it("returns 403 for regular users", async () => {
    const { body } = await t.login("ana@example.com");
    const res = await listUsers(body.accessToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });
});

describe("docs and health", () => {
  it("serves the OpenAPI document and Swagger UI", async () => {
    const t = await setup();
    const spec = await t.app.inject({ method: "GET", url: "/docs/json" });
    expect(spec.statusCode).toBe(200);
    const doc = spec.json();
    expect(doc.openapi).toBe("3.0.3");
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(["/auth/register", "/auth/login", "/auth/refresh", "/auth/logout", "/me", "/admin/users"]),
    );
    expect(doc.paths["/healthz"]).toBeUndefined();
    const ui = await t.app.inject({ method: "GET", url: "/docs/" });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/html");
    expect((await t.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
    await t.app.close();
    t.store.close();
  });
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Hono } from "hono";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createAuthMiddleware } from "./auth.ts";
import { makeSession, setupAuthApp } from "../test-helpers/authHarness.ts";

describe("read-only API key", () => {
  const GOOD_KEY = "readonly-test-key-0123456789abcdef";

  // A real tRPC handler behind the auth middleware, so the tests see which
  // procedures tRPC actually runs, not just what the middleware lets through.
  function setup(readonlyApiKey: string | undefined = GOOD_KEY) {
    const ran: string[] = [];
    const t = initTRPC.create();
    const read = (name: string) =>
      t.procedure.query(() => {
        ran.push(name);
        return name;
      });
    const appRouter = t.router({
      charger: t.router({ list: read("charger.list") }),
      schedule: t.router({ active: read("schedule.active") }),
      config: t.router({
        notification: t.router({ get: read("config.notification.get") }),
      }),
    });

    const { deps } = setupAuthApp({
      authMode: "oidc",
      validateSession: (id) =>
        Promise.resolve(id === "sess-123" ? makeSession() : null),
    });
    const app = new Hono();
    app.use("*", createAuthMiddleware({ ...deps, readonlyApiKey }));
    // An allowlisted path that reports the session it was given.
    app.get(
      "/trpc/schedule.list",
      (c) => c.json({ session: c.get("session" as never) ?? null }),
    );
    app.all(
      "/trpc/*",
      (c) =>
        fetchRequestHandler({
          endpoint: "/trpc",
          req: c.req.raw,
          router: appRouter,
        }),
    );
    app.get("/protected", (c) => c.json({ ok: true }));
    return { app, ran };
  }

  function bearer(key = GOOD_KEY): Record<string, string> {
    return { Authorization: `Bearer ${key}` };
  }

  it("allows an allowlisted batch read with the right key", async () => {
    const { app, ran } = setup();

    const res = await app.request(
      "/trpc/charger.list,schedule.active?batch=1&input=%7B%7D",
      { headers: bearer() },
    );

    expect(res.status).toBe(200);
    expect(ran).toEqual(["charger.list", "schedule.active"]);
  });

  it("refuses the wrong key", async () => {
    const { app, ran } = setup();

    const res = await app.request("/trpc/charger.list", {
      headers: bearer("readonly-test-key-0123456789abcdeX"),
    });

    expect(res.status).toBe(401);
    expect(ran).toEqual([]);
  });

  it("refuses every key when none is set", async () => {
    const { app } = setup(undefined);

    const res = await app.request("/trpc/charger.list", {
      headers: { Authorization: "Bearer undefined" },
    });

    expect(res.status).toBe(401);
  });

  it("ignores a key shorter than 32 characters", async () => {
    const { app } = setup("short-key");

    const res = await app.request("/trpc/charger.list", {
      headers: bearer("short-key"),
    });

    expect(res.status).toBe(401);
  });

  it("refuses a read that is not on the allowlist", async () => {
    const { app, ran } = setup();

    const res = await app.request("/trpc/config.notification.get", {
      headers: bearer(),
    });

    expect(res.status).toBe(401);
    expect(ran).toEqual([]);
  });

  it("refuses a batch that sneaks in one read off the allowlist", async () => {
    const { app, ran } = setup();

    const plain = await app.request(
      "/trpc/charger.list,config.notification.get?batch=1&input=%7B%7D",
      { headers: bearer() },
    );
    const encoded = await app.request(
      "/trpc/charger.list%2Cconfig.notification.get?batch=1&input=%7B%7D",
      { headers: bearer() },
    );

    expect(plain.status).toBe(401);
    expect(encoded.status).toBe(401);
    expect(ran).toEqual([]);
  });

  it("refuses anything but GET", async () => {
    const { app } = setup();

    const res = await app.request("/trpc/charger.list", {
      method: "POST",
      headers: { ...bearer(), "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });

  it("refuses requests that came through a proxy", async () => {
    const { app, ran } = setup();
    const via = ["X-Forwarded-For", "CF-Connecting-IP", "Forwarded"];

    const statuses = await Promise.all(via.map(async (header) => {
      const res = await app.request("/trpc/charger.list", {
        headers: { ...bearer(), [header]: "203.0.113.7" },
      });
      return res.status;
    }));

    expect(statuses).toEqual([401, 401, 401]);
    expect(ran).toEqual([]);
  });

  it("only works on tRPC reads", async () => {
    const { app } = setup();

    const res = await app.request("/protected", { headers: bearer() });

    expect(res.status).toBe(401);
  });

  it("refuses a badly encoded path instead of crashing", async () => {
    const { app } = setup();

    const res = await app.request("/trpc/charger.list%E0%A4%A", {
      headers: bearer(),
    });

    expect(res.status).toBe(401);
  });

  it("does not attach a session", async () => {
    const { app } = setup();

    const res = await app.request("/trpc/schedule.list", { headers: bearer() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: null });
  });

  it("leaves session logins working", async () => {
    const { app, ran } = setup();

    const res = await app.request("/trpc/config.notification.get", {
      headers: { Cookie: "session_id=sess-123" },
    });

    expect(res.status).toBe(200);
    expect(ran).toEqual(["config.notification.get"]);
  });
});

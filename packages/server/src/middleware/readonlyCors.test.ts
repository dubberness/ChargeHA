import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Hono } from "hono";
import { createAuthMiddleware } from "./auth.ts";
import {
  createReadonlyCorsMiddleware,
  parseCorsOrigins,
} from "./readonlyCors.ts";
import { makeSession, setupAuthApp } from "../test-helpers/authHarness.ts";
import { Logger } from "../lib/Logger.ts";

describe("read-only CORS", () => {
  const KEY = "readonly-test-key-0123456789abcdef";
  const PANEL = "http://192.168.1.133";
  const logger = new Logger("test", "error");

  function setup(origins = PANEL) {
    const { deps } = setupAuthApp({
      authMode: "oidc",
      validateSession: (id) =>
        Promise.resolve(id === "sess-123" ? makeSession() : null),
    });
    const app = new Hono();
    app.use(
      "*",
      createReadonlyCorsMiddleware(parseCorsOrigins(origins, logger)),
    );
    app.use("*", createAuthMiddleware({ ...deps, readonlyApiKey: KEY }));
    app.all("/trpc/*", (c) => c.json({ ok: true }));
    return app;
  }

  const preflight = (origin: string, method = "GET") => ({
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": "authorization",
    },
  });

  it("answers a listed origin's preflight for an allowlisted read", async () => {
    const res = await setup().request(
      "/trpc/charger.list,schedule.list?batch=1",
      preflight(PANEL),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PANEL);
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization",
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("lets a listed origin read with the key", async () => {
    const res = await setup().request("/trpc/charger.list?batch=1", {
      headers: { Origin: PANEL, Authorization: `Bearer ${KEY}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(PANEL);
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("still needs the key: CORS doesn't open the read", async () => {
    const res = await setup().request("/trpc/charger.list?batch=1", {
      headers: { Origin: PANEL },
    });

    expect(res.status).toBe(401);
  });

  it("gives an unlisted origin nothing", async () => {
    const app = setup();
    const pre = await app.request(
      "/trpc/charger.list",
      preflight("http://evil.example"),
    );
    const get = await app.request("/trpc/charger.list", {
      headers: {
        Origin: "http://evil.example",
        Authorization: `Bearer ${KEY}`,
      },
    });

    expect(pre.status).toBe(401);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(get.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("gives no CORS to a read off the allowlist", async () => {
    const app = setup();
    const pre = await app.request(
      "/trpc/charger.list,config.notification.get",
      preflight(PANEL),
    );
    const get = await app.request("/trpc/config.notification.get", {
      headers: { Origin: PANEL, Cookie: "session_id=sess-123" },
    });

    expect(pre.status).toBe(401);
    expect(get.status).toBe(200);
    expect(get.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("only answers preflights for GET", async () => {
    const res = await setup().request(
      "/trpc/charger.list",
      preflight(PANEL, "POST"),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("gives no CORS through a proxy", async () => {
    const res = await setup().request("/trpc/charger.list", {
      headers: {
        Origin: PANEL,
        Authorization: `Bearer ${KEY}`,
        "CF-Connecting-IP": "203.0.113.9",
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does nothing when no origins are set", async () => {
    const res = await setup("").request("/trpc/charger.list", {
      headers: { Origin: PANEL, Authorization: `Bearer ${KEY}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("parseCorsOrigins", () => {
  const logger = new Logger("test", "error");

  it("keeps exact origins and drops a trailing slash", () => {
    const origins = parseCorsOrigins(
      " http://192.168.1.133/ , https://ha.example.com",
      logger,
    );

    expect([...origins]).toEqual([
      "http://192.168.1.133",
      "https://ha.example.com",
    ]);
  });

  it("drops wildcards, paths and junk", () => {
    const origins = parseCorsOrigins(
      "*,http://192.168.1.133/local/wallpanel,not a url,ftp://x.example",
      logger,
    );

    expect(origins.size).toBe(0);
  });
});

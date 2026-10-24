import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Hono } from "hono";
import { createAuthMiddleware } from "../middleware/auth.ts";
import { setupAuthApp } from "../test-helpers/authHarness.ts";
import { createHealthRoutes } from "./health.ts";

describe("GET /health", () => {
  // The real route behind the real middleware, with login on and no session.
  function appWithLogin(): Hono {
    const { deps } = setupAuthApp({ authMode: "oidc" });
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.route("/health", createHealthRoutes());
    app.get("/protected", (c) => c.json({ ok: true }));
    return app;
  }

  it("answers without a session when login is on", async () => {
    const app = appWithLogin();

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    // Same app, so the 200 is the exemption and not login being off.
    expect((await app.request("/protected")).status).toBe(401);
  });

  it("is only there for GET", async () => {
    const res = await appWithLogin().request("/health", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

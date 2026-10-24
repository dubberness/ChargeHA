import { Hono } from "hono";

// Liveness for Docker's HEALTHCHECK. The auth middleware lets GET /health
// through, so it answers with login on too; it says nothing about the setup.
export function createHealthRoutes(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json({ status: "ok" }));
  return app;
}

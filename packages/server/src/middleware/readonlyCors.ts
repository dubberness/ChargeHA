import type { MiddlewareHandler } from "hono";
import type { Logger } from "../lib/Logger.ts";
import { isReadonlyTrpcPath } from "./auth.ts";

// READONLY_CORS_ORIGINS: web pages allowed to make the read-only key's reads
// from the browser, e.g. a wall panel served by Home Assistant. Exact origins,
// comma-separated. A bad entry is dropped with a warning, and "*" is never
// accepted. Unset means no CORS headers at all.
export function parseCorsOrigins(
  raw: string | undefined,
  logger: Logger,
): ReadonlySet<string> {
  const entries = (raw ?? "").split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter((entry) => entry !== "");
  const origins = entries.filter((entry) => {
    if (isOrigin(entry)) return true;
    logger.warn(`READONLY_CORS_ORIGINS: ignored "${entry}", not an origin`);
    return false;
  });
  if (origins.length > 0) {
    logger.info(`Read-only reads allowed from ${origins.join(", ")}`);
  }
  return new Set(origins);
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value;
  } catch {
    return false;
  }
}

// CORS for the read-only reads only: a listed origin asking for an allowlisted
// GET gets Access-Control-Allow-Origin, and its preflight is answered here
// because a preflight carries no key. Credentials are never allowed, so a page
// can use the key but can't ride on a logged-in browser's session. Everything
// else passes through untouched; auth still decides whether the read runs.
export function createReadonlyCorsMiddleware(
  origins: ReadonlySet<string>,
): MiddlewareHandler {
  return async function readonlyCors(c, next) {
    const origin = c.req.header("Origin");
    if (
      !origin || !origins.has(origin) ||
      !isReadonlyTrpcPath(c.req.raw, new URL(c.req.url).pathname)
    ) {
      return next();
    }
    if (c.req.method === "OPTIONS") {
      if (c.req.header("Access-Control-Request-Method") !== "GET") {
        return next();
      }
      return c.body(null, 204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Authorization",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
      });
    }
    await next();
    if (c.req.method !== "GET") return;
    // deno-lint-ignore custom-no-param-mutation/no-param-mutation -- Hono middleware API
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.append("Vary", "Origin");
  };
}

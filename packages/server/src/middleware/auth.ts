import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "@std/crypto/timing-safe-equal";
import type { AuthService } from "../services/AuthService.ts";
import type { ConfigService } from "../services/ConfigService.ts";
import type { Logger } from "../lib/Logger.ts";

export interface AuthMiddlewareDeps {
  authService: AuthService;
  configService: ConfigService;
  logger: Logger;
  // Plugin-declared device endpoints that bypass session auth.
  publicPrefixes?: string[];
  // READONLY_API_KEY: lets a LAN dashboard make the reads in
  // READONLY_TRPC_PROCEDURES without logging in. Unset means no key works.
  readonlyApiKey?: string;
}

const EXEMPT_PREFIXES = [
  "GET /auth/oidc/",
  "GET /.well-known/",
  "GET /health",
] as const;

// Exact paths that bypass auth: the SPA shell and the login page — without
// these an unauthenticated browser can never reach the login form.
const EXEMPT_EXACT = [
  "GET /",
  "GET /login",
] as const;

const EXEMPT_TRPC_PATHS = [
  "/trpc/auth.login",
  "/trpc/auth.session",
] as const;

// The reads the read-only key may make. An allowlist, not "every query",
// because some queries hand back saved secrets: plugin getConfig decrypts its
// settings and config.notification.get holds the Telegram bot token. Check a
// procedure's output for secrets before adding it here.
const READONLY_TRPC_PROCEDURES: ReadonlySet<string> = new Set([
  "charger.list",
  "config.charging.get",
  "config.solar.get",
  "energy.getPlugins",
  "energy.realtime",
  "forecast.status",
  "forecast.summary",
  "health.pluginWarnings",
  "log.chargeController",
  "schedule.active",
  "schedule.list",
  "tariff.list",
]);

// Headers a reverse proxy or Cloudflare adds. The key is for the LAN, so a
// request carrying any of these is refused even with the right key.
const PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ray",
] as const;

// A shorter key is refused at startup rather than trusted.
const MIN_READONLY_KEY_LENGTH = 32;

const STATIC_EXTENSIONS = [
  ".js",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".map",
] as const;

// Detect whether the incoming request arrived over HTTPS. Checks
// X-Forwarded-Proto header first (reverse proxy), then URL scheme.
export function isHttps(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded === "https") return true;
  const proto = new URL(req.url).protocol;
  return proto === "https:";
}

function isExemptPath(method: string, path: string): boolean {
  if (EXEMPT_EXACT.some((exact) => exact === `${method} ${path}`)) {
    return true;
  }

  // Check method+path prefixes
  const matchesPrefix = EXEMPT_PREFIXES.some((prefix) => {
    const [exemptMethod, exemptPath] = prefix.split(" ", 2);
    return method === exemptMethod && path.startsWith(exemptPath);
  });
  if (matchesPrefix) return true;

  // Check tRPC exempt paths (any method — tRPC uses GET for queries, POST for mutations)
  if (EXEMPT_TRPC_PATHS.some((trpcPath) => path.startsWith(trpcPath))) {
    return true;
  }

  // Check static asset extensions
  const pathWithoutQuery = path.split("?")[0];
  if (STATIC_EXTENSIONS.some((ext) => pathWithoutQuery.endsWith(ext))) {
    return true;
  }

  return false;
}

function trimSlashes(path: string): string {
  return path.replace(/^\//, "").replace(/\/$/, "");
}

// The procedures tRPC will run for this path, worked out the way its fetch
// adapter does: trim, drop "trpc", trim, decode, split the batch on commas.
// Matching it exactly means the allowlist sees what tRPC sees.
function trpcProcedures(path: string): string[] {
  if (!path.startsWith("/trpc/")) return [];
  const encoded = trimSlashes(trimSlashes(path).slice("trpc".length));
  try {
    return decodeURIComponent(encoded).split(",");
  } catch {
    return [];
  }
}

function isReadonlyRequest(req: Request, path: string): boolean {
  const procedures = trpcProcedures(path);
  return req.method === "GET" &&
    procedures.length > 0 &&
    procedures.every((name) => READONLY_TRPC_PROCEDURES.has(name)) &&
    !PROXY_HEADERS.some((header) => req.headers.has(header));
}

async function sha256(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

// Compares digests so the time taken says nothing about the key's length or
// how much of it matched.
async function bearerMatches(
  authorization: string | undefined,
  expectedDigest: Uint8Array,
): Promise<boolean> {
  const match = authorization?.match(/^Bearer (\S+)$/i);
  if (!match) return false;
  return timingSafeEqual(await sha256(match[1]), expectedDigest);
}

function readonlyKeyDigest(
  rawKey: string | undefined,
  logger: Logger,
): Promise<Uint8Array> | null {
  // Trimmed: a stray space pasted into a container's env field would
  // otherwise fail every request with no clue why.
  const key = rawKey?.trim();
  if (!key) return null;
  if (key.length < MIN_READONLY_KEY_LENGTH) {
    logger.warn(
      `READONLY_API_KEY ignored: it needs at least ${MIN_READONLY_KEY_LENGTH} characters`,
    );
    return null;
  }
  logger.info("Read-only API key is on for LAN reads");
  return sha256(key);
}

// Hono middleware that adds Strict-Transport-Security header only when the
// request arrived over HTTPS.
export function hstsMiddleware(): MiddlewareHandler {
  return async function hsts(c, next) {
    await next();
    if (isHttps(c.req.raw)) {
      // deno-lint-ignore custom-no-param-mutation/no-param-mutation -- Hono middleware API
      c.res.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains",
      );
    }
  };
}

// Create the session-based auth middleware. Check order: 1. auth_mode ===
// "none" → skip; 2. RESET_AUTH env var → skip + X-Auth-Warning header; 3.
// exempt path → skip; 4. valid session cookie → attach to context, continue;
// 5. read-only key on an allowlisted LAN read → continue; 6. otherwise → 401
export function createAuthMiddleware(
  deps: AuthMiddlewareDeps,
): MiddlewareHandler {
  const { authService, configService, logger, publicPrefixes = [] } = deps;
  const readonlyDigest = readonlyKeyDigest(deps.readonlyApiKey, logger);

  return async function authMiddleware(c, next) {
    // 1. Check auth_mode
    const internal = await configService.getInternal();
    const authMode = internal.authMode;
    if (authMode === "none") {
      return next();
    }

    // 2. Check RESET_AUTH env var
    const resetAuth = Deno.env.get("RESET_AUTH");
    if (resetAuth === "true") {
      await next();
      // deno-lint-ignore custom-no-param-mutation/no-param-mutation -- Hono middleware API
      c.res.headers.set("X-Auth-Warning", "disabled");
      return;
    }

    // 3. Check exempt paths
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    if (
      isExemptPath(method, path) ||
      publicPrefixes.some((prefix) =>
        path === prefix || path.startsWith(`${prefix}/`)
      )
    ) {
      return next();
    }

    // 4. Check session cookie
    const cookieHeader = c.req.header("Cookie");
    const sessionId = parseCookieValue(cookieHeader, "session_id");

    if (sessionId) {
      const session = await authService.validateSession(sessionId);
      if (session) {
        // Attach session to Hono context for downstream handlers
        // deno-lint-ignore custom-no-param-mutation/no-param-mutation -- Hono middleware API
        c.set("session", session);
        return next();
      }
    }

    // 5. Read-only key. No session is attached, so nothing downstream can
    //    mistake it for a logged-in user.
    if (
      readonlyDigest && isReadonlyRequest(c.req.raw, path) &&
      await bearerMatches(c.req.header("Authorization"), await readonlyDigest)
    ) {
      return next();
    }

    // 6. No valid session. Browser navigations (document requests) are sent
    //    to the login page; data requests get a JSON 401.
    logger.warn(`Auth rejected: ${method} ${path}`);
    const acceptsHtml = c.req.header("Accept")?.includes("text/html") ?? false;
    if (method === "GET" && acceptsHtml) {
      return c.redirect("/login", 302);
    }
    return c.json({ error: "Unauthorized" }, 401);
  };
}

function parseCookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  const match = cookies.find((cookie) => {
    const [key] = cookie.trim().split("=");
    return key === name;
  });
  if (!match) return null;
  const [, ...rest] = match.trim().split("=");
  return rest.join("="); // handle values with '=' in them
}

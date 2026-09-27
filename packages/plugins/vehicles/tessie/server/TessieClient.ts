import type { CallContext } from "@chargeha/shared";
import type { Logger } from "@chargeha/server/lib/Logger";
import type { PluginDbLogger } from "@chargeha/server/lib/PluginDbLogger";
import { shortId } from "@chargeha/shared/redact";
import type { TeslaVehicleData } from "../../tesla/shared/vehicleData.ts";

// Tessie API — https://developer.tessie.com
// One bearer token covers every vehicle on the account. Tessie signs vehicle
// commands with its own virtual key and keeps polling the car itself, so
// there is no per-call Tesla billing, no command proxy and no OAuth.
export const TESSIE_API_BASE = "https://api.tessie.com";

const READ_TIMEOUT_MS = 15_000;
// Tessie's wake returns false after its own 90s timeout.
const WAKE_TIMEOUT_MS = 100_000;
// Commands wait for completion and retry up to 3 times server-side,
// including an automatic wake when the car is asleep.
const COMMAND_TIMEOUT_MS = 120_000;

export class TessieConnectionError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, { cause });
    this.name = "TessieConnectionError";
  }
}

export class TessieApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "TessieApiError";
    this.statusCode = statusCode;
  }
}

export interface TessieVehicleSummary {
  vin: string;
  name: string;
}

export type TessieSleepStatus = "asleep" | "waiting_for_sleep" | "awake";

export interface TessieClientIo {
  fetch: typeof globalThis.fetch;
}

interface TessieVehicleListItem {
  vin: string;
  is_active?: boolean;
  display_name?: string;
  last_state?: {
    display_name?: string;
    vehicle_state?: { vehicle_name?: string };
  };
}

interface RequestOptions {
  method: "GET" | "POST";
  query?: Record<string, string>;
  timeoutMs: number;
  // Validates a token before it is saved; otherwise the stored one is used.
  token?: string;
  vin?: string;
}

// Account-level Tessie HTTP client. Every request is recorded to the plugin
// log (never the token), mirroring the Tesla adapter's request log.
export class TessieClient {
  // Set by a 401/403 and cleared by the next success, so the auth health
  // check and command status need no request of their own.
  private authRejected = false;

  constructor(
    private readonly getToken: () => Promise<string | null>,
    private readonly logger: Logger,
    private readonly dbLog: PluginDbLogger,
    private readonly io: TessieClientIo = { fetch: globalThis.fetch },
  ) {}

  get lastAuthRejected(): boolean {
    return this.authRejected;
  }

  async listVehicles(
    ctx: CallContext,
    token?: string,
  ): Promise<TessieVehicleSummary[]> {
    const data = await this.request<{ results?: TessieVehicleListItem[] }>(
      "/vehicles",
      ctx,
      {
        method: "GET",
        query: { only_active: "true" },
        timeoutMs: READ_TIMEOUT_MS,
        token,
      },
    );
    return (data.results ?? []).map((v) => ({
      vin: v.vin,
      name: v.display_name ?? v.last_state?.display_name ??
        v.last_state?.vehicle_state?.vehicle_name ?? "Tesla",
    }));
  }

  // Tessie's last-known state. Never wakes the car — for a sleeping car this
  // is the state it went to sleep with, which is what it still is.
  getState(vin: string, ctx: CallContext): Promise<TeslaVehicleData> {
    return this.request<TeslaVehicleData>(`/${vin}/state`, ctx, {
      method: "GET",
      timeoutMs: READ_TIMEOUT_MS,
      vin,
    });
  }

  async getStatus(vin: string, ctx: CallContext): Promise<TessieSleepStatus> {
    const data = await this.request<{ status: TessieSleepStatus }>(
      `/${vin}/status`,
      ctx,
      { method: "GET", timeoutMs: READ_TIMEOUT_MS, vin },
    );
    return data.status;
  }

  async wake(vin: string, ctx: CallContext): Promise<boolean> {
    const data = await this.request<{ result?: boolean }>(
      `/${vin}/wake`,
      ctx,
      { method: "POST", timeoutMs: WAKE_TIMEOUT_MS, vin },
    );
    return data.result === true;
  }

  async command(
    vin: string,
    command: string,
    params: Record<string, string>,
    ctx: CallContext,
  ): Promise<boolean> {
    this.logger.debug(`Sending command ${command} to vehicle ${shortId(vin)}`);
    const data = await this.request<{ result?: boolean; reason?: string }>(
      `/${vin}/command/${command}`,
      ctx,
      {
        method: "POST",
        query: { ...params, wait_for_completion: "true" },
        timeoutMs: COMMAND_TIMEOUT_MS,
        vin,
      },
    );
    const ok = data.result === true;
    if (!ok) {
      this.dbLog.warn(`Command rejected: ${command}`, {
        payload: { command, reason: data.reason ?? null, vin },
        origin: ctx.origin,
        traceId: ctx.traceId,
      });
    }
    return ok;
  }

  private async request<T>(
    path: string,
    ctx: CallContext,
    options: RequestOptions,
  ): Promise<T> {
    const token = options.token ?? await this.getToken();
    if (!token) {
      throw new TessieApiError(
        "No Tessie API token configured — add one in Settings",
        401,
      );
    }
    const query = options.query
      ? new URLSearchParams(options.query).toString()
      : undefined;
    const url = `${TESSIE_API_BASE}${path}${query ? `?${query}` : ""}`;
    const response = await this.send(url, token, path, query, ctx, options);

    // A candidate token being tested says nothing about the stored one.
    if (options.token === undefined) {
      this.authRejected = response.status === 401 || response.status === 403;
    }
    if (!response.ok) {
      const reason = await this.parseErrorBody(response);
      throw new TessieApiError(
        reason ?? friendlyStatus(response.status),
        response.status,
      );
    }
    return await response.json() as T;
  }

  private async send(
    url: string,
    token: string,
    endpoint: string,
    query: string | undefined,
    ctx: CallContext,
    options: RequestOptions,
  ): Promise<Response> {
    const { method, vin } = options;
    const start = Date.now();
    try {
      const response = await this.io.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const responseBody = await response.clone().json()
        .catch((e: unknown) => {
          this.logger.debug("Response body is not JSON:", e);
          return undefined;
        });
      const logOpts = {
        payload: {
          method,
          endpoint,
          query,
          status: response.status,
          durationMs: Date.now() - start,
          vin,
          response: responseBody,
        },
        origin: ctx.origin,
        traceId: ctx.traceId,
      };
      if (response.ok) this.dbLog.info(`${method} ${endpoint}`, logOpts);
      else this.dbLog.warn(`${method} ${endpoint}`, logOpts);
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      this.dbLog.error(`${method} ${endpoint}`, {
        payload: {
          method,
          endpoint,
          query,
          durationMs: Date.now() - start,
          vin,
          error: errorMessage,
        },
        origin: ctx.origin,
        traceId: ctx.traceId,
      });
      throw new TessieConnectionError(
        "Could not reach the Tessie API — check your internet connection",
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async parseErrorBody(response: Response): Promise<string | null> {
    try {
      const data = await response.json();
      const error = data.error?.message ?? data.error ?? data.message ?? null;
      return typeof error === "string" ? error : null;
    } catch (e) {
      this.logger.debug("Could not parse error body:", e);
      return null;
    }
  }
}

function friendlyStatus(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "Tessie rejected the API token — update it in Settings";
    case 404:
      return "Vehicle not found on your Tessie account";
    case 408:
      return "Vehicle did not respond — it may be asleep or out of range";
    case 429:
      return "Too many requests — Tessie is rate limiting, try again shortly";
    case 500:
    case 502:
    case 503:
      return "Tessie service error — try again in a moment";
    default:
      return `Tessie returned an unexpected error (${status})`;
  }
}

import type {
  SolarForecastPeriod,
  SolarForecastSite,
} from "@chargeha/shared/solarForecast";
import {
  ForecastAuthError,
  type ForecastProviderOptions,
  type SolarForecastProvider,
} from "./types.ts";

// Reads the forecast that Home Assistant's "Solcast PV Forecast" integration
// (BJReplay/ha-solcast-solar) already holds, through its query_forecast_data
// action. Home Assistant is then the only thing calling Solcast, so the
// account's daily requests are not split between the two.

const SOLCAST_DOMAIN = "solcast_solar";
const QUERY_ACTION = "query_forecast_data";
const SITE_ID = "all";
const HALF_HOUR_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
// Solcast forecasts a week ahead. How much of it the integration still holds
// depends on when it last updated, so ask for less if the long range is
// refused.
const RANGES_DAYS = [6, 2];
const TIMEOUT_MS = 30_000;

interface HaServiceDomain {
  domain: string;
  services?: Record<string, unknown>;
}

interface HaForecastRow {
  period_start: string;
  pv_estimate: number;
  pv_estimate10?: number;
  pv_estimate90?: number;
}

// "homeassistant.local:8123/" → "http://homeassistant.local:8123"
export function normaliseBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Enter Home Assistant's address");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

// The integration reports kW, keyed by the start of each period. Periods
// are half an hour unless the gap to the next one says otherwise.
export function toForecastPeriods(
  rows: readonly HaForecastRow[],
): SolarForecastPeriod[] {
  const starts = rows.map((row) => {
    const ms = Date.parse(row.period_start);
    if (Number.isNaN(ms)) {
      throw new Error(`Unexpected forecast time "${row.period_start}"`);
    }
    return ms;
  });
  return rows.map((row, i) => {
    const gapMs = i + 1 < starts.length ? starts[i + 1] - starts[i] : 0;
    return {
      periodStart: new Date(starts[i]).toISOString(),
      periodMinutes: gapMs > 0 && gapMs <= 2 * HALF_HOUR_MS
        ? gapMs / 60_000
        : HALF_HOUR_MS / 60_000,
      pvW: row.pv_estimate * 1000,
      pvW10: (row.pv_estimate10 ?? row.pv_estimate) * 1000,
      pvW90: (row.pv_estimate90 ?? row.pv_estimate) * 1000,
    };
  });
}

// Home Assistant refused the range (HTTP 400): usually it reaches past the
// forecast the integration holds.
class RangeRefusedError extends Error {}

export class HomeAssistantProvider implements SolarForecastProvider {
  readonly id = "homeassistant" as const;
  readonly displayName = "Home Assistant";

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  // Checks the address and token, and that the Solcast integration is there.
  // The integration adds its rooftop sites together, so there is one "site".
  async listSites(
    token: string,
    options?: ForecastProviderOptions,
  ): Promise<SolarForecastSite[]> {
    const domains = await this.request<HaServiceDomain[]>(
      token,
      options,
      "/api/services",
    );
    const solcast = domains.find((d) => d.domain === SOLCAST_DOMAIN);
    if (!solcast?.services || !(QUERY_ACTION in solcast.services)) {
      throw new Error(
        "Home Assistant has no Solcast integration — add Solcast PV Forecast there first",
      );
    }
    return [{
      id: SITE_ID,
      name: "Solcast via Home Assistant",
      capacityKw: null,
    }];
  }

  fetchForecast(
    token: string,
    _siteId: string,
    options?: ForecastProviderOptions,
  ): Promise<SolarForecastPeriod[]> {
    const startMs = Math.floor(this.now() / HALF_HOUR_MS) * HALF_HOUR_MS;
    return this.queryRange(token, options, startMs, RANGES_DAYS);
  }

  // Tries the first range, then the shorter ones if it is refused.
  private async queryRange(
    token: string,
    options: ForecastProviderOptions | undefined,
    startMs: number,
    [days, ...shorter]: readonly number[],
  ): Promise<SolarForecastPeriod[]> {
    try {
      const body = await this.request<
        { service_response?: { data?: HaForecastRow[] } }
      >(
        token,
        options,
        `/api/services/${SOLCAST_DOMAIN}/${QUERY_ACTION}?return_response`,
        {
          start_date_time: new Date(startMs).toISOString(),
          end_date_time: new Date(startMs + days * DAY_MS).toISOString(),
        },
      );
      return toForecastPeriods(body.service_response?.data ?? []);
    } catch (err) {
      if (!(err instanceof RangeRefusedError)) throw err;
      if (shorter.length > 0) {
        return this.queryRange(token, options, startMs, shorter);
      }
      const detail = err.message ? ` (${err.message})` : "";
      throw new Error(
        `Home Assistant's Solcast integration has no forecast to give yet${detail}`,
      );
    }
  }

  private async request<T>(
    token: string,
    options: ForecastProviderOptions | undefined,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchFn(
      `${normaliseBaseUrl(options?.baseUrl)}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    ).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach Home Assistant: ${reason}`);
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new ForecastAuthError(
        "Home Assistant rejected the access token — check it in Settings",
      );
    }
    if (res.status === 400) {
      const detail = await res.json().catch(() => null) as
        | { message?: string }
        | null;
      throw new RangeRefusedError(detail?.message ?? "");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Home Assistant returned HTTP ${res.status}`);
    }
    return await res.json() as T;
  }
}

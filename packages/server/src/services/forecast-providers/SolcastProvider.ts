import type {
  SolarForecastPeriod,
  SolarForecastSite,
} from "@chargeha/shared/solarForecast";
import {
  ForecastAuthError,
  ForecastQuotaError,
  type SolarForecastProvider,
} from "./types.ts";

export const SOLCAST_API_BASE = "https://api.solcast.com.au";

// The hobbyist plan forecasts up to 7 days ahead. Asking for fewer hours
// costs the same single request, so always take the lot.
const FORECAST_HOURS = 168;
const TIMEOUT_MS = 30_000;

interface SolcastSite {
  resource_id: string;
  name?: string;
  capacity?: number;
}

interface SolcastForecast {
  period_end: string;
  period: string;
  pv_estimate: number;
  pv_estimate10?: number;
  pv_estimate90?: number;
}

// "PT30M" → 30, "PT1H" → 60. Solcast rooftop sites use 30 minutes.
export function parsePeriodMinutes(period: string): number {
  const match = period.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!match || (!match[1] && !match[2])) {
    throw new Error(`Unexpected Solcast period "${period}"`);
  }
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

// Solcast sends seven fractional digits ("…00.0000000Z"); keep three so
// every runtime parses it.
function parseSolcastTime(value: string): number {
  const ms = Date.parse(value.replace(/\.(\d{3})\d*Z$/, ".$1Z"));
  if (Number.isNaN(ms)) throw new Error(`Unexpected Solcast time "${value}"`);
  return ms;
}

// Solcast reports kW; periods are keyed by their end.
export function toForecastPeriod(f: SolcastForecast): SolarForecastPeriod {
  const periodMinutes = parsePeriodMinutes(f.period);
  const startMs = parseSolcastTime(f.period_end) - periodMinutes * 60_000;
  return {
    periodStart: new Date(startMs).toISOString(),
    periodMinutes,
    pvW: f.pv_estimate * 1000,
    pvW10: (f.pv_estimate10 ?? f.pv_estimate) * 1000,
    pvW90: (f.pv_estimate90 ?? f.pv_estimate) * 1000,
  };
}

async function errorFor(res: Response): Promise<Error> {
  const body = await res.json().catch(() => null) as {
    response_status?: { error_code?: string; message?: string };
  } | null;
  const detail = body?.response_status?.message;
  if (res.status === 401 || res.status === 403) {
    return new ForecastAuthError(
      "Solcast rejected the API key — check it in Settings",
    );
  }
  if (
    res.status === 429 &&
    body?.response_status?.error_code === "TooManyRequests"
  ) {
    return new ForecastQuotaError(
      detail ?? "Solcast's daily request limit has been reached",
    );
  }
  if (res.status === 429) {
    return new Error("Solcast is busy — the update will be retried");
  }
  if (res.status === 404) {
    return new Error("Solcast site not found — check the site ID");
  }
  return new Error(
    `Solcast returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
  );
}

export class SolcastProvider implements SolarForecastProvider {
  readonly id = "solcast" as const;
  readonly displayName = "Solcast";

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = SOLCAST_API_BASE,
  ) {}

  // Solcast does not count site listing against the quota.
  async listSites(apiKey: string): Promise<SolarForecastSite[]> {
    const data = await this.get<{ sites?: SolcastSite[] }>(
      apiKey,
      "/rooftop_sites",
      {},
    );
    return (data.sites ?? []).map((site) => ({
      id: site.resource_id,
      name: site.name || site.resource_id,
      capacityKw: typeof site.capacity === "number" ? site.capacity : null,
    }));
  }

  async fetchForecast(
    apiKey: string,
    siteId: string,
  ): Promise<SolarForecastPeriod[]> {
    const data = await this.get<{ forecasts?: SolcastForecast[] }>(
      apiKey,
      `/rooftop_sites/${encodeURIComponent(siteId)}/forecasts`,
      { hours: String(FORECAST_HOURS) },
    );
    return (data.forecasts ?? []).map(toForecastPeriod);
  }

  private async get<T>(
    apiKey: string,
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const query = new URLSearchParams({ format: "json", ...params });
    const res = await this.fetchFn(`${this.baseUrl}${path}?${query}`, {
      // Header auth keeps the key out of URLs and any logged request line.
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach Solcast: ${reason}`);
    });
    if (!res.ok) throw await errorFor(res);
    return await res.json() as T;
  }
}

// Solar production forecasts from an external provider (e.g. Solcast).
// Shared so the server, the client and the demo fixtures agree on shapes.

export const FORECAST_PROVIDERS = ["solcast", "homeassistant"] as const;
export type ForecastProviderId = typeof FORECAST_PROVIDERS[number];

export const FORECAST_PROVIDER_NAMES: Record<ForecastProviderId, string> = {
  solcast: "Solcast",
  homeassistant: "Home Assistant (Solcast integration)",
};

// Providers that hand over a forecast something else already fetched. They
// are reached at an address on the local network, and reading them costs
// nothing, so there is no daily quota to ration.
export const LOCAL_FORECAST_PROVIDERS: readonly ForecastProviderId[] = [
  "homeassistant",
];

export const isLocalForecastProvider = (
  id: ForecastProviderId | "" | null,
): boolean => !!id && LOCAL_FORECAST_PROVIDERS.includes(id);

// One forecast period. Power is the average over the period, in watts.
// pvW10/pvW90 are the 10th/90th percentile — a cloudy and a clear outcome.
export interface SolarForecastPeriod {
  periodStart: string; // ISO 8601, UTC
  periodMinutes: number;
  pvW: number;
  pvW10: number;
  pvW90: number;
}

// A PV system registered with the provider. Solcast calls it a rooftop site.
export interface SolarForecastSite {
  id: string;
  name: string;
  capacityKw: number | null;
}

// Days of history needed before the learned correction is used.
export const FORECAST_LEARN_MIN_DAYS = 7;

// How the system's output has compared with the forecast, hour by hour,
// learned from recent history. See docs/solar-forecast.md.
export interface ForecastCorrection {
  // Multiplier for each local hour of the day, 0–23. 1 where there is too
  // little history to say.
  hourFactors: number[];
  // Days of history it was learned from.
  days: number;
  learnedOn: string; // YYYY-MM-DD, local
}

// "waiting" until there are enough clear days to compare.
export type PanelCheckState = "ok" | "low" | "waiting";

// Whether the system is producing what it usually does on clear days.
export interface PanelCheck {
  state: PanelCheckState;
  // Output on the latest clear days as a share of the usual, e.g. 0.62.
  recentShare: number | null;
  // The latest clear days the check is based on (YYYY-MM-DD, local).
  recentDays: string[];
  checkedOn: string; // YYYY-MM-DD, local
}

export interface SolarForecastStatus {
  provider: ForecastProviderId | null;
  // Address of a local provider (Home Assistant). Empty for the others.
  baseUrl: string;
  apiKeySet: boolean;
  // Sites to forecast. Empty means every site on the account.
  siteIds: string[];
  dailyLimit: number;
  // Requests counted against the provider's daily quota so far.
  usedToday: number;
  lastFetchAt: string | null;
  lastError: string | null;
  // When the next automatic update will run, or null when none is planned.
  nextFetchAt: string | null;
  // Whether displayed forecasts use the learned correction.
  adjust: boolean;
  // Local time of the evening summary, "HH:MM".
  summaryTime: string;
  correction: ForecastCorrection | null;
  panelCheck: PanelCheck | null;
}

export interface SolarForecastDay {
  date: string; // YYYY-MM-DD, local
  forecastWh: number;
  forecastWh10: number;
  forecastWh90: number;
  // Measured production. Null for days that have not started.
  actualWh: number | null;
}

export interface SolarForecastSummaryPeriod extends SolarForecastPeriod {
  // Measured average power over the period. Null for future periods.
  actualW: number | null;
}

export interface SolarForecastSummary {
  today: SolarForecastDay & {
    // Forecast energy for the part of today that has already passed, so it
    // can be compared with what has actually been produced.
    forecastToNowWh: number;
    // Measured production over the same hours as forecastToNowWh.
    actualToNowWh: number;
    // Forecast energy still to come today.
    remainingWh: number;
  };
  // Today and the following days the provider covers, in order.
  days: SolarForecastDay[];
  // Today and tomorrow, one entry per forecast period.
  periods: SolarForecastSummaryPeriod[];
  updatedAt: string | null;
  // True when the figures include the learned correction.
  adjusted: boolean;
  // Set while the system is producing well under its usual clear-day output.
  panelLow: { recentShare: number } | null;
}

// What solar should add to a plugged-in car before the sun is done for
// the day. Expected uses the forecast; cautious its low end.
export interface SolarChargeProjection {
  vehicleId: string;
  expectedKwh: number;
  cautiousKwh: number;
  // Battery level then. Null until the battery size has been learned from
  // past charging.
  expectedPct: number | null;
  cautiousPct: number | null;
  limitPct: number;
  // When the sun is done for the day.
  untilAt: string;
  // When the expected solar reaches the limit, if it does before untilAt.
  limitAt: string | null;
}

export const periodEndMs = (period: SolarForecastPeriod): number =>
  Date.parse(period.periodStart) + period.periodMinutes * 60_000;

// Energy the period is forecast to produce between `startMs` and `endMs`.
// Power is spread evenly across a period, so a window covering half of it
// gets half its energy.
export function forecastWhBetween<P extends SolarForecastPeriod>(
  period: P,
  pick: (period: P) => number,
  startMs: number,
  endMs: number,
): number {
  const periodStartMs = Date.parse(period.periodStart);
  const overlapMs = Math.min(endMs, periodEndMs(period)) -
    Math.max(startMs, periodStartMs);
  if (overlapMs <= 0) return 0;
  return pick(period) * overlapMs / 3_600_000;
}

// Sum of forecast energy in each bucket. `edgesMs` holds the bucket
// boundaries, so n + 1 edges give n buckets.
export function bucketForecastWh<P extends SolarForecastPeriod>(
  periods: readonly P[],
  edgesMs: readonly number[],
  pick: (period: P) => number = (p) => p.pvW,
): number[] {
  return edgesMs.slice(1).map((endMs, i) =>
    periods.reduce(
      (sum, period) => sum + forecastWhBetween(period, pick, edgesMs[i], endMs),
      0,
    )
  );
}

// UTC instant of local midnight at the start of `date`, for a zone that is
// `offsetHours` ahead of UTC on that day.
export const localMidnightUtcMs = (date: string, offsetHours: number): number =>
  Date.parse(`${date}T00:00:00Z`) - offsetHours * 3_600_000;

// Power to compare against what happened. Past periods use the day-ahead
// forecast — what was expected before the day began — when there is one;
// the latest update for a period already underway is close to a
// measurement and would flatter the forecast.
export function effectiveForecastW(
  period: SolarForecastPeriod & { dayAheadW: number | null },
  nowMs: number,
): number {
  return periodEndMs(period) <= nowMs
    ? period.dayAheadW ?? period.pvW
    : period.pvW;
}

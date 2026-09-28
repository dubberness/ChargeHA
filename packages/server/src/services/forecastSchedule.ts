import {
  periodEndMs,
  type SolarForecastPeriod,
} from "@chargeha/shared/solarForecast";

// Picks when to spend the provider's small daily quota (Solcast's free plan
// allows 10 requests). Updates are spread evenly across daylight, which is
// read from the forecast itself — the hours it expects any production — so
// no sunrise maths or home location is needed. Nothing is fetched at night,
// when the forecast cannot change anything useful.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Never closer together than this, however large the quota.
export const MIN_INTERVAL_MS = 15 * MINUTE_MS;
// After a failed attempt (network, provider busy), wait this long.
export const RETRY_MS = 15 * MINUTE_MS;
// Older than this and the forecast is refreshed straight away — the server
// was probably down.
export const STALE_MS = 20 * HOUR_MS;
// With no daylight ahead in the stored forecast, check back this often.
export const NO_DAYLIGHT_RETRY_MS = HOUR_MS;

export interface DaylightRun {
  startMs: number;
  endMs: number;
}

// Contiguous stretches of periods forecast to produce anything, in order.
export function daylightRuns(
  periods: readonly SolarForecastPeriod[],
): DaylightRun[] {
  return [...periods]
    .filter((p) => p.pvW > 0 || p.pvW90 > 0)
    .sort((a, b) => Date.parse(a.periodStart) - Date.parse(b.periodStart))
    .reduce<DaylightRun[]>((runs, period) => {
      const startMs = Date.parse(period.periodStart);
      const endMs = periodEndMs(period);
      const last = runs.at(-1);
      if (last && last.endMs >= startMs) {
        return [...runs.slice(0, -1), { ...last, endMs }];
      }
      return [...runs, { startMs, endMs }];
    }, []);
}

// Solcast's quota resets at midnight UTC.
export const nextUtcMidnightMs = (nowMs: number): number => {
  const now = new Date(nowMs);
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
};

export interface FetchBudget {
  // Fetches the schedule plans per day (each costs one request per site).
  autoFetches: number;
  // Requests held back so "Update now" still works after the day's
  // automatic updates.
  reservedRequests: number;
}

export function fetchBudget(
  dailyLimit: number,
  siteCount: number,
): FetchBudget {
  const fetchesPerDay = Math.floor(dailyLimit / siteCount);
  const reserveOne = fetchesPerDay > 2;
  return {
    autoFetches: fetchesPerDay - (reserveOne ? 1 : 0),
    reservedRequests: reserveOne ? siteCount : 0,
  };
}

export interface ScheduleInput {
  nowMs: number;
  lastFetchMs: number | null;
  lastAttemptMs: number | null;
  lastAttemptFailed: boolean;
  usedToday: number;
  dailyLimit: number;
  siteCount: number;
  runs: readonly DaylightRun[];
}

// When the next automatic update should run (a time at or before now means
// "now"), or null when the quota cannot cover even one update.
export function planNextFetch(input: ScheduleInput): number | null {
  const { nowMs, dailyLimit, siteCount, usedToday } = input;
  if (siteCount < 1 || siteCount > dailyLimit) return null;
  const budget = fetchBudget(dailyLimit, siteCount);
  const quotaLeft = usedToday + siteCount <=
    dailyLimit - budget.reservedRequests;
  const quotaOpenMs = quotaLeft ? nowMs : nextUtcMidnightMs(nowMs);
  const retryMs = input.lastAttemptFailed && input.lastAttemptMs !== null
    ? input.lastAttemptMs + RETRY_MS
    : nowMs;
  return Math.max(scheduledMs(input, budget), quotaOpenMs, retryMs);
}

function scheduledMs(input: ScheduleInput, budget: FetchBudget): number {
  const { nowMs, lastFetchMs, runs } = input;
  if (lastFetchMs === null || nowMs - lastFetchMs >= STALE_MS) return nowMs;
  // First update at the start of daylight, last at its end, the rest
  // evenly between.
  const intervalMs = (run: DaylightRun): number => {
    if (budget.autoFetches <= 1) return Infinity;
    const spreadMs = (run.endMs - run.startMs) / (budget.autoFetches - 1);
    return Math.max(MIN_INTERVAL_MS, spreadMs);
  };
  const planned = runs
    .filter((run) => run.endMs > lastFetchMs)
    .map((run) => ({
      run,
      atMs: lastFetchMs < run.startMs
        ? run.startMs
        : lastFetchMs + intervalMs(run),
    }))
    .find(({ run, atMs }) => atMs <= run.endMs);
  return planned?.atMs ?? lastFetchMs + NO_DAYLIGHT_RETRY_MS;
}

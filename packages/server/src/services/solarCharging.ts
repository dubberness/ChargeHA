// How much solar a plugged-in car can expect to get: the forecast, less
// what the house typically uses at that hour, within what the charger can
// take, outside blockouts. Pure functions; SolarChargePlanner loads the
// data. Assumes the car stays plugged in at home through the window.
import {
  periodEndMs,
  type SolarForecastPeriod,
} from "@chargeha/shared/solarForecast";
import { localDateStr } from "@chargeha/shared/timezone";
import { localHour } from "./forecastLearning.ts";

const HOURS = 24;
// A charging session ends at a gap this long between readings.
const SESSION_GAP_MS = 10 * 60_000;
// Longest step between readings counted as charging at the earlier power.
const MAX_STEP_MS = 5 * 60_000;
// A session needs this much battery change to say anything about size.
const MIN_SESSION_PCT = 3;
// Total battery change needed before the size is trusted.
export const MIN_LEARNED_PCT = 15;
// kWh per percent outside this range (15–150 kWh batteries) is bad data.
const MIN_KWH_PER_PCT = 0.15;
const MAX_KWH_PER_PCT = 1.5;

export interface SurplusRules {
  // The charger's lowest and highest power, in watts at the wall.
  minChargeW: number;
  maxChargeW: number;
  // Solar below this starts nothing (minSolarGenerationKw).
  minGenerationW: number;
  // Kept back for the house (solarMarginKw).
  marginW: number;
  // "gross" tracks total production and ignores house load.
  reference: "excess" | "gross";
  // True when charging is blocked at that instant (a blockout).
  blockedAt: (ms: number) => boolean;
}

// Solar power the car gets during one forecast period, in watts.
export function carSolarW(
  pvW: number,
  houseW: number,
  rules: SurplusRules,
): number {
  if (pvW < rules.minGenerationW) return 0;
  const houseShare = rules.reference === "gross" ? 0 : houseW;
  const surplus = pvW - houseShare - rules.marginW;
  if (surplus < rules.minChargeW) return 0;
  return Math.min(rules.maxChargeW, surplus);
}

export interface SolarToCar {
  wh: number;
  // When the energy reaches `capWh`, if it does in the window.
  capReachedAtMs: number | null;
}

// Solar energy into the car between `fromMs` and `toMs`, stopping once
// `capWh` (room left below the limit) is reached.
export function solarToCar<P extends SolarForecastPeriod>(
  periods: readonly P[],
  pick: (period: P) => number,
  houseW: (ms: number) => number,
  rules: SurplusRules,
  fromMs: number,
  toMs: number,
  capWh = Infinity,
): SolarToCar {
  return periods.reduce<SolarToCar>((acc, period) => {
    if (acc.capReachedAtMs !== null) return acc;
    const startMs = Math.max(fromMs, Date.parse(period.periodStart));
    const endMs = Math.min(toMs, periodEndMs(period));
    if (endMs <= startMs) return acc;
    const midMs = (startMs + endMs) / 2;
    if (rules.blockedAt(midMs)) return acc;
    const w = carSolarW(pick(period), houseW(midMs), rules);
    if (w <= 0) return acc;
    const wh = w * (endMs - startMs) / 3_600_000;
    if (acc.wh + wh < capWh) return { wh: acc.wh + wh, capReachedAtMs: null };
    const fraction = (capWh - acc.wh) / wh;
    return {
      wh: capWh,
      capReachedAtMs: Math.round(startMs + fraction * (endMs - startMs)),
    };
  }, { wh: 0, capReachedAtMs: null });
}

// End of the last forecast period with any production in the window —
// the sun is done for the day after it.
export function lastSunMs<P extends SolarForecastPeriod>(
  periods: readonly P[],
  fromMs: number,
  toMs: number,
): number | null {
  const sunny = periods.filter((p) =>
    p.pvW > 0 && periodEndMs(p) > fromMs && Date.parse(p.periodStart) < toMs
  );
  if (sunny.length === 0) return null;
  return Math.min(toMs, Math.max(...sunny.map(periodEndMs)));
}

// ── House load ───────────────────────────────────────────────────────

export interface LoadBucket {
  startMs: number;
  // Average home consumption over the bucket.
  homeW: number;
  // Average car charging over the bucket, taken out of homeW when the
  // energy source counts the car as part of the house.
  carW: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const mean = (values: number[]): number =>
  values.reduce((a, b) => a + b, 0) / values.length;

// Typical house load for each local hour: the median across days of each
// day's average for that hour. The median ignores the odd day with the
// oven or heater on at an unusual hour. Hours with no history take the
// median of the others; with no history at all, zero.
export function houseLoadByHour(
  buckets: readonly LoadBucket[],
  timezone: string,
  includesCar: boolean,
): number[] {
  const byDayHour = buckets.reduce((acc, b) => {
    const key = `${localDateStr(new Date(b.startMs), timezone)} ${
      localHour(b.startMs, timezone)
    }`;
    const houseW = Math.max(0, includesCar ? b.homeW - b.carW : b.homeW);
    return acc.set(key, [...acc.get(key) ?? [], houseW]);
  }, new Map<string, number[]>());
  const perHour = Array.from(
    { length: HOURS },
    (_, hour) =>
      [...byDayHour.entries()]
        .filter(([key]) => Number(key.split(" ")[1]) === hour)
        .map(([, values]) => mean(values)),
  );
  const known = perHour.filter((days) => days.length > 0).map(median);
  const fallback = known.length > 0 ? median(known) : 0;
  return perHour.map((days) =>
    Math.round(days.length > 0 ? median(days) : fallback)
  );
}

// ── Battery size ─────────────────────────────────────────────────────

export interface ChargeReading {
  ms: number;
  powerW: number;
  batteryLevel: number | null;
}

// Energy per battery percent, learned from past charging sessions, or
// null until they add up to MIN_LEARNED_PCT of charge. Charger power is
// measured at the wall, so charging losses are included — which is what
// turning solar energy into battery percent needs.
export function learnKwhPerPercent(
  readings: readonly ChargeReading[],
): number | null {
  const charging = readings.filter((r) => r.powerW > 0)
    .toSorted((a, b) => a.ms - b.ms);
  const sessions = charging.reduce<ChargeReading[][]>((acc, r) => {
    const current = acc[acc.length - 1];
    const previous = current?.[current.length - 1];
    if (!previous || r.ms - previous.ms > SESSION_GAP_MS) {
      return [...acc, [r]];
    }
    current.push(r);
    return acc;
  }, []);
  const totals = sessions.map((session) => {
    const levels = session.map((r) => r.batteryLevel)
      .filter((l): l is number => l !== null);
    const pct = levels.length > 1 ? levels[levels.length - 1] - levels[0] : 0;
    const wh = session.slice(0, -1).reduce(
      (sum, r, i) =>
        sum + r.powerW * Math.min(session[i + 1].ms - r.ms, MAX_STEP_MS) /
          3_600_000,
      0,
    );
    return { pct, wh };
  }).filter((s) => s.pct >= MIN_SESSION_PCT);
  const pct = totals.reduce((sum, s) => sum + s.pct, 0);
  if (pct < MIN_LEARNED_PCT) return null;
  const kwhPerPct = totals.reduce((sum, s) => sum + s.wh, 0) / pct / 1000;
  if (kwhPerPct < MIN_KWH_PER_PCT || kwhPerPct > MAX_KWH_PER_PCT) return null;
  return Math.round(kwhPerPct * 1000) / 1000;
}

// ── Schedule windows ─────────────────────────────────────────────────

const STEP_MS = 5 * 60_000;
const SCAN_MS = 8 * 86_400_000;

// When the window `isActive` is in at `nowMs` ends, and when it next
// starts after that. Found by stepping forward 5 minutes at a time, which
// matches schedules set to the minute closely enough for a forecast.
export function windowAfter(
  isActive: (ms: number) => boolean,
  nowMs: number,
): { endMs: number; nextStartMs: number | null } | null {
  const steps = Math.ceil(SCAN_MS / STEP_MS);
  const aligned = Math.floor(nowMs / STEP_MS) * STEP_MS;
  const at = (i: number) => aligned + i * STEP_MS;
  const endIndex = Array.from({ length: steps }, (_, i) => i + 1)
    .find((i) => !isActive(at(i)));
  if (endIndex === undefined) return null;
  const nextIndex = Array.from(
    { length: steps - endIndex },
    (_, i) => endIndex + i + 1,
  ).find((i) => isActive(at(i)));
  return {
    endMs: at(endIndex),
    nextStartMs: nextIndex === undefined ? null : at(nextIndex),
  };
}

// Learning from how the system's output has compared with the forecast:
// an hour-by-hour correction for the displayed forecast, and a check that
// the panels are still producing what they usually do on clear days.
// Pure functions; ForecastLearner loads the data and stores the results.
import { z } from "zod";
import {
  FORECAST_LEARN_MIN_DAYS,
  type ForecastCorrection,
  type PanelCheck,
  periodEndMs,
  type SolarForecastPeriod,
} from "@chargeha/shared/solarForecast";
import { localDateStr } from "@chargeha/shared/timezone";

const BUCKET_MS = 15 * 60_000;
const HOURS = 24;

// Correction factors stay in this range: a heavily shaded hour can make a
// fraction of its forecast, but a factor far outside it is more likely bad
// data than the roof.
const MIN_FACTOR = 0.3;
const MAX_FACTOR = 1.5;
// Each hour's factor starts from "the forecast is right" with this share of
// the busiest hour's forecast energy as weight, so a dawn hour with a few
// watt-hours of history moves only a little.
const PRIOR_SHARE = 0.03;

// A clear day: the forecast made during the day expected most of what the
// sunniest recent day did, and was sure of it (narrow 10–90% range).
const CLEAR_MIN_SHARE_OF_SUNNIEST = 0.6;
const CLEAR_MAX_SPREAD = 0.25;
// A day counts only when readings cover this much of its forecast energy.
const MIN_DAY_COVERAGE = 0.9;
// The check compares the latest clear days with the usual before them.
const RECENT_CLEAR_DAYS = 3;
const RECENT_WITHIN_DAYS = 10;
const MIN_BASELINE_DAYS = 3;
// Output under this share of the usual on every recent clear day is low.
const LOW_SHARE = 0.75;

export interface SolarBucket {
  startMs: number;
  avgW: number;
  readings: number;
}

// One past forecast period next to what was measured over it.
export interface PeriodSample {
  date: string; // local
  hour: number; // local, 0–23
  // Forecast from before the day began. Null when none was fetched in time.
  dayAheadWh: number | null;
  // Last forecast made before the period ended — close to what the weather
  // actually did.
  latestWh: number;
  latest10Wh: number;
  latest90Wh: number;
  // Null when the readings have a gap over the period.
  actualWh: number | null;
}

export interface DayTotals {
  date: string;
  // Summed over the periods that have readings.
  latestWh: number;
  latest10Wh: number;
  latest90Wh: number;
  actualWh: number;
  // Share of the day's forecast energy that has readings.
  coverage: number;
}

const hourFormats = new Map<string, Intl.DateTimeFormat>();

const hourFormat = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hourCycle: "h23",
  });

// Local hour of an instant. Formatters are cached — this runs for every
// forecast period on every summary.
export function localHour(ms: number, timezone: string): number {
  const format = hourFormats.get(timezone) ?? hourFormat(timezone);
  hourFormats.set(timezone, format);
  return Number(format.format(ms)) % HOURS;
}

// Energy measured over a period, or null when any of its buckets is
// missing or short of readings.
export function measuredWh(
  period: SolarForecastPeriod,
  buckets: ReadonlyMap<number, SolarBucket>,
  minReadings: number,
): number | null {
  const startMs = Date.parse(period.periodStart);
  const count = Math.round((periodEndMs(period) - startMs) / BUCKET_MS);
  const covering = Array.from(
    { length: count },
    (_, i) => buckets.get(startMs + i * BUCKET_MS),
  );
  if (covering.some((b) => !b || b.readings < minReadings)) return null;
  return covering.reduce(
    (wh, b) => wh + (b?.avgW ?? 0) * BUCKET_MS / 3_600_000,
    0,
  );
}

export function samplePeriods(
  periods: ReadonlyArray<SolarForecastPeriod & { dayAheadW: number | null }>,
  buckets: readonly SolarBucket[],
  timezone: string,
  minReadings: number,
): PeriodSample[] {
  const byStart = new Map(buckets.map((b) => [b.startMs, b]));
  return periods.map((period) => {
    const startMs = Date.parse(period.periodStart);
    const hours = period.periodMinutes / 60;
    return {
      date: localDateStr(new Date(startMs), timezone),
      hour: localHour(startMs, timezone),
      dayAheadWh: period.dayAheadW === null ? null : period.dayAheadW * hours,
      latestWh: period.pvW * hours,
      latest10Wh: period.pvW10 * hours,
      latest90Wh: period.pvW90 * hours,
      actualWh: measuredWh(period, byStart, minReadings),
    };
  });
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

// Hour-by-hour ratio of measured output to the day-ahead forecast, summed
// over the samples. Summing weights sunny days most, which is where a
// shaded hour or a mis-set roof shows clearly; cloudy days' misses mostly
// cancel out. Needs FORECAST_LEARN_MIN_DAYS of history, else every factor is 1.
export function learnCorrection(
  samples: readonly PeriodSample[],
  learnedOn: string,
): ForecastCorrection {
  const usable = samples.filter((s) =>
    s.dayAheadWh !== null && s.actualWh !== null
  );
  const sumByHour = (pick: (s: PeriodSample) => number) =>
    Array.from(
      { length: HOURS },
      (_, h) =>
        usable.filter((s) => s.hour === h).reduce((t, s) => t + pick(s), 0),
    );
  const forecast = sumByHour((s) => s.dayAheadWh ?? 0);
  const actual = sumByHour((s) => s.actualWh ?? 0);
  const days = new Set(
    usable.filter((s) => (s.dayAheadWh ?? 0) > 0).map((s) => s.date),
  );
  if (days.size < FORECAST_LEARN_MIN_DAYS) {
    return {
      hourFactors: new Array(HOURS).fill(1),
      days: days.size,
      learnedOn,
    };
  }
  const prior = PRIOR_SHARE * Math.max(...forecast);
  const hourFactors = forecast.map((f, h) =>
    f <= 0 ? 1 : round2(
      clamp((actual[h] + prior) / (f + prior), MIN_FACTOR, MAX_FACTOR),
    )
  );
  return { hourFactors, days: days.size, learnedOn };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Scales each period — latest, range and day-ahead alike — by its local
// hour's factor.
export function applyCorrection<
  P extends SolarForecastPeriod & { dayAheadW: number | null },
>(
  periods: readonly P[],
  hourFactors: readonly number[],
  timezone: string,
): P[] {
  return periods.map((period) => {
    const factor =
      hourFactors[localHour(Date.parse(period.periodStart), timezone)] ?? 1;
    if (factor === 1) return period;
    return {
      ...period,
      pvW: period.pvW * factor,
      pvW10: period.pvW10 * factor,
      pvW90: period.pvW90 * factor,
      dayAheadW: period.dayAheadW === null ? null : period.dayAheadW * factor,
    };
  });
}

export function dailyTotals(samples: readonly PeriodSample[]): DayTotals[] {
  const dates = [...new Set(samples.map((s) => s.date))].sort();
  return dates.map((date) => samples.filter((s) => s.date === date))
    .map((day) => {
      const date = day[0].date;
      const measured = day.filter((s) => s.actualWh !== null);
      const sum = (list: PeriodSample[], pick: (s: PeriodSample) => number) =>
        list.reduce((total, s) => total + pick(s), 0);
      const forecastWh = sum(day, (s) => s.latestWh);
      const latestWh = sum(measured, (s) => s.latestWh);
      return {
        date,
        latestWh,
        latest10Wh: sum(measured, (s) => s.latest10Wh),
        latest90Wh: sum(measured, (s) => s.latest90Wh),
        actualWh: sum(measured, (s) => s.actualWh ?? 0),
        coverage: forecastWh > 0 ? latestWh / forecastWh : 0,
      };
    });
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const daysBetween = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
  86_400_000;

// Compares output on the latest clear days with the system's usual
// clear-day output, both as a share of the forecast made during the day.
// Relative to its own usual, so a forecast that always runs high or low
// for this roof does not matter. Weather is taken out by using only clear
// days; a gap in the readings by leaving out days they do not cover.
export function checkPanels(
  days: readonly DayTotals[],
  checkedOn: string,
): PanelCheck {
  const sunniest = Math.max(0, ...days.map((d) => d.latestWh));
  const clear = days.filter((d) =>
    d.coverage >= MIN_DAY_COVERAGE &&
    d.latestWh > 0 &&
    d.latestWh >= CLEAR_MIN_SHARE_OF_SUNNIEST * sunniest &&
    (d.latest90Wh - d.latest10Wh) / d.latestWh <= CLEAR_MAX_SPREAD
  );
  const ratio = (d: DayTotals) => d.actualWh / d.latestWh;
  const recent = clear.slice(-RECENT_CLEAR_DAYS)
    .filter((d) => daysBetween(d.date, checkedOn) <= RECENT_WITHIN_DAYS);
  const baseline = clear.slice(0, -RECENT_CLEAR_DAYS);
  const waiting: PanelCheck = {
    state: "waiting",
    recentShare: null,
    recentDays: [],
    checkedOn,
  };
  if (
    recent.length < RECENT_CLEAR_DAYS || baseline.length < MIN_BASELINE_DAYS
  ) {
    return waiting;
  }
  const usual = median(baseline.map(ratio));
  if (usual <= 0) return waiting;
  const shares = recent.map((d) => ratio(d) / usual);
  return {
    state: shares.every((s) => s < LOW_SHARE) ? "low" : "ok",
    recentShare: round2(shares.reduce((a, b) => a + b, 0) / shares.length),
    recentDays: recent.map((d) => d.date),
    checkedOn,
  };
}

// ── Stored results ────────────────────────────────────────────────────

const correctionSchema = z.object({
  hourFactors: z.array(z.number()).length(HOURS),
  days: z.number(),
  learnedOn: z.string(),
});

const panelCheckSchema = z.object({
  state: z.enum(["ok", "low", "waiting"]),
  recentShare: z.number().nullable(),
  recentDays: z.array(z.string()),
  checkedOn: z.string(),
});

const parseJson = <T>(raw: string, schema: z.ZodType<T>): T | null => {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const parseCorrection = (raw: string): ForecastCorrection | null =>
  parseJson(raw, correctionSchema);

export const parsePanelCheck = (raw: string): PanelCheck | null =>
  parseJson(raw, panelCheckSchema);

// Factors to scale displayed forecasts by, or null when the correction is
// switched off or still learning.
export function activeFactors(
  adjust: boolean,
  correction: ForecastCorrection | null,
): number[] | null {
  if (!adjust || !correction) return null;
  if (correction.days < FORECAST_LEARN_MIN_DAYS) return null;
  return correction.hourFactors;
}

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  activeFactors,
  applyCorrection,
  checkPanels,
  dailyTotals,
  type DayTotals,
  learnCorrection,
  localHour,
  measuredWh,
  parseCorrection,
  type PeriodSample,
  samplePeriods,
} from "./forecastLearning.ts";

const ms = (iso: string) => Date.parse(iso);

const dateAfter = (start: string, days: number) =>
  new Date(ms(`${start}T00:00:00Z`) + days * 86_400_000)
    .toISOString().slice(0, 10);

describe("forecastLearning", () => {
  describe("localHour", () => {
    it("gives the hour in the site's zone", () => {
      expect(localHour(ms("2026-09-28T00:30:00Z"), "UTC")).toBe(0);
      expect(localHour(ms("2026-09-28T00:30:00Z"), "Australia/Hobart"))
        .toBe(10);
      // Daylight saving has started by November.
      expect(localHour(ms("2026-11-28T00:30:00Z"), "Australia/Hobart"))
        .toBe(11);
    });
  });

  describe("measuredWh", () => {
    const period = {
      periodStart: "2026-09-28T02:00:00Z",
      periodMinutes: 30,
      pvW: 4000,
      pvW10: 2000,
      pvW90: 5000,
    };
    const bucket = (iso: string, avgW: number, readings = 15) => ({
      startMs: ms(iso),
      avgW,
      readings,
    });
    const byStart = (...buckets: ReturnType<typeof bucket>[]) =>
      new Map(buckets.map((b) => [b.startMs, b]));

    it("adds up the period's 15-minute buckets", () => {
      const buckets = byStart(
        bucket("2026-09-28T02:00:00Z", 2000),
        bucket("2026-09-28T02:15:00Z", 4000),
      );
      expect(measuredWh(period, buckets, 12)).toBe(1500);
    });

    it("gives nothing when a bucket is missing", () => {
      const buckets = byStart(bucket("2026-09-28T02:00:00Z", 2000));
      expect(measuredWh(period, buckets, 12)).toBeNull();
    });

    it("gives nothing when a bucket is short of readings", () => {
      const buckets = byStart(
        bucket("2026-09-28T02:00:00Z", 2000),
        bucket("2026-09-28T02:15:00Z", 4000, 5),
      );
      expect(measuredWh(period, buckets, 12)).toBeNull();
    });
  });

  describe("samplePeriods", () => {
    it("converts power to energy and keeps a missing day-ahead missing", () => {
      const [sample] = samplePeriods(
        [{
          periodStart: "2026-09-28T02:00:00Z",
          periodMinutes: 30,
          pvW: 4000,
          pvW10: 2000,
          pvW90: 5000,
          dayAheadW: null,
        }],
        [],
        "UTC",
        12,
      );
      expect(sample).toEqual({
        date: "2026-09-28",
        hour: 2,
        dayAheadWh: null,
        latestWh: 2000,
        latest10Wh: 1000,
        latest90Wh: 2500,
        actualWh: null,
      });
    });
  });

  // One sample per hour listed, every day, at the given actual share.
  const history = (
    days: number,
    hours: Record<number, { forecastWh: number; actualShare: number }>,
  ): PeriodSample[] =>
    Array.from({ length: days }, (_, d) => dateAfter("2026-09-01", d))
      .flatMap((date) =>
        Object.entries(hours).map(([hour, { forecastWh, actualShare }]) => ({
          date,
          hour: Number(hour),
          dayAheadWh: forecastWh,
          latestWh: forecastWh,
          latest10Wh: forecastWh,
          latest90Wh: forecastWh,
          actualWh: forecastWh * actualShare,
        }))
      );

  describe("learnCorrection", () => {
    it("leaves the forecast alone until there are enough days", () => {
      const correction = learnCorrection(
        history(6, { 8: { forecastWh: 1000, actualShare: 0.5 } }),
        "2026-09-28",
      );
      expect(correction.days).toBe(6);
      expect(correction.hourFactors.every((f) => f === 1)).toBe(true);
    });

    it("learns each hour's share of the forecast", () => {
      const { hourFactors, days } = learnCorrection(
        history(14, {
          8: { forecastWh: 1000, actualShare: 0.5 },
          12: { forecastWh: 3000, actualShare: 1.1 },
        }),
        "2026-09-28",
      );
      expect(days).toBe(14);
      expect(hourFactors[8]).toBeCloseTo(0.54, 2);
      expect(hourFactors[12]).toBeCloseTo(1.1, 2);
      expect(hourFactors[3]).toBe(1);
    });

    it("keeps factors within limits", () => {
      const { hourFactors } = learnCorrection(
        history(14, {
          8: { forecastWh: 1000, actualShare: 0 },
          12: { forecastWh: 3000, actualShare: 3 },
        }),
        "2026-09-28",
      );
      expect(hourFactors[8]).toBe(0.3);
      expect(hourFactors[12]).toBe(1.5);
    });

    it("skips periods without readings or a day-ahead forecast", () => {
      const samples = history(14, { 8: { forecastWh: 1000, actualShare: 1 } })
        .map((s, i) =>
          i % 2 ? { ...s, actualWh: null } : { ...s, dayAheadWh: null }
        );
      expect(learnCorrection(samples, "2026-09-28").days).toBe(0);
    });
  });

  describe("applyCorrection", () => {
    it("scales the forecast, its range and the day-ahead value", () => {
      const factors = Array.from({ length: 24 }, (_, h) => h === 2 ? 0.5 : 1);
      const [scaled, untouched] = applyCorrection(
        [
          {
            periodStart: "2026-09-28T02:00:00Z",
            periodMinutes: 30,
            pvW: 4000,
            pvW10: 2000,
            pvW90: 5000,
            dayAheadW: 3000,
          },
          {
            periodStart: "2026-09-28T03:00:00Z",
            periodMinutes: 30,
            pvW: 4000,
            pvW10: 2000,
            pvW90: 5000,
            dayAheadW: null,
          },
        ],
        factors,
        "UTC",
      );
      expect(scaled).toMatchObject({
        pvW: 2000,
        pvW10: 1000,
        pvW90: 2500,
        dayAheadW: 1500,
      });
      expect(untouched.pvW).toBe(4000);
    });
  });

  describe("dailyTotals", () => {
    it("sums measured periods and reports how much of the day they cover", () => {
      const samples = history(1, {
        10: { forecastWh: 3000, actualShare: 1 },
        11: { forecastWh: 1000, actualShare: 1 },
      });
      const [day] = dailyTotals([samples[0], {
        ...samples[1],
        actualWh: null,
      }]);
      expect(day).toMatchObject({
        date: "2026-09-01",
        latestWh: 3000,
        actualWh: 3000,
        coverage: 0.75,
      });
    });
  });

  describe("checkPanels", () => {
    const clearDay = (i: number, share: number): DayTotals => ({
      date: dateAfter("2026-09-01", i),
      latestWh: 30_000,
      latest10Wh: 28_000,
      latest90Wh: 31_000,
      actualWh: 30_000 * share,
      coverage: 1,
    });
    const cloudyDay = (i: number): DayTotals => ({
      ...clearDay(i, 0.3),
      latestWh: 8_000,
      latest10Wh: 3_000,
      latest90Wh: 15_000,
      actualWh: 2_000,
    });
    // Seven usual clear days, then the given recent ones.
    const days = (...recent: DayTotals[]) => [
      ...Array.from({ length: 7 }, (_, i) => clearDay(i, 0.9)),
      ...recent,
    ];
    const checkedOn = "2026-09-14";

    it("waits for enough clear days", () => {
      expect(checkPanels(days().slice(0, 4), checkedOn).state)
        .toBe("waiting");
    });

    it("is normal when recent clear days match the usual", () => {
      const check = checkPanels(
        days(clearDay(10, 0.88), clearDay(11, 0.9), clearDay(12, 0.92)),
        checkedOn,
      );
      expect(check).toEqual({
        state: "ok",
        recentShare: 1,
        recentDays: ["2026-09-11", "2026-09-12", "2026-09-13"],
        checkedOn,
      });
    });

    it("is low when every recent clear day is well under the usual", () => {
      const check = checkPanels(
        days(
          clearDay(10, 0.55),
          cloudyDay(11),
          clearDay(12, 0.5),
          clearDay(13, 0.6),
        ),
        checkedOn,
      );
      expect(check.state).toBe("low");
      expect(check.recentShare).toBeCloseTo(0.61, 2);
    });

    it("is not low when one recent clear day is normal", () => {
      const check = checkPanels(
        days(clearDay(10, 0.5), clearDay(11, 0.9), clearDay(12, 0.5)),
        checkedOn,
      );
      expect(check.state).toBe("ok");
    });

    it("ignores days the readings do not cover", () => {
      const gap = { ...clearDay(12, 0.2), coverage: 0.5 };
      const check = checkPanels(
        days(clearDay(9, 0.9), clearDay(10, 0.9), clearDay(11, 0.9), gap),
        checkedOn,
      );
      expect(check.state).toBe("ok");
    });

    it("waits when the latest clear days are too long ago", () => {
      expect(checkPanels(days(), "2026-09-30").state).toBe("waiting");
    });
  });

  describe("stored results", () => {
    it("reads back a stored correction and rejects a malformed one", () => {
      const correction = {
        hourFactors: new Array(24).fill(1),
        days: 9,
        learnedOn: "2026-09-28",
      };
      expect(parseCorrection(JSON.stringify(correction))).toEqual(correction);
      expect(parseCorrection('{"hourFactors":[1]}')).toBeNull();
      expect(parseCorrection("not json")).toBeNull();
      expect(parseCorrection("")).toBeNull();
    });

    it("applies the correction only when on and learned", () => {
      const learned = {
        hourFactors: new Array(24).fill(0.9),
        days: 7,
        learnedOn: "2026-09-28",
      };
      expect(activeFactors(true, learned)).toEqual(learned.hourFactors);
      expect(activeFactors(false, learned)).toBeNull();
      expect(activeFactors(true, { ...learned, days: 6 })).toBeNull();
      expect(activeFactors(true, null)).toBeNull();
    });
  });
});

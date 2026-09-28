import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  bucketForecastWh,
  effectiveForecastW,
  forecastWhBetween,
  localMidnightUtcMs,
  type SolarForecastPeriod,
} from "./solarForecast.ts";

describe("solarForecast", () => {
  const period = (
    periodStart: string,
    pvW: number,
    periodMinutes = 30,
  ): SolarForecastPeriod => ({
    periodStart,
    periodMinutes,
    pvW,
    pvW10: pvW / 2,
    pvW90: pvW * 2,
  });
  const ms = (iso: string) => Date.parse(iso);

  describe("forecastWhBetween", () => {
    it("gives a whole period's energy when the window covers it", () => {
      const p = period("2026-09-28T02:00:00Z", 4000);
      expect(
        forecastWhBetween(
          p,
          (x) => x.pvW,
          ms("2026-09-28T00:00:00Z"),
          ms("2026-09-28T03:00:00Z"),
        ),
      ).toBe(2000);
    });

    it("splits a period evenly across a window that cuts it", () => {
      const p = period("2026-09-28T02:00:00Z", 4000);
      expect(
        forecastWhBetween(
          p,
          (x) => x.pvW,
          ms("2026-09-28T02:15:00Z"),
          ms("2026-09-28T03:00:00Z"),
        ),
      ).toBe(1000);
    });

    it("gives nothing outside the window", () => {
      const p = period("2026-09-28T02:00:00Z", 4000);
      expect(
        forecastWhBetween(
          p,
          (x) => x.pvW,
          ms("2026-09-28T02:30:00Z"),
          ms("2026-09-28T03:00:00Z"),
        ),
      ).toBe(0);
    });
  });

  describe("bucketForecastWh", () => {
    it("sums periods into each bucket", () => {
      const periods = [
        period("2026-09-28T00:00:00Z", 2000),
        period("2026-09-28T00:30:00Z", 4000),
        period("2026-09-28T01:00:00Z", 6000),
      ];
      const edges = [
        ms("2026-09-28T00:00:00Z"),
        ms("2026-09-28T01:00:00Z"),
        ms("2026-09-28T02:00:00Z"),
      ];
      expect(bucketForecastWh(periods, edges)).toEqual([3000, 3000]);
    });

    it("uses the picked estimate", () => {
      const periods = [period("2026-09-28T00:00:00Z", 2000)];
      const edges = [ms("2026-09-28T00:00:00Z"), ms("2026-09-28T01:00:00Z")];
      expect(bucketForecastWh(periods, edges, (p) => p.pvW90)).toEqual([2000]);
    });

    it("splits 30-minute periods across 15-minute buckets", () => {
      const periods = [period("2026-09-28T00:00:00Z", 2000)];
      const edges = [0, 1, 2].map((i) =>
        ms("2026-09-28T00:00:00Z") + i * 15 * 60_000
      );
      expect(bucketForecastWh(periods, edges)).toEqual([500, 500]);
    });
  });

  describe("effectiveForecastW", () => {
    const now = ms("2026-09-28T03:00:00Z");

    it("uses the day-ahead forecast for a finished period", () => {
      const p = { ...period("2026-09-28T02:00:00Z", 4000), dayAheadW: 3000 };
      expect(effectiveForecastW(p, now)).toBe(3000);
    });

    it("falls back to the latest forecast without a day-ahead one", () => {
      const p = { ...period("2026-09-28T02:00:00Z", 4000), dayAheadW: null };
      expect(effectiveForecastW(p, now)).toBe(4000);
    });

    it("uses the latest forecast for periods still to come", () => {
      const p = { ...period("2026-09-28T03:00:00Z", 4000), dayAheadW: 3000 };
      expect(effectiveForecastW(p, now)).toBe(4000);
    });
  });

  describe("localMidnightUtcMs", () => {
    it("moves local midnight back by the zone offset", () => {
      expect(new Date(localMidnightUtcMs("2026-09-28", 10)).toISOString())
        .toBe("2026-09-27T14:00:00.000Z");
    });

    it("handles zones behind UTC and half hours", () => {
      expect(new Date(localMidnightUtcMs("2026-09-28", -4)).toISOString())
        .toBe("2026-09-28T04:00:00.000Z");
      expect(new Date(localMidnightUtcMs("2026-09-28", 9.5)).toISOString())
        .toBe("2026-09-27T14:30:00.000Z");
    });
  });
});

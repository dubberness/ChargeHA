import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SolarForecastPeriod } from "@chargeha/shared/solarForecast";
import {
  daylightRuns,
  fetchBudget,
  MIN_INTERVAL_MS,
  nextUtcMidnightMs,
  NO_DAYLIGHT_RETRY_MS,
  planNextFetch,
  RETRY_MS,
  type ScheduleInput,
  STALE_MS,
} from "./forecastSchedule.ts";

describe("forecastSchedule", () => {
  const ms = (iso: string) => Date.parse(iso);
  const iso = (value: number | null) =>
    value === null ? null : new Date(value).toISOString();
  const period = (periodStart: string, pvW: number): SolarForecastPeriod => ({
    periodStart,
    periodMinutes: 30,
    pvW,
    pvW10: pvW,
    pvW90: pvW,
  });
  // Daylight 06:00–18:00 UTC on the 28th and 29th.
  const runs = [
    { startMs: ms("2026-09-28T06:00:00Z"), endMs: ms("2026-09-28T18:00:00Z") },
    { startMs: ms("2026-09-29T06:00:00Z"), endMs: ms("2026-09-29T18:00:00Z") },
  ];
  const input = (overrides: Partial<ScheduleInput>): ScheduleInput => ({
    nowMs: ms("2026-09-28T09:00:00Z"),
    lastFetchMs: ms("2026-09-28T06:00:00Z"),
    lastAttemptMs: ms("2026-09-28T06:00:00Z"),
    lastAttemptFailed: false,
    usedToday: 1,
    dailyLimit: 10,
    siteCount: 1,
    runs,
    ...overrides,
  });

  describe("daylightRuns", () => {
    it("merges consecutive producing periods and skips the night", () => {
      expect(daylightRuns([
        period("2026-09-28T05:30:00Z", 0),
        period("2026-09-28T06:00:00Z", 100),
        period("2026-09-28T06:30:00Z", 900),
        period("2026-09-28T07:00:00Z", 0),
        period("2026-09-29T06:00:00Z", 50),
      ])).toEqual([
        {
          startMs: ms("2026-09-28T06:00:00Z"),
          endMs: ms("2026-09-28T07:00:00Z"),
        },
        {
          startMs: ms("2026-09-29T06:00:00Z"),
          endMs: ms("2026-09-29T06:30:00Z"),
        },
      ]);
    });
  });

  describe("fetchBudget", () => {
    it("holds one fetch back for a manual update", () => {
      expect(fetchBudget(10, 1)).toEqual({
        autoFetches: 9,
        reservedRequests: 1,
      });
    });

    it("counts one request per site", () => {
      expect(fetchBudget(10, 2)).toEqual({
        autoFetches: 4,
        reservedRequests: 2,
      });
    });

    it("keeps nothing back when the quota is tiny", () => {
      expect(fetchBudget(2, 1)).toEqual({
        autoFetches: 2,
        reservedRequests: 0,
      });
    });
  });

  describe("planNextFetch", () => {
    it("fetches straight away the first time", () => {
      const now = ms("2026-09-28T23:00:00Z");
      expect(planNextFetch(input({ nowMs: now, lastFetchMs: null }))).toBe(now);
    });

    it("fetches straight away when the forecast is stale", () => {
      const now = ms("2026-09-28T09:00:00Z");
      expect(planNextFetch(input({ nowMs: now, lastFetchMs: now - STALE_MS })))
        .toBe(now);
    });

    it("spreads the day's fetches evenly across daylight", () => {
      // 9 automatic fetches over 12 hours of daylight: every 90 minutes.
      expect(iso(planNextFetch(input({ nowMs: ms("2026-09-28T06:10:00Z") }))))
        .toBe("2026-09-28T07:30:00.000Z");
    });

    it("waits for the next sunrise after the last daylight fetch", () => {
      expect(iso(planNextFetch(input({
        nowMs: ms("2026-09-28T20:00:00Z"),
        lastFetchMs: ms("2026-09-28T18:00:00Z"),
      })))).toBe("2026-09-29T06:00:00.000Z");
    });

    it("fetches at sunrise when the last fetch was overnight", () => {
      expect(iso(planNextFetch(input({
        nowMs: ms("2026-09-28T05:00:00Z"),
        lastFetchMs: ms("2026-09-28T02:00:00Z"),
      })))).toBe("2026-09-28T06:00:00.000Z");
    });

    it("never fetches closer together than the minimum interval", () => {
      const planned = planNextFetch(input({
        nowMs: ms("2026-09-28T06:05:00Z"),
        dailyLimit: 1000,
      }));
      expect(planned).toBe(ms("2026-09-28T06:00:00Z") + MIN_INTERVAL_MS);
    });

    it("waits for the quota reset once the automatic share is used", () => {
      const now = ms("2026-09-28T09:00:00Z");
      expect(planNextFetch(input({ nowMs: now, usedToday: 9 })))
        .toBe(nextUtcMidnightMs(now));
    });

    it("backs off after a failed attempt", () => {
      const attempt = ms("2026-09-28T07:30:00Z");
      expect(planNextFetch(input({
        nowMs: ms("2026-09-28T07:35:00Z"),
        lastAttemptMs: attempt,
        lastAttemptFailed: true,
      }))).toBe(attempt + RETRY_MS);
    });

    it("checks back later when no daylight lies ahead", () => {
      const last = ms("2026-09-28T06:00:00Z");
      expect(planNextFetch(input({
        nowMs: ms("2026-09-28T06:30:00Z"),
        runs: [],
        lastFetchMs: last,
      })))
        .toBe(last + NO_DAYLIGHT_RETRY_MS);
    });

    it("plans nothing when one fetch costs more than the whole quota", () => {
      expect(planNextFetch(input({ dailyLimit: 1, siteCount: 2 }))).toBeNull();
    });
  });

  describe("nextUtcMidnightMs", () => {
    it("returns the next UTC midnight", () => {
      expect(iso(nextUtcMidnightMs(ms("2026-09-28T23:59:00Z"))))
        .toBe("2026-09-29T00:00:00.000Z");
    });
  });
});

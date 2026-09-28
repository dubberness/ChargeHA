import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { AppDatabase } from "../AppDatabase.ts";
import type { ForecastPeriodWrite } from "./ForecastRepository.ts";

describe("ForecastRepository", () => {
  let db: AppDatabase;

  beforeEach(async () => {
    db = new AppDatabase(":memory:");
    await db.init();
  });

  afterEach(() => {
    db.close();
  });

  const write = (
    periodStart: string,
    pvW: number,
    isDayAhead: boolean,
  ): ForecastPeriodWrite => ({
    periodStart,
    periodMinutes: 30,
    pvW,
    pvW10: pvW / 2,
    pvW90: pvW * 2,
    isDayAhead,
  });

  const read = () =>
    db.forecasts.getPeriods("2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z");

  it("stores and reads back periods in order", async () => {
    await db.forecasts.upsertPeriods([
      write("2026-09-28T02:30:00.000Z", 2000, false),
      write("2026-09-28T02:00:00.000Z", 1000, false),
    ], new Date("2026-09-28T01:00:00Z"));

    expect(await read()).toEqual([
      {
        periodStart: "2026-09-28T02:00:00Z",
        periodMinutes: 30,
        pvW: 1000,
        pvW10: 500,
        pvW90: 2000,
        dayAheadW: null,
      },
      {
        periodStart: "2026-09-28T02:30:00Z",
        periodMinutes: 30,
        pvW: 2000,
        pvW10: 1000,
        pvW90: 4000,
        dayAheadW: null,
      },
    ]);
  });

  it("keeps the last day-ahead value once the day has begun", async () => {
    const start = "2026-09-28T02:00:00.000Z";
    await db.forecasts.upsertPeriods(
      [write(start, 1000, true)],
      new Date("2026-09-27T05:00:00Z"),
    );
    await db.forecasts.upsertPeriods(
      [write(start, 1500, true)],
      new Date("2026-09-27T08:00:00Z"),
    );
    await db.forecasts.upsertPeriods(
      [write(start, 3000, false)],
      new Date("2026-09-28T01:00:00Z"),
    );

    const [period] = await read();
    expect(period.pvW).toBe(3000);
    expect(period.dayAheadW).toBe(1500);
  });

  it("returns only periods inside the range", async () => {
    await db.forecasts.upsertPeriods([
      write("2026-09-27T23:30:00.000Z", 1, false),
      write("2026-09-28T00:00:00.000Z", 2, false),
      write("2026-09-29T00:00:00.000Z", 3, false),
    ], new Date("2026-09-27T20:00:00Z"));

    const periods = await db.forecasts.getPeriods(
      "2026-09-28T00:00:00Z",
      "2026-09-29T00:00:00Z",
    );
    expect(periods.map((p) => p.pvW)).toEqual([2]);
  });

  it("prunes periods older than the retention window", async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    await db.forecasts.upsertPeriods(
      [write(old, 1, false), write(recent, 2, false)],
      new Date(),
    );

    await db.forecasts.prune(30);

    const periods = await db.forecasts.getPeriods(
      new Date(Date.now() - 50 * 86_400_000).toISOString(),
      new Date().toISOString(),
    );
    expect(periods.map((p) => p.pvW)).toEqual([2]);
  });
});

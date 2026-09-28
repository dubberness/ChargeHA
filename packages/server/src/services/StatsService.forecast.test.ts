import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { sql } from "drizzle-orm";
import { AppDatabase } from "../db/AppDatabase.ts";
import { StatsService } from "./StatsService.ts";

describe("StatsService solar forecast", () => {
  let db: AppDatabase;
  let stats: StatsService;

  beforeEach(async () => {
    db = new AppDatabase(":memory:");
    await db.init();
    await db.setConfig("timezone", "Australia/Brisbane"); // UTC+10, no DST
    stats = new StatsService(db, () => Date.parse("2026-09-28T04:00:00Z"));
  });

  afterEach(() => {
    db.close();
  });

  const forecast = async (
    periodStart: string,
    pvW: number,
    dayAheadW: number | null,
  ) => {
    await db.forecasts.upsertPeriods(
      [{
        periodStart,
        periodMinutes: 30,
        pvW,
        pvW10: pvW,
        pvW90: pvW,
        isDayAhead: false,
      }],
      new Date("2026-09-27T10:00:00Z"),
    );
    if (dayAheadW !== null) {
      await db.db.run(sql`
        UPDATE solar_forecasts SET day_ahead_w = ${dayAheadW}
        WHERE period_start = ${periodStart.replace("T", " ").slice(0, 19)}
      `);
    }
  };

  const reading = async (timestamp: string, solarW: number) => {
    await db.db.run(sql`
      INSERT INTO energy_readings
        (timestamp, solar_production_w, grid_power_w, home_consumption_w)
      VALUES (${timestamp}, ${solarW}, 0, 0)
    `);
  };

  it("leaves the response alone without a forecast", async () => {
    const day = await stats.buildDayStats("2026-09-28", undefined, false);
    expect(day.forecastSolarWh).toBeUndefined();
    expect(day.energyBuckets[10].forecastWh).toBeUndefined();
  });

  it("puts forecast energy into the local-hour buckets", async () => {
    // 00:00Z is 10:00 in Brisbane.
    await forecast("2026-09-28T00:00:00Z", 2000, null);
    await forecast("2026-09-28T00:30:00Z", 4000, null);

    const day = await stats.buildDayStats("2026-09-28", undefined, false);

    expect(day.energyBuckets[10].forecastWh).toBe(3000);
    // Hours outside the forecast have no value, not zero.
    expect(day.energyBuckets[9].forecastWh).toBeUndefined();
    expect(day.energyBuckets[11].forecastWh).toBeUndefined();
    expect(day.forecastSolarWh).toBe(3000);
  });

  it("compares finished hours against the day-ahead forecast", async () => {
    // 10:00 local has finished; 14:00 local (04:00Z) has not.
    await forecast("2026-09-28T00:00:00Z", 2000, 1600);
    await forecast("2026-09-28T04:00:00Z", 5000, 4000);
    await reading("2026-09-28 00:10:00", 1800);

    const day = await stats.buildDayStats("2026-09-28", undefined, false);

    expect(day.energyBuckets[10].forecastWh).toBe(800);
    expect(day.energyBuckets[14].forecastWh).toBe(2500);
    expect(day.forecastComparison).toEqual({ forecastWh: 800, actualWh: 30 });
  });

  it("splits periods across 15-minute buckets", async () => {
    await forecast("2026-09-28T00:00:00Z", 2000, null);

    const day = await stats.buildDayStats("2026-09-28", undefined, true);

    expect(day.energyBuckets[40].forecastWh).toBe(500);
    expect(day.energyBuckets[41].forecastWh).toBe(500);
    expect(day.energyBuckets[42].forecastWh).toBeUndefined();
  });

  it("totals the forecast per day in the month view", async () => {
    await forecast("2026-09-27T00:00:00Z", 2000, null);
    await forecast("2026-09-28T00:00:00Z", 4000, null);

    const month = await stats.buildMonthStats(2026, 9, undefined);

    expect(month.energyBuckets[26].forecastWh).toBe(1000);
    expect(month.energyBuckets[27].forecastWh).toBe(2000);
    expect(month.forecastSolarWh).toBe(3000);
  });

  it("totals the forecast per month in the year view", async () => {
    await forecast("2026-09-28T00:00:00Z", 4000, null);

    const year = await stats.buildYearStats(2026, undefined);

    expect(year.energyBuckets[8].forecastWh).toBe(2000);
    expect(year.forecastSolarWh).toBe(2000);
  });

  describe("with a learned correction", () => {
    const learn = (hourFactors: Record<number, number>, days = 14) =>
      db.setConfig(
        "forecast_correction",
        JSON.stringify({
          hourFactors: Array.from(
            { length: 24 },
            (_, h) => hourFactors[h] ?? 1,
          ),
          days,
          learnedOn: "2026-09-28",
        }),
      );

    it("scales the forecast by the local hour's factor", async () => {
      // 00:00Z is 10:00 in Brisbane.
      await forecast("2026-09-28T00:00:00Z", 2000, 1600);
      await learn({ 10: 0.5 });

      const day = await stats.buildDayStats("2026-09-28", undefined, false);

      expect(day.energyBuckets[10].forecastWh).toBe(400);
      expect(day.forecastSolarWh).toBe(400);
    });

    it("uses the forecast as it is when switched off or still learning", async () => {
      await forecast("2026-09-28T00:00:00Z", 2000, 1600);
      await learn({ 10: 0.5 }, 3);

      const learning = await stats.buildDayStats(
        "2026-09-28",
        undefined,
        false,
      );
      expect(learning.energyBuckets[10].forecastWh).toBe(800);

      await learn({ 10: 0.5 });
      await db.setConfig("forecast_adjust", "false");
      const off = await stats.buildDayStats("2026-09-28", undefined, false);
      expect(off.energyBuckets[10].forecastWh).toBe(800);
    });
  });
});

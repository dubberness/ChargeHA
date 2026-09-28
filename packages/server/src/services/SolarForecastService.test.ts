import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { sql } from "drizzle-orm";
import type {
  SolarForecastPeriod,
  SolarForecastSite,
} from "@chargeha/shared/solarForecast";
import { AppDatabase } from "../db/AppDatabase.ts";
import { Logger } from "../lib/Logger.ts";
import {
  FORECAST_API_KEY,
  parseSiteIds,
  SolarForecastService,
  sumSites,
} from "./SolarForecastService.ts";
import {
  ForecastQuotaError,
  type SolarForecastProvider,
} from "./forecast-providers/types.ts";

// Records every fetch; tests set `sites`, `forecasts` and `failWith`.
class FakeProvider implements SolarForecastProvider {
  readonly id = "solcast" as const;
  readonly displayName = "Solcast";
  sites: SolarForecastSite[] = [{ id: "site-a", name: "A", capacityKw: 5 }];
  failWith: Error | null = null;
  fetched: string[] = [];
  constructor(public forecasts: Record<string, SolarForecastPeriod[]>) {}
  listSites(_apiKey: string) {
    return Promise.resolve(this.sites);
  }
  fetchForecast(_apiKey: string, siteId: string) {
    this.fetched.push(siteId);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.forecasts[siteId] ?? []);
  }
}

describe("SolarForecastService", () => {
  let db: AppDatabase;
  let nowMs: number;

  const period = (periodStart: string, pvW: number): SolarForecastPeriod => ({
    periodStart,
    periodMinutes: 30,
    pvW,
    pvW10: pvW / 2,
    pvW90: pvW * 2,
  });

  const fakeProvider = () =>
    new FakeProvider({
      "site-a": [period("2026-09-28T02:00:00.000Z", 1000)],
      "site-b": [period("2026-09-28T02:00:00.000Z", 500)],
    });

  const setup = async (provider = fakeProvider()) => {
    const service = new SolarForecastService(
      db,
      [provider],
      new Logger("test", "error"),
      () => nowMs,
    );
    await service.saveSettings({ forecastProvider: "solcast", apiKey: "k1" });
    return { service, provider };
  };

  beforeEach(async () => {
    db = new AppDatabase(":memory:");
    await db.init();
    await db.setConfig("timezone", "UTC");
    nowMs = Date.parse("2026-09-28T01:00:00Z");
  });

  afterEach(() => {
    db.close();
  });

  describe("refresh", () => {
    it("stores the forecast and counts the request", async () => {
      const { service } = await setup();

      expect(await service.refresh()).toEqual({ success: true });

      const periods = await db.forecasts.getPeriods(
        "2026-09-28T00:00:00Z",
        "2026-09-29T00:00:00Z",
      );
      expect(periods.map((p) => p.pvW)).toEqual([1000]);
      const status = await service.getStatus();
      expect(status.usedToday).toBe(1);
      expect(status.lastFetchAt).toBe("2026-09-28T01:00:00.000Z");
      expect(status.lastError).toBeNull();
    });

    it("sums every site on the account, one request each", async () => {
      const provider = fakeProvider();
      provider.sites = [
        { id: "site-a", name: "East", capacityKw: 3 },
        { id: "site-b", name: "West", capacityKw: 3 },
      ];
      const { service } = await setup(provider);

      await service.refresh();

      const [stored] = await db.forecasts.getPeriods(
        "2026-09-28T00:00:00Z",
        "2026-09-29T00:00:00Z",
      );
      expect(stored.pvW).toBe(1500);
      expect((await service.getStatus()).usedToday).toBe(2);
    });

    it("fetches only the configured sites", async () => {
      const { service, provider } = await setup();
      await service.saveSettings({ forecastSiteIds: "site-b" });

      await service.refresh();

      expect(provider.fetched).toEqual(["site-b"]);
    });

    it("refuses once the daily limit is reached, without a request", async () => {
      const { service, provider } = await setup();
      await service.saveSettings({ forecastDailyLimit: 1 });
      await service.refresh();

      const second = await service.refresh();

      expect(second.success).toBe(false);
      expect(second.error).toContain("requests are used");
      expect(provider.fetched).toHaveLength(1);
    });

    it("marks the quota spent when the provider says so", async () => {
      const provider = fakeProvider();
      provider.failWith = new ForecastQuotaError("Daily limit exceeded");
      const { service } = await setup(provider);

      const result = await service.refresh();

      expect(result).toEqual({ success: false, error: "Daily limit exceeded" });
      const status = await service.getStatus();
      expect(status.usedToday).toBe(10);
      expect(status.lastError).toBe("Daily limit exceeded");
    });

    it("starts counting again on a new UTC day", async () => {
      const { service } = await setup();
      await service.refresh();

      nowMs = Date.parse("2026-09-29T00:05:00Z");

      expect((await service.getStatus()).usedToday).toBe(0);
    });

    it("records the day-ahead forecast only for later days", async () => {
      const provider = fakeProvider();
      provider.forecasts["site-a"] = [
        period("2026-09-28T02:00:00.000Z", 1000),
        period("2026-09-29T02:00:00.000Z", 2000),
      ];
      const { service } = await setup(provider);

      await service.refresh();

      const periods = await db.forecasts.getPeriods(
        "2026-09-28T00:00:00Z",
        "2026-09-30T00:00:00Z",
      );
      expect(periods.map((p) => p.dayAheadW)).toEqual([null, 2000]);
    });

    it("says so when it is not set up", async () => {
      const service = new SolarForecastService(
        db,
        [fakeProvider()],
        new Logger("test", "error"),
        () => nowMs,
      );
      expect((await service.refresh()).success).toBe(false);
    });
  });

  describe("tick", () => {
    it("fetches straight away after a key is saved", async () => {
      const { service, provider } = await setup();

      await service.tick();

      expect(provider.fetched).toEqual(["site-a"]);
    });

    it("does not fetch again until the schedule says so", async () => {
      const { service, provider } = await setup();
      await service.tick();

      nowMs += 60_000;
      await service.tick();

      expect(provider.fetched).toHaveLength(1);
    });
  });

  describe("settings", () => {
    it("reports whether a key is set but never the key", async () => {
      const { service } = await setup();

      const status = await service.getStatus();

      expect(status.apiKeySet).toBe(true);
      expect(JSON.stringify(status)).not.toContain("k1");
    });

    it("removes the key when saved blank", async () => {
      const { service } = await setup();

      await service.saveSettings({ apiKey: "" });

      expect(await db.readSecret(FORECAST_API_KEY)).toBeNull();
      expect((await service.getStatus()).nextFetchAt).toBeNull();
    });

    it("tests a key by listing its sites", async () => {
      const { service } = await setup();

      expect(await service.testKey("new-key")).toEqual({
        success: true,
        sites: [{ id: "site-a", name: "A", capacityKw: 5 }],
      });
    });

    it("tests with the provider being chosen, before it is saved", async () => {
      const service = new SolarForecastService(
        db,
        [fakeProvider()],
        new Logger("test", "error"),
        () => nowMs,
      );

      expect((await service.testKey("new-key", "solcast")).success).toBe(true);
      expect((await service.testKey("new-key")).error).toBe(
        "Choose a provider",
      );
    });

    it("fails a key with no sites", async () => {
      const provider = fakeProvider();
      provider.sites = [];
      const { service } = await setup(provider);

      const result = await service.testKey("new-key");

      expect(result.success).toBe(false);
      expect(result.error).toContain("No sites");
    });
  });

  describe("getSummary", () => {
    it("is null with no forecast for today", async () => {
      const { service } = await setup();
      expect(await service.getSummary()).toBeNull();
    });

    it("is null once forecasting is turned off", async () => {
      nowMs = Date.parse("2026-09-28T12:00:00Z");
      await db.forecasts.upsertPeriods(
        [{ ...period("2026-09-28T13:00:00.000Z", 4000), isDayAhead: false }],
        new Date("2026-09-28T09:00:00Z"),
      );
      const { service } = await setup();
      await service.saveSettings({ forecastProvider: "" });

      expect(await service.getSummary()).toBeNull();
    });

    it("compares today with the forecast and lists the days ahead", async () => {
      nowMs = Date.parse("2026-09-28T12:00:00Z");
      await db.forecasts.upsertPeriods([
        { ...period("2026-09-28T10:00:00.000Z", 2000), isDayAhead: false },
        { ...period("2026-09-28T13:00:00.000Z", 4000), isDayAhead: false },
        { ...period("2026-09-29T10:00:00.000Z", 1000), isDayAhead: true },
        { ...period("2026-09-29T23:30:00.000Z", 0), isDayAhead: true },
      ], new Date("2026-09-28T09:00:00Z"));
      await db.db.run(sql`
        INSERT INTO energy_readings
          (timestamp, solar_production_w, grid_power_w, home_consumption_w)
        VALUES ('2026-09-28 10:05:00', 1200, 0, 500),
               ('2026-09-28 09:05:00', 600, 0, 500)
      `);
      const { service } = await setup();

      const summary = await service.getSummary();

      expect(summary?.today).toMatchObject({
        date: "2026-09-28",
        forecastWh: 3000,
        forecastToNowWh: 1000,
        remainingWh: 2000,
        actualWh: 30,
        // The 09:05 reading predates the forecast, so it is not compared.
        actualToNowWh: 20,
      });
      expect(summary?.days.map((d) => [d.date, d.forecastWh])).toEqual([
        ["2026-09-28", 3000],
        ["2026-09-29", 500],
      ]);
      expect(summary?.periods.map((p) => p.actualW)).toEqual([
        40,
        null,
        null,
        null,
      ]);
      expect(summary?.adjusted).toBe(false);
      expect(summary?.panelLow).toBeNull();
    });

    it("applies the learned correction and reports low output", async () => {
      nowMs = Date.parse("2026-09-28T12:00:00Z");
      await db.forecasts.upsertPeriods(
        [{ ...period("2026-09-28T13:00:00.000Z", 4000), isDayAhead: false }],
        new Date("2026-09-28T09:00:00Z"),
      );
      await db.setConfig(
        "forecast_correction",
        JSON.stringify({
          hourFactors: Array.from({ length: 24 }, (_, h) => h === 13 ? 0.5 : 1),
          days: 14,
          learnedOn: "2026-09-28",
        }),
      );
      await db.setConfig(
        "forecast_panel_check",
        JSON.stringify({
          state: "low",
          recentShare: 0.6,
          recentDays: ["2026-09-25", "2026-09-26", "2026-09-27"],
          checkedOn: "2026-09-28",
        }),
      );
      const { service } = await setup();

      const summary = await service.getSummary();

      expect(summary?.today.forecastWh).toBe(1000);
      expect(summary?.adjusted).toBe(true);
      expect(summary?.panelLow).toEqual({ recentShare: 0.6 });
      const status = await service.getStatus();
      expect(status.adjust).toBe(true);
      expect(status.correction?.days).toBe(14);
      expect(status.panelCheck?.state).toBe("low");
    });

    it("saves turning the correction off", async () => {
      const { service } = await setup();
      await service.saveSettings({ forecastAdjust: false });
      expect((await service.getStatus()).adjust).toBe(false);
    });
  });

  describe("helpers", () => {
    it("adds sites together period by period", () => {
      expect(
        sumSites([
          [period("2026-09-28T02:00:00Z", 100)],
          [
            period("2026-09-28T02:00:00Z", 50),
            period("2026-09-28T02:30:00Z", 5),
          ],
        ]).map((p) => [p.periodStart, p.pvW]),
      ).toEqual([
        ["2026-09-28T02:00:00Z", 150],
        ["2026-09-28T02:30:00Z", 5],
      ]);
    });

    it("parses site id lists", () => {
      expect(parseSiteIds(" a-1, b-2\nc-3 ,")).toEqual(["a-1", "b-2", "c-3"]);
      expect(parseSiteIds("")).toEqual([]);
    });
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { sql } from "drizzle-orm";
import type {
  NotificationEventType,
  VehicleChargeState,
} from "@chargeha/shared";
import {
  type EngineSchedule,
  selectActiveChargeSchedule,
} from "@chargeha/shared/engine";
import type { SolarForecastSummary } from "@chargeha/shared/solarForecast";
import { buildVehicleChargeState } from "@chargeha/shared/test-factories";
import { AppDatabase } from "../db/AppDatabase.ts";
import { Logger } from "../lib/Logger.ts";
import { SolarChargePlanner } from "./SolarChargePlanner.ts";

describe("SolarChargePlanner", () => {
  const day = (date: string, forecastWh: number) => ({
    date,
    forecastWh,
    forecastWh10: forecastWh,
    forecastWh90: forecastWh,
    actualWh: null,
  });

  const summary: SolarForecastSummary = {
    today: {
      ...day("2026-09-28", 20_000),
      actualWh: 18_000,
      forecastToNowWh: 20_000,
      actualToNowWh: 18_000,
      remainingWh: 0,
    },
    days: [day("2026-09-28", 20_000), day("2026-09-29", 6_000)],
    periods: [],
    updatedAt: null,
    adjusted: false,
    panelLow: null,
  };

  let db: AppDatabase;
  let nowMs: number;
  let states: Map<string, VehicleChargeState>;
  let sent: Array<{ eventType: NotificationEventType; message: string }>;
  let planner: SolarChargePlanner;

  const target = { id: "cp1", vehicleId: "v1" };
  const overnight = (solarAware: boolean): EngineSchedule => ({
    id: "s1",
    vehicleId: "v1",
    chargerId: null,
    scheduleType: "charge",
    startTime: "21:00",
    endTime: "07:00",
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    chargeAmps: 16,
    chargeLimitPct: 60,
    solarAware,
    enabled: true,
  });
  const state = buildVehicleChargeState({
    batteryLevel: 40,
    chargeLimit: 80,
    chargeAmpsMin: 5,
    chargeAmpsMax: 16,
    isHome: true,
  });

  // 3 kW of solar, cautious and expected alike, over [from, to).
  const sun = async (fromIso: string, toIso: string, pvW = 3000) => {
    const count = (Date.parse(toIso) - Date.parse(fromIso)) / 1_800_000;
    await db.forecasts.upsertPeriods(
      Array.from({ length: count }, (_, i) => ({
        periodStart: new Date(Date.parse(fromIso) + i * 1_800_000)
          .toISOString(),
        periodMinutes: 30,
        pvW,
        pvW10: pvW,
        pvW90: pvW,
        isDayAhead: false,
      })),
      new Date("2026-09-27T00:00:00Z"),
    );
  };

  // Two past charging sessions, each 3 kW for two hours adding 10%:
  // 0.6 kWh per percent.
  const chargingHistory = async () => {
    const rows = ["2026-09-20", "2026-09-21"].flatMap((date) =>
      Array.from({ length: 121 }, (_, m) => {
        const t = new Date(Date.parse(`${date}T01:00:00Z`) + m * 60_000);
        const ts = t.toISOString().slice(0, 19).replace("T", " ");
        return sql`(${ts}, 'v1', 3000, 13, ${
          50 + Math.floor(m / 12)
        }, 0, 3000, 1)`;
      })
    );
    await db.db.run(sql`
      INSERT INTO vehicle_charge_readings
        (timestamp, vehicle_id, charge_power_w, charge_amps, battery_level,
         solar_contribution_w, grid_contribution_w, is_home)
      VALUES ${sql.join(rows, sql`, `)}
    `);
  };

  const active = (schedules: EngineSchedule[]) =>
    selectActiveChargeSchedule(
      schedules,
      target,
      new Date(nowMs),
      "UTC",
    );

  beforeEach(async () => {
    db = new AppDatabase(":memory:");
    await db.init();
    await db.setConfig("timezone", "UTC");
    await db.setConfig("forecast_provider", "solcast");
    await db.upsertVehicle({
      id: "v1",
      name: "Timmy Tesla",
      adapterType: "tesla",
      priority: 1,
      config: "{}",
      mode: "auto",
    });
    nowMs = Date.parse("2026-09-28T22:00:00Z");
    states = new Map([["v1", state]]);
    sent = [];
    planner = new SolarChargePlanner(
      db,
      {
        getAdjustedPeriods: (startMs, endMs) =>
          db.forecasts.getPeriods(
            new Date(startMs).toISOString(),
            new Date(endMs).toISOString(),
          ),
        getSummary: () => Promise.resolve(summary),
      },
      { getAllStates: () => Promise.resolve(states) },
      {
        notify: (eventType, _title, message) => {
          sent.push({ eventType, message });
          return Promise.resolve();
        },
      },
      new Logger("test", "error"),
      () => nowMs,
    );
  });

  afterEach(() => {
    db.close();
  });

  describe("planSchedule", () => {
    it("lowers a solar-aware limit by tomorrow's solar", async () => {
      await chargingHistory();
      // 6 kWh tomorrow = 10% at 0.6 kWh per percent.
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      const schedules = [overnight(true)];

      const planned = await planner.planSchedule(
        active(schedules),
        target,
        schedules,
        state,
      );

      expect(planned?.effective.chargeLimitPct).toBe(50);
      expect(planned?.solarPlan).toEqual({ baseLimitPct: 60, solarPct: 10 });
    });

    it("counts only solar before the schedule next runs", async () => {
      await chargingHistory();
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      // After tomorrow night's window opens: that top-up can use it.
      await sun("2026-09-29T21:00:00Z", "2026-09-29T23:00:00Z");
      const schedules = [overnight(true)];

      const planned = await planner.planSchedule(
        active(schedules),
        target,
        schedules,
        state,
      );

      expect(planned?.effective.chargeLimitPct).toBe(50);
    });

    it("leaves a schedule that is not solar-aware alone", async () => {
      await chargingHistory();
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      const schedules = [overnight(false)];
      const scheduled = active(schedules);

      expect(
        await planner.planSchedule(scheduled, target, schedules, state),
      ).toBe(scheduled);
    });

    it("charges to the full limit until the battery size is known", async () => {
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      const schedules = [overnight(true)];

      const planned = await planner.planSchedule(
        active(schedules),
        target,
        schedules,
        state,
      );

      expect(planned?.effective.chargeLimitPct).toBe(60);
      expect(planned?.solarPlan).toBeUndefined();
    });

    it("keeps the plan for the whole window", async () => {
      await chargingHistory();
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      const schedules = [overnight(true)];
      await planner.planSchedule(active(schedules), target, schedules, state);

      // A later forecast would say more, but the window is already planned.
      await sun("2026-09-29T10:00:00Z", "2026-09-29T14:00:00Z");
      nowMs += 60 * 60_000;
      const planned = await planner.planSchedule(
        active(schedules),
        target,
        schedules,
        state,
      );

      expect(planned?.effective.chargeLimitPct).toBe(50);
    });

    it("skips solar during blockouts", async () => {
      await chargingHistory();
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      const blockout: EngineSchedule = {
        ...overnight(false),
        id: "b1",
        vehicleId: null,
        scheduleType: "blockout",
        startTime: "10:00",
        endTime: "11:00",
        chargeAmps: null,
        chargeLimitPct: null,
      };
      const schedules = [overnight(true), blockout];

      const planned = await planner.planSchedule(
        active(schedules),
        target,
        schedules,
        state,
      );

      expect(planned?.effective.chargeLimitPct).toBe(55);
    });
  });

  describe("projections", () => {
    beforeEach(() => {
      nowMs = Date.parse("2026-09-29T09:00:00Z");
    });

    it("says what solar should add before sunset", async () => {
      await chargingHistory();
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");

      const [projection] = await planner.projections();

      expect(projection).toEqual({
        vehicleId: "v1",
        expectedKwh: 6,
        cautiousKwh: 6,
        expectedPct: 50,
        cautiousPct: 50,
        limitPct: 80,
        untilAt: "2026-09-29T12:00:00.000Z",
        limitAt: null,
      });
    });

    it("says when the car reaches its limit", async () => {
      await chargingHistory();
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      states.set("v1", { ...state, batteryLevel: 75 });

      const [projection] = await planner.projections();

      // 5% is 3 kWh: an hour at 3 kW.
      expect(projection.expectedPct).toBe(80);
      expect(projection.limitAt).toBe("2026-09-29T11:00:00.000Z");
    });

    it("gives energy only until the battery size is known", async () => {
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");

      const [projection] = await planner.projections();

      expect(projection.expectedKwh).toBe(6);
      expect(projection.expectedPct).toBeNull();
    });

    it("leaves out cars that are unplugged or away", async () => {
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      states.set("v1", { ...state, isPluggedIn: false });
      expect(await planner.projections()).toEqual([]);

      states.set("v1", { ...state, isHome: false });
      expect(await planner.projections()).toEqual([]);
    });

    it("has nothing once the sun is done", async () => {
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      nowMs = Date.parse("2026-09-29T13:00:00Z");
      expect(await planner.projections()).toEqual([]);
    });
  });

  describe("evening summary", () => {
    it("goes out once, after the set time", async () => {
      await db.setConfig("forecast_summary_time", "20:00");
      nowMs = Date.parse("2026-09-28T19:59:00Z");
      await planner.tick();
      expect(sent).toEqual([]);

      nowMs = Date.parse("2026-09-28T20:00:00Z");
      await planner.tick();
      await planner.tick();
      expect(sent).toHaveLength(1);
      expect(sent[0].eventType).toBe("daily_solar_summary");
      expect(sent[0].message).toContain("Timmy Tesla");
    });

    it("includes tonight's solar-aware top-up", async () => {
      await chargingHistory();
      await sun("2026-09-29T10:00:00Z", "2026-09-29T12:00:00Z");
      await db.createSchedule(overnight(true));
      nowMs = Date.parse("2026-09-28T20:00:00Z");

      await planner.sendSummary();

      expect(sent[0].message).toContain(
        "Tonight from 21:00: topping up to 50% (60% less ~10% expected from solar).",
      );
    });
  });
});

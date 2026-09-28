import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SolarForecastSummary } from "@chargeha/shared/solarForecast";
import { buildVehicleChargeState } from "@chargeha/shared/test-factories";
import {
  buildEveningSummary,
  type SummaryCar,
  summaryDue,
} from "./eveningSummary.ts";

describe("eveningSummary", () => {
  describe("summaryDue", () => {
    const at = Date.parse("2026-09-28T10:30:00Z"); // 20:30 in Hobart

    it("is due once the time has passed", () => {
      expect(summaryDue(at, "Australia/Hobart", "20:00", "", "2026-09-28"))
        .toBe(true);
    });

    it("is not due before the time", () => {
      expect(summaryDue(at, "Australia/Hobart", "21:00", "", "2026-09-28"))
        .toBe(false);
    });

    it("goes out once a day", () => {
      expect(
        summaryDue(at, "Australia/Hobart", "20:00", "2026-09-28", "2026-09-28"),
      ).toBe(false);
    });
  });

  describe("buildEveningSummary", () => {
    const day = (date: string, forecastWh: number) => ({
      date,
      forecastWh,
      forecastWh10: forecastWh / 2,
      forecastWh90: forecastWh * 1.2,
      actualWh: null,
    });
    const summary: SolarForecastSummary = {
      today: {
        ...day("2026-09-28", 20_100),
        actualWh: 18_200,
        forecastToNowWh: 20_100,
        actualToNowWh: 18_200,
        remainingWh: 0,
      },
      days: [day("2026-09-28", 20_100), day("2026-09-29", 27_800)],
      periods: [],
      updatedAt: null,
      adjusted: false,
      panelLow: null,
    };
    const car = (overrides: Partial<SummaryCar> = {}): SummaryCar => ({
      name: "Timmy Tesla",
      state: buildVehicleChargeState({ batteryLevel: 40 }),
      solarKwhToday: 6.3,
      tonight: null,
      ...overrides,
    });

    it("sums up today and tomorrow", () => {
      const { title, message } = buildEveningSummary(summary, [car()]);
      expect(title).toBe("Solar Summary");
      expect(message.split("\n")).toEqual([
        "Today: 18.2 kWh made (forecast 20.1 kWh).",
        "Tomorrow: about 27.8 kWh (likely 13.9–33.4).",
        "Timmy Tesla: 6.3 kWh from solar today, now 40%.",
      ]);
    });

    it("says what a solar-aware top-up will do tonight", () => {
      const plan = { baseLimitPct: 60, solarPct: 25 };
      const topUp = buildEveningSummary(summary, [
        car({ tonight: { startTime: "21:00", limitPct: 35, plan } }),
      ]).message;
      expect(topUp).toContain(
        "Tonight from 21:00: no grid top-up needed — 40% is already at or above 35% (60% less ~25% expected from solar).",
      );

      const needed = buildEveningSummary(summary, [
        car({
          state: buildVehicleChargeState({ batteryLevel: 20 }),
          tonight: { startTime: "21:00", limitPct: 35, plan },
        }),
      ]).message;
      expect(needed).toContain(
        "Tonight from 21:00: topping up to 35% (60% less ~25% expected from solar).",
      );
    });

    it("says when there is not enough sun to count on", () => {
      const { message } = buildEveningSummary(summary, [
        car({ tonight: { startTime: "21:00", limitPct: 60, plan: null } }),
      ]);
      expect(message).toContain(
        "Tonight from 21:00: charging to 60% — not enough sun forecast to count on.",
      );
    });
  });
});

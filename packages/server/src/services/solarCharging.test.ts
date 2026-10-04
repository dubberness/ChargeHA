import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  carSolarW,
  houseLoadByHour,
  lastSunMs,
  learnKwhPerPercent,
  solarToCar,
  type SurplusRules,
  windowAfter,
} from "./solarCharging.ts";

describe("solarCharging", () => {
  const ms = (iso: string) => Date.parse(iso);
  const rules = (overrides: Partial<SurplusRules> = {}): SurplusRules => ({
    minChargeW: 1150, // 5 A at 230 V
    maxChargeW: 3680, // 16 A
    minGenerationW: 1200,
    marginW: 0,
    reference: "excess",
    blockedAt: () => false,
    ...overrides,
  });
  const period = (periodStart: string, pvW: number) => ({
    periodStart,
    periodMinutes: 30,
    pvW,
    pvW10: pvW / 2,
    pvW90: pvW,
  });

  describe("carSolarW", () => {
    it("gives the car what the house does not use", () => {
      expect(carSolarW(3000, 500, rules())).toBe(2500);
    });

    it("holds back the cushion under a solar-only blockout", () => {
      expect(carSolarW(3000, 500, rules(), true)).toBe(2200);
    });

    it("counts house load under a solar-only blockout even on gross", () => {
      const gross = rules({ reference: "gross" });
      expect(carSolarW(3000, 500, gross)).toBe(3000);
      expect(carSolarW(3000, 500, gross, true)).toBe(2200);
    });

    it("keeps a configured margin larger than the cushion", () => {
      expect(carSolarW(3000, 500, rules({ marginW: 600 }), true)).toBe(1900);
    });

    it("stops at the charger's maximum", () => {
      expect(carSolarW(6000, 500, rules())).toBe(3680);
    });

    it("gives nothing below the charger's minimum", () => {
      expect(carSolarW(1600, 500, rules())).toBe(0);
    });

    it("gives nothing below the minimum generation", () => {
      expect(carSolarW(1500, 0, rules({ minGenerationW: 1600 }))).toBe(0);
    });

    it("keeps the margin back", () => {
      expect(carSolarW(3000, 500, rules({ marginW: 300 }))).toBe(2200);
    });

    it("ignores the house when tracking gross production", () => {
      expect(carSolarW(3000, 500, rules({ reference: "gross" }))).toBe(3000);
    });
  });

  describe("solarToCar", () => {
    const periods = [
      period("2026-09-28T01:00:00Z", 3000),
      period("2026-09-28T01:30:00Z", 3000),
      period("2026-09-28T02:00:00Z", 3000),
    ];
    const house = () => 500;
    const from = ms("2026-09-28T01:00:00Z");
    const to = ms("2026-09-28T02:30:00Z");

    it("adds up the car's share over the window", () => {
      const result = solarToCar(
        periods,
        (p) => p.pvW,
        house,
        rules(),
        from,
        to,
      );
      expect(result).toEqual({ wh: 3750, capReachedAtMs: null });
    });

    it("counts only the part of a period inside the window", () => {
      const result = solarToCar(
        periods,
        (p) => p.pvW,
        house,
        rules(),
        ms("2026-09-28T01:15:00Z"),
        ms("2026-09-28T01:30:00Z"),
      );
      expect(result.wh).toBe(625);
    });

    it("holds back the cushion in solar-only periods", () => {
      const solarOnly = rules({
        solarOnlyAt: (t) => t < ms("2026-09-28T01:30:00Z"),
      });
      const all = solarToCar(periods, (p) => p.pvW, house, rules(), from, to);
      const result = solarToCar(
        periods,
        (p) => p.pvW,
        house,
        solarOnly,
        from,
        to,
      );
      expect(all.wh - result.wh).toBe(150);
    });

    it("skips blocked periods", () => {
      const blocked = rules({
        blockedAt: (t) => t < ms("2026-09-28T01:30:00Z"),
      });
      const result = solarToCar(
        periods,
        (p) => p.pvW,
        house,
        blocked,
        from,
        to,
      );
      expect(result.wh).toBe(2500);
    });

    it("stops at the cap and says when it got there", () => {
      const result = solarToCar(
        periods,
        (p) => p.pvW,
        house,
        rules(),
        from,
        to,
        1875,
      );
      expect(result).toEqual({
        wh: 1875,
        capReachedAtMs: ms("2026-09-28T01:45:00Z"),
      });
    });

    it("uses the picked estimate", () => {
      const result = solarToCar(
        periods,
        (p) => p.pvW10,
        house,
        rules(),
        from,
        to,
      );
      // 1500 W less 500 W house is under the 1150 W minimum.
      expect(result.wh).toBe(0);
    });
  });

  describe("lastSunMs", () => {
    it("ends with the last period that produces anything", () => {
      const periods = [
        period("2026-09-28T07:00:00Z", 200),
        period("2026-09-28T07:30:00Z", 0),
      ];
      expect(
        lastSunMs(
          periods,
          ms("2026-09-28T01:00:00Z"),
          ms("2026-09-28T14:00:00Z"),
        ),
      ).toBe(ms("2026-09-28T07:30:00Z"));
    });

    it("is null once the sun is done", () => {
      const periods = [period("2026-09-28T07:00:00Z", 200)];
      expect(
        lastSunMs(
          periods,
          ms("2026-09-28T08:00:00Z"),
          ms("2026-09-28T14:00:00Z"),
        ),
      ).toBeNull();
    });
  });

  describe("houseLoadByHour", () => {
    const bucket = (iso: string, homeW: number, carW = 0) => ({
      startMs: ms(iso),
      homeW,
      carW,
    });

    it("takes the median across days of each hour's average", () => {
      const load = houseLoadByHour(
        [
          bucket("2026-09-26T10:00:00Z", 400),
          bucket("2026-09-26T10:15:00Z", 600),
          bucket("2026-09-27T10:00:00Z", 300),
          bucket("2026-09-28T10:00:00Z", 3000),
        ],
        "UTC",
        false,
      );
      expect(load[10]).toBe(500);
    });

    it("takes the car out when the house total includes it", () => {
      const load = houseLoadByHour(
        [bucket("2026-09-26T10:00:00Z", 4000, 3600)],
        "UTC",
        true,
      );
      expect(load[10]).toBe(400);
    });

    it("fills hours without history from the others", () => {
      const load = houseLoadByHour(
        [
          bucket("2026-09-26T10:00:00Z", 400),
          bucket("2026-09-26T11:00:00Z", 600),
          bucket("2026-09-26T12:00:00Z", 800),
        ],
        "UTC",
        false,
      );
      expect(load[3]).toBe(600);
      expect(houseLoadByHour([], "UTC", false)[3]).toBe(0);
    });
  });

  describe("learnKwhPerPercent", () => {
    // One reading a minute at `powerW`, the level rising `pct` over it.
    const session = (
      startIso: string,
      minutes: number,
      powerW: number,
      fromPct: number,
      pct: number,
    ) =>
      Array.from({ length: minutes + 1 }, (_, m) => ({
        ms: ms(startIso) + m * 60_000,
        powerW,
        batteryLevel: Math.floor(fromPct + pct * m / minutes),
      }));

    it("divides the energy by the battery gained", () => {
      // 3 kW for 2 hours = 6 kWh for 10%.
      const readings = [
        ...session("2026-09-26T01:00:00Z", 120, 3000, 50, 10),
        ...session("2026-09-27T01:00:00Z", 120, 3000, 60, 10),
      ];
      expect(learnKwhPerPercent(readings)).toBe(0.6);
    });

    it("needs enough charging to trust it", () => {
      expect(
        learnKwhPerPercent(session("2026-09-26T01:00:00Z", 120, 3000, 50, 10)),
      ).toBeNull();
    });

    it("ignores sessions that barely moved the battery", () => {
      const readings = [
        ...session("2026-09-26T01:00:00Z", 60, 3000, 50, 2),
        ...session("2026-09-27T01:00:00Z", 60, 3000, 50, 2),
        ...session("2026-09-28T01:00:00Z", 60, 3000, 50, 2),
      ];
      expect(learnKwhPerPercent(readings)).toBeNull();
    });

    it("rejects a size no car has", () => {
      const readings = [
        ...session("2026-09-26T01:00:00Z", 120, 30_000, 50, 10),
        ...session("2026-09-27T01:00:00Z", 120, 30_000, 60, 10),
      ];
      expect(learnKwhPerPercent(readings)).toBeNull();
    });
  });

  describe("windowAfter", () => {
    // Active 21:00–07:00 UTC every night.
    const overnight = (t: number) => {
      const hour = new Date(t).getUTCHours();
      return hour >= 21 || hour < 7;
    };

    it("finds the end of this window and the start of the next", () => {
      expect(windowAfter(overnight, ms("2026-09-28T23:00:00Z"))).toEqual({
        endMs: ms("2026-09-29T07:00:00Z"),
        nextStartMs: ms("2026-09-29T21:00:00Z"),
      });
    });

    it("has no next start for a window that never comes back", () => {
      const once = (t: number) => t < ms("2026-09-29T07:00:00Z");
      expect(windowAfter(once, ms("2026-09-28T23:00:00Z"))).toEqual({
        endMs: ms("2026-09-29T07:00:00Z"),
        nextStartMs: null,
      });
    });
  });
});

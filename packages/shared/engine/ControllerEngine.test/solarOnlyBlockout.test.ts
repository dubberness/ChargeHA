import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ControllerEngine } from "../ControllerEngine.ts";
import { SOLAR_ONLY } from "../SolarOnly.ts";
import { makeInput } from "../test-helpers/controller-engine.ts";
import type { EngineSchedule } from "../types.ts";

describe("ControllerEngine — solar-only blockout", () => {
  const now = new Date("2026-01-01T03:00:00Z");
  const T0 = 1_000_000_000;
  const SETTLE_MS = SOLAR_ONLY.startSettleSeconds * 1000;
  const GRACE_MS = SOLAR_ONLY.graceSeconds * 1000;
  const RAMP_MS = SOLAR_ONLY.rampSettleSeconds * 1000;

  const blockout = (overrides?: Partial<EngineSchedule>): EngineSchedule => ({
    id: "b1",
    vehicleId: null,
    chargerId: null,
    scheduleType: "blockout",
    startTime: "02:00",
    endTime: "06:00",
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    chargeAmps: null,
    chargeLimitPct: null,
    allowSolar: true,
    enabled: true,
    ...overrides,
  });

  type Overrides = NonNullable<Parameters<typeof makeInput>[0]>;

  // One loop under a solar-only blockout, `atMs` after T0.
  const loop = (atMs: number, overrides: Overrides = {}) =>
    makeInput({
      now,
      timestamp: T0 + atMs,
      schedules: [blockout()],
      ...overrides,
      configOverrides: { timezone: "UTC", ...overrides.configOverrides },
    });

  const charging = (chargeAmps: number) => ({
    state: { isCharging: true, chargeAmps },
  });

  describe("starting", () => {
    it("waits for the surplus to hold before starting", () => {
      const engine = new ControllerEngine();
      const first = engine.decide(loop(0)).decisions.get("V1");
      expect(first?.action).toBe("none");
      expect(first?.detail).toContain("Waiting for steady solar (0s/180s)");

      const almost = engine.decide(loop(SETTLE_MS - 1000)).decisions.get("V1");
      expect(almost?.action).toBe("none");

      const ready = engine.decide(loop(SETTLE_MS)).decisions.get("V1");
      expect(ready?.action).toBe("start");
    });

    it("leaves the cushion exporting when it starts", () => {
      const engine = new ControllerEngine();
      engine.decide(loop(0));
      // 3000W of export less the 300W cushion is 2700W: 11A, not 13A.
      const d = engine.decide(loop(SETTLE_MS)).decisions.get("V1");
      expect(d?.targetAmps).toBe(11);
    });

    it("starts the wait again after the surplus drops out", () => {
      const engine = new ControllerEngine();
      engine.decide(loop(0));
      const short = engine.decide(
        loop(60_000, { energyOverrides: { gridPowerW: -500 } }),
      ).decisions.get("V1");
      expect(short?.detail).toContain("insufficient solar");

      const back = engine.decide(loop(120_000)).decisions.get("V1");
      expect(back?.detail).toContain("Waiting for steady solar (0s/180s)");
      const early = engine.decide(loop(SETTLE_MS)).decisions.get("V1");
      expect(early?.action).toBe("none");
      const ready = engine.decide(loop(120_000 + SETTLE_MS)).decisions.get(
        "V1",
      );
      expect(ready?.action).toBe("start");
    });

    it("needs the cushion on top of minimum amps to start", () => {
      const engine = new ControllerEngine();
      // 1400W would start a 5A charge normally; less the cushion it is 4A.
      const energyOverrides = { gridPowerW: -1400 };
      engine.decide(loop(0, { energyOverrides }));
      const d = engine.decide(loop(SETTLE_MS, { energyOverrides })).decisions
        .get("V1");
      expect(d?.action).toBe("none");
      expect(d?.detail).toContain("insufficient solar");
    });
  });

  describe("tracking", () => {
    it("lowers amps at once, however small the change", () => {
      const engine = new ControllerEngine();
      // 100W export + 2300W car - 300W cushion = 2100W: 9A, a 1A drop that
      // normal tracking would hold back to settle.
      const d = engine.decide(
        loop(0, {
          vehicle: charging(10),
          energyOverrides: { gridPowerW: -100 },
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("adjust_amps");
      expect(d?.targetAmps).toBe(9);
    });

    it("raises amps only to the level the surplus has held", () => {
      const engine = new ControllerEngine();
      const at = (ms: number, gridPowerW: number) =>
        engine.decide(
          loop(ms, { vehicle: charging(6), energyOverrides: { gridPowerW } }),
        ).decisions.get("V1");

      // Targets of 10A, then 8A, then 9A while the car sits at 6A.
      expect(at(0, -1400)?.action).toBe("none");
      expect(at(RAMP_MS / 2, -900)?.action).toBe("none");
      const raised = at(RAMP_MS, -1200);
      expect(raised?.action).toBe("adjust_amps");
      expect(raised?.targetAmps).toBe(8);
    });

    it("raises amps slowly even for a large jump", () => {
      const engine = new ControllerEngine();
      const d = engine.decide(
        loop(0, {
          vehicle: charging(5),
          energyOverrides: { gridPowerW: -3000 },
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("none");
      expect(d?.targetAmps).toBe(5);
    });

    it("spends the cushion before calling the car short", () => {
      const engine = new ControllerEngine();
      // 100W export + 1150W car = 1250W: covers 5A, though not the cushion.
      const d = engine.decide(
        loop(0, {
          vehicle: charging(5),
          energyOverrides: { gridPowerW: -100 },
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("none");
      expect(d?.reason).toBe("solar_tracking");
      expect(d?.targetAmps).toBe(5);
    });
  });

  describe("running short", () => {
    it("drops to minimum amps on the first short reading", () => {
      const engine = new ControllerEngine();
      const d = engine.decide(
        loop(0, {
          vehicle: charging(10),
          energyOverrides: { gridPowerW: 1500 },
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("adjust_amps");
      expect(d?.targetAmps).toBe(5);
      expect(d?.reason).toBe("grace_period");
    });

    it("stops within seconds once solar no longer covers minimum amps", () => {
      const engine = new ControllerEngine();
      const at = (ms: number) =>
        engine.decide(
          loop(ms, {
            vehicle: charging(5),
            energyOverrides: { gridPowerW: 200 },
          }),
        );
      expect(at(0).decisions.get("V1")?.action).toBe("none");
      expect(at(GRACE_MS - 1000).decisions.get("V1")?.action).toBe("none");

      const output = at(GRACE_MS);
      expect(output.decisions.get("V1")?.action).toBe("stop");
      expect(output.controlStates.get("V1")?.cooldownUntil).toBe(
        T0 + GRACE_MS + SOLAR_ONLY.cooldownSeconds * 1000,
      );
    });

    it("keeps a shorter configured grace period", () => {
      const engine = new ControllerEngine();
      const d = engine.decide(
        loop(0, {
          vehicle: charging(5),
          energyOverrides: { gridPowerW: 200 },
          configOverrides: { gracePeriodMinutes: 0 },
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("stop");
    });
  });

  describe("keeping the grid out", () => {
    const overnight: EngineSchedule = {
      id: "s1",
      vehicleId: null,
      chargerId: null,
      scheduleType: "charge",
      startTime: "02:00",
      endTime: "06:00",
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      chargeAmps: 16,
      chargeLimitPct: null,
      enabled: true,
    };

    it("holds back a charge schedule", () => {
      const engine = new ControllerEngine();
      const d = engine.decide(
        loop(0, {
          schedules: [blockout(), overnight],
          energyOverrides: { solarProductionW: 0, gridPowerW: 500 },
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("none");
      expect(d?.checks).toContainEqual({
        check: "charge_schedule",
        result: "active: 02:00-06:00 @ 16A — held by blockout",
      });
    });

    it("does not fall back to the grid in solar+grid mode", () => {
      const engine = new ControllerEngine();
      const d = engine.decide(
        loop(0, {
          energyOverrides: { gridPowerW: -500 },
          configOverrides: { solarTrackingMode: "solar_grid" },
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("none");
    });

    it("counts only surplus when tracking gross production", () => {
      const engine = new ControllerEngine();
      const d = engine.decide(
        loop(0, {
          energyOverrides: { solarProductionW: 5000, gridPowerW: 0 },
          configOverrides: { solarReference: "gross" },
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("none");
      expect(d?.detail).toContain("insufficient solar");
    });

    it("stops a car charging with no solar at all", () => {
      const engine = new ControllerEngine();
      const d = engine.decide(
        loop(0, {
          vehicle: charging(5),
          energyOverrides: { solarProductionW: 0, gridPowerW: 1500 },
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("stop");
      expect(d?.reason).toBe("no_solar");
    });
  });

  describe("alongside other blockouts", () => {
    it("gives way to an overlapping blockout that blocks everything", () => {
      const engine = new ControllerEngine();
      const d = engine.decide(
        loop(0, {
          vehicle: charging(10),
          schedules: [
            blockout(),
            blockout({ id: "b2", allowSolar: false }),
          ],
        }),
      ).decisions.get("V1");
      expect(d?.action).toBe("stop");
      expect(d?.reason).toBe("blockout");
    });

    it("records the blockout as solar only", () => {
      const engine = new ControllerEngine();
      const d = engine.decide(loop(0)).decisions.get("V1");
      expect(d?.checks).toContainEqual({
        check: "blockout_schedule",
        result: "solar only: 02:00-06:00",
      });
    });
  });
});

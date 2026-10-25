import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ControllerEngine } from "../ControllerEngine.ts";
import { makeInput } from "../test-helpers/controller-engine.ts";

describe("ControllerEngine — car preheating on the cable", () => {
  const T0 = 1_000_000;
  const MINUTE = 60_000;
  // Preheating before a 07:45 departure: drawing 5A off the wall, reported
  // as charging, with the sun barely up.
  const preheating = {
    isCharging: true,
    isConditioning: true,
    chargeAmps: 5,
    chargePowerKw: 1.17,
  };
  const dawn = { solarProductionW: 300, gridPowerW: 900 };
  const night = { solarProductionW: 0, gridPowerW: 1200 };

  it("holds instead of stopping at night", () => {
    const engine = new ControllerEngine();

    const decision = engine.decide(makeInput({
      vehicle: { state: preheating },
      energyOverrides: night,
      timestamp: T0,
    })).decisions.get("V1");

    expect(decision?.action).toBe("none");
    expect(decision?.reason).toBe("conditioning");
    expect(decision?.detail).toContain("preheating");
    expect(decision?.checks.at(-1)?.result).toContain("no solar generation");
  });

  it("drops to minimum amps instead of stopping at the charge limit", () => {
    const engine = new ControllerEngine();

    const decision = engine.decide(makeInput({
      vehicle: {
        state: {
          ...preheating,
          batteryLevel: 100,
          chargeLimit: 100,
          chargeAmps: 13,
          chargePowerKw: 3.04,
        },
      },
      energyOverrides: { solarProductionW: 1000, gridPowerW: 2500 },
      timestamp: T0,
    })).decisions.get("V1");

    expect(decision?.action).toBe("adjust_amps");
    expect(decision?.targetAmps).toBe(5);
    expect(decision?.reason).toBe("conditioning");
  });

  it("never runs a grace period out to a stop while preheating", () => {
    const engine = new ControllerEngine();
    const ticks = Array.from({ length: 30 }, (_, i) => T0 + i * MINUTE / 2);

    const actions = ticks.map((timestamp) =>
      engine.decide(makeInput({
        vehicle: { state: preheating },
        energyOverrides: dawn,
        timestamp,
      })).decisions.get("V1")?.action
    );

    expect(actions.every((action) => action === "none")).toBe(true);
    expect(engine.getControlState("V1").graceStartedAt).toBeNull();
    expect(engine.getControlState("V1").cooldownUntil).toBeNull();
  });

  it("still stops when the user sets Stop", () => {
    const engine = new ControllerEngine();

    const decision = engine.decide(makeInput({
      vehicle: { mode: "stop", state: preheating },
      energyOverrides: night,
      timestamp: T0,
    })).decisions.get("V1");

    expect(decision?.action).toBe("stop");
    expect(decision?.reason).toBe("mode_stop");
  });

  it("stops as before when the car is not preheating", () => {
    const engine = new ControllerEngine();

    const decision = engine.decide(makeInput({
      vehicle: { state: { ...preheating, isConditioning: false } },
      energyOverrides: night,
      timestamp: T0,
    })).decisions.get("V1");

    expect(decision?.action).toBe("stop");
    expect(decision?.reason).toBe("no_solar");
  });

  it("tracks solar as normal while preheating in the sun", () => {
    const engine = new ControllerEngine();

    const decision = engine.decide(makeInput({
      vehicle: { state: preheating },
      energyOverrides: { solarProductionW: 5000, gridPowerW: -2500 },
      timestamp: T0,
    })).decisions.get("V1");

    expect(decision?.reason).not.toBe("conditioning");
    expect(decision?.action).not.toBe("stop");
  });
});

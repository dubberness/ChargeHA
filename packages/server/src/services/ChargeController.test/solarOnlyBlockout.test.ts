import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  BASE_ENERGY,
  type ControllerCtx,
  currentScheduleWindow,
  setupController,
} from "../../test-helpers/ChargeControllerHarness.ts";

describe("ChargeController — solar-only blockout", () => {
  const CHARGING_AT_MIN = {
    isCharging: true,
    chargeAmps: 5,
    chargePowerKw: 1.15,
  };
  // 100W of export on top of the car's 1150W: enough to hold 5A.
  const JUST_COVERED = { ...BASE_ENERGY, gridPowerW: -100 };

  let ctx: ControllerCtx | undefined;

  afterEach(() => {
    ctx?.controller.stop();
    ctx?.db.close();
  });

  const addBlockout = async (c: ControllerCtx, allowSolar: boolean) => {
    const { today, startTime, endTime } = currentScheduleWindow();
    await c.db.createSchedule({
      id: "blockout-1",
      vehicleId: null,
      chargerId: null,
      scheduleType: "blockout",
      startTime,
      endTime,
      days: [today],
      chargeAmps: null,
      chargeLimitPct: null,
      allowSolar,
    });
  };

  it("keeps a car charging on solar instead of stopping it", async () => {
    ctx = await setupController(CHARGING_AT_MIN, "auto", JUST_COVERED);
    await addBlockout(ctx, true);
    await ctx.runOneLoop();

    const log = await ctx.getLastLogParsed();
    expect(log?.action).toBe("none");
    expect(log?.actionDetail).toContain("Already charging at 5A");
    expect(log?.checks).toContainEqual({
      check: "blockout_schedule",
      result: expect.stringContaining("solar only"),
    });
    expect(ctx.adapter.commands).not.toContainEqual({ cmd: "stop" });
  });

  it("still stops the car under a blockout that blocks everything", async () => {
    ctx = await setupController(CHARGING_AT_MIN, "auto", JUST_COVERED);
    await addBlockout(ctx, false);
    await ctx.runOneLoop();

    expect((await ctx.getLastLogParsed())?.action).toBe("stop");
  });

  describe("loop interval", () => {
    it("samples faster while a car is charging on solar", async () => {
      ctx = await setupController(CHARGING_AT_MIN, "auto", JUST_COVERED);
      await addBlockout(ctx, true);

      const config = await ctx.controller.runOnce();
      expect(config.controllerLoopSeconds).toBe(10);
    });

    it("gives the car the normal interval after a command", async () => {
      ctx = await setupController(
        { isCharging: true, chargeAmps: 10, chargePowerKw: 2.3 },
        "auto",
        JUST_COVERED,
      );
      await addBlockout(ctx, true);

      const config = await ctx.controller.runOnce();
      expect((await ctx.getLastLogParsed())?.action).toBe("adjust_amps");
      expect(config.controllerLoopSeconds).toBe(30);
    });

    it("keeps the normal interval while nothing is charging", async () => {
      ctx = await setupController({}, "auto");
      await addBlockout(ctx, true);

      const config = await ctx.controller.runOnce();
      expect((await ctx.getLastLogParsed())?.actionDetail).toContain(
        "Waiting for steady solar",
      );
      expect(config.controllerLoopSeconds).toBe(30);
    });

    it("keeps the normal interval outside a solar-only blockout", async () => {
      ctx = await setupController(CHARGING_AT_MIN, "auto", JUST_COVERED);

      const config = await ctx.controller.runOnce();
      expect(config.controllerLoopSeconds).toBe(30);
    });
  });

  it("does not announce its short grace period", async () => {
    ctx = await setupController(CHARGING_AT_MIN, "auto", {
      ...BASE_ENERGY,
      gridPowerW: 200,
    });
    await addBlockout(ctx, true);
    await ctx.runOneLoop();
    await ctx.runOneLoop();

    expect((await ctx.getLastLogParsed())?.actionDetail).toContain(
      "Grace period active",
    );
    const lowSolar = ctx.trackingEmitter.controllerEvents().filter(
      (e) => e.type === "controller_low_solar",
    );
    expect(lowSolar).toHaveLength(0);
  });
});

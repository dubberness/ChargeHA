import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import type { AdapterVehicleChargeState } from "@chargeha/shared";
import { buildVehicleChargeState } from "@chargeha/shared/test-factories";
import type { VehicleRequestContext } from "@chargeha/shared/plugins";
import { Logger } from "@chargeha/server/lib/Logger";
import type { TessieAdapter } from "./TessieAdapter.ts";
import {
  COMMAND_CONFIRM_MS,
  STATE_CACHE_MS,
  TessieVehicleMiddleware,
} from "./TessieVehicleMiddleware.ts";

class FakeTessieAdapter {
  state: AdapterVehicleChargeState = buildVehicleChargeState({
    batteryLevel: 60,
    isOnline: true,
  });
  commandResult = true;
  wakeResult = true;
  fetches = 0;
  wakes = 0;
  commands: string[] = [];

  getChargeState(): Promise<AdapterVehicleChargeState> {
    this.fetches++;
    return Promise.resolve({ ...this.state });
  }

  wakeVehicle(): Promise<boolean> {
    this.wakes++;
    if (this.wakeResult) this.state = { ...this.state, isOnline: true };
    return Promise.resolve(this.wakeResult);
  }

  startCharging(): Promise<boolean> {
    this.commands.push("start");
    return Promise.resolve(this.commandResult);
  }

  stopCharging(): Promise<boolean> {
    this.commands.push("stop");
    return Promise.resolve(this.commandResult);
  }

  setChargeAmps(amps: number): Promise<boolean> {
    this.commands.push(`amps:${amps}`);
    return Promise.resolve(this.commandResult);
  }
}

describe("TessieVehicleMiddleware", () => {
  const logger = new Logger("TessieMiddleware", "error");
  const ctx = (
    overrides: Partial<VehicleRequestContext> = {},
  ): VehicleRequestContext => ({
    origin: "test",
    traceId: "test",
    hasSolar: false,
    hasSchedule: false,
    hasBlockout: false,
    ...overrides,
  });
  const cc = { origin: "test", traceId: "test" };

  let time: FakeTime;
  let adapter: FakeTessieAdapter;
  let middleware: TessieVehicleMiddleware;

  beforeEach(() => {
    time = new FakeTime();
    adapter = new FakeTessieAdapter();
    middleware = new TessieVehicleMiddleware(
      adapter as unknown as TessieAdapter,
      logger,
    );
  });

  afterEach(() => {
    time.restore();
  });

  describe("requestState", () => {
    it("fetches on first request and serves the cache inside the window", async () => {
      await middleware.requestState(ctx());
      time.tick(STATE_CACHE_MS - 1);
      await middleware.requestState(ctx({ hasSolar: true }));
      expect(adapter.fetches).toBe(1);
    });

    it("fetches again once the cache window passes", async () => {
      await middleware.requestState(ctx());
      time.tick(STATE_CACHE_MS);
      await middleware.requestState(ctx());
      expect(adapter.fetches).toBe(2);
    });

    it("never wakes a sleeping car for a routine poll", async () => {
      adapter.state = { ...adapter.state, isOnline: false };
      await middleware.requestState(ctx({ hasSolar: true, hasSchedule: true }));
      expect(adapter.wakes).toBe(0);
      expect(middleware.online).toBe(false);
    });

    it("bypasses the cache on forceRefresh", async () => {
      await middleware.requestState(ctx());
      await middleware.requestState(ctx({ forceRefresh: true }));
      expect(adapter.fetches).toBe(2);
      expect(adapter.wakes).toBe(0);
    });

    it("wakes a sleeping car on forceRefresh, then re-reads", async () => {
      adapter.state = { ...adapter.state, isOnline: false };
      const state = await middleware.requestState(ctx({ forceRefresh: true }));
      expect(adapter.wakes).toBe(1);
      expect(adapter.fetches).toBe(2);
      expect(state?.isOnline).toBe(true);
    });

    it("returns the last-known state when the wake fails", async () => {
      adapter.state = { ...adapter.state, isOnline: false };
      adapter.wakeResult = false;
      const state = await middleware.requestState(ctx({ forceRefresh: true }));
      expect(state?.batteryLevel).toBe(60);
      expect(adapter.fetches).toBe(1);
    });
  });

  describe("min amps", () => {
    it("reports the floor set by the charging point", async () => {
      middleware.setMinAmps(2);
      const state = await middleware.requestState(ctx());
      expect(state?.chargeAmpsMin).toBe(2);
      expect(middleware.getCachedState()?.chargeAmpsMin).toBe(2);
    });
  });

  describe("seedState", () => {
    it("seeds an empty cache as offline", () => {
      middleware.seedState(buildVehicleChargeState({ isOnline: true }));
      expect(middleware.getCachedState()?.isOnline).toBe(false);
    });

    it("does not overwrite fetched state", async () => {
      await middleware.requestState(ctx());
      middleware.seedState(buildVehicleChargeState({ batteryLevel: 10 }));
      expect(middleware.getCachedState()?.batteryLevel).toBe(60);
    });
  });

  describe("commands", () => {
    it("marks charging and expires the cache after a start", async () => {
      await middleware.requestState(ctx());
      expect(await middleware.startCharging(cc)).toBe(true);
      expect(middleware.getCachedState()?.isCharging).toBe(true);
      await middleware.requestState(ctx());
      expect(adapter.fetches).toBe(2);
    });

    it("zeroes power and amps after a stop", async () => {
      adapter.state = { ...adapter.state, isCharging: true, chargeAmps: 16 };
      await middleware.requestState(ctx());
      await middleware.stopCharging(cc);
      const state = middleware.getCachedState();
      expect(state?.isCharging).toBe(false);
      expect(state?.chargeAmps).toBe(0);
      expect(state?.chargePowerKw).toBe(0);
    });

    it("caches the requested amps", async () => {
      await middleware.requestState(ctx());
      await middleware.setChargeAmps(9, cc);
      expect(adapter.commands).toEqual(["amps:9"]);
      expect(middleware.getCachedState()?.chargeAmps).toBe(9);
    });

    it("re-reads state when the car refuses a command", async () => {
      await middleware.requestState(ctx());
      adapter.commandResult = false;
      expect(await middleware.startCharging(cc)).toBe(false);
      expect(adapter.fetches).toBe(2);
    });
  });

  describe("after a command", () => {
    const TICK_MS = 30_000;
    // Tessie reporting the car at `amps`, read at `atMs`.
    const report = (amps: number, atMs: number) => {
      adapter.state = {
        ...adapter.state,
        chargeAmps: amps,
        lastUpdated: new Date(atMs).toISOString(),
      };
    };

    beforeEach(async () => {
      report(14, Date.now());
      await middleware.requestState(ctx());
      time.tick(1000);
      await middleware.setChargeAmps(8, cc);
    });

    it("keeps the expected amps while Tessie still has an older reading", async () => {
      time.tick(TICK_MS);
      const state = await middleware.requestState(ctx());
      expect(adapter.fetches).toBe(2);
      expect(state?.chargeAmps).toBe(8);
    });

    it("catches a change the car did not act on", async () => {
      time.tick(TICK_MS);
      report(14, Date.now());
      const state = await middleware.requestState(ctx());
      expect(state?.chargeAmps).toBe(14);
    });

    it("reads every tick until confirmed, then goes back to the cache", async () => {
      time.tick(TICK_MS);
      await middleware.requestState(ctx());
      time.tick(TICK_MS);
      report(8, Date.now());
      await middleware.requestState(ctx());
      time.tick(TICK_MS);
      await middleware.requestState(ctx());
      expect(adapter.fetches).toBe(3);
      expect(middleware.getCachedState()?.chargeAmps).toBe(8);
    });

    it("takes the reading as it is once the wait runs out", async () => {
      time.tick(COMMAND_CONFIRM_MS);
      const state = await middleware.requestState(ctx());
      expect(state?.chargeAmps).toBe(14);
    });

    it("waits for confirmation after a stop too", async () => {
      adapter.state = { ...adapter.state, isCharging: true };
      await middleware.stopCharging(cc);
      time.tick(TICK_MS);
      expect((await middleware.requestState(ctx()))?.isCharging).toBe(false);
      expect(adapter.fetches).toBe(2);
    });
  });
});

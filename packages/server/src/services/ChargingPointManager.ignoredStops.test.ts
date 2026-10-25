import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertExists } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import type { CallContext, ChargerState } from "@chargeha/shared";
import type { AppDatabase } from "../db/AppDatabase.ts";
import type { ChargerRow } from "../db/types.ts";
import { ChargerPluginRegistry } from "@chargeha/server/bootstrap/ChargerPluginRegistry";
import type { ChargerPlugin } from "@chargeha/shared/plugins";
import type { VehicleManager } from "./VehicleManager.ts";
import type { ConfigService } from "./ConfigService.ts";
import type { TypedEventEmitter } from "./TypedEventEmitter.ts";
import { ChargingPointManager } from "./ChargingPointManager.ts";
import { Logger } from "../lib/Logger.ts";
import { MockEventEmitter } from "../test-helpers/MockEventEmitter.ts";
import { throwingMock } from "../test-helpers/throwingMock.ts";
import { StubChargerMiddleware } from "../test-helpers/StubChargerMiddleware.ts";

// A car can accept a stop and keep drawing: preconditioning before a
// departure, or a charge schedule of its own. Re-sending the stop every loop
// only floods its API.
describe("ChargingPointManager stops the car carries on through", () => {
  const CHARGER_TYPE = "sim";
  const SMART_ROW: ChargerRow = {
    id: "charger-1",
    name: "Test Charger",
    chargerAdapterType: CHARGER_TYPE,
    chargerConfig: "{}",
    mode: "auto",
    priority: 1,
    vehicleId: null,
    kind: "smart",
    active: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  const CAR_ROW: ChargerRow = { ...SMART_ROW, kind: "vehicle_api" };
  const CTX: CallContext = { origin: "test", traceId: "test" };
  const charging = (amps: number): ChargerState => ({
    chargerId: "charger-1",
    isCharging: true,
    isPluggedIn: true,
    chargeAmps: amps,
    chargeAmpsMax: 15,
    chargeAmpsMin: 5,
    chargePowerKw: amps * 0.23,
    chargerVoltage: 230,
    chargerPhases: 1,
    energyAddedKwh: 0,
    status: "charging",
    statusDetail: null,
    controlMode: "amps",
    lastUpdated: "2024-01-01T00:00:00.000Z",
  });

  let middlewares: Map<string, StubChargerMiddleware>;
  let manager: ChargingPointManager;

  beforeEach(() => {
    middlewares = new Map();
    const registry = new ChargerPluginRegistry();
    registry.register(throwingMock<ChargerPlugin>("ChargerPlugin", {
      id: CHARGER_TYPE,
      displayName: "Simulated Charger",
      createChargerMiddleware: (row: ChargerRow) => {
        const mw = new StubChargerMiddleware(null);
        middlewares.set(row.id, mw);
        return Promise.resolve(mw);
      },
    }));
    manager = new ChargingPointManager(
      throwingMock<AppDatabase>("AppDatabase", {
        getChargerConfig: () => Promise.resolve({}),
        getChargerSecrets: () => Promise.resolve({}),
      }),
      registry,
      throwingMock<VehicleManager>("VehicleManager", {}),
      throwingMock<ConfigService>("ConfigService", {}),
      new MockEventEmitter() as unknown as TypedEventEmitter,
      new Logger("ChargingPointManager", "error"),
    );
  });

  // Asks for a stop every 30 s for `ticks` loops while the car keeps
  // charging, and returns how many stops were sent.
  const stopEveryLoop = async (
    mw: StubChargerMiddleware,
    time: FakeTime,
    ticks: number,
  ): Promise<number> => {
    const before = mw.stopCalls.length;
    await Array.from({ length: ticks }).reduce<Promise<void>>(
      async (prev) => {
        await prev;
        await manager.stopCharging(CAR_ROW.id, CTX, charging(5));
        time.tick(30_000);
      },
      Promise.resolve(),
    );
    return mw.stopCalls.length - before;
  };

  const addCar = async (): Promise<StubChargerMiddleware> => {
    await manager.addCharger(CAR_ROW);
    const mw = middlewares.get(CAR_ROW.id);
    assertExists(mw);
    return mw;
  };

  it("waits longer between stops the car keeps ignoring", async () => {
    const time = new FakeTime();
    try {
      const mw = await addCar();
      // 29 minutes of loops: the first four go, then holds of 1, 2, 4 and
      // 8 minutes.
      expect(await stopEveryLoop(mw, time, 58)).toBe(8);
    } finally {
      time.restore();
    }
  });

  it("still sends a stop asked for by hand", async () => {
    const time = new FakeTime();
    try {
      const mw = await addCar();
      await stopEveryLoop(mw, time, 4);

      const result = await manager.stopCharging(
        CAR_ROW.id,
        CTX,
        charging(5),
        { force: true },
      );

      expect(result.success).toBe(true);
      expect(mw.stopCalls).toHaveLength(5);
    } finally {
      time.restore();
    }
  });

  it("starts counting again once the car has stopped", async () => {
    const time = new FakeTime();
    try {
      const mw = await addCar();
      await stopEveryLoop(mw, time, 4);
      time.tick(60_000);
      await manager.stopCharging(CAR_ROW.id, CTX, {
        ...charging(0),
        isCharging: false,
      });

      expect(await stopEveryLoop(mw, time, 4)).toBe(4);
    } finally {
      time.restore();
    }
  });
});

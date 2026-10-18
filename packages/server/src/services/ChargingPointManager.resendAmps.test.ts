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

// A car's API can accept an amps command the car then drops. The command must
// go again, or the car sits at its old amps until the target next changes.
describe("ChargingPointManager amps command the car dropped", () => {
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

  // Commands 15 A, waits, then commands 15 A again while the car still
  // reports 7 A. Returns the amps actually sent.
  const commandTwice = async (
    row: ChargerRow,
    waitMs: number,
  ): Promise<number[]> => {
    const time = new FakeTime();
    try {
      await manager.addCharger(row);
      const mw = middlewares.get(row.id);
      assertExists(mw);
      await manager.startChargingAt(row.id, 15, CTX, charging(7));
      time.tick(waitMs);
      await manager.startChargingAt(row.id, 15, CTX, charging(7));
      return mw.setAmpsCalls.map((c) => c.amps);
    } finally {
      time.restore();
    }
  };

  it("sends it again once the car has had a minute to apply it", async () => {
    expect(await commandTwice(CAR_ROW, 60_000)).toEqual([15, 15]);
  });

  it("does not send it again within the minute", async () => {
    expect(await commandTwice(CAR_ROW, 59_000)).toEqual([15]);
  });

  it("keeps sending it a minute apart while the car keeps dropping it", async () => {
    const time = new FakeTime();
    try {
      await manager.addCharger(CAR_ROW);
      const mw = middlewares.get(CAR_ROW.id);
      assertExists(mw);
      await manager.startChargingAt(CAR_ROW.id, 15, CTX, charging(7));
      time.tick(60_000);
      await manager.startChargingAt(CAR_ROW.id, 15, CTX, charging(7));
      time.tick(30_000);
      await manager.startChargingAt(CAR_ROW.id, 15, CTX, charging(7));
      time.tick(30_000);
      await manager.startChargingAt(CAR_ROW.id, 15, CTX, charging(7));
      expect(mw.setAmpsCalls.map((c) => c.amps)).toEqual([15, 15, 15]);
    } finally {
      time.restore();
    }
  });

  it("never re-sends to a smart charger, whose amps are measured draw", async () => {
    expect(await commandTwice(SMART_ROW, 10 * 60_000)).toEqual([15]);
  });
});

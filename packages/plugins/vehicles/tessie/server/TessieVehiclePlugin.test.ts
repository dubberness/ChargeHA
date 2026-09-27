import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ChargerRow, VehicleRow } from "@chargeha/shared";
import type { PluginDependencies } from "@chargeha/server/bootstrap/PluginDependencies";
import { Logger } from "@chargeha/server/lib/Logger";
import { PluginDbLogger } from "@chargeha/server/lib/PluginDbLogger";
import { buildVehicleChargeState } from "@chargeha/shared/test-factories";
import { throwingMock } from "../../../../server/src/test-helpers/throwingMock.ts";
import {
  checkTessieAuthHealth,
  TessieVehiclePlugin,
} from "./TessieVehiclePlugin.ts";

describe("TessieVehiclePlugin", () => {
  const VEHICLE: VehicleRow = {
    id: "VIN1",
    name: "Model 3",
    adapterType: "tessie",
    priority: 1,
    config: "{}",
    mode: "auto",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const CHARGER: ChargerRow = {
    id: "vehicle:VIN1",
    name: "Model 3",
    chargerAdapterType: "tessie",
    chargerConfig: "{}",
    mode: "auto",
    priority: 1,
    vehicleId: "VIN1",
    kind: "vehicle_api",
    active: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const logger = new Logger("TessiePlugin", "error");

  function makeDeps(
    { token = "tok", vehicles = [VEHICLE] }: {
      token?: string | null;
      vehicles?: VehicleRow[];
    } = {},
  ) {
    const secrets = new Map<string, string | null>([["api_token", token]]);
    const upserted: string[] = [];
    const deleted: string[] = [];
    const deps = throwingMock<PluginDependencies>("PluginDependencies", {
      pluginId: "tessie",
      log: logger,
      dbLog: new PluginDbLogger(() => Promise.resolve(), logger),
      getSecret: (key: string) => Promise.resolve(secrets.get(key) ?? null),
      setSecret: (key: string, value: string | null) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      getVehicleRows: () => Promise.resolve(vehicles),
      getVehicleRow: (id: string) =>
        Promise.resolve(vehicles.find((v) => v.id === id) ?? null),
      upsertVehicleRow: (row: { id: string }) => {
        upserted.push(row.id);
        return Promise.resolve();
      },
      addVehicle: () => Promise.resolve(),
      deleteVehicle: (id: string) => {
        deleted.push(id);
        return Promise.resolve();
      },
    });
    return { deps, secrets, upserted, deleted };
  }

  function fetchReturning(status: number, body: unknown) {
    return {
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify(body), { status }),
        )) as typeof globalThis.fetch,
    };
  }

  describe("checkTessieAuthHealth", () => {
    it("is ok when no vehicle is configured", () => {
      expect(
        checkTessieAuthHealth({
          tokenConfigured: false,
          tokenRejected: false,
          vehicleConfigured: false,
        }).status,
      ).toBe("ok");
    });

    it("errors when vehicles exist without a token", () => {
      expect(
        checkTessieAuthHealth({
          tokenConfigured: false,
          tokenRejected: false,
          vehicleConfigured: true,
        }).status,
      ).toBe("error");
    });

    it("errors when the token was rejected", () => {
      expect(
        checkTessieAuthHealth({
          tokenConfigured: true,
          tokenRejected: true,
          vehicleConfigured: true,
        }).status,
      ).toBe("error");
    });
  });

  describe("plugin", () => {
    it("disables commands until a token is saved", async () => {
      const { deps } = makeDeps({ token: null });
      const plugin = new TessieVehiclePlugin(deps);
      const status = await plugin.getCommandStatus();
      expect(status.commandsDisabled).toBe(true);
      expect(status.reason).toContain("Tessie API token");
      await plugin.shutdown();
    });

    it("enables commands with a token", async () => {
      const { deps } = makeDeps();
      const plugin = new TessieVehiclePlugin(deps);
      expect(await plugin.getCommandStatus()).toEqual({
        commandsDisabled: false,
        reason: null,
      });
      await plugin.shutdown();
    });

    it("reports a working token with its vehicle count", async () => {
      const { deps } = makeDeps();
      const plugin = new TessieVehiclePlugin(
        deps,
        fetchReturning(200, { results: [{ vin: "A" }, { vin: "B" }] }),
      );
      expect(await plugin.testToken("candidate")).toEqual({
        success: true,
        vehicleCount: 2,
      });
      await plugin.shutdown();
    });

    it("reports a rejected token without throwing", async () => {
      const { deps } = makeDeps();
      const plugin = new TessieVehiclePlugin(deps, fetchReturning(401, {}));
      const result = await plugin.testToken("bad");
      expect(result.success).toBe(false);
      expect(result.error).toContain("rejected the API token");
      await plugin.shutdown();
    });

    it("saves each selected vehicle", async () => {
      const { deps, upserted } = makeDeps();
      const plugin = new TessieVehiclePlugin(deps);
      await plugin.selectVehicles({
        vehicles: [
          { vin: "VIN1", name: "A", priority: 1 },
          { vin: "VIN2", name: "B", priority: 2 },
        ],
      });
      expect(upserted).toEqual(["VIN1", "VIN2"]);
      await plugin.shutdown();
    });

    it("removes vehicles and the token on disconnect", async () => {
      const { deps, secrets, deleted } = makeDeps();
      const plugin = new TessieVehiclePlugin(deps);
      await plugin.disconnect();
      expect(deleted).toEqual(["VIN1"]);
      expect(secrets.get("api_token")).toBeNull();
      await plugin.shutdown();
    });

    it("shares one middleware between the vehicle and charger roles", async () => {
      const { deps } = makeDeps();
      const plugin = new TessieVehiclePlugin(deps);
      const vehicle = await plugin.createVehicleMiddleware(VEHICLE);
      await plugin.createChargerMiddleware(CHARGER, {
        config: { min_amps: "3" },
        secrets: {},
      });
      // The charger row's floor lands on the shared vehicle middleware.
      vehicle.seedState(
        buildVehicleChargeState({ vehicleId: "VIN1", chargeAmpsMin: 5 }),
      );
      expect(vehicle.getCachedState()?.chargeAmpsMin).toBe(3);
      await plugin.shutdown();
    });

    it("rejects a charger row with no vehicle", async () => {
      const { deps } = makeDeps();
      const plugin = new TessieVehiclePlugin(deps);
      await expect(
        plugin.createChargerMiddleware({ ...CHARGER, vehicleId: null }, {
          config: {},
          secrets: {},
        }),
      ).rejects.toThrow("has no vehicleId");
      await plugin.shutdown();
    });
  });
});

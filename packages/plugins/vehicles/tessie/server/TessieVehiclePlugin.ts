import { TRPCError } from "@trpc/server";
import type { ChargerRow, VehicleRow } from "@chargeha/shared";
import { createTraceId } from "@chargeha/shared";
import { inSequence } from "@chargeha/shared/async";
import { deserializeSection } from "@chargeha/shared/configSections";
import type { PluginDependencies } from "@chargeha/server/bootstrap/PluginDependencies";
import type {
  ChargerMiddleware,
  ChargerPlugin,
  ChargerRowConfig,
  CommandStatus,
  HealthCheckResult,
  PluginHealthCheck,
  PluginHttpRoutes,
  PluginTunnelRoute,
  VehicleMiddleware,
  VehiclePlugin,
} from "@chargeha/shared/plugins";
import { TessieAdapter } from "./TessieAdapter.ts";
import { TessieChargerMiddleware } from "./TessieChargerMiddleware.ts";
import {
  TessieClient,
  type TessieClientIo,
  type TessieVehicleSummary,
} from "./TessieClient.ts";
import { TessieVehicleMiddleware } from "./TessieVehicleMiddleware.ts";
import { TESSIE_SECRET_KEYS, tessieConfigDef } from "./config.ts";
import { tessieChargerConfigDef } from "./chargerConfig.ts";
import { createTessieRouter } from "./router.ts";

export interface TessieStatus {
  tokenConfigured: boolean;
  // The stored token was refused on the most recent request.
  tokenRejected: boolean;
  vehicleConfigured: boolean;
}

export interface TessieTokenTestResult {
  success: boolean;
  vehicleCount?: number;
  error?: string;
}

// Only a problem once a car is set up — an unconfigured plugin is not an
// error. Reads the client's last result, so the check costs no request.
export function checkTessieAuthHealth(status: TessieStatus): HealthCheckResult {
  if (!status.vehicleConfigured) return { status: "ok" };
  if (!status.tokenConfigured) {
    return { status: "error", message: "No Tessie API token is configured." };
  }
  if (status.tokenRejected) return { status: "error" };
  return { status: "ok" };
}

// Tessie vehicle plugin — Tesla vehicles through Tessie's API instead of
// Tesla's Fleet API. One API token replaces the Fleet API's developer app,
// key pair, partner registration, OAuth, command proxy and virtual key
// pairing. Like the Tesla plugin, one instance serves both the vehicle and
// the charger role, sharing one middleware per car.
export class TessieVehiclePlugin implements VehiclePlugin, ChargerPlugin {
  readonly id = "tessie";
  readonly displayName = "Tessie";
  readonly vendor = "Tesla";
  readonly configDef = tessieConfigDef;
  readonly secretKeys = TESSIE_SECRET_KEYS;
  readonly settingsComponentKey = "tessie-settings";

  readonly client: TessieClient;

  private readonly middlewares = new Map<string, TessieVehicleMiddleware>();
  private readonly startupPromise: Promise<void>;

  constructor(
    private readonly deps: PluginDependencies,
    io?: TessieClientIo,
  ) {
    this.client = new TessieClient(
      () => deps.getSecret("api_token"),
      deps.log,
      deps.dbLog,
      io,
    );
    this.startupPromise = this.startup();
  }

  private async startup(): Promise<void> {
    const rows = await this.deps.getVehicleRows();
    await Promise.all(rows.map((row) => this.deps.addVehicle(row)));
  }

  // deno-lint-ignore require-await
  async createVehicleMiddleware(row: VehicleRow): Promise<VehicleMiddleware> {
    return this.sharedMiddleware(row);
  }

  private sharedMiddleware(row: VehicleRow): TessieVehicleMiddleware {
    const existing = this.middlewares.get(row.id);
    if (existing) return existing;
    const adapter = new TessieAdapter(row.id, this.client, this.deps.log);
    const created = new TessieVehicleMiddleware(adapter, this.deps.log);
    this.middlewares.set(row.id, created);
    return created;
  }

  async createChargerMiddleware(
    row: ChargerRow,
    resolved: ChargerRowConfig,
  ): Promise<ChargerMiddleware> {
    if (row.vehicleId === null) {
      throw new Error(`Tessie charger row ${row.id} has no vehicleId`);
    }
    const vehicles = await this.deps.getVehicleRows();
    const vehicle = vehicles.find((v) => v.id === row.vehicleId);
    if (!vehicle) {
      throw new Error(
        `No Tessie vehicle ${row.vehicleId} for charger ${row.id}`,
      );
    }
    const shared = this.sharedMiddleware(vehicle);
    const { tessieMinAmps } = deserializeSection(
      tessieChargerConfigDef,
      resolved.config,
    );
    shared.setMinAmps(Number(tessieMinAmps));
    return new TessieChargerMiddleware(row, shared);
  }

  async shutdown(): Promise<void> {
    await this.startupPromise.catch((err) => {
      this.deps.log.error("Startup had failed before shutdown:", err);
    });
    this.middlewares.clear();
  }

  async getStatus(): Promise<TessieStatus> {
    const [token, vehicles] = await Promise.all([
      this.deps.getSecret("api_token"),
      this.deps.getVehicleRows(),
    ]);
    return {
      tokenConfigured: !!token,
      tokenRejected: this.client.lastAuthRejected,
      vehicleConfigured: vehicles.length > 0,
    };
  }

  // Try a token before it is saved. Never throws for a bad token — the
  // wizard shows the message next to the field.
  async testToken(token: string): Promise<TessieTokenTestResult> {
    try {
      const vehicles = await this.client.listVehicles(
        { origin: "user:tessie-test-token", traceId: createTraceId() },
        token,
      );
      return { success: true, vehicleCount: vehicles.length };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Connection failed";
      // A mistyped token is expected; the message is enough, not a stack.
      this.deps.log.warn(`Tessie token test failed: ${error}`);
      return { success: false, error };
    }
  }

  async listAccountVehicles(): Promise<{ vehicles: TessieVehicleSummary[] }> {
    try {
      const vehicles = await this.client.listVehicles({
        origin: "user:tessie-list-vehicles",
        traceId: createTraceId(),
      });
      return { vehicles };
    } catch (err) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: err instanceof Error ? err.message : "Failed to list vehicles",
        cause: err,
      });
    }
  }

  async selectVehicles(
    input: { vehicles: { vin: string; name?: string; priority: number }[] },
  ): Promise<{ success: true; vins: string[] }> {
    await inSequence(input.vehicles, (vehicle) => this.saveVehicle(vehicle));
    return { success: true as const, vins: input.vehicles.map((v) => v.vin) };
  }

  private async saveVehicle(
    vehicle: { vin: string; name?: string; priority: number },
  ): Promise<void> {
    await this.deps.upsertVehicleRow({
      id: vehicle.vin,
      name: vehicle.name ?? "Tesla",
      priority: vehicle.priority,
      config: JSON.stringify({}),
      mode: "auto" as const,
    });
    const row = await this.deps.getVehicleRow(vehicle.vin);
    if (row) await this.deps.addVehicle(row);
  }

  // Remove every Tessie vehicle and forget the token.
  async disconnect(): Promise<{ success: true }> {
    const vehicles = await this.deps.getVehicleRows();
    await inSequence(vehicles, (v) => this.deps.deleteVehicle(v.id));
    this.middlewares.clear();
    await this.deps.setSecret("api_token", null);
    this.deps.log.info("Tessie disconnected — token and vehicles removed");
    return { success: true as const };
  }

  getRouter() {
    return createTessieRouter(this, this.deps);
  }

  async getCommandStatus(): Promise<CommandStatus> {
    const status = await this.getStatus();
    if (!status.tokenConfigured) {
      return {
        commandsDisabled: true,
        reason: "Add your Tessie API token in Settings to control charging.",
      };
    }
    if (status.tokenRejected) {
      return {
        commandsDisabled: true,
        reason:
          "Tessie rejected the API token. Generate a new one in Tessie and update it in Settings.",
      };
    }
    return { commandsDisabled: false, reason: null };
  }

  getVehicleHttpRoutes(): PluginHttpRoutes | null {
    return null;
  }

  getChargerHttpRoutes(): PluginHttpRoutes | null {
    return null;
  }

  getTunnelRoutes(): PluginTunnelRoute[] {
    return [];
  }

  getHealthChecks(): PluginHealthCheck[] {
    return [
      {
        name: "tessie-auth",
        timeoutMs: 5000,
        warningTitle: "Tessie Not Authenticated",
        warningMessage:
          "Tessie rejected the API token, so polling and charging control have stopped. Update the token in Settings.",
        run: async () => checkTessieAuthHealth(await this.getStatus()),
      },
    ];
  }
}

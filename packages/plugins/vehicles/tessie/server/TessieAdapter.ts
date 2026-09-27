import type {
  AdapterVehicleChargeState,
  CallContext,
  VehicleAdapter,
} from "@chargeha/shared";
import type { Logger } from "@chargeha/server/lib/Logger";
import { shortId } from "@chargeha/shared/redact";
import { toAdapterChargeState } from "../../tesla/shared/vehicleData.ts";
import type { TessieClient } from "./TessieClient.ts";
import { DEFAULT_MIN_AMPS } from "./chargerConfig.ts";

// One vehicle on a Tessie account. Tessie returns Tesla's own vehicle_data
// shape, so the mapping is the Tesla plugin's.
export class TessieAdapter implements VehicleAdapter {
  constructor(
    private readonly vin: string,
    private readonly client: TessieClient,
    private readonly logger: Logger,
  ) {}

  async connect(ctx: CallContext): Promise<void> {
    await this.client.getStatus(this.vin, ctx);
    this.logger.info(`Connected to vehicle ${shortId(this.vin)} via Tessie`);
  }

  async disconnect(): Promise<void> {
    // Stateless HTTP — nothing to close.
  }

  async getChargeState(ctx: CallContext): Promise<AdapterVehicleChargeState> {
    const data = await this.client.getState(this.vin, ctx);
    return toAdapterChargeState(this.vin, data, DEFAULT_MIN_AMPS);
  }

  startCharging(ctx: CallContext): Promise<boolean> {
    return this.client.command(this.vin, "start_charging", {}, ctx);
  }

  stopCharging(ctx: CallContext): Promise<boolean> {
    return this.client.command(this.vin, "stop_charging", {}, ctx);
  }

  setChargeAmps(amps: number, ctx: CallContext): Promise<boolean> {
    return this.client.command(
      this.vin,
      "set_charging_amps",
      { amps: String(amps) },
      ctx,
    );
  }

  setChargeLimit(percent: number, ctx: CallContext): Promise<boolean> {
    return this.client.command(
      this.vin,
      "set_charge_limit",
      { percent: String(percent) },
      ctx,
    );
  }

  wakeVehicle(ctx: CallContext): Promise<boolean> {
    return this.client.wake(this.vin, ctx);
  }

  // "waiting_for_sleep" is still awake and answering.
  async isVehicleOnline(ctx: CallContext): Promise<boolean> {
    return (await this.client.getStatus(this.vin, ctx)) !== "asleep";
  }
}

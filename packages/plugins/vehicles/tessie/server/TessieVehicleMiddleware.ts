import type { AdapterVehicleChargeState, CallContext } from "@chargeha/shared";
import type {
  VehicleMiddleware,
  VehicleRequestContext,
} from "@chargeha/shared/plugins";
import type { Logger } from "@chargeha/server/lib/Logger";
import type { TessieAdapter } from "./TessieAdapter.ts";
import { DEFAULT_MIN_AMPS } from "./chargerConfig.ts";

// How long a fetched state is served before the next controller tick reads
// Tessie again. Tessie reads are free and never wake the car, so there is no
// cost model to tune — this only keeps the request rate polite.
export const STATE_CACHE_MS = 60_000;

// Tessie vehicle middleware. Much simpler than the Tesla Fleet one: Tessie
// serves its own last-known state without waking the car, and its commands
// wake the car themselves, so there is no wake budget to protect.
export class TessieVehicleMiddleware implements VehicleMiddleware {
  private cachedState: AdapterVehicleChargeState | null = null;
  // The vehicle_api charger row owns the floor; the adapter cannot see row
  // config. Held here so both roles report the same number.
  private minAmps = DEFAULT_MIN_AMPS;
  private lastFetchAtMs = 0;

  constructor(
    private readonly adapter: TessieAdapter,
    private readonly logger: Logger,
  ) {}

  get online(): boolean {
    return this.cachedState?.isOnline ?? false;
  }

  setMinAmps(amps: number): void {
    this.minAmps = amps;
  }

  getCachedState(): AdapterVehicleChargeState | null {
    if (!this.cachedState) return null;
    return { ...this.cachedState, chargeAmpsMin: this.minAmps };
  }

  seedState(state: AdapterVehicleChargeState): void {
    if (this.cachedState) {
      this.logger.debug("seedState skipped: cache already has data");
      return;
    }
    // Historical data says nothing about whether the car is awake now.
    this.cachedState = { ...state, isOnline: false };
  }

  async requestState(
    context: VehicleRequestContext,
  ): Promise<AdapterVehicleChargeState | null> {
    const age = Date.now() - this.lastFetchAtMs;
    if (!context.forceRefresh && this.cachedState && age < STATE_CACHE_MS) {
      this.logger.debug(`Cache fresh (age=${Math.round(age / 1000)}s)`);
      return this.getCachedState();
    }

    const state = await this.fetchAndCache(withSuffix(context, "state"));
    // A user-initiated refresh of a sleeping car wakes it, matching the
    // Tesla plugin's forceRefresh. Nothing else ever wakes it just to read.
    if (!context.forceRefresh || state.isOnline) return state;

    this.logger.info("Asleep — waking for user refresh");
    const woke = await this.adapter.wakeVehicle(withSuffix(context, "wake"));
    if (!woke) {
      this.logger.warn("Wake failed — returning last-known state");
      return state;
    }
    return this.fetchAndCache(withSuffix(context, "state"));
  }

  async startCharging(ctx: CallContext): Promise<boolean> {
    const ok = await this.adapter.startCharging(ctx);
    if (ok && this.cachedState) {
      this.cachedState = {
        ...this.cachedState,
        isCharging: true,
        lastUpdated: new Date().toISOString(),
      };
      // Expire the cache so the next tick reads real charger voltage/phases,
      // which the car only reports while charging.
      this.lastFetchAtMs = 0;
    } else if (!ok) {
      await this.refreshCacheAfterRejection(withSuffix(ctx, "post-reject"));
    }
    return ok;
  }

  async stopCharging(ctx: CallContext): Promise<boolean> {
    const ok = await this.adapter.stopCharging(ctx);
    if (ok && this.cachedState) {
      this.cachedState = {
        ...this.cachedState,
        isCharging: false,
        chargePowerKw: 0,
        chargeAmps: 0,
        lastUpdated: new Date().toISOString(),
      };
    } else if (!ok) {
      await this.refreshCacheAfterRejection(withSuffix(ctx, "post-reject"));
    }
    return ok;
  }

  async setChargeAmps(amps: number, ctx: CallContext): Promise<boolean> {
    const ok = await this.adapter.setChargeAmps(amps, ctx);
    if (ok && this.cachedState) {
      this.cachedState = {
        ...this.cachedState,
        chargeAmps: amps,
        lastUpdated: new Date().toISOString(),
      };
    } else if (!ok) {
      await this.refreshCacheAfterRejection(withSuffix(ctx, "post-reject"));
    }
    return ok;
  }

  // The car refused the command, so the cache is out of step with it.
  private async refreshCacheAfterRejection(ctx: CallContext): Promise<void> {
    try {
      await this.fetchAndCache(ctx);
    } catch (e) {
      this.logger.warn("Failed to refresh state after command rejection", e);
    }
  }

  private async fetchAndCache(
    ctx: CallContext,
  ): Promise<AdapterVehicleChargeState> {
    const state = await this.adapter.getChargeState(ctx);
    this.cachedState = state;
    this.lastFetchAtMs = Date.now();
    return { ...state, chargeAmpsMin: this.minAmps };
  }
}

function withSuffix(ctx: CallContext, suffix: string): CallContext {
  return { ...ctx, origin: `${ctx.origin}:${suffix}` };
}

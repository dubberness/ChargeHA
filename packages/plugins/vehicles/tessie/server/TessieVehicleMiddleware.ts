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

// After a command the car is read again on every tick until Tessie reports a
// reading taken after it, so a command the car accepted but did not act on is
// caught within a tick. Tessie only refreshes about once a minute, so the
// first re-read often still predates the command; this caps the wait if
// Tessie stops updating (e.g. the car fell asleep).
export const COMMAND_CONFIRM_MS = 3 * 60_000;

// Tessie vehicle middleware. Much simpler than the Tesla Fleet one: Tessie
// serves its own last-known state without waking the car, and its commands
// wake the car themselves, so there is no wake budget to protect.
export class TessieVehicleMiddleware implements VehicleMiddleware {
  private cachedState: AdapterVehicleChargeState | null = null;
  // The vehicle_api charger row owns the floor; the adapter cannot see row
  // config. Held here so both roles report the same number.
  private minAmps = DEFAULT_MIN_AMPS;
  private lastFetchAtMs = 0;
  // When the last successful command was sent, until a reading confirms it.
  private unconfirmedCommandAtMs: number | null = null;

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
    const cacheUsable = this.cachedState !== null &&
      this.unconfirmedCommandAtMs === null && age < STATE_CACHE_MS;
    if (!context.forceRefresh && cacheUsable) {
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
    if (ok) {
      // The re-read also picks up real charger voltage/phases, which the car
      // only reports while charging.
      this.expectAfterCommand({ isCharging: true });
    } else {
      await this.refreshCacheAfterRejection(withSuffix(ctx, "post-reject"));
    }
    return ok;
  }

  async stopCharging(ctx: CallContext): Promise<boolean> {
    const ok = await this.adapter.stopCharging(ctx);
    if (ok) {
      this.expectAfterCommand({
        isCharging: false,
        chargePowerKw: 0,
        chargeAmps: 0,
      });
    } else {
      await this.refreshCacheAfterRejection(withSuffix(ctx, "post-reject"));
    }
    return ok;
  }

  async setChargeAmps(amps: number, ctx: CallContext): Promise<boolean> {
    const ok = await this.adapter.setChargeAmps(amps, ctx);
    if (ok) {
      this.expectAfterCommand({ chargeAmps: amps });
    } else {
      await this.refreshCacheAfterRejection(withSuffix(ctx, "post-reject"));
    }
    return ok;
  }

  // Tessie accepting a command means the car acknowledged it, not that it
  // acted on it — a car still ramping up can drop a second amps change. Show
  // the expected result now, and re-read until a reading confirms it.
  private expectAfterCommand(patch: Partial<AdapterVehicleChargeState>): void {
    const now = Date.now();
    this.unconfirmedCommandAtMs = now;
    if (!this.cachedState) return;
    this.cachedState = {
      ...this.cachedState,
      ...patch,
      lastUpdated: new Date(now).toISOString(),
    };
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
    this.lastFetchAtMs = Date.now();
    const expected = this.getCachedState();
    if (expected && this.predatesUnconfirmedCommand(state)) {
      this.logger.debug("Tessie has not reported since the last command yet");
      return expected;
    }
    this.unconfirmedCommandAtMs = null;
    this.cachedState = state;
    return { ...state, chargeAmpsMin: this.minAmps };
  }

  // A reading taken before the last command says nothing about whether the
  // car acted on it. Keep the expected state and read again next tick — until
  // COMMAND_CONFIRM_MS, after which the reading is taken as it is.
  private predatesUnconfirmedCommand(
    state: AdapterVehicleChargeState,
  ): boolean {
    const sentAt = this.unconfirmedCommandAtMs;
    if (sentAt === null) return false;
    if (Date.now() - sentAt >= COMMAND_CONFIRM_MS) return false;
    return Date.parse(state.lastUpdated) < sentAt;
  }
}

function withSuffix(ctx: CallContext, suffix: string): CallContext {
  return { ...ctx, origin: `${ctx.origin}:${suffix}` };
}

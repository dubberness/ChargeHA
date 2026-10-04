import { SolarAllocator } from "./SolarAllocator.ts";
import { Trace } from "./Trace.ts";
import { StepOrchestrator } from "./StepOrchestrator.ts";
import { solarOnlyConfig, solarOnlyCushionW } from "./SolarOnly.ts";
import type {
  EngineInput,
  EngineOutput,
  VehicleControlState,
  VehicleDecision,
} from "./types.ts";
import { createControlState } from "./types.ts";

// Pure decision engine for the charge controller. Owns per-vehicle runtime
// state (grace periods, cooldowns, amp debouncing) and exposes a single
// `decide()` method. No I/O, no database, no adapters — the caller (ChargeController or the simulator) executes the returned decisions.
export class ControllerEngine {
  private controlStates = new Map<string, VehicleControlState>();

  decide(input: EngineInput): EngineOutput {
    const { vehicles, activeBlockout, energy, now, timestamp } = input;
    if (!input.config.chargingEnabled) {
      const decisions = new Map(
        vehicles.map((vehicle): [string, VehicleDecision] => [vehicle.id, {
          action: "none",
          reason: "charging_disabled",
          detail: "Charging disabled",
          targetAmps: null,
          checks: [],
        }]),
      );
      return { decisions, controlStates: this.controlStates };
    }

    // A blockout that allows solar tracks under its own, tighter rules.
    const solarOnly = activeBlockout?.allowSolar === true;
    const config = solarOnly ? solarOnlyConfig(input.config) : input.config;
    const cushionW = solarOnly ? solarOnlyCushionW(config) : 0;

    // Pre-compute per-vehicle solar allocation
    const allocation = SolarAllocator.allocate(
      vehicles,
      { ...config, solarMarginKw: config.solarMarginKw + cushionW / 1000 },
      energy,
    );
    vehicles.forEach((vehicle) => {
      const cs = this.getControlState(vehicle.id);
      this.controlStates.set(vehicle.id, {
        ...cs,
        allocatedAmps: allocation.get(vehicle.id) ?? null,
      });
    });

    const decisions = new Map(
      vehicles.map((vehicle): [string, VehicleDecision] => {
        const { state } = vehicle;
        if (!state) return [vehicle.id, noState()];
        const cs = this.getControlState(vehicle.id);
        const { decision, stateUpdates } = StepOrchestrator.run({
          vehicle,
          state,
          config,
          activeBlockout,
          energy,
          now,
          timestamp,
          cs,
          solar: SolarAllocator.targets(
            state,
            config,
            energy,
            cs.allocatedAmps,
            cushionW,
          ),
        });
        // The settle clocks only run while their own step keeps deciding;
        // any other outcome starts them again.
        this.controlStates.set(vehicle.id, {
          ...cs,
          solarReadySince: null,
          ...(solarOnly ? { pendingAmps: null, pendingSince: null } : {}),
          ...stateUpdates,
        });
        return [vehicle.id, decision];
      }),
    );

    return { decisions, controlStates: this.controlStates };
  }

  // Read a vehicle's control state (for the orchestrator's event emission).
  getControlState(vehicleId: string): VehicleControlState {
    const existing = this.controlStates.get(vehicleId);
    if (existing) return existing;
    const cs = createControlState();
    this.controlStates.set(vehicleId, cs);
    return cs;
  }
}

function noState(): VehicleDecision {
  return {
    action: "none",
    reason: "no_state",
    detail: "No vehicle state available",
    targetAmps: null,
    checks: [Trace.vehicleStateUnavailable()],
  };
}

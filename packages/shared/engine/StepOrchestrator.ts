import { Steps } from "./Steps.ts";
import type { Step, StepContext } from "./Steps.ts";
import { Trace } from "./Trace.ts";
import type { StepTrace } from "./Trace.ts";
import type { ControlStateUpdates, VehicleDecision } from "./types.ts";

// Final decision plus the control-state changes the engine applies.
export interface StepRunResult {
  decision: VehicleDecision;
  stateUpdates: ControlStateUpdates;
}

export class StepOrchestrator {
  // Evaluated in order. The first step to return a decision ends the run.
  static readonly ORDER: readonly Step[] = [
    Steps.pluggedIn,
    Steps.atHome,
    Steps.batteryAtLimit,
    Steps.mode,
    Steps.blockout,
    Steps.chargeSchedule,
    Steps.batteryPriority,
    Steps.solarTrackingGate,
    Steps.minSolarGeneration,
    Steps.minExcessSolar,
    Steps.displaced,
    Steps.insufficientSolar,
    Steps.cooldown,
    Steps.steadySolar,
    Steps.sufficientSolar,
    Steps.idle,
  ];

  static run(ctx: StepContext): StepRunResult {
    return StepOrchestrator.holdWhileConditioning(
      ctx.state,
      StepOrchestrator.runFrom(ctx, 0, []),
    );
  }

  // A car heating or cooling itself on the cable reports the draw as
  // charging and keeps drawing through a stop, so stopping (or counting down
  // to a stop) only spams commands. Hold it at minimum amps instead, which
  // is the least it can take from the wall; the car tops up the rest from
  // its battery. Stop mode is the user's own call and still stops.
  private static holdWhileConditioning(
    state: StepContext["state"],
    result: StepRunResult,
  ): StepRunResult {
    const { decision } = result;
    if (state.isConditioning !== true || !state.isCharging) return result;
    if (decision.reason === "mode_stop") return result;
    if (decision.action !== "stop" && decision.reason !== "grace_period") {
      return result;
    }
    const min = state.chargeAmpsMin;
    const lower = state.chargeAmps > min;
    return {
      decision: {
        action: lower ? "adjust_amps" : "none",
        reason: "conditioning",
        detail: lower
          ? `Adjust to ${min}A (min) — car is preheating, a stop would not end the draw`
          : `Holding at ${min}A — car is preheating, a stop would not end the draw`,
        targetAmps: lower ? min : null,
        checks: [...decision.checks, Trace.conditioning(decision.detail)],
      },
      stateUpdates: { graceStartedAt: null, graceNotified: false },
    };
  }

  private static runFrom(
    ctx: StepContext,
    index: number,
    collected: StepTrace[],
  ): StepRunResult {
    const step = StepOrchestrator.ORDER[index];
    if (!step) throw new Error("Step pipeline ended without a decision");
    const result = step(ctx);
    const checks = [...collected, ...result.trace];
    if (!result.decision) {
      return StepOrchestrator.runFrom(ctx, index + 1, checks);
    }
    return {
      decision: { ...result.decision, checks },
      stateUpdates: result.stateUpdates ?? {},
    };
  }
}

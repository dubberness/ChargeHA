import type { ControllerConfig } from "./types.ts";

// Rules for a blockout that allows solar. Grid charging stays blocked, and
// solar tracking is tightened so a dip stops the charge instead of being
// ridden out on the grid.
export const SOLAR_ONLY = {
  // Left exporting while charging, to absorb the lag between a cloud and the
  // car's response. Spent before a charging car is counted as short.
  cushionKw: 0.3,
  // How long a car at minimum amps may stay short before it is stopped —
  // long enough for its own ramp-down to reach the meter, no longer.
  graceSeconds: 30,
  // The surplus must hold this long before a charge is started.
  startSettleSeconds: 180,
  // A higher surplus must hold this long before the amps are raised to it.
  rampSettleSeconds: 60,
  // Wait after a stop. Short, because the start settle follows it.
  cooldownSeconds: 300,
  // Controller loop interval while a car is charging under one.
  loopSeconds: 10,
} as const;

// The config solar tracking runs under while a solar-only blockout is in
// force: surplus only, never the grid, and its own shorter timings. A
// configured timing that is already shorter is kept.
export function solarOnlyConfig(config: ControllerConfig): ControllerConfig {
  const atMost = (minutes: number, seconds: number) =>
    Math.min(minutes, seconds / 60);
  return {
    ...config,
    solarTrackingMode: "solar_only",
    solarReference: "excess",
    gracePeriodMinutes: atMost(
      config.gracePeriodMinutes,
      SOLAR_ONLY.graceSeconds,
    ),
    cooldownPeriodMinutes: atMost(
      config.cooldownPeriodMinutes,
      SOLAR_ONLY.cooldownSeconds,
    ),
    ampDebounceSettleMinutes: atMost(
      config.ampDebounceSettleMinutes,
      SOLAR_ONLY.rampSettleSeconds,
    ),
  };
}

// The cushion in watts, over whatever margin is already configured.
export function solarOnlyCushionW(config: ControllerConfig): number {
  return Math.max(0, SOLAR_ONLY.cushionKw - config.solarMarginKw) * 1000;
}

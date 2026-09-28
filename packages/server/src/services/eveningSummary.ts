// The evening summary: today's solar against the forecast, tomorrow's
// forecast, and what each car gets tonight. Pure; SolarChargePlanner
// gathers the inputs and sends it.
import type { SolarForecastSummary } from "@chargeha/shared/solarForecast";
import type { SolarPlan } from "@chargeha/shared/engine";
import type { VehicleChargeState } from "@chargeha/shared";
import { zonedParts } from "@chargeha/shared/timezone";

export interface SummaryCar {
  name: string;
  state: VehicleChargeState | null;
  solarKwhToday: number;
  // The next solar-aware top-up, when one opens within a day.
  tonight: {
    startTime: string;
    limitPct: number;
    plan: SolarPlan | null;
  } | null;
}

const kwh = (wh: number) => (wh / 1000).toFixed(1);

// True once the local time reaches `time` ("HH:MM") on a day the summary
// has not gone out yet.
export function summaryDue(
  nowMs: number,
  timezone: string,
  time: string,
  sentOn: string | null,
  today: string,
): boolean {
  if (sentOn === today) return false;
  const { hour, minute } = zonedParts(new Date(nowMs), timezone);
  const [dueHour, dueMinute] = time.split(":").map(Number);
  return hour * 60 + minute >= dueHour * 60 + dueMinute;
}

function tonightLine(car: SummaryCar): string | null {
  const { tonight, state } = car;
  if (!tonight) return null;
  const from = `Tonight from ${tonight.startTime}`;
  if (!tonight.plan) {
    return `${from}: charging to ${tonight.limitPct}% — not enough sun forecast to count on.`;
  }
  const why =
    `${tonight.plan.baseLimitPct}% less ~${tonight.plan.solarPct}% expected from solar`;
  if (state && state.batteryLevel >= tonight.limitPct) {
    return `${from}: no grid top-up needed — ${state.batteryLevel}% is already at or above ${tonight.limitPct}% (${why}).`;
  }
  return `${from}: topping up to ${tonight.limitPct}% (${why}).`;
}

function carLines(car: SummaryCar): string[] {
  const level = car.state ? `, now ${car.state.batteryLevel}%` : "";
  return [
    `${car.name}: ${
      car.solarKwhToday.toFixed(1)
    } kWh from solar today${level}.`,
    tonightLine(car),
  ].filter((line): line is string => line !== null);
}

function forecastLine(
  label: string,
  day: SolarForecastSummary["days"][number],
): string {
  const range = `${kwh(day.forecastWh10)}–${kwh(day.forecastWh90)}`;
  return `${label}: about ${kwh(day.forecastWh)} kWh (likely ${range}).`;
}

export function buildEveningSummary(
  summary: SolarForecastSummary,
  cars: readonly SummaryCar[],
): { title: string; message: string } {
  const { today } = summary;
  const tomorrow = summary.days[1];
  const lines = [
    `Today: ${kwh(today.actualWh ?? 0)} kWh made (forecast ${
      kwh(today.forecastWh)
    } kWh).`,
    tomorrow ? forecastLine("Tomorrow", tomorrow) : null,
    ...cars.flatMap(carLines),
  ].filter((line): line is string => line !== null);
  return { title: "Solar Summary", message: lines.join("\n") };
}

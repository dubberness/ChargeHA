import type { AdapterVehicleChargeState } from "@chargeha/shared";

// Tesla's `vehicle_data` shape. Shared because it is not Fleet-API-only:
// Tessie's `/{vin}/state` returns the same object, field for field.

export interface TeslaChargeState {
  battery_level?: number;
  charge_limit_soc?: number;
  charging_state?: string;
  charge_amps?: number;
  charge_current_request_max?: number;
  charger_power?: number;
  charger_voltage?: number;
  charger_phases?: number;
  charge_energy_added?: number;
  minutes_to_full_charge?: number;
  charge_port_door_open?: boolean;
  // When the car took this reading, in epoch ms.
  timestamp?: number;
}

export interface TeslaVehicleState {
  vehicle_name?: string;
  car_type?: string;
}

export interface TeslaDriveState {
  latitude?: number;
  longitude?: number;
}

export interface TeslaVehicleData {
  charge_state: TeslaChargeState;
  vehicle_state?: TeslaVehicleState;
  drive_state?: TeslaDriveState;
  state?: string;
}

// Some Teslas report charger_phases = 2 on three phases, but 2 is genuine on
// delta/no-neutral supplies — only charger_power separates the two cases.
// https://github.com/teslamate-org/teslamate/issues/414
function correctThreePhase(
  reported: number | null,
  amps: number,
  volts: number,
  powerKw: number | undefined,
): number | null {
  if (reported !== 2 || !powerKw) return reported;
  // Phase-to-neutral only. A line-to-line reading (~400V) makes the ratio
  // sqrt(3), which looks exactly like two phases.
  if (volts < 200 || volts > 260) return reported;
  // charger_power is integer kW, so below ~10A the quantisation swamps it.
  if (amps < 10) return reported;

  const ratio = powerKw / ((amps * volts) / 1000);
  return ratio >= 2.6 && ratio <= 3.4 ? 3 : reported;
}

const NOT_CHARGING_STATES = ["Disconnected", "Stopped", "Complete", "NoPower"];
const CHARGING_STATES = ["Charging", "Starting"];

export function toAdapterChargeState(
  vin: string,
  data: TeslaVehicleData,
  minAmps: number,
): AdapterVehicleChargeState {
  const charge = data.charge_state;
  const vehicle = data.vehicle_state;
  const drive = data.drive_state;
  const chargingState = charge.charging_state ?? "Unknown";
  const chargeAmps = charge.charge_amps ?? 0;
  const chargerVoltage = charge.charger_voltage ?? 0;
  // Reported only while charging; null is "unknown", which the engine
  // resolves from the threePhaseCharger setting.
  const chargerPhases = correctThreePhase(
    charge.charger_phases ?? null,
    chargeAmps,
    chargerVoltage,
    charge.charger_power,
  );
  // Compute from V × I × phases — Tesla's charger_power field rounds to
  // integer kW, which misreports e.g. 1.44 kW as 1 and shows 0 during
  // ramp-up transitions.
  const chargerPowerKw =
    Math.round(chargeAmps * chargerVoltage * (chargerPhases ?? 1) / 10) /
    100;
  const definitelyNotCharging = NOT_CHARGING_STATES.includes(chargingState);
  const isCharging = CHARGING_STATES.includes(chargingState) ||
    chargerPowerKw > 0.1 || (!definitelyNotCharging && chargeAmps > 0);

  return {
    vehicleId: vin,
    batteryLevel: charge.battery_level ?? 0,
    chargeLimit: charge.charge_limit_soc ?? 0,
    isCharging,
    isPluggedIn: chargingState !== "Disconnected",
    isOnline: data.state === "online",
    chargeAmps,
    chargeAmpsMax: charge.charge_current_request_max ?? 0,
    chargeAmpsMin: minAmps,
    chargePowerKw: chargerPowerKw,
    chargerVoltage,
    chargerPhases,
    energyAddedKwh: charge.charge_energy_added ?? 0,
    minutesToFull: charge.minutes_to_full_charge ?? 0,
    chargePortOpen: charge.charge_port_door_open ?? false,
    vehicleName: vehicle?.vehicle_name ?? "Tesla",
    lastUpdated: readingTime(charge.timestamp),
    latitude: drive?.latitude ?? null,
    longitude: drive?.longitude ?? null,
  };
}

// A cached reading (Tessie's, or a sleeping car's) can be hours old, so keep
// the car's own time rather than stamping it with now. Never later than now:
// a car clock running fast must not make a reading look newer than it is.
function readingTime(timestampMs: number | undefined): string {
  const now = Date.now();
  const ms = typeof timestampMs === "number" && timestampMs > 0
    ? Math.min(timestampMs, now)
    : now;
  return new Date(ms).toISOString();
}

import {
  ArrowUpDown,
  BatteryCharging,
  Calendar,
  CloudSun,
  ListOrdered,
  Plug,
  PlugZap,
  ShieldBan,
  Unplug,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button, Text, Tooltip } from "@radix-ui/themes";
import type { VehicleChargeState } from "@chargeha/shared";
import { ampsRange, ampsValue, kwValue } from "../../utils/Format.ts";
import { Spinner } from "../ui/Spinner.tsx";
import layout from "../ui/CardLayout.module.css";
import styles from "./VehicleCard.module.css";

const VISIBLE_REASONS = new Set([
  "schedule",
  "blockout",
  "grace_period",
  "displaced",
  "cooldown",
  "battery_priority",
]);

const REASON_ICONS: Record<string, LucideIcon> = {
  schedule: Calendar,
  blockout: ShieldBan,
  grace_period: CloudSun,
  displaced: ListOrdered,
  cooldown: CloudSun,
  battery_priority: BatteryCharging,
};

const REASON_COLORS: Record<string, "blue" | "orange"> = {
  schedule: "blue",
  blockout: "orange",
  grace_period: "orange",
  displaced: "orange",
  cooldown: "orange",
  battery_priority: "orange",
};

interface VehicleCardDetailsProps {
  state: VehicleChargeState;
  solarPowerW: number;
  gridPowerW: number;
  chargeLimitPercent: number;
  allocationStatus: string | null;
  controllerReason: string | null;
  controllerDetail: string | null;
  chargerStatus: { status: string; statusDetail: string | null } | null;
}

interface ChargeControlsProps {
  state: VehicleChargeState;
  disabled: boolean;
  commandPending: string | false;
  onStartCharging: () => void;
  onStopCharging: () => void;
  onSetAmps: (amps: number) => void;
}

// The car's own card already shows its battery, limit and amps, and an
// adapter's detail for an ordinary status only repeats them. A status outside
// this set is the charger saying something the card does not.
const ROUTINE_STATUSES = new Set([
  "available",
  "preparing",
  "charging",
  "suspended",
  "finishing",
]);

const sentenceCase = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

export function ChargerStatusRow(
  { chargerStatus }: {
    chargerStatus: { status: string; statusDetail: string | null } | null;
  },
) {
  if (!chargerStatus) return null;
  if (chargerStatus.status === "no_draw") {
    return (
      <div className={layout.detailRow}>
        <Unplug size={14} />
        <Text size="1" color="gray">
          No draw — vehicle may be absent, finished, or paused
          {chargerStatus.statusDetail ? ` (${chargerStatus.statusDetail})` : ""}
        </Text>
      </div>
    );
  }
  if (!chargerStatus.statusDetail) return null;
  return (
    <div className={layout.detailRow}>
      <PlugZap size={14} />
      <Text size="1" color="gray">
        {sentenceCase(chargerStatus.statusDetail)}
      </Text>
    </div>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function ChargeButton(
  { isCharging, disabled, commandPending, onStart, onStop }: {
    isCharging: boolean;
    disabled: boolean;
    commandPending: string | false;
    onStart: () => void;
    onStop: () => void;
  },
) {
  if (isCharging) {
    return (
      <Button
        variant="soft"
        color="red"
        size="2"
        disabled={disabled}
        onClick={onStop}
      >
        {commandPending === "stop" ? <Spinner /> : null}
        {commandPending === "stop" ? "Stopping..." : "Stop Charging"}
      </Button>
    );
  }
  return (
    <Button
      variant="soft"
      color="green"
      size="2"
      disabled={disabled}
      onClick={onStart}
    >
      {commandPending === "start" ? <Spinner /> : null}
      {commandPending === "start" ? "Starting..." : "Start Charging"}
    </Button>
  );
}

// Callers that also have a fallback for unformatted reasons need to know
// which they got.
export const isVisibleReason = (reason: string | null): boolean =>
  reason !== null && VISIBLE_REASONS.has(reason);

// Renders nothing for a reason with no user-facing phrasing, so callers can
// hand it whatever the controller reported without filtering first.
export function ControllerReasonRow(
  { reason, detail }: { reason: string | null; detail: string | null },
) {
  if (reason === null || detail === null || !isVisibleReason(reason)) {
    return null;
  }
  const Icon = REASON_ICONS[reason];
  const color = REASON_COLORS[reason] ?? "gray";
  return (
    <div className={layout.detailRow}>
      {Icon && <Icon size={14} />}
      <Text size="1" color={color}>{detail}</Text>
    </div>
  );
}

// The only charging row a charger cannot produce: `minutesToFull` and the
// limit are the vehicle's own numbers, not anything the charger measures.
function TimeToFullRow(
  { state, chargeLimitPercent }: {
    state: VehicleChargeState;
    chargeLimitPercent: number;
  },
) {
  // Gated on the estimate alone, not on the car's own isCharging flag. A car
  // driven by a smart charger never sees its own startCharging, so that flag
  // stays false while the charger is delivering energy; the adapter only
  // produces a non-zero estimate when it believes it is charging anyway, so
  // the extra condition ruled the row out without adding anything.
  if (state.minutesToFull <= 0) return null;
  return (
    <div className={layout.detailRow}>
      <Plug size={14} />
      <Text size="1" color="gray">
        {formatMinutes(state.minutesToFull)} to {chargeLimitPercent}%
      </Text>
    </div>
  );
}

// `readOnly` used to drop this block whole, costing real information rather
// than just the controls. Every other row is already shown on the charger
// card above; time to full is the one row that card cannot produce.
export function PairedChargeDetails(
  { state, chargeLimitPercent }: {
    state: VehicleChargeState;
    chargeLimitPercent: number;
  },
) {
  return (
    <div className={layout.details}>
      <TimeToFullRow state={state} chargeLimitPercent={chargeLimitPercent} />
    </div>
  );
}

function AmpsControl(
  { state, disabled, commandPending, onSetAmps }: {
    state: VehicleChargeState;
    disabled: boolean;
    commandPending: string | false;
    onSetAmps: (amps: number) => void;
  },
) {
  return (
    <Tooltip content="Start charging to adjust amps" hidden={state.isCharging}>
      <div className={styles.ampsControl}>
        <Button
          variant="ghost"
          size="1"
          disabled={disabled || !state.isCharging ||
            state.chargeAmps <= state.chargeAmpsMin}
          onClick={() =>
            onSetAmps(state.chargeAmps - 1)}
        >
          {commandPending === "amps" ? <Spinner /> : "−"}
        </Button>
        <Text size="2" weight="bold">{ampsValue(state.chargeAmps)}</Text>
        <Button
          variant="ghost"
          size="1"
          disabled={disabled || !state.isCharging ||
            state.chargeAmps >= state.chargeAmpsMax}
          onClick={() =>
            onSetAmps(state.chargeAmps + 1)}
        >
          {commandPending === "amps" ? <Spinner /> : "+"}
        </Button>
      </div>
    </Tooltip>
  );
}

interface ChargeStat {
  label: string;
  value: string;
}

function sourceStat(solarPowerW: number, gridPowerW: number): ChargeStat[] {
  if (solarPowerW <= 0 && gridPowerW <= 0) return [];
  return [{
    label: "Power from",
    value: `${kwValue(solarPowerW)} solar, ${kwValue(gridPowerW)} grid`,
  }];
}

function sessionStats(
  state: VehicleChargeState,
  solarPowerW: number,
  gridPowerW: number,
): ChargeStat[] {
  if (!state.isCharging) return [];
  return [
    {
      label: "Charge rate",
      value: ampsRange(state.chargeAmps, state.chargeAmpsMax),
    },
    ...sourceStat(solarPowerW, gridPowerW),
    {
      label: "Added this session",
      value: `${state.energyAddedKwh.toFixed(1)} kWh`,
    },
  ];
}

// Same gate as TimeToFullRow: the estimate alone, not the car's own flag.
function timeLeftStat(
  state: VehicleChargeState,
  chargeLimitPercent: number,
): ChargeStat[] {
  if (state.minutesToFull <= 0) return [];
  return [{
    label: "Time left",
    value: `${formatMinutes(state.minutesToFull)} to ${chargeLimitPercent}%`,
  }];
}

export function VehicleCardDetails({
  state,
  solarPowerW,
  gridPowerW,
  chargeLimitPercent,
  allocationStatus,
  controllerReason,
  controllerDetail,
  chargerStatus,
}: VehicleCardDetailsProps) {
  const stats = [
    ...sessionStats(state, solarPowerW, gridPowerW),
    ...timeLeftStat(state, chargeLimitPercent),
  ];
  const unusualStatus = chargerStatus !== null &&
    !ROUTINE_STATUSES.has(chargerStatus.status);
  return (
    <>
      {/* Why it is or isn't charging, ahead of the numbers */}
      <div className={layout.details}>
        {allocationStatus && (
          <div className={layout.detailRow}>
            <ArrowUpDown size={14} />
            <Text size="1" color="yellow">{allocationStatus}</Text>
          </div>
        )}
        <ControllerReasonRow
          reason={controllerReason}
          detail={controllerDetail}
        />
        {unusualStatus && <ChargerStatusRow chargerStatus={chargerStatus} />}
      </div>

      {stats.length > 0 && (
        <div className={styles.stats}>
          {stats.map((stat) => (
            <div key={stat.label} className={styles.stat}>
              <Text size="1" color="gray">{stat.label}</Text>
              <Text size="2" weight="bold">{stat.value}</Text>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function ChargeControls({
  state,
  disabled,
  commandPending,
  onStartCharging,
  onStopCharging,
  onSetAmps,
}: ChargeControlsProps) {
  return (
    <div className={styles.controls}>
      <ChargeButton
        isCharging={state.isCharging}
        disabled={disabled}
        commandPending={commandPending}
        onStart={onStartCharging}
        onStop={onStopCharging}
      />
      <AmpsControl
        state={state}
        disabled={disabled}
        commandPending={commandPending}
        onSetAmps={onSetAmps}
      />
    </div>
  );
}

import { kwValue } from "../../../utils/Format.ts";

export interface HeadlinePoint {
  id: string;
  name: string;
  mode: string;
  priority: number;
  state: {
    isCharging: boolean;
    isPluggedIn: boolean | null;
    chargePowerKw: number | null;
  } | null;
}

export interface StatusHeadline {
  tone: "charging" | "waiting" | "idle";
  title: string;
  detail: string | null;
}

type PowerSplit = Record<string, { solarW: number; gridW: number }>;
type Statuses = Record<string, { reason: string; detail: string } | undefined>;
type Realtime = { solarProductionW: number; gridPowerW: number } | null;

// Reasons where the car is ready and something else is holding it back —
// the ones worth an amber icon rather than a grey one.
const WAITING_TITLES: Record<string, string> = {
  solar_tracking: "Waiting for more solar",
  no_solar: "Waiting for more solar",
  grace_period: "Waiting for solar to recover",
  cooldown: "Waiting to restart",
  blockout: "Paused by a blockout",
  battery_priority: "Home battery is charging first",
  displaced: "Waiting for a higher-priority vehicle",
  charging_disabled: "Charging is turned off",
};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function exportNote(realtime: Realtime): string {
  if (!realtime || realtime.gridPowerW > -10) return "";
  return ` · ${kwValue(-realtime.gridPowerW)} exporting`;
}

function sourceTitle(who: string, solarPct: number): string {
  if (solarPct >= 100) return `Charging ${who} on solar`;
  if (solarPct <= 0) return `Charging ${who} from the grid`;
  return `Charging ${who} on ${solarPct}% solar`;
}

function allSolarDetail(totalW: number, realtime: Realtime): string {
  const solar = kwValue(realtime?.solarProductionW ?? 0);
  return `${kwValue(totalW)} of ${solar} solar${exportNote(realtime)}`;
}

function chargingHeadline(
  charging: HeadlinePoint[],
  split: PowerSplit,
  realtime: Realtime,
): StatusHeadline {
  const who = charging.length === 1
    ? charging[0].name
    : `${charging.length} vehicles`;
  const totalW = sum(charging.map((p) => (p.state?.chargePowerKw ?? 0) * 1000));
  if (!realtime) {
    return {
      tone: "charging",
      title: `Charging ${who}`,
      detail: kwValue(totalW),
    };
  }
  const solarW = sum(charging.map((p) => split[p.id]?.solarW ?? 0));
  const gridW = sum(charging.map((p) => split[p.id]?.gridW ?? 0));
  const solarPct = Math.round((solarW / totalW) * 100);
  const detail = solarPct >= 100
    ? allSolarDetail(totalW, realtime)
    : `${kwValue(totalW)} · ${kwValue(solarW)} solar, ${kwValue(gridW)} grid`;
  return { tone: "charging", title: sourceTitle(who, solarPct), detail };
}

function sparePower(realtime: Realtime): string | null {
  if (!realtime || realtime.solarProductionW <= 10) return null;
  return `${kwValue(realtime.solarProductionW)} solar${exportNote(realtime)}`;
}

function pluggedInHeadline(
  point: HeadlinePoint,
  status: { reason: string; detail: string } | undefined,
): StatusHeadline {
  if (point.mode === "stop") {
    return {
      tone: "idle",
      title: `${point.name} is set to Stop`,
      detail: null,
    };
  }
  if (status?.reason === "battery_at_limit") {
    return {
      tone: "idle",
      title: `${point.name} is at its charge limit`,
      detail: null,
    };
  }
  const waiting = status ? WAITING_TITLES[status.reason] : undefined;
  return {
    tone: waiting ? "waiting" : "idle",
    title: waiting ?? `${point.name} is plugged in, not charging`,
    detail: status?.detail ?? null,
  };
}

// The one-line answer to "what is it doing, and why" for the top of the
// dashboard. Null when there is nothing to charge.
export function statusHeadline(
  points: HeadlinePoint[],
  split: PowerSplit,
  statuses: Statuses,
  realtime: Realtime,
): StatusHeadline | null {
  if (points.length === 0) return null;
  const charging = points.filter((p) =>
    p.state?.isCharging && (p.state.chargePowerKw ?? 0) > 0
  );
  if (charging.length > 0) return chargingHeadline(charging, split, realtime);

  const pluggedIn = [...points]
    .sort((a, b) => a.priority - b.priority)
    .find((p) => p.state?.isPluggedIn === true);
  if (pluggedIn) return pluggedInHeadline(pluggedIn, statuses[pluggedIn.id]);

  // An asleep car or a smart plug cannot say whether a cable is in, so only
  // a clean "no" from every point earns "nothing plugged in".
  const allUnplugged = points.every((p) => p.state?.isPluggedIn === false);
  return {
    tone: "idle",
    title: allUnplugged ? "Nothing plugged in" : "Not charging",
    detail: sparePower(realtime),
  };
}

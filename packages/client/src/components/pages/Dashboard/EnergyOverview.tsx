import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Car,
  Home,
  Info,
  Sun,
} from "lucide-react";
import { Card, Skeleton, Text } from "@radix-ui/themes";
import { useEnergyData } from "../../../hooks/useEnergyData.ts";
import { EnergyFlowDiagram } from "../../EnergyFlowDiagram/EnergyFlowDiagram.tsx";
import { kwhValue } from "../../../utils/Format.ts";
import { localDateStr } from "@chargeha/shared/timezone";
import { useSiteTimezone } from "../../../hooks/useSiteTimezone.ts";
import { trpc } from "../../../trpc.ts";
import {
  chargingEntriesFromPoints,
  useChargingFlows,
} from "./energyHelpers.ts";
import { useChargers } from "../../../hooks/useChargers.ts";
import styles from "./Dashboard.module.css";

interface PluginWarning {
  title: string;
  message: string;
  // Absent on cards the dashboard raises itself, which are all errors.
  severity?: "warning" | "error";
}

// Amber and red have to be far enough apart to read at a 3px border — a
// degraded charger must not look like one that stopped charging.
const WARNING_ACCENTS = {
  warning: { color: "var(--amber-9)", Icon: Info },
  error: { color: "var(--red-9)", Icon: AlertTriangle },
} as const;

function PluginWarningCard({ warning }: { warning: PluginWarning }) {
  const { color, Icon } = WARNING_ACCENTS[warning.severity ?? "error"];
  return (
    <Card style={{ borderLeft: `3px solid ${color}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Icon
          size={20}
          style={{ color, flexShrink: 0 }}
        />
        <div>
          <Text size="2" weight="bold" style={{ display: "block" }}>
            {warning.title}
          </Text>
          <Text size="2" color="gray">{warning.message}</Text>
        </div>
      </div>
    </Card>
  );
}

// Anything stopping the numbers below from being trusted, so it sits above
// them.
export function EnergyWarnings(
  { pluginWarnings }: { pluginWarnings: PluginWarning[] },
) {
  const { data: energyData } = useEnergyData();
  const realtime = energyData?.realtime ?? null;
  return (
    <>
      {realtime?.pollFailed && (
        <PluginWarningCard
          warning={{
            title: "Energy source offline",
            message: realtime.pollError ??
              "Energy data poll failed — see the Logs page for details.",
          }}
        />
      )}
      {pluginWarnings.map((warning) => (
        <PluginWarningCard key={warning.title} warning={warning} />
      ))}
    </>
  );
}

export function LiveFlow() {
  const { data: energyData, isLoading: loading } = useEnergyData();
  const realtime = energyData?.realtime ?? null;
  const { chargers } = useChargers();
  const chargingVehicles = useChargingFlows(
    realtime,
    chargingEntriesFromPoints(chargers),
  );
  return (
    <div className={styles.flow}>
      <EnergyFlowDiagram
        data={realtime}
        loading={loading}
        chargingVehicles={chargingVehicles}
      />
    </div>
  );
}

function TodayStat(
  { icon, color, label, value, sub, loading }: {
    icon: ReactNode;
    color: string;
    label: string;
    value: string;
    sub?: string | null;
    loading: boolean;
  },
) {
  return (
    <div className={styles.todayStat} data-testid="today-stat">
      <div className={styles.todayLabel} style={{ color }}>
        {icon}
        <Text size="1" color="gray">{label}</Text>
      </div>
      {loading
        ? <Skeleton width="72px" height="26px" />
        : <Text size="5" weight="bold">{value}</Text>}
      {sub && !loading && <Text size="1" color="gray">{sub}</Text>}
    </div>
  );
}

// "11.2 kWh from solar (95%)" — the share is the point of the app, the
// energy is what the old Solar to EVs tile carried.
export function solarShareText(
  chargedWh: number,
  solarWh: number,
): string | null {
  if (chargedWh <= 0) return null;
  const pct = Math.min(100, Math.round((solarWh / chargedWh) * 100));
  return `${kwhValue(solarWh)} from solar (${pct}%)`;
}

export function TodaySummary() {
  const { data: energyData, isLoading: loading } = useEnergyData();
  const cumulative = energyData?.cumulative ?? null;
  const timezone = useSiteTimezone();
  const today = localDateStr(new Date(), timezone);
  const { data: statsDay = null } = trpc.stats.day.useQuery(
    { date: today },
    { refetchInterval: 60_000 },
  );

  const dailySolar = cumulative?.dailySolarProducedWh ?? 0;
  const dailyImport = cumulative?.dailyGridImportWh ?? 0;
  const dailyExport = cumulative?.dailyGridExportWh ?? 0;
  const chargedWh = statsDay?.totalChargedWh ?? 0;

  return (
    <div className={styles.section}>
      <Text
        size="1"
        color="gray"
        weight="medium"
        className={styles.sectionLabel}
      >
        Today
      </Text>
      <Card>
        <div className={styles.today}>
          <TodayStat
            icon={<Sun size={16} />}
            color="var(--color-solar)"
            label="Solar Generated"
            value={kwhValue(dailySolar)}
            loading={loading}
          />
          <TodayStat
            icon={<Home size={16} />}
            color="var(--color-home)"
            label="Home Consumed"
            value={kwhValue(dailySolar + dailyImport - dailyExport)}
            loading={loading}
          />
          <TodayStat
            icon={<ArrowDownToLine size={16} />}
            color="var(--color-grid-import)"
            label="Grid Import"
            value={kwhValue(dailyImport)}
            loading={loading}
          />
          <TodayStat
            icon={<ArrowUpFromLine size={16} />}
            color="var(--color-grid-export)"
            label="Grid Export"
            value={kwhValue(dailyExport)}
            loading={loading}
          />
          <TodayStat
            icon={<Car size={16} />}
            color="var(--color-charging)"
            label="EVs Charged"
            value={kwhValue(chargedWh)}
            sub={solarShareText(chargedWh, statsDay?.totalSolarWh ?? 0)}
            loading={loading}
          />
        </div>
      </Card>
    </div>
  );
}

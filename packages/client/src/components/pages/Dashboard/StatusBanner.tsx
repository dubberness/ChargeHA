import { type ReactNode, useMemo } from "react";
import { Calendar, DollarSign, Hourglass, PlugZap, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, Text } from "@radix-ui/themes";
import { useEnergyData } from "../../../hooks/useEnergyData.ts";
import { useVehicles } from "../../../hooks/useVehicles.ts";
import { useChargers } from "../../../hooks/useChargers.ts";
import { useControllerStatuses } from "../../../hooks/controllerStatusStore.ts";
import { formatRate } from "../../../utils/Format.ts";
import { trpc } from "../../../trpc.ts";
import {
  chargingEntriesFromPoints,
  formatTimeUntil,
  useChargingSolarGrid,
} from "./energyHelpers.ts";
import { type StatusHeadline, statusHeadline } from "./statusHeadline.ts";
import styles from "./Dashboard.module.css";

const TONES: Record<
  StatusHeadline["tone"],
  { color: string; Icon: LucideIcon }
> = {
  charging: { color: "var(--color-charging)", Icon: Zap },
  waiting: { color: "var(--amber-9)", Icon: Hourglass },
  idle: { color: "var(--gray-9)", Icon: PlugZap },
};

interface CurrentRate {
  label: string;
  ratePerKwh: number;
  currencySymbol?: string;
  nextRate?: { label: string; ratePerKwh: number; startsAt: string } | null;
}

function nextRateText(rate: CurrentRate): string | null {
  if (!rate.nextRate) return null;
  const sym = rate.currencySymbol ?? "$";
  const { label, ratePerKwh, startsAt } = rate.nextRate;
  return `Next: ${label} (${formatRate(ratePerKwh, sym)}) in ${
    formatTimeUntil(startsAt)
  }`;
}

function Fact(
  { icon, label, value, sub }: {
    icon: ReactNode;
    label: string;
    value: string;
    sub?: string | null;
  },
) {
  return (
    <div className={styles.fact}>
      <div className={styles.factLabel}>
        {icon}
        <Text size="1" color="gray">{label}</Text>
      </div>
      <Text size="2" weight="bold" className={styles.factValue}>{value}</Text>
      {sub && <Text size="1" color="gray" data-testid="tariff-next">{sub}
      </Text>}
    </div>
  );
}

function Headline({ headline }: { headline: StatusHeadline }) {
  const { color, Icon } = TONES[headline.tone];
  return (
    <div className={styles.headline}>
      <Icon size={24} style={{ color, flexShrink: 0 }} />
      <div>
        <Text size="4" weight="bold" as="div">{headline.title}</Text>
        {headline.detail && (
          <Text size="2" color="gray" as="div">{headline.detail}</Text>
        )}
      </div>
    </div>
  );
}

function useHeadline(): StatusHeadline | null {
  const { data: energyData } = useEnergyData();
  const realtime = energyData?.realtime ?? null;
  const { chargers } = useChargers();
  const points = useMemo(() => chargers.filter((p) => p.active), [chargers]);
  const split = useChargingSolarGrid(
    realtime,
    chargingEntriesFromPoints(points),
  );
  const statuses = useControllerStatuses();
  return statusHeadline(points, split, statuses, realtime);
}

function useActiveScheduleLines(): string[] | null {
  const { vehicles } = useVehicles();
  const { data: activeSchedules = [] } = trpc.schedule.active.useQuery(
    undefined,
    { refetchInterval: 30_000 },
  );
  return useMemo(() => {
    if (activeSchedules.length === 0) return null;
    return activeSchedules.map((s) => {
      const type = s.scheduleType === "blockout" ? "Blockout" : "Charge";
      const vehicleName = s.vehicleId
        ? vehicles.find((v) => v.id === s.vehicleId)?.name ?? "Vehicle"
        : "All vehicles";
      return `${type} ${s.startTime}-${s.endTime} · ${vehicleName}`;
    });
  }, [activeSchedules, vehicles]);
}

// What the controller is doing and why, with the two things that most often
// explain it — the tariff and any schedule in force — alongside.
export function StatusBanner() {
  const headline = useHeadline();
  const scheduleLines = useActiveScheduleLines();
  const { data: currentRate = null } = trpc.tariff.currentRate.useQuery(
    undefined,
    { refetchInterval: 10_000 },
  );
  const accent = headline ? TONES[headline.tone].color : "var(--gray-9)";

  return (
    <Card
      className={styles.banner}
      style={{ "--accent": accent } as React.CSSProperties}
    >
      {headline && <Headline headline={headline} />}
      <div className={styles.facts}>
        {currentRate && (
          <Fact
            icon={<DollarSign size={14} />}
            label={`Tariff - ${currentRate.label}`}
            value={`${
              formatRate(
                currentRate.ratePerKwh,
                currentRate.currencySymbol ?? "$",
              )
            }/kWh`}
            sub={nextRateText(currentRate)}
          />
        )}
        <Fact
          icon={<Calendar size={14} />}
          label={scheduleLines && scheduleLines.length > 1
            ? "Active Schedules"
            : "Active Schedule"}
          value={scheduleLines?.join("\n") ?? "None"}
        />
      </div>
    </Card>
  );
}

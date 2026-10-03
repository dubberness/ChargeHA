import { type ReactNode, useMemo } from "react";
import {
  CalendarDays,
  CloudSun,
  Hourglass,
  Sun,
  Sunrise,
  TriangleAlert,
} from "lucide-react";
import { Badge, Callout, Card, Text } from "@radix-ui/themes";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  SolarForecastDay,
  SolarForecastSummary,
} from "@chargeha/shared/solarForecast";
import { trpc } from "../../../trpc.ts";
import { useSiteTimezone } from "../../../hooks/useSiteTimezone.ts";
import { formatRelativeTime, kwhValue } from "../../../utils/Format.ts";
import styles from "./SolarForecast.module.css";
import dashboardStyles from "./Dashboard.module.css";

interface ChartPoint {
  t: number;
  forecastKw: number;
  rangeKw: [number, number];
  actualKw: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function toChartPoints(summary: SolarForecastSummary): ChartPoint[] {
  return summary.periods.map((p) => ({
    t: Date.parse(p.periodStart),
    forecastKw: round2(p.pvW / 1000),
    rangeKw: [round2(p.pvW10 / 1000), round2(p.pvW90 / 1000)],
    actualKw: p.actualW === null ? null : round2(p.actualW / 1000),
  }));
}

// "+8% vs forecast" — how today is tracking against what was expected by
// now. Null until enough of the day has passed to say anything.
export function trackingLabel(
  actualWh: number,
  forecastToNowWh: number,
): string | null {
  if (forecastToNowWh < 100) return null;
  const pct = Math.round((actualWh / forecastToNowWh - 1) * 100);
  if (pct === 0) return "On forecast so far";
  return `${pct > 0 ? "+" : ""}${pct}% vs forecast so far`;
}

// "Forecast updated 12m ago · adjusted to your system"
export function updatedLabel(summary: SolarForecastSummary): string | null {
  if (!summary.updatedAt) return null;
  const updated = `Forecast updated ${
    formatRelativeTime(new Date(summary.updatedAt))
  }`;
  return summary.adjusted ? `${updated} · adjusted to your system` : updated;
}

function PanelLowWarning({ recentShare }: { recentShare: number }) {
  return (
    <Callout.Root color="amber" size="1" role="status">
      <Callout.Icon>
        <TriangleAlert size={14} />
      </Callout.Icon>
      <Callout.Text>
        Your solar made about{" "}
        {Math.round(recentShare * 100)}% of its usual output on recent clear
        days. Worth checking the inverter and panels.
      </Callout.Text>
    </Callout.Root>
  );
}

const rangeLabel = (day: SolarForecastDay) =>
  `Likely ${(day.forecastWh10 / 1000).toFixed(1)}–${
    (day.forecastWh90 / 1000).toFixed(1)
  } kWh`;

function SummaryFact(
  { icon, label, value, sub }: {
    icon: ReactNode;
    label: string;
    value: string;
    sub?: string;
  },
) {
  return (
    <div className={styles.fact}>
      <div className={styles.factLabel}>
        {icon}
        <Text size="1" color="gray">{label}</Text>
      </div>
      <Text size="3" weight="bold">{value}</Text>
      {sub && <Text size="1" color="gray">{sub}</Text>}
    </div>
  );
}

// Today's production against the forecast: the fill is what has been made,
// the tick is the forecast and the band behind it is the likely range.
function ProductionBar({ today }: { today: SolarForecastDay }) {
  const actualWh = today.actualWh ?? 0;
  const max = Math.max(today.forecastWh90, actualWh, 1);
  const pct = (wh: number) => `${(wh / max) * 100}%`;
  return (
    <div className={styles.progress} aria-hidden="true">
      <div
        className={styles.progressRange}
        style={{
          left: pct(today.forecastWh10),
          width: pct(today.forecastWh90 - today.forecastWh10),
        }}
      />
      <div className={styles.progressFill} style={{ width: pct(actualWh) }} />
      <div
        className={styles.progressMark}
        style={{ left: pct(today.forecastWh) }}
      />
    </div>
  );
}

function ForecastSummary({ summary }: { summary: SolarForecastSummary }) {
  const { today } = summary;
  const tomorrow = summary.days[1];
  const tracking = trackingLabel(today.actualToNowWh, today.forecastToNowWh);
  return (
    <div className={styles.summary}>
      <div className={styles.summaryHead}>
        <div className={styles.produced}>
          <Sun size={20} style={{ color: "var(--color-solar)" }} />
          <Text size="6" weight="bold">{kwhValue(today.actualWh ?? 0)}</Text>
          <Text size="2" color="gray">produced so far</Text>
        </div>
        {tracking && (
          <Badge
            variant="soft"
            color={today.actualToNowWh >= today.forecastToNowWh
              ? "green"
              : "amber"}
          >
            {tracking}
          </Badge>
        )}
      </div>
      <ProductionBar today={today} />
      <div className={styles.facts}>
        <SummaryFact
          icon={<CloudSun size={14} />}
          label="Forecast Today"
          value={kwhValue(today.forecastWh)}
          sub={rangeLabel(today)}
        />
        <SummaryFact
          icon={<Hourglass size={14} />}
          label="Still to Come"
          value={kwhValue(today.remainingWh)}
        />
        {tomorrow && (
          <SummaryFact
            icon={<Sunrise size={14} />}
            label="Forecast Tomorrow"
            value={kwhValue(tomorrow.forecastWh)}
            sub={rangeLabel(tomorrow)}
          />
        )}
      </div>
    </div>
  );
}

interface ForecastTooltipProps {
  format: Intl.DateTimeFormat;
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChartPoint }>;
}

// Recharts' default tooltip is white with series-coloured text, which is
// hard to read in dark mode; this follows the theme like the stats chart's.
export function ForecastTooltip(
  { format, active, payload }: ForecastTooltipProps,
) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const actual = {
    label: "Actual",
    value: `${point.actualKw} kW`,
    className: styles.tooltipActual,
  };
  const rows = [
    ...(point.actualKw === null ? [] : [actual]),
    {
      label: "Forecast",
      value: `${point.forecastKw} kW`,
      className: styles.tooltipForecast,
    },
    {
      label: "Likely range",
      value: `${point.rangeKw[0]}–${point.rangeKw[1]} kW`,
      className: styles.tooltipRange,
    },
  ];
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipHeader}>{format.format(point.t)}</div>
      {rows.map((row) => (
        <div key={row.label} className={styles.tooltipRow}>
          <span className={row.className} />
          <span className={styles.tooltipLabel}>{row.label}</span>
          <span className={styles.tooltipValue}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function ForecastChart(
  { points, timezone }: { points: ChartPoint[]; timezone: string },
) {
  const time = useMemo(
    () =>
      new Intl.DateTimeFormat([], {
        timeZone: timezone,
        weekday: "short",
        hour: "numeric",
      }),
    [timezone],
  );
  const hourMinute = useMemo(
    () =>
      new Intl.DateTimeFormat([], {
        timeZone: timezone,
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }),
    [timezone],
  );
  return (
    <div className={styles.chart}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={points}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t: number) => time.format(t)}
            tick={{ fontSize: 11 }}
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => `${v} kW`}
            width={52}
          />
          <Tooltip content={<ForecastTooltip format={hourMinute} />} />
          <Area
            dataKey="rangeKw"
            name="Likely range"
            stroke="none"
            fill="var(--color-solar-forecast)"
            fillOpacity={0.15}
            isAnimationActive={false}
          />
          <Line
            dataKey="forecastKw"
            name="Forecast"
            type="monotone"
            stroke="var(--color-solar-forecast)"
            strokeWidth={2}
            strokeDasharray="6 3"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="actualKw"
            name="Actual"
            type="monotone"
            stroke="var(--color-solar)"
            strokeWidth={2.5}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          <ReferenceLine
            x={Date.now()}
            stroke="var(--gray-8)"
            strokeDasharray="2 2"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// Days are local calendar dates, so format them in UTC — any other zone
// could shift the weekday.
function DayStrip({ days }: { days: SolarForecastDay[] }) {
  const weekday = new Intl.DateTimeFormat([], {
    timeZone: "UTC",
    weekday: "short",
  });
  const max = Math.max(...days.map((d) => d.forecastWh90), 1);
  return (
    <div className={styles.days} aria-label="Daily forecast">
      {days.map((day, i) => (
        <div key={day.date} className={styles.day}>
          <Text size="1" color="gray">
            {i === 0 ? "Today" : weekday.format(Date.parse(day.date))}
          </Text>
          <div
            className={styles.dayBar}
            title={rangeLabel(day)}
          >
            <div
              className={styles.dayRange}
              style={{
                bottom: `${(day.forecastWh10 / max) * 100}%`,
                height: `${
                  ((day.forecastWh90 - day.forecastWh10) / max) * 100
                }%`,
              }}
            />
            <div
              className={styles.dayFill}
              style={{ height: `${(day.forecastWh / max) * 100}%` }}
            />
          </div>
          <Text size="1" weight="medium">
            {(day.forecastWh / 1000).toFixed(1)}
          </Text>
        </div>
      ))}
    </div>
  );
}

export function SolarForecastCard() {
  const timezone = useSiteTimezone();
  const { data: summary } = trpc.forecast.summary.useQuery(undefined, {
    refetchInterval: 5 * 60_000,
  });
  const points = useMemo(
    () => (summary ? toChartPoints(summary) : []),
    [summary],
  );
  if (!summary) return null;
  const updated = updatedLabel(summary);

  return (
    <div className={dashboardStyles.section}>
      <Text
        size="1"
        color="gray"
        weight="medium"
        className={dashboardStyles.sectionLabel}
      >
        Solar Forecast
      </Text>
      {summary.panelLow && (
        <PanelLowWarning recentShare={summary.panelLow.recentShare} />
      )}
      <Card>
        <ForecastSummary summary={summary} />
        <div className={styles.header}>
          <CalendarDays size={16} />
          <Text size="2" weight="medium">Today and tomorrow</Text>
          <span className={styles.legend}>
            <span className={styles.legendActual} /> Actual
            <span className={styles.legendForecast} /> Forecast
          </span>
        </div>
        <ForecastChart points={points} timezone={timezone} />
        {summary.days.length > 2 && <DayStrip days={summary.days} />}
        {updated && (
          <Text size="1" color="gray" className={styles.updated}>
            {updated}
          </Text>
        )}
      </Card>
    </div>
  );
}

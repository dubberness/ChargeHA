import type { AppDatabase } from "../db/AppDatabase.ts";
import type { Logger } from "../lib/Logger.ts";
import type { NotificationService } from "./NotificationService.ts";
import {
  deserializeSection,
  forecastConfigDef,
  forecastStateDef,
  sectionDbKeys,
} from "@chargeha/shared/configSections";
import {
  FORECAST_LEARN_MIN_DAYS,
  type ForecastCorrection,
  localMidnightUtcMs,
  type PanelCheck,
} from "@chargeha/shared/solarForecast";
import { localDateStr, offsetHoursAt } from "@chargeha/shared/timezone";
import {
  activeFactors,
  checkPanels,
  dailyTotals,
  learnCorrection,
  parseCorrection,
  parsePanelCheck,
  samplePeriods,
} from "./forecastLearning.ts";

const DAY_MS = 86_400_000;
// Checked hourly; the work itself runs once per local day, after midnight.
const CHECK_MS = 60 * 60_000;
// The correction follows the season, so it learns from recent weeks only.
const LEARN_DAYS = 21;
// The panel check compares recent clear days with those before them.
const HISTORY_DAYS = 45;
// A 15-minute bucket needs this share of its expected readings to count.
const MIN_BUCKET_COVERAGE = 0.8;
const DEFAULT_RECORDING_SECONDS = 60;

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString().slice(0, 10);

export interface LearningState {
  adjust: boolean;
  correction: ForecastCorrection | null;
  panelCheck: PanelCheck | null;
  timezone: string;
}

export async function readLearningState(
  db: AppDatabase,
): Promise<LearningState> {
  const keys = [
    ...sectionDbKeys(forecastConfigDef),
    ...sectionDbKeys(forecastStateDef),
  ];
  const [values, timezone] = await Promise.all([
    Promise.all(keys.map((k) => db.getConfig(k))),
    db.getConfig("timezone"),
  ]);
  const raw = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  const config = deserializeSection(forecastConfigDef, raw);
  const state = deserializeSection(forecastStateDef, raw);
  return {
    adjust: config.forecastAdjust,
    correction: parseCorrection(state.forecastCorrection),
    panelCheck: parsePanelCheck(state.forecastPanelCheck),
    timezone: timezone || "UTC",
  };
}

// The hour factors to scale displayed forecasts by, with the zone their
// hours are in. Null when switched off or still learning.
export async function loadActiveCorrection(
  db: AppDatabase,
): Promise<{ hourFactors: number[]; timezone: string } | null> {
  const state = await readLearningState(db);
  const hourFactors = activeFactors(state.adjust, state.correction);
  return hourFactors ? { hourFactors, timezone: state.timezone } : null;
}

// Once a day, relearns the forecast correction from recent history and
// checks the panels are producing what they usually do on clear days,
// sending a notification when they drop well below it.
export class ForecastLearner {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly notifications: Pick<NotificationService, "notify">,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.runIfDue(), CHECK_MS);
    void this.runIfDue();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async runIfDue(): Promise<void> {
    try {
      if (!(await this.db.getConfig("forecast_provider"))) return;
      const state = await readLearningState(this.db);
      const today = localDateStr(new Date(this.now()), state.timezone);
      if (state.correction?.learnedOn === today) return;
      await this.run(today, state);
    } catch (err) {
      this.logger.error("Forecast learning failed:", err);
    }
  }

  private async run(today: string, previous: LearningState): Promise<void> {
    const { timezone } = previous;
    const midnightOf = (date: string) =>
      localMidnightUtcMs(date, offsetHoursAt(timezone, date));
    const startIso = new Date(midnightOf(addDays(today, -HISTORY_DAYS)))
      .toISOString();
    const endIso = new Date(midnightOf(today)).toISOString();
    const [periods, buckets, recordingSeconds] = await Promise.all([
      this.db.forecasts.getPeriods(startIso, endIso),
      this.db.stats.getSolarProductionBuckets(startIso, endIso),
      this.db.getConfig("recording_interval_seconds"),
    ]);
    const seconds = Number(recordingSeconds) || DEFAULT_RECORDING_SECONDS;
    const minReadings = Math.max(
      1,
      Math.floor(MIN_BUCKET_COVERAGE * 900 / seconds),
    );
    const samples = samplePeriods(periods, buckets, timezone, minReadings);
    const learnFrom = addDays(today, -LEARN_DAYS);
    const correction = learnCorrection(
      samples.filter((s) => s.date >= learnFrom),
      today,
    );
    const panelCheck = checkPanels(dailyTotals(samples), today);
    await Promise.all([
      this.db.setConfig("forecast_correction", JSON.stringify(correction)),
      this.db.setConfig("forecast_panel_check", JSON.stringify(panelCheck)),
    ]);
    this.logger.info(
      correction.days < FORECAST_LEARN_MIN_DAYS
        ? `Forecast correction: learning (${correction.days} of ${FORECAST_LEARN_MIN_DAYS} days)`
        : `Forecast correction learned from ${correction.days} days`,
    );
    if (panelCheck.state === "low" && previous.panelCheck?.state !== "low") {
      await this.notifyLow(panelCheck);
    }
  }

  private async notifyLow(check: PanelCheck): Promise<void> {
    const pct = Math.round((check.recentShare ?? 0) * 100);
    this.logger.warn(
      `Solar output ${pct}% of usual on the last ${check.recentDays.length} clear days`,
    );
    await this.notifications.notify(
      "solar_underperforming",
      "Solar Output Low",
      `Your solar made about ${pct}% of its usual output on the last ${check.recentDays.length} clear days (${
        check.recentDays.join(", ")
      }). Worth checking the inverter for faults and the panels for dirt or new shade.`,
    );
  }
}

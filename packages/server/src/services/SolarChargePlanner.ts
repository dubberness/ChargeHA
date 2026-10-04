import type { AppDatabase } from "../db/AppDatabase.ts";
import type { Logger } from "../lib/Logger.ts";
import type { NotificationService } from "./NotificationService.ts";
import type { SolarForecastService } from "./SolarForecastService.ts";
import type { VehicleManager } from "./VehicleManager.ts";
import {
  deserializeSection,
  sectionDbKeys,
  type SolarConfig,
  solarConfigDef,
} from "@chargeha/shared/configSections";
import {
  type ActiveChargeSchedule,
  type EngineSchedule,
  selectActiveBlockout,
  selectActiveChargeSchedule,
  type SolarPlan,
} from "@chargeha/shared/engine";
import {
  localMidnightUtcMs,
  type SolarChargeProjection,
  type SolarForecastPeriod,
} from "@chargeha/shared/solarForecast";
import { localDateStr, offsetHoursAt } from "@chargeha/shared/timezone";
import type { VehicleChargeState } from "@chargeha/shared";
import { localHour } from "./forecastLearning.ts";
import {
  houseLoadByHour,
  lastSunMs,
  learnKwhPerPercent,
  solarToCar,
  type SurplusRules,
  windowAfter,
} from "./solarCharging.ts";
import { buildEveningSummary, summaryDue } from "./eveningSummary.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TICK_MS = 60_000;
// House load and battery size change slowly; reloaded at most hourly.
const CACHE_MS = HOUR_MS;
const LOAD_DAYS = 14;
const BATTERY_DAYS = 90;
// Never plan on solar further ahead than the forecast reaches.
const MAX_LOOKAHEAD_MS = 7 * DAY_MS;

type PvPick = (period: SolarForecastPeriod) => number;
const expected: PvPick = (p) => p.pvW;
const cautious: PvPick = (p) => p.pvW10;

interface Context {
  loadedAt: number;
  timezone: string;
  solar: SolarConfig;
  houseByHour: number[];
}

export interface SolarEstimate {
  kwh: number;
  // Null until the battery size has been learned.
  pct: number | null;
  // When the energy fills the car to its limit, if it does.
  limitAtMs: number | null;
}

// Uses the solar forecast for charging: what solar should add to a car
// today (dashboard), how far a solar-aware schedule's limit can drop for
// the solar still to come (controller), and the evening summary.
export class SolarChargePlanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ctx: Context | null = null;
  private readonly batteries = new Map<
    string,
    { loadedAt: number; kwhPerPct: number | null }
  >();
  // Plans are fixed for a schedule window, so the limit does not move while
  // the car charges. Keyed by charging point.
  private readonly plans = new Map<
    string,
    { key: string; plan: SolarPlan | null }
  >();

  constructor(
    private readonly db: AppDatabase,
    private readonly forecast: Pick<
      SolarForecastService,
      "getAdjustedPeriods" | "getSummary"
    >,
    private readonly vehicles: Pick<VehicleManager, "getAllStates">,
    private readonly notifications: Pick<NotificationService, "notify">,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  // ── Solar-aware schedules ──────────────────────────────────────────

  // Lowers a solar-aware schedule's limit by the solar the car should get
  // between this window's end and the schedule's next start. Returns the
  // schedule unchanged when it is not solar-aware or nothing can be said.
  async planSchedule(
    active: ActiveChargeSchedule | null,
    target: { id: string; vehicleId: string | null },
    schedules: EngineSchedule[],
    state: VehicleChargeState | null,
  ): Promise<ActiveChargeSchedule | null> {
    const base = active?.effective.chargeLimitPct ?? null;
    const solarAware = active?.contributors.some((s) => s.solarAware);
    if (!active || !state || base === null || !solarAware) return active;
    try {
      const plan = await this.cachedPlan(active, target, schedules, state);
      if (!plan) return active;
      return {
        ...active,
        effective: {
          ...active.effective,
          chargeLimitPct: Math.max(0, base - plan.solarPct),
        },
        solarPlan: plan,
      };
    } catch (err) {
      this.logger.error("Solar-aware schedule plan failed:", err);
      return active;
    }
  }

  private async cachedPlan(
    active: ActiveChargeSchedule,
    target: { id: string; vehicleId: string | null },
    schedules: EngineSchedule[],
    state: VehicleChargeState,
  ): Promise<SolarPlan | null> {
    const { timezone } = await this.context();
    const window = windowAfter(
      (ms) =>
        selectActiveChargeSchedule(
          schedules,
          target,
          new Date(ms),
          timezone,
        ) !==
          null,
      this.now(),
    );
    if (!window) return null;
    const key = `${
      active.contributors.map((s) => s.id).join(",")
    }@${window.endMs}`;
    const cached = this.plans.get(target.id);
    if (cached?.key === key) return cached.plan;
    const plan = await this.planWindow(
      active.effective.chargeLimitPct ?? 0,
      target.vehicleId,
      state,
      schedules,
      window,
    );
    this.plans.set(target.id, { key, plan });
    return plan;
  }

  private async planWindow(
    baseLimitPct: number,
    vehicleId: string | null,
    state: VehicleChargeState,
    schedules: EngineSchedule[],
    window: { endMs: number; nextStartMs: number | null },
  ): Promise<SolarPlan | null> {
    const toMs = Math.min(
      window.nextStartMs ?? window.endMs + DAY_MS,
      window.endMs + MAX_LOOKAHEAD_MS,
    );
    const estimate = await this.estimate(
      vehicleId,
      state,
      schedules,
      window.endMs,
      toMs,
      cautious,
    );
    const until = new Date(toMs).toISOString();
    if (estimate.pct === null) {
      this.logger.info(
        "Solar-aware schedule: charging to the full limit — battery size not learned yet",
      );
      return null;
    }
    this.logger.info(
      `Solar-aware schedule: solar should add at least ${estimate.pct}% (${
        estimate.kwh.toFixed(1)
      } kWh) before ${until} — limit ${baseLimitPct}% → ${
        Math.max(0, baseLimitPct - estimate.pct)
      }%`,
    );
    return estimate.pct > 0 ? { baseLimitPct, solarPct: estimate.pct } : null;
  }

  // ── Estimates ──────────────────────────────────────────────────────

  // Solar into the car between two instants, ignoring its current level —
  // except that it stops at the car's own limit when the size is known.
  async estimate(
    vehicleId: string | null,
    state: VehicleChargeState,
    schedules: EngineSchedule[],
    fromMs: number,
    toMs: number,
    pick: PvPick,
    roomPct = Infinity,
  ): Promise<SolarEstimate> {
    const ctx = await this.context();
    const [periods, kwhPerPct] = await Promise.all([
      this.forecast.getAdjustedPeriods(fromMs - HOUR_MS, toMs),
      vehicleId ? this.kwhPerPct(vehicleId) : Promise.resolve(null),
    ]);
    const capWh = kwhPerPct === null ? Infinity : roomPct * kwhPerPct * 1000;
    const { wh, capReachedAtMs } = solarToCar(
      periods,
      pick,
      (ms) => ctx.houseByHour[localHour(ms, ctx.timezone)],
      this.rules(ctx, state, schedules),
      fromMs,
      toMs,
      capWh,
    );
    return {
      kwh: wh / 1000,
      pct: kwhPerPct === null ? null : Math.floor(wh / 1000 / kwhPerPct),
      limitAtMs: capReachedAtMs,
    };
  }

  private rules(
    ctx: Context,
    state: VehicleChargeState,
    schedules: EngineSchedule[],
  ): SurplusRules {
    const { solar, timezone } = ctx;
    const wattsPerAmp = solar.gridVoltage * (solar.threePhaseCharger ? 3 : 1);
    return {
      minChargeW: Math.max(
        state.chargeAmpsMin * wattsPerAmp,
        (solar.minExcessSolarKw ?? 0) * 1000,
      ),
      maxChargeW: state.chargeAmpsMax * wattsPerAmp,
      minGenerationW: solar.minSolarGenerationKw * 1000,
      marginW: solar.solarMarginKw * 1000,
      reference: solar.solarReference,
      blockedAt: (ms) => {
        const blockout = selectActiveBlockout(
          schedules,
          new Date(ms),
          timezone,
        );
        return blockout !== null && !blockout.allowSolar;
      },
      solarOnlyAt: (ms) =>
        selectActiveBlockout(schedules, new Date(ms), timezone)?.allowSolar ===
          true,
    };
  }

  // ── Today's projection (dashboard) ─────────────────────────────────

  // For each plugged-in car at home on auto, what solar should add before
  // the sun is done today.
  async projections(): Promise<SolarChargeProjection[]> {
    const ctx = await this.context();
    if (!ctx.solar.solarTrackingEnabled) return [];
    const nowMs = this.now();
    const endOfDayMs = this.localMidnightAfter(nowMs, ctx.timezone);
    const periods = await this.forecast.getAdjustedPeriods(
      nowMs - HOUR_MS,
      endOfDayMs,
    );
    const untilMs = lastSunMs(periods, nowMs, endOfDayMs);
    if (untilMs === null) return [];
    const [rows, states, schedules] = await Promise.all([
      this.db.getVehicles(),
      this.vehicles.getAllStates(),
      this.db.getSchedules(),
    ]);
    const projections = await Promise.all(
      rows.filter((row) => row.mode === "auto").map((row) =>
        this.project(row.id, states.get(row.id), schedules, nowMs, untilMs)
      ),
    );
    return projections.filter((p): p is SolarChargeProjection => p !== null);
  }

  private async project(
    vehicleId: string,
    state: VehicleChargeState | undefined,
    schedules: EngineSchedule[],
    nowMs: number,
    untilMs: number,
  ): Promise<SolarChargeProjection | null> {
    if (!state?.isPluggedIn || state.isHome === false) return null;
    const roomPct = state.chargeLimit - state.batteryLevel;
    if (roomPct <= 0) return null;
    const [exp, low] = await Promise.all(
      [expected, cautious].map((pick) =>
        this.estimate(
          vehicleId,
          state,
          schedules,
          nowMs,
          untilMs,
          pick,
          roomPct,
        )
      ),
    );
    const level = (e: SolarEstimate) =>
      e.pct === null
        ? null
        : Math.min(state.chargeLimit, state.batteryLevel + e.pct);
    return {
      vehicleId,
      expectedKwh: round1(exp.kwh),
      cautiousKwh: round1(low.kwh),
      expectedPct: level(exp),
      cautiousPct: level(low),
      limitPct: state.chargeLimit,
      untilAt: new Date(untilMs).toISOString(),
      limitAt: exp.limitAtMs === null
        ? null
        : new Date(exp.limitAtMs).toISOString(),
    };
  }

  // ── Evening summary ────────────────────────────────────────────────

  async tick(): Promise<void> {
    try {
      const raw = await Promise.all([
        this.db.getConfig("forecast_provider"),
        this.db.getConfig("forecast_summary_time"),
        this.db.getConfig("forecast_summary_sent_on"),
      ]);
      const [provider, time, sentOn] = raw;
      if (!provider) return;
      const { timezone } = await this.context();
      const today = localDateStr(new Date(this.now()), timezone);
      if (!summaryDue(this.now(), timezone, time || "20:00", sentOn, today)) {
        return;
      }
      await this.db.setConfig("forecast_summary_sent_on", today);
      await this.sendSummary();
    } catch (err) {
      this.logger.error("Evening summary failed:", err);
    }
  }

  async sendSummary(): Promise<void> {
    const ctx = await this.context();
    const nowMs = this.now();
    const [summary, rows, states, schedules, solarWh] = await Promise.all([
      this.forecast.getSummary(),
      this.db.getVehicles(),
      this.vehicles.getAllStates(),
      this.db.getSchedules(),
      this.db.stats.getVehicleSolarWh(
        new Date(this.localMidnightAfter(nowMs - DAY_MS, ctx.timezone))
          .toISOString(),
        new Date(nowMs).toISOString(),
      ),
    ]);
    if (!summary) return;
    const cars = await Promise.all(rows.map(async (row) => {
      const state = states.get(row.id) ?? null;
      return {
        name: row.name,
        state,
        solarKwhToday: (solarWh.get(row.id) ?? 0) / 1000,
        tonight: state
          ? await this.tonight(row.id, state, schedules, ctx.timezone)
          : null,
      };
    }));
    const { title, message } = buildEveningSummary(summary, cars);
    await this.notifications.notify("daily_solar_summary", title, message);
  }

  // The top-up planned for the next solar-aware schedule window starting
  // within a day, as it would be worked out when that window opens.
  private async tonight(
    vehicleId: string,
    state: VehicleChargeState,
    schedules: EngineSchedule[],
    timezone: string,
  ) {
    const target = { id: vehicleId, vehicleId };
    const at = (ms: number) =>
      selectActiveChargeSchedule(schedules, target, new Date(ms), timezone);
    const nowMs = this.now();
    const opens = windowAfter((ms) => at(ms) === null, nowMs);
    const startMs = at(nowMs) !== null ? nowMs : opens?.endMs;
    if (startMs === undefined || startMs - nowMs > DAY_MS) return null;
    const active = at(startMs);
    const base = active?.effective.chargeLimitPct ?? null;
    if (!active?.contributors.some((s) => s.solarAware) || base === null) {
      return null;
    }
    const window = windowAfter((ms) => at(ms) !== null, startMs);
    if (!window) return null;
    const plan = await this.planWindow(
      base,
      vehicleId,
      state,
      schedules,
      window,
    );
    return {
      startTime: active.effective.startTime,
      limitPct: Math.max(0, base - (plan?.solarPct ?? 0)),
      plan,
    };
  }

  // ── Cached inputs ──────────────────────────────────────────────────

  private async context(): Promise<Context> {
    const nowMs = this.now();
    if (this.ctx && nowMs - this.ctx.loadedAt < CACHE_MS) return this.ctx;
    const keys = sectionDbKeys(solarConfigDef);
    const [values, timezone] = await Promise.all([
      Promise.all(keys.map((k) => this.db.getConfig(k))),
      this.db.getConfig("timezone"),
    ]);
    const solar = deserializeSection(
      solarConfigDef,
      Object.fromEntries(keys.map((k, i) => [k, values[i]])),
    );
    const buckets = await this.db.stats.getHouseLoadBuckets(
      new Date(nowMs - LOAD_DAYS * DAY_MS).toISOString(),
      new Date(nowMs).toISOString(),
    );
    const tz = timezone || "UTC";
    this.ctx = {
      loadedAt: nowMs,
      timezone: tz,
      solar,
      houseByHour: houseLoadByHour(
        buckets,
        tz,
        !solar.consumptionExcludesCharging,
      ),
    };
    return this.ctx;
  }

  async kwhPerPct(vehicleId: string): Promise<number | null> {
    const nowMs = this.now();
    const cached = this.batteries.get(vehicleId);
    if (cached && nowMs - cached.loadedAt < CACHE_MS) return cached.kwhPerPct;
    const readings = await this.db.stats.getVehicleChargeReadings(
      vehicleId,
      new Date(nowMs - BATTERY_DAYS * DAY_MS).toISOString(),
    );
    const kwhPerPct = learnKwhPerPercent(readings);
    this.batteries.set(vehicleId, { loadedAt: nowMs, kwhPerPct });
    return kwhPerPct;
  }

  private localMidnightAfter(ms: number, timezone: string): number {
    const tomorrow = localDateStr(new Date(ms + DAY_MS), timezone);
    return localMidnightUtcMs(tomorrow, offsetHoursAt(timezone, tomorrow));
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

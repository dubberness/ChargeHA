import type { AppDatabase } from "../db/AppDatabase.ts";
import type { StoredForecastPeriod } from "../db/repositories/ForecastRepository.ts";
import type { Logger } from "../lib/Logger.ts";
import {
  deserializeSection,
  type ForecastConfig,
  forecastConfigDef,
  forecastStateDef,
  sectionDbKeys,
  serializeSection,
} from "@chargeha/shared/configSections";
import {
  bucketForecastWh,
  effectiveForecastW,
  type ForecastProviderId,
  isLocalForecastProvider,
  localMidnightUtcMs,
  periodEndMs,
  type SolarForecastDay,
  type SolarForecastPeriod,
  type SolarForecastSite,
  type SolarForecastStatus,
  type SolarForecastSummary,
  type SolarForecastSummaryPeriod,
} from "@chargeha/shared/solarForecast";
import { localDateStr, offsetHoursAt } from "@chargeha/shared/timezone";
import { inSequence } from "@chargeha/shared/async";
import {
  ForecastQuotaError,
  type SolarForecastProvider,
} from "./forecast-providers/types.ts";
import { daylightRuns, planNextFetch } from "./forecastSchedule.ts";
import { type ForecastLearner, readLearningState } from "./ForecastLearner.ts";
import { activeFactors, applyCorrection } from "./forecastLearning.ts";

// Secret, so it lives outside forecastConfigDef and never reaches the client.
export const FORECAST_API_KEY = "forecast_api_key";

const DAY_MS = 86_400_000;
const TICK_MS = 60_000;
// Energy stats come in 15-minute buckets.
const BUCKET_MS = 15 * 60_000;
// How far back the scheduler looks for today's daylight.
const LOOKBACK_MS = DAY_MS;
const DEFAULT_RETENTION_DAYS = 730;
// A local provider has no quota. Plan as if it allowed this many requests
// a day, which reads it about every half hour of daylight.
const LOCAL_DAILY_FETCHES = 25;

export interface ForecastSettingsInput extends Partial<ForecastConfig> {
  // undefined leaves the stored key alone; "" removes it.
  apiKey?: string;
}

export interface ForecastTestResult {
  success: boolean;
  sites?: SolarForecastSite[];
  error?: string;
}

export interface ForecastRefreshResult {
  success: boolean;
  error?: string;
}

interface Usage {
  date: string;
  count: number;
}

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const addDays = (date: string, days: number): string =>
  utcDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const addPeriods = (
  a: SolarForecastPeriod,
  b: SolarForecastPeriod,
): SolarForecastPeriod => ({
  ...a,
  pvW: a.pvW + b.pvW,
  pvW10: a.pvW10 + b.pvW10,
  pvW90: a.pvW90 + b.pvW90,
});

// Adds each site's forecast into one series.
export function sumSites(
  perSite: readonly SolarForecastPeriod[][],
): SolarForecastPeriod[] {
  const byStart = perSite.flat().reduce((acc, period) => {
    const existing = acc.get(period.periodStart);
    acc.set(
      period.periodStart,
      existing ? addPeriods(existing, period) : period,
    );
    return acc;
  }, new Map<string, SolarForecastPeriod>());
  return [...byStart.values()].sort((a, b) =>
    Date.parse(a.periodStart) - Date.parse(b.periodStart)
  );
}

// Fetches solar forecasts from the configured provider on a schedule that
// fits its daily quota, and stores them for the dashboard and stats pages.
export class SolarForecastService {
  private readonly providers: Map<string, SolarForecastProvider>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<ForecastRefreshResult> | null = null;
  // Site count seen on the last fetch, for planning when the settings
  // leave the site list to the account.
  private knownSiteCount: number | null = null;

  constructor(
    private readonly db: AppDatabase,
    providers: SolarForecastProvider[],
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    // Learns from the stored forecasts; runs alongside the fetching.
    private readonly learner: ForecastLearner | null = null,
  ) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
    this.learner?.start();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.learner?.stop();
  }

  // Runs the automatic update when the schedule says it is due.
  async tick(): Promise<void> {
    try {
      const next = await this.nextFetchMs();
      if (next !== null && next <= this.now()) await this.refresh();
    } catch (err) {
      this.logger.error("Solar forecast tick failed:", err);
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────

  async getConfig(): Promise<ForecastConfig> {
    const keys = sectionDbKeys(forecastConfigDef);
    const values = await Promise.all(keys.map((k) => this.db.getConfig(k)));
    return deserializeSection(
      forecastConfigDef,
      Object.fromEntries(keys.map((k, i) => [k, values[i]])),
    );
  }

  async saveSettings(input: ForecastSettingsInput): Promise<void> {
    const { apiKey, ...config } = input;
    const before = await this.getConfig();
    const kv = serializeSection(forecastConfigDef, config);
    await Promise.all(
      Object.entries(kv).map(([key, value]) =>
        this.db.setConfig(key as keyof typeof kv, value)
      ),
    );
    if (apiKey !== undefined) {
      await this.db.storeSecret(FORECAST_API_KEY, apiKey.trim() || null);
    }
    const sourceKeys = [
      "forecastProvider",
      "forecastSiteIds",
      "forecastBaseUrl",
    ] as const;
    const settingChanged = sourceKeys.some((key) =>
      config[key] !== undefined && config[key] !== before[key]
    );
    const sourceChanged = apiKey !== undefined || settingChanged;
    if (sourceChanged) {
      // A new key or site list: the next tick forecasts as soon as the
      // quota allows, and the old settings' error no longer applies.
      this.knownSiteCount = null;
      await this.setState({ forecastLastFetchAt: "", forecastLastError: "" });
    }
  }

  // Lists the account's sites with a key before it is saved. Free — listing
  // sites does not count against the quota. `providerId` is the one being
  // chosen, and `baseUrl` its address, which may not be saved yet.
  async testKey(
    apiKey?: string,
    providerId?: ForecastProviderId,
    baseUrl?: string,
  ): Promise<ForecastTestResult> {
    try {
      const provider = providerId
        ? this.providers.get(providerId) ?? null
        : await this.activeProvider();
      const key = apiKey?.trim() || await this.db.readSecret(FORECAST_API_KEY);
      if (!provider) return { success: false, error: "Choose a provider" };
      if (!key) return { success: false, error: "Enter an API key" };
      const sites = await provider.listSites(key, {
        baseUrl: baseUrl ?? (await this.getConfig()).forecastBaseUrl,
      });
      if (sites.length === 0) {
        return {
          success: false,
          error: `No sites on this ${provider.displayName} account yet`,
        };
      }
      return { success: true, sites };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  }

  // ── Status ───────────────────────────────────────────────────────────

  async getStatus(): Promise<SolarForecastStatus> {
    const [config, apiKey, state, next, learning] = await Promise.all([
      this.getConfig(),
      this.db.readSecret(FORECAST_API_KEY),
      this.getState(),
      this.nextFetchMs(),
      readLearningState(this.db),
    ]);
    const local = isLocalForecastProvider(config.forecastProvider);
    return {
      provider: config.forecastProvider || null,
      baseUrl: config.forecastBaseUrl,
      apiKeySet: !!apiKey,
      siteIds: parseSiteIds(config.forecastSiteIds),
      dailyLimit: config.forecastDailyLimit,
      usedToday: local ? 0 : this.usageToday(state.usage),
      lastFetchAt: state.lastFetchAt,
      lastError: state.lastError,
      nextFetchAt: next === null ? null : new Date(next).toISOString(),
      adjust: config.forecastAdjust,
      summaryTime: config.forecastSummaryTime,
      correction: learning.correction,
      panelCheck: learning.panelCheck,
    };
  }

  // ── Fetching ─────────────────────────────────────────────────────────

  // Fetch now, if the quota allows. Concurrent callers share one fetch.
  refresh(): Promise<ForecastRefreshResult> {
    this.inFlight ??= this.fetchAndStore().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchAndStore(): Promise<ForecastRefreshResult> {
    const [provider, apiKey, config] = await Promise.all([
      this.activeProvider(),
      this.db.readSecret(FORECAST_API_KEY),
      this.getConfig(),
    ]);
    if (!provider || !apiKey) {
      return { success: false, error: "Solar forecast is not set up" };
    }
    const startedMs = this.now();
    await this.setState({
      forecastLastAttemptAt: new Date(startedMs).toISOString(),
    });
    // A local provider has one combined forecast and no quota to count.
    const local = isLocalForecastProvider(provider.id);
    const options = { baseUrl: config.forecastBaseUrl };
    try {
      const configured = local ? [] : parseSiteIds(config.forecastSiteIds);
      const siteIds = configured.length > 0
        ? configured
        : (await provider.listSites(apiKey, options)).map((s) => s.id);
      if (siteIds.length === 0) {
        throw new Error(
          `No sites on this ${provider.displayName} account — add one on their website first`,
        );
      }
      this.knownSiteCount = siteIds.length;
      const used = this.usageToday((await this.getState()).usage);
      if (!local && used + siteIds.length > config.forecastDailyLimit) {
        throw new ForecastQuotaError(
          `Today's ${config.forecastDailyLimit} requests are used — updates resume after midnight UTC`,
        );
      }
      const perSite: SolarForecastPeriod[][] = [];
      await inSequence(siteIds, async (siteId) => {
        perSite.push(await provider.fetchForecast(apiKey, siteId, options));
        if (!local) await this.countRequest(config.forecastDailyLimit);
      });
      await this.store(sumSites(perSite), new Date(startedMs));
      await this.setState({
        forecastLastFetchAt: new Date(startedMs).toISOString(),
        forecastLastError: "",
      });
      this.logger.info(
        `Solar forecast updated from ${provider.displayName} (${siteIds.length} site${
          siteIds.length === 1 ? "" : "s"
        })`,
      );
      return { success: true };
    } catch (err) {
      const message = errorMessage(err);
      if (err instanceof ForecastQuotaError) {
        await this.exhaustQuota(config.forecastDailyLimit);
      }
      await this.setState({ forecastLastError: message });
      this.logger.warn(`Solar forecast update failed: ${message}`);
      return { success: false, error: message };
    }
  }

  private async store(
    periods: SolarForecastPeriod[],
    fetchedAt: Date,
  ): Promise<void> {
    const timezone = await this.timezone();
    const fetchedDay = localDateStr(fetchedAt, timezone);
    await this.db.forecasts.upsertPeriods(
      periods.map((period) => ({
        ...period,
        isDayAhead:
          localDateStr(new Date(period.periodStart), timezone) > fetchedDay,
      })),
      fetchedAt,
    );
    const retention = Number(await this.db.getConfig("data_retention_days")) ||
      DEFAULT_RETENTION_DAYS;
    await this.db.forecasts.prune(retention);
  }

  // ── Scheduling ───────────────────────────────────────────────────────

  private async nextFetchMs(): Promise<number | null> {
    const [provider, apiKey, config, state] = await Promise.all([
      this.activeProvider(),
      this.db.readSecret(FORECAST_API_KEY),
      this.getConfig(),
      this.getState(),
    ]);
    if (!provider || !apiKey) return null;
    const nowMs = this.now();
    const periods = await this.db.forecasts.getPeriods(
      new Date(nowMs - LOOKBACK_MS).toISOString(),
      new Date(nowMs + 8 * DAY_MS).toISOString(),
    );
    const local = isLocalForecastProvider(provider.id);
    const configured = parseSiteIds(config.forecastSiteIds).length;
    return planNextFetch({
      nowMs,
      lastFetchMs: parseTime(state.lastFetchAt),
      lastAttemptMs: parseTime(state.lastAttemptAt),
      lastAttemptFailed: state.lastError !== null,
      usedToday: local ? 0 : this.usageToday(state.usage),
      dailyLimit: local ? LOCAL_DAILY_FETCHES : config.forecastDailyLimit,
      siteCount: local ? 1 : configured || this.knownSiteCount || 1,
      runs: daylightRuns(periods),
    });
  }

  private async activeProvider(): Promise<SolarForecastProvider | null> {
    const { forecastProvider } = await this.getConfig();
    return forecastProvider
      ? this.providers.get(forecastProvider as ForecastProviderId) ?? null
      : null;
  }

  // ── Quota bookkeeping (persisted, so restarts never overspend) ───────

  private usageToday(usage: Usage | null): number {
    return usage?.date === utcDate(this.now()) ? usage.count : 0;
  }

  private async countRequest(dailyLimit: number): Promise<void> {
    const used = this.usageToday((await this.getState()).usage);
    await this.setUsage(Math.min(used + 1, dailyLimit));
  }

  // The provider says the day's quota is gone, whatever our count says.
  private async exhaustQuota(dailyLimit: number): Promise<void> {
    await this.setUsage(dailyLimit);
  }

  private async setUsage(count: number): Promise<void> {
    const usage: Usage = { date: utcDate(this.now()), count };
    await this.setState({ forecastUsage: JSON.stringify(usage) });
  }

  private async getState(): Promise<{
    usage: Usage | null;
    lastFetchAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
  }> {
    const keys = sectionDbKeys(forecastStateDef);
    const values = await Promise.all(keys.map((k) => this.db.getConfig(k)));
    const state = deserializeSection(
      forecastStateDef,
      Object.fromEntries(keys.map((k, i) => [k, values[i]])),
    );
    return {
      usage: parseUsage(state.forecastUsage),
      lastFetchAt: state.forecastLastFetchAt || null,
      lastAttemptAt: state.forecastLastAttemptAt || null,
      lastError: state.forecastLastError || null,
    };
  }

  private async setState(
    patch: Partial<Record<keyof typeof forecastStateDef, string>>,
  ): Promise<void> {
    const kv = serializeSection(forecastStateDef, patch);
    await Promise.all(
      Object.entries(kv).map(([key, value]) =>
        this.db.setConfig(key as keyof typeof kv, value)
      ),
    );
  }

  private async timezone(): Promise<string> {
    return (await this.db.getConfig("timezone")) || "UTC";
  }

  // ── Forecast for other services ──────────────────────────────────────

  // Periods starting in [start, end), with the learned correction applied
  // when it is on. Empty when forecasting is off.
  async getAdjustedPeriods(
    startMs: number,
    endMs: number,
  ): Promise<StoredForecastPeriod[]> {
    if (!(await this.activeProvider())) return [];
    const [periods, learning] = await Promise.all([
      this.db.forecasts.getPeriods(
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
      ),
      readLearningState(this.db),
    ]);
    const hourFactors = activeFactors(learning.adjust, learning.correction);
    return hourFactors
      ? applyCorrection(periods, hourFactors, learning.timezone)
      : periods;
  }

  // ── Dashboard summary ────────────────────────────────────────────────

  // Today against the forecast, and the days ahead. Null when forecasting is
  // off or there is no forecast for today.
  async getSummary(): Promise<SolarForecastSummary | null> {
    if (!(await this.activeProvider())) return null;
    const timezone = await this.timezone();
    const nowMs = this.now();
    const today = localDateStr(new Date(nowMs), timezone);
    const midnightOf = (date: string) =>
      localMidnightUtcMs(date, offsetHoursAt(timezone, date));
    const dates = Array.from({ length: 8 }, (_, i) => addDays(today, i));
    const edges = [...dates, addDays(today, 8)].map(midnightOf);
    const [rawPeriods, actualRows, state, learning] = await Promise.all([
      this.db.forecasts.getPeriods(
        new Date(edges[0]).toISOString(),
        new Date(edges[8]).toISOString(),
      ),
      this.db.stats.getEnergyStatsDayDetailed(
        today,
        offsetHoursAt(timezone, today),
      ),
      this.getState(),
      readLearningState(this.db),
    ]);
    const hourFactors = activeFactors(learning.adjust, learning.correction);
    const periods = hourFactors
      ? applyCorrection(rawPeriods, hourFactors, timezone)
      : rawPeriods;
    if (!periods.some((p) => Date.parse(p.periodStart) < edges[1])) {
      return null;
    }
    const lastEndMs = Math.max(...periods.map(periodEndMs));
    const pick = (p: StoredForecastPeriod) => effectiveForecastW(p, nowMs);
    const actualWh = actualRows.reduce((s, r) => s + r.solarProductionWh, 0);
    const days: SolarForecastDay[] = dates
      .map((date, i) => ({ date, startMs: edges[i], endMs: edges[i + 1] }))
      .filter(({ endMs }, i) => i === 0 || lastEndMs >= endMs)
      .map(({ date, startMs, endMs }, i) => ({
        date,
        forecastWh: bucketForecastWh(periods, [startMs, endMs], pick)[0],
        forecastWh10:
          bucketForecastWh(periods, [startMs, endMs], (p) => p.pvW10)[0],
        forecastWh90:
          bucketForecastWh(periods, [startMs, endMs], (p) => p.pvW90)[0],
        actualWh: i === 0 ? actualWh : null,
      }));
    const [forecastToNowWh, remainingWh] = bucketForecastWh(
      periods,
      [edges[0], nowMs, edges[1]],
      pick,
    );
    // Measured production over the same hours the forecast covers — on the
    // first day the forecast only starts when it was first fetched.
    const coveredFromMs = Date.parse(periods[0].periodStart);
    const actualToNowWh = actualRows
      .filter((r) => edges[0] + r.bucket * BUCKET_MS >= coveredFromMs)
      .reduce((s, r) => s + r.solarProductionWh, 0);
    return {
      today: { ...days[0], forecastToNowWh, actualToNowWh, remainingWh },
      days,
      periods: this.summaryPeriods(periods, actualRows, edges, nowMs),
      updatedAt: state.lastFetchAt,
      adjusted: hourFactors !== null,
      panelLow: learning.panelCheck?.state === "low"
        ? { recentShare: learning.panelCheck.recentShare ?? 0 }
        : null,
    };
  }

  // Today and tomorrow, each period with its measured production once it
  // has passed. Actuals come in 15-minute buckets from the energy stats.
  private summaryPeriods(
    periods: StoredForecastPeriod[],
    actualRows: ReadonlyArray<{ bucket: number; solarProductionWh: number }>,
    edges: number[],
    nowMs: number,
  ): SolarForecastSummaryPeriod[] {
    const actualByBucket = new Map(
      actualRows.map((r) => [r.bucket, r.solarProductionWh]),
    );
    return periods
      .filter((p) => Date.parse(p.periodStart) < edges[2])
      .map(({ dayAheadW: _dayAhead, ...period }) => {
        const startMs = Date.parse(period.periodStart);
        const endMs = periodEndMs(period);
        if (endMs > nowMs || endMs > edges[1]) {
          return { ...period, actualW: null };
        }
        const first = Math.round((startMs - edges[0]) / BUCKET_MS);
        const count = Math.round((endMs - startMs) / BUCKET_MS);
        const wh = Array.from({ length: count }, (_, i) => first + i)
          .reduce((sum, b) => sum + (actualByBucket.get(b) ?? 0), 0);
        return { ...period, actualW: wh / ((endMs - startMs) / 3_600_000) };
      });
  }
}

export function parseSiteIds(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function parseUsage(raw: string): Usage | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.date === "string" && typeof parsed?.count === "number"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

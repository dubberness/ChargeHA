import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, gte, lt, sql } from "drizzle-orm";
import type { SolarForecastPeriod } from "@chargeha/shared/solarForecast";
import { toSqliteDatetime } from "./sqliteHelpers.ts";
import { solarForecasts } from "../Schema.ts";

export interface StoredForecastPeriod extends SolarForecastPeriod {
  // The forecast as it stood before the period's local day began, or null
  // when no update landed before that day.
  dayAheadW: number | null;
}

export interface ForecastPeriodWrite extends SolarForecastPeriod {
  // True when this update was fetched before the period's local day began.
  isDayAhead: boolean;
}

// "2026-09-28 01:30:00" (UTC, as stored) → "2026-09-28T01:30:00Z".
const toIso = (stored: string): string => `${stored.replace(" ", "T")}Z`;

export class ForecastRepository {
  constructor(private db: BetterSQLite3Database) {}

  // Insert or replace each period. The latest update always wins; the
  // day-ahead value only moves while the period's day is still ahead.
  async upsertPeriods(
    periods: readonly ForecastPeriodWrite[],
    fetchedAt: Date,
  ): Promise<void> {
    const fetched = toSqliteDatetime(fetchedAt.toISOString());
    const toRow = (period: ForecastPeriodWrite) => ({
      periodStart: toSqliteDatetime(period.periodStart),
      periodMinutes: period.periodMinutes,
      pvEstimateW: period.pvW,
      pvEstimate10W: period.pvW10,
      pvEstimate90W: period.pvW90,
      dayAheadW: period.isDayAhead ? period.pvW : null,
      fetchedAt: fetched,
    });
    const latest = {
      periodMinutes: sql`excluded.period_minutes`,
      pvEstimateW: sql`excluded.pv_estimate_w`,
      pvEstimate10W: sql`excluded.pv_estimate10_w`,
      pvEstimate90W: sql`excluded.pv_estimate90_w`,
      fetchedAt: sql`excluded.fetched_at`,
    };
    const dayAhead = periods.filter((p) => p.isDayAhead).map(toRow);
    const sameDay = periods.filter((p) => !p.isDayAhead).map(toRow);
    if (dayAhead.length > 0) {
      await this.db.insert(solarForecasts).values(dayAhead)
        .onConflictDoUpdate({
          target: solarForecasts.periodStart,
          set: { ...latest, dayAheadW: sql`excluded.day_ahead_w` },
        });
    }
    if (sameDay.length > 0) {
      await this.db.insert(solarForecasts).values(sameDay)
        .onConflictDoUpdate({
          target: solarForecasts.periodStart,
          set: latest,
        });
    }
  }

  // Periods starting in [start, end), oldest first.
  async getPeriods(
    startIso: string,
    endIso: string,
  ): Promise<StoredForecastPeriod[]> {
    const rows = await this.db.select().from(solarForecasts)
      .where(and(
        gte(solarForecasts.periodStart, toSqliteDatetime(startIso)),
        lt(solarForecasts.periodStart, toSqliteDatetime(endIso)),
      ))
      .orderBy(asc(solarForecasts.periodStart));
    return rows.map((row) => ({
      periodStart: toIso(row.periodStart),
      periodMinutes: row.periodMinutes,
      pvW: row.pvEstimateW,
      pvW10: row.pvEstimate10W,
      pvW90: row.pvEstimate90W,
      dayAheadW: row.dayAheadW,
    }));
  }

  async prune(retentionDays: number): Promise<void> {
    await this.db.delete(solarForecasts).where(
      lt(
        solarForecasts.periodStart,
        sql`datetime('now', ${`-${retentionDays} days`})`,
      ),
    );
  }
}

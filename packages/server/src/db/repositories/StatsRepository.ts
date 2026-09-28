import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { sqliteTimezoneOffset, toSqliteDatetime } from "./sqliteHelpers.ts";

export class StatsRepository {
  constructor(private db: BetterSQLite3Database) {}

  /** Aggregate vehicle charge readings by hour for a given day (YYYY-MM-DD local). */
  async getStatsDay(
    date: string,
    tzOffsetHours: number,
    vehicleId?: string,
  ): Promise<
    Array<{
      bucket: string;
      solarWh: number;
      gridWh: number;
      awayWh: number;
      totalWh: number;
      costCents: number;
      solarSavingsCents: number;
    }>
  > {
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const vehicleCondition = vehicleId
      ? sql` AND vehicle_id = ${vehicleId}`
      : sql``;

    const rows = await this.db.all<{
      bucket: string;
      solar_wh: number;
      grid_wh: number;
      away_wh: number;
      total_wh: number;
      cost_cents: number;
      solar_savings_cents: number;
    }>(sql`SELECT
              strftime('%H', timestamp, ${offset}) AS bucket,
              SUM(CASE WHEN is_home = 1 THEN solar_contribution_w * (60.0 / 3600.0) ELSE 0 END) AS solar_wh,
              SUM(CASE WHEN is_home = 1 THEN grid_contribution_w * (60.0 / 3600.0) ELSE 0 END) AS grid_wh,
              SUM(CASE WHEN is_home = 0 THEN charge_power_w * (60.0 / 3600.0) ELSE 0 END) AS away_wh,
              SUM(charge_power_w * (60.0 / 3600.0)) AS total_wh,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN grid_contribution_w * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS cost_cents,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN solar_contribution_w * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS solar_savings_cents
            FROM vehicle_charge_readings
            WHERE date(timestamp, ${offset}) = ${date}${vehicleCondition}
            GROUP BY bucket
            ORDER BY bucket`);
    return rows.map((row) => ({
      bucket: row.bucket as string,
      solarWh: (row.solar_wh as number) ?? 0,
      gridWh: (row.grid_wh as number) ?? 0,
      awayWh: (row.away_wh as number) ?? 0,
      totalWh: (row.total_wh as number) ?? 0,
      costCents: (row.cost_cents as number) ?? 0,
      solarSavingsCents: (row.solar_savings_cents as number) ?? 0,
    }));
  }

  /** Aggregate vehicle charge readings by 15-min intervals for a given day (YYYY-MM-DD local). */
  async getStatsDayDetailed(
    date: string,
    tzOffsetHours: number,
    vehicleId?: string,
  ): Promise<
    Array<{
      bucket: number;
      solarWh: number;
      gridWh: number;
      awayWh: number;
      totalWh: number;
      costCents: number;
      solarSavingsCents: number;
    }>
  > {
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const vehicleCondition = vehicleId
      ? sql` AND vehicle_id = ${vehicleId}`
      : sql``;

    const rows = await this.db.all<{
      bucket: number;
      solar_wh: number;
      grid_wh: number;
      away_wh: number;
      total_wh: number;
      cost_cents: number;
      solar_savings_cents: number;
    }>(sql`SELECT
              CAST(strftime('%H', timestamp, ${offset}) AS INTEGER) * 4
                + CAST(strftime('%M', timestamp, ${offset}) AS INTEGER) / 15 AS bucket,
              SUM(CASE WHEN is_home = 1 THEN solar_contribution_w * (60.0 / 3600.0) ELSE 0 END) AS solar_wh,
              SUM(CASE WHEN is_home = 1 THEN grid_contribution_w * (60.0 / 3600.0) ELSE 0 END) AS grid_wh,
              SUM(CASE WHEN is_home = 0 THEN charge_power_w * (60.0 / 3600.0) ELSE 0 END) AS away_wh,
              SUM(charge_power_w * (60.0 / 3600.0)) AS total_wh,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN grid_contribution_w * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS cost_cents,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN solar_contribution_w * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS solar_savings_cents
            FROM vehicle_charge_readings
            WHERE date(timestamp, ${offset}) = ${date}${vehicleCondition}
            GROUP BY bucket
            ORDER BY bucket`);
    return rows.map((row) => ({
      bucket: (row.bucket as number) ?? 0,
      solarWh: (row.solar_wh as number) ?? 0,
      gridWh: (row.grid_wh as number) ?? 0,
      awayWh: (row.away_wh as number) ?? 0,
      totalWh: (row.total_wh as number) ?? 0,
      costCents: (row.cost_cents as number) ?? 0,
      solarSavingsCents: (row.solar_savings_cents as number) ?? 0,
    }));
  }

  /** Aggregate vehicle charge readings by day for a given month (local time). */
  async getStatsMonth(
    year: number,
    month: number,
    tzOffsetHours: number,
    vehicleId?: string,
  ): Promise<
    Array<{
      bucket: string;
      solarWh: number;
      gridWh: number;
      awayWh: number;
      totalWh: number;
      costCents: number;
      solarSavingsCents: number;
    }>
  > {
    const monthStr = String(month).padStart(2, "0");
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const yearMonth = `${year}-${monthStr}`;
    const vehicleCondition = vehicleId
      ? sql` AND vehicle_id = ${vehicleId}`
      : sql``;

    const rows = await this.db.all<{
      bucket: string;
      solar_wh: number;
      grid_wh: number;
      away_wh: number;
      total_wh: number;
      cost_cents: number;
      solar_savings_cents: number;
    }>(sql`SELECT
              strftime('%d', timestamp, ${offset}) AS bucket,
              SUM(CASE WHEN is_home = 1 THEN solar_contribution_w * (60.0 / 3600.0) ELSE 0 END) AS solar_wh,
              SUM(CASE WHEN is_home = 1 THEN grid_contribution_w * (60.0 / 3600.0) ELSE 0 END) AS grid_wh,
              SUM(CASE WHEN is_home = 0 THEN charge_power_w * (60.0 / 3600.0) ELSE 0 END) AS away_wh,
              SUM(charge_power_w * (60.0 / 3600.0)) AS total_wh,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN grid_contribution_w * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS cost_cents,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN solar_contribution_w * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS solar_savings_cents
            FROM vehicle_charge_readings
            WHERE strftime('%Y-%m', timestamp, ${offset}) = ${yearMonth}${vehicleCondition}
            GROUP BY bucket
            ORDER BY bucket`);
    return rows.map((row) => ({
      bucket: row.bucket as string,
      solarWh: (row.solar_wh as number) ?? 0,
      gridWh: (row.grid_wh as number) ?? 0,
      awayWh: (row.away_wh as number) ?? 0,
      totalWh: (row.total_wh as number) ?? 0,
      costCents: (row.cost_cents as number) ?? 0,
      solarSavingsCents: (row.solar_savings_cents as number) ?? 0,
    }));
  }

  /** Aggregate vehicle charge readings by month for a given year (local time). */
  async getStatsYear(
    year: number,
    tzOffsetHours: number,
    vehicleId?: string,
  ): Promise<
    Array<{
      bucket: string;
      solarWh: number;
      gridWh: number;
      awayWh: number;
      totalWh: number;
      costCents: number;
      solarSavingsCents: number;
    }>
  > {
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const yearStr = String(year);
    const vehicleCondition = vehicleId
      ? sql` AND vehicle_id = ${vehicleId}`
      : sql``;

    const rows = await this.db.all<{
      bucket: string;
      solar_wh: number;
      grid_wh: number;
      away_wh: number;
      total_wh: number;
      cost_cents: number;
      solar_savings_cents: number;
    }>(sql`SELECT
              strftime('%m', timestamp, ${offset}) AS bucket,
              SUM(CASE WHEN is_home = 1 THEN solar_contribution_w * (60.0 / 3600.0) ELSE 0 END) AS solar_wh,
              SUM(CASE WHEN is_home = 1 THEN grid_contribution_w * (60.0 / 3600.0) ELSE 0 END) AS grid_wh,
              SUM(CASE WHEN is_home = 0 THEN charge_power_w * (60.0 / 3600.0) ELSE 0 END) AS away_wh,
              SUM(charge_power_w * (60.0 / 3600.0)) AS total_wh,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN grid_contribution_w * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS cost_cents,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN solar_contribution_w * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS solar_savings_cents
            FROM vehicle_charge_readings
            WHERE strftime('%Y', timestamp, ${offset}) = ${yearStr}${vehicleCondition}
            GROUP BY bucket
            ORDER BY bucket`);
    return rows.map((row) => ({
      bucket: row.bucket as string,
      solarWh: (row.solar_wh as number) ?? 0,
      gridWh: (row.grid_wh as number) ?? 0,
      awayWh: (row.away_wh as number) ?? 0,
      totalWh: (row.total_wh as number) ?? 0,
      costCents: (row.cost_cents as number) ?? 0,
      solarSavingsCents: (row.solar_savings_cents as number) ?? 0,
    }));
  }

  /** Aggregate whole-home grid usage grouped by tariff rate for a date range. */
  async getTariffBreakdown(
    startDate: string,
    endDate: string,
    tzOffsetHours: number,
  ): Promise<
    Array<{
      ratePerKwh: number;
      gridWh: number;
      costCents: number;
    }>
  > {
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const rows = await this.db.all<{
      rate_per_kwh: number;
      grid_wh: number;
      cost_cents: number;
    }>(sql`SELECT
              rate_per_kwh,
              SUM(MAX(grid_power_w, 0) * (60.0 / 3600.0)) AS grid_wh,
              SUM(MAX(grid_power_w, 0) * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100) AS cost_cents
            FROM energy_readings
            WHERE rate_per_kwh IS NOT NULL
              AND date(timestamp, ${offset}) >= ${startDate}
              AND date(timestamp, ${offset}) <= ${endDate}
            GROUP BY rate_per_kwh
            ORDER BY rate_per_kwh ASC`);
    return rows.map((row) => ({
      ratePerKwh: (row.rate_per_kwh as number) ?? 0,
      gridWh: (row.grid_wh as number) ?? 0,
      costCents: (row.cost_cents as number) ?? 0,
    }));
  }

  // ---- Home energy stats (from energy_readings) ----

  /** Aggregate home energy readings by hour for a given day (YYYY-MM-DD local). */
  async getEnergyStatsDay(
    date: string,
    tzOffsetHours: number,
  ): Promise<
    Array<{
      bucket: string;
      solarProductionWh: number;
      solarWh: number;
      gridWh: number;
      totalWh: number;
      costCents: number;
      solarSavingsCents: number;
    }>
  > {
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const rows = await this.db.all<{
      bucket: string;
      solar_production_wh: number;
      solar_wh: number;
      grid_wh: number;
      total_wh: number;
      cost_cents: number;
      solar_savings_cents: number;
    }>(sql`SELECT
              strftime('%H', timestamp, ${offset}) AS bucket,
              SUM(solar_production_w * (60.0 / 3600.0)) AS solar_production_wh,
              SUM(MIN(solar_production_w, home_consumption_w) * (60.0 / 3600.0)) AS solar_wh,
              SUM(MAX(grid_power_w, 0) * (60.0 / 3600.0)) AS grid_wh,
              SUM(home_consumption_w * (60.0 / 3600.0)) AS total_wh,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN MAX(grid_power_w, 0) * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS cost_cents,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN MIN(solar_production_w, home_consumption_w) * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS solar_savings_cents
            FROM energy_readings
            WHERE date(timestamp, ${offset}) = ${date}
            GROUP BY bucket
            ORDER BY bucket`);
    return rows.map((row) => ({
      bucket: row.bucket as string,
      solarProductionWh: (row.solar_production_wh as number) ?? 0,
      solarWh: (row.solar_wh as number) ?? 0,
      gridWh: (row.grid_wh as number) ?? 0,
      totalWh: (row.total_wh as number) ?? 0,
      costCents: (row.cost_cents as number) ?? 0,
      solarSavingsCents: (row.solar_savings_cents as number) ?? 0,
    }));
  }

  /** Average solar production in each UTC 15-minute bucket with readings in
   *  [start, end), and how many readings it has, so a caller can tell a
   *  bucket with a gap in the recording from a dull one. */
  async getSolarProductionBuckets(
    startIso: string,
    endIso: string,
  ): Promise<Array<{ startMs: number; avgW: number; readings: number }>> {
    const rows = await this.db.all<{
      bucket_start: number;
      avg_w: number;
      readings: number;
    }>(sql`SELECT
              CAST(strftime('%s', timestamp) AS INTEGER) / 900 * 900 AS bucket_start,
              AVG(solar_production_w) AS avg_w,
              COUNT(*) AS readings
            FROM energy_readings
            WHERE timestamp >= ${toSqliteDatetime(startIso)}
              AND timestamp < ${toSqliteDatetime(endIso)}
              AND poll_failed = 0
            GROUP BY bucket_start
            ORDER BY bucket_start`);
    return rows.map((row) => ({
      startMs: row.bucket_start * 1000,
      avgW: row.avg_w ?? 0,
      readings: row.readings,
    }));
  }

  /** Average home consumption and home car charging in each UTC 15-minute
   *  bucket with energy readings in [start, end). */
  async getHouseLoadBuckets(
    startIso: string,
    endIso: string,
  ): Promise<Array<{ startMs: number; homeW: number; carW: number }>> {
    const start = toSqliteDatetime(startIso);
    const end = toSqliteDatetime(endIso);
    const rows = await this.db.all<{
      bucket_start: number;
      home_w: number;
      car_w: number | null;
    }>(sql`WITH home AS (
              SELECT CAST(strftime('%s', timestamp) AS INTEGER) / 900 * 900 AS bucket_start,
                     AVG(home_consumption_w) AS home_w
              FROM energy_readings
              WHERE timestamp >= ${start} AND timestamp < ${end} AND poll_failed = 0
              GROUP BY bucket_start
            ), per_vehicle AS (
              SELECT CAST(strftime('%s', timestamp) AS INTEGER) / 900 * 900 AS bucket_start,
                     AVG(charge_power_w) AS car_w
              FROM vehicle_charge_readings
              WHERE timestamp >= ${start} AND timestamp < ${end} AND is_home = 1
              GROUP BY bucket_start, vehicle_id
            ), car AS (
              SELECT bucket_start, SUM(car_w) AS car_w FROM per_vehicle GROUP BY bucket_start
            )
            SELECT home.bucket_start, home.home_w, car.car_w
            FROM home LEFT JOIN car ON car.bucket_start = home.bucket_start
            ORDER BY home.bucket_start`);
    return rows.map((row) => ({
      startMs: row.bucket_start * 1000,
      homeW: row.home_w ?? 0,
      carW: row.car_w ?? 0,
    }));
  }

  /** One vehicle's charge readings since `startIso`, oldest first. */
  async getVehicleChargeReadings(
    vehicleId: string,
    startIso: string,
  ): Promise<
    Array<{ ms: number; powerW: number; batteryLevel: number | null }>
  > {
    const rows = await this.db.all<{
      ts: number;
      charge_power_w: number;
      battery_level: number | null;
    }>(sql`SELECT CAST(strftime('%s', timestamp) AS INTEGER) AS ts,
                  charge_power_w, battery_level
            FROM vehicle_charge_readings
            WHERE vehicle_id = ${vehicleId}
              AND timestamp >= ${toSqliteDatetime(startIso)}
            ORDER BY timestamp`);
    return rows.map((row) => ({
      ms: row.ts * 1000,
      powerW: row.charge_power_w,
      batteryLevel: row.battery_level,
    }));
  }

  /** Solar energy each vehicle took at home in [start, end). */
  async getVehicleSolarWh(
    startIso: string,
    endIso: string,
  ): Promise<Map<string, number>> {
    const rows = await this.db.all<{ vehicle_id: string; wh: number }>(
      sql`SELECT vehicle_id, SUM(solar_contribution_w * (60.0 / 3600.0)) AS wh
          FROM vehicle_charge_readings
          WHERE timestamp >= ${toSqliteDatetime(startIso)}
            AND timestamp < ${toSqliteDatetime(endIso)}
            AND is_home = 1
          GROUP BY vehicle_id`,
    );
    return new Map(rows.map((row) => [row.vehicle_id, row.wh ?? 0]));
  }

  /** Aggregate home energy readings by 15-min intervals for a given day (YYYY-MM-DD local). */
  async getEnergyStatsDayDetailed(
    date: string,
    tzOffsetHours: number,
  ): Promise<
    Array<{
      bucket: number;
      solarProductionWh: number;
      solarWh: number;
      gridWh: number;
      totalWh: number;
      costCents: number;
      solarSavingsCents: number;
    }>
  > {
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const rows = await this.db.all<{
      bucket: number;
      solar_production_wh: number;
      solar_wh: number;
      grid_wh: number;
      total_wh: number;
      cost_cents: number;
      solar_savings_cents: number;
    }>(sql`SELECT
              CAST(strftime('%H', timestamp, ${offset}) AS INTEGER) * 4
                + CAST(strftime('%M', timestamp, ${offset}) AS INTEGER) / 15 AS bucket,
              SUM(solar_production_w * (60.0 / 3600.0)) AS solar_production_wh,
              SUM(MIN(solar_production_w, home_consumption_w) * (60.0 / 3600.0)) AS solar_wh,
              SUM(MAX(grid_power_w, 0) * (60.0 / 3600.0)) AS grid_wh,
              SUM(home_consumption_w * (60.0 / 3600.0)) AS total_wh,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN MAX(grid_power_w, 0) * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS cost_cents,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN MIN(solar_production_w, home_consumption_w) * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS solar_savings_cents
            FROM energy_readings
            WHERE date(timestamp, ${offset}) = ${date}
            GROUP BY bucket
            ORDER BY bucket`);
    return rows.map((row) => ({
      bucket: (row.bucket as number) ?? 0,
      solarProductionWh: (row.solar_production_wh as number) ?? 0,
      solarWh: (row.solar_wh as number) ?? 0,
      gridWh: (row.grid_wh as number) ?? 0,
      totalWh: (row.total_wh as number) ?? 0,
      costCents: (row.cost_cents as number) ?? 0,
      solarSavingsCents: (row.solar_savings_cents as number) ?? 0,
    }));
  }

  /** Aggregate home energy readings by day for a given month (local time). */
  async getEnergyStatsMonth(
    year: number,
    month: number,
    tzOffsetHours: number,
  ): Promise<
    Array<{
      bucket: string;
      solarProductionWh: number;
      solarWh: number;
      gridWh: number;
      totalWh: number;
      costCents: number;
      solarSavingsCents: number;
    }>
  > {
    const monthStr = String(month).padStart(2, "0");
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const yearMonth = `${year}-${monthStr}`;
    const rows = await this.db.all<{
      bucket: string;
      solar_production_wh: number;
      solar_wh: number;
      grid_wh: number;
      total_wh: number;
      cost_cents: number;
      solar_savings_cents: number;
    }>(sql`SELECT
              strftime('%d', timestamp, ${offset}) AS bucket,
              SUM(solar_production_w * (60.0 / 3600.0)) AS solar_production_wh,
              SUM(MIN(solar_production_w, home_consumption_w) * (60.0 / 3600.0)) AS solar_wh,
              SUM(MAX(grid_power_w, 0) * (60.0 / 3600.0)) AS grid_wh,
              SUM(home_consumption_w * (60.0 / 3600.0)) AS total_wh,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN MAX(grid_power_w, 0) * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS cost_cents,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN MIN(solar_production_w, home_consumption_w) * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS solar_savings_cents
            FROM energy_readings
            WHERE strftime('%Y-%m', timestamp, ${offset}) = ${yearMonth}
            GROUP BY bucket
            ORDER BY bucket`);
    return rows.map((row) => ({
      bucket: row.bucket as string,
      solarProductionWh: (row.solar_production_wh as number) ?? 0,
      solarWh: (row.solar_wh as number) ?? 0,
      gridWh: (row.grid_wh as number) ?? 0,
      totalWh: (row.total_wh as number) ?? 0,
      costCents: (row.cost_cents as number) ?? 0,
      solarSavingsCents: (row.solar_savings_cents as number) ?? 0,
    }));
  }

  /** Aggregate home energy readings by month for a given year (local time). */
  async getEnergyStatsYear(
    year: number,
    tzOffsetHours: number,
  ): Promise<
    Array<{
      bucket: string;
      solarProductionWh: number;
      solarWh: number;
      gridWh: number;
      totalWh: number;
      costCents: number;
      solarSavingsCents: number;
    }>
  > {
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const yearStr = String(year);
    const rows = await this.db.all<{
      bucket: string;
      solar_production_wh: number;
      solar_wh: number;
      grid_wh: number;
      total_wh: number;
      cost_cents: number;
      solar_savings_cents: number;
    }>(sql`SELECT
              strftime('%m', timestamp, ${offset}) AS bucket,
              SUM(solar_production_w * (60.0 / 3600.0)) AS solar_production_wh,
              SUM(MIN(solar_production_w, home_consumption_w) * (60.0 / 3600.0)) AS solar_wh,
              SUM(MAX(grid_power_w, 0) * (60.0 / 3600.0)) AS grid_wh,
              SUM(home_consumption_w * (60.0 / 3600.0)) AS total_wh,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN MAX(grid_power_w, 0) * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS cost_cents,
              SUM(CASE WHEN rate_per_kwh IS NOT NULL THEN MIN(solar_production_w, home_consumption_w) * (60.0 / 3600.0) / 1000.0 * rate_per_kwh * 100 ELSE 0 END) AS solar_savings_cents
            FROM energy_readings
            WHERE strftime('%Y', timestamp, ${offset}) = ${yearStr}
            GROUP BY bucket
            ORDER BY bucket`);
    return rows.map((row) => ({
      bucket: row.bucket as string,
      solarProductionWh: (row.solar_production_wh as number) ?? 0,
      solarWh: (row.solar_wh as number) ?? 0,
      gridWh: (row.grid_wh as number) ?? 0,
      totalWh: (row.total_wh as number) ?? 0,
      costCents: (row.cost_cents as number) ?? 0,
      solarSavingsCents: (row.solar_savings_cents as number) ?? 0,
    }));
  }

  /** Fine-grained solar production for a day in 15-minute buckets (96 points). */
  async getSolarProductionDay(
    date: string,
    tzOffsetHours: number,
  ): Promise<Array<{ bucket: number; solarProductionWh: number }>> {
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const rows = await this.db.all<{
      bucket: number;
      solar_production_wh: number;
    }>(sql`SELECT
              CAST(strftime('%H', timestamp, ${offset}) AS INTEGER) * 4
                + CAST(strftime('%M', timestamp, ${offset}) AS INTEGER) / 15 AS bucket,
              SUM(solar_production_w * (60.0 / 3600.0)) AS solar_production_wh
            FROM energy_readings
            WHERE date(timestamp, ${offset}) = ${date}
            GROUP BY bucket
            ORDER BY bucket`);
    return rows.map((row) => ({
      bucket: (row.bucket as number) ?? 0,
      solarProductionWh: (row.solar_production_wh as number) ?? 0,
    }));
  }

  /** Fine-grained solar production for a month in 6-hour buckets. */
  async getSolarProductionMonth(
    year: number,
    month: number,
    tzOffsetHours: number,
  ): Promise<
    Array<{ day: number; quarter: number; solarProductionWh: number }>
  > {
    const monthStr = String(month).padStart(2, "0");
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const yearMonth = `${year}-${monthStr}`;
    const rows = await this.db.all<{
      day: number;
      quarter: number;
      solar_production_wh: number;
    }>(sql`SELECT
              CAST(strftime('%d', timestamp, ${offset}) AS INTEGER) AS day,
              CAST(strftime('%H', timestamp, ${offset}) AS INTEGER) / 6 AS quarter,
              SUM(solar_production_w * (60.0 / 3600.0)) AS solar_production_wh
            FROM energy_readings
            WHERE strftime('%Y-%m', timestamp, ${offset}) = ${yearMonth}
            GROUP BY day, quarter
            ORDER BY day, quarter`);
    return rows.map((row) => ({
      day: (row.day as number) ?? 0,
      quarter: (row.quarter as number) ?? 0,
      solarProductionWh: (row.solar_production_wh as number) ?? 0,
    }));
  }

  /** Fine-grained solar production for a year in weekly buckets. */
  async getSolarProductionYear(
    year: number,
    tzOffsetHours: number,
  ): Promise<Array<{ week: number; solarProductionWh: number }>> {
    const offset = sqliteTimezoneOffset(tzOffsetHours);
    const yearStr = String(year);
    const rows = await this.db.all<{
      week: number;
      solar_production_wh: number;
    }>(sql`SELECT
              CAST(strftime('%W', timestamp, ${offset}) AS INTEGER) AS week,
              SUM(solar_production_w * (60.0 / 3600.0)) AS solar_production_wh
            FROM energy_readings
            WHERE strftime('%Y', timestamp, ${offset}) = ${yearStr}
            GROUP BY week
            ORDER BY week`);
    return rows.map((row) => ({
      week: (row.week as number) ?? 0,
      solarProductionWh: (row.solar_production_wh as number) ?? 0,
    }));
  }
}

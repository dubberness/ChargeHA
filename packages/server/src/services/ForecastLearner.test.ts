import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { sql } from "drizzle-orm";
import type { NotificationEventType } from "@chargeha/shared";
import { inSequence } from "@chargeha/shared/async";
import { AppDatabase } from "../db/AppDatabase.ts";
import { Logger } from "../lib/Logger.ts";
import { ForecastLearner, readLearningState } from "./ForecastLearner.ts";

const DAY_MS = 86_400_000;

describe("ForecastLearner", () => {
  let db: AppDatabase;
  let nowMs: number;
  let sent: Array<{ eventType: NotificationEventType; message: string }>;
  let learner: ForecastLearner;

  beforeEach(async () => {
    db = new AppDatabase(":memory:");
    await db.init();
    await db.setConfig("timezone", "UTC");
    await db.setConfig("forecast_provider", "solcast");
    nowMs = Date.parse("2026-09-28T05:00:00Z");
    sent = [];
    learner = new ForecastLearner(
      db,
      {
        notify: (eventType, _title, message) => {
          sent.push({ eventType, message });
          return Promise.resolve();
        },
      },
      new Logger("test", "error"),
      () => nowMs,
    );
  });

  afterEach(() => {
    db.close();
  });

  // A clear day forecast at 4 kW from 02:00 to 03:00 UTC, fetched the day
  // before, and a reading every minute of that hour at `actualW`.
  const day = async (date: string, actualW: number) => {
    const fetchedAt = new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS / 2);
    await db.forecasts.upsertPeriods(
      ["02:00", "02:30"].map((time) => ({
        periodStart: `${date}T${time}:00Z`,
        periodMinutes: 30,
        pvW: 4000,
        pvW10: 3800,
        pvW90: 4100,
        isDayAhead: true,
      })),
      fetchedAt,
    );
    const values = Array.from(
      { length: 60 },
      (_, m) =>
        sql`(${`${date} 02:${
          String(m).padStart(2, "0")
        }:00`}, ${actualW}, 0, 0)`,
    );
    await db.db.run(sql`
      INSERT INTO energy_readings
        (timestamp, solar_production_w, grid_power_w, home_consumption_w)
      VALUES ${sql.join(values, sql`, `)}
    `);
  };

  const history = async (actualWs: number[]) => {
    const first = Date.parse("2026-09-28T00:00:00Z") - actualWs.length * DAY_MS;
    await inSequence(
      actualWs.map((actualW, i) => ({ actualW, i })),
      ({ actualW, i }) =>
        day(new Date(first + i * DAY_MS).toISOString().slice(0, 10), actualW),
    );
  };

  it("learns how the system compares with the forecast", async () => {
    await history(new Array(10).fill(3000));

    await learner.runIfDue();

    const { correction, panelCheck } = await readLearningState(db);
    expect(correction?.days).toBe(10);
    expect(correction?.learnedOn).toBe("2026-09-28");
    expect(correction?.hourFactors[2]).toBeCloseTo(0.76, 2);
    expect(correction?.hourFactors[12]).toBe(1);
    expect(panelCheck?.state).toBe("ok");
    expect(sent).toEqual([]);
  });

  it("keeps learning until there are enough days", async () => {
    await history([3000, 3000, 3000]);

    await learner.runIfDue();

    const { correction, panelCheck } = await readLearningState(db);
    expect(correction?.days).toBe(3);
    expect(correction?.hourFactors[2]).toBe(1);
    expect(panelCheck?.state).toBe("waiting");
  });

  it("runs once a day", async () => {
    await history(new Array(10).fill(3000));
    await learner.runIfDue();
    await db.setConfig(
      "forecast_correction",
      JSON.stringify({
        hourFactors: new Array(24).fill(1),
        days: 99,
        learnedOn: "2026-09-28",
      }),
    );

    await learner.runIfDue();

    expect((await readLearningState(db)).correction?.days).toBe(99);
  });

  it("notifies once when clear days come in well under the usual", async () => {
    await history([...new Array(9).fill(3600), 1800, 1800, 1800]);

    await learner.runIfDue();

    expect((await readLearningState(db)).panelCheck?.state).toBe("low");
    expect(sent).toHaveLength(1);
    expect(sent[0].eventType).toBe("solar_underperforming");
    expect(sent[0].message).toContain("about 50% of its usual output");

    // Still low the next day: no repeat.
    await day("2026-09-28", 1800);
    nowMs += DAY_MS;
    await learner.runIfDue();
    expect((await readLearningState(db)).panelCheck?.state).toBe("low");
    expect(sent).toHaveLength(1);
  });

  it("leaves days with gaps in the readings out", async () => {
    await history(new Array(9).fill(3600));
    // Three clear days with the recorder down for most of the hour.
    await inSequence(
      ["2026-09-28", "2026-09-29", "2026-09-30"],
      async (date) => {
        await day(date, 3600);
        await db.db.run(sql`
        DELETE FROM energy_readings
        WHERE timestamp >= ${`${date} 02:10:00`}
          AND timestamp < ${`${date} 03:00:00`}
      `);
      },
    );
    nowMs = Date.parse("2026-10-01T05:00:00Z");

    await learner.runIfDue();

    const { panelCheck } = await readLearningState(db);
    expect(panelCheck?.state).toBe("ok");
    expect(panelCheck?.recentDays).not.toContain("2026-09-30");
  });

  it("does nothing while the forecast is off", async () => {
    await db.setConfig("forecast_provider", "");
    await history(new Array(10).fill(3000));

    await learner.runIfDue();

    expect((await readLearningState(db)).correction).toBeNull();
  });
});

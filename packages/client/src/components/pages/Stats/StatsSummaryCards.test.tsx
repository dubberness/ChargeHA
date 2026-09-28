import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import type { StatsResponse } from "@chargeha/shared";
import { renderWithProviders } from "../../../test-utils.tsx";
import { forecastDeltaLabel, StatsSummaryCards } from "./StatsSummaryCards.tsx";

describe("StatsSummaryCards solar forecast", () => {
  const baseData: StatsResponse = {
    period: "day",
    startDate: "2026-09-28",
    endDate: "2026-09-28",
    energyBuckets: [],
    homeSolarProductionWh: 12_000,
    homeConsumedWh: 8_000,
    homeSolarWh: 6_000,
    homeGridWh: 2_000,
    homeSelfPoweredPercent: 75,
    solarProductionLine: [],
    buckets: [],
    totalChargedWh: 0,
    totalSolarWh: 0,
    totalGridWh: 0,
    totalAwayWh: 0,
    selfPoweredPercent: 0,
  };

  afterEach(() => {
    cleanup();
  });

  it("shows no forecast cards without a forecast", () => {
    renderWithProviders(<StatsSummaryCards data={baseData} loading={false} />);
    expect(screen.queryByText("Solar Forecast")).not.toBeInTheDocument();
  });

  it("shows the forecast and how production compared", () => {
    renderWithProviders(
      <StatsSummaryCards
        data={{
          ...baseData,
          forecastSolarWh: 15_000,
          forecastComparison: { forecastWh: 10_000, actualWh: 12_000 },
        }}
        loading={false}
      />,
    );
    expect(screen.getByText("Solar Forecast")).toBeInTheDocument();
    expect(screen.getByText("15.0 kWh")).toBeInTheDocument();
    expect(screen.getByText("Actual vs Forecast")).toBeInTheDocument();
    expect(screen.getByText("+20%")).toBeInTheDocument();
  });

  it("skips the comparison until an hour of forecast has passed", () => {
    renderWithProviders(
      <StatsSummaryCards
        data={{ ...baseData, forecastSolarWh: 15_000 }}
        loading={false}
      />,
    );
    expect(screen.queryByText("Actual vs Forecast")).not.toBeInTheDocument();
  });

  describe("forecastDeltaLabel", () => {
    it("signs the difference", () => {
      expect(forecastDeltaLabel({ forecastWh: 10_000, actualWh: 8_500 }))
        .toBe("-15%");
      expect(forecastDeltaLabel({ forecastWh: 10_000, actualWh: 10_000 }))
        .toBe("0%");
    });

    it("has nothing to say about a zero forecast", () => {
      expect(forecastDeltaLabel({ forecastWh: 0, actualWh: 100 })).toBe("—");
    });
  });
});

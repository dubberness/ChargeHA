import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import type { SolarForecastSummary } from "@chargeha/shared/solarForecast";
import { renderWithProviders } from "../../../test-utils.tsx";
import {
  ForecastTooltip,
  SolarForecastCard,
  toChartPoints,
  trackingLabel,
} from "./SolarForecastCard.tsx";
import { trpc } from "../../../trpc.ts";

vi.mock("../../../trpc.ts", () => ({
  widenTrpc: vi.fn(),
  trpc: {
    forecast: { summary: { useQuery: vi.fn() } },
    config: {
      system: {
        get: {
          useQuery: vi.fn(() => ({ data: { timezone: "Australia/Brisbane" } })),
        },
      },
    },
  },
}));

// Recharts needs real layout; the chart itself is not under test here.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: () => <div data-testid="forecast-chart" />,
}));

describe("SolarForecastCard", () => {
  const day = (date: string, forecastWh: number) => ({
    date,
    forecastWh,
    forecastWh10: forecastWh * 0.5,
    forecastWh90: forecastWh * 1.2,
    actualWh: null,
  });

  const summary: SolarForecastSummary = {
    today: {
      ...day("2026-09-28", 20_000),
      actualWh: 9_000,
      forecastToNowWh: 10_000,
      actualToNowWh: 9_000,
      remainingWh: 10_000,
    },
    days: [
      { ...day("2026-09-28", 20_000), actualWh: 9_000 },
      day("2026-09-29", 25_000),
      day("2026-09-30", 5_000),
    ],
    periods: [{
      periodStart: "2026-09-28T02:00:00.000Z",
      periodMinutes: 30,
      pvW: 3000,
      pvW10: 2000,
      pvW90: 4000,
      actualW: 2500,
    }],
    updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    adjusted: false,
    panelLow: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing without a forecast", () => {
    vi.mocked(trpc.forecast.summary.useQuery).mockReturnValue(
      { data: null } as never,
    );
    renderWithProviders(<SolarForecastCard />);
    expect(screen.queryByText("Solar Forecast")).not.toBeInTheDocument();
  });

  it("shows today, tomorrow and the days ahead", () => {
    vi.mocked(trpc.forecast.summary.useQuery).mockReturnValue(
      { data: summary } as never,
    );
    renderWithProviders(<SolarForecastCard />);

    expect(screen.getByText("Forecast Today")).toBeInTheDocument();
    expect(screen.getByText("20.0 kWh")).toBeInTheDocument();
    expect(screen.getByText("Likely 10.0–24.0 kWh")).toBeInTheDocument();
    expect(screen.getByText("-10% vs forecast so far")).toBeInTheDocument();
    expect(screen.getByText("Forecast Tomorrow")).toBeInTheDocument();
    expect(screen.getByLabelText("Daily forecast")).toHaveTextContent("Today");
    expect(screen.getByText("Forecast updated 12m ago")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says when the forecast is adjusted to the system", () => {
    vi.mocked(trpc.forecast.summary.useQuery).mockReturnValue(
      { data: { ...summary, adjusted: true } } as never,
    );
    renderWithProviders(<SolarForecastCard />);

    expect(
      screen.getByText("Forecast updated 12m ago · adjusted to your system"),
    ).toBeInTheDocument();
  });

  it("warns when the panels are making less than usual", () => {
    vi.mocked(trpc.forecast.summary.useQuery).mockReturnValue(
      { data: { ...summary, panelLow: { recentShare: 0.62 } } } as never,
    );
    renderWithProviders(<SolarForecastCard />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "about 62% of its usual output",
    );
  });

  describe("ForecastTooltip", () => {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
    });
    const point = toChartPoints(summary)[0];

    it("lists actual, forecast and range for a past period", () => {
      renderWithProviders(
        <ForecastTooltip
          format={format}
          active
          payload={[{ payload: point }]}
        />,
      );
      expect(screen.getByText("2:00 AM")).toBeInTheDocument();
      expect(screen.getByText("2.5 kW")).toBeInTheDocument();
      expect(screen.getByText("3 kW")).toBeInTheDocument();
      expect(screen.getByText("2–4 kW")).toBeInTheDocument();
    });

    it("leaves out actual for a period still to come", () => {
      renderWithProviders(
        <ForecastTooltip
          format={format}
          active
          payload={[{ payload: { ...point, actualKw: null } }]}
        />,
      );
      expect(screen.queryByText("Actual")).not.toBeInTheDocument();
    });
  });

  describe("trackingLabel", () => {
    it("compares production with the forecast so far", () => {
      expect(trackingLabel(11_000, 10_000)).toBe("+10% vs forecast so far");
      expect(trackingLabel(10_000, 10_000)).toBe("On forecast so far");
    });

    it("says nothing before the day has really started", () => {
      expect(trackingLabel(20, 50)).toBeNull();
    });
  });

  describe("toChartPoints", () => {
    it("converts watts to kilowatts", () => {
      expect(toChartPoints(summary)).toEqual([{
        t: Date.parse("2026-09-28T02:00:00.000Z"),
        forecastKw: 3,
        rangeKw: [2, 4],
        actualKw: 2.5,
      }]);
    });
  });
});

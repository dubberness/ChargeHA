import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { SolarForecastStatus } from "@chargeha/shared/solarForecast";
import type { SectionProps, SettingsRowProps } from "./SettingsLayout.tsx";
import { renderWithProviders } from "../../../test-utils.tsx";
import {
  adjustedHours,
  correctionLine,
  formatSite,
  hourLabel,
  panelCheckLine,
  SolarForecastSettings,
  statusLine,
} from "./SolarForecastSettings.tsx";
import { trpc } from "../../../trpc.ts";

const h = vi.hoisted(() => ({
  saveMutate: vi.fn(),
  testMutate: vi.fn(),
  refreshMutate: vi.fn(),
  sendSummaryMutate: vi.fn(),
  testData: undefined as unknown,
}));

vi.mock("../../../trpc.ts", () => ({
  widenTrpc: vi.fn(),
  trpc: {
    forecast: {
      status: { useQuery: vi.fn() },
      saveSettings: {
        useMutation: vi.fn(() => ({ mutate: h.saveMutate, isPending: false })),
      },
      testKey: {
        useMutation: vi.fn(() => ({
          mutate: h.testMutate,
          reset: vi.fn(),
          isPending: false,
          data: h.testData,
        })),
      },
      refresh: {
        useMutation: vi.fn(() => ({
          mutate: h.refreshMutate,
          isPending: false,
          data: undefined,
        })),
      },
      sendSummary: {
        useMutation: vi.fn(() => ({
          mutate: h.sendSummaryMutate,
          isPending: false,
          isSuccess: false,
        })),
      },
    },
    useUtils: vi.fn(() => ({
      forecast: { invalidate: vi.fn(), status: { fetch: vi.fn() } },
      stats: { invalidate: vi.fn() },
    })),
  },
}));

vi.mock("./SettingsLayout.tsx", () => ({
  SettingsSection: (
    { children, title, isDirty, onSave }: SectionProps,
  ) => (
    <div>
      <h3>{title}</h3>
      {isDirty && onSave && (
        <button type="button" onClick={onSave}>Save</button>
      )}
      {children}
    </div>
  ),
  SettingsRow: ({ children, label, help }: SettingsRowProps) => (
    <div>
      <label>{label}</label>
      {help && <span>{help}</span>}
      {children}
    </div>
  ),
  NumberInput: (
    { value, onChange }: { value: string; onChange: (v: string) => void },
  ) => (
    <input
      aria-label="Daily request limit"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

describe("SolarForecastSettings", () => {
  const status = (
    overrides: Partial<SolarForecastStatus> = {},
  ): SolarForecastStatus => ({
    provider: "solcast",
    baseUrl: "",
    apiKeySet: true,
    siteIds: [],
    dailyLimit: 10,
    usedToday: 3,
    lastFetchAt: null,
    lastError: null,
    nextFetchAt: null,
    adjust: true,
    summaryTime: "20:00",
    correction: null,
    panelCheck: null,
    ...overrides,
  });

  const factors = (overrides: Record<number, number>) =>
    Array.from({ length: 24 }, (_, h) => overrides[h] ?? 1);

  const withStatus = (value: SolarForecastStatus) =>
    vi.mocked(trpc.forecast.status.useQuery).mockReturnValue(
      { data: value } as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    h.testData = undefined;
    globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows only the provider picker while disabled", () => {
    withStatus(status({ provider: null, apiKeySet: false }));
    renderWithProviders(<SolarForecastSettings />);

    expect(screen.getByText("Solar Forecast")).toBeInTheDocument();
    expect(screen.queryByText("API key")).not.toBeInTheDocument();
  });

  it("asks for a key when none is saved", () => {
    withStatus(status({ apiKeySet: false }));
    renderWithProviders(<SolarForecastSettings />);

    expect(screen.getByLabelText("Solcast API key")).toBeInTheDocument();
    expect(screen.queryByText("Update now")).not.toBeInTheDocument();
  });

  it("tests a typed key", () => {
    withStatus(status({ apiKeySet: false }));
    renderWithProviders(<SolarForecastSettings />);

    fireEvent.change(screen.getByLabelText("Solcast API key"), {
      target: { value: " abc " },
    });
    fireEvent.click(screen.getByText("Test Key"));

    expect(h.testMutate).toHaveBeenCalledWith({
      apiKey: "abc",
      provider: "solcast",
    });
  });

  it("lists the sites a passing test found", () => {
    h.testData = {
      success: true,
      sites: [{ id: "a", name: "Home", capacityKw: 6 }],
    };
    withStatus(status({ apiKeySet: false }));
    renderWithProviders(<SolarForecastSettings />);

    expect(screen.getByText(/Found Home \(6 kW\)/)).toBeInTheDocument();
  });

  it("shows why a test failed", () => {
    h.testData = { success: false, error: "Solcast rejected the API key" };
    withStatus(status({ apiKeySet: false }));
    renderWithProviders(<SolarForecastSettings />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Solcast rejected the API key",
    );
  });

  it("hides a saved key behind Replace", () => {
    withStatus(status());
    renderWithProviders(<SolarForecastSettings />);

    expect(screen.queryByLabelText("Solcast API key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Replace"));
    expect(screen.getByLabelText("Solcast API key")).toBeInTheDocument();
  });

  it("saves changed settings", () => {
    withStatus(status());
    renderWithProviders(<SolarForecastSettings />);

    fireEvent.change(screen.getByLabelText("Site IDs"), {
      target: { value: "abcd-1234 " },
    });
    fireEvent.change(screen.getByLabelText("Daily request limit"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(h.saveMutate).toHaveBeenCalledWith({
      forecastProvider: "solcast",
      forecastSiteIds: "abcd-1234",
      forecastDailyLimit: 50,
      forecastAdjust: true,
      forecastSummaryTime: "20:00",
    });
  });

  describe("Home Assistant", () => {
    const haStatus = (overrides: Partial<SolarForecastStatus> = {}) =>
      status({
        provider: "homeassistant",
        baseUrl: "http://ha.local:8123",
        ...overrides,
      });

    it("asks for an address and token instead of sites and a limit", () => {
      withStatus(haStatus({ apiKeySet: false }));
      renderWithProviders(<SolarForecastSettings />);

      expect(screen.getByLabelText("Home Assistant address")).toHaveValue(
        "http://ha.local:8123",
      );
      expect(screen.getByLabelText("Home Assistant access token"))
        .toBeInTheDocument();
      expect(screen.queryByLabelText("Site IDs")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Daily request limit")).not
        .toBeInTheDocument();
    });

    it("tests the typed address with the token", () => {
      withStatus(haStatus({ apiKeySet: false, baseUrl: "" }));
      renderWithProviders(<SolarForecastSettings />);

      fireEvent.change(screen.getByLabelText("Home Assistant address"), {
        target: { value: " http://10.0.0.5:8123 " },
      });
      fireEvent.change(screen.getByLabelText("Home Assistant access token"), {
        target: { value: "tok" },
      });
      fireEvent.click(screen.getByText("Test"));

      expect(h.testMutate).toHaveBeenCalledWith({
        apiKey: "tok",
        provider: "homeassistant",
        baseUrl: "http://10.0.0.5:8123",
      });
    });

    it("saves the address", () => {
      withStatus(haStatus());
      renderWithProviders(<SolarForecastSettings />);

      fireEvent.change(screen.getByLabelText("Home Assistant address"), {
        target: { value: "http://10.0.0.5:8123/" },
      });
      fireEvent.click(screen.getByText("Save"));

      expect(h.saveMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          forecastProvider: "homeassistant",
          forecastBaseUrl: "http://10.0.0.5:8123/",
        }),
      );
    });

    it("leaves the request count out of the status line", () => {
      expect(statusLine(haStatus({ usedToday: 0 }))).toBe("Not updated yet");
    });

    it("keeps Update now available whatever the stored limit", () => {
      withStatus(haStatus({ dailyLimit: 1, usedToday: 0 }));
      renderWithProviders(<SolarForecastSettings />);

      expect(screen.getByText("Update now").closest("button")).not
        .toBeDisabled();
    });
  });

  it("saves the evening summary time and sends one on demand", () => {
    withStatus(status());
    renderWithProviders(<SolarForecastSettings />);

    fireEvent.change(screen.getByLabelText("Evening summary time"), {
      target: { value: "19:30" },
    });
    fireEvent.click(screen.getByText("Send now"));
    fireEvent.click(screen.getByText("Save"));

    expect(h.sendSummaryMutate).toHaveBeenCalled();
    expect(h.saveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ forecastSummaryTime: "19:30" }),
    );
  });

  it("saves turning the adjustment off", () => {
    withStatus(status());
    renderWithProviders(<SolarForecastSettings />);

    fireEvent.click(screen.getByLabelText("Adjust to my system"));
    fireEvent.click(screen.getByText("Save"));

    expect(h.saveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ forecastAdjust: false }),
    );
  });

  it("lists the hours the learned correction moves", () => {
    withStatus(status({
      correction: {
        hourFactors: factors({ 7: 0.7, 12: 1.06 }),
        days: 21,
        learnedOn: "2026-09-28",
      },
    }));
    renderWithProviders(<SolarForecastSettings />);

    expect(screen.getByText("Learned from 21 days:")).toBeInTheDocument();
    expect(screen.getByText("7 am −30%")).toBeInTheDocument();
    expect(screen.getByText("12 pm +6%")).toBeInTheDocument();
  });

  it("shows the system check result", () => {
    withStatus(status({
      panelCheck: {
        state: "low",
        recentShare: 0.62,
        recentDays: ["2026-09-25", "2026-09-26", "2026-09-27"],
        checkedOn: "2026-09-28",
      },
    }));
    renderWithProviders(<SolarForecastSettings />);

    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText(/recent clear days at 62% of usual/))
      .toBeInTheDocument();
  });

  it("will not save a limit that is not a whole number", () => {
    withStatus(status());
    renderWithProviders(<SolarForecastSettings />);

    fireEvent.change(screen.getByLabelText("Daily request limit"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(h.saveMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("updates on demand while requests remain", () => {
    withStatus(status());
    renderWithProviders(<SolarForecastSettings />);

    fireEvent.click(screen.getByText("Update now"));

    expect(h.refreshMutate).toHaveBeenCalled();
  });

  it("blocks updating once the day's requests are used", () => {
    withStatus(status({ usedToday: 10 }));
    renderWithProviders(<SolarForecastSettings />);

    expect(screen.getByText("Update now").closest("button")).toBeDisabled();
  });

  it("shows the last update's error", () => {
    withStatus(status({ lastError: "Solcast is busy" }));
    renderWithProviders(<SolarForecastSettings />);

    expect(screen.getByRole("alert")).toHaveTextContent("Solcast is busy");
  });

  describe("statusLine", () => {
    it("says when it has not updated yet", () => {
      expect(statusLine(status())).toBe(
        "Not updated yet · 3 of 10 requests used today",
      );
    });

    it("includes the next update when it is in the future", () => {
      const line = statusLine(
        status({
          lastFetchAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          nextFetchAt: "2099-01-01T03:30:00Z",
        }),
      );
      expect(line).toMatch(/^Updated 5m ago · next at .+ · 3 of 10/);
    });
  });

  describe("learning labels", () => {
    it("names hours on a 12-hour clock", () => {
      expect([0, 7, 12, 17].map(hourLabel))
        .toEqual(["12 am", "7 am", "12 pm", "5 pm"]);
    });

    it("leaves out hours moved by less than 5%", () => {
      const correction = {
        hourFactors: factors({ 8: 0.97, 9: 1.2 }),
        days: 10,
        learnedOn: "2026-09-28",
      };
      expect(adjustedHours(correction)).toEqual(["9 am +20%"]);
    });

    it("counts the days while still learning", () => {
      expect(correctionLine({
        hourFactors: factors({}),
        days: 3,
        learnedOn: "2026-09-28",
      })).toBe("Learning — 3 of 7 days so far.");
      expect(correctionLine(null)).toMatch(/first full day/);
    });

    it("waits until there are clear days to compare", () => {
      expect(panelCheckLine(null)).toMatch(/^Waiting/);
    });
  });

  describe("formatSite", () => {
    it("adds the capacity when known", () => {
      expect(formatSite({ id: "a", name: "Home", capacityKw: 6 }))
        .toBe("Home (6 kW)");
      expect(formatSite({ id: "a", name: "Home", capacityKw: null }))
        .toBe("Home");
    });
  });
});

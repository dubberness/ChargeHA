import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  HomeAssistantProvider,
  normaliseBaseUrl,
  toForecastPeriods,
} from "./HomeAssistantProvider.ts";
import { ForecastAuthError } from "./types.ts";

describe("HomeAssistantProvider", () => {
  const NOW_MS = Date.parse("2026-10-01T02:10:00Z");
  const options = { baseUrl: "http://ha.local:8123/" };

  // Answers each request in turn with [status, body].
  const respond = (...answers: Array<[number, unknown]>) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
      const [status, body] =
        answers[Math.min(calls.length, answers.length - 1)];
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    return {
      calls,
      provider: new HomeAssistantProvider(
        fetchFn as typeof fetch,
        () => NOW_MS,
      ),
    };
  };

  const services = [
    { domain: "light", services: { turn_on: {} } },
    { domain: "solcast_solar", services: { query_forecast_data: {} } },
  ];

  describe("normaliseBaseUrl", () => {
    it("drops trailing slashes and assumes http", () => {
      expect(normaliseBaseUrl(" http://ha.local:8123/ ")).toBe(
        "http://ha.local:8123",
      );
      expect(normaliseBaseUrl("192.168.1.5")).toBe("http://192.168.1.5");
      expect(normaliseBaseUrl("https://ha.example.com")).toBe(
        "https://ha.example.com",
      );
    });

    it("needs an address", () => {
      expect(() => normaliseBaseUrl("  ")).toThrow("Enter Home Assistant");
      expect(() => normaliseBaseUrl(undefined)).toThrow();
    });
  });

  describe("toForecastPeriods", () => {
    it("converts kW to W and reads the period length from the gaps", () => {
      expect(toForecastPeriods([
        {
          period_start: "2026-10-01T12:00:00+10:00",
          pv_estimate: 3.2,
          pv_estimate10: 1.5,
          pv_estimate90: 4.1,
        },
        { period_start: "2026-10-01T12:30:00+10:00", pv_estimate: 2 },
      ])).toEqual([
        {
          periodStart: "2026-10-01T02:00:00.000Z",
          periodMinutes: 30,
          pvW: 3200,
          pvW10: 1500,
          pvW90: 4100,
        },
        {
          periodStart: "2026-10-01T02:30:00.000Z",
          periodMinutes: 30,
          pvW: 2000,
          pvW10: 2000,
          pvW90: 2000,
        },
      ]);
    });

    it("rejects a time it cannot read", () => {
      expect(() =>
        toForecastPeriods([{ period_start: "soon", pv_estimate: 1 }])
      )
        .toThrow("Unexpected forecast time");
    });
  });

  describe("listSites", () => {
    it("finds the Solcast integration and sends the token as a bearer", async () => {
      const { calls, provider } = respond([200, services]);

      expect(await provider.listSites("tok", options)).toEqual([
        { id: "all", name: "Solcast via Home Assistant", capacityKw: null },
      ]);
      expect(calls[0].url).toBe("http://ha.local:8123/api/services");
      expect(new Headers(calls[0].init?.headers).get("Authorization"))
        .toBe("Bearer tok");
    });

    it("says when the Solcast integration is missing", async () => {
      const { provider } = respond([200, [services[0]]]);
      await expect(provider.listSites("tok", options)).rejects.toThrow(
        "no Solcast integration",
      );
    });

    it("reports a rejected token", async () => {
      const { provider } = respond([401, {}]);
      await expect(provider.listSites("tok", options)).rejects.toBeInstanceOf(
        ForecastAuthError,
      );
    });

    it("needs an address before it calls anything", async () => {
      const { calls, provider } = respond([200, services]);
      await expect(provider.listSites("tok", {})).rejects.toThrow(
        "Enter Home Assistant",
      );
      expect(calls).toEqual([]);
    });
  });

  describe("fetchForecast", () => {
    const data = [
      { period_start: "2026-10-01T12:00:00+10:00", pv_estimate: 1 },
      { period_start: "2026-10-01T12:30:00+10:00", pv_estimate: 2 },
    ];

    it("asks the integration for the days ahead from this half hour", async () => {
      const { calls, provider } = respond([
        200,
        { service_response: { data } },
      ]);

      const periods = await provider.fetchForecast("tok", "all", options);

      expect(periods.map((p) => p.pvW)).toEqual([1000, 2000]);
      expect(calls[0].url).toBe(
        "http://ha.local:8123/api/services/solcast_solar/query_forecast_data?return_response",
      );
      expect(calls[0].init?.method).toBe("POST");
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({
        start_date_time: "2026-10-01T02:00:00.000Z",
        end_date_time: "2026-10-07T02:00:00.000Z",
      });
    });

    it("asks for a shorter range when the long one is refused", async () => {
      const { calls, provider } = respond(
        [400, { message: "Range is invalid" }],
        [200, { service_response: { data } }],
      );

      expect(await provider.fetchForecast("tok", "all", options))
        .toHaveLength(2);
      expect(JSON.parse(String(calls[1].init?.body)).end_date_time).toBe(
        "2026-10-03T02:00:00.000Z",
      );
    });

    it("says when the integration has no forecast yet", async () => {
      const { provider } = respond([400, { message: "Range is invalid" }]);
      await expect(provider.fetchForecast("tok", "all", options)).rejects
        .toThrow("no forecast to give yet (Range is invalid)");
    });

    it("reports other failures with their status", async () => {
      const { provider } = respond([500, {}]);
      await expect(provider.fetchForecast("tok", "all", options)).rejects
        .toThrow("HTTP 500");
    });
  });
});

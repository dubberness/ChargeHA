import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  parsePeriodMinutes,
  SolcastProvider,
  toForecastPeriod,
} from "./SolcastProvider.ts";
import { ForecastAuthError, ForecastQuotaError } from "./types.ts";

describe("SolcastProvider", () => {
  const respond = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    return { calls, provider: new SolcastProvider(fetchFn as typeof fetch) };
  };

  describe("parsePeriodMinutes", () => {
    it("reads ISO 8601 durations", () => {
      expect(parsePeriodMinutes("PT30M")).toBe(30);
      expect(parsePeriodMinutes("PT1H")).toBe(60);
      expect(parsePeriodMinutes("PT1H30M")).toBe(90);
    });

    it("rejects anything else", () => {
      expect(() => parsePeriodMinutes("P1D")).toThrow();
      expect(() => parsePeriodMinutes("PT")).toThrow();
    });
  });

  describe("toForecastPeriod", () => {
    it("keys the period by its start and converts kW to W", () => {
      expect(toForecastPeriod({
        period_end: "2026-09-28T02:30:00.0000000Z",
        period: "PT30M",
        pv_estimate: 3.2,
        pv_estimate10: 1.5,
        pv_estimate90: 4.1,
      })).toEqual({
        periodStart: "2026-09-28T02:00:00.000Z",
        periodMinutes: 30,
        pvW: 3200,
        pvW10: 1500,
        pvW90: 4100,
      });
    });

    it("uses the median when a percentile is missing", () => {
      const p = toForecastPeriod({
        period_end: "2026-09-28T02:30:00Z",
        period: "PT30M",
        pv_estimate: 2,
      });
      expect([p.pvW10, p.pvW90]).toEqual([2000, 2000]);
    });
  });

  describe("listSites", () => {
    it("maps rooftop sites and sends the key as a bearer token", async () => {
      const { calls, provider } = respond(200, {
        sites: [{ resource_id: "abcd-1234", name: "Home", capacity: 6 }],
      });
      expect(await provider.listSites("key-1")).toEqual([
        { id: "abcd-1234", name: "Home", capacityKw: 6 },
      ]);
      expect(calls[0].url).toBe(
        "https://api.solcast.com.au/rooftop_sites?format=json",
      );
      expect(new Headers(calls[0].init?.headers).get("Authorization"))
        .toBe("Bearer key-1");
    });
  });

  describe("fetchForecast", () => {
    it("asks for seven days of the site's forecast", async () => {
      const { calls, provider } = respond(200, {
        forecasts: [{
          period_end: "2026-09-28T02:30:00.0000000Z",
          period: "PT30M",
          pv_estimate: 1,
          pv_estimate10: 0.5,
          pv_estimate90: 1.5,
        }],
      });
      const periods = await provider.fetchForecast("key-1", "abcd-1234");
      expect(periods).toHaveLength(1);
      expect(calls[0].url).toBe(
        "https://api.solcast.com.au/rooftop_sites/abcd-1234/forecasts?format=json&hours=168",
      );
      expect(calls[0].url).not.toContain("key-1");
    });

    it("reports a rejected key", async () => {
      const { provider } = respond(401, {});
      await expect(provider.fetchForecast("bad", "site"))
        .rejects.toBeInstanceOf(ForecastAuthError);
    });

    it("recognises the daily limit", async () => {
      const { provider } = respond(429, {
        response_status: {
          error_code: "TooManyRequests",
          message: "You have exceeded your free daily limit.",
        },
      });
      const error = await provider.fetchForecast("key", "site").catch((e) => e);
      expect(error).toBeInstanceOf(ForecastQuotaError);
      expect(error.message).toBe("You have exceeded your free daily limit.");
    });

    it("treats a bare 429 as busy, not the daily limit", async () => {
      const { provider } = respond(429, {});
      const error = await provider.fetchForecast("key", "site").catch((e) => e);
      expect(error).not.toBeInstanceOf(ForecastQuotaError);
      expect(error.message).toContain("busy");
    });

    it("explains an unknown site", async () => {
      const { provider } = respond(404, {});
      await expect(provider.fetchForecast("key", "nope"))
        .rejects.toThrow("site not found");
    });

    it("wraps network failures", async () => {
      const provider = new SolcastProvider(
        (() => Promise.reject(new TypeError("dns failed"))) as typeof fetch,
      );
      await expect(provider.fetchForecast("key", "site"))
        .rejects.toThrow("Could not reach Solcast: dns failed");
    });
  });
});

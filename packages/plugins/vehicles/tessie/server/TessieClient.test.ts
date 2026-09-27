import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Logger } from "@chargeha/server/lib/Logger";
import { PluginDbLogger } from "@chargeha/server/lib/PluginDbLogger";
import {
  TESSIE_API_BASE,
  TessieApiError,
  TessieClient,
  TessieConnectionError,
} from "./TessieClient.ts";

interface Call {
  url: URL;
  method: string;
  auth: string | null;
}

describe("TessieClient", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const logger = new Logger("TessieClient", "error");
  const ctx = { origin: "test", traceId: "trace" };

  let calls: Call[];
  let respond: (call: Call) => Response;
  let dbEntries: { level: string; payload: string | null }[];
  let token: string | null;
  let client: TessieClient;

  beforeEach(() => {
    calls = [];
    respond = () => jsonResponse({});
    dbEntries = [];
    token = "stored-token";
    const fetch = (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        auth: headers.get("Authorization"),
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    };
    client = new TessieClient(
      () => Promise.resolve(token),
      logger,
      new PluginDbLogger((entry) => {
        dbEntries.push(entry);
        return Promise.resolve();
      }, logger),
      { fetch: fetch as typeof globalThis.fetch },
    );
  });

  describe("requests", () => {
    it("sends the stored token as a bearer header to api.tessie.com", async () => {
      respond = () => jsonResponse({ status: "awake" });
      await client.getStatus("VIN1", ctx);
      expect(calls[0].url.origin).toBe(new URL(TESSIE_API_BASE).origin);
      expect(calls[0].url.pathname).toBe("/VIN1/status");
      expect(calls[0].auth).toBe("Bearer stored-token");
    });

    it("never writes the token to the request log", async () => {
      respond = () => jsonResponse({ status: "awake" });
      await client.getStatus("VIN1", ctx);
      expect(dbEntries.length).toBe(1);
      expect(JSON.stringify(dbEntries)).not.toContain("stored-token");
    });

    it("throws without calling Tessie when no token is stored", async () => {
      token = null;
      await expect(client.getStatus("VIN1", ctx)).rejects.toThrow(
        TessieApiError,
      );
      expect(calls.length).toBe(0);
    });

    it("wraps network failures in a TessieConnectionError", async () => {
      respond = () => {
        throw new TypeError("network down");
      };
      await expect(client.getState("VIN1", ctx)).rejects.toThrow(
        TessieConnectionError,
      );
    });

    it("uses Tessie's error message when the body has one", async () => {
      respond = () => jsonResponse({ error: "Vehicle is in service" }, 400);
      await expect(client.getState("VIN1", ctx)).rejects.toThrow(
        "Vehicle is in service",
      );
    });
  });

  describe("listVehicles", () => {
    it("asks for active vehicles only and maps names", async () => {
      respond = () =>
        jsonResponse({
          results: [
            { vin: "VIN1", display_name: "Red Car" },
            { vin: "VIN2", last_state: { display_name: "Blue Car" } },
            {
              vin: "VIN3",
              last_state: { vehicle_state: { vehicle_name: "V" } },
            },
            { vin: "VIN4" },
          ],
        });
      const vehicles = await client.listVehicles(ctx);
      expect(calls[0].url.pathname).toBe("/vehicles");
      expect(calls[0].url.searchParams.get("only_active")).toBe("true");
      expect(vehicles).toEqual([
        { vin: "VIN1", name: "Red Car" },
        { vin: "VIN2", name: "Blue Car" },
        { vin: "VIN3", name: "V" },
        { vin: "VIN4", name: "Tesla" },
      ]);
    });

    it("uses a candidate token instead of the stored one", async () => {
      respond = () => jsonResponse({ results: [] });
      await client.listVehicles(ctx, "candidate");
      expect(calls[0].auth).toBe("Bearer candidate");
    });
  });

  describe("command", () => {
    it("posts to the command path with params and waits for completion", async () => {
      respond = () => jsonResponse({ result: true });
      const ok = await client.command(
        "VIN1",
        "set_charging_amps",
        { amps: "8" },
        ctx,
      );
      expect(ok).toBe(true);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url.pathname).toBe("/VIN1/command/set_charging_amps");
      expect(calls[0].url.searchParams.get("amps")).toBe("8");
      expect(calls[0].url.searchParams.get("wait_for_completion")).toBe("true");
    });

    it("returns false and logs a warning when the car refuses", async () => {
      respond = () => jsonResponse({ result: false, reason: "busy" });
      const ok = await client.command("VIN1", "start_charging", {}, ctx);
      expect(ok).toBe(false);
      expect(dbEntries.some((e) => e.level === "warn")).toBe(true);
    });
  });

  describe("wake", () => {
    it("reports Tessie's result", async () => {
      respond = () => jsonResponse({ result: true });
      expect(await client.wake("VIN1", ctx)).toBe(true);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url.pathname).toBe("/VIN1/wake");
    });
  });

  describe("lastAuthRejected", () => {
    it("is set by a 401 and cleared by the next success", async () => {
      respond = () => jsonResponse({}, 401);
      await expect(client.getStatus("VIN1", ctx)).rejects.toThrow(
        "rejected the API token",
      );
      expect(client.lastAuthRejected).toBe(true);

      respond = () => jsonResponse({ status: "awake" });
      await client.getStatus("VIN1", ctx);
      expect(client.lastAuthRejected).toBe(false);
    });

    it("is not touched by testing a candidate token", async () => {
      respond = () => jsonResponse({}, 401);
      await expect(client.listVehicles(ctx, "bad")).rejects.toThrow();
      expect(client.lastAuthRejected).toBe(false);
    });
  });
});

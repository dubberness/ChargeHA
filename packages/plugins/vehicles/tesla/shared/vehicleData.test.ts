import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { toAdapterChargeState } from "./vehicleData.ts";

describe("toAdapterChargeState", () => {
  const NOW = Date.parse("2026-09-28T00:36:48.000Z");
  const lastUpdated = (timestamp?: number) =>
    toAdapterChargeState("VIN", { charge_state: { timestamp } }, 5)
      .lastUpdated;

  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime(NOW);
  });

  afterEach(() => {
    time.restore();
  });

  it("keeps the time the car took the reading", () => {
    expect(lastUpdated(NOW - 5 * 3_600_000))
      .toBe("2026-09-27T19:36:48.000Z");
  });

  it("uses now when the reading has no time", () => {
    expect(lastUpdated()).toBe("2026-09-28T00:36:48.000Z");
  });

  it("never dates a reading later than now", () => {
    expect(lastUpdated(NOW + 60_000)).toBe("2026-09-28T00:36:48.000Z");
  });
});

describe("toAdapterChargeState — climate", () => {
  const conditioning = (data: Parameters<typeof toAdapterChargeState>[1]) =>
    toAdapterChargeState("VIN", data, 5).isConditioning;
  const charging = { charging_state: "Charging", charge_amps: 5 };

  it("is conditioning while a departure preheat runs", () => {
    expect(conditioning({
      charge_state: charging,
      climate_state: { is_climate_on: true, is_preconditioning: true },
    })).toBe(true);
  });

  it("is conditioning while the battery heater runs", () => {
    expect(conditioning({
      charge_state: { ...charging, battery_heater_on: true },
      climate_state: { is_climate_on: false },
    })).toBe(true);
  });

  it("is conditioning while cabin overheat protection cools", () => {
    expect(conditioning({
      charge_state: charging,
      climate_state: { cabin_overheat_protection_actively_cooling: true },
    })).toBe(true);
  });

  it("is not conditioning with climate off, as Tessie reports it idle", () => {
    expect(conditioning({
      charge_state: { ...charging, battery_heater_on: false },
      climate_state: {
        is_climate_on: false,
        is_preconditioning: false,
        battery_heater: false,
        cabin_overheat_protection_actively_cooling: false,
      },
    })).toBe(false);
  });

  it("is not conditioning when the reading has no climate", () => {
    expect(conditioning({ charge_state: charging })).toBe(false);
  });
});

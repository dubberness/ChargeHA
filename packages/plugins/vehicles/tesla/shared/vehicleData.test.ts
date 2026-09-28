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

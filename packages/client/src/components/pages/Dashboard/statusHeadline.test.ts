import { describe, expect, it } from "vitest";
import { type HeadlinePoint, statusHeadline } from "./statusHeadline.ts";

describe("statusHeadline", () => {
  const point = (
    overrides: Partial<HeadlinePoint> = {},
    state: Partial<NonNullable<HeadlinePoint["state"]>> | null = {},
  ): HeadlinePoint => ({
    id: "cp-1",
    name: "Model 3",
    mode: "auto",
    priority: 1,
    state: state === null
      ? null
      : { isCharging: false, isPluggedIn: true, chargePowerKw: 0, ...state },
    ...overrides,
  });
  const charging = (overrides: Partial<HeadlinePoint> = {}, kw = 2) =>
    point(overrides, { isCharging: true, chargePowerKw: kw });
  const realtime = { solarProductionW: 3500, gridPowerW: -700 };

  it("says nothing with no charging points", () => {
    expect(statusHeadline([], {}, {}, realtime)).toBeNull();
  });

  it("names the car and the spare solar when charging on solar alone", () => {
    expect(
      statusHeadline(
        [charging()],
        { "cp-1": { solarW: 2000, gridW: 0 } },
        {},
        realtime,
      ),
    ).toEqual({
      tone: "charging",
      title: "Charging Model 3 on solar",
      detail: "2.0 kW of 3.5 kW solar · 700 W exporting",
    });
  });

  it("gives the solar share when the grid is topping up", () => {
    expect(
      statusHeadline(
        [charging()],
        { "cp-1": { solarW: 1500, gridW: 500 } },
        {},
        { solarProductionW: 2100, gridPowerW: 500 },
      ),
    ).toEqual({
      tone: "charging",
      title: "Charging Model 3 on 75% solar",
      detail: "2.0 kW · 1.5 kW solar, 500 W grid",
    });
  });

  it("says when the charge is all from the grid", () => {
    const headline = statusHeadline(
      [charging()],
      { "cp-1": { solarW: 0, gridW: 2000 } },
      {},
      { solarProductionW: 0, gridPowerW: 2500 },
    );
    expect(headline?.title).toBe("Charging Model 3 from the grid");
  });

  it("counts the cars when more than one is charging", () => {
    const headline = statusHeadline(
      [charging(), charging({ id: "cp-2", name: "Leaf", priority: 2 })],
      {
        "cp-1": { solarW: 2000, gridW: 0 },
        "cp-2": { solarW: 2000, gridW: 0 },
      },
      {},
      { solarProductionW: 6000, gridPowerW: 0 },
    );
    expect(headline?.title).toBe("Charging 2 vehicles on solar");
    expect(headline?.detail).toBe("4.0 kW of 6.0 kW solar");
  });

  it("still names the charge before energy data arrives", () => {
    expect(statusHeadline([charging()], {}, {}, null)).toEqual({
      tone: "charging",
      title: "Charging Model 3",
      detail: "2.0 kW",
    });
  });

  it("gives the controller's reason for a car that is waiting", () => {
    expect(
      statusHeadline(
        [point()],
        {},
        {
          "cp-1": {
            reason: "blockout",
            detail: "Not charging — blockout until 21:00",
          },
        },
        realtime,
      ),
    ).toEqual({
      tone: "waiting",
      title: "Paused by a blockout",
      detail: "Not charging — blockout until 21:00",
    });
  });

  it.each<[string, HeadlinePoint, string | undefined, string]>([
    [
      "a stopped car",
      point({ mode: "stop" }),
      "mode_stop",
      "Model 3 is set to Stop",
    ],
    [
      "a full battery",
      point(),
      "battery_at_limit",
      "Model 3 is at its charge limit",
    ],
    [
      "no word from the controller yet",
      point(),
      undefined,
      "Model 3 is plugged in, not charging",
    ],
  ])("is calm about %s", (_label, p, reason, title) => {
    const statuses = reason ? { "cp-1": { reason, detail: "x" } } : {};
    const headline = statusHeadline([p], {}, statuses, realtime);
    expect(headline?.tone).toBe("idle");
    expect(headline?.title).toBe(title);
  });

  it("describes the highest-priority car that is plugged in", () => {
    const headline = statusHeadline(
      [
        point({ id: "cp-2", name: "Leaf", priority: 2 }),
        point({ priority: 1 }, { isPluggedIn: false }),
      ],
      {},
      {},
      realtime,
    );
    expect(headline?.title).toBe("Leaf is plugged in, not charging");
  });

  it("says nothing is plugged in only when every point says so", () => {
    expect(
      statusHeadline([point({}, { isPluggedIn: false })], {}, {}, realtime),
    ).toEqual({
      tone: "idle",
      title: "Nothing plugged in",
      detail: "3.5 kW solar · 700 W exporting",
    });
    // An asleep car cannot say whether its cable is in.
    expect(statusHeadline([point({}, null)], {}, {}, null)).toEqual({
      tone: "idle",
      title: "Not charging",
      detail: null,
    });
  });
});

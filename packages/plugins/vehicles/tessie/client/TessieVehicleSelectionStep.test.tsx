import { describe, expect, it, vi } from "vitest";
import { selectionNext } from "./TessieVehicleSelectionStep.tsx";

vi.mock("./trpc.ts", () => ({ trpc: {} }));

describe("selectionNext", () => {
  const save = () => Promise.resolve();

  it("waits while vehicles load", () => {
    expect(
      selectionNext({ loading: true, selectedCount: 0, existingCount: 0, save })
        .kind,
    ).toBe("loading");
  });

  it("saves the selection when something is picked", () => {
    const next = selectionNext({
      loading: false,
      selectedCount: 2,
      existingCount: 0,
      save,
    });
    expect(next.kind).toBe("ready");
    expect(next.kind === "ready" && next.onNext).toBe(save);
  });

  it("continues past vehicles saved earlier", () => {
    const next = selectionNext({
      loading: false,
      selectedCount: 0,
      existingCount: 1,
      save,
    });
    expect(next.kind).toBe("ready");
    expect(next.kind === "ready" && next.onNext).not.toBe(save);
  });

  it("blocks with nothing selected or saved", () => {
    expect(
      selectionNext({
        loading: false,
        selectedCount: 0,
        existingCount: 0,
        save,
      })
        .kind,
    ).toBe("blocked");
  });
});

import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "../../../../client/src/test-utils.tsx";
import { TessieTokenForm, tokenTestStatus } from "./TessieTokenStep.tsx";

const mocks = vi.hoisted(() => ({
  testMutate: vi.fn(),
  testState: {} as Record<string, unknown>,
  capturedOnSuccess: null as
    | null
    | ((data: { success: boolean }, input: { token: string }) => void),
}));

vi.mock("./trpc.ts", () => ({
  trpc: {
    plugin: {
      vehicle: {
        tessie: {
          testToken: {
            useMutation: (
              opts: { onSuccess: typeof mocks.capturedOnSuccess },
            ) => {
              mocks.capturedOnSuccess = opts.onSuccess;
              return {
                mutate: mocks.testMutate,
                isPending: false,
                isError: false,
                data: undefined,
                error: null,
                ...mocks.testState,
              };
            },
          },
        },
      },
    },
  },
}));

describe("tokenTestStatus", () => {
  const base = { isPending: false, isError: false, error: null };

  it("is idle before a test", () => {
    expect(tokenTestStatus(base)).toEqual({ status: "idle" });
  });

  it("reports the vehicle count on success", () => {
    expect(
      tokenTestStatus({ ...base, data: { success: true, vehicleCount: 2 } }),
    ).toEqual({ status: "success", detail: "2 vehicles found" });
  });

  it("uses the singular for one vehicle", () => {
    expect(
      tokenTestStatus({ ...base, data: { success: true, vehicleCount: 1 } }),
    ).toEqual({ status: "success", detail: "1 vehicle found" });
  });

  it("shows Tessie's message for a rejected token", () => {
    expect(
      tokenTestStatus({
        ...base,
        data: { success: false, error: "Tessie rejected the API token" },
      }),
    ).toEqual({ status: "error", message: "Tessie rejected the API token" });
  });
});

describe("TessieTokenForm", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.testState = {};
  });

  it("disables the test button until a token is entered", () => {
    renderWithProviders(<TessieTokenForm onValidated={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Test Token" })).toBeDisabled();
  });

  it("tests the trimmed token", () => {
    renderWithProviders(<TessieTokenForm onValidated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Tessie API token"), {
      target: { value: "  abc123  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test Token" }));
    expect(mocks.testMutate).toHaveBeenCalledWith({ token: "abc123" });
  });

  it("hands a working token back to the caller", () => {
    const onValidated = vi.fn();
    renderWithProviders(<TessieTokenForm onValidated={onValidated} />);
    mocks.capturedOnSuccess?.({ success: true }, { token: "abc123" });
    expect(onValidated).toHaveBeenCalledWith("abc123");
  });

  it("does not hand back a rejected token", () => {
    const onValidated = vi.fn();
    renderWithProviders(<TessieTokenForm onValidated={onValidated} />);
    mocks.capturedOnSuccess?.({ success: false }, { token: "bad" });
    expect(onValidated).not.toHaveBeenCalled();
  });
});

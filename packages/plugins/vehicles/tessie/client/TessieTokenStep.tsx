import { useMemo, useState } from "react";
import { Button, Link, Text, TextField } from "@radix-ui/themes";
import { Loader2 } from "lucide-react";
import {
  advanceOnly,
  type PluginStepDef,
  stepStyles as styles,
  TestResultBadge,
  type TestStatus,
  type WizardNext,
} from "../../../hostUi.ts";
import { trpc } from "./trpc.ts";

export const TESSIE_TOKEN_URL = "https://dash.tessie.com/settings/api";

type TestResult = { success: boolean; vehicleCount?: number; error?: string };

export function tokenTestStatus(
  mutation: {
    isPending: boolean;
    isError: boolean;
    data?: TestResult;
    error?: { message: string } | null;
  },
): TestStatus {
  if (mutation.isPending) return { status: "testing" };
  if (mutation.isError) {
    return { status: "error", message: mutation.error?.message ?? "Failed" };
  }
  if (!mutation.data) return { status: "idle" };
  if (!mutation.data.success) {
    return {
      status: "error",
      message: mutation.data.error ?? "Connection failed",
    };
  }
  const count = mutation.data.vehicleCount ?? 0;
  return {
    status: "success",
    detail: `${count} vehicle${count === 1 ? "" : "s"} found`,
  };
}

// A saved token can be kept as-is; a new one must pass a test first.
function tokenNext(
  { validated, hasSavedToken, save }: {
    validated: string | null;
    hasSavedToken: boolean;
    save: (token: string) => Promise<void>;
  },
): WizardNext {
  if (validated) {
    return {
      kind: "ready",
      hint: "Next saves your Tessie API token",
      onNext: () => save(validated),
    };
  }
  if (hasSavedToken) {
    return {
      kind: "ready",
      hint: "A token is already saved — Next continues",
      onNext: advanceOnly,
    };
  }
  return { kind: "blocked", reason: "Test the token to continue" };
}

export function TessieTokenForm(
  { onValidated }: { onValidated: (token: string) => void },
): JSX.Element {
  const [token, setToken] = useState("");
  const testMutation = trpc.plugin.vehicle.tessie.testToken.useMutation({
    onSuccess: (data: TestResult, input: { token: string }) => {
      if (data.success) onValidated(input.token);
    },
  });
  const testResult = useMemo(() => tokenTestStatus(testMutation), [
    testMutation.isPending,
    testMutation.isError,
    testMutation.data,
    testMutation.error,
  ]);
  const trimmed = token.trim();

  return (
    <>
      <div className={styles.fieldGroup}>
        <Text as="label" size="2" weight="medium">API token</Text>
        <Text size="1" color="gray">
          In Tessie, open{" "}
          <Link href={TESSIE_TOKEN_URL} target="_blank" rel="noreferrer">
            Settings → API
          </Link>{" "}
          and choose Generate Access Token.
        </Text>
        <TextField.Root
          size="2"
          type="password"
          placeholder="Paste your Tessie access token"
          value={token}
          onChange={(e: { target: { value: string } }) =>
            setToken(e.target.value)}
          aria-label="Tessie API token"
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button
          size="2"
          variant="soft"
          disabled={!trimmed || testMutation.isPending}
          onClick={() => testMutation.mutate({ token: trimmed })}
        >
          {testMutation.isPending && (
            <Loader2 size={14} className={styles.spinner} />
          )}
          {testMutation.isPending ? "Testing..." : "Test Token"}
        </Button>
        <TestResultBadge testResult={testResult} />
      </div>
    </>
  );
}

export const tessieTokenStep: PluginStepDef = {
  id: "tessie-token",
  label: "Tessie API Token",
  useStep: () => {
    const { data: status } = trpc.plugin.vehicle.tessie.tessieStatus
      .useQuery();
    const saveMutation = trpc.plugin.vehicle.tessie.setConfig.useMutation();
    const utils = trpc.useUtils();
    const [validated, setValidated] = useState<string | null>(null);

    const save = async (token: string) => {
      await saveMutation.mutateAsync({ tessieApiToken: token });
      await utils.plugin.vehicle.tessie.invalidate();
    };

    return {
      next: tokenNext({
        validated,
        hasSavedToken: !!status?.tokenConfigured,
        save,
      }),
      view: (
        <div className={styles.stepContainer}>
          <Text as="p" size="3" color="gray">
            Tessie talks to your Tesla for you, so there is no Tesla developer
            account, key pairing or command proxy to set up. You need an active
            Tessie subscription with your car added to it.
          </Text>
          <TessieTokenForm onValidated={setValidated} />
        </div>
      ),
    };
  },
};

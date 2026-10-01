import { useEffect, useState } from "react";
import { CheckCircle, CloudSun, KeyRound, RefreshCw, Send } from "lucide-react";
import {
  Badge,
  Button,
  Select,
  Switch,
  Text,
  TextField,
} from "@radix-ui/themes";
import {
  FORECAST_LEARN_MIN_DAYS,
  FORECAST_PROVIDER_NAMES,
  FORECAST_PROVIDERS,
  type ForecastCorrection,
  type ForecastProviderId,
  isLocalForecastProvider,
  type PanelCheck,
  type SolarForecastSite,
  type SolarForecastStatus,
} from "@chargeha/shared/solarForecast";
import { trpc } from "../../../trpc.ts";
import { formatRelativeTime } from "../../../utils/Format.ts";
import { FormError } from "../../ui/FormError.tsx";
import type { SaveStatus } from "../../../hooks/useSectionConfig.ts";
import {
  NumberInput,
  SettingsRow,
  SettingsSection,
} from "./SettingsLayout.tsx";

const SOLCAST_SIGNUP_URL = "https://solcast.com/free-rooftop-solar-forecasting";

const NONE = "__none__";

interface Draft {
  provider: ForecastProviderId | "";
  baseUrl: string;
  siteIds: string;
  dailyLimit: string;
  adjust: boolean;
  summaryTime: string;
  // Only set while the key is being replaced.
  apiKey: string | null;
}

const draftFrom = (status: SolarForecastStatus): Draft => ({
  provider: status.provider ?? "",
  baseUrl: status.baseUrl,
  siteIds: status.siteIds.join(", "),
  dailyLimit: String(status.dailyLimit),
  adjust: status.adjust,
  summaryTime: status.summaryTime,
  apiKey: null,
});

const isDirty = (draft: Draft, status: SolarForecastStatus): boolean => {
  const saved = draftFrom(status);
  return draft.provider !== saved.provider ||
    draft.baseUrl.trim() !== saved.baseUrl ||
    draft.siteIds.trim() !== saved.siteIds ||
    draft.dailyLimit !== saved.dailyLimit ||
    draft.adjust !== saved.adjust ||
    draft.summaryTime !== saved.summaryTime ||
    (draft.apiKey !== null && draft.apiKey.trim() !== "");
};

export function formatSite(site: SolarForecastSite): string {
  return site.capacityKw === null
    ? site.name
    : `${site.name} (${site.capacityKw} kW)`;
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

// "Updated 12m ago · next at 2:30 pm · 3 of 10 requests used today". A local
// provider has no requests to count.
export function statusLine(
  status: SolarForecastStatus,
  nowMs = Date.now(),
): string {
  const parts = [
    status.lastFetchAt
      ? `Updated ${formatRelativeTime(new Date(status.lastFetchAt))}`
      : "Not updated yet",
    status.nextFetchAt && Date.parse(status.nextFetchAt) > nowMs
      ? `next at ${formatClock(status.nextFetchAt)}`
      : null,
    isLocalForecastProvider(status.provider)
      ? null
      : `${status.usedToday} of ${status.dailyLimit} requests used today`,
  ];
  return parts.filter(Boolean).join(" · ");
}

// "7 am", "12 pm"
export function hourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? "am" : "pm"}`;
}

// Hours the correction moves by 5% or more, e.g. "7 am −30%".
export function adjustedHours(correction: ForecastCorrection): string[] {
  return correction.hourFactors.flatMap((factor, hour) => {
    const pct = Math.round((factor - 1) * 100);
    if (Math.abs(pct) < 5) return [];
    return [`${hourLabel(hour)} ${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`];
  });
}

export function correctionLine(correction: ForecastCorrection | null): string {
  if (!correction) return "Starts learning after the first full day.";
  if (correction.days < FORECAST_LEARN_MIN_DAYS) {
    return `Learning — ${correction.days} of ${FORECAST_LEARN_MIN_DAYS} days so far.`;
  }
  return adjustedHours(correction).length === 0
    ? `Learned from ${correction.days} days — the forecast already matches your system.`
    : `Learned from ${correction.days} days:`;
}

export function panelCheckLine(check: PanelCheck | null): string {
  const pct = Math.round((check?.recentShare ?? 0) * 100);
  switch (check?.state) {
    case "ok":
      return `Normal — recent clear days at ${pct}% of usual.`;
    case "low":
      return `Low — recent clear days at ${pct}% of usual. Worth checking the inverter and panels.`;
    default:
      return "Waiting for enough clear days to compare.";
  }
}

const CHECK_BADGES: Record<
  PanelCheck["state"],
  { label: string; color: "green" | "amber" | "gray" }
> = {
  ok: { label: "Normal", color: "green" },
  low: { label: "Low", color: "amber" },
  waiting: { label: "Waiting", color: "gray" },
};

function LearningRows(
  { status, adjust, onAdjust }: {
    status: SolarForecastStatus;
    adjust: boolean;
    onAdjust: (adjust: boolean) => void;
  },
) {
  const { correction, panelCheck } = status;
  const checkBadge = CHECK_BADGES[panelCheck?.state ?? "waiting"];
  const hours = correction && correction.days >= FORECAST_LEARN_MIN_DAYS
    ? adjustedHours(correction)
    : [];
  return (
    <>
      <SettingsRow
        label="Adjust to my system"
        help="Learns, hour by hour, how your output compares with the forecast — shade, dirt, a roof set up slightly off — and corrects the forecast to match."
      >
        <Switch
          aria-label="Adjust to my system"
          checked={adjust}
          onCheckedChange={onAdjust}
        />
      </SettingsRow>
      <Text size="1" color="gray">{correctionLine(correction)}</Text>
      {hours.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {hours.map((label) => (
            <Badge key={label} size="1" color="gray">{label}</Badge>
          ))}
        </div>
      )}
      <SettingsRow
        label="System check"
        help="Compares clear days with your usual. Turn on Solar Underperforming in Notifications to be told when output drops."
      >
        <Badge size="1" color={checkBadge.color}>{checkBadge.label}</Badge>
      </SettingsRow>
      <Text size="1" color="gray">{panelCheckLine(panelCheck)}</Text>
    </>
  );
}

function SummaryRow(
  { time, onTime }: { time: string; onTime: (time: string) => void },
) {
  const send = trpc.forecast.sendSummary.useMutation();
  return (
    <SettingsRow
      label="Evening summary"
      help="Today's solar, tomorrow's forecast and any top-up planned tonight. Turn on Daily Solar Summary in Notifications to receive it."
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <TextField.Root
          type="time"
          aria-label="Evening summary time"
          value={time}
          onChange={(e) => onTime(e.target.value)}
        />
        <Button
          size="1"
          variant="soft"
          disabled={send.isPending}
          onClick={() => send.mutate()}
        >
          <Send size={12} />
          {send.isSuccess ? "Sent" : "Send now"}
        </Button>
      </div>
    </SettingsRow>
  );
}

function ApiKeyEditor(
  { provider, baseUrl, value, onChange }: {
    provider: ForecastProviderId;
    baseUrl: string;
    value: string;
    onChange: (v: string) => void;
  },
) {
  const test = trpc.forecast.testKey.useMutation();
  const result = test.data;
  const local = isLocalForecastProvider(provider);
  const testLabel = local ? "Test" : "Test Key";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <TextField.Root
          type="password"
          aria-label={local ? "Home Assistant access token" : "Solcast API key"}
          placeholder={local ? "Paste the access token" : "Paste your API key"}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            test.reset();
          }}
          style={{ flex: 1 }}
        />
        <Button
          size="2"
          variant="soft"
          disabled={!value.trim() || test.isPending}
          onClick={() =>
            test.mutate({
              apiKey: value.trim(),
              provider,
              ...(local ? { baseUrl: baseUrl.trim() } : {}),
            })}
        >
          {test.isPending ? "Testing…" : testLabel}
        </Button>
      </div>
      <Text size="1" color="gray">
        {local
          ? "Testing checks the address, the token and that the Solcast integration is there."
          : "Testing lists your sites and does not use a request."}
      </Text>
      {result?.success && (
        <Text size="1" color="green">
          <CheckCircle size={12} style={{ verticalAlign: "middle" }} /> Found
          {" "}
          {result.sites?.map(formatSite).join(", ")}
        </Text>
      )}
      <FormError message={result?.success === false ? result.error : null} />
    </div>
  );
}

function ForecastStatusBlock({ status }: { status: SolarForecastStatus }) {
  const utils = trpc.useUtils();
  const refresh = trpc.forecast.refresh.useMutation({
    onSettled: () => {
      utils.forecast.invalidate();
      utils.stats.invalidate();
    },
  });
  const outOfRequests = !isLocalForecastProvider(status.provider) &&
    status.usedToday >= status.dailyLimit;
  const error = refresh.data?.success === false
    ? refresh.data.error
    : status.lastError;
  return (
    <>
      <SettingsRow label="Forecast" help={statusLine(status)}>
        <Button
          size="1"
          variant="soft"
          disabled={refresh.isPending || outOfRequests}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw size={12} />
          {refresh.isPending ? "Updating…" : "Update now"}
        </Button>
      </SettingsRow>
      <FormError message={error} />
    </>
  );
}

// Where the forecast comes from, under the key.
function ProviderHint({ local }: { local: boolean }) {
  if (local) {
    return (
      <Text size="1" color="gray">
        Reads the forecast from the Solcast PV Forecast integration in Home
        Assistant, so only Home Assistant spends your Solcast requests.
      </Text>
    );
  }
  return (
    <Text size="1" color="gray">
      No account? Sign up free at{" "}
      <a href={SOLCAST_SIGNUP_URL} target="_blank" rel="noreferrer">
        solcast.com
      </a>{" "}
      as a home user, add your rooftop, then copy the API key.
    </Text>
  );
}

type UpdateDraft = (patch: Partial<Draft>) => void;

function ApiKeyRows(
  { provider, status, draft, update }: {
    provider: ForecastProviderId;
    status: SolarForecastStatus;
    draft: Draft;
    update: UpdateDraft;
  },
) {
  const editingKey = draft.apiKey !== null || !status.apiKeySet;
  const local = isLocalForecastProvider(provider);
  return (
    <>
      {local && (
        <SettingsRow
          label="Home Assistant address"
          help="Where ChargeHA can reach Home Assistant, e.g. http://homeassistant.local:8123."
        >
          <TextField.Root
            aria-label="Home Assistant address"
            placeholder="http://homeassistant.local:8123"
            value={draft.baseUrl}
            onChange={(e) => update({ baseUrl: e.target.value })}
            style={{ width: 260 }}
          />
        </SettingsRow>
      )}
      <SettingsRow
        label={local ? "Access token" : "API key"}
        help={local
          ? "A long-lived access token: your Home Assistant profile → Security. Stored encrypted when ENCRYPTION_KEY is set."
          : "Your Solcast account → API Key. Stored encrypted when ENCRYPTION_KEY is set."}
      >
        {status.apiKeySet && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge color="green" size="1">
              <KeyRound size={10} /> Saved
            </Badge>
            <Button
              size="1"
              variant="soft"
              onClick={() =>
                update({ apiKey: draft.apiKey === null ? "" : null })}
            >
              {draft.apiKey === null ? "Replace" : "Cancel"}
            </Button>
          </div>
        )}
      </SettingsRow>
      {editingKey && (
        <ApiKeyEditor
          provider={provider}
          baseUrl={draft.baseUrl}
          value={draft.apiKey ?? ""}
          onChange={(apiKey) => update({ apiKey })}
        />
      )}
      <ProviderHint local={local} />
    </>
  );
}

// Which sites to forecast and how many requests a day the account allows.
function QuotaRows(
  { draft, update, limitValid }: {
    draft: Draft;
    update: UpdateDraft;
    limitValid: boolean;
  },
) {
  return (
    <>
      <SettingsRow
        label="Site IDs"
        help="Leave blank to forecast every site on the account. East/west arrays set up as two sites are added together."
      >
        <TextField.Root
          aria-label="Site IDs"
          placeholder="All sites"
          value={draft.siteIds}
          onChange={(e) => update({ siteIds: e.target.value })}
          style={{ width: 220 }}
        />
      </SettingsRow>

      <SettingsRow
        label="Daily request limit"
        help="10 on Solcast's free plan (older accounts may have 50). Updates are spread across daylight, one request per site, with one kept back for Update now."
      >
        <NumberInput
          value={draft.dailyLimit}
          onChange={(dailyLimit) => update({ dailyLimit })}
          suffix="/ day"
          min={1}
        />
      </SettingsRow>
      {!limitValid && (
        <FormError message="Enter a whole number of requests, 1 or more." />
      )}
    </>
  );
}

function useForecastDraft(status: SolarForecastStatus | undefined) {
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (status && draft === null) setDraft(draftFrom(status));
  }, [status, draft]);
  return [draft, setDraft] as const;
}

// Saves, then resets the draft from what the server now holds.
function useForecastSave(setDraft: (draft: Draft) => void) {
  const utils = trpc.useUtils();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({
    state: "idle",
    tick: 0,
  });
  const save = trpc.forecast.saveSettings.useMutation({
    onMutate: () => setSaveStatus((s) => ({ state: "saving", tick: s.tick })),
    onSuccess: async () => {
      await utils.forecast.invalidate();
      const fresh = await utils.forecast.status.fetch();
      setDraft(draftFrom(fresh));
      setSaveStatus((s) => ({ state: "saved", tick: s.tick + 1 }));
    },
    onError: (err) =>
      setSaveStatus((s) => ({
        state: "error",
        message: err.message,
        tick: s.tick + 1,
      })),
  });
  return { save, saveStatus };
}

export function SolarForecastSettings() {
  const { data: status } = trpc.forecast.status.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const [draft, setDraft] = useForecastDraft(status);
  const { save, saveStatus } = useForecastSave(setDraft);

  if (!status || !draft) return null;

  const update: UpdateDraft = (patch) => setDraft({ ...draft, ...patch });
  const limit = Number(draft.dailyLimit);
  const limitValid = Number.isInteger(limit) && limit >= 1;
  const local = isLocalForecastProvider(draft.provider);
  const onSave = () => {
    if (!limitValid) return;
    save.mutate({
      forecastProvider: draft.provider,
      ...(local ? { forecastBaseUrl: draft.baseUrl.trim() } : {}),
      forecastSiteIds: draft.siteIds.trim(),
      forecastDailyLimit: limit,
      forecastAdjust: draft.adjust,
      forecastSummaryTime: draft.summaryTime,
      ...(draft.apiKey?.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    });
  };
  const configured = status.provider !== null && status.apiKeySet;

  return (
    <SettingsSection
      icon={<CloudSun size={16} />}
      title="Solar Forecast"
      description="Forecast your solar production and compare it with what your system actually made. Solcast's free hobbyist plan works, directly or through Home Assistant."
      saveStatus={saveStatus}
      isDirty={isDirty(draft, status)}
      onSave={onSave}
    >
      <SettingsRow label="Provider" help="Where the forecast comes from.">
        <Select.Root
          value={draft.provider || NONE}
          onValueChange={(v) =>
            update({ provider: v === NONE ? "" : v as ForecastProviderId })}
        >
          <Select.Trigger aria-label="Forecast provider" />
          <Select.Content>
            <Select.Item value={NONE}>Disabled</Select.Item>
            {FORECAST_PROVIDERS.map((id) => (
              <Select.Item key={id} value={id}>
                {FORECAST_PROVIDER_NAMES[id]}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </SettingsRow>

      {draft.provider && (
        <>
          <ApiKeyRows
            provider={draft.provider}
            status={status}
            draft={draft}
            update={update}
          />

          {!local && (
            <QuotaRows draft={draft} update={update} limitValid={limitValid} />
          )}

          {configured && (
            <>
              <ForecastStatusBlock status={status} />
              <LearningRows
                status={status}
                adjust={draft.adjust}
                onAdjust={(adjust) => update({ adjust })}
              />
              <SummaryRow
                time={draft.summaryTime}
                onTime={(summaryTime) => update({ summaryTime })}
              />
            </>
          )}
        </>
      )}
    </SettingsSection>
  );
}

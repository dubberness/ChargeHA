import type { QueryHandler } from "./types.ts";
import { PROVIDER_CONFIG_FIELDS } from "@chargeha/shared/notifications";

export const miscHandlers: Record<string, QueryHandler> = {
  // Encryption is always "configured" in demo — no secrets to protect.
  "health.encryption": () => ({ configured: true }),
  "health.pluginWarnings": () => [],

  "notification.providers": () => PROVIDER_CONFIG_FIELDS,

  // No forecast provider in demo — the dashboard card and stats line hide.
  "forecast.status": () => ({
    provider: null,
    baseUrl: "",
    apiKeySet: false,
    siteIds: [],
    dailyLimit: 10,
    usedToday: 0,
    lastFetchAt: null,
    lastError: null,
    nextFetchAt: null,
    adjust: true,
    summaryTime: "20:00",
    correction: null,
    panelCheck: null,
  }),
  "forecast.summary": () => null,
  "forecast.projections": () => [],
};

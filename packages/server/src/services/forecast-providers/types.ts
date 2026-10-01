import type {
  ForecastProviderId,
  SolarForecastPeriod,
  SolarForecastSite,
} from "@chargeha/shared/solarForecast";

export interface ForecastProviderOptions {
  // Address of a local provider (Home Assistant). Unused by cloud providers.
  baseUrl?: string;
}

// A solar forecast source (e.g. Solcast). Stateless: the forecast service
// owns scheduling, quota accounting and storage.
export interface SolarForecastProvider {
  readonly id: ForecastProviderId;
  readonly displayName: string;
  // Sites on the account. Must not count against the daily quota — it is
  // called whenever the settings page tests a key.
  listSites(
    apiKey: string,
    options?: ForecastProviderOptions,
  ): Promise<SolarForecastSite[]>;
  // Forecast periods for one site, from now onwards. One quota request.
  fetchForecast(
    apiKey: string,
    siteId: string,
    options?: ForecastProviderOptions,
  ): Promise<SolarForecastPeriod[]>;
}

// The provider refused the key.
export class ForecastAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForecastAuthError";
  }
}

// The provider says today's quota is spent. Nothing more can be fetched
// until it resets.
export class ForecastQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForecastQuotaError";
  }
}

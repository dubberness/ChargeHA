import { z } from "zod";
import { defineSection } from "@chargeha/shared/configSections";

export const DEFAULT_MIN_AMPS = 5;

// ── Tessie charging-point config ────────────────────────────────────────────
// Same floor as the Tesla plugin's: it is the car's limit, not the API's.
// Row-scoped because two cars on one Tessie account can differ.
export const tessieChargerConfigDef = defineSection({
  tessieMinAmps: {
    key: "min_amps",
    schema: z.enum(["1", "2", "3", "4", "5"]),
    default: String(DEFAULT_MIN_AMPS) as "5",
  },
});

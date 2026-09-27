import { z } from "zod";
import {
  defineSection,
  type SectionKeys,
  type SectionType,
} from "@chargeha/shared/configSections";

// ── Tessie plugin config section ────────────────────────────────────────────
// Keys are relative — PluginDependencies prefixes them with the plugin id.

export const tessieConfigDef = defineSection({
  tessieApiToken: {
    key: "api_token",
    schema: z.string(),
    default: "",
  },
});

export type TessieConfig = SectionType<typeof tessieConfigDef>;

export type TessieConfigKey = SectionKeys<typeof tessieConfigDef>;

export const TESSIE_SECRET_KEYS = [
  "api_token",
] as const satisfies readonly TessieConfigKey[];

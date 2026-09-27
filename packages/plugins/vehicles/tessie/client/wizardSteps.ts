import type { PluginStepDef } from "../../../hostUi.ts";
import type { VehiclePluginOption } from "../../../pluginOptions.ts";
import { tessieTokenStep } from "./TessieTokenStep.tsx";
import { tessieVehicleSelectionStep } from "./TessieVehicleSelectionStep.tsx";

export const tessieVehicleOption: VehiclePluginOption = {
  id: "tessie",
  label: "Tesla (via Tessie)",
  description:
    "Connects through your Tessie subscription with a single API token. No Tesla developer account, key pairing or command proxy needed.",
  iconKey: "car",
};

export const tessieWizardSteps: PluginStepDef[] = [
  tessieTokenStep,
  tessieVehicleSelectionStep,
];

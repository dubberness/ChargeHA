import { z } from "zod";
import { authSelectVehiclesInput } from "@chargeha/shared/schemas";
import { publicProcedure, router } from "../../../../server/src/trpc/trpc.ts";
import type { PluginDependencies } from "@chargeha/server/bootstrap/PluginDependencies";
import {
  createChargerConfigProcedures,
  createPluginConfigProcedures,
} from "../../../createPluginConfigProcedures.ts";
import { TESSIE_SECRET_KEYS, tessieConfigDef } from "./config.ts";
import { tessieChargerConfigDef } from "./chargerConfig.ts";
import type { TessieVehiclePlugin } from "./TessieVehiclePlugin.ts";

type TessieRouterPlugin = Pick<
  TessieVehiclePlugin,
  | "getStatus"
  | "testToken"
  | "listAccountVehicles"
  | "selectVehicles"
  | "disconnect"
>;

const testTokenInput = z.object({ token: z.string().min(1) });

export function createTessieRouter(
  plugin: TessieRouterPlugin,
  deps: PluginDependencies,
) {
  return router({
    ...createPluginConfigProcedures(deps, tessieConfigDef, TESSIE_SECRET_KEYS),

    charger: router(
      createChargerConfigProcedures(deps, tessieChargerConfigDef, []),
    ),

    tessieStatus: publicProcedure.query(() => plugin.getStatus()),

    tessieVehicles: publicProcedure.query(() => plugin.listAccountVehicles()),

    listVehicles: publicProcedure.query(async () => {
      return { vehicles: await deps.getVehiclesWithState() };
    }),

    testToken: publicProcedure
      .input(testTokenInput)
      .mutation(({ input }) => plugin.testToken(input.token)),

    selectVehicles: publicProcedure
      .input(authSelectVehiclesInput)
      .mutation(({ input }) => plugin.selectVehicles(input)),

    disconnect: publicProcedure.mutation(() => plugin.disconnect()),
  });
}

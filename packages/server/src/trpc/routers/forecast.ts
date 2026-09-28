import { z } from "zod";
import { forecastConfigDef } from "@chargeha/shared/configSections";
import { FORECAST_PROVIDERS } from "@chargeha/shared/solarForecast";
import { publicProcedure, router } from "../trpc.ts";

const settingsInput = z.object({
  forecastProvider: forecastConfigDef.forecastProvider.schema.optional(),
  forecastSiteIds: forecastConfigDef.forecastSiteIds.schema.max(500)
    .optional(),
  forecastDailyLimit: forecastConfigDef.forecastDailyLimit.schema.optional(),
  forecastAdjust: forecastConfigDef.forecastAdjust.schema.optional(),
  forecastSummaryTime: forecastConfigDef.forecastSummaryTime.schema.optional(),
  // Write-only: status reports whether a key is set, never the key.
  apiKey: z.string().max(500).optional(),
});

export const forecastRouter = router({
  status: publicProcedure.query(({ ctx }) => ctx.forecastService.getStatus()),

  summary: publicProcedure.query(({ ctx }) => ctx.forecastService.getSummary()),

  saveSettings: publicProcedure
    .input(settingsInput)
    .mutation(async ({ ctx, input }) => {
      await ctx.forecastService.saveSettings(input);
      return { success: true as const };
    }),

  // Lists the account's sites. Free: does not use the daily quota.
  testKey: publicProcedure
    .input(z.object({
      apiKey: z.string().max(500).optional(),
      provider: z.enum(FORECAST_PROVIDERS).optional(),
    }))
    .mutation(({ ctx, input }) =>
      ctx.forecastService.testKey(input.apiKey, input.provider)
    ),

  // What solar should add to each plugged-in car before sunset.
  projections: publicProcedure.query(({ ctx }) =>
    ctx.solarPlanner.projections()
  ),

  // Sends the evening summary now, to try it out.
  sendSummary: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.solarPlanner.sendSummary();
    return { success: true as const };
  }),

  // Uses one request per site from the daily quota.
  refresh: publicProcedure.mutation(({ ctx }) => ctx.forecastService.refresh()),
});

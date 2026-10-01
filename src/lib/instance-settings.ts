import { z } from "zod"

export const instanceSettingsSchema = z.strictObject({
  debug: z.boolean(),
  loggingToFile: z.boolean(),
  usageStatisticsEnabled: z.boolean(),
  requestRetry: z.number().int().min(0).max(100),
  maxRetryInterval: z.number().int().min(0).max(3600),
  routingStrategy: z.enum(["round-robin", "fill-first"]),
})
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>

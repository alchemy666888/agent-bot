import { z } from "zod";
export const dashboardQuerySchema = z
  .object({
    search: z.string().max(200).default(""),
    page: z.coerce.number().int().positive().default(1),
  })
  .strict();
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

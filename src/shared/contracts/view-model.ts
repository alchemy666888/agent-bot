import { z } from "zod";

export const pageInputSchema = z
  .object({
    search: z.string().trim().max(200).default(""),
    page: z.coerce.number().int().positive().default(1),
  })
  .strict();
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({
      contractVersion: z.literal(1),
      items: z.array(item),
      page: z.number().int().positive(),
      pageSize: z.literal(50),
      total: z.number().int().nonnegative(),
    })
    .strict();

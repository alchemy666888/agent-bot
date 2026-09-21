import { z } from "zod";
export const updateStages = [
  "received",
  "prompt_saved",
  "model_complete",
  "delivery_complete",
  "failed",
] as const;
export const updateStateSchema = z
  .object({
    updateId: z.string().regex(/^\d+$/),
    stage: z.enum(updateStages),
    promptId: z.string().optional(),
    assistantId: z.string().optional(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type UpdateState = z.infer<typeof updateStateSchema>;
const rank = new Map(updateStages.map((stage, index) => [stage, index]));
export function advanceUpdate(
  current: UpdateState,
  next: UpdateState,
): UpdateState {
  if (
    current.updateId !== next.updateId ||
    (rank.get(next.stage) ?? -1) < (rank.get(current.stage) ?? 0)
  )
    throw new Error("INVALID_UPDATE_TRANSITION");
  if (current.stage === "delivery_complete" || current.stage === "failed")
    return current;
  return updateStateSchema.parse(next);
}

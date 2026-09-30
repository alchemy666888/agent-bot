import { z } from "zod";

/** The complete vocabulary understood by the worker. Skill prose is never parsed
 * to expand this list. Adding an entry is an operator/code change. */
export const capabilityIds = [
  "conversation.read",
  "conversation.write",
  "telegram.send",
  "network.fetch",
] as const;

export const capabilityIdSchema = z.enum(capabilityIds);
export type CapabilityId = z.infer<typeof capabilityIdSchema>;

export const sensitiveCapabilities = new Set<CapabilityId>([
  "telegram.send",
  "network.fetch",
]);

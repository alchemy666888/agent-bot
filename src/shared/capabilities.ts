/** Capability names are code-owned. Skill documents cannot extend this list. */
export const allowedCapabilityIds = [
  "model.read",
  "telegram.reply",
  "http.fetch",
  "network.http",
] as const;
export type CapabilityId = (typeof allowedCapabilityIds)[number];

export function isCapabilityId(value: string): value is CapabilityId {
  return (allowedCapabilityIds as readonly string[]).includes(value);
}

/** Adapters remain outside skill content and must be registered by the operator. */
export interface CapabilityAdapter {
  readonly id: CapabilityId;
  invoke(input: unknown): Promise<unknown>;
}

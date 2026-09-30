import { z } from "zod";

/** Capability names are platform-owned. Skill documents can request, but never define, them. */
export const capabilityIdentifiers = [
  "model.generate",
  "telegram.send",
  "network.http",
  "filesystem.read",
  "filesystem.write",
  "sandbox.execute",
] as const;

export const capabilityIdentifierSchema = z.enum(capabilityIdentifiers);
export type CapabilityIdentifier = z.infer<typeof capabilityIdentifierSchema>;

export const sensitiveCapabilities = new Set<CapabilityIdentifier>([
  "telegram.send",
  "network.http",
  "filesystem.read",
  "filesystem.write",
  "sandbox.execute",
]);

export function parseCapabilities(
  value: readonly string[],
): CapabilityIdentifier[] {
  return [
    ...new Set(value.map((item) => capabilityIdentifierSchema.parse(item))),
  ];
}

/** Capability names are code-owned. Skill documents cannot extend this list. */
export const allowedCapabilityIds = [
  "model.read",
  "telegram.reply",
  "http.fetch",
  "network.http",
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

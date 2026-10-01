import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CapabilityRegistry } from "../../../../src/worker/capabilities/registry";

const definition = (id: string, scope: "general" | "skill") => ({
  scope,
  request: { id, description: `${id} tool`, inputSchema: { type: "object" } },
  input: z.object({}),
  execute: async () => null,
});

describe("capability routing enumeration", () => {
  it("clones and sorts general tools without elevating skill-scoped tools", () => {
    const registry = new CapabilityRegistry([
      definition("z_general", "general"),
      definition("skill_only", "skill"),
      definition("a_general", "general"),
    ]);
    const first = registry.generalRequests();
    expect(first.map(({ id }) => id)).toEqual(["a_general", "z_general"]);
    first[0]!.description = "mutated";
    expect(registry.generalRequests()[0]!.description).toBe("a_general tool");
  });
});

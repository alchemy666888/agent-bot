import { describe, expect, it } from "vitest";
import { convertRow } from "../../../scripts/migrate-skills-to-github.mjs";

const row = {
  stable_id: "11111111-1111-4111-8111-111111111111",
  version_id: "22222222-2222-4222-8222-222222222222",
  draft_id: "33333333-3333-4333-8333-333333333333",
  draft_revision: 2,
  version_number: 4,
  status: "superseded",
  display_name: "Example",
  description: "description",
  approved_body:
    "# Safe body\nsecret-shaped content remains only in the skill file",
  approved_document: {
    stableId: "11111111-1111-4111-8111-111111111111",
    draftId: "33333333-3333-4333-8333-333333333333",
    revision: 2,
    name: "Example",
    body: "# Safe body\nsecret-shaped content remains only in the skill file",
    ownerTelegramUserIds: ["123"],
    triggers: [{ type: "event", value: "arrival" }],
    tools: ["search"],
    capabilities: ["web"],
    approval: {
      approvedBy: "operator",
      approvedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  approved_by: "operator",
  approved_at: "2026-01-01T00:00:00.000Z",
  approval_source: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  owners: ["123"],
  triggers: [{ type: "event", value: "arrival" }],
  tools: ["search"],
  capabilities: ["web"],
};

describe("skill migration conversion", () => {
  it("preserves provenance and maps historical lifecycle without placing the body in metadata", () => {
    const converted = convertRow(row);
    expect(converted.manifest.status).toBe("retired");
    expect(converted.manifest.migration.sourceStatus).toBe("superseded");
    expect(converted.manifest.migration.capabilities).toEqual(["web"]);
    expect(JSON.stringify(converted.manifest)).not.toContain("secret-shaped");
    expect(converted.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails closed when the approved document disagrees with normalized data", () => {
    expect(() => convertRow({ ...row, approved_body: "changed" })).toThrow(
      "approved_document_mismatch",
    );
  });
});

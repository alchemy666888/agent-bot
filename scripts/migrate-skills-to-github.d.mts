export interface ConvertedSkillRow {
  row: Record<string, unknown>;
  manifest: {
    status: "active" | "retired";
    migration: {
      sourceStatus: "active" | "retired" | "superseded";
      capabilities: string[];
    };
    [key: string]: unknown;
  };
  body: string;
  digest: string;
}
export function convertRow(input: unknown): ConvertedSkillRow;

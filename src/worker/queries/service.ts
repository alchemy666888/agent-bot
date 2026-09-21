import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pageInputSchema } from "../../shared/contracts";
import type { RecordKind } from "../persistence/layout";
export interface QueryPage {
  items: Record<string, unknown>[];
  page: number;
  pageSize: 50;
  total: number;
}
export class QueryService {
  constructor(private root: string) {}
  async list(kind: RecordKind, input: unknown): Promise<QueryPage> {
    const { search, page } = pageInputSchema.parse(input);
    const directory = join(this.root, "data/state", kind);
    const files = await readdir(directory).catch(() => [] as string[]);
    const records = await Promise.all(
      files
        .filter((x) => x.endsWith(".json"))
        .map(
          async (file) =>
            JSON.parse(await readFile(join(directory, file), "utf8")) as Record<
              string,
              unknown
            >,
        ),
    );
    const needle = search.toLocaleLowerCase();
    const filtered = records
      .filter(
        (record) =>
          !needle ||
          JSON.stringify(record).toLocaleLowerCase().includes(needle),
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      items: filtered.slice((page - 1) * 50, page * 50),
      page,
      pageSize: 50,
      total: filtered.length,
    };
  }
  async overview() {
    const entries = await Promise.all(
      (
        [
          "users",
          "conversations",
          "messages",
          "model-runs",
          "errors",
        ] as RecordKind[]
      ).map(async (kind) => [kind, (await this.list(kind, {})).total] as const),
    );
    return Object.fromEntries(entries);
  }
}

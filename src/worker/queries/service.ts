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
    const needle = search.toLocaleLowerCase();
    const filtered = (await this.readAll(kind))
      .filter(
        (record) =>
          !needle ||
          JSON.stringify(record).toLocaleLowerCase().includes(needle),
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return this.page(filtered, page);
  }
  async conversation(
    id: string,
    input: unknown,
  ): Promise<
    QueryPage & {
      found: boolean;
      conversation?: Record<string, unknown>;
    }
  > {
    if (!/^[\w.-]+$/.test(id)) throw new Error("INVALID_QUERY");
    const { page } = pageInputSchema.parse(input);
    let conversation: Record<string, unknown> | undefined;
    try {
      conversation = JSON.parse(
        await readFile(
          join(this.root, "data/state/conversations", `${id}.json`),
          "utf8",
        ),
      ) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...this.page([], page), found: false };
      throw error;
    }
    const messages = (await this.readAll("messages"))
      .filter((record) => record.conversationId === id)
      .sort((a, b) =>
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
      );
    return { ...this.page(messages, page), found: true, conversation };
  }
  private page(filtered: Record<string, unknown>[], page: number): QueryPage {
    return {
      items: filtered.slice((page - 1) * 50, page * 50),
      page,
      pageSize: 50,
      total: filtered.length,
    };
  }
  private async readAll(kind: RecordKind): Promise<Record<string, unknown>[]> {
    const directory = join(this.root, "data/state", kind);
    const files = await readdir(directory).catch(() => [] as string[]);
    return Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(
          async (file) =>
            JSON.parse(await readFile(join(directory, file), "utf8")) as Record<
              string,
              unknown
            >,
        ),
    );
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

import { z } from "zod";
import { CapabilityRegistry } from "./registry";

type SearchOutput = {
  type?: string;
  status?: string;
  action?: unknown;
  content?: string | { type?: string; text?: string }[];
};
type SearchBody = {
  output_text?: string;
  output?: SearchOutput[];
};

export interface DeepSeekWebSearchConfig {
  apiKey: string;
  baseUrl: string;
}

function searchText(body: SearchBody): string {
  if (body.output_text) return body.output_text;
  const texts: string[] = [];
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    if (typeof item.content === "string") texts.push(item.content);
    else
      for (const part of item.content ?? [])
        if (part.type === "output_text" && part.text) texts.push(part.text);
  }
  return texts.join("");
}

/**
 * DeepSeek executes `web_search` on the server. DuckDuckGo's instant-answer
 * endpoint often returns an empty abstract for weather and news, which is what
 * the assistant was reporting as a blank search.
 */
async function searchWithDeepSeek(
  request: typeof fetch,
  deepseek: DeepSeekWebSearchConfig,
  query: string,
  signal: AbortSignal,
) {
  if (!deepseek.apiKey) throw new Error("WEB_SEARCH_UNCONFIGURED");
  let input: unknown = `Search the public web and report current facts with source URLs.\n\nQuery: ${query}`;
  const searches: unknown[] = [];
  let summary = "";
  for (let round = 0; round < 3; round++) {
    const response = await request(
      `${deepseek.baseUrl.replace(/\/$/, "")}/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${deepseek.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          stream: false,
          tools: [{ type: "web_search" }],
          tool_choice: round === 0 ? { type: "web_search" } : "auto",
          input,
        }),
        signal,
      },
    );
    if (!response.ok)
      throw Object.assign(new Error("WEB_SEARCH_FAILED"), {
        status: response.status,
      });
    const body = (await response.json()) as SearchBody;
    const output = body.output ?? [];
    for (const item of output)
      if (item.type === "web_search_call") searches.push(item.action ?? item);
    summary = searchText(body);
    if (summary || !output.some((item) => item.type === "web_search_call"))
      break;
    input = output;
  }
  return { summary, searches: searches.slice(0, 5) };
}

/** The only place where skill-facing identifiers become executable code. */
export function createCapabilityRegistry(
  request: typeof fetch = fetch,
  deepseek: DeepSeekWebSearchConfig = {
    apiKey: "",
    baseUrl: "https://api.deepseek.com",
  },
) {
  return new CapabilityRegistry([
    {
      scope: "general",
      request: {
        id: "web_search",
        description:
          "Search the public web with DeepSeek web_search for current factual information.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", minLength: 1 } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      input: z.object({ query: z.string().min(1).max(500) }).strict(),
      timeoutMs: 45_000,
      async execute(value, signal) {
        const { query } = value as { query: string };
        return searchWithDeepSeek(request, deepseek, query, signal);
      },
    },
  ]);
}

export * from "./registry";

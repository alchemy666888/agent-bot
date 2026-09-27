import {
  modelResponseSchema,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "../../shared/contracts";

type ResponsesBody = {
  id?: string;
  output_text?: string;
  output?: {
    type?: string;
    content?: string | { type?: string; text?: string }[];
  }[];
  usage?: { input_tokens: number; output_tokens: number };
};

function finalContent(body: ResponsesBody): string | undefined {
  if (body.output_text) return body.output_text;
  const texts: string[] = [];
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    if (typeof item.content === "string") {
      texts.push(item.content);
      continue;
    }
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && part.text) texts.push(part.text);
    }
  }
  return texts.join("") || undefined;
}

export class DeepSeekProvider implements ModelProvider {
  constructor(
    private config: { apiKey: string; baseUrl: string; thinking: boolean },
    private request: typeof fetch = fetch,
  ) {}
  async generate(input: ModelRequest): Promise<ModelResponse> {
    const instructions = input.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const response = await this.request(`${this.config.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        stream: false,
        reasoning: { effort: this.config.thinking ? "medium" : "none" },
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        ...(instructions ? { instructions } : {}),
        input: input.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role,
            content: message.content,
          })),
      }),
      signal: input.signal,
    });
    if (!response.ok)
      throw Object.assign(new Error("DEEPSEEK_REQUEST_FAILED"), {
        status: response.status,
      });
    const body = (await response.json()) as ResponsesBody;
    return modelResponseSchema.parse({
      content: finalContent(body),
      requestId: body.id,
      usage: body.usage && {
        inputTokens: body.usage.input_tokens,
        outputTokens: body.usage.output_tokens,
      },
    });
  }
}

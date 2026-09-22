import {
  modelResponseSchema,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "../../shared/contracts";
export class DeepSeekProvider implements ModelProvider {
  constructor(
    private config: { apiKey: string; baseUrl: string; thinking: boolean },
    private request: typeof fetch = fetch,
  ) {}
  async generate(input: ModelRequest): Promise<ModelResponse> {
    const response = await this.request(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          stream: false,
          thinking: { type: this.config.thinking ? "enabled" : "disabled" },
          reasoning_effort: "medium",
          messages: input.messages,
        }),
        signal: input.signal,
      },
    );
    if (!response.ok)
      throw Object.assign(new Error("DEEPSEEK_REQUEST_FAILED"), {
        status: response.status,
      });
    const body = (await response.json()) as {
      id?: string;
      choices?: {
        message?: { content?: string; reasoning_content?: string };
      }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return modelResponseSchema.parse({
      content: body.choices?.[0]?.message?.content,
      requestId: body.id,
      usage: body.usage && {
        inputTokens: body.usage.prompt_tokens,
        outputTokens: body.usage.completion_tokens,
      },
    });
  }
}

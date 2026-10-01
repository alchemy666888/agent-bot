import {
  routingDecisionSchema,
  routingRequestSchema,
  type RoutingDecision,
  type RoutingRequest,
} from "../../shared/contracts";

type ResponsesBody = {
  id?: string;
  output_text?: string;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: { input_tokens: number; output_tokens: number };
};

export type RouterRunMetadata = {
  requestId?: string;
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs: number;
};

export interface RequestRouter {
  route(request: RoutingRequest): Promise<RoutingDecision>;
  /** Optional instrumented form used to account for the classifier request. */
  routeWithMetadata?(
    request: RoutingRequest,
  ): Promise<{ decision: RoutingDecision; run: RouterRunMetadata }>;
}

function responseText(body: ResponsesBody): string | undefined {
  if (body.output_text) return body.output_text;
  return (
    body.output
      ?.flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "output_text")
      .map((part) => part.text ?? "")
      .join("") || undefined
  );
}

export class DeepSeekRouter implements RequestRouter {
  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl: string;
      thinking?: boolean;
    },
    private readonly request: typeof fetch = fetch,
  ) {}

  async route(rawRequest: RoutingRequest): Promise<RoutingDecision> {
    return (await this.routeWithMetadata(rawRequest)).decision;
  }

  async routeWithMetadata(
    rawRequest: RoutingRequest,
  ): Promise<{ decision: RoutingDecision; run: RouterRunMetadata }> {
    const input = routingRequestSchema.parse(rawRequest);
    const started = Date.now();
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
        instructions:
          "Classify the current request only. Decide whether it needs an authorized skill or operator-approved tool. Select only IDs present in the supplied lists and prefer explicit user intent. Return only JSON matching the routing schema. Never propose arguments, executable instructions, or tool calls. Use web_search_fallback only when current external facts are required; use direct when no capability is needed; use ambiguous when clarification is necessary; use refuse for unsafe requests.",
        input: [
          {
            role: "user",
            content: JSON.stringify({
              request: input.request,
              conversationContext: input.conversationContext,
              authorizedSkills: input.authorizedSkills,
              availableTools: input.availableTools,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "routing_decision",
            strict: true,
            schema: {
              type: "object",
              oneOf: [
                {
                  properties: {
                    kind: { const: "skill" },
                    selectedSkillId: { type: "string" },
                    confidence: { type: "number" },
                    rationale: { type: "string" },
                  },
                  required: [
                    "kind",
                    "selectedSkillId",
                    "confidence",
                    "rationale",
                  ],
                  additionalProperties: false,
                },
                {
                  properties: {
                    kind: { const: "tool" },
                    selectedToolId: { type: "string" },
                    confidence: { type: "number" },
                    rationale: { type: "string" },
                  },
                  required: [
                    "kind",
                    "selectedToolId",
                    "confidence",
                    "rationale",
                  ],
                  additionalProperties: false,
                },
                ...["web_search_fallback", "direct", "refuse"].map((kind) => ({
                  properties: {
                    kind: { const: kind },
                    confidence: { type: "number" },
                    rationale: { type: "string" },
                  },
                  required: ["kind", "confidence", "rationale"],
                  additionalProperties: false,
                })),
                {
                  properties: {
                    kind: { const: "ambiguous" },
                    candidateIds: {
                      type: "array",
                      items: { type: "string" },
                      minItems: 2,
                      maxItems: 10,
                    },
                    confidence: { type: "number" },
                    rationale: { type: "string" },
                  },
                  required: ["kind", "candidateIds", "confidence", "rationale"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
      }),
      signal: input.signal,
    });
    if (!response.ok)
      throw Object.assign(new Error("DEEPSEEK_ROUTING_FAILED"), {
        status: response.status,
      });

    let body: ResponsesBody | undefined;
    try {
      body = (await response.json()) as ResponsesBody;
      const text = responseText(body);
      if (!text) throw new Error("ROUTER_OUTPUT_INVALID");
      const decision = routingDecisionSchema.parse(JSON.parse(text));
      return {
        decision,
        run: {
          requestId: body.id,
          usage: body.usage
            ? {
                inputTokens: body.usage.input_tokens,
                outputTokens: body.usage.output_tokens,
              }
            : undefined,
          latencyMs: Date.now() - started,
        },
      };
    } catch (error) {
      const invalid =
        error instanceof Error && error.message === "ROUTER_OUTPUT_INVALID"
          ? error
          : new Error("ROUTER_OUTPUT_INVALID", { cause: error });
      Object.assign(invalid, {
        run: {
          requestId: body?.id,
          usage: body?.usage
            ? {
                inputTokens: body.usage.input_tokens,
                outputTokens: body.usage.output_tokens,
              }
            : undefined,
          latencyMs: Date.now() - started,
        } satisfies RouterRunMetadata,
      });
      throw invalid;
    }
  }
}

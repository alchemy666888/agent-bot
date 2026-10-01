import {
  routingDecisionSchema,
  routingRequestSchema,
  type RoutingDecision,
  type RoutingRequest,
} from "../../shared/contracts";

type ResponsesBody = {
  output_text?: string;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
};

const SAFE_ROUTING_FALLBACK: RoutingDecision = {
  kind: "direct",
  confidence: 0,
  rationale: "Router output was invalid; use the safe no-capability path.",
};

export interface RequestRouter {
  route(request: RoutingRequest): Promise<RoutingDecision>;
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
    const input = routingRequestSchema.parse(rawRequest);
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

    try {
      const text = responseText((await response.json()) as ResponsesBody);
      if (!text) return structuredClone(SAFE_ROUTING_FALLBACK);
      const decision = routingDecisionSchema.parse(JSON.parse(text));
      const skillIds = new Set(input.authorizedSkills.map(({ id }) => id));
      const toolIds = new Set(input.availableTools.map(({ id }) => id));
      if (decision.kind === "skill" && !skillIds.has(decision.selectedSkillId))
        return structuredClone(SAFE_ROUTING_FALLBACK);
      if (decision.kind === "tool" && !toolIds.has(decision.selectedToolId))
        return structuredClone(SAFE_ROUTING_FALLBACK);
      if (decision.kind === "web_search_fallback" && !toolIds.has("web_search"))
        return structuredClone(SAFE_ROUTING_FALLBACK);
      if (
        decision.kind === "ambiguous" &&
        decision.candidateIds.some(
          (id) => !skillIds.has(id) && !toolIds.has(id),
        )
      )
        return structuredClone(SAFE_ROUTING_FALLBACK);
      return decision;
    } catch {
      return structuredClone(SAFE_ROUTING_FALLBACK);
    }
  }
}

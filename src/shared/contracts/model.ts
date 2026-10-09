import { z } from "zod";
import { skillCatalogToken } from "../../worker/skills/schemas";

export const modelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1),
  })
  .strict();
export const capabilityRequestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    description: z.string().min(1).max(500),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

const routingIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const routingTextSchema = z.string().trim().min(1).max(2_000);

/** Metadata that is safe to disclose to the classifier. Skill instructions are deliberately absent. */
export const authorizedSkillDescriptorSchema = z
  .object({
    id: routingIdentifierSchema,
    name: z.string().trim().min(1).max(120),
    description: routingTextSchema,
    status: z.enum(["active", "retired"]),
    supportedTasks: z.array(z.string().trim().min(1).max(200)).max(100),
    triggerHints: z.array(z.string().trim().min(1).max(200)).max(100),
    permittedCapabilityIds: z.array(routingIdentifierSchema).max(100),
  })
  .strict();

/** An operator-approved capability. This is descriptive only and contains no arguments. */
export const availableToolDescriptorSchema = z
  .object({
    id: routingIdentifierSchema,
    description: routingTextSchema,
    inputSchema: z.record(z.string().max(128), z.unknown()),
  })
  .strict();

const routingCommon = {
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(500),
};
export const routingDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("skill"),
      selectedSkillId: routingIdentifierSchema,
      ...routingCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool"),
      selectedToolId: routingIdentifierSchema,
      ...routingCommon,
    })
    .strict(),
  z
    .object({ kind: z.literal("web_search_fallback"), ...routingCommon })
    .strict(),
  z.object({ kind: z.literal("direct"), ...routingCommon }).strict(),
  z.object({ kind: z.literal("unavailable"), ...routingCommon }).strict(),
  z
    .object({
      kind: z.literal("ambiguous"),
      candidateIds: z
        .array(routingIdentifierSchema)
        .min(2)
        .max(10)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: "Candidate IDs must be unique",
        }),
      ...routingCommon,
    })
    .strict(),
  z.object({ kind: z.literal("refuse"), ...routingCommon }).strict(),
]);

export const routingRequestSchema = z
  .object({
    request: z.string().trim().min(1).max(10_000),
    conversationContext: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1).max(10_000),
          })
          .strict(),
      )
      .max(20),
    authorizedSkills: z.array(authorizedSkillDescriptorSchema).max(200),
    availableTools: z.array(availableToolDescriptorSchema).max(200),
    trustedClock: z.string().trim().min(1).max(2_000).optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    for (const [field, values] of [
      ["authorizedSkills", request.authorizedSkills],
      ["availableTools", request.availableTools],
    ] as const) {
      const ids = values.map(({ id }) => id);
      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} IDs must be unique`,
        });
    }
  });
export const skillContextSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    instructions: z.string().max(20_000),
    capabilities: z.array(capabilityRequestSchema),
    prohibitedActions: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const MAX_AUTHORIZED_SKILL_COUNT = 200;
export const MAX_AUTHORIZED_SKILL_CATALOG_BYTES = 2 * 1024 * 1024;

/**
 * A repository-filtered, version-pinned skill snapshot supplied by trusted
 * orchestration. It informs the model about the user's complete authorized
 * catalog, but does not itself authorize any capability.
 */
export const authorizedSkillCatalogSchema = z
  .object({
    catalogToken: z.string().regex(/^[a-f0-9]{64}$/),
    skills: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().trim().min(1).max(120),
            description: z.string().trim().max(2_000).optional(),
            versionId: z.uuid(),
            manifestRevision: z.number().int().positive().optional(),
            instructions: z.string().min(1).max(1_000_000),
            visibility: z.enum(["private", "shared", "public"]),
            ownerTelegramUserIds: z.array(z.string().regex(/^\d+$/)).min(1),
            allowedTelegramUserIds: z.array(z.string().regex(/^\d+$/)),
            triggers: z
              .object({
                phrases: z.array(z.string().min(1).max(200)).max(100),
                keywords: z.array(z.string().min(1).max(200)).max(100),
                minimumConfidence: z.number().min(0).max(1),
              })
              .strict(),
            tools: z.array(z.string().min(1).max(200)).max(100),
            prohibitedActions: z.array(z.string().min(1).max(200)).max(100),
            status: z.enum(["active", "retired"]),
          })
          .strict(),
      )
      .max(MAX_AUTHORIZED_SKILL_COUNT),
  })
  .strict()
  .superRefine((catalog, context) => {
    if (
      catalog.catalogToken !==
      skillCatalogToken(catalog.skills.map((skill) => skill.versionId))
    )
      context.addIssue({
        code: "custom",
        message: "Skill catalog must be version-pinned",
      });
    if (
      new TextEncoder().encode(JSON.stringify(catalog)).byteLength >
      MAX_AUTHORIZED_SKILL_CATALOG_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Authorized skill catalog is too large",
      });
  });
export const modelExecutionModeSchema = z.enum([
  "direct",
  "selected_skill",
  "selected_tools",
  "forced_web_search",
]);
export const modelRequestSchema = z
  .object({
    messages: z.array(modelMessageSchema).min(1),
    trustedInstructions: z
      .array(
        z
          .object({
            source: z.enum(["common", "personal", "runtime"]),
            content: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    /** Chosen by trusted orchestration; model providers must not infer or broaden it. */
    executionMode: modelExecutionModeSchema,
    skill: skillContextSchema.optional(),
    authorizedSkillCatalog: authorizedSkillCatalogSchema.optional(),
    generalCapabilities: z.array(capabilityRequestSchema).optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
export const modelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
export const modelResponseSchema = z
  .object({
    content: z.string().min(1),
    usage: modelUsageSchema.optional(),
    requestId: z.string().min(1).optional(),
    outputRecovery: z
      .object({
        triggered: z.boolean(),
        succeeded: z.boolean(),
      })
      .strict()
      .optional(),
    capabilityAudit: z
      .array(
        z.object({
          capabilityId: z.string(),
          outcome: z.enum([
            "success",
            "denied",
            "invalid",
            "timeout",
            "failure",
          ]),
          durationMs: z.number().nonnegative(),
        }),
      )
      .optional(),
  })
  .strict();
export type ModelRequest = z.infer<typeof modelRequestSchema>;
export type ModelExecutionMode = z.infer<typeof modelExecutionModeSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;
export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>;
export type SkillContext = z.infer<typeof skillContextSchema>;
export type AuthorizedSkillCatalog = z.infer<
  typeof authorizedSkillCatalogSchema
>;
export type AuthorizedSkillDescriptor = z.infer<
  typeof authorizedSkillDescriptorSchema
>;
export type AvailableToolDescriptor = z.infer<
  typeof availableToolDescriptorSchema
>;
export type RoutingRequest = z.infer<typeof routingRequestSchema>;
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

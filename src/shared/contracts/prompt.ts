import { z } from "zod";

export const PROMPT_FILE_MAX_BYTES = 16 * 1024;
export const PROMPT_BUNDLE_MAX_BYTES = 64 * 1024;
export const PROMPT_BUNDLE_MAX_LAYERS = 8;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const shaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "Expected a lowercase Git SHA-1");
const promptIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const promptKindSchema = z.enum(["system", "request"]);
export const promptScopeSchema = z.enum(["common", "global", "personal"]);
export const promptStatusSchema = z.enum(["active", "disabled"]);
export const promptMutationOperationSchema = z.enum([
  "create",
  "update",
  "disable",
  "delete",
  "reset",
]);

export const promptMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: promptIdSchema,
    kind: promptKindSchema,
    scope: promptScopeSchema,
    status: promptStatusSchema,
    summary: z.string().trim().min(1).max(256),
    triggers: z
      .object({
        commands: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(16),
        phrases: z.array(z.string().trim().min(1).max(80)).max(32),
      })
      .strict(),
    languages: z
      .array(z.string().regex(/^(\*|[a-z]{2,3}(?:-[A-Z]{2})?)$/))
      .min(1)
      .max(16),
  })
  .strict();

/** Metadata already filtered by the server. It deliberately carries no path or identity. */
export const authorizedPromptCandidateSchema = z
  .object({
    id: promptIdSchema,
    kind: z.literal("request"),
    scope: promptScopeSchema,
    summary: z.string().trim().min(1).max(256),
    commands: z.array(z.string().max(32)).max(16),
    phrases: z.array(z.string().max(80)).max(32),
  })
  .strict();

const promptLayerSchema = z
  .object({
    id: promptIdSchema,
    content: z
      .string()
      .min(1)
      .refine((v) => utf8Bytes(v) <= PROMPT_FILE_MAX_BYTES, {
        message: `Prompt layer exceeds ${PROMPT_FILE_MAX_BYTES} UTF-8 bytes`,
      }),
    source: z.enum(["repository", "verified_snapshot", "compiled_emergency"]),
    blobSha: shaSchema.optional(),
  })
  .strict()
  .superRefine((layer, ctx) => {
    if (layer.source === "compiled_emergency" && layer.blobSha !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["blobSha"],
        message: "Compiled layers have no blob SHA",
      });
    if (layer.source !== "compiled_emergency" && layer.blobSha === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["blobSha"],
        message: "Dynamic layers require a blob SHA",
      });
  });

export const promptBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimePolicy: z
      .object({
        version: z.string().regex(/^[1-9][0-9]*$/),
        mode: z.enum(["normal", "emergency"]),
      })
      .strict(),
    commonSystemPrompt: promptLayerSchema,
    personalOverlay: promptLayerSchema.optional(),
    requestTemplate: promptLayerSchema,
    skillContextReference: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        commitSha: shaSchema,
        blobSha: shaSchema,
      })
      .strict()
      .optional(),
    trustedRuntimeContext: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
            value: z.string().max(512),
          })
          .strict(),
      )
      .max(16),
    repositoryCommitSha: shaSchema.nullable(),
    selectedBlobShas: z
      .array(
        z.object({ promptId: promptIdSchema, blobSha: shaSchema }).strict(),
      )
      .max(PROMPT_BUNDLE_MAX_LAYERS),
    resolutionSource: z.enum([
      "explicit",
      "trigger",
      "router",
      "default",
      "emergency",
    ]),
    degradedModeSource: z
      .enum(["current_snapshot", "verified_snapshot", "compiled_emergency"])
      .nullable(),
    turnPin: z
      .object({ commitSha: shaSchema.nullable(), pinnedAt: z.iso.datetime() })
      .strict(),
    telemetry: z
      .object({
        resolution: z.enum(["exact", "trigger", "router", "fallback"]),
        degraded: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const layers = [
      bundle.commonSystemPrompt,
      bundle.personalOverlay,
      bundle.requestTemplate,
    ].filter(
      (layer): layer is z.infer<typeof promptLayerSchema> =>
        layer !== undefined,
    );
    if (
      layers.length + (bundle.skillContextReference ? 1 : 0) >
      PROMPT_BUNDLE_MAX_LAYERS
    )
      ctx.addIssue({
        code: "custom",
        message: `Bundle exceeds ${PROMPT_BUNDLE_MAX_LAYERS} layers`,
      });
    if (utf8Bytes(JSON.stringify(bundle)) > PROMPT_BUNDLE_MAX_BYTES)
      ctx.addIssue({
        code: "custom",
        message: `Bundle exceeds ${PROMPT_BUNDLE_MAX_BYTES} UTF-8 bytes`,
      });
    const layerIds = layers.map((layer) => layer.id);
    const selectedIds = bundle.selectedBlobShas.map((item) => item.promptId);
    if (
      new Set(layerIds).size !== layerIds.length ||
      new Set(selectedIds).size !== selectedIds.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["selectedBlobShas"],
        message: "Duplicate prompt IDs",
      });
    if (bundle.turnPin.commitSha !== bundle.repositoryCommitSha)
      ctx.addIssue({
        code: "custom",
        path: ["turnPin", "commitSha"],
        message: "Turn pin must match repository commit",
      });
    if (
      bundle.skillContextReference &&
      bundle.skillContextReference.commitSha !== bundle.repositoryCommitSha
    )
      ctx.addIssue({
        code: "custom",
        path: ["skillContextReference", "commitSha"],
        message: "Skill context must use the pinned repository commit",
      });
    const dynamic = layers.filter(
      (layer) => layer.source !== "compiled_emergency",
    );
    if (dynamic.length > 0 && bundle.repositoryCommitSha === null)
      ctx.addIssue({
        code: "custom",
        path: ["repositoryCommitSha"],
        message: "Dynamic layers require one pinned commit",
      });
    if (bundle.runtimePolicy.mode === "emergency") {
      if (bundle.commonSystemPrompt.source !== "compiled_emergency")
        ctx.addIssue({
          code: "custom",
          path: ["commonSystemPrompt"],
          message: "Emergency common prompt must be compiled",
        });
      if (
        [bundle.personalOverlay, bundle.requestTemplate].some(
          (layer) => layer && layer.source === "repository",
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Emergency mode permits dynamic content only from a verified snapshot",
        });
    }
  });

export const promptChangeProposalSchema = z
  .object({
    operation: promptMutationOperationSchema,
    scope: promptScopeSchema,
    kind: promptKindSchema,
    promptId: promptIdSchema,
    plainLanguageSummary: z.string().trim().min(1).max(256),
    proposedContent: z
      .string()
      .refine(
        (value) => utf8Bytes(value) <= PROMPT_FILE_MAX_BYTES,
        "Proposed content is too large",
      ),
    baseCommitSha: shaSchema,
    baseBlobSha: shaSchema.optional(),
  })
  .strict();

export const promptChangeProposalResultSchema = z
  .object({
    proposalId: z.uuid(),
    status: z.enum(["pending_confirmation", "rejected"]),
    expiresAt: z.iso.datetime(),
    summary: z.string().max(256),
  })
  .strict();

export const promptRoutingRequestSchema = z
  .object({
    requestId: z.uuid(),
    candidates: z.array(authorizedPromptCandidateSchema).min(1).max(64),
  })
  .strict()
  .superRefine((request, ctx) => {
    const ids = request.candidates.map((candidate) => candidate.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Duplicate prompt IDs",
      });
  });

export const promptRoutingResultSchema = z
  .object({
    requestId: z.uuid(),
    selectedId: promptIdSchema.nullable(),
    confidence: z.number().min(0).max(1),
    reasonCode: z.enum(["selected", "low_confidence", "no_match"]),
  })
  .strict();

export function parseAuthorizedPromptRoutingResult(
  request: unknown,
  result: unknown,
) {
  const parsedRequest = promptRoutingRequestSchema.parse(request);
  const parsedResult = promptRoutingResultSchema.parse(result);
  if (parsedResult.requestId !== parsedRequest.requestId)
    throw new Error("Routing request ID mismatch");
  if (
    parsedResult.selectedId !== null &&
    !parsedRequest.candidates.some(({ id }) => id === parsedResult.selectedId)
  )
    throw new Error("Routing result selected an unauthorized prompt ID");
  return parsedResult;
}

export type PromptKind = z.infer<typeof promptKindSchema>;
export type PromptScope = z.infer<typeof promptScopeSchema>;
export type PromptStatus = z.infer<typeof promptStatusSchema>;
export type PromptMutationOperation = z.infer<
  typeof promptMutationOperationSchema
>;
export type PromptMetadata = z.infer<typeof promptMetadataSchema>;
export type AuthorizedPromptCandidate = z.infer<
  typeof authorizedPromptCandidateSchema
>;
export type PromptBundle = z.infer<typeof promptBundleSchema>;
export type PromptChangeProposal = z.infer<typeof promptChangeProposalSchema>;
export type PromptChangeProposalResult = z.infer<
  typeof promptChangeProposalResultSchema
>;
export type PromptRoutingRequest = z.infer<typeof promptRoutingRequestSchema>;
export type PromptRoutingResult = z.infer<typeof promptRoutingResultSchema>;

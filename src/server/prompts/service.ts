import "server-only";

import { DEFAULT_EMERGENCY_SYSTEM_PROMPT } from "../config";
import {
  promptBundleSchema,
  type PromptBundle,
  type PromptRoutingRequest,
  type PromptRoutingResult,
} from "../../shared/contracts/prompt";
import type { PromptSnapshotCache, PromptSnapshotResult } from "./cache";
import type { StoredPromptFile, VerifiedPromptSnapshot } from "./github-store";
import { resolvePrompt } from "./resolver";

export interface PromptRoutingClient {
  route(input: {
    request: string;
    routing: PromptRoutingRequest;
  }): Promise<PromptRoutingResult>;
}

export type ResolvePromptBundleInput = {
  userKey: string;
  text: string;
  language?: string;
  trustedRuntimeContext?: Array<{ key: string; value: string }>;
  skillContextReference?: { id: string; commitSha: string; blobSha: string };
  pinnedSnapshot?: VerifiedPromptSnapshot;
};

function immutable<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>))
      immutable(child);
    Object.freeze(value);
  }
  return value;
}

function layer(
  file: StoredPromptFile,
  source: "repository" | "verified_snapshot",
) {
  return {
    id: file.metadata.id,
    content: file.body,
    source,
    blobSha: file.blobSha,
  } as const;
}

function fileAt(
  snapshot: VerifiedPromptSnapshot,
  path: string,
): StoredPromptFile {
  const file = snapshot.files.find(
    (candidate) =>
      candidate.path === path && candidate.metadata.status === "active",
  );
  if (!file) throw new Error("VERIFIED_SNAPSHOT_MISSING_MANDATORY_PROMPT");
  return file;
}

/** Resolves and freezes every layer from one immutable, verified snapshot. */
export class PromptService {
  constructor(
    private readonly cache: Pick<PromptSnapshotCache, "get">,
    private readonly options: {
      router?: PromptRoutingClient;
      routerEnabled?: boolean;
      confidenceThreshold?: number;
      runtimePolicyVersion?: string;
      now?: () => Date;
    } = {},
  ) {}

  async resolve(
    input: ResolvePromptBundleInput,
  ): Promise<Readonly<PromptBundle>> {
    const cached = await this.cache.get(input.pinnedSnapshot);
    if (!cached.snapshot) return this.emergency(cached, input);
    // Keep the local reference for the entire operation; cache activation cannot replace it.
    const snapshot = cached.snapshot;
    const prompt = await resolvePrompt({
      snapshot,
      userKey: input.userKey,
      text: input.text,
      language: input.language,
      routerEnabled: this.options.routerEnabled,
      confidenceThreshold: this.options.confidenceThreshold,
      router: this.options.router
        ? (routing) =>
            this.options.router!.route({ request: input.text, routing })
        : undefined,
    });
    const common = fileAt(snapshot, "prompts/common/system/base.md");
    const overlays = snapshot.files
      .filter(
        (file) =>
          file.metadata.kind === "system" &&
          file.metadata.scope === "personal" &&
          file.metadata.status === "active" &&
          file.path.startsWith(`prompts/users/${input.userKey}/system/`),
      )
      .sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
    // Multiple active overlays are configuration ambiguity and therefore apply none.
    const overlay = overlays.length === 1 ? overlays[0] : undefined;
    const source =
      cached.source === "verified_snapshot"
        ? "verified_snapshot"
        : "repository";
    const selected = [common, overlay, prompt.file].filter(
      (file): file is StoredPromptFile => file !== undefined,
    );
    const bundle = promptBundleSchema.parse({
      schemaVersion: 1,
      runtimePolicy: {
        version: this.options.runtimePolicyVersion ?? "1",
        mode: "normal",
      },
      commonSystemPrompt: layer(common, source),
      ...(overlay ? { personalOverlay: layer(overlay, source) } : {}),
      requestTemplate: layer(prompt.file, source),
      ...(input.skillContextReference
        ? { skillContextReference: input.skillContextReference }
        : {}),
      trustedRuntimeContext: input.trustedRuntimeContext ?? [],
      repositoryCommitSha: snapshot.commitSha,
      selectedBlobShas: selected.map((file) => ({
        promptId: file.metadata.id,
        blobSha: file.blobSha,
      })),
      resolutionSource: prompt.source,
      degradedModeSource:
        cached.source === "verified_snapshot" ? "verified_snapshot" : null,
      turnPin: {
        commitSha: snapshot.commitSha,
        pinnedAt: (this.options.now?.() ?? new Date()).toISOString(),
      },
      telemetry: {
        resolution: prompt.telemetry,
        degraded: cached.source === "verified_snapshot",
      },
    });
    return immutable(bundle);
  }

  private emergency(
    cached: Extract<PromptSnapshotResult, { source: "compiled_emergency" }>,
    input: ResolvePromptBundleInput,
  ): Readonly<PromptBundle> {
    const content =
      cached.emergencySystemPrompt || DEFAULT_EMERGENCY_SYSTEM_PROMPT;
    const bundle = promptBundleSchema.parse({
      schemaVersion: 1,
      runtimePolicy: {
        version: this.options.runtimePolicyVersion ?? "1",
        mode: "emergency",
      },
      commonSystemPrompt: { id: "base", content, source: "compiled_emergency" },
      requestTemplate: {
        id: "default",
        content: "Answer the user's request using the mandatory system policy.",
        source: "compiled_emergency",
      },
      trustedRuntimeContext: input.trustedRuntimeContext ?? [],
      repositoryCommitSha: null,
      selectedBlobShas: [],
      resolutionSource: "emergency",
      degradedModeSource: "compiled_emergency",
      turnPin: {
        commitSha: null,
        pinnedAt: (this.options.now?.() ?? new Date()).toISOString(),
      },
      telemetry: { resolution: "fallback", degraded: true },
    });
    return immutable(bundle);
  }
}

export const materializePromptBundle = (
  service: PromptService,
  input: ResolvePromptBundleInput,
) => service.resolve(input);

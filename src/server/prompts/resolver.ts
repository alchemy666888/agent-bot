import "server-only";

import { randomUUID } from "node:crypto";
import type {
  AuthorizedPromptCandidate,
  PromptRoutingRequest,
  PromptRoutingResult,
} from "../../shared/contracts/prompt";
import { parseAuthorizedPromptRoutingResult } from "../../shared/contracts/prompt";
import type { StoredPromptFile, VerifiedPromptSnapshot } from "./github-store";

export const EXPLICIT_PROMPT_COMMAND = "/prompt";

export type PromptRouter = (
  request: PromptRoutingRequest,
) => Promise<PromptRoutingResult>;

export type PromptResolution = {
  file: StoredPromptFile;
  source: "explicit" | "trigger" | "router" | "default";
  telemetry: "exact" | "trigger" | "router" | "fallback";
  candidates: readonly AuthorizedPromptCandidate[];
};

/** `/prompt <id>` is the only explicit selection syntax. The whole message is reserved. */
export function parseExplicitPromptSelection(text: string): string | null {
  const match = text.match(
    /^\/prompt(?:@[A-Za-z0-9_]{5,32})? +([a-z][a-z0-9-]{0,63})\s*$/,
  );
  return match?.[1] ?? null;
}

export function isReservedPromptCommand(text: string): boolean {
  return /^\/prompt(?:@[A-Za-z0-9_]{5,32})?(?:\s|$)/i.test(text);
}

export function normalizeTrigger(value: string, language?: string): string {
  const locale = normalizeLanguage(language);
  try {
    return value
      .normalize("NFKC")
      .toLocaleLowerCase(locale === "*" ? "en" : locale)
      .trim()
      .replace(/\s+/gu, " ");
  } catch {
    return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
  }
}

export function normalizeLanguage(language?: string): string {
  if (!language) return "*";
  const match = language
    .replace("_", "-")
    .match(/^([A-Za-z]{2,3})(?:-([A-Za-z]{2}))?$/);
  return match
    ? `${match[1].toLowerCase()}${match[2] ? `-${match[2].toUpperCase()}` : ""}`
    : "*";
}

function languageRank(languages: readonly string[], requested: string): number {
  if (languages.includes(requested)) return 2;
  const primary = requested.split("-")[0];
  if (languages.includes(primary)) return 1;
  return languages.includes("*") ? 0 : -1;
}

function belongsToUser(file: StoredPromptFile, userKey: string): boolean {
  return file.path.startsWith(`prompts/users/${userKey}/requests/`);
}

/** Builds the complete authorization boundary before any user-controlled matching. */
export function authorizedRequestPrompts(
  snapshot: VerifiedPromptSnapshot,
  userKey: string,
): StoredPromptFile[] {
  return snapshot.files
    .filter(
      (file) =>
        file.metadata.kind === "request" && file.metadata.status === "active",
    )
    .filter((file) =>
      file.metadata.scope === "common" || file.metadata.scope === "global"
        ? !file.path.includes("/users/")
        : belongsToUser(file, userKey),
    )
    .sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
}

function metadata(file: StoredPromptFile): AuthorizedPromptCandidate {
  return {
    id: file.metadata.id,
    kind: "request",
    scope: file.metadata.scope,
    summary: file.metadata.summary,
    commands: [...file.metadata.triggers.commands],
    phrases: [...file.metadata.triggers.phrases],
  };
}

function defaultPrompt(files: readonly StoredPromptFile[]): StoredPromptFile {
  const result = files.find(
    (file) =>
      file.metadata.scope === "common" && file.metadata.id === "default",
  );
  if (!result) throw new Error("VERIFIED_SNAPSHOT_MISSING_DEFAULT_PROMPT");
  return result;
}

type Match = { file: StoredPromptFile; rank: readonly number[] };

function deterministicMatches(
  files: readonly StoredPromptFile[],
  text: string,
  language: string,
): Match[] {
  const normalized = normalizeTrigger(text, language);
  const command = text
    .match(/^\/([a-z][a-z0-9_-]{0,31})(?:@[A-Za-z0-9_]{5,32})?(?:\s|$)/i)?.[1]
    ?.toLowerCase();
  const matches: Match[] = [];
  for (const file of files) {
    const lang = languageRank(file.metadata.languages, language);
    if (lang < 0) continue;
    if (
      command &&
      file.metadata.triggers.commands.some(
        (item) => item.toLowerCase() === command,
      )
    ) {
      matches.push({ file, rank: [2, lang, command.length] });
      continue;
    }
    for (const phrase of file.metadata.triggers.phrases) {
      const needle = normalizeTrigger(phrase, language);
      // Unicode letters and numbers define boundaries; punctuation and whitespace delimit phrases.
      const start = normalized.indexOf(needle);
      if (
        start >= 0 &&
        (start === 0 || !/[\p{L}\p{N}_]/u.test(normalized[start - 1])) &&
        (start + needle.length === normalized.length ||
          !/[\p{L}\p{N}_]/u.test(normalized[start + needle.length]))
      )
        matches.push({ file, rank: [1, lang, [...needle].length] });
    }
  }
  return matches;
}

function uniqueBest(matches: Match[]): StoredPromptFile | null {
  if (!matches.length) return null;
  matches.sort((a, b) => {
    for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
      const difference = (b.rank[i] ?? 0) - (a.rank[i] ?? 0);
      if (difference) return difference;
    }
    return a.file.metadata.id.localeCompare(b.file.metadata.id);
  });
  const best = matches[0];
  const tiedIds = new Set(
    matches
      .filter((item) =>
        item.rank.every((rank, index) => rank === best.rank[index]),
      )
      .map((item) => item.file.metadata.id),
  );
  return tiedIds.size === 1 ? best.file : null;
}

export async function resolvePrompt(input: {
  snapshot: VerifiedPromptSnapshot;
  userKey: string;
  text: string;
  language?: string;
  router?: PromptRouter;
  routerEnabled?: boolean;
  confidenceThreshold?: number;
  requestId?: string;
}): Promise<PromptResolution> {
  const files = authorizedRequestPrompts(input.snapshot, input.userKey);
  const fallback = defaultPrompt(files);
  const candidates = files.map(metadata);
  const frozenCandidates: readonly AuthorizedPromptCandidate[] = Object.freeze(
    candidates.map((candidate) => Object.freeze(candidate)),
  );
  const finish = (
    file: StoredPromptFile,
    source: PromptResolution["source"],
    telemetry: PromptResolution["telemetry"],
  ): PromptResolution => ({
    file,
    source,
    telemetry,
    candidates: frozenCandidates,
  });

  const explicit = parseExplicitPromptSelection(input.text);
  if (explicit) {
    const selected = files.find((file) => file.metadata.id === explicit);
    return selected
      ? finish(selected, "explicit", "exact")
      : finish(fallback, "default", "fallback");
  }
  // Malformed uses of the reserved command are never interpreted as ordinary text.
  if (isReservedPromptCommand(input.text))
    return finish(fallback, "default", "fallback");

  const deterministic = deterministicMatches(
    files,
    input.text,
    normalizeLanguage(input.language),
  );
  const selected = uniqueBest(deterministic);
  if (selected) {
    const commandMatch = deterministic.some(
      (match) => match.file === selected && match.rank[0] === 2,
    );
    return finish(
      selected,
      commandMatch ? "explicit" : "trigger",
      commandMatch ? "exact" : "trigger",
    );
  }
  // A deterministic ambiguity is terminal and safe: a probabilistic model may
  // not break the tie and make behavior depend on catalog iteration order.
  if (deterministic.length) return finish(fallback, "default", "fallback");

  if (input.routerEnabled && input.router) {
    const request = { requestId: input.requestId ?? randomUUID(), candidates };
    try {
      const routed = parseAuthorizedPromptRoutingResult(
        request,
        await input.router(request),
      );
      const threshold = input.confidenceThreshold ?? 0.75;
      if (
        routed.reasonCode === "selected" &&
        routed.selectedId &&
        routed.confidence >= threshold
      ) {
        // Reauthorize against the original set after parsing model output.
        const file = files.find(
          (candidate) => candidate.metadata.id === routed.selectedId,
        );
        if (file) return finish(file, "router", "router");
      }
    } catch {
      // Model routing is an optional, fail-closed enhancement.
    }
  }
  return finish(fallback, "default", "fallback");
}

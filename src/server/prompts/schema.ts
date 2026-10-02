import "server-only";

import {
  promptMetadataSchema,
  PROMPT_FILE_MAX_BYTES,
} from "../../shared/contracts/prompt";
import { containsLikelySecret } from "../../shared/redaction";
import { PROMPT_USER_KEY_PATTERN } from "./identity";

const ALLOWED_VARIABLES = new Set([
  "language",
  "locale",
  "timezone",
  "current_date",
]);
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const EXACT_FIELDS = new Set([
  "schema_version",
  "id",
  "kind",
  "scope",
  "status",
  "summary",
  "triggers",
  "languages",
]);
const SECURITY_DECLARATION =
  /(?:\b(?:grant|allow|enable|disable|override|bypass|ignore|change|expand|revoke|authorize|permit|access|available)\b[^\n.]{0,80}\b(?:authori[sz]ation|permission|credential|secret|api\s*key|token|tool|runtime|sandbox|operator|capabilit(?:y|ies))\b|\b(?:you|assistant|model)\s+(?:can|may|must|should)\s+use\b[^\n.]{0,50}\btools?\b|\b(?:authori[sz]ation|permissions?|credentials?|tools?|runtime[_ -]?permissions?|operator|capabilities)\s*:)/i;
const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export type RepositoryPromptEntry = {
  path: string;
  content: string | Uint8Array;
  mode?: string | number;
  type?: "blob" | "file" | "symlink" | "submodule" | "commit";
};

export type ValidatedPromptFile = {
  path: string;
  metadata: ReturnType<typeof promptMetadataSchema.parse>;
  body: string;
};

function scalar(value: string): string | number {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    const inner = v.slice(1, -1);
    if (/\\|\r|\n/.test(inner))
      throw new TypeError("Escapes are not supported in front matter");
    return inner;
  }
  if (!v || /[!&*{}[\]|>@`]/.test(v))
    throw new TypeError("Unsupported YAML scalar");
  if (/^[0-9]+$/.test(v)) return Number(v);
  if (v.includes(":")) throw new TypeError("Unsupported YAML scalar");
  return v;
}

/** A deliberately tiny schema-v1 YAML reader; it never constructs arbitrary YAML. */
export function parsePromptFrontMatter(source: string): {
  metadata: unknown;
  body: string;
} {
  if (!source.startsWith("---\n"))
    throw new TypeError("Missing YAML front matter");
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new TypeError("Unterminated YAML front matter");
  const lines = source.slice(4, end).split("\n");
  const data: Record<string, unknown> = {};
  let section: "triggers" | "languages" | null = null;
  let list: "commands" | "phrases" | "languages" | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#") || /\t|\r/.test(line))
      throw new TypeError(
        "Blank lines, comments, and tabs are not supported in front matter",
      );
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^([a-z_]+):(?: (.*))?$/))) {
      const [, key, raw] = match;
      if (!EXACT_FIELDS.has(key) || Object.hasOwn(data, key))
        throw new TypeError("Unknown or duplicate front-matter field");
      section =
        key === "triggers"
          ? "triggers"
          : key === "languages"
            ? "languages"
            : null;
      list = key === "languages" ? "languages" : null;
      if (section === "triggers") data.triggers = {};
      else if (section === "languages") data.languages = [];
      else {
        if (raw === undefined)
          throw new TypeError("Missing front-matter value");
        data[key] = scalar(raw);
      }
      continue;
    }
    if (
      (match = line.match(/^  (commands|phrases):$/)) &&
      section === "triggers"
    ) {
      list = match[1] as "commands" | "phrases";
      const triggers = data.triggers as Record<string, unknown>;
      if (Object.hasOwn(triggers, list))
        throw new TypeError("Duplicate trigger field");
      triggers[list] = [];
      continue;
    }
    if (
      (match = line.match(/^  (commands|phrases): \[\]$/)) &&
      section === "triggers"
    ) {
      list = null;
      const triggers = data.triggers as Record<string, unknown>;
      if (Object.hasOwn(triggers, match[1]))
        throw new TypeError("Duplicate trigger field");
      triggers[match[1]] = [];
      continue;
    }
    if ((match = line.match(/^(  |    )- (.+)$/)) && list) {
      const expected = list === "languages" ? "  " : "    ";
      if (match[1] !== expected)
        throw new TypeError("Invalid front-matter indentation");
      const target =
        list === "languages"
          ? data.languages
          : (data.triggers as Record<string, unknown>)[list];
      (target as unknown[]).push(scalar(match[2]));
      continue;
    }
    throw new TypeError("Unsupported YAML syntax");
  }
  return {
    metadata: {
      schemaVersion: data.schema_version,
      id: data.id,
      kind: data.kind,
      scope: data.scope,
      status: data.status,
      summary: data.summary,
      triggers: data.triggers,
      languages: data.languages,
    },
    body: source.slice(end + 5),
  };
}

export function normalizePromptPath(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.includes("%") ||
    /[\0-\x1f\x7f]/.test(path)
  )
    throw new TypeError("Unsafe prompt path");
  const parts = path.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.join("/") !== path ||
    !path.endsWith(".md")
  )
    throw new TypeError("Unsafe prompt path");
  if (parts[0] !== "prompts")
    throw new TypeError("Prompt path is outside prompts/");
  return path;
}

function expectedPath(metadata: ValidatedPromptFile["metadata"]): RegExp {
  const kindDir = metadata.kind === "system" ? "system" : "requests";
  if (metadata.scope === "personal")
    return new RegExp(
      `^prompts/users/u1_[A-Za-z0-9_-]{43}/${kindDir}/${metadata.id}\\.md$`,
    );
  if (metadata.scope === "global" && metadata.kind === "system") return /a^/;
  return new RegExp(
    `^prompts/${metadata.scope}/${kindDir}/${metadata.id}\\.md$`,
  );
}

export function validatePromptContent(body: string): void {
  if (!body.trim()) throw new TypeError("Prompt body is empty");
  if (SECURITY_DECLARATION.test(body))
    throw new TypeError("Prompt attempts to alter application security policy");
  if (containsLikelySecret(body))
    throw new TypeError("Prompt contains likely secret material");
  for (const match of body.matchAll(TEMPLATE))
    if (!ALLOWED_VARIABLES.has(match[1].trim()))
      throw new TypeError("Template variable is not allowlisted");
  const withoutAllowed = body.replace(TEMPLATE, "");
  if (/\{[{%]|[%}]\}/.test(withoutAllowed) || /<%|\$\{/.test(withoutAllowed))
    throw new TypeError("Arbitrary templates are prohibited");
}

export function validatePromptFile(
  entry: RepositoryPromptEntry,
): ValidatedPromptFile {
  const path = normalizePromptPath(entry.path);
  if (entry.type && entry.type !== "blob" && entry.type !== "file")
    throw new TypeError("Prompt entry is not a regular file");
  const numericMode = typeof entry.mode === "number" ? entry.mode : undefined;
  const mode =
    typeof entry.mode === "string" ? entry.mode : numericMode?.toString(8);
  if (
    (numericMode !== undefined && (numericMode & 0o111) !== 0) ||
    (mode &&
      (mode === "120000" ||
        mode === "160000" ||
        mode === "040000" ||
        /(?:^|0)[1357]{3}$/.test(mode.slice(-4))))
  )
    throw new TypeError(
      "Symlinks, submodules, directories, and executable prompts are prohibited",
    );
  const bytes =
    typeof entry.content === "string"
      ? new TextEncoder().encode(entry.content)
      : entry.content;
  if (bytes.byteLength > PROMPT_FILE_MAX_BYTES)
    throw new TypeError("Prompt file exceeds 16 KiB");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Prompt file is not valid UTF-8");
  }
  const parsed = parsePromptFrontMatter(source);
  const metadata = promptMetadataSchema.parse(parsed.metadata);
  if (!SAFE_ID.test(metadata.id) || !expectedPath(metadata).test(path))
    throw new TypeError("Prompt path does not match declared metadata");
  if (metadata.scope === "personal") {
    const key = path.split("/")[2];
    if (!PROMPT_USER_KEY_PATTERN.test(key))
      throw new TypeError("Invalid personal namespace");
  }
  validatePromptContent(parsed.body);
  return { path, metadata, body: parsed.body };
}

/** Validates the entire candidate before it can replace a snapshot. */
export function validatePromptSnapshot(
  entries: readonly RepositoryPromptEntry[],
): ValidatedPromptFile[] {
  const files = entries.map(validatePromptFile);
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const file of files) {
    const identity = `${file.metadata.scope}:${file.metadata.kind}:${file.metadata.id}:${file.path.split("/")[2] ?? ""}`;
    if (paths.has(file.path) || identities.has(identity))
      throw new TypeError("Duplicate prompt path or ID");
    paths.add(file.path);
    identities.add(identity);
  }
  return files;
}

export const parseAndValidatePromptFile = validatePromptFile;

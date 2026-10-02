import "server-only";

import { PROMPT_USER_KEY_PATTERN } from "./identity";

export type PromptScope = "common" | "global" | "personal";
export type PromptAction =
  "read" | "list" | "create" | "update" | "delete" | "reset";
export type PromptActor = { canonicalId: string; userKey: string };
export type PromptTarget = { scope: PromptScope; userKey?: string };

const mutations = new Set<PromptAction>([
  "create",
  "update",
  "delete",
  "reset",
]);

/** Central policy used before routing and again for the selected ID/path. */
export function isPromptAuthorized(input: {
  actor: PromptActor;
  target: PromptTarget;
  action: PromptAction;
  operatorIds?: ReadonlySet<string>;
}): boolean {
  const { actor, target, action } = input;
  if (!PROMPT_USER_KEY_PATTERN.test(actor.userKey)) return false;
  if (target.scope === "personal")
    return (
      target.userKey === actor.userKey &&
      PROMPT_USER_KEY_PATTERN.test(target.userKey)
    );
  if (!mutations.has(action)) return target.userKey === undefined;
  return (
    target.userKey === undefined &&
    (input.operatorIds ?? new Set()).has(actor.canonicalId)
  );
}

/** Throws one deliberately indistinguishable error for absent and forbidden targets. */
export function authorizePrompt(
  input: Parameters<typeof isPromptAuthorized>[0],
): void {
  if (!isPromptAuthorized(input)) throw new PromptNotFoundError();
}

export class PromptNotFoundError extends Error {
  readonly code = "PROMPT_NOT_FOUND";
  constructor() {
    super("PROMPT_NOT_FOUND");
    this.name = "PromptNotFoundError";
  }
}

export type StoredPromptSummary = {
  id: string;
  kind: "system" | "request";
  scope: PromptScope;
  summary: string;
  userKey?: string;
  [privateField: string]: unknown;
};

/** Converts authorized storage rows to the intentionally small list response. */
export function listAuthorizedPromptSummaries(
  actor: PromptActor,
  rows: readonly StoredPromptSummary[],
): Array<{
  id: string;
  kind: "system" | "request";
  scope: PromptScope;
  summary: string;
}> {
  return rows
    .filter((row) =>
      isPromptAuthorized({
        actor,
        target: { scope: row.scope, userKey: row.userKey },
        action: "list",
      }),
    )
    .map(({ id, kind, scope, summary }) => ({ id, kind, scope, summary }));
}

export const canAccessPrompt = isPromptAuthorized;

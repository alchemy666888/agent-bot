import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PromptAction, PromptActor, PromptTarget } from "./authorization";
import { isPromptAuthorized } from "./authorization";

export const PROMPT_CONFIRMATION_TTL_MS = 10 * 60_000;
export type ConfirmationStage = "first" | "second";
export type ConfirmationDecision = "yes" | "no";

/** Telegram callback_data contains only this random capability (24 bytes/32 chars). */
export function createConfirmationNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function digestConfirmationNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "ascii").digest("hex");
}

/** Constant-time comparison is retained even though only token digests are stored. */
export function confirmationNonceMatches(
  nonce: string,
  digest: string,
): boolean {
  const actual = Buffer.from(digestConfirmationNonce(nonce), "hex");
  if (!/^[0-9a-f]{64}$/.test(digest)) return false;
  return timingSafeEqual(actual, Buffer.from(digest, "hex"));
}

export function parseConfirmationText(
  text: string,
): ConfirmationDecision | null {
  const normalized = text.normalize("NFKC").trim().toLocaleLowerCase("en");
  if (normalized === "yes" || normalized === "confirm") return "yes";
  if (normalized === "no" || normalized === "cancel") return "no";
  return null;
}

export function parseConfirmationCallback(data: string): {
  decision: ConfirmationDecision;
  nonce: string;
} | null {
  const match = data.match(/^([yn])_([A-Za-z0-9_-]{32})$/);
  return match
    ? { decision: match[1] === "y" ? "yes" : "no", nonce: match[2] }
    : null;
}

export type ConfirmationBinding = {
  actor: PromptActor;
  chatId: string;
  target: PromptTarget;
  operation: Exclude<PromptAction, "read" | "list"> | "disable";
  kind: "system" | "request";
  promptId: string;
  sanitizedSummary: string;
  contentDigest: string;
  baseCommitSha: string;
  baseBlobSha?: string | null;
  baseTreeSha?: string | null;
};

export type PendingConfirmation = ConfirmationBinding & {
  id: string;
  stage: ConfirmationStage;
  state: "pending" | "committing" | "cancelled" | "expired";
  nonceDigest: string;
  expiresAt: Date;
};

export interface ConfirmationStore {
  /** Must cancel another live row for the actor/target or reject atomically. */
  create(record: PendingConfirmation): Promise<void>;
  findByNonceDigest(digest: string): Promise<PendingConfirmation | null>;
  /** Used only for an unambiguous text fallback. */
  findUniquePending(
    actorId: string,
    chatId: string,
  ): Promise<PendingConfirmation | null>;
  cancel(
    id: string,
    reason: "rejected" | "expired" | "conflict",
  ): Promise<boolean>;
  /** CAS first -> second and rotate the nonce digest/expiry in one transaction. */
  advance(
    id: string,
    oldDigest: string,
    newDigest: string,
    expiresAt: Date,
  ): Promise<boolean>;
  /** CAS second -> committing. A false result is an idempotent replay. */
  beginCommit(id: string, digest: string): Promise<boolean>;
}

/** Deterministic adapter for tests and single-process deployments. Production uses PostgreSQL. */
export class InMemoryConfirmationStore implements ConfirmationStore {
  private readonly records = new Map<string, PendingConfirmation>();

  async create(record: PendingConfirmation): Promise<void> {
    for (const candidate of this.records.values()) {
      if (
        candidate.state === "pending" &&
        candidate.actor.canonicalId === record.actor.canonicalId &&
        JSON.stringify(candidate.target) === JSON.stringify(record.target)
      )
        candidate.state = "cancelled";
    }
    this.records.set(record.id, structuredClone(record));
  }

  async findByNonceDigest(digest: string) {
    return (
      [...this.records.values()].find(
        (record) => record.state === "pending" && record.nonceDigest === digest,
      ) ?? null
    );
  }

  async findUniquePending(actorId: string, chatId: string) {
    const matches = [...this.records.values()].filter(
      (record) =>
        record.state === "pending" &&
        record.actor.canonicalId === actorId &&
        record.chatId === chatId,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  async cancel(id: string, reason: "rejected" | "expired" | "conflict") {
    const record = this.records.get(id);
    if (!record || record.state !== "pending") return false;
    record.state = reason === "expired" ? "expired" : "cancelled";
    return true;
  }

  async advance(
    id: string,
    oldDigest: string,
    newDigest: string,
    expiresAt: Date,
  ) {
    const record = this.records.get(id);
    if (
      !record ||
      record.state !== "pending" ||
      record.stage !== "first" ||
      record.nonceDigest !== oldDigest
    )
      return false;
    record.stage = "second";
    record.nonceDigest = newDigest;
    record.expiresAt = expiresAt;
    return true;
  }

  async beginCommit(id: string, digest: string) {
    const record = this.records.get(id);
    if (
      !record ||
      record.state !== "pending" ||
      record.stage !== "second" ||
      record.nonceDigest !== digest
    )
      return false;
    record.state = "committing";
    return true;
  }
}

export type ConfirmationPrompt = {
  text: string;
  buttons: readonly [
    { text: "Yes"; callbackData: string },
    { text: "No"; callbackData: string },
  ];
  expiresAt: Date;
};

function safeSummary(value: string): string {
  const summary = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b[0-9a-f]{40,64}\b/gi, "[version]")
    .replace(/(?:^|\s)(?:[\w.-]+\/)+[\w.-]+/g, " [target]")
    .replace(/\s+/g, " ")
    .trim();
  if (!summary || summary.length > 256)
    throw new TypeError("INVALID_PROMPT_SUMMARY");
  return summary;
}

export function confirmationMessage(
  record: Pick<
    PendingConfirmation,
    "stage" | "operation" | "target" | "sanitizedSummary"
  >,
): string {
  const scope = record.target.scope;
  const behavior = safeSummary(record.sanitizedSummary);
  const history =
    record.operation === "delete"
      ? " Deleting stops its use, but private history remains for audit and recovery."
      : "";
  return record.stage === "first"
    ? `Proposed ${scope} behavior: ${behavior}.${history} Do you want to continue?`
    : `Please confirm again: apply this ${scope} behavior now?${history}`;
}

/** Framework-independent, transactional confirmation coordinator. */
export class PromptConfirmationService {
  constructor(
    private readonly store: ConfirmationStore,
    private readonly options: {
      now?: () => Date;
      ttlMs?: number;
      operatorIds?: ReadonlySet<string>;
      id?: () => string;
    } = {},
  ) {}

  async propose(binding: ConfirmationBinding): Promise<ConfirmationPrompt> {
    this.authorize(binding);
    const nonce = createConfirmationNonce();
    const now = this.options.now?.() ?? new Date();
    const expiresAt = new Date(
      now.getTime() + (this.options.ttlMs ?? PROMPT_CONFIRMATION_TTL_MS),
    );
    const record: PendingConfirmation = {
      ...binding,
      sanitizedSummary: safeSummary(binding.sanitizedSummary),
      id: this.options.id?.() ?? randomBytes(16).toString("hex"),
      stage: "first",
      state: "pending",
      nonceDigest: digestConfirmationNonce(nonce),
      expiresAt,
    };
    await this.store.create(record);
    return this.prompt(record, nonce);
  }

  async respond(input: {
    actor: PromptActor;
    chatId: string;
    decision: ConfirmationDecision;
    nonce?: string;
  }): Promise<{
    status: "cancelled" | "second_confirmation" | "committing" | "ignored";
    prompt?: ConfirmationPrompt;
    action?: PendingConfirmation;
  }> {
    const record = input.nonce
      ? await this.store.findByNonceDigest(digestConfirmationNonce(input.nonce))
      : await this.store.findUniquePending(
          input.actor.canonicalId,
          input.chatId,
        );
    if (!record || record.state !== "pending") return { status: "ignored" };
    const now = this.options.now?.() ?? new Date();
    if (record.expiresAt <= now) {
      await this.store.cancel(record.id, "expired");
      return { status: "cancelled" };
    }
    if (
      record.actor.canonicalId !== input.actor.canonicalId ||
      record.actor.userKey !== input.actor.userKey ||
      record.chatId !== input.chatId
    )
      return { status: "ignored" };
    this.authorize({ ...record, actor: input.actor });
    if (input.decision === "no") {
      await this.store.cancel(record.id, "rejected");
      return { status: "cancelled" };
    }
    if (record.stage === "first") {
      const nonce = createConfirmationNonce();
      const expiresAt = new Date(
        now.getTime() + (this.options.ttlMs ?? PROMPT_CONFIRMATION_TTL_MS),
      );
      if (
        !(await this.store.advance(
          record.id,
          record.nonceDigest,
          digestConfirmationNonce(nonce),
          expiresAt,
        ))
      )
        return { status: "ignored" };
      const next = {
        ...record,
        stage: "second" as const,
        nonceDigest: digestConfirmationNonce(nonce),
        expiresAt,
      };
      return {
        status: "second_confirmation",
        prompt: this.prompt(next, nonce),
      };
    }
    if (!(await this.store.beginCommit(record.id, record.nonceDigest)))
      return { status: "ignored" };
    return { status: "committing", action: { ...record, state: "committing" } };
  }

  private authorize(binding: ConfirmationBinding) {
    const action =
      binding.operation === "disable" ? "update" : binding.operation;
    if (
      !isPromptAuthorized({
        actor: binding.actor,
        target: binding.target,
        action,
        operatorIds: this.options.operatorIds,
      })
    )
      throw new Error("PROMPT_NOT_FOUND");
  }

  private prompt(
    record: PendingConfirmation,
    yesNonce: string,
  ): ConfirmationPrompt {
    return {
      text: confirmationMessage(record),
      buttons: [
        { text: "Yes", callbackData: `y_${yesNonce}` },
        { text: "No", callbackData: `n_${yesNonce}` },
      ],
      expiresAt: record.expiresAt,
    };
  }
}

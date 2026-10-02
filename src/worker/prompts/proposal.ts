import {
  promptChangeProposalSchema,
  type PromptBundle,
  type PromptChangeProposal,
} from "../../shared/contracts/prompt";

/**
 * Accept only an explicit management command carrying a complete proposal.
 * This intentionally does not infer preferences from ordinary requests,
 * model output, tool results, or sensitive facts.
 */
export function detectPromptChangeProposal(
  rawTelegramText: string,
  bundle: Readonly<PromptBundle>,
): PromptChangeProposal | null {
  const match = rawTelegramText.match(/^\s*\/prompt-propose\s+([\s\S]+)$/i);
  if (!match || !bundle.repositoryCommitSha) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  const result = promptChangeProposalSchema.safeParse(candidate);
  if (!result.success) return null;
  // Optimistic concurrency is pinned by the trusted server bundle, never by
  // user text. A mismatch is rejected rather than silently rewritten.
  if (result.data.baseCommitSha !== bundle.repositoryCommitSha) return null;
  return result.data;
}

export const parseExplicitPromptProposal = detectPromptChangeProposal;

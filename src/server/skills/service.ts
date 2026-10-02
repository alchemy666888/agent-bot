import { uuidV7 } from "../../shared/ids";
import type {
  SkillDraft,
  SkillDraftGenerator,
} from "../../worker/skills/types";

const ENGLISH_CREATE_VERBS = new Set([
  "create",
  "make",
  "build",
  "author",
  "generate",
  "install",
]);
const ENGLISH_FILLER = new Set(["me", "a", "an", "new", "custom", "ai"]);
const CHINESE_CREATE_VERBS = [
  "建立",
  "創建",
  "创建",
  "生成",
  "製作",
  "制作",
  "安裝",
  "安装",
] as const;
const CHINESE_SKILL_NOUNS = ["ai skill", "ai技能", "skill", "技能"] as const;
const EXPLANATION_MARKERS = [
  "how to",
  "how do i",
  "how can i",
  "explain how",
  "如何",
  "怎麼",
  "怎么",
  "怎樣",
  "怎样",
  "教學",
  "教学",
] as const;

function isExplanationRequest(normalized: string): boolean {
  return EXPLANATION_MARKERS.some((marker) => normalized.includes(marker));
}

function hasEnglishCreationIntent(normalized: string): boolean {
  const words = normalized.match(/[a-z]+/g) ?? [];
  return words.some((word, index) => {
    if (!ENGLISH_CREATE_VERBS.has(word)) return false;
    let next = index + 1;
    while (next < words.length && ENGLISH_FILLER.has(words[next]!)) next += 1;
    return words[next] === "skill";
  });
}

function hasChineseCreationIntent(normalized: string): boolean {
  // Keep the verb and object in the same short clause. This avoids an
  // unbounded `.*` accidentally joining unrelated statements.
  const clauses = normalized.split(/[。！？!?；;\n]/);
  return clauses.some((clause) =>
    CHINESE_CREATE_VERBS.some((verb) => {
      const verbAt = clause.indexOf(verb);
      if (verbAt < 0) return false;
      return CHINESE_SKILL_NOUNS.some((noun) => {
        const nounAt = clause.indexOf(noun);
        return nounAt >= 0 && Math.abs(nounAt - verbAt) <= 32;
      });
    }),
  );
}

export function isSkillCreationRequest(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase().trim();
  if (!normalized || isExplanationRequest(normalized)) return false;
  return (
    hasEnglishCreationIntent(normalized) || hasChineseCreationIntent(normalized)
  );
}

function list(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(/\s*(?:,|;|\n)\s*/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function field(text: string, names: string[]): string | undefined {
  const alternatives = names
    .map((name) => name.replace(/ /g, "\\s+"))
    .join("|");
  const match = text.match(
    new RegExp(
      `(?:^|\\n)\\s*(?:${alternatives})\\s*:\\s*(.+?)(?=\\n\\s*[A-Za-z][A-Za-z ]{1,30}:|$)`,
      "is",
    ),
  );
  return match?.[1]?.trim();
}

function safeName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

function missing(draft: SkillDraft): string[] {
  const result: string[] = [];
  if (!draft.skillName)
    result.push("What short, hyphenated name should the skill use?");
  if (!draft.intendedTasksDomain)
    result.push(
      "What tasks and domain should this skill handle? Give one or two concrete examples.",
    );
  if (!draft.mustDo.length)
    result.push(
      "What MUST the skill always do? Reply `MUST DO: ...` (use `none` if there are no special rules).",
    );
  if (!draft.mustNotDo.length)
    result.push(
      "What MUST the skill never do? Reply `MUST NOT DO: ...` (use `none` if there are no special rules).",
    );
  if (!draft.betterToDo.length)
    result.push(
      "What is BETTER TO DO when practical? Reply `BETTER TO DO: ...` (use `none` if there is no preference).",
    );
  return result;
}

function clarification(question: string, languageCode?: string): string {
  const language = languageCode?.toLowerCase();
  if (language?.startsWith("zh")) {
    const translated = question.startsWith("What short")
      ? "這個 skill 要使用什麼簡短的英文連字號名稱？"
      : question.startsWith("What tasks")
        ? "這個 skill 要處理哪些任務與領域？請提供一至兩個具體例子。"
        : question.includes("always")
          ? "這個 skill 一定要做什麼？若無特殊規則，請回答「無」。"
          : question.includes("never")
            ? "這個 skill 絕對不能做什麼？若無特殊規則，請回答「無」。"
            : "在可行情況下，這個 skill 最好怎麼做？若無偏好，請回答「無」。";
    return `我正在準備你的 skill，還需要一項資料：\n\n${translated}`;
  }
  return `I’m preparing your skill and need one focused detail:\n\n${question}`;
}

function applyText(draft: SkillDraft, text: string): SkillDraft {
  const named = field(text, ["name", "skill name"]);
  const inferredName = text.match(
    /skill\s+(?:called|named)\s+["']?([a-z0-9][a-z0-9 -]{1,62})/i,
  )?.[1];
  const domain = field(text, [
    "tasks/domain",
    "tasks",
    "domain",
    "intended tasks",
  ]);
  const mustDo = field(text, ["must do"]);
  const mustNot = field(text, ["must not do", "must not"]);
  const better = field(text, ["better to do"]);
  const tools = field(text, ["tools/functions", "tools", "functions"]);
  const next = {
    ...draft,
    skillName:
      named || inferredName
        ? safeName(named ?? inferredName!)
        : draft.skillName,
    intendedTasksDomain: domain ?? draft.intendedTasksDomain,
    mustDo: mustDo === undefined ? draft.mustDo : list(mustDo),
    mustNotDo: mustNot === undefined ? draft.mustNotDo : list(mustNot),
    betterToDo: better === undefined ? draft.betterToDo : list(better),
    requiredToolsFunctions:
      tools === undefined ? draft.requiredToolsFunctions : list(tools),
  };
  // A plain answer is accepted only for the single focused question just asked.
  if (
    !named &&
    !domain &&
    !mustDo &&
    !mustNot &&
    !better &&
    !tools &&
    draft.unresolvedQuestions.length === 1
  ) {
    const question = draft.unresolvedQuestions[0]!;
    if (question.startsWith("What short")) next.skillName = safeName(text);
    else if (question.startsWith("What tasks"))
      next.intendedTasksDomain = text.trim();
    else if (question.includes("MUST the skill always"))
      next.mustDo = list(text);
    else if (question.includes("never do")) next.mustNotDo = list(text);
    else if (question.includes("BETTER TO DO")) next.betterToDo = list(text);
  }
  next.unresolvedQuestions = missing(next);
  return next;
}

export interface SkillAuthoringRepository {
  begin(draft: SkillDraft): Promise<SkillDraft>;
  activeForOwner(ownerTelegramUserId: string): Promise<SkillDraft | undefined>;
  processedUpdate(
    ownerTelegramUserId: string,
    updateId: string,
  ): Promise<SkillDraft | undefined>;
  save(draft: SkillDraft, eventType: string): Promise<SkillDraft>;
  commitRevision(draft: SkillDraft, content: string): Promise<SkillDraft>;
  publish(
    draft: SkillDraft,
  ): Promise<{ number: number; url: string; state: "created" | "merged" }>;
}

export class SkillAuthoringService {
  constructor(
    private readonly repository: SkillAuthoringRepository,
    private readonly generator: SkillDraftGenerator,
  ) {}

  async shouldHandle(userId: string, text: string): Promise<boolean> {
    return (
      isSkillCreationRequest(text) ||
      /^\/skill_/i.test(text.trim()) ||
      Boolean(await this.repository.activeForOwner(userId))
    );
  }

  async handle(
    userId: string,
    text: string,
    updateId: string,
    languageCode?: string,
  ): Promise<string> {
    let draft: SkillDraft | undefined =
      await this.repository.activeForOwner(userId);
    const completed = await this.repository.processedUpdate(userId, updateId);
    if (!draft && completed?.lastResponse) return completed.lastResponse;
    if (draft?.lastProcessedUpdateId === updateId && draft.lastResponse)
      return draft.lastResponse;
    const now = new Date().toISOString();
    if (!draft) {
      if (!isSkillCreationRequest(text))
        return "No active skill draft is available for this Telegram user.";
      draft = await this.repository.begin({
        id: uuidV7(),
        stableId: uuidV7(),
        ownerTelegramUserId: userId,
        skillName: null,
        intendedTasksDomain: null,
        mustDo: [],
        mustNotDo: [],
        betterToDo: [],
        requiredToolsFunctions: [],
        unresolvedQuestions: [],
        draftContent: null,
        revisionNumber: 0,
        status: "clarifying",
        createdAt: now,
        updatedAt: now,
        installedAt: null,
        lastProcessedUpdateId: null,
        lastResponse: null,
        branch: "",
        baseCommitSha: "",
        latestCommitSha: "",
        skillBlobSha: null,
        manifestBlobSha: null,
        contentDigest: null,
        pullRequestNumber: null,
      });
    }

    // An approval event may have been committed just before a worker crash.
    // Installation is an idempotent write, so finish that transition first.
    if (draft.status === "approved") {
      const published = await this.repository.publish(draft);
      const response =
        published.state === "merged"
          ? `Installed skill “${draft.skillName}” revision ${draft.revisionNumber}: pull request #${published.number} is merged into the configured base branch.`
          : `Installed skill “${draft.skillName}” revision ${draft.revisionNumber} by successfully creating pull request #${published.number}: ${published.url}. An operator must merge it into the configured base branch.`;
      await this.repository.save(
        {
          ...draft,
          status: "installed",
          installedAt: now,
          pullRequestNumber: published.number,
          updatedAt: now,
          lastProcessedUpdateId: updateId,
          lastResponse: response,
        },
        "skill_draft.installed",
      );
      return response;
    }

    const approve = text.trim().match(/^\/skill_approve\s+(\d+)$/i);
    if (
      /^\/skill_cancel$/i.test(text.trim()) ||
      /^(?:取消|放棄)(?:這個|目前|當前)?\s*skill(?:\s*草稿)?$/i.test(
        text.trim(),
      )
    ) {
      const response =
        "Skill draft cancelled. Start again whenever you are ready.";
      await this.repository.save(
        {
          ...draft,
          status: "cancelled",
          updatedAt: now,
          lastProcessedUpdateId: updateId,
          lastResponse: response,
        },
        "skill_draft.cancelled",
      );
      return response;
    }
    if (/^\/skill_approve\b/i.test(text.trim()) && !approve) {
      const response = `Approval must name the displayed revision: /skill_approve ${draft.revisionNumber}`;
      await this.repository.save(
        {
          ...draft,
          updatedAt: now,
          lastProcessedUpdateId: updateId,
          lastResponse: response,
        },
        "skill_draft.invalid_approval",
      );
      return response;
    }
    if (approve) {
      const [, revision] = approve;
      const requested = Number(revision);
      if (
        draft.status !== "awaiting_approval" ||
        requested !== draft.revisionNumber ||
        !draft.latestCommitSha ||
        !draft.contentDigest
      ) {
        const response = `That approval is stale or not applicable. Review the current draft ${draft.id}, revision ${draft.revisionNumber}, commit ${draft.latestCommitSha}, digest ${draft.contentDigest}.`;
        await this.repository.save(
          {
            ...draft,
            updatedAt: now,
            lastProcessedUpdateId: updateId,
            lastResponse: response,
          },
          "skill_draft.stale_approval",
        );
        return response;
      }
      draft = await this.repository.save(
        {
          ...draft,
          status: "approved",
          updatedAt: now,
          lastProcessedUpdateId: null,
          lastResponse: null,
        },
        "skill_draft.approved",
      );
      let published;
      try {
        published = await this.repository.publish(draft);
      } catch (error) {
        if ((error as Error).message === "SKILL_REVISION_REQUIRED") {
          const response = `Revision required: the approved branch or commit conflicts with the reviewed revision. Create and approve a new revision; remote changes were not overwritten.`;
          await this.repository.save(
            {
              ...draft,
              status: "revision_requested",
              updatedAt: now,
              lastProcessedUpdateId: updateId,
              lastResponse: response,
            },
            "skill_draft.revision_required",
          );
          return response;
        }
        throw error;
      }
      const response =
        published.state === "merged"
          ? `Installed skill “${draft.skillName}” revision ${draft.revisionNumber}: pull request #${published.number} is merged into the configured base branch.`
          : `Installed skill “${draft.skillName}” revision ${draft.revisionNumber} by successfully creating pull request #${published.number}: ${published.url}. An operator must merge it into the configured base branch.`;
      await this.repository.save(
        {
          ...draft,
          status: "installed",
          installedAt: now,
          pullRequestNumber: published.number,
          updatedAt: now,
          lastProcessedUpdateId: updateId,
          lastResponse: response,
        },
        "skill_draft.installed",
      );
      return response;
    }

    let feedback: string | undefined;
    if (draft.status === "awaiting_approval") {
      feedback = text
        .trim()
        .replace(/^\/skill_revise(?:\s+\d+)?\s*/i, "")
        .trim();
      draft = await this.repository.save(
        { ...draft, status: "revision_requested", updatedAt: now },
        "skill_draft.revision_requested",
      );
    }
    draft = applyText(draft, text);
    if (draft.unresolvedQuestions.length) {
      const response = clarification(
        draft.unresolvedQuestions[0]!,
        languageCode,
      );
      await this.repository.save(
        {
          ...draft,
          status: "clarifying",
          unresolvedQuestions: [draft.unresolvedQuestions[0]!],
          updatedAt: now,
          lastProcessedUpdateId: updateId,
          lastResponse: response,
        },
        "skill_draft.clarification_requested",
      );
      return response;
    }

    draft = await this.repository.save(
      {
        ...draft,
        status: "analyzing",
        updatedAt: now,
        lastProcessedUpdateId: null,
        lastResponse: null,
      },
      "skill_draft.analysis_started",
    );
    const content = await this.generator.generateSkillDraft(draft, feedback);
    draft = await this.repository.commitRevision(draft, content);
    const revisionNumber = draft.revisionNumber;
    draft = await this.repository.save(
      {
        ...draft,
        draftContent: null,
        status: "draft_ready",
        updatedAt: now,
      },
      "skill_draft.draft_ready",
    );
    const response = `${content}\n\nDraft ${draft.id}, revision ${revisionNumber}.\nCommit: ${draft.latestCommitSha}\nDigest: ${draft.contentDigest}\nApprove: /skill_approve ${revisionNumber}\nRevise: send comments (or /skill_revise ${revisionNumber} <comments>)\nCancel: /skill_cancel`;
    await this.repository.save(
      {
        ...draft,
        status: "awaiting_approval",
        updatedAt: now,
        lastProcessedUpdateId: updateId,
        lastResponse: response,
      },
      "skill_draft.awaiting_approval",
    );
    return response;
  }
}

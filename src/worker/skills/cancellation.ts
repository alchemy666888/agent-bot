const EXACT_CANCELLATIONS = new Set([
  "stop",
  "stop it",
  "stop please",
  "please stop",
  "cancel",
  "cancel it",
  "please cancel",
  "abort",
  "quit",
  "never mind",
  "nevermind",
  "no thanks",
  "no thank you",
  "停",
  "停止",
  "取消",
  "放弃",
  "放棄",
  "不要",
  "不要了",
  "不用",
  "不用了",
  "不需要",
  "算了",
  "别",
  "別",
]);

function isEnglishCancellation(compact: string): boolean {
  return (
    /^(?:please )?(?:no )?(?:stop|cancel|abort|quit|never mind)(?: (?:it|this|please|now|creating|creation|generating|generate|the|a|an|ai|skill|skills))*$/.test(
      compact,
    ) ||
    /^(?:please )?(?:no )?(?:do not|dont) (?:create|creating|generate|generating|need|want)(?: (?:a|an|the|ai|skill|skills|this|anymore|now))*$/.test(
      compact,
    )
  );
}

function isChineseCancellation(squeezed: string): boolean {
  if (!squeezed) return false;
  const refusal =
    "(?:停一下|停止|取消|放棄|放弃|不要了|不用了|不需要|不要|不用|別再|别再|別|别|算了|停)";
  const object =
    "(?:再)?(?:幫我|帮我|給我|给我)?(?:生成|建立|創建|创建|製作|制作|安裝|安装)?(?:一個|一个|這個|这个|目前|當前|当前)?(?:ai)?(?:skill|技能)?(?:草稿)?";
  return new RegExp(
    `^(?:請|请)?${refusal}(?:${object})?(?:${refusal}(?:${object})?)*[吧啊呀]?$`,
  ).test(squeezed);
}

/** True when the user is refusing the in-progress skill interview, not answering it. */
export function isSkillCancellationRequest(text: string): boolean {
  const trimmed = text.normalize("NFKC").trim();
  if (!trimmed || [...trimmed].length > 80) return false;
  if (/^\/skill_cancel$/i.test(trimmed)) return true;

  const compact = trimmed
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (EXACT_CANCELLATIONS.has(compact)) return true;
  if (
    /^(?:取消|放棄|放弃)(?:這個|这个|目前|當前|当前)?\s*(?:skill|技能)(?:\s*草稿)?$/.test(
      compact,
    )
  )
    return true;
  if (isEnglishCancellation(compact)) return true;
  return isChineseCancellation(
    trimmed.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""),
  );
}

export function skillCancellationMessage(
  text: string,
  languageCode?: string,
): string {
  const chinese =
    languageCode?.toLowerCase().startsWith("zh") ||
    /\p{Script=Han}/u.test(text);
  return chinese
    ? "已取消 skill 草稿。想再建立時跟我說即可。"
    : "Skill draft cancelled. Start again whenever you are ready.";
}

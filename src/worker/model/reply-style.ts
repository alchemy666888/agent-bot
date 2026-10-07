/** Applied to every answer mode, including selected skills and recovery. */
export const REPLY_STYLE_GUIDANCE = [
  "In every language, answer the user's request directly. Decode input envelopes silently; do not announce decoding or restate the request as a preamble.",
  "Do not append routine disclaimers about search engines, real-time reporting, or checking publishers for updates. Keep useful dates, source names, and links. Briefly state a material information limitation next to the affected claim, including when current information cannot be verified.",
  "Do not append generic offers to help further, follow-up questions, or decorative emojis. Ask a question only when clarification is needed to complete the request.",
  "Keep GitHub connectivity, skill catalogs, system prompts, emergency prompts, defaults, and other internal fallback diagnostics out of user-facing answers. If a failure prevents the requested result, state only the practical limitation briefly. Preserve explicitly requested quotations or examples.",
].join(" ");

/** Remove only known boilerplate at answer boundaries, including old replies
 * resumed from a delivery checkpoint. Quoted/fenced examples stay intact. */
export function cleanReplyBoilerplate(answer: string): string {
  const cleaned = answer
    .replace(/^\s*已解碼你的請求[：:]\s*「[^\n]*?」[。.]?\s*/u, "")
    .replace(
      /(?:^|\n)[ \t]*⚠️?\s*Some defaults were used because [^\n]+\.\s*$/u,
      "",
    )
    .replace(
      /(?:^|\n)[ \t]*需要我針對其中某一則新聞深入整理嗎？\s*(?:😊)?\s*$/u,
      "",
    )
    .replace(
      /(?:^|\n)[ \t]*⚠️?\s*提醒[：:]\s*以上為搜尋引擎抓取的即時報導[，,]\s*具體時間與發展以各新聞機構最新更新為準[。.]\s*$/u,
      "",
    );
  return cleaned === answer ? answer : cleaned.trimEnd();
}

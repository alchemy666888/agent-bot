import { describe, expect, it } from "vitest";
import { cleanReplyBoilerplate } from "../../../../src/worker/model/reply-style";

const prefix = "已解碼你的請求：「香港今天有什麼新聞」。";
const reminder =
  "⚠️ 提醒：以上為搜尋引擎抓取的即時報導，具體時間與發展以各新聞機構最新更新為準。";
const followUp = "需要我針對其中某一則新聞深入整理嗎？😊";
const diagnostics =
  "⚠️ Some defaults were used because the GitHub connection and skill list were unavailable, the configured system prompt was unavailable, the built-in emergency prompt was used.";
const news =
  "香港今天的新聞（10 月 6 日）\n來源：https://news.example/hong-kong";

describe("reply boilerplate", () => {
  it("removes the reported preamble and footer while preserving news and sources", () => {
    const answer = `${prefix}\n${news}\n\n${reminder}\n\n${followUp}\n\n${diagnostics}`;
    expect(cleanReplyBoilerplate(answer)).toBe(news);
    expect(cleanReplyBoilerplate(`${prefix}${news}`)).toBe(news);
  });

  it.each([prefix, reminder, followUp, diagnostics])(
    "leaves no deliverable answer when only boilerplate remains: %s",
    (text) => {
      expect(cleanReplyBoilerplate(text).trim()).toBe("");
    },
  );

  it.each([
    news,
    "目前無法取得最新新聞。",
    "這項消息尚未獲官方證實。\n來源：https://news.example/claim",
    "你想查看香港哪一天的新聞？",
    `原文範例：\n\`\`\`plaintext\n${prefix}\n${reminder}\n${followUp}\n${diagnostics}\n\`\`\``,
    `引用：\n> ${reminder}\n> ${diagnostics}`,
  ])(
    "preserves useful content, necessary questions and quoted examples: %s",
    (text) => {
      expect(cleanReplyBoilerplate(text)).toBe(text);
    },
  );
});

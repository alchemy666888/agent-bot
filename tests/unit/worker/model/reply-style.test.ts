import { describe, expect, it } from "vitest";
import { cleanReplyBoilerplate } from "../../../../src/worker/model/reply-style";

const prefix = "已解碼你的請求：「香港今天有什麼新聞」。";
const reminder =
  "⚠️ 提醒：以上為搜尋引擎抓取的即時報導，具體時間與發展以各新聞機構最新更新為準。";
const followUp = "需要我針對其中某一則新聞深入整理嗎？😊";
const diagnostics =
  "⚠️ Some defaults were used because the GitHub connection and skill list were unavailable, the configured system prompt was unavailable, the built-in emergency prompt was used.";
const news = "香港今天的新聞（10 月 6 日）";
const sourceFooter =
  "來源：ChainCatcher（10月7日淨流出4.87億美元）、Cointelegraph（485M流出）。";

describe("reply boilerplate", () => {
  it("removes the reported preamble and footer while preserving the news", () => {
    const answer = `${prefix}\n${news}\n${sourceFooter}\n\n${reminder}\n\n${followUp}\n\n${diagnostics}`;
    expect(cleanReplyBoilerplate(answer)).toBe(news);
    expect(cleanReplyBoilerplate(`${prefix}${news}`)).toBe(news);
  });

  it("drops a trailing source footer without removing an in-answer source section", () => {
    const body = `${news}\n\n數據來源（可直接查）\nSoSoValue：sosovalue.com`;
    expect(cleanReplyBoilerplate(`${body}\n\n${sourceFooter}`)).toBe(body);
    expect(cleanReplyBoilerplate(`${news}\n${sourceFooter}`)).toBe(news);
    expect(
      cleanReplyBoilerplate(`${news}\nSources: https://news.example`),
    ).toBe(news);
    expect(
      cleanReplyBoilerplate("香港目前晴朗。來源：https://weather.example"),
    ).toBe("香港目前晴朗。");
    expect(cleanReplyBoilerplate(sourceFooter)).toBe(sourceFooter);
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
    "這項消息尚未獲官方證實。",
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

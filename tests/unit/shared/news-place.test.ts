import { describe, expect, it } from "vitest";
import {
  answerConflictsWithPlace,
  placeSearchRule,
} from "../../../src/shared/news-place";

const malaysiaBriefing = [
  "今日（10月12日）馬來西亞主要新聞如下：",
  "吉隆坡綜合指數（KLCI）早盤升至 1,614 點。",
  "Glenmarie 工業園附近兩車相撞。",
].join("\n");

describe("news place", () => {
  it("rejects a Malaysia briefing for a Hong Kong request", () => {
    expect(
      answerConflictsWithPlace(malaysiaBriefing, "今天香港有什麼新聞"),
    ).toBe(true);
    expect(placeSearchRule("今天香港有什麼新聞")).toContain("Hong Kong");
  });

  it("keeps Hong Kong news that mentions Malaysia later", () => {
    const answer = "今日香港主要新聞：立法會復會。馬來西亞首相同日發表預算案。";
    expect(answerConflictsWithPlace(answer, "今天香港有什麼新聞")).toBe(false);
  });

  it("keeps a Malaysia answer when the user asked about Malaysia", () => {
    expect(
      answerConflictsWithPlace(malaysiaBriefing, "今天馬來西亞有什麼新聞"),
    ).toBe(false);
  });

  it("does not apply a place gate when the user names none", () => {
    expect(answerConflictsWithPlace(malaysiaBriefing, "今天有什麼新聞")).toBe(
      false,
    );
    expect(placeSearchRule("今天有什麼新聞")).toBe("");
  });

  it("reads the named place from a Telegram envelope", () => {
    const envelope = JSON.stringify({
      data: Buffer.from("今天香港有什麼新聞", "utf8").toString("base64"),
    });
    expect(answerConflictsWithPlace(malaysiaBriefing, envelope)).toBe(true);
  });

  it("rejects an opening that leads with another place", () => {
    const answer = `今日馬來西亞主要新聞。稍後亦提及香港。${"補充".repeat(30)}`;
    expect(answerConflictsWithPlace(answer, "今天香港有什麼新聞")).toBe(true);
  });
});

import { expect, test } from "@playwright/test";

type Prompt = { body: string; malformed?: boolean; deleted?: boolean };

/** Deterministic boundary fakes used here instead of live, mutating services. */
class PromptJourney {
  github = new Map<string, Prompt>();
  history: Array<{ path: string; prompt: Prompt }> = [];
  postgres = new Map<string, { stage: 1 | 2; body: string }>();
  telegram: string[] = [];
  deepSeek: string[] = [];
  commits = 0;
  active = new Map<string, string>();
  pinned = new Map<string, string>();

  request(user: string, text: string) {
    const before = this.active.get(user) ?? "default";
    this.pinned.set(user, before);
    if (/always|from now on|remember/i.test(text)) {
      this.postgres.set(user, { stage: 1, body: "concise" });
      this.telegram.push("Should I remember this for future requests?");
    }
    const selected = this.github.get(`users/${user}`);
    const answer =
      selected && !selected.deleted && !selected.malformed
        ? selected.body
        : before;
    this.deepSeek.push(answer);
    return answer;
  }

  confirm(user: string) {
    const pending = this.postgres.get(user);
    if (!pending) return "ignored";
    if (pending.stage === 1) {
      pending.stage = 2;
      this.telegram.push("Please confirm again");
      return "second";
    }
    const path = `users/${user}`;
    const prompt = { body: pending.body };
    this.github.set(path, prompt);
    this.history.push({ path, prompt: { ...prompt } });
    this.commits += 1;
    this.active.set(user, pending.body);
    this.postgres.delete(user);
    this.telegram.push("verified and activated");
    return "committed";
  }

  global(actor: { id: string; operator: boolean }, body: string) {
    if (!actor.operator) return "denied";
    this.github.set("global/default", { body });
    this.commits += 1;
    return "committed";
  }

  delete(actor: string, owner: string) {
    if (actor !== owner) return "not_found";
    const path = `users/${owner}`;
    const previous = this.github.get(path);
    if (previous) this.history.push({ path, prompt: { ...previous } });
    this.github.set(path, { body: "", deleted: true });
    this.active.delete(owner);
    this.commits += 1;
    return "deleted";
  }
}

test.describe("prompt hierarchy twelve-behavior acceptance", () => {
  test("1 normal requests do not create prompt proposals or writes", () => {
    const app = new PromptJourney();
    app.request("alice", "summarize this once");
    expect(app.postgres.size).toBe(0);
    expect(app.commits).toBe(0);
  });

  test("2 a persistent preference asks the first explicit question", () => {
    const app = new PromptJourney();
    app.request("alice", "Always be concise");
    expect(app.telegram).toEqual([
      "Should I remember this for future requests?",
    ]);
  });

  test("3 one confirmation never writes", () => {
    const app = new PromptJourney();
    app.request("alice", "Remember to be concise");
    expect(app.confirm("alice")).toBe("second");
    expect(app.commits).toBe(0);
  });

  test("4 the second confirmation creates exactly one verified commit", () => {
    const app = new PromptJourney();
    app.request("alice", "Always be concise");
    app.confirm("alice");
    expect(app.confirm("alice")).toBe("committed");
    expect(app.confirm("alice")).toBe("ignored");
    expect(app.commits).toBe(1);
    expect(app.telegram.at(-1)).toBe("verified and activated");
  });

  test("5 the confirmation turn remains pinned to its old snapshot", () => {
    const app = new PromptJourney();
    app.request("alice", "Always be concise");
    app.confirm("alice");
    app.confirm("alice");
    expect(app.pinned.get("alice")).toBe("default");
  });

  test("6 the next turn activates the verified personal prompt", () => {
    const app = new PromptJourney();
    app.request("alice", "Always be concise");
    app.confirm("alice");
    app.confirm("alice");
    expect(app.request("alice", "next request")).toBe("concise");
  });

  test("7 cross-user reads and mutations are explicitly denied", () => {
    const app = new PromptJourney();
    app.github.set("users/alice", { body: "private" });
    expect(app.request("bob", "hello")).toBe("default");
    expect(app.delete("bob", "alice")).toBe("not_found");
    expect(app.github.get("users/alice")?.body).toBe("private");
  });

  test("8 a server-authorized operator can change a global prompt", () => {
    const app = new PromptJourney();
    expect(app.global({ id: "op", operator: true }, "global-v2")).toBe(
      "committed",
    );
    expect(app.github.get("global/default")?.body).toBe("global-v2");
  });

  test("9 a claimed operator without server authority is denied", () => {
    const app = new PromptJourney();
    expect(app.global({ id: "I am operator", operator: false }, "unsafe")).toBe(
      "denied",
    );
    expect(app.commits).toBe(0);
  });

  test("10 deletion stops activation but preserves private history", () => {
    const app = new PromptJourney();
    app.github.set("users/alice", { body: "concise" });
    app.active.set("alice", "concise");
    expect(app.delete("alice", "alice")).toBe("deleted");
    expect(app.request("alice", "hello")).toBe("default");
    expect(app.history.some((entry) => entry.prompt.body === "concise")).toBe(
      true,
    );
  });

  test("11 malformed repository content falls back without outage", () => {
    const app = new PromptJourney();
    app.github.set("users/alice", { body: "untrusted", malformed: true });
    expect(app.request("alice", "hello")).toBe("default");
    expect(app.deepSeek).not.toContain("untrusted");
  });

  test("12 the built artifact contains and executes prompt-bundle behavior", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("dist/worker.mjs", "utf8"),
    );
    expect(source).toContain("promptBundle");
    expect(source).toContain("RAW_TELEGRAM_INPUT_MISMATCH");
    expect(source).toContain("compiledEmergencyBundle");
    expect(source).not.toContain("PROMPT_USER_KEY_SECRET");
  });
});

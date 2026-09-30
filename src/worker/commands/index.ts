export type SkillAvailability = "available" | "unavailable" | "retired";

export interface InstalledSkill {
  /** Stable name used by /use (display names are not stable identifiers). */
  name: string;
  displayName: string;
  purpose: string;
  version: string;
  availability: SkillAvailability;
  supportedTasks?: readonly string[];
  operatingConstraints?: string;
  /** When present, only these Telegram user IDs may inspect or invoke the skill. */
  authorizedUserIds?: readonly string[];
}

export interface SkillInvocation {
  skill: InstalledSkill;
  request: string;
}

export type CommandResult =
  | { kind: "reply"; text: string }
  | { kind: "invoke"; invocation: SkillInvocation };

export const SKILLS_PAGE_SIZE = 5;

/** Unicode-aware normalization used for every stable skill-name comparison. */
export function normalizeSkillName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function parseCommand(
  text: string,
): { command: string; arguments: string } | undefined {
  const match = text.match(
    /^\s*\/(\w+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*?))?\s*$/u,
  );
  if (!match) return undefined;
  return {
    command: `/${match[1]!.toLocaleLowerCase("en-US")}`,
    arguments: match[2] ?? "",
  };
}

function isAuthorized(skill: InstalledSkill, userId?: string): boolean {
  return (
    !skill.authorizedUserIds ||
    (!!userId && skill.authorizedUserIds.includes(userId))
  );
}

type Resolution =
  | { status: "found"; skill: InstalledSkill }
  | { status: "missing" | "ambiguous" };

export function resolveSkill(
  catalog: readonly InstalledSkill[],
  name: string,
): Resolution {
  const normalized = normalizeSkillName(name);
  const matches = catalog.filter(
    (skill) =>
      normalizeSkillName(skill.name) === normalized ||
      normalizeSkillName(skill.displayName) === normalized,
  );
  if (matches.length === 0) return { status: "missing" };
  // Duplicate normalized names are never resolved by catalog ordering.
  if (matches.length > 1) return { status: "ambiguous" };
  return { status: "found", skill: matches[0]! };
}

function skillsList(
  catalog: readonly InstalledSkill[],
  rawPage: string,
  userId?: string,
): string {
  const page = rawPage === "" ? 1 : Number(rawPage);
  if (!Number.isSafeInteger(page) || page < 1)
    return "Invalid page. Use /skills or /skills <page-number>.";
  if (catalog.length === 0) return "No skills are installed.";
  const pages = Math.ceil(catalog.length / SKILLS_PAGE_SIZE);
  if (page > pages)
    return `Page ${page} does not exist. Skills has ${pages} page${pages === 1 ? "" : "s"}.`;
  const sorted = [...catalog].sort((a, b) =>
    normalizeSkillName(a.name).localeCompare(normalizeSkillName(b.name), "und"),
  );
  const lines = sorted
    .slice((page - 1) * SKILLS_PAGE_SIZE, page * SKILLS_PAGE_SIZE)
    .map((skill) => {
      const availability = isAuthorized(skill, userId)
        ? skill.availability
        : "unavailable";
      return `${skill.displayName} — ${skill.purpose} · v${skill.version} · ${availability} · /skill ${skill.name}`;
    });
  return [
    `Skills (${page}/${pages})`,
    ...lines,
    "Invoke: /use <skill-name> <request>",
  ].join("\n");
}

function resolutionReply(status: "missing" | "ambiguous"): string {
  return status === "ambiguous"
    ? "That skill name is ambiguous. Use the stable name shown by /skills."
    : "Skill not found. Use /skills to see installed skills.";
}

export function handleCommand(
  text: string,
  catalog: readonly InstalledSkill[] = [],
  userId?: string,
): CommandResult | undefined {
  const parsed = parseCommand(text);
  if (!parsed) return undefined;
  if (parsed.command === "/start")
    return {
      kind: "reply",
      text: "Hello! I’m a general-purpose AI assistant. Send me a text message to begin.",
    };
  if (parsed.command === "/help")
    return {
      kind: "reply",
      text: [
        "Send text to chat. Commands: /start, /help, /new.",
        "/skills [page] lists installed, approved skills and availability.",
        "/skill <skill-name> shows supported tasks and operating constraints.",
        "/use <skill-name> <request> explicitly invokes a skill.",
        "Skills are created and versioned by maintainers, require approval before becoming available, and may be restricted or retired.",
      ].join("\n"),
    };
  if (parsed.command === "/new")
    return { kind: "reply", text: "Started a new conversation." };
  if (parsed.command === "/skills")
    return {
      kind: "reply",
      text: skillsList(catalog, parsed.arguments, userId),
    };
  if (parsed.command !== "/skill" && parsed.command !== "/use")
    return undefined;

  const invocation =
    parsed.command === "/use"
      ? parsed.arguments.match(/^(\S+)\s+([\s\S]*\S)$/u)
      : undefined;
  const requestedName =
    parsed.command === "/skill" ? parsed.arguments : invocation?.[1];
  if (!requestedName)
    return {
      kind: "reply",
      text:
        parsed.command === "/use"
          ? "Usage: /use <skill-name> <request>"
          : "Usage: /skill <skill-name>",
    };
  const resolution = resolveSkill(catalog, requestedName);
  if (resolution.status !== "found")
    return { kind: "reply", text: resolutionReply(resolution.status) };
  const skill = resolution.skill;
  if (!isAuthorized(skill, userId))
    return { kind: "reply", text: "You are not authorized to use this skill." };
  if (parsed.command === "/skill")
    return {
      kind: "reply",
      text: [
        `${skill.displayName} (${skill.name})`,
        `Purpose: ${skill.purpose}`,
        `Version: ${skill.version}`,
        `Availability: ${skill.availability}`,
        `Supported tasks: ${skill.supportedTasks?.join("; ") || "Not specified"}`,
        `Operating constraints: ${skill.operatingConstraints || "None specified"}`,
      ].join("\n"),
    };
  if (skill.availability === "retired")
    return {
      kind: "reply",
      text: "This skill has been retired and cannot be invoked.",
    };
  if (skill.availability !== "available")
    return {
      kind: "reply",
      text: "This skill is currently unavailable. Please try again later.",
    };
  return { kind: "invoke", invocation: { skill, request: invocation![2]! } };
}

/** Backwards-compatible deterministic reply API. */
export const commandReply = (command: string): string | undefined => {
  const result = handleCommand(command);
  return result?.kind === "reply" ? result.text : undefined;
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replace(/''/g, "'");
  if (
    ["|", ">", "|-", ">-", "|+", ">+", "~", "null", "''", '""'].includes(
      trimmed,
    )
  )
    return "";
  return trimmed;
}

function unwrapFence(text: string): string {
  for (const match of text.matchAll(
    /```(?:markdown|md|yaml|yml)?[ \t]*\n([\s\S]*?)```/gi,
  )) {
    const inner = match[1]?.trim() ?? "";
    if (/^---[ \t]*\n/.test(inner) || /^name\s*:/m.test(inner)) return inner;
  }
  return text;
}

function splitFrontmatter(text: string): {
  block: string | undefined;
  body: string;
} {
  const match = text.match(/(?:^|\n)---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match || match.index === undefined)
    return { block: undefined, body: text.trim() };
  const after = text.slice(match.index + match[0].length).trim();
  return { block: match[1], body: after };
}

function readDescription(block: string | undefined): string {
  if (!block) return "";
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^description:\s*(.*)$/);
    if (!match) continue;
    const indicator = (match[1] ?? "").trim();
    if (/^(?:\|[+-]?|>[+-]?)$/.test(indicator)) {
      const folded = indicator.startsWith(">");
      const collected: string[] = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor]!;
        if (/^\s+\S/.test(line) || line.trim() === "")
          collected.push(line.trim());
        else break;
      }
      return collected
        .join(folded ? " " : " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    return unquote(indicator);
  }
  return "";
}

function oneLine(value: string, maximum = 500): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

/**
 * Rewrites model-authored SKILL.md so the frontmatter name is the approved
 * skill name and a description is always present. Quoted names, code fences,
 * and folded YAML otherwise fail publication with SKILL_MARKDOWN_MANIFEST_MISMATCH.
 */
export function alignSkillMarkdown(
  content: string,
  skillName: string,
  fallbackDescription: string,
): string {
  const text = unwrapFence(
    content
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .trim(),
  );
  const { block, body } = splitFrontmatter(text);
  const description = oneLine(
    readDescription(block) ||
      fallbackDescription ||
      skillName ||
      "Custom skill",
  );
  const document = body.trim();
  return `---\nname: ${skillName}\ndescription: ${JSON.stringify(description)}\n---\n\n${document}\n`;
}

export function markdownIdentity(content: string): {
  name: string;
  description: string;
} {
  const text = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();
  const block = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/)?.[1];
  const name = unquote(block?.match(/^name:\s*(.*)$/m)?.[1] ?? "");
  const description = unquote(
    block?.match(/^description:\s*(.*)$/m)?.[1] ?? "",
  );
  if (!name || !description)
    throw new Error("SKILL_MARKDOWN_MANIFEST_MISMATCH");
  return { name, description };
}

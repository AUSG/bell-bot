import type { BellCommand } from "../types";

const LEADING_APP_MENTION = /^\s*<@[A-Z0-9]+(?:\|[^>]+)?>\s*/i;
const MEMBER_LIST_SUFFIX = /\s+(목록|list)$/i;
const RESERVED_GROUP_NAMES = new Set(["목록", "list", "도움말", "help"]);

export function normalizeGroupName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function removeLeadingAppMention(text: string): string {
  return text.replace(LEADING_APP_MENTION, "").trim();
}

export function parseBellCommand(text: string): BellCommand {
  const command = normalizeGroupName(decodeSlackText(removeLeadingAppMention(text)));

  if (!command || command === "도움말" || command.toLowerCase() === "help") {
    return { type: "help" };
  }

  if (command === "목록" || command.toLowerCase() === "list") {
    return { type: "list_groups" };
  }

  const listMatch = command.match(MEMBER_LIST_SUFFIX);
  if (listMatch) {
    const groupName = normalizeGroupName(command.slice(0, listMatch.index));
    if (groupName) {
      return { type: "list_members", groupName };
    }
  }

  return { type: "mention_group", groupName: command };
}

export function isReservedGroupName(value: string): boolean {
  const name = normalizeGroupName(value);
  return (
    RESERVED_GROUP_NAMES.has(name.toLowerCase()) ||
    MEMBER_LIST_SUFFIX.test(name)
  );
}

function decodeSlackText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

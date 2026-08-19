import type { BellCommand } from "../types";

const LEADING_APP_MENTION = /^\s*<@[A-Z0-9]+(?:\|[^>]+)?>\s*/i;
const MEMBER_LIST_SUFFIX = /\s+(목록|list)$/i;
const MEMBER_LIST_COMMAND = /^(목록|list)$/i;
const EXPLICIT_GROUP_SEPARATOR = /\s+\|(?:\s+|$)/;
const RESERVED_GROUP_NAMES = new Set(["목록", "list", "도움말", "help"]);

export const MAX_GROUP_NAME_LENGTH = 75;

export function normalizeGroupName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function removeLeadingAppMention(text: string): string {
  return text.replace(LEADING_APP_MENTION, "").trim();
}

export function parseBellCommand(text: string): BellCommand {
  const decoded = decodeSlackText(removeLeadingAppMention(text));
  const { command, allowPrefixMatch } = extractCommandSegment(decoded);

  if (!command || command === "도움말" || command.toLowerCase() === "help") {
    return { type: "help" };
  }

  if (command === "목록" || command.toLowerCase() === "list") {
    return { type: "list_groups" };
  }

  return { type: "group_request", groupText: command, allowPrefixMatch };
}

export function buildGroupNameCandidates(
  groupText: string,
  allowPrefixMatch: boolean,
): string[] {
  const normalized = normalizeGroupName(groupText);
  if (!normalized) {
    return [];
  }

  if (!allowPrefixMatch) {
    return [normalized];
  }

  const prefixes: string[] = [];
  let prefix = "";
  for (const word of normalized.split(" ")) {
    const candidate = prefix ? `${prefix} ${word}` : word;
    if (Array.from(candidate).length > MAX_GROUP_NAME_LENGTH) {
      break;
    }
    prefixes.push(candidate);
    prefix = candidate;
  }

  return prefixes.reverse();
}

export function isMemberListRequest(groupText: string, groupName: string): boolean {
  if (!groupText.startsWith(groupName)) {
    return false;
  }

  const remainder = normalizeGroupName(groupText.slice(groupName.length));
  return MEMBER_LIST_COMMAND.test(remainder);
}

export function isReservedGroupName(value: string): boolean {
  const name = normalizeGroupName(value);
  return (
    RESERVED_GROUP_NAMES.has(name.toLowerCase()) ||
    MEMBER_LIST_SUFFIX.test(name) ||
    EXPLICIT_GROUP_SEPARATOR.test(name)
  );
}

function decodeSlackText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function extractCommandSegment(value: string): {
  command: string;
  allowPrefixMatch: boolean;
} {
  const newlineIndex = value.search(/\r?\n/);
  const firstLine = newlineIndex >= 0 ? value.slice(0, newlineIndex) : value;
  const separator = firstLine.match(EXPLICIT_GROUP_SEPARATOR);
  const commandText = separator?.index === undefined
    ? firstLine
    : firstLine.slice(0, separator.index);

  return {
    command: normalizeGroupName(commandText),
    allowPrefixMatch: newlineIndex < 0 && separator?.index === undefined,
  };
}

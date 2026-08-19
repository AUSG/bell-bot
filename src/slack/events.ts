import { getGroupByName, listGroups } from "../db/groups";
import type { BellCommand, SlackBlock, SlackMessage } from "../types";
import { parseBellCommand } from "./commands";
import { postEphemeral, postMessage } from "./client";

const MAX_SECTION_TEXT_LENGTH = 2_800;
const MAX_HEADER_TEXT_LENGTH = 150;

export interface AppMentionEvent {
  channel: string;
  text: string;
  user: string;
  threadTs?: string;
}

interface CommandResponse extends SlackMessage {
  visibility: "channel" | "ephemeral";
}

export type ParsedEventsRequest =
  | { type: "url_verification"; challenge: string }
  | { type: "app_mention"; event: AppMentionEvent }
  | { type: "ignored" };

export function parseEventsRequest(payload: unknown): ParsedEventsRequest | null {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return null;
  }

  if (payload.type === "url_verification") {
    return typeof payload.challenge === "string"
      ? { type: "url_verification", challenge: payload.challenge }
      : null;
  }

  if (payload.type !== "event_callback" || !isRecord(payload.event)) {
    return { type: "ignored" };
  }

  const event = payload.event;
  if (event.type !== "app_mention" || typeof event.bot_id === "string") {
    return { type: "ignored" };
  }
  if (
    typeof event.channel !== "string" ||
    typeof event.text !== "string" ||
    typeof event.user !== "string"
  ) {
    return null;
  }

  return {
    type: "app_mention",
    event: {
      channel: event.channel,
      text: event.text,
      user: event.user,
      ...(typeof event.thread_ts === "string" ? { threadTs: event.thread_ts } : {}),
    },
  };
}

export async function handleAppMention(event: AppMentionEvent, env: Env): Promise<void> {
  const command = parseBellCommand(event.text);
  const message = await buildCommandMessage(command, env.DB);
  const options = {
    channel: event.channel,
    text: message.text,
    blocks: message.blocks,
    ...(event.threadTs ? { threadTs: event.threadTs } : {}),
  };

  if (message.visibility === "channel") {
    await postMessage(env, options);
  } else {
    await postEphemeral(env, { ...options, user: event.user });
  }
}

export async function buildCommandMessage(
  command: BellCommand,
  db: D1Database,
): Promise<CommandResponse> {
  if (command.type === "help") {
    return helpMessage();
  }

  if (command.type === "list_groups") {
    const groups = await listGroups(db);
    if (groups.length === 0) {
      const body =
        "아직 등록된 그룹이 없어요.\n\n`/bell` 또는 `Bell 그룹 관리` 바로가기에서 첫 그룹을 만들 수 있어요.";
      return sectionMessage("🔔 등록된 그룹", body, `🔔 등록된 그룹\n\n${body}`);
    }

    const lines = groups.map(
      (group) => `• ${escapeMrkdwn(group.name)} — ${group.memberCount}명`,
    );
    return multiSectionMessage(
      "🔔 등록된 그룹",
      chunkLines(lines),
      `🔔 등록된 그룹\n\n${lines.join("\n")}`,
    );
  }

  const group = await getGroupByName(db, command.groupName);
  if (!group) {
    const displayName = inlineCode(command.groupName);
    const body = `${displayName} 그룹을 찾지 못했어요.\n\n\`@Bell 목록\`으로 등록된 그룹을 확인할 수 있어요.`;
    return sectionMessage("🔔 Bell", body, `🔔 ${body}`);
  }

  const mentions = group.members.filter(isSlackUserId).map((userId) => `<@${userId}>`);
  const fallbackGroupName = escapeMrkdwn(group.name);
  if (mentions.length === 0) {
    const text = `🔔 ${fallbackGroupName}에는 아직 등록된 멤버가 없어요.`;
    return sectionMessage(
      `🔔 ${group.name}`,
      "아직 등록된 멤버가 없어요.",
      text,
    );
  }

  if (command.type === "list_members") {
    const header = `🔔 ${group.name} · ${mentions.length}명`;
    const fallbackHeader = `🔔 ${fallbackGroupName} · ${mentions.length}명`;
    return multiSectionMessage(
      header,
      chunkTokens(mentions),
      `${fallbackHeader}\n\n${mentions.join(" ")}`,
    );
  }

  return groupMentionMessage(group.name, mentions);
}

export function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]{2,}$/.test(value);
}

function helpMessage(): CommandResponse {
  const body = [
    "`@Bell [그룹명]`\n그룹의 모든 멤버를 호출합니다.",
    "`@Bell 목록`\n등록된 그룹을 확인합니다.",
    "`@Bell [그룹명] 목록`\n해당 그룹의 구성원을 확인합니다.",
    "`/bell` 또는 `Bell 그룹 관리` 바로가기\n그룹을 관리합니다.",
  ].join("\n\n");

  return sectionMessage("🔔 Bell 사용법", body, `🔔 Bell 사용법\n\n${body}`);
}

function sectionMessage(header: string, body: string, fallback: string): CommandResponse {
  return multiSectionMessage(header, [body], fallback);
}

function multiSectionMessage(
  header: string,
  sections: readonly string[],
  fallback: string,
): CommandResponse {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: truncate(header, MAX_HEADER_TEXT_LENGTH), emoji: true },
    },
    ...sections.map(
      (text): SlackBlock => ({
        type: "section",
        text: { type: "mrkdwn", text },
      }),
    ),
  ];

  return { text: fallback, blocks, visibility: "ephemeral" };
}

function groupMentionMessage(
  groupName: string,
  mentions: readonly string[],
): CommandResponse {
  const displayName = escapeMrkdwn(groupName);
  const memberText = mentions.join(" ");

  return {
    text: `🔔 ${displayName} — ${memberText}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `:bell: *${displayName}* — ${memberText}` },
      },
    ],
    visibility: "channel",
  };
}

function chunkLines(lines: readonly string[]): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_SECTION_TEXT_LENGTH && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function chunkTokens(tokens: readonly string[]): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length > MAX_SECTION_TEXT_LENGTH && current) {
      chunks.push(current);
      current = token;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function inlineCode(value: string): string {
  return `\`${escapeMrkdwn(value).replaceAll("`", "'")}\``;
}

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

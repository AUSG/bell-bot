import { getLongestMatchingGroup, listGroups } from "../db/groups";
import type { BellCommand, SlackBlock, SlackMessage } from "../types";
import {
  buildGroupNameCandidates,
  isMemberListRequest,
  parseBellCommand,
} from "./commands";
import { postEphemeral, postMessage } from "./client";

const MAX_SECTION_TEXT_LENGTH = 2_800;
const MAX_HEADER_TEXT_LENGTH = 150;
const MAX_GROUP_QUERY_DISPLAY_LENGTH = 75;

export interface AppMentionEvent {
  channel: string;
  messageTs: string;
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
    typeof event.ts !== "string" ||
    typeof event.text !== "string" ||
    typeof event.user !== "string"
  ) {
    return null;
  }

  return {
    type: "app_mention",
    event: {
      channel: event.channel,
      messageTs: event.ts,
      text: event.text,
      user: event.user,
      ...(typeof event.thread_ts === "string" ? { threadTs: event.thread_ts } : {}),
    },
  };
}

export async function handleAppMention(event: AppMentionEvent, env: Env): Promise<void> {
  const command = parseBellCommand(event.text);
  const message = await buildCommandMessage(command, env.DB);
  const baseOptions = {
    channel: event.channel,
    text: message.text,
    blocks: message.blocks,
  };

  if (message.visibility === "channel") {
    await postMessage(env, {
      ...baseOptions,
      threadTs: event.threadTs ?? event.messageTs,
    });
  } else {
    await postEphemeral(env, {
      ...baseOptions,
      user: event.user,
      // Slack only displays threaded ephemeral messages in an existing thread.
      ...(event.threadTs ? { threadTs: event.threadTs } : {}),
    });
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

  const group = await getLongestMatchingGroup(
    db,
    buildGroupNameCandidates(command.groupText, command.allowPrefixMatch),
  );
  if (!group) {
    const displayName = inlineCode(truncateWithEllipsis(
      command.groupText,
      MAX_GROUP_QUERY_DISPLAY_LENGTH,
    ));
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

  if (isMemberListRequest(command.groupText, group.name)) {
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
  const sections = [
    [
      "*그룹 호출 · 스레드 공개*",
      "`@Bell 행사팀`",
      "행사팀의 모든 멤버를 호출 메시지의 댓글에서 실제 멘션해 알림을 보냅니다. 새 글에서 호출해도 Bell이 별도의 채널 글을 만들지 않고 해당 글의 첫 댓글로 답해요.",
    ].join("\n"),
    [
      "*공지 본문과 함께 호출*",
      "`@Bell 행사팀 오늘 3시에 모여주세요`",
      "```@Bell 행사팀 오늘 3시에 모여주세요\n장소는 회의실입니다```",
      "```@Bell 행사팀\n오늘 3시에 모여주세요```",
      "`@Bell 행사팀 | 오늘 3시에 모여주세요`",
      "Bell은 첫 줄만 명령으로 읽습니다. 첫 줄에 본문이 함께 있어도 그 앞부분과 일치하는 등록 그룹 중 가장 긴 이름을 사용해요. 예를 들어 `AUSG`와 `AUSG 운영진`이 모두 있으면 `AUSG 운영진`을 선택합니다.",
      "둘째 줄부터는 그룹 조회에 포함하지 않습니다. 첫 줄의 그룹명 경계를 확실히 지정하려면 공백을 포함한 ` | ` 구분자를 사용하세요. 본문은 원래 메시지에 남고 Bell은 멘션 한 줄만 추가합니다.",
    ].join("\n"),
    [
      "*그룹 조회 · 요청자에게만 표시*",
      "`@Bell 목록` 또는 `@Bell list` — 등록된 전체 그룹",
      "`@Bell 행사팀 목록` 또는 `@Bell 행사팀 list` — 행사팀 구성원",
      "그룹명 뒤의 나머지가 정확히 `목록` 또는 `list`일 때만 구성원 조회로 처리합니다. 조회 결과, 도움말, 오류 안내는 요청한 사람에게만 보여요.",
    ].join("\n"),
    [
      "*그룹 관리*",
      "`/bell` 또는 `Bell 그룹 관리` 바로가기에서 생성·이름 변경·멤버 변경·삭제를 할 수 있습니다.",
      "`/bell`은 Slack 제한으로 스레드에서 실행되지 않습니다. 스레드에서는 작성기 바로가기 메뉴에서 `그룹 관리` 또는 `그룹관리`를 검색하세요.",
    ].join("\n"),
  ];
  const fallback = `🔔 Bell 사용법\n\n${sections.join("\n\n")}`;

  return multiSectionMessage("🔔 Bell 사용법", sections, fallback);
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

function truncateWithEllipsis(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) {
    return value;
  }
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

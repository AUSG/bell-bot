import {
  createGroup,
  deleteGroup,
  getGroupManagerSnapshot,
  GroupLimitReachedError,
  GroupNameConflictError,
  GroupNotFoundError,
  MAX_MANAGED_GROUPS,
  updateGroup,
} from "../db/groups";
import type { Group, GroupIdentity, SlackBlock, SlackModalView, SlackOption } from "../types";
import { isReservedGroupName, normalizeGroupName } from "./commands";
import { openModal, updateModal } from "./client";
import { isSlackUserId } from "./events";

export const GROUP_FORM_CALLBACK_ID = "bell_group_form";
export const GROUP_SELECT_ACTION_ID = "bell_group_select";
export const GROUP_DELETE_ACTION_ID = "bell_group_delete";
export const GROUP_NAME_BLOCK_ID = "group_name";
export const GROUP_NAME_ACTION_ID = "group_name_value";
export const GROUP_MEMBERS_BLOCK_ID = "group_members";
export const GROUP_MEMBERS_ACTION_ID = "group_members_value";

const NEW_GROUP_OPTION_VALUE = "new";
const GROUP_OPTION_PREFIX = "group:";
const MAX_GROUP_NAME_LENGTH = 75;
const MAX_GROUP_MEMBERS = 100;

export type GroupFormMetadata =
  | { mode: "create" }
  | { mode: "edit"; groupId: number };

export interface GroupFormFieldIds {
  nameBlockId: string;
  nameActionId: string;
  membersBlockId: string;
  membersActionId: string;
}

interface BlockActionPayload {
  actionId: string;
  value: string;
  viewId: string;
  hash?: string;
}

interface GroupFormSubmission {
  metadata: GroupFormMetadata;
  fields: GroupFormFieldIds;
  name: string;
  members: string[];
}

export async function openGroupManager(triggerId: string, env: Env): Promise<void> {
  const snapshot = await getGroupManagerSnapshot(
    env.DB,
    MAX_MANAGED_GROUPS + 1,
  );
  await openModal(
    env,
    triggerId,
    buildGroupManagerView(snapshot.groups, snapshot.selectedGroup),
  );
}

export async function handleInteraction(
  payload: unknown,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return new Response("Invalid interaction payload", { status: 400 });
  }

  if (payload.type === "block_actions") {
    const action = parseBlockAction(payload);
    if (!action) {
      return new Response("Invalid block action", { status: 400 });
    }

    if (action.actionId === GROUP_SELECT_ACTION_ID) {
      ctx.waitUntil(
        updateSelectedGroup(action, env).catch((error: unknown) => {
          logError("update_group_modal", error);
        }),
      );
    } else if (action.actionId === GROUP_DELETE_ACTION_ID) {
      ctx.waitUntil(
        removeSelectedGroup(action, env).catch((error: unknown) => {
          logError("delete_group", error);
        }),
      );
    }

    return new Response(null, { status: 200 });
  }

  if (payload.type === "view_submission") {
    return handleViewSubmission(payload, env);
  }

  return new Response(null, { status: 200 });
}

export function buildGroupManagerView(
  groups: readonly GroupIdentity[],
  selectedGroup: Group | null,
): SlackModalView {
  const metadata: GroupFormMetadata = selectedGroup
    ? { mode: "edit", groupId: selectedGroup.id }
    : { mode: "create" };
  const fields = groupFormFieldIds(metadata);
  const newGroupOption: SlackOption = {
    text: plainText("새 그룹 만들기"),
    value: NEW_GROUP_OPTION_VALUE,
  };
  const atGroupLimit = groups.length >= MAX_MANAGED_GROUPS;
  const includeNewGroupOption = !atGroupLimit || selectedGroup === null;
  const visibleGroupLimit = includeNewGroupOption
    ? MAX_MANAGED_GROUPS
    : MAX_MANAGED_GROUPS + 1;
  const groupOptions = groups.slice(0, visibleGroupLimit).map(
    (group): SlackOption => ({
      text: plainText(truncate(group.name, MAX_GROUP_NAME_LENGTH)),
      value: `${GROUP_OPTION_PREFIX}${group.id}`,
    }),
  );
  const options = includeNewGroupOption
    ? [newGroupOption, ...groupOptions]
    : groupOptions;
  const selectedOption = selectedGroup
    ? (options.find((option) => option.value === `${GROUP_OPTION_PREFIX}${selectedGroup.id}`) ??
      options[0] ??
      newGroupOption)
    : newGroupOption;

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: selectedGroup
          ? "수정할 그룹을 고르거나 새 그룹을 만들 수 있어요."
          : "새 그룹의 이름과 멤버를 입력해 주세요.",
      },
      accessory: {
        type: "static_select",
        action_id: GROUP_SELECT_ACTION_ID,
        placeholder: plainText("그룹 선택"),
        options,
        initial_option: selectedOption,
      },
    },
    ...(atGroupLimit
      ? [
          {
            type: "context" as const,
            elements: [
              {
                type: "mrkdwn" as const,
                text: `Bell은 그룹을 최대 ${MAX_MANAGED_GROUPS}개까지 관리해요. 새 그룹을 만들려면 기존 그룹을 삭제해 주세요.`,
              },
            ],
          },
        ]
      : []),
    {
      type: "input",
      block_id: fields.nameBlockId,
      label: plainText("그룹 이름"),
      element: {
        type: "plain_text_input",
        action_id: fields.nameActionId,
        placeholder: plainText("예: 10기 운영진"),
        ...(selectedGroup ? { initial_value: selectedGroup.name } : {}),
      },
    },
    {
      type: "input",
      block_id: fields.membersBlockId,
      label: plainText("멤버"),
      optional: true,
      element: {
        type: "multi_users_select",
        action_id: fields.membersActionId,
        placeholder: plainText("Slack 사용자 선택"),
        max_selected_items: MAX_GROUP_MEMBERS,
        ...(selectedGroup?.members.length ? { initial_users: selectedGroup.members } : {}),
      },
    },
  ];

  if (selectedGroup) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: "이 그룹을 더 이상 사용하지 않나요?" },
        accessory: {
          type: "button",
          action_id: GROUP_DELETE_ACTION_ID,
          text: plainText("그룹 삭제"),
          value: String(selectedGroup.id),
          style: "danger",
          confirm: {
            title: plainText("그룹 삭제"),
            text: plainText(`정말 '${selectedGroup.name}' 그룹을 삭제할까요?`),
            confirm: plainText("삭제"),
            deny: plainText("취소"),
            style: "danger",
          },
        },
      },
    );
  }

  return {
    type: "modal",
    callback_id: GROUP_FORM_CALLBACK_ID,
    private_metadata: JSON.stringify(metadata),
    title: plainText("🔔 Bell 그룹 관리"),
    submit: plainText("저장"),
    close: plainText("취소"),
    blocks,
  };
}

export function groupFormFieldIds(metadata: GroupFormMetadata): GroupFormFieldIds {
  const suffix = metadata.mode === "create" ? "new" : String(metadata.groupId);
  return {
    nameBlockId: `${GROUP_NAME_BLOCK_ID}_${suffix}`,
    nameActionId: `${GROUP_NAME_ACTION_ID}_${suffix}`,
    membersBlockId: `${GROUP_MEMBERS_BLOCK_ID}_${suffix}`,
    membersActionId: `${GROUP_MEMBERS_ACTION_ID}_${suffix}`,
  };
}

async function updateSelectedGroup(action: BlockActionPayload, env: Env): Promise<void> {
  const selectedGroupId = parseGroupOption(action.value);
  if (selectedGroupId === undefined) {
    return;
  }

  const snapshot = await getGroupManagerSnapshot(
    env.DB,
    MAX_MANAGED_GROUPS + 1,
    selectedGroupId,
  );

  await updateModal(env, {
    viewId: action.viewId,
    view: buildGroupManagerView(snapshot.groups, snapshot.selectedGroup),
    ...(action.hash ? { hash: action.hash } : {}),
  });
}

async function removeSelectedGroup(action: BlockActionPayload, env: Env): Promise<void> {
  const groupId = parsePositiveInteger(action.value);
  if (groupId === null) {
    return;
  }

  await deleteGroup(env.DB, groupId);
  const snapshot = await getGroupManagerSnapshot(
    env.DB,
    MAX_MANAGED_GROUPS + 1,
  );

  await updateModal(env, {
    viewId: action.viewId,
    view: buildGroupManagerView(snapshot.groups, snapshot.selectedGroup),
    ...(action.hash ? { hash: action.hash } : {}),
  });
}

async function handleViewSubmission(
  payload: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  if (!isRecord(payload.view) || payload.view.callback_id !== GROUP_FORM_CALLBACK_ID) {
    return new Response(null, { status: 200 });
  }

  const metadata =
    typeof payload.view.private_metadata === "string"
      ? parseMetadata(payload.view.private_metadata)
      : null;
  if (!metadata) {
    return new Response("Invalid view metadata", { status: 400 });
  }

  const fields = groupFormFieldIds(metadata);
  const submission = parseGroupFormSubmission(payload.view, metadata, fields);
  if (!submission) {
    return modalErrors({
      [fields.nameBlockId]: "입력값을 읽지 못했어요. 모달을 다시 열어 주세요.",
    });
  }

  const validationErrors = validateGroupForm(submission);
  if (Object.keys(validationErrors).length > 0) {
    return modalErrors(validationErrors);
  }

  try {
    if (submission.metadata.mode === "create") {
      await createGroup(env.DB, submission.name, submission.members);
    } else {
      await updateGroup(
        env.DB,
        submission.metadata.groupId,
        submission.name,
        submission.members,
      );
    }
  } catch (error: unknown) {
    if (error instanceof GroupNameConflictError) {
      return modalErrors({
        [submission.fields.nameBlockId]: "이미 같은 이름의 그룹이 있어요.",
      });
    }
    if (error instanceof GroupLimitReachedError) {
      return modalErrors({
        [submission.fields.nameBlockId]:
          `그룹은 최대 ${MAX_MANAGED_GROUPS}개까지 만들 수 있어요.`,
      });
    }
    if (error instanceof GroupNotFoundError) {
      return modalErrors({
        [submission.fields.nameBlockId]:
          "이 그룹이 이미 삭제되었어요. 모달을 다시 열어 주세요.",
      });
    }

    logError("save_group", error);
    return modalErrors({
      [submission.fields.nameBlockId]: "저장 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.",
    });
  }

  return new Response(null, { status: 200 });
}

function parseBlockAction(payload: Record<string, unknown>): BlockActionPayload | null {
  if (!Array.isArray(payload.actions) || !isRecord(payload.view)) {
    return null;
  }

  const action: unknown = payload.actions[0];
  if (
    !isRecord(action) ||
    typeof action.action_id !== "string" ||
    typeof payload.view.id !== "string"
  ) {
    return null;
  }

  let value: string | null = null;
  if (typeof action.value === "string") {
    value = action.value;
  } else if (isRecord(action.selected_option) && typeof action.selected_option.value === "string") {
    value = action.selected_option.value;
  }

  if (value === null) {
    return null;
  }

  return {
    actionId: action.action_id,
    value,
    viewId: payload.view.id,
    ...(typeof payload.view.hash === "string" ? { hash: payload.view.hash } : {}),
  };
}

function parseGroupFormSubmission(
  view: Record<string, unknown>,
  metadata: GroupFormMetadata,
  fields: GroupFormFieldIds,
): GroupFormSubmission | null {
  if (!isRecord(view.state) || !isRecord(view.state.values)) {
    return null;
  }

  const nameAction = getStateAction(
    view.state.values,
    fields.nameBlockId,
    fields.nameActionId,
  );
  const membersAction = getStateAction(
    view.state.values,
    fields.membersBlockId,
    fields.membersActionId,
  );
  if (!nameAction || !membersAction) {
    return null;
  }

  const rawName = typeof nameAction.value === "string" ? nameAction.value : "";
  const selectedUsers = Array.isArray(membersAction.selected_users)
    ? membersAction.selected_users.filter((value): value is string => typeof value === "string")
    : [];

  return {
    metadata,
    fields,
    name: normalizeGroupName(rawName),
    members: [...new Set(selectedUsers)],
  };
}

function getStateAction(
  values: Record<string, unknown>,
  blockId: string,
  actionId: string,
): Record<string, unknown> | null {
  const block = values[blockId];
  if (!isRecord(block)) {
    return null;
  }
  const action = block[actionId];
  return isRecord(action) ? action : null;
}

function validateGroupForm(submission: GroupFormSubmission): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!submission.name) {
    errors[submission.fields.nameBlockId] = "그룹 이름을 입력해 주세요.";
  } else if (Array.from(submission.name).length > MAX_GROUP_NAME_LENGTH) {
    errors[submission.fields.nameBlockId] =
      `그룹 이름은 ${MAX_GROUP_NAME_LENGTH}자 이하로 입력해 주세요.`;
  } else if (isReservedGroupName(submission.name)) {
    errors[submission.fields.nameBlockId] =
      "Bell 명령으로 사용되는 이름은 그룹명으로 저장할 수 없어요.";
  }

  if (submission.members.length > MAX_GROUP_MEMBERS) {
    errors[submission.fields.membersBlockId] =
      `멤버는 최대 ${MAX_GROUP_MEMBERS}명까지 선택할 수 있어요.`;
  } else if (submission.members.some((member) => !isSlackUserId(member))) {
    errors[submission.fields.membersBlockId] =
      "올바르지 않은 Slack 사용자 ID가 포함되어 있어요.";
  }
  return errors;
}

function parseMetadata(value: string): GroupFormMetadata | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.mode !== "string") {
      return null;
    }
    if (parsed.mode === "create") {
      return { mode: "create" };
    }
    if (parsed.mode === "edit" && typeof parsed.groupId === "number") {
      const groupId = parsePositiveInteger(String(parsed.groupId));
      return groupId === null ? null : { mode: "edit", groupId };
    }
    return null;
  } catch {
    return null;
  }
}

function parseGroupOption(value: string): number | null | undefined {
  if (value === NEW_GROUP_OPTION_VALUE) {
    return null;
  }
  if (!value.startsWith(GROUP_OPTION_PREFIX)) {
    return undefined;
  }
  return parsePositiveInteger(value.slice(GROUP_OPTION_PREFIX.length)) ?? undefined;
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function modalErrors(errors: Record<string, string>): Response {
  return Response.json({ response_action: "errors", errors });
}

function plainText(text: string): { type: "plain_text"; text: string; emoji: true } {
  return { type: "plain_text", text, emoji: true };
}

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

function logError(operation: string, error: unknown): void {
  console.error(
    JSON.stringify({
      message: "Slack interaction failed",
      operation,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

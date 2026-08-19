import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createGroup,
  getGroupByName,
  MAX_MANAGED_GROUPS,
} from "../src/db/groups";
import {
  buildGroupManagerView,
  GROUP_FORM_CALLBACK_ID,
  groupFormFieldIds,
  handleInteraction,
  type GroupFormMetadata,
} from "../src/slack/interactions";

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM "groups"').run();
});

describe("group management modal", () => {
  it("uses Slack's multi-user selector", () => {
    const view = buildGroupManagerView([], null);
    expect(JSON.stringify(view)).toContain('"type":"multi_users_select"');
    expect(view.private_metadata).toBe('{"mode":"create"}');
  });

  it("adds a deletion confirmation for existing groups", () => {
    const view = buildGroupManagerView(
      [{ id: 1, name: "10기 운영진" }],
      { id: 1, name: "10기 운영진", members: ["U123ABC"] },
    );
    const serialized = JSON.stringify(view);
    expect(serialized).toContain('"style":"danger"');
    expect(serialized).toContain("정말 '10기 운영진' 그룹을 삭제할까요?");
  });

  it("changes input IDs when switching groups so Slack loads the new values", () => {
    const createFields = groupFormFieldIds({ mode: "create" });
    const firstGroupFields = groupFormFieldIds({ mode: "edit", groupId: 1 });
    const secondGroupFields = groupFormFieldIds({ mode: "edit", groupId: 2 });

    expect(firstGroupFields).not.toEqual(createFields);
    expect(secondGroupFields).not.toEqual(firstGroupFields);
  });

  it("creates a group from a modal submission", async () => {
    const response = await handleInteraction(
      submissionPayload({ mode: "create" }, "  11기   운영진 ", ["U123ABC", "U456DEF"]),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    const group = await getGroupByName(env.DB, "11기 운영진");
    expect(group?.name).toBe("11기 운영진");
    expect(group?.members).toEqual(["U123ABC", "U456DEF"]);
    expect(typeof group?.id).toBe("number");
  });

  it("updates a group from a modal submission", async () => {
    await createGroup(env.DB, "기존 그룹", ["U123ABC"]);
    const group = await getGroupByName(env.DB, "기존 그룹");
    expect(group).not.toBeNull();
    if (!group) {
      throw new Error("Expected an existing group");
    }

    const response = await handleInteraction(
      submissionPayload({ mode: "edit", groupId: group.id }, "변경 그룹", ["U456DEF"]),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await getGroupByName(env.DB, "기존 그룹")).toBeNull();
    expect(await getGroupByName(env.DB, "변경 그룹")).toEqual({
      id: group.id,
      name: "변경 그룹",
      members: ["U456DEF"],
    });
  });

  it("returns an inline error for a duplicate name", async () => {
    await createGroup(env.DB, "회장단", []);
    const response = await handleInteraction(
      submissionPayload({ mode: "create" }, "회장단", []),
      env,
      createExecutionContext(),
    );
    const body: unknown = await response.json();

    expect(body).toEqual({
      response_action: "errors",
      errors: {
        [groupFormFieldIds({ mode: "create" }).nameBlockId]:
          "이미 같은 이름의 그룹이 있어요.",
      },
    });
  });

  it.each(["목록", "HELP", "행사 TF 목록", "행사 TF list"])(
    "rejects a group name that would be parsed as a command: %s",
    async (name) => {
      const metadata: GroupFormMetadata = { mode: "create" };
      const response = await handleInteraction(
        submissionPayload(metadata, name, []),
        env,
        createExecutionContext(),
      );

      await expect(response.json()).resolves.toEqual({
        response_action: "errors",
        errors: {
          [groupFormFieldIds(metadata).nameBlockId]:
            "Bell 명령으로 사용되는 이름은 그룹명으로 저장할 수 없어요.",
        },
      });
    },
  );

  it("does not split an emoji when truncating a static-select option", () => {
    const name = `${"a".repeat(74)}😀b`;
    const view = buildGroupManagerView(
      [{ id: 1, name }],
      { id: 1, name, members: [] },
    );
    const groupSelector = view.blocks[0];
    if (
      groupSelector?.type !== "section" ||
      groupSelector.accessory?.type !== "static_select"
    ) {
      throw new Error("Expected a static group selector");
    }
    const option = groupSelector.accessory.options.find(
      (candidate) => candidate.value === "group:1",
    );

    expect(option?.text.text).toBe(`${"a".repeat(74)}😀`);
    expect(option?.text.text).not.toContain("�");
  });

  it("hides new-group selection after reaching the modal limit", () => {
    const groups = Array.from({ length: MAX_MANAGED_GROUPS }, (_, index) => ({
      id: index + 1,
      name: `그룹 ${index + 1}`,
    }));
    const selected = { ...groups[0]!, members: [] };
    const view = buildGroupManagerView(groups, selected);
    const serialized = JSON.stringify(view);

    expect(serialized).not.toContain("새 그룹 만들기");
    expect(serialized).toContain(`그룹을 최대 ${MAX_MANAGED_GROUPS}개까지 관리`);
  });

  it("returns an inline error for a stale create modal after reaching the limit", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1
         FROM sequence
         WHERE value < ?
       )
       INSERT INTO "groups" (name)
       SELECT printf('그룹 %03d', value)
       FROM sequence`,
    )
      .bind(MAX_MANAGED_GROUPS)
      .run();
    const metadata: GroupFormMetadata = { mode: "create" };

    const response = await handleInteraction(
      submissionPayload(metadata, "한도 초과", []),
      env,
      createExecutionContext(),
    );

    await expect(response.json()).resolves.toEqual({
      response_action: "errors",
      errors: {
        [groupFormFieldIds(metadata).nameBlockId]:
          `그룹은 최대 ${MAX_MANAGED_GROUPS}개까지 만들 수 있어요.`,
      },
    });
  });

  it("returns an inline error when an edited group was already deleted", async () => {
    const metadata: GroupFormMetadata = { mode: "edit", groupId: 999_999 };
    const response = await handleInteraction(
      submissionPayload(metadata, "삭제된 그룹", []),
      env,
      createExecutionContext(),
    );

    await expect(response.json()).resolves.toEqual({
      response_action: "errors",
      errors: {
        [groupFormFieldIds(metadata).nameBlockId]:
          "이 그룹이 이미 삭제되었어요. 모달을 다시 열어 주세요.",
      },
    });
  });
});

function submissionPayload(
  metadata: GroupFormMetadata,
  name: string,
  members: string[],
): Record<string, unknown> {
  const fields = groupFormFieldIds(metadata);
  return {
    type: "view_submission",
    view: {
      callback_id: GROUP_FORM_CALLBACK_ID,
      private_metadata: JSON.stringify(metadata),
      state: {
        values: {
          [fields.nameBlockId]: {
            [fields.nameActionId]: { type: "plain_text_input", value: name },
          },
          [fields.membersBlockId]: {
            [fields.membersActionId]: {
              type: "multi_users_select",
              selected_users: members,
            },
          },
        },
      },
    },
  };
}

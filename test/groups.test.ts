import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupManagerSnapshot,
  getGroupByName,
  GroupLimitReachedError,
  GroupNameConflictError,
  GroupNotFoundError,
  listGroupIdentities,
  listGroups,
  MAX_MANAGED_GROUPS,
  updateGroup,
} from "../src/db/groups";
import { buildCommandMessage } from "../src/slack/events";

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM "groups"').run();
});

describe("D1 group repository", () => {
  it("creates, reads, renames, updates members, and deletes a group", async () => {
    await createGroup(env.DB, "10기 운영진", ["U123ABC", "U456DEF"]);

    const summaries = await listGroups(env.DB);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.name).toBe("10기 운영진");
    expect(summaries[0]?.memberCount).toBe(2);
    expect(typeof summaries[0]?.id).toBe("number");
    const created = await getGroupByName(env.DB, "10기 운영진");
    expect(created?.members).toEqual(["U123ABC", "U456DEF"]);
    expect(created).not.toBeNull();
    if (!created) {
      throw new Error("Expected the created group");
    }

    await updateGroup(env.DB, created.id, "AUSG 운영진", ["U456DEF", "U789GHI"]);
    expect(await getGroupByName(env.DB, "10기 운영진")).toBeNull();
    expect(await getGroupById(env.DB, created.id)).toEqual({
      id: created.id,
      name: "AUSG 운영진",
      members: ["U456DEF", "U789GHI"],
    });

    await updateGroup(env.DB, created.id, "AUSG 운영진", []);
    expect((await getGroupById(env.DB, created.id))?.members).toEqual([]);

    await deleteGroup(env.DB, created.id);
    expect(await getGroupById(env.DB, created.id)).toBeNull();
    const memberCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?",
    )
      .bind(created.id)
      .first<{ count: number }>("count");
    expect(memberCount).toBe(0);
  });

  it("keeps a failed duplicate create atomic", async () => {
    await createGroup(env.DB, "회장단", ["U123ABC"]);
    await expect(createGroup(env.DB, "회장단", ["U999ZZZ"])).rejects.toBeInstanceOf(
      GroupNameConflictError,
    );
    const group = await getGroupByName(env.DB, "회장단");
    expect(group?.name).toBe("회장단");
    expect(group?.members).toEqual(["U123ABC"]);
    expect(typeof group?.id).toBe("number");
  });

  it("lists only the group identities needed by the management modal", async () => {
    await createGroup(env.DB, "B 그룹", ["U123ABC", "U456DEF"]);
    await createGroup(env.DB, "A 그룹", ["U789GHI"]);

    const identities = await listGroupIdentities(env.DB, 1);
    expect(identities).toHaveLength(1);
    expect(identities[0]?.name).toBe("A 그룹");
    expect(identities[0]).not.toHaveProperty("memberCount");
  });

  it("reads the manager list and selected group as one consistent snapshot", async () => {
    await createGroup(env.DB, "B 그룹", ["U456DEF"]);
    await createGroup(env.DB, "A 그룹", ["U123ABC"]);

    const initial = await getGroupManagerSnapshot(env.DB, MAX_MANAGED_GROUPS + 1);
    expect(initial.groups.map((group) => group.name)).toEqual(["A 그룹", "B 그룹"]);
    expect(initial.selectedGroup?.name).toBe("A 그룹");
    expect(initial.selectedGroup?.members).toEqual(["U123ABC"]);

    const createMode = await getGroupManagerSnapshot(
      env.DB,
      MAX_MANAGED_GROUPS + 1,
      null,
    );
    expect(createMode.selectedGroup).toBeNull();
  });

  it("writes only added and removed memberships during an update", async () => {
    await createGroup(env.DB, "운영진", ["U123ABC", "U456DEF"]);
    const group = await getGroupByName(env.DB, "운영진");
    expect(group).not.toBeNull();
    if (!group) {
      throw new Error("Expected an existing group");
    }

    await env.DB.batch([
      env.DB.prepare(
        "CREATE TABLE member_change_log (action TEXT NOT NULL, slack_user_id TEXT NOT NULL)",
      ),
      env.DB.prepare(`
        CREATE TRIGGER log_member_insert
        AFTER INSERT ON group_members
        BEGIN
          INSERT INTO member_change_log VALUES ('insert', NEW.slack_user_id);
        END
      `),
      env.DB.prepare(`
        CREATE TRIGGER log_member_delete
        AFTER DELETE ON group_members
        BEGIN
          INSERT INTO member_change_log VALUES ('delete', OLD.slack_user_id);
        END
      `),
    ]);

    try {
      await updateGroup(env.DB, group.id, "운영진", ["U456DEF", "U789GHI"]);
      const firstUpdate = await env.DB
        .prepare("SELECT action, slack_user_id FROM member_change_log ORDER BY rowid")
        .all<{ action: string; slack_user_id: string }>();
      expect(firstUpdate.results).toEqual([
        { action: "delete", slack_user_id: "U123ABC" },
        { action: "insert", slack_user_id: "U789GHI" },
      ]);

      await env.DB.prepare("DELETE FROM member_change_log").run();
      await updateGroup(env.DB, group.id, "운영진", ["U456DEF", "U789GHI"]);
      const unchangedUpdate = await env.DB
        .prepare("SELECT action, slack_user_id FROM member_change_log")
        .all();
      expect(unchangedUpdate.results).toEqual([]);
    } finally {
      await env.DB.batch([
        env.DB.prepare("DROP TRIGGER IF EXISTS log_member_insert"),
        env.DB.prepare("DROP TRIGGER IF EXISTS log_member_delete"),
        env.DB.prepare("DROP TABLE IF EXISTS member_change_log"),
      ]);
    }
  });

  it("keeps an update atomic when the new name conflicts", async () => {
    await createGroup(env.DB, "기존 그룹", ["U123ABC"]);
    await createGroup(env.DB, "다른 그룹", ["U456DEF"]);
    const group = await getGroupByName(env.DB, "기존 그룹");
    expect(group).not.toBeNull();
    if (!group) {
      throw new Error("Expected an existing group");
    }

    await expect(
      updateGroup(env.DB, group.id, "다른 그룹", ["U999ZZZ"]),
    ).rejects.toBeInstanceOf(GroupNameConflictError);
    expect(await getGroupById(env.DB, group.id)).toEqual(group);
  });

  it("reports a concurrently deleted group even when the member list is empty", async () => {
    await expect(updateGroup(env.DB, 999_999, "삭제된 그룹", [])).rejects.toBeInstanceOf(
      GroupNotFoundError,
    );
  });

  it("enforces the static Slack modal group limit atomically", async () => {
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

    await expect(createGroup(env.DB, "한도 초과", ["U123ABC"])).rejects.toBeInstanceOf(
      GroupLimitReachedError,
    );
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM "groups"')
      .first<{ count: number }>("count");
    expect(count).toBe(MAX_MANAGED_GROUPS);
  });

  it("stores group memberships as a WITHOUT ROWID table", async () => {
    const table = await env.DB
      .prepare("SELECT wr FROM pragma_table_list WHERE name = ?")
      .bind("group_members")
      .first<{ wr: number }>();

    expect(table?.wr).toBe(1);
  });
});

describe("command messages", () => {
  it("renders an actual Slack mention for a group", async () => {
    await createGroup(env.DB, "행사 TF", ["U123ABC", "U456DEF"]);
    const message = await buildCommandMessage(
      { type: "mention_group", groupName: "행사 TF" },
      env.DB,
    );
    expect(message.text).toBe("🔔 행사 TF\n\n<@U123ABC> <@U456DEF>");
  });

  it("renders a member list with its count", async () => {
    await createGroup(env.DB, "11기 운영진", ["U123ABC"]);
    const message = await buildCommandMessage(
      { type: "list_members", groupName: "11기 운영진" },
      env.DB,
    );
    expect(message.text).toBe("🔔 11기 운영진 · 1명\n\n<@U123ABC>");
  });

  it("explains when a group does not exist", async () => {
    const message = await buildCommandMessage(
      { type: "mention_group", groupName: "100기 운영진" },
      env.DB,
    );
    expect(message.text).toContain("`100기 운영진` 그룹을 찾지 못했어요");
  });

  it("handles an empty group", async () => {
    await createGroup(env.DB, "빈 그룹", []);
    const message = await buildCommandMessage(
      { type: "mention_group", groupName: "빈 그룹" },
      env.DB,
    );
    expect(message.text).toBe("🔔 빈 그룹에는 아직 등록된 멤버가 없어요.");
  });

  it("lists all groups and member counts", async () => {
    await createGroup(env.DB, "10기 운영진", ["U123ABC", "U456DEF"]);
    await createGroup(env.DB, "회장단", ["U789GHI"]);
    const message = await buildCommandMessage({ type: "list_groups" }, env.DB);
    expect(message.text).toContain("• 10기 운영진 — 2명");
    expect(message.text).toContain("• 회장단 — 1명");
  });

  it("escapes a group name in Slack's mrkdwn fallback without escaping member mentions", async () => {
    await createGroup(env.DB, "<!channel> & 운영진", ["U123ABC"]);
    const message = await buildCommandMessage(
      { type: "mention_group", groupName: "<!channel> & 운영진" },
      env.DB,
    );

    expect(message.text).toBe(
      "🔔 &lt;!channel&gt; &amp; 운영진\n\n<@U123ABC>",
    );
  });
});

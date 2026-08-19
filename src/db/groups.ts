import type { Group, GroupIdentity, GroupSummary } from "../types";

interface GroupSummaryRow {
  id: number;
  name: string;
  member_count: number;
}

interface GroupMemberRow {
  id: number;
  name: string;
  slack_user_id: string | null;
}

interface GroupManagerRow {
  id: number;
  name: string;
  slack_user_id?: string | null;
}

interface UpdateGroupStatusRow {
  group_exists: number;
  name_conflict: number;
}

export interface GroupManagerSnapshot {
  groups: GroupIdentity[];
  selectedGroup: Group | null;
}

export const MAX_MANAGED_GROUPS = 99;

export class GroupNameConflictError extends Error {
  constructor() {
    super("A group with the same name already exists");
    this.name = "GroupNameConflictError";
  }
}

export class GroupLimitReachedError extends Error {
  constructor() {
    super(`A maximum of ${MAX_MANAGED_GROUPS} groups can be managed`);
    this.name = "GroupLimitReachedError";
  }
}

export class GroupNotFoundError extends Error {
  constructor() {
    super("The group no longer exists");
    this.name = "GroupNotFoundError";
  }
}

export async function listGroups(db: D1Database): Promise<GroupSummary[]> {
  const result = await db
    .prepare(
      `SELECT g.id,
              g.name,
              (
                SELECT COUNT(*)
                FROM group_members AS m
                WHERE m.group_id = g.id
              ) AS member_count
       FROM "groups" AS g
       ORDER BY g.name`,
    )
    .all<GroupSummaryRow>();

  return result.results.map((row) => ({
    id: row.id,
    name: row.name,
    memberCount: row.member_count,
  }));
}

export async function listGroupIdentities(
  db: D1Database,
  limit: number,
): Promise<GroupIdentity[]> {
  const result = await db
    .prepare(
      `SELECT id, name
       FROM "groups"
       ORDER BY name
       LIMIT ?`,
    )
    .bind(limit)
    .all<GroupIdentity>();

  return result.results;
}

export async function getGroupManagerSnapshot(
  db: D1Database,
  limit: number,
  selectedGroupId?: number | null,
): Promise<GroupManagerSnapshot> {
  if (selectedGroupId === null) {
    return {
      groups: await listGroupIdentities(db, limit),
      selectedGroup: null,
    };
  }

  const selectedGroupStatement = selectedGroupId === undefined
    ? db.prepare(
        `SELECT g.id, g.name, m.slack_user_id
         FROM "groups" AS g
         LEFT JOIN group_members AS m ON m.group_id = g.id
         WHERE g.id = (
           SELECT id
           FROM "groups"
           ORDER BY name
           LIMIT 1
         )
         ORDER BY m.slack_user_id`,
      )
    : db
        .prepare(
          `SELECT g.id, g.name, m.slack_user_id
           FROM "groups" AS g
           LEFT JOIN group_members AS m ON m.group_id = g.id
           WHERE g.id = ?
           ORDER BY m.slack_user_id`,
        )
        .bind(selectedGroupId);

  const [groupsResult, selectedGroupResult] = await db.batch<GroupManagerRow>([
    db
      .prepare(
        `SELECT id, name
         FROM "groups"
         ORDER BY name
         LIMIT ?`,
      )
      .bind(limit),
    selectedGroupStatement,
  ]);

  return {
    groups: (groupsResult?.results ?? []).map((row) => ({ id: row.id, name: row.name })),
    selectedGroup: hydrateGroup(
      (selectedGroupResult?.results ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        slack_user_id: row.slack_user_id ?? null,
      })),
    ),
  };
}

export async function getGroupByName(
  db: D1Database,
  name: string,
): Promise<Group | null> {
  const result = await db
    .prepare(
      `SELECT g.id, g.name, m.slack_user_id
       FROM "groups" AS g
       LEFT JOIN group_members AS m ON m.group_id = g.id
       WHERE g.name = ?
       ORDER BY m.slack_user_id`,
    )
    .bind(name)
    .all<GroupMemberRow>();

  return hydrateGroup(result.results);
}

export async function getGroupById(db: D1Database, id: number): Promise<Group | null> {
  const result = await db
    .prepare(
      `SELECT g.id, g.name, m.slack_user_id
       FROM "groups" AS g
       LEFT JOIN group_members AS m ON m.group_id = g.id
       WHERE g.id = ?
       ORDER BY m.slack_user_id`,
    )
    .bind(id)
    .all<GroupMemberRow>();

  return hydrateGroup(result.results);
}

export async function createGroup(
  db: D1Database,
  name: string,
  members: readonly string[],
): Promise<void> {
  const membersJson = serializeMembers(members);
  try {
    const [insertResult] = await db.batch([
      db
        .prepare(
          `INSERT INTO "groups" (name)
           SELECT ?
           WHERE (
             SELECT COUNT(*) FROM "groups"
           ) < ?`,
        )
        .bind(name, MAX_MANAGED_GROUPS),
      db
        .prepare(
          `INSERT INTO group_members (group_id, slack_user_id)
           SELECT last_insert_rowid(), CAST(member.value AS TEXT)
           FROM json_each(?) AS member
           WHERE changes() = 1`,
        )
        .bind(membersJson),
    ]);

    if ((insertResult?.meta.changes ?? 0) !== 1) {
      throw new GroupLimitReachedError();
    }
  } catch (error: unknown) {
    if (error instanceof GroupLimitReachedError) {
      throw error;
    }
    if (await groupNameExists(db, name)) {
      throw new GroupNameConflictError();
    }
    throw error;
  }
}

export async function updateGroup(
  db: D1Database,
  id: number,
  name: string,
  members: readonly string[],
): Promise<void> {
  const membersJson = serializeMembers(members);
  try {
    const [sameNameResult, renamedResult] = await db.batch([
      db
        .prepare(
          `UPDATE "groups"
           SET updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND name = ?`,
        )
        .bind(id, name),
      db
        .prepare(
          `UPDATE "groups"
           SET name = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND name <> ?`,
        )
        .bind(name, id, name),
      db
        .prepare(
          `DELETE FROM group_members
           WHERE group_id = ?
             AND slack_user_id NOT IN (
               SELECT CAST(member.value AS TEXT)
               FROM json_each(?) AS member
             )`,
        )
        .bind(id, membersJson),
      db
        .prepare(
          `INSERT INTO group_members (group_id, slack_user_id)
           SELECT ?, CAST(member.value AS TEXT)
           FROM json_each(?) AS member
           -- Disambiguates SQLite's UPSERT clause from a SELECT join clause.
           WHERE true
           ON CONFLICT(group_id, slack_user_id) DO NOTHING`,
        )
        .bind(id, membersJson),
    ]);

    const groupChanges =
      (sameNameResult?.meta.changes ?? 0) +
      (renamedResult?.meta.changes ?? 0);
    if (groupChanges !== 1) {
      throw new GroupNotFoundError();
    }
  } catch (error: unknown) {
    if (error instanceof GroupNotFoundError) {
      throw error;
    }

    const status = await getUpdateGroupStatus(db, id, name);
    if (!status.group_exists) {
      throw new GroupNotFoundError();
    }
    if (status.name_conflict) {
      throw new GroupNameConflictError();
    }
    throw error;
  }
}

export async function deleteGroup(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM "groups" WHERE id = ?').bind(id).run();
}

function hydrateGroup(rows: GroupMemberRow[]): Group | null {
  const first = rows[0];
  if (!first) {
    return null;
  }

  return {
    id: first.id,
    name: first.name,
    members: rows.flatMap((row) => (row.slack_user_id ? [row.slack_user_id] : [])),
  };
}

function serializeMembers(members: readonly string[]): string {
  return JSON.stringify([...new Set(members)]);
}

async function groupNameExists(db: D1Database, name: string): Promise<boolean> {
  const result = await db
    .prepare('SELECT 1 AS found FROM "groups" WHERE name = ?')
    .bind(name)
    .first<{ found: number }>();
  return result?.found === 1;
}

async function getUpdateGroupStatus(
  db: D1Database,
  id: number,
  name: string,
): Promise<UpdateGroupStatusRow> {
  const result = await db
    .prepare(
      `SELECT EXISTS(
                SELECT 1 FROM "groups" WHERE id = ?
              ) AS group_exists,
              EXISTS(
                SELECT 1
                FROM "groups"
                WHERE name = ? AND id <> ?
              ) AS name_conflict`,
    )
    .bind(id, name, id)
    .first<UpdateGroupStatusRow>();

  return result ?? { group_exists: 0, name_conflict: 0 };
}

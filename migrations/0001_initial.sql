PRAGMA foreign_keys = ON;

CREATE TABLE "groups" (
    -- Prevent a deleted ID from being reused by an older, still-open Slack modal.
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE group_members (
    group_id INTEGER NOT NULL,
    slack_user_id TEXT NOT NULL,

    PRIMARY KEY (group_id, slack_user_id),

    FOREIGN KEY (group_id)
        REFERENCES "groups"(id)
        ON DELETE CASCADE
) WITHOUT ROWID;

-- groups.name's UNIQUE index and group_members' WITHOUT ROWID primary key
-- already cover both lookup patterns without redundant secondary indexes.

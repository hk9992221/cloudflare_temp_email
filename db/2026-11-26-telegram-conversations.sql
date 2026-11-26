-- v0.0.12 to v0.0.13. The administrator migration performs the same additive DDL.
CREATE TABLE IF NOT EXISTS telegram_conversations (
    bot_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    prompt_id INTEGER,
    expires_at INTEGER NOT NULL,
    last_update_id INTEGER NOT NULL,
    PRIMARY KEY (bot_id, chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_conversations_expires ON telegram_conversations(expires_at);

CREATE TABLE IF NOT EXISTS telegram_conversation_updates (
    bot_id TEXT NOT NULL,
    update_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, update_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_conversation_updates_expires ON telegram_conversation_updates(expires_at);

INSERT INTO settings(key, value) VALUES ('db_version', 'v0.0.13')
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
WHERE settings.value = 'v0.0.12';

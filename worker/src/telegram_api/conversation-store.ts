export const CONVERSATION_TTL = 300;
const UPDATE_TTL = 48 * 60 * 60;

export const TELEGRAM_CONVERSATION_SCHEMA = `
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
`;

export interface ConversationKey {
    botId: string;
    chatId: string;
    userId: string;
}

export type ConversationStatus = 'awaiting_input' | 'awaiting_selection' | 'awaiting_confirmation' | 'executing';

export interface ConversationRow {
    session_id: string;
    revision: number;
    command: string;
    status: ConversationStatus;
    data: string;
    prompt_id: number | null;
    expires_at: number;
    last_update_id: number;
}

export const conversationNow = () => Math.floor(Date.now() / 1000);

export class ConversationStore {
    private readonly db: D1DatabaseSession;
    private readonly identity: [string, string, string];

    constructor(db: D1Database, key: ConversationKey) {
        this.db = db.withSession('first-primary');
        this.identity = [key.botId, key.chatId, key.userId];
    }

    async claimUpdate(updateId: number): Promise<boolean> {
        const result = await this.db.prepare(
            'INSERT OR IGNORE INTO telegram_conversation_updates (bot_id, update_id, expires_at) VALUES (?, ?, ?)'
        ).bind(this.identity[0], updateId, conversationNow() + UPDATE_TTL).run();
        return result.meta.changes === 1;
    }

    async get() {
        return this.db.prepare(`
            SELECT session_id, revision, command, status, data, prompt_id, expires_at, last_update_id
            FROM telegram_conversations WHERE bot_id = ? AND chat_id = ? AND user_id = ?
        `).bind(...this.identity).first<ConversationRow>();
    }

    async start(command: string, updateId: number): Promise<ConversationRow | null> {
        const now = conversationNow();
        // Reserve the slot while the first step is resolved. A duplicate or older
        // command cannot replace a newer session or an active execution.
        return this.db.prepare(`
            INSERT INTO telegram_conversations
                (bot_id, chat_id, user_id, session_id, revision, command, status, data, expires_at, last_update_id)
            VALUES (?, ?, ?, ?, 0, ?, 'executing', '{}', ?, ?)
            ON CONFLICT(bot_id, chat_id, user_id) DO UPDATE SET
                session_id = excluded.session_id, revision = 0, command = excluded.command,
                status = excluded.status, data = excluded.data, prompt_id = NULL,
                expires_at = excluded.expires_at, last_update_id = excluded.last_update_id
            WHERE telegram_conversations.expires_at <= ?
               OR (telegram_conversations.status <> 'executing'
                   AND telegram_conversations.last_update_id < excluded.last_update_id)
            RETURNING session_id, revision, command, status, data, prompt_id, expires_at, last_update_id
        `).bind(...this.identity, crypto.randomUUID().replace(/-/g, ''), command, now + CONVERSATION_TTL,
            updateId, now).first<ConversationRow>();
    }

    async advance(
        row: ConversationRow, status: ConversationStatus, data: string, promptId: number | null, updateId: number,
    ): Promise<ConversationRow | null> {
        const now = conversationNow();
        return this.db.prepare(`
            UPDATE telegram_conversations
            SET revision = revision + 1, status = ?, data = ?, prompt_id = ?, expires_at = ?, last_update_id = ?
            WHERE bot_id = ? AND chat_id = ? AND user_id = ? AND session_id = ? AND revision = ?
              AND expires_at > ? AND last_update_id <= ?
            RETURNING session_id, revision, command, status, data, prompt_id, expires_at, last_update_id
        `).bind(status, data, promptId, now + CONVERSATION_TTL, updateId, ...this.identity,
            row.session_id, row.revision, now, updateId).first<ConversationRow>();
    }

    async recordPrompt(row: ConversationRow, promptId: number) {
        const result = await this.db.prepare(`
            UPDATE telegram_conversations SET prompt_id = ?
            WHERE bot_id = ? AND chat_id = ? AND user_id = ? AND session_id = ? AND revision = ?
        `).bind(promptId, ...this.identity, row.session_id, row.revision).run();
        return result.meta.changes === 1;
    }

    async clear(row: ConversationRow) {
        const result = await this.db.prepare(`
            DELETE FROM telegram_conversations
            WHERE bot_id = ? AND chat_id = ? AND user_id = ? AND session_id = ? AND revision = ?
        `).bind(...this.identity, row.session_id, row.revision).run();
        return result.meta.changes === 1;
    }
}

export async function cleanTelegramConversations(db: D1Database) {
    const now = conversationNow();
    for (const table of ['telegram_conversations', 'telegram_conversation_updates']) {
        await db.prepare(`
            DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at <= ? ORDER BY expires_at LIMIT 500)
        `).bind(now).run();
    }
}

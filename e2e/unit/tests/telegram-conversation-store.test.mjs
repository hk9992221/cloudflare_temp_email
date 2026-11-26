import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanTelegramConversations,
  ConversationStore,
  TELEGRAM_CONVERSATION_SCHEMA,
} from '../../../worker/src/telegram_api/conversation-store.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(TELEGRAM_CONVERSATION_SCHEMA);
  const db = {
    withSession(mode) {
      assert.equal(mode, 'first-primary');
      return db;
    },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args) {
          return {
            first: async () => statement.get(...args) ?? null,
            run: async () => ({ meta: statement.run(...args) }),
          };
        },
      };
    },
  };
  const key = { botId: '1', chatId: '20', userId: '30' };
  return { sqlite, db, key, session: new ConversationStore(db, key) };
}

test('confirmation and cancellation compare the active revision, and replay is bot-scoped', async () => {
  const { db, key, session, sqlite } = fixture();
  try {
    assert.equal(await session.claimUpdate(100), true);
    assert.equal(await session.claimUpdate(100), false);
    assert.equal(await new ConversationStore(db, { ...key, botId: '2' }).claimUpdate(100), true);
    const reserved = await session.start('delete', 100);
    const confirm = await session.advance(reserved, 'awaiting_confirmation', '{}', 10, 100);
    const duplicateWorker = new ConversationStore(db, key);
    const [first, second] = await Promise.all([
      session.advance(confirm, 'executing', '{}', 10, 101),
      duplicateWorker.advance(confirm, 'executing', '{}', 10, 102),
    ]);
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(await session.clear(confirm), false);
    assert.equal(await session.start('new', 103), null);
    assert.equal(await session.clear(first), true);
    assert.equal(await session.get(), null);
  } finally {
    sqlite.close();
  }
});

test('separate chat, user and bot scopes and expired states are independent', async () => {
  const { db, key, session, sqlite } = fixture();
  try {
    const row = await session.start('bind', 200);
    const prompt = await session.advance(row, 'awaiting_input', '{}', null, 200);
    assert.equal(await session.recordPrompt(prompt, 41), true);
    assert.equal((await session.get()).prompt_id, 41);
    for (const identity of [{ botId: '2' }, { chatId: '21' }, { userId: '31' }]) {
      assert.equal(await new ConversationStore(db, { ...key, ...identity }).get(), null);
    }
    assert.equal(await session.start('mails', 199), null);
    sqlite.exec("UPDATE telegram_conversations SET expires_at = 1; INSERT INTO telegram_conversation_updates VALUES ('1', 100, 1)");
    assert.equal(await session.advance(prompt, 'executing', '{}', null, 201), null);
    await cleanTelegramConversations(db);
    assert.equal(await session.get(), null);
    assert.equal(await session.claimUpdate(100), true);
  } finally {
    sqlite.close();
  }
});

test('v0.0.13 migration is repeatable and retains existing addresses and mail', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE address (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE raw_mails (id INTEGER PRIMARY KEY, raw TEXT);
      INSERT INTO settings VALUES ('db_version', 'v0.0.12', CURRENT_TIMESTAMP);
      INSERT INTO address VALUES (1, 'mailbox@example.org');
      INSERT INTO raw_mails VALUES (2, 'Existing MIME data');
    `);
    const sql = readFileSync(new URL('../../../db/2026-11-26-telegram-conversations.sql', import.meta.url), 'utf8');
    db.exec(sql);
    db.exec(sql);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='db_version'").get().value, 'v0.0.13');
    assert.equal(db.prepare("SELECT name FROM address WHERE id=1").get().name, 'mailbox@example.org');
    assert.equal(db.prepare("SELECT raw FROM raw_mails WHERE id=2").get().raw, 'Existing MIME data');
    assert.equal(db.prepare("SELECT count(*) count FROM sqlite_master WHERE name LIKE 'telegram_conversation%'").get().count, 2);
  } finally {
    db.close();
  }
});

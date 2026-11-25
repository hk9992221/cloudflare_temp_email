import { RawMailRow } from '../../models';
import { commonParseMail } from '../../utils/mail_parser';
import {
    abandonWriteIntent, activeWriteIntent, finishWriteIntent, MailStorageError, MAX_RAW_MAIL_BYTES,
    newMailObjectKey, openWriteIntent, prepareObject, putObject, readObject, requireBucket,
    requireStorageSchema, storedObjectFields, summarizeMail,
} from './r2';
import { readLegacyMailBytes } from './read';

const BATCH_SIZE = 5;
const BATCH_BYTES = 16 * 1024 * 1024;
const LEASE_SECONDS = 10 * 60;
const JOB = 'mail_storage_migration';
const leaseCheck = `SELECT 1 FROM ${JOB} WHERE id = 1 AND lease_token = ? AND lease_until > unixepoch()`;

type MigrationJob = {
    cursor: number;
    upper_id: number;
    scanned: number;
    migrated: number;
    skipped: number;
    bytes_migrated: number;
    paused: number;
    lease_until: number;
};

export async function migrationProgress(db: D1Database) {
    const [job, failures, count] = await db.batch([
        db.prepare(`SELECT cursor, upper_id, scanned, migrated, skipped, bytes_migrated, paused, lease_until
            FROM ${JOB} WHERE id = 1`),
        db.prepare(`SELECT mail_id, error_code, attempts FROM mail_storage_migration_failures
            ORDER BY updated_at DESC, mail_id LIMIT 25`),
        db.prepare('SELECT count(*) AS failed FROM mail_storage_migration_failures'),
    ]);
    return { job: (job.results[0] as MigrationJob | undefined) ?? null, failures: failures.results,
        failed: Number((count.results[0] as { failed?: number } | undefined)?.failed ?? 0) };
}

export async function previewMigration(env: Bindings) {
    await requireStorageSchema(env);
    return env.DB.prepare(`SELECT count(*) AS eligible,
        sum(COALESCE(length(raw_blob), length(CAST(raw AS BLOB)), 0)) AS d1PayloadBytes
        FROM raw_mails WHERE storage_backend = 'd1'`).first();
}

export async function setMigrationPaused(env: Bindings, paused: boolean) {
    await requireStorageSchema(env);
    await initializeJob(env.DB);
    await env.DB.prepare(`UPDATE ${JOB} SET paused = ? WHERE id = 1`).bind(Number(paused)).run();
    return migrationProgress(env.DB);
}

async function initializeJob(db: D1Database) {
    await db.prepare(`INSERT OR IGNORE INTO ${JOB}(id, upper_id)
        SELECT 1, COALESCE(max(id), 0) FROM raw_mails`).run();
}

function recordProcessed(db: D1Database, token: string, id: number, retry: boolean,
    migratedKey: string | null, bytes: number, skipped: boolean) {
    return db.prepare(`UPDATE ${JOB} SET cursor = CASE WHEN ? = 1 THEN cursor ELSE max(cursor, ?) END,
        scanned = scanned + ?, skipped = skipped + ?,
        migrated = migrated + EXISTS(SELECT 1 FROM raw_mails WHERE r2_key = ?),
        bytes_migrated = bytes_migrated + CASE WHEN EXISTS(SELECT 1 FROM raw_mails WHERE r2_key = ?) THEN ? ELSE 0 END
        WHERE id = 1 AND lease_token = ? AND lease_until > unixepoch()`)
        .bind(Number(retry), id, Number(!retry), Number(skipped && !retry), migratedKey, migratedKey, bytes, token);
}

async function migrateMail(
    env: Bindings, id: number, token: string, retry: boolean, reserveBytes: (bytes: number) => boolean,
) {
    const db = env.DB;
    const bucket = requireBucket(env);
    const key = newMailObjectKey(env);
    if (!await openWriteIntent(db, key, id)) {
        const exists = await db.prepare(`SELECT 1 FROM raw_mails WHERE id = ? AND storage_backend = 'd1'`)
            .bind(id).first();
        if (exists) throw new MailStorageError('MAIL_STORAGE_MIGRATION_INTENT_BUSY');
        await recordProcessed(db, token, id, retry, null, 0, true).run();
        return { state: 'skipped', bytes: 0 } as const;
    }
    let size = 0;
    try {
        const row = await db.prepare(`SELECT rm.* FROM raw_mails rm JOIN mail_storage_gc g ON g.mail_id = rm.id
            WHERE rm.id = ? AND g.object_key = ? AND rm.storage_backend = 'd1'`).bind(id, key).first<RawMailRow>();
        if (!row) throw new MailStorageError('MAIL_STORAGE_MIGRATION_SOURCE_CHANGED');
        const raw = await readLegacyMailBytes(row);
        size = raw.byteLength;
        if (!reserveBytes(size)) {
            await db.prepare(`DELETE FROM mail_storage_gc WHERE object_key = ? AND reason = 'write'
                AND lease_token IS NULL`).bind(key).run();
            return { state: 'deferred', bytes: 0 } as const;
        }
        if (size > MAX_RAW_MAIL_BYTES) throw new MailStorageError('MAIL_STORAGE_SIZE_LIMIT');
        const { object, stored } = await prepareObject(env, raw, key);
        const summary = summarizeMail(await commonParseMail({ rawEmail: new TextDecoder().decode(raw), rawBytes: raw }));
        await putObject(bucket, object, stored);
        await readObject(bucket, object);
        const [update] = await db.batch([
            db.prepare(`UPDATE raw_mails SET storage_backend = 'r2', raw = NULL, raw_blob = NULL,
                r2_key = ?, raw_encoding = ?, raw_size = ?, stored_size = ?, content_sha256 = ?,
                subject = ?, sender = ?, preview = ?, attachment_count = ?
                WHERE id = ? AND storage_backend = 'd1'
                AND EXISTS (${activeWriteIntent} AND mail_id = raw_mails.id)
                AND EXISTS (${leaseCheck})`).bind(...storedObjectFields(object, summary), id, key, token),
            finishWriteIntent(db, key),
            db.prepare(`DELETE FROM mail_storage_migration_failures WHERE mail_id = ?
                AND EXISTS (SELECT 1 FROM raw_mails WHERE r2_key = ?)`).bind(id, key),
            recordProcessed(db, token, id, retry, key, size, false),
        ]);
        if (update.meta.changes !== 1) throw new MailStorageError('MAIL_STORAGE_MIGRATION_SOURCE_CHANGED');
        return { state: 'migrated', bytes: size } as const;
    } catch (error) {
        await abandonWriteIntent(db, key).catch(() => {});
        // Reconcile a lost D1 response after the atomic update.
        if (await db.prepare('SELECT 1 FROM raw_mails WHERE id = ? AND r2_key = ?').bind(id, key).first()) {
            return { state: 'migrated', bytes: size } as const;
        }
        throw error;
    }
}

export async function runMigrationBatch(env: Bindings, mode: 'next' | 'retry' | 'restart') {
    requireBucket(env);
    await requireStorageSchema(env);
    const db = env.DB;
    await initializeJob(db);
    const token = crypto.randomUUID();
    const { meta } = await db.prepare(`UPDATE ${JOB} SET lease_token = ?, lease_until = unixepoch() + ?
        WHERE id = 1 AND paused = 0 AND lease_until <= unixepoch()`)
        .bind(token, LEASE_SECONDS).run();
    if (meta.changes !== 1) throw new MailStorageError('MAIL_STORAGE_MIGRATION_PAUSED_OR_BUSY');

    const result = { scanned: 0, migrated: 0, skipped: 0, failed: 0, bytesMigrated: 0, nextCursor: 0, hasMore: false };
    const retry = mode === 'retry';
    let remainingBytes = BATCH_BYTES;
    const reserveBytes = (size: number) => {
        if (size > remainingBytes) return false;
        remainingBytes -= size;
        return true;
    };
    try {
        if (mode === 'restart') {
            await db.prepare(`UPDATE ${JOB} SET cursor = 0, upper_id = (SELECT COALESCE(max(id), 0) FROM raw_mails)
                WHERE id = 1 AND lease_token = ?`).bind(token).run();
        }
        const job = await db.prepare(`SELECT cursor, upper_id FROM ${JOB} WHERE id = 1`).first<MigrationJob>();
        if (!job) throw new MailStorageError('MAIL_STORAGE_MIGRATION_JOB_MISSING');
        result.nextCursor = job.cursor;
        const candidates = retry
            ? db.prepare(`SELECT mail_id AS id FROM mail_storage_migration_failures
                ORDER BY updated_at, mail_id LIMIT ?`).bind(BATCH_SIZE)
            : db.prepare(`SELECT id FROM raw_mails WHERE storage_backend = 'd1' AND id > ? AND id <= ?
                ORDER BY id LIMIT ?`).bind(job.cursor, job.upper_id, BATCH_SIZE);
        for (const { id } of (await candidates.all<{ id: number }>()).results) {
            if (!await db.prepare(`${leaseCheck} AND paused = 0`).bind(token).first()) break;
            let outcome: Awaited<ReturnType<typeof migrateMail>>;
            try {
                outcome = await migrateMail(env, id, token, retry, reserveBytes);
            } catch (error) {
                const code = error instanceof MailStorageError ? error.code : 'MAIL_STORAGE_MIGRATION_FAILED';
                await db.batch([
                    db.prepare(`INSERT INTO mail_storage_migration_failures (mail_id, error_code)
                        SELECT ?, ? WHERE EXISTS (SELECT 1 FROM raw_mails WHERE id = ? AND storage_backend = 'd1')
                        AND EXISTS (${leaseCheck})
                        ON CONFLICT(mail_id) DO UPDATE SET error_code = excluded.error_code,
                            attempts = attempts + 1, updated_at = unixepoch()`).bind(id, code, id, token),
                    recordProcessed(db, token, id, retry, null, 0, false),
                ]);
                console.error('mail storage migration:', code, id);
                outcome = { state: 'skipped', bytes: 0 };
                result.failed++;
            }
            if (outcome.state === 'deferred') break;
            if (!retry) result.nextCursor = id;
            result.scanned++;
            if (outcome.state === 'migrated') result.migrated++;
            else if (outcome.state === 'skipped' && !await db.prepare(
                'SELECT 1 FROM mail_storage_migration_failures WHERE mail_id = ?').bind(id).first()) result.skipped++;
            result.bytesMigrated += outcome.bytes;
        }
        const remaining = retry
            ? db.prepare('SELECT 1 FROM mail_storage_migration_failures LIMIT 1')
            : db.prepare(`SELECT 1 FROM raw_mails WHERE storage_backend = 'd1' AND id > ? AND id <= ? LIMIT 1`)
                .bind(result.nextCursor, job.upper_id);
        result.hasMore = !!await remaining.first();
        if (!retry && !result.hasMore) {
            await db.prepare(`UPDATE ${JOB} SET cursor = upper_id WHERE id = 1 AND lease_token = ?`)
                .bind(token).run();
            result.nextCursor = job.upper_id;
        }
        return result;
    } finally {
        await db.prepare(`UPDATE ${JOB} SET lease_token = NULL, lease_until = 0 WHERE id = 1 AND lease_token = ?`)
            .bind(token).run();
    }
}

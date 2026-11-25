import { Context } from 'hono';
import { collectMailObjects } from '../email/storage/gc';
import { migrationProgress, previewMigration, runMigrationBatch, setMigrationPaused } from '../email/storage/migration';
import { configuredBackend, MAIL_OBJECT_PREFIX, MailStorageError, MAX_RAW_MAIL_BYTES } from '../email/storage/r2';
import { inspectMailStorageSchema } from '../email/storage/schema';

const getStatus = async (c: Context<HonoCustomType>) => {
    const { DB, MAIL_STORAGE } = c.env;
    const { hasBackend, hasMailTable, ready } = await inspectMailStorageSchema(DB);
    let mode: 'd1' | 'r2' | 'invalid' = 'invalid';
    try {
        mode = configuredBackend(c.env);
    } catch (error) {
        if (!(error instanceof MailStorageError)) throw error;
    }
    const base = { mode, configurationValid: mode !== 'invalid', bindingConfigured: !!MAIL_STORAGE,
        schemaReady: ready, maxRawBytes: MAX_RAW_MAIL_BYTES };
    if (!ready) {
        const d1 = hasMailTable && !hasBackend
            ? await DB.prepare('SELECT count(*) AS n FROM raw_mails').first<number>('n') : null;
        return c.json({ ...base, d1, r2: null, pendingMigration: null, r2StoredBytes: null,
            knownRawBytes: null, unknownRawSizeCount: null, gcPending: null, gcFailed: null, migration: null });
    }
    const [count, queue, migration] = await Promise.all([
        DB.prepare(`SELECT
            count(CASE WHEN storage_backend = 'd1' THEN 1 END) AS d1,
            count(CASE WHEN storage_backend = 'r2' THEN 1 END) AS r2,
            sum(raw_size) AS knownRawBytes, count(*) - count(raw_size) AS unknownRawSizeCount,
            COALESCE(sum(CASE WHEN storage_backend = 'r2' THEN stored_size END), 0) AS r2StoredBytes
            FROM raw_mails`).first<{ d1: number; r2: number; knownRawBytes: number | null;
                unknownRawSizeCount: number; r2StoredBytes: number }>(),
        DB.prepare(`SELECT count(*) AS gcPending,
            count(CASE WHEN last_error_code IS NOT NULL THEN 1 END) AS gcFailed
            FROM mail_storage_gc`).first(),
        migrationProgress(DB),
    ]);
    return c.json({ ...base, ...count, pendingMigration: count?.d1 ?? null, ...queue, migration });
};

const check = async (c: Context<HonoCustomType>) => {
    const { ready } = await inspectMailStorageSchema(c.env.DB);
    if (!c.env.MAIL_STORAGE) return c.json({ schemaReady: ready, r2Reachable: false,
        error: 'MAIL_STORAGE_BINDING_MISSING' });
    try {
        await c.env.MAIL_STORAGE.list({ prefix: MAIL_OBJECT_PREFIX, limit: 1 });
        return c.json({ schemaReady: ready, r2Reachable: true });
    } catch {
        return c.json({ schemaReady: ready, r2Reachable: false, error: 'MAIL_STORAGE_BINDING_UNREACHABLE' });
    }
};

const migrate = async (c: Context<HonoCustomType>) => {
    const { action } = await c.req.json<{ action: string }>();
    try {
        switch (action) {
            case 'preview': return c.json(await previewMigration(c.env));
            case 'next':
            case 'restart':
            case 'retry': return c.json(await runMigrationBatch(c.env, action));
            case 'pause':
            case 'resume': return c.json(await setMigrationPaused(c.env, action === 'pause'));
            default: return c.json({ message: 'MAIL_STORAGE_ACTION_INVALID' }, 400);
        }
    } catch (error) {
        if (error instanceof MailStorageError) return c.json({ message: error.code }, 409);
        throw error;
    }
};

const gc = async (c: Context<HonoCustomType>) => {
    const { retryFailed } = await c.req.json<{ retryFailed?: boolean }>();
    return c.json(await collectMailObjects(c.env, retryFailed === true));
};

export default { getStatus, check, migrate, gc };

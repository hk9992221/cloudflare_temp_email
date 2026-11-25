import { Context } from 'hono';
import { collectMailObjects } from '../../worker/src/email/storage/gc';
import { createWebhookAttachmentPath } from '../../worker/src/utils/webhook';
import { executeCustomSqlCleanup } from '../../worker/src/admin_api/cleanup_api';

export function mailStorageTestBindings(request: Request, env: Bindings): Bindings {
    const mode = request.headers.get('x-test-mail-storage');
    const fault = request.headers.get('x-test-mail-storage-fault');
    const target = Number(request.headers.get('x-test-storage-target'));
    const DB = !['commit', 'lost-commit-response'].includes(fault ?? '') ? env.DB : {
        prepare: env.DB.prepare.bind(env.DB),
        async batch(statements: D1PreparedStatement[]) {
            // The inbound R2 commit is the only two-statement batch after the PUT.
            if (statements.length !== 2) return env.DB.batch(statements);
            if (fault === 'commit') throw new Error('Injected D1 commit failure');
            await env.DB.batch(statements);
            throw new Error('Injected lost D1 commit response');
        },
    } as D1Database;
    const bucket = fault === 'missing-binding' ? undefined : env.MAIL_STORAGE;
    const MAIL_STORAGE = bucket && fault ? new Proxy(bucket, {
        get(object, member) {
            const method = Reflect.get(object, member);
            if (typeof method !== 'function') return method;
            return async (...args: unknown[]) => {
                if (member === fault) throw new Error('Injected R2 failure');
                const response = await method.apply(object, args);
                if (member === 'put' && fault === 'expire-write') {
                    await env.DB.prepare('UPDATE mail_storage_gc SET next_retry_at = 0 WHERE object_key = ?')
                        .bind(args[0]).run();
                    await collectMailObjects(mailStorageTestBindings(
                        new Request(request.url, { headers: { 'x-test-mail-storage-fault': 'delete' } }), env));
                }
                if (member === 'put' && fault === 'delete-migration-source' && target && await env.DB.prepare(
                    'SELECT 1 FROM mail_storage_gc WHERE object_key = ? AND mail_id = ?').bind(args[0], target).first()) {
                    await env.DB.batch([
                        env.DB.prepare('DELETE FROM raw_mails WHERE id = ?').bind(target),
                        env.DB.prepare(`INSERT INTO raw_mails (id, address, raw) VALUES (?, 'replacement@example.com', 'replacement')`)
                            .bind(target),
                    ]);
                }
                return response;
            };
        },
    }) : bucket;
    return {
        ...env, DB, MAIL_STORAGE, ...(mode !== null ? {
            MAIL_STORAGE_BACKEND: mode === 'legacy-gzip' ? 'd1' : mode,
            ...(mode === 'legacy-gzip' ? { ENABLE_MAIL_GZIP: true } : {}),
            REMOVE_EXCEED_SIZE_ATTACHMENT: false,
        } : {}),
        ...(request.headers.has('x-test-storage-identity') ? { MAIL_STORAGE_R2_GZIP: false } : {}),
    };
}

export async function inspectMailStorageTest(request: Request, env: Bindings) {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get('id'));
    const row = await env.DB.prepare(`SELECT id, address, created_at, storage_backend, r2_key, raw_encoding,
        raw IS NULL AS raw_empty, raw_blob IS NULL AS blob_empty FROM raw_mails WHERE id = ?`).bind(id).first();
    const key = url.searchParams.get('key') ?? row?.r2_key as string | undefined;
    if (request.method === 'GET' && url.searchParams.has('attachment') && row?.address && row.created_at) {
        return Response.json({ path: await createWebhookAttachmentPath(env.JWT_SECRET, id, String(row.address),
            String(row.created_at), Number(url.searchParams.get('attachment'))) });
    }
    if (request.method === 'POST') {
        const action = url.searchParams.get('action');
        if (action === 'corrupt' && key) await env.MAIL_STORAGE!.put(key, 'corrupt');
        if (action === 'remove' && key) await env.MAIL_STORAGE!.delete(key);
        if (action === 'expire') await env.DB.prepare(
            `UPDATE mail_storage_gc SET next_retry_at = 0, lease_until = 0 WHERE object_key = ?`).bind(key).run();
        if (action === 'custom-delete') {
            return Response.json(await executeCustomSqlCleanup({ env, get: () => 'en' } as Context<HonoCustomType>,
                { enabled: true, name: 'Fixture cleanup', sql: `DELETE FROM raw_mails WHERE id = ${id}` }));
        }
        if (action === 'migration-window') {
            await env.DB.batch([
                env.DB.prepare('DELETE FROM mail_storage_migration'),
                env.DB.prepare('INSERT INTO mail_storage_migration(id, cursor, upper_id) VALUES (1, ?, ?)')
                    .bind(Number(url.searchParams.get('after')), id),
            ]);
        }
        if (action === 'interrupt') {
            // Simulate process termination after the intent and PUT, before any commit.
            const orphan = '_internal/raw-mails/v1/2026/11/' + crypto.randomUUID() + '.eml';
            await env.DB.prepare(`INSERT INTO mail_storage_gc(object_key, reason, next_retry_at)
                VALUES (?, 'write', 0)`).bind(orphan).run();
            await env.MAIL_STORAGE!.put(orphan, 'orphan');
            return Response.json({ key: orphan });
        }
    }
    const object = key ? await env.MAIL_STORAGE!.head(key) : null;
    const { results: queue } = await env.DB.prepare(
        `SELECT object_key, reason, attempts FROM mail_storage_gc ORDER BY created_at, object_key`).all();
    return Response.json({ row, exists: !!object, queue });
}

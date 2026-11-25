import { isMailObjectKey, requireBucket, requireStorageSchema } from './r2';

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 8;
const CLAIM_SECONDS = 5 * 60;
const VERIFY_AFTER_SECONDS = 24 * 60 * 60;

type Task = {
    object_key: string;
    reason: 'write' | 'orphan' | 'delete' | 'verify';
    attempts: number;
};

export async function collectMailObjects(env: Bindings, retryFailed = false) {
    const bucket = requireBucket(env);
    await requireStorageSchema(env);
    const { results } = await env.DB.prepare(`SELECT object_key, reason, attempts FROM mail_storage_gc
        WHERE lease_until <= unixepoch() AND
            ((attempts < ? AND next_retry_at <= unixepoch()) OR (? = 1 AND attempts >= ?))
        ORDER BY next_retry_at LIMIT ?`)
        .bind(MAX_ATTEMPTS, Number(retryFailed), MAX_ATTEMPTS, BATCH_SIZE).all<Task>();
    const result = { deleted: 0, failed: 0, skipped: 0, verifyPending: 0 };
    for (const task of results) {
        const key = task.object_key;
        const token = crypto.randomUUID();
        const claim = await env.DB.prepare(`UPDATE mail_storage_gc
            SET lease_token = ?, lease_until = unixepoch() + ?,
                mail_id = CASE WHEN reason = 'write' THEN NULL ELSE mail_id END,
                reason = CASE WHEN reason = 'write' THEN 'orphan' ELSE reason END
            WHERE object_key = ? AND lease_until <= unixepoch() AND reason = ? AND attempts = ?
            AND ((attempts < ? AND next_retry_at <= unixepoch()) OR (? = 1 AND attempts >= ?))
            AND NOT EXISTS (SELECT 1 FROM raw_mails WHERE r2_key = ?)`)
            .bind(token, CLAIM_SECONDS, key, task.reason, task.attempts, MAX_ATTEMPTS,
                Number(retryFailed), MAX_ATTEMPTS, key).run();
        if (claim.meta.changes !== 1) {
            result.skipped++;
            continue;
        }
        try {
            if (!isMailObjectKey(key)) throw new Error('Invalid mail object key');
            await bucket.delete(key);
        } catch {
            const attempts = task.attempts + 1;
            const errorCode = isMailObjectKey(key) ? 'MAIL_STORAGE_DELETE_FAILED' : 'MAIL_STORAGE_KEY_INVALID';
            await env.DB.prepare(`UPDATE mail_storage_gc SET attempts = ?, last_error_code = ?,
                next_retry_at = unixepoch() + ?, lease_token = NULL, lease_until = 0
                WHERE object_key = ? AND lease_token = ?`)
                .bind(attempts, errorCode, Math.min(3600, 30 * 2 ** Math.min(attempts, 7)), key, token).run();
            console.error('mail storage GC:', errorCode);
            result.failed++;
            continue;
        }
        if (task.reason === 'write' || task.reason === 'orphan') {
            // Recheck after a grace period in case an already-issued PUT completed
            // after the expired intent was fenced and the first delete ran.
            await env.DB.prepare(`UPDATE mail_storage_gc SET reason = 'verify', attempts = 0,
                last_error_code = NULL, next_retry_at = unixepoch() + ?, lease_token = NULL, lease_until = 0
                WHERE object_key = ? AND lease_token = ?`).bind(VERIFY_AFTER_SECONDS, key, token).run();
            result.verifyPending++;
        } else {
            await env.DB.prepare('DELETE FROM mail_storage_gc WHERE object_key = ? AND lease_token = ?')
                .bind(key, token).run();
            result.deleted++;
        }
    }
    return result;
}

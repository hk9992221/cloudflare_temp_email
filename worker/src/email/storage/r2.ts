import { RawMailRow } from '../../models';
import { inspectMailStorageSchema } from './schema';

export const MAX_RAW_MAIL_BYTES = 12 * 1024 * 1024;
const MAX_STORED_BYTES = MAX_RAW_MAIL_BYTES + 64 * 1024;
const WRITE_WINDOW_SECONDS = 20 * 60;
const READY = new WeakSet<D1Database>();
export const MAIL_OBJECT_PREFIX = '_internal/raw-mails/v1/';

export class MailStorageError extends Error {
    constructor(public readonly code: string) {
        super(code);
        this.name = 'MailStorageError';
    }
}

export function configuredBackend(env: Bindings) {
    const backend = env.MAIL_STORAGE_BACKEND ?? 'd1';
    if (backend !== 'd1' && backend !== 'r2') throw new MailStorageError('MAIL_STORAGE_BACKEND_INVALID');
    if (backend === 'r2') gzipEnabled(env);
    return backend;
}

export function requireBucket(env: Bindings) {
    if (!env.MAIL_STORAGE) throw new MailStorageError('MAIL_STORAGE_BINDING_MISSING');
    return env.MAIL_STORAGE;
}

export async function requireStorageSchema(env: Bindings) {
    if (READY.has(env.DB)) return;
    const { ready } = await inspectMailStorageSchema(env.DB);
    if (!ready) throw new MailStorageError('MAIL_STORAGE_SCHEMA_REQUIRED');
    READY.add(env.DB);
}

export function isMailObjectKey(key: string): boolean {
    return /^_internal\/raw-mails\/v1\/\d{4}\/(?:0[1-9]|1[0-2])\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.eml(?:\.gz)?$/.test(key);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readBounded(
    stream: ReadableStream<Uint8Array>, limit: number, expected?: number,
): Promise<ArrayBuffer> {
    const reader = stream.getReader();
    const buffer = expected === undefined ? undefined : new Uint8Array(expected);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const offset = size;
            size += value.byteLength;
            if (size > (expected ?? limit)) throw new MailStorageError('MAIL_STORAGE_SIZE_LIMIT');
            if (buffer) buffer.set(value, offset);
            else chunks.push(value);
        }
        if (buffer) {
            if (size !== expected) throw new MailStorageError('MAIL_STORAGE_OBJECT_CORRUPT');
            return buffer.buffer;
        }
        const output = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return output.buffer;
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
}

export type StoredObject = {
    r2_key: string;
    raw_encoding: 'gzip' | 'identity';
    raw_size: number;
    stored_size: number;
    content_sha256: string;
};

export async function readObject(bucket: R2Bucket, row: RawMailRow | StoredObject): Promise<ArrayBuffer> {
    const { r2_key, raw_encoding, raw_size, stored_size, content_sha256 } = row;
    if (!r2_key || !isMailObjectKey(r2_key) || !content_sha256 ||
        (raw_encoding !== 'identity' && raw_encoding !== 'gzip') ||
        typeof raw_size !== 'number' || !Number.isSafeInteger(raw_size) ||
        raw_size <= 0 || raw_size > MAX_RAW_MAIL_BYTES ||
        typeof stored_size !== 'number' || !Number.isSafeInteger(stored_size) ||
        stored_size <= 0 || stored_size > MAX_STORED_BYTES) {
        throw new MailStorageError('MAIL_STORAGE_REFERENCE_INVALID');
    }
    let object: R2ObjectBody | null;
    try {
        object = await bucket.get(r2_key);
    } catch {
        throw new MailStorageError('MAIL_STORAGE_GET_FAILED');
    }
    if (!object) throw new MailStorageError('MAIL_STORAGE_OBJECT_MISSING');
    if (object.size !== stored_size) {
        await object.body.cancel().catch(() => {});
        throw new MailStorageError('MAIL_STORAGE_OBJECT_CORRUPT');
    }
    try {
        const stream = raw_encoding === 'gzip'
            ? object.body.pipeThrough(new DecompressionStream('gzip'))
            : object.body;
        const raw = await readBounded(stream, MAX_RAW_MAIL_BYTES, raw_size);
        if (await sha256(raw) !== content_sha256) throw new Error('Checksum mismatch');
        return raw;
    } catch {
        throw new MailStorageError('MAIL_STORAGE_OBJECT_CORRUPT');
    }
}

export function summarizeMail(parsed: ParsedEmailContext['parsedEmail']) {
    const sender = parsed?.sender.trim().replace(/^<([^<>]+)>$/, '$1');
    const preview = parsed?.text || parsed?.html.slice(0, 8192).replace(/<[^>]*>/g, ' ') || '';
    return {
        subject: parsed?.subject.slice(0, 512) ?? null,
        sender: sender?.slice(0, 512) || null,
        preview: parsed ? preview.slice(0, 8192).replace(/\s+/g, ' ').trim().slice(0, 768) : null,
        attachment_count: parsed?.attachments?.length ?? null,
    };
}

function gzipEnabled(env: Bindings) {
    const setting = env.MAIL_STORAGE_R2_GZIP;
    if (setting === undefined || setting === true || setting === 'true') return true;
    if (setting === false || setting === 'false') return false;
    throw new MailStorageError('MAIL_STORAGE_R2_GZIP_INVALID');
}

export function newMailObjectKey(env: Bindings) {
    const date = new Date().toISOString().slice(0, 7).replace('-', '/');
    return `${MAIL_OBJECT_PREFIX}${date}/${crypto.randomUUID()}.eml${gzipEnabled(env) ? '.gz' : ''}`;
}

export async function prepareObject(env: Bindings, raw: ArrayBuffer, key = newMailObjectKey(env)) {
    if (raw.byteLength === 0 || raw.byteLength > MAX_RAW_MAIL_BYTES) {
        throw new MailStorageError('MAIL_STORAGE_SIZE_LIMIT');
    }
    const gzip = gzipEnabled(env);
    let stored = raw;
    if (gzip) {
        try {
            stored = await readBounded(
                new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')), MAX_STORED_BYTES);
        } catch {
            throw new MailStorageError('MAIL_STORAGE_GZIP_FAILED');
        }
    }
    const object: StoredObject = {
        r2_key: key,
        raw_encoding: gzip ? 'gzip' : 'identity',
        raw_size: raw.byteLength,
        stored_size: stored.byteLength,
        content_sha256: await sha256(raw),
    };
    return { object, stored };
}

export async function openWriteIntent(db: D1Database, key: string, mailId?: number) {
    // Deleting a source row clears its migration intent in the same transaction.
    const statement = mailId === undefined
        ? db.prepare(`INSERT INTO mail_storage_gc(object_key, reason, next_retry_at)
            VALUES (?, 'write', unixepoch() + ?)`).bind(key, WRITE_WINDOW_SECONDS)
        : db.prepare(`INSERT OR IGNORE INTO mail_storage_gc(object_key, reason, next_retry_at, mail_id)
            SELECT ?, 'write', unixepoch() + ?, id FROM raw_mails
            WHERE id = ? AND storage_backend = 'd1'`).bind(key, WRITE_WINDOW_SECONDS, mailId);
    if (mailId === undefined) return (await statement.run()).meta.changes === 1;
    const [, result] = await db.batch([
        db.prepare(`UPDATE mail_storage_gc SET mail_id = NULL, reason = 'orphan'
            WHERE mail_id = ? AND next_retry_at <= unixepoch()`).bind(mailId),
        statement,
    ]);
    return result.meta.changes === 1;
}

export async function putObject(bucket: R2Bucket, object: StoredObject, stored: ArrayBuffer) {
    try {
        const result = await bucket.put(object.r2_key, stored, {
            sha256: await sha256(stored),
            onlyIf: { etagDoesNotMatch: '*' },
            customMetadata: {
                version: '1',
                encoding: object.raw_encoding,
                rawSize: String(object.raw_size),
                storedSize: String(object.stored_size),
                sha256: object.content_sha256,
            },
        });
        if (!result) throw new Error('Object already exists');
    } catch {
        throw new MailStorageError('MAIL_STORAGE_PUT_FAILED');
    }
}

export const activeWriteIntent = `SELECT 1 FROM mail_storage_gc
    WHERE object_key = ? AND reason = 'write' AND next_retry_at > unixepoch() AND lease_token IS NULL`;

export function finishWriteIntent(db: D1Database, key: string) {
    return db.prepare(`DELETE FROM mail_storage_gc WHERE object_key = ?
        AND EXISTS (SELECT 1 FROM raw_mails WHERE r2_key = ?)`).bind(key, key);
}

export async function abandonWriteIntent(db: D1Database, key: string) {
    // A lost D1 response can mean the transaction committed. Preserve any live reference.
    await db.prepare(`UPDATE mail_storage_gc SET mail_id = NULL, reason = 'orphan', next_retry_at = unixepoch()
        WHERE object_key = ? AND reason = 'write' AND lease_token IS NULL
        AND NOT EXISTS (SELECT 1 FROM raw_mails WHERE r2_key = ?)`).bind(key, key).run();
}

export function storedObjectFields(object: StoredObject, summary: ReturnType<typeof summarizeMail>) {
    return [object.r2_key, object.raw_encoding, object.raw_size, object.stored_size, object.content_sha256,
        summary.subject, summary.sender, summary.preview, summary.attachment_count];
}

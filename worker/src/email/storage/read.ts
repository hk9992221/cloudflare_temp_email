import { decodeMailBytes, resolveRawEmail as resolveD1Raw } from '../../gzip';
import { RawMailRow } from '../../models';
import { recipientMetadata } from '../../utils/recipient_resolver';
import { MailStorageError, MAX_RAW_MAIL_BYTES, readBounded, readObject, requireBucket } from './r2';

export async function readLegacyMailBytes(row: RawMailRow, limit = MAX_RAW_MAIL_BYTES): Promise<ArrayBuffer> {
    if (row.raw_blob != null) {
        try {
            const blob = new Uint8Array(row.raw_blob as ArrayLike<number>);
            return await readBounded(new Blob([blob]).stream().pipeThrough(
                new DecompressionStream('gzip')), limit);
        } catch (error) {
            if (error instanceof MailStorageError) throw error;
            if (typeof row.raw !== 'string') throw new MailStorageError('MAIL_STORAGE_LEGACY_CORRUPT');
        }
    }
    if (typeof row.raw !== 'string') throw new MailStorageError('MAIL_STORAGE_LEGACY_MISSING');
    return new TextEncoder().encode(row.raw).buffer as ArrayBuffer;
}

export async function readRawMailBytes(env: Bindings, row: RawMailRow) {
    if (row.storage_backend === 'r2') return readObject(requireBucket(env), row);
    return readLegacyMailBytes(row, 25 * 1024 * 1024);
}

export async function resolveRawEmail(env: Bindings, row: RawMailRow): Promise<string> {
    if (row.storage_backend !== 'r2') return resolveD1Raw(row);
    return decodeMailBytes(await readRawMailBytes(env, row));
}

export async function rawMailParseContext(env: Bindings, row: RawMailRow): Promise<ParsedEmailContext> {
    const recipient = recipientMetadata(row.address ?? '', row.original_recipient ?? row.address ?? '', row.alias_tag ?? null);
    if (row.storage_backend !== 'r2' && row.raw_blob == null) return { rawEmail: row.raw ?? '', recipient };
    const rawBytes = await readRawMailBytes(env, row);
    return { rawEmail: decodeMailBytes(rawBytes), rawBytes, recipient };
}

export function publicMailRow(row: RawMailRow) {
    const { raw_blob: _blob, storage_backend: _backend, r2_key: _key, raw_encoding: _encoding,
        raw_size: _size, stored_size: _stored, content_sha256: _hash, subject: _subject, sender: _sender,
        preview: _preview, attachment_count: _attachments, ...publicRow } = row;
    return { ...publicRow, original_recipient: row.original_recipient ?? row.address, alias_tag: row.alias_tag ?? null };
}

export async function resolveRawEmailRow(env: Bindings, row: RawMailRow) {
    return { ...publicMailRow(row), raw: await resolveRawEmail(env, row) };
}

export async function downloadRawMail(env: Bindings, row: RawMailRow) {
    return new Response(await readRawMailBytes(env, row), {
        headers: {
            'Content-Type': 'message/rfc822',
            'Content-Disposition': `attachment; filename="${row.id}.eml"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

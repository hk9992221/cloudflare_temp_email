import { Context } from "hono";
import { createMimeMessage } from "mimetext";

import { compressMail } from "../gzip";
import { getBooleanValue } from "../utils";
import { commonParseMail } from "../utils/mail_parser";
import {
    abandonWriteIntent, activeWriteIntent, configuredBackend, finishWriteIntent, MailStorageError,
    openWriteIntent, prepareObject, putObject, requireBucket, requireStorageSchema, storedObjectFields,
    summarizeMail,
} from "./storage/r2";

type SaveResult = Pick<D1Result, 'success'> & { meta: Pick<D1Result['meta'], 'last_row_id'> };

let rawMailTableColumns: Set<string> | undefined;

const getRawMailTableColumns = async (
    env: Bindings, requiredColumns: string[]
): Promise<Set<string>> => {
    const cachedColumns = rawMailTableColumns;
    if (cachedColumns && requiredColumns.every(column => cachedColumns.has(column))) {
        return cachedColumns;
    }
    const tableInfo = await env.DB.prepare(`PRAGMA table_info(raw_mails)`).all<{ name: string }>();
    const columns = new Set(tableInfo.results.map(column => column.name));
    if (requiredColumns.every(column => columns.has(column))) {
        rawMailTableColumns = columns;
    }
    return columns;
}

export const storeRawMail = async (
    env: Bindings,
    source: string,
    address: string,
    messageId: string | null,
    input: string | ParsedEmailContext,
): Promise<SaveResult> => {
    const mail = typeof input === 'string' ? { rawEmail: input } : input;
    if (configuredBackend(env) === 'r2') {
        return storeR2Mail(env, source, address, messageId, mail);
    }
    const raw = mail.rawEmail;
    const requiresBinary = mail.rawBytes !== undefined && needsBinaryStorage(mail.rawEmail, mail.rawBytes);
    const gzipEnabled = requiresBinary || getBooleanValue(env.ENABLE_MAIL_GZIP);
    const readStatusEnabled = getBooleanValue(env.ENABLE_MAIL_READ_STATUS);
    const requiredColumns: string[] = [];
    if (gzipEnabled) requiredColumns.push('raw_blob');
    if (readStatusEnabled) requiredColumns.push('is_unread');

    let tableColumns = new Set<string>();
    if (requiredColumns.length > 0) {
        tableColumns = await getRawMailTableColumns(env, requiredColumns);
    }

    if (requiresBinary && !tableColumns.has('raw_blob')) throw new MailStorageError('MAIL_STORAGE_SCHEMA_REQUIRED');

    let rawBlob: ArrayBuffer | undefined;
    if (gzipEnabled && tableColumns.has('raw_blob')) {
        try {
            rawBlob = await compressMail(mail.rawBytes ?? raw);
        } catch (error) {
            if (requiresBinary) throw new MailStorageError('MAIL_STORAGE_GZIP_FAILED');
            console.error("gzip compression failed, falling back to plaintext", error);
        }
    }

    const storeUnreadStatus = readStatusEnabled && tableColumns.has('is_unread');
    if (rawBlob) {
        if (!storeUnreadStatus) {
            return env.DB.prepare(
                `INSERT INTO raw_mails (source, address, raw_blob, message_id) VALUES (?, ?, ?, ?)`
            ).bind(source, address, rawBlob, messageId).run();
        }
        return env.DB.prepare(
            `INSERT INTO raw_mails (source, address, raw_blob, message_id, is_unread) VALUES (?, ?, ?, ?, 1)`
        ).bind(source, address, rawBlob, messageId).run();
    }
    if (!storeUnreadStatus) {
        return env.DB.prepare(
            `INSERT INTO raw_mails (source, address, raw, message_id) VALUES (?, ?, ?, ?)`
        ).bind(source, address, raw, messageId).run();
    }
    return env.DB.prepare(
        `INSERT INTO raw_mails (source, address, raw, message_id, is_unread) VALUES (?, ?, ?, ?, 1)`
    ).bind(source, address, raw, messageId).run();
}

function needsBinaryStorage(text: string, bytes: ArrayBuffer): boolean {
    if (!text.includes('\uFFFD')) return false;
    try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
        return false;
    } catch {
        // D1 TEXT cannot represent invalid UTF-8 bytes. Use the existing
        // compressed BLOB field even when compression is disabled for text.
        return true;
    }
}

async function storeR2Mail(
    env: Bindings, source: string, address: string, messageId: string | null, mail: ParsedEmailContext,
): Promise<SaveResult> {
    const bucket = requireBucket(env);
    await requireStorageSchema(env);
    const raw = mail.rawBytes ?? new TextEncoder().encode(mail.rawEmail).buffer as ArrayBuffer;
    const { object, stored } = await prepareObject(env, raw);
    const summary = summarizeMail(await commonParseMail(mail));
    const key = object.r2_key;
    if (!await openWriteIntent(env.DB, key)) throw new MailStorageError('MAIL_STORAGE_INTENT_FAILED');
    try {
        await putObject(bucket, object, stored);
        const [insert] = await env.DB.batch([
            env.DB.prepare(`INSERT INTO raw_mails (source, address, message_id, is_unread, storage_backend,
                r2_key, raw_encoding, raw_size, stored_size, content_sha256, subject, sender, preview, attachment_count)
                SELECT ?, ?, ?, ?, 'r2', ?, ?, ?, ?, ?, ?, ?, ?, ?
                WHERE EXISTS (${activeWriteIntent})`).bind(source, address, messageId,
                    getBooleanValue(env.ENABLE_MAIL_READ_STATUS) ? 1 : null,
                    ...storedObjectFields(object, summary), key),
            finishWriteIntent(env.DB, key),
        ]);
        if (!insert.success || insert.meta.changes !== 1) throw new MailStorageError('MAIL_STORAGE_COMMIT_FAILED');
        return insert;
    } catch (error) {
        const committed = await env.DB.prepare('SELECT id FROM raw_mails WHERE r2_key = ?')
            .bind(key).first<number>('id').catch(() => null);
        if (committed) return { success: true, meta: { last_row_id: committed } };
        await abandonWriteIntent(env.DB, key).catch(() => {});
        throw error instanceof MailStorageError ? error : new MailStorageError('MAIL_STORAGE_COMMIT_FAILED');
    }
}

export const deleteRawMail = async (
    env: Bindings, mailId: number, address: string
): Promise<void> => {
    try {
        const { success } = await env.DB.prepare(
            `DELETE FROM raw_mails WHERE id = ? AND address = ?`
        ).bind(mailId, address).run();
        if (!success) throw new Error(`Failed to delete mail ${mailId}`);
    } catch (error) {
        console.error("delete mail error", error);
    }
};

export const sendAdminInternalMail = async (
    c: Context<HonoCustomType>, toMail: string, subject: string, text: string
): Promise<boolean> => {
    try {
        const msg = createMimeMessage();
        msg.setSender({
            name: "Admin",
            addr: "admin@internal"
        });
        msg.setRecipient(toMail);
        msg.setSubject(subject);
        msg.addMessage({
            contentType: 'text/plain',
            data: text
        });
        const messageId = Math.random().toString(36).substring(2, 15);
        const { success } = await storeRawMail(
            c.env, "admin@internal", toMail, messageId, msg.asRaw()
        );
        if (!success) {
            console.log(`Failed save message from admin@internal to ${toMail}`);
        }
        return success;
    } catch (error) {
        console.log("sendAdminInternalMail error", error);
        return false;
    }
};

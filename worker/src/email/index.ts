import { Context } from "hono";

import { getJsonSetting, normalizeAddressDomain } from "../utils";
import { sendMailToTelegram } from "../telegram_api";
import { auto_reply } from "./auto_reply";
import { isBlocked } from "./black_list";
import { triggerWebhook, triggerAnotherWorker } from "../common";
import { commonParseMail } from "../utils/mail_parser";
import { check_if_junk_mail } from "./check_junk";
import { remove_attachment_if_need } from "./check_attachment";
import { extractEmailInfo } from "./ai_extract";
import { forwardEmail } from "./forward";
import { EmailRuleSettings } from "../models";
import { CONSTANTS } from "../constants";
import { deleteRawMail, storeRawMail } from "./storage";
import { configuredBackend, MailStorageError, MAX_RAW_MAIL_BYTES, readBounded } from "./storage/r2";


async function receiveEmail(
    message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext,
    allowForward: boolean = true, onStored?: () => void
): Promise<void> {
    const toAddress = normalizeAddressDomain(message.to);
    if (await isBlocked(message, env)) {
        message.setReject("Reject from address");
        console.log(`Reject message from ${message.from} to ${toAddress}`);
        return;
    }
    const parsedEmailContext: ParsedEmailContext = { rawEmail: '' };
    try {
        if (configuredBackend(env) === 'r2') {
            if (message.rawSize > MAX_RAW_MAIL_BYTES) throw new MailStorageError('MAIL_STORAGE_SIZE_LIMIT');
            parsedEmailContext.rawBytes = await readBounded(message.raw, MAX_RAW_MAIL_BYTES);
            parsedEmailContext.rawEmail = new TextDecoder().decode(parsedEmailContext.rawBytes);
        } else {
            parsedEmailContext.rawEmail = await new Response(message.raw).text();
        }
    } catch (error) {
        rejectStorageFailure(message, error);
        return;
    }
    const { rawEmail, rawBytes } = parsedEmailContext;

    // check if junk mail
    try {
        const is_junk = await check_if_junk_mail(env, toAddress, parsedEmailContext, message.headers.get("Message-ID"));
        if (is_junk) {
            message.setReject("Junk mail");
            console.log(`Junk mail from ${message.from} to ${toAddress}`);
            return;
        }
    } catch (error) {
        console.error("check junk mail error", error);
    }

    // check if unknown address mail
    try {
        const emailRuleSettings = await getJsonSetting<EmailRuleSettings>(
            { env: env } as Context<HonoCustomType>, CONSTANTS.EMAIL_RULE_SETTINGS_KEY
        );
        if (emailRuleSettings?.blockReceiveUnknowAddressEmail) {
            const db_address_id = await env.DB.prepare(
                `SELECT id FROM address where name = ? `
            ).bind(toAddress).first("id");
            if (!db_address_id) {
                message.setReject("Unknown address");
                console.log(`Unknown address mail from ${message.from} to ${toAddress}`);
                return;
            }
        }
    } catch (error) {
        console.error("check unknown address mail error", error);
    }

    // remove attachment if configured or size > 2MB
    try {
        await remove_attachment_if_need(env, parsedEmailContext, message.from, toAddress, message.rawSize);
    } catch (error) {
        console.error("remove attachment error", error);
    }

    const message_id = message.headers.get("Message-ID");
    // save email
    let storedMailId: number;
    try {
        const result = await storeRawMail(env, message.from, toAddress, message_id, parsedEmailContext);
        if (!result.success || !result.meta.last_row_id) throw new MailStorageError('MAIL_STORAGE_COMMIT_FAILED');
        storedMailId = result.meta.last_row_id;
    } catch (error) {
        rejectStorageFailure(message, error);
        return;
    }
    onStored?.();

    // forward email
    const { deleteOriginal: deleteAfterForward } = allowForward
        ? await forwardEmail(message, env, rawBytes ?? rawEmail,
            (targetMessage, onTargetStored) => receiveEmail(targetMessage, env, ctx, false, onTargetStored))
        : { deleteOriginal: false };

    // AI email content extraction
    const aiExtractResult = await extractEmailInfo(parsedEmailContext, env, storedMailId, toAddress);

    // send email to telegram
    try {
        await sendMailToTelegram(
            { env: env } as Context<HonoCustomType>,
            toAddress, parsedEmailContext, storedMailId, aiExtractResult);
    } catch (error) {
        console.error("send mail to telegram error", error);
    }

    // send webhook
    try {
        await triggerWebhook(
            { env: env } as Context<HonoCustomType>,
            toAddress, parsedEmailContext, storedMailId, aiExtractResult
        );
    } catch (error) {
        console.error("send webhook error", error);
    }

    // trigger another worker
    try {
        const parsedEmail = (await commonParseMail(parsedEmailContext));
        const parsedText = parsedEmail?.text ?? ""
        const rpcEmail: RPCEmailMessage = {
            from: message.from,
            to: toAddress,
            rawEmail: rawEmail,
            headers: message.headers
        }
        await triggerAnotherWorker({ env: env } as Context<HonoCustomType>, rpcEmail, parsedText);
    } catch (error) {
        console.error("trigger another worker error", error);
    }

    // auto reply email
    if (allowForward) await auto_reply(message, env, toAddress);

    const shouldDeleteMail = deleteAfterForward;
    if (shouldDeleteMail && storedMailId) await deleteRawMail(env, storedMailId, toAddress);
}

function rejectStorageFailure(message: ForwardableEmailMessage, error: unknown) {
    const code = error instanceof MailStorageError ? error.code : 'MAIL_STORAGE_WRITE_FAILED';
    console.error('mail storage rejected delivery:', code);
    message.setReject(`Email could not be stored (${code})`);
}

async function email(message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext): Promise<void> {
    await receiveEmail(message, env, ctx);
}

export { email }

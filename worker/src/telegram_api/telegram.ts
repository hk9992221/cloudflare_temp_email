
import { Context } from "hono";
import { Telegraf, Context as TgContext, Markup } from "telegraf";
import { callbackQuery, message } from "telegraf/filters";

import { CONSTANTS } from "../constants";
import { getBooleanValue, getJsonObjectValue, htmlToText } from '../utils';
import { TelegramSettings } from "./settings";
import { sendTelegramAttachments } from "./tg_file_upload";
import { jwtListToAddressData } from "./common";
import { getTelegramCommands, telegramCommandHandlers } from "./commands";
import { isConversationCallback, TelegramConversationManager } from "./conversation";
import type { CommandContext, CommandReply } from "./conversation";
import { commonParseMail } from "../utils/mail_parser";
import { rawMailParseContext } from "../email/storage/read";
import { UserFromGetMe } from "telegraf/types";
import i18n from "../i18n";
import { LocaleMessages } from "../i18n/type";
import type { ExtractResult, RawMailRow } from "../models";
import { recipientMetadata } from "../utils/recipient_resolver";


// Helper to get messages by userId
const getTgMessages = async (
    c: Context<HonoCustomType>,
    ctx?: TgContext,
    userId?: string | null
): Promise<LocaleMessages> => {
    // Check if user language config is enabled (default false)
    if (!getBooleanValue(c.env.TG_ALLOW_USER_LANG)) {
        return i18n.getMessages(c.env.DEFAULT_LANG || 'zh');
    }

    const uid = userId || ctx?.message?.from?.id?.toString() || ctx?.callbackQuery?.from?.id?.toString();
    if (uid) {
        const savedLang = await c.env.KV.get(`${CONSTANTS.TG_KV_PREFIX}:lang:${uid}`);
        if (savedLang) { return i18n.getMessages(savedLang); }
    }
    return i18n.getMessages(c.env.DEFAULT_LANG || 'zh');
};

const formatAiExtractForTelegram = (
    msgs: LocaleMessages,
    aiExtract?: ExtractResult | string | null
): string => {
    if (!aiExtract) {
        return "";
    }

    try {
        if (typeof aiExtract === "string") {
            const metadata = JSON.parse(aiExtract);
            aiExtract = metadata?.ai_extract;
        }
    } catch (error) {
        console.warn("Failed to parse AI extraction metadata", error);
        return "";
    }

    if (!aiExtract || typeof aiExtract !== "object") {
        return "";
    }

    const labels: Record<Exclude<ExtractResult["type"], "none">, string> = {
        auth_code: msgs.TgAiExtractAuthCodeMsg,
        auth_link: msgs.TgAiExtractAuthLinkMsg,
        service_link: msgs.TgAiExtractServiceLinkMsg,
        subscription_link: msgs.TgAiExtractSubscriptionLinkMsg,
        other_link: msgs.TgAiExtractOtherLinkMsg,
    };
    const label = labels[aiExtract.type as keyof typeof labels];
    const result = typeof aiExtract.result === "string"
        ? aiExtract.result.replace(/\s+/g, " ").trim().slice(0, 600)
        : "";
    if (!result) {
        return "";
    }

    if (!label) {
        return "";
    }

    const resultText = typeof aiExtract.result_text === "string"
        ? aiExtract.result_text.replace(/\s+/g, " ").trim().slice(0, 120)
        : "";
    const displayText = aiExtract.type !== "auth_code" && resultText && resultText !== result
        ? ` (${resultText})`
        : "";
    return `${msgs.TgAiExtractResultMsg}\n${label}: ${result}${displayText}\n\n`;
}

const readTelegramMail = async (
    c: Context<HonoCustomType>, { userId, msgs }: CommandContext,
    query: string | number, mailIndex: number,
): Promise<CommandReply> => {
    const jwtList = await c.env.KV.get<string[]>(`${CONSTANTS.TG_KV_PREFIX}:${userId}`, 'json') || [];
    const { addressIdMap } = await jwtListToAddressData(c, jwtList, msgs);
    const addresses = Object.keys(addressIdMap);
    const queryAddress = typeof query === 'number' ? addresses.find(address => addressIdMap[address] === query)
        : query || addresses[0];
    if (!queryAddress || !(queryAddress in addressIdMap)) {
        return { text: `${msgs.TgNotBoundAddressMsg} ${typeof query === 'string' ? query : ''}`.trim() };
    }
    const addressId = addressIdMap[queryAddress];
    const dbAddressId = await c.env.DB.prepare('SELECT id FROM address WHERE id = ?')
        .bind(addressId).first('id');
    if (!dbAddressId) return { text: msgs.TgInvalidAddressMsg };
    const mailRow = await c.env.DB.prepare(
        'SELECT * FROM raw_mails WHERE address = ? ORDER BY id DESC LIMIT 1 OFFSET ?'
    ).bind(queryAddress, mailIndex).first<RawMailRow>();
    const mailContext = mailRow ? await rawMailParseContext(c.env, mailRow) : undefined;
    if (mailContext && mailRow?.alias_tag) {
        mailContext.recipient = recipientMetadata(queryAddress, mailRow.original_recipient ?? queryAddress, mailRow.alias_tag);
    }
    const { mail } = mailContext
        ? await parseMail(msgs, mailContext, queryAddress, mailRow?.created_at, mailRow?.metadata)
        : { mail: msgs.TgNoMoreMailsMsg };
    const settings = await c.env.KV.get<TelegramSettings>(CONSTANTS.TG_KV_SETTINGS_KEY, 'json');
    const miniAppButtons = [];
    if (settings?.miniAppUrl && mailRow?.id) {
        const url = new URL(settings.miniAppUrl);
        url.pathname = '/telegram_mail';
        url.searchParams.set('mail_id', String(mailRow.id));
        miniAppButtons.push(Markup.button.webApp(msgs.TgViewMailBtnMsg, url.toString()));
    }
    return { text: mail || msgs.TgNoMailMsg, ...Markup.inlineKeyboard([
        Markup.button.callback(msgs.TgPrevBtnMsg, `mail:${addressId}:${mailIndex - 1}`, mailIndex <= 0),
        ...miniAppButtons,
        Markup.button.callback(msgs.TgNextBtnMsg, `mail:${addressId}:${mailIndex + 1}`, !mailContext),
    ]) };
};

export function newTelegramBot(c: Context<HonoCustomType>, token: string): Telegraf {
    const bot = new Telegraf(token);
    const botInfo = getJsonObjectValue<UserFromGetMe>(c.env.TG_BOT_INFO);
    if (botInfo) bot.botInfo = botInfo;
    bot.catch(() => { throw new Error('Telegram update processing failed'); });

    const authorize = async (userId: string) => {
        const settings = await c.env.KV.get<TelegramSettings>(CONSTANTS.TG_KV_SETTINGS_KEY, 'json');
        return !settings?.enableAllowList || settings.allowList.includes(userId);
    };
    const messages = (ctx: TgContext) => getTgMessages(c, ctx);
    const commands = telegramCommandHandlers(c, (context, address, index) => readTelegramMail(c, context, address, index));
    const manager = new TelegramConversationManager(c.env.DB, commands, messages, authorize, (text) =>
        ['zh', 'en'].some(lang => text.endsWith(i18n.getMessages(lang).TgConversationTextHelpMsg)));

    bot.use(async (ctx, next) => {
        try {
            // Keep all command and mailbox operations restricted to private chats.
            if (ctx.chat?.type !== 'private' || !ctx.from || !await authorize(String(ctx.from.id))) {
                const msgs = await messages(ctx);
                if (ctx.callbackQuery) await ctx.answerCbQuery(msgs.TgNoPermissionMsg);
                else if (ctx.chat?.type === 'private') await ctx.reply(msgs.TgNoPermissionMsg);
                return;
            }
            await next();
        } catch {
            // Telegram errors can contain request payloads such as credentials.
            console.error('Telegram command processing failed');
            const msgs = i18n.getMessages(c.env.DEFAULT_LANG || 'zh');
            if (ctx.callbackQuery) {
                await ctx.answerCbQuery(msgs.TgConversationErrorMsg).catch(() => undefined);
            }
            if (ctx.chat?.type === 'private') await ctx.reply(msgs.TgConversationErrorMsg).catch(() => undefined);
        }
    });

    bot.on(callbackQuery('data'), async ctx => {
        const { data, message } = ctx.callbackQuery;
        if (isConversationCallback(data)) {
            await manager.callback(ctx, data, message?.message_id,
                message && ('edit_date' in message ? message.edit_date ?? message.date : message.date));
            return;
        }
        // Keep already-sent mail pagination buttons usable.
        const current = /^mail:(\d+):(\d+)$/.exec(data);
        const legacy = current ? null : /^mail_(.+)_(\d+)$/.exec(data);
        await ctx.answerCbQuery();
        if (!current && !legacy) return;
        const index = Number((current ?? legacy)![2]);
        if (!message || !Number.isSafeInteger(index) || index >= Number.MAX_SAFE_INTEGER) return;
        const msgs = await messages(ctx);
        const result = await readTelegramMail(c, { userId: String(ctx.from.id), msgs },
            current ? Number(current[1]) : legacy![1], index);
        try {
            await ctx.editMessageText(result.text, { reply_markup: result.reply_markup ?? { inline_keyboard: [] } });
        } catch {
            await ctx.reply(result.text, { reply_markup: result.reply_markup });
        }
    });

    bot.command('cancel', ctx => manager.cancel(ctx));
    for (const name of Object.keys(commands)) {
        bot.command(name, ctx => manager.start(ctx, name, ctx.payload));
    }

    bot.on(message('text'), async ctx => {
        const { text, entities, reply_to_message: reply } = ctx.message;
        if (entities?.some(entity => entity.type === 'bot_command' && entity.offset === 0)) {
            // A command for another bot is neither a switch nor input.
            const target = text.split(/\s/, 1)[0].split('@')[1];
            if (!target || target.toLowerCase() === ctx.botInfo.username.toLowerCase()) await manager.cancel(ctx, true);
            return;
        }
        const isPromptReply = reply?.from?.id === ctx.botInfo.id && 'text' in reply
            && !!reply.text && manager.isPrompt(reply.text);
        await manager.input(ctx, text, reply?.message_id, isPromptReply);
    });

    return bot;
}

export async function initTelegramBotCommands(c: Context<HonoCustomType>, bot: Telegraf) {
    await bot.telegram.setMyCommands(getTelegramCommands(c));
}

const parseMail = async (
    msgs: LocaleMessages,
    parsedEmailContext: ParsedEmailContext,
    address: string,
    created_at: string | undefined | null,
    aiExtract?: ExtractResult | string | null
) => {
    if (!parsedEmailContext.rawEmail) {
        return {};
    }
    try {
        const parsedEmail = await commonParseMail(parsedEmailContext);
        let parsedText = parsedEmail?.text || "";
        if (!parsedText.trim() && parsedEmail?.html) {
            parsedText = htmlToText(parsedEmail.html);
        }
        if (parsedText.length && parsedText.length > 1000) {
            parsedText = parsedText.substring(0, 1000) + `\n\n...\n${msgs.TgMsgTooLongMsg}`;
        }
        return {
            isHtml: false,
            mail: formatAiExtractForTelegram(msgs, aiExtract)
                + `From: ${parsedEmail?.sender || msgs.TgNoSenderMsg}\n`
                + `To: ${address}\n`
                + (parsedEmailContext.recipient?.is_plus_alias
                    ? `${msgs.TgOriginalRecipientMsg} ${parsedEmailContext.recipient.original_recipient}\n`
                      + `${msgs.TgAliasTagMsg} +${parsedEmailContext.recipient.alias_tag}\n` : '')
                + (created_at ? `Date: ${created_at}\n` : "")
                + `Subject: ${parsedEmail?.subject}\n`
                + `Content:\n${parsedText || msgs.TgParseFailedViewInAppMsg}`
        };
    } catch (e) {
        return {
            isHtml: false,
            mail: `${msgs.TgParseMailFailedMsg} ${(e as Error).message}`
        };
    }
}


export async function sendMailToTelegram(
    c: Context<HonoCustomType>, address: string,
    parsedEmailContext: ParsedEmailContext,
    mailId: number | undefined,
    aiExtract?: ExtractResult | null
) {
    if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.KV) {
        return;
    }
    const userId = await c.env.KV.get(`${CONSTANTS.TG_KV_PREFIX}:${address}`);
    const settings = await c.env.KV.get<TelegramSettings>(CONSTANTS.TG_KV_SETTINGS_KEY, "json");
    const globalPush = settings?.enableGlobalMailPush && settings?.globalMailPushList;
    if (!userId && !globalPush) {
        return;
    }
    const bot = newTelegramBot(c, c.env.TELEGRAM_BOT_TOKEN);

    const buildAndSend = async (targetUserId: string, msgs: LocaleMessages) => {
        const { mail } = await parseMail(
            msgs, parsedEmailContext, address, new Date().toUTCString(), aiExtract
        );
        if (!mail) return;
        const attachments = parsedEmailContext.parsedEmail?.attachments || [];
        const buttons = [];
        if (settings?.miniAppUrl && mailId) {
            const url = new URL(settings.miniAppUrl);
            url.pathname = "/telegram_mail"
            url.searchParams.set("mail_id", String(mailId));
            buttons.push(Markup.button.webApp(msgs.TgViewMailBtnMsg, url.toString()));
        }
        await bot.telegram.sendMessage(targetUserId, mail, {
            ...Markup.inlineKeyboard([...buttons])
        });
        // send attachments via native fetch (telegraf multipart upload is incompatible with CF Workers)
        if (getBooleanValue(c.env.ENABLE_TG_PUSH_ATTACHMENT) && attachments.length > 0) {
            const caption = `From: ${parsedEmailContext.parsedEmail?.sender || ""}\nSubject: ${parsedEmailContext.parsedEmail?.subject || ""}`;
            const failed = await sendTelegramAttachments(c.env.TELEGRAM_BOT_TOKEN, targetUserId, attachments, caption);
            if (failed > 0) {
                try {
                    await bot.telegram.sendMessage(targetUserId, msgs.TgAttachmentUploadFailedMsg.replace('{count}', String(failed)), {
                        ...Markup.inlineKeyboard([...buttons])
                    });
                } catch {
                    console.warn("Telegram attachment failure notice could not be sent");
                }
            }
        }
    };

    if (globalPush) {
        const globalMsgs = i18n.getMessages(c.env.DEFAULT_LANG || 'zh');
        for (const pushId of settings.globalMailPushList) {
            await buildAndSend(pushId, globalMsgs);
        }
    }

    if (userId && !(globalPush || []).some(id => String(id) === userId)) {
        const userMsgs = await getTgMessages(c, undefined, userId);
        await buildAndSend(userId, userMsgs);
    }
}

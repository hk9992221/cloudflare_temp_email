import { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

import { newTelegramBot, initTelegramBotCommands, sendMailToTelegram } from './telegram'
import settings from './settings'
import miniapp from './miniapp'
import i18n from '../i18n'

export const api = new Hono<HonoCustomType>();
export { sendMailToTelegram }

const telegramWebhookSecret = (token: string) =>
    createHmac('sha256', token).update('cloudflare-temp-email:telegram-webhook:v1').digest('hex');

api.use("/telegram/*", async (c, next) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!c.env.TELEGRAM_BOT_TOKEN) {
        return c.text(msgs.TgBotTokenRequiredMsg, 400);
    }
    if (!c.env.KV) {
        return c.text(msgs.KVNotAvailableMsg, 400);
    }
    return await next();
});

api.use("/admin/telegram/*", async (c, next) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!c.env.TELEGRAM_BOT_TOKEN) {
        return c.text(msgs.TgBotTokenRequiredMsg, 400);
    }
    if (!c.env.KV) {
        return c.text(msgs.KVNotAvailableMsg, 400);
    }
    return await next();
});

api.post("/telegram/webhook", async (c) => {
    const token = c.env.TELEGRAM_BOT_TOKEN;
    const header = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (!header || !/^[a-f0-9]{64}$/.test(header)
        || !timingSafeEqual(Buffer.from(header), Buffer.from(telegramWebhookSecret(token)))) {
        return c.text('Unauthorized', 401);
    }
    const reqJson = await c.req.json().catch(() => null);
    if (!Number.isSafeInteger(reqJson?.update_id)) return c.text('Invalid update', 400);
    try {
        // An actual sendMessage response is required to associate ForceReply prompts.
        await newTelegramBot(c, token).handleUpdate(reqJson);
        return c.body(null, 200);
    } catch {
        console.error('Telegram webhook update failed');
        return c.text('Telegram update failed', 500);
    }
});

api.post("/admin/telegram/init", async (c) => {
    const domain = new URL(c.req.url).host;
    const token = c.env.TELEGRAM_BOT_TOKEN;
    const webhookUrl = `https://${domain}/telegram/webhook`;
    console.log(`setting webhook to ${webhookUrl}`);
    const bot = newTelegramBot(c, token);
    try {
        await bot.telegram.setWebhook(webhookUrl, { secret_token: telegramWebhookSecret(token) });
        await initTelegramBotCommands(c, bot);
    } catch {
        console.error('Telegram webhook initialization failed');
        return c.text(i18n.getMessagesbyContext(c).TgConversationErrorMsg, 502);
    }
    return c.json({
        message: "webhook set successfully",
    });
});

api.get("/admin/telegram/status", async (c) => {
    const token = c.env.TELEGRAM_BOT_TOKEN;
    const bot = newTelegramBot(c, token);
    const info = await bot.telegram.getWebhookInfo()
    const commands = await bot.telegram.getMyCommands()
    return c.json({ info, commands });
});

api.get("/admin/telegram/settings", settings.getTelegramSettings);
api.post("/admin/telegram/settings", settings.saveTelegramSettings);
api.post("/telegram/get_bind_address", miniapp.getTelegramBindAddress);
api.post("/telegram/new_address", miniapp.newTelegramAddress);
api.post("/telegram/bind_address", miniapp.bindAddress);
api.post("/telegram/unbind_address", miniapp.unbindAddress);
api.post("/telegram/get_mail", miniapp.getMail);

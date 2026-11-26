import { createHmac, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createTestAddress, deleteAddress, WORKER_URL } from '../../fixtures/test-helpers';

const BOT_ID = 81230001;
const TOKEN = 'e2e-telegram-test-token';
const SECRET = createHmac('sha256', TOKEN).update('cloudflare-temp-email:telegram-webhook:v1').digest('hex');
let nextUpdate = randomBytes(4).readUInt32LE() % 1_000_000_000;
let nextUser = Date.now();

interface Button { text: string; callback_data?: string }
interface Call {
    method: string;
    payload: { text?: string; message_id?: number; reply_markup?: {
        inline_keyboard?: Button[][]; force_reply?: boolean; input_field_placeholder?: string;
    } };
}
interface Result { status: number; calls: Call[] }

const user = (id: number) => ({ id, is_bot: false, first_name: 'Test User' });
const chat = (id: number, type = 'private') => ({ id, type });
const bot = { id: BOT_ID, is_bot: true, first_name: 'Bot', username: 'test_bot' };
const at = () => Math.floor(Date.now() / 1000);
const conversationPath = (id: number, botId = BOT_ID) =>
    `${WORKER_URL}/__test/telegram_conversation?user=${id}&bot=${botId}`;

function textUpdate(id: number, text: string, reply?: { id: number; text?: string }, room = id) {
    const update_id = ++nextUpdate;
    return { update_id, message: {
        message_id: update_id, date: at(), from: user(id), chat: chat(room), text,
        ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
        ...(reply ? { reply_to_message: { message_id: reply.id, date: at(), from: bot, chat: chat(room), text: reply.text } } : {}),
    } };
}

function callback(id: number, data: string, messageId: number, room = id, type = 'private') {
    const update_id = ++nextUpdate;
    return { update_id, callback_query: {
        id: String(update_id), chat_instance: String(room), from: user(id), data,
        message: { message_id: messageId, from: bot, chat: chat(room, type), date: at(), text: 'Prompt' },
    } };
}

async function send(request: APIRequestContext, data: unknown, headers: Record<string, string> = {}) {
    const response = await request.post(`${WORKER_URL}/__test/telegram_update`, {
        data, headers: { 'x-telegram-bot-api-secret-token': SECRET, ...headers },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<Result>;
}

const messages = (result: Result) => result.calls.filter(c => ['sendMessage', 'editMessageText'].includes(c.method));
const message = (result: Result) => messages(result).at(-1)!;
const buttons = (result: Result) => message(result).payload.reply_markup?.inline_keyboard?.flat() ?? [];
const button = (result: Result, label: string) => {
    const match = buttons(result).find(item => item.text === label);
    expect(match, `Missing button "${label}"`).toBeDefined();
    expect(Buffer.byteLength(match!.callback_data!)).toBeLessThanOrEqual(64);
    return match!.callback_data!;
};

async function active(request: APIRequestContext, id: number, botId?: number) {
    return (await request.get(conversationPath(id, botId))).json();
}

async function click(request: APIRequestContext, id: number, result: Result, label: string, overrides = {}) {
    const row = await active(request, id);
    return send(request, callback(id, button(result, label), row.prompt_id), overrides);
}

async function bindFixtures(request: APIRequestContext, id: number, tokens: string[]) {
    expect((await request.post(`${WORKER_URL}/__test/telegram_command_binding`, {
        data: { user: id, credentials: tokens },
    })).ok()).toBe(true);
}

test('admin initialization signs the webhook registration and registers the full command menu', async ({ request }) => {
    const response = await request.post(`${WORKER_URL}/__test/telegram_init`);
    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.status).toBe(200);
    expect(result.calls.map((call: Call) => call.method)).toEqual(['setWebhook', 'setMyCommands']);
    expect(result.calls[0].payload.secret_token).toBe(SECRET);
    expect(new URL(result.calls[0].payload.url).pathname).toBe('/telegram/webhook');
    expect(result.calls[1].payload.commands.map((item: { command: string }) => item.command))
        .toEqual(['start', 'new', 'address', 'bind', 'unbind', 'delete', 'mails', 'cleaninvalidaddress', 'lang', 'cancel']);
});

test('authenticated menu, ForceReply, direct and partial /new use configured domains', async ({ request }) => {
    const id = ++nextUser;
    const header = { 'x-test-telegram-domains': '["manual.example.com"]' };
    const bad = await send(request, textUpdate(id, '/new'), { 'x-telegram-bot-api-secret-token': 'invalid' });
    expect(bad).toMatchObject({ status: 401, calls: [] });
    expect(await active(request, id)).toBeNull();

    const menu = await send(request, textUpdate(id, '/new@test_bot'), header);
    const namePrompt = await click(request, id, menu, 'Enter a custom name', header);
    expect(message(namePrompt).payload.reply_markup?.force_reply).toBe(true);
    expect(namePrompt.calls.some(call => call.method === 'editMessageReplyMarkup')).toBe(true);
    const chosenName = `interactive${randomBytes(3).toString('hex')}`;
    const promptId = (await active(request, id)).prompt_id;
    expect(await send(request, textUpdate(id, chosenName, { id: promptId + 1 }), header)).toMatchObject({ calls: [] });
    const domains = await send(request, textUpdate(id, chosenName, { id: promptId }), header);
    expect(buttons(domains).map(b => b.text)).toEqual(['Use the default domain selection', 'manual.example.com', 'Cancel']);
    const made = await click(request, id, domains, 'manual.example.com', header);
    expect(message(made).method).toBe('editMessageText');
    expect(message(made).payload.text).toContain(`${chosenName}@manual.example.com`);
    expect(await active(request, id)).toBeNull();

    const partial = await send(request, textUpdate(id, `/new ${chosenName}p@`), header);
    expect(message(partial).payload.text).toContain('Choose an email domain');
    const created = await click(request, id, partial, 'Use the default domain selection', header);
    expect(message(created).payload.text).toContain(`${chosenName}p@manual.example.com`);
    const badDomain = await send(request, textUpdate(id, `/new ${chosenName}i@test.example.com`), header);
    expect(message(badDomain).payload.text).toContain('Invalid domain');
    expect(buttons(badDomain).map(b => b.text)).not.toContain('test.example.com');
    const corrected = await click(request, id, badDomain, 'manual.example.com', header);
    expect(message(corrected).payload.text).toContain(`${chosenName}i@manual.example.com`);
    const direct = await send(request, textUpdate(id, `/new ${chosenName}d@manual.example.com`), header);
    expect(message(direct).payload.text).toContain(`${chosenName}d@manual.example.com`);
    expect(await active(request, id)).toBeNull();
    const random = await send(request, textUpdate(id, '/new'), header);
    expect(message(await click(request, id, random, 'Generate randomly', header)).payload.text)
        .toContain('@manual.example.com');
});

test('bind retries without storing the credential and /mails, /unbind and /lang use existing handlers', async ({ request }) => {
    const id = ++nextUser;
    const mailbox = await createTestAddress(request, 'tginteractive');
    try {
        const prompt = await send(request, textUpdate(id, '/bind'));
        expect(message(prompt).payload.reply_markup?.force_reply).toBe(true);
        const invalid = 'not-a-real.jwt.secret';
        const retry = await send(request, textUpdate(id, invalid));
        expect(message(retry).payload.text).toContain('Invalid credential');
        expect(message(retry).payload.reply_markup?.force_reply).toBe(true);
        expect(JSON.stringify(await active(request, id))).not.toContain(invalid);
        const bound = await send(request, textUpdate(id, mailbox.jwt));
        expect(message(bound).payload.text).toContain(mailbox.address);
        expect(await active(request, id)).toBeNull();

        const mails = await send(request, textUpdate(id, '/mails'));
        expect(buttons(mails).map(b => b.text)).toContain('Open the first bound mailbox');
        expect(message(await click(request, id, mails, mailbox.address)).payload.text).toContain('mail');
        const unbind = await send(request, textUpdate(id, '/unbind'));
        const unset = await click(request, id, unbind, mailbox.address, { 'x-test-telegram-edit': 'fail' });
        expect(message(unset)).toMatchObject({ method: 'sendMessage', payload: { text: expect.stringContaining(mailbox.address) } });
        expect(unset.calls.some(call => call.method === 'editMessageReplyMarkup')).toBe(true);

        await bindFixtures(request, id, [mailbox.jwt, invalid]);
        const cleanup = await send(request, textUpdate(id, '/cleaninvalidaddress'));
        expect(message(cleanup).payload.text).toContain(mailbox.address);
        expect(message(cleanup).payload.text).not.toContain(invalid);
        expect((await (await request.get(`${WORKER_URL}/__test/telegram_binding?userId=${id}`)).json())).toHaveLength(1);

        const lang = await send(request, textUpdate(id, '/lang'));
        expect(message(await click(request, id, lang, '中文')).payload.text).toContain('中文');
        expect(message(await send(request, textUpdate(id, '/address'))).payload.text).toContain('地址');
    } finally {
        await deleteAddress(request, mailbox.jwt);
    }
});

test('delete requires confirmation, isolate identity, reject disabled and execute only once', async ({ request }) => {
    const id = ++nextUser;
    const other = ++nextUser;
    const mailbox = await createTestAddress(request, 'tgconfirm');
    let deleted = false;
    try {
        await bindFixtures(request, id, [mailbox.jwt]);
        const command = textUpdate(id, `/delete ${mailbox.address}`);
        const confirm = await send(request, command);
        const data = button(confirm, 'Confirm deletion');
        expect(message(confirm).payload.text).toContain('cannot be undone');
        expect((await send(request, command)).calls).toEqual([]);
        const row = await active(request, id);
        const group = await send(request, callback(other, data, row.prompt_id, -10001, 'supergroup'));
        expect(group.calls).toHaveLength(1);
        expect(group.calls[0]).toMatchObject({ method: 'answerCallbackQuery', payload: { text: expect.stringContaining('permission') } });
        const impersonation = await send(request, callback(other, data, row.prompt_id, id));
        expect(impersonation.calls).toHaveLength(1);
        const wrongChat = await send(request, callback(id, data, row.prompt_id, id + 400));
        expect(wrongChat.calls).toHaveLength(1);
        const otherBot = await send(request, callback(id, data, row.prompt_id), { 'x-test-telegram-bot': '81230002' });
        expect(otherBot.calls).toHaveLength(1);
        const before = await request.get(`${WORKER_URL}/api/settings`, { headers: { Authorization: `Bearer ${mailbox.jwt}` } });
        expect(before.ok()).toBe(true);

        const denied = await send(request, callback(id, data, row.prompt_id), { 'x-test-telegram-delete': 'disabled' });
        expect(message(denied).payload.text).toContain('disabled');
        expect(await active(request, id)).toBeNull();

        const newConfirm = await send(request, textUpdate(id, `/delete ${mailbox.address}`));
        const newData = button(newConfirm, 'Confirm deletion');
        const newId = (await active(request, id)).prompt_id;
        const one = callback(id, newData, newId);
        const two = callback(id, newData, newId);
        const results = await Promise.all([send(request, one), send(request, one), send(request, two)]);
        const success = results.flatMap(messages).filter(call => call.payload.text?.startsWith('Deleted successfully'));
        expect(success).toHaveLength(1);
        expect(success[0].payload.reply_markup?.inline_keyboard).toEqual([]);
        expect(await active(request, id)).toBeNull();
        expect((await request.get(`${WORKER_URL}/api/settings`, {
            headers: { Authorization: `Bearer ${mailbox.jwt}` },
        })).status()).toBe(401);
        deleted = true;
    } finally {
        if (!deleted) {
            await request.delete(`${WORKER_URL}/admin/delete_address/${mailbox.address_id}`);
        }
    }
});

test('revoked Telegram allowlist permission prevents confirmation and a new command', async ({ request }) => {
    const id = ++nextUser;
    const mailbox = await createTestAddress(request, 'tgrevoked');
    const settingsUrl = `${WORKER_URL}/admin/telegram/settings`;
    const initial = await (await request.get(settingsUrl)).json();
    try {
        await bindFixtures(request, id, [mailbox.jwt]);
        const confirm = await send(request, textUpdate(id, `/delete ${mailbox.address}`));
        const row = await active(request, id);
        expect((await request.post(settingsUrl, {
            data: { ...initial, enableAllowList: true, allowList: [] },
        })).ok()).toBe(true);
        const denied = await send(request, callback(id, button(confirm, 'Confirm deletion'), row.prompt_id));
        expect(denied.calls).toHaveLength(1);
        expect(denied.calls[0]).toMatchObject({ method: 'answerCallbackQuery', payload: { text: expect.stringContaining('permission') } });
        const disallowed = await send(request, textUpdate(++nextUser, '/delete'));
        expect(message(disallowed).payload.text).toContain('permission');
        expect(await active(request, nextUser)).toBeNull();
        expect((await request.get(`${WORKER_URL}/api/settings`, {
            headers: { Authorization: `Bearer ${mailbox.jwt}` },
        })).ok()).toBe(true);
    } finally {
        await request.post(settingsUrl, { data: initial });
        await send(request, textUpdate(id, '/cancel'));
        await deleteAddress(request, mailbox.jwt);
    }
});

test('parallel users keep independent conversations and expired ForceReply is rejected', async ({ request }) => {
    const a = ++nextUser;
    const b = ++nextUser;
    const [bind, create] = await Promise.all([
        send(request, textUpdate(a, '/bind')),
        send(request, textUpdate(b, '/new')),
    ]);
    expect(message(bind).payload.reply_markup?.force_reply).toBe(true);
    expect(buttons(create).map(item => item.text)).toContain('Generate randomly');
    const rowA = await active(request, a);
    const rowB = await active(request, b);
    expect(rowA.session_id).not.toBe(rowB.session_id);
    await request.post(conversationPath(a));
    const response = await send(request, textUpdate(a, 'invalid-example-token', {
        id: rowA.prompt_id, text: message(bind).payload.text,
    }));
    expect(message(response).payload.text).toContain('has expired');
    expect(await active(request, a)).toBeNull();
    expect(await active(request, b)).toMatchObject({ session_id: rowB.session_id, revision: rowB.revision });
    await send(request, textUpdate(b, '/cancel'));
});

test('pagination, ownership, old buttons, cancellation, command switching and expiration', async ({ request }) => {
    const id = ++nextUser;
    const owned = await Promise.all(Array.from({ length: 10 }, () => createTestAddress(request, 'tgpage')));
    const outsider = await createTestAddress(request, 'tgunbound');
    try {
        await bindFixtures(request, id, owned.map(m => m.jwt));
        const first = await send(request, textUpdate(id, '/delete'));
        const firstRow = await active(request, id);
        expect(message(first).payload.text).toContain('Page 1 of 2');
        expect(buttons(first).slice(0, 8).map(b => b.text)).toEqual(owned.slice(0, 8).map(m => m.address));
        expect(buttons(first).map(b => b.text)).not.toContain(outsider.address);
        const second = await click(request, id, first, 'Next page');
        expect(message(second).method).toBe('editMessageText');
        expect(message(second).payload.message_id).toBe(firstRow.prompt_id);
        expect(message(second).payload.text).toContain('Page 2 of 2');
        expect(buttons(second).slice(0, 2).map(b => b.text)).toEqual(owned.slice(8).map(m => m.address));
        const stale = await send(request, callback(id, button(first, owned[0].address), firstRow.prompt_id));
        expect(stale.calls[0]).toMatchObject({ method: 'answerCallbackQuery', payload: { text: expect.stringContaining('no longer available') } });
        expect(message(await click(request, id, second, 'Previous page')).payload.text).toContain('Page 1 of 2');

        const newDelete = await send(request, textUpdate(id, '/delete'));
        const ask = await click(request, id, newDelete, 'Enter manually');
        const invalid = await send(request, textUpdate(id, 'not-an-email'));
        expect(message(ask).payload.reply_markup?.force_reply).toBe(true);
        expect(message(invalid).payload.text).toContain('Invalid address');
        const forbidden = await send(request, textUpdate(id, outsider.address));
        expect(message(forbidden).payload.text).toContain('does not belong');
        const cancelled = await send(request, textUpdate(id, '/cancel'));
        expect(message(cancelled).payload.text).toContain('cancelled');
        expect(await active(request, id)).toBeNull();

        await send(request, textUpdate(id, '/bind'));
        const switched = await send(request, textUpdate(id, '/start'));
        expect(message(switched).payload.text).toContain('Welcome');
        expect(await active(request, id)).toBeNull();
        expect((await send(request, textUpdate(id, 'ignore me'))).calls).toEqual([]);

        const confirmation = await send(request, textUpdate(id, `/delete ${owned[0].address}`));
        const expiredRow = await active(request, id);
        await request.post(conversationPath(id));
        const expired = await send(request, callback(id, button(confirmation, 'Confirm deletion'), expiredRow.prompt_id));
        expect(expired.calls[0]).toMatchObject({ method: 'answerCallbackQuery', payload: { text: expect.stringContaining('expired') } });
        expect(await active(request, id)).toBeNull();
        expect((await request.get(`${WORKER_URL}/api/settings`, {
            headers: { Authorization: `Bearer ${owned[0].jwt}` },
        })).ok()).toBe(true);
    } finally {
        for (const mailbox of [...owned, outsider]) await deleteAddress(request, mailbox.jwt);
    }
});

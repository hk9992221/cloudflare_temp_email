import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { buildAttachmentMail, fixtureFiles, sha256 } from '../../fixtures/attachment-test-mail';
import { plusAddressingStatus, splitPlusRecipient } from '../../../worker/src/utils/recipient_resolver';
import { createTestAddress, deleteAddress, TEST_DOMAIN } from '../../fixtures/test-helpers';

const sender = 'sender@test.example.com';
const admin = { 'x-admin-auth': 'e2e-admin-pass' };
const auth = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });
const aliasFor = (address: string, tag: string) => address.replace('@', () => `+${tag}@`);

async function inbox(request: APIRequestContext, jwt: string, filters = {}) {
    const query = new URLSearchParams({ limit: '20', offset: '0', summary: 'true', ...filters });
    const response = await request.get(`/api/mails?${query}`, { headers: auth(jwt) });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
}

async function delivery(request: APIRequestContext, to: string, options: Record<string, unknown> = {},
    mode = 'd1', identity = false) {
    const fixture = buildAttachmentMail('different-mime-to@example.net', randomUUID(), fixtureFiles.slice(0, 2), mode !== 'd1');
    const response = await request.post('/__test/receive_mail', {
        headers: { 'x-test-mail-storage': mode, ...(identity ? { 'x-test-storage-identity': 'true' } : {}) },
        data: { from: sender, to, raw: fixture.raw, raw_base64: fixture.rawBytes.toString('base64'),
            record_telegram: true, plus_addressing: true, ...options },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return { ...(await response.json()), bytes: fixture.rawBytes };
}

test('resolver validates SMTP syntax without folding the local part or tag', () => {
    expect(splitPlusRecipient('Invoice++Work.CI@MAIL.EXAMPLE.COM')).toEqual({
        address: 'Invoice@mail.example.com', tag: '+Work.CI',
    });
    for (const invalid of ['+tag@example.com', 'invoice+@example.com', 'invoice+.tag@example.com',
        'invoice+ok@example.com\r\nBcc: victim@example.com', 'invoice+ok@example.com.',
        'invoice+ok@-invalid.example.com', 'invoice+ok @example.com', `invoice+${'a'.repeat(64)}@example.com`]) {
        expect(splitPlusRecipient(invalid)).toBeNull();
    }
    expect(plusAddressingStatus({ ENABLE_PLUS_ADDRESSING: false }, { enablePlusAddressing: true }))
        .toEqual({ enabled: false, locked: true });
    expect(plusAddressingStatus({ ENABLE_PLUS_ADDRESSING: true }, { enablePlusAddressing: false }))
        .toEqual({ enabled: false, locked: false });
});

for (const [mode, identity, encoding] of [
    ['d1', false, null], ['legacy-gzip', false, null], ['r2', true, 'identity'], ['r2', false, 'gzip'],
] as const) {
    test(`Plus routing preserves envelope, MIME and attachment hashes in ${mode} (${encoding})`, async ({ request }) => {
        const box = await createTestAddress(request, 'plus-storage');
        try {
            const tag = 'GitHub+CI';
            const original = aliasFor(box.address.replace(TEST_DOMAIN, TEST_DOMAIN.toUpperCase()), tag);
            const received = await delivery(request, original, {}, mode, identity);
            expect(received.success).toBe(true);
            const { count, results: [row] } = await inbox(request, box.jwt, { aliasTag: tag });
            expect(count).toBe(1);
            expect(row).toMatchObject({ address: box.address, original_recipient: original, alias_tag: tag, attachment_count: 2 });
            const info = await (await request.get(`/__test/mail_storage?id=${row.id}`)).json();
            expect(info.row.raw_encoding).toBe(encoding);
            if (mode === 'd1') expect(info.row.raw_empty).toBe(0);
            if (mode === 'legacy-gzip') expect(info.row.blob_empty).toBe(0);
            const eml = await request.get(`/api/mail/${row.id}?download=eml`, { headers: auth(box.jwt) });
            expect(sha256(await eml.body())).toBe(sha256(received.bytes));
            for (const [index, file] of fixtureFiles.slice(0, 2).entries()) {
                const { path } = await (await request.get(`/__test/mail_storage?id=${row.id}&attachment=${index}`)).json();
                const attachment = await request.get(path);
                expect(attachment.ok()).toBe(true);
                expect(sha256(await attachment.body())).toBe(sha256(file.bytes));
            }
        } finally {
            await deleteAddress(request, box.jwt);
        }
    });
}

test('multiple tags, case, unread, history and pagination remain scoped to the mailbox', async ({ request }) => {
    const box = await createTestAddress(request, 'plus-list');
    const other = await createTestAddress(request, 'plus-other', 'manual.example.com');
    try {
        const legacy = await request.post('/__test/seed_mail', {
            data: { address: box.address, raw: 'Subject: Historical\r\n\r\nHistory' },
        });
        expect(legacy.ok()).toBe(true);
        for (const tag of ['shop', 'Shop', 'shop', '+next', "tag'OR'1"]) {
            expect((await delivery(request, aliasFor(box.address, tag))).success).toBe(true);
        }
        expect((await delivery(request, aliasFor(other.address, 'private'))).success).toBe(true);
        expect((await inbox(request, box.jwt, { aliasTags: 'true', tagSearch: 'shop', limit: '1' })).count).toBe(2);
        expect((await inbox(request, box.jwt, { aliasTags: 'true', tagSearch: 'shop', limit: '1', offset: '1' })).results)
            .toEqual([{ alias_tag: 'shop' }]);
        expect((await inbox(request, box.jwt, { aliasTags: 'true', tagSearch: 'private' })).results).toEqual([]);
        const { results: [historical] } = await inbox(request, box.jwt, { alias: 'none' });
        expect(historical).toMatchObject({ alias_tag: null, original_recipient: box.address });
        const { count, results: [shop] } = await inbox(request, box.jwt, { aliasTag: 'shop', unread: 'true', limit: '1' });
        expect(count).toBe(2);
        expect((await request.patch(`/api/mails/${shop.id}/read`, { headers: auth(box.jwt), data: { isUnread: false } })).ok()).toBe(true);
        expect((await inbox(request, box.jwt, { aliasTag: 'shop', unread: 'true' })).count).toBe(1);
        expect((await request.get(`/api/mail/${shop.id}?download=eml`, { headers: auth(other.jwt) })).status()).toBe(404);
        expect((await inbox(request, box.jwt, { aliasTag: '+next' })).count).toBe(1);
        expect((await inbox(request, box.jwt, { aliasTag: "tag'OR'1" })).count).toBe(1);
    } finally {
        await deleteAddress(request, box.jwt);
        await deleteAddress(request, other.jwt);
    }
});

test('exact registered address takes priority and survives deletion of its base mailbox', async ({ request }) => {
    const box = await createTestAddress(request, 'plus-exact');
    const name = aliasFor(box.address, 'exact');
    const exact = await (await request.post('/__test/register_literal_address', { data: { name } })).json();
    try {
        expect((await delivery(request, name)).success).toBe(true);
        expect((await inbox(request, box.jwt)).count).toBe(0);
        expect((await inbox(request, exact.jwt)).results[0]).toMatchObject({
            address: name, original_recipient: name, alias_tag: null,
        });
        await deleteAddress(request, box.jwt);
        expect((await inbox(request, exact.jwt)).count).toBe(1);
    } finally {
        await deleteAddress(request, exact.jwt);
    }
});

test('admin opt-in, environment kill switch and unknown-recipient policy', async ({ request }) => {
    const target = '/admin/account_settings';
    const saved = await (await request.get(target, { headers: admin })).json();
    const box = await createTestAddress(request, 'plus-policy');
    const to = aliasFor(box.address, 'known');
    const rules = async (settings: Record<string, unknown>) => expect((await request.post(target, {
        headers: admin, data: { ...saved, emailRuleSettings: { ...saved.emailRuleSettings, ...settings } },
    })).ok()).toBe(true);
    try {
        const flags = async () => (await (await request.get('/open_api/settings')).json()).enablePlusAddressing;
        expect(await flags()).toBe(false);
        await rules({ enablePlusAddressing: true, blockReceiveUnknowAddressEmail: true });
        expect(await flags()).toBe(true);
        expect((await delivery(request, to, { plus_addressing: undefined })).success).toBe(true);
        expect((await delivery(request, to, { plus_addressing: false })).rejected).toBe('Unknown address');
        for (const name of [aliasFor(box.address, ''), '+tag@test.example.com', 'missing+tag@test.example.com',
            ` ${to}`, aliasFor(box.address, 'x'.repeat(64))]) {
            expect((await delivery(request, name)).rejected).toBe('Unknown address');
        }
        expect((await delivery(request, to, { from: 'blocked-sender.e2e.invalid' })).rejected).toBe('Reject from address');
        await rules({ enablePlusAddressing: false, blockReceiveUnknowAddressEmail: true });
        expect(await flags()).toBe(false);
        expect((await delivery(request, to)).rejected).toBe('Unknown address');
        expect((await inbox(request, box.jwt, { aliasTag: 'known' })).count).toBe(1);
    } finally {
        await request.post(target, { headers: admin, data: { ...saved, emailRuleSettings: {
            ...saved.emailRuleSettings, enablePlusAddressing: saved.emailRuleSettings.enablePlusAddressing ?? null,
        } } });
        await deleteAddress(request, box.jwt);
    }
});

test('forwarding inherits an anchored base-mailbox rule, honors exclusions and deduplicates destinations', async ({ request }) => {
    const box = await createTestAddress(request, 'plus-forward');
    const destination = await createTestAddress(request, 'plus-target');
    const tag = 'forward';
    const original = aliasFor(box.address, tag);
    const external = 'relay@example.net';
    const basePattern = '^' + box.address.replaceAll('.', '\\.') + '$';
    try {
        const result = await delivery(request, original, {
            forward_address_list: [external, external],
            subdomain_forward_address_list: [
                { forward: external, recipientPatterns: [basePattern] },
                { forward: aliasFor(destination.address, 'received'), recipientPatterns: [basePattern] },
                { forward: aliasFor(destination.address, 'received') },
                { forward: aliasFor(destination.address, 'same-mailbox') },
                { forward: aliasFor(box.address, 'loop'), deleteOriginal: true },
                { forward: 'blocked@example.net', recipientPatterns: [basePattern, '^(?!.*\\+forward)'],
                    recipientMatchMode: 'all' },
            ],
        });
        expect(result.forwardedTo).toEqual([external]);
        expect((await inbox(request, box.jwt)).count).toBe(1);
        expect((await inbox(request, destination.jwt)).results).toMatchObject([
            { address: destination.address, original_recipient: aliasFor(destination.address, 'received'), alias_tag: 'received' },
        ]);
    } finally {
        await deleteAddress(request, box.jwt);
        await deleteAddress(request, destination.jwt);
    }
});

test('the base mailbox receives Telegram attachments and Webhook metadata, with legacy envelope to', async ({ request }) => {
    const box = await createTestAddress(request, 'plus-notify');
    const to = aliasFor(box.address, 'Service+CI');
    let capture: Record<string, unknown> | undefined;
    const receiver = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            capture = JSON.parse(Buffer.concat(chunks).toString());
            res.end('OK');
        });
    });
    await new Promise<void>(resolve => receiver.listen(0, '0.0.0.0', resolve));
    const port = (receiver.address() as { port: number }).port;
    const hostname = process.env.CI ? 'e2e-runner' : '127.0.0.1';
    const metadata = { original_recipient: to, mailbox_address: box.address, alias_tag: 'Service+CI', is_plus_alias: true };
    try {
        expect((await request.post('/__test/telegram_binding', {
            data: { userId: 91386421, address: box.address, jwt: box.jwt },
        })).ok()).toBe(true);
        expect((await request.post('/api/webhook/settings', { headers: auth(box.jwt), data: {
            enabled: true, url: `http://${hostname}:${port}/`, method: 'POST', headers: '{}',
            body: '{"to":"${to}","original_recipient":"${original_recipient}","mailbox_address":"${mailbox_address}","alias_tag":"${alias_tag}","is_plus_alias":${is_plus_alias}}',
            filter: { field: 'mailbox_address', operator: 'equals', value: box.address },
        } })).ok()).toBe(true);
        const received = await delivery(request, to, { telegram_attachments: true }, 'r2');
        expect(received.success).toBe(true);
        expect(capture).toEqual({ to, ...metadata });
        expect(received.telegramCalls.map(call => call.method)).toEqual(['sendMessage', 'sendMediaGroup']);
        expect(received.telegramCalls[0].payload.text).toContain(to);
        expect(received.telegramCalls[1].payload.files.map(file => file.sha256)).toEqual(
            fixtureFiles.slice(0, 2).map(file => sha256(file.bytes)));
        const rpc = await delivery(request, to, {
            raw: 'From: sender@test.example.com\r\nTo: different@example.net\r\nSubject: RPC\r\n\r\nOriginal body',
            raw_base64: undefined, record_another_worker: true,
        });
        expect(rpc.workerCalls).toMatchObject([{ to, ...metadata }]);
    } finally {
        receiver.closeAllConnections();
        await new Promise<void>(resolve => receiver.close(() => resolve()));
        await deleteAddress(request, box.jwt);
    }
});

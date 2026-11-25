import { test, expect } from '@playwright/test';
import { buildAttachmentMail, fixtureFiles, sha256 } from '../../fixtures/attachment-test-mail';
import { createTestAddress } from '../../fixtures/test-helpers';

const admin = { 'x-admin-auth': 'e2e-admin-pass' };

test('near-limit R2 gzip retains MIME and both large attachments byte for byte', async ({ request }) => {
    test.setTimeout(90_000);
    const address = await createTestAddress(request, 'attachment-limit');
    const headers = { Authorization: `Bearer ${address.jwt}` };
    const large = Buffer.alloc(4_460_000);
    for (let offset = 0, value = 1; offset < large.length; offset++) {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        large[offset] = value >>> 24;
    }
    const files = ['near-1.bin', 'near-2.bin'].map((name, index) => ({
        name, bytes: index ? Buffer.from(large).reverse() : large, type: 'application/octet-stream',
    }));
    const { raw, rawBytes } = buildAttachmentMail(address.address, 'Near-limit attachments', files, false);
    expect(rawBytes.length).toBeGreaterThan(11.5 * 1024 * 1024);
    expect(rawBytes.length).toBeLessThan(12 * 1024 * 1024);
    try {
        const delivery = await request.post('/__test/receive_mail', {
            headers: { 'x-test-mail-storage': 'r2' },
            data: { from: 'sender@test.example.com', to: address.address, raw, record_telegram: true },
        });
        expect(await delivery.json()).toMatchObject({ success: true });
        const listing = await request.get('/api/mails?limit=10&offset=0&summary=true', { headers });
        const { results: [mail] } = await listing.json();
        expect(mail.attachment_count).toBe(2);
        const eml = await request.get(`/api/mail/${mail.id}?download=eml`, { headers });
        expect(eml.status()).toBe(200);
        expect(sha256(await eml.body())).toBe(sha256(rawBytes));
        for (const [index, file] of files.entries()) {
            const signed = await request.get(`/__test/mail_storage?id=${mail.id}&attachment=${index}`);
            const { path } = await signed.json();
            const fileResponse = await request.get(path);
            expect(fileResponse.status()).toBe(200);
            expect(sha256(await fileResponse.body())).toBe(sha256(file.bytes));
        }
    } finally {
        await request.delete('/api/delete_address', { headers });
    }
});

for (const scenario of [
    { name: 'disabled', enabled: false, files: fixtureFiles.slice(0, 2), expectedMethod: undefined },
    { name: 'single JPG', enabled: true, files: fixtureFiles.slice(0, 1), expectedMethod: 'sendDocument' },
    { name: 'grouped media and document', enabled: true, files: fixtureFiles.slice(0, 3),
        expectedMethod: 'sendMediaGroup', singleDocument: true },
    { name: 'ordinary documents', enabled: true, files: fixtureFiles.slice(2, 4),
        expectedMethod: 'sendDocument', singleDocument: true },
    ...(['http', 'network', 'api'] as const).map(failure => ({
        name: `${failure} rejection`, enabled: true, files: fixtureFiles.slice(0, 2),
        expectedMethod: 'sendMediaGroup', failure,
    })),
]) {
    test(`Telegram attachment integrity — ${scenario.name}`, async ({ request }) => {
        const mailbox = await createTestAddress(request, 'tg-attachment');
        const headers = { Authorization: `Bearer ${mailbox.jwt}` };
        const settingsUrl = '/admin/telegram/settings';
        const prior = await (await request.get(settingsUrl, { headers: admin })).json();
        const chat = 91386211;
        try {
            expect((await request.post('/__test/telegram_binding', { data: {
                userId: chat, address: mailbox.address, jwt: mailbox.jwt,
            } })).ok()).toBe(true);
            expect((await request.post(settingsUrl, { headers: admin, data: {
                enableAllowList: false, allowList: [], miniAppUrl: 'https://example.com',
                enableGlobalMailPush: true, globalMailPushList: [chat],
            } })).ok()).toBe(true);
            const { raw, rawBytes } = buildAttachmentMail(mailbox.address, 'Telegram attachment test', scenario.files);
            const received = await request.post('/__test/receive_mail', {
                headers: { 'x-test-mail-storage': 'r2' },
                data: { from: 'sender@test.example.com', to: mailbox.address, raw,
                    raw_base64: rawBytes.toString('base64'), record_telegram: true,
                    telegram_attachments: scenario.enabled,
                    telegram_upload_failure: 'failure' in scenario ? scenario.failure : undefined },
            });
            const body = await received.json();
            expect(body.success).toBe(true);
            const calls = body.telegramCalls;
            expect(calls.map((call: { method: string }) => call.method)).toEqual([
                'sendMessage', ...(scenario.expectedMethod ? [scenario.expectedMethod] : []),
                ...('singleDocument' in scenario ? ['sendDocument'] : []),
                ...('failure' in scenario ? ['sendMessage'] : []),
            ]);
            expect(calls[0].payload.text).toContain('Original café body');
            expect(calls.every((call: { payload: { chat_id: number } }) => Number(call.payload.chat_id) === chat)).toBe(true);
            if (scenario.expectedMethod) {
                expect(calls.filter((call: { method: string }) => call.method !== 'sendMessage')
                    .flatMap((call: { payload: { files: unknown[] } }) => call.payload.files)).toEqual(scenario.files.map(file => ({
                    name: file.name, type: file.type, size: file.bytes.length, sha256: sha256(file.bytes),
                })));
                if (scenario.expectedMethod === 'sendMediaGroup') {
                    expect(calls[1].payload.media.every((entry: { type: string }) => entry.type === 'document')).toBe(true);
                }
            }
            if ('failure' in scenario) expect(calls.at(-1).payload.text).toContain('Webmail');
            const { results: [row] } = await (await request.get('/api/mails?limit=10&offset=0&summary=true', { headers })).json();
            const eml = await request.get(`/api/mail/${row.id}?download=eml`, { headers });
            expect(sha256(await eml.body())).toBe(sha256(rawBytes));
        } finally {
            await request.post(settingsUrl, { headers: admin, data: prior });
            await request.delete('/api/delete_address', { headers });
        }
    });
}

test('mixed inbox preserves unencoded binary MIME attachment bytes in D1 and R2', async ({ request }) => {
    const mailbox = await createTestAddress(request, 'binary-attachment');
    const file = {
        name: 'transfer-binary.bin', type: 'application/octet-stream', encoding: 'binary' as const,
        bytes: Buffer.from([0x00, 0x7f, 0x81, 0x80, 0xff, 0x20]),
    };
    const headers = { Authorization: `Bearer ${mailbox.jwt}` };
    try {
        const sources = new Map();
        for (const mode of ['d1', 'r2']) {
            const subject = `Mixed binary fixture ${mode}`;
            const { raw, rawBytes } = buildAttachmentMail(mailbox.address, subject, [file]);
            const response = await request.post('/__test/receive_mail', {
                headers: { 'x-test-mail-storage': mode },
                data: { from: 'sender@test.example.com', to: mailbox.address, raw,
                    raw_base64: rawBytes.toString('base64'), record_telegram: true },
            });
            expect(await response.json()).toMatchObject({ success: true });
            sources.set(subject, rawBytes);
        }
        const { results } = await (await request.get('/api/mails?limit=10&offset=0&summary=true', { headers })).json();
        expect(results).toHaveLength(2);
        for (const row of results) {
            const eml = await request.get(`/api/mail/${row.id}?download=eml`, { headers });
            expect(eml.status()).toBe(200);
            expect(sha256(await eml.body())).toBe(sha256(sources.get(row.subject)));
            const { path } = await (await request.get(`/__test/mail_storage?id=${row.id}&attachment=0`)).json();
            const attachment = await request.get(path);
            expect(attachment.status()).toBe(200);
            expect(sha256(await attachment.body())).toBe(sha256(file.bytes));
        }
    } finally {
        await request.delete('/api/delete_address', { headers });
    }
});

import { APIRequestContext, expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createTestAddress } from '../../fixtures/test-helpers';

const admin = { 'x-admin-auth': 'e2e-admin-pass' };
const r2 = { 'x-test-mail-storage': 'r2' };
const receive = (request: APIRequestContext, to: string, raw: string, headers = r2, rawBytes?: Buffer) =>
    request.post('/__test/receive_mail', { headers,
        data: { from: 'sender@test.example.com', to, raw, raw_base64: rawBytes?.toString('base64'), record_telegram: true },
    });

const adminAction = (request: APIRequestContext, path: string, data: object, fault?: string, target?: number) =>
    request.post(`/admin/mail_storage/${path}`, { headers: {
        ...admin, ...(fault ? { 'x-test-mail-storage-fault': fault } : {}),
        ...(target ? { 'x-test-storage-target': String(target) } : {}),
    }, data });

const inspect = async (request: APIRequestContext, id: number, key?: string) =>
    (await request.get(`/__test/mail_storage?id=${id}${key ? '&key=' + encodeURIComponent(key) : ''}`)).json();

const rawMail = (address: string, subject: string, body = 'Hello') =>
    ['From: sender@test.example.com', `To: ${address}`, `Message-ID: <${randomUUID()}@test>`,
        `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');

test.beforeAll(async ({ request }) => {
    expect((await request.post('/admin/db_initialize', { headers: admin })).ok()).toBe(true);
    expect((await request.post('/admin/db_migration', { headers: admin })).ok()).toBe(true);
    expect((await request.post('/admin/db_migration', { headers: admin })).ok()).toBe(true);
    expect(await (await request.get('/admin/mail_storage/check', { headers: admin })).json())
        .toMatchObject({ schemaReady: true, r2Reachable: true });
});

test('mixed D1/R2 reads retain scopes and order, and summary uses no object reads', async ({ request }) => {
    const { jwt, address } = await createTestAddress(request, 'storage-mixed');
    const other = await createTestAddress(request, 'storage-other');
    const headers = { Authorization: `Bearer ${jwt}` };
    const legacy = rawMail(address, 'Legacy');
    const raw = rawMail(address, 'Object').replace(
        'From: sender@test.example.com', 'From: Display Name <sender@test.example.com>');
    const bytes = Buffer.concat([Buffer.from(raw), Buffer.from([0x80, 0xff, 0x00])]);
    try {
        expect((await (await receive(request, address, legacy, { 'x-test-mail-storage': 'legacy-gzip' })).json()).success)
            .toBe(true);
        expect((await (await receive(request, address, raw, r2, bytes)).json()).success).toBe(true);
        const summary = await request.get('/api/mails?limit=20&offset=0&summary=true', { headers: {
            ...headers, 'x-test-mail-storage-fault': 'get',
        } });
        const { results, count } = await summary.json();
        expect(count).toBe(2);
        expect(results.map((row: { subject: string }) => row.subject)).toEqual(['Object', 'Legacy']);
        expect(results[0]).not.toHaveProperty('raw');
        expect(results[0]).toMatchObject({ sender: 'Display Name <sender@test.example.com>' });
        const { id } = results[0];
        expect((await inspect(request, id)).row).toMatchObject({
            storage_backend: 'r2', raw_empty: 1, blob_empty: 1, raw_encoding: 'gzip',
        });
        expect((await inspect(request, results[1].id)).row).toMatchObject({ storage_backend: 'd1', blob_empty: 0 });
        const full = await (await request.get('/api/mails?limit=20&offset=0', { headers })).json();
        expect(full.results[1].raw).toBe(legacy);
        expect(full.results[0]).not.toHaveProperty('r2_key');
        const download = await request.get(`/api/mail/${id}?download=eml`, { headers });
        expect(await download.body()).toEqual(bytes);
        const denied = await request.get(`/api/mail/${id}?download=eml`,
            { headers: { Authorization: `Bearer ${other.jwt}` } });
        expect(denied.status()).toBe(404);
        expect((await request.get(`/admin/mails/${id}`, { headers: admin })).ok()).toBe(true);
    } finally {
        await request.delete('/api/delete_address', { headers });
        await request.delete('/api/delete_address', { headers: { Authorization: `Bearer ${other.jwt}` } });
        await adminAction(request, 'gc', {});
    }
});

test('preserves an attachment in a MIME message larger than the D1 row limit', async ({ request }) => {
    test.setTimeout(60_000);
    const { jwt, address } = await createTestAddress(request, 'storage-large');
    const headers = { Authorization: `Bearer ${jwt}` };
    const file = Buffer.alloc(1_600_000, 139);
    const mime = [
        'From: sender@test.example.com', `To: ${address}`, 'Subject: Large attachment',
        'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="large-mail"', '',
        '--large-mail', 'Content-Type: text/html; charset=utf-8', '', '<p>Original body</p>',
        '--large-mail', 'Content-Type: application/zip', 'Content-Disposition: attachment; filename="sample.zip"',
        'Content-Transfer-Encoding: base64', '', file.toString('base64').match(/.{1,76}/g)!.join('\r\n'),
        '--large-mail--', '',
    ].join('\r\n');
    try {
        expect(Buffer.byteLength(mime)).toBeGreaterThan(2_000_000);
        expect((await (await receive(request, address, mime, { ...r2, 'x-test-storage-identity': 'true' })).json()).success).toBe(true);
        const { results } = await (await request.get('/api/mails?limit=10&offset=0&summary=true', { headers })).json();
        expect(results[0].attachment_count).toBe(1);
        expect(results[0].preview).toBe('Original body');
        const id = results[0].id;
        expect((await inspect(request, id)).row.raw_encoding).toBe('identity');
        const download = await request.get(`/api/mail/${id}?download=eml`, { headers });
        expect(download.status()).toBe(200);
        const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
        expect(hash(await download.body())).toBe(hash(mime));
        const parsed = await request.get(`/api/parsed_mail/${id}`, { headers });
        expect((await parsed.json()).attachments[0]).toMatchObject({ filename: 'sample.zip', size: file.length });
    } finally {
        await request.delete('/api/delete_address', { headers });
        await adminAction(request, 'gc', {});
    }
});

test('failed saves suppress success side effects and interrupted writes are collected', async ({ request }) => {
    const address = `unregistered-${randomUUID()}@test.example.com`;
    const raw = rawMail(address, 'Failure');
    for (const [mode, fault] of [['r2', 'missing-binding'], ['r2', 'put'], ['r2', 'commit'], ['r2', 'expire-write'], ['invalid', '']]) {
        const delivery = await receive(request, address, raw,
            { 'x-test-mail-storage': mode, 'x-test-mail-storage-fault': fault });
        expect(await delivery.json()).toMatchObject({ success: false, telegramCalls: [], replyCalled: false });
    }
    const query = `/admin/mails?address=${address}&limit=10&offset=0&summary=true`;
    expect((await (await request.get(query, { headers: admin })).json()).count).toBe(0);
    const { key } = await (await request.post('/__test/mail_storage?action=interrupt')).json();
    expect((await inspect(request, 0, key)).exists).toBe(true);
    expect((await adminAction(request, 'gc', {})).ok()).toBe(true);
    expect((await inspect(request, 0, key)).exists).toBe(false);

    const ambiguous = await receive(request, address, raw, { ...r2, 'x-test-mail-storage-fault': 'lost-commit-response' });
    expect(await ambiguous.json()).toMatchObject({ success: true });
    const { results } = await (await request.get(query, { headers: admin })).json();
    expect(results).toHaveLength(1);
    await adminAction(request, 'gc', {});
    expect(await (await request.get(`/admin/mails/${results[0].id}?download=eml`, { headers: admin })).text()).toBe(raw);
    await request.delete(`/admin/mails/${results[0].id}`, { headers: admin });
    await adminAction(request, 'gc', {});
});

test('corrupt or missing objects fail explicitly and custom SQL deletion is retried', async ({ request }) => {
    const address = `storage-gc-${randomUUID()}@test.example.com`;
    const raw = rawMail(address, 'Collect');
    expect((await (await receive(request, address, raw)).json()).success).toBe(true);
    const { results } = await (await request.get(`/admin/mails?address=${address}&limit=10&offset=0&summary=true`,
        { headers: admin })).json();
    const id = results[0].id;
    const { row } = await inspect(request, id);
    await request.post(`/__test/mail_storage?action=corrupt&id=${id}`);
    expect((await request.get(`/admin/mails/${id}`, { headers: admin })).status()).toBe(500);
    await request.post(`/__test/mail_storage?action=remove&id=${id}`);
    expect((await request.get(`/admin/mails/${id}`, { headers: admin })).status()).toBe(500);
    await request.post(`/__test/mail_storage?action=corrupt&id=${id}`);
    expect(await (await request.post(`/__test/mail_storage?action=custom-delete&id=${id}`)).json())
        .toMatchObject({ success: true });
    expect((await inspect(request, id, row.r2_key)).queue)
        .toContainEqual(expect.objectContaining({ object_key: row.r2_key, reason: 'delete' }));
    expect(await (await adminAction(request, 'gc', {}, 'delete')).json()).toMatchObject({ failed: 1 });
    expect((await inspect(request, id, row.r2_key)).exists).toBe(true);
    await request.post(`/__test/mail_storage?action=expire&key=${encodeURIComponent(row.r2_key)}`);
    await adminAction(request, 'gc', {});
    expect((await inspect(request, id, row.r2_key)).exists).toBe(false);
});

test('migration pauses, preserves D1 on failure, retries, and fences a reused row ID', async ({ request }) => {
    const address = `storage-migration-${randomUUID()}@test.example.com`;
    const raw = rawMail(address, 'Migrate');
    const ids = [];
    for (const mode of ['d1', 'legacy-gzip', 'd1']) {
        expect((await (await receive(request, address, raw, { 'x-test-mail-storage': mode })).json()).success).toBe(true);
    }
    const query = `/admin/mails?address=${address}&limit=10&offset=0&summary=true`;
    const { results } = await (await request.get(query, { headers: admin })).json();
    ids.push(...results.map((row: { id: number }) => row.id).reverse());
    await request.post(`/__test/mail_storage?action=migration-window&after=${ids[0] - 1}&id=${ids[2]}`);
    expect((await adminAction(request, 'migrate', { action: 'preview' })).ok()).toBe(true);
    expect((await adminAction(request, 'migrate', { action: 'pause' })).ok()).toBe(true);
    expect((await adminAction(request, 'migrate', { action: 'next' })).status()).toBe(409);
    expect((await adminAction(request, 'migrate', { action: 'resume' })).ok()).toBe(true);
    expect(await (await adminAction(request, 'migrate', { action: 'next' }, 'put')).json())
        .toMatchObject({ failed: 3, migrated: 0, hasMore: false });
    for (const id of ids) {
        expect(await (await request.get(`/admin/mails/${id}?download=eml`, { headers: admin })).text()).toBe(raw);
        expect((await inspect(request, id)).row.storage_backend).toBe('d1');
    }
    expect(await (await adminAction(request, 'migrate', { action: 'retry' }, 'delete-migration-source', ids[2])).json())
        .toMatchObject({ migrated: 2 });
    for (const id of ids.slice(0, 2)) {
        expect((await inspect(request, id)).row).toMatchObject({ storage_backend: 'r2', raw_empty: 1, blob_empty: 1 });
        expect(await (await request.get(`/admin/mails/${id}?download=eml`, { headers: admin })).text()).toBe(raw);
    }
    expect((await inspect(request, ids[2])).row).toMatchObject({ address: 'replacement@example.com', storage_backend: 'd1' });
    for (const id of ids) await request.delete(`/admin/mails/${id}`, { headers: admin });
    await adminAction(request, 'gc', {});
});

test('R2 attachments still work with signed Webhook links and global Telegram push', async ({ request }) => {
    const address = `storage-global-${randomUUID()}@test.example.com`;
    const settingsPath = '/admin/telegram/settings';
    const previous = await (await request.get(settingsPath, { headers: admin })).json();
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=', 'base64');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
    const mime = [
        'From: sender@test.example.com', `To: ${address}`, 'Subject: R2 signed attachment',
        'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="r2-inline"', '',
        '--r2-inline', 'Content-Type: text/html; charset=utf-8', '', '<p>Image<img src="cid:example"></p>',
        '--r2-inline', 'Content-Type: image/png', 'Content-Disposition: inline; filename="pixel.png"',
        'Content-ID: <example>', 'Content-Transfer-Encoding: base64', '', image.toString('base64'),
        '--r2-inline', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="example.pdf"',
        'Content-Transfer-Encoding: base64', '', pdf.toString('base64'),
        '--r2-inline', 'Content-Type: application/zip', 'Content-Disposition: attachment; filename="example.zip"',
        'Content-Transfer-Encoding: base64', '', zip.toString('base64'),
        '--r2-inline--', '',
    ].join('\r\n');
    let id: number | undefined;
    try {
        expect((await request.post(settingsPath, { headers: admin, data: {
            enableAllowList: false, allowList: [], miniAppUrl: 'https://example.com',
            enableGlobalMailPush: true, globalMailPushList: [123456],
        } })).ok()).toBe(true);
        const received = await (await receive(request, address, mime)).json();
        expect(received.success).toBe(true);
        expect(received.telegramCalls).toContainEqual(expect.objectContaining({ method: 'sendMessage' }));
        const { results } = await (await request.get(`/admin/mails?address=${address}&limit=10&offset=0&summary=true`,
            { headers: admin })).json();
        id = results[0].id;
        const { path } = await (await request.get(`/__test/mail_storage?id=${id}&attachment=0`)).json();
        const attachment = await request.get(path);
        expect(attachment.status()).toBe(200);
        expect(attachment.headers()['content-type']).toBe('image/png');
        expect(await attachment.body()).toEqual(image);
        for (const [index, expected] of [[1, pdf], [2, zip]] as const) {
            const link = await (await request.get(`/__test/mail_storage?id=${id}&attachment=${index}`)).json();
            const contents = await request.get(link.path);
            expect(contents.status()).toBe(200);
            expect(await contents.body()).toEqual(expected);
        }
        const badPath = path.replace(/[^/]+$/, 'a'.repeat(52));
        expect((await request.get(badPath)).status()).toBe(404);
        const miniApp = await request.post('/telegram/get_mail?download=eml', { headers: admin, data: { mailId: id } });
        expect(miniApp.status()).toBe(200);
        expect(await miniApp.text()).toBe(mime);
    } finally {
        await request.post(settingsPath, { headers: admin, data: previous });
        if (id) await request.delete(`/admin/mails/${id}`, { headers: admin });
        await adminAction(request, 'gc', {});
    }
});

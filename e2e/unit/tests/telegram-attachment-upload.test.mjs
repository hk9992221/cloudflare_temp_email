import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendTelegramAttachments } from '../../../worker/src/telegram_api/tg_file_upload.ts';

const file = (filename, content) => ({ filename, content, mimeType: 'application/octet-stream', disposition: 'attachment' });

test('Telegram skips an oversized document and still uploads a permitted view without extra bytes', async t => {
    const request = t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.ok(url.endsWith('/sendDocument'));
        const document = options.body.get('document');
        assert.equal(document.name, '原图.bin');
        assert.equal(document.type, 'application/octet-stream');
        assert.deepEqual(new Uint8Array(await document.arrayBuffer()), Uint8Array.of(128, 255));
        return Response.json({ ok: true });
    });
    const failed = await sendTelegramAttachments('fake', '123', [
        file('large.bin', new Uint8Array(50 * 1024 * 1024 + 1)),
        file('原图.bin', Uint8Array.of(9, 128, 255, 8).subarray(1, 3)),
    ], '');
    assert.equal(failed, 1);
    assert.equal(request.mock.callCount(), 1);
});

test('Telegram groups media as documents and sends ordinary files individually after an error', async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, { body }) => {
        calls.push(url.split('/').at(-1));
        if (calls.length <= 2) {
            const types = JSON.parse(body.get('media')).map(({ type }) => type);
            assert.deepEqual(types, Array(calls.length === 1 ? 5 : 2).fill('document'));
            return Response.json({ ok: calls.length === 2 });
        }
        assert.equal(body.get('document').name, calls.length === 3 ? 'report.pdf' : 'notes.txt');
        return Response.json({ ok: true });
    });
    const media = Array.from({ length: 7 }, (_, i) => ({
        ...file(`${i}.jpg`, Uint8Array.of(i)),
        mimeType: 'image/jpeg',
    }));
    const files = [file('report.pdf', Uint8Array.of(9)), ...media, file('notes.txt', Uint8Array.of(5))];
    assert.equal(await sendTelegramAttachments('fake', '123', files, 'caption'), 5);
    assert.deepEqual(calls, ['sendMediaGroup', 'sendMediaGroup', 'sendDocument', 'sendDocument']);
});

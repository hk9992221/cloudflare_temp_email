import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processItem, releaseMailAttachments } from '../email-parser';

vi.mock('mail-parser-wasm', () => ({
    parse_message: vi.fn(() => { throw new Error('Exercise the PostalMime fallback'); }),
}));

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attachment');
});

afterEach(() => vi.restoreAllMocks());

describe('PostalMime fallback', () => {
    it.each([
        ['From: Sender <first@example.com>', 'Sender <first@example.com>'],
        ['From: first@example.com', 'first@example.com'],
        ['fRoM: "Sender, Display"\r\n <first@example.com>', 'Sender, Display <first@example.com>'],
        ['From: =?UTF-8?B?5Y+R5Lu25Lq6?= <first@example.com>', '发件人 <first@example.com>'],
        ['From: First <first@example.com>\r\nFrom: Last <last@example.com>', 'First <first@example.com>'],
        ['From: First <first@example.com>\r\nFrom:', 'First <first@example.com>'],
        ['From:\r\nFrom: Last <last@example.com>', 'bounce@transport.example'],
        ['From: invalid\r\nFrom: Last <last@example.com>', 'bounce@transport.example'],
        ['', 'bounce@transport.example'],
    ])('parses sender: %s', async (header, sender) => {
        const raw = [...(header ? [header] : []), 'Subject: =?UTF-8?B?5rWL6K+V?=',
            'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
            Buffer.from('正文 "quoted" \\path $& ${from}').toString('base64')].join('\r\n');
        const item = await processItem({ raw, source: 'bounce@transport.example' });
        expect(item.originalSource).toBe('bounce@transport.example');
        expect(item.source).toBe(sender);
        expect(item.subject).toBe('测试');
        expect(item.text.trim()).toBe('正文 "quoted" \\path $& ${from}');
        expect(item.message).toBe(item.text);
        expect(item.attachments).toEqual([]);
    });

    it('preserves inline binary bytes, Unicode filenames and attached email content', async () => {
        const binary = Buffer.from([0, 127, 128, 255]);
        const attachedMail = 'From: nested@example.com\r\nSubject: Nested\r\n\r\nNested body';
        const raw = [
            'From: Sender <first@example.com>', 'Subject: Attachments',
            'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=test', '',
            '--test', 'Content-Type: text/html; charset=utf-8', '', '<p>正文</p><img src="cid:picture">',
            '--test', 'Content-Type: image/png', 'Content-ID: <picture>',
            "Content-Disposition: inline; filename*=utf-8''%E5%9B%BE.png", 'Content-Transfer-Encoding: base64', '',
            binary.toString('base64'), '--test', 'Content-Type: message/rfc822',
            'Content-Disposition: attachment; filename="forward.eml"', 'Content-Transfer-Encoding: base64', '',
            Buffer.from(attachedMail).toString('base64'), '--test--',
        ].join('\r\n');
        const item = await processItem({ raw, source: 'bounce@transport.example' });
        expect(item.message).toContain('<p>正文</p>');
        expect(item.attachments[0].id).toBe('<picture>');
        expect(item.attachments.map(file => file.filename)).toEqual(['图.png', 'forward.eml']);
        expect(new Uint8Array(await item.attachments[0].blob.arrayBuffer())).toEqual(new Uint8Array(binary));
        expect(await item.attachments[1].blob.text()).toBe(attachedMail);
        expect(item.attachments[0].blob.type).toBe('image/png');
        expect(item.attachments[0].size).toBe('4 B');
        expect(item.message).toContain('src="blob:attachment"');
        expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    });
});

describe('attachment bytes and object URLs', () => {
    it('uses exact byte offsets, keeps empty files, and reports missing bytes', async () => {
        const { parse_message } = await import('mail-parser-wasm');
        parse_message.mockReturnValueOnce({
            subject: 'Views',
            text: 'Body',
            attachments: [
                { filename: 'bytes.bin', content: new Uint8Array([9, 1, 2, 8]).subarray(1, 3) },
                { filename: 'view.bin', content: new DataView(new Uint8Array([9, 3, 4, 8]).buffer, 1, 2) },
                { filename: 'empty.txt', content: new ArrayBuffer(0) },
                { filename: 'missing.txt', content: undefined },
                { filename: 'unexpected.txt', content: 'AAAA' },
            ],
        });
        const result = await processItem({ raw: 'fixture' });
        expect(result.attachments.map(part => part.size)).toEqual(['2 B', '2 B', '0 B', null, null]);
        expect([...new Uint8Array(await result.attachments[0].blob.arrayBuffer())]).toEqual([1, 2]);
        expect([...new Uint8Array(await result.attachments[1].blob.arrayBuffer())]).toEqual([3, 4]);
        expect(result.attachments[3]).toMatchObject({ blob: null, url: null });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        releaseMailAttachments(result);
        expect(revoke).toHaveBeenCalledTimes(3);
    });

    it('does not create URLs for an abandoned WASM parse', async () => {
        const { parse_message } = await import('mail-parser-wasm');
        parse_message.mockReturnValueOnce({ subject: '', text: '', attachments: [
            { filename: 'discarded.bin', content: new Uint8Array([1]) },
        ] });
        const result = await processItem({ raw: 'Subject: Test\r\n\r\nBody' });
        expect(result.subject).toBe('Test');
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('reports parse failure for missing MIME instead of producing an empty file', async () => {
        const result = await processItem({});
        expect(result).toMatchObject({ parseError: true, attachments: [] });
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });
});

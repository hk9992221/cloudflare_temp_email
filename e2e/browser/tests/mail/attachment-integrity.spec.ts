import { readFile } from 'node:fs/promises';
import { test, expect, request as apiRequest } from '@playwright/test';
import { buildAttachmentMail, fixtureFiles, sha256 } from '../../../fixtures/attachment-test-mail';
import { createTestAddress, deleteAddress, FRONTEND_URL, WORKER_URL } from '../../../fixtures/test-helpers';

const variants = [
    { label: 'D1 plaintext', mode: 'd1', legacyCharset: false },
    { label: 'D1 gzip', mode: 'legacy-gzip', legacyCharset: true },
    { label: 'D1 non-UTF-8 without compression enabled', mode: 'd1', legacyCharset: true },
    { label: 'R2 plaintext', mode: 'r2', legacyCharset: true, identity: true },
    { label: 'R2 gzip', mode: 'r2', legacyCharset: true },
    { label: 'historical D1', mode: 'history', legacyCharset: false },
];

function expectedSize(size: number) {
    return size >= 1024 ? `${Number((size / 1024).toFixed(2))} KB` : `${size} B`;
}

for (const variant of variants) {
    test(`real attachment downloads preserve hashes from ${variant.label}`, async ({ page }) => {
        test.setTimeout(60_000);
        const api = await apiRequest.newContext();
        const mailbox = await createTestAddress(api, 'attachment-browser');
        const subject = `Attachment fixtures ${variant.label}`;
        const { raw, rawBytes } = buildAttachmentMail(mailbox.address, subject, fixtureFiles, variant.legacyCharset);
        try {
            const result = await api.post(`${WORKER_URL}/__test/${variant.mode === 'history' ? 'seed_mail' : 'receive_mail'}`, {
                headers: {
                    'x-test-mail-storage': variant.mode,
                    ...(variant.identity ? { 'x-test-storage-identity': 'true' } : {}),
                },
                data: { from: 'sender@test.example.com', to: mailbox.address, address: mailbox.address, raw,
                    ...(variant.legacyCharset ? { raw_base64: rawBytes.toString('base64') } : {}),
                    record_telegram: true },
            });
            expect(await result.json()).toMatchObject({ success: true });
            await page.addInitScript(() => {
                localStorage.setItem('mailListView', 'true');
                localStorage.setItem('useIframeShowMail', 'true');
                const revoke = URL.revokeObjectURL.bind(URL);
                const revoked: string[] = [];
                Object.assign(window, { revokedAttachmentUrls: revoked });
                URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
            });
            const requestedEml: string[] = [];
            page.on('request', request => {
                if (request.url().includes('download=eml') && request.method() === 'GET') requestedEml.push(request.url());
            });
            const summary = page.waitForResponse(response => response.url().includes('/api/mails?') &&
                new URL(response.url()).searchParams.get('summary') === 'true');
            await page.goto(`${FRONTEND_URL}/en/?jwt=${mailbox.jwt}`);
            const list = await (await summary).json();
            expect(list.results[0]).not.toHaveProperty('raw');
            const mail = page.getByRole('listitem').filter({ hasText: subject });
            await expect(mail).toBeVisible();
            expect(requestedEml).toHaveLength(0);

            const metadata = await (await api.get(`${WORKER_URL}/__test/mail_storage?id=${list.results[0].id}`)).json();
            expect(metadata.row.storage_backend).toBe(variant.mode === 'r2' ? 'r2' : 'd1');
            if (variant.mode === 'r2') expect(metadata.row.raw_encoding).toBe(variant.identity ? 'identity' : 'gzip');
            else if (variant.mode === 'history' || (variant.mode === 'd1' && !variant.legacyCharset)) {
                expect(metadata.row.raw_empty).toBe(0);
            } else expect(metadata.row.blob_empty).toBe(0);

            await mail.click();
            const images = page.frameLocator('iframe.mail-iframe').locator('img');
            await expect(images).toHaveCount(2);
            await expect.poll(() => images.evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).naturalWidth)))
                .toEqual([2, 2]);

            await page.getByRole('button', { name: 'Attachments', exact: true }).click();
            const urls = [];
            for (const file of fixtureFiles) {
                const link = page.locator('a[download]').filter({ visible: true }).and(page.locator(
                    `a[download="${file.name}"]`));
                const row = page.getByRole('listitem').filter({ has: link });
                await expect(row).toContainText(`Size: ${expectedSize(file.bytes.length)}`);
                const blobUrl = (await link.getAttribute('href'))!;
                urls.push(blobUrl);
                expect(await page.evaluate(async url => (await (await fetch(url)).blob()).type, blobUrl)).toBe(file.type);
                const download = page.waitForEvent('download');
                await link.click();
                const downloaded = await download;
                expect(downloaded.suggestedFilename()).toBe(file.name);
                expect(sha256(await readFile((await downloaded.path())!))).toBe(sha256(file.bytes));
            }
            expect(requestedEml).toHaveLength(1);
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: 'Back to List' }).click();
            const revoked = await page.evaluate(() => (window as unknown as { revokedAttachmentUrls: string[] }).revokedAttachmentUrls);
            for (const url of urls) expect(revoked).toContain(url);
        } finally {
            await deleteAddress(api, mailbox.jwt);
            await api.dispose();
        }
    });
}

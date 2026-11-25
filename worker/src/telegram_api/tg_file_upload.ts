// Telegram's hosted Bot API documents a 50 MB upload limit for documents.
const TG_MAX_FILE_SIZE = 50 * 1024 * 1024;
const MEDIA_GROUP_SIZE = 6;

function attachmentBatches(files: ParsedEmailAttachment[]): ParsedEmailAttachment[][] {
    const media: ParsedEmailAttachment[] = [];
    const documents: ParsedEmailAttachment[] = [];
    for (const file of files) {
        if (/^(image|video|audio)\//i.test(file.mimeType)) media.push(file);
        else documents.push(file);
    }

    const batches: ParsedEmailAttachment[][] = [];
    let offset = 0;
    while (offset < media.length) {
        // Leave at least two items for the final group when possible.
        const size = media.length - offset === MEDIA_GROUP_SIZE + 1 ? MEDIA_GROUP_SIZE - 1 : MEDIA_GROUP_SIZE;
        batches.push(media.slice(offset, offset + size));
        offset += size;
    }
    return batches.concat(documents.map(file => [file]));
}

export async function sendTelegramAttachments(
    botToken: string,
    chatId: string,
    attachments: ParsedEmailAttachment[],
    caption: string
): Promise<number> {
    const uploadable = attachments.filter(file => file.content.byteLength <= TG_MAX_FILE_SIZE);
    let failed = attachments.length - uploadable.length;
    if (failed > 0) console.warn("Telegram attachment upload skipped: file size limit");

    const firstCaption = caption.slice(0, 1024);
    for (const [index, batch] of attachmentBatches(uploadable).entries()) {
        const single = batch.length === 1;
        const form = new FormData();
        form.append('chat_id', chatId);

        const media = batch.map((file, slot) => {
            const field = single ? 'document' : `file${slot}`;
            form.append(field, new Blob([file.content], {
                type: file.mimeType || 'application/octet-stream'
            }), file.filename || 'attachment');
            return {
                type: 'document',
                media: `attach://${field}`,
                ...(index === 0 && slot === 0 ? { caption: firstCaption } : {}),
            };
        });
        if (!single) form.append('media', JSON.stringify(media));
        else if (index === 0) form.append('caption', firstCaption);

        const method = single ? 'sendDocument' : 'sendMediaGroup';
        try {
            const response = await fetch(
                `https://api.telegram.org/bot${botToken}/${method}`,
                { method: 'POST', body: form },
            );
            if (response.ok) {
                const result = await response.json<{ ok?: boolean }>();
                if (result?.ok === true) continue;
            } else {
                await response.body?.cancel().catch(() => {});
            }
            console.warn("Telegram attachment upload rejected", response.status);
        } catch {
            console.warn("Telegram attachment upload failed");
        }
        failed += batch.length;
    }
    return failed;
}

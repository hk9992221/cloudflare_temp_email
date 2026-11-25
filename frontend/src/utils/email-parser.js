import PostalMime from 'postal-mime';

function humanFileSize(size) {
    const unit = size === 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024));
    return parseFloat((size / Math.pow(1024, unit)).toFixed(2)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
}

async function parseMail(raw, rawBytes) {
    if (rawBytes === undefined) {
        try {
            const { parse_message } = await import('mail-parser-wasm');
            const parsed = parse_message(raw);
            if (parsed.subject && (parsed.body_html || parsed.text)) {
                return {
                    sender: parsed.sender,
                    subject: parsed.subject,
                    html: parsed.body_html,
                    text: parsed.text,
                    attachments: parsed.attachments?.map(file => ({
                        // WASM getters are prototype properties.
                        content: file.content,
                        filename: file.filename,
                        mimeType: file.content_type,
                        contentId: file.content_id,
                    })),
                };
            }
        } catch {
            // PostalMime is also used when the WASM bundle cannot load.
        }
    }

    if (rawBytes !== undefined ? rawBytes.byteLength === 0 : typeof raw !== 'string' || raw.length === 0) {
        throw new TypeError('Missing MIME data');
    }
    const parsed = await PostalMime.parse(rawBytes ?? raw, { attachmentEncoding: 'arraybuffer' });
    const from = parsed.from;
    return {
        ...parsed,
        sender: from?.name && from.address ? `${from.name} <${from.address}>` : from?.address,
    };
}

function attachmentBlob(file) {
    const { content, mimeType } = file;
    // Both parsers are configured to return decoded bytes. Passing the view
    // itself to Blob preserves byteOffset and byteLength.
    if (!(content instanceof ArrayBuffer) && !ArrayBuffer.isView(content)) return null;
    return new Blob([content], { type: mimeType || 'application/octet-stream' });
}

export async function processItem(item, rawBytes, { includeAttachments = true } = {}) {
    item.originalSource ??= item.source;
    if (rawBytes !== undefined) item.rawBytes = rawBytes;
    item.parseError = false;
    item.attachments = [];
    try {
        const parsed = await parseMail(item.raw, rawBytes);
        item.source = parsed.sender || item.originalSource;
        item.subject = parsed.subject || 'No Subject';
        item.message = parsed.html || parsed.text || '';
        item.text = parsed.text || '';
        if (!includeAttachments) return item;

        const cidUrls = new Map();
        for (const [index, file] of (parsed.attachments || []).entries()) {
            const blob = attachmentBlob(file);
            const url = blob ? URL.createObjectURL(blob) : null;
            if (url && file.contentId) cidUrls.set(file.contentId.replace(/^<|>$/g, ''), url);
            item.attachments.push({
                id: file.contentId || index,
                filename: file.filename || file.contentId || 'attachment',
                size: blob ? humanFileSize(blob.size) : null,
                url,
                blob,
            });
        }
        if (parsed.html && cidUrls.size) {
            item.message = parsed.html.replace(/\bcid:([^\s"'<>),;]+)/gi, (match, id) => {
                try {
                    return cidUrls.get(decodeURIComponent(id)) ?? match;
                } catch {
                    return match;
                }
            });
        }
    } catch {
        releaseMailAttachments(item);
        item.attachments = [];
        item.parseError = true;
        item.subject ||= 'No Subject';
        item.message = '';
        item.text = '';
    }
    return item;
}

export function releaseMailAttachments(item) {
    for (const attachment of item?.attachments ?? []) {
        if (attachment.url) URL.revokeObjectURL(attachment.url);
    }
}

export function getDownloadEmlUrl(raw) {
    return URL.createObjectURL(new Blob([raw], { type: 'message/rfc822' }));
}

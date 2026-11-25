export const commonParseMail = async (parsedEmailContext: ParsedEmailContext): Promise<{
    sender: string,
    subject: string,
    text: string,
    html: string,
    headers?: Record<string, string>[],
    attachments?: ParsedEmailAttachment[],
} | undefined> => {
    // check parsed email context is valid
    if (!parsedEmailContext || !parsedEmailContext.rawEmail) {
        return undefined;
    }
    // return parsed email if already parsed
    if (parsedEmailContext.parsedEmail) {
        return parsedEmailContext.parsedEmail;
    }
    const raw_mail = parsedEmailContext.rawEmail;
    // Use the string-based WASM parser for plain bodies only. PostalMime
    // owns multipart and other attachment-bearing MIME so its output is bytes.
    // const mimeHeaders = raw_mail.slice(0, raw_mail.search(/\r?\n\r?\n|$/));
    // const contentType = /^content-type:[ \t\r\n]*([^;\s]+)/im.exec(mimeHeaders)?.[1]?.toLowerCase();
    // const plainMail = !contentType || contentType === 'text/plain' || contentType === 'text/html';
    // if (plainMail && !/^content-disposition:/im.test(mimeHeaders) && !raw_mail.includes('\uFFFD')) {
    //     try {
    //         const { parse_message_wrapper } = await import('mail-parser-wasm-worker');
    //         const parsedEmail = parse_message_wrapper(raw_mail);
    //         if (!parsedEmail.attachments?.length) {
    //             parsedEmailContext.parsedEmail = {
    //                 sender: parsedEmail.sender || "",
    //                 subject: parsedEmail.subject || "",
    //                 text: parsedEmail.text || "",
    //                 headers: parsedEmail.headers?.map(header => ({ key: header.key, value: header.value })) || [],
    //                 html: parsedEmail.body_html || "",
    //                 attachments: [],
    //             };
    //             return parsedEmailContext.parsedEmail;
    //         }
    //     } catch (e) {
    //         console.error("Failed use mail-parser-wasm-worker to parse email", e);
    //     }
    // }
    try {
        const { default: PostalMime } = await import('postal-mime');
        const parsedEmail = await PostalMime.parse(parsedEmailContext.rawBytes ?? raw_mail, {
            attachmentEncoding: 'arraybuffer',
        });
        parsedEmailContext.parsedEmail = {
            sender: parsedEmail.from ? `${parsedEmail.from.name} <${parsedEmail.from.address}>` : "",
            subject: parsedEmail.subject || "",
            text: parsedEmail.text || "",
            html: parsedEmail.html || "",
            headers: parsedEmail.headers || [],
            attachments: (parsedEmail.attachments || []).map(att => ({
                filename: att.filename || "attachment",
                mimeType: att.mimeType || "application/octet-stream",
                content: attachmentBytes(att.content),
                disposition: att.disposition || "attachment",
            })),
        };
        return parsedEmailContext.parsedEmail;
    }
    catch (e) {
        console.error("Failed use PostalMime to parse email", e);
    }
    return undefined;
}

function attachmentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (content instanceof Uint8Array) return content;
    throw new TypeError('PostalMime did not return decoded attachment bytes');
}

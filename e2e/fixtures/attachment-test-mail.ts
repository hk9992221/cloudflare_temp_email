import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const sha256 = (file: Buffer) => createHash('sha256').update(file).digest('hex');

type FixtureFile = {
    name: string;
    type: string;
    bytes: Buffer;
    cid?: string;
    encoding?: 'quoted-printable' | 'binary';
};

function storedZip(files: Record<string, string>) {
    const entries: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const filename = Buffer.from(name);
        const data = Buffer.from(content);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x21, 12);
        header.writeUInt32LE(crc32(data), 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(filename.length, 26);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50);
        central.writeUInt16LE(20, 4);
        header.copy(central, 6, 4, 30);
        central.writeUInt32LE(offset, 42);
        directory.push(central, filename);
        entries.push(header, filename, data);
        offset += header.length + filename.length + data.length;
    }
    const centralDirectory = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...entries, centralDirectory, end]);
}

function samplePdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 144 144] /Contents 4 0 R >>',
        '<< /Length 15 >>\nstream\n4 4 10 10 re f\n\nendstream',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = objects.map((body, index) => {
        const offset = pdf.length;
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
        return offset;
    });
    const xref = pdf.length;
    pdf += ['xref', '0 5', '0000000000 65535 f ',
        ...offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
        'trailer', '<< /Size 5 /Root 1 0 R >>', 'startxref', String(xref), '%%EOF', ''].join('\n');
    return Buffer.from(pdf);
}

const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDtdD0+yk8P6a72luzNaxEsYwSTsHPSiiivhq/8WXqzzZ/Ez//Z', 'base64');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGO4pCwidMCJgSXw6q87QgAgdQUwOxukygAAAABJRU5ErkJggg==', 'base64');

export const fixtureFiles: FixtureFile[] = [
    { name: '原始照片.jpg', type: 'image/jpeg', bytes: jpeg },
    { name: 'pixel.png', type: 'image/png', bytes: png, cid: 'pixel@test' },
    { name: 'report.pdf', type: 'application/pdf', bytes: samplePdf() },
    { name: 'document.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: storedZip({
            '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Attachment fixture</w:t></w:r></w:p></w:body></w:document>',
        }) },
    { name: 'archive.zip', type: 'application/zip', bytes: storedZip({ 'readme.txt': 'Archive fixture\n' }) },
    { name: '文字.txt', type: 'text/plain', bytes: Buffer.from('caf\xe9=quoting', 'latin1'), encoding: 'quoted-printable' },
    { name: 'binary.bin', type: 'application/octet-stream', bytes: Buffer.from([0, 128, 255, 1, 127, 10]) },
    { name: 'empty.txt', type: 'text/plain', bytes: Buffer.alloc(0) },
];

export function buildAttachmentMail(address: string, subject: string, files = fixtureFiles, legacyCharset = true) {
    const charset = legacyCharset ? 'iso-8859-1' : 'utf-8';
    const headers = [
        'From: Sender <sender@test.example.com>', `To: ${address}`, `Subject: ${subject}`,
        'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=attachment-fixture', '',
        '--attachment-fixture', `Content-Type: text/html; charset=${charset}`, 'Content-Transfer-Encoding: 8bit', '',
    ].join('\r\n') + '\r\n';
    const chunks = [Buffer.from(headers), Buffer.from('<p>Original caf\xe9 body</p><img src="cid:pixel%40test"><img src="CID:pixel@test">\r\n', legacyCharset ? 'latin1' : 'utf8')];
    for (const file of files) {
        const encoding = file.encoding ?? 'base64';
        chunks.push(Buffer.from([
            '--attachment-fixture', `Content-Type: ${file.type}`,
            `Content-Disposition: ${file.cid ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            ...(file.cid ? [`Content-ID: <${file.cid}>`] : []),
            `Content-Transfer-Encoding: ${encoding}`, '', '',
        ].join('\r\n')));
        if (encoding === 'quoted-printable') {
            chunks.push(Buffer.from(Array.from(file.bytes, byte => '=' + byte.toString(16).padStart(2, '0').toUpperCase()).join('')));
        } else if (encoding === 'binary') {
            chunks.push(file.bytes);
        } else {
            chunks.push(Buffer.from(file.bytes.toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''));
        }
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from('--attachment-fixture--\r\n'));
    const rawBytes = Buffer.concat(chunks);
    return { raw: rawBytes.toString('utf8'), rawBytes };
}

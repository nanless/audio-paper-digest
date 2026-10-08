'use strict';

// PDF 排版提取是所有纯 PDF 来源共用的入口。这里测三件事：临时文件怎么落盘、
// 视觉审计的字段与 SHA 是否自洽、参数与结果校验在出错时是否真的拦下来。
// 需要真实 PyMuPDF 的用例走 scripts/python-runtime.sh，不联网、不调模型。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pdfLayout = require('../scripts/lib/pdf-layout.js');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

// 不依赖 PDF 生成库，手拼一份两页以内的合法 Helvetica PDF。
function buildPdf(pageLines) {
    const objects = new Map();
    const pageIds = [];
    let nextId = 4;
    for (const lines of pageLines) {
        const pageId = nextId;
        const contentId = nextId + 1;
        nextId += 2;
        pageIds.push(pageId);
        const escaped = lines.map(line => line.replace(/\\/g, '\\\\')
            .replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
        const stream = Buffer.from('BT /F1 9 Tf 30 760 Td 10 TL '
            + escaped.map(text => `(${text}) Tj T*`).join(' ') + ' ET', 'ascii');
        objects.set(pageId, Buffer.from(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
            + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`, 'ascii'));
        objects.set(contentId, Buffer.concat([
            Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'ascii'),
            stream, Buffer.from('\nendstream', 'ascii')
        ]));
    }
    objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'));
    const kids = pageIds.map(id => `${id} 0 R`).join(' ');
    objects.set(2, Buffer.from(
        `<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`, 'ascii'));
    objects.set(3, Buffer.from(
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii'));

    const chunks = [Buffer.from('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n', 'latin1')];
    const maxId = Math.max(...objects.keys());
    const offsets = new Array(maxId + 1).fill(0);
    let size = chunks[0].length;
    for (const objectId of [...objects.keys()].sort((a, b) => a - b)) {
        offsets[objectId] = size;
        const body = Buffer.concat([
            Buffer.from(`${objectId} 0 obj\n`, 'ascii'), objects.get(objectId),
            Buffer.from('\nendobj\n', 'ascii')
        ]);
        chunks.push(body);
        size += body.length;
    }
    const xref = size;
    const xrefLines = ['xref', `0 ${offsets.length}`, '0000000000 65535 f '];
    for (const offset of offsets.slice(1)) xrefLines.push(`${String(offset).padStart(10, '0')} 00000 n `);
    xrefLines.push('trailer', `<< /Size ${offsets.length} /Root 1 0 R >>`,
        'startxref', String(xref), '%%EOF', '');
    chunks.push(Buffer.from(xrefLines.join('\n'), 'ascii'));
    return Buffer.concat(chunks);
}

function tempDirectory(prefix) {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function writePdf(directory, pageLines, name = 'source.pdf') {
    const target = path.join(directory, name);
    fs.writeFileSync(target, buildPdf(pageLines));
    return target;
}

function validAudit(overrides = {}) {
    const audit = {
        contract: 'conference-pdf-visual-audit-v1',
        version: 1,
        backend: { name: 'pymupdf', version: '1.27.2.3' },
        renderDpi: 144,
        pages: [{ page: 1, width: 612, height: 792, bytes: 4096,
            mediaType: 'image/png', sha256: 'a'.repeat(64) }],
        embeddedImages: [],
        tableCandidates: [],
        formulaCandidates: [],
        figureCandidates: [],
        ...overrides
    };
    audit.auditSha256 = pdfLayout.stableHash(audit);
    return audit;
}

describe('PDF 排版提取', () => {
    it('把字节写成 0600 的临时 source.pdf 交给抽取器，返回后删掉整个目录', async () => {
        const bytes = buildPdf([['Alpha table 1'], ['Beta formula']]);
        let observed = null;
        const result = await pdfLayout.extractPdfLayoutFromBytes(bytes, {
            extract: async pdfPath => {
                observed = {
                    pdfPath,
                    content: fs.readFileSync(pdfPath),
                    mode: fs.statSync(pdfPath).mode & 0o777,
                    directory: path.dirname(pdfPath)
                };
                return { contract: 'pdf-layout-extraction-result-v1', version: 1, injected: true };
            }
        });

        assert.equal(path.isAbsolute(observed.pdfPath), true, '交给抽取器的不是绝对路径');
        assert.equal(path.basename(observed.pdfPath), 'source.pdf');
        assert.deepEqual(observed.content, bytes, '临时文件内容与传入字节不一致');
        assert.equal(observed.mode, 0o600, '临时 PDF 的权限位不是 0600');
        assert.equal(fs.existsSync(observed.directory), false, '返回后临时目录还在');
        assert.deepEqual(result, { contract: 'pdf-layout-extraction-result-v1', version: 1, injected: true });
    });

    it('抽取器抛错时同样删掉临时目录', async () => {
        let directory = null;
        await assert.rejects(() => pdfLayout.extractPdfLayoutFromBytes(buildPdf([['x']]), {
            extract: async pdfPath => {
                directory = path.dirname(pdfPath);
                throw new Error('模拟抽取器崩溃');
            }
        }), /模拟抽取器崩溃/);
        assert.equal(fs.existsSync(directory), false, '抽取器失败后临时目录还在');
    });

    it('stableHash 忽略对象键顺序，但数组顺序会改变哈希', () => {
        assert.equal(pdfLayout.stableHash({ b: 1, a: { d: 2, c: [3, 4] } }),
            pdfLayout.stableHash({ a: { c: [3, 4], d: 2 }, b: 1 }));
        assert.notEqual(pdfLayout.stableHash([1, 2]), pdfLayout.stableHash([2, 1]));
    });

    it('validateVisualAudit 接受字段齐全、SHA 可复算的审计并原样返回', () => {
        const audit = validAudit();
        assert.equal(pdfLayout.validateVisualAudit(audit), audit);
    });

    it('走真实 PyMuPDF 抽取一份两页 PDF', async () => {
        const directory = tempDirectory('pdf-layout-e2e-');
        try {
            const pdfPath = writePdf(directory, [['Alpha table 1'], ['Beta formula y=x^2']]);
            const result = await pdfLayout.extractPdfLayoutFromPath(pdfPath);

            assert.equal(result.contract, 'pdf-layout-extraction-result-v1');
            assert.equal(result.version, 1);
            assert.equal(result.backend.name, 'pymupdf');
            assert.equal(result.pageCount, 2);
            assert.equal(result.pdfSha256, sha256(fs.readFileSync(pdfPath)));
            assert.equal(result.textSha256, sha256(Buffer.from(result.text, 'utf8')));
            assert.match(result.text, /Alpha table 1/);
            assert.match(result.text, /Beta formula/);
            assert.equal(pdfLayout.validateVisualAudit(result.visualAudit), result.visualAudit);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('走真实 PyMuPDF 渲染请求的每一页，文件确实落盘', async () => {
        const directory = tempDirectory('pdf-layout-render-');
        try {
            const pdfPath = writePdf(directory, [['one'], ['two']]);
            const output = path.join(directory, 'out');
            fs.mkdirSync(output);
            const files = await pdfLayout.renderPdfPages(pdfPath, output, [1, 2]);

            assert.equal(files.length, 2, '返回的文件数与请求页数不一致');
            assert.deepEqual(files.map(file => file.page), [1, 2]);
            for (const file of files) {
                assert.equal(file.mediaType, 'image/png');
                assert.equal(fs.existsSync(path.join(output, file.filename)), true,
                    `${file.filename} 没有真的写出来`);
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('拒绝相对路径、非 PDF 字节和空渲染参数', async () => {
        // 只接受 Node 侧那句原文。若把这里的前置校验删掉，请求会落到 Python，
        // 报错里会多出 pdf-layout-extract: 与 traceback，这条断言就挡不住了。
        await assert.rejects(() => pdfLayout.extractPdfLayoutFromPath('relative.pdf'),
            error => error.message === 'PDF 排版提取失败：PDF 路径必须是绝对路径');
        await assert.rejects(() => pdfLayout.extractPdfLayoutFromBytes(Buffer.from('not a pdf')),
            /PDF 字节的文件头不对/);
        await assert.rejects(() => pdfLayout.extractPdfLayoutFromBytes(Buffer.alloc(0)),
            /PDF 字节的文件头不对/);

        const directory = tempDirectory('pdf-layout-guard-');
        try {
            const pdfPath = writePdf(directory, [['one']]);
            const output = path.join(directory, 'out');
            fs.mkdirSync(output);
            await assert.rejects(() => pdfLayout.renderPdfPages(pdfPath, output, []),
                /渲染参数不合法/);
            await assert.rejects(() => pdfLayout.renderPdfPages(pdfPath, 'relative', [1]),
                /渲染参数不合法/);
            await assert.rejects(() => pdfLayout.renderPdfPages(pdfPath, output, [0]),
                /渲染参数不合法/);
            await assert.rejects(() => pdfLayout.renderPdfPages(pdfPath, output, [1.5]),
                /渲染参数不合法/);
            await assert.rejects(() => pdfLayout.renderPdfPages(pdfPath, output, [3]),
                /要渲染的页码超出 PDF 总页数/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('视觉审计被篡改、带像素字段或逐页记录不合法时都拒绝', () => {
        const drifted = validAudit();
        drifted.pages[0].bytes = 9999;
        assert.throws(() => pdfLayout.validateVisualAudit(drifted), /SHA-256 复算不上/);

        const leaky = validAudit({
            pages: [{ page: 1, width: 612, height: 792, bytes: 4096,
                mediaType: 'image/png', sha256: 'a'.repeat(64), pngBase64: 'AAAA' }]
        });
        assert.throws(() => pdfLayout.validateVisualAudit(leaky), /留下了像素字段/);

        const wrongContract = validAudit({ contract: 'conference-pdf-visual-audit-v2' });
        assert.throws(() => pdfLayout.validateVisualAudit(wrongContract), /格式标记不完整/);

        const badPage = validAudit({
            pages: [{ page: 0, width: 612, height: 792, bytes: 4096,
                mediaType: 'image/jpeg', sha256: 'a'.repeat(64) }]
        });
        assert.throws(() => pdfLayout.validateVisualAudit(badPage), /逐页记录不合法/);

        const badDpi = validAudit({ renderDpi: 0 });
        assert.throws(() => pdfLayout.validateVisualAudit(badDpi), /格式标记不完整/);
    });
});

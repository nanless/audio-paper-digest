'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { spawnSync, execFileSync } = require('node:child_process');

const source = require('../scripts/lib/conference-pdf-source.js');
const ledgerApi = require('../scripts/lib/conference-source-ledger.js');

const temporary = [];
afterEach(() => {
    while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function stableJson(value) {
    if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(stableJson(item))));
    if (value && typeof value === 'object') {
        return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stableJson(value[key]))])));
    }
    return JSON.stringify(value);
}

function resign(descriptor) {
    const { descriptorSha256, ...body } = descriptor;
    return { ...body, descriptorSha256: digest(Buffer.from(stableJson(body))) };
}

function fixture({ bytes = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'binary') } = {}) {
    // macOS 上的 /var 通常是指向 /private/var 的兼容符号链接。
    // 把受控根目录的固定数据放在仓库下面，这样这条测试
    // 也能顺带验证适配器会拒绝根目录带符号链接的路径。
    const root = fs.mkdtempSync(path.join(process.cwd(), '.conference-pdf-source-'));
    temporary.push(root);
    fs.mkdirSync(path.join(root, 'papers'), { mode: 0o700 });
    const relativePath = 'papers/example.pdf';
    const filename = path.join(root, relativePath);
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    return {
        root, filename, bytes,
        record: {
            identity: { conference: 'icassp-2026', arnumber: '12345678' },
            pdfRelativePath: relativePath,
            pdfSha256: digest(bytes),
        },
    };
}

function ledgerFixture() {
    const f = fixture();
    for (const folder of ['metadata', 'text', 'artifacts']) fs.mkdirSync(path.join(f.root, folder), { mode: 0o700 });
    const createMember = (value, suffix) => {
        const pdfFile = `papers/${suffix}.pdf`;
        const pdfBytes = suffix === 'first' ? f.bytes : Buffer.concat([f.bytes, Buffer.from(`\n% ${suffix}\n`)]);
        fs.writeFileSync(path.join(f.root, pdfFile), pdfBytes, { mode: 0o600 });
        const files = {
            metadataFile: `metadata/${suffix}.json`, pdfFile,
            textFile: `text/${suffix}.txt`, artifactsFile: `artifacts/${suffix}.json`,
        };
        const contents = {
            metadataFile: Buffer.from(`{"id":"${value}"}`), pdfFile: pdfBytes,
            textFile: Buffer.from(`extracted ${value}`), artifactsFile: Buffer.from(`{"sections":[]}`),
        };
        for (const field of ['metadataFile', 'textFile', 'artifactsFile']) {
            fs.writeFileSync(path.join(f.root, files[field]), contents[field], { mode: 0o600 });
        }
        const member = {
            identity: { type: 'icassp-arnumber', value }, ...files,
            metadataSha256: digest(contents.metadataFile), pdfSha256: digest(contents.pdfFile),
            textSha256: digest(contents.textFile), artifactsSha256: digest(contents.artifactsFile),
        };
        member.availability = { metadata: 'present', pdf: 'present', text: 'present', artifacts: 'present' };
        member.provenance = {
            metadata: { kind: 'official-metadata', locator: `https://example.test/${value}/metadata`, retrievedAt: '2026-09-06T08:00:00.000Z' },
            pdf: { kind: 'official-pdf', locator: `https://example.test/${value}/pdf`, retrievedAt: '2026-09-06T08:00:00.000Z' },
            text: { extractor: 'pdftotext', version: '24.02', inputSha256: member.pdfSha256 },
            artifacts: { extractor: 'pdf-layout', version: '1.0', inputSha256: member.pdfSha256 },
        };
        member.status = {
            state: 'verified', updatedAt: '2026-09-06T08:00:00.000Z', reason: 'all four local source artifacts checked',
            evidence: ['metadata', 'pdf', 'text', 'artifacts'].map(kind => ({ kind, sha256: member[`${kind}Sha256`] })),
        };
        return member;
    };
    const members = [createMember('1001', 'first'), createMember('1002', 'second')];
    const ledger = ledgerApi.createLedger({ id: 'icassp-2026', year: 2026 }, members);
    const ledgerFile = path.join(f.root, 'ledger.json'); ledgerApi.writeLedger(ledgerFile, ledger);
    const ledgerHandle = ledgerApi.loadLedgerHandle(ledgerFile);
    const { ledgerSha256 } = ledgerApi.ledgerHandleSnapshot(ledgerHandle);
    return { ...f, ledger, ledgerHandle, ledgerSha256, first: ledger.members[0], second: ledger.members[1] };
}

test('本地 PDF 来源描述符绑定已核验的身份、字节，并显式标明提取不可得', () => {
    const f = fixture();
    const result = source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record });
    assert.equal(result.descriptor.contract, 'conference-pdf-source-v1');
    assert.equal(result.descriptor.kind, 'local_pdf');
    assert.equal(result.descriptor.pdfSha256, f.record.pdfSha256);
    assert.equal(result.descriptor.pdfBytes, f.bytes.length);
    assert.equal(result.descriptor.textSha256, null);
    assert.equal(result.descriptor.structuredArtifactsSha256, null);
    assert.equal(result.descriptor.formulaTeXSha256, null);
    assert.deepEqual(result.descriptor.availability, { text: false, structuredArtifacts: false, formulaTeX: false });
    assert.deepEqual(result.formulaTeX, { available: false, reason: 'no-reliable-structured-tex' });
    assert.deepEqual(source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: result.descriptor }), result.descriptor);
});

test('本地提取记录可复核的哈希；没有可靠的结构化 TeX 时，不声称公式可用', () => {
    const f = fixture();
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record,
        extractPdf: () => ({ extractorVersion: 'pdftotext-24.02', text: 'plain extracted text', formulaTeX: { available: true } }),
    }), /reliable structured TeX/);
    const structuredArtifacts = { sections: [{ id: 'method', text: 'Method' }], formulaIndex: [] };
    const result = source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record,
        extractPdf: ({ pdfBytes }) => {
            assert.notEqual(pdfBytes, f.bytes, 'extractor receives a separate Buffer');
            return { extractorVersion: 'local-pdf-extractor-v1', text: 'local extracted text', structuredArtifacts,
                formulaTeX: { available: false, reason: 'pdf-has-no-reliable-structured-tex' } };
        },
    });
    assert.equal(result.descriptor.availability.text, true);
    assert.equal(result.descriptor.availability.structuredArtifacts, true);
    assert.equal(result.descriptor.availability.formulaTeX, false);
    source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: result.descriptor,
        text: result.text, structuredArtifacts: result.structuredArtifacts });
    assert.throws(() => source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: result.descriptor,
        text: 'modified', structuredArtifacts }), /text artifact/);
    const reliable = source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record,
        extractPdf: () => ({ extractorVersion: 'structured-tex-v1', text: 'text', structuredArtifacts: { formulaIndex: ['eq-1'] },
            formulaTeX: { available: true, reliability: 'reliable', formulas: [{ tex: 'x^2', sourceRef: 'page-1:eq-1' }] } }),
    });
    assert.equal(reliable.descriptor.availability.formulaTeX, true);
    assert.match(reliable.descriptor.formulaTeXSha256, /^[a-f0-9]{64}$/);
    source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: reliable.descriptor,
        text: reliable.text, structuredArtifacts: reliable.structuredArtifacts, formulaTeX: reliable.formulaTeX });
});

test('只接受受控根目录内、大小不超限、且只有一条硬链接的普通 PDF', t => {
    const f = fixture();
    for (const pdfRelativePath of ['/tmp/outside.pdf', '../outside.pdf', 'papers/../example.pdf', 'papers\\example.pdf']) {
        assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: { ...f.record, pdfRelativePath } }),
            /relative path|traversal/);
    }
    fs.symlinkSync(f.filename, path.join(f.root, 'papers', 'linked.pdf'));
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: { ...f.record, pdfRelativePath: 'papers/linked.pdf' } }),
        /regular, non-linked/);
    fs.linkSync(f.filename, path.join(f.root, 'papers', 'hard-linked.pdf'));
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: { ...f.record, pdfRelativePath: 'papers/hard-linked.pdf' } }),
        /regular, non-linked/);
    fs.unlinkSync(path.join(f.root, 'papers', 'hard-linked.pdf'));
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record, maxBytes: f.bytes.length - 1 }), /size limit/);
    t.diagnostic('security checks reject traversal, symbolic links, hard links, and oversized files');
});

test('文件头不对、字节变了、记录哈希不符或描述符被改动，一律直接失败', () => {
    const bad = fixture({ bytes: Buffer.from('not a PDF') });
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: bad.root, record: bad.record }), /standard PDF/);
    const f = fixture();
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: { ...f.record, pdfSha256: '0'.repeat(64) } }), /SHA-256 differs/);
    const result = source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record });
    const mutated = { ...result.descriptor, pdfBytes: result.descriptor.pdfBytes + 1 };
    assert.throws(() => source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: mutated }), /checksum/);
    fs.writeFileSync(f.filename, Buffer.concat([f.bytes, Buffer.from('changed')]), { mode: 0o600 });
    assert.throws(() => source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: result.descriptor }), /bytes no longer replay/);
});

test('账目桥接只放行选中的已核验成员，并绑定所有非 PDF 来源的 SHA', () => {
    const f = ledgerFixture();
    const identityKey = ledgerApi.identityKey(f.first.identity);
    const result = source.buildConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: f.ledgerHandle, identityKey,
    });
    assert.deepEqual(result.descriptor.ledgerBinding, {
        ledgerSha256: f.ledgerSha256,
        identityKey,
        metadataSha256: f.first.metadataSha256,
        textSha256: f.first.textSha256,
        artifactsSha256: f.first.artifactsSha256,
    });
    assert.equal(result.descriptor.pdfRelativePath, f.first.pdfFile);
    assert.deepEqual(source.replayConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: f.ledgerHandle, identityKey, descriptor: result.descriptor,
    }), result.descriptor);
    assert.throws(() => source.buildConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: f.ledgerHandle, identityKey: 'icassp-arnumber:9999',
    }), /does not identify/);

    const blocked = structuredClone(f.ledger);
    const blockedMember = blocked.members[0];
    blockedMember.availability.text = 'absent';
    blockedMember.availability.artifacts = 'absent';
    blockedMember.textFile = blockedMember.textSha256 = blockedMember.artifactsFile = blockedMember.artifactsSha256 = null;
    blockedMember.provenance.text = blockedMember.provenance.artifacts = null;
    blockedMember.status = { ...blockedMember.status, state: 'blocked', evidence: blockedMember.status.evidence.filter(item => ['metadata', 'pdf'].includes(item.kind)) };
    assert.throws(() => source.buildConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: structuredClone(f.ledgerHandle), identityKey,
    }), /authenticated loaded ledger handle/);
});

test('账目复核拒绝跨成员、跨账目、来源漂移，以及重算描述符字段的伪造', () => {
    const f = ledgerFixture();
    const firstKey = ledgerApi.identityKey(f.first.identity);
    const secondKey = ledgerApi.identityKey(f.second.identity);
    const result = source.buildConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: f.ledgerHandle, identityKey: firstKey,
    });
    assert.throws(() => source.replayConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: f.ledgerHandle, identityKey: secondKey, descriptor: result.descriptor,
    }), /does not belong to this loaded ledger member/);
    assert.throws(() => source.replayConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: structuredClone(f.ledgerHandle), identityKey: firstKey, descriptor: result.descriptor,
    }), /authenticated loaded ledger handle/);

    const unknown = resign({ ...result.descriptor, untrustedField: 'forged' });
    assert.throws(() => source.replayConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: f.ledgerHandle, identityKey: firstKey, descriptor: unknown,
    }), /unexpected or missing fields/);
    const inconsistent = resign({ ...result.descriptor, extractor: { ...result.descriptor.extractor, textAvailable: true } });
    assert.throws(() => source.replayConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: f.ledgerHandle, identityKey: firstKey, descriptor: inconsistent,
    }), /availability, hash, and extractor/);

    fs.writeFileSync(path.join(f.root, f.first.metadataFile), 'metadata drift', { mode: 0o600 });
    assert.throws(() => source.replayConferencePdfSourceFromLedger({
        sourceRoot: f.root, ledgerHandle: f.ledgerHandle, identityKey: firstKey, descriptor: result.descriptor,
    }), /metadata artifact SHA-256 differs/);
});


for (const entry of ['ledger-json', 'pdf', 'ledger-artifact', 'ledger-artifact-replaced']) {
    test(`公开 ${entry} 入口遇到 FIFO 应拒绝，不能阻塞在打开文件上`, () => {
        const f = ledgerFixture();
        const target = entry === 'ledger-json' ? path.join(f.root, 'ledger.json')
            : entry === 'pdf' ? f.filename : path.join(f.root, f.first.metadataFile);
        if (entry !== 'ledger-artifact-replaced') {
            fs.unlinkSync(target); execFileSync('mkfifo', [target]);
        }
        const code = `
            const fs = require('node:fs'); const path = require('node:path');
            const { execFileSync } = require('node:child_process');
            const source = require(process.argv[1]); const ledger = require(process.argv[2]);
            const [entry, root, target, recordText] = process.argv.slice(3);
            try {
                if (entry === 'ledger-json') {
                    require(path.join(path.dirname(process.argv[1]), '..', 'conference-tools.js'))
                        .validateLedgerFile({ ledgerDirectory: root, ledgerName: 'ledger.json' });
                } else if (entry === 'pdf') {
                    source.buildConferencePdfSource({ cacheRoot: root, record: JSON.parse(recordText) });
                } else {
                    const handle = ledger.loadLedgerHandle(path.join(root, 'ledger.json'));
                    if (entry === 'ledger-artifact-replaced') {
                        const originalOpen = fs.openSync;
                        fs.openSync = (filename, ...args) => {
                            if (filename === target) {
                                fs.openSync = originalOpen; fs.unlinkSync(target); execFileSync('mkfifo', [target]);
                            }
                            return originalOpen(filename, ...args);
                        };
                        ledger.verifyMemberFiles(ledger.ledgerHandleSnapshot(handle).ledger, root);
                    } else {
                        source.buildConferencePdfSourceFromLedger({ sourceRoot: root, ledgerHandle: handle,
                            identityKey: 'icassp-arnumber:1001' });
                    }
                }
                process.exitCode = 2;
            } catch (error) { console.error(error.message); process.exitCode = 1; }
        `;
        const result = spawnSync(process.execPath, ['-e', code,
            require.resolve('../scripts/lib/conference-pdf-source.js'),
            require.resolve('../scripts/lib/conference-source-ledger.js'),
            entry, f.root, target, JSON.stringify(f.record)], { encoding: 'utf8', timeout: 2000 });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Unsafe ledger|regular, non-linked/);
        assert.equal(fs.lstatSync(target).isFIFO(), true);
    });
}

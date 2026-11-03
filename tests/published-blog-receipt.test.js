const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config');
const { validAnalysisPaper } = require('./valid-analysis-fixture');
const { productionV6GenerationFields, productionV6ReceiptFields,
    llmApiProductionGenerationFields, llmApiProductionReceiptFields } = require('./formal-publication-fixture');
const { publishedPapersFingerprint, assertPublishedBlogReceipt } = require('../scripts/lib/published-blog-receipt');

function paper(id = '2607.12345', extra = {}) {
    return validAnalysisPaper(id, {
        title: 'Visual summary paper',
        fetchedAt: '2026-07-13T10:00:00.000+08:00',
        parsed: { score: 6.9, primaryTaskTag: '#语音识别' },
        ...extra
    });
}

function writePublishedReceipt(currentDir, targetDate, publishedPapers, overrides = {}, mode = 'manual') {
    fs.mkdirSync(currentDir, { recursive: true });
    const generationPath = path.join(currentDir, `blog-generation-manifest-${targetDate}.json`);
    const snapshotFingerprint = publishedPapersFingerprint(publishedPapers);
    const productionFields = mode === 'api'
        ? llmApiProductionGenerationFields(publishedPapers)
        : productionV6GenerationFields(publishedPapers);
    const generation = {
        schemaVersion: 3, date: targetDate, category: '论文速递',
        visualSummaryRequired: false, digestCoverRequired: false,
        inputFingerprint: 'c'.repeat(64), publishAll: false, publishedPapers,
        publishedPapersFingerprintContract: 'typed-json-f64-utf16-v1',
        publishedPapersFingerprint: snapshotFingerprint,
        ...productionFields
    };
    const raw = Buffer.from(JSON.stringify(generation));
    fs.writeFileSync(generationPath, raw);
    const receiptPath = path.join(currentDir, `blog-review-receipt-${targetDate}.json`);
    fs.writeFileSync(receiptPath, JSON.stringify({
        schemaVersion: 3, date: targetDate, strictReview: true, hugoGate: 'hugo',
        reviewProtocolFingerprint: 'b'.repeat(64),
        generationManifestSha256: crypto.createHash('sha256').update(raw).digest('hex'),
        generationInputIntegrity: 'typed-json-f64-utf16-v1',
        generationInputFingerprint: generation.inputFingerprint,
        publishedPapersFingerprint: snapshotFingerprint,
        publicationCommit: 'a'.repeat(40), remoteVerifiedOid: 'a'.repeat(40),
        remoteVerifiedAt: '2026-07-14T02:00:00+08:00',
        ...(mode === 'api'
            ? llmApiProductionReceiptFields(generation)
            : productionV6ReceiptFields(generation)),
        ...overrides
    }));
    return receiptPath;
}

describe('正式博客出版凭证', () => {
    it('计算已发布论文的校验信息时，包含表情符号等字符的对象键仍按 UTF-16 编码单元排序', () => {
        const probe = JSON.parse(fs.readFileSync(
            path.join(__dirname, 'fixtures', 'published-papers-fingerprint-probe.json'),
            'utf8'
        ));
        assert.strictEqual(
            publishedPapersFingerprint(probe),
            '3ee65da42ed04aa221d4429d960f7b60ed86fb5bee62f428ec67d2f8d2171882'
        );
    });

    it('只有远端 OID 已验证的博客发布凭证才能登记出版完成', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-published-'));
        const originalCurrent = Config.CURRENT_DIR;
        try {
            Config.CURRENT_DIR = dir;
            const receipt = writePublishedReceipt(dir, '2026-07-13', [paper()], { remoteVerifiedOid: null });
            assert.throws(() => assertPublishedBlogReceipt('2026-07-13', receipt), /远端 OID/);
            writePublishedReceipt(dir, '2026-07-13', [paper()]);
            assert.strictEqual(assertPublishedBlogReceipt('2026-07-13', receipt).publicationCommit, 'a'.repeat(40));
        } finally {
            Config.CURRENT_DIR = originalCurrent;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('符合 API 正式发布要求的凭证可以登记出版完成，但篡改其中的模型记录会被拒绝', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-api-published-'));
        const originalCurrent = Config.CURRENT_DIR;
        try {
            Config.CURRENT_DIR = dir;
            const receipt = writePublishedReceipt(dir, '2026-07-13', [paper()], {}, 'api');
            const publication = assertPublishedBlogReceipt('2026-07-13', receipt);
            assert.strictEqual(publication.publicationMode, 'llm_api_production');
            assert.match(publication.llmApiProductionFingerprint, /^[a-f0-9]{64}$/);
            const generationPath = path.join(dir, 'blog-generation-manifest-2026-07-13.json');
            const generation = JSON.parse(fs.readFileSync(generationPath, 'utf8'));
            generation.llmApiBindings[0].model = 'tampered-model';
            fs.writeFileSync(generationPath, JSON.stringify(generation));
            assert.throws(
                () => assertPublishedBlogReceipt('2026-07-13', receipt),
                /generation manifest|provenance 指纹/
            );
        } finally {
            Config.CURRENT_DIR = originalCurrent;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('发布凭证中的论文内容被篡改而输入校验信息未更新时，拒绝登记出版完成', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-snapshot-tamper-'));
        const originalCurrent = Config.CURRENT_DIR;
        try {
            Config.CURRENT_DIR = dir;
            const receiptPath = writePublishedReceipt(dir, '2026-07-13', [paper()]);
            const generationPath = path.join(dir, 'blog-generation-manifest-2026-07-13.json');
            const generation = JSON.parse(fs.readFileSync(generationPath, 'utf8'));
            generation.publishedPapers[0].title = 'tampered after generation';
            const generationRaw = Buffer.from(JSON.stringify(generation));
            fs.writeFileSync(generationPath, generationRaw);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            receipt.generationManifestSha256 = crypto.createHash('sha256')
                .update(generationRaw).digest('hex');
            fs.writeFileSync(receiptPath, JSON.stringify(receipt));
            assert.throws(
                () => assertPublishedBlogReceipt('2026-07-13', receiptPath),
                /可反向验证的已发布论文权威快照/
            );
        } finally {
            Config.CURRENT_DIR = originalCurrent;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

it('旧汇总只认原五类声明，重算包内校验值不能添入新格式', () => {
    const checks = require('../scripts/lib/published-blog-receipt');
    const papers = [paper()];
    const baseline = llmApiProductionGenerationFields(papers);
    for (const mutate of [
        value => { value.llmApiBindings[0].readerSourceBindingsContract = 'different-source-binding'; },
        value => { value.llmApiBindings[0].readerAuthorIdentitySchemaFingerprint = 'a'.repeat(64); },
        value => { value.llmApiBindings[0].readerResourceIdentitySchemaFingerprint = 'b'.repeat(64); },
        value => { value.llmApiProduction.readerSourceBindingsContract = 'different-source-binding'; },
        value => { value.llmApiProduction.readerAuthorIdentitySchemaFingerprint = 'c'.repeat(64); }
    ]) {
        const value = structuredClone(baseline);
        mutate(value);
        value.llmApiBindingsFingerprint = checks.stableApiBindingsSha256(value.llmApiBindings);
        value.llmApiProduction.bindingsFingerprint = value.llmApiBindingsFingerprint;
        value.llmApiProductionFingerprint = checks.stableSha256(value.llmApiProduction);
        assert.throws(() => checks.assertLlmApiProductionGeneration(value, papers), /原单一格式/);
    }
    checks.assertLlmApiProductionGeneration(baseline, papers);
});

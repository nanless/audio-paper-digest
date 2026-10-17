'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildManifestContext } = require('../../scripts/lib/legacy-manual-source.js');
const { buildCompleteEntry, writeLegacyFulltextManifestFixture } = require('./helpers/legacy-fulltext-fixture.js');
const {
    ARTIFACT_PARSER_VERSION,
    computeStructuredPayloadSha256,
    validateStructuredArtifacts,
    buildArtifactIndex,
    validateArtifactIndex,
    buildArtifactManifestContext,
    loadStructuredArtifactSnapshot,
    structuredSnapshotPathFor,
    readArtifactManifestLocked,
    artifactPathFor,
    isReusableArtifactCheckpoint
} = require('../scripts/manual-artifact-index.js');
const {
    parseArxivStructuredArtifactsFromHtml,
    buildUnstructuredTextArtifactSignals,
    bindStructuredArtifactsToText
} = require('../../scripts/deep-analyzer.js');

function fixtureText() {
    return `# Introduction
We study automatic speech recognition (ASR) on the LibriSpeech dataset [1].
Smith et al. (2024) provide a strong baseline, and our system is compared with that baseline.

# Method
The encoder optimizes the following objective:
$$L = L_{CTC} + 0.3 L_{AED}$$

# Results
| System | WER clean | WER other |
| --- | ---: | ---: |
| Baseline | 4.8 | 10.2 |
| Proposed ASR | 4.1 | 9.3 |

Table 2 Ablation results on the test set
Variant  WER  Accuracy
without adapter  5.2  91.0
full model  4.1  93.4

# Conclusion
The proposed model improves WER, while the small test set limits generalization.
${'Additional full-text evidence about audio frames, training data, evaluation, and reproducibility. '.repeat(18)}`;
}

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-artifact-index-'));
    const filtered = {
        status: 'complete', batchDate: '2026-08-28', batchId: 'artifact-batch',
        papers: [{ arxivId: '2608.12345v2', title: 'Artifact fixture', authors: ['A'] }]
    };
    const context = buildManifestContext(filtered, filtered.batchDate, dir);
    const input = context.inputs[0];
    const text = fixtureText();
    const productionHtml = fs.readFileSync(
        path.join(__dirname, '..', '..', 'tests', 'fixtures', 'arxiv-structured-paper.html'), 'utf8'
    );
    const structuredArtifacts = bindStructuredArtifactsToText(
        parseArxivStructuredArtifactsFromHtml(
            productionHtml, '2608.12345v2', '2608.12345v2'
        ),
        text
    );
    fs.writeFileSync(input.filePath, text);
    const sourceEntry = buildCompleteEntry(input, {
        source: 'html', sourceId: '2608.12345v2', text, warnings: [],
        imageInfos: [{
            url: 'https://arxiv.org/html/2608.12345v2/x1.png',
            caption: 'Overview of the speech encoder', alt: 'encoder diagram', source: 'arxiv_html'
        }]
    }, fs.readFileSync(input.filePath));
    return { dir, context, input, text, sourceEntry, structuredArtifacts };
}

// Explicit old-format fixture bytes, never a production writer or completion receipt.
function savedArtifactFixture(f) {
    const { dir, context, input, text, sourceEntry, structuredArtifacts } = f;
    const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const artifactContext = buildArtifactManifestContext(context, dir);
    const snapshotPath = structuredSnapshotPathFor(artifactContext, input, sourceEntry, structuredArtifacts);
    const snapshot = { version: 1, mode: 'manual_structured_source_snapshot', paperId: input.id,
        source: sourceEntry.source, sourceId: sourceEntry.sourceId, sourceSha256: sourceEntry.sourceSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256, paperInputSha256: input.paperInputSha256,
        payloadSha256: structuredArtifacts.payloadSha256, structuredArtifacts };
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot, null, 2));
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, snapshotBytes);
    sourceEntry.structuredArtifactsSnapshot = { version: 1, path: snapshotPath,
        parserVersion: structuredArtifacts.parserVersion, healthStatus: structuredArtifacts.health.status,
        payloadSha256: structuredArtifacts.payloadSha256, outputSha256: digest(snapshotBytes), bytes: snapshotBytes.length };
    const index = buildArtifactIndex({ paperId: input.id, sourceText: text,
        sourceSha256: sourceEntry.sourceSha256, sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
        paperInputSha256: input.paperInputSha256, imageInfos: sourceEntry.imageInfos,
        sourceKind: sourceEntry.source, sourceId: sourceEntry.sourceId, structuredArtifacts,
        structuredArtifactsSha256: structuredArtifacts.payloadSha256 });
    const indexPath = artifactPathFor(artifactContext, input, sourceEntry);
    const indexBytes = Buffer.from(JSON.stringify(index, null, 2));
    fs.writeFileSync(indexPath, indexBytes);
    const entry = { status: index.inventoryHealth.status, paperId: input.id, parserVersion: ARTIFACT_PARSER_VERSION,
        path: indexPath, paperInputSha256: input.paperInputSha256, sourceSha256: sourceEntry.sourceSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256, structuredArtifactsSha256: structuredArtifacts.payloadSha256,
        inventoryStatus: index.inventoryHealth.status, inventoryIssues: index.inventoryHealth.issues,
        artifactIndexSha256: index.artifactIndexSha256, outputSha256: digest(indexBytes), bytes: indexBytes.length,
        completedAt: '2026-08-28T12:00:00+08:00' };
    const manifest = { version: 1, mode: 'manual_artifact_index', parserVersion: ARTIFACT_PARSER_VERSION,
        date: context.date, filteredBatchSha256: context.filteredBatchSha256,
        expectedPaperInputs: artifactContext.expectedPaperInputs, papers: { [input.id]: entry },
        status: 'partial_failed', failed: 1, usage: { totalTokens: 19 }, error: 'retained fixture failure' };
    fs.writeFileSync(artifactContext.manifestPath, JSON.stringify(manifest, null, 2));
    return { artifactContext, entry, manifest };
}

describe('Manual 结构化来源索引 v1', () => {
    it('对象键顺序不同，结构化来源内容的 SHA-256 仍相同', () => {
        const left = { version: 1, parserVersion: 'arxiv-html-dom-v4', nested: { b: 2, a: 1 } };
        const right = { nested: { a: 1, b: 2 }, parserVersion: 'arxiv-html-dom-v4', version: 1 };
        assert.equal(computeStructuredPayloadSha256(left), computeStructuredPayloadSha256(right));
    });

    it('相同输入生成相同单篇清单，包含表格、图片、公式和来源引文', () => {
        const { input, text, sourceEntry, structuredArtifacts } = fixture();
        const options = {
            paperId: input.id,
            sourceText: text,
            sourceSha256: sourceEntry.sourceSha256,
            sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
            paperInputSha256: input.paperInputSha256,
            imageInfos: sourceEntry.imageInfos,
            sourceKind: sourceEntry.source,
            sourceId: sourceEntry.sourceId,
            structuredArtifacts,
            structuredArtifactsSha256: structuredArtifacts.payloadSha256
        };
        const index = buildArtifactIndex(options);
        assert.equal(index.parserVersion, ARTIFACT_PARSER_VERSION);
        assert.equal(index.outputSha256, index.artifactIndexSha256);
        assert.deepEqual(buildArtifactIndex(options), index);
        assert.ok(index.sections.length >= 4);
        assert.equal(index.inventoryHealth.status, 'complete');
        assert.ok(index.tables.length >= 1);
        assert.ok(index.tables.some(table => table.kind === 'result' && table.matrixSha256));
        assert.ok(index.tables.every(table => table.id && table.replayBlockSha256));
        assert.ok(index.tables[0].cells.some(cell => cell.rowspan === 2));
        assert.ok(index.tables[0].cells.some(cell => cell.colspan === 2));
        assert.equal(index.figures[0].id, 'IMG0001');
        assert.equal(index.figures[1].source, 'arxiv_html_dom_inline_svg');
        assert.equal(index.figures[1].url, '');
        assert.match(index.figures[1].inlineSvgSha256, /^[a-f0-9]{64}$/);
        assert.deepEqual(index.images, index.figures);
        assert.ok(index.formulas[0].id.startsWith('FOR'));
        assert.match(index.formulas[0].latex, /mathcal/);
        assert.equal(index.references.length, 1);
        assert.ok(index.acronyms.some(item => item.value === 'ASR'));
        assert.ok(index.citations.length >= 2);
        assert.ok(index.baselines.length >= 1);
        assert.ok(index.datasets.length >= 1);
        assert.ok(index.metrics.some(item => item.value === 'WER'));
        assert.ok(index.sourceSpans.length >= 8);
        assert.ok(index.sourceSpans.every(span => span.id && span.sha256));
        assert.doesNotThrow(() => validateArtifactIndex(index, options));
    });

    it('把带编号的 DOM 原生带框图作为可核对的非位图证据', () => {
        const { input, text, sourceEntry } = fixture();
        const html = `<article><figure class="ltx_figure">
          <p><span class="ltx_framed"><span class="ltx_p">Shared task instruction and prompt variants.</span></span></p>
          <figcaption><span class="ltx_tag_figure">Figure 4:</span> Verbatim prompt suite.</figcaption>
        </figure></article>`;
        const structuredArtifacts = bindStructuredArtifactsToText(
            parseArxivStructuredArtifactsFromHtml(html, sourceEntry.sourceId, input.id),
            text
        );
        const options = {
            paperId: input.id,
            sourceText: text,
            sourceSha256: sourceEntry.sourceSha256,
            sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
            paperInputSha256: input.paperInputSha256,
            imageInfos: [],
            sourceKind: sourceEntry.source,
            sourceId: sourceEntry.sourceId,
            structuredArtifacts
        };
        const index = buildArtifactIndex(options);
        assert.equal(index.inventoryHealth.status, 'complete');
        assert.equal(index.figures.length, 1);
        assert.equal(index.figures[0].source, 'arxiv_html_dom_inline_figure');
        assert.equal(index.figures[0].url, '');
        assert.equal(index.figures[0].rasterDownloadEligible, false);
        assert.match(index.figures[0].inlineHtmlSha256, /^[a-f0-9]{64}$/);
        assert.ok(index.figures[0].inlineHtmlBytes > 0);
        assert.doesNotThrow(() => validateArtifactIndex(index, options));
    });

    it('跨论文输入身份不符或输出语义被篡改时直接失败', () => {
        const { input, text, sourceEntry, structuredArtifacts } = fixture();
        const options = {
            paperId: input.id, sourceText: text,
            sourceSha256: sourceEntry.sourceSha256,
            sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
            paperInputSha256: input.paperInputSha256,
            imageInfos: sourceEntry.imageInfos,
            sourceKind: sourceEntry.source,
            sourceId: sourceEntry.sourceId,
            structuredArtifacts
        };
        const index = buildArtifactIndex(options);
        assert.throws(
            () => validateArtifactIndex(index, { ...options, paperId: '2608.99999' }),
            /单篇隔离/
        );
        const tampered = structuredClone(index);
        tampered.tables[0].matrix[1][1] = '99.9';
        assert.throws(() => validateArtifactIndex(tampered, options), /output SHA/);
        assert.throws(
            () => buildArtifactIndex({ ...options, sourceSha256: '0'.repeat(64) }),
            /全文字节不一致/
        );
    });

    it('只读重放原格式检查点，不补写缺失产物或改变失败、费用与来源清单', t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
        const { dir, context, input, text, sourceEntry, structuredArtifacts } = f;
        const fullManifestPath = path.join(dir, 'manifest.json');
        writeLegacyFulltextManifestFixture(fullManifestPath, context);
        const historicalBytes = fs.readFileSync(fullManifestPath);
        const { artifactContext, entry, manifest } = savedArtifactFixture(f);
        const retainedBytes = fs.readFileSync(artifactContext.manifestPath);
        assert.deepEqual(loadStructuredArtifactSnapshot(input, sourceEntry), structuredArtifacts);
        assert.deepEqual(readArtifactManifestLocked(artifactContext), manifest);
        const options = { context: artifactContext, input, sourceEntry, sourceText: text };
        assert.equal(isReusableArtifactCheckpoint(entry, options), true);
        assert.equal(isReusableArtifactCheckpoint({ ...entry, status: 'failed' }, options), false);
        assert.equal(isReusableArtifactCheckpoint({ ...entry, sourceIdentitySha256: '0'.repeat(64) }, options), false);
        assert.equal(isReusableArtifactCheckpoint(entry, { ...options, sourceText: text + 'changed' }), false);
        assert.throws(() => readArtifactManifestLocked({ ...artifactContext, date: '2026-08-29' }), /不同 parser 或 filtered/);
        fs.appendFileSync(entry.path, '\n');
        assert.equal(isReusableArtifactCheckpoint(entry, options), false);
        fs.unlinkSync(entry.path);
        assert.equal(isReusableArtifactCheckpoint(entry, options), false);
        assert.equal(fs.existsSync(entry.path), false);
        assert.deepEqual(fs.readFileSync(fullManifestPath), historicalBytes);
        assert.deepEqual(fs.readFileSync(artifactContext.manifestPath), retainedBytes);
        assert.deepEqual(readArtifactManifestLocked(artifactContext).usage, { totalTokens: 19 });
        assert.equal(readArtifactManifestLocked(artifactContext).error, 'retained fixture failure');
    });

    it('快照表格篡改、身份错配与缺失仍拒绝，核验不会修复原文件', t => {
        const f = fixture();
        t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
        const { input, text, sourceEntry } = f;
        const { artifactContext, entry } = savedArtifactFixture(f);
        const options = { context: artifactContext, input, sourceEntry, sourceText: text };
        assert.equal(isReusableArtifactCheckpoint(entry, options), true);
        const pointer = sourceEntry.structuredArtifactsSnapshot;
        const snapshot = JSON.parse(fs.readFileSync(pointer.path, 'utf8'));
        snapshot.structuredArtifacts.tables[0].matrix[2][1] = '99.9';
        const changed = Buffer.from(JSON.stringify(snapshot, null, 2));
        fs.writeFileSync(pointer.path, changed);
        assert.equal(isReusableArtifactCheckpoint(entry, options), false);
        assert.throws(() => loadStructuredArtifactSnapshot(input, sourceEntry), /字节 SHA/);
        assert.deepEqual(fs.readFileSync(pointer.path), changed);
        // Recomputing only the outer file witness cannot bless a changed DOM payload.
        pointer.bytes = changed.length;
        pointer.outputSha256 = crypto.createHash('sha256').update(changed).digest('hex');
        assert.throws(() => loadStructuredArtifactSnapshot(input, sourceEntry), /payload SHA/);
        assert.equal(isReusableArtifactCheckpoint(entry, options), false);
        fs.unlinkSync(pointer.path);
        assert.equal(isReusableArtifactCheckpoint(entry, options), false);
        assert.equal(fs.existsSync(pointer.path), false);
    });

    it('退役写入 API 不再导出，只读核验 API 保持可用', () => {
        const api = require('../scripts/manual-artifact-index.js');
        for (const name of ['initializeArtifactManifestLocked', 'persistStructuredArtifactSnapshot',
            'upsertArtifactManifestPaperLocked', 'ensureArtifactIndexCheckpoint',
            'recordArtifactFailure', 'finalizeArtifactManifestLocked']) assert.equal(Object.hasOwn(api, name), false);
        for (const name of ['loadStructuredArtifactSnapshot', 'validateStructuredArtifacts',
            'validateArtifactIndex', 'readArtifactManifestLocked', 'isReusableArtifactCheckpoint'])
            assert.equal(typeof api[name], 'function');
    });

    it('图注或公式结构无法还原时，把 PDF/文本回退标为不完整', () => {
        const { input, text, sourceEntry } = fixture();
        const pdfText = `${text}\nTable 9: Main results\nSystem WER\nBaseline 4.8\nEq. (3) defines the loss = a + b.`;
        const sourceSha256 = require('node:crypto').createHash('sha256').update(pdfText).digest('hex');
        const structuredArtifacts = bindStructuredArtifactsToText(
            buildUnstructuredTextArtifactSignals(pdfText, 'pdf_text'), pdfText
        );
        assert.doesNotThrow(() => validateStructuredArtifacts(structuredArtifacts));
        const index = buildArtifactIndex({
            paperId: input.id,
            sourceText: pdfText,
            sourceSha256,
            sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
            paperInputSha256: input.paperInputSha256,
            imageInfos: [],
            sourceKind: 'pdf',
            sourceId: input.requestedArxivId,
            structuredArtifacts
        });
        assert.equal(index.inventoryHealth.status, 'incomplete');
        assert.ok(index.inventoryHealth.issues.some(issue => /矩阵|MathML|公式/.test(issue)));
    });
});

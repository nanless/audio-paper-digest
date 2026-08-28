'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    buildManifestContext,
    buildCompleteEntry,
    initializeManifestLocked,
    isReusableStructuredSnapshotForCurrentParser
} = require('../scripts/manual-fetch-fulltext.js');
const {
    ARTIFACT_PARSER_VERSION,
    validateStructuredArtifacts,
    buildArtifactIndex,
    validateArtifactIndex,
    buildArtifactManifestContext,
    initializeArtifactManifestLocked,
    persistStructuredArtifactSnapshot,
    readArtifactManifestLocked,
    ensureArtifactIndexCheckpoint,
    recordArtifactFailure,
    finalizeArtifactManifestLocked,
    isReusableArtifactCheckpoint
} = require('../scripts/manual-artifact-index.js');
const {
    parseArxivStructuredArtifactsFromHtml,
    buildUnstructuredTextArtifactSignals,
    bindStructuredArtifactsToText
} = require('../scripts/deep-analyzer.js');

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
        path.join(__dirname, 'fixtures', 'arxiv-structured-paper.html'), 'utf8'
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

describe('Manual ArtifactIndex v1', () => {
    it('only refetches incomplete v2 HTML after the inline-SVG parser upgrade', () => {
        assert.equal(isReusableStructuredSnapshotForCurrentParser(
            { source: 'html' },
            { parserVersion: 'arxiv-html-dom-v2', health: { status: 'complete' } }
        ), true);
        assert.equal(isReusableStructuredSnapshotForCurrentParser(
            { source: 'html' },
            { parserVersion: 'arxiv-html-dom-v2', health: { status: 'incomplete' } }
        ), false);
        assert.equal(isReusableStructuredSnapshotForCurrentParser(
            { source: 'html' },
            { parserVersion: 'arxiv-html-dom-v3', health: { status: 'incomplete' } }
        ), true);
        assert.equal(isReusableStructuredSnapshotForCurrentParser(
            { source: 'pdf' },
            { parserVersion: 'unstructured-text-signals-v1', health: { status: 'incomplete' } }
        ), true);
    });

    it('builds deterministic, replayable single-paper inventories with longform-compatible projections', () => {
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

    it('fails closed on cross-paper input identity and semantic output tampering', () => {
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

    it('checkpoints beside manifest v2, validates file bytes, and resumes only the failed paper', () => {
        const { dir, context, input, text, sourceEntry, structuredArtifacts } = fixture();
        const fullManifestPath = path.join(dir, 'manifest.json');
        initializeManifestLocked(fullManifestPath, context);
        const historicalBytes = fs.readFileSync(fullManifestPath);

        const artifactContext = buildArtifactManifestContext(context, dir);
        initializeArtifactManifestLocked(artifactContext);
        sourceEntry.structuredArtifactsSnapshot = persistStructuredArtifactSnapshot(
            artifactContext, input, sourceEntry, structuredArtifacts
        );
        let entry = ensureArtifactIndexCheckpoint(artifactContext, input, sourceEntry);
        assert.equal(entry.status, 'complete');
        assert.equal(fs.readFileSync(fullManifestPath).equals(historicalBytes), true);
        assert.equal(isReusableArtifactCheckpoint(entry, {
            context: artifactContext, input, sourceEntry, sourceText: text
        }), true);

        fs.appendFileSync(entry.path, '\n');
        assert.equal(isReusableArtifactCheckpoint(entry, {
            context: artifactContext, input, sourceEntry, sourceText: text
        }), false);
        entry = ensureArtifactIndexCheckpoint(artifactContext, input, sourceEntry);
        assert.equal(isReusableArtifactCheckpoint(entry, {
            context: artifactContext, input, sourceEntry, sourceText: text
        }), true);

        fs.appendFileSync(entry.path, '\n');
        recordArtifactFailure(artifactContext, input, new Error('transient parser failure'));
        assert.equal(readArtifactManifestLocked(artifactContext).papers[input.id].status, 'failed');
        entry = ensureArtifactIndexCheckpoint(artifactContext, input, sourceEntry);
        const finalized = finalizeArtifactManifestLocked(artifactContext, { [input.id]: sourceEntry });
        assert.equal(finalized.status, 'complete');
        assert.equal(finalized.count, 1);
        assert.equal(finalized.failed, 0);
        assert.equal(readArtifactManifestLocked(artifactContext).papers[input.id].outputSha256, entry.outputSha256);
    });

    it('binds reuse to the exact structured source snapshot, not only flattened text', () => {
        const { dir, context, input, text, sourceEntry, structuredArtifacts } = fixture();
        const artifactContext = buildArtifactManifestContext(context, dir);
        initializeArtifactManifestLocked(artifactContext);
        sourceEntry.structuredArtifactsSnapshot = persistStructuredArtifactSnapshot(
            artifactContext, input, sourceEntry, structuredArtifacts
        );
        const entry = ensureArtifactIndexCheckpoint(artifactContext, input, sourceEntry);
        assert.equal(isReusableArtifactCheckpoint(entry, {
            context: artifactContext, input, sourceEntry, sourceText: text
        }), true);
        const snapshot = JSON.parse(fs.readFileSync(sourceEntry.structuredArtifactsSnapshot.path, 'utf8'));
        snapshot.structuredArtifacts.tables[0].matrix[2][1] = '99.9';
        fs.writeFileSync(sourceEntry.structuredArtifactsSnapshot.path, JSON.stringify(snapshot, null, 2));
        assert.equal(isReusableArtifactCheckpoint(entry, {
            context: artifactContext, input, sourceEntry, sourceText: text
        }), false);
    });

    it('marks PDF/text fallback incomplete when captions or formula structure cannot be recovered', () => {
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

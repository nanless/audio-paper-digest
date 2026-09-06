'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const arxiv = require('../scripts/lib/arxiv-source-authority.js');
const history = require('../scripts/lib/historical-arxiv-analysis.js');
const fresh = require('../scripts/lib/fresh-rewrite-run.js');
const authority = require('../scripts/lib/paper-source-authority.js');
const deep = require('../scripts/deep-analyzer.js');
const cli = require('../scripts/historical-arxiv-analysis.js');

const RUN_ID = '77777777-7777-4777-8777-777777777777';
function fixture(t) { const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-analysis-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function source() {
    const text = 'Official full paper methods experiments evidence limitations. '.repeat(250);
    const flattenedTextSha256 = crypto.createHash('sha256').update(text).digest('hex');
    const body = { version: 1, source: 'arxiv_html', tables: [], formulas: [], flattenedTextSha256 };
    return { text, source: 'html', sourceId: '2609.03622v1', imageInfos: [{ url: 'https://arxiv.org/html/2609.03622v1/f1.png', caption: 'Figure 1' }],
        readerAuthors: { authors: [], sourceDomSha256: 'a'.repeat(64) }, htmlAvailability: 'available', htmlAttempts: 1, warnings: [],
        structuredArtifacts: { ...body, payloadSha256: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') } };
}

test('live authority creates an isolated fresh-engine run without old generated fields', async t => {
    const root = fixture(t); const authorityRoot = path.join(root, 'authority'); fs.mkdirSync(authorityRoot);
    const runRoot = path.join(root, 'runs');
    const original = deep.fetchArxivTextDetailed; deep.fetchArxivTextDetailed = async () => source();
    t.after(() => { deep.fetchArxivTextDetailed = original; });
    const prepared = await arxiv.prepareArxivSourceAuthority({ authorityRoot, arxivId: '2609.03622',
        authorityName: 'arxiv-2609.03622.json', apply: true, now: '2026-09-07T00:00:00Z' });
    const metadata = { arxivId: '2609.03622', paper_id: '2609.03622', title: 'Official title',
        abstract: 'Official abstract', authors: ['Author'], categories: ['cs.SD'], source: 'arxiv', sources: ['arxiv'] };
    const proof = { contract: history.METADATA_CONTRACT, paperId: 'arxiv:2609.03622', sourceName: 'data/current/raw-candidates.json',
        fileSha256: 'b'.repeat(64), recordSha256: fresh.stableHash(metadata) };
    const result = history.prepareHistoricalArxivRun({ authorityHandle: prepared.authorityHandle,
        metadata, metadataProof: proof, date: '2026-09-04', rootDir: runRoot, runId: RUN_ID });
    assert.equal(result.canonicalPath, path.join(runRoot, RUN_ID, 'analysis.json'));
    const loaded = fresh.loadRun(RUN_ID, { rootDir: runRoot });
    assert.equal(loaded.run.baseline.contract, history.BASELINE_CONTRACT);
    assert.equal(loaded.run.status, 'sources_ready');
    assert.doesNotMatch(JSON.stringify(loaded.inputs), /OLD_CANONICAL|apiReaderArticle/);
    const cached = JSON.parse(fs.readFileSync(path.join(runRoot, RUN_ID, 'sources', '2609.03622', 'source-details.json'), 'utf8'));
    assert.equal(cached.imageInfos.length, 1);
    const recoveredRun = history.prepareHistoricalArxivRun({ authorityHandle: prepared.authorityHandle,
        metadata, metadataProof: proof, date: '2026-09-04', rootDir: runRoot, runId: RUN_ID });
    assert.equal(recoveredRun.status, 'recovered');
    assert.equal(history.recoverHistoricalArxivRun({ runId: RUN_ID, date: '2026-09-04',
        arxivId: '2609.03622', rootDir: runRoot }).recovered, true);
    const generic = authority.loadAuthorityHandle({ authorityRoot, authorityName: 'arxiv-2609.03622.json' });
    assert.equal(history.verifyHistoricalArxivRunAuthority({ runId: RUN_ID, rootDir: runRoot,
        authorityHandle: prepared.authorityHandle }), true);
    assert.throws(() => history.verifyHistoricalArxivRunAuthority({ runId: RUN_ID, rootDir: runRoot,
        authorityHandle: generic }), /production-authorized/);
    assert.throws(() => history.prepareHistoricalArxivRun({ authorityHandle: generic, metadata,
        metadataProof: proof, date: '2026-09-04', rootDir: runRoot }), /production-authorized/);
});

test('generated or non-source metadata is rejected before creating a run', () => {
    assert.throws(() => history.normalizedMetadata({ arxivId: '2609.03622', title: 'x', abstract: 'y', analysis: 'old' }, '2609.03622'), /old analysis/);
    assert.throws(() => history.normalizedMetadata({ arxivId: '2609.03622', title: 'x', abstract: 'y', score: 9 }, '2609.03622'), /non-source/);
});

test('CLI rejects calendar-invalid dates', () => {
    assert.equal(cli.validDate('2026-09-04'), true);
    assert.equal(cli.validDate('2026-02-30'), false);
    assert.throws(() => cli.parseArgs(['prepare', '--dry-run', '--id', '2609.03622',
        '--date', '2026-02-30', '--authority', 'arxiv-2609.03622.json']), /Use/);
});

test('prepare CLI requires an explicit stable run ID for recovery', () => {
    const args = ['prepare', '--dry-run', '--run-id', RUN_ID, '--id', '2609.03622',
        '--date', '2026-09-04', '--authority', 'arxiv-2609.03622.json'];
    assert.equal(cli.parseArgs(args).runId, RUN_ID);
    assert.throws(() => cli.parseArgs(args.filter((_, index) => ![2, 3].includes(index))), /Use/);
});

test('isolated run executes the fresh analysis callbacks and persists its own canonical', async t => {
    const root = fixture(t); const authorityRoot = path.join(root, 'authority'); fs.mkdirSync(authorityRoot);
    const runRoot = path.join(root, 'runs');
    const original = deep.fetchArxivTextDetailed; deep.fetchArxivTextDetailed = async () => source();
    t.after(() => { deep.fetchArxivTextDetailed = original; });
    const prepared = await arxiv.prepareArxivSourceAuthority({ authorityRoot, arxivId: '2609.03622',
        authorityName: 'arxiv-2609.03622.json', apply: true, now: '2026-09-07T00:00:00Z' });
    const metadata = { arxivId: '2609.03622', paper_id: '2609.03622', title: 'Official title',
        abstract: 'Official abstract', authors: ['Author'], categories: ['cs.SD'], source: 'arxiv', sources: ['arxiv'] };
    const proof = { contract: history.METADATA_CONTRACT, paperId: 'arxiv:2609.03622', sourceName: 'raw-candidates.json',
        fileSha256: 'b'.repeat(64), recordSha256: fresh.stableHash(metadata) };
    history.prepareHistoricalArxivRun({ authorityHandle: prepared.authorityHandle, metadata,
        metadataProof: proof, date: '2026-09-04', rootDir: runRoot, runId: RUN_ID });
    const result = await fresh.analyzeRewrite({ runId: RUN_ID, concurrency: 1 }, {
        rootDir: runRoot,
        readFreshSource: runDir => {
            const sourceDir = path.join(runDir, 'sources', '2609.03622');
            const details = JSON.parse(fs.readFileSync(path.join(sourceDir, 'source-details.json'), 'utf8'));
            const freshSourceDescriptor = JSON.parse(fs.readFileSync(path.join(sourceDir, 'source.json'), 'utf8'));
            return { ...details, freshSourceDescriptor };
        },
        withFreshAnalysisContext: (_identity, callback) => callback(),
        isSuccessfulAnalysisRecord: paper => paper.mockComplete === true,
        analyzeBatch: async (papers, options) => {
            const preparedPaper = await options.preparePaperLocked(papers[0]);
            assert.equal(preparedPaper.skip, false);
            const descriptor = fresh.readRegularJson(path.join(runRoot, RUN_ID, 'sources', '2609.03622', 'source.json')).value;
            const provenance = { contract: fresh.FRESHNESS_CONTRACT, runId: RUN_ID,
                sourceSha256: descriptor.sourceSha256,
                structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
                sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
                sourceOnly: true, oldGeneratedTextIncluded: false };
            const completed = { ...preparedPaper.paper, mockComplete: true, analysis: 'fresh source analysis',
                freshRewriteProvenance: provenance, analysisManifest: { freshRewriteProvenance: provenance } };
            await options.onPaperResultLocked(preparedPaper.paper, { success: true, result: completed });
            return { results: [completed], stats: { success: 1, failed: 0 } };
        }
    });
    assert.equal(result.status, 'complete');
    const canonical = fresh.readRegularJson(path.join(runRoot, RUN_ID, 'analysis.json')).value;
    assert.equal(canonical.status, 'complete');
    assert.equal(canonical.papers[0].analysis, 'fresh source analysis');
    assert.equal(history.recoverHistoricalArxivRun({ runId: RUN_ID, date: '2026-09-04',
        arxivId: '2609.03622', rootDir: runRoot }).sealedComplete, true);
    canonical.papers[0].analysis = 'tampered after seal';
    fs.writeFileSync(path.join(runRoot, RUN_ID, 'analysis.json'), JSON.stringify(canonical));
    assert.throws(() => history.recoverHistoricalArxivRun({ runId: RUN_ID, date: '2026-09-04',
        arxivId: '2609.03622', rootDir: runRoot }), /does not seal/);
});

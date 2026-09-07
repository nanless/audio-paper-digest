'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const direct = require('../scripts/lib/historical-direct-aggregate.js');
const planApi = require('../scripts/lib/historical-direct-rewrite-plan.js');
const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
const conferenceProjections = require('../scripts/lib/historical-conference-page-projections.js');
const engine = require('../scripts/analysis-engine.js');
const { validAnalysisPaper, validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonSha = value => sha(Buffer.from(JSON.stringify(value)));
const pageKey = value => `page:${sha(value)}`;
const DATE = '2026-08-08';
const CONFERENCE = 'icassp-2026';

function write(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, value, { mode: 0o600 });
    return sha(Buffer.isBuffer(value) ? value : Buffer.from(value));
}
function writeJson(filename, value) { return write(filename, `${JSON.stringify(value, null, 2)}\n`); }
function page(root, relative, title, kind, scope, cohortDate) {
    const content = `---\ntitle: ${title}\ndate: ${cohortDate}\n---\nPOISON_OLD_BODY_${title}\n`;
    return { pageId: pageKey(relative), path: relative, primaryUrl: `https://example.test/${path.basename(relative, '.md')}/`,
        contentSha256: write(path.join(root, relative), content), kind, scope, cohortDate,
        identityHints: kind === 'paper' && scope.type === 'daily'
            ? { status: 'single', candidates: [{ scheme: 'arxiv', value: title.replace('arXiv ', ''), sources: ['body:arxiv-link'] }] }
            : { status: 'none', candidates: [] } };
}
function sealedAnalysis(item, sourceDescriptor, sourceDetails) {
    const arxivId = item.route.arxivId || '2608.00001'; const paper = validLegacyApiAnalysisPaper(arxivId);
    const current = validAnalysisPaper(arxivId);
    paper.analysisManifest.stages.taxonomySeal = current.analysisManifest.stages.taxonomySeal;
    paper.analysisManifest.stages.coreSummaryRepair = current.analysisManifest.stages.coreSummaryRepair;
    paper.analysisManifest.contracts.taxonomy = current.analysisManifest.contracts.taxonomy;
    paper.analysisManifest.contracts.coreSummary = current.analysisManifest.contracts.coreSummary;
    for (const field of ['coreSummaryInputAnalysisSha256', 'inputCoreSummarySha256', 'outputCoreSummarySha256']) {
        paper.analysisManifest.stages.scoringAudit[field] = current.analysisManifest.stages.scoringAudit[field];
    }
    const provenance = runner.directProvenanceFor(item, sourceDescriptor);
    paper.directPaperId = item.paperId; paper.title = `Fresh ${item.paperId}`; paper.sourceSha256 = provenance.sourceSha256;
    paper.freshRewriteProvenance = provenance; paper.analysisManifest.freshRewriteProvenance = structuredClone(provenance);
    paper.analysisManifest.sourceAcquisition = { analysisSource: sourceDetails.source, sourceId: sourceDetails.sourceId,
        sourceTextChars: sourceDetails.text.length, usedTextChars: sourceDetails.text.length, fullTextChars: sourceDetails.text.length,
        fullTextAvailable: true, truncated: false, sourceSha256: provenance.sourceSha256, usedTextSha256: provenance.sourceSha256,
        structuredArtifactsSha256: provenance.structuredArtifactsSha256, htmlAttempts: 1, warnings: [] };
    const authorIdentity = paper.apiReaderAuthors.identity;
    authorIdentity.sourceTextSha256 = provenance.sourceSha256; authorIdentity.metadataSha256 = runner.stableHash(paper.authors);
    authorIdentity.authors[0].nameBinding.metadataSha256 = authorIdentity.metadataSha256;
    authorIdentity.authors[0].affiliationBindings[0].sourceTextSha256 = provenance.sourceSha256;
    paper.apiReaderAuthors.sourceDomSha256 = provenance.sourceSha256;
    paper.apiReaderAuthors.identitySha256 = runner.stableHash(authorIdentity);
    paper.apiReaderResources.sourceTextSha256 = provenance.sourceSha256;
    paper.apiReaderResources.identitySha256 = runner.stableHash({ contract: paper.apiReaderResources.contract,
        sourceTextSha256: provenance.sourceSha256, resources: paper.apiReaderResources.resources });
    const readerStage = paper.analysisManifest.stages.apiReaderArticle;
    Object.assign(readerStage, { readerAuthorsSha256: runner.stableHash(paper.apiReaderAuthors),
        readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256, resourceIdentitySha256: paper.apiReaderResources.identitySha256,
        sourceBindingsSourceTextSha256: provenance.sourceSha256, structuredArtifactsSha256: provenance.structuredArtifactsSha256 });
    paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = paper.apiReaderResources.identitySha256;
    assert.equal(engine.apiReaderV3BindsCanonical(paper), true);
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), true);
    return paper;
}
async function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-direct-aggregate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blog = path.join(root, 'blog'); const metadata = path.join(root, 'metadata.json'); const pdf = path.join(root, 'conference.pdf');
    const arxivOne = '2608.00001'; const arxivTwo = '2608.00002';
    const pages = [
        page(blog, 'content/posts/arxiv-one.md', `arXiv ${arxivOne}`, 'paper', { type: 'daily', key: DATE }, DATE),
        page(blog, 'content/posts/arxiv-two.md', `arXiv ${arxivTwo}`, 'paper', { type: 'daily', key: DATE }, DATE),
        page(blog, `content/posts/${DATE}.md`, 'Daily summary', 'daily-summary', { type: 'daily', key: DATE }, DATE),
        page(blog, 'content/posts/conference-paper.md', 'Conference fresh title', 'paper', { type: 'conference', key: CONFERENCE }, DATE),
        page(blog, 'content/posts/icassp-2026.md', 'Conference summary', 'conference-summary', { type: 'conference', key: CONFERENCE }, DATE)
    ];
    const inventory = { counts: {}, ledgerSha256: sha('inventory-ledger'), pageSetSha256: planApi.stableHash(pages), pages };
    const metadataSha = writeJson(metadata, { papers: [{ arnumber: '100', title: 'Conference fresh title' }] });
    const pdfSha = write(pdf, '%PDF-1.4\nconference bytes\n%%EOF\n');
    const catalog = { contract: 'merged-good-historical-local-data-v3', version: 3, entries: [
        { paperId: `arxiv:${arxivOne}`, sources: [{ sourcePath: '/ignored/a', fileSha256: sha('a'), availability: 'old-analysis' }] },
        { paperId: `arxiv:${arxivTwo}`, sources: [{ sourcePath: '/ignored/b', fileSha256: sha('b'), availability: 'old-analysis' }] },
        { paperId: 'conference:icassp:2026:icassp-arnumber:100', sources: [{ sourceSet: 'retained-local', provenance: 'retained-local',
            metadata: { absolutePath: metadata, sha256: metadataSha, recordIndex: 0, metadataIdentityBindingSha256: sha('metadata-binding') },
            pdf: { absolutePath: pdf, sha256: pdfSha, availability: 'available', bytes: fs.statSync(pdf).size } }] }
    ] };
    const catalogSha = jsonSha(catalog);
    const conference = conferenceProjections.buildConferencePageProjections({ catalog, catalogFileSha256: catalogSha, inventory, blogRoot: blog });
    const plan = planApi.buildDirectRewritePlan({ catalog, catalogFileSha256: catalogSha, inventory, conferencePageProjections: conference });
    const projection = direct.buildAggregateProjection({ plan, inventory });
    const paths = { planFile: path.join(root, 'plan.json'), projectionFile: path.join(root, 'aggregate-projection.json'),
        registryRoot: path.join(root, 'registries'), executionRoot: path.join(root, 'executions'), stagingRoot: path.join(root, 'staging'),
        sourceRoot: path.join(root, 'sources'), failureRoot: path.join(root, 'failure-handoffs') };
    writeJson(paths.planFile, plan); writeJson(paths.projectionFile, projection);
    const capture = async ({ arxivId, generation }) => {
        const text = `fresh official text ${arxivId} generation ${generation}`;
        const pdfBytes = Buffer.from(`%PDF-1.4\n${arxivId}/${generation}\n%%EOF\n`);
        const structuredArtifacts = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha(text) };
        structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
        return { arxivId, generation, sourceManifestSha256: sha(`manifest:${arxivId}:${generation}`), text,
            runtimeDetails: { paperId: `arxiv:${arxivId}`, source: 'html', sourceId: arxivId, text, imageInfos: [],
                structuredArtifacts,
                htmlAvailability: 'available', htmlAttempts: 1, warnings: [] },
            manifest: { text: { responseSha256: sha(text), source: 'html', sourceId: arxivId },
                pdf: { responseSha256: sha(pdfBytes) } } };
    };
    const analyze = async ({ item, sourceDescriptor, sourceDetails }) => sealedAnalysis(item, sourceDescriptor, sourceDetails);
    const options = { apply: true, plan, registryRoot: paths.registryRoot, executionRoot: paths.executionRoot,
        stagingRoot: paths.stagingRoot, freshArxivSourceRoot: paths.sourceRoot, freshArxivFailureHandoffRoot: paths.failureRoot, concurrency: 3 };
    const deps = { captureFreshArxivRewriteSource: capture, analyze, extractPdfText: async () => 'fresh conference source text '.repeat(10),
        materializeConferenceFigures: async () => [], rendererImplementationSha256: () => sha('direct-mock-renderer-v1'),
        renderDirectPage: packet => ({ markdown: `---\ndate: ${packet.cohortDate}\n---\n${packet.paper.apiReaderArticle}`, assets: [] }) };
    const first = await runner.runDirectRewrite({ ...options, arxivGeneration: 1 }, deps);
    assert.equal(first.status, 'complete', JSON.stringify(first.results));
    const second = await runner.runDirectRewrite({ ...options, queue: 'arxiv', arxivGeneration: 2 }, deps);
    assert.equal(second.status, 'complete', JSON.stringify(second.results));
    return { root, plan, projection, paths, firstRegistry: first.registryFile, secondRegistry: second.registryFile };
}
function inputs(f, registryFile = f.firstRegistry) {
    return direct.loadDirectAggregateInputs({ planFile: f.paths.planFile, registryFile, projectionFile: f.paths.projectionFile,
        stagingRoot: f.paths.stagingRoot, executionRoot: f.paths.executionRoot });
}
function writeRegistry(filename, registry) { writeJson(filename, registry); }
function rebasedRegistry(registry, entries) {
    const body = { contract: registry.contract, version: registry.version, planSha256: registry.planSha256,
        createdAt: registry.createdAt, entries };
    return { ...body, registrySha256: runner.stableHash(body) };
}

test('direct aggregate accepts a complete daily cohort and produces source-generation-bound markdown', async t => {
    const f = await fixture(t); const [aggregate] = direct.buildDirectAggregates({ inputs: inputs(f), daily: DATE });
    assert.equal(aggregate.scope, 'daily'); assert.equal(aggregate.key, DATE);
    assert.equal(aggregate.members.length, 2);
    assert.deepEqual(aggregate.members.map(item => item.paperId), ['arxiv:2608.00001', 'arxiv:2608.00002']);
    assert.equal(aggregate.source.sourceGeneration.generation, 1);
    assert.match(aggregate.markdown, /FRESH_READER|source-only/);
    assert.doesNotMatch(JSON.stringify(aggregate), /POISON_OLD_BODY/);
    const output = direct.writeDirectAggregates({ outputRoot: path.join(f.root, 'aggregates'),
        aggregateRunId: direct.aggregateRunIdFor([aggregate]), aggregates: [aggregate] });
    assert.equal(output.length, 1); assert.equal(fs.statSync(output[0].filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(output[0].pageFilename).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(output[0].pageFilename, 'utf8'), /\[Fresh arxiv:2608\.00001\]\(\/arxiv-one\/\)/);
});

test('direct aggregate rejects a partial daily cohort', async t => {
    const f = await fixture(t); const registry = JSON.parse(fs.readFileSync(f.firstRegistry, 'utf8'));
    const entries = registry.entries.map(entry => entry.paperId === 'arxiv:2608.00002'
        ? { ...entry, status: 'failed' } : entry);
    const filename = path.join(f.root, 'partial-registry.json'); writeRegistry(filename, rebasedRegistry(registry, entries));
    assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f, filename), daily: DATE }), /not staged; aggregate requires complete cohort staging/);
});

test('direct aggregate rejects a daily cohort mixed across arXiv source generations', async t => {
    const f = await fixture(t); const first = JSON.parse(fs.readFileSync(f.firstRegistry, 'utf8'));
    const second = JSON.parse(fs.readFileSync(f.secondRegistry, 'utf8'));
    const upgraded = second.entries.find(entry => entry.paperId === 'arxiv:2608.00002');
    const entries = first.entries.map(entry => entry.paperId === upgraded.paperId ? upgraded : entry);
    const filename = path.join(f.root, 'mixed-registry.json'); writeRegistry(filename, rebasedRegistry(first, entries));
    assert.throws(() => direct.buildDirectAggregates({ inputs: inputs(f, filename), daily: DATE }), /mixed arXiv source generations/);
});

test('direct aggregate rejects a projection that omits a planned cohort', async t => {
    const f = await fixture(t); const projection = JSON.parse(fs.readFileSync(f.paths.projectionFile, 'utf8'));
    projection.daily = [];
    projection.dailySetSha256 = direct.stableHash(projection.daily);
    const body = { ...projection }; delete body.projectionSha256;
    projection.projectionSha256 = direct.stableHash(body);
    const filename = path.join(f.root, 'incomplete-projection.json'); writeJson(filename, projection);
    assert.throws(() => direct.loadDirectAggregateInputs({ planFile: f.paths.planFile, registryFile: f.firstRegistry,
        projectionFile: filename, stagingRoot: f.paths.stagingRoot, executionRoot: f.paths.executionRoot }), /cohort coverage/);
});

test('direct aggregate creates a complete retained-local conference aggregate', async t => {
    const f = await fixture(t); const [aggregate] = direct.buildDirectAggregates({ inputs: inputs(f), conference: CONFERENCE });
    assert.equal(aggregate.scope, 'conference'); assert.equal(aggregate.key, CONFERENCE);
    assert.equal(aggregate.members.length, 1);
    assert.equal(aggregate.members[0].paperId, 'conference:icassp:2026:icassp-arnumber:100');
    assert.equal(aggregate.source.sourceGeneration.contract, 'retained-local-conference-pdf-v1');
    assert.equal(aggregate.source.sourceGeneration.generation, null);
});

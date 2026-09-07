'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const catalog = require('../scripts/lib/historical-direct-rewrite-input-catalog.js');
const conferenceSources = require('../scripts/lib/historical-conference-local-sources.js');
const inputsCli = require('../scripts/historical-direct-rewrite-inputs.js');
const projectionsCli = require('../scripts/historical-conference-page-projections.js');
const planCli = require('../scripts/historical-direct-rewrite-plan.js');
const projectionApi = require('../scripts/lib/historical-conference-page-projections.js');
const planApi = require('../scripts/lib/historical-direct-rewrite-plan.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pdf = () => Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
function write(filename, value) { fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 }); return filename; }
function pageId(value) { return `page:${sha(value)}`; }
function frontmatter(title) { return Buffer.from(`---\ntitle: ${JSON.stringify(title)}\ndate: 2026-05-01\n---\nThis historical body must never be a direct-input source.\n`, 'utf8'); }

test('a title-different author prior preprint remains auditable but is never direct-routable', () => {
    assert.equal(catalog.directEligibleConferenceSource({ pdf: { availability: 'available',
        acquisition: { versionRelation: catalog.BLOCKED_CROSS_VERSION_RELATION } } }), false);
    assert.equal(catalog.directEligibleConferenceSource({ pdf: { availability: 'available',
        acquisition: { versionRelation: 'same-paper-versioned-official-preprint' } } }), true);
});

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-input-v5-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blog = path.join(root, 'blog'); const sourceDir = path.join(root, 'sources'); fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
    const records = [
        { sourceSet: 'workspace-icassp-2026', provenance: 'retained-local-crawler', conference: { slug: 'icassp', year: 2026 }, scheme: 'icassp-arnumber', idFields: ['arnumber'], shape: 'array', records: [{ arnumber: '100', title: 'ICASSP Local Paper' }] },
        { sourceSet: 'workspace-iclr-2026', provenance: 'retained-local-crawler', conference: { slug: 'iclr', year: 2026 }, scheme: 'openreview-forum-id', idFields: ['forum_id'], shape: 'array', records: [{ forum_id: 'Qwerty_1', title: 'ICLR Workspace Paper' }] },
        { sourceSet: 'workspace-icml-2026', provenance: 'retained-local-crawler', conference: { slug: 'icml', year: 2026 }, scheme: 'openreview-forum-id', idFields: ['id'], shape: 'array', records: [{ id: 'AbCdef_12', title: 'ICML Local Paper' }] },
        { sourceSet: 'accepted-local-iclr-2026', provenance: 'retained-local-accepted-crawler', conference: { slug: 'iclr', year: 2026 }, scheme: 'openreview-forum-id', idFields: ['forum_id'], shape: 'array', records: [
            { forum_id: 'Qwerty_1', title: 'ICLR Workspace Paper' },
            { forum_id: 'q05hC1Pzkr', title: 'ICLR Sole Accepted Exception' },
            { forum_id: 'Unrelated_1', title: 'Unrelated Accepted Corpus Paper' }
        ] }
    ];
    const sourceSets = records.map(spec => {
        const metadataPath = path.join(sourceDir, `${spec.sourceSet}.json`); write(metadataPath, spec.records);
        const pdfPaths = new Map();
        for (const record of spec.records) {
            const id = record.arnumber || record.forum_id || record.id;
            const filename = path.join(sourceDir, `${spec.sourceSet}-${id}.pdf`); fs.writeFileSync(filename, pdf(), { mode: 0o600 }); pdfPaths.set(id, filename);
        }
        return { ...spec, metadataPath, pdfPath: (_record, externalId) => pdfPaths.get(externalId.value) };
    });
    const posterPdfRoot = path.join(root, 'poster-pdfs'); const freshPdfRoot = path.join(root, 'fresh-pdfs');
    const openreviewReceiptRoot = path.join(root, 'openreview-receipts');
    const alternateReceiptRoot = path.join(root, 'alternate-receipts');
    for (const directory of [posterPdfRoot, freshPdfRoot, openreviewReceiptRoot, alternateReceiptRoot]) {
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    const posterSnapshot = write(path.join(root, 'poster-snapshot.json'), { count: 1, next: null, previous: null, results: [{
        id: 60946, name: 'Unrelated Poster Source', decision: 'Accept (regular)', eventtype: 'Poster', event_type: 'Poster',
        visible: true, virtualsite_url: '/virtual/2026/poster/60946',
        paper_url: 'https://openreview.net/forum?id=Poster_1',
        sourceurl: 'https://openreview.net/group?id=ICML.cc/2026/Conference'
    }] });
    fs.writeFileSync(path.join(posterPdfRoot, 'Poster_1.pdf'), pdf(), { mode: 0o600 });
    const conference = conferenceSources.buildLocalSourcesManifest({ sourceSets,
        icmlPosterSnapshotFile: posterSnapshot, icmlPdfRoot: posterPdfRoot,
        icmlFreshPdfRoot: freshPdfRoot, openreviewReceiptRoot, alternateReceiptRoot });
    const conferenceManifest = write(path.join(root, 'conference-local-sources.json'), conference);
    const pages = [];
    const addPage = ({ name, title, scope, identityHints = { status: 'none', candidates: [] } }) => {
        const relative = `content/posts/${name}.md`; const bytes = frontmatter(title); const filename = path.join(blog, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); fs.writeFileSync(filename, bytes, { mode: 0o600 });
        pages.push({ pageId: pageId(name), kind: 'paper', path: relative, primaryUrl: `https://example.test/${name}/`, contentSha256: sha(bytes),
            scope, cohortDate: '2026-05-01', identityHints });
    };
    addPage({ name: 'arxiv', title: 'ArXiv projected page', scope: { type: 'daily', key: '2026-05-01' }, identityHints: { status: 'single', candidates: [{ scheme: 'arxiv', value: '2601.00001', sources: ['body:arxiv-link'] }] } });
    addPage({ name: 'arxiv-duplicate', title: 'ArXiv duplicate page', scope: { type: 'daily', key: '2026-05-02' }, identityHints: { status: 'single', candidates: [{ scheme: 'arxiv', value: '2601.00001', sources: ['body:arxiv-link'] }] } });
    addPage({ name: 'icassp', title: 'ICASSP Local Paper', scope: { type: 'conference', key: 'icassp-2026' } });
    addPage({ name: 'iclr-one', title: 'ICLR Workspace Paper', scope: { type: 'conference', key: 'iclr-2026' } });
    addPage({ name: 'iclr-two', title: 'ICLR Workspace Paper', scope: { type: 'conference', key: 'iclr-2026' } });
    addPage({ name: 'iclr-exception', title: 'ICLR Sole Accepted Exception', scope: { type: 'conference', key: 'iclr-2026' } });
    addPage({ name: 'icml', title: 'ICML Local Paper', scope: { type: 'conference', key: 'icml-2026' } });
    const inventory = { counts: {}, pages, pageSetSha256: sha('page set'), ledgerSha256: sha('ledger') };
    const inventoryFile = write(path.join(root, 'inventory.json'), inventory);
    return { root, blog, conferenceManifest, inventoryFile, inventory, catalogRoot: path.join(root, 'catalogs'), projectionRoot: path.join(root, 'projections'), planRoot: path.join(root, 'plans'), reportRoot: path.join(root, 'unprojected') };
}

function inputArgs(f, mode = '--dry-run') {
    return [mode, '--conference-manifest', f.conferenceManifest, '--inventory', f.inventoryFile,
        '--blog-root', f.blog, '--name', 'scoped-historical-local-data-v5.json'];
}

test('scoped v5 builder derives fresh arXiv identities from frozen evidence and retains only exact local conference records', t => {
    const f = fixture(t); const value = catalog.buildScopedCatalog({ conferenceManifest: f.conferenceManifest, inventoryFile: f.inventoryFile, blogRoot: f.blog });
    assert.equal(value.contract, 'merged-good-historical-local-data-v5');
    assert.deepEqual(value.summary, { arxivPapers: 1, arxivPages: 2, singleArxivPages: 2,
        dailyPrimaryArxivBindings: 0, dailyIcmlPosterBindings: 0, dailyIcmlPosterRoutableBindings: 0,
        conferencePapers: 4, canonicalRecords: 5, sourceRecords: 4,
        conferenceSourceSets: { 'accepted-local-iclr-2026': 1, 'workspace-icassp-2026': 1, 'workspace-iclr-2026': 1, 'workspace-icml-2026': 1 } });
    assert.equal(value.scopeBinding.conferencePageCount, 5);
    assert.equal(value.scopeBinding.arxivPageCount, 2);
    assert.deepEqual(value.entries.find(entry => entry.paperId === 'arxiv:2601.00001').sources, []);
    assert.equal(value.entries.some(entry => entry.paperId.endsWith('Unrelated_1')), false);
    assert.equal(value.entries.find(entry => entry.paperId.endsWith('Qwerty_1')).sources[0].sourceSet, 'workspace-iclr-2026');
    assert.equal(value.entries.find(entry => entry.paperId.endsWith('q05hC1Pzkr')).sources[0].sourceSet, 'accepted-local-iclr-2026');
    assert.doesNotMatch(JSON.stringify(value), /historical body must never/i);
    assert.doesNotMatch(JSON.stringify(value), /Unrelated Accepted Corpus Paper/);
    assert.deepEqual(catalog.normalizeCatalog(value), value);
});

test('CLI produces a scoped v5 catalog and its projection-to-plan dry-run succeeds', t => {
    const f = fixture(t); const parsed = inputsCli.parseArgs(inputArgs(f));
    assert.equal(parsed.apply, false); assert.equal(parsed.name, 'scoped-historical-local-data-v5.json');
    const written = inputsCli.main(inputArgs(f, '--apply'), { files: { historicalDirectRewriteInputCatalogDir: f.catalogRoot } });
    assert.equal(written.status, 'created'); assert.equal(written.filename, path.join(f.catalogRoot, 'scoped-historical-local-data-v5.json'));
    const second = inputsCli.main(inputArgs(f, '--apply'), { files: { historicalDirectRewriteInputCatalogDir: f.catalogRoot } });
    assert.equal(second.status, 'recovered');
    const projection = projectionsCli.main(['--dry-run', '--catalog', written.filename, '--inventory', f.inventoryFile], {
        files: { historicalConferencePageProjectionDir: f.projectionRoot }, blogRoot: f.blog
    });
    assert.deepEqual({ projections: projection.projections, projectedPages: projection.projectedPages, unmatchedPages: projection.unmatchedPages }, { projections: 4, projectedPages: 5, unmatchedPages: 0 });
    const projectionArtifact = require('../scripts/lib/historical-conference-page-projections.js').buildFromFiles({ catalogFile: written.filename, inventoryFile: f.inventoryFile, blogRoot: f.blog });
    const projectionFile = path.join(f.projectionRoot, 'conference-page-projections-v3.json');
    require('../scripts/lib/historical-conference-page-projections.js').writeProjectionArtifact({ root: f.projectionRoot, outputName: 'conference-page-projections-v3.json', artifact: projectionArtifact });
    const plan = planCli.main(['--dry-run', '--catalog', written.filename, '--inventory', f.inventoryFile, '--conference-projections', projectionFile], {
        files: { historicalDirectRewritePlanDir: f.planRoot, historicalDirectRewriteUnprojectedReportDir: f.reportRoot }
    });
    assert.deepEqual({ arxiv: plan.arxivFreshFetch, conference: plan.conferenceLocalPdf, canonicals: plan.canonicalPapers, pages: plan.projectedPages, unprojected: plan.unprojectedCatalogEntries }, { arxiv: 1, conference: 4, canonicals: 5, pages: 7, unprojected: 0 });
    assert.deepEqual({ frozen: plan.frozenPaperPages, uncovered: plan.uncoveredFrozenPaperPages,
        complete: plan.paperPageCoverageComplete }, { frozen: 7, uncovered: 0, complete: true });
});

test('CLI rejects the removed arXiv-manifest prerequisite and incomplete scope', t => {
    const f = fixture(t);
    assert.throws(() => inputsCli.parseArgs(['--dry-run', '--arxiv-manifest', '/tmp/old.json', '--conference-manifest', f.conferenceManifest, '--inventory', f.inventoryFile, '--blog-root', f.blog]), /Use/);
    assert.throws(() => inputsCli.parseArgs(['--dry-run', '--conference-manifest', f.conferenceManifest, '--inventory', f.inventoryFile]), /Use/);
});

test('projection and plan reject legacy v3/v4 and malformed v5 bytes through the producer strict validator', t => {
    const f = fixture(t);
    const current = catalog.buildScopedCatalog({ conferenceManifest: f.conferenceManifest,
        inventoryFile: f.inventoryFile, blogRoot: f.blog });
    const legacyV3 = { contract: 'merged-good-historical-local-data-v3', version: 3,
        scope: current.scope, inputs: current.inputs, summary: current.summary, entries: current.entries };
    assert.throws(() => projectionApi.normalizeCatalog(legacyV3), /current scoped v5 local source catalog/);
    assert.throws(() => planApi.normalizeCatalog(legacyV3), /current scoped v5 local source catalog/);
    const legacyV4 = structuredClone(current); legacyV4.contract = 'merged-good-historical-local-data-v4'; legacyV4.version = 4;
    assert.throws(() => projectionApi.normalizeCatalog(legacyV4), /current scoped v5 local source catalog/);
    assert.throws(() => planApi.normalizeCatalog(legacyV4), /current scoped v5 local source catalog/);
    const cases = [
        value => { delete value.scopeBinding; },
        value => { value.inputs.unshift({ path: '/tmp/legacy-arxiv-good-data.json',
            sha256: sha('legacy arxiv input'), selectedPapers: 1 }); },
        value => { value.entries.find(entry => entry.paperId === 'arxiv:2601.00001').sources = [{
            sourcePath: 'data/current/papers.json', fileSha256: sha('legacy retained arxiv prose'),
            availability: 'crawler-full-text-record', provenance: 'legacy-local-crawler'
        }]; }
    ];
    for (const mutate of cases) {
        const legacy = structuredClone(current); mutate(legacy);
        assert.throws(() => projectionApi.normalizeCatalog(legacy), /current scoped v5 local source catalog/);
        assert.throws(() => planApi.normalizeCatalog(legacy), /current scoped v5 local source catalog/);
    }
});

test('catalog seals qualified multiple-hint primary arXiv bindings and merges their IDs without local writer sources', t => {
    const f = fixture(t); const relative = 'content/posts/multiple-primary.md';
    const bytes = Buffer.from('---\ntitle: "Multiple primary"\ndate: 2026-05-03\n---\n\n# Multiple primary\n\n'
        + '✅ **7.0/10** | 前50% | #语音识别 | [arxiv](https://arxiv.org/abs/2605.28508v1)\n\n'
        + 'Reference only: https://openreview.net/forum?id=D0LuQNZfEl\nPOISON_OLD_BODY\n');
    fs.mkdirSync(path.dirname(path.join(f.blog, relative)), { recursive: true });
    fs.writeFileSync(path.join(f.blog, relative), bytes, { mode: 0o600 });
    f.inventory.pages.push({ pageId: pageId(relative), kind: 'paper', path: relative,
        primaryUrl: 'https://example.test/multiple-primary/', contentSha256: sha(bytes),
        scope: { type: 'daily', key: '2026-05-03' }, cohortDate: '2026-05-03', identityHints: {
            status: 'multiple', candidates: [
                { scheme: 'arxiv', value: '2605.28508', sources: ['body:arxiv-link'] },
                { scheme: 'openreview-forum-id', value: 'D0LuQNZfEl', sources: ['body:openreview-link'] }
            ] } });
    fs.writeFileSync(f.inventoryFile, JSON.stringify(f.inventory), { mode: 0o600 });
    const value = catalog.buildScopedCatalog({ conferenceManifest: f.conferenceManifest,
        inventoryFile: f.inventoryFile, blogRoot: f.blog });
    assert.equal(value.contract, 'merged-good-historical-local-data-v5');
    assert.equal(value.dailyPrimaryArxivBindings.length, 1);
    assert.equal(value.summary.dailyPrimaryArxivBindings, 1);
    assert.equal(value.scopeBinding.dailyPrimaryArxivBindingCount, 1);
    assert.equal(value.summary.arxivPages, 3);
    assert.deepEqual(value.entries.find(entry => entry.paperId === 'arxiv:2605.28508').sources, []);
    assert.equal(JSON.stringify(value).includes('POISON_OLD_BODY'), false);
    assert.deepEqual(catalog.normalizeCatalog(value), value);
});

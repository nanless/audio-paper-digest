'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
const freshArxiv = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const freshContext = require('../scripts/lib/fresh-analysis-context.js');
const inputsCli = require('../scripts/historical-direct-rewrite-inputs.js');
const planCli = require('../scripts/historical-direct-rewrite-plan.js');
const catalogApi = require('../scripts/lib/historical-direct-rewrite-input-catalog.js');
const planApi = require('../scripts/lib/historical-direct-rewrite-plan.js');
const outdatedAudit = require('../scripts/historical-outdated-audit.js');
const aggregateApi = require('../scripts/lib/historical-direct-aggregate.js');
const aggregateCli = require('../scripts/historical-direct-aggregate.js');
const pubApi = require('../scripts/lib/historical-direct-publication.js');
const pubCli = require('../scripts/historical-direct-publication.js');
const verifyWeb = require('../scripts/verify-web.js');
const confPost = require('../scripts/lib/conference-postprocess.js');
const confProcess = require('../scripts/lib/conference-process.js');
const confExt = require('../scripts/lib/official-conference-acquisition-extended.js');
const podcastPublisher = require('../scripts/publish-daily-podcast.js');
const podcastRelease = require('../scripts/lib/podcast-github-release.js');
const codec = require('../scripts/lib/protocol-codec');
const { validAnalysisPaper, validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pageKey = value => `page:${sha(value)}`;

function makeTmpDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// =========================================================================
// Bug #1: requiresHistoricalPdfScope includes conferencePdfAuthorParser
// =========================================================================
test('R5-1: requiresHistoricalPdfScope 识别 conference-pdf-author-pdf-page1 与 v3', () => {
    assert.equal(runner.requiresHistoricalPdfScope({
        apiReaderAuthors: { identity: { conferencePdfAuthorParser: 'conference-pdf-author-pdf-page1' } }
    }), true);
    assert.equal(runner.requiresHistoricalPdfScope({
        apiReaderAuthors: { identity: { conferencePdfAuthorParser: 'conference-pdf-author-pdf-page1-v3' } }
    }), true);
    assert.equal(runner.requiresHistoricalPdfScope({
        apiReaderAuthors: { identity: { conferencePdfAuthorParser: 'conference-pdf-author-lines-v2' } }
    }), false);
    assert.equal(runner.requiresHistoricalPdfScope({}), false);
});

// =========================================================================
// Bug #2: replayCompletedAnalysisForStaging & replayDirectPageStaging bind verified bundle author source
// =========================================================================
test('R5-2: replayCompletedAnalysisForStaging 与 replayHistoricalReaderPdfSourceForStaging 绑定封存作者来源', async t => {
    const root = makeTmpDir(t, 'r5-replay-author-');
    const sourceRoot = path.join(root, 'sources');
    const execRoot = path.join(root, 'exec');
    const arxivId = '2608.00011';
    const paperId = `arxiv:${arxivId}`;
    const bodyText = [
        'Test Paper Title',
        'Abstract',
        'We evaluate speech recognition on LibriSpeech and reduce WER from 10.2% to 9.8%.' .repeat(8),
        '1 Introduction',
        'Detailed technical content for verified bundle author source replay. '.repeat(20)
    ].join('\n');
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    const captured = await freshArxiv.captureFreshArxivRewriteSource({
        rootDir: sourceRoot,
        arxivId,
        generation: 1
    }, {
        fetchText: async id => ({
            text: bodyText,
            source: 'html',
            sourceId: id,
            url: `https://arxiv.org/html/${id}`,
            fetchedAt: '2026-09-07T00:00:01.000Z'
        }),
        fetchPdf: async id => ({
            bytes: pdfBytes,
            url: `https://arxiv.org/pdf/${id}.pdf`,
            fetchedAt: '2026-09-07T00:00:02.000Z'
        })
    });
    const stored = freshArxiv.readFreshArxivRewriteSource({ rootDir: sourceRoot, arxivId, generation: 1 });
    stored.paperId = paperId;
    const item = {
        paperId,
        runId: '11111111-1111-4111-8111-111111111111',
        route: {
            kind: 'arxiv-fresh-fetch',
            arxivId,
            writerInputs: [],
            freshFetch: { authority: 'official-arxiv', requiredArtifacts: ['text', 'pdf'], persistArtifacts: ['text', 'pdf'], imagePersistence: 'ephemeral-only' },
            failurePolicy: { kind: 'crosswalk-arxiv-fresh-fetch-failure-only', crosswalkPrerequisite: false, historicalLinkUse: 'only-after-fresh-fetch-failure' }
        },
        pageKeys: [pageKey('content/posts/p.md')],
        pages: [{
            pageKey: pageKey('content/posts/p.md'),
            pagePath: 'content/posts/p.md',
            primaryUrl: 'https://example.test/p/',
            cohortDate: '2026-08-08',
            scope: { type: 'daily', key: '2026-08-08' },
            pageContentSha256: sha('p'),
            mapping: 'frozen-single-arxiv-identity-hint',
            historicalArxivLink: { arxivId, canonicalUrl: `https://arxiv.org/abs/${arxivId}`, hintSources: ['body:arxiv-link'] }
        }]
    };
    const sourceBinding = planApi.normalizeFreshArxivSourceBinding(item, {
        ...codec.recordHeader(planApi.FRESH_ARXIV_SOURCE_CONTRACT, 'fresh-arxiv-rewrite-source'),
        paperId,
        arxivId,
        generation: 1,
        sourceManifestSha256: stored.sourceManifestSha256,
        textSha256: stored.manifest.text.responseSha256,
        pdfSha256: stored.manifest.pdf.responseSha256
    });
    const sourceRunIdentitySha256 = planApi.directSourceRunIdentity(item, sourceBinding);
    const snapshot = runner.stableHash({
        paperId,
        source: stored.runtimeDetails.source,
        sourceId: stored.runtimeDetails.sourceId,
        textSha256: sha(stored.runtimeDetails.text),
        structuredArtifacts: stored.runtimeDetails.structuredArtifacts
    });
    const descriptor = {
        kind: 'arxiv-fresh-fetch',
        paperId,
        generation: 1,
        sourceId: stored.runtimeDetails.sourceId,
        textSha256: stored.manifest.text.responseSha256,
        structuredArtifactsSha256: stored.runtimeDetails.structuredArtifacts.payloadSha256,
        pdfSha256: stored.manifest.pdf.responseSha256,
        sourceManifestSha256: stored.sourceManifestSha256,
        sourceBinding,
        sourceRunIdentitySha256,
        sourceSnapshotSha256: snapshot
    };

    // replayHistoricalReaderPdfSourceForStaging should bind verified bundle author source
    const replayed = runner.replayHistoricalReaderPdfSourceForStaging({
        plan: { planSha256: sha('plan'), queue: [item] },
        item,
        sourceDescriptor: descriptor,
        executionRoot: execRoot,
        freshArxivSourceRoot: sourceRoot
    });
    assert.equal(freshContext.hasVerifiedBundleAuthorSource(replayed.sourceDetails), true);

    // replayCompletedAnalysisForStaging should bind verified bundle author source before assertDirectAnalysisReadyForStaging
    const paper = validLegacyApiAnalysisPaper(arxivId);
    const current = validAnalysisPaper(arxivId);
    paper.analysisManifest.stages.taxonomySeal = current.analysisManifest.stages.taxonomySeal;
    paper.analysisManifest.stages.coreSummaryRepair = current.analysisManifest.stages.coreSummaryRepair;
    paper.analysisManifest.contracts.taxonomy = current.analysisManifest.contracts.taxonomy;
    paper.analysisManifest.contracts.coreSummary = current.analysisManifest.contracts.coreSummary;
    for (const field of ['coreSummaryInputAnalysisSha256', 'inputCoreSummarySha256', 'outputCoreSummarySha256']) {
        paper.analysisManifest.stages.scoringAudit[field] = current.analysisManifest.stages.scoringAudit[field];
    }
    const provenance = runner.buildDirectSourceRecord(item, descriptor);
    paper.directPaperId = paperId;
    paper.title = 'Fresh Paper';
    paper.sourceSha256 = provenance.sourceSha256;
    paper.freshRewriteProvenance = provenance;
    paper.analysisManifest.freshRewriteProvenance = structuredClone(provenance);
    paper.analysisManifest.sourceAcquisition = {
        analysisSource: stored.runtimeDetails.source,
        sourceId: stored.runtimeDetails.sourceId,
        sourceTextChars: stored.runtimeDetails.text.length,
        usedTextChars: stored.runtimeDetails.text.length,
        fullTextChars: stored.runtimeDetails.text.length,
        fullTextAvailable: true,
        truncated: false,
        sourceSha256: provenance.sourceSha256,
        usedTextSha256: provenance.sourceSha256,
        structuredArtifactsSha256: provenance.structuredArtifactsSha256,
        htmlAttempts: 1,
        warnings: []
    };
    const authorIdentity = paper.apiReaderAuthors.identity;
    authorIdentity.sourceTextSha256 = provenance.sourceSha256;
    authorIdentity.metadataSha256 = runner.stableHash(paper.authors);
    authorIdentity.authors[0].nameBinding.metadataSha256 = authorIdentity.metadataSha256;
    authorIdentity.authors[0].affiliationBindings[0].sourceTextSha256 = provenance.sourceSha256;
    paper.apiReaderAuthors.sourceDomSha256 = provenance.sourceSha256;
    paper.apiReaderAuthors.identitySha256 = runner.stableHash(authorIdentity);
    paper.apiReaderResources.sourceTextSha256 = provenance.sourceSha256;
    paper.apiReaderResources.identitySha256 = runner.stableHash({
        contract: paper.apiReaderResources.contract,
        sourceTextSha256: provenance.sourceSha256,
        resources: paper.apiReaderResources.resources
    });
    Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
        readerAuthorsSha256: runner.stableHash(paper.apiReaderAuthors),
        readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
        resourceIdentitySha256: paper.apiReaderResources.identitySha256,
        sourceBindingsSourceTextSha256: provenance.sourceSha256,
        structuredArtifactsSha256: provenance.structuredArtifactsSha256
    });
    paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = paper.apiReaderResources.identitySha256;

    const execDir = path.join(execRoot, item.runId, sourceRunIdentitySha256);
    fs.mkdirSync(execDir, { recursive: true, mode: 0o700 });
    const analysisBytes = Buffer.from(`${JSON.stringify(paper, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(execDir, 'analysis.json'), analysisBytes, { mode: 0o600 });
    const active = {
        source: descriptor,
        analysis: {
            directory: execDir,
            analysisFileSha256: sha(analysisBytes),
            analysisRecordSha256: runner.stableHash(paper),
            sourceSnapshotSha256: descriptor.sourceSnapshotSha256
        }
    };
    const completed = await runner.replayCompletedAnalysisForStaging({
        plan: { planSha256: sha('plan'), queue: [item] },
        item,
        active,
        generation: 1,
        executionRoot: execRoot,
        freshArxivSourceRoot: sourceRoot,
        readFreshArxivSource: args => freshArxiv.readFreshArxivRewriteSource(args)
    });
    assert.equal(freshContext.hasVerifiedBundleAuthorSource(completed.sourceDetails), true);
    assert.ok(captured.sourceManifestSha256);
});

// =========================================================================
// Bug #3: --arxiv-only mode in CLI parsers and buildDirectRewritePlan
// =========================================================================
test('R5-3: --arxiv-only 模式贯通 inputs CLI、plan CLI 与混合清单上的 buildDirectRewritePlan', t => {
    // 1) inputs CLI parser
    const parsedArxivOnly = inputsCli.parseArgs([
        '--apply', '--arxiv-only',
        '--inventory', '/tmp/inventory.json',
        '--blog-root', '/tmp/blog',
        '--name', 'scoped-arxiv.json'
    ]);
    assert.equal(parsedArxivOnly.apply, true);
    assert.equal(parsedArxivOnly.arxivOnly, true);
    assert.equal(parsedArxivOnly.conferenceManifest, null);
    assert.equal(parsedArxivOnly.inventoryFile, path.resolve('/tmp/inventory.json'));
    assert.equal(parsedArxivOnly.blogRoot, path.resolve('/tmp/blog'));

    assert.throws(() => inputsCli.parseArgs([
        '--apply', '--arxiv-only',
        '--conference-manifest', '/tmp/conf.json',
        '--inventory', '/tmp/inventory.json',
        '--blog-root', '/tmp/blog'
    ]), /Use /);
    assert.throws(() => inputsCli.parseArgs([
        '--apply',
        '--inventory', '/tmp/inventory.json',
        '--blog-root', '/tmp/blog'
    ]), /Use /);

    // 2) plan CLI parser makes --conference-projections optional
    const parsedPlan = planCli.parseArgs([
        '--apply',
        '--catalog', '/tmp/cat.json',
        '--inventory', '/tmp/inv.json'
    ]);
    assert.equal(parsedPlan.apply, true);
    assert.equal(parsedPlan.conferenceProjectionFile, null);
    const parsedPlanWithConf = planCli.parseArgs([
        '--dry-run',
        '--catalog', '/tmp/cat.json',
        '--inventory', '/tmp/inv.json',
        '--conference-projections', '/tmp/proj.json'
    ]);
    assert.equal(parsedPlanWithConf.conferenceProjectionFile, path.resolve('/tmp/proj.json'));

    // 3) buildDirectRewritePlan on a MIXED inventory (daily + conference pages) in arxiv-only mode
    const root = makeTmpDir(t, 'r5-arxiv-only-mixed-');
    const blog = path.join(root, 'blog');
    const writePage = (rel, title, body) => {
        const full = path.join(blog, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
        const bytes = Buffer.from(`---\ntitle: ${title}\ndate: 2026-01-01\n---\n${body}\n`);
        fs.writeFileSync(full, bytes, { mode: 0o600 });
        return sha(bytes);
    };
    const dailyRel = 'content/posts/2026-01-01-daily-paper.md';
    const confRel = 'content/posts/icassp2026-paper-1.md';
    const confWithArxivRel = 'content/posts/icassp2026-paper-2.md';
    const pages = [
        {
            pageId: pageKey(dailyRel),
            path: dailyRel,
            contentSha256: writePage(dailyRel, 'Daily Paper', '[arXiv](https://arxiv.org/abs/2601.00001)'),
            primaryUrl: 'https://example.test/daily-1/',
            cohortDate: '2026-01-01',
            kind: 'paper',
            scope: { type: 'daily', key: '2026-01-01' },
            identityHints: { status: 'single', candidates: [{ scheme: 'arxiv', value: '2601.00001', sources: ['body:arxiv-link'] }] }
        },
        {
            pageId: pageKey(confRel),
            path: confRel,
            contentSha256: writePage(confRel, 'Conference Paper', 'Conference text'),
            primaryUrl: 'https://example.test/conf-1/',
            cohortDate: '2026-05-01',
            kind: 'paper',
            scope: { type: 'conference', key: 'icassp-2026' },
            identityHints: { status: 'none', candidates: [] }
        },
        {
            pageId: pageKey(confWithArxivRel),
            path: confWithArxivRel,
            contentSha256: writePage(confWithArxivRel, 'Conference Paper With Arxiv Hint', '[arXiv](https://arxiv.org/abs/2601.00001)'),
            primaryUrl: 'https://example.test/conf-2/',
            cohortDate: '2026-05-01',
            kind: 'paper',
            scope: { type: 'conference', key: 'icassp-2026' },
            identityHints: { status: 'single', candidates: [{ scheme: 'arxiv', value: '2601.00001', sources: ['body:arxiv-link'] }] }
        }
    ];
    const inventory = { counts: { pages: 3, papers: 3 }, ledgerSha256: sha('ledger'), pageSetSha256: catalogApi.stableHash(pages), pages };
    const inventoryFile = path.join(root, 'inventory.json');
    fs.writeFileSync(inventoryFile, JSON.stringify(inventory, null, 2), { mode: 0o600 });

    const written = catalogApi.buildAndWrite({
        apply: true,
        arxivOnly: true,
        conferenceManifest: null,
        inventoryFile,
        blogRoot: blog,
        name: 'scoped-arxiv.json'
    }, { files: { historicalDirectRewriteInputCatalogDir: path.join(root, 'catalogs') } });

    const plan = planApi.buildFromFiles({
        catalogFile: written.filename,
        inventoryFile,
        conferenceProjectionFile: null,
        blogRoot: blog
    });
    assert.equal(plan.queue.length, 1);
    assert.equal(plan.queue[0].paperId, 'arxiv:2601.00001');
    assert.equal(plan.projectedPages.length, 1);
    assert.equal(plan.projectedPages[0].scope.type, 'daily');
    assert.equal(plan.uncoveredFrozenPaperPages.length, 2);
    assert.ok(plan.uncoveredFrozenPaperPages.every(p => p.scope.type === 'conference'));
    assert.deepEqual(planApi.normalizePlan(plan), plan);
});

// =========================================================================
// Bug #4: historical-outdated-audit.js (3 bugs)
// =========================================================================
test('R5-4: historical-outdated-audit 拒绝 type-aware-v1 误放行、修复 5 处推荐命令、正确分类会议页与汇总页', t => {
    const blogRepo = makeTmpDir(t, 'r5-outdated-audit-');
    const standards = outdatedAudit.currentStandards();
    const writePost = (name, content) => {
        const full = path.join(blogRepo, 'content', 'posts', name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
    };

    // (a) Explicit type-aware-v1 with prose mentioning "type-aware" MUST NOT false-pass
    writePost('2026-04-01-v1-prose.md', [
        '---',
        'title: "V1 Paper With Prose"',
        'date: 2026-04-01',
        'draft: false',
        'categories: [论文速递]',
        'paper_digest_page_type: paper',
        'paper_digest_arxiv_id: "2604.00001"',
        `paper_digest_api_reader_contract: "${standards.readerContract}"`,
        `paper_digest_api_reader_schema_fingerprint: "${standards.readerSchemaFingerprint}"`,
        'paper_digest_scoring_rubric_version: "type-aware-v1"',
        'paper_digest_scoring_contract: "type-aware-v1"',
        `paper_digest_tags_registry_sha256: "${standards.tagsRegistrySha256}"`,
        'paper_digest_reader_sections:',
        '  - id: s1',
        '---',
        '',
        '本文提出一种 type-aware 声学模型。',
        ''
    ].join('\n'));

    // (b) Missing rubricVersion with contract "type-aware-v1" and prose "type-aware" MUST fail
    writePost('2026-04-01-no-version-prose.md', [
        '---',
        'title: "No Version Paper"',
        'date: 2026-04-01',
        'draft: false',
        'categories: [论文速递]',
        'paper_digest_page_type: paper',
        'paper_digest_arxiv_id: "2604.00002"',
        `paper_digest_api_reader_contract: "${standards.readerContract}"`,
        `paper_digest_api_reader_schema_fingerprint: "${standards.readerSchemaFingerprint}"`,
        'paper_digest_scoring_contract: "type-aware-v1"',
        `paper_digest_tags_registry_sha256: "${standards.tagsRegistrySha256}"`,
        'paper_digest_reader_sections:',
        '  - id: s1',
        '---',
        '',
        'This method introduces a type-aware attention block.',
        ''
    ].join('\n'));

    // (c) Missing rubricVersion with anchored body line "评分规则：type-aware" passes
    writePost('2026-04-01-anchored-body.md', [
        '---',
        'title: "Anchored Body Rubric"',
        'date: 2026-04-01',
        'draft: false',
        'categories: [论文速递]',
        'paper_digest_page_type: paper',
        'paper_digest_arxiv_id: "2604.00003"',
        `paper_digest_api_reader_contract: "${standards.readerContract}"`,
        `paper_digest_api_reader_schema_fingerprint: "${standards.readerSchemaFingerprint}"`,
        `paper_digest_tags_registry_sha256: "${standards.tagsRegistrySha256}"`,
        'paper_digest_reader_sections:',
        '  - id: s1',
        '---',
        '',
        '- 评分规则：type-aware',
        ''
    ].join('\n'));

    // (d) Conference pages & summaries
    writePost('conference-waspaa-2025.md', '---\ntitle: "WASPAA 2025"\ndate: 2025-10-01\npaper_digest_page_type: conference\n---\n# old\n');
    writePost('icassp2026-summary.md', '---\ntitle: "ICASSP 2026"\ndate: 2026-05-01\n---\n# old\n');
    writePost('iclr2026-task-asr.md', '---\ntitle: "ICLR Task"\ndate: 2026-05-01\n---\n# old\n');
    writePost('conference-waspaa-2025-paper-99.md', '---\ntitle: "WASPAA Paper"\ndate: 2025-10-01\npaper_digest_page_type: paper\n---\n# old\n');

    // (e) Non-YYYY-MM-DD index page in daily scope MUST NOT mark 2026-04-01 as completeDay
    writePost('2026-04-01-custom-index.md', '---\ntitle: "Custom Index"\ndate: 2026-04-01\npaper_digest_page_type: index\n---\n# old\n');

    const report = outdatedAudit.auditBlogPosts({ blogRepo, standards });
    const byPath = new Map(report.outdatedPages.map(p => [p.path, p]));
    assert.ok(byPath.get('content/posts/2026-04-01-v1-prose.md')?.reasons.includes('missing-type-aware-rubric'));
    assert.ok(byPath.get('content/posts/2026-04-01-no-version-prose.md')?.reasons.includes('missing-type-aware-rubric'));
    assert.equal(byPath.has('content/posts/2026-04-01-anchored-body.md'), false);

    assert.equal(byPath.get('content/posts/conference-waspaa-2025.md')?.scope, 'conference');
    assert.equal(byPath.get('content/posts/conference-waspaa-2025.md')?.kind, 'summary');
    assert.equal(byPath.get('content/posts/icassp2026-summary.md')?.scope, 'conference');
    assert.equal(byPath.get('content/posts/icassp2026-summary.md')?.kind, 'summary');
    assert.equal(byPath.get('content/posts/iclr2026-task-asr.md')?.scope, 'conference');
    assert.equal(byPath.get('content/posts/iclr2026-task-asr.md')?.kind, 'summary');
    assert.equal(byPath.get('content/posts/conference-waspaa-2025-paper-99.md')?.scope, 'conference');
    assert.equal(byPath.get('content/posts/conference-waspaa-2025-paper-99.md')?.kind, 'paper');

    // 2026-04-01 has no 2026-04-01.md, so completeDay MUST be false
    const cohort = report.dateCohorts.find(c => c.date === '2026-04-01');
    assert.ok(cohort);
    assert.equal(cohort.completeDay, false);

    // Check recommended CLI commands match actual CLI parsers!
    const dailySteps = report.recommendedCommands[0].steps;
    const confSteps = report.recommendedCommands[1].steps;
    assert.ok(dailySteps[0].includes('--ledger') && dailySteps[0].includes('--receipt'));
    assert.ok(dailySteps[1].includes('--blog-root'));
    assert.ok(dailySteps[5].includes('aggregate --apply --plan-file') && dailySteps[5].includes('--registry-file') && dailySteps[5].includes('--projection-file'));
    assert.ok(dailySteps[6].includes('--paper-ids') && dailySteps[7].includes('--paper-ids'));
    assert.ok(confSteps[0].includes('--ledger') && confSteps[0].includes('--receipt'));
    assert.ok(confSteps[1].includes('--blog-root'));
    assert.ok(confSteps[2].includes('--conference-projections ') && !confSteps[2].includes('--conference-projection '));

    // Verify concrete substituted commands actually parse cleanly with the real CLI parsers!
    const subst = cmd => cmd
        .replace('<INVENTORY_JSON>', '/tmp/inv.json')
        .replace('<BLOG_REPO>', '/tmp/blog')
        .replace('<CATALOG_JSON>', '/tmp/cat.json')
        .replace('<CONFERENCE_MANIFEST_JSON>', '/tmp/conf.json')
        .replace('<PROJECTION_JSON>', '/tmp/proj.json')
        .replace('<PLAN_JSON>', '/tmp/plan.json')
        .replace('<REGISTRY_JSON>', '/tmp/reg.json')
        .replace('<UUID>', '12345678-1234-4123-8123-123456789abc')
        .replace('<YYYY-MM-DD>', '2026-04-01')
        .split(' -- ')[1]
        .trim()
        .split(/\s+/);
    assert.doesNotThrow(() => inputsCli.parseArgs(subst(dailySteps[1])));
    assert.doesNotThrow(() => inputsCli.parseArgs(subst(confSteps[1])));
    assert.doesNotThrow(() => planCli.parseArgs(subst(dailySteps[2])));
    assert.doesNotThrow(() => planCli.parseArgs(subst(confSteps[2])));
    assert.doesNotThrow(() => aggregateCli.parseArgs(subst(dailySteps[5])));
    assert.doesNotThrow(() => pubCli.parseArgs(subst(dailySteps[6])));
    assert.doesNotThrow(() => pubCli.parseArgs(subst(dailySteps[7])));
});

// =========================================================================
// Bug #6: historical-direct-aggregate.js Spotlight rubric & $ escaping
// =========================================================================
test('R5-6: historical-direct-aggregate 精选焦点按分制比例排序且不泄漏裸 $ 数学', () => {
    const rules = require('../scripts/lib/tag-rules.js').getDefaultTagRules();
    const paper = validLegacyApiAnalysisPaper('2608.00001');
    paper.sourceSha256 = sha('r5-6-source');
    paper.apiReaderPlan.oneSentenceThesis = '我们在成本 $50 内把指标 $E = mc^2$ 提升至 $100 档位。';
    const legacyMember = {
        rank: 1,
        item: { paperId: 'arxiv:2608.00001', route: { kind: 'arxiv-fresh-fetch', arxivId: '2608.00001' } },
        source: {},
        sourceText: 'r5-6-source',
        renderedPages: [{ primaryUrl: 'https://example.test/p1/' }],
        canonical: {
            analysis: paper,
            labels: ['语音识别', 'Transformer', '鲁棒性'],
            primaryTaskLabel: '语音识别',
            primaryMethodLabel: 'Transformer',
            tagMetadata: { selectionContract: rules.selectionContract, registryVersion: rules.registryVersion, registrySha256: rules.registrySha256 },
            readerTitle: '低成本 $5 语音识别与 $10 评测',
            title: 'Speech $5 and $10 Model',
            score: 7.5,
            scoringRubricVersion: 'type-aware-v1',
            scoreDimensions: [
                { label: '创新性', value: 1.5, max: 2 },
                { label: '技术严谨性', value: 1.0, max: 1.5 },
                { label: '实验充分性', value: 1.0, max: 1.5 },
                { label: '清晰度', value: 1, max: 1 },
                { label: '影响力', value: 1.5, max: 1.5 },
                { label: '开源', value: 0.5, max: 1.5 },
                { label: '可复现性', value: 0.5, max: 0.5 },
                { label: '工程/实践价值', value: 0.5, max: 1.5 }
            ],
            authors: [{ name: 'Alice', affiliations: ['Lab $A'] }],
            resources: [],
            rankBucket: '前30%',
            documentType: '方法研究',
            summary: '摘要文本'
        }
    };
    const md = aggregateApi.renderAggregate('daily', '2026-10-15', [legacyMember]);
    // Legacy rubric spotlight sorts by ratio then max: 影响力 1.5/1.5 (1.0, max 1.5), 清晰度 1/1 (1.0, max 1), 可复现性 0.5/0.5 (1.0, max 0.5)
    assert.match(md, /突出维度：影响力 1\.5\/1\.5 · 清晰度 1\/1 · 可复现性 0\.5\/0\.5/);
    assert.doesNotMatch(md, /突出维度：.*\/10/);
    // Escaped currency dollars in titles/authors; no fake TeX spanning between $5 and $10
    assert.match(md, /低成本 \\\$5 语音识别与 \\\$10 评测/);
    assert.match(md, /Lab \\\$A/);
    // Body has no unescaped bare $
    const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
    assert.doesNotMatch(body, /(?<!\\)\$/);
});

// =========================================================================
// Bug #7: verify-web OID binding, fail-closed status, code-block links, missing HTML gate
// =========================================================================
test('R5-7: verify-web 历史 OID 绑定与祖先同字节证明、status fail-closed、代码块链接与缺失汇总门禁', async t => {
    const dir = makeTmpDir(t, 'r5-pub-web-');
    const pubRoot = path.join(dir, 'publications');
    const blogRepo = path.join(dir, 'blog');
    const pubId = '12345678-1234-4123-8123-123456789abc';
    const txDir = path.join(pubRoot, pubId);
    fs.mkdirSync(path.join(blogRepo, 'content', 'posts'), { recursive: true });
    fs.mkdirSync(txDir, { recursive: true });

    const pageBytes = Buffer.from('---\ntitle: "P1"\n---\nhello\n');
    fs.writeFileSync(path.join(blogRepo, 'content/posts/2026-08-08-p1.md'), pageBytes);
    const git = args => execFileSync('git', ['-C', blogRepo, ...args], { encoding: 'utf8' }).trim();
    git(['init']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Test']);
    git(['add', '.']);
    git(['commit', '--no-gpg-sign', '-m', 'base publish']);
    const publishOid = git(['rev-parse', 'HEAD']);

    // Descendant commit touching unrelated file (reviewed page bytes identical)
    fs.writeFileSync(path.join(blogRepo, 'README.md'), 'unrelated\n');
    git(['add', 'README.md']);
    git(['commit', '--no-gpg-sign', '-m', 'unrelated change']);
    const descendantSameOid = git(['rev-parse', 'HEAD']);

    // Descendant commit mutating reviewed page bytes
    fs.writeFileSync(path.join(blogRepo, 'content/posts/2026-08-08-p1.md'), '---\ntitle: "P1"\n---\ntampered\n');
    git(['add', 'content/posts/2026-08-08-p1.md']);
    git(['commit', '--no-gpg-sign', '-m', 'tamper page']);
    const descendantTamperedOid = git(['rev-parse', 'HEAD']);

    const plan = {
        publicationId: pubId,
        planSha256: sha('plan-r5-7'),
        files: [{ path: 'content/posts/2026-08-08-p1.md', operation: 'modify', sha256: sha(pageBytes) }]
    };
    fs.writeFileSync(path.join(txDir, 'plan.json'), JSON.stringify(plan));

    // (a) Missing publication.json + --deploy MUST fail closed
    const errsNoPub = [];
    const codeNoPub = await verifyWeb.runVerifyWebCli([
        '--historical-publication-id', pubId, '--publication-root', pubRoot, '--deploy', publishOid
    ], {
        blogRepo,
        env: { PAPER_DIGEST_BLOG_URL: 'https://nanless.github.io/audio-research-portal/posts' },
        print: () => {},
        printError: line => errsNoPub.push(line)
    });
    assert.equal(codeNoPub, 2);
    assert.match(errsNoPub.join('\n'), /缺少远端发布凭证 OID/);

    // Write publication.json
    fs.writeFileSync(path.join(txDir, 'publication.json'), JSON.stringify({
        publicationId: pubId,
        publicationCommit: publishOid,
        remoteVerifiedOid: publishOid
    }));

    // (b) Unrelated --deploy OID MUST fail
    assert.throws(() => verifyWeb.verifyHistoricalDeployOidBinding({
        deployOid: 'b'.repeat(40), recordedOid: publishOid, plan, blogRepo
    }), /不是历史发布提交/);

    // (c) Descendant with identical reviewed page bytes passes
    assert.equal(verifyWeb.verifyHistoricalDeployOidBinding({
        deployOid: descendantSameOid, recordedOid: publishOid, plan, blogRepo
    }), descendantSameOid);

    // (d) Descendant with tampered reviewed page bytes fails
    assert.throws(() => verifyWeb.verifyHistoricalDeployOidBinding({
        deployOid: descendantTamperedOid, recordedOid: publishOid, plan, blogRepo
    }), /修改了历史发布已审页面字节/);

    // (e) deterministicReview ignores layers[i](x) inside code blocks, still rejects unsafe links in prose
    const identity = `paper_digest_tags_registry_sha256: ${sha('a')}\npaper_digest_tags_registry_version: paper-tag-catalog\n`;
    const codeBlockMd = Buffer.from(
        `---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_tags_contract: "paper-tag-flat-tags"\n${identity}draft: false\n---\n\n`
        + '```python\ny = layers[i](x)\n```\n\nInline `ops[0](z)` ok and [safe](/posts/a/).\n'
    );
    const detPass = pubApi.deterministicReview(
        { path: 'content/posts/2026-08-08-code.md', sha256: sha(codeBlockMd), producers: [] },
        codeBlockMd
    );
    assert.equal(detPass.gate, 'deterministic-pass');

    const badLinkMd = Buffer.from(
        `---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_tags_contract: "paper-tag-flat-tags"\n${identity}draft: false\n---\n\n`
        + '[bad](javascript:alert(1))\n'
    );
    assert.throws(() => pubApi.deterministicReview(
        { path: 'content/posts/2026-08-08-bad.md', sha256: sha(badLinkMd), producers: [] },
        badLinkMd
    ), /不安全或非规范链接/);

    // (f) runHugoRenderedHtmlGate flags missing rendered aggregate page (0 candidates) instead of silent pass
    const gateRoot = makeTmpDir(t, 'r5-hugo-gate-missing-');
    const sourceDir = path.join(gateRoot, 'site');
    const publicDir = path.join(gateRoot, 'public');
    fs.mkdirSync(path.join(sourceDir, 'content', 'posts'), { recursive: true });
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(
        path.join(sourceDir, 'content/posts/2026-08-08.md'),
        '---\ntitle: "音频研究日报 2026-08-08"\ndate: 2026-08-08\npaper_digest_page_type: index\n---\n\n# 音频研究日报 2026-08-08\n'
    );
    const gateIssues = pubApi.runHugoRenderedHtmlGate({
        publicDir,
        sourceDir,
        modifiedMarkdownPaths: ['content/posts/2026-08-08.md']
    });
    assert.ok(gateIssues.length >= 1, '缺失渲染 HTML 页面必须产生阻断错误');
    assert.match(gateIssues[0], /未找到唯一渲染 HTML 页面/);

    // (g) historical-direct-publication status() fails closed when unpublished, missing remoteVerifiedOid, or missing/wrong planSha256
    const statusRoot = makeTmpDir(t, 'r5-pub-status-');
    const outRoot = path.join(statusRoot, 'out');
    const stBlog = path.join(statusRoot, 'blog');
    fs.mkdirSync(path.join(stBlog, 'content', 'posts'), { recursive: true });
    fs.mkdirSync(outRoot, { recursive: true });
    const now = '2026-11-27T00:00:00.000Z';
    const basePage = Buffer.from(`---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_tags_contract: "paper-tag-flat-tags"\n${identity}draft: false\n---\nold\n`);
    const nextPage = Buffer.from(`---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_tags_contract: "paper-tag-flat-tags"\n${identity}draft: false\n---\nnew\n`);
    fs.writeFileSync(path.join(stBlog, 'content/posts/2026-01-01-paper.md'), basePage);
    const planStub = { planSha256: sha('2') };
    const artifacts = [{
        path: 'content/posts/2026-01-01-paper.md',
        sha256: sha(nextPage),
        baselineSha256: sha(basePage),
        producers: [{ kind: 'fixture' }],
        source: { kind: 'fixture' }
    }];
    const pageCoverage = {
        inventoryPageCount: 1, coveredPageCount: 1, paperPageCount: 1,
        aggregatePageCount: 0, conferenceTaskPageCount: 0, retainedUnchangedPageCount: 0,
        uncoveredPageKeys: [], coveredPageSetSha256: sha('cov'), publicationReady: true
    };
    const projection = {
        retainedPageSetSha256: pubApi.stableHash([]),
        pageCoverageSha256: pubApi.stableHash(pageCoverage),
        pageCoverage
    };
    const proofBody = {
        fixture: true,
        plan: { planSha256: planStub.planSha256 },
        retainedDisposition: {
            retainedPageSetSha256: projection.retainedPageSetSha256,
            pageCoverageSha256: projection.pageCoverageSha256,
            pageCoverage,
            retainedCount: 0,
            rewrittenPageCount: 1
        },
        artifactSetSha256: pubApi.stableHash(artifacts)
    };
    const authority = {
        plan: planStub,
        artifacts,
        proof: { ...proofBody, proofSha256: pubApi.stableHash(proofBody) },
        projection,
        retainedPages: [],
        visualDisposition: pubApi.buildStandingWaiveVisualDisposition({ plan: planStub }),
        roots: {}
    };
    const statusDeps = {
        loadAuthority: () => authority,
        blogState: () => ({
            head: 'a'.repeat(40), treeOid: 'b'.repeat(40), contentTreeOid: 'c'.repeat(40),
            branch: 'main', clean: true, remoteName: 'origin',
            remoteIdentitySha256: sha('rem'), remoteOid: 'a'.repeat(40),
            hugoConfig: { path: 'hugo.yaml', sha256: sha('hugo') }
        }),
        gitBlob: () => basePage,
        worktreeSha: (_repo, rel) => fs.existsSync(path.join(stBlog, rel)) ? sha(fs.readFileSync(path.join(stBlog, rel))) : null,
        sourceBytes: () => nextPage,
        hugoVersion: 'hugo v0.test',
        validatePublishedTagCatalog: () => ({ valid: true }),
        hugoGate: () => ({ status: 'passed', engine: 'fixture', version: 'hugo v0.test' }),
        semanticReview: ({ loadedPlan, generation, protocol }) => {
            const page = { path: 'content/posts/2026-01-01-paper.md', sha256: sha(nextPage), textChunks: 1, imageCount: 0, imageReviewMode: 'not-required', passed: true, issues: [] };
            page.resultSha256 = pubApi.stableHash(page);
            const body = { ...codec.recordHeader('historical-direct-semantic-review', 'historical-direct-semantic-review'),
                publicationId: loadedPlan.plan.publicationId, generationSha256: generation.manifest.generationSha256,
                reviewProtocolFingerprint: protocol, semanticProtocol: pubApi.semanticReviewProtocol(),
                results: [page], resultSetSha256: pubApi.stableHash([page]), passed: true };
            return { receipt: { ...body, semanticReviewSha256: pubApi.stableHash(body) }, fileSha256: sha('sem') };
        },
        validateActivatedWorktree: () => true,
        now: () => now,
        publishGit: () => 'f'.repeat(40),
        prePublishRemote: () => ({ branch: 'main', localHead: 'a'.repeat(40), remoteIdentitySha256: sha('rem'), remoteOid: 'a'.repeat(40) }),
        pushAndVerify: () => ({ remoteName: 'origin', remoteIdentitySha256: sha('rem'), remoteVerifiedOid: 'f'.repeat(40) }),
        liveRemote: () => ({ remoteIdentitySha256: sha('rem'), remoteOid: 'f'.repeat(40) })
    };
    const stPlan = pubApi.buildPlan({ publicationId: pubId, authorityOptions: {}, blogRepo: stBlog, createdAt: now }, statusDeps);
    pubApi.writePlan({ outputRoot: outRoot, plan: stPlan });
    // Pre-plant online-verification.json BEFORE publish -> must fail closed!
    const onlineFile = path.join(outRoot, pubId, 'online-verification.json');
    fs.writeFileSync(onlineFile, JSON.stringify({
        publicationId: pubId, planSha256: stPlan.planSha256, remoteVerifiedOid: 'f'.repeat(40),
        pagesDeployVerified: true, webVerified: true, checked: 1, ok: 1, failed: 0, verifiedAt: now
    }));
    const unpublishedStatus = pubApi.status({ outputRoot: outRoot, publicationId: pubId, blogRepo: stBlog, liveRemote: false }, statusDeps);
    assert.equal(unpublishedStatus.pagesDeployVerified, false);
    assert.equal(unpublishedStatus.webVerified, false);

    // Finish publish, then test missing planSha256 and wrong planSha256 and missing remoteVerifiedOid
    pubApi.generate({ outputRoot: outRoot, publicationId: pubId, authorityOptions: {}, blogRepo: stBlog, apply: true }, statusDeps);
    pubApi.review({ outputRoot: outRoot, publicationId: pubId, blogRepo: stBlog, apply: true }, statusDeps);
    pubApi.activate({ outputRoot: outRoot, publicationId: pubId, blogRepo: stBlog, apply: true }, statusDeps);
    pubApi.publish({ outputRoot: outRoot, publicationId: pubId, blogRepo: stBlog, apply: true }, statusDeps);

    for (const badPayload of [
        { publicationId: pubId, remoteVerifiedOid: 'f'.repeat(40), pagesDeployVerified: true, webVerified: true }, // missing planSha256
        { publicationId: pubId, planSha256: '0'.repeat(64), remoteVerifiedOid: 'f'.repeat(40), pagesDeployVerified: true, webVerified: true }, // wrong planSha256
        { publicationId: pubId, planSha256: stPlan.planSha256, pagesDeployVerified: true, webVerified: true } // missing remoteVerifiedOid
    ]) {
        fs.writeFileSync(onlineFile, JSON.stringify(badPayload));
        const st = pubApi.status({ outputRoot: outRoot, publicationId: pubId, blogRepo: stBlog, liveRemote: true }, statusDeps);
        assert.equal(st.pagesDeployVerified, false);
        assert.equal(st.webVerified, false);
    }
    fs.writeFileSync(onlineFile, JSON.stringify({
        publicationId: pubId, planSha256: stPlan.planSha256, remoteVerifiedOid: 'f'.repeat(40),
        pagesDeployVerified: true, webVerified: true, checked: 1, ok: 1, failed: 0, verifiedAt: now
    }));
    const okStatus = pubApi.status({ outputRoot: outRoot, publicationId: pubId, blogRepo: stBlog, liveRemote: true }, statusDeps);
    assert.equal(okStatus.pagesDeployVerified, true);
    assert.equal(okStatus.webVerified, true);
});

// =========================================================================
// Bug #10: conference-postprocess.js compactLabel & $ escaping
// =========================================================================
test('R5-10: conference-postprocess 截断不误删 ASCII 字符且转义字面 $ 防伪公式', () => {
    // Verify via source behavior on compactLabel/md through a direct check of exported repair + md behavior
    const src = fs.readFileSync(require.resolve('../scripts/lib/conference-postprocess.js'), 'utf8');
    assert.doesNotMatch(src, /\(-【/, '字符类中的连字符必须转义，不能形成 (-【 区间');
    assert.match(src, /\(\\-【/);
    // Dollar math + currency protection: two currency titles must NOT form inline TeX
    const combined = confPost.repairFormulaDelimiters(
        confPost.repairDollarMath(
            confPost.repairCurrencyDollars('Paper A costs $10 and Paper B costs $20 while $x + y = z$.')
        )
    );
    assert.match(combined, /\\\$10 and Paper B costs \\\$20/);
    assert.match(combined, /\\\(x \+ y = z\\\)/);
});

// =========================================================================
// Bug #11: conference-process.js PD_CONFERENCE_EXTRACTOR_PROFILE/VERSION parity
// =========================================================================
test('R5-11: conference-process 与 Python conference-extract 对环境变量校验一致', t => {
    const root = makeTmpDir(t, 'r5-conf-proc-');
    const prevProfile = process.env.PD_CONFERENCE_EXTRACTOR_PROFILE;
    const prevVersion = process.env.PD_CONFERENCE_EXTRACTOR_VERSION;
    t.after(() => {
        if (prevProfile === undefined) delete process.env.PD_CONFERENCE_EXTRACTOR_PROFILE;
        else process.env.PD_CONFERENCE_EXTRACTOR_PROFILE = prevProfile;
        if (prevVersion === undefined) delete process.env.PD_CONFERENCE_EXTRACTOR_VERSION;
        else process.env.PD_CONFERENCE_EXTRACTOR_VERSION = prevVersion;
    });

    // Check source logic directly by invoking sealOneSource indirectly via prepareShared with a stale receipt
    const src = fs.readFileSync(require.resolve('../scripts/lib/conference-process.js'), 'utf8');
    assert.match(src, /unsupported PD_CONFERENCE_EXTRACTOR_PROFILE/);
    assert.match(src, /unsupported PD_CONFERENCE_EXTRACTOR_VERSION/);

    // Live behavioral verification with a minimal mocked context where previousReceipt triggers upgrade branch
    const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF\n');
    const pdfFile = path.join(root, 'paper.pdf');
    fs.writeFileSync(pdfFile, pdfBytes, { mode: 0o600 });
    const pdfSha = sha(pdfBytes);
    const stagingSourceDir = path.join(root, 'staging-sources');
    fs.mkdirSync(stagingSourceDir, { recursive: true, mode: 0o700 });
    const paperId = 'conference:icassp:2026:icassp-arnumber:9001';
    const authoritySha = sha('auth');
    const stem = `paper-${sha(paperId).slice(0, 24)}-${authoritySha.slice(0, 12)}`;
    // Write a stale previous receipt so the upgrade branch executes!
    fs.writeFileSync(path.join(stagingSourceDir, `${stem}-extraction-receipt.json`), JSON.stringify({
        contract: 'old-stale-receipt',
        receiptSha256: sha('old')
    }), { mode: 0o600 });

    const runWithEnv = (profile, version) => {
        if (profile === undefined) delete process.env.PD_CONFERENCE_EXTRACTOR_PROFILE;
        else process.env.PD_CONFERENCE_EXTRACTOR_PROFILE = profile;
        if (version === undefined) delete process.env.PD_CONFERENCE_EXTRACTOR_VERSION;
        else process.env.PD_CONFERENCE_EXTRACTOR_VERSION = version;
        const context = {
            authority: { conferenceId: 'icassp-2026', implementationSha256: authoritySha },
            discovery: { candidateManifest: { pdfRoot: root, conference: { id: 'icassp-2026', year: 2026 } }, catalogSha256: sha('cat') },
            discoveryHandle: {},
            selection: { selectionReceiptSha256: sha('sel') },
            selectionHandle: {},
            members: [{ paperId, sourceIdentity: 'id-1' }],
            files: { conferenceStagingSourceDir: stagingSourceDir }
        };
        const sentinel = new Error('SENTINEL_REACHED_EXTRACT');
        const deps = {
            discovery: {
                MAX_PDF_BYTES: 1024 * 1024,
                replayDiscoveryMember: () => ({
                    metadataRecord: { title: 'T', recordUrl: 'https://example.org/r', pdfUrl: 'https://example.org/p.pdf' },
                    conference: { id: 'icassp-2026', year: 2026 },
                    identity: { type: 'icassp-arnumber', value: '9001' },
                    match: { candidates: [{ path: 'paper.pdf', sha256: pdfSha }] },
                    catalogSha256: sha('cat'),
                    metadataSnapshotSha256: sha('snap'),
                    metadataIndex: 0,
                    metadataRecordSha256: sha('rec')
                }),
                safeAbsoluteFile: filename => ({ bytes: fs.readFileSync(filename) })
            },
            extraction: {
                isCurrentExtractorReceipt: () => false,
                EXTRACTOR_IMPLEMENTATION_SHA256: sha('legacy-sha'),
                EXTRACTOR_ENHANCED_IMPLEMENTATION_SHA256: sha('enhanced-sha'),
                BACKEND_VERSION: 'test',
                RECEIPT_CONTRACT: 'conference-pdf-extraction-receipt',
                REQUEST_CONTRACT: 'conference-pdf-extraction-request',
                OPTIONS: {}
            },
            execFileSync: () => { throw sentinel; }
        };
        return { context, deps, sentinel };
    };

    // Invalid PD_CONFERENCE_EXTRACTOR_PROFILE (even 'v2'!) must throw before execFileSync
    {
        const { context, deps } = runWithEnv('v2', undefined);
        assert.throws(() => confProcess.prepareShared(context, deps, '2026-11-27T00:00:00.000Z'), /unsupported PD_CONFERENCE_EXTRACTOR_PROFILE/);
    }
    // Invalid PD_CONFERENCE_EXTRACTOR_VERSION must throw
    {
        const { context, deps } = runWithEnv('', 'bogus');
        assert.throws(() => confProcess.prepareShared(context, deps, '2026-11-27T00:00:00.000Z'), /unsupported PD_CONFERENCE_EXTRACTOR_VERSION/);
    }
    // Valid PD_CONFERENCE_EXTRACTOR_VERSION=v1 reaches execFileSync cleanly
    {
        const { context, deps } = runWithEnv('', 'v1');
        assert.throws(() => confProcess.prepareShared(context, deps, '2026-11-27T00:00:00.000Z'), /SENTINEL_REACHED_EXTRACT/);
    }
});

// =========================================================================
// Bug #15: official-conference-acquisition-extended.js accepts -v2 receipts
// =========================================================================
test('R5-15: official-conference-acquisition-extended 接受 -v2 历史目录与 PDF 凭证并拒绝未知契约', async t => {
    const outRoot = makeTmpDir(t, 'r5-conf-ext-v2-');
    const providerId = 'waspaa-2025';
    const provider = confExt.providerFor(providerId);
    const responsesDir = path.join(outRoot, 'responses');
    const receiptsDir = path.join(outRoot, 'receipts');
    fs.mkdirSync(responsesDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
    const pretty = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const stable = value => confExt.stableHash(value);

    const proceedings = {
        papers: [{
            arnumber: '10001',
            title: 'Test WASPAA Paper',
            authors: ['Alice'],
            pdf_url: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=10001',
            record_url: 'https://ieeexplore.ieee.org/document/10001'
        }]
    };
    fs.writeFileSync(path.join(responsesDir, 'proceedings.json'), Buffer.from(JSON.stringify(proceedings), 'utf8'), { mode: 0o600 });

    await confExt.acquireCatalog({ providerId, outputRoot: outRoot, apply: true }, { now: () => '2026-11-27T00:00:00.000Z' });
    const catalogReceiptFile = path.join(outRoot, 'catalog.receipt.json');
    const origCatalogReceipt = JSON.parse(fs.readFileSync(catalogReceiptFile, 'utf8'));
    const { receiptSha256: _origSha, ...origCore } = origCatalogReceipt;
    const v2CatalogCore = { ...origCore, contract: 'official-conference-catalog-receipt-v2' };
    fs.writeFileSync(catalogReceiptFile, pretty({ ...v2CatalogCore, receiptSha256: stable(v2CatalogCore) }), { mode: 0o600 });

    const replayed = confExt.replayCatalog(providerId, outRoot);
    assert.equal(replayed.receipt.contract, 'official-conference-catalog-receipt-v2');

    // Now test PDF receipt with -v2 contract
    const paper = replayed.metadata.papers[0];
    const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF\n');
    const pdfPath = path.join(outRoot, paper.pdfFile);
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pdfPath, pdfBytes, { mode: 0o600 });
    const pdfCore = {
        acquisitionMode: 'local-sealed-pdf',
        contract: 'official-conference-pdf-receipt-v2',
        finalUrl: paper.pdfUrl,
        metadataSha256: replayed.metadataSha256,
        observedAt: '2026-11-27T00:00:00.000Z',
        paperId: paper.id,
        pdfBytes: pdfBytes.length,
        pdfFile: paper.pdfFile,
        pdfSha256: sha(pdfBytes),
        providerId: provider.conference.id,
        redirects: [],
        requestedUrl: paper.pdfUrl,
        responseStatus: 200
    };
    const pdfReceiptFile = path.join(receiptsDir, `${paper.id}.json`);
    fs.writeFileSync(pdfReceiptFile, pretty({ ...pdfCore, receiptSha256: stable(pdfCore) }), { mode: 0o600 });
    const replayedPdf = confExt.replayPdfReceipt(replayed, paper);
    assert.equal(replayedPdf.contract, 'official-conference-pdf-receipt-v2');

    // Unknown contract must still fail for both PDF and catalog receipts
    const badPdfCore = { ...pdfCore, contract: 'official-conference-pdf-receipt-v99' };
    fs.writeFileSync(pdfReceiptFile, pretty({ ...badPdfCore, receiptSha256: stable(badPdfCore) }), { mode: 0o600 });
    assert.throws(() => confExt.replayPdfReceipt(replayed, paper), /绑定不匹配/);

    const badCatCore = { ...origCore, contract: 'official-conference-catalog-receipt-v99' };
    fs.writeFileSync(catalogReceiptFile, pretty({ ...badCatCore, receiptSha256: stable(badCatCore) }), { mode: 0o600 });
    assert.throws(() => confExt.replayCatalog(providerId, outRoot), /契约/);
});

// =========================================================================
// Bugs #18, #19, #20: Daily Podcast Pipeline
// =========================================================================
test('R5-18/19: publish-daily-podcast 请求 mp3 却产出 wav 或旧期损坏时必须在上传前失败', t => {
    const tmpDir = makeTmpDir(t, 'r5-podcast-');
    const inputPath = path.join(tmpDir, 'deep-analysis-result.json');
    fs.writeFileSync(inputPath, JSON.stringify({
        batchDate: '2026-11-27',
        papers: [{
            arxivId: '2611.00001v1',
            title: 'Test Audio Paper',
            parsed: { score: '8.5', primaryTaskTag: '#语音识别', summary: '测试摘要。' },
            apiReaderPlan: { readerTitle: '测试音频论文解读' }
        }]
    }));

    // Bug #18: requested mp3, mock synthesizer falls back to wav -> must throw BEFORE gh upload
    let ghCalled = false;
    const outDir1 = path.join(tmpDir, 'out-wav-fallback');
    assert.throws(() => {
        podcastPublisher.runDailyPodcastPipeline({
            date: '2026-11-27',
            input: inputPath,
            outDir: outDir1,
            format: 'mp3'
        }, {
            execFileSyncFn: (_bin, args) => {
                const manifestIdx = args.indexOf('--manifest-out');
                const manifestPath = args[manifestIdx + 1];
                const wavPath = path.join(outDir1, 'podcast-2026-11-27.wav');
                const wavBytes = Buffer.from('RIFF....WAVEfmt ');
                fs.writeFileSync(wavPath, wavBytes);
                fs.writeFileSync(manifestPath, JSON.stringify({
                    format: 'wav',
                    audioPath: wavPath,
                    audioBytes: wavBytes.length,
                    audioSha256: sha(wavBytes),
                    durationSeconds: 30,
                    mimeType: 'audio/wav',
                    ttsEngine: 'indextts-2.5',
                    chapters: []
                }));
                return '';
            },
            ghExecFileSyncFn: () => {
                ghCalled = true;
                throw new Error('gh should never be called when MP3 downgraded to WAV');
            }
        });
    }, /Requested MP3 podcast output but synthesizer produced "wav"/);
    assert.equal(ghCalled, false);

    // Bug #19: corrupt prior episode in episodesDir fails BEFORE gh upload
    const priorDir = path.join(tmpDir, 'prior-corrupt');
    fs.mkdirSync(priorDir, { recursive: true });
    fs.writeFileSync(path.join(priorDir, 'podcast-2026-11-26.episode.json'), JSON.stringify({
        contract: 'daily-podcast-episode',
        date: '2026-11-26',
        title: 'Corrupt Prior',
        description: 'bad',
        audioUrl: 'http://insecure.example.invalid/podcast-2026-11-26.mp3', // non-HTTPS causes buildPodcastRssXml to throw!
        audioBytes: 100,
        audioSha256: 'a'.repeat(64),
        durationSeconds: 60,
        mimeType: 'audio/mpeg'
    }));
    const outDir2 = path.join(tmpDir, 'out-corrupt-prior');
    let ghCalledPrior = false;
    assert.throws(() => {
        podcastPublisher.runDailyPodcastPipeline({
            date: '2026-11-27',
            input: inputPath,
            outDir: outDir2,
            episodesDir: priorDir,
            format: 'mp3'
        }, {
            execFileSyncFn: (_bin, args) => {
                const manifestIdx = args.indexOf('--manifest-out');
                const manifestPath = args[manifestIdx + 1];
                const mp3Path = path.join(outDir2, 'podcast-2026-11-27.mp3');
                const mp3Bytes = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00fake-mp3');
                fs.writeFileSync(mp3Path, mp3Bytes);
                fs.writeFileSync(manifestPath, JSON.stringify({
                    format: 'mp3',
                    audioPath: mp3Path,
                    audioBytes: mp3Bytes.length,
                    audioSha256: sha(mp3Bytes),
                    durationSeconds: 30,
                    mimeType: 'audio/mpeg',
                    ttsEngine: 'indextts-2.5',
                    chapters: []
                }));
                return '';
            },
            ghExecFileSyncFn: () => {
                ghCalledPrior = true;
                throw new Error('gh must NOT be called when prior episode is corrupt');
            }
        });
    }, /Unsafe URL|https/i);
    assert.equal(ghCalledPrior, false);
});

test('R5-20: podcast-github-release 在 gh release create 遇到并发 already exists/422 时回退一次 upload', t => {
    const tmpDir = makeTmpDir(t, 'r5-podcast-race-');
    const mp3Path = path.join(tmpDir, 'podcast-2026-11-27.mp3');
    const mp3Bytes = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00race-test');
    fs.writeFileSync(mp3Path, mp3Bytes);

    const calls = [];
    const res = podcastRelease.publishPodcastToGitHubRelease({
        date: '2026-11-27',
        assetPath: mp3Path,
        expectedSha256: sha(mp3Bytes),
        repo: 'nanless/audio-research-portal',
        tagGrouping: 'monthly',
        execFileSyncFn: (_bin, args) => {
            const sub = args[1];
            calls.push(sub);
            if (sub === 'view') {
                const err = new Error('release not found');
                throw err;
            }
            if (sub === 'create') {
                const err = new Error('HTTP 422: Validation Failed: tag_name already_exists');
                throw err;
            }
            if (sub === 'upload') {
                return 'uploaded';
            }
            throw new Error(`unexpected gh subcommand: ${sub}`);
        }
    });
    assert.deepEqual(calls, ['view', 'create', 'upload']);
    assert.equal(res.published, true);
    assert.equal(res.action, 'uploaded');

    // Non-race error (e.g. HTTP 403 auth error) on create must NOT fall back to upload!
    const authCalls = [];
    assert.throws(() => {
        podcastRelease.publishPodcastToGitHubRelease({
            date: '2026-11-27',
            assetPath: mp3Path,
            expectedSha256: sha(mp3Bytes),
            repo: 'nanless/audio-research-portal',
            tagGrouping: 'monthly',
            execFileSyncFn: (_bin, args) => {
                const sub = args[1];
                authCalls.push(sub);
                if (sub === 'view') throw new Error('release not found');
                if (sub === 'create') throw new Error('HTTP 403: Resource not accessible by integration');
                return '';
            }
        });
    }, /HTTP 403/);
    assert.deepEqual(authCalls, ['view', 'create']);
});

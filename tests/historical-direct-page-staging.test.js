'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const api = require('../scripts/lib/historical-direct-page-staging.js');
const freshSource = require('../scripts/lib/fresh-arxiv-rewrite-source.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pageKey = value => `page:${sha(value)}`;
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-direct-page-staging-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const item = { paperId: 'arxiv:2609.00001', runId: '11111111-1111-4111-8111-111111111111',
        route: { kind: 'arxiv-fresh-fetch', arxivId: '2609.00001' }, projectionSha256: sha('projection'), pages: [
            { pageKey: pageKey('one'), pagePath: 'content/posts/one.md', primaryUrl: 'https://example.test/one/', cohortDate: '2026-09-01',
                scope: { type: 'daily', key: '2026-09-01' }, pageContentSha256: sha('frozen-old-page-one'),
                mapping: 'frozen-single-arxiv-identity-hint', historicalArxivLink: { arxivId: '2609.00001' } },
            { pageKey: pageKey('two'), pagePath: 'content/posts/two.md', primaryUrl: 'https://example.test/two/', cohortDate: '2026-09-02',
                scope: { type: 'daily', key: '2026-09-02' }, pageContentSha256: sha('frozen-old-page-two'),
                mapping: 'frozen-single-arxiv-identity-hint', historicalArxivLink: { arxivId: '2609.00001' } }
        ] };
    const reader = 'FRESH_READER_ONLY';
    const analysis = { directPaperId: item.paperId, title: 'Fresh source title', analysis: 'FRESH_CANONICAL_ONLY',
        apiReaderArticle: reader, apiReaderArticleSha256: sha(reader) };
    const sourceDescriptor = { kind: item.route.kind, paperId: item.paperId, generation: 1, sourceId: item.route.arxivId,
        textSha256: sha('fresh text'), structuredArtifactsSha256: sha('fresh artifacts'), pdfSha256: sha('fresh pdf'),
        sourceManifestSha256: sha('fresh manifest'), sourceBinding: { proof: 'bound' }, sourceRunIdentitySha256: sha('source run'),
        sourceSnapshotSha256: sha('snapshot') };
    const artifact = { paperId: item.paperId, runId: item.runId, route: item.route.kind, analysisFileSha256: sha('analysis file'),
        analysisRecordSha256: api.stableHash(analysis), sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        sourceGeneration: 1, sourceManifestSha256: sourceDescriptor.sourceManifestSha256,
        sourceTextSha256: sourceDescriptor.textSha256, sourcePdfSha256: sourceDescriptor.pdfSha256,
        sourceRunIdentitySha256: sourceDescriptor.sourceRunIdentitySha256 };
    const abstract = 'Exact sealed source abstract for publication.';
    const metadataSidecar = { contract: 'historical-arxiv-publication-metadata-v1', paperId: item.paperId,
        manifestSha256: sha('sidecar manifest'), atomResponseSha256: sha('atom'),
        metadataRecordSha256: sha('metadata record'), abstractSha256: sha(abstract), entryVersion: 1,
        entryUpdatedAt: '2026-01-01T00:00:00.000Z', publishedAt: '2025-12-31T00:00:00.000Z',
        observedAt: '2026-01-03T00:00:00.000Z', sourceId: item.route.arxivId, querySourceId: item.route.arxivId,
        sourceCapturedAt: '2026-01-02T00:00:00.000Z', sourceEarliestCapturedAt: '2026-01-02T00:00:00.000Z',
        sourceLatestCapturedAt: '2026-01-02T00:00:00.000Z',
        sourceName: `https://export.arxiv.org/api/query?id_list=${item.route.arxivId}&max_results=1`,
        sourceManifestSha256: sourceDescriptor.sourceManifestSha256,
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        sourceTextSha256: sourceDescriptor.textSha256, generation: 1 };
    const publicationSource = { contract: api.PUBLICATION_SOURCE_CONTRACT, version: 1,
        paperId: item.paperId, sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256,
        sourceTextSha256: sourceDescriptor.textSha256, abstract, abstractSha256: sha(abstract), metadataSidecar };
    return { root, item, analysis, sourceDescriptor, publicationSource, artifact,
        stagingInputSha256: sha('staging input'), stagingBindingSha256: sha('staging binding') };
}
function options(f, overrides = {}) {
    return { item: f.item, sourceDescriptor: f.sourceDescriptor,
        publicationSource: f.item.route.kind === 'arxiv-fresh-fetch' ? f.publicationSource : null,
        artifact: f.artifact, analysis: f.analysis,
        directory: path.join(f.root, 'staging'), stagingInputSha256: f.stagingInputSha256, stagingBindingSha256: f.stagingBindingSha256,
        dependencies: { rendererImplementationSha256: () => sha('renderer-v1'), assertCompleteAnalysis: () => {},
            renderDirectPage: packet => ({ markdown: `---\ndate: ${packet.cohortDate}\n---\n${packet.paper.apiReaderArticle}`, assets: [] }) }, ...overrides };
}

test('已保存并核验的直接来源与 Reader 数据包生成全部计划中的历史页面，不依赖来源对照或旧版词表输入', t => {
    const f = fixture(t); const packets = []; const result = api.stageDirectPages(options(f, {
        dependencies: { rendererImplementationSha256: () => sha('renderer-v1'), assertCompleteAnalysis: () => {},
            renderDirectPage: packet => { packets.push(packet); return { markdown: `---\ndate: ${packet.cohortDate}\n---\n${packet.paper.apiReaderArticle}`, assets: [] }; } }
    }));
    assert.equal(result.contract, api.CONTRACT); assert.equal(result.pages.length, 2);
    assert.equal(result.analysis.readerArticleSha256, f.analysis.apiReaderArticleSha256);
    for (const page of result.pages) {
        const bytes = fs.readFileSync(path.join(f.root, 'staging', page.stagedPath), 'utf8');
        assert.match(bytes, /FRESH_READER_ONLY/); assert.doesNotMatch(bytes, /OLD|POISON/);
        assert.equal(bytes, `---\ndate: ${page.cohortDate}\n---\nFRESH_READER_ONLY`,
            'ordinary source routes must retain the renderer bytes exactly');
    }
    const disk = JSON.stringify(result);
    assert.doesNotMatch(disk, /crosswalk|taxonomyAssignment|POISON_OLD_BODY/i);
    assert.equal(packets.length, 2);
    assert.deepEqual(packets[0].publicationSource, f.publicationSource);
    assert.equal(Object.hasOwn(packets[0].paper, 'abstract'), false,
        'Python must inject only the separately sealed publication abstract');
    const recovered = api.stageDirectPages(options(f));
    assert.equal(recovered.manifestSha256, result.manifestSha256);
});

test('直接 arXiv 发布来源拒绝身份、来源和摘要 SHA 漂移', t => {
    const f = fixture(t);
    for (const publicationSource of [
        { ...f.publicationSource, paperId: 'arxiv:2609.99999' },
        { ...f.publicationSource, sourceSnapshotSha256: sha('another snapshot') },
        { ...f.publicationSource, abstractSha256: sha('another abstract') },
    ]) {
        assert.throws(() => api.stageDirectPages(options(f, { publicationSource })),
            /发布来源记录格式无效，或与来源快照、全文及摘要哈希不一致/);
    }
});

test('直接页面暂存保存并核验精确的元数据旁路证明，拒绝任何外层绑定漂移', t => {
    const f = fixture(t); const metadataSidecar = {
        contract: 'historical-arxiv-publication-metadata-v1', paperId: f.item.paperId,
        manifestSha256: sha('sidecar manifest'),
        atomResponseSha256: sha('atom'), metadataRecordSha256: sha('metadata record'),
        abstractSha256: f.publicationSource.abstractSha256,
        entryVersion: 1, entryUpdatedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: '2025-12-31T00:00:00.000Z', observedAt: '2026-01-03T00:00:00.000Z',
        sourceId: f.item.route.arxivId, querySourceId: f.item.route.arxivId,
        sourceCapturedAt: '2026-01-02T00:00:00.000Z',
        sourceEarliestCapturedAt: '2026-01-02T00:00:00.000Z',
        sourceLatestCapturedAt: '2026-01-02T00:00:00.000Z',
        sourceName: `https://export.arxiv.org/api/query?id_list=${f.item.route.arxivId}&max_results=1`,
        sourceManifestSha256: f.sourceDescriptor.sourceManifestSha256,
        sourceSnapshotSha256: f.sourceDescriptor.sourceSnapshotSha256,
        sourceTextSha256: f.sourceDescriptor.textSha256, generation: 1
    };
    const publicationSource = { ...f.publicationSource, metadataSidecar };
    const result = api.stageDirectPages(options(f, { publicationSource }));
    assert.deepEqual(result.publicationSource.metadataSidecar, metadataSidecar);
    for (const drifted of [
        { ...metadataSidecar, abstractSha256: sha('wrong abstract') },
        { ...metadataSidecar, sourceManifestSha256: sha('wrong source manifest') },
        { ...metadataSidecar, generation: 2 },
        { ...metadataSidecar, observedAt: '2026-01-01T12:00:00.000Z' },
        { ...metadataSidecar, observedAt: '2025-12-31T12:00:00.000Z',
            sourceId: `${f.item.route.arxivId}v1`, querySourceId: `${f.item.route.arxivId}v1`,
            sourceName: `https://export.arxiv.org/api/query?id_list=${f.item.route.arxivId}v1&max_results=1` },
        { ...metadataSidecar, entryUpdatedAt: '2026-01-03T00:00:00.000Z' },
        { ...metadataSidecar, publishedAt: '2026-01-01T12:00:00.000Z' },
        { ...metadataSidecar, sourceLatestCapturedAt: '2026-01-01T00:00:00.000Z' },
        { ...metadataSidecar, sourceId: `${f.item.route.arxivId}v2` },
        { ...metadataSidecar, querySourceId: `${f.item.route.arxivId}v1` },
        { ...metadataSidecar, sourceName: 'https://example.test/not-arxiv' },
        { ...metadataSidecar, unexpected: true }
    ]) {
        const other = fixture(t);
        assert.throws(() => api.stageDirectPages(options(other, {
            publicationSource: { ...other.publicationSource, metadataSidecar: drifted }
        })), /元数据对应记录格式无效，或其来源、版本、时间和哈希与来源记录不一致|元数据对应记录 包含未知字段或缺少必需字段/);
    }
    const missing = { ...f.publicationSource }; delete missing.metadataSidecar;
    assert.throws(() => api.stageDirectPages(options(f, { publicationSource: missing })), /缺少官方论文元数据对应记录/);
});

test('来源、Reader 和汇总保存核验之后渲染页面字节仍有变化时，直接页面暂存直接失败', t => {
    const f = fixture(t); const result = api.stageDirectPages(options(f));
    fs.appendFileSync(path.join(f.root, 'staging', result.pages[0].stagedPath), 'tamper');
    assert.throws(() => api.stageDirectPages(options(f)), /生成页面 SHA 与清单不一致/);
});

test('标题不同的先期预印本会加上可见的顶部声明，其字节由页面和清单 SHA 保存核验', t => {
    const f = fixture(t);
    const paperId = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
    f.item.paperId = paperId;
    const sourceBindingSha256 = sha('source binding');
    const receiptSelfSha256 = sha('receipt self');
    const acquisition = {
        versionRelation: 'author-prior-preprint-with-different-title',
        sourceKind: 'author-prior-preprint-cross-version',
        sourceTitle: 'Beyond Words: Toward Audio-First Foundation Models for Effortless Human-Computer Interaction',
        sourceDoi: '10.2139/ssrn.6288899',
        receipt: { selfSha256: receiptSelfSha256 }
    };
    const disclosureBody = { contract: 'historical-author-prior-preprint-disclosure-v1', version: 1, paperId,
        icmlTitle: 'Position: *Beyond Text* The Text-Centric Bias in Foundation Models Must Be Revisited for a Speech-First Future',
        preprintTitle: acquisition.sourceTitle, doi: acquisition.sourceDoi,
        versionRelation: acquisition.versionRelation, sourceKind: acquisition.sourceKind,
        receiptSelfSha256, sourceBindingSha256, cameraReady: false, openreviewResponseBytes: false,
        statement: 'This input is an author prior preprint with a different title; it is neither the ICML camera-ready paper nor OpenReview response bytes.' };
    f.item.route = { kind: 'conference-local-pdf', writerInputs: [{ sourceBindingSha256, pdf: { acquisition } }],
        sourceDisclosure: { ...disclosureBody, disclosureSha256: api.stableHash(disclosureBody) } };
    f.analysis.directPaperId = paperId;
    f.artifact.paperId = paperId;
    f.artifact.route = f.item.route.kind;
    f.sourceDescriptor.paperId = paperId;
    f.sourceDescriptor.kind = f.item.route.kind;
    f.artifact.analysisRecordSha256 = api.stableHash(f.analysis);
    const result = api.stageDirectPages(options(f));
    for (const page of result.pages) {
        const filename = path.join(f.root, 'staging', page.stagedPath);
        const bytes = fs.readFileSync(filename);
        const markdown = bytes.toString('utf8');
        assert.match(markdown, /^---\ndate: \d{4}-\d{2}-\d{2}\n---\n> \*\*⚠️ 来源版本说明（非 Camera-ready）\*\*/);
        assert.match(markdown, /不是会议 camera-ready 定稿/);
        assert.match(markdown, /Beyond Words: Toward Audio-First Foundation Models for Effortless Human-Computer Interaction/);
        assert.match(markdown, /10\.2139\/ssrn\.6288899/);
        assert.equal(page.contentSha256, sha(bytes));
    }
    assert.equal(result.pageSetSha256, api.stableHash(result.pages));
    assert.equal(result.sourceDisclosure.disclosureSha256, f.item.route.sourceDisclosure.disclosureSha256);
    const manifestBody = { ...result }; delete manifestBody.manifestSha256;
    assert.equal(result.manifestSha256, api.stableHash(manifestBody));
});

test('已撤稿的 arXiv 历史版本证据会注入精确的顶部警告，确定性复核拒绝把它删掉', t => {
    const f = fixture(t); const selected = `${f.item.route.arxivId}v1`;
    f.sourceDescriptor.sourceId = selected;
    f.sourceDescriptor.sourceVersion = freshSource.historicalVersionIdentity({ arxivId: f.item.route.arxivId,
        textSourceId: selected, pdf: { sourceId: selected, url: `https://arxiv.org/pdf/${selected}.pdf`,
            currentPdfUnavailable: true, currentPdfStatus: 404 } });
    Object.assign(f.publicationSource.metadataSidecar, { sourceId: selected, querySourceId: selected,
        entryVersion: 1,
        sourceName: `https://export.arxiv.org/api/query?id_list=${selected}&max_results=1` });
    const result = api.stageDirectPages(options(f));
    assert.equal(result.sourceDisclosure.identitySha256, f.sourceDescriptor.sourceVersion.identitySha256);
    for (const page of result.pages) {
        const markdown = fs.readFileSync(path.join(f.root, 'staging', page.stagedPath), 'utf8');
        assert.match(markdown, /^---\ndate: \d{4}-\d{2}-\d{2}\n---\n> \*\*⚠️ 来源版本说明（当前稿不可用）\*\*/);
        assert.match(markdown, new RegExp(selected));
        assert.match(markdown, /不得暗示当前稿仍有效/);
    }
    const manifestFile = path.join(f.root, 'staging', 'page-staging-manifest.json');
    const forged = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const page = forged.pages[0]; const filename = path.join(f.root, 'staging', page.stagedPath);
    const disclosure = api.arxivHistoricalVersionPageDisclosure(f.item, f.sourceDescriptor);
    const stripped = fs.readFileSync(filename, 'utf8').replace(`${disclosure}\n\n`, '');
    fs.writeFileSync(filename, stripped);
    page.contentSha256 = sha(Buffer.from(stripped));
    forged.pageSetSha256 = api.stableHash(forged.pages);
    const body = { ...forged }; delete body.manifestSha256; forged.manifestSha256 = api.stableHash(body);
    fs.writeFileSync(manifestFile, `${JSON.stringify(forged, null, 2)}\n`);
    assert.throws(() => api.stageDirectPages(options(f)), /来源版本说明缺失、内容不一致或未位于页面正文开头/);
});

test('先期预印本暂存拒绝缺失的路径声明和未闭合的 front matter 块', t => {
    const f = fixture(t);
    f.item.paperId = 'conference:icml:2026:openreview-forum-id:n1mAjfRDZ6';
    f.item.route = { kind: 'conference-local-pdf', writerInputs: [{ pdf: { acquisition: {
        versionRelation: 'author-prior-preprint-with-different-title', sourceTitle: 'title', sourceDoi: 'doi'
    } } }] };
    assert.throws(() => api.priorPreprintDisclosureProof(f.item), /早期预印本说明 必须是对象/);
    assert.throws(() => api.injectTopDisclosure('---\ntitle: broken\nbody', '> warning'), /Hugo 页头缺少结束标记/);
});

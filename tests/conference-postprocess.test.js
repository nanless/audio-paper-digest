'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/conference-postprocess.js');
const tagCatalogApi = require('../scripts/lib/tag-catalog.js');
const { createTagRules } = require('../scripts/lib/tag-rules.js');
const cli = require('../scripts/conference-postprocess.js');
const executionCli = require('../scripts/conference-execution.js');
const adapter = require('../scripts/lib/conference-analysis-adapter.js');
const pageApi = require('../scripts/lib/historical-page-staging.js');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture.js');
const { validAnalysisPaper, validAnalysisText } = require('./valid-analysis-fixture.js');

const TAG_CATALOG_PATH = path.resolve(__dirname, '../config/tag-catalog.json');
const WEAK = { fullText: 'weak', tables: 'unavailable', formulas: 'unavailable', figures: 'unavailable' };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const TAG_RULES = createTagRules({ registryPath: TAG_CATALOG_PATH });

function currentTag(id) {
    const concept = TAG_RULES.tagCatalog.concepts.find(item => item.id === id && item.status === 'active');
    assert.ok(concept, `conference fixture requires active taxonomy concept ${id}`);
    return `#${concept.preferredLabel.zh}`;
}

function currentSelection() {
    const selection = {
        tags: [currentTag('task.asr'), currentTag('method.transformer'), currentTag('research_focus.robustness')],
        primaryTaskTag: currentTag('task.asr'),
        primaryMethodTag: currentTag('method.transformer')
    };
    const validation = TAG_RULES.validateTagSelection(selection);
    assert.equal(validation.valid, true, `conference fixture taxonomy is invalid: ${validation.errors.join('; ')}`);
    return selection;
}

function canonical(index) {
    return validAnalysisPaper(`2609.${String(10000 + index).slice(-5)}`).analysis;
}

function completed(executionId, index = 0, analysisText) {
    const paperId = `conference:icassp:2026:icassp-arnumber:${100 + index}`;
    const base = validAnalysisPaper(`2609.${String(10000 + index).slice(-5)}`, {}, analysisText);
    const analysis = analysisText || canonical(index);
    const parsed = require('../scripts/utils.js').parseAnalysis(analysis);
    const article = `会议 Reader 全新正文 ${index}。`; const articleSha = sha256(article);
    const plan = { version: 3, contract: 'beginner-researcher-v3', readerTitle: `会议解读 ${index}`,
        oneSentenceThesis: '会议论文的一句话结论。', figurePlacements: [], tableBindings: [], formulaBindings: [],
        sourceBindingsContract: 'api-reader-source-bindings-v4' };
    plan.sourceBindingsSha256 = api.stableHash({ tableBindings: [], formulaBindings: [] });
    const planSha = api.stableHash(plan);
    const authors = ['作者']; const metadataSha256 = api.stableHash(authors);
    const authorIdentity = { contract: 'api-reader-author-identity-v1', sourceDomSha256: '',
        sourceTextSha256: base.sourceSha256 || '1'.repeat(64), metadataSha256, authors: [{ name: '作者',
            affiliations: ['机构信息未在会议 PDF 中可靠披露'],
            nameBinding: { sourceKind: 'paper_metadata', sourceValue: '作者', metadataSha256 },
            affiliationBindings: [{ sourceKind: 'explicit_unavailable', sourceValue: '机构信息未在会议 PDF 中可靠披露',
                sourceTextSha256: base.sourceSha256 || '1'.repeat(64) }] }] };
    const readerAuthors = { authors: authorIdentity.authors.map(({ name, affiliations }) => ({ name, affiliations })),
        sourceDomSha256: base.sourceSha256 || '1'.repeat(64), identity: authorIdentity,
        identitySha256: api.stableHash(authorIdentity) };
    const resourceIdentity = { contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: base.sourceSha256 || '1'.repeat(64), resources: [] };
    const readerResources = { ...resourceIdentity, identitySha256: api.stableHash(resourceIdentity) };
    const paper = { ...base, id: paperId, conferencePaperId: paperId, title: `会议论文 ${index}`, authors,
        abstract: '摘要', source: 'conference', conference: { id: 'icassp-2026', year: 2026 },
        externalId: { scheme: 'icassp-arnumber', value: String(100 + index) }, analysis, parsed,
        apiReaderArticle: article, apiReaderArticleSha256: articleSha, apiReaderPlan: plan, apiReaderPlanSha256: planSha,
        apiReaderFigures: [], apiReaderAuthors: readerAuthors, apiReaderResources: readerResources,
        conferencePublication: { contract: 'conference-official-publication-v1',
            recordUrl: `https://ieeexplore.ieee.org/document/${100 + index}`,
            pdfUrl: `https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=${100 + index}` } };
    delete paper.arxivId;
    paper.sourceSha256 = paper.sourceSha256 || '1'.repeat(64);
    paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256,
        structuredArtifactsSha256: '2'.repeat(64), analysisSource: 'conference_pdf_text',
        fullTextAvailable: true };
    Object.assign(paper.analysisManifest.contracts, { apiReaderArticle: 'beginner-researcher-v3',
        apiReaderSourceBindings: 'api-reader-source-bindings-v4',
        apiReaderAuthorIdentity: 'api-reader-author-identity-v1', apiReaderResourceIdentity: 'api-reader-resource-identity-v1' });
    Object.assign(paper.analysisManifest.stages.openSourceScan, { resourceEvidenceContract: 'api-reader-resource-identity-v1',
        resourceEvidenceSha256: readerResources.identitySha256 });
    Object.assign(paper.analysisManifest.stages.scoringAudit, { status: 'complete', scoringContract: 'api-scoring-audit-v2',
        outputAnalysisSha256: sha256(analysis), stabilityWarning: false });
    paper.analysisManifest.stages.apiReaderArticle = { status: 'complete', model: 'fixture-model', protocol: 'openai_responses',
        articleSha256: articleSha, planSha256: planSha, figureCount: 0, figuresSha256: api.stableHash([]),
        readerAuthorsSha256: api.stableHash(readerAuthors), readerAuthorIdentityContractVersion: 'api-reader-author-identity-v1',
        readerAuthorIdentitySha256: readerAuthors.identitySha256,
        resourceIdentityContractVersion: 'api-reader-resource-identity-v1', resourceIdentitySha256: readerResources.identitySha256,
        resourceCount: 0, parserVersion: 'api-reader-parser-v3', assemblerVersion: 'api-reader-assembler-v3',
        tableContractVersion: 'api-reader-tables-v3', figureContractVersion: 'api-reader-figures-v3',
        qualityMetricsContractVersion: 'api-reader-quality-metrics-v2', qualityMetrics: {
            contract: 'api-reader-quality-metrics-v2', rawIssueCount: 0, waivedIssueCount: 0, blockingIssueCount: 0, warningCount: 0 },
        sourceBindingsContractVersion: 'api-reader-source-bindings-v4', sourceBindingsSha256: plan.sourceBindingsSha256,
        sourceBindingsSourceTextSha256: paper.sourceSha256, tableBindingCount: 0, formulaBindingCount: 0,
        structuredArtifactsSha256: '2'.repeat(64) };
    const analysisRecord = { status: 'complete', papers: [paper] };
    const analysisFileSha256 = sha256(JSON.stringify(analysisRecord)); const completedAt = '2026-09-07T00:00:00.000Z';
    const receiptBody = { contract: 'conference-analysis-completion-receipt-v1', version: 1, executionId,
        paperId, sourceSnapshotSha256: 'b'.repeat(64), analysisSha256: analysisFileSha256, completedAt };
    const completionReceipt = { ...receiptBody, receiptSha256: api.stableHash(receiptBody) };
    return { planKey: 'a', analysis: analysisRecord, analysisFileSha256, run: { status: 'complete', executionId, paperId,
        conference: { id: 'icassp-2026', year: 2026 }, capabilities: WEAK, sourceSnapshotSha256: 'b'.repeat(64),
        analysisSha256: analysisFileSha256, completionReceipt }, source: { sourceDetails: { structuredArtifacts: {
            tables: [], formulas: [], figures: [] } } } };
}

function fixture(t, extraRuns = []) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-postprocess-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runs = new Map(); const one = '11111111-1111-4111-8111-111111111111';
    const two = '22222222-2222-4222-8222-222222222222';
    runs.set(one, completed(one, 1)); runs.set(two, completed(two, 2));
    for (const item of extraRuns) runs.set(item.executionId, completed(item.executionId, item.index, item.analysisText));
    const paperIds = [...runs.values()].map(item => item.run.paperId).sort(); const selectedMemberSetSha256 = api.stableHash(paperIds);
    const run = { conferenceId: 'icassp-2026', identitySha256: '1'.repeat(64), stateSha256: '2'.repeat(64),
        membershipSha256: '3'.repeat(64), filterPolicySha256: '4'.repeat(64), selectionReceiptSha256: '5'.repeat(64),
        selectedMemberSetSha256, members: paperIds.map(paperId => ({ paperId })) };
    const receipt = { receiptSha256: '6'.repeat(64), filter: { filterPolicySha256: run.filterPolicySha256,
        selectionReceiptSha256: run.selectionReceiptSha256, selectedMemberSetSha256 } };
    const planHandle = { key: 'a' }; const planAuthority = { snapshot: { run, receipt,
        receiptFileSha256: '7'.repeat(64), runFileSha256: '8'.repeat(64) } };
    const dependencies = { loadConferenceAnalysis: ({ executionId }) => structuredClone(runs.get(executionId)),
        planHandleAuthority: handle => { if (handle?.key !== 'a') throw new Error('wrong plan'); return structuredClone(planAuthority); },
        verifyPlanAuthority: (loaded, handle) => { if (loaded.planKey !== handle?.key) throw new Error('cross-plan'); return true; },
        isSuccessful: () => true, render: packet => {
            assert.equal(Object.hasOwn(packet, 'taxonomy'), false);
            assert.equal(packet.tagMetadata.paperId, packet.paper_id);
            assert.equal(packet.tagMetadata.status, 'assigned');
            return { markdown: `---\npaper_digest_paper_id: "${packet.paper_id}"\n---\n\n${packet.paper.parsed.summary}\n`, assets: [] };
        } };
    const extra = extraRuns.map(item => item.executionId);
    return { root, one, two, extra, runs, planHandle, sourceRoot: path.join(root, 'source'), dependencies };
}

test('会议页面生成会核对完成记录、论文身份和标签，并按词表版本分别保存文件', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging');
    const result = api.stagePaper({ analysisRoot: path.join(f.root, 'analysis'), executionId: f.one,
        tagCatalogPath: TAG_CATALOG_PATH, stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    assert.equal(result.status, 'staged'); assert.equal(result.manifest.paperId, f.runs.get(f.one).run.paperId);
    assert.equal(result.manifest.identity.kind, 'conference'); assert.equal(result.manifest.identity.arxivId, null);
    assert.equal(result.manifest.identity.source.status, 'official');
    assert.equal(result.manifest.taxonomy.flatCompatContract, 'paper-taxonomy-flat-tags-compat-v1');
    assert.equal(result.manifest.readerContract, 'beginner-researcher-v3');
    assert.equal(result.manifest.sourceBindingsContract, 'api-reader-source-bindings-v4');
    assert.equal(result.manifest.scoringContract, 'api-scoring-audit-v2');
    assert.equal(Object.keys(result.manifest.scoreDimensions).length, 8);
    assert.doesNotMatch(result.markdown, /arxiv/i); assert.deepEqual(result.manifest.capabilities, WEAK);
    const registry = tagCatalogApi.loadTagCatalog(TAG_CATALOG_PATH);
    const replayed = api.loadStage({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies);
    assert.equal(replayed.manifest.manifestSha256, result.manifest.manifestSha256);
    assert.ok(fs.existsSync(path.join(stagingRoot, f.one, registry.registrySha256,
        result.manifest.implementation.implementationSha256, 'page.md')));
    assert.equal(api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies).manifest.manifestSha256, result.manifest.manifestSha256);
});

test('preserved conference pages rewrite local Figure paths to the dedicated image repository', () => {
    const markdown = '![Figure 1](/images/conference/aistats-2026/470f332ff69e/figure-1.png)';
    const repaired = api.repairConferenceImageUrls(markdown);
    assert.equal(repaired,
        '![Figure 1](https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/'
        + 'aistats-2026/470f332ff69e/figure-1.png)');
    assert.equal(api.repairConferenceImageUrls(repaired), repaired);
});

test('preserved conference pages escape literal currency dollars without changing prose values', () => {
    const repaired = api.repairPreservedPage('成本为$32,000,000，高于$2,000；区间为$60-80 USD。');
    assert.equal(repaired, '成本为\\$32,000,000，高于\\$2,000；区间为\\$60-80 USD。');
    assert.equal(api.repairPreservedPage(repaired), repaired);
});

test('preserved conference pages escape compact technical notation stars', () => {
    const repaired = api.repairPreservedPage('**H1*-H2* × 谐噪比：** 数值越低越偏向嘎裂。');
    assert.equal(repaired, '**H1\\*-H2\\* × 谐噪比：** 数值越低越偏向嘎裂。');
    assert.equal(api.repairPreservedPage(repaired), repaired);
});

test('preserved conference page repairs never alter YAML frontmatter', () => {
    const page = '---\ndescription: "H1*-H2* costs $32"\n---\n\n**H1*-H2*:** cost $32.';
    const repaired = api.repairPreservedPage(page);
    assert.equal(repaired,
        '---\ndescription: "H1*-H2* costs $32"\n---\n\n**H1\\*-H2\\*:** cost \\$32.');
});

test('preserved conference pages repair significance and linguistic notation stars', () => {
    const page = '---\ntitle: "Stars"\n---\n\n| p |\n|---|\n| p=0.002** |\n\nFigure *Vː2 and *mättīsin.';
    const repaired = api.repairPreservedPage(page);
    assert.equal(repaired,
        '---\ntitle: "Stars"\n---\n\n| p |\n|---|\n| p=0.002\\*\\* |\n\nFigure \\*Vː2 and \\*mättīsin.');
    assert.equal(api.repairPreservedPage(repaired), repaired);
});

test('real PDF formula crop reaches staged Markdown, PNG bytes and figure inventory', t => {
    const f = fixture(t), loaded = f.runs.get(f.one);
    const source = JSON.parse(require('node:child_process').execFileSync('bash', [
        path.resolve(__dirname, '../scripts/python-runtime.sh'), '-B', '-c', `
import sys,json,hashlib
sys.path.insert(0,'scripts')
import fitz
from conference_extractor import load_pypdf_backend
d=fitz.open();p=d.new_page(width=612,height=792)
p.insert_text((60,100),'y=',fontsize=12)
p.insert_text((80,100),'x',fontsize=12)
p.insert_text((87,94),'2',fontsize=8)
raw=d.tobytes();backend=load_pypdf_backend()
a=backend.extract_structures(raw,backend.extract_pages(raw))
a['visualAudit']=backend.extract_visual_audit(raw)
a['pages']=a['visualAudit']['pages']
print(json.dumps({'structuredArtifacts':a,'sourceBinding':{'pdfSha256':hashlib.sha256(raw).hexdigest()},'sourceSnapshotSha256':'b'*64}))
`], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }));
    loaded.run.capabilities = { fullText: 'full', tables: 'available', formulas: 'available', figures: 'available' };
    const dependencies = { ...f.dependencies, render: api.render, buildConferenceSourceContext: () => source };
    const stagingRoot = path.join(f.root, 'formula-stage');
    const result = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, dependencies);
    assert.equal(result.status, 'staged');
    assert.match(result.markdown, /!\[原文数学表达区域 1，PDF 第 1 页\]/);
    assert.equal(result.manifest.assets.length, 1);
    const asset = result.manifest.assets[0];
    assert.match(asset.path, /^static\/images\/conference\/icassp-2026\/[a-f0-9]{12}\/figure-1\.png$/);
    const directory = path.join(stagingRoot, f.one, result.manifest.taxonomy.registrySha256,
        result.manifest.implementation.implementationSha256);
    const png = fs.readFileSync(path.join(directory, 'assets', asset.path));
    assert.equal(sha256(png), asset.sha256);
    assert.equal(asset.sha256, source.structuredArtifacts.formulas[0].sourceExpression.crop.sha256);
    assert.equal(png.length, asset.size);
    assert.ok(png.readUInt32BE(16) < 100, 'crop must not include the page or a neighbouring column');
    assert.ok(png.readUInt32BE(20) < 60, 'crop preserves the exponent without a paragraph-sized image');
    assert.match(fs.readFileSync(path.join(directory, 'page.md'), 'utf8'), /原文公式与排版/);
    assert.equal(loaded.analysis.papers[0].apiReaderPlan.formulaBindings.length, 0);
    assert.equal(api.loadStage({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, dependencies).manifest.manifestSha256,
    result.manifest.manifestSha256);
});

test('IWSLT conference-paper-id with dots remains a conference identity', t => {
    const f = fixture(t); const loaded = f.runs.get(f.one);
    const paperId = 'conference:iwslt:2026:conference-paper-id:IWSLT.2026.001';
    const paper = loaded.analysis.papers[0];
    Object.assign(paper, { id: paperId, conferencePaperId: paperId,
        conference: { id: 'iwslt-2026', year: 2026 },
        externalId: { scheme: 'conference-paper-id', value: 'IWSLT.2026.001' },
        conferencePublication: { contract: 'conference-official-publication-v1',
            recordUrl: 'https://aclanthology.org/2026.iwslt-1.1/',
            pdfUrl: 'https://aclanthology.org/2026.iwslt-1.1.pdf' } });
    loaded.analysisFileSha256 = sha256(JSON.stringify(loaded.analysis));
    Object.assign(loaded.run, { paperId, conference: { id: 'iwslt-2026', year: 2026 },
        analysisSha256: loaded.analysisFileSha256 });
    const receiptBody = { ...loaded.run.completionReceipt, paperId, analysisSha256: loaded.analysisFileSha256 };
    delete receiptBody.receiptSha256;
    loaded.run.completionReceipt = { ...receiptBody, receiptSha256: api.stableHash(receiptBody) };
    const result = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot: path.join(f.root, 'staging'), planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies);
    assert.equal(result.manifest.paperId, paperId);
    assert.equal(result.manifest.identity.externalId.value, 'IWSLT.2026.001');
    assert.equal(result.manifest.publication.recordUrl, 'https://aclanthology.org/2026.iwslt-1.1/');
    assert.match(result.manifest.pagePath, /iwslt-2026-conference-paper-id-iwslt-2026-001-/);
    assert.doesNotMatch(result.markdown, /arxiv/i);
});

test('completion drift, arXiv renderer leakage and weak assets fail closed', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging');
    f.runs.get(f.one).run.completionReceipt.analysisSha256 = 'c'.repeat(64);
    assert.throws(() => api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /会议分析的完成状态、论文身份或完成凭证/);
    f.runs.set(f.one, completed(f.one, 1));
    assert.throws(() => api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, { ...f.dependencies, render: () => ({ markdown: 'https://arxiv.org/abs/1234.5678', assets: [] }) }), /arXiv identity/);
    assert.throws(() => api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, { ...f.dependencies, render: () => ({ markdown: 'generic', assets: [{ path: 'x' }] }) }), /weak assets/);
});

test('production Node stage invokes the generic Python renderer without an arXiv identity', t => {
    const f = fixture(t); const dependencies = { ...f.dependencies }; delete dependencies.render;
    const stagingRoot = path.join(f.root, 'dry-staging');
    const result = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, dependencies);
    assert.match(result.markdown, /paper_digest_paper_id: "conference:icassp:2026:icassp-arnumber:101"/);
    assert.match(result.markdown, /表格、公式与 Figure 均不可用/);
    assert.match(result.markdown, /paper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"/);
    assert.match(result.markdown, /paper_digest_api_reader_contract: "beginner-researcher-v3"/);
    assert.match(result.markdown, /paper_digest_api_reader_source_binding_contract: "api-reader-source-bindings-v4"/);
    assert.match(result.markdown, /paper_digest_api_reader_decision_projection: "api-reader-decision-projection-v2"/);
    assert.match(result.markdown, /paper_digest_conference_record_url: "https:\/\/ieeexplore\.ieee\.org\/document\/101"/);
    assert.match(result.markdown, /创新 1\.5\/2/);
    assert.match(result.markdown, /## 👥 作者与机构/);
    assert.match(result.markdown, /## 🔗 开源与复现资源/);
    assert.match(result.markdown, /## ⚖️ 评分明细/);
    assert.match(result.markdown, /评分属于系统判断，不是论文实验结果/);
    assert.doesNotMatch(result.markdown, /paper_digest_arxiv_id|arxiv\.org/i);
    assert.equal(fs.existsSync(stagingRoot), false);
});

test('aggregate replays every selected stage and emits only when the full explicit selection is complete', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging'); const aggregateRoot = path.join(f.root, 'aggregate');
    f.runs.get(f.one).analysis.papers[0].title = 'Bad [link](https://evil.invalid) # heading';
    for (const executionId of [f.one, f.two]) api.stagePaper({ analysisRoot: 'ignored', executionId,
        tagCatalogPath: TAG_CATALOG_PATH, stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    const result = api.aggregateConference({ analysisRoot: 'ignored', executionIds: [f.one, f.two], tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, aggregateRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    assert.equal(result.manifest.members.length, 2); assert.equal(result.manifest.members[0].paperId, f.runs.get(f.one).run.paperId);
    assert.equal(result.manifest.date, '2026-09-07');
    assert.equal(result.manifest.readerQuality, 'reader-facing-v3');
    assert.equal(result.manifest.taxonomy.scope, 'aggregate-primary-task-counts');
    assert.deepEqual(result.manifest.primaryTaskCounts, [{ label: '语音识别', count: 2 }]);
    // 汇总页必须携带支撑“热门方向只统计主任务”的 concept 数据，
    // 结构与单篇页一致（{facet,id,label}），scope 语义保持不变。
    const conceptsLine = result.manifest.markdown.split('\n')
        .find(line => line.startsWith('paper_digest_taxonomy_concepts: '));
    assert.equal(conceptsLine,
        'paper_digest_taxonomy_concepts: [{"facet":"task","id":"task.asr","label":"语音识别"}]');
    assert.match(result.manifest.markdown,
        /paper_digest_taxonomy_concepts: .*?\npaper_digest_taxonomy_scope: "aggregate-primary-task-counts"/);
    assert.match(result.manifest.markdown, /paper_digest_reader_quality: "reader-facing-v3"/);
    assert.match(result.manifest.markdown, /paper_digest_page_type: index/);
    assert.match(result.manifest.markdown, /^date: 2026-09-07$/m);
    assert.match(result.manifest.markdown, /## ⚡ 今日概览/);
    assert.match(result.manifest.markdown, /👥 \*\*作者与机构\*\*/);
    assert.match(result.manifest.markdown, /🔗 \*\*开源资源\*\*/);
    assert.match(result.manifest.markdown, /Reader 中文题目 \| 英文题目 \| 八维评分 \| 分档 \| 文档类型/);
    assert.doesNotMatch(result.manifest.markdown, /\]\(https:\/\/evil\.invalid\)|\n# heading/);
    assert.doesNotMatch(result.manifest.markdown, /旧会议汇总正文/);
    assert.ok(fs.existsSync(path.join(aggregateRoot, 'icassp-2026', result.manifest.aggregateId, 'manifest.json')));
    const secondStage = api.loadStage({ analysisRoot: 'ignored', executionId: f.two, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies);
    fs.appendFileSync(path.join(secondStage.directory, 'page.md'), 'drift');
    assert.throws(() => api.aggregateConference({ analysisRoot: 'ignored', executionIds: [f.one, f.two], tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, aggregateRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /会议暂存的分类记录、页面或清单与当前分析结果、词表和生成程序的输出不一致/);
});

test('aggregate rejects a selected-member subset and executions from another authenticated plan', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging'); const aggregateRoot = path.join(f.root, 'aggregate');
    for (const executionId of [f.one, f.two]) api.stagePaper({ analysisRoot: 'ignored', executionId,
        tagCatalogPath: TAG_CATALOG_PATH, stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    assert.throws(() => api.aggregateConference({ analysisRoot: 'ignored', executionIds: [f.one], tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, aggregateRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /已核验计划中的全部入选论文/);
    f.runs.get(f.two).planKey = 'b';
    assert.throws(() => api.aggregateConference({ analysisRoot: 'ignored', executionIds: [f.one, f.two], tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, aggregateRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /cross-plan/);
});

test('多层标签统计分别计算每一级的直接使用篇数和包含下级概念的去重篇数', () => {
    const registry = tagCatalogApi.loadTagCatalog(TAG_CATALOG_PATH);
    const hierarchy = api.aggregateHierarchy(registry, [
        ['task.asr', 'method.transformer', 'research_focus.robustness'],
        ['task.av-asr', 'method.transformer', 'research_focus.robustness'],
        ['task.lip-reading', 'method.transformer']]);
    assert.equal(hierarchy.contract, api.HIERARCHY_CONTRACT);
    assert.equal(hierarchy.registrySha256, registry.registrySha256);
    assert.equal(hierarchy.registryVersion, registry.version);
    assert.equal(hierarchy.memberCount, 3);
    assert.equal(hierarchy.facets.length, 9);
    const facet = id => hierarchy.facets.find(item => item.id === id);
    assert.deepEqual(hierarchy.facets.map(item => item.id), registry.facets.map(item => item.id));
    // 每分面一棵树，只输出计数 > 0 的节点。
    const task = facet('task');
    assert.deepEqual(task.nodes.map(node => node.id), ['task.asr']);
    const [root] = task.nodes;
    assert.deepEqual({ id: root.id, label: root.label, level: root.level, directCount: root.directCount, subtreeCount: root.subtreeCount },
        { id: 'task.asr', label: '语音识别', level: 0, directCount: 1, subtreeCount: 3 });
    const [second] = root.children;
    assert.deepEqual({ id: second.id, level: second.level, directCount: second.directCount, subtreeCount: second.subtreeCount },
        { id: 'task.av-asr', level: 1, directCount: 1, subtreeCount: 2 });
    const [third] = second.children;
    assert.deepEqual({ id: third.id, level: third.level, directCount: third.directCount, subtreeCount: third.subtreeCount },
        { id: 'task.lip-reading', level: 2, directCount: 1, subtreeCount: 1 });
    assert.deepEqual(third.children, []);
    // 空分面保留分面壳（每分面一棵树），但没有任何节点。
    assert.deepEqual(facet('application'), { id: 'application', label: '应用', nodes: [] });
    // 同分面内未被计数的兄弟/后代概念绝不出现。
    const serialized = JSON.stringify(hierarchy);
    for (const id of ['task.inverse-text-normalization', 'task.speech-separation',
        'research_focus.adversarial-robustness']) assert.equal(serialized.includes(id), false);
    assert.equal(facet('method').nodes[0].directCount, 3);
    assert.equal(facet('method').nodes[0].subtreeCount, 3);
    assert.equal(facet('research_focus').nodes[0].directCount, 2);
    const flat = [];
    const walk = nodes => nodes.forEach(node => { flat.push(node); walk(node.children); });
    hierarchy.facets.forEach(item => walk(item.nodes));
    assert.equal(flat.length, 5);
    assert.ok(flat.every(node => Number.isInteger(node.directCount) && Number.isInteger(node.subtreeCount)
        && node.directCount > 0 && node.subtreeCount >= node.directCount));
    // 含子树按成员去重：同一篇同时带祖先与后代也不会被数两次。
    const deduped = api.aggregateHierarchy(registry, [['task.asr', 'task.av-asr'], ['task.lip-reading']]);
    const dedupRoot = deduped.facets.find(item => item.id === 'task').nodes[0];
    assert.deepEqual([dedupRoot.directCount, dedupRoot.subtreeCount], [1, 2]);
    // 未知概念 fail-closed。
    assert.throws(() => api.aggregateHierarchy(registry, [['task.not-a-concept']]), /当前词表中缺失或未启用的概念/);
    assert.throws(() => api.aggregateHierarchy(registry, [[null]]), /当前词表中缺失或未启用的概念/);
    assert.throws(() => api.aggregateHierarchy(registry, ['not-an-array']), /概念 ID 列表必须是数组/);
    assert.throws(() => api.aggregateHierarchy({}, []), /构建标签层级需要词表的分类维度/);
    // 渲染：根不缩进、二级缩进一级、三级缩进两级，链接按标签 URL 编码。
    const lines = api.hierarchyLines(hierarchy);
    assert.equal(lines[0], '### 🏷️ 多级标签统计');
    assert.ok(lines.some(line => line.startsWith('每个层级都统计本期论文数') && line.includes('点开下级标签可看该级论文数')));
    assert.ok(lines.includes(`- [#语音识别](/tags/${encodeURIComponent('语音识别')}/) — 直接 1 篇 · 含子树 3 篇`));
    assert.ok(lines.includes(`  - [#音视频语音识别](/tags/${encodeURIComponent('音视频语音识别')}/) — 直接 1 篇 · 含子树 2 篇`));
    assert.ok(lines.includes(`    - [#唇读](/tags/${encodeURIComponent('唇读')}/) — 直接 1 篇 · 含子树 1 篇`));
    // 8 个英文专名标签必须折成 Hugo 实际生成的小写词页 URL，否则 404。
    assert.ok(lines.includes('- [#Transformer](/tags/transformer/) — 直接 3 篇 · 含子树 3 篇'));
    assert.equal(api.tagHref('Transformer'), '/tags/transformer/');
    assert.equal(api.tagHref('鲁棒性'), `/tags/${encodeURIComponent('鲁棒性')}/`);
    assert.ok(lines.includes('#### 研究任务'));
    assert.ok(lines.includes('#### 方法'));
    assert.ok(lines.includes('#### 研究重点'));
    assert.equal(lines.some(line => line.startsWith('#### 应用')), false);
});

test('aggregate renders the multi-level tag drill-down and seals it in the manifest', t => {
    const tagged = tag => validAnalysisText().replaceAll('#语音识别', tag);
    const f = fixture(t, [
        { executionId: '33333333-3333-4333-8333-333333333333', index: 3,
            analysisText: tagged(currentTag('task.av-asr')) },
        { executionId: '44444444-4444-4444-8444-444444444444', index: 4,
            analysisText: tagged(currentTag('task.lip-reading')) }]);
    const stagingRoot = path.join(f.root, 'staging'); const aggregateRoot = path.join(f.root, 'aggregate');
    const executionIds = [f.one, f.two, ...f.extra];
    for (const executionId of executionIds) api.stagePaper({ analysisRoot: 'ignored', executionId,
        tagCatalogPath: TAG_CATALOG_PATH, stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    const result = api.aggregateConference({ analysisRoot: 'ignored', executionIds, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, aggregateRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    const registry = tagCatalogApi.loadTagCatalog(TAG_CATALOG_PATH);
    const hierarchy = result.manifest.taxonomyHierarchy;
    assert.equal(hierarchy.contract, api.HIERARCHY_CONTRACT);
    assert.equal(hierarchy.registrySha256, registry.registrySha256);
    assert.equal(hierarchy.memberCount, 4);
    const task = hierarchy.facets.find(item => item.id === 'task');
    assert.deepEqual(task.nodes.map(node => node.id), ['task.asr']);
    const [root, second] = [task.nodes[0], task.nodes[0].children[0]];
    assert.deepEqual([root.directCount, root.subtreeCount], [2, 4]);
    assert.deepEqual([second.directCount, second.subtreeCount], [1, 2]);
    const third = second.children[0];
    assert.deepEqual({ id: third.id, level: third.level, counts: [third.directCount, third.subtreeCount] },
        { id: 'task.lip-reading', level: 2, counts: [1, 1] });
    assert.equal(hierarchy.facets.find(item => item.id === 'method').nodes[0].directCount, 4);
    // 兼容：既有字段一个都不动。
    assert.deepEqual(Object.fromEntries(result.manifest.primaryTaskCounts.map(item => [item.label, item.count])),
        { 语音识别: 2, 音视频语音识别: 1, 唇读: 1 });
    assert.equal(result.manifest.taxonomy.contract, 'paper-taxonomy-flat-tags-compat-v1');
    assert.equal(result.manifest.taxonomy.registrySha256, registry.registrySha256);
    assert.equal(result.manifest.taxonomy.scope, 'aggregate-primary-task-counts');
    assert.equal(result.manifest.registrySha256, registry.registrySha256);
    // 排版：热门方向表之后、评分排行榜之前，分面分节 + 缩进层级 + 可点开链接。
    const markdown = result.manifest.markdown;
    assert.ok(markdown.indexOf('### 🏷️ 热门方向') < markdown.indexOf('### 🏷️ 多级标签统计'));
    assert.ok(markdown.indexOf('### 🏷️ 多级标签统计') < markdown.indexOf('## 📊 论文评分排行榜'));
    const section = markdown.split('### 🏷️ 多级标签统计')[1].split('## 📊 论文评分排行榜')[0];
    const link = label => `/tags/${encodeURIComponent(label)}/`;
    const rows = section.split('\n');
    assert.ok(rows.includes(`- [#语音识别](${link('语音识别')}) — 直接 2 篇 · 含子树 4 篇`));
    assert.ok(rows.includes(`  - [#音视频语音识别](${link('音视频语音识别')}) — 直接 1 篇 · 含子树 2 篇`));
    assert.ok(rows.includes(`    - [#唇读](${link('唇读')}) — 直接 1 篇 · 含子树 1 篇`));
    assert.ok(rows.includes('- [#Transformer](/tags/transformer/) — 直接 4 篇 · 含子树 4 篇'));
    assert.ok(rows.includes(`- [#鲁棒性](${link('鲁棒性')}) — 直接 4 篇 · 含子树 4 篇`));
    assert.ok(section.includes('零级标签可点开进入对应标签页，点开下级标签可看该级论文数。'));
    assert.ok(section.includes('#### 研究任务'));
    assert.ok(section.includes('#### 方法'));
    assert.ok(section.includes('#### 研究重点'));
    assert.equal(section.includes('#### 应用'), false);
    assert.equal(section.includes('音频分离'), false);
    assert.ok(markdown.includes(`paper_digest_taxonomy_registry_sha256: "${registry.registrySha256}"`));
    // 落盘字节与 manifest 完全一致，且层级统计随 manifest 一起封存。
    const directory = path.join(aggregateRoot, 'icassp-2026', result.manifest.aggregateId);
    assert.equal(fs.readFileSync(path.join(directory, 'aggregate.md'), 'utf8'), markdown);
    const written = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(written.manifestSha256, result.manifest.manifestSha256);
    assert.deepEqual(written.taxonomyHierarchy, hierarchy);
});

test('Reader/scoring/taxonomy/publication compatibility gates cannot be bypassed by success stubs', t => {
    const f = fixture(t); const args = { analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot: path.join(f.root, 'staging'), planHandle: f.planHandle, sourceRoot: f.sourceRoot };
    f.runs.get(f.one).analysis.papers[0].analysisManifest.contracts.apiReaderSourceBindings = 'api-reader-source-bindings-v3';
    assert.throws(() => api.stagePaper(args, f.dependencies), /读者文章、来源绑定规则或文章与正式分析的对应记录未通过校验/);
    f.runs.set(f.one, completed(f.one, 1));
    f.runs.get(f.one).analysis.papers[0].analysisManifest.stages.scoringAudit.scoringContract = 'legacy';
    assert.throws(() => api.stagePaper(args, f.dependencies), /评分审查的状态、规则、正文绑定或稳定性未通过校验/);
    f.runs.set(f.one, completed(f.one, 1));
    delete f.runs.get(f.one).analysis.papers[0].analysisManifest.contracts.coreSummary;
    assert.throws(() => api.stagePaper(args, f.dependencies), /通过核心摘要阶段校验/);
    f.runs.set(f.one, completed(f.one, 1));
    f.runs.get(f.one).analysis.papers[0].analysisManifest.stages.taxonomySeal.registrySha256 = '0'.repeat(64);
    assert.throws(() => api.stagePaper(args, f.dependencies), /标签阶段记录未通过当前校验/);
    f.runs.set(f.one, completed(f.one, 1));
    f.runs.get(f.one).analysis.papers[0].conferencePublication.pdfUrl = 'https://arxiv.org/pdf/1234.5678.pdf';
    assert.throws(() => api.stagePaper(args, f.dependencies), /符合会议页面要求的公网 HTTPS 地址/);
    f.runs.set(f.one, completed(f.one, 1));
    f.runs.get(f.one).analysis.papers[0].analysis = '## 评分\n6.9/10';
    assert.throws(() => api.stagePaper(args, f.dependencies), /包含规定的 13 节/);
    f.runs.set(f.one, completed(f.one, 1));
    f.runs.get(f.one).analysis.papers[0].analysisManifest.sourceAcquisition.analysisSource = 'abstract';
    assert.throws(() => api.stagePaper(args, f.dependencies), /基于全文的分析/);
});

test('loadStage re-renders current completion and rejects re-signed metadata or extra files', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging');
    const staged = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    const registry = tagCatalogApi.loadTagCatalog(TAG_CATALOG_PATH); const directory = path.join(stagingRoot, f.one,
        registry.registrySha256, staged.manifest.implementation.implementationSha256);
    const manifestFile = path.join(directory, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(manifestFile));
    manifest.title = 'attacker title'; const body = structuredClone(manifest); delete body.manifestSha256;
    manifest.manifestSha256 = api.stableHash(body); fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(() => api.loadStage({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /会议暂存的分类记录、页面或清单与当前分析结果、词表和生成程序的输出不一致/);
    fs.writeFileSync(manifestFile, `${JSON.stringify(staged.manifest, null, 2)}\n`); fs.writeFileSync(path.join(directory, 'extra.json'), '{}');
    assert.throws(() => api.loadStage({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /unexpected recovery content/);
});

test('页面生成程序升级后，使用新的暂存身份，不覆盖原文件', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging');
    const implementation = marker => { const body = { contract: api.PROJECTION_CONTRACT, version: 1,
        nodeSourceSha256: marker.repeat(64), rendererSourceSha256: 'b'.repeat(64), publisherSourceSha256: 'c'.repeat(64),
        publisherCommonSourceSha256: '2'.repeat(64),
        tagStageRecordSourceSha256: '6'.repeat(64), pythonTagStageRecordSourceSha256: '7'.repeat(64),
        analysisSectionsSourceSha256: '3'.repeat(64), analysisSectionTitlesSourceSha256: '4'.repeat(64),
        loaderSourceSha256: 'd'.repeat(64), parserSourceSha256: 'e'.repeat(64), pythonParserSourceSha256: '5'.repeat(64), taxonomySourceSha256: 'f'.repeat(64),
        identitySourceSha256: '1'.repeat(64) };
        return { ...body, implementationSha256: api.stableHash(body) }; };
    const firstDeps = { ...f.dependencies, implementationFingerprint: () => implementation('a') };
    const secondDeps = { ...f.dependencies, implementationFingerprint: () => implementation('d'),
        render: packet => ({ markdown: `---\npaper_digest_paper_id: "${packet.paper_id}"\n---\n\nUPGRADED\n`, assets: [] }) };
    const first = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, firstDeps);
    const second = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, secondDeps);
    assert.notEqual(first.manifest.implementation.implementationSha256, second.manifest.implementation.implementationSha256);
    assert.notEqual(api.loadStage({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, firstDeps).directory,
    api.loadStage({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, secondDeps).directory);
});

test('real plan authority, source replay and sealed analysis can stage one conference paper', async t => {
    const fixture = productionPlanFixture(t); const executionId = '99999999-9999-4999-8999-999999999999';
    const analysisRoot = path.join(fixture.root, 'analysis'); const stagingRoot = path.join(fixture.root, 'page-staging');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId, now: '2026-09-07T00:00:00.000Z' });
    const loaded = adapter.loadConferenceAnalysis({ analysisRoot, executionId }); const generated = completed(executionId, 0).analysis.papers[0];
    const paper = { ...generated, id: loaded.run.paperId, conferencePaperId: loaded.run.paperId,
        title: loaded.analysis.papers[0].title, conference: loaded.analysis.papers[0].conference,
        externalId: loaded.analysis.papers[0].externalId };
    delete paper.arxivId;
    const analysis = { ...loaded.analysis, status: 'complete', completedAt: '2026-09-07T01:00:00.000Z', papers: [paper] };
    fs.writeFileSync(path.join(analysisRoot, executionId, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId }));
    const result = api.stagePaper({ analysisRoot, executionId, tagCatalogPath: TAG_CATALOG_PATH, stagingRoot,
        planHandle: fixture.planHandle, sourceRoot: fixture.sourceRoot, apply: true }, { isSuccessful: () => true,
        render: packet => ({ markdown: `---\npaper_digest_paper_id: "${packet.paper_id}"\n---\n\nFRESH`, assets: [] }) });
    assert.equal(result.manifest.paperId, fixture.paperId); assert.equal(result.status, 'staged');
    const aggregate = api.aggregateConference({ analysisRoot, executionIds: [executionId], tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, aggregateRoot: path.join(fixture.root, 'aggregates'), planHandle: fixture.planHandle,
        sourceRoot: fixture.sourceRoot, apply: true }, { isSuccessful: () => true,
        render: packet => ({ markdown: `---\npaper_digest_paper_id: "${packet.paper_id}"\n---\n\nFRESH`, assets: [] }) });
    assert.equal(aggregate.manifest.plan.selectedMemberSetSha256,
        api.stableHash([fixture.paperId])); assert.equal(aggregate.manifest.members.length, 1);
});

test('analysis loader rejects a re-signed source file whose actual SHA no longer matches run.json', t => {
    const fixture = productionPlanFixture(t); const executionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const analysisRoot = path.join(fixture.root, 'analysis');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId });
    const filename = path.join(analysisRoot, executionId, 'source.json'); const source = JSON.parse(fs.readFileSync(filename));
    source.sourceDetails.text += ' drift'; source.sourceDetails.structuredArtifacts.flattenedTextSha256 = sha256(source.sourceDetails.text);
    const artifacts = structuredClone(source.sourceDetails.structuredArtifacts); delete artifacts.payloadSha256;
    source.sourceDetails.structuredArtifacts.payloadSha256 = sha256(JSON.stringify(artifacts));
    const body = structuredClone(source); delete body.recordSha256; source.recordSha256 = api.stableHash(body);
    fs.writeFileSync(filename, `${JSON.stringify(source, null, 2)}\n`);
    assert.throws(() => adapter.loadConferenceAnalysis({ analysisRoot, executionId }), /evidence drifted/);
});

test('shared immutable staging writer removes its own short EIO file and retries safely', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-short-write-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); const filename = path.join(root, 'page.md');
    let calls = 0; const io = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync,
        writeSync: (fd, buffer, offset, length, position) => {
            calls += 1; if (calls === 1) return fs.writeSync(fd, buffer, offset, Math.min(3, length), position);
            const error = new Error('injected short-write EIO'); error.code = 'EIO'; throw error;
        } };
    assert.throws(() => pageApi.writeExact(filename, Buffer.from('complete bytes'), { io }), /EIO/);
    assert.equal(fs.existsSync(filename), false);
    assert.equal(pageApi.writeExact(filename, Buffer.from('complete bytes')), sha256('complete bytes'));
});

test('an unresolved primary task becomes a review assignment, never a page, and is promoted after the fix', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'review-staging');
    const unknownTaskText = validAnalysisText()
        .replace('primary_task_tag: #语音识别', 'primary_task_tag: #不存在的主任务')
        .replace('#语音识别 #Transformer #鲁棒性', '#不存在的主任务 #Transformer #鲁棒性')
        .replace('主任务标签: #语音识别', '主任务标签: #不存在的主任务');
    f.runs.set(f.one, completed(f.one, 1, unknownTaskText));
    const args = { analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH, stagingRoot,
        planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true };
    const review = api.stagePaper(args, f.dependencies);
    assert.equal(review.status, 'blocked');
    assert.equal(review.assignment.status, 'blocked');
    assert.ok(review.assignment.blockedReasons.includes('primary-task:unknown:#不存在的主任务'));
    assert.ok(review.assignment.blockedReasons.some(reason => reason.startsWith('selection:')));
    assert.deepEqual(review.assignment.conceptIds, []);
    assert.equal(review.assignment.primaryTaskId, null);
    assert.match(review.assignment.registrySha256, /^[a-f0-9]{64}$/);
    // Fail-closed: the blocked paper stages its assignment placeholder only.
    const registry = tagCatalogApi.loadTagCatalog(TAG_CATALOG_PATH);
    const registryRoot = path.join(stagingRoot, f.one, registry.registrySha256);
    const implementationRoot = path.join(registryRoot, fs.readdirSync(registryRoot)[0]);
    assert.deepEqual(fs.readdirSync(implementationRoot), ['assignment.json']);
    assert.equal(fs.existsSync(path.join(implementationRoot, 'page.md')), false);
    assert.equal(fs.existsSync(path.join(implementationRoot, 'manifest.json')), false);

    // Fixing the labels re-runs postprocess: the placeholder is superseded and
    // the paper is promoted to a real staged page under the same execution.
    f.runs.set(f.one, completed(f.one, 1));
    const staged = api.stagePaper(args, f.dependencies);
    assert.equal(staged.status, 'staged');
    assert.equal(staged.manifest.paperId, f.runs.get(f.one).run.paperId);
    assert.deepEqual(fs.readdirSync(implementationRoot).sort(), ['assignment.json', 'manifest.json', 'page.md']);
    const assignment = JSON.parse(fs.readFileSync(path.join(implementationRoot, 'assignment.json'), 'utf8'));
    assert.equal(assignment.status, 'assigned');
    assert.equal(assignment.primaryTaskId, 'task.asr');
    assert.equal(api.loadStage({ analysisRoot: 'ignored', executionId: f.one, tagCatalogPath: TAG_CATALOG_PATH,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies).manifest.manifestSha256,
    staged.manifest.manifestSha256);
});

test('CLI requires full authority, configured roots and distinct UUID selections', () => {
    const authority = executionCli.AUTHORITY_FLAGS.flatMap(flag => [flag, flag === '--filter' ? '33333333-3333-4333-8333-333333333333' : 'proof.json']);
    const parsed = cli.parseArgs(['aggregate', '--dry-run', ...authority,
        '--analysis-runs', '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222']);
    assert.equal(parsed.executionIds.length, 2);
    assert.throws(() => cli.parseArgs(['paper', '--apply', '--analysis-run', '11111111-1111-4111-8111-111111111111']), /Use/);
    assert.throws(() => cli.configured({ conferenceAnalysisDir: 'relative' }), /configured absolute path/);
});


test('会议缓存兼容旧标签字段，但不能混用新旧字段', () => {
    const current = completed('88888888-8888-4888-8888-888888888888').analysis.papers[0];
    const expected = api.getConsistentPublicationFields(current);
    const legacy = structuredClone(current);
    legacy.parsed = Object.fromEntries(Object.entries(legacy.parsed).map(([key, value]) =>
        [key === 'tagValidation' ? 'taxonomyValidation' : key, value]));
    const before = JSON.stringify(legacy);
    assert.deepEqual(api.getConsistentPublicationFields(legacy), expected);
    assert.equal(JSON.stringify(legacy), before);
    delete legacy.parsed.taxonomyValidation;
    assert.deepEqual(api.getConsistentPublicationFields(legacy), expected);
    for (const value of [current.parsed.tagValidation, null, {}]) {
        const mixed = structuredClone(current);
        mixed.parsed.taxonomyValidation = value;
        assert.throws(() => api.getConsistentPublicationFields(mixed), /解析结果不能同时包含/);
    }
});

test('会议实现身份实际包含 Python 解析器全文，单独变化使身份失效', () => {
    const baseline = api.implementationFingerprint();
    const parserPath = path.resolve(__dirname, '../scripts/utils.py');
    assert.equal(baseline.pythonParserSourceSha256, sha256(fs.readFileSync(parserPath)));
    const originalRead = pageApi.readRegular;
    try {
        pageApi.readRegular = function(file, ...args) {
            const result = originalRead(file, ...args);
            if (path.resolve(file) !== parserPath) return result;
            const bytes = Buffer.concat([result.bytes, Buffer.from('\n# changed Python parser dependency')]);
            return { ...result, bytes, fileSha256: sha256(bytes) };
        };
        const changed = api.implementationFingerprint();
        assert.notEqual(changed.pythonParserSourceSha256, baseline.pythonParserSourceSha256);
        assert.notEqual(changed.implementationSha256, baseline.implementationSha256);
        assert.equal(changed.parserSourceSha256, baseline.parserSourceSha256);
        const { pythonParserSourceSha256: _changedPython, implementationSha256: _changedHash, ...otherChanged } = changed;
        const { pythonParserSourceSha256: _originalPython, implementationSha256: _originalHash, ...otherOriginal } = baseline;
        assert.deepEqual(otherChanged, otherOriginal);
    } finally { pageApi.readRegular = originalRead; }
});

test('会议页面实现身份包含两端标签格式读取器的实际全文 SHA', () => {
    const baseline = api.implementationFingerprint();
    for (const [relative, field] of [
        ['scripts/lib/tag-stage-record.js', 'tagStageRecordSourceSha256'],
        ['scripts/tag_stage_record.py', 'pythonTagStageRecordSourceSha256']
    ]) {
        const target = path.resolve(__dirname, '..', relative);
        assert.equal(baseline[field], sha256(fs.readFileSync(target)));
        const originalRead = pageApi.readRegular;
        try {
            pageApi.readRegular = function(file, ...args) {
                const result = originalRead(file, ...args);
                if (path.resolve(file) !== target) return result;
                const bytes = Buffer.concat([result.bytes, Buffer.from('\nchanged tag record dependency')]);
                return { ...result, bytes, fileSha256: sha256(bytes) };
            };
            const changed = api.implementationFingerprint();
            assert.notEqual(changed[field], baseline[field]);
            assert.notEqual(changed.implementationSha256, baseline.implementationSha256);
            for (const key of Object.keys(baseline)) {
                if (key !== field && key !== 'implementationSha256') assert.equal(changed[key], baseline[key]);
            }
        } finally { pageApi.readRegular = originalRead; }
    }
});

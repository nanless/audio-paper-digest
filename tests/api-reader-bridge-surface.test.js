const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    collapseRepeatedReaderBridgeHeadings,
    repairApiReaderPlanSurfaceBinding,
    stableFingerprint,
    buildApiReaderQualityMetrics,
    apiReaderPreInjectionQualityView
} = require('../scripts/deep-analyzer.js');
const { apiReaderV3BindsCanonical } = require('../scripts/analysis-engine.js');
const { validateEditorialQuality } = require('../scripts/editorial-quality.js');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const heading = '**声学先验 × 测试时适应：**';
const explanation = ' 声学先验负责描述干净语音，测试时适应负责更新当前输入的增强模型，两者共同指导增强过程。';

test('only exact consecutive paragraph-leading bridge headings collapse, including multiple copies', () => {
    for (const count of [2, 3, 5]) {
        const raw = Array(count).fill(heading).join(' ') + explanation;
        const once = collapseRepeatedReaderBridgeHeadings(raw);
        assert.equal(once, heading + explanation);
        assert.equal(collapseRepeatedReaderBridgeHeadings(once), once);
    }
    assert.equal(collapseRepeatedReaderBridgeHeadings(heading + '\n' + heading + explanation), heading + explanation);
});

test('different headings, inline citations, separate paragraphs, tables and fenced examples are unchanged', () => {
    for (const raw of [
        heading + ' **声学先验 × 监督训练：**' + explanation,
        '**声学先验×测试时适应：** ' + heading + explanation,
        '正文引用 ' + heading + ' ' + heading + explanation,
        heading + explanation + ' 文中再次引用 ' + heading,
        heading + '\n\n' + heading + explanation,
        '| 项目 | 解释 |\n| --- | --- |\n| 例子 | ' + heading + ' ' + heading + ' |',
        '```markdown\n\n' + heading + ' ' + heading + '\n\n```',
        '~~~text\n' + heading + ' ' + heading + '\n~~~'
    ]) assert.equal(collapseRepeatedReaderBridgeHeadings(raw), raw);
});

function signedFixture() {
    const sourceSha256 = '1'.repeat(64);
    const bridge = { terms: ['声学先验', '测试时适应'], sectionKind: 'component',
        marker: '[[CONCEPT_BRIDGE_1]]', explanation: heading + ' ' + heading + explanation };
    const article = '### 两个组件如何共同工作\n\n' + bridge.explanation;
    const plan = { version: 3, contract: 'beginner-researcher-v3',
        readerTitle: '两个组件如何共同工作', oneSentenceThesis: '解释已有机制。',
        sections: [{ kind: 'component', heading: '两个组件如何共同工作' }],
        conceptBridges: [bridge], figurePlacements: [], tableBindings: [], formulaBindings: [],
        sourceBindingsContract: 'api-reader-source-bindings-v4',
        sourceBindingsSha256: stableFingerprint({ tableBindings: [], formulaBindings: [] }) };
    const identity = { contract: 'api-reader-author-identity-v1', sourceTextSha256: sourceSha256,
        metadataSha256: stableFingerprint([]), authors: [] };
    const authors = { authors: [], identity, identitySha256: stableFingerprint(identity) };
    const resourceBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sourceSha256, resources: [] };
    const resources = { ...resourceBody, identitySha256: stableFingerprint(resourceBody) };
    const paper = { arxivId: '2609.03622', authors: [], sourceSha256,
        apiReaderArticle: article, apiReaderPlan: plan, apiReaderFigures: [],
        apiReaderAuthors: authors, apiReaderResources: resources,
        apiReaderArticleSha256: sha(article), apiReaderPlanSha256: stableFingerprint(plan),
        analysisManifest: {
            sourceAcquisition: { sourceSha256, structuredArtifactsSha256: '2'.repeat(64) },
            contracts: { apiReaderArticle: plan.contract, apiReaderSourceBindings: plan.sourceBindingsContract,
                apiReaderAuthorIdentity: identity.contract, apiReaderResourceIdentity: resources.contract },
            stages: { openSourceScan: { resourceEvidenceContract: resources.contract,
                resourceEvidenceSha256: resources.identitySha256 }, apiReaderArticle: {
                status: 'complete', fingerprint: '3'.repeat(64), attempts: 2, model: 'signed-model',
                protocol: 'openai_responses', temperature: 0.1,
                articleSha256: sha(article), planSha256: stableFingerprint(plan),
                figureCount: 0, figuresSha256: stableFingerprint([]),
                readerAuthorsSha256: stableFingerprint(authors), readerAuthorIdentityContractVersion: identity.contract,
                readerAuthorIdentitySha256: authors.identitySha256,
                resourceIdentityContractVersion: resources.contract, resourceIdentitySha256: resources.identitySha256,
                resourceCount: 0, parserVersion: 'api-reader-parser-v3', assemblerVersion: 'api-reader-assembler-v3',
                tableContractVersion: 'api-reader-tables-v3', figureContractVersion: 'api-reader-figures-v3',
                qualityMetricsContractVersion: 'api-reader-quality-metrics-v2',
                qualityMetrics: { contract: 'api-reader-quality-metrics-v2', blockingIssueCount: 0, rawIssueCount: 999 },
                sourceBindingsContractVersion: plan.sourceBindingsContract, sourceBindingsSha256: plan.sourceBindingsSha256,
                sourceBindingsSourceTextSha256: sourceSha256, tableBindingCount: 0, formulaBindingCount: 0,
                structuredArtifactsSha256: '2'.repeat(64)
            } }
        } };
    assert.equal(apiReaderV3BindsCanonical(paper), true);
    return paper;
}

test('surface repair preserves production binding, reseals actual bytes and metrics without claiming a new LLM run', () => {
    const paper = signedFixture();
    const before = structuredClone(paper);
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    assert.equal(repairApiReaderPlanSurfaceBinding(paper, paper.analysisManifest), true);
    assert.equal(paper.apiReaderArticle, before.apiReaderArticle.replace(heading + ' ' + heading, heading));
    assert.equal(paper.apiReaderPlan.conceptBridges[0].explanation, heading + explanation);
    assert.equal(paper.apiReaderArticleSha256, sha(paper.apiReaderArticle));
    assert.equal(paper.apiReaderPlanSha256, stableFingerprint(paper.apiReaderPlan));
    assert.equal(apiReaderV3BindsCanonical(paper), true);
    assert.equal(stage.surfaceRepairVersion, 'api-reader-surface-repair-v2');
    assert.equal(stage.surfaceRepair.executionKind, 'deterministic_surface_repair');
    assert.equal(stage.surfaceRepair.inputArticleSha256, before.apiReaderArticleSha256);
    assert.equal(stage.surfaceRepair.outputArticleSha256, paper.apiReaderArticleSha256);
    assert.equal(stage.surfaceRepair.inputPlanSha256, before.apiReaderPlanSha256);
    assert.equal(stage.surfaceRepair.outputPlanSha256, paper.apiReaderPlanSha256);
    assert.deepEqual(stage.qualityMetrics, buildApiReaderQualityMetrics(validateEditorialQuality({
        summary: '', method: paper.apiReaderArticle, innovations: '', results: '', details: '', limits: ''
    }), paper.apiReaderArticle));
    for (const key of ['fingerprint', 'attempts', 'model', 'protocol', 'temperature']) {
        assert.equal(stage[key], before.analysisManifest.stages.apiReaderArticle[key]);
    }
    const once = JSON.stringify(paper);
    assert.equal(repairApiReaderPlanSurfaceBinding(paper, paper.analysisManifest), false);
    assert.equal(JSON.stringify(paper), once);
});

test('surface metrics replay only bound Figure and TeX injections back to the parser quality view', () => {
    const figure = { ordinal: 1, label: 'Figure 1', caption: 'A result chart.',
        url: 'https://arxiv.org/html/2609.03622v1/fig.png' };
    const focus = '先对比四个频谱面板中的噪声变化';
    const figureBlock = '> **看图路径：** 1. ' + focus + '\n\n'
        + '![原论文 Figure 1：A result chart.](' + figure.url + ')\n\n'
        + '*论文图 1。原论文 Figure 1：“A result chart.”。*';
    const formula = '\\[x=1\\]';
    const plan = { figurePlacements: [{ figureOrdinal: 1, marker: '[[FIGURE_1]]', focusPoints: [focus] }],
        formulaBindings: [{ marker: '[[FORMULA_1]]', latex: 'x=1', renderedBlockSha256: sha(formula) }] };
    const authored = '### 解释现有图表\n\n这里是作者写出的说明段。\n\n';
    const final = authored + figureBlock + '\n\n' + formula;
    const view = apiReaderPreInjectionQualityView(final, plan, [figure]);
    assert.equal(view, authored + '[[FIGURE_1]]\n\n[[FORMULA_1]]');
    const quality = value => validateEditorialQuality({
        summary: '', method: value, innovations: '', results: '', details: '', limits: ''
    });
    assert.ok(quality(final).issues.some(issue => issue.match === '四个'));
    assert.ok(!quality(view).issues.some(issue => issue.match === '四个'));
    assert.throws(() => apiReaderPreInjectionQualityView(final.replace(focus, '未绑定图文'), plan, [figure]),
        /无法精确重放 Figure/);
    assert.throws(() => apiReaderPreInjectionQualityView(final.replace('x=1', 'x=2'), plan, [figure]),
        /无法精确重放公式/);
    const unboundProse = '> **看图路径：** 正文声称四个未绑定面板';
    assert.equal(apiReaderPreInjectionQualityView(unboundProse, {}, []), unboundProse);
});

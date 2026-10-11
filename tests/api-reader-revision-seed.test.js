const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    prepareApiReaderRevisionSeed,
    buildApiReaderGenerationStart,
    stableFingerprint
} = require('../scripts/deep-analyzer.js');
const { hasValidApiReaderV3Records } = require('../scripts/analysis-engine.js');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sourceText = 'This is the same verified paper source used to produce the Reader.';

function createReaderPaperSample() {
    const sourceSha256 = sha(sourceText);
    const paper = { arxivId: '2609.03622', authors: ['Author'], sourceSha256 };
    const identity = {
        contract: 'api-reader-author-identity-v1', sourceTextSha256: sourceSha256,
        sourceDomSha256: '', metadataSha256: stableFingerprint(paper.authors),
        authors: [{ name: 'Author', affiliations: ['Not disclosed'],
            nameBinding: { sourceKind: 'paper_metadata', sourceValue: 'Author',
                metadataSha256: stableFingerprint(paper.authors) },
            affiliationBindings: [{ sourceKind: 'explicit_unavailable', sourceValue: 'Not disclosed',
                sourceTextSha256: sourceSha256 }] }]
    };
    paper.apiReaderAuthors = { authors: [{ name: 'Author', affiliations: ['Not disclosed'] }],
        identity, identitySha256: stableFingerprint(identity) };
    const resources = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sourceSha256, resources: [] };
    paper.apiReaderResources = { ...resources, identitySha256: stableFingerprint(resources) };
    paper.apiReaderFigures = [];
    paper.apiReaderArticle = '### 保留已经正确的解释\n\n这里是上一轮完成并绑定的读者正文。';
    paper.apiReaderPlan = {
        version: 3, contract: 'beginner-researcher-v3', sections: [{ kind: 'component', heading: '正确的解释' }],
        figurePlacements: [], tableBindings: [], formulaBindings: [],
        sourceBindingsContract: 'api-reader-source-bindings-v4',
        sourceBindingsSha256: stableFingerprint({ tableBindings: [], formulaBindings: [] })
    };
    paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
    paper.apiReaderPlanSha256 = stableFingerprint(paper.apiReaderPlan);
    paper.analysisManifest = {
        sourceAcquisition: { sourceSha256, structuredArtifactsSha256: 'a'.repeat(64) },
        contracts: { apiReaderArticle: 'beginner-researcher-v3',
            apiReaderSourceBindings: 'api-reader-source-bindings-v4',
            apiReaderAuthorIdentity: 'api-reader-author-identity-v1',
            apiReaderResourceIdentity: 'api-reader-resource-identity-v1' },
        stages: {
            openSourceScan: { resourceEvidenceContract: resources.contract,
                resourceEvidenceSha256: paper.apiReaderResources.identitySha256 },
            apiReaderArticle: {
                status: 'complete', model: 'test-model', protocol: 'openai_responses',
                articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256,
                figureCount: 0, figuresSha256: stableFingerprint([]),
                readerAuthorsSha256: stableFingerprint(paper.apiReaderAuthors),
                readerAuthorIdentityContractVersion: identity.contract,
                readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
                resourceIdentityContractVersion: resources.contract,
                resourceIdentitySha256: paper.apiReaderResources.identitySha256, resourceCount: 0,
                parserVersion: 'api-reader-parser-v3', assemblerVersion: 'api-reader-assembler-v3',
                tableContractVersion: 'api-reader-tables-v3', figureContractVersion: 'api-reader-figures-v3',
                qualityMetricsContractVersion: 'api-reader-quality-metrics-v2',
                qualityMetrics: { contract: 'api-reader-quality-metrics-v2', blockingIssueCount: 0 },
                sourceBindingsContractVersion: 'api-reader-source-bindings-v4',
                sourceBindingsSha256: paper.apiReaderPlan.sourceBindingsSha256,
                sourceBindingsSourceTextSha256: sourceSha256,
                tableBindingCount: 0, formulaBindingCount: 0, structuredArtifactsSha256: 'a'.repeat(64)
            }
        }
    };
    assert.equal(hasValidApiReaderV3Records(paper), true, '测试正文必须通过正式校验器');
    return paper;
}

test('反馈修订的种子精确锁定已签名文章和计划，并带上来源与修订哈希', () => {
    const paper = createReaderPaperSample();
    const before = JSON.stringify(paper);
    const seed = prepareApiReaderRevisionSeed(paper, sourceText, '只修正图的颜色对应');
    assert.deepEqual(JSON.parse(seed.initialDraft), { article: paper.apiReaderArticle, plan: paper.apiReaderPlan });
    assert.equal(seed.metadata.revisionMode, 'api-reader-signed-revision-v1');
    assert.equal(seed.metadata.revisionSeedSha256, sha(seed.initialDraft));
    assert.equal(seed.metadata.revisionSeedArticleSha256, paper.apiReaderArticleSha256);
    assert.equal(seed.metadata.revisionSeedPlanSha256, paper.apiReaderPlanSha256);
    assert.equal(seed.metadata.revisionSeedSourceSha256, sha(sourceText));
    assert.equal(seed.metadata.revisionTemperature, 0.1);
    assert.equal(JSON.stringify(paper), before, '准备修订参考不得改动原记录');
});

test('带种子的生成从修复温度开始，请求完整 schema，但不改写正确内容', () => {
    const paper = createReaderPaperSample();
    const reviewFeedback = '修正数据角色';
    const seed = prepareApiReaderRevisionSeed(paper, sourceText, reviewFeedback);
    const start = buildApiReaderGenerationStart(paper, { reviewFeedback, sourceText, initialDraft: seed.initialDraft });
    assert.equal(start.previousDraft, seed.initialDraft);
    assert.equal(start.temperature, 0.1);
    assert.equal(start.isRevision, true);
    assert.match(start.reviewFeedbackPrefix, /只修反馈指出的问题及必要连带内容/);
    assert.match(start.reviewFeedbackPrefix, /保留已经正确的章节、解释、图表和数字/);
    assert.match(start.reviewFeedbackPrefix, /完整 JSON/);
    assert.match(start.reviewFeedbackPrefix, /不得直接返回参考用的/);
});

test('默认生成和无反馈刷新既不设种子，也不改温度', () => {
    assert.equal(prepareApiReaderRevisionSeed({}, 'irrelevant', ''), null);
    const start = buildApiReaderGenerationStart({});
    assert.equal(start.previousDraft, '无');
    assert.equal(start.temperature, 0.6);
    assert.equal(start.isRevision, false);
    assert.equal(start.reviewFeedbackPrefix, '');
});

test('不完整、被篡改、阶段过期或来源不对的 Reader，作为修订种子一律拒绝', () => {
    for (const tamper of [
        paper => { paper.apiReaderArticle += '未签名改写'; },
        paper => { paper.apiReaderPlan.sections[0].heading = '未签名标题'; },
        paper => { paper.analysisManifest.stages.apiReaderArticle.status = 'pending'; },
        paper => { paper.analysisManifest.stages.apiReaderArticle.planSha256 = 'b'.repeat(64); },
        paper => { paper.analysisManifest.stages.apiReaderArticle.figuresSha256 = 'b'.repeat(64); },
        paper => { paper.latestAnalysisAttemptError = 'latest attempt failed'; }
    ]) {
        const paper = createReaderPaperSample();
        tamper(paper);
        assert.throws(() => prepareApiReaderRevisionSeed(paper, sourceText, '修正事实'), /定向修订需要完整的读者文章/);
    }
    assert.throws(() => prepareApiReaderRevisionSeed(createReaderPaperSample(), sourceText + 'changed', '修正事实'), /来源 SHA 与本次论文全文不一致/);
    assert.throws(() => prepareApiReaderRevisionSeed({}, sourceText, '修正事实'), /定向修订需要完整的读者文章/);
});

test('调用方提供的草稿不能绕过种子校验，已签名输入一变种子身份就变', () => {
    const paper = createReaderPaperSample();
    const seed = prepareApiReaderRevisionSeed(paper, sourceText, '修正事实');
    assert.throws(() => buildApiReaderGenerationStart(paper, {
        reviewFeedback: '修正事实', sourceText, initialDraft: seed.initialDraft + 'forged'
    }), /未通过当前正文、写作计划和来源记录的核验/);
    assert.throws(() => buildApiReaderGenerationStart(paper, { sourceText, initialDraft: seed.initialDraft }), /未通过当前正文、写作计划和来源记录的核验/);
    paper.apiReaderArticle += '\n\n另一次已签名修订。';
    paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
    paper.analysisManifest.stages.apiReaderArticle.articleSha256 = paper.apiReaderArticleSha256;
    const next = prepareApiReaderRevisionSeed(paper, sourceText, '修正事实');
    assert.notEqual(next.metadata.revisionSeedSha256, seed.metadata.revisionSeedSha256);
    assert.notEqual(stableFingerprint(next.metadata), stableFingerprint(seed.metadata));
});


test('已签名正文仍有图片标记时拒绝资格，普通图号引文保留', () => {
    const paper = createReaderPaperSample();
    const sourceSha256 = paper.sourceSha256;
    const sourceManifest = JSON.stringify(paper.analysisManifest.sourceAcquisition);
    for (const marker of ['[[FIGURE_2]]', '[[FIGURE_0]]', '[[FIGURE_02]]']) {
        const candidate = structuredClone(paper);
        candidate.apiReaderArticle += `\n\n${marker}`;
        candidate.apiReaderArticleSha256 = sha(candidate.apiReaderArticle);
        candidate.analysisManifest.stages.apiReaderArticle.articleSha256 = candidate.apiReaderArticleSha256;
        assert.equal(hasValidApiReaderV3Records(candidate), false, marker);
        assert.equal(candidate.sourceSha256, sourceSha256);
        assert.equal(JSON.stringify(candidate.analysisManifest.sourceAcquisition), sourceManifest);
    }
    const ordinaryQuote = structuredClone(paper);
    ordinaryQuote.apiReaderArticle += '\n\n原文引用 FIGURE_2 与 Figure 2 都只是普通图号。';
    ordinaryQuote.apiReaderArticleSha256 = sha(ordinaryQuote.apiReaderArticle);
    ordinaryQuote.analysisManifest.stages.apiReaderArticle.articleSha256 = ordinaryQuote.apiReaderArticleSha256;
    assert.equal(hasValidApiReaderV3Records(ordinaryQuote), true);
});


function refreshBoundSample(paper) {
    paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
    paper.apiReaderPlanSha256 = stableFingerprint(paper.apiReaderPlan);
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    stage.articleSha256 = paper.apiReaderArticleSha256;
    stage.planSha256 = paper.apiReaderPlanSha256;
    stage.figureCount = paper.apiReaderFigures.length;
    stage.figuresSha256 = stableFingerprint(paper.apiReaderFigures);
}

function addBoundFigure(paper, ordinal) {
    const marker = `[[FIGURE_${ordinal}]]`;
    const figure = { ordinal, label: `Figure ${ordinal}`, caption: '原始图注',
        url: `https://arxiv.org/html/2609.03622/figure-${ordinal}.png` };
    const block = '> **看图路径：** 1. 核对原图方向\n\n'
        + `![原论文 Figure ${ordinal}：原始图注](${figure.url})\n\n`
        + `*论文图 ${ordinal}。原论文 Figure ${ordinal}：“原始图注”。*`;
    paper.apiReaderFigures.push(figure);
    paper.apiReaderPlan.figurePlacements.push({ figureOrdinal: ordinal, marker,
        targetKind: 'component', focusPoints: ['核对原图方向'] });
    paper.apiReaderArticle += `\n\n图前新增导读。\n\n${block}\n\n图后新增解释。`;
    refreshBoundSample(paper);
    return { marker, block };
}

test('修订参考只逆转精确来源图块，保留导读、解释和旧计划', () => {
    const paper = createReaderPaperSample();
    const firstFigure = addBoundFigure(paper, 1);
    const secondFigure = addBoundFigure(paper, 2);
    assert.equal(hasValidApiReaderV3Records(paper), true);
    const originalPaper = JSON.stringify(paper);
    const seed = prepareApiReaderRevisionSeed(paper, sourceText, '只修事实');
    const reference = JSON.parse(seed.initialDraft);
    assert.ok(reference.article.includes(firstFigure.marker));
    assert.ok(reference.article.includes(secondFigure.marker));
    assert.equal(reference.article.includes('看图路径'), false);
    assert.equal(reference.article.includes('![原论文'), false);
    assert.equal(reference.article.includes('*论文图'), false);
    assert.ok(reference.article.includes('图前新增导读。'));
    assert.ok(reference.article.includes('图后新增解释。'));
    assert.deepEqual(reference.plan, paper.apiReaderPlan);
    assert.equal(seed.metadata.revisionSeedSha256, sha(seed.initialDraft));
    assert.equal(seed.metadata.revisionSeedArticleSha256, paper.apiReaderArticleSha256);
    assert.equal(JSON.stringify(paper), originalPaper);
});

test('不精确或重复的完整图块不能靠修订参考猜测删改', () => {
    for (const scenario of ['修改图注', '重复整块']) {
        const paper = createReaderPaperSample();
        const figureSample = addBoundFigure(paper, 1);
        if (scenario === '修改图注') {
            paper.apiReaderArticle = paper.apiReaderArticle.replace('：“原始图注”。*', '：“另一解释”。*');
        } else {
            paper.apiReaderArticle += `\n\n${figureSample.block}`;
        }
        refreshBoundSample(paper);
        assert.throws(() => prepareApiReaderRevisionSeed(paper, sourceText, '修事实'),
            /无法精确重放 Figure 1 注入块/);
    }
});

test('原始公式只从修订正文逆回标记，TeX 和来源记录仍保留在计划', () => {
    const analyzer = require('../scripts/deep-analyzer.js');
    const paper = createReaderPaperSample();
    const html = '<div class="ltx_equation" id="E1"><math display="block"><semantics>'
        + '<mtext>x equals y</mtext><annotation encoding="application/x-tex">x=y</annotation>'
        + '</semantics></math></div>';
    const artifacts = analyzer.bindStructuredArtifactsToText(
        analyzer.parseArxivStructuredArtifactsFromHtml(html, paper.arxivId, paper.arxivId), sourceText
    );
    const requestedBindings = [{ formulaOrdinal: 1, targetKind: 'component', marker: '[[FORMULA_1]]' }];
    const bound = analyzer.bindApiReaderSourceEvidence('[[FORMULA_1]]', [], requestedBindings,
        { sourceText, structuredArtifacts: artifacts,
            sections: [{ kind: 'component', heading: '公式说明', body: '[[FORMULA_1]]' }] });
    paper.apiReaderPlan.formulaBindings = bound.formulaBindings;
    paper.apiReaderPlan.structuredSourcePayload = bound.structuredSourcePayload;
    paper.apiReaderArticle += `\n\n公式前解释。\n\n${bound.article}\n\n公式后解释。`;
    paper.apiReaderPlan.sourceBindingsSha256 = stableFingerprint({ tableBindings: [], formulaBindings: bound.formulaBindings });
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = artifacts.payloadSha256;
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    stage.structuredArtifactsSha256 = artifacts.payloadSha256;
    stage.formulaBindingCount = 1;
    stage.sourceBindingsSha256 = paper.apiReaderPlan.sourceBindingsSha256;
    refreshBoundSample(paper);
    assert.equal(hasValidApiReaderV3Records(paper), true);
    const seed = prepareApiReaderRevisionSeed(paper, sourceText, '修正事实');
    const reference = JSON.parse(seed.initialDraft);
    assert.ok(reference.article.includes('[[FORMULA_1]]'));
    assert.equal(reference.article.includes(bound.article), false);
    assert.ok(reference.article.includes('公式前解释。'));
    assert.ok(reference.article.includes('公式后解释。'));
    assert.deepEqual(reference.plan.formulaBindings, bound.formulaBindings);
    assert.equal(reference.plan.structuredSourcePayload, bound.structuredSourcePayload);
    const originalSeedSha256 = seed.metadata.revisionSeedSha256;
    paper.apiReaderPlan.formulaBindings[0].renderedBlockSha256 = 'f'.repeat(64);
    refreshBoundSample(paper);
    assert.throws(() => prepareApiReaderRevisionSeed(paper, sourceText, '修正事实'),
        /定向修订需要完整的读者文章/);
    assert.equal(sha(seed.initialDraft), originalSeedSha256);
});

test('旧Reader自洽SHA仍不能给残留术语组合标记授予资格', () => {
    const deep = require('../scripts/deep-analyzer');
    const validSample = createReaderPaperSample();
    assert.equal(hasValidApiReaderV3Records(validSample), true);
    for (const marker of ['[[CONCEPT_BRIDGE_0]]', '[[CONCEPT_BRIDGE_99]]']) {
        const sample = createReaderPaperSample();
        sample.apiReaderArticle += '\n\n' + marker;
        sample.apiReaderArticleSha256 = sha(sample.apiReaderArticle);
        sample.analysisManifest.stages.apiReaderArticle.articleSha256 = sample.apiReaderArticleSha256;
        const original = JSON.stringify(sample);
        assert.equal(hasValidApiReaderV3Records(sample), false);
        assert.equal(JSON.stringify(sample), original);
        assert.equal(deep.findUnassembledApiReaderConceptMarker(sample.apiReaderArticle), marker);
    }
});

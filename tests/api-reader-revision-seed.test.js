const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    prepareApiReaderRevisionSeed,
    buildApiReaderGenerationStart,
    stableFingerprint
} = require('../scripts/deep-analyzer.js');
const { apiReaderV3BindsCanonical } = require('../scripts/analysis-engine.js');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sourceText = 'This is the same verified paper source used to produce the Reader.';

function fixture() {
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
    assert.equal(apiReaderV3BindsCanonical(paper), true, 'fixture must satisfy the production validator');
    return paper;
}

test('feedback revision seeds exact signed article and plan, with source and revision hashes', () => {
    const paper = fixture();
    const before = JSON.stringify(paper);
    const seed = prepareApiReaderRevisionSeed(paper, sourceText, '只修正图的颜色对应');
    assert.deepEqual(JSON.parse(seed.initialDraft), { article: paper.apiReaderArticle, plan: paper.apiReaderPlan });
    assert.equal(seed.metadata.revisionMode, 'api-reader-signed-revision-v1');
    assert.equal(seed.metadata.revisionSeedSha256, sha(seed.initialDraft));
    assert.equal(seed.metadata.revisionSeedArticleSha256, paper.apiReaderArticleSha256);
    assert.equal(seed.metadata.revisionSeedPlanSha256, paper.apiReaderPlanSha256);
    assert.equal(seed.metadata.revisionSeedSourceSha256, sha(sourceText));
    assert.equal(seed.metadata.revisionTemperature, 0.1);
    assert.equal(JSON.stringify(paper), before, 'seed preparation must be read-only');
});

test('seeded generation starts at repair temperature and requests full schema without rewriting correct content', () => {
    const paper = fixture();
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

test('default generation and no-feedback refresh do not seed or change temperature', () => {
    assert.equal(prepareApiReaderRevisionSeed({}, 'irrelevant', ''), null);
    const start = buildApiReaderGenerationStart({});
    assert.equal(start.previousDraft, '无');
    assert.equal(start.temperature, 0.6);
    assert.equal(start.isRevision, false);
    assert.equal(start.reviewFeedbackPrefix, '');
});

test('incomplete, tampered, stale-stage and wrong-source Readers fail closed as revision seeds', () => {
    for (const tamper of [
        paper => { paper.apiReaderArticle += '未签名改写'; },
        paper => { paper.apiReaderPlan.sections[0].heading = '未签名标题'; },
        paper => { paper.analysisManifest.stages.apiReaderArticle.status = 'pending'; },
        paper => { paper.analysisManifest.stages.apiReaderArticle.planSha256 = 'b'.repeat(64); },
        paper => { paper.analysisManifest.stages.apiReaderArticle.figuresSha256 = 'b'.repeat(64); },
        paper => { paper.latestAnalysisAttemptError = 'latest attempt failed'; }
    ]) {
        const paper = fixture();
        tamper(paper);
        assert.throws(() => prepareApiReaderRevisionSeed(paper, sourceText, '修正事实'), /已签名 Reader/);
    }
    assert.throws(() => prepareApiReaderRevisionSeed(fixture(), sourceText + 'changed', '修正事实'), /来源 SHA 不一致/);
    assert.throws(() => prepareApiReaderRevisionSeed({}, sourceText, '修正事实'), /已签名 Reader/);
});

test('caller-supplied drafts cannot bypass seed validation and changed signed inputs change the seed identity', () => {
    const paper = fixture();
    const seed = prepareApiReaderRevisionSeed(paper, sourceText, '修正事实');
    assert.throws(() => buildApiReaderGenerationStart(paper, {
        reviewFeedback: '修正事实', sourceText, initialDraft: seed.initialDraft + 'forged'
    }), /未验证底稿/);
    assert.throws(() => buildApiReaderGenerationStart(paper, { sourceText, initialDraft: seed.initialDraft }), /未验证底稿/);
    paper.apiReaderArticle += '\n\n另一次已签名修订。';
    paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
    paper.analysisManifest.stages.apiReaderArticle.articleSha256 = paper.apiReaderArticleSha256;
    const next = prepareApiReaderRevisionSeed(paper, sourceText, '修正事实');
    assert.notEqual(next.metadata.revisionSeedSha256, seed.metadata.revisionSeedSha256);
    assert.notEqual(stableFingerprint(next.metadata), stableFingerprint(seed.metadata));
});

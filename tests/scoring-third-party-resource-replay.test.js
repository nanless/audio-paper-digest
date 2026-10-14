'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const replay = require('../scripts/lib/scoring-third-party-resource-replay');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
};
function sign(identity) {
    const { identitySha256, ...body } = identity;
    return { ...body, identitySha256: sha(JSON.stringify(stable(body))) };
}
function createResourceReplaySample(type = 'third_party') {
    const source = type === 'third_party'
        ? 'We initialize the baseline with OtherLib: https://example.com/otherlib.'
        : { code: 'Our code is available at https://example.com/code.',
            model: 'Our model weights are available at https://example.com/code.',
            dataset: 'Our dataset is available at https://example.com/code.',
            demo: 'Our audio demo is available at https://example.com/code.' }[type];
    const url = type === 'third_party' ? 'https://example.com/otherlib' : 'https://example.com/code';
    const resource = { type, origin: 'paper_source', sourceQuote: source,
        sourceQuoteSha256: sha(source), originalUrl: url, finalUrl: url,
        redirects: [], status: 200, availability: 'available', retryable: false };
    const previous = sign({ contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: sha(source), resources: [resource] });
    const latest = sign({ ...previous, resources: [{ ...resource, status: null,
        availability: 'temporarily_unreachable', retryable: true,
        failureCode: 'PUBLIC_RESOURCE_DEADLINE_EXCEEDED' }] });
    const structural = '## 核心摘要\n正确摘要与数字不变。\n\n## 开源详情\n- 代码：未提及。';
    const input = deep.applyApiReaderResourceAvailability(structural, previous);
    const output = input + '\n原评分理由。';
    const evidence = deep.buildStageEvidenceContext('scoringAudit', input, source);
    const paper = { analysisStageCheckpoints: { scoringAudit: output },
        analysisManifest: { stages: { scoringAudit: { status: 'complete',
            scoringInputSha256: sha(input), evidenceSha256: sha(evidence),
            outputAnalysisSha256: sha(output), updatedAt: '2026-10-12T00:00:00+08:00' } } } };
    const helpers = { verify: deep.replayVerifiedReaderResourceIdentity,
        apply: deep.applyApiReaderResourceAvailability,
        evidence: (analysis, text) => deep.buildStageEvidenceContext('scoringAudit', analysis, text) };
    return { source, previous, latest, structural, input, output, paper, helpers };
}
function prepare(sample) {
    return replay.prepareReplay(sample.paper, sample.previous, sample.latest,
        sample.structural, sample.source, sample.helpers);
}

test('第三方仅可达状态变化精确复用原评分输入与原输出，下一恢复仍使用原审计状态', () => {
    const sample = createResourceReplaySample();
    const originalStage = JSON.stringify(sample.paper.analysisManifest.stages.scoringAudit);
    const result = prepare(sample);
    assert.ok(result);
    assert.equal(result.analysis, sample.input);
    assert.equal(result.output, sample.output);
    assert.equal(JSON.stringify(sample.paper.analysisManifest.stages.scoringAudit), originalStage);
    assert.notEqual(deep.applyApiReaderResourceAvailability(sample.structural, sample.latest), sample.input);
    sample.paper.analysisManifest.scoringResourceInputReplay = result.metadata;
    sample.previous = sample.latest;
    assert.equal(prepare(sample).analysis, sample.input);
});

test('作者代码、资源归属与来源变化、原签输入或输出改变均不能取得复用', () => {
    for (const type of ['code', 'model', 'dataset', 'demo']) {
        assert.equal(prepare(createResourceReplaySample(type)), null);
    }
    for (const change of [
        sample => { sample.structural += '\n新事实或核心摘要改变。'; },
        sample => { sample.paper.analysisManifest.stages.scoringAudit.evidenceSha256 = '0'.repeat(64); },
        sample => { sample.paper.analysisStageCheckpoints.scoringAudit += '\n被改的评分。'; },
        sample => { sample.latest.resources[0].sourceQuote += ' altered'; sample.latest = sign(sample.latest); },
        sample => { sample.latest.resources[0].type = 'code'; sample.latest = sign(sample.latest); },
        sample => { sample.latest.resources[0].finalUrl += '/changed'; sample.latest = sign(sample.latest); },
        sample => { sample.latest.resources[0].license = 'new-license'; sample.latest = sign(sample.latest); }
    ]) {
        const sample = createResourceReplaySample();
        change(sample);
        assert.equal(prepare(sample), null);
    }
});

test('正常评分分支保留第三方状态变化的已签阶段，作者资源变化仍进入评分请求', async t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const filename = path.join(__dirname, '../scripts/deep-analyzer.js');
    const production = fs.readFileSync(filename, 'utf8');
    const begin = production.indexOf('    // 评分前，先核对资源链接的来源和可达状态，再同步开源声明。',
        production.indexOf('async function analyzePaperDeep'));
    const end = production.indexOf('    // 保留 13 节 analysis 与评分作为机器兼容层。', begin);
    assert.ok(begin > 0 && end > begin);
    // Execute the production scoring branch. Resource transport and a new scoring request are
    // intercepted; all current fingerprint checks and the public source replay remain real.
    const extension = `
module.exports.createScoringReplaySampleStage = function(sample) {
 const input = sample.input;
 const evidence = buildStageEvidenceContext('scoringAudit', input, sample.source);
 const audit = {evidenceProfile:{}};
 return {status:'complete', model:DEEP_CONFIG.model,
 protocol:detectApiType(DEEP_CONFIG.endpoint, DEEP_CONFIG.model),
 endpointSha256:crypto.createHash('sha256').update(DEEP_CONFIG.endpoint).digest('hex'),
 maxTokens:16000,maxResponseBytes:API_MAX_RESPONSE_BYTES,temperature:SCORING_AUDIT_TEMPERATURE,
 promptTextContract:currentPromptTextContract('scoringAudit'),
 promptTemplateSha256:promptTemplateSha256(promptFilePathForContract('scoringAudit',currentPromptTextContract('scoringAudit'))),
 ...modelTextFingerprintFields(input,evidence),
 scoringInputSha256:crypto.createHash('sha256').update(input).digest('hex'),
 coreSummaryInputAnalysisSha256:crypto.createHash('sha256').update(sample.structural).digest('hex'),
 inputCoreSummarySha256:crypto.createHash('sha256').update(extractSectionByTitle(input,'核心摘要')).digest('hex'),
 outputCoreSummarySha256:crypto.createHash('sha256').update(extractSectionByTitle(sample.output,'核心摘要')).digest('hex'),
 evidenceSelectionVersion:EVIDENCE_SELECTION_VERSION,evidenceMaxChars:SCORING_EVIDENCE_MAX_CHARS,
 evidenceSha256:crypto.createHash('sha256').update(evidence).digest('hex'),
 scoringContract:SCORING_AUDIT_CONTRACT,resourceNormalizationContract:SCORING_RESOURCE_NORMALIZATION_CONTRACT,
 requestFormatContract:SCORING_REQUEST_FORMAT_CONTRACT,capRulesVersion:SCORING_CAP_RULES_VERSION,
 ...(resolveAuxiliaryRequestPolicy('scoringAudit')?{auxiliaryRequestPolicy:resolveAuxiliaryRequestPolicy('scoringAudit')} : {}),
 stabilityResolution:{contract:SCORING_STABILITY_RESOLUTION_CONTRACT,status:'not_required',threshold:SCORING_STABILITY_THRESHOLD},
 audit,auditSha256:stableFingerprint(audit),outputAnalysisSha256:crypto.createHash('sha256').update(sample.output).digest('hex')};
};
module.exports.executeScoringReplaySample = async function(paper, rawTextForAnalysis, latestIdentity) {
 const options={};
 const analysisManifest=paper.analysisManifest;
 const imageManifest=[];
 const sourceDetails={structuredArtifacts:null};
 let analysis=paper.analysisStageCheckpoints.scoringAudit;
 const originalBuilder=buildApiReaderResourceIdentity;
 const originalAudit=auditTypeAwareScoringDetailed;
 let scoringRequests=0;
 buildApiReaderResourceIdentity=async()=>latestIdentity;
 auditTypeAwareScoringDetailed=async()=>{scoringRequests++;throw Object.assign(new Error('CONTROLLED_SCORING_REQUEST'),{code:'CONTRACT_REJECTED'});};
 try { ${production.slice(begin, end)}
 return {analysis,scoringRequests};
 } catch(error){return {error:error.message,scoringRequests};}
 finally{buildApiReaderResourceIdentity=originalBuilder;auditTypeAwareScoringDetailed=originalAudit;}
};`;
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = module.paths;
    loaded._compile(production + extension, filename);
    const runtime = loaded.exports;
    for (const type of ['third_party', 'code']) {
        const sample = createResourceReplaySample(type);
        sample.paper.analysisStageCheckpoints.coreSummaryRepair = sample.structural;
        sample.paper.analysisManifest.stages.coreSummaryRepair = { outputAnalysisSha256: sha(sample.structural) };
        sample.paper.analysisManifest.stages.openSourceScan = {};
        sample.paper.apiReaderResources = sample.previous;
        sample.paper.analysisManifest.stages.scoringAudit = runtime.createScoringReplaySampleStage(sample);
        const originalStage = JSON.stringify(sample.paper.analysisManifest.stages.scoringAudit);
        const result = await runtime.executeScoringReplaySample(sample.paper, sample.source, sample.latest);
        if (type === 'third_party') {
            assert.equal(result.error, undefined);
            assert.equal(result.scoringRequests, 0);
            assert.equal(result.analysis, sample.output);
            assert.equal(JSON.stringify(sample.paper.analysisManifest.stages.scoringAudit), originalStage);
            assert.deepEqual(sample.paper.apiReaderResources, sample.latest);
        } else {
            assert.equal(result.error, 'CONTROLLED_SCORING_REQUEST');
            assert.equal(result.scoringRequests, 1);
            assert.equal(sample.paper.analysisManifest.scoringResourceInputReplay, undefined);
        }
    }
});

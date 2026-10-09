'use strict';
process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.invalid/v1';
process.env.PAPER_ANALYZER_API_KEY = 'test-key';
process.env.PAPER_ANALYZER_MODEL = 'test-model';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const registry = require('../scripts/lib/prompt-text-versions.js');
const deep = require('../scripts/deep-analyzer.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const changed = ['primaryAnalysis','openSourceScan','revision','apiReaderArticle','apiReaderRepair','scoringAudit','imageSupplement'];
test('改写阶段分别读取 v1、v2、v3 原路径，旧版本不能解析成当前版本', () => {
    for (const stage of changed) {
        const v1 = registry.promptFilePathForContract(stage, '');
        const v2 = registry.promptFilePathForContract(stage, 'analysis-prompt-text-v2');
        const v3 = registry.promptFilePathForContract(stage, 'analysis-prompt-text-v3');
        assert.equal(registry.currentPromptTextContract(stage), ['primaryAnalysis','scoringAudit'].includes(stage) ? 'analysis-prompt-text-v4' : 'analysis-prompt-text-v3');
        assert.equal(v2, v1.replace('.md', '-v2.md'));
        assert.equal(v3, v1.replace('.md', '-v3.md'));
        assert.notEqual(deep.runtimePromptTemplateSha256(v2), deep.runtimePromptTemplateSha256(v3));
        assert.throws(() => registry.promptFilePathForContract(stage, 'analysis-prompt-text-v9'), /没有登记/);
    }
    for (const stage of ['visualSummary','digestCover','tableRepair','methodRepair','tagSelection','coreSummaryRepair','structureRepair']) {
        assert.equal(registry.currentPromptTextContract(stage), 'analysis-prompt-text-v2');
        assert.throws(() => registry.promptFilePathForContract(stage, 'analysis-prompt-text-v3'), /没有登记/);
    }
});
test('已完成的 v2 修订记录按原版本核验，保留 v2 身份；新请求使用不同的 v3 指纹', () => {
    const input = validAnalysisText(), source = 'Speech recognition source evidence.';
    const evidence = deep.buildStageEvidenceContext('revision', input, source);
    const oldFingerprint = deep.buildTextStageFingerprint('revision', input, evidence, 'analysis-prompt-text-v2');
    const newFingerprint = deep.buildTextStageFingerprint('revision', input, evidence, 'analysis-prompt-text-v3');
    assert.notEqual(oldFingerprint, newFingerprint);
    const paper = { analysisCheckpoint: input, analysisStageCheckpoints: { revision: input } };
    const manifest = { version: 1, stages: { revision: { status: 'complete', fingerprint: oldFingerprint,
        promptTextContract: 'analysis-prompt-text-v2' } } };
    const before = JSON.stringify({paper,manifest});
    const prepared = deep.prepareTextRecoveryStage(paper, manifest, 'revision', input, source);
    assert.equal(prepared.fingerprint, oldFingerprint);
    assert.equal(manifest.stages.revision.promptTextContract, 'analysis-prompt-text-v2');
    assert.equal(JSON.stringify({paper,manifest}), before);
    const fresh = deep.prepareTextRecoveryStage({analysisCheckpoint:input}, {version:1,stages:{}}, 'revision', input, source);
    assert.equal(fresh.fingerprint, newFingerprint);
});

test('旧摘要修正使用真实归档字节通过原 SHA 门槛，只迁移到 v2；v3 目标被拒绝且不改记录', () => {
    const history = require('../scripts/lib/prompt-history.js');
    const names = {primaryAnalysis:'deep-analysis',openSourceScan:'opensource-scan',revision:'gap-fill',
        tableRepair:'table-fill',methodRepair:'method-fill',coreSummaryRepair:'core-summary-repair',structureRepair:'structure-repair'};
    const archived = new Map();
    for (const [stage, expected] of Object.entries(deep.CORE_SUMMARY_V3_V1_RUNTIME_PROMPT_SHA256)) {
        const contract = ['primaryAnalysis','coreSummaryRepair'].includes(stage) ? 'core-summary-detailed-v3' : '';
        const bytes = history.historicalPromptTemplateBytesForSha256(expected, contract);
        assert.ok(bytes, `原许可的提示词 ${stage} 必须存在真实归档字节`);
        archived.set(path.resolve(__dirname,'../prompts',names[stage]+'.md'), bytes);
    }
    const source = 'source evidence without experimental tables', text = 'actual primary input with sufficient source evidence';
    const body = validAnalysisText(), id = '2602.05847';
    const paper = {arxivId:id,title:'OmniVideo-R1',authors:['A'],categories:['cs.SD'],analysisCheckpoint:body,
        analysisStageCheckpoints:Object.fromEntries(['primaryAnalysis','openSourceScan','demoLinkScan','revision',
        'tableRepair','methodRepair','coreSummaryRepair','structureRepair','scoringAudit'].map(s=>[s,body]))};
    const manifest = {version:1,sourceAcquisition:{sourceSha256:crypto.createHash('sha256').update(source).digest('hex')},
        contracts:{experimentTables:'bounded-v1',methodDetail:'detailed-v1',editorialLeakage:'high-confidence-v1'},
        stages:Object.fromEntries(['primaryAnalysis','openSourceScan','revision','tableRepair','methodRepair',
        'coreSummaryRepair','structureRepair'].map(s=>[s,{status:'complete'}]))};
    manifest.stages.demoLinkScan={status:'not_needed',fingerprint:deep.stableFingerprint({implementation:'demo-link-scan-v2-resource-identity'})};
    manifest.stages.primaryAnalysis.fingerprint=deep.buildLegacyCoreSummaryV2PrimaryFingerprint(paper,text,id);
    for (const stage of ['openSourceScan','revision','tableRepair','methodRepair','coreSummaryRepair','structureRepair']) {
        const evidence=deep.buildLegacyCoreSummaryV2EvidenceContext(stage,body,source);
        manifest.stages[stage].fingerprint=deep.buildLegacyCoreSummaryV2TextFingerprint(stage,body,evidence);
    }
    const targetFor = contract => deep.buildRecoveryFingerprints(paper,text,id,{version:1,stages:{primaryAnalysis:{
        status:'complete',promptTextContract:contract}}}).primaryAnalysis;
    const v2Target=targetFor('analysis-prompt-text-v2'), v3Target=targetFor('analysis-prompt-text-v3');
    assert.notEqual(v2Target,v3Target);
    const originalRead=fs.readFileSync;
    fs.readFileSync=function(file,options){const bytes=archived.get(path.resolve(String(file)));
        if(!bytes)return originalRead.apply(this,arguments);
        return typeof options==='string'||options?.encoding ? bytes.toString(typeof options==='string'?options:options.encoding) : Buffer.from(bytes);};
    try {
        assert.equal(deep.currentCoreSummaryV3MigrationPromptsAreExact(),true);
        const untouched=JSON.stringify({paper,manifest});
        assert.equal(deep.tryMigrateCoreSummaryV3LegacyCheckpoints(paper,manifest,text,source,id,v3Target),false);
        assert.equal(JSON.stringify({paper,manifest}),untouched);
        assert.equal(deep.tryMigrateCoreSummaryV3LegacyCheckpoints(paper,manifest,text,source,id,v2Target),true);
        for(const stage of ['primaryAnalysis','openSourceScan','revision','tableRepair','methodRepair'])
            assert.equal(manifest.stages[stage].promptTextContract,'analysis-prompt-text-v2');
        assert.equal(manifest.stages.primaryAnalysis.fingerprint,v2Target);
        assert.notEqual(manifest.stages.primaryAnalysis.fingerprint,v3Target);
    } finally {fs.readFileSync=originalRead;}
});

test('旧 v2 文件 SHA 在空归档目录下仍可找到原文件，未知 SHA 不会被当前版本替代', () => {
    const history = require('../scripts/lib/prompt-history.js');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(),'prompt-v2-no-archive-'));
    try {
        for (const stage of changed) {
            const filename = registry.promptFilePathForContract(stage,'analysis-prompt-text-v2');
            const original = fs.readFileSync(path.resolve(__dirname,'..',filename));
            const declaredSha = crypto.createHash('sha256').update(original).digest('hex');
            assert.deepEqual(history.promptBytesForSha256(stage,declaredSha,dir),original);
            assert.equal(history.promptBytesForSha256(stage,'0'.repeat(64),dir),null);
        }
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

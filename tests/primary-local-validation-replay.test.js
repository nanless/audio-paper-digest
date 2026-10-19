'use strict';
// Synthetic fixtures only: these tests cannot certify a real paper, source, paid response or publication.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const helper = require('../scripts/lib/primary-local-validation-replay');
const repair = require('../scripts/lib/primary-fact-local-repair');
const engine = require('../scripts/analysis-engine'), config = require('../scripts/config');
function sample() {
    const input = '## 评分\n6/10\n\n## 核心摘要\n受保护摘要。\n\n## 实验结果\n原段只写无掩码基线。其它数字14.9°和条件保持。\n\n独立的受保护长段，用于验证局部段落的外部字节不能被修改。\n\n## 核心创新点\n受保护创新点。\n';
    const feedback = { coreAnalysisSha256: repair.sha(input), primaryFeedback: '该基线仍使用random掩码。', rejectedPrimaryClaims: ['无掩码基线'] };
    const plan = repair.buildPlan(input, feedback);
    const result = repair.applyPatch(input, plan, { contract: repair.CONTRACT, inputSha256: plan.inputSha256,
        replacements: [{ from: plan.targets[0].text, to: plan.targets[0].text.replace('无掩码基线', 'random掩码未适配基线') }] });
    return { input, feedback, ...result };
}
test('normal bounded patch receipt proves saved before/after relation and preserves exterior', () => {
    const p = sample();
    assert.deepEqual(helper.primaryPatchProof(p.input, p.analysis, p.feedback, p.receipt), {
        targetCount: 1, beforeSha256: repair.sha(p.input), afterSha256: repair.sha(p.analysis), protectedExteriorUnchanged: true });
    for (const output of [p.analysis.replace('受保护摘要', '擅改摘要'), p.analysis + '额外正文']) {
        const receipt = { ...p.receipt, outputSha256: repair.sha(output) };
        assert.throws(() => helper.primaryPatchProof(p.input, output, p.feedback, receipt), /获准|原字节/);
    }
    assert.throws(() => helper.primaryPatchProof(p.input, p.analysis, p.feedback, { ...p.receipt, inputSha256: '0'.repeat(64) }), /输入或输出SHA/);
});
test('public cold engine refuses missing operation independently of all other incomplete-paper gates', () => {
    const paper = { arxivId: '2601.00001v1', analysisManifest: { contracts: {}, stages: {
        primaryAnalysis: { primaryLocalFactRepair: {} }, revision: { localFactValidation: { contract: 'primary-local-fact-validation-v1' } } } } };
    assert.match(engine.getIncompleteAnalysisContentReason(paper), /兼容操作与必需合同/);
    paper.analysisManifest.contracts.primaryLocalValidationReplay = { contract: helper.CONTRACT, operationSha256: 'a'.repeat(64) };
    assert.match(engine.getIncompleteAnalysisContentReason(paper), /兼容操作与必需合同/);
    paper.analysisManifest.compatibilityMigrations = [{ contract: helper.CONTRACT, operationSha256: 'b'.repeat(64) }];
    assert.match(engine.getIncompleteAnalysisContentReason(paper), /兼容操作与必需合同/);
});
test('real request-body identity and unique normal usage pair are required, not merely same response hash', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'primary-local-replay-test-'));
    const old = config.FILES.llmUsageDir; config.FILES.llmUsageDir = temp;
    const eventId = crypto.randomUUID(), inputSha256 = repair.sha('synthetic full Responses request JSON');
    const paper = { arxivId: '2601.00001v1', freshRewriteProvenance: { runId: crypto.randomUUID() } };
    const receipt = { responseSha256: repair.sha('synthetic saved response') };
    const expected = { inputSha256, model: 'synthetic-model', protocol: 'openai_responses' };
    const base = { version: 'llm-usage-v1', eventId, runtime: 'node', runId: paper.freshRewriteProvenance.runId,
        paperId: paper.arxivId, stage: 'primaryAnalysis', unitId: repair.sha('unit'), transportAttempt: 1, ...expected };
    const started = { ...base, kind: 'request_started', at: '2026-01-01T00:00:00.000Z', phase: 'authorized_before_transport', outcome: 'result_unknown', chargeState: 'unknown' };
    const completed = { ...base, kind: 'request', at: '2026-01-01T00:00:01.000Z', outcome: 'completed', transportStarted: true,
        statusCode: 200, errorCode: null, outputTextSha256: receipt.responseSha256, usage: { status: 'reported', totalTokens: 12 } };
    const files = [path.join(temp, crypto.randomUUID() + '.json'), path.join(temp, crypto.randomUUID() + '.json')];
    function write(pair) { pair.forEach((value, index) => fs.writeFileSync(files[index], JSON.stringify(value))); }
    try {
        write([started, completed]);
        const pinned = helper.paidProof(paper, receipt, undefined, expected);
        assert.equal(pinned.length, 2);
        assert.deepEqual(helper.paidProof(paper, receipt, pinned, expected), pinned);
        for (const mutate of [
            pair => pair.forEach(e => { e.inputSha256 = '0'.repeat(64); }),
            pair => pair.forEach(e => { e.model = 'wrong-model'; }),
            pair => pair.forEach(e => { e.protocol = 'wrong-protocol'; }),
            pair => { pair[0].phase = 'not-authorized'; },
            pair => { pair[0].stage = 'revision'; },
            pair => { pair[0].version = 'unknown'; },
            pair => { pair[1].runtime = 'python'; },
            pair => { pair[1].at = 'invalid-time'; },
            pair => { pair[1].usage.totalTokens = 0; },
            pair => { pair[1].eventId = 'not-a-uuid'; }
        ]) {
            const pair = structuredClone([started, completed]); mutate(pair); write(pair);
            assert.throws(() => helper.paidProof(paper, receipt, undefined, expected));
        }
        write([started, completed]); fs.appendFileSync(files[0], '\n');
        assert.throws(() => helper.paidProof(paper, receipt, pinned, expected), /字节变化/);
        write([started, completed]);
        const duplicate = path.join(temp, crypto.randomUUID() + '.json'); fs.copyFileSync(files[1], duplicate);
        assert.throws(() => helper.paidProof(paper, receipt, undefined, expected), /唯一真实完成请求/);
    } finally { config.FILES.llmUsageDir = old; fs.rmSync(temp, { recursive: true, force: true }); }
});

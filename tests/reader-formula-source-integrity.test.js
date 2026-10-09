'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
function fixture(latex, visible = 'CTCLoss divided by max(token count, 10)') {
    const html = '<html><body><div class="ltx_equation" id="S1.E1"><math display="block"><semantics>'
        + '<mtext>' + visible + '</mtext><annotation encoding="application/x-tex">' + latex
        + '</annotation></semantics></math></div></body></html>';
    const sourceText = cheerio.load(html)('body').text();
    const structuredArtifacts = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html, '2601.12345v1', '2601.12345v1'), sourceText);
    const draft = { sections: [{ kind: 'component', heading: '训练目标', body: '[[FORMULA_1]]' }],
        formulaBindings: [{ formulaOrdinal: 1, targetKind: 'component', marker: '[[FORMULA_1]]' }],
        tableBindings: [], figurePlacements: [], conceptBridges: [] };
    return { sourceText, structuredArtifacts, draft,
        bind: () => deep.bindApiReaderSourceEvidence('[[FORMULA_1]]', [], draft.formulaBindings,
            { sourceText, structuredArtifacts, sections: draft.sections }) };
}
test('真实 HTML 的截断 TeX 不因 CTCLoss/max 两个词被猜补为分母 5', () => {
    const f = fixture(String.raw`S_{\text{ctc}}(y,X)=-`);
    assert.equal(f.structuredArtifacts.formulas[0].latex, String.raw`S_{\text{ctc}}(y,X)=-`);
    assert.throws(f.bind, /formulaBindings\[0\].*等号后截断.*不能猜补/);
    const evidence = deep.buildApiReaderArtifactEvidence(f.structuredArtifacts);
    assert.match(evidence, /FORMULA_ORDINALS_AVAILABLE: \[\]/);
    assert.doesNotMatch(evidence, /FORMULA_1:/);
});
test('完整原始 TeX 保留运算和常数，不能改写为另一篇论文的固定公式', () => {
    for (const latex of [String.raw`S_{\text{ctc}}(y,X)=-\frac{\mathrm{CTCLoss}(y,X)}{\max(|y|,10)}`,
        'x=y', String.raw`C^*`]) {
        const f = fixture(latex);
        const result = f.bind();
        assert.equal(result.formulaBindings[0].latex, latex);
        assert.equal(result.article, `\\[${latex}\\]`);
        assert.match(deep.buildApiReaderArtifactEvidence(f.structuredArtifacts), /FORMULA_ORDINALS_AVAILABLE: \[1\]/);
    }
});
test('截断公式错误保留可定位的修复路径，不改变封存来源', () => {
    for (const latex of ['x=', 'x=+', 'x=−']) {
        const f = fixture(latex), before = JSON.stringify(f.structuredArtifacts);
        let error;
        try { f.bind(); } catch (caught) { error = caught; }
        assert.ok(error);
        assert.match(deep.buildApiReaderValidationFeedback(error), /formulaBindings\[0\]/);
        const paths = repair.buildRepairTargets(f.draft, [{ path: null, message: error.message }]).map(target => target.path);
        assert.ok(paths.includes('/formulaBindings/0'));
        assert.ok(paths.includes('/sections/0/body'));
        assert.equal(JSON.stringify(f.structuredArtifacts), before);
    }
});

const guessed = String.raw`\displaystyle S_{\text{ctc}}(y,X)=-\frac{\mathrm{CTCLoss}\big(\log p_{\text{ctc}}(X),\,\mathrm{tok}(y)\big)}{\max(|\mathrm{tok}(y)|,\,5)}`;
const crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
test('原文确实含完整整式时附原始结构化字节，完整原文 SHA 与 TeX 都能重放', () => {
    const f = fixture(guessed), result = f.bind();
    assert.equal(sha(result.structuredSourcePayload), f.structuredArtifacts.payloadSha256);
    assert.equal(deep.readerFormulaSourcePayloadValid(result.formulaBindings[0], result.structuredSourcePayload,
        f.structuredArtifacts.payloadSha256, sha(f.sourceText)), true);
    const original = JSON.parse(result.structuredSourcePayload);
    assert.equal(original.formulas[0].latex, guessed);
    assert.equal(fixture('x=y').bind().structuredSourcePayload, undefined);
});

test('Node 旧自洽猜补缓存拒绝，且新增原始内容不能用自声明或错误 TeX 蒙混', () => {
    const engine = require('../scripts/analysis-engine');
    const paper = require('./valid-analysis-fixture').validLegacyApiAnalysisPaper('2601.12345');
    const f = fixture(guessed), result = f.bind(), plan = paper.apiReaderPlan;
    paper.apiReaderArticle += '\n\n' + result.article;
    plan.formulaBindings = result.formulaBindings;
    const source = { ...JSON.parse(result.structuredSourcePayload), flattenedTextSha256: paper.sourceSha256 };
    let payload = JSON.stringify(source);
    const sourceSha = sha(payload);
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = sourceSha;
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    stage.structuredArtifactsSha256 = sourceSha;
    function reseal() {
        plan.sourceBindingsSha256 = deep.stableFingerprint({ tableBindings: plan.tableBindings, formulaBindings: plan.formulaBindings });
        paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
        paper.apiReaderPlanSha256 = deep.stableFingerprint(plan);
        Object.assign(stage, { articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256,
            sourceBindingsSha256: plan.sourceBindingsSha256, formulaBindingCount: 1 });
    }
    reseal();
    assert.equal(engine.hasValidApiReaderV3Records(paper), false, '旧猜补记录虽输出SHA完全自洽仍拒绝');
    plan.rawTeXVerified = true; reseal();
    assert.equal(engine.hasValidApiReaderV3Records(paper), false, '布尔自声明不能代替原文');
    delete plan.rawTeXVerified;
    plan.structuredSourcePayload = payload; reseal();
    assert.equal(engine.hasValidApiReaderV3Records(paper), true);
    plan.structuredSourcePayload = payload.replace('CTCLoss', 'FakeLoss'); reseal();
    assert.equal(engine.hasValidApiReaderV3Records(paper), false, '改payload后不能只重签plan');
    for (const change of [
        data => { data.formulas[0].latex = String.raw`S_{\text{ctc}}(y,X)=-`; },
        data => { data.formulas[0].ordinal = 2; },
        data => { data.formulas[0].sourceDomSha256 = '0'.repeat(64); },
        data => { data.flattenedTextSha256 = '0'.repeat(64); }
    ]) {
        const altered = structuredClone(source); change(altered);
        plan.structuredSourcePayload = JSON.stringify(altered);
        paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = sha(plan.structuredSourcePayload);
        stage.structuredArtifactsSha256 = sha(plan.structuredSourcePayload); reseal();
        assert.equal(engine.hasValidApiReaderV3Records(paper), false);
    }
});

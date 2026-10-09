'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { savedBytes } = require('./helpers/current-v6-public-pipeline.cjs');
const { validateManualTakeoverManifest } = require('../../scripts/analysis-contract.js');
const CURRENT = 'manual-agents-sol-high-v2';

// 此处独立写出已发布 v5 的输入规则，不调用待测代码计算预期 SHA。
function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    }
    return value;
}
function knownV5Sha(value) {
    return crypto.createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}
function check(paper) {
    return validateManualTakeoverManifest(paper.analysisManifest, paper.sourceSha256, {
        analysis: paper.analysis, imageManifest: paper.imageManifest, expectedModelPolicy: CURRENT
    });
}

test('通过正式入口生成的 native v6 原输出按已知阶段输入规则只读核验，拒绝错误 SHA、双层包装和混用模型规则', t => {
    const raw = savedBytes('canonical');
    const canonical = JSON.parse(raw.toString('utf8'));
    const paper = canonical.papers[0];
    const before = JSON.stringify(paper);
    const takeover = paper.analysisManifest.manualTakeover;
    assert.equal(takeover.version, 2);
    assert.equal(paper.manualDepth, 'full-text-evidence-v6');
    assert.equal(takeover.stageReviews.version, 2);
    assert.equal(takeover.stageReviews.stages.version, undefined);
    for (const [stage, item] of Object.entries(takeover.stageEvidence)) {
        const expected = knownV5Sha({
            stage, executionKind: item.executionKind || null,
            sourceSha256: takeover.sourceSha256, analysisSha256: takeover.analysisSha256,
            claims: item.reviewedClaims, stagePromptSha256: item.promptSha256,
            stageContextSha256: item.contextSha256 || null
        });
        assert.equal(item.inputSha256, expected, stage);
    }
    // 模块已正常导入；这次校验只读传入对象，不借助样例中的旧绝对路径读取文件。
    const mocks = ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'realpathSync']
        .map(name => t.mock.method(fs, name, () => { throw new Error('本次对象校验不应读取文件'); }));
    try {
        assert.equal(check(paper), null);
        const wrongSha = structuredClone(paper);
        wrongSha.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.inputSha256 = '0'.repeat(64);
        assert.match(check(wrongSha), /input|输入|指纹|SHA/i);
        const wrapped = structuredClone(paper);
        const review = wrapped.analysisManifest.manualTakeover;
        review.stageReviews = { version: 2, stages: review.stageReviews };
        review.stageReviewsSha256 = knownV5Sha(review.stageReviews);
        assert.ok(check(wrapped), '重新算对象 SHA 也不能使双层阶段审查格式合法');
        const mixed = structuredClone(paper);
        mixed.analysisManifest.manualTakeover.modelPolicy = 'manual-agents-terra-high-v1';
        assert.ok(check(mixed));
        assert.equal(JSON.stringify(paper), before);
    } finally {
        mocks.forEach(mock => mock.mock.restore());
    }
});

test('全新四角色正式提交后 native v6 生产入口只保存一层阶段审查', () => {
    const script = `
const fs = require('node:fs');
const helper = require('./manual/tests/helpers/current-v6-public-pipeline.cjs');
const fx = helper.createCurrentV6Pipeline();
const Config = require('./scripts/config.js');
Config.CURRENT_DIR = fx.currentDir;
Config.FILES.filteredPapers = fx.filteredPath;
Config.FILES.deepAnalysisResult = fx.canonicalPath;
Config.FILES.manualExternalResourceCache = fx.currentDir + '/manual-external-resource-cache.json';
process.argv = [process.execPath, 'manual-deep-analysis.js', '--date', fx.date, '--spec', fx.specPath, '--v6-production', '--force'];
require('./manual/scripts/manual-deep-analysis.js').run().then(() => {
    const data = JSON.parse(fs.readFileSync(fx.canonicalPath));
    const paper = data.papers[0];
    const review = paper.analysisManifest.manualTakeover.stageReviews;
    const result = {status:data.status, success:data.stats.success, failed:data.stats.failed,
        version:review.version, nestedVersion:review.stages.version,
        exactReview:JSON.stringify(review) === JSON.stringify(fx.spec.papers[fx.id].stageReviews),
        publicError:require('./scripts/analysis-contract.js').validateManualTakeoverManifest(
            paper.analysisManifest,paper.sourceSha256,{analysis:paper.analysis,imageManifest:paper.imageManifest,
                expectedModelPolicy:'manual-agents-sol-high-v2'})};
    console.log('NATIVE_RESULT ' + JSON.stringify(result));
    fs.rmSync(fx.temporaryRoot,{recursive:true,force:true});
}).catch(error=>{console.error(error);fs.rmSync(fx.temporaryRoot,{recursive:true,force:true});process.exitCode=1});
`;
    const child = spawnSync(process.execPath, ['-e', script], {
        cwd:path.resolve(__dirname, '..', '..'), encoding:'utf8', timeout:20000
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const result = JSON.parse(child.stdout.match(/NATIVE_RESULT (\{.*\})/)[1]);
    assert.equal(result.status, 'complete');
    assert.equal(result.success, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.version, 2);
    assert.equal(result.nestedVersion, undefined);
    assert.equal(result.exactReview, true);
    assert.equal(result.publicError, null);
});

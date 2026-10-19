'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');

test('正常主分析入口发送局部JSON并保存新证明，完整审校不再重写全文', async t => {
    const bodies = [];
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            const parsed = JSON.parse(body);
            bodies.push(parsed);
            const prompt = JSON.stringify(parsed.messages);
            let content = '代码：未说明\n模型权重：未说明\n数据集：未说明\nDemo：未说明';
            if (bodies.length === 1) {
                const text = parsed.messages[0].content;
                const inputSha256 = /本次原稿SHA：([a-f0-9]{64})/.exec(text)?.[1];
                const targets = JSON.parse(/获准修改的段落：\n([^\n]+)/.exec(text)[1]);
                content = JSON.stringify({ contract: 'primary-local-fact-repair-v1', inputSha256,
                    replacements: targets.map(target => ({ from: target.text,
                        to: target.text.replace('错误余弦蒸馏损失。', '蒸馏使用冻结文本教师的MSE。') })) });
            }
            assert.ok(bodies.length <= 2, `不应发送整文审校请求：${prompt.slice(0, 100)}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { content } }] }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'primary-local-entry-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const project = path.join(__dirname, '..');
    for (const directory of ['scripts', 'prompts', 'manual', 'config']) {
        fs.cpSync(path.join(project, directory), path.join(folder, directory), { recursive: true });
    }
    require('./helpers/git-prompt-evidence-workspace.cjs').installFixtureGitObjectStore(folder, project);
    fs.mkdirSync(path.join(folder, 'tests'));
    fs.copyFileSync(path.join(__dirname, 'valid-analysis-fixture.js'), path.join(folder, 'tests/valid-analysis-fixture.js'));
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(folder, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(folder, '.env'), `PAPER_ANALYZER_API_KEY=synthetic-local-only\nPAPER_ANALYZER_MODEL=ci-test-model\nPAPER_ANALYZER_ENDPOINT=http://127.0.0.1:${server.address().port}/v1\n`, { mode: 0o600 });
    let prefix = fs.readFileSync(path.join(__dirname, 'daily-fact-review.test.js'), 'utf8')
        .split("test('只读反馈严格绑定")[0];
    prefix = prefix.replace("baseline.replace('## 核心摘要\\n', `## 核心摘要\\n${wrong}`)",
        "baseline.replace('## 实验结果\\n', `## 实验结果\\n${wrong}\\n\\n`)");
    prefix = prefix.replace('imageInfos:[],structuredArtifacts:artifacts',
        "imageInfos:[{url:'https://example.invalid/synthetic-test.png'}],structuredArtifacts:artifacts");
    const program = prefix + `
(async () => {
    const sample = await fixture({ after() {} });
    Object.assign(sample.paper.analysisManifest.sourceAcquisition, {
        usedTextSha256: review.sha(sourceText), sourceId: ID, analysisSource: 'html'
    });
    sample.feedback.coreFeedback = '';
    sample.feedback.readerFeedback = '';
    sample.feedback.rejectedCoreClaims = [];
    sample.feedback.rejectedReaderClaims = [];
    sample.feedback.primaryFeedback = '蒸馏使用冻结文本教师的MSE，只修实验原句。';
    sample.feedback.rejectedPrimaryClaims = [wrong];
    const bound = review.validateFeedback(sample.feedback, sample.plan, sample.paper);
    let primarySaved;
    let localValidationSaved;
    sample.paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')] = paper => {
        if (paper.analysisManifest.stages.primaryAnalysis?.primaryLocalFactRepair && !primarySaved) {
            primarySaved = structuredClone(paper);
        }
        if (paper.analysisManifest.stages.revision?.localFactValidation && !localValidationSaved) {
            localValidationSaved = JSON.parse(JSON.stringify(paper));
            const stage = localValidationSaved.analysisManifest.stages.revision;
            const validation = stage.localFactValidation;
            assert.equal(validation.contract, 'primary-local-fact-validation-v2');
            assert.equal(review.sha(validation.inputAnalysisText), stage.inputAnalysisSha256);
            const prepared = deep.prepareTextRecoveryStage(localValidationSaved,
                localValidationSaved.analysisManifest, 'revision', localValidationSaved.analysisCheckpoint, sourceText);
            assert.equal(prepared.invalidated, false);
            assert.equal(prepared.inputAnalysis, validation.inputAnalysisText);
            assert.equal(prepared.inputAnalysisSha256, stage.inputAnalysisSha256);
            assert.equal(prepared.evidenceSha256, stage.evidenceSha256);
            assert.equal(prepared.fingerprint, stage.fingerprint);
            throw new Error('TEST_LOCAL_VALIDATION_SAVED');
        }
    };
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () =>
        daily.createDailyAnalyzeFn(sample.plan, { analyze: paper => review.withFactReview(bound,
            () => deep.analyzePaperDeep(paper)) })(sample.paper)), /TEST_LOCAL_VALIDATION_SAVED/);
    assert.ok(primarySaved);
    assert.equal(primarySaved.analysisCheckpoint, original.replace(wrong, '蒸馏使用冻结文本教师的MSE。'));
    assert.deepEqual(primarySaved.analysisManifest.stages.primaryAnalysis.factReview, bound.proof);
    assert.equal(localValidationSaved.analysisManifest.stages.revision.status, 'complete');
    assert.equal(require('../scripts/analysis-contract').isRecoveryStageTerminal('revision',
        localValidationSaved.analysisManifest.stages.revision.status), true);
    assert.equal(deep.isRecoveryStageComplete({ stages: {
        revision: localValidationSaved.analysisManifest.stages.revision
    } }, 'revision'), true);
    assert.equal(localValidationSaved.analysisManifest.stages.revision.localFactValidation.contract,
        'primary-local-fact-validation-v2');
    assert.ok(review.validateFeedback(sample.feedback, sample.plan, primarySaved));
    console.log('PUBLIC_LOCAL_PRIMARY_CHECKPOINT_AND_VALIDATION_CONFIRMED');
    fs.rmSync(sample.root, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
    fs.writeFileSync(path.join(folder, 'tests/primary-local-child.cjs'), program);
    const result = await new Promise(resolve => {
        const child = cp.spawn(process.execPath, ['tests/primary-local-child.cjs'], { cwd: folder });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PUBLIC_LOCAL_PRIMARY_CHECKPOINT_AND_VALIDATION_CONFIRMED/);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].max_tokens, 16000);
});

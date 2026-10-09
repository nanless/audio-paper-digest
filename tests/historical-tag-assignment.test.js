'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/historical-tag-assignment.js');
const cli = require('../scripts/historical-tag-assignment.js');
const tagCatalogApi = require('../scripts/lib/tag-catalog.js');
const { parseAnalysis } = require('../scripts/utils.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

const RUN_ID = '77777777-7777-4777-8777-777777777777';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function paper(id = '2609.03622', analysis = validAnalysisText()) {
    return { arxivId: id, paper_id: id, title: `Paper ${id}`, abstract: 'Source abstract', authors: ['Author'],
        categories: ['cs.SD'], analysis, parsed: parseAnalysis(analysis) };
}

function runFixture(t, papers = [paper()]) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-tags-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runDir = path.join(root, 'runs', RUN_ID); fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const analysis = { version: 1, contract: 'fresh-rewrite-analysis-v1', runId: RUN_ID,
        batchDate: '2026-09-04', status: 'complete', generation: 1, papers };
    const bytes = Buffer.from(`${JSON.stringify(analysis, null, 2)}\n`);
    fs.writeFileSync(path.join(runDir, 'analysis.json'), bytes, { mode: 0o600 });
    const run = { runId: RUN_ID, status: 'complete', analysisSha256: sha(bytes),
        baseline: { contract: api.HISTORICAL_BASELINE_CONTRACT } };
    const dependencies = { loadRun: () => ({ run, analysis, runDir }), isSuccessfulAnalysisRecord: () => true,
        readFreshSource: () => ({ text: 'Original source text' }) };
    const handle = api.loadCompletedHistoricalAnalysisRun({ analysisRoot: path.join(root, 'runs'), runId: RUN_ID }, dependencies);
    return { root, runDir, run, analysis, dependencies, handle, output: path.join(root, 'assignments') };
}

function registry() {
    return tagCatalogApi.loadTagCatalog(path.join(__dirname, '..', 'config', 'tag-catalog.json'));
}

test('已完成的历史正式记录映射精确概念，并绑定全部来源 SHA', t => {
    let analysis = validAnalysisText()
        .replace('primary_task_tag: #语音识别', 'primary_task_tag: #音视频语音识别')
        .replace('#语音识别 #Transformer #鲁棒性', '#音视频语音识别 #Transformer #鲁棒性')
        .replace('主任务标签: #语音识别', '主任务标签: #音视频语音识别')
        .replace('补充标签: #鲁棒性', '补充标签: #鲁棒性');
    const f = runFixture(t, [paper('2609.03622', analysis)]);
    const assignment = api.buildAssignments({ runHandle: f.handle, tagCatalog: registry() })[0];
    assert.equal(assignment.status, 'assigned');
    assert.equal(assignment.contract, 'paper-tag-assignment-v2'); assert.equal(assignment.version, 2);
    assert.equal(assignment.primaryTaskId, 'task.av-asr');
    assert.equal(assignment.primaryMethodId, 'method.transformer');
    assert.ok(assignment.conceptIds.includes('task.av-asr'));
    assert.ok(!assignment.conceptIds.includes('task.asr'));
    assert.equal(assignment.analysisSha256, sha(analysis));
    assert.match(assignment.registrySha256, /^[a-f0-9]{64}$/);
    const body = structuredClone(assignment); delete body.assignmentSha256;
    assert.equal(assignment.assignmentSha256, api.stableHash(body));
});

test('2403.14817 bare #端到端 is blocked instead of guessed across method/setting facets', t => {
    const analysis = validAnalysisText()
        .replace('primary_method_tag: #Transformer', 'primary_method_tag: #端到端')
        .replace('#语音识别 #Transformer #鲁棒性', '#语音识别 #端到端 #鲁棒性')
        .replace('主方法标签: #Transformer', '主方法标签: #端到端');
    const f = runFixture(t, [paper('2403.14817', analysis)]);
    const assignment = api.buildAssignments({ runHandle: f.handle, tagCatalog: registry() })[0];
    assert.equal(assignment.status, 'blocked');
    assert.equal(assignment.primaryMethodId, null);
    assert.deepEqual(assignment.conceptIds, []);
});

test('未知、跨 facet 歧义、已废弃或缺失的主标签一律标记为阻塞', t => {
    const unknownAnalysis = validAnalysisText().replaceAll('#鲁棒性', '#在线');
    const f = runFixture(t, [paper('2609.03622', unknownAnalysis)]);
    const unknown = api.buildAssignment({ runHandle: f.handle, paper: f.analysis.papers[0], tagCatalog: registry() });
    assert.equal(unknown.status, 'blocked'); assert.ok(unknown.blockedReasons.some(reason => reason.includes('analysis-tags:')));
    const legacy = api.buildLegacyAssignment({ runHandle: f.handle, paper: f.analysis.papers[0], tagCatalog: registry() });
    assert.equal(legacy.contract, 'paper-taxonomy-assignment-v1'); assert.equal(legacy.version, 1);
    assert.ok(legacy.blockedReasons.some(reason => reason.includes('canonical-taxonomy:')));
    const { assignmentSha256: legacySha, ...legacyBody } = legacy;
    assert.equal(legacySha, api.stableHash(legacyBody));
    assert.throws(() => api.writeAssignments({ outputRoot: f.output, assignments: [legacy] }), /只接受完整且哈希有效的新版/);
    assert.deepEqual(unknown.conceptIds, []); assert.equal(unknown.primaryTaskId, null);

    const ambiguousRegistry = registry();
    ambiguousRegistry.concepts.find(item => item.id === 'task.asr').aliases.push('Transformer');
    const original = runFixture(t, [paper('2609.03623')]);
    const ambiguous = api.buildAssignment({ runHandle: original.handle, paper: original.analysis.papers[0], tagCatalog: ambiguousRegistry });
    assert.equal(ambiguous.status, 'blocked'); assert.ok(ambiguous.blockedReasons.some(reason => reason.includes('tag:ambiguous:#Transformer')));
});

test('加载器拒绝不完整、非历史、漂移或过期的已解析分析运行', t => {
    const f = runFixture(t);
    for (const mutate of [
        run => { run.status = 'analysis_partial'; },
        run => { run.baseline.contract = 'fresh-rewrite-baseline-v1'; },
        run => { run.analysisSha256 = 'f'.repeat(64); }
    ]) {
        const changed = structuredClone(f.run); mutate(changed);
        assert.throws(() => api.loadCompletedHistoricalAnalysisRun({ analysisRoot: path.join(f.root, 'runs'), runId: RUN_ID },
            { ...f.dependencies, loadRun: () => ({ run: changed, analysis: f.analysis, runDir: f.runDir }) }));
    }
    const stale = structuredClone(f.analysis.papers[0]); stale.parsed.tags = ['#在线'];
    assert.throws(() => api.buildAssignment({ runHandle: f.handle, paper: stale, tagCatalog: registry() }), /论文记录与该分析运行中的完整原记录不一致/);
});

test('命令行支持批次和单篇预演，零写入；写入则生成私有且幂等的产物', t => {
    const f = runFixture(t, [paper('2609.03622'), paper('2609.03623')]);
    const config = { FILES: { freshRewriteRunsDir: path.join(f.root, 'runs'),
        tagCatalogFile: path.join(__dirname, '..', 'config', 'tag-catalog.json'),
        historicalTagAssignmentDir: f.output } };
    const runtime = { config, dependencies: f.dependencies };
    const batch = cli.main(['assign', '--dry-run', '--analysis-run', RUN_ID], runtime);
    assert.equal(batch.mode, 'batch'); assert.equal(batch.total, 2); assert.equal(fs.existsSync(f.output), false);
    const single = cli.main(['assign', '--dry-run', '--analysis-run', RUN_ID,
        '--paper-id', 'arxiv:2609.03622'], runtime);
    assert.equal(single.mode, 'single'); assert.equal(single.total, 1); assert.equal(fs.existsSync(f.output), false);
    const applied = cli.main(['assign', '--apply', '--analysis-run', RUN_ID,
        '--paper-id', 'arxiv:2609.03622'], runtime);
    assert.equal(applied.outputs.length, 1);
    assert.equal(fs.statSync(f.output).mode & 0o777, 0o700);
    assert.equal(fs.statSync(applied.outputs[0].filename).mode & 0o777, 0o600);
    assert.equal(path.basename(applied.outputs[0].filename),
        `arxiv-2609.03622.tags.${registry().registrySha256}.${applied.assignments[0].assignmentSha256}.json`);
    assert.equal(cli.main(['assign', '--apply', '--analysis-run', RUN_ID,
        '--paper-id', 'arxiv:2609.03622'], runtime).outputs[0].fileSha256, applied.outputs[0].fileSha256);
    assert.throws(() => cli.parseArgs(['assign', '--dry-run', '--analysis-run', RUN_ID,
        '--paper-id', '../escape']));
});

test('登记升级会在原审计记录旁边新建一份不可变产物', t => {
    const f = runFixture(t); const firstTagCatalog = registry();
    const first = api.buildAssignments({ runHandle: f.handle, tagCatalog: firstTagCatalog });
    const firstOutput = api.writeAssignments({ outputRoot: f.output, assignments: first })[0];
    const upgraded = structuredClone(firstTagCatalog); upgraded.registrySha256 = 'f'.repeat(64);
    const second = api.buildAssignments({ runHandle: f.handle, tagCatalog: upgraded });
    const secondOutput = api.writeAssignments({ outputRoot: f.output, assignments: second })[0];
    assert.notEqual(firstOutput.filename, secondOutput.filename);
    assert.equal(fs.existsSync(firstOutput.filename), true);
    assert.equal(fs.existsSync(secondOutput.filename), true);
    assert.throws(() => api.assignmentFilename('arxiv:2609.03622'), /有效的词表 SHA/);
});

test('同一次分析运行保留每个升级后的分配，文件名不冲突', t => {
    const f = runFixture(t); const tagCatalog = registry();
    const first = api.buildAssignments({ runHandle: f.handle, tagCatalog })[0];
    const firstOutput = api.writeAssignments({ outputRoot: f.output, assignments: [first] })[0];
    const changedBody = structuredClone(first); delete changedBody.assignmentSha256;
    changedBody.analysisFileSha256 = 'e'.repeat(64);
    const resealedEnvelope = { ...changedBody, assignmentSha256: api.stableHash(changedBody) };
    const secondOutput = api.writeAssignments({ outputRoot: f.output, assignments: [resealedEnvelope] })[0];
    assert.notEqual(firstOutput.filename, secondOutput.filename,
        'even an envelope-only analysis SHA change must remain independently addressable');

    const upgradedAnalysis = validAnalysisText().replaceAll('#鲁棒性', '#多语言');
    const upgradedFixture = runFixture(t, [paper('2609.03622', upgradedAnalysis)]);
    const upgraded = api.buildAssignments({ runHandle: upgradedFixture.handle, tagCatalog })[0];
    const upgradedOutput = api.writeAssignments({ outputRoot: f.output, assignments: [upgraded] })[0];
    assert.notEqual(upgradedOutput.filename, firstOutput.filename);
    assert.equal(fs.existsSync(firstOutput.filename), true);
    assert.equal(fs.existsSync(secondOutput.filename), true);
    assert.equal(fs.existsSync(upgradedOutput.filename), true);
});

test('原历史分析完整复算旧分配，并按原文件 SHA 重放，不被旁边新版替代', t => {
    const f = runFixture(t), catalog = registry(), paperId = `arxiv:${f.analysis.papers[0].arxivId}`;
    const old = api.buildLegacyAssignment({ runHandle: f.handle, paper: f.analysis.papers[0], tagCatalog: catalog });
    const current = api.buildAssignment({ runHandle: f.handle, paper: f.analysis.papers[0], tagCatalog: catalog });
    const oldRoot = path.join(f.root, 'old-assignments'), runRoot = path.join(oldRoot, RUN_ID);
    fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    const shortFile = path.join(runRoot, api.legacyAssignmentFilename(paperId, catalog.registrySha256));
    const hashedFile = path.join(runRoot, api.legacyHashedAssignmentFilename(paperId, catalog.registrySha256, old.assignmentSha256));
    const oldBytes = Buffer.from(JSON.stringify(old));
    fs.writeFileSync(shortFile, oldBytes, { mode: 0o600 });
    fs.writeFileSync(hashedFile, api.canonicalBytes(old), { mode: 0o600 });
    api.writeAssignments({ outputRoot: f.output, assignments: [current] });
    const pageKey = `page:${'1'.repeat(64)}`, crosswalkId = '11111111-1111-4111-8111-111111111111';
    const crosswalk = { source: { papers: [{ pageKey, pagePath: 'content/posts/old.md', primaryUrl: 'https://example.test/old/',
        cohortDate: '2026-09-04', pageContentSha256: '2'.repeat(64) }] },
    identityGroups: [{ paperId, pageKeys: [pageKey] }],
    assignments: { [pageKey]: { status: 'verified', sourceAuthority: { paperId } } } };
    const staging = require('../scripts/lib/historical-page-staging.js');
    const options = { crosswalkId, analysisRoot: path.join(f.root, 'runs'), analysisRunId: RUN_ID,
        tagAssignmentRoot: f.output, tagCatalogPath: path.join(__dirname, '..', 'config/tag-catalog.json') };
    const dependencies = { readCrosswalk: () => crosswalk, loadRun: () => f.handle,
        assignmentFiles: { historicalTagAssignmentDir: f.output, legacyHistoricalTagAssignmentDir: oldRoot } };
    assert.deepEqual(staging.loadPageGenerationInputs(options, dependencies).groups[0].tagAssignment, current);
    const pinned = { ...options, assignmentProofs: { [paperId]: { assignmentSha256: old.assignmentSha256, fileSha256: sha(oldBytes) } } };
    const restored = staging.loadPageGenerationInputs(pinned, dependencies).groups[0];
    assert.deepEqual(restored.tagAssignment, old); assert.equal(restored.tagAssignmentFileSha256, sha(oldBytes));
    assert.deepEqual(fs.readFileSync(shortFile), oldBytes);
    // 完全相同的旧字节副本可以选回；不同排版仍须匹配原 raw SHA。
    fs.writeFileSync(hashedFile, oldBytes);
    assert.deepEqual(staging.loadPageGenerationInputs(pinned, dependencies).groups[0].tagAssignment, old);
    fs.writeFileSync(shortFile, Buffer.concat([oldBytes, Buffer.from('\n')]));
    fs.writeFileSync(hashedFile, api.canonicalBytes(old));
    assert.throws(() => staging.loadPageGenerationInputs(pinned, dependencies), /原文件 SHA 不一致/);
    assert.throws(() => api.writeAssignments({ outputRoot: f.output, assignments: [old] }), /只接受完整且哈希有效的新版/);
});


test('历史标签分配读取旧缓存且拒绝混用，不新增缺少校验子字段门槛', () => {
    const current = paper();
    const expected = api.getConsistentClassificationLabels(current);
    const legacy = structuredClone(current);
    legacy.parsed = Object.fromEntries(Object.entries(legacy.parsed).map(([key, value]) =>
        [key === 'tagValidation' ? 'taxonomyValidation' : key, value]));
    const before = JSON.stringify(legacy);
    assert.deepEqual(api.getConsistentClassificationLabels(legacy), expected);
    assert.equal(JSON.stringify(legacy), before);
    delete legacy.parsed.taxonomyValidation;
    assert.deepEqual(api.getConsistentClassificationLabels(legacy), expected);
    for (const value of [current.parsed.tagValidation, null, {}]) {
        const mixed = structuredClone(current);
        mixed.parsed.taxonomyValidation = value;
        assert.throws(() => api.getConsistentClassificationLabels(mixed), /解析结果不能同时包含/);
    }
});


function storageFixture(t) {
    const f = runFixture(t), value = api.buildAssignments({ runHandle: f.handle, tagCatalog: registry() })[0];
    const root = f.output, args = { outputRoot: root, assignments: [value] };
    const write = () => api.writeAssignments(args);
    const filename = path.join(root, RUN_ID, api.assignmentFilename(value.paperId, value.registrySha256, value.assignmentSha256));
    return { root, value, args, write, filename };
}
test('不可变后处理输出短写失败不留正式文件，原请求可以成功重试', t => {
    const f = storageFixture(t), original = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = function(target, bytes, ...args) {
        if (!injected && typeof target === 'number') {
            injected = true;
            original.call(fs, target, Buffer.from(bytes).subarray(0, 7));
            throw Object.assign(new Error('磁盘空间不足'), { code: 'ENOSPC' });
        }
        return original.call(fs, target, bytes, ...args);
    };
    try { assert.throws(f.write, {code:'ENOSPC'}); } finally { fs.writeFileSync = original; }
    assert.equal(injected, true); assert.equal(fs.existsSync(f.filename), false);
    const [result] = f.write();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.filename)), f.value);
    assert.equal(result.fileSha256, sha(fs.readFileSync(f.filename)));
});
test('不可变后处理输出写入失败不能覆盖或删除竞争者的正式文件', t => {
    const f = storageFixture(t), original = fs.writeFileSync;
    let injected = false; const winner = Buffer.from('另一写者保存的原始字节');
    fs.writeFileSync = function(target, bytes, ...args) {
        if (!injected && typeof target === 'number') {
            injected = true;
            original.call(fs, f.filename, winner);
            throw Object.assign(new Error('写入失败'), { code: 'EIO' });
        }
        return original.call(fs, target, bytes, ...args);
    };
    try { assert.throws(f.write, {code:'EIO'}); } finally { fs.writeFileSync = original; }
    assert.deepEqual(fs.readFileSync(f.filename), winner);
    assert.throws(f.write); assert.deepEqual(fs.readFileSync(f.filename), winner);
});
test('不可变后处理输出建立正式链接后进程中断，公开写入入口可安全恢复', t => {
    const f = storageFixture(t);
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs'), link = fs.linkSync;
        fs.linkSync = (...args) => { link(...args); process.kill(process.pid, 'SIGKILL'); };
        require(process.argv[1]).writeAssignments(JSON.parse(process.argv[2]));
    `, require.resolve('../scripts/lib/historical-tag-assignment.js'), JSON.stringify(f.args)], {encoding:'utf8'});
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const before = fs.readFileSync(f.filename);
    assert.equal(fs.statSync(f.filename).nlink, 2);
    const [result] = f.write();
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.equal(fs.statSync(f.filename).nlink, 1);
    assert.equal(result.fileSha256, sha(before));
});

test('旧历史分析的补充平面来源不直接复用标签，普通原文仍通过', t => {
    const f = runFixture(t);
    const options = { analysisRoot: path.join(f.root, 'runs'), runId: RUN_ID };
    assert.throws(() => api.loadCompletedHistoricalAnalysisRun(options, {
        ...f.dependencies, readFreshSource: () => ({ text: '原论文定义数学变量 𝑥，作者𠮷田。' })
    }), /Unicode.*重分析/);
    assert.throws(() => api.loadCompletedHistoricalAnalysisRun(options, {
        ...f.dependencies, readFreshSource: () => null
    }), /Unicode.*重分析/);
    assert.doesNotThrow(() => api.loadCompletedHistoricalAnalysisRun(options, f.dependencies));
});

'use strict';

// 只读清单骨架导出（scripts/export-review-failure-manifest.js）的测试：
// 用临时目录构造最小会议失败记录与原生成记录，以及最小历史发布计划，检查
// 导出的骨架字段、可推导身份、_todo 人工项、错误路径，以及运行前后磁盘字节不变。
// 不联网，不写生产数据。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const codec = require('../scripts/lib/protocol-codec');
const api = require('../scripts/export-review-failure-manifest.js');

const SHA = /^[a-f0-9]{64}$/;
const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
const PROCESS = '33333333-3333-4333-8333-333333333333';
const PROTOCOL = crypto.createHash('sha256').update('protocol-one').digest('hex');
const OTHER_PROTOCOL = crypto.createHash('sha256').update('protocol-two').digest('hex');
const PAGE_ONE = 'content/posts/conference-demo-2026-one.md';
const PAGE_TWO = 'content/posts/conference-demo-2026-two.md';

function canonical(value) {
    return Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
            : value;
}
function stable(value) {
    return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function sha(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function header(name) { return codec.recordHeader(name, name); }
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}
function snapshot(directory) {
    if (!fs.existsSync(directory)) return {};
    const result = {};
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) walk(target);
            else result[path.relative(directory, target)] = fs.readFileSync(target).toString('base64');
        }
    };
    walk(directory);
    return result;
}

function failureRecord({ pagePath = PAGE_ONE, pageSha = sha(PAGE_ONE), paperId = 'conference:demo:2026:one',
    protocol = PROTOCOL, stage = 'image', failureKind = 'content', completed = true, issues } = {}) {
    const body = {
        ...header('conference-page-content-review-failure'),
        path: pagePath,
        sha256: pageSha,
        paperId,
        passed: false,
        stage,
        protocol,
        issues: issues || [{ severity: 'error', type: 'model_content', description: '图中的数值与正文断言不符' }],
        completed,
        imageCount: 2
    };
    if (failureKind === null) delete body.failureKind; else body.failureKind = failureKind;
    if (completed === null) delete body.completed;
    const failureSha256 = stable(body);
    return { ...body, failureSha256 };
}
function writeFailure(runtime, record) {
    const directory = path.join(runtime, 'conference-publications', 'page-review-failures');
    writeJson(path.join(directory, record.failureSha256 + '.json'), record);
    return record.failureSha256;
}

function generationRecord(conferenceId = 'demo-2026', processId = PROCESS, pages = [
    { path: PAGE_ONE, paperId: 'conference:demo:2026:one', sourceSha256: sha(PAGE_ONE) },
    { path: PAGE_TWO, paperId: 'conference:demo:2026:two', sourceSha256: sha(PAGE_TWO) }
], imageFiles = []) {
    const body = {
        ...header('conference-blog-generation'),
        conferenceId,
        processId,
        files: pages.map(page => ({ kind: 'paper', path: page.path, paperId: page.paperId,
            sourceSha256: page.sourceSha256, sourcePath: '/tmp/fixture/page.md',
            manifestSha256: sha('manifest') })),
        imageFiles
    };
    return { ...body, generationSha256: stable(body) };
}
function writeGeneration(runtime, record, conferenceId = 'demo-2026') {
    writeJson(path.join(runtime, 'conference-publications', conferenceId, PROCESS, 'generation.json'), record);
}

function writePlan(runtime, { publicationId = UUID, planSha256 = sha('rewrite-plan'),
    scope = 'full-history', selected = [], visualDisposition = null } = {}) {
    const body = {
        ...header('historical-direct-publication-plan'),
        publicationId,
        authorityProof: { proofSha256: sha('proof'), plan: { planSha256, fileSha256: sha('rewrite-plan-file') } },
        publicationScope: scope,
        selectedPaperIds: selected,
        visualDisposition
    };
    const value = { ...body, planSha256: stable(body) };
    writeJson(path.join(runtime, 'historical-direct-publications', publicationId, 'plan.json'), value);
    return value;
}

function tempRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-manifest-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function outFile(root, name = 'skeleton.json') { return path.join(root, name); }

test('会议：按同协议、同页 SHA 导出 imageFailureUniverse 与占位 members', t => {
    const runtime = tempRoot(t);
    const out = outFile(runtime);
    writeGeneration(runtime, generationRecord('demo-2026', PROCESS, undefined, [
        { kind: 'asset', paperId: 'conference:demo:2026:one', path: 'demo-2026/aaaaaaaaaaaa/figure-2.png' },
        { kind: 'asset', paperId: 'conference:demo:2026:one', path: 'demo-2026/aaaaaaaaaaaa/figure-3.png' }
    ]));
    const one = writeFailure(runtime, failureRecord({ pagePath: PAGE_ONE, pageSha: sha(PAGE_ONE),
        paperId: 'conference:demo:2026:one', issues: [
            { severity: 'error', type: 'model_content', description: '图片里的阈值写成了符号，正文却说百分比' },
            { severity: 'info', type: 'model_content', description: 'alt 文本拼写不一致' }
        ] }));
    const two = writeFailure(runtime, failureRecord({ pagePath: PAGE_TWO, pageSha: sha(PAGE_TWO),
        paperId: 'conference:demo:2026:two' }));
    // 干扰项：正文阶段、其他协议、页面不属于本流程，都不能进入 universe。
    writeFailure(runtime, failureRecord({ pagePath: PAGE_ONE, pageSha: sha(PAGE_ONE), stage: 'text',
        failureKind: null, completed: null }));
    writeFailure(runtime, failureRecord({ pagePath: PAGE_ONE, pageSha: sha(PAGE_ONE), protocol: OTHER_PROTOCOL }));
    writeFailure(runtime, failureRecord({ pagePath: 'content/posts/other.md', pageSha: sha('other') }));
    fs.writeFileSync(path.join(runtime, 'conference-publications', 'page-review-failures', 'notes.txt'), 'ignore');
    const before = snapshot(path.join(runtime, 'conference-publications'));

    const result = api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--conference-id', 'demo-2026', '--review-protocol-sha', PROTOCOL,
        '--runtime-root', runtime, '--out', out]);

    assert.equal(result.written, out);
    assert.equal(result.counts.universe, 2);
    assert.equal(result.counts.excludedOtherStage, 1);
    assert.equal(result.counts.excludedOtherProtocol, 1);
    assert.equal(result.counts.excludedUnmatchedPage, 1);
    assert.equal(result.counts.skippedNonFailureFiles, 1);

    const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(saved.contract, 'conference-publication-figure-crop-manifest');
    assert.match(saved.schemaFingerprint, SHA);
    assert.equal(saved.conferenceId, 'demo-2026');
    assert.equal(saved.processId, PROCESS);
    const generation = JSON.parse(fs.readFileSync(path.join(runtime, 'conference-publications',
        'demo-2026', PROCESS, 'generation.json')));
    assert.equal(saved.baseGenerationSha256, generation.generationSha256);
    assert.match(saved.baseGenerationFileSha256, SHA);
    assert.equal(saved.reviewProtocolSha256, PROTOCOL);
    assert.deepEqual(saved.imageFailureUniverse.map(entry => entry.failureSha256).sort(), [one, two].sort());
    for (const entry of saved.imageFailureUniverse) assert.deepEqual(entry.routes, []);
    assert.equal(saved.members.length, 2);
    for (const member of saved.members) {
        assert.deepEqual(Object.keys(member).sort(), api.MEMBER_FIELDS.slice().sort());
        assert.match(member.pagePath, /^content\/posts\//);
        assert.match(member.pageSha256, SHA);
        assert.match(member.reviewFailureSha256, SHA);
        assert.equal(member.figureOrdinal, null);
        assert.equal(member.analysisSha256, null);
        assert.equal(member.readerArticleSha256, null);
    }
    assert.ok(Array.isArray(saved._todo) && saved._todo.length >= 5);
    assert.match(saved._todo.join('\n'), /补齐清单后必须删除整个字段/);
    assert.match(saved._todo.join('\n'), new RegExp(one));
    assert.match(saved._todo.join('\n'), /#0 error\/model_content/);
    assert.match(saved._todo.join('\n'), /原生成该论文图片序号 2, 3/);
    assert.match(saved._todo.join('\n'), /原生成没有该论文的 figure-N\.png 图片记录/);
    // 只读：失败记录、原生成记录都保持原字节。
    assert.deepEqual(snapshot(path.join(runtime, 'conference-publications')), before);
});

test('会议：同页命中多种协议时必须显式指定协议', t => {
    const runtime = tempRoot(t);
    writeGeneration(runtime, generationRecord());
    writeFailure(runtime, failureRecord({ protocol: PROTOCOL }));
    writeFailure(runtime, failureRecord({ protocol: OTHER_PROTOCOL }));
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--conference-id', 'demo-2026', '--runtime-root', runtime, '--out', outFile(runtime)]),
    /--review-protocol-sha/);
    assert.equal(fs.existsSync(outFile(runtime)), false);
});

test('会议：缺少失败目录或失败记录损坏时明确报错', t => {
    const runtime = tempRoot(t);
    writeGeneration(runtime, generationRecord());
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--conference-id', 'demo-2026', '--runtime-root', runtime, '--out', outFile(runtime)]),
    /页面审查失败目录不存在/);

    const tampered = failureRecord();
    writeFailure(runtime, tampered);
    const file = path.join(runtime, 'conference-publications', 'page-review-failures',
        tampered.failureSha256 + '.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.issues[0].description = '改写过的描述';
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--conference-id', 'demo-2026', '--runtime-root', runtime, '--out', outFile(runtime)]),
    /文件名与自身 SHA 不一致/);
});

test('会议：缺少原生成记录时报错', t => {
    const runtime = tempRoot(t);
    fs.mkdirSync(path.join(runtime, 'conference-publications', 'page-review-failures'), { recursive: true });
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--conference-id', 'demo-2026', '--runtime-root', runtime, '--out', outFile(runtime)]),
    /会议发布流程目录不存在/);
});

test('会议：失败记录缺字段时明确报错，不补猜', t => {
    const runtime = tempRoot(t);
    writeGeneration(runtime, generationRecord());
    const body = failureRecord();
    delete body.issues;
    delete body.failureSha256;
    const resealed = { ...body, failureSha256: stable(body) };
    writeJson(path.join(runtime, 'conference-publications', 'page-review-failures',
        resealed.failureSha256 + '.json'), resealed);
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--conference-id', 'demo-2026', '--runtime-root', runtime, '--out', outFile(runtime)]),
    /缺少页面身份、协议或 issues/);
});

test('会议：原生成页面没有同页 SHA 的图片拒稿时报错，不猜 universe', t => {
    const runtime = tempRoot(t);
    writeGeneration(runtime, generationRecord());
    writeFailure(runtime, failureRecord({ pageSha: sha('stale-page-bytes') }));
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--conference-id', 'demo-2026', '--review-protocol-sha', PROTOCOL,
        '--runtime-root', runtime, '--out', outFile(runtime)]),
    /没有同协议、同页 SHA 的图片拒稿/);
});

test('会议：未传 --conference-id 时按 process 唯一反查目录，多命中则要求显式指定', t => {
    const runtime = tempRoot(t);
    writeGeneration(runtime, generationRecord());
    writeFailure(runtime, failureRecord());
    const result = api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--review-protocol-sha', PROTOCOL, '--runtime-root', runtime, '--out', outFile(runtime)]);
    assert.equal(result.conferenceId, 'demo-2026');

    writeGeneration(runtime, generationRecord('other-conf'), 'other-conf');
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--review-protocol-sha', PROTOCOL, '--runtime-root', runtime,
        '--out', outFile(runtime, 'second.json')]), /--conference-id/);
});

test('会议：拒绝覆盖已有文件、拒绝写进生产 data 目录', t => {
    const runtime = tempRoot(t);
    writeGeneration(runtime, generationRecord());
    writeFailure(runtime, failureRecord());
    const out = outFile(runtime);
    api.main(['--kind', 'conference-figure-crop', '--process', PROCESS, '--conference-id', 'demo-2026',
        '--review-protocol-sha', PROTOCOL, '--runtime-root', runtime, '--out', out]);
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--conference-id', 'demo-2026', '--review-protocol-sha', PROTOCOL,
        '--runtime-root', runtime, '--out', out]), /拒绝覆盖/);
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--conference-id', 'demo-2026', '--review-protocol-sha', PROTOCOL, '--runtime-root', runtime,
        '--out', path.resolve(__dirname, '..', 'data', 'skeleton-should-not-exist.json')]),
    /拒绝把骨架写进生产数据目录/);
});

test('历史：从发布计划导出 planSha256 与 scope，其余字段留 null', t => {
    const runtime = tempRoot(t);
    const out = outFile(runtime);
    const planSha = sha('rewrite-plan');
    writePlan(runtime, { planSha256: planSha });
    const before = snapshot(path.join(runtime, 'historical-direct-publications'));

    const result = api.main(['--kind', 'historical-visual-disposition', '--publication', UUID,
        '--runtime-root', runtime, '--out', out]);

    const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(saved.contract, 'historical-direct-visual-disposition');
    assert.match(saved.schemaFingerprint, SHA);
    assert.equal(saved.planSha256, planSha);
    assert.equal(saved.scope, 'full-history-publication');
    for (const field of ['mode', 'reason', 'requestedBy', 'createdAt', 'dispositionSha256']) {
        assert.equal(saved[field], null, field);
    }
    assert.deepEqual(Object.keys(saved).sort(), ['_todo', 'contract', 'createdAt', 'dispositionSha256',
        'mode', 'planSha256', 'reason', 'requestedBy', 'schemaFingerprint', 'scope'].sort());
    assert.match(saved._todo.join('\n'), /waived 只能是 user/);
    assert.deepEqual(result.counts, { planSha256: 1, scope: 1, pendingHumanFields: 5 });
    assert.deepEqual(snapshot(path.join(runtime, 'historical-direct-publications')), before);
});

test('历史：按发布计划区分全量/样本范围，并沿用 --plan-file 交叉核对', t => {
    const runtime = tempRoot(t);
    const planFile = path.join(runtime, 'direct-plan.json');
    const planBody = { ...header('historical-direct-rewrite-plan'), fixture: 'rewrite-plan' };
    const planSha = stable(planBody);
    writeJson(planFile, { ...planBody, planSha256: planSha });
    writePlan(runtime, { planSha256: planSha, scope: 'selected-sample', selected: ['arxiv:2609.00001'] });

    const result = api.main(['--kind', 'historical-visual-disposition', '--publication', UUID,
        '--runtime-root', runtime, '--out', outFile(runtime, 'sample.json')]);
    assert.equal(result.scope, 'selected-sample-publication');
    assert.equal(result.planSha256, planSha);

    const second = api.main(['--kind', 'historical-visual-disposition', '--publication', UUID,
        '--plan-file', planFile, '--runtime-root', runtime, '--out', outFile(runtime, 'second.json')]);
    assert.equal(second.planSha256, planSha);

    // 旧计划没有范围字段时，按 validatePlan 的同一规则当作全历史。
    const legacy = writePlan(runtime, { planSha256: planSha });
    delete legacy.publicationScope;
    delete legacy.selectedPaperIds;
    delete legacy.planSha256;
    const legacyPlanFile = path.join(runtime, 'historical-direct-publications', UUID, 'plan.json');
    writeJson(legacyPlanFile, { ...legacy, planSha256: stable(legacy) });
    const legacyResult = api.main(['--kind', 'historical-visual-disposition', '--publication', UUID,
        '--runtime-root', runtime, '--out', outFile(runtime, 'legacy.json')]);
    assert.equal(legacyResult.scope, 'full-history-publication');

    const other = { ...header('historical-direct-rewrite-plan'), fixture: 'another-plan' };
    const otherFile = path.join(runtime, 'other-plan.json');
    writeJson(otherFile, { ...other, planSha256: stable(other) });
    assert.throws(() => api.main(['--kind', 'historical-visual-disposition', '--publication', UUID,
        '--plan-file', otherFile, '--runtime-root', runtime, '--out', outFile(runtime, 'third.json')]),
    /不是同一份/);
});


test('历史：缺少发布计划或计划自身 SHA 不闭合时报错', t => {
    const runtime = tempRoot(t);
    assert.throws(() => api.main(['--kind', 'historical-visual-disposition', '--publication', UUID,
        '--runtime-root', runtime, '--out', outFile(runtime)]), /发布计划不存在|历史发布根目录不存在/);

    const value = writePlan(runtime, { publicationId: OTHER_UUID });
    value.scope = 'full-history-publication';
    writeJson(path.join(runtime, 'historical-direct-publications', OTHER_UUID, 'plan.json'), value);
    assert.throws(() => api.main(['--kind', 'historical-visual-disposition', '--publication', OTHER_UUID,
        '--runtime-root', runtime, '--out', outFile(runtime)]), /发布计划自身 SHA 不闭合/);
});

test('参数：kind、必填身份与未知参数都会被拒绝', () => {
    assert.throws(() => api.main(['--kind', 'other', '--out', '/tmp/x.json']), /--kind/);
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--out', '/tmp/x.json']), /--process/);
    assert.throws(() => api.main(['--kind', 'historical-visual-disposition', '--out', '/tmp/x.json']), /--publication/);
    assert.throws(() => api.main(['--kind', 'conference-figure-crop', '--process', PROCESS,
        '--publication', UUID, '--out', '/tmp/x.json']), /不接受参数/);
    assert.throws(() => api.main(['--kind', 'historical-visual-disposition', '--publication', UUID,
        '--out', 'relative.json']), /绝对路径/);
});

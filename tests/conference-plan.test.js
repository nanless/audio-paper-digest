'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../scripts/lib/conference-plan.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const fs = require('node:fs');
const path = require('node:path');
const { productionPlanFixture, loadOriginalConferenceApis, sha256 } = require('./helpers/conference-production-plan-fixture.js');

const paperId = paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value: '1001' });
const identities = [{ paperId, sourceIdentity: 'icassp-arnumber:1001' }];
const selectedMemberSetSha256 = plan.stableHash([paperId]);
const valid = () => ({
    contract: plan.PLAN_CONTRACT,
    version: plan.VERSION,
    ledgerName: 'icassp-2026.json',
    tagMetadata: { version: 'paper-tag-catalog-v2', sha256: 'a'.repeat(64) },
    selectionPolicy: { contract: plan.SELECTION_CONTRACT, identities, selectedMemberSetSha256 },
    shards: [{ shardId: 'all', paperIds: [paperId] }]
});

test('新版计划逐项核验入选论文，并要求分片完整覆盖', () => {
    assert.deepEqual(plan.normalizePlan(valid()), valid());
    assert.equal(valid().version, 3);
    assert.equal(Object.hasOwn(valid(), 'taxonomy'), false);
    const drift = valid(); drift.selectionPolicy.selectedMemberSetSha256 = 'b'.repeat(64);
    assert.throws(() => plan.normalizePlan(drift), /selectedMemberSetSha256/);
    const incomplete = valid(); incomplete.shards[0].paperIds = [];
    assert.throws(() => plan.normalizePlan(incomplete), /paperIds 须为非空数组/);
});

test('计划拒绝混用标签字段，并核对格式与版本', () => {
    for (const legacyValue of [valid().tagMetadata, null]) {
        assert.throws(() => plan.normalizePlan({ ...valid(), taxonomy: legacyValue }), /不能混用新旧标签字段/);
    }
    for (const [contract, version] of [[plan.PLAN_CONTRACT, 2], ['conference-run-plan-v9', 3]]) {
        assert.throws(() => plan.normalizePlan({ ...valid(), contract, version }), /不属于支持的组合/);
    }
    assert.throws(() => plan.normalizePlan({ ...valid(), contract: 'conference-run-plan-v2', version: 2 }), /标签字段与格式版本不一致/);
});

test('旧计划和凭证可按原字节读取，但不能创建另一份运行记录', t => {
    const original = loadOriginalConferenceApis();
    const f = productionPlanFixture(t, { planApi: original.plan });
    const runFile = path.join(f.roots.runs, 'run.json');
    const receiptFile = path.join(f.roots.runs, 'run.plan-receipt.json');
    const planFile = path.join(f.roots.ledgers, 'plan.json');
    const before = [planFile, runFile, receiptFile].map(filename => fs.readFileSync(filename));
    const handle = plan.loadPlanHandle(runFile, receiptFile, planFile, f.importHandle, f.tagCatalogPath);
    const snapshot = plan.planHandleSnapshot(handle);
    assert.equal(snapshot.run.version, 2);
    assert.equal(snapshot.receipt.version, 2);
    assert.deepEqual(snapshot.run, f.planned.run);
    assert.deepEqual(snapshot.receipt, f.planned.receipt);
    assert.equal(snapshot.runFileSha256, sha256(before[1]));
    assert.equal(snapshot.receiptFileSha256, sha256(before[2]));
    assert.deepEqual(plan.tagMetadataForPlan(f.planned.plan), f.planned.plan.taxonomy);
    assert.deepEqual(plan.tagMetadataForReceipt(snapshot.receipt), snapshot.receipt.taxonomy);
    const recovered = plan.createRunFromImportPlan({ files: f.files, importHandle: f.importHandle,
        planName: 'plan.json', runName: 'run.json' });
    assert.equal(recovered.recovered, true);
    assert.deepEqual(recovered.receipt, f.planned.receipt);
    assert.throws(() => plan.applyRunPlan(recovered), /旧计划只能读取或恢复/);
    assert.throws(() => plan.createRunFromImportPlan({ files: f.files, importHandle: f.importHandle,
        planName: 'plan.json', runName: 'new-run.json' }), /ENOENT|运行输入文件不存在/);
    assert.equal(fs.existsSync(path.join(f.roots.runs, 'new-run.json')), false);
    assert.equal(fs.existsSync(path.join(f.roots.runs, 'new-run.plan-receipt.json')), false);
    [planFile, runFile, receiptFile].forEach((filename, index) => assert.deepEqual(fs.readFileSync(filename), before[index]));

    // 原凭证绑定的是实际 plan 文件字节，不接受只改排版而保留原凭证。
    fs.writeFileSync(planFile, Buffer.concat([before[0], Buffer.from('\n')]));
    assert.throws(() => plan.loadPlanHandle(runFile, receiptFile, planFile, f.importHandle, f.tagCatalogPath), /计划凭证未绑定已审计划文件的确切文件名和字节/);
    fs.writeFileSync(planFile, before[0]);
    for (const currentValue of [snapshot.receipt.taxonomy, null]) {
        const mixedReceipt = { ...snapshot.receipt, tagMetadata: currentValue };
        assert.throws(() => plan.normalizeSecureReceipt(mixedReceipt), /计划凭证的 SHA/);
        const { receiptSha256: _oldSha, ...mixedBody } = mixedReceipt;
        mixedReceipt.receiptSha256 = plan.stableHash(mixedBody);
        assert.throws(() => plan.normalizeSecureReceipt(mixedReceipt), /不能混用新旧标签字段/);
    }
});

test('仅保存旧版计划记录的两个构造函数不再对外提供', () => {
    assert.equal(plan.createRunFromPlan, undefined);
    assert.equal(plan.createPlanReceipt, undefined);
});

test('计划文件名仍然是直接的 JSON 名', () => {
    assert.throws(() => plan.receiptNameFor('../run.json'), /合法的 JSON 文件名/);
    assert.equal(plan.receiptNameFor('run.json'), 'run.plan-receipt.json');
});

test('计划写入失败只清理本人文件，普通文件与符号链接竞争者均保留', t => {
    const f = productionPlanFixture(t);
    for (const replacement of ['file', 'symlink', 'directory']) {
        const output = path.join(f.root, `cleanup-${replacement}`);
        const result = { ...f.planned, runFile: path.join(output, 'run.json'),
            receiptFile: path.join(output, 'run.plan-receipt.json') };
        const savedDirectory = `${output}-held`;
        const target = path.join(f.root, `winner-${replacement}.json`);
        const winner = Buffer.from('其他写入者的完整文件');
        fs.writeFileSync(target, winner);
        const originalError = Object.assign(new Error('测试实际短写后的磁盘错误'), { code: 'EIO' });
        const io = Object.create(fs); let injected = false;
        io.writeFileSync = (fd, bytes) => {
            if (injected) return fs.writeFileSync(fd, bytes);
            injected = true; fs.writeSync(fd, Buffer.from(bytes), 0, 4, 0);
            if (replacement === 'directory') {
                fs.renameSync(output, savedDirectory); fs.mkdirSync(output); fs.writeFileSync(result.runFile, winner);
            } else {
                fs.unlinkSync(result.runFile);
                if (replacement === 'symlink') fs.symlinkSync(target, result.runFile);
                else fs.writeFileSync(result.runFile, winner);
            }
            throw originalError;
        };
        let failure;
        try { plan.applyRunPlan(result, io); } catch (error) { failure = error; }
        assert.deepEqual(fs.readFileSync(result.runFile), winner);
        assert.equal(failure.cause, originalError); assert.equal(failure.code, 'EIO');
        assert.ok(failure.cleanupError instanceof AggregateError);
        assert.match(failure.message, /保留现有路径/);
        assert.deepEqual(fs.readFileSync(target), winner);
        if (replacement === 'symlink') assert.equal(fs.lstatSync(result.runFile).isSymbolicLink(), true);
        if (replacement === 'directory') assert.equal(fs.existsSync(path.join(savedDirectory, 'run.json')), true);
        else assert.equal(fs.existsSync(result.receiptFile), false);
    }
});

test('本人独占文件短写后完整清理，可用同一计划重新写入', t => {
    const f = productionPlanFixture(t); const output = path.join(f.root, 'cleanup-retry');
    const result = { ...f.planned, runFile: path.join(output, 'run.json'), receiptFile: path.join(output, 'run.plan-receipt.json') };
    const originalError = Object.assign(new Error('测试独占文件短写'), { code: 'EIO' });
    const io = Object.create(fs);
    io.writeFileSync = (fd, bytes) => { fs.writeSync(fd, Buffer.from(bytes), 0, 4, 0); throw originalError; };
    assert.throws(() => plan.applyRunPlan(result, io), error => {
        assert.equal(error.cause, originalError); assert.equal(error.cleanupError, undefined); return true;
    });
    assert.equal(fs.existsSync(output), false);
    assert.equal(plan.applyRunPlan(result), result);
    assert.deepEqual(fs.readFileSync(result.runFile), result.runBytes);
    assert.deepEqual(fs.readFileSync(result.receiptFile), result.receiptBytes);
});

test('计划写入与清理同时失败时保留两种原始错误', t => {
    const f = productionPlanFixture(t); const output = path.join(f.root, 'cleanup-error');
    const result = { ...f.planned, runFile: path.join(output, 'run.json'), receiptFile: path.join(output, 'run.plan-receipt.json') };
    const originalError = Object.assign(new Error('测试写入错误'), { code: 'EIO' });
    const cleanupError = Object.assign(new Error('测试清理权限错误'), { code: 'EACCES' });
    const io = Object.create(fs);
    io.writeFileSync = (fd, bytes) => { fs.writeSync(fd, Buffer.from(bytes), 0, 4, 0); throw originalError; };
    io.unlinkSync = () => { throw cleanupError; };
    assert.throws(() => plan.applyRunPlan(result, io), error => {
        assert.equal(error.cause, originalError);
        assert.ok(error.cleanupError.errors.includes(cleanupError)); return true;
    });
    assert.equal(fs.existsSync(result.runFile), true);
});

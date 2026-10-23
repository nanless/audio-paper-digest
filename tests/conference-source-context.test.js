'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const context = require('../scripts/lib/conference-source-context.js');
const planApi = require('../scripts/lib/conference-plan.js');
const ledgerApi = require('../scripts/lib/conference-source-ledger.js');
const runApi = require('../scripts/lib/conference-run.js');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture.js');

function artifactPath(fixture, field) {
    return path.join(fixture.sourceRoot, fixture.member[field]);
}

function replaceBytes(filename, replacement, callback) {
    const original = fs.readFileSync(filename);
    fs.writeFileSync(filename, replacement);
    try { callback(); } finally { fs.writeFileSync(filename, original); }
}

function build(fixture) {
    return context.buildConferenceSourceContext({ planHandle: fixture.planHandle,
        paperId: fixture.paperId, sourceRoot: fixture.sourceRoot });
}

function isReplayRejection(error) {
    return ['pdf_source_invalid', 'source_sha_drift', 'source_read_failed'].includes(error?.reasonCode);
}

test('来源同一FD增长时最多读取原大小加一个哨兵再拒，原计划及正常来源仍可重放', t => {
    const fixture = productionPlanFixture(t);
    assert.equal(build(fixture).analysisReady, true);
    const filename = artifactPath(fixture, 'metadataFile');
    const original = fs.readFileSync(filename), identity = fs.statSync(filename);
    const originals = { readFileSync: fs.readFileSync, readSync: fs.readSync };
    let changed = false, bytesRead = 0;
    function target(fd) {
        if (typeof fd !== 'number' || !new Error().stack.includes('readBoundBytes')) return false;
        const stat = fs.fstatSync(fd);
        if (stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
        if (!changed) { fs.appendFileSync(filename, Buffer.alloc(4096, 0x20)); changed = true; }
        return true;
    }
    fs.readFileSync = function (fd, ...args) {
        const matches = target(fd), counted = bytesRead;
        const bytes = originals.readFileSync.call(this, fd, ...args);
        // Some Node versions implement readFileSync through exported readSync.
        if (matches && bytesRead === counted) bytesRead += bytes.length;
        return bytes;
    };
    fs.readSync = function (fd, ...args) {
        const matches = target(fd), count = originals.readSync.call(this, fd, ...args);
        if (matches) bytesRead += count;
        return count;
    };
    try {
        assert.throws(() => build(fixture), error => error.reasonCode === 'source_changed_during_read');
        assert.equal(changed, true);
        assert.ok(bytesRead <= original.length + 1,
            `实际读取 ${bytesRead}，原记录 ${original.length}，最多允许一个哨兵字节`);
    } finally {
        Object.assign(fs, originals);
        fs.writeFileSync(filename, original);
    }
    assert.equal(build(fixture).analysisReady, true);
});

test('生产来源上下文不公开跳过计划核验的测试辅助入口', () => {
    assert.equal(context.buildConferenceSourceContextForTesting, undefined);
    assert.equal(context.buildConferenceSourceContextFromLedger, undefined);
    assert.throws(() => context.buildConferenceSourceContext({ planHandle: {}, paperId: 'x', sourceRoot: '/tmp' }),
        error => error.reasonCode === 'plan_handle_invalid');
});

test('共享只读计划和成员仅来自登记句柄，保留普通快照隔离且不重复核验整批', t => {
    const fixture = productionPlanFixture(t);
    const authority = planApi.planHandleReadOnlyAuthority(fixture.planHandle);
    const again = planApi.planHandleReadOnlyAuthority(fixture.planHandle);
    assert.equal(authority, again);
    assert.ok(Object.isFrozen(authority.snapshot.run.members[0]));
    assert.ok(Object.isFrozen(authority.snapshot.receipt.members[0]));
    assert.throws(() => { authority.snapshot.run.members[0].paperId = 'forged'; }, TypeError);
    const ordinary = planApi.planHandleAuthority(fixture.planHandle);
    ordinary.snapshot.run.members[0].paperId = 'mutable independent snapshot';
    assert.equal(authority.snapshot.run.members[0].paperId, fixture.paperId);
    const ledger = ledgerApi.ledgerHandleReadOnlyView(authority.ledgerHandle);
    const member = ledgerApi.ledgerHandleReadOnlyMember(authority.ledgerHandle, fixture.sourceIdentity);
    assert.equal(member, ledger.ledger.members[0]);
    assert.ok(Object.isFrozen(member.provenance));
    assert.throws(() => { member.metadataSha256 = '0'.repeat(64); }, TypeError);
    const snapshot = ledgerApi.ledgerHandleSnapshot(authority.ledgerHandle);
    snapshot.ledger.members[0].metadataSha256 = '0'.repeat(64);
    assert.notEqual(member.metadataSha256, snapshot.ledger.members[0].metadataSha256);
    for (const fake of [Object.freeze({}), authority, authority.snapshot]) {
        assert.throws(() => planApi.planHandleReadOnlyAuthority(fake), /经过核验并登记/);
        assert.throws(() => ledgerApi.ledgerHandleReadOnlyView(fake), /authenticated loaded handle/);
        assert.throws(() => ledgerApi.ledgerHandleReadOnlyMember(fake, fixture.sourceIdentity), /authenticated loaded handle/);
    }
    const originals = [planApi.planHandleSnapshot, planApi.planHandleAuthority,
        ledgerApi.ledgerHandleSnapshot, runApi.assertConferenceRunFromVerifiedLedger];
    planApi.planHandleSnapshot = planApi.planHandleAuthority = ledgerApi.ledgerHandleSnapshot
        = runApi.assertConferenceRunFromVerifiedLedger = () => assert.fail('单篇来源重放不得重复克隆或核验完整已认证批次');
    try {
        const first = build(fixture), second = build(fixture);
        assert.equal(first.sourceSnapshotSha256, second.sourceSnapshotSha256);
        assert.deepEqual(first, second);
    } finally {
        [planApi.planHandleSnapshot, planApi.planHandleAuthority,
            ledgerApi.ledgerHandleSnapshot, runApi.assertConferenceRunFromVerifiedLedger] = originals;
    }
});

test('只读句柄缓存不缓存来源字节，同大小同mtime篡改四类来源仍逐篇拒绝', t => {
    const fixture = productionPlanFixture(t);
    build(fixture);
    for (const field of ['metadataFile', 'textFile', 'artifactsFile', 'pdfFile']) {
        const filename = artifactPath(fixture, field), original = fs.readFileSync(filename), stat = fs.statSync(filename);
        const altered = Buffer.from(original); altered[0] ^= 1;
        fs.writeFileSync(filename, altered); fs.utimesSync(filename, stat.atime, stat.mtime);
        try { assert.throws(() => build(fixture), isReplayRejection, field); }
        finally { fs.writeFileSync(filename, original); fs.utimesSync(filename, stat.atime, stat.mtime); }
        assert.equal(build(fixture).analysisReady, true);
    }
});

test('生产来源上下文拒绝调用方另行提供运行记录、执行记录、来源清单或文本', () => {
    for (const extra of [{ run: {} }, { execution: {} }, { ledgerHandle: {} }, { text: 'forged' }]) {
        assert.throws(() => context.buildConferenceSourceContext({ planHandle: {}, paperId: 'x', sourceRoot: '/tmp', ...extra }),
            /包含未允许的字段，或缺少必填字段/);
    }
});

test('已核验计划再次读取来源文件，拒绝内容被替换以及文件或父级目录的符号链接', t => {
    const fixture = productionPlanFixture(t);
    const valid = build(fixture);
    assert.equal(valid.analysisReady, true);
    assert.equal(valid.productionAuthorization.authorized, true);
    const textFile = artifactPath(fixture, 'textFile');
    replaceBytes(textFile, Buffer.from(`${valid.text}\nreplaced`), () => {
        assert.throws(() => build(fixture), isReplayRejection);
    });

    const savedText = `${textFile}.saved`; fs.renameSync(textFile, savedText); fs.symlinkSync(savedText, textFile);
    try { assert.throws(() => build(fixture), isReplayRejection); }
    finally { fs.unlinkSync(textFile); fs.renameSync(savedText, textFile); }

    const memberDirectory = path.dirname(textFile); const savedDirectory = `${memberDirectory}.saved`;
    fs.renameSync(memberDirectory, savedDirectory); fs.symlinkSync(savedDirectory, memberDirectory);
    try { assert.throws(() => build(fixture), isReplayRejection); }
    finally { fs.unlinkSync(memberDirectory); fs.renameSync(savedDirectory, memberDirectory); }
});

test('使用计划来源时拒绝非法 UTF-8、重复 JSON、过短文本或结构化提取记录被改动', t => {
    const fixture = productionPlanFixture(t); const valid = build(fixture);
    const textFile = artifactPath(fixture, 'textFile'); const metadataFile = artifactPath(fixture, 'metadataFile');
    const artifactsFile = artifactPath(fixture, 'artifactsFile');
    replaceBytes(textFile, Buffer.from([0xc3, 0x28]), () => {
        assert.throws(() => build(fixture), isReplayRejection);
    });
    replaceBytes(metadataFile, Buffer.from('{"identity":{},"identity":{}}'), () => {
        assert.throws(() => build(fixture), isReplayRejection);
    });
    replaceBytes(textFile, Buffer.from('short'), () => {
        assert.throws(() => build(fixture), isReplayRejection);
    });
    const artifact = structuredClone(valid.structuredArtifacts);
    artifact.flattenedTextSha256 = '0'.repeat(64);
    replaceBytes(artifactsFile, Buffer.from(`${JSON.stringify(artifact)}\n`), () => {
        assert.throws(() => build(fixture), isReplayRejection);
    });
    artifact.flattenedTextSha256 = valid.structuredArtifacts.flattenedTextSha256;
    artifact.payloadSha256 = '0'.repeat(64);
    replaceBytes(artifactsFile, Buffer.from(`${JSON.stringify(artifact)}\n`), () => {
        assert.throws(() => build(fixture), isReplayRejection);
    });
    artifact.payloadSha256 = valid.structuredArtifacts.payloadSha256;
    artifact.pages[0].textEnd -= 1;
    replaceBytes(artifactsFile, Buffer.from(`${JSON.stringify(artifact)}\n`), () => {
        assert.throws(() => build(fixture), isReplayRejection);
    });
});

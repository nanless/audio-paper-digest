'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const context = require('../scripts/lib/conference-source-context.js');
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

test('生产来源上下文不提供任何绕过账目或运行测试的口子', () => {
    assert.equal(context.buildConferenceSourceContextForTesting, undefined);
    assert.equal(context.buildConferenceSourceContextFromLedger, undefined);
    assert.throws(() => context.buildConferenceSourceContext({ planHandle: {}, paperId: 'x', sourceRoot: '/tmp' }),
        error => error.reasonCode === 'plan_handle_invalid');
});

test('生产来源上下文拒绝调用方自带运行、执行、账目或文本', () => {
    for (const extra of [{ run: {} }, { execution: {} }, { ledgerHandle: {} }, { text: 'forged' }]) {
        assert.throws(() => context.buildConferenceSourceContext({ planHandle: {}, paperId: 'x', sourceRoot: '/tmp', ...extra }),
            /unknown or missing fields/);
    }
});

test('真实的已核验计划会复核来源字节，拒绝被替换的内容以及叶子和父级符号链接', t => {
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

test('真实计划授权在使用之前就拒绝非法 UTF-8、重复 JSON、过短文本和产物语义漂移', t => {
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

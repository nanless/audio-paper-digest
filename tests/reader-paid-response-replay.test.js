'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const repair = require('../scripts/lib/reader-repair');

function controlledModule({ lockHeld = true, scopePresent = true } = {}) {
    const filename = path.resolve(__dirname, '../scripts/lib/reader-paid-response-replay.js');
    const instance = new Module(filename, module);
    instance.filename = filename;
    instance.paths = Module._nodeModulePaths(path.dirname(filename));
    const normalRequire = instance.require.bind(instance);
    instance.require = name => {
        if (name === './fresh-analysis-context') {
            return {
                getFreshAnalysisContext: () => scopePresent ? {} : null,
                freshAnalysisIdentity: () => ({ runId: 'sealed-run' }),
                freshReaderAttemptsDirectory: directory => directory
            };
        }
        if (name === '../analysis-engine') {
            return { paperAnalysisLockHeld: () => lockHeld };
        }
        return normalRequire(name);
    };
    instance._compile(fs.readFileSync(filename, 'utf8'), filename);
    return instance.exports;
}

function controlledInput() {
    const identity = {
        paperId: '2610.07047', freshAnalysis: { runId: 'sealed-run' },
        contentMode: 'reader-source-signed-revision-v1',
        model: { model: 'muse-spark-1.3-contributor' },
        tableCompilerSha256: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64),
        parserImplementationSha256: 'c'.repeat(64)
    };
    const old = {
        envelopeSha256: 'd'.repeat(64),
        envelope: {
            identity,
            payload: { status: 'failed', attempts: 3, fullAttempts: 2, transportFailures: 0 }
        }
    };
    const options = {
        candidateIdentitySha256: repair.hashDraft(identity), candidateFileSha256: old.envelopeSha256,
        responseFile: '/unused/response.json', responseFileSha256: 'e'.repeat(64),
        usageFileName: '00000000-0000-0000-0000-000000000001.json', usageFileSha256: 'f'.repeat(64),
        usageEventId: '00000000-0000-0000-0000-000000000002',
        repairDiagnosticId: '00000000-0000-0000-0000-000000000003',
        repairRequestSha256: '1'.repeat(64), repairResponseSha256: '2'.repeat(64)
    };
    return { old, options, identity: { ...identity, parserImplementationSha256: '3'.repeat(64) } };
}

function expectRejected(helper, sample) {
    assert.throws(() => helper.replayPaidReaderResponse('/unused', sample.old, sample.identity, sample.options), error => {
        assert.equal(error.code, 'READER_PAID_RESPONSE_REPLAY_REJECTED');
        assert.equal(error.retryable, false);
        assert.equal(error.scope, 'run');
        return true;
    });
}

test('原响应复验必须处于当前封存来源和论文锁内', () => {
    expectRejected(controlledModule({ lockHeld: false }), controlledInput());
    expectRejected(controlledModule({ scopePresent: false }), controlledInput());
});

test('参数、原候选和付费次数不能由调用方放宽', () => {
    for (const change of [
        sample => { sample.options.extra = true; },
        sample => { sample.options.candidateFileSha256 = '0'.repeat(64); },
        sample => { sample.old.envelope.payload.attempts = 2; },
        sample => { sample.old.envelope.payload.fullAttempts = 1; },
        sample => { sample.old.envelope.payload.explicitReaderRetryRound = {}; }
    ]) {
        const sample = controlledInput();
        change(sample);
        expectRejected(controlledModule(), sample);
    }
});

test('新实现复验不能更换原模型、逻辑输入、提示或恢复轮身份', () => {
    for (const field of ['inputFingerprint', 'readerArticlePromptSha256', 'readerRecoveryEpochSha256']) {
        const sample = controlledInput();
        sample.identity[field] = '0'.repeat(64);
        expectRejected(controlledModule(), sample);
    }
    const sample = controlledInput();
    sample.identity.model = { model: 'another-model' };
    expectRejected(controlledModule(), sample);
});

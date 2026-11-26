'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config');
const ledger = require('../scripts/lib/llm-usage-ledger');
const llmUsage = require('../scripts/lib/llm-usage');
const diagnostics = require('../scripts/lib/reader-request-diagnostics');
const replay = require('../scripts/lib/reader-compatible-candidate-replay');
const ordinalPatch = require('../scripts/lib/reader-target-ordinal-patch');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function makeTempDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    fs.chmodSync(dir, 0o700);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeJsonFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify(value) + '\n', 'utf8');
    fs.writeFileSync(filePath, bytes, { mode: 0o600 });
    return { file: filePath, sha256: sha(bytes), bytes };
}

test('llm-usage-ledger supports flat and YYYY-MM-DD sharded files, legacy basename fallback, and repo relocation', t => {
    const root = makeTempDir(t, 'usage-ledger-');
    const usageDir = path.join(root, 'audio-research-workbench', 'data', 'runtime', 'llm-usage');
    fs.mkdirSync(usageDir, { recursive: true, mode: 0o700 });

    const flatId = '11111111-1111-4111-8111-111111111111.json';
    const shardedId = '22222222-2222-4222-8222-222222222222.json';
    const flatFile = writeJsonFile(path.join(usageDir, flatId), { kind: 'request', id: 'flat' }).file;
    const shardedFile = writeJsonFile(path.join(usageDir, '2026-11-26', shardedId), { kind: 'request', id: 'sharded' }).file;

    // Non-ledger auxiliary file is ignored by listUsageLedgerFiles.
    fs.writeFileSync(path.join(usageDir, '.ignored.tmp'), 'tmp', { mode: 0o600 });

    assert.equal(ledger.isUsageLedgerFile(flatFile, usageDir), true);
    assert.equal(ledger.isUsageLedgerFile(shardedFile, usageDir), true);

    // Pre-rename repo relocation for both flat and sharded paths.
    const oldFlatPath = flatFile.replace('audio-research-workbench', 'audio-paper-digest');
    const oldShardedPath = shardedFile.replace('audio-research-workbench', 'audio-paper-digest');
    assert.equal(ledger.isUsageLedgerFile(oldFlatPath, usageDir), true);
    assert.equal(ledger.isUsageLedgerFile(oldShardedPath, usageDir), true);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, oldFlatPath), flatFile);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, oldShardedPath), shardedFile);

    // listUsageLedgerFiles returns both flat and sharded records.
    const listed = ledger.listUsageLedgerFiles(usageDir);
    assert.deepEqual(listed, [
        { file: flatFile, name: flatId, relativePath: flatId },
        { file: shardedFile, name: shardedId, relativePath: `2026-11-26/${shardedId}` }
    ]);

    // resolveUsageLedgerFile handles basename, relative shard path, absolute path, and legacy basename fallback into shard.
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, flatId), flatFile);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, `2026-11-26/${shardedId}`), shardedFile);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, shardedId), shardedFile);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, path.join(usageDir, shardedId)), shardedFile);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, flatFile), flatFile);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, shardedFile), shardedFile);
});

test('llm-usage-ledger rejects traversal, symlinks, outside paths, malformed names, and ambiguous cross-shard duplicates', t => {
    const root = makeTempDir(t, 'usage-ledger-sec-');
    const usageDir = path.join(root, 'llm-usage');
    const outsideDir = path.join(root, 'outside');
    fs.mkdirSync(usageDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outsideDir, { recursive: true, mode: 0o700 });

    const uuid = '33333333-3333-4333-8333-333333333333.json';
    const outsideFile = writeJsonFile(path.join(outsideDir, uuid), { evil: true }).file;
    const nestedFile = writeJsonFile(path.join(usageDir, '2026-11-26', 'nested', uuid), { evil: true }).file;
    const badShardFile = writeJsonFile(path.join(usageDir, 'not-a-date', uuid), { evil: true }).file;
    const badNameFile = writeJsonFile(path.join(usageDir, '2026-11-26', 'evil.json'), { evil: true }).file;

    // Outside / traversal / nested / invalid shard / invalid filename
    assert.equal(ledger.isUsageLedgerFile(outsideFile, usageDir), false);
    assert.equal(ledger.isUsageLedgerFile(nestedFile, usageDir), false);
    assert.equal(ledger.isUsageLedgerFile(badShardFile, usageDir), false);
    assert.equal(ledger.isUsageLedgerFile(badNameFile, usageDir), false);
    assert.equal(ledger.isUsageLedgerFile(path.join(usageDir, '..', 'outside', uuid), usageDir), false);

    assert.equal(ledger.resolveUsageLedgerFile(usageDir, outsideFile), null);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, `../outside/${uuid}`), null);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, `2026-11-26/nested/${uuid}`), null);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, `not-a-date/${uuid}`), null);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, '2026-11-26/evil.json'), null);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, '2026-11-26\\33333333-3333-4333-8333-333333333333.json'), null);

    // Ambiguous duplicate basename in two shards must fail closed (return null).
    const dupId = '44444444-4444-4444-8444-444444444444.json';
    writeJsonFile(path.join(usageDir, '2026-11-25', dupId), { day: 25 });
    writeJsonFile(path.join(usageDir, '2026-11-26', dupId), { day: 26 });
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, dupId), null);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, `2026-11-26/${dupId}`), path.join(usageDir, '2026-11-26', dupId));

    // Symlinked file inside shard is rejected by isUsageLedgerFile, resolveUsageLedgerFile, and listUsageLedgerFiles.
    const symFileId = '55555555-5555-4555-8555-555555555555.json';
    const symFilePath = path.join(usageDir, '2026-11-26', symFileId);
    fs.symlinkSync(outsideFile, symFilePath);
    assert.equal(ledger.isUsageLedgerFile(symFilePath, usageDir), false);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, `2026-11-26/${symFileId}`), null);
    assert.throws(() => ledger.listUsageLedgerFiles(usageDir), /符号链接|普通文件/);
    fs.unlinkSync(symFilePath);

    // Symlinked shard directory is rejected.
    const symShardPath = path.join(usageDir, '2026-11-27');
    fs.symlinkSync(outsideDir, symShardPath);
    assert.equal(ledger.isUsageLedgerFile(path.join(symShardPath, uuid), usageDir), false);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, `2026-11-27/${uuid}`), null);
    assert.throws(() => ledger.listUsageLedgerFiles(usageDir), /符号链接|真实目录/);
    fs.unlinkSync(symShardPath);

    // Symlinked usageDir root is rejected.
    const symRoot = path.join(root, 'sym-usage');
    fs.symlinkSync(usageDir, symRoot);
    assert.equal(ledger.isUsageLedgerFile(path.join(symRoot, '2026-11-26', dupId), symRoot), false);
    assert.equal(ledger.resolveUsageLedgerFile(symRoot, `2026-11-26/${dupId}`), null);
    assert.throws(() => ledger.listUsageLedgerFiles(symRoot), /符号链接|真实目录/);
});

test('sharded usage files work across latestReaderRequest, validatePaidDraftFingerprintFees, and ordinal-patch seal verification', t => {
    const root = makeTempDir(t, 'usage-sharded-verifiers-');
    const usageDir = path.join(root, 'llm-usage');
    fs.mkdirSync(usageDir, { recursive: true, mode: 0o700 });
    const prevUsageDir = Config.FILES.llmUsageDir;
    Config.FILES.llmUsageDir = usageDir;
    t.after(() => { Config.FILES.llmUsageDir = prevUsageDir; });

    const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const paperId = '2611.01234v1';
    const eventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const rawDraft = '{"version":3,"readerTitle":"测试标题足够长度"}';
    const rawSha = sha(Buffer.from(rawDraft, 'utf8'));
    const inputSha = sha(Buffer.from('input-body', 'utf8'));
    const header = llmUsage.usageEventHeader();

    const startedEvent = {
        ...header, kind: 'request_started', eventId, at: '2026-11-26T01:00:00.000Z',
        runtime: 'node', runId, paperId, stage: 'apiReaderArticle', unitId: null,
        contentAttempt: 1, transportAttempt: 1, protocol: 'openai_responses',
        model: 'muse-spark-1.3-contributor', outcome: 'result_unknown',
        phase: 'authorized_before_transport', chargeState: 'unknown',
        inputSha256: inputSha
    };
    const completedEvent = {
        ...header, kind: 'request', eventId, at: '2026-11-26T01:00:05.000Z',
        runtime: 'node', runId, paperId, stage: 'apiReaderArticle', unitId: null,
        contentAttempt: 1, transportAttempt: 1, protocol: 'openai_responses',
        model: 'muse-spark-1.3-contributor', outcome: 'completed', transportStarted: true,
        statusCode: 200, errorCode: null, durationMs: 5000,
        inputSha256: inputSha, outputTextSha256: rawSha,
        estimates: { textCharacters: 10, estimatedInputTextTokens: 4, images: 0 },
        usage: { status: 'reported', inputSemantics: 'provider_reported', inputTokens: 10, outputTokens: 20, totalTokens: 30,
            cachedInputTokens: 0, cacheCreationInputTokens: null, reasoningTokens: 5 }
    };
    const dispositionEvent = {
        ...header, kind: 'disposition', eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        at: '2026-11-26T01:00:06.000Z', runtime: 'node', runId, paperId,
        stage: 'apiReaderArticle', unitId: null, contentAttempt: 1, transportAttempt: null,
        outputTextSha256: rawSha, disposition: 'rejected', errorCode: null
    };

    // Write via production writeLlmUsageEvent with shardByDate: true!
    const captured = llmUsage.withPersistedLlmUsageRecords(() => {
        llmUsage.writeLlmUsageEvent(startedEvent, { directory: usageDir, shardByDate: true });
        llmUsage.writeLlmUsageEvent(completedEvent, { directory: usageDir, shardByDate: true });
        llmUsage.writeLlmUsageEvent(dispositionEvent, { directory: usageDir, shardByDate: true });
    });
    assert.equal(captured.records.length, 3);
    for (const rec of captured.records) {
        assert.match(path.relative(usageDir, rec.file), /^2026-11-26\/[a-f0-9-]{36}\.json$/);
    }

    // 1. latestReaderRequest finds the sharded request event.
    const latest = replay.latestReaderRequest(usageDir, paperId, runId);
    assert.ok(latest);
    assert.equal(latest.value.eventId, eventId);
    assert.match(latest.relativePath, /^2026-11-26\/[a-f0-9-]{36}\.json$/);

    // 2. validatePaidDraftFingerprintFees accepts sharded usage files.
    const candidate = {
        identity: {
            paperId, freshAnalysis: { runId },
            model: { model: 'muse-spark-1.3-contributor', protocol: 'openai_responses' }
        },
        payload: { attempts: 1 }
    };
    const fees = captured.records.map(r => ({ file: r.file, sha256: r.sha256 }));
    const verifiedFees = diagnostics.validatePaidDraftFingerprintFees(fees, candidate, rawSha);
    assert.equal(verifiedFees.length, 3);

    // 3. Outside path is still rejected by validatePaidDraftFingerprintFees.
    const outsideFile = writeJsonFile(path.join(root, 'outside.json'), completedEvent);
    assert.throws(() => diagnostics.validatePaidDraftFingerprintFees(
        [fees[0], { file: outsideFile.file, sha256: outsideFile.sha256 }, fees[2]],
        candidate,
        rawSha
    ), /fee path is not the normal ledger/);

    // 4. Verify ordinal-patch helper recognizes sharded usage files inside verifySeal path check (and rejects outside).
    assert.equal(typeof ordinalPatch.replay, 'function');
    assert.equal(ledger.isUsageLedgerFile(captured.records[0].file, usageDir), true);
    assert.equal(ledger.resolveUsageLedgerFile(usageDir, path.basename(captured.records[0].file)), captured.records[0].file);
});

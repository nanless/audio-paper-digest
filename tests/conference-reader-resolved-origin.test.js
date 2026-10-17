'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const repair = require('../scripts/lib/reader-repair');
const origin = require('../scripts/lib/conference-reader-resolved-origin');
const filename = path.resolve(__dirname, '../scripts/lib/conference-reader-resolved-origin.js');
const program = fs.readFileSync(filename, 'utf8');

// Execute private pure validation spans without exporting production authority
// or constructing a grant/source/qualification success in these unit tests.
const shapeStart = program.indexOf('    const names = fs.readdirSync(directory);', program.indexOf('function inspectLatestResolvedPaidReader'));
const shapeEnd = program.indexOf('    const current = ', shapeStart);
const ledgerStart = program.indexOf('            const allowed = ', program.indexOf('function inspectLatestResolvedPaidReader'));
const ledgerEnd = program.indexOf('            const raw = ', ledgerStart);
assert.ok(shapeStart > 0 && shapeEnd > shapeStart && ledgerStart > 0 && ledgerEnd > ledgerStart);
const isolated = new Module(filename, module);
isolated.filename = filename;
isolated.paths = Module._nodeModulePaths(path.dirname(filename));
isolated._compile(program + `
module.exports.__pure = { migrationChain,
    shape(namesInput, hasLedger) {
        const fs = { readdirSync: () => namesInput, existsSync: () => hasLedger };
        const directory = '/pure/no-source-capability';
        const loaded = { directory };
        ${program.slice(shapeStart, shapeEnd)}
        return resolved;
    },
    frontier(ledger, selected, originalIdentity) {
        const payload = selected.payload, chain = { originalIdentity };
        ${program.slice(ledgerStart, ledgerEnd)}
        return latest;
    }
};`, filename);
const pure = isolated.exports.__pure;
const integrity = error => error.code === 'CONFERENCE_READER_RESOLVED_ORIGIN_INTEGRITY' && error.scope === 'run';

test('unbranded JSON can neither authorize local edits nor downgrade integrity to paper-level', () => {
    for (const invoke of [
        () => origin.readVerifiedOrigin({}),
        () => origin.assertOriginalPaidOrigin({}, {}),
        () => origin.replayLocalPatch({}, {}),
        () => origin.assertDeferredLocalCorrection({})
    ]) assert.throws(invoke, integrity);
});

test('active and absent origins keep the normal route; ambiguous retired origins fail closed', () => {
    const resolved = 'a'.repeat(64) + '.00000000-0000-4000-8000-000000000001.resolved.json';
    assert.equal(pure.shape(['b'.repeat(64) + '.json', resolved], true), null);
    assert.equal(pure.shape([], true), null);
    assert.equal(pure.shape([resolved], false), null);
    assert.deepEqual(pure.shape([resolved], true), [resolved]);
    assert.throws(() => pure.shape([resolved, resolved.replace(/^a/, 'b')], true), integrity);
});

test('latest paid frontier cannot select an older response or invent unused counters', () => {
    const identity = { paperId: 'conference:pure-test', inputFingerprint: 'literal-test' };
    const payload = { attempts: 2, fullAttempts: 1 };
    const logical = Object.fromEntries(Object.entries(identity));
    const ledger = { value: { logicalIdentitySha256: repair.hashDraft(logical), requests: [
        { kind: 'full', status: 'content', contentAttempt: 1, identitySha256: repair.hashDraft(identity) },
        { kind: 'patch', status: 'content', contentAttempt: 2, identitySha256: repair.hashDraft(identity) }
    ] } };
    assert.equal(pure.frontier(ledger, { payload }, identity).contentAttempt, 2);
    for (const mutate of [
        value => { value.value.requests[1].contentAttempt = 1; },
        value => { value.value.requests[1].identitySha256 = '0'.repeat(64); },
        value => { value.value.requests[1].status = 'pending'; },
        value => { value.value.logicalIdentitySha256 = '0'.repeat(64); },
        value => { value.value.requests.pop(); }
    ]) {
        const changed = structuredClone(ledger);
        mutate(changed);
        assert.throws(() => pure.frontier(changed, { payload }, identity), integrity);
    }
});

test('immutable migration bytes and original failed history cannot be changed', t => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'resolved-origin-pure-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const originalIdentity = { paperId: 'conference:pure-test',
        conferenceReaderGrant: { executionId: '00000000-0000-4000-8000-000000000001' },
        parserImplementationSha256: '1'.repeat(64) };
    const payload = { status: 'failed', draft: sample.draft, attempts: 2, fullAttempts: 1,
        noProgress: 1, validationFailureStreak: 2, issues: [], failureSignature: 'literal-test' };
    const envelope = { version: repair.REPAIR_VERSION, identity: originalIdentity,
        payload, payloadSha256: repair.hashDraft(payload) };
    const name = repair.hashDraft(originalIdentity) + '.migrated-00000000-0000-4000-8000-000000000001.json';
    const file = path.join(directory, name), bytes = Buffer.from(JSON.stringify(envelope));
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const nextIdentity = { ...originalIdentity, parserImplementationSha256: '2'.repeat(64) };
    const draftSha = repair.hashDraft(payload.draft);
    const audit = { contract: 'reader-recovery-diagnostics-revision-v1', scope: 'conference-process',
        paperId: originalIdentity.paperId, runId: originalIdentity.conferenceReaderGrant.executionId,
        fromIdentitySha256: repair.hashDraft(originalIdentity), toIdentitySha256: repair.hashDraft(nextIdentity),
        oldEnvelopeSha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
        oldPayloadSha256: repair.hashDraft(payload), archivedName: name, clearedNoProgress: false,
        inputDraftSha256: draftSha, outputDraftSha256: draftSha, changedFields: ['parserImplementationSha256'] };
    const selected = { identity: nextIdentity, payload: { ...payload, readerRecoveryRevisions: [audit] } };
    assert.deepEqual(pure.migrationChain(directory, selected).originalIdentity, originalIdentity);
    for (const mutate of [
        value => { value.payload.readerRecoveryRevisions[0].clearedNoProgress = true; },
        value => { value.payload.readerRecoveryRevisions[0].changedFields = ['model']; },
        value => { value.payload.noProgress = 0; }
    ]) {
        const changed = structuredClone(selected);
        mutate(changed);
        assert.throws(() => pure.migrationChain(directory, changed), integrity);
    }
    fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from('\n')]), { mode: 0o600 });
    assert.throws(() => pure.migrationChain(directory, selected), integrity);
});

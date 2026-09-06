'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger, writeLedger, loadLedgerHandle } = require('../scripts/lib/conference-source-ledger.js');
const { createConferenceRunFromVerifiedLedger } = require('../scripts/lib/conference-run.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const { parseArgs, safeRuntimeFile, validateLedgerFile, validateRunFile } = require('../scripts/conference-tools.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = '2026-09-06T00:00:00.000Z';

function fixtureMember(root) {
    const files = { metadata: 'meta/1001.json', pdf: 'pdf/1001.pdf', text: 'text/1001.txt', artifacts: 'artifacts/1001.json' };
    const values = { metadata: '{"id":1001}', pdf: '%PDF-1.4\nfixture', text: 'conference text', artifacts: '{}' };
    for (const [kind, relative] of Object.entries(files)) {
        const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, values[kind]);
    }
    return {
        identity: { type: 'icassp-arnumber', value: '1001' },
        metadataFile: files.metadata, metadataSha256: sha(values.metadata), pdfFile: files.pdf, pdfSha256: sha(values.pdf),
        textFile: files.text, textSha256: sha(values.text), artifactsFile: files.artifacts, artifactsSha256: sha(values.artifacts),
        status: { state: 'verified', updatedAt: stamp, reason: 'official identity bound', evidence: [
            { kind: 'metadata', sha256: sha(values.metadata) }, { kind: 'pdf', sha256: sha(values.pdf) },
            { kind: 'text', sha256: sha(values.text) }, { kind: 'artifacts', sha256: sha(values.artifacts) }
        ] }
    };
}

test('conference maintenance CLI accepts only configured direct filenames', () => {
    assert.deepEqual(parseArgs(['validate-ledger', '--ledger', 'icassp-2026.json']), { command: 'validate-ledger', ledgerName: 'icassp-2026.json' });
    assert.deepEqual(parseArgs(['validate-run', '--run', 'run-1.json', '--ledger', 'icassp-2026.json']), { command: 'validate-run', runName: 'run-1.json', ledgerName: 'icassp-2026.json' });
    for (const args of [[], ['validate-ledger', '--ledger', '../x.json'], ['verify-ledger', '--run', 'x.json'], ['validate-run', '--run', 'x.json', '--extra'], ['validate-run', '--run', 'x.json', '--ledger', '../x.json']]) assert.throws(() => parseArgs(args));
});

test('conference CLI validates ledger files and run files only below configured roots', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-tools-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ledgerDirectory = path.join(root, 'ledgers'); const sourceRoot = path.join(root, 'sources'); const runsDirectory = path.join(root, 'runs');
    fs.mkdirSync(ledgerDirectory); fs.mkdirSync(sourceRoot); fs.mkdirSync(runsDirectory);
    const ledger = createLedger({ id: 'icassp-2026', year: 2026 }, [fixtureMember(sourceRoot)]);
    writeLedger(path.join(ledgerDirectory, 'icassp-2026.json'), ledger);
    const checked = validateLedgerFile({ ledgerDirectory, sourceRoot, ledgerName: 'icassp-2026.json', verifyFiles: true });
    assert.equal(checked.members, 1); assert.equal(checked.filesVerified, true);
    const ledgerHandle = loadLedgerHandle(path.join(ledgerDirectory, 'icassp-2026.json'));
    const paperId = paperIdentity.canonicalConferencePaperId(
        { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value: '1001' });
    const run = createConferenceRunFromVerifiedLedger({ ledgerHandle, taxonomyVersion: 'paper-taxonomy-v1',
        filterPolicySha256: 'a'.repeat(64), selectionReceiptSha256: 'b'.repeat(64),
        selectedMemberSetSha256: require('../scripts/lib/conference-run.js').stableHash([paperId]),
        members: [{ paperId, sourceIdentity: 'icassp-arnumber:1001' }], shards: [{ shardId: 'all', paperIds: [paperId] }] });
    fs.writeFileSync(path.join(runsDirectory, 'run-1.json'), JSON.stringify(run));
    assert.equal(validateRunFile({ runsDirectory, runName: 'run-1.json', ledgerDirectory, ledgerName: 'icassp-2026.json' }).conference, 'icassp-2026');
    assert.throws(() => safeRuntimeFile(ledgerDirectory, '../icassp-2026.json'));
    fs.symlinkSync(path.join(ledgerDirectory, 'icassp-2026.json'), path.join(ledgerDirectory, 'link.json'));
    assert.throws(() => validateLedgerFile({ ledgerDirectory, sourceRoot, ledgerName: 'link.json' }));
});

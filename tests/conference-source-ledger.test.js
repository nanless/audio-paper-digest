'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledger = require('../scripts/lib/conference-source-ledger.js');

const NOW = '2026-09-06T08:00:00.000Z';

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conference-ledger-')));
    for (const dir of ['metadata', 'pdf', 'text', 'artifacts']) fs.mkdirSync(path.join(root, dir));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function member(root, type, value) {
    const stem = `${type}-${value}`;
    const files = {
        metadataFile: `metadata/${stem}.json`, pdfFile: `pdf/${stem}.pdf`,
        textFile: `text/${stem}.txt`, artifactsFile: `artifacts/${stem}.json`
    };
    const contents = {
        metadataFile: Buffer.from(`metadata:${stem}`), pdfFile: Buffer.from(`pdf:${stem}`),
        textFile: Buffer.from(`text:${stem}`), artifactsFile: Buffer.from(`artifacts:${stem}`)
    };
    for (const [field, relative] of Object.entries(files)) fs.writeFileSync(path.join(root, relative), contents[field], { mode: 0o600 });
    const result = {
        identity: { type, value }, ...files,
        metadataSha256: ledger.sha256(contents.metadataFile), pdfSha256: ledger.sha256(contents.pdfFile),
        textSha256: ledger.sha256(contents.textFile), artifactsSha256: ledger.sha256(contents.artifactsFile),
        availability: { metadata: 'present', pdf: 'present', text: 'present', artifacts: 'present' }
    };
    result.provenance = {
        metadata: { kind: 'official-metadata', locator: `https://example.test/metadata/${stem}`, retrievedAt: NOW },
        pdf: { kind: 'official-pdf', locator: `https://example.test/pdf/${stem}`, retrievedAt: NOW },
        text: { extractor: 'fixture-text-extractor', version: '1.0.0', inputSha256: result.pdfSha256 },
        artifacts: { extractor: 'fixture-artifact-extractor', version: '1.0.0', inputSha256: result.pdfSha256 }
    };
    result.status = {
        state: 'verified', updatedAt: NOW, reason: '本机 PDF、提取文本和工件已逐项校验。',
        evidence: ['metadata', 'pdf', 'text', 'artifacts'].map(kind => ({ kind, sha256: result[`${kind}Sha256`] }))
    };
    return result;
}

function removeArtifact(memberValue, kind, state = 'blocked') {
    const result = structuredClone(memberValue);
    result.availability[kind] = 'absent';
    result[`${kind}File`] = null;
    result[`${kind}Sha256`] = null;
    result.provenance[kind] = null;
    result.status = {
        state, updatedAt: NOW, reason: `已核身份，但 ${kind} 来源尚不可重放。`,
        evidence: result.status.evidence.filter(item => item.kind !== kind)
    };
    return result;
}

function makeLedger(root, members) {
    const ordered = [...members].sort((a, b) => ledger.identityKey(a.identity).localeCompare(ledger.identityKey(b.identity), 'en'));
    return {
        version: ledger.CONTRACT, conference: { id: 'icassp-2026', year: 2026 }, members: ordered,
        memberSetSha256: ledger.memberSetSha256(ordered)
    };
}

test('conference-source-ledger-v1 accepts all supported non-title identities and binds local source SHA evidence', t => {
    const root = fixture(t);
    const source = ledger.createLedger({ id: 'icassp-2026', year: 2026 }, [
        member(root, 'openreview-forum-id', 'AbCdef_12'),
        member(root, 'conference-paper-id', '27'),
        member(root, 'icassp-arnumber', '10910001')
    ]);
    assert.equal(ledger.validateLedger(source), source);
    assert.equal(ledger.verifyMemberFiles(source, root), true);
    assert.deepEqual(source.members.map(item => ledger.identityKey(item.identity)), [
        'conference-paper-id:27', 'icassp-arnumber:10910001', 'openreview-forum-id:AbCdef_12'
    ]);
    assert.equal(ledger.memberSetSha256([...source.members].reverse()), source.memberSetSha256);
    assert.throws(() => ledger.validateIdentity({ type: 'icassp-arnumber', value: 'A paper title is never an ID' }), /invalid/);
    const withTitle = structuredClone(source);
    withTitle.members[0].title = 'A title must not become identity data';
    assert.throws(() => ledger.validateLedger(withTitle), /unexpected/);
});

test('member list is canonicalized by identity only and rejects duplicate, unsorted, or stale member hashes', t => {
    const root = fixture(t);
    const first = member(root, 'icassp-arnumber', '100');
    const second = member(root, 'openreview-forum-id', 'Forum_2');
    const source = makeLedger(root, [first, second]);
    const duplicate = structuredClone(source);
    duplicate.members.push(structuredClone(duplicate.members[0]));
    duplicate.memberSetSha256 = ledger.memberSetSha256(duplicate.members);
    assert.throws(() => ledger.validateLedger(duplicate), /duplicate identities/);
    const unsorted = structuredClone(source);
    unsorted.members.reverse();
    unsorted.memberSetSha256 = ledger.memberSetSha256(unsorted.members);
    assert.throws(() => ledger.validateLedger(unsorted), /sorted/);
    const stale = structuredClone(source);
    stale.memberSetSha256 = 'a'.repeat(64);
    assert.throws(() => ledger.validateLedger(stale), /memberSetSha256 mismatch/);
});

test('schema fails closed on unbound evidence, malformed statuses, and invalid identity spellings', t => {
    const root = fixture(t);
    const source = makeLedger(root, [member(root, 'icassp-arnumber', '101')]);
    const badEvidence = structuredClone(source);
    badEvidence.members[0].status.evidence[1].sha256 = 'b'.repeat(64);
    assert.throws(() => ledger.validateLedger(badEvidence), /not bound/);
    const missingEvidence = structuredClone(source);
    missingEvidence.members[0].status.evidence.pop();
    assert.throws(() => ledger.validateLedger(missingEvidence), /exactly the present/);
    const badStatus = structuredClone(source);
    badStatus.members[0].status.updatedAt = '2026-09-06';
    assert.throws(() => ledger.validateLedger(badStatus), /canonical UTC/);
    for (const [type, value] of [
        ['icassp-arnumber', '001'], ['conference-paper-id', '0'], ['openreview-forum-id', 'short'],
        ['openreview-forum-id', 'a space 9'], ['unknown', '123']
    ]) assert.throws(() => ledger.validateIdentity({ type, value }));
});

test('identity-verified members can remain blocked or needs-review with explicitly absent replay artifacts', t => {
    const root = fixture(t);
    const base = member(root, 'icassp-arnumber', '102');
    const blocked = removeArtifact(removeArtifact(removeArtifact(base, 'artifacts'), 'text'), 'pdf');
    const source = makeLedger(root, [blocked]);
    assert.equal(ledger.validateLedger(source), source);
    assert.throws(() => ledger.verifyMemberFiles(source, root), /non-verified members.*not ready/);

    const review = removeArtifact(base, 'artifacts', 'needs-review');
    assert.equal(ledger.validateLedger(makeLedger(root, [review])).members[0].status.state, 'needs-review');

    const absentWithBytes = structuredClone(source);
    absentWithBytes.members[0].pdfFile = 'pdf/icassp-arnumber-102.pdf';
    assert.throws(() => ledger.validateLedger(absentWithBytes), /must be null when pdf is absent/);
    const absentWithEvidence = structuredClone(source);
    absentWithEvidence.members[0].status.evidence.push({ kind: 'pdf', sha256: base.pdfSha256 });
    assert.throws(() => ledger.validateLedger(absentWithEvidence), /exactly the present/);

    // The stale physical artifact is deliberately left in the cache.  A
    // blocked ledger may be inspected, but its absent artifact is not part of
    // byte replay and cannot accidentally turn the member into ready.
    const onlyArtifactsAbsent = removeArtifact(base, 'artifacts');
    fs.writeFileSync(path.join(root, base.artifactsFile), 'stale absent bytes');
    assert.throws(() => ledger.verifyMemberFiles(makeLedger(root, [onlyArtifactsAbsent]), root), /non-verified members.*not ready/);
});

test('complete replay artifacts, complete SHA evidence, and derived extraction provenance are exclusive to verified members', t => {
    const root = fixture(t);
    const base = member(root, 'conference-paper-id', '103');
    const nonVerifiedComplete = structuredClone(base);
    nonVerifiedComplete.status.state = 'needs-review';
    assert.throws(() => ledger.validateLedger(makeLedger(root, [nonVerifiedComplete])), /only verified/);

    const verifiedIncomplete = removeArtifact(base, 'artifacts');
    verifiedIncomplete.status.state = 'verified';
    assert.throws(() => ledger.validateLedger(makeLedger(root, [verifiedIncomplete])), /only verified/);

    const noExtractor = structuredClone(base);
    noExtractor.provenance.text.version = '';
    assert.throws(() => ledger.validateLedger(makeLedger(root, [noExtractor])), /provenance\.text\.version/);
    const wrongInput = structuredClone(base);
    wrongInput.provenance.artifacts.inputSha256 = 'a'.repeat(64);
    assert.throws(() => ledger.validateLedger(makeLedger(root, [wrongInput])), /must bind the member PDF/);
    const absentProvenance = removeArtifact(base, 'artifacts');
    absentProvenance.provenance.artifacts = { extractor: 'x', version: '1', inputSha256: base.pdfSha256 };
    assert.throws(() => ledger.validateLedger(makeLedger(root, [absentProvenance])), /must be null when its artifact is absent/);
    const noSourceLocator = structuredClone(base);
    noSourceLocator.provenance.pdf.locator = '';
    assert.throws(() => ledger.validateLedger(makeLedger(root, [noSourceLocator])), /provenance\.pdf\.locator/);
    const unknownProvenance = structuredClone(base);
    unknownProvenance.provenance.pdf.extra = 'not accepted';
    assert.throws(() => ledger.validateLedger(makeLedger(root, [unknownProvenance])), /unexpected or missing/);
});

test('createLedger upgrades only the old all-present in-memory authoring shape, while persisted ledgers remain fail-closed', t => {
    const root = fixture(t);
    const canonical = member(root, 'icassp-arnumber', '104');
    const legacy = structuredClone(canonical);
    delete legacy.availability;
    delete legacy.provenance;
    const created = ledger.createLedger({ id: 'icassp-2026', year: 2026 }, [legacy]);
    assert.equal(created.members[0].provenance.metadata.kind, 'legacy-unrecorded');
    assert.equal(ledger.validateLedger(created), created);
    assert.throws(() => ledger.validateLedger({ ...created, members: [legacy] }), /unexpected or missing/);
});

test('all source files are portable relative paths; traversal, absolute paths, aliases, and symlinks are rejected', t => {
    const root = fixture(t);
    const source = makeLedger(root, [member(root, 'conference-paper-id', '1')]);
    for (const unsafe of ['/private/file.pdf', '../escape.txt', 'a/../b', 'C:\\temp\\paper.pdf', 'a//b', './paper.pdf']) {
        const changed = structuredClone(source);
        changed.members[0].pdfFile = unsafe;
        assert.throws(() => ledger.validateLedger(changed), /relative path/);
    }
    const aliased = structuredClone(source);
    aliased.members[0].textFile = aliased.members[0].pdfFile;
    assert.throws(() => ledger.validateLedger(aliased), /must not alias/);
    const original = path.join(root, source.members[0].pdfFile);
    fs.unlinkSync(original);
    fs.symlinkSync(path.join(root, source.members[0].textFile), original);
    assert.throws(() => ledger.verifyMemberFiles(source, root), /Unsafe ledger artifact/);
});

test('ledger JSON reads and immutable writes reject duplicate keys, links, unsafe output, and byte drift', t => {
    const root = fixture(t);
    const source = makeLedger(root, [member(root, 'icassp-arnumber', '109')]);
    const output = path.join(root, 'ledger.json');
    const writtenSha = ledger.writeLedger(output, source);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const loaded = ledger.loadLedger(output);
    assert.equal(loaded.ledgerSha256, writtenSha);
    assert.equal(loaded.ledger.version, ledger.CONTRACT);
    assert.equal(ledger.verifyMemberFiles(loaded.ledger, root), true);
    assert.throws(() => ledger.writeLedger(output, source), /EEXIST/);

    const duplicate = path.join(root, 'duplicate.json');
    fs.writeFileSync(duplicate, '{"version":"x","version":"y"}', { mode: 0o600 });
    assert.throws(() => ledger.loadLedger(duplicate), /Duplicate JSON key/);
    const linked = path.join(root, 'linked.json');
    fs.symlinkSync(output, linked);
    assert.throws(() => ledger.loadLedger(linked), /ELOOP|Unsafe/);

    fs.writeFileSync(path.join(root, source.members[0].textFile), 'drifted', { mode: 0o600 });
    assert.throws(() => ledger.verifyMemberFiles(source, root), /SHA-256 mismatch/);
});

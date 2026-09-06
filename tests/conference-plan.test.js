'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ledgerApi = require('../scripts/lib/conference-source-ledger.js');
const runApi = require('../scripts/lib/conference-run.js');
const planApi = require('../scripts/lib/conference-plan.js');
const cli = require('../scripts/conference-plan.js');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conference-plan-'));
    const ledgers = path.join(root, 'ledgers'); const runs = path.join(root, 'runs');
    fs.mkdirSync(ledgers); fs.mkdirSync(runs);
    const taxonomy = path.join(root, 'taxonomy.json'); fs.writeFileSync(taxonomy, json({ contract: 'fixture-taxonomy', version: 2 }));
    const h = label => digest(label);
    const make = (value, state = 'verified') => ({
        identity: { type: 'icassp-arnumber', value }, metadataFile: `metadata/${value}.json`, metadataSha256: h(`metadata:${value}`),
        pdfFile: state === 'verified' ? `pdf/${value}.pdf` : null, pdfSha256: state === 'verified' ? h(`pdf:${value}`) : null,
        textFile: state === 'verified' ? `text/${value}.txt` : null, textSha256: state === 'verified' ? h(`text:${value}`) : null,
        artifactsFile: state === 'verified' ? `artifacts/${value}.json` : null, artifactsSha256: state === 'verified' ? h(`artifacts:${value}`) : null,
        availability: state === 'verified' ? { metadata: 'present', pdf: 'present', text: 'present', artifacts: 'present' }
            : { metadata: 'present', pdf: 'absent', text: 'absent', artifacts: 'absent' },
        provenance: state === 'verified' ? {
            metadata: { kind: 'official-metadata', locator: `fixture:${value}:metadata`, retrievedAt: '2026-09-06T00:00:00.000Z' },
            pdf: { kind: 'official-pdf', locator: `fixture:${value}:pdf`, retrievedAt: '2026-09-06T00:00:00.000Z' },
            text: { extractor: 'fixture', version: '1', inputSha256: h(`pdf:${value}`) },
            artifacts: { extractor: 'fixture', version: '1', inputSha256: h(`pdf:${value}`) }
        } : {
            metadata: { kind: 'official-metadata', locator: `fixture:${value}:metadata`, retrievedAt: '2026-09-06T00:00:00.000Z' },
            pdf: null, text: null, artifacts: null
        },
        status: state === 'verified' ? { state, updatedAt: '2026-09-06T00:00:00.000Z', reason: 'fixture proof',
            evidence: ['metadata', 'pdf', 'text', 'artifacts'].map(kind => ({ kind, sha256: state === 'verified' ? (kind === 'metadata' ? h(`metadata:${value}`) : h(`${kind}:${value}`)) : null })) }
            : { state, updatedAt: '2026-09-06T00:00:00.000Z', reason: 'fixture blocked', evidence: [{ kind: 'metadata', sha256: h(`metadata:${value}`) }] }
    });
    const ledger = ledgerApi.createLedger({ id: 'icassp-2026', year: 2026 }, [make('100'), make('200'), make('300', 'blocked')]);
    fs.writeFileSync(path.join(ledgers, 'icassp.json'), json(ledger));
    const members = [{ paperId: 'icassp-2026:100', sourceIdentity: 'icassp-arnumber:100' }, { paperId: 'icassp-2026:200', sourceIdentity: 'icassp-arnumber:200' }];
    const selectionBound = { contract: planApi.SELECTION_CONTRACT, identities: members };
    const plan = { contract: planApi.PLAN_CONTRACT, version: 1, ledgerName: 'icassp.json',
        taxonomy: { version: 'paper-taxonomy-v2', sha256: digest(fs.readFileSync(taxonomy)) },
        selectionPolicy: { ...selectionBound, sha256: planApi.stableHash(selectionBound) },
        shards: [{ shardId: 'part-a', paperIds: ['icassp-2026:100'] }, { shardId: 'part-b', paperIds: ['icassp-2026:200'] }] };
    fs.writeFileSync(path.join(ledgers, 'pilot.json'), json(plan));
    return { root, ledgers, runs, taxonomy, ledger, plan, files: { conferenceSourceLedgerDir: ledgers, conferenceRunsDir: runs, taxonomyRegistry: taxonomy } };
}
function cleanup(f) { fs.rmSync(f.root, { recursive: true, force: true }); }

test('reviewed explicit verified plan produces a hash-bound run and immutable receipt, dry-run then O_EXCL apply', () => {
    const f = fixture();
    try {
        const result = planApi.createRunFromPlan({ files: f.files, ledgerName: 'icassp.json', planName: 'pilot.json', runName: 'pilot-run.json' });
        assert.equal(result.run.contract, 'conference-run-v1');
        assert.equal(result.run.members.length, 2); assert.equal(result.receipt.ledgerSha256, result.ledgerSha256);
        assert.equal(result.receipt.taxonomy.sha256, digest(fs.readFileSync(f.taxonomy)));
        assert.equal(result.receipt.selectionPolicySha256, result.run.selectionPolicySha256);
        assert.equal(result.receipt.receiptSha256, planApi.receiptDigest(result.receipt));
        assert.equal(fs.existsSync(result.runFile), false);
        const preview = planApi.report(result); assert.equal(preview.status, 'dry-run'); assert.equal(preview.members, 2);
        planApi.applyRunPlan(result);
        const storedRun = ledgerApi.readRegularJson(result.runFile).value;
        const storedReceipt = ledgerApi.readRegularJson(result.receiptFile).value;
        const ledgerHandle = ledgerApi.loadLedgerHandle(path.join(fs.realpathSync(f.ledgers), 'icassp.json'));
        assert.equal(runApi.assertConferenceRunFromVerifiedLedger(storedRun, ledgerHandle).identitySha256, result.run.identitySha256);
        assert.equal(storedReceipt.receiptSha256, planApi.receiptDigest(storedReceipt));
        assert.throws(() => planApi.applyRunPlan(result), /refusing to overwrite/);
    } finally { cleanup(f); }
});

test('rejects paths, plan-ledger substitution, changed configured taxonomy bytes and blocked sources', () => {
    const f = fixture();
    try {
        assert.throws(() => planApi.createRunFromPlan({ files: f.files, ledgerName: '../icassp.json', planName: 'pilot.json', runName: 'run.json' }), /safe direct JSON/);
        const badLedger = { ...f.plan, ledgerName: 'other.json' }; fs.writeFileSync(path.join(f.ledgers, 'wrong-ledger.json'), json(badLedger));
        assert.throws(() => planApi.createRunFromPlan({ files: f.files, ledgerName: 'icassp.json', planName: 'wrong-ledger.json', runName: 'run.json' }), /does not match/);
        fs.appendFileSync(f.taxonomy, '\n');
        assert.throws(() => planApi.createRunFromPlan({ files: f.files, ledgerName: 'icassp.json', planName: 'pilot.json', runName: 'run.json' }), /taxonomy SHA/);
        fs.writeFileSync(f.taxonomy, json({ contract: 'fixture-taxonomy', version: 2 }));
        const blocked = structuredClone(f.plan); blocked.selectionPolicy.identities.push({ paperId: 'icassp-2026:300', sourceIdentity: 'icassp-arnumber:300' });
        const bound = { contract: blocked.selectionPolicy.contract, identities: blocked.selectionPolicy.identities };
        blocked.selectionPolicy.sha256 = planApi.stableHash(bound); blocked.shards.push({ shardId: 'part-c', paperIds: ['icassp-2026:300'] });
        fs.writeFileSync(path.join(f.ledgers, 'blocked.json'), json(blocked));
        assert.throws(() => planApi.createRunFromPlan({ files: f.files, ledgerName: 'icassp.json', planName: 'blocked.json', runName: 'run.json' }), /not verified/);
    } finally { cleanup(f); }
});

test('rejects duplicate JSON keys, linked input and incomplete/overlapping sharding before output', () => {
    const f = fixture();
    try {
        fs.writeFileSync(path.join(f.ledgers, 'duplicate.json'), '{"contract":"x","contract":"x"}');
        assert.throws(() => planApi.createRunFromPlan({ files: f.files, ledgerName: 'icassp.json', planName: 'duplicate.json', runName: 'run.json' }), /Duplicate JSON key/);
        fs.linkSync(path.join(f.ledgers, 'pilot.json'), path.join(f.ledgers, 'linked.json'));
        assert.throws(() => planApi.createRunFromPlan({ files: f.files, ledgerName: 'icassp.json', planName: 'linked.json', runName: 'run.json' }), /Unsafe ledger JSON file/);
        const incomplete = structuredClone(f.plan); incomplete.shards = [{ shardId: 'a', paperIds: ['icassp-2026:100'] }];
        fs.writeFileSync(path.join(f.ledgers, 'incomplete.json'), json(incomplete));
        assert.throws(() => planApi.createRunFromPlan({ files: f.files, ledgerName: 'icassp.json', planName: 'incomplete.json', runName: 'run.json' }), /do not cover/);
        const overlapping = structuredClone(f.plan); overlapping.shards[1].paperIds = ['icassp-2026:100', 'icassp-2026:200'];
        fs.writeFileSync(path.join(f.ledgers, 'overlap.json'), json(overlapping));
        assert.throws(() => planApi.createRunFromPlan({ files: f.files, ledgerName: 'icassp.json', planName: 'overlap.json', runName: 'run.json' }), /more than one shard/);
    } finally { cleanup(f); }
});

test('CLI reports dry-run/create without accepting arbitrary flags or paths', () => {
    const f = fixture(); const out = []; const original = console.log;
    try {
        console.log = message => out.push(JSON.parse(message));
        const dry = cli.main(['--dry-run', '--ledger', 'icassp.json', '--plan', 'pilot.json', '--run', 'cli.json'], { files: f.files });
        assert.equal(dry.status, 'dry-run'); assert.equal(out.pop().runName, 'cli.json');
        const applied = cli.main(['--apply', '--ledger', 'icassp.json', '--plan', 'pilot.json', '--run', 'cli.json'], { files: f.files });
        assert.equal(applied.status, 'created'); assert.equal(fs.existsSync(path.join(f.runs, 'cli.plan-receipt.json')), true);
        assert.throws(() => cli.parseArgs(['--dry-run', '--ledger', '/tmp/a.json', '--plan', 'pilot.json', '--run', 'cli.json']), /safe direct JSON/);
    } finally { console.log = original; cleanup(f); }
});

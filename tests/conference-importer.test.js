'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const importer = require('../scripts/lib/conference-importer.js');
const ledgerApi = require('../scripts/lib/conference-source-ledger.js');
const discoveryApi = require('../scripts/lib/conference-discovery.js');
const filterApi = require('../scripts/lib/conference-filter.js');
const stagingApi = require('../scripts/lib/conference-staging.js');
const extractionFixture = require('./helpers/conference-extraction-fixture.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const planApi = require('../scripts/lib/conference-plan.js');
const executionApi = require('../scripts/lib/conference-execution.js');
const sourceContextApi = require('../scripts/lib/conference-source-context.js');
const cli = require('../scripts/conference-import.js');
const planCli = require('../scripts/conference-plan.js');
const executionCli = require('../scripts/conference-execution.js');

const NOW = '2026-09-06T12:00:00.000Z';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pid = value => paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value });

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-import-'));
    const source = path.join(root, 'source'); const cache = path.join(root, 'cache'); const output = path.join(root, 'output');
    for (const dir of [source, cache, output]) fs.mkdirSync(dir, { mode: 0o700 });
    for (const dir of ['metadata', 'pdf', 'text', 'artifacts']) fs.mkdirSync(path.join(source, dir), { mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, source, cache, output };
}

function input(f, { full = true } = {}) {
    const metadata = '{"conference":{"id":"icassp-2026","year":2026},"identity":{"type":"icassp-arnumber","value":"100"},"title":"This title is only metadata"}';
    const pdf = '%PDF-1.4\nsource'; const extracted = 'extracted text'; const artifacts = '{"pages":[]}';
    fs.writeFileSync(path.join(f.source, 'metadata', '100.json'), metadata, { mode: 0o600 });
    fs.writeFileSync(path.join(f.source, 'pdf', '100.pdf'), pdf, { mode: 0o600 });
    if (full) {
        fs.writeFileSync(path.join(f.source, 'text', '100.txt'), extracted, { mode: 0o600 });
        fs.writeFileSync(path.join(f.source, 'artifacts', '100.json'), artifacts, { mode: 0o600 });
    }
    const member = {
        identity: { type: 'icassp-arnumber', value: '100' },
        metadata: { file: 'metadata/100.json', sha256: sha(metadata), identityEvidence: {
            conferenceIdPointer: '/conference/id', conferenceYearPointer: '/conference/year',
            identityTypePointer: '/identity/type', identityValuePointer: '/identity/value'
        }, discoveryBinding: { catalogSha256: '1'.repeat(64), metadataSnapshotSha256: '2'.repeat(64),
            metadataIndex: 0, metadataRecordSha256: '3'.repeat(64) },
        provenance: { kind: 'official-metadata', locator: 'ieee:100', retrievedAt: NOW } },
        pdf: { file: 'pdf/100.pdf', sha256: sha(pdf), provenance: { kind: 'official-pdf', locator: 'ieee-pdf:100', retrievedAt: NOW } },
        text: full ? { file: 'text/100.txt', sha256: sha(extracted), provenance: { extractor: 'pdftotext', version: '24.02' } } : null,
        artifacts: full ? { file: 'artifacts/100.json', sha256: sha(artifacts), provenance: { extractor: 'layout', version: '1' } } : null
    };
    return { contract: importer.CONTRACT, version: importer.VERSION, conference: { id: 'icassp-2026', year: 2026 },
        members: [member], memberSetSha256: ledgerApi.memberSetSha256([{ identity: member.identity }]) };
}

test('manifest-bound dry run and apply copy only declared local artifacts and create a replayable verified ledger', t => {
    const f = fixture(t); const manifest = input(f);
    const dry = importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW });
    assert.equal(dry.mode, 'dry-run'); assert.equal(dry.verified, 1); assert.equal(fs.readdirSync(f.cache).length, 0);
    const applied = importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true });
    assert.equal(applied.verified, 1); assert.equal(applied.blocked, 0);
    assert.equal(ledgerApi.verifyMemberFiles(applied.ledger, f.cache), true);
    assert.equal(applied.ledger.members[0].identity.value, '100');
    assert.match(applied.ledger.members[0].metadataFile, /^icassp-2026-2026\/icassp-arnumber--100\/metadata\.json$/);
    // Re-entry is safe only when byte-identical cache artifacts already exist.
    assert.equal(importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true }).verified, 1);
});

test('cache publication removes a short-write temporary inode and remains safely retryable', t => {
    const f = fixture(t); const manifest = input(f);
    const originalOpen = fs.openSync; const originalWrite = fs.writeFileSync;
    let cacheWriteFd; let interrupted = false;
    fs.openSync = function trackCacheTemporary(target, ...args) {
        const fd = originalOpen.call(this, target, ...args);
        if (String(target).includes('/.metadata.json.') && String(target).endsWith('.tmp')) cacheWriteFd = fd;
        return fd;
    };
    fs.writeFileSync = function interruptCacheWrite(target, bytes, ...args) {
        if (!interrupted && target === cacheWriteFd) {
            interrupted = true;
            originalWrite.call(this, target, Buffer.from(bytes).subarray(0, 3), ...args);
            const error = new Error('fixture short cache write'); error.code = 'EIO'; throw error;
        }
        return originalWrite.call(this, target, bytes, ...args);
    };
    try {
        assert.throws(() => importer.importConferenceSources({ manifest, sourceRoot: f.source,
            cacheRoot: f.cache, updatedAt: NOW, apply: true }), /short cache write/);
    } finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; }
    const destination = path.join(f.cache, 'icassp-2026-2026', 'icassp-arnumber--100', 'metadata.json');
    assert.equal(fs.existsSync(destination), false);
    assert.equal(importer.importConferenceSources({ manifest, sourceRoot: f.source,
        cacheRoot: f.cache, updatedAt: NOW, apply: true }).verified, 1);
});

test('missing PDF is kept blocked, and metadata title cannot become an identity or select another file', t => {
    const f = fixture(t); const manifest = input(f, { full: false });
    manifest.members[0].pdf = null;
    manifest.memberSetSha256 = ledgerApi.memberSetSha256([{ identity: manifest.members[0].identity }]);
    const result = importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true });
    assert.equal(result.blocked, 1); assert.equal(result.ledger.members[0].availability.pdf, 'absent');
    assert.equal(result.ledger.members[0].status.state, 'blocked');
    const titleIdentity = structuredClone(manifest);
    titleIdentity.members[0].identity.value = 'This title is only metadata';
    assert.throws(() => importer.validateManifest(titleIdentity), /invalid/);
});

test('rejects undeclared/traversing/link/hard-link files, malformed PDFs and pre-existing byte drift', t => {
    const f = fixture(t); const manifest = input(f);
    const traversal = structuredClone(manifest); traversal.members[0].pdf.file = '../pdf/100.pdf';
    assert.throws(() => importer.importConferenceSources({ manifest: traversal, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /relative path/);
    fs.symlinkSync(path.join(f.source, 'pdf', '100.pdf'), path.join(f.source, 'pdf', 'linked.pdf'));
    const linked = structuredClone(manifest); linked.members[0].pdf.file = 'pdf/linked.pdf';
    assert.throws(() => importer.importConferenceSources({ manifest: linked, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /unsafe|single-link/);
    fs.unlinkSync(path.join(f.source, 'pdf', 'linked.pdf'));
    fs.linkSync(path.join(f.source, 'pdf', '100.pdf'), path.join(f.source, 'pdf', 'hard.pdf'));
    const hard = structuredClone(manifest); hard.members[0].pdf.file = 'pdf/hard.pdf';
    assert.throws(() => importer.importConferenceSources({ manifest: hard, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /single-link/);
    fs.unlinkSync(path.join(f.source, 'pdf', 'hard.pdf'));
    importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true });
    const changedPdf = '%PDF-1.4\nchanged'; fs.writeFileSync(path.join(f.source, 'pdf', '100.pdf'), changedPdf);
    const drift = structuredClone(manifest); drift.members[0].pdf.sha256 = sha(changedPdf);
    assert.throws(() => importer.importConferenceSources({ manifest: drift, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true }), /different bytes/);
});

test('requires manifest input SHA values and strict metadata identity evidence before any member can verify', t => {
    const f = fixture(t); const manifest = input(f);
    const badSha = structuredClone(manifest); badSha.members[0].pdf.sha256 = 'a'.repeat(64);
    assert.throws(() => importer.importConferenceSources({ manifest: badSha, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /expected SHA-256/);
    const missingSha = structuredClone(manifest); delete missingSha.members[0].text.sha256;
    assert.throws(() => importer.validateManifest(missingSha), /unknown or missing fields/);
    const wrongIdentity = structuredClone(manifest); wrongIdentity.members[0].metadata.identityEvidence.identityValuePointer = '/title';
    assert.throws(() => importer.importConferenceSources({ manifest: wrongIdentity, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /must exactly bind/);
    const missingEvidence = structuredClone(manifest); delete missingEvidence.members[0].metadata.identityEvidence;
    assert.throws(() => importer.validateManifest(missingEvidence), /unknown or missing fields/);
});

test('rejects overlapping roots, FIFO sources, non-UTF8 text, and duplicate metadata/artifact JSON keys', t => {
    const f = fixture(t); const manifest = input(f);
    assert.throws(() => importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.source, updatedAt: NOW }), /must not overlap/);
    const nestedCache = path.join(f.source, 'nested-cache'); fs.mkdirSync(nestedCache, { mode: 0o700 });
    assert.throws(() => importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: nestedCache, updatedAt: NOW }), /must not overlap/);
    const fifo = structuredClone(manifest); fs.unlinkSync(path.join(f.source, 'text', '100.txt'));
    execFileSync('mkfifo', [path.join(f.source, 'text', '100.txt')]);
    assert.throws(() => importer.importConferenceSources({ manifest: fifo, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /regular single-link/);
    fs.unlinkSync(path.join(f.source, 'text', '100.txt'));
    fs.writeFileSync(path.join(f.source, 'text', '100.txt'), Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    fifo.members[0].text.sha256 = sha(Buffer.from([0xc3, 0x28]));
    assert.throws(() => importer.importConferenceSources({ manifest: fifo, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /strict UTF-8/);
    const duplicateMetadata = structuredClone(manifest); const duplicated = '{"conference":{"id":"icassp-2026","year":2026},"identity":{"type":"icassp-arnumber","value":"100"},"identity":{"type":"icassp-arnumber","value":"100"}}';
    fs.writeFileSync(path.join(f.source, 'metadata', '100.json'), duplicated, { mode: 0o600 }); duplicateMetadata.members[0].metadata.sha256 = sha(duplicated);
    assert.throws(() => importer.importConferenceSources({ manifest: duplicateMetadata, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /valid UTF-8 JSON/);
    const f2 = fixture(t); const artifactsManifest = input(f2); const duplicateArtifacts = '{"pages":[],"pages":[]}';
    fs.writeFileSync(path.join(f2.source, 'artifacts', '100.json'), duplicateArtifacts, { mode: 0o600 });
    artifactsManifest.members[0].artifacts.sha256 = sha(duplicateArtifacts);
    assert.throws(() => importer.importConferenceSources({ manifest: artifactsManifest, sourceRoot: f2.source, cacheRoot: f2.cache, updatedAt: NOW }), /valid UTF-8 JSON/);
});

function productionFixture(t) {
    const f = fixture(t); const catalogDir = path.join(f.root, 'catalogs'); const reportDir = path.join(f.root, 'reports');
    const filters = path.join(f.root, 'filters'); const staging = path.join(f.root, 'staging');
    for (const directory of [catalogDir, reportDir, filters, staging]) fs.mkdirSync(directory, { mode: 0o700 });
    const records = ['100', '200'].map(value => ({ arnumber: value, title: `Paper ${value}` }));
    const metadataFile = path.join(f.root, 'metadata.json'); const pdfRoot = path.join(f.root, 'pdfs');
    fs.mkdirSync(pdfRoot, { mode: 0o700 });
    fs.writeFileSync(metadataFile, JSON.stringify(records), { mode: 0o600 });
    for (const record of records) fs.writeFileSync(path.join(pdfRoot, `${record.title}.pdf`),
        extractionFixture.buildPdf(record.title), { mode: 0o600 });
    const discovered = discoveryApi.discoverConference({ adapter: 'icassp', year: 2026, metadataFile, pdfRoot });
    const catalog = discovered.manifest; const report = discovered.report;
    const catalogFile = path.join(catalogDir, 'catalog.json');
    const reportFile = path.join(reportDir, 'report.json');
    fs.writeFileSync(catalogFile, discoveryApi.canonicalBytes(catalog)); fs.writeFileSync(reportFile, discoveryApi.canonicalBytes(report));
    const discoveryHandle = discoveryApi.loadDiscoveryHandle(catalogFile, reportFile);
    const filterId = '11111111-1111-4111-8111-111111111111';
    let state = filterApi.prepareFilter({ filterRoot: filters, discoveryHandle, filterId, now: NOW,
        spec: { contract: filterApi.SPEC_CONTRACT, version: filterApi.VERSION, filterPolicySha256: sha('policy'), promptSha256: sha('prompt'),
            model: 'fixture', endpointProtocol: 'openai-responses', taxonomyRegistrySha256: sha('taxonomy') } });
    for (const [index, value] of ['100', '200'].entries()) {
        const paperId = pid(value); const status = value === '100' ? 'included' : 'excluded';
        const artifact = filterApi.buildDecisionArtifact({ state, paperId,
            operationId: index ? '33333333-3333-4333-8333-333333333333' : '22222222-2222-4222-8222-222222222222',
            actor: { type: 'manual', id: 'reviewer' }, model: null, endpointProtocol: 'manual', requestBytes: 'review',
            responseBytes: status, status, reason: status, usage: {}, now: NOW });
        const decisionFile = filterApi.writeDecisionArtifact({ filterRoot: filters, filterId,
            decisionName: `decision-${value}.json`, artifact });
        state = filterApi.applyDecision({ filterRoot: filters, filterId,
            decisionHandle: filterApi.loadDecisionHandle(decisionFile), owner: 'reviewer', now: NOW });
    }
    const selectionHandle = filterApi.loadSelectionHandle(filters, filterId, discoveryHandle);
    const value = '100'; const paperId = pid(value);
    const sourceIdentity = `icassp-arnumber:${value}`;
    const replay = discoveryApi.replayDiscoveryMember(discoveryHandle, sourceIdentity);
    const candidate = replay.match.candidates[0]; const pdf = fs.readFileSync(path.join(pdfRoot, candidate.path));
    const generated = extractionFixture.runProductionExtraction({ sourceRoot: f.source, value, pdfBytes: pdf, stamp: NOW,
        discoveryBinding: { catalogSha256: replay.catalogSha256,
            metadataSnapshotSha256: replay.metadataSnapshotSha256, metadataIndex: replay.metadataIndex,
            metadataRecordSha256: replay.metadataRecordSha256 } });
    const extracted = [{ paperId, sourceIdentity, receiptName: generated.receiptName }];
    const extraction = { contract: stagingApi.EXTRACTION_CONTRACT, version: stagingApi.VERSION,
        conference: { id: 'icassp-2026', year: 2026 }, review: { actor: 'reviewer', reviewedAt: NOW }, members: extracted,
        membersSha256: stagingApi.stableHash(extracted) };
    const staged = stagingApi.bindInputs({ selectionHandle, discoveryHandle, extractionManifest: extraction,
        extractionFileSha256: sha('reviewed extraction file'), extractionSourceRoot: f.source,
        importManifestName: 'import.json' });
    stagingApi.writeStagingBundle({ stagingRoot: staging, importManifestName: 'import.json', receiptName: 'receipt.json', staged });
    return { ...f, catalogDir, reportDir, filters, staging, filterId, staged, discoveryHandle, selectionHandle,
        files: { conferenceStagingDir: staging, conferenceStagingSourceDir: f.source,
            conferenceDiscoveryCatalogDir: catalogDir, conferenceDiscoveryReportDir: reportDir,
            conferenceFiltersDir: filters, conferenceSourceCacheDir: f.cache, conferenceSourceLedgerDir: f.output } };
}

test('production CLI requires authenticated staging and writes an immutable ledger/import-receipt pair', t => {
    const f = productionFixture(t);
    const tail = ['--import', 'import.json', '--receipt', 'receipt.json', '--filter', f.filterId,
        '--catalog', 'catalog.json', '--report', 'report.json', '--updated-at', NOW, '--ledger-output', 'ledger.json'];
    assert.throws(() => cli.parseCommand(['--apply', '--manifest', path.join(f.root, 'manifest.json'),
        '--source-root', f.source, '--cache-root', f.cache, '--updated-at', NOW, '--ledger-output', 'ledger.json']), /--import NAME/);
    fs.rmdirSync(f.cache); fs.rmdirSync(f.output);
    const dry = cli.main(['--dry-run', ...tail], { files: f.files });
    assert.equal(dry.status, 'dry-run');
    assert.equal(fs.existsSync(f.cache), false); assert.equal(fs.existsSync(f.output), false);
    const applied = cli.main(['--apply', ...tail], { files: f.files });
    assert.equal(fs.statSync(f.cache).mode & 0o777, 0o700); assert.equal(fs.statSync(f.output).mode & 0o777, 0o700);
    assert.equal(applied.status, 'imported'); assert.equal(ledgerApi.loadLedger(path.join(f.output, 'ledger.json')).ledger.members.length, 1);
    const receipt = ledgerApi.readRegularJson(path.join(f.output, 'ledger.import-receipt.json')).value;
    assert.equal(receipt.selectionReceiptSha256, applied.selectionReceiptSha256);
    assert.equal(receipt.stagingReceiptSha256, f.staged.receipt.receiptSha256);
    assert.equal(receipt.ledger.sha256, applied.ledgerSha256);
    assert.throws(() => cli.main(['--apply', ...tail], { files: f.files }), /immutable conference import bundle/);
});

test('production CLI rejects an excluded identity inserted into a staged import manifest', t => {
    const f = productionFixture(t); const tampered = structuredClone(f.staged.importManifest);
    tampered.members[0].identity.value = '200'; tampered.memberSetSha256 = ledgerApi.memberSetSha256(tampered.members);
    fs.writeFileSync(path.join(f.staging, 'excluded.json'), stagingApi.canonicalBytes(tampered), { mode: 0o600 });
    assert.throws(() => cli.main(['--dry-run', '--import', 'excluded.json', '--receipt', 'receipt.json', '--filter', f.filterId,
        '--catalog', 'catalog.json', '--report', 'report.json', '--updated-at', NOW, '--ledger-output', 'ledger.json'],
    { files: f.files }), /exact import manifest file|excluded|unbound/);
});

test('authenticated import, plan and execution preserve the full selection receipt chain', t => {
    const f = productionFixture(t); const tail = ['--import', 'import.json', '--receipt', 'receipt.json', '--filter', f.filterId,
        '--catalog', 'catalog.json', '--report', 'report.json', '--updated-at', NOW, '--ledger-output', 'ledger.json'];
    cli.main(['--apply', ...tail], { files: f.files });
    const stagingHandle = stagingApi.loadStagingHandle(path.join(f.staging, 'import.json'), path.join(f.staging, 'receipt.json'),
        f.selectionHandle, f.discoveryHandle, f.source);
    const oldPublicLedgerLoad = ledgerApi.loadLedger;
    ledgerApi.loadLedger = () => { throw new Error('loadImportHandle must not perform an independent first ledger read'); };
    let importHandle;
    try {
        importHandle = importer.loadImportHandle(path.join(f.output, 'ledger.json'),
            path.join(f.output, 'ledger.import-receipt.json'), stagingHandle);
    } finally { ledgerApi.loadLedger = oldPublicLedgerLoad; }
    assert.deepEqual(importer.importHandleSnapshot(importHandle).verifiedMembers,
        [{ paperId: pid('100'), sourceIdentity: 'icassp-arnumber:100' }]);
    const taxonomy = path.join(f.root, 'taxonomy.json'); fs.writeFileSync(taxonomy, '{"version":"taxonomy-v1"}\n');
    const runs = path.join(f.root, 'runs'); const executions = path.join(f.root, 'executions');
    const identities = importer.importHandleSnapshot(importHandle).verifiedMembers;
    const selectedMemberSetSha256 = planApi.stableHash(identities.map(member => member.paperId));
    const plan = { contract: planApi.PLAN_CONTRACT, version: planApi.VERSION, ledgerName: 'ledger.json',
        taxonomy: { version: 'taxonomy-v1', sha256: sha(fs.readFileSync(taxonomy)) },
        selectionPolicy: { contract: planApi.SELECTION_CONTRACT, identities, selectedMemberSetSha256 },
        shards: [{ shardId: 'all', paperIds: identities.map(member => member.paperId) }] };
    fs.writeFileSync(path.join(f.output, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const planFiles = { ...f.files, conferenceRunsDir: runs, taxonomyRegistry: taxonomy };
    const planArgs = ['--catalog', 'catalog.json', '--report', 'report.json', '--filter', f.filterId,
        '--import', 'import.json', '--staging-receipt', 'receipt.json', '--ledger', 'ledger.json',
        '--import-receipt', 'ledger.import-receipt.json', '--plan', 'plan.json', '--run', 'cli-run.json'];
    const dryPlan = planCli.main(['--dry-run', ...planArgs], { files: planFiles });
    assert.equal(dryPlan.status, 'dry-run'); assert.equal(fs.existsSync(runs), false);
    const appliedPlan = planCli.main(['--apply', ...planArgs], { files: planFiles });
    assert.equal(appliedPlan.status, 'created');
    assert.equal(fs.statSync(runs).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(runs, 'cli-run.json')), true);
    assert.equal(fs.existsSync(path.join(runs, 'cli-run.plan-receipt.json')), true);
    const realAuthority = importer.importHandleAuthority(importHandle);
    const originalAuthorityLoader = importer.importHandleAuthority;
    importer.importHandleAuthority = () => ({ ledgerHandle: realAuthority.ledgerHandle,
        snapshot: { ...realAuthority.snapshot, ledgerSha256: '0'.repeat(64) } });
    try {
        assert.throws(() => planApi.createRunFromImportPlan({ files: planFiles, importHandle,
            planName: 'plan.json', runName: 'mismatch.json' }), /run ledger SHA differs/);
    } finally { importer.importHandleAuthority = originalAuthorityLoader; }
    const aliasedPlan = structuredClone(plan); aliasedPlan.selectionPolicy.identities[0].paperId = 'icassp-2026:alias';
    aliasedPlan.selectionPolicy.selectedMemberSetSha256 = planApi.stableHash(
        aliasedPlan.selectionPolicy.identities.map(member => member.paperId));
    aliasedPlan.shards[0].paperIds = ['icassp-2026:alias'];
    fs.writeFileSync(path.join(f.output, 'alias-plan.json'), `${JSON.stringify(aliasedPlan, null, 2)}\n`);
    assert.throws(() => planApi.createRunFromImportPlan({ files: { conferenceSourceLedgerDir: f.output,
        conferenceRunsDir: runs, taxonomyRegistry: taxonomy }, importHandle, planName: 'alias-plan.json', runName: 'alias.json' }),
    /exactly equal|not canonical/);
    const planned = planApi.createRunFromImportPlan({ files: { conferenceSourceLedgerDir: f.output,
        conferenceRunsDir: runs, taxonomyRegistry: taxonomy }, importHandle, planName: 'plan.json', runName: 'run.json' });
    let writes = 0;
    const failingIo = new Proxy(fs, { get(target, property) {
        if (property === 'writeFileSync') return (...args) => {
            writes += 1; if (writes === 2) { const error = new Error('fixture EIO'); error.code = 'EIO'; throw error; }
            return fs.writeFileSync(...args);
        };
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.throws(() => planApi.applyRunPlan(planned, failingIo), /recoverable run\/plan-receipt pair/);
    assert.equal(fs.existsSync(path.join(runs, 'run.json')), false);
    assert.equal(fs.existsSync(path.join(runs, 'run.plan-receipt.json')), false);
    planApi.applyRunPlan(planned);
    const planHandle = planApi.loadPlanHandle(path.join(runs, 'run.json'), path.join(runs, 'run.plan-receipt.json'),
        path.join(f.output, 'plan.json'), importHandle, taxonomy);
    const sourceContext = sourceContextApi.buildConferenceSourceContext({ planHandle,
        paperId: identities[0].paperId, sourceRoot: f.cache });
    assert.equal(sourceContext.productionAuthorization.authorized, true);
    assert.equal(sourceContext.productionAuthorization.binding.contract,
        sourceContextApi.PLAN_AUTHORITY_BINDING_CONTRACT);
    assert.equal(sourceContext.productionAuthorization.binding.planReceiptSha256, planned.receipt.receiptSha256);
    assert.equal(sourceContext.sourceSnapshotSha256,
        sourceContextApi.stableHash(sourceContext.sourceSnapshotBinding));
    assert.throws(() => sourceContextApi.buildConferenceSourceContext({ planHandle: {},
        paperId: identities[0].paperId, sourceRoot: f.cache }), error => error.reasonCode === 'plan_handle_invalid');
    const execution = executionApi.prepareExecutionFromPlan({ executionRoot: executions, planHandle,
        executionId: '55555555-5555-4555-8555-555555555555', now: NOW });
    assert.equal(execution.source.filterPolicySha256, f.staged.receipt.selection.filterPolicySha256);
    assert.equal(execution.source.selectionReceiptSha256, f.staged.receipt.selection.selectionReceiptSha256);
    assert.equal(execution.source.selectedMemberSetSha256, f.staged.receipt.selection.selectedMemberSetSha256);
    assert.equal(execution.source.importReceiptSha256, planned.receipt.import.receiptSha256);
    assert.equal(execution.source.planReceiptSha256, planned.receipt.receiptSha256);
    assert.equal(fs.existsSync(path.join(executions, execution.executionId, 'authority.json')), true);
    const statusArgs = ['--run', 'run.json', '--plan-receipt', 'run.plan-receipt.json', '--plan', 'plan.json',
        '--ledger', 'ledger.json', '--import-receipt', 'ledger.import-receipt.json', '--import', 'import.json',
        '--staging-receipt', 'receipt.json', '--filter', f.filterId, '--catalog', 'catalog.json', '--report', 'report.json',
        '--execution', execution.executionId];
    const status = executionCli.main(['status', ...statusArgs], {
        files: { ...planFiles, conferenceExecutionsDir: executions }, executionRoot: executions });
    assert.equal(status.planReceiptSha256, planned.receipt.receiptSha256);
    assert.equal(status.selectionReceiptSha256, planned.receipt.filter.selectionReceiptSha256);
    assert.throws(() => planApi.loadPlanHandle(path.join(runs, 'run.json'), path.join(runs, 'missing.json'),
        path.join(f.output, 'plan.json'), importHandle, taxonomy), /cannot be read safely|ENOENT/);
    assert.throws(() => executionApi.prepareExecutionFromPlan({ executionRoot: executions, planHandle: {},
        executionId: '66666666-6666-4666-8666-666666666666', now: NOW }), /authenticated plan handle/);
});

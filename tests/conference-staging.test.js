'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const discovery = require('../scripts/lib/conference-discovery.js');
const filter = require('../scripts/lib/conference-filter.js');
const ledger = require('../scripts/lib/conference-source-ledger.js');
const importer = require('../scripts/lib/conference-importer.js');
const staging = require('../scripts/lib/conference-staging.js');
const extractionReceipt = require('../scripts/lib/conference-extraction-receipt.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const cli = require('../scripts/conference-staging.js');
const extractionFixture = require('./helpers/conference-extraction-fixture.js');

const h = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = '2026-09-06T00:00:00.000Z';
const filterId = '11111111-1111-4111-8111-111111111111';
const operationIds = ['22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const pid = value => paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value });

function discoveryBundle(root, suffix = '', mode = 'exact') {
    const catalogDir = path.join(root, `catalogs${suffix}`); const reportDir = path.join(root, `reports${suffix}`);
    const pdfRoot = path.join(root, `pdfs${suffix}`);
    fs.mkdirSync(catalogDir); fs.mkdirSync(reportDir); fs.mkdirSync(pdfRoot);
    const records = ['100', '200', '300'].map(value => ({ arnumber: value, title: `Paper ${value}${suffix}` }));
    const metadataFile = path.join(root, `metadata${suffix}.json`);
    fs.writeFileSync(metadataFile, JSON.stringify(records), { mode: 0o600 });
    for (const record of records) {
        if (mode === 'unmatched') continue;
        const names = mode === 'exact' ? [`${record.title}.pdf`]
            : mode === 'normalized' ? [`${record.title.replaceAll(' ', '_')}.pdf`]
                : [`${record.title.replaceAll(' ', '_')}!.pdf`, `${record.title.replaceAll(' ', '-')}?.pdf`];
        for (const name of names) fs.writeFileSync(path.join(pdfRoot, name),
            extractionFixture.buildPdf(record.title), { mode: 0o600 });
    }
    const { manifest, report } = discovery.discoverConference({ adapter: 'icassp', year: 2026,
        metadataFile, pdfRoot });
    const catalogFile = path.join(catalogDir, 'catalog.json'); const reportFile = path.join(reportDir, 'report.json');
    fs.writeFileSync(catalogFile, discovery.canonicalBytes(manifest), { mode: 0o600 });
    fs.writeFileSync(reportFile, discovery.canonicalBytes(report), { mode: 0o600 });
    return { catalogDir, reportDir, catalogFile, reportFile,
        handle: discovery.loadDiscoveryHandle(catalogFile, reportFile) };
}

function completeFilter(root, discoveryHandle) {
    const filterRoot = path.join(root, 'filters'); fs.mkdirSync(filterRoot);
    let state = filter.prepareFilter({ filterRoot, discoveryHandle,
        spec: { contract: filter.SPEC_CONTRACT, version: filter.VERSION, filterPolicySha256: h('policy'),
            promptSha256: h('prompt'), model: 'fixture-model', endpointProtocol: 'openai-responses',
            taxonomyRegistrySha256: h('taxonomy') }, filterId, now: stamp });
    for (const [index, value] of ['100', '200', '300'].entries()) {
        const paperId = pid(value);
        const status = value === '300' ? 'excluded' : 'included';
        const artifact = filter.buildDecisionArtifact({ state, paperId, operationId: operationIds[index],
            actor: { type: 'manual', id: 'reviewer' }, model: null, endpointProtocol: 'manual',
            requestBytes: `review ${value}`, responseBytes: `${status} ${value}`, status,
            reason: `${status} fixture`, usage: {}, now: stamp });
        const filename = filter.writeDecisionArtifact({ filterRoot, filterId,
            decisionName: `decision-${value}.json`, artifact });
        state = filter.applyDecision({ filterRoot, filterId, decisionHandle: filter.loadDecisionHandle(filename),
            owner: 'staging-test', now: stamp });
    }
    return { filterRoot, state, selectionHandle: filter.loadSelectionHandle(filterRoot, filterId, discoveryHandle) };
}

function extractionMember(sourceRoot, value, discoveryHandle, overrides = {}) {
    const sourceIdentity = `icassp-arnumber:${value}`;
    const replay = discovery.replayDiscoveryMember(discoveryHandle, sourceIdentity);
    const discoverySnapshot = discovery.discoveryHandleSnapshot(discoveryHandle);
    const candidate = replay.match.candidates[0];
    const pdf = fs.readFileSync(path.join(discoverySnapshot.candidateManifest.pdfRoot, candidate.path));
    return extractionFixture.runProductionExtraction({ sourceRoot, value,
        pdfBytes: overrides.pdfBytes || pdf, stamp,
        discoveryBinding: overrides.discoveryBinding || { catalogSha256: replay.catalogSha256,
            metadataSnapshotSha256: replay.metadataSnapshotSha256, metadataIndex: replay.metadataIndex,
            metadataRecordSha256: replay.metadataRecordSha256 } });
}

function extraction(sourceRoot, discoveryHandle, values = ['100', '200']) {
    const members = values.map(value => extractionMember(sourceRoot, value, discoveryHandle))
        .map(({ paperId, sourceIdentity, receiptName }) => ({ paperId, sourceIdentity, receiptName }))
        .sort((a, b) => a.paperId.localeCompare(b.paperId));
    return { contract: staging.EXTRACTION_CONTRACT, version: staging.VERSION,
        conference: { id: 'icassp-2026', year: 2026 }, review: { actor: 'reviewer.1', reviewedAt: stamp },
        members, membersSha256: staging.stableHash(members) };
}

function fixture() {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-staging-'));
    const first = discoveryBundle(root); const filtered = completeFilter(root, first.handle);
    const specs = path.join(root, 'specs'); const sources = path.join(root, 'sources'); const output = path.join(root, 'staging');
    fs.mkdirSync(specs); fs.mkdirSync(sources); fs.mkdirSync(output);
    return { root, first, filtered, specs, sources, output,
        files: { conferenceDiscoveryCatalogDir: first.catalogDir, conferenceDiscoveryReportDir: first.reportDir,
            conferenceFiltersDir: filtered.filterRoot, conferenceStagingSpecsDir: specs,
            conferenceStagingSourceDir: sources, conferenceStagingDir: output } };
}

function stage(f, value = extraction(f.sources, f.first.handle), overrides = {}) {
    return staging.bindInputs({ selectionHandle: f.filtered.selectionHandle, discoveryHandle: f.first.handle,
        extractionManifest: value, extractionFileSha256: h('extraction-file'),
        extractionSourceRoot: f.sources,
        importManifestName: 'import.json', ...overrides });
}

test('authenticated selection and discovery stage exactly the included identities with all source SHA bindings', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const result = stage(f);
    assert.equal(result.importManifest.contract, importer.CONTRACT);
    assert.deepEqual(result.importManifest.members.map(member => member.identity.value), ['100', '200']);
    assert.equal(result.receipt.selection.selectionReceiptSha256,
        filter.selectionHandleSnapshot(f.filtered.selectionHandle).selectionReceiptSha256);
    assert.equal(result.receipt.discovery.catalogSha256, discovery.discoveryHandleSnapshot(f.first.handle).catalogSha256);
    assert.deepEqual(result.receipt.members.map(member => member.sourceIdentity),
        ['icassp-arnumber:100', 'icassp-arnumber:200']);
    assert.equal(result.receipt.members[0].extractionReceiptName, '100-receipt.json');
    assert.equal(result.receipt.importManifest.sha256, h(result.importBytes));
    const { receiptSha256, ...body } = result.receipt;
    assert.equal(receiptSha256, staging.stableHash(body));
});

test('excluded, missing, extra, aliased, forged and cross-discovery inputs fail closed', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    assert.throws(() => stage(f, extraction(f.sources, f.first.handle, ['100', '300'])), /excluded or extra|exactly cover/);
    assert.throws(() => stage(f, extraction(f.sources, f.first.handle, ['100'])), /exactly cover/);
    assert.throws(() => stage(f, extraction(f.sources, f.first.handle, ['100', '200', '300'])), /exactly cover|excluded or extra/);
    const aliased = extraction(f.sources, f.first.handle); aliased.members[0].paperId = pid('101');
    aliased.membersSha256 = staging.stableHash(aliased.members);
    assert.throws(() => stage(f, aliased), /excluded or extra|not canonical/);
    assert.throws(() => staging.bindInputs({ selectionHandle: {}, discoveryHandle: f.first.handle,
        extractionManifest: extraction(f.sources, f.first.handle), extractionFileSha256: h('x'), extractionSourceRoot: f.sources,
        importManifestName: 'import.json' }), /not authenticated/);
    const other = discoveryBundle(f.root, '-other');
    assert.throws(() => stage(f, extraction(f.sources, f.first.handle), { discoveryHandle: other.handle }), /does not bind/);
});

test('only a unique exact discovery candidate can enter staging and metadata/PDF bindings are causal', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const replay100 = discovery.replayDiscoveryMember(f.first.handle, 'icassp-arnumber:100');
    const wrong100 = extractionMember(f.sources, '100', f.first.handle, { discoveryBinding: {
        catalogSha256: replay100.catalogSha256, metadataSnapshotSha256: replay100.metadataSnapshotSha256,
        metadataIndex: replay100.metadataIndex, metadataRecordSha256: h('wrong-record') } });
    const right200 = extractionMember(f.sources, '200', f.first.handle);
    const wrongMembers = [wrong100, right200].map(({ paperId, sourceIdentity, receiptName }) => (
        { paperId, sourceIdentity, receiptName }
    )).sort((a, b) => a.paperId.localeCompare(b.paperId));
    const wrongManifest = { contract: staging.EXTRACTION_CONTRACT, version: staging.VERSION,
        conference: { id: 'icassp-2026', year: 2026 }, review: { actor: 'reviewer.1', reviewedAt: stamp },
        members: wrongMembers, membersSha256: staging.stableHash(wrongMembers) };
    assert.throws(() => stage(f, wrongManifest), /exact discovery metadata record/);

    const replay200 = discovery.replayDiscoveryMember(f.first.handle, 'icassp-arnumber:200');
    const snapshot = discovery.discoveryHandleSnapshot(f.first.handle);
    const wrongPdf = fs.readFileSync(path.join(snapshot.candidateManifest.pdfRoot, replay200.match.candidates[0].path));
    const mismatched100 = extractionMember(f.sources, '100', f.first.handle, { pdfBytes: wrongPdf });
    const pdfMembers = [mismatched100, extractionMember(f.sources, '200', f.first.handle)]
        .map(({ paperId, sourceIdentity, receiptName }) => ({ paperId, sourceIdentity, receiptName }))
        .sort((a, b) => a.paperId.localeCompare(b.paperId));
    const pdfManifest = { ...wrongManifest, members: pdfMembers, membersSha256: staging.stableHash(pdfMembers) };
    assert.throws(() => stage(f, pdfManifest), /unique exact discovery candidate/);
});

test('normalized, ambiguous, and unmatched discovery members cannot stage without a resolution receipt', t => {
    for (const mode of ['normalized', 'ambiguous', 'unmatched']) {
        const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `conference-${mode}-`));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const bundle = discoveryBundle(root, '', mode); const filtered = completeFilter(root, bundle.handle);
        const members = ['100', '200'].map(value => ({ paperId: pid(value),
            sourceIdentity: `icassp-arnumber:${value}`, receiptName: `${value}-receipt.json` }));
        const extractionManifest = { contract: staging.EXTRACTION_CONTRACT, version: staging.VERSION,
            conference: { id: 'icassp-2026', year: 2026 }, review: { actor: 'reviewer.1', reviewedAt: stamp },
            members, membersSha256: staging.stableHash(members) };
        const sources = path.join(root, 'sources'); fs.mkdirSync(sources);
        assert.throws(() => staging.bindInputs({ selectionHandle: filtered.selectionHandle,
            discoveryHandle: bundle.handle, extractionManifest, extractionFileSha256: h('manifest'),
            extractionSourceRoot: sources, importManifestName: 'import.json' }), /not a unique exact PDF match/);
    }
});

test('staging rejects changed extraction receipt, extractor, PDF, text, or artifact bytes', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const reviewed = extraction(f.sources, f.first.handle);
    const receiptFile = path.join(f.sources, '100-receipt.json');
    const changedReceipt = JSON.parse(fs.readFileSync(receiptFile));
    changedReceipt.extractor.backend.version = '6.18.0';
    const { receiptSha256: _old, ...receiptBody } = changedReceipt;
    changedReceipt.receiptSha256 = extractionReceipt.stableHash(receiptBody);
    fs.writeFileSync(receiptFile, `${JSON.stringify(changedReceipt, null, 2)}\n`);
    assert.throws(() => stage(f, reviewed), /extractor\/backend name or version/);

    extraction(f.sources, f.first.handle); fs.appendFileSync(path.join(f.sources, '100.pdf'), 'changed');
    assert.throws(() => stage(f, reviewed), /SHA differs/);
    extraction(f.sources, f.first.handle); fs.appendFileSync(path.join(f.sources, '100.txt'), 'changed');
    assert.throws(() => stage(f, reviewed), /SHA differs/);
    extraction(f.sources, f.first.handle); fs.appendFileSync(path.join(f.sources, '100-artifacts.json'), ' ');
    assert.throws(() => stage(f, reviewed), /SHA differs/);
    assert.throws(() => extractionReceipt.extractionHandleSnapshot({}), /authenticated extraction handle/);
});

test('CLI dry-run is non-writing and apply creates an immutable O_EXCL pair in configured staging output', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const value = extraction(f.sources, f.first.handle); const extractionFile = path.join(f.specs, 'reviewed.json');
    fs.writeFileSync(extractionFile, staging.canonicalBytes(value), { mode: 0o600 });
    const args = ['--dry-run', '--catalog', 'catalog.json', '--report', 'report.json', '--filter', filterId,
        '--extraction', 'reviewed.json', '--import-output', 'import.json', '--receipt-output', 'receipt.json'];
    const preview = cli.main(args, { files: f.files });
    assert.equal(preview.status, 'dry-run'); assert.equal(fs.readdirSync(f.output).length, 0);
    const applied = cli.main(['--apply', ...args.slice(1)], { files: f.files });
    assert.equal(applied.status, 'written');
    assert.equal(fs.statSync(path.join(f.output, 'import.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(f.output, 'receipt.json')).mode & 0o777, 0o600);
    assert.deepEqual(importer.validateManifest(ledger.readRegularJson(path.join(f.output, 'import.json')).value).members
        .map(member => member.identity.value), ['100', '200']);
    const handle = staging.loadStagingHandle(path.join(f.output, 'import.json'), path.join(f.output, 'receipt.json'),
        f.filtered.selectionHandle, f.first.handle, f.sources);
    const snapshot = staging.stagingHandleSnapshot(handle);
    assert.equal(snapshot.receipt.selection.selectionReceiptSha256, applied.selectionReceiptSha256);
    assert.deepEqual(snapshot.importManifest.members.map(member => member.identity.value), ['100', '200']);
    assert.throws(() => staging.stagingHandleSnapshot(structuredClone(handle)), /authenticated staging handle/);
    assert.throws(() => cli.main(['--apply', ...args.slice(1)], { files: f.files }), /immutable staging bundle/);
    assert.equal(fs.readdirSync(f.output).sort().join(','), 'import.json,receipt.json');
});

test('staging handle replays exact manifest/receipt bytes and current selection/discovery', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const result = stage(f); const importFile = path.join(f.output, 'import.json'); const receiptFile = path.join(f.output, 'receipt.json');
    fs.writeFileSync(importFile, result.importBytes, { mode: 0o600 }); fs.writeFileSync(receiptFile, result.receiptBytes, { mode: 0o600 });
    assert.ok(staging.loadStagingHandle(importFile, receiptFile, f.filtered.selectionHandle, f.first.handle, f.sources));
    const changed = structuredClone(result.importManifest); changed.members[0].pdf.sha256 = h('changed');
    fs.writeFileSync(importFile, staging.canonicalBytes(changed), { mode: 0o600 });
    assert.throws(() => staging.loadStagingHandle(importFile, receiptFile, f.filtered.selectionHandle, f.first.handle, f.sources),
        /exact import manifest file|member binding/);
    fs.writeFileSync(importFile, result.importBytes, { mode: 0o600 });
    const changedReceipt = structuredClone(result.receipt); changedReceipt.members[0].sourceSha256 = h('changed');
    fs.writeFileSync(receiptFile, staging.canonicalBytes(changedReceipt), { mode: 0o600 });
    assert.throws(() => staging.loadStagingHandle(importFile, receiptFile, f.filtered.selectionHandle, f.first.handle, f.sources),
        /receipt SHA/);
});

test('downstream import replays Python extraction and rejects deleted derived bytes', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const result = stage(f); const importFile = path.join(f.output, 'import.json');
    const receiptFile = path.join(f.output, 'receipt.json');
    fs.writeFileSync(importFile, result.importBytes, { mode: 0o600 });
    fs.writeFileSync(receiptFile, result.receiptBytes, { mode: 0o600 });
    const handle = staging.loadStagingHandle(importFile, receiptFile,
        f.filtered.selectionHandle, f.first.handle, f.sources);
    fs.unlinkSync(path.join(f.sources, '100.txt'));
    const cache = path.join(f.root, 'cache'); fs.mkdirSync(cache);
    assert.throws(() => importer.importConferenceSourcesFromStaging({ stagingHandle: handle,
        sourceRoot: f.sources, cacheRoot: cache, updatedAt: stamp }), /extraction replay failed|missing or inaccessible/);
});

test('CLI accepts only direct configured names and a canonical filter UUID', () => {
    assert.deepEqual(cli.parseArgs(['--dry-run', '--catalog', 'c.json', '--report', 'r.json', '--filter', filterId,
        '--extraction', 'e.json', '--import-output', 'i.json', '--receipt-output', 's.json']),
    { apply: false, catalogName: 'c.json', reportName: 'r.json', filterId,
        extractionName: 'e.json', importManifestName: 'i.json', receiptName: 's.json' });
    for (const args of [[], ['--dry-run', '--catalog', '../c.json'],
        ['--apply', '--catalog', 'c.json', '--report', 'r.json', '--filter', 'not-uuid',
            '--extraction', 'e.json', '--import-output', 'i.json', '--receipt-output', 's.json']]) {
        assert.throws(() => cli.parseArgs(args));
    }
});

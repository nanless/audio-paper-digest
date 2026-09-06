'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const discovery = require('../../scripts/lib/conference-discovery.js');
const filter = require('../../scripts/lib/conference-filter.js');
const staging = require('../../scripts/lib/conference-staging.js');
const importer = require('../../scripts/lib/conference-importer.js');
const plan = require('../../scripts/lib/conference-plan.js');
const importCli = require('../../scripts/conference-import.js');
const extractionFixture = require('./conference-extraction-fixture.js');
const paperIdentity = require('../../scripts/lib/paper-identity.js');

const NOW = '2026-09-06T12:00:00.000Z';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function productionPlanFixture(t, { value = '100', pdfLines = 120 } = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-plan-authority-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const roots = Object.fromEntries(['source', 'cache', 'ledgers', 'catalogs', 'reports', 'filters', 'staging', 'runs']
        .map(name => [name, path.join(root, name)]));
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { mode: 0o700 });
    const pdfRoot = path.join(root, 'pdfs'); fs.mkdirSync(pdfRoot, { mode: 0o700 });
    const metadataFile = path.join(root, 'metadata.json'); const title = `Paper ${value}`;
    fs.writeFileSync(metadataFile, JSON.stringify([{ arnumber: value, title }]), { mode: 0o600 });
    fs.writeFileSync(path.join(pdfRoot, `${title}.pdf`), extractionFixture.buildPdf(title, pdfLines), { mode: 0o600 });

    const discovered = discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile, pdfRoot });
    const catalogFile = path.join(roots.catalogs, 'catalog.json'); const reportFile = path.join(roots.reports, 'report.json');
    fs.writeFileSync(catalogFile, discovery.canonicalBytes(discovered.manifest), { mode: 0o600 });
    fs.writeFileSync(reportFile, discovery.canonicalBytes(discovered.report), { mode: 0o600 });
    const discoveryHandle = discovery.loadDiscoveryHandle(catalogFile, reportFile);
    const filterId = '11111111-1111-4111-8111-111111111111';
    let filterState = filter.prepareFilter({ filterRoot: roots.filters, discoveryHandle, filterId, now: NOW,
        spec: { contract: filter.SPEC_CONTRACT, version: filter.VERSION, filterPolicySha256: sha256('policy'),
            promptSha256: sha256('prompt'), model: 'fixture', endpointProtocol: 'openai-responses',
            endpointIdentitySha256: sha256('endpoint identity'),
            taxonomyRegistrySha256: sha256('taxonomy') } });
    const paperId = paperIdentity.canonicalConferencePaperId(
        { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value });
    const decision = filter.buildDecisionArtifact({ state: filterState, paperId,
        operationId: '22222222-2222-4222-8222-222222222222', actor: { type: 'manual', id: 'reviewer' },
        model: null, endpointProtocol: 'manual', requestBytes: 'review', responseBytes: 'included',
        status: 'included', reason: 'included', usage: {}, now: NOW });
    const decisionFile = filter.writeDecisionArtifact({ filterRoot: roots.filters, filterId,
        decisionName: 'decision.json', artifact: decision });
    filterState = filter.applyDecision({ filterRoot: roots.filters, filterId,
        decisionHandle: filter.loadDecisionHandle(decisionFile), owner: 'reviewer', now: NOW });
    const selectionHandle = filter.loadSelectionHandle(roots.filters, filterId, discoveryHandle);

    const sourceIdentity = `icassp-arnumber:${value}`;
    const replay = discovery.replayDiscoveryMember(discoveryHandle, sourceIdentity);
    const pdfBytes = fs.readFileSync(path.join(pdfRoot, replay.match.candidates[0].path));
    const generated = extractionFixture.runProductionExtraction({ sourceRoot: roots.source, value, pdfBytes, stamp: NOW,
        discoveryBinding: { catalogSha256: replay.catalogSha256, metadataSnapshotSha256: replay.metadataSnapshotSha256,
            metadataIndex: replay.metadataIndex, metadataRecordSha256: replay.metadataRecordSha256 } });
    const members = [{ paperId, sourceIdentity, receiptName: generated.receiptName }];
    const reviewed = { contract: staging.EXTRACTION_CONTRACT, version: staging.VERSION,
        conference: { id: 'icassp-2026', year: 2026 }, review: { actor: 'reviewer', reviewedAt: NOW }, members,
        membersSha256: staging.stableHash(members) };
    const staged = staging.bindInputs({ selectionHandle, discoveryHandle, extractionManifest: reviewed,
        extractionFileSha256: sha256('reviewed extraction'), extractionSourceRoot: roots.source,
        importManifestName: 'import.json' });
    staging.writeStagingBundle({ stagingRoot: roots.staging, importManifestName: 'import.json',
        receiptName: 'staging-receipt.json', staged });

    const files = { conferenceStagingDir: roots.staging, conferenceStagingSourceDir: roots.source,
        conferenceDiscoveryCatalogDir: roots.catalogs, conferenceDiscoveryReportDir: roots.reports,
        conferenceFiltersDir: roots.filters, conferenceSourceCacheDir: roots.cache,
        conferenceSourceLedgerDir: roots.ledgers, conferenceRunsDir: roots.runs };
    importCli.main(['--apply', '--import', 'import.json', '--receipt', 'staging-receipt.json', '--filter', filterId,
        '--catalog', 'catalog.json', '--report', 'report.json', '--updated-at', NOW, '--ledger-output', 'ledger.json'], { files });
    const stagingHandle = staging.loadStagingHandle(path.join(roots.staging, 'import.json'),
        path.join(roots.staging, 'staging-receipt.json'), selectionHandle, discoveryHandle, roots.source);
    const importHandle = importer.loadImportHandle(path.join(roots.ledgers, 'ledger.json'),
        path.join(roots.ledgers, 'ledger.import-receipt.json'), stagingHandle);
    const taxonomy = path.join(root, 'taxonomy.json'); fs.writeFileSync(taxonomy, '{"version":"taxonomy-v1"}\n', { mode: 0o600 });
    files.taxonomyRegistry = taxonomy;
    const identities = importer.importHandleSnapshot(importHandle).verifiedMembers;
    const runPlan = { contract: plan.PLAN_CONTRACT, version: plan.VERSION, ledgerName: 'ledger.json',
        taxonomy: { version: 'taxonomy-v1', sha256: sha256(fs.readFileSync(taxonomy)) },
        selectionPolicy: { contract: plan.SELECTION_CONTRACT, identities,
            selectedMemberSetSha256: plan.stableHash(identities.map(member => member.paperId)) },
        shards: [{ shardId: 'all', paperIds: identities.map(member => member.paperId) }] };
    fs.writeFileSync(path.join(roots.ledgers, 'plan.json'), `${JSON.stringify(runPlan, null, 2)}\n`, { mode: 0o600 });
    const planned = plan.createRunFromImportPlan({ files, importHandle, planName: 'plan.json', runName: 'run.json' });
    plan.applyRunPlan(planned);
    const planHandle = plan.loadPlanHandle(path.join(roots.runs, 'run.json'),
        path.join(roots.runs, 'run.plan-receipt.json'), path.join(roots.ledgers, 'plan.json'), importHandle, taxonomy);
    const authority = plan.planHandleAuthority(planHandle);
    const ledger = authority.ledgerHandle && require('../../scripts/lib/conference-source-ledger.js')
        .ledgerHandleSnapshot(authority.ledgerHandle).ledger;
    const member = ledger.members[0];
    return { root, roots, files, planHandle, paperId, sourceIdentity, member,
        sourceRoot: roots.cache, filterState };
}

module.exports = { productionPlanFixture, NOW, sha256 };

// Offline mechanical PDF fixture; no model or network calls.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const child = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const lib = name => require(path.join(ROOT, 'scripts/lib', name));
const discovery = lib('conference-discovery'), filter = lib('conference-filter');
const processApi = lib('conference-process'), adapter = lib('conference-analysis-adapter');
const analysisContext = lib('conference-analysis-context');
const extractionFixture = require(path.join(ROOT, 'tests/helpers/conference-extraction-fixture.js'));
const evidenceFixture = require(path.join(ROOT, 'tests/helpers/conference-filter-evidence-fixture.js'));
async function shortProceedingsFixture(t, { conferenceId = 'jep-2026', lines = 60 } = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'short-proceedings-fixture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const names = ['catalogs', 'reports', 'filters', 'specs', 'source', 'staging', 'cache', 'ledgers',
        'runs', 'analysis', 'pages', 'aggregates', 'processes', 'pdf'];
    for (const name of names) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const record = { id: 'audit26_short', title: 'Audited short proceedings', authors: ['A. Author'],
        abstract: 'A finite mechanical source fixture.', pdfFile: 'audit.pdf',
        recordUrl: 'https://www.isca-archive.org/jep_2026/audit26_short.html',
        pdfUrl: 'https://www.isca-archive.org/jep_2026/audit26_short.pdf', doi: null, track: 'Main' };
    const metadata = path.join(root, 'metadata.json');
    fs.writeFileSync(metadata, JSON.stringify({ conference: { id: conferenceId, year: 2026 }, papers: [record] }), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'pdf', record.pdfFile), extractionFixture.buildPdf('Short', lines), { mode: 0o600 });
    const found = discovery.discoverConference({ adapter: 'official-proceedings', conferenceId,
        year: 2026, metadataFile: metadata, pdfRoot: path.join(root, 'pdf') });
    for (const [directory, name, value] of [['catalogs', 'catalog.json', found.manifest], ['reports', 'report.json', found.report]]) {
        fs.writeFileSync(path.join(root, directory, name), discovery.canonicalBytes(value), { mode: 0o600 });
    }
    const discoveryHandle = discovery.loadDiscoveryHandle(path.join(root, 'catalogs/catalog.json'), path.join(root, 'reports/report.json'));
    const { evidenceHandle } = evidenceFixture.createEvidenceHandle({ root, discoveryHandle });
    const filterId = '11111111-1111-4111-8111-111111111111', now = '2026-10-23T00:00:00.000Z';
    let state = filter.prepareFilter({ filterRoot: path.join(root, 'filters'), discoveryHandle, evidenceHandle,
        filterId, now, spec: evidenceFixture.createFilterSpec({ discoveryHandle, evidenceHandle }) });
    const paperId = Object.keys(state.decisions)[0];
    const artifact = filter.buildDecisionArtifact({ state, paperId,
        operationId: '22222222-2222-4222-8222-222222222222', actor: { type: 'manual', id: 'offline-auditor' },
        model: null, endpointProtocol: 'manual', requestBytes: 'mechanical selection', responseBytes: 'included',
        status: 'included', reason: 'offline source profile audit', usage: {}, now });
    const decision = filter.writeDecisionArtifact({ filterRoot: path.join(root, 'filters'), filterId, decisionName: 'included.json', artifact });
    filter.applyDecision({ filterRoot: path.join(root, 'filters'), filterId,
        decisionHandle: filter.loadDecisionHandle(decision), owner: 'offline-auditor', now });
    const map = { conferenceDiscoveryCatalogDir: 'catalogs', conferenceDiscoveryReportDir: 'reports',
        conferenceFiltersDir: 'filters', conferenceStagingSpecsDir: 'specs', conferenceStagingSourceDir: 'source',
        conferenceStagingDir: 'staging', conferenceSourceCacheDir: 'cache', conferenceSourceLedgerDir: 'ledgers',
        conferenceRunsDir: 'runs', conferenceAnalysisDir: 'analysis', conferencePageStagingDir: 'pages',
        conferenceAggregateDir: 'aggregates', conferenceProcessDir: 'processes' };
    const files = { ...require(path.join(ROOT, 'scripts/config.js')).FILES,
        ...Object.fromEntries(Object.entries(map).map(([key, value]) => [key, path.join(root, value)])) };
    const deps = { ...processApi.defaultDependencies(), files,
        execFileSync: (_cmd, args, options) => child.execFileSync('bash', [args[0], '-c',
            'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[3]); from conference_extractor import run_extraction; run_extraction(sys.argv[1], apply=True, source_root=Path(sys.argv[2]))',
            args.at(-1), files.conferenceStagingSourceDir, path.join(ROOT, 'scripts')], options) };
    const context = processApi.loadAuthority({ catalogName: 'catalog.json', reportName: 'report.json', filterId }, deps);
    const shared = processApi.prepareShared(context, deps, now);
    const executionId = '33333333-3333-4333-8333-333333333333';
    adapter.prepareConferenceAnalysis({ planHandle: shared.planHandle, paperId, sourceRoot: shared.sourceCacheRoot,
        analysisRoot: files.conferenceAnalysisDir, executionId });
    const loaded = adapter.loadConferenceAnalysis({ analysisRoot: files.conferenceAnalysisDir, executionId });
    const handle = adapter.verifyPlanAuthority(loaded, shared.planHandle, shared.sourceCacheRoot);
    const paper = loaded.analysis.papers[0], details = loaded.source.sourceDetails;
    return { paper, details, handle, loaded, root, sourceRoot: shared.sourceCacheRoot,
        ledgerFile: path.join(files.conferenceSourceLedgerDir, shared.names.ledger),
        withSource: callback => analysisContext.withConferenceAnalysisSource({ executionId,
            executionDir: loaded.directory, paperId, sourceDetails: details,
            readerPdfSourceHandle: handle }, callback) };
}
module.exports = { shortProceedingsFixture };

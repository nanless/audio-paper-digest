'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const processApi = require('../../scripts/lib/conference-process.js');
const discovery = require('../../scripts/lib/conference-discovery.js');
const filter = require('../../scripts/lib/conference-filter.js');
const extractionFixture = require('./conference-extraction-fixture.js');
const evidenceFixture = require('./conference-filter-evidence-fixture.js');
const { stableHash } = processApi;

function storageDependencies(files) {
    return {
        ...processApi.defaultDependencies(),
        files,
        now: () => '2026-09-09T00:00:00.000Z',
        execFileSync: (_command, args, options) => {
            const code = 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[3]); from conference_extractor import run_extraction; run_extraction(sys.argv[1], apply=True, source_root=Path(sys.argv[2]))';
            return childProcess.execFileSync('bash', [args[0], '-c', code, args.at(-1),
                files.conferenceStagingSourceDir, path.join(__dirname, '../../scripts')], options);
        },
        processPaper: async (_context, _shared, item) => ({
            analysisProof: {
                analysisSha256: stableHash(item.paperId),
                completionReceiptSha256: stableHash('analysis'),
                sourceSnapshotSha256: stableHash('source')
            },
            pageProof: {
                manifestSha256: stableHash('page'),
                contentSha256: stableHash('content'),
                pagePath: 'content/posts/paper.md'
            }
        }),
        aggregate: async () => ({
            manifest: {
                aggregateId: stableHash('aggregate').slice(0, 32),
                manifestSha256: stableHash('manifest'),
                markdownSha256: stableHash('markdown'),
                pagePath: 'content/posts/conference.md'
            }
        })
    };
}

function createSourceFixture(root) {
    const directoryNames = ['catalogs', 'reports', 'filters', 'specs', 'source', 'staging', 'cache', 'ledgers',
        'runs', 'analysis', 'pages', 'aggregates', 'processes', 'pdf'];
    for (const name of directoryNames) {
        fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    }
    const metadataFile = path.join(root, 'metadata.json');
    const pdfRoot = path.join(root, 'pdf');
    const record = {
        id: 'ando26_odyssey', title: 'Fixture audio paper', authors: ['A. Author'],
        abstract: 'Speech processing evidence.', pdfFile: 'papers/ando26_odyssey.pdf',
        recordUrl: 'https://www.isca-archive.org/odyssey_2026/ando26_odyssey.html',
        pdfUrl: 'https://www.isca-archive.org/odyssey_2026/ando26_odyssey.pdf', doi: null, track: 'Main'
    };
    fs.writeFileSync(metadataFile, JSON.stringify({ conference: { id: 'odyssey-2026', year: 2026 }, papers: [record] }));
    fs.mkdirSync(path.join(pdfRoot, 'papers'));
    fs.writeFileSync(path.join(pdfRoot, record.pdfFile),
        extractionFixture.buildPdf(record.title, 150));
    const found = discovery.discoverConference({
        adapter: 'official-proceedings', conferenceId: 'odyssey-2026',
        year: 2026, metadataFile, pdfRoot
    });
    fs.writeFileSync(path.join(root, 'catalogs', 'catalog.json'), discovery.canonicalBytes(found.manifest));
    fs.writeFileSync(path.join(root, 'reports', 'report.json'), discovery.canonicalBytes(found.report));
    const discoveryHandle = discovery.loadDiscoveryHandle(path.join(root, 'catalogs', 'catalog.json'),
        path.join(root, 'reports', 'report.json'));
    const { evidenceHandle } = evidenceFixture.createEvidenceHandle({
        root, discoveryHandle,
        now: '2026-09-09T00:00:00.000Z'
    });
    const filterId = '11111111-1111-4111-8111-111111111111';
    const stamp = '2026-09-09T00:00:00.000Z';
    const state = filter.prepareFilter({
        filterRoot: path.join(root, 'filters'), discoveryHandle, evidenceHandle,
        filterId, now: stamp,
        spec: evidenceFixture.createFilterSpec({ discoveryHandle, evidenceHandle })
    });
    const paperId = Object.keys(state.decisions)[0];
    const artifact = filter.buildDecisionArtifact({
        state, paperId,
        operationId: '22222222-2222-4222-8222-222222222222', actor: { type: 'manual', id: 'filter-reviewer' },
        model: null, endpointProtocol: 'manual', requestBytes: 'filter request', responseBytes: 'included',
        status: 'included', reason: 'audio paper', usage: {}, now: stamp
    });
    const decisionFile = filter.writeDecisionArtifact({
        filterRoot: path.join(root, 'filters'), filterId,
        decisionName: 'included.json', artifact
    });
    filter.applyDecision({
        filterRoot: path.join(root, 'filters'), filterId,
        decisionHandle: filter.loadDecisionHandle(decisionFile), owner: 'filter-reviewer', now: stamp
    });
    const tagCatalogPath = path.join(root, 'taxonomy.json');
    fs.writeFileSync(tagCatalogPath, '{"version":"taxonomy-v1"}\n');
    const files = {
        conferenceDiscoveryCatalogDir: path.join(root, 'catalogs'),
        conferenceDiscoveryReportDir: path.join(root, 'reports'), conferenceFiltersDir: path.join(root, 'filters'),
        conferenceStagingSpecsDir: path.join(root, 'specs'), conferenceStagingSourceDir: path.join(root, 'source'),
        conferenceStagingDir: path.join(root, 'staging'), conferenceSourceCacheDir: path.join(root, 'cache'),
        conferenceSourceLedgerDir: path.join(root, 'ledgers'), conferenceRunsDir: path.join(root, 'runs'),
        conferenceAnalysisDir: path.join(root, 'analysis'), conferencePageStagingDir: path.join(root, 'pages'),
        conferenceAggregateDir: path.join(root, 'aggregates'), conferenceProcessDir: path.join(root, 'processes'),
        tagCatalogFile: tagCatalogPath
    };
    const deps = storageDependencies(files);
    const context = processApi.loadAuthority({ catalogName: 'catalog.json', reportName: 'report.json', filterId }, deps);
    const options = {
        apply: true, concurrency: 1, catalogName: 'catalog.json', reportName: 'report.json', filterId
    };
    return { root, files, deps, context, options, stamp, paperId };
}

module.exports = { createSourceFixture, storageDependencies };

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
const evidenceFixture = require('./conference-filter-evidence-fixture.js');

const NOW = '2026-09-06T12:00:00.000Z';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function productionPlanFixture(t, { value = '100', pdfLines = 120, planApi = plan, authors = null } = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-plan-authority-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const roots = Object.fromEntries(['source', 'cache', 'ledgers', 'catalogs', 'reports', 'filters', 'staging', 'runs']
        .map(name => [name, path.join(root, name)]));
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { mode: 0o700 });
    const pdfRoot = path.join(root, 'pdfs'); fs.mkdirSync(pdfRoot, { mode: 0o700 });
    const metadataFile = path.join(root, 'metadata.json'); const title = `Paper ${value}`;
    fs.writeFileSync(metadataFile, JSON.stringify([{ arnumber: value, title, ...(authors ? { authors } : {}) }]), { mode: 0o600 });
    fs.writeFileSync(path.join(pdfRoot, `${title}.pdf`), extractionFixture.buildPdf(title, pdfLines), { mode: 0o600 });

    const discovered = discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile, pdfRoot });
    const catalogFile = path.join(roots.catalogs, 'catalog.json'); const reportFile = path.join(roots.reports, 'report.json');
    fs.writeFileSync(catalogFile, discovery.canonicalBytes(discovered.manifest), { mode: 0o600 });
    fs.writeFileSync(reportFile, discovery.canonicalBytes(discovered.report), { mode: 0o600 });
    const discoveryHandle = discovery.loadDiscoveryHandle(catalogFile, reportFile);
    const { evidenceHandle } = evidenceFixture.createEvidenceHandle({ root, discoveryHandle, now: NOW });
    const filterId = '11111111-1111-4111-8111-111111111111';
    let filterState = filter.prepareFilter({ filterRoot: roots.filters, discoveryHandle, evidenceHandle,
        filterId, now: NOW,
        spec: evidenceFixture.createFilterSpec({ discoveryHandle, evidenceHandle }) });
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
    const generated = extractionFixture.runProductionExtraction({ sourceRoot: roots.source, value, pdfBytes, stamp: NOW, authors,
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
    // 原源码实例保留原文件名与原词表版本；当前默认样本使用新名称。
    const tagField = planApi.PLAN_CONTRACT === 'conference-run-plan-v2' ? 'taxonomy' : 'tagMetadata';
    const tagCatalogVersion = tagField === 'taxonomy' ? 'taxonomy-v1' : 'paper-tag-catalog-v2';
    const tagCatalogPath = path.join(root, tagField === 'taxonomy' ? 'taxonomy.json' : 'tag-catalog.json');
    fs.writeFileSync(tagCatalogPath, `${JSON.stringify({ version: tagCatalogVersion })}\n`, { mode: 0o600 });
    files.tagCatalogFile = tagCatalogPath;
    const identities = importer.importHandleSnapshot(importHandle).verifiedMembers;
    // 原源码实例按其旧格式生成样本；不修改新版对象的字段，也不重新计算其 SHA 来冒充旧记录。
    const runPlan = planApi.normalizePlan({ contract: planApi.PLAN_CONTRACT, version: planApi.VERSION, ledgerName: 'ledger.json',
        [tagField]: { version: tagCatalogVersion, sha256: sha256(fs.readFileSync(tagCatalogPath)) },
        selectionPolicy: { contract: planApi.SELECTION_CONTRACT, identities,
            selectedMemberSetSha256: planApi.stableHash(identities.map(member => member.paperId)) },
        shards: [{ shardId: 'all', paperIds: identities.map(member => member.paperId) }] });
    fs.writeFileSync(path.join(roots.ledgers, 'plan.json'), `${JSON.stringify(runPlan, null, 2)}\n`, { mode: 0o600 });
    const planned = planApi.createRunFromImportPlan({ files, importHandle, planName: 'plan.json', runName: 'run.json' });
    planApi.applyRunPlan(planned);
    const planHandle = planApi.loadPlanHandle(path.join(roots.runs, 'run.json'),
        path.join(roots.runs, 'run.plan-receipt.json'), path.join(roots.ledgers, 'plan.json'), importHandle, tagCatalogPath);
    const authority = planApi.planHandleAuthority(planHandle);
    const ledger = authority.ledgerHandle && require('../../scripts/lib/conference-source-ledger.js')
        .ledgerHandleSnapshot(authority.ledgerHandle).ledger;
    const member = ledger.members[0];
    return { root, roots, files, planHandle, planned, importHandle, tagCatalogPath, paperId, sourceIdentity, member,
        sourceRoot: roots.cache, filterState };
}

// 本批前提交的完整源码只用于临时离线旧样本。先核原字节，再按原 filename
// 装载实例；依赖替换仅限该实例，不改 require.cache、环境或当前生产模块。
const ORIGINAL_CONFERENCE_SOURCE_PINS = Object.freeze({
    'conference-run': '01ddaa42f1ef45b82787478ba2592b35410752d6950dca0d46a4e74203efef84',
    'conference-plan': 'fd1b320179cad9a6ce7fce89adde32af8c561875fa614fe5cedd8f559d468b38',
    'conference-execution': '5aeb0f44a294aee482279b89abda19b7b81b011dc041dec74e4e05cb8296df7a'
});
function loadOriginalConferenceApis() {
    const Module = require('node:module');
    const loadedApis = {};
    for (const [name, expectedSha] of Object.entries(ORIGINAL_CONFERENCE_SOURCE_PINS)) {
        const raw = fs.readFileSync(path.join(__dirname, `../fixtures/${name}-v2-source.txt`));
        if (sha256(raw) !== expectedSha) throw new Error('原会议源码归档的内容哈希不匹配。');
        const filename = path.resolve(__dirname, `../../scripts/lib/${name}.js`);
        const loaded = new Module(filename, module);
        loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
        const originalRequire = loaded.require.bind(loaded);
        loaded.require = request => {
            const dependency = request.startsWith('./') && request.endsWith('.js')
                ? request.slice(2, -3) : null;
            return dependency && Object.hasOwn(loadedApis, dependency)
                ? loadedApis[dependency] : originalRequire(request);
        };
        loaded._compile(raw.toString('utf8'), filename);
        loadedApis[name] = loaded.exports;
    }
    return { run: loadedApis['conference-run'], plan: loadedApis['conference-plan'],
        execution: loadedApis['conference-execution'] };
}

module.exports = { productionPlanFixture, NOW, sha256, loadOriginalConferenceApis, ORIGINAL_CONFERENCE_SOURCE_PINS };

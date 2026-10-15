'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const api = require('../scripts/lib/conference-process');
const replayApi = require('../scripts/lib/conference-retained-source-replay');
const extraction = require('../scripts/lib/conference-extraction-receipt');
const extractionFixture = require('./helpers/conference-extraction-fixture');
const evidenceFixture = require('./helpers/conference-filter-evidence-fixture');

function mixedFixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'retained-conference-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const deps = api.defaultDependencies();
    const files = Object.fromEntries(['conferenceStagingDir', 'conferenceStagingSourceDir',
        'conferenceDiscoveryCatalogDir', 'conferenceDiscoveryReportDir', 'conferenceFiltersDir',
        'conferenceSourceCacheDir', 'conferenceSourceLedgerDir', 'conferenceRunsDir', 'conferenceAnalysisDir']
        .map(key => [key, path.join(root, key)]));
    for (const folder of Object.values(files)) fs.mkdirSync(folder, { mode: 0o700 });
    const pdfRoot = path.join(root, 'pdf'); fs.mkdirSync(pdfRoot);
    const metadataFile = path.join(root, 'metadata.json');
    fs.writeFileSync(metadataFile, JSON.stringify(['100', '101'].map(arnumber => ({ arnumber, title: `Paper ${arnumber}` }))));
    for (const value of ['100', '101']) fs.writeFileSync(path.join(pdfRoot, `Paper ${value}.pdf`), extractionFixture.buildPdf(`Paper ${value}`, 150));
    const found = deps.discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile, pdfRoot });
    const catalog = path.join(files.conferenceDiscoveryCatalogDir, 'catalog.json');
    const report = path.join(files.conferenceDiscoveryReportDir, 'report.json');
    fs.writeFileSync(catalog, deps.discovery.canonicalBytes(found.manifest));
    fs.writeFileSync(report, deps.discovery.canonicalBytes(found.report));
    const discoveryHandle = deps.discovery.loadDiscoveryHandle(catalog, report);
    const { evidenceHandle } = evidenceFixture.createEvidenceHandle({ root, discoveryHandle });
    const filterId = '11111111-1111-4111-8111-111111111111', now = '2026-09-07T00:00:00.000Z';
    let state = deps.filter.prepareFilter({ filterRoot: files.conferenceFiltersDir, discoveryHandle, evidenceHandle,
        filterId, now, spec: evidenceFixture.createFilterSpec({ discoveryHandle, evidenceHandle }) });
    for (const [index, paperId] of Object.keys(state.decisions).entries()) {
        const decision = deps.filter.buildDecisionArtifact({ state, paperId,
            operationId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
            actor: { type: 'manual', id: 'fixture-reviewer' }, model: null, endpointProtocol: 'manual',
            requestBytes: 'review', responseBytes: 'included', status: 'included', reason: 'speech evidence', usage: {}, now });
        const file = deps.filter.writeDecisionArtifact({ filterRoot: files.conferenceFiltersDir, filterId,
            decisionName: `decision-${index}.json`, artifact: decision });
        state = deps.filter.applyDecision({ filterRoot: files.conferenceFiltersDir, filterId,
            decisionHandle: deps.filter.loadDecisionHandle(file), owner: 'fixture-reviewer', now });
    }
    const selectionHandle = deps.filter.loadSelectionHandle(files.conferenceFiltersDir, filterId, discoveryHandle);
    const selection = deps.filter.selectionHandleSnapshot(selectionHandle);
    const sealed = ['100', '101'].map(value => {
        const found = deps.discovery.replayDiscoveryMember(discoveryHandle, `icassp-arnumber:${value}`);
        return extractionFixture.runProductionExtraction({ sourceRoot: files.conferenceStagingSourceDir,
            value, pdfBytes: fs.readFileSync(path.join(pdfRoot, `Paper ${value}.pdf`)), stamp: now,
            discoveryBinding: { catalogSha256: found.catalogSha256, metadataSnapshotSha256: found.metadataSnapshotSha256,
                metadataIndex: found.metadataIndex, metadataRecordSha256: found.metadataRecordSha256 } });
    });
    files.tagCatalogFile = path.join(root, 'tag-catalog.json');
    fs.writeFileSync(files.tagCatalogFile, fs.readFileSync(path.join(__dirname, '../config/tag-catalog.json')));
    const context = { selectionHandle, discoveryHandle, authority: { conferenceId: 'icassp-2026',
        filterPolicySha256: selection.filterPolicySha256, selectionReceiptSha256: selection.selectionReceiptSha256,
        selectedMemberSetSha256: selection.selectedMemberSetSha256 } };
    deps.files = files;
    const planHandles = ['a'.repeat(64), 'b'.repeat(64)].map(implementation => {
        const names = api.namesFor({ authority: { ...context.authority, implementationSha256: implementation } });
        const members = sealed.map(({ paperId, sourceIdentity, receiptName }) => ({ paperId, sourceIdentity, receiptName }));
        const manifest = { contract: deps.staging.EXTRACTION_CONTRACT, version: deps.staging.VERSION,
            conference: { id: 'icassp-2026', year: 2026 }, review: { actor: 'fixture-reviewer', reviewedAt: now },
            members, membersSha256: api.stableHash(members) };
        const staged = deps.staging.bindInputs({ selectionHandle, discoveryHandle, extractionManifest: manifest,
            extractionFileSha256: api.stableHash(manifest), extractionSourceRoot: files.conferenceStagingSourceDir,
            importManifestName: names.import, replay: false });
        deps.staging.writeStagingBundle({ stagingRoot: files.conferenceStagingDir,
            importManifestName: names.import, receiptName: names.stagingReceipt, staged });
        const stagingHandle = deps.staging.loadStagingHandle(path.join(files.conferenceStagingDir, names.import),
            path.join(files.conferenceStagingDir, names.stagingReceipt), selectionHandle, discoveryHandle,
            files.conferenceStagingSourceDir, { replay: false });
        const cacheRoot = path.join(files.conferenceSourceCacheDir, 'generation-' + implementation);
        fs.mkdirSync(cacheRoot, { mode: 0o700 });
        const result = deps.importer.importConferenceSourcesFromStaging({ stagingHandle,
            sourceRoot: files.conferenceStagingSourceDir, cacheRoot, updatedAt: now, apply: true, replay: false });
        const bundle = deps.importer.createImportReceipt({ result, ledgerName: names.ledger });
        deps.importCli.reserveOutputPair(files.conferenceSourceLedgerDir, names.ledger,
            bundle.ledgerBytes, bundle.receipt, names.importReceipt);
        const imported = deps.importer.loadImportHandle(path.join(files.conferenceSourceLedgerDir, names.ledger),
            path.join(files.conferenceSourceLedgerDir, names.importReceipt), stagingHandle);
        const identities = deps.importer.importHandleSnapshot(imported).verifiedMembers;
        const plan = { contract: deps.plan.PLAN_CONTRACT, version: deps.plan.PLAN_VERSION, ledgerName: names.ledger,
            tagMetadata: { version: 'paper-tag-catalog-v2', sha256: extractionFixture.sha256(fs.readFileSync(files.tagCatalogFile)) },
            selectionPolicy: { contract: deps.plan.SELECTION_CONTRACT, identities,
                selectedMemberSetSha256: api.stableHash(identities.map(item => item.paperId)) },
            shards: [{ shardId: 'all', paperIds: identities.map(item => item.paperId) }] };
        fs.writeFileSync(path.join(files.conferenceSourceLedgerDir, names.plan), api.canonicalBytes(plan));
        const prepared = deps.plan.createRunFromImportPlan({ files, importHandle: imported, planName: names.plan, runName: names.run });
        deps.plan.applyRunPlan(prepared);
        return { handle: deps.plan.loadPlanHandle(path.join(files.conferenceRunsDir, names.run),
            path.join(files.conferenceRunsDir, deps.plan.receiptNameFor(names.run)),
            path.join(files.conferenceSourceLedgerDir, names.plan), imported, files.tagCatalogFile), cacheRoot, names };
    });
    const items = sealed.map((source, index) => {
        const original = planHandles[index], executionId = `${index + 1}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
        deps.adapter.prepareConferenceAnalysis({ planHandle: original.handle, paperId: source.paperId,
            sourceRoot: original.cacheRoot, analysisRoot: files.conferenceAnalysisDir, executionId, now });
        const filename = path.join(files.conferenceAnalysisDir, executionId, 'analysis.json');
        const analysis = JSON.parse(fs.readFileSync(filename));
        analysis.status = 'complete'; analysis.completedAt = now;
        fs.writeFileSync(filename, JSON.stringify(analysis));
        deps.adapter.sealCompletedRun(deps.adapter.loadConferenceAnalysis({ analysisRoot: files.conferenceAnalysisDir, executionId }));
        const loaded = deps.adapter.loadConferenceAnalysis({ analysisRoot: files.conferenceAnalysisDir, executionId });
        const snapshot = extraction.extractionHandleSnapshot(extraction.loadExtractionHandle(
            files.conferenceStagingSourceDir, source.receiptName, { replay: false }));
        return { paperId: source.paperId, sourceIdentity: source.sourceIdentity, analysisRunId: executionId, status: 'complete',
            sourceProof: { requestSha256: snapshot.verification.requestSha256, receiptSha256: snapshot.receipt.receiptSha256,
                verificationSha256: snapshot.verification.verificationSha256, textSha256: snapshot.text.sha256,
                artifactsSha256: snapshot.artifacts.sha256, pdfSha256: snapshot.pdf.sha256 },
            analysisProof: { analysisSha256: loaded.analysisFileSha256,
                completionReceiptSha256: loaded.run.completionReceipt.receiptSha256,
                sourceSnapshotSha256: loaded.run.sourceSnapshotSha256 } };
    });
    return { deps, context, items, plans: planHandles };
}

test('混合已完成会议逐篇核验自己的原计划，完整上游及正文来源保持只读', t => {
    const f = mixedFixture(t);
    const planFile = path.join(f.deps.files.conferenceSourceLedgerDir, f.plans[0].names.plan);
    const migrated = JSON.parse(fs.readFileSync(planFile));
    migrated.tagMetadata.sha256 = '0'.repeat(64);
    fs.writeFileSync(planFile, api.canonicalBytes(migrated));
    const modifiedPlanBytes = fs.readFileSync(planFile);
    const temporary = [], mkdtemp = fs.mkdtempSync;
    t.mock.method(fs, 'mkdtempSync', (...args) => {
        const directory = mkdtemp(...args);
        if (String(args[0]).includes('conference-retained-plan-')) temporary.push(directory);
        return directory;
    });
    const loader = replayApi.createRetainedSourceReplay(f.context, f.deps);
    const calls = [], original = f.deps.adapter.verifyPlanAuthority;
    t.mock.method(f.deps.adapter, 'verifyPlanAuthority', (loaded, handle, sourceRoot) => {
        const proof = f.deps.plan.planHandleSnapshot(handle);
        calls.push(proof.receipt.receiptSha256);
        return original(loaded, handle, sourceRoot);
    });
    const before = f.items.map(item => fs.readFileSync(path.join(f.deps.files.conferenceAnalysisDir, item.analysisRunId, 'analysis.json')));
    f.items.forEach((item, index) => {
        const shared = loader.forItem(item);
        assert.equal(shared.sourceRoot, f.plans[index].cacheRoot);
        assert.equal(shared.planReceiptSha256, f.deps.plan.planHandleSnapshot(f.plans[index].handle).receipt.receiptSha256);
        assert.deepEqual(fs.readFileSync(path.join(f.deps.files.conferenceAnalysisDir, item.analysisRunId, 'analysis.json')), before[index]);
    });
    assert.equal(new Set(calls).size, 2);
    assert.deepEqual(fs.readFileSync(planFile), modifiedPlanBytes, '只重建原SHA字节，不改现有词表字段或计划文件');
    assert.equal(temporary.length, 1);
    assert(temporary.every(directory => !fs.existsSync(directory)), '原计划临时文件在核验后清理');
    const drift = structuredClone(f.items[0]); drift.sourceProof.requestSha256 = '0'.repeat(64);
    assert.throws(() => loader.forItem(drift), /逐项 SHA 不一致/);
    const wrongAnalysis = structuredClone(f.items[0]); wrongAnalysis.analysisProof.analysisSha256 = '0'.repeat(64);
    assert.throws(() => loader.forItem(wrongAnalysis), /分析或完成凭证与原成员不一致/);
    const member = f.deps.ledger.ledgerHandleSnapshot(f.deps.plan.planHandleAuthority(f.plans[0].handle).ledgerHandle).ledger.members[0];
    const textFile = path.join(f.plans[0].cacheRoot, member.textFile), originalText = fs.readFileSync(textFile);
    fs.appendFileSync(textFile, '\nchanged sealed evidence');
    assert.throws(() => loader.forItem(f.items[0]), /SHA|sha|来源|全文/);
    fs.writeFileSync(textFile, originalText);
    const changed = structuredClone(migrated); changed.shards[0].shardId = 'changed';
    fs.writeFileSync(planFile, api.canonicalBytes(changed));
    assert.throws(() => replayApi.createRetainedSourceReplay(f.context, f.deps).forItem(f.items[0]), /原会议计划文件字节缺失/);
    fs.writeFileSync(planFile, modifiedPlanBytes);
    t.mock.method(f.deps.plan, 'loadPlanHandle', () => { throw new Error('fixture plan validation failure'); });
    assert.throws(() => replayApi.createRetainedSourceReplay(f.context, f.deps).forItem(f.items[0]), /fixture plan validation failure/);
    assert(temporary.every(directory => !fs.existsSync(directory)), '正常核验抛错也清理原计划临时文件');
    t.mock.restoreAll();
    const missing = path.join(f.deps.files.conferenceSourceLedgerDir, f.plans[1].names.importReceipt);
    fs.unlinkSync(missing);
    assert.throws(() => replayApi.createRetainedSourceReplay(f.context, f.deps).forItem(f.items[1]), /ENOENT|安全|read safely/);
});

'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const filter = require('../scripts/lib/conference-filter.js');
const evidenceApi = require('../scripts/lib/conference-filter-evidence.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const discovery = require('../scripts/lib/conference-discovery.js');
const ledger = require('../scripts/lib/conference-source-ledger.js');
const cli = require('../scripts/conference-filter.js');
const h = value => crypto.createHash('sha256').update(value).digest('hex');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const stamp = '2026-09-06T00:00:00.000Z';
const evidenceRunId = '55555555-5555-4555-8555-555555555555';
const papers = ['100', '200'].map(value => paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value }));
function spec(f, overrides = {}) {
    const catalog = filter.catalogFromDiscoveryHandle(f.discoveryHandle);
    const discoverySnapshot = discovery.discoveryHandleSnapshot(f.discoveryHandle);
    const evidence = filter.evidenceBindingFromHandle(f.evidenceHandle, catalog);
    return { contract: filter.SPEC_CONTRACT, version: filter.SPEC_VERSION, filterPolicySha256: h('policy'), promptSha256: h('prompt'),
    model: 'muse-spark-1.2-contributor', endpointProtocol: 'openai-responses', endpointIdentitySha256: h('endpoint'),
    taxonomyRegistrySha256: h('taxonomy'), evidenceCatalogContract: evidenceApi.CATALOG_CONTRACT,
    discovery: { contract: catalog.contract, conferenceId: catalog.conferenceId,
        catalogSha256: catalog.catalogSha256, reportSha256: discoverySnapshot.reportSha256,
        candidateSetSha256: filter.stableHash(catalog.members) }, evidence, ...overrides };
}
function attachEvidence(root, evidenceRoot, discoveryHandle) {
    const snapshot = discovery.discoveryHandleSnapshot(discoveryHandle);
    evidenceApi.prepareEvidence({ evidenceRunsRoot: evidenceRoot, runId: evidenceRunId, discoveryHandle,
        apply: true, limit: snapshot.candidateManifest.members.length, now: stamp,
        extract: (itemRoot, { request, replay }) => {
            const abstract = String(replay.metadataRecord.abstract || '');
            const text = Buffer.from(abstract
                ? `Abstract\n${abstract}\n1 Introduction\nFixture body.`
                : 'Fixture text intentionally has no abstract heading.');
            const artifacts = Buffer.from(`${JSON.stringify({
                pages: [{ page: 1, textStart: 0, textEnd: text.length }]
            }, null, 2)}\n`);
            const receipt = Buffer.from('{"fixture":true}\n');
            fs.writeFileSync(path.join(itemRoot, 'text.txt'), text);
            fs.writeFileSync(path.join(itemRoot, 'artifacts.json'), artifacts);
            fs.writeFileSync(path.join(itemRoot, 'extraction-receipt.json'), receipt);
            return { paperId: request.paperId, sourceIdentity: request.sourceIdentity,
                pdf: { sha256: request.source.pdf.sha256 },
                text: { file: 'text.txt', sha256: h(text) },
                artifacts: { file: 'artifacts.json', sha256: h(artifacts) },
                receipt: { file: 'extraction-receipt.json', fileSha256: h(receipt), receiptSha256: 'a'.repeat(64) },
                verification: { verificationSha256: 'b'.repeat(64) } };
        } });
    return evidenceApi.loadEvidenceHandle({ evidenceRunsRoot: evidenceRoot, runId: evidenceRunId, discoveryHandle });
}
function fixture(metadataRecords = null) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-filter-'));
    for (const name of ['filters', 'catalogs', 'reports', 'evidence']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    metadataRecords ||= [100, 200].map(number => ({ arnumber: String(number), title: `Paper ${number}` }));
    const metadataBytes = Buffer.from(JSON.stringify(metadataRecords));
    fs.writeFileSync(path.join(root, 'metadata.json'), metadataBytes, { mode: 0o600 });
    const pdfCatalog = metadataRecords.map(record => {
        const directory = `pdf-${record.arnumber}`; fs.mkdirSync(path.join(root, directory), { mode: 0o700 });
        const filename = `${directory}/${record.title}.pdf`; const bytes = Buffer.from(`%PDF-1.7\n${record.arnumber}\n`);
        fs.writeFileSync(path.join(root, directory, `${record.title}.pdf`), bytes, { mode: 0o600 });
        return { path: filename, sha256: h(bytes), size: bytes.length };
    }).sort((left, right) => left.path.localeCompare(right.path));
    const pdfByArnumber = new Map(pdfCatalog.map(item => [path.dirname(item.path).slice('pdf-'.length), item]));
    const manifest = { contract: discovery.CONTRACT, version: discovery.VERSION, adapter: 'icassp', conference: { id: 'icassp-2026', year: 2026 },
        metadataSnapshot: { file: path.join(root, 'metadata.json'), sha256: h(metadataBytes), size: metadataBytes.length }, pdfRoot: root,
        pdfCatalogSha256: ledger.stableHash(pdfCatalog), pdfCatalog, members: metadataRecords.map((record, index) => ({
            identity: { type: 'icassp-arnumber', value: String(record.arnumber) }, metadataIndex: index, title: record.title,
            numericAlias: null, match: { kind: 'exact', candidates: [pdfByArnumber.get(String(record.arnumber))] }
        })), memberSetSha256: '' };
    manifest.memberSetSha256 = ledger.memberSetSha256(manifest.members);
    const report = discovery.buildReport(manifest);
    const catalogFile = path.join(root, 'catalogs', 'conference.json'); const reportFile = path.join(root, 'reports', 'conference.json');
    fs.writeFileSync(catalogFile, discovery.canonicalBytes(manifest), { mode: 0o600 });
    fs.writeFileSync(reportFile, discovery.canonicalBytes(report), { mode: 0o600 });
    const discoveryHandle = discovery.loadDiscoveryHandle(catalogFile, reportFile);
    return { root, filters: path.join(root, 'filters'), discoveryHandle,
        evidenceRoot: path.join(root, 'evidence'), evidenceHandle: attachEvidence(root, path.join(root, 'evidence'), discoveryHandle) };
}
function officialFixture(options = {}) {
    const conferenceId = options.conferenceId || 'aaai-2026';
    const officialPapers = options.papers || [
        { id: 'AAAI.2026-001_camera', title: 'Audio paper', authors: ['A. Author'], abstract: 'Audio evidence.',
            pdfFile: 'accepted/paper-001.pdf', recordUrl: 'https://ojs.aaai.org/index.php/AAAI/article/view/30001',
            pdfUrl: 'https://ojs.aaai.org/index.php/AAAI/article/view/30001/32001', doi: '10.1609/aaai.v40i1.30001', track: 'Main' },
        { id: 'AAAI-2026.002', title: 'Other paper', authors: ['B. Author'], abstract: '', pdfFile: 'accepted/paper-002.pdf',
            recordUrl: 'https://ojs.aaai.org/index.php/AAAI/article/view/30002',
            pdfUrl: 'https://ojs.aaai.org/index.php/AAAI/article/view/30002/32002', doi: null, track: null }
    ];
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-filter-official-'));
    for (const name of ['filters', 'catalogs', 'reports', 'pdf', 'evidence']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const metadataFile = path.join(root, 'metadata.json');
    fs.writeFileSync(metadataFile, JSON.stringify({ conference: { id: conferenceId, year: 2026 }, papers: officialPapers }), { mode: 0o600 });
    for (const [index, paper] of officialPapers.entries()) {
        const filename = path.join(root, 'pdf', ...paper.pdfFile.split('/'));
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filename, `%PDF-1.7\nofficial-${index}`, { mode: 0o600 });
    }
    const found = discovery.discoverConference({ adapter: 'official-proceedings', conferenceId, year: 2026,
        metadataFile, pdfRoot: path.join(root, 'pdf') });
    const catalogFile = path.join(root, 'catalogs', 'conference.json'); const reportFile = path.join(root, 'reports', 'conference.json');
    fs.writeFileSync(catalogFile, discovery.canonicalBytes(found.manifest), { mode: 0o600 });
    fs.writeFileSync(reportFile, discovery.canonicalBytes(found.report), { mode: 0o600 });
    const discoveryHandle = discovery.loadDiscoveryHandle(catalogFile, reportFile);
    return { root, filters: path.join(root, 'filters'), discoveryHandle, found,
        evidenceRoot: path.join(root, 'evidence'), evidenceHandle: attachEvidence(root, path.join(root, 'evidence'), discoveryHandle) };
}
function prepare(f) { return filter.prepareFilter({ filterRoot: f.filters, discoveryHandle: f.discoveryHandle,
    evidenceHandle: f.evidenceHandle, spec: spec(f), filterId: ids[0], now: stamp }); }
function artifactHandle(f, state, paperId, status, operationId, options = {}) {
    const artifact = filter.buildDecisionArtifact({ state, paperId, operationId,
        actor: { type: 'manual', id: 'reviewer.1' }, model: null, endpointProtocol: 'manual',
        requestBytes: `request for ${paperId}`, responseBytes: status === 'failed' ? null : `${status} evidence`,
        status, reason: `${status} fixture`, usage: {},
        now: options.now || stamp });
    const name = `${operationId}.json`;
    const filename = filter.writeDecisionArtifact({ filterRoot: f.filters, filterId: state.filterId, decisionName: name, artifact });
    return { handle: filter.loadDecisionHandle(filename), filename };
}
function apply(f, state, paperId, status, operationId, options = {}) {
    const decision = artifactHandle(f, state, paperId, status, operationId, options);
    return filter.applyDecision({ filterRoot: f.filters, filterId: state.filterId,
        decisionHandle: decision.handle, owner: 'worker', now: options.now || stamp });
}

test('production prepare requires authenticated discovery and closes over source identities', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    assert.deepEqual(Object.keys(state.decisions), papers); assert.equal(state.completion.pending, 2);
    assert.throws(() => filter.prepareFilter({ filterRoot: f.filters, discoveryHandle: structuredClone(f.discoveryHandle),
        spec: spec(f), filterId: ids[3] }), /authenticated discovery handle/);
    assert.throws(() => filter.prepareFilter({ filterRoot: f.filters, catalog: { members: [] }, spec: spec(f), filterId: ids[3] }),
        /authenticated discovery handle/);
});

test('prepare audits deterministic keyword rejection while short abstracts fail open to LLM', t => {
    const f = fixture([
        { arnumber: '100', title: 'Generic optimization', abstract: 'This paper studies a general convex optimization method with convergence bounds across several synthetic benchmarks and mathematical settings.' },
        { arnumber: '200', title: 'Generic optimization follow-up', abstract: '' }
    ]);
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    assert.equal(state.decisions[papers[0]].status, 'excluded');
    assert.equal(state.decisions[papers[1]].status, 'pending');
    assert.equal(state.completion.excluded, 1);
    const artifact = JSON.parse(fs.readFileSync(path.join(f.filters, ids[0], 'decisions', state.attempts[0].decisionArtifactName)));
    assert.equal(artifact.actor.type, 'keyword');
    assert.equal(artifact.actor.id, 'speech-audio-music-v4');
    assert.deepEqual(artifact.result.usage, { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const evaluation = JSON.parse(Buffer.from(artifact.response.data, 'base64').toString());
    const keywordInput = JSON.parse(Buffer.from(artifact.request.data, 'base64').toString());
    assert.equal(evaluation.failOpen, false);
    assert.equal(evaluation.conferenceCategoryFallback, false);
    assert.equal(evaluation.conferenceFallbackVersion, filter.CORE_CONFERENCE_FALLBACK_VERSION);
    assert.equal(keywordInput.evidence.status, 'ready');
    assert.equal(keywordInput.requestEnvelopeSha256.length, 64);
});

test('bulk keyword prepare authenticates source collections once and preserves the v5 CAS chain across checkpoints', t => {
    const records = Array.from({ length: 140 }, (_, index) => ({
        arnumber: String(1000 + index),
        title: `Generic optimization study ${index}`,
        abstract: `This paper studies a general convex optimization method ${index} with convergence bounds across several synthetic benchmarks and mathematical settings.`
    }));
    const f = fixture(records); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const calls = { discoveryBatch: 0, discoverySingle: 0, evidenceBatch: 0, evidenceSingle: 0 };
    const originals = {
        discoveryBatch: discovery.replayDiscoveryMembers,
        discoverySingle: discovery.replayDiscoveryMember,
        evidenceBatch: evidenceApi.evidenceHandleMemberSnapshots,
        evidenceSingle: evidenceApi.evidenceHandleSnapshot
    };
    discovery.replayDiscoveryMembers = (...args) => { calls.discoveryBatch += 1; return originals.discoveryBatch(...args); };
    discovery.replayDiscoveryMember = (...args) => { calls.discoverySingle += 1; return originals.discoverySingle(...args); };
    evidenceApi.evidenceHandleMemberSnapshots = (...args) => { calls.evidenceBatch += 1; return originals.evidenceBatch(...args); };
    evidenceApi.evidenceHandleSnapshot = (...args) => { calls.evidenceSingle += 1; return originals.evidenceSingle(...args); };
    t.after(() => {
        discovery.replayDiscoveryMembers = originals.discoveryBatch;
        discovery.replayDiscoveryMember = originals.discoverySingle;
        evidenceApi.evidenceHandleMemberSnapshots = originals.evidenceBatch;
        evidenceApi.evidenceHandleSnapshot = originals.evidenceSingle;
    });
    const state = prepare(f);
    assert.equal(state.completion.excluded, records.length);
    assert.equal(state.completion.pending, 0);
    assert.equal(state.attempts.length, records.length);
    assert.deepEqual(calls, { discoveryBatch: 2, discoverySingle: 0, evidenceBatch: 1, evidenceSingle: 2 });
    const replayed = filter.readFilter({ filterRoot: f.filters, filterId: ids[0] });
    assert.equal(replayed.stateSha256, state.stateSha256);
    assert.equal(replayed.attempts[127].nextStateSha256, replayed.attempts[128].priorStateSha256);
});

test('core audio conferences fail open while broad conferences retain deterministic rejection', () => {
    const examples = [
        { conferenceId: 'dafx-2026', title: 'Efficient Plate Reverberator Design' },
        { conferenceId: 'nime-2026', title: 'A Responsive Piano Interface' },
        { conferenceId: 'odyssey-2026', title: 'Robust Identity Embeddings' },
        { conferenceId: 'iwslt-2026', title: 'Simultaneous Translation with Adaptive Policies' }
    ];
    const abstract = 'We present a new system design with controlled experiments, quantitative comparisons, ablation studies, and reproducible evaluation protocols.';
    for (const example of examples) {
        const result = filter.evaluateConferenceKeywordPrefilter({ title: example.title, abstract }, example.conferenceId);
        assert.equal(result.pass, true, example.conferenceId);
        assert.equal(result.conferenceCategoryFallback, true, example.conferenceId);
        assert.equal(result.conferenceFallbackVersion, 'core-audio-conferences-2026-v1');
    }
    const broad = filter.evaluateConferenceKeywordPrefilter({ title: 'Generic Convex Optimization', abstract }, 'eusipco-2026');
    assert.equal(broad.pass, false);
    assert.equal(broad.conferenceCategoryFallback, false);
    assert.deepEqual(filter.CORE_AUDIO_CONFERENCE_IDS,
        ['dafx-2026', 'iwslt-2026', 'nime-2026', 'odyssey-2026']);
    assert.equal(filter.FILTER_CONFIG_BINDING.coreConferenceFallbackVersion,
        filter.CORE_CONFERENCE_FALLBACK_VERSION);
});

test('conference filtering uses the daily prompt block and daily structured decision parser', () => {
    assert.match(filter.LLM_FILTER_PROMPT, /语音、音频或音乐处理/);
    assert.equal(filter.LLM_FILTER_PROMPT, require('../scripts/utils.js').loadPrompt('prompts/filter.md', {
        title: '{title}', abstract: '{abstract}', categories: '{categories}'
    }));
    assert.deepEqual(filter.parseLlmDecisionText('理由：音频是核心输入。\n结论：相关'),
        { status: 'included', reason: '音频是核心输入。', parseSource: 'conclusion_line' });
});

test('production filter accepts authenticated official proceedings and preserves stable source identities', t => {
    const f = officialFixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const boundSpec = filter.normalizeSpec(spec(f));
    assert.equal(boundSpec.version, 5);
    assert.deepEqual(boundSpec.evidence.locator,
        evidenceApi.locatorBindingForConference({ id: 'aaai-2026', year: 2026 }));
    assert.equal(boundSpec.evidence.locator.profile, evidenceApi.AAAI_LOCATOR_PROFILE);
    const state = prepare(f);
    const expected = ['AAAI-2026.002', 'AAAI.2026-001_camera'].map(value => paperIdentity.canonicalConferencePaperId(
        { id: 'aaai-2026', year: 2026 }, { type: 'conference-paper-id', value })).sort();
    assert.deepEqual(Object.keys(state.decisions), expected);
    assert.equal(state.input.conferenceId, 'aaai-2026');
    assert.equal(state.completion.pending, 2);
    assert.deepEqual(f.found.manifest.members.map(member => member.match.kind), ['exact', 'exact']);
    const envelope = filter.requestEnvelope({ state, paperId: expected[0], discoveryHandle: f.discoveryHandle,
        evidenceHandle: f.evidenceHandle });
    assert.equal(envelope.discovery.adapter, 'official-proceedings');
    assert.equal(envelope.discovery.sourceIdentity, 'conference-paper-id:AAAI-2026.002');
});

test('keyword CAS digest canonicalizes CVPR mixed-case IDs independently of locale iteration order', t => {
    const genericAbstract = 'This paper studies a general visual optimization method with convergence bounds across several synthetic benchmarks and mathematical settings.';
    const papers = [
        { id: 'Bai_DRiffusion_Draft-and-Refine_Process_Parallelizes_Diffusion_Models_with_Ease_CVPR_2026_paper',
            title: 'Draft and refine visual optimization', authors: ['A. Author'], abstract: genericAbstract,
            pdfFile: 'papers/driffusion.pdf', recordUrl: 'https://example.org/cvpr/driffusion',
            pdfUrl: 'https://example.org/cvpr/driffusion.pdf', doi: null, track: 'Main' },
        { id: 'Bai_Demo2Tutorial_From_Human_Experience_to_Multimodal_Software_Tutorials_CVPR_2026_paper',
            title: 'Human experience for software tutorials', authors: ['B. Author'], abstract: genericAbstract,
            pdfFile: 'papers/demo2tutorial.pdf', recordUrl: 'https://example.org/cvpr/demo2tutorial',
            pdfUrl: 'https://example.org/cvpr/demo2tutorial.pdf', doi: null, track: 'Main' }
    ];
    const f = officialFixture({ conferenceId: 'cvpr-2026', papers });
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    const iterationOrder = Object.keys(state.decisions);
    assert.notDeepEqual(iterationOrder, [...iterationOrder].sort());
    assert.equal(state.completion.excluded, papers.length);
    assert.equal(state.attempts.length, papers.length);
    assert.equal(filter.readFilter({ filterRoot: f.filters, filterId: ids[0] }).stateSha256, state.stateSha256);
});

test('per-conference spec rejects legacy shared shape, unregistered locators, and another evidence run', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const bound = spec(f);
    assert.deepEqual(bound.evidence.locator,
        evidenceApi.locatorBindingForConference({ id: 'icassp-2026', year: 2026 }));
    assert.equal(Object.hasOwn(bound.evidence.locator, 'profile'), false);
    const production = filter.buildProductionSpec({ endpoint: 'https://example.test/v1',
        model: 'muse-spark-1.3-contributor', taxonomyRegistrySha256: h('taxonomy'),
        discoveryHandle: f.discoveryHandle, evidenceHandle: f.evidenceHandle });
    assert.equal(production.discovery.conferenceId, 'icassp-2026');
    assert.equal(production.discovery.catalogSha256, bound.discovery.catalogSha256);
    assert.deepEqual(production.evidence, bound.evidence);
    assert.throws(() => filter.normalizeSpec({ contract: 'conference-filter-spec-v4', version: 4,
        filterPolicySha256: h('policy'), promptSha256: h('prompt'), model: bound.model,
        endpointProtocol: bound.endpointProtocol, endpointIdentitySha256: h('endpoint'),
        taxonomyRegistrySha256: h('taxonomy'), evidenceCatalogContract: evidenceApi.CATALOG_CONTRACT,
        evidenceLocatorContract: evidenceApi.LOCATOR_CONTRACT,
        evidenceLocatorImplementationSha256: evidenceApi.LOCATOR_IMPLEMENTATION_SHA256 }), /contract\/version|unknown or missing/);
    const unregistered = structuredClone(bound);
    unregistered.evidence.locator.implementationSha256 = h('unregistered locator');
    assert.throws(() => filter.normalizeSpec(unregistered), /not a registered binding/);
    const otherRun = structuredClone(bound); otherRun.evidence.runId = ids[3];
    assert.throws(() => filter.prepareFilter({ filterRoot: f.filters, discoveryHandle: f.discoveryHandle,
        evidenceHandle: f.evidenceHandle, spec: otherRun, filterId: ids[3] }), /does not bind this authenticated/);
});

test('ready evidence becomes the prompt abstract and is cryptographically bound', t => {
    const abstract = 'This paper studies a generic convex optimization method with convergence bounds across several synthetic benchmarks and mathematical settings.';
    const f = fixture([{ arnumber: '100', title: 'Generic optimization', abstract }]);
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    const envelope = filter.requestEnvelope({ state, paperId: papers[0], discoveryHandle: f.discoveryHandle,
        evidenceHandle: f.evidenceHandle });
    assert.equal(envelope.evidence.status, 'ready');
    assert.equal(envelope.metadataRecord.abstract, abstract);
    assert.equal(envelope.evidence.evidenceSha256, h(abstract));
    assert.equal(envelope.evidence.catalogSha256, state.input.evidence.catalogSha256);
    assert.equal(state.decisions[papers[0]].status, 'excluded');
});

test('non-ready evidence preserves metadata but always fails open to LLM', t => {
    const f = fixture([{ arnumber: '100', title: 'Generic optimization', abstract: '' }]);
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    const envelope = filter.requestEnvelope({ state, paperId: papers[0], discoveryHandle: f.discoveryHandle,
        evidenceHandle: f.evidenceHandle });
    assert.equal(envelope.evidence.status, 'missing');
    assert.equal(envelope.metadataRecord.abstract, '');
    assert.equal(state.decisions[papers[0]].status, 'pending');
    const evaluation = filter.evaluateConferenceKeywordPrefilter(envelope.metadataRecord, 'eusipco-2026', 'missing');
    assert.equal(evaluation.pass, true);
    assert.equal(evaluation.evidenceFailOpen, true);
});

test('filter rejects unauthenticated and tampered evidence before preparing', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    assert.throws(() => filter.prepareFilter({ filterRoot: f.filters, discoveryHandle: f.discoveryHandle,
        evidenceHandle: structuredClone(f.evidenceHandle), spec: spec(f), filterId: ids[3] }), /authenticated evidence/);
    const catalog = evidenceApi.evidenceHandleSnapshot(f.evidenceHandle).catalog;
    const receipt = path.join(f.evidenceRoot, evidenceRunId, catalog.members[0].receiptPath);
    fs.appendFileSync(receipt, '\n');
    assert.throws(() => filter.prepareFilter({ filterRoot: f.filters, discoveryHandle: f.discoveryHandle,
        evidenceHandle: f.evidenceHandle, spec: spec(f), filterId: ids[3] }), /evidence|receipt|drift|JSON/);
});

test('daily prompt categories preserve conference, human domain label, and track', () => {
    const prompt = filter.renderDailyFilterPrompt({
        discovery: { conference: { id: 'dafx-2026', year: 2026 } },
        metadataRecord: { title: 'PolyADAA', abstract: 'A nonlinear audio circuit emulation method.', track: 'Audio Effects Modeling' }
    });
    assert.match(prompt, /dafx-2026/);
    assert.match(prompt, /Digital Audio Effects/);
    assert.match(prompt, /Audio Effects Modeling/);
    assert.equal(filter.CORE_AUDIO_CONFERENCE_LABELS['dafx-2026'], 'Digital Audio Effects');
    assert.deepEqual(filter.FILTER_CONFIG_BINDING.coreAudioConferenceLabels, filter.CORE_AUDIO_CONFERENCE_LABELS);
    assert.deepEqual(filter.evaluateConferenceKeywordPrefilter({ title: 'PolyADAA', abstract: 'x'.repeat(100),
        track: 'Audio Effects Modeling' }, 'dafx-2026').conferenceCategories,
    ['dafx-2026', 'Digital Audio Effects', 'Audio Effects Modeling']);
});

test('final decisions require preserved evidence and receipt contains included identities only', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = prepare(f);
    state = apply(f, state, papers[0], 'included', ids[1]);
    state = apply(f, state, papers[1], 'excluded', ids[2], { actor: 'manual', now: '2026-09-06T00:01:00.000Z' });
    const receipt = filter.readSelectionReceipt({ filterRoot: f.filters, filterId: ids[0] });
    assert.deepEqual(receipt.included.map(item => item.paperId), [papers[0]]);
    assert.equal(receipt.included[0].sourceSha256, state.decisions[papers[0]].sourceSha256);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(papers[1]));
    const selectionHandle = filter.loadSelectionHandle(f.filters, ids[0], f.discoveryHandle);
    assert.deepEqual(filter.selectionHandleSnapshot(selectionHandle).included, [{ paperId: papers[0],
        sourceIdentity: 'icassp-arnumber:100', sourceSha256: state.decisions[papers[0]].sourceSha256,
        decisionArtifactSha256: state.attempts[0].decisionArtifactSha256 }]);
    assert.throws(() => filter.selectionHandleSnapshot(structuredClone(selectionHandle)), /authenticated filter selection handle/);
    assert.throws(() => filter.writeDecisionArtifact({ filterRoot: f.filters, filterId: ids[0],
        decisionName: `${ids[1]}.json`, artifact: {} }), /artifact|exclusively/);
});

test('idempotent final-decision retry heals a selection receipt write interrupted after complete state', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = prepare(f);
    state = apply(f, state, papers[0], 'included', ids[1]);
    const finalDecision = artifactHandle(f, state, papers[1], 'excluded', ids[2], { actor: 'manual' });
    const originalOpen = fs.openSync; const originalWrite = fs.writeFileSync;
    let receiptFd;
    let interrupted = false;
    fs.openSync = function trackReceiptOpen(target, ...args) {
        const fd = originalOpen.call(this, target, ...args);
        if (String(target).endsWith('/selection-receipt.json')) receiptFd = fd;
        return fd;
    };
    fs.writeFileSync = function interruptedReceiptWrite(target, ...args) {
        if (!interrupted && target === receiptFd) {
            interrupted = true;
            const error = new Error('fixture interrupted receipt write'); error.code = 'EIO'; throw error;
        }
        return originalWrite.call(this, target, ...args);
    };
    try {
        assert.throws(() => filter.applyDecision({ filterRoot: f.filters, filterId: ids[0],
            decisionHandle: finalDecision.handle, owner: 'worker', now: stamp }), /interrupted receipt write/);
    } finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; }
    assert.equal(filter.readFilter({ filterRoot: f.filters, filterId: ids[0] }).completion.status, 'complete');
    assert.equal(fs.existsSync(path.join(f.filters, ids[0], 'selection-receipt.json')), false);
    const healed = filter.applyDecision({ filterRoot: f.filters, filterId: ids[0],
        decisionHandle: finalDecision.handle, owner: 'worker', now: stamp });
    assert.equal(healed.completion.status, 'complete');
    assert.equal(filter.readSelectionReceipt({ filterRoot: f.filters, filterId: ids[0] }).filterId, ids[0]);
});

test('handwritten LLM actors and forged handles fail closed', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    assert.throws(() => filter.applyDecision({ filterRoot: f.filters, filterId: ids[0], decisionHandle: {}, owner: 'worker' }), /authenticated decision/);
    assert.throws(() => filter.buildDecisionArtifact({ state, paperId: papers[0], operationId: ids[1], actor: { type: 'llm', id: 'worker' },
        model: spec(f).model, endpointProtocol: spec(f).endpointProtocol, requestBytes: 'request', responseBytes: 'response',
        status: 'included', reason: 'yes', usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    /authenticated conference filter runner/);
    const manual = filter.buildDecisionArtifact({ state, paperId: papers[0], operationId: ids[1],
        actor: { type: 'manual', id: 'reviewer' }, model: null, endpointProtocol: 'manual', requestBytes: 'request',
        responseBytes: 'response', status: 'included', reason: 'yes', usage: {}, now: stamp });
    const forged = { ...manual, actor: { type: 'llm', id: 'forged' }, model: spec(f).model,
        endpointProtocol: spec(f).endpointProtocol,
        result: { ...manual.result, usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 } } };
    const body = { ...forged }; delete body.artifactSha256; forged.artifactSha256 = filter.stableHash(body);
    assert.throws(() => filter.writeDecisionArtifact({ filterRoot: f.filters, filterId: ids[0],
        decisionName: 'forged-llm.json', artifact: forged }), /endpointIdentity|requestEnvelope|transportReceipt/);
    assert.equal(filter.adaptDiscoveryCatalog, undefined); assert.equal(filter.discoveryDocumentToFilterCatalog, undefined);
});

test('decision bytes are replayed and drift fails closed', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = prepare(f); const decision = artifactHandle(f, state, papers[0], 'included', ids[1]);
    state = filter.applyDecision({ filterRoot: f.filters, filterId: ids[0], decisionHandle: decision.handle, owner: 'worker', now: stamp });
    const changed = JSON.parse(fs.readFileSync(decision.filename, 'utf8')); changed.response.data = Buffer.from('tampered').toString('base64');
    fs.writeFileSync(decision.filename, `${JSON.stringify(changed, null, 2)}\n`);
    assert.throws(() => filter.readFilter({ filterRoot: f.filters, filterId: ids[0] }), /SHA drifted|artifact replay drifted|size\/base64/);
});

test('failed remains retryable, cumulative usage monotonic, final cannot change', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = prepare(f); state = apply(f, state, papers[0], 'failed', ids[1]);
    assert.equal(state.completion.failed, 1); assert.equal(state.completion.excluded, 0);
    state = apply(f, state, papers[0], 'included', ids[2], { now: '2026-09-06T00:01:00.000Z' });
    assert.throws(() => apply(f, state, papers[0], 'excluded', ids[3]), /final decision cannot be changed/);
});

test('manual decision cannot impersonate a model or protocol', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    assert.throws(() => filter.buildDecisionArtifact({ state, paperId: papers[0], operationId: ids[1],
        actor: { type: 'manual', id: 'reviewer' }, model: 'fixture-model', endpointProtocol: 'openai-responses',
        requestBytes: 'request', responseBytes: 'response', status: 'included', reason: 'yes', usage: {} }),
    /manual decision must use/);
});

test('operation idempotency is bound to the exact preserved decision artifact', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    const first = artifactHandle(f, state, papers[0], 'included', ids[1]);
    const different = filter.buildDecisionArtifact({ state, paperId: papers[0], operationId: ids[1],
        actor: { type: 'manual', id: 'reviewer' }, model: null, endpointProtocol: 'manual',
        requestBytes: 'different request bytes', responseBytes: 'included evidence', status: 'included', reason: 'included fixture',
        usage: {}, now: stamp });
    const secondFile = filter.writeDecisionArtifact({ filterRoot: f.filters, filterId: ids[0], decisionName: 'different.json', artifact: different });
    const applied = filter.applyDecision({ filterRoot: f.filters, filterId: ids[0], decisionHandle: first.handle, owner: 'worker', now: stamp });
    assert.equal(filter.applyDecision({ filterRoot: f.filters, filterId: ids[0], decisionHandle: first.handle, owner: 'worker', now: stamp }).attempts.length, 1);
    assert.throws(() => filter.applyDecision({ filterRoot: f.filters, filterId: ids[0],
        decisionHandle: filter.loadDecisionHandle(secondFile), owner: 'worker', now: stamp }), /different decision evidence/);
    assert.equal(applied.attempts.length, 1);
});

test('CLI requires catalog+report+spec and decision artifacts, not raw patches', () => {
    assert.deepEqual(cli.parseArgs(['spec', '--catalog', 'icassp.json', '--report', 'icassp-report.json',
        '--evidence-run', evidenceRunId, '--output', 'icassp-filter-v5.json']),
    { command: 'spec', catalogName: 'icassp.json', reportName: 'icassp-report.json', evidenceRunId,
        specName: 'icassp-filter-v5.json' });
    assert.throws(() => cli.parseArgs(['spec', '--output', 'shared-filter.json']), /catalog/);
    assert.deepEqual(cli.parseArgs(['prepare', '--catalog', 'icassp.json', '--report', 'icassp-report.json',
        '--evidence-run', evidenceRunId, '--spec', 'filter.json', '--filter', ids[0]]),
    { command: 'prepare', catalogName: 'icassp.json', reportName: 'icassp-report.json', evidenceRunId,
        specName: 'filter.json', filterId: ids[0] });
    assert.deepEqual(cli.parseArgs(['apply', '--filter', ids[0], '--decision', 'one.json', '--owner', 'worker.1']),
        { command: 'apply', filterId: ids[0], decisionName: 'one.json', owner: 'worker.1' });
    for (const args of [['prepare', '--catalog', 'x.json', '--spec', 'x.json'],
        ['apply', '--filter', ids[0], '--patch', 'one.json', '--owner', 'worker.1']]) assert.throws(() => cli.parseArgs(args));
});

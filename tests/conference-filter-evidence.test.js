'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const discovery = require('../scripts/lib/conference-discovery.js');
const api = require('../scripts/lib/conference-filter-evidence.js');
const cli = require('../scripts/conference-filter-evidence.js');
const envLoader = require('../scripts/env-loader.js');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fixtureRoot = path.join(__dirname, 'fixtures', 'conference-filter-evidence');
function fixture(name) { return fs.readFileSync(path.join(fixtureRoot, name)); }
function artifactFor(bytes) { return { pages: [{ page: 1, textStart: 0, textEnd: bytes.length }] }; }

function workspace(papers = [{ id: 'paper-1', title: 'One paper' }]) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conference-filter-evidence-')));
    const source = path.join(root, 'source'); const catalogs = path.join(root, 'catalogs');
    const reports = path.join(root, 'reports'); const runs = path.join(root, 'runs');
    for (const directory of [source, catalogs, reports]) fs.mkdirSync(directory, { mode: 0o700 });
    const pdfDir = path.join(source, 'pdfs'); fs.mkdirSync(pdfDir);
    const records = papers.map((paper, index) => {
        const pdfFile = `pdfs/paper-${index + 1}.pdf`;
        fs.writeFileSync(path.join(source, pdfFile), `%PDF-1.4\nfixture-${index}\n`, { mode: 0o600 });
        return { id: paper.id, title: paper.title, authors: ['A. Author'], abstract: '', pdfFile,
            recordUrl: `https://example.org/paper/${index + 1}`, pdfUrl: `https://example.org/paper/${index + 1}.pdf`,
            doi: null, track: null };
    });
    const metadata = path.join(source, 'metadata.json');
    fs.writeFileSync(metadata, `${JSON.stringify({ conference: { id: 'fixture-2026', year: 2026 }, papers: records })}\n`, { mode: 0o600 });
    const found = discovery.discoverConference({ adapter: 'official-proceedings', conferenceId: 'fixture-2026',
        year: 2026, metadataFile: metadata, pdfRoot: source });
    const catalogFile = path.join(catalogs, 'fixture.json'); const reportFile = path.join(reports, 'fixture-report.json');
    fs.writeFileSync(catalogFile, discovery.canonicalBytes(found.manifest), { mode: 0o600 });
    fs.writeFileSync(reportFile, discovery.canonicalBytes(found.report), { mode: 0o600 });
    return { root, runs, handle: discovery.loadDiscoveryHandle(catalogFile, reportFile) };
}
function extractorWith(textBytes) {
    return (itemRoot, { request }) => {
        const artifactBytes = Buffer.from(`${JSON.stringify(artifactFor(textBytes), null, 2)}\n`);
        const receiptBytes = Buffer.from('{"fixture":true}\n');
        fs.writeFileSync(path.join(itemRoot, 'text.txt'), textBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(itemRoot, 'artifacts.json'), artifactBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(itemRoot, 'extraction-receipt.json'), receiptBytes, { mode: 0o600 });
        return { paperId: request.paperId, sourceIdentity: request.sourceIdentity,
            pdf: { sha256: request.source.pdf.sha256 }, text: { file: 'text.txt', sha256: sha256(textBytes) },
            artifacts: { file: 'artifacts.json', sha256: sha256(artifactBytes) },
            receipt: { file: 'extraction-receipt.json', fileSha256: sha256(receiptBytes), receiptSha256: 'a'.repeat(64) },
            verification: { verificationSha256: 'b'.repeat(64) } };
    };
}

test('provider fixtures yield exact ready spans and ambiguity fails open', () => {
    for (const name of ['acl.txt', 'cvpr.txt', 'pmlr.txt']) {
        const bytes = fixture(name); const result = api.locateAbstract(bytes, artifactFor(bytes));
        assert.equal(result.status, 'ready', name);
        assert.equal(bytes.subarray(result.textStart, result.textEnd).toString('utf8'), result.text, name);
        assert.equal(sha256(bytes.subarray(result.textStart, result.textEnd)), result.sha256, name);
    }
    const ambiguous = fixture('ambiguous.txt');
    assert.equal(api.locateAbstract(ambiguous, artifactFor(ambiguous)).status, 'ambiguous');
    assert.equal(api.locateAbstract(fixture('aaai-bare-introduction.txt'),
        artifactFor(fixture('aaai-bare-introduction.txt'))).status, 'missing');
    assert.equal(api.locateAbstract(fixture('aaai-bare-introduction.txt'),
        artifactFor(fixture('aaai-bare-introduction.txt')), api.AAAI_LOCATOR_PROFILE).status, 'ready');
    assert.equal(api.locateAbstract(fixture('aaai-introduction-substring.txt'),
        artifactFor(fixture('aaai-introduction-substring.txt')), api.AAAI_LOCATOR_PROFILE).status, 'missing');
    assert.equal(api.locateAbstract(fixture('aaai-duplicate-introduction.txt'),
        artifactFor(fixture('aaai-duplicate-introduction.txt')), api.AAAI_LOCATOR_PROFILE).status, 'ambiguous');
});

test('locator profiles preserve the default hash and scope the AAAI grammar', () => {
    assert.equal(api.LOCATOR_IMPLEMENTATION_SHA256,
        'aea85b736cfbfc8a5758df6451a231b49a5d1e534a0015ea22952ef570c1d08c');
    assert.deepEqual(api.locatorBindingForConference({ id: 'iwslt-2026', year: 2026 }), {
        contract: api.LOCATOR_CONTRACT, implementationSha256: api.LOCATOR_IMPLEMENTATION_SHA256 });
    const aaai = api.locatorBindingForConference({ id: 'aaai-2026', year: 2026 });
    assert.equal(aaai.profile, api.AAAI_LOCATOR_PROFILE);
    assert.notEqual(aaai.implementationSha256, api.LOCATOR_IMPLEMENTATION_SHA256);
    const site = workspace(); const snapshot = discovery.discoveryHandleSnapshot(site.handle);
    const defaultState = api.initialState(snapshot, '99999999-9999-4999-8999-999999999999');
    assert.doesNotThrow(() => api.normalizeState(defaultState, snapshot, defaultState.binding.runId));
    const aaaiSnapshot = structuredClone(snapshot);
    aaaiSnapshot.candidateManifest.conference = { id: 'aaai-2026', year: 2026 };
    const aaaiState = api.initialState(aaaiSnapshot, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.deepEqual(aaaiState.locator, aaai);
    const legacy = structuredClone(aaaiState);
    legacy.locator = api.locatorBindingForConference({ id: 'iwslt-2026', year: 2026 });
    delete legacy.stateSha256; legacy.stateSha256 = api.stableHash(legacy);
    assert.throws(() => api.normalizeState(legacy, aaaiSnapshot, legacy.binding.runId), /run locator/);
});

test('authenticated discovery stages resumable evidence and signs catalog only when complete', () => {
    const site = workspace([{ id: 'paper-1', title: 'One' }, { id: 'paper-2', title: 'Two' }]);
    const runId = '11111111-1111-4111-8111-111111111111';
    const first = api.prepareEvidence({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle,
        apply: true, limit: 1, extract: extractorWith(fixture('acl.txt')) });
    assert.equal(first.status, 'pending'); assert.equal(first.counts.ready, 1); assert.equal(first.counts.pending, 1);
    assert.equal(fs.existsSync(path.join(site.runs, runId, 'evidence-catalog.json')), false);
    const second = api.prepareEvidence({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle,
        apply: true, limit: 1, extract: extractorWith(fixture('pmlr.txt')) });
    assert.equal(second.status, 'complete'); assert.equal(second.counts.ready, 2);
    assert.equal(fs.statSync(path.join(site.runs, runId, 'evidence-catalog.json')).mode & 0o777, 0o600);
    assert.equal(api.inspectEvidence({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle }).verified, 2);
    const handle = api.loadEvidenceHandle({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle });
    const state = JSON.parse(fs.readFileSync(path.join(site.runs, runId, 'state.json')));
    const paper = api.evidenceHandleSnapshot(handle, state.members[0].paperId);
    assert.equal(paper.receipt.evidence.status, 'ready');
    assert.equal(paper.member.receiptSha256, paper.receipt.receiptSha256);
    assert.throws(() => api.evidenceHandleSnapshot({}, paper.member.paperId), /authenticated evidence handle/);
});

test('status is read-only and fails closed when a final artifact is missing', () => {
    const site = workspace(); const runId = '66666666-6666-4666-8666-666666666666';
    api.prepareEvidence({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle,
        apply: true, extract: extractorWith(fixture('acl.txt')) });
    const reportFile = path.join(site.runs, runId, 'evidence-report.json');
    fs.unlinkSync(reportFile);
    assert.throws(() => api.inspectEvidence({ evidenceRunsRoot: site.runs, runId,
        discoveryHandle: site.handle }), /is missing/);
    assert.equal(fs.existsSync(reportFile), false);
});

test('resume fails closed after extracted text tampering', () => {
    const site = workspace(); const runId = '22222222-2222-4222-8222-222222222222';
    api.prepareEvidence({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle,
        apply: true, extract: extractorWith(fixture('cvpr.txt')) });
    const state = JSON.parse(fs.readFileSync(path.join(site.runs, runId, 'state.json')));
    fs.appendFileSync(path.join(site.runs, runId, 'items', state.members[0].itemName, 'text.txt'), 'tamper');
    assert.throws(() => api.inspectEvidence({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle }), /tampered/);
});

test('a complete receipt left ahead of state is adopted on resume', () => {
    const site = workspace([{ id: 'paper-1', title: 'One' }, { id: 'paper-2', title: 'Two' }]);
    const runId = '44444444-4444-4444-8444-444444444444';
    api.prepareEvidence({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle,
        apply: true, limit: 1, extract: extractorWith(fixture('acl.txt')) });
    const stateFile = path.join(site.runs, runId, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile));
    const completed = state.members.find(member => member.status === 'ready');
    Object.assign(completed, { status: 'pending', receiptFileSha256: null, receiptSha256: null, evidenceSha256: null });
    delete state.stateSha256; state.stateSha256 = api.stableHash(state);
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    const resumed = api.prepareEvidence({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle,
        apply: true, limit: 1, extract: () => { throw new Error('must recover without extracting'); } });
    assert.equal(resumed.counts.ready, 1); assert.equal(resumed.counts.pending, 1);
});

test('exact three-input interruption prefixes resume for the four observed providers', async t => {
    const providers = ['aistats-2026', 'eacl-2026', 'cvpr-2026', 'acl-2026'];
    for (const [index, provider] of providers.entries()) {
        await t.test(provider, () => {
            const site = workspace();
            const runId = `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`;
            assert.throws(() => api.prepareEvidence({ evidenceRunsRoot: site.runs, runId,
                discoveryHandle: site.handle, apply: true, extract: () => { throw new Error('simulated interrupt'); } }),
            /simulated interrupt/);
            const state = JSON.parse(fs.readFileSync(path.join(site.runs, runId, 'state.json')));
            const itemRoot = path.join(site.runs, runId, 'items', state.members[0].itemName);
            assert.deepEqual(fs.readdirSync(itemRoot).sort(), ['metadata.json', 'paper.pdf', 'request.json']);
            const resumed = api.prepareEvidence({ evidenceRunsRoot: site.runs, runId,
                discoveryHandle: site.handle, apply: true, extract: extractorWith(fixture('acl.txt')) });
            assert.equal(resumed.status, 'complete');
            assert.equal(resumed.counts.ready, 1);
        });
    }
});

test('interrupted output subsets and extra files remain operator-review failures', () => {
    for (const extraName of ['text.txt', 'unexpected.tmp']) {
        const site = workspace();
        const runId = extraName === 'text.txt' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
            : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        assert.throws(() => api.prepareEvidence({ evidenceRunsRoot: site.runs, runId,
            discoveryHandle: site.handle, apply: true, extract: () => { throw new Error('simulated interrupt'); } }));
        const state = JSON.parse(fs.readFileSync(path.join(site.runs, runId, 'state.json')));
        const itemRoot = path.join(site.runs, runId, 'items', state.members[0].itemName);
        fs.writeFileSync(path.join(itemRoot, extraName), 'partial', { mode: 0o600 });
        assert.throws(() => api.prepareEvidence({ evidenceRunsRoot: site.runs, runId,
            discoveryHandle: site.handle, apply: true, extract: () => { throw new Error('must not run'); } }),
        /operator review/);
    }
});

test('plan is zero-write, CLI is bounded, and daily role mapping is explicit', () => {
    const site = workspace(); const runId = '33333333-3333-4333-8333-333333333333';
    const plan = api.prepareEvidence({ evidenceRunsRoot: site.runs, runId, discoveryHandle: site.handle,
        apply: false, limit: 1 });
    assert.equal(plan.status, 'dry-run'); assert.equal(fs.existsSync(site.runs), false);
    assert.throws(() => cli.parseArgs(['apply', '--catalog', 'a.json', '--report', 'b.json', '--run', runId, '--limit', '501']), /1\.\.500/);
    assert.throws(() => cli.parseArgs(['apply', '--catalog', 'a.json', '--report', 'b.json', '--run', runId,
        '--all', '--limit', '2', '--expected-total', '2']), /cannot be combined/);
    assert.throws(() => cli.parseArgs(['apply', '--catalog', 'a.json', '--report', 'b.json', '--run', runId,
        '--expected-total', '1']), /requires --all/);
    assert.equal(cli.parseArgs(['apply', '--catalog', 'a.json', '--report', 'b.json', '--run', runId,
        '--all', '--expected-total', '1']).expectedTotal, 1);
    const oldMode = process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
    const oldRole = process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE;
    try {
        process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE = '1';
        process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE = 'daily';
        assert.equal(envLoader.requiredWorkspaceRoleForCommand('conference-filter-evidence.js'), 'daily');
    } finally {
        if (oldMode === undefined) delete process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE; else process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE = oldMode;
        if (oldRole === undefined) delete process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE; else process.env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE = oldRole;
    }
});

test('explicit all mode requires the authenticated total and completes in one invocation', () => {
    const site = workspace([{ id: 'paper-1', title: 'One' }, { id: 'paper-2', title: 'Two' },
        { id: 'paper-3', title: 'Three' }]);
    const mismatchRun = '77777777-7777-4777-8777-777777777777';
    assert.throws(() => api.prepareEvidence({ evidenceRunsRoot: site.runs, runId: mismatchRun,
        discoveryHandle: site.handle, apply: true, all: true, expectedTotal: 2,
        extract: extractorWith(fixture('acl.txt')) }), /authenticated discovery total 3/);
    assert.equal(fs.existsSync(site.runs), false);
    const runId = '88888888-8888-4888-8888-888888888888';
    const result = api.prepareEvidence({ evidenceRunsRoot: site.runs, runId,
        discoveryHandle: site.handle, apply: true, all: true, expectedTotal: 3,
        extract: extractorWith(fixture('acl.txt')) });
    assert.equal(result.status, 'complete');
    assert.equal(result.processed, 3);
    assert.equal(result.counts.ready, 3);
    assert.equal(result.counts.pending, 0);
});

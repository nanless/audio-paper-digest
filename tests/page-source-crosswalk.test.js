'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/page-source-crosswalk.js');
const cli = require('../scripts/page-source-crosswalk.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const stamp = '2026-09-06T00:00:00.000Z';

function eio(stage) {
    const error = new Error(`${stage} injected EIO`); error.code = 'EIO'; return error;
}
function writeOperationLock(directory, { pid = 99999999, startedAt = '2000-01-01T00:00:00.000Z',
    heartbeatAt = startedAt, token = ids[9], extra = false } = {}) {
    const lock = path.join(directory, 'operation.lock'); fs.mkdirSync(lock, { mode: 0o700 });
    const body = { contract: api.LOCK_OWNER_CONTRACT, version: 1, owner: 'fixture.owner', pid,
        hostname: os.hostname(), token, startedAt, heartbeatAt, leaseMs: api.LOCK_STALE_MS };
    const owner = { ...body, ownerSha256: api.stableHash(body) };
    const ownerFile = path.join(lock, 'owner.json'); fs.writeFileSync(ownerFile, api.prettyBytes(owner), { mode: 0o600 });
    if (extra) fs.writeFileSync(path.join(lock, 'unexpected'), 'x');
    if (startedAt.startsWith('2000-')) {
        const old = new Date('2000-01-01T00:00:00.000Z'); fs.utimesSync(ownerFile, old, old); fs.utimesSync(lock, old, old);
    }
    return { lock, ownerFile, owner };
}

function rehashPage(page) {
    const snapshotBody = structuredClone(page);
    delete snapshotBody.outboundPostLinks; delete snapshotBody.snapshotSha256; delete snapshotBody.recordSha256;
    page.snapshotSha256 = api.stableHash(snapshotBody);
    const recordBody = structuredClone(page); delete recordBody.recordSha256;
    page.recordSha256 = api.stableHash(recordBody);
}
function rehashLedger(ledger) {
    ledger.pageSetSha256 = api.stableHash(ledger.pages);
    const body = structuredClone(ledger); delete body.ledgerSha256;
    ledger.ledgerSha256 = api.stableHash(body);
}

function record(pathname, kind, content) {
    const markerValues = kind === 'paper' ? { paper_digest_page_type: 'paper', paper_digest_pipeline_owned: true } : {};
    const primaryUrl = `https://example.test/blog/posts/${path.basename(pathname, '.md')}/`;
    const pageId = `page:${api.stableHash({ contract: 'historical-page-id-v1', path: pathname, primaryUrl })}`;
    const body = { pageId, path: pathname, gitBlobOid: sha(`blob:${pathname}`).slice(0, 40),
        contentBytes: content.length + 10, contentSha256: sha(content),
        frontmatterBytes: 10, frontmatterSha256: sha(`frontmatter:${pathname}`),
        bodyBytes: content.length, bodySha256: sha(`body:${pathname}`),
        primaryUrl, aliases: [], kind,
        scope: { type: 'daily', key: '2026-01-01' }, legacy: { tags: ['语音识别'], categories: ['论文速递'],
            marker: { pipelineOwned: kind === 'paper' ? true : null, declaredPageType: kind === 'paper' ? 'paper' : null,
                fieldNames: Object.keys(markerValues).sort(), fieldsSha256: api.stableHash(markerValues) } },
        publishedDate: '2026-01-01', cohortDate: '2026-01-01', legacyTaskKey: null,
        draft: false, published: true,
        identityHints: { status: kind === 'paper' ? 'single' : 'none', candidates: kind === 'paper'
            ? [{ scheme: 'arxiv', value: '2601.00001', sources: ['filename'] }] : [] },
        outboundPostLinks: [], publicationEvidenceRefs: kind === 'paper' ? [
            { field: 'paper_digest_api_reader_contract', valueType: 'string', value: null,
                valueSha256: api.stableHash('beginner-researcher-v3') },
            { field: 'paper_digest_arxiv_id', valueType: 'string', value: '2601.00001',
                valueSha256: api.stableHash('2601.00001') },
            { field: 'paper_digest_page_type', valueType: 'string', value: 'paper',
                valueSha256: api.stableHash('paper') }
        ] : [], legacyTaxonomyCandidates: [
            { taxonomy: 'tags', term: '语音识别', status: 'unverified',
                candidateUrl: 'https://example.test/blog/tags/%E8%AF%AD%E9%9F%B3%E8%AF%86%E5%88%AB/', method: 'legacy-term-normalization-v1' },
            { taxonomy: 'categories', term: '论文速递', status: 'unverified',
                candidateUrl: 'https://example.test/blog/categories/%E8%AE%BA%E6%96%87%E9%80%9F%E9%80%92/', method: 'legacy-term-normalization-v1' }
        ] };
    const snapshotBody = structuredClone(body); delete snapshotBody.outboundPostLinks;
    const withSnapshot = { ...body, snapshotSha256: api.stableHash(snapshotBody) };
    return { ...withSnapshot, recordSha256: api.stableHash(withSnapshot) };
}
function historicalBundle(root) {
    const inventory = path.join(root, 'inventory'); fs.mkdirSync(inventory);
    const pages = [record('content/posts/2026-01-01-paper-2601-00001.md', 'paper', 'SECRET OLD BODY'),
        record('content/posts/2026-01-01.md', 'daily-summary', 'summary')].sort((a, b) => a.path.localeCompare(b.path));
    const paper = pages.find(page => page.kind === 'paper'); const summary = pages.find(page => page.kind === 'daily-summary');
    paper.outboundPostLinks = [{ ordinal: 1, linkType: 'markdown-inline', sourceByteStart: 0, sourceByteEnd: 4,
        targetRawSha256: sha('/blog/posts/2026-01-01/'), targetUrl: summary.primaryUrl, status: 'resolved',
        targetPath: summary.path, targetPageId: summary.pageId, targetRecordSha256: summary.snapshotSha256 }];
    const paperBody = structuredClone(paper); delete paperBody.recordSha256;
    paper.recordSha256 = api.stableHash(paperBody);
    const trackedPages = pages.map(page => ({ path: page.path, blobOid: page.gitBlobOid }));
    const hugoPages = pages.map(page => ({ path: page.path, permalink: page.primaryUrl }));
    const source = { branch: 'main', head: 'a'.repeat(40), clean: true, statusSha256: sha(''), remoteName: 'origin',
        remoteIdentitySha256: sha('remote'), baseUrl: 'https://example.test/blog/',
        remoteMain: { availability: 'unavailable', oid: null, ref: 'refs/remotes/origin/main' },
        hugoConfig: { path: 'hugo.yaml', sha256: sha('config') }, contentRoot: 'content/posts',
        hugoRuntime: { version: 'hugo v0.fixture', pageSetSha256: api.stableHash(hugoPages),
            publishedPageSetSha256: api.stableHash(hugoPages), pageCount: hugoPages.length,
            publishedPageCount: hugoPages.length },
        gitObjectFormat: 'sha1', contentTreeOid: 'b'.repeat(40),
        trackedPages: { count: trackedPages.length, setSha256: api.stableHash(trackedPages) } };
    const policy = { contract: 'historical-page-scan-policy-v3', bodyRetention: 'sha256-only',
        identityHints: 'frontmatter-filename-explicit-links-v1', outboundLinks: 'strict-balanced-inline-occurrences-v3',
        linkOffsetUnit: 'utf8-byte-body-relative',
        taxonomyRoutes: 'unverified-candidates-v2', publicationEvidence: 'schema-checked-hash-default-whitelist-v3',
        targetRecordBinding: 'target-page-snapshot-sha256-v1' };
    const outboundPostLinks = pages.flatMap(page => page.outboundPostLinks.map(link => (
        { sourcePageId: page.pageId, sourcePath: page.path, ...link }
    )));
    const counts = { pages: 2, papers: 1, dailySummaries: 1, conferenceSummaries: 0, conferenceTasks: 0,
        unknown: 0, urlCollisions: 0, outboundPostLinks: 1, resolvedOutboundPostLinks: 1,
        unresolvedOutboundPostLinks: 0, ambiguousOutboundPostLinks: 0 };
    const ledgerBody = { contract: api.LEDGER_CONTRACT, version: 1, source, policy, pages, urlCollisions: [],
        outboundPostLinks, outboundPostLinksSha256: api.stableHash(outboundPostLinks), counts,
        pageSetSha256: api.stableHash(pages) };
    const ledger = { ...ledgerBody, ledgerSha256: api.stableHash(ledgerBody) };
    const ledgerBytes = api.prettyBytes(ledger); const ledgerName = 'history.json';
    const receiptBody = { contract: api.LEDGER_RECEIPT_CONTRACT, version: 1, ledger: { name: ledgerName,
        fileSha256: sha(ledgerBytes), ledgerSha256: ledger.ledgerSha256, pageSetSha256: ledger.pageSetSha256,
        pageCount: pages.length }, repositorySnapshotSha256: api.stableHash(source) };
    const receipt = { ...receiptBody, receiptSha256: api.stableHash(receiptBody) };
    fs.writeFileSync(path.join(inventory, ledgerName), ledgerBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(inventory, 'history.receipt.json'), api.prettyBytes(receipt), { mode: 0o600 });
    return { inventory, ledger, receipt, ledgerName, receiptName: 'history.receipt.json' };
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'page-source-crosswalk-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, crosswalk: path.join(root, 'crosswalk'), ...historicalBundle(root) };
}
function load(f) {
    return api.loadHistoricalInventoryHandle({ inventoryRoot: f.inventory, ledgerName: f.ledgerName, receiptName: f.receiptName });
}

test('opaque inventory loader replays canonical ledger/receipt and rejects forged handles or byte drift', t => {
    const f = fixture(t); const handle = load(f); const snapshot = api.inventoryHandleSnapshot(handle);
    assert.equal(snapshot.ledger.pages.length, 2); assert.equal(snapshot.receipt.ledger.name, f.ledgerName);
    const paper = snapshot.ledger.pages.find(page => page.kind === 'paper');
    assert.equal(paper.outboundPostLinks[0].status, 'resolved');
    assert.equal(paper.outboundPostLinks[0].targetPageId,
        snapshot.ledger.pages.find(page => page.kind === 'daily-summary').pageId);
    assert.throws(() => api.inventoryHandleSnapshot({}), /authenticated historical inventory handle/);
    fs.appendFileSync(path.join(f.inventory, f.ledgerName), ' ');
    assert.throws(() => load(f), /canonical|exact ledger|self-SHA/);
    fs.writeFileSync(path.join(f.inventory, f.ledgerName), api.prettyBytes(f.ledger), { mode: 0o600 });
    const changed = structuredClone(f.receipt); changed.repositorySnapshotSha256 = sha('changed');
    fs.writeFileSync(path.join(f.inventory, f.receiptName), api.prettyBytes(changed), { mode: 0o600 });
    assert.throws(() => load(f), /repository snapshot|self-SHA/);

    const injected = structuredClone(f.ledger); injected.pages[0].legacy.body = 'SECRET OLD BODY';
    const { recordSha256: _record, ...pageBody } = injected.pages[0];
    injected.pages[0].recordSha256 = api.stableHash(pageBody); injected.pageSetSha256 = api.stableHash(injected.pages);
    const { ledgerSha256: _ledger, ...ledgerBody } = injected; injected.ledgerSha256 = api.stableHash(ledgerBody);
    const injectedBytes = api.prettyBytes(injected);
    const receiptBody = { contract: api.LEDGER_RECEIPT_CONTRACT, version: 1, ledger: { name: 'injected.json',
        fileSha256: sha(injectedBytes), ledgerSha256: injected.ledgerSha256, pageSetSha256: injected.pageSetSha256,
        pageCount: injected.pages.length }, repositorySnapshotSha256: api.stableHash(injected.source) };
    fs.writeFileSync(path.join(f.inventory, 'injected.json'), injectedBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(f.inventory, 'injected.receipt.json'),
        api.prettyBytes({ ...receiptBody, receiptSha256: api.stableHash(receiptBody) }), { mode: 0o600 });
    assert.throws(() => api.loadHistoricalInventoryHandle({ inventoryRoot: f.inventory, ledgerName: 'injected.json',
        receiptName: 'injected.receipt.json' }), /historical page legacy has unknown or missing fields/);

    const wrongTarget = structuredClone(f.ledger); const wrongPaper = wrongTarget.pages.find(page => page.kind === 'paper');
    wrongPaper.outboundPostLinks[0].targetRecordSha256 = sha('wrong target');
    const wrongPageBody = structuredClone(wrongPaper); delete wrongPageBody.recordSha256;
    wrongPaper.recordSha256 = api.stableHash(wrongPageBody);
    wrongTarget.outboundPostLinks = wrongTarget.pages.flatMap(page => page.outboundPostLinks.map(link => (
        { sourcePageId: page.pageId, sourcePath: page.path, ...link }
    )));
    wrongTarget.outboundPostLinksSha256 = api.stableHash(wrongTarget.outboundPostLinks);
    wrongTarget.pageSetSha256 = api.stableHash(wrongTarget.pages);
    const wrongLedgerBody = structuredClone(wrongTarget); delete wrongLedgerBody.ledgerSha256;
    wrongTarget.ledgerSha256 = api.stableHash(wrongLedgerBody);
    assert.throws(() => api.validateHistoricalLedger(wrongTarget), /target binding/);

    const leaked = structuredClone(f.ledger); const leakedPaper = leaked.pages.find(page => page.kind === 'paper');
    const contractEvidence = leakedPaper.publicationEvidenceRefs.find(
        evidence => evidence.field === 'paper_digest_api_reader_contract');
    contractEvidence.value = '/Users/private/reader-secret';
    contractEvidence.valueSha256 = api.stableHash(contractEvidence.value);
    rehashPage(leakedPaper); rehashLedger(leaked);
    assert.throws(() => api.validateHistoricalLedger(leaked), /must be hash-only/);

    const invalidEnum = structuredClone(f.ledger); const invalidPaper = invalidEnum.pages.find(page => page.kind === 'paper');
    const pageTypeEvidence = invalidPaper.publicationEvidenceRefs.find(
        evidence => evidence.field === 'paper_digest_page_type');
    pageTypeEvidence.value = 'https://user:secret@example.test/path';
    pageTypeEvidence.valueSha256 = api.stableHash(pageTypeEvidence.value);
    rehashPage(invalidPaper); rehashLedger(invalidEnum);
    assert.throws(() => api.validateHistoricalLedger(invalidEnum), /preserved publication string is invalid/);
});

test('loader accepts the exact canonical ledger/receipt bytes emitted by the Python inventory contract', t => {
    const f = fixture(t); const output = path.join(f.root, 'python-inventory'); fs.mkdirSync(output);
    const input = path.join(f.root, 'python-input.json'); fs.writeFileSync(input, JSON.stringify(f.ledger));
    const script = [
        'import json,sys',
        'sys.path.insert(0, sys.argv[1])',
        'from historical_page_scan import build_receipt',
        'ledger=json.load(open(sys.argv[2], encoding="utf-8"))',
        'ledger_bytes,receipt,receipt_bytes=build_receipt(ledger, "python.json")',
        'open(sys.argv[3], "wb").write(ledger_bytes)',
        'open(sys.argv[4], "wb").write(receipt_bytes)',
    ].join(';');
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script, path.join(__dirname, '..', 'scripts'),
        input, path.join(output, 'python.json'), path.join(output, 'python.receipt.json')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const handle = api.loadHistoricalInventoryHandle({ inventoryRoot: output, ledgerName: 'python.json',
        receiptName: 'python.receipt.json' });
    assert.equal(api.inventoryHandleSnapshot(handle).ledger.ledgerSha256, f.ledger.ledgerSha256);
});

test('prepare selects every and only paper page without title/body, dry-run is zero-write and apply uses safe modes', t => {
    const f = fixture(t); const roots = { inventoryRoot: f.inventory, crosswalkRoot: f.crosswalk };
    const args = ['prepare', '--dry-run', '--ledger', f.ledgerName, '--receipt', f.receiptName, '--crosswalk', ids[0]];
    const dry = cli.main(args, { roots, now: stamp });
    assert.equal(dry.status, 'dry-run'); assert.equal(dry.total, 1); assert.equal(fs.existsSync(f.crosswalk), false);
    const applied = cli.main(['prepare', '--apply', ...args.slice(2)], { roots, now: stamp });
    assert.equal(applied.status, 'prepared');
    const directory = path.join(f.crosswalk, ids[0]);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, 'decisions')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, 'state.json')).mode & 0o777, 0o600);
    const stateBytes = fs.readFileSync(path.join(directory, 'state.json'));
    assert.doesNotMatch(stateBytes.toString(), /SECRET OLD BODY|title/i);
    const state = api.readCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0] });
    assert.equal(Object.values(state.assignments)[0].status, 'pending'); assert.deepEqual(state.identityGroups, []);
    assert.equal(Object.keys(state.assignments)[0], f.ledger.pages.find(page => page.kind === 'paper').pageId);
    const status = cli.main(['status', '--crosswalk', ids[0]], { roots });
    assert.equal(status.status, 'valid'); assert.equal(status.pending, 1);
});

test('prepare rolls back injected EIO and recovers only verifiable known half-products', t => {
    const f = fixture(t); const handle = load(f);
    for (const [offset, stage] of ['afterDirectoryCreate', 'afterDecisionsCreate', 'afterStateWrite'].entries()) {
        const crosswalkId = ids[offset + 3];
        assert.throws(() => api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
            crosswalkId, now: stamp, apply: true, testHooks: { [stage]: () => { throw eio(stage); } } }),
        /injected EIO/);
        const recovered = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
            crosswalkId, now: stamp, apply: true });
        assert.equal(recovered.completion.pending, 1);
        assert.equal(api.readCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId }).stateSha256,
            recovered.stateSha256);
    }

    const emptyId = ids[6]; const emptyDirectory = path.join(f.crosswalk, emptyId);
    fs.mkdirSync(emptyDirectory, { mode: 0o700 });
    assert.equal(api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: emptyId, now: stamp, apply: true }).completion.pending, 1);

    const decisionsId = ids[7]; const decisionsDirectory = path.join(f.crosswalk, decisionsId);
    fs.mkdirSync(decisionsDirectory, { mode: 0o700 });
    fs.mkdirSync(path.join(decisionsDirectory, 'decisions'), { mode: 0o700 });
    assert.equal(api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: decisionsId, now: stamp, apply: true }).completion.pending, 1);

    const stateId = ids[8]; const stateDirectory = path.join(f.crosswalk, stateId);
    fs.mkdirSync(stateDirectory, { mode: 0o700 });
    const initial = api.buildInitialState(handle, { crosswalkId: stateId, now: stamp });
    fs.writeFileSync(path.join(stateDirectory, 'state.json'), api.prettyBytes(initial), { mode: 0o600 });
    assert.equal(api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: stateId, now: stamp, apply: true }).stateSha256, initial.stateSha256);

    const unknownId = ids[9]; const unknownDirectory = path.join(f.crosswalk, unknownId);
    fs.mkdirSync(unknownDirectory, { mode: 0o700 }); fs.writeFileSync(path.join(unknownDirectory, 'unknown'), 'x');
    assert.throws(() => api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: unknownId, now: stamp, apply: true }), /unknown content/);

    const linkedId = ids[10]; const linkedDirectory = path.join(f.crosswalk, linkedId);
    fs.mkdirSync(linkedDirectory, { mode: 0o700 }); fs.symlinkSync(f.inventory, path.join(linkedDirectory, 'decisions'));
    assert.throws(() => api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: linkedId, now: stamp, apply: true }), /unsafe directory/);
});

test('decision application is CAS-bound, append-only and idempotent by exact operation evidence', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildDecisionArtifact({ state, pageKey, operationId: ids[1], actorId: 'reviewer.1',
        status: 'needs-review', reason: 'source identity needs explicit authority', now: stamp });
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'review.json', artifact });
    const handle = api.loadDecisionHandle(decisionFile);
    const updated = api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle: handle,
        owner: 'worker.1', now: stamp });
    assert.equal(updated.completion.needsReview, 1); assert.equal(updated.attempts.length, 1);
    const viaCli = cli.main(['apply', '--crosswalk', ids[0], '--decision', 'review.json', '--owner', 'worker.1'],
        { roots: { inventoryRoot: f.inventory, crosswalkRoot: f.crosswalk }, now: stamp });
    assert.equal(viaCli.status, 'updated'); assert.equal(viaCli.attempts, 1);
    assert.equal(api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle: handle,
        owner: 'worker.1', now: stamp }).attempts.length, 1);
    const different = { ...artifact, result: { status: 'blocked', reason: 'different' } };
    different.artifactSha256 = api.stableHash(Object.fromEntries(Object.entries(different).filter(([key]) => key !== 'artifactSha256')));
    const secondFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'different.json', artifact: different });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionHandle: api.loadDecisionHandle(secondFile), owner: 'worker' }), /different decision evidence/);
    const staleState = api.buildInitialState(load(f), { crosswalkId: ids[0], now: stamp });
    const stale = api.buildDecisionArtifact({ state: staleState, pageKey, operationId: ids[2], actorId: 'reviewer',
        status: 'conflict', reason: 'conflict', now: stamp });
    const staleFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'stale.json', artifact: stale });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionHandle: api.loadDecisionHandle(staleFile), owner: 'worker' }), /compare-and-swap/);
    fs.appendFileSync(decisionFile, ' ');
    assert.throws(() => api.readCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0] }), /replay drifted/);
});

test('operation lock never steals a live PID and rejects fresh-dead, symlink, extra, or tampered evidence', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildDecisionArtifact({ state, pageKey, operationId: ids[1], actorId: 'reviewer',
        status: 'needs-review', reason: 'review', now: stamp });
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'review.json', artifact }); const decisionHandle = api.loadDecisionHandle(decisionFile);
    const directory = path.join(f.crosswalk, ids[0]); const lockPath = path.join(directory, 'operation.lock');

    const live = api.acquireLock(directory, 'live.owner', stamp);
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /locked by a live process/);
    api.releaseLock(live); assert.equal(fs.existsSync(lockPath), false);

    const fresh = new Date().toISOString(); writeOperationLock(directory, { startedAt: fresh, heartbeatAt: fresh });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /dead process but is not stale/);
    fs.rmSync(lockPath, { recursive: true });

    fs.symlinkSync(f.inventory, lockPath);
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /not a canonical directory/);
    fs.unlinkSync(lockPath);

    writeOperationLock(directory, { extra: true });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /unknown or missing evidence/);
    fs.rmSync(lockPath, { recursive: true });

    const tampered = writeOperationLock(directory);
    const changed = { ...tampered.owner, owner: 'changed.owner' };
    fs.writeFileSync(tampered.ownerFile, api.prettyBytes(changed), { mode: 0o600 });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /self-SHA drifted/);
});

test('operation lock reclaims only a verified stale lock owned by a dead local PID', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildDecisionArtifact({ state, pageKey, operationId: ids[1], actorId: 'reviewer',
        status: 'needs-review', reason: 'review', now: stamp });
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'review.json', artifact }); const decisionHandle = api.loadDecisionHandle(decisionFile);
    const directory = path.join(f.crosswalk, ids[0]); const stale = writeOperationLock(directory);
    const updated = api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp });
    assert.equal(updated.completion.needsReview, 1); assert.equal(updated.attempts.length, 1);
    assert.equal(fs.existsSync(stale.lock), false);
    assert.equal(fs.existsSync(path.join(directory, 'operation.lock.reclaim')), false);
});

test('verified/completion/identity-group injection and finalize all fail closed', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    assert.throws(() => api.buildDecisionArtifact({ state, pageKey, actorId: 'reviewer', status: 'verified',
        reason: 'forged', now: stamp }), /future authenticated source-authority/);
    const forged = structuredClone(state); forged.assignments[pageKey] = { ...forged.assignments[pageKey], status: 'verified',
        reason: 'forged', decisionArtifactSha256: sha('forged') };
    assert.throws(() => api.assertCrosswalkState(forged), /future authenticated source-authority/);
    const groups = structuredClone(state); groups.identityGroups = [{ forged: true }]; groups.identityGroupsSha256 = api.stableHash(groups.identityGroups);
    assert.throws(() => api.assertCrosswalkState(groups), /identityGroups must remain empty/);
    assert.throws(() => api.finalizeCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0] }), /every paper/);
    assert.throws(() => cli.main(['finalize', '--crosswalk', ids[0]],
        { roots: { inventoryRoot: f.inventory, crosswalkRoot: f.crosswalk } }), /every paper/);
});

test('paths, links, duplicate JSON and CLI grammar fail closed without writes', t => {
    const f = fixture(t); const roots = { inventoryRoot: f.inventory, crosswalkRoot: f.crosswalk };
    assert.throws(() => cli.parseArgs(['prepare', '--dry-run', '--ledger', '../x.json', '--receipt', 'r.json']));
    assert.throws(() => cli.parseArgs(['status', '--crosswalk', '../x']));
    const linked = path.join(f.inventory, 'linked.json'); fs.symlinkSync(path.join(f.inventory, f.ledgerName), linked);
    assert.throws(() => api.loadHistoricalInventoryHandle({ inventoryRoot: f.inventory, ledgerName: 'linked.json',
        receiptName: f.receiptName }), /regular single-link/);
    fs.writeFileSync(path.join(f.inventory, 'duplicate.json'), '{"contract":"x","contract":"x"}\n');
    assert.throws(() => api.loadHistoricalInventoryHandle({ inventoryRoot: f.inventory, ledgerName: 'duplicate.json',
        receiptName: f.receiptName }), /duplicate JSON key/);
    assert.equal(fs.existsSync(f.crosswalk), false);
    const dry = cli.main(['prepare', '--dry-run', '--ledger', f.ledgerName, '--receipt', f.receiptName,
        '--crosswalk', ids[0]], { roots, now: stamp });
    assert.equal(dry.status, 'dry-run'); assert.equal(fs.existsSync(f.crosswalk), false);
});

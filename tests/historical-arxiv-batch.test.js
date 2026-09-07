'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const batch = require('../scripts/lib/historical-arxiv-batch.js');
const cli = require('../scripts/historical-arxiv-batch.js');

const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-433333333333', '44444444-4444-4444-8444-444444444444'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const key = character => `page:${character.repeat(64)}`;
const HINT_SOURCES = ['body:arxiv-link'];
const scope = { type: 'daily', key: '2026-01-01' };
const source = { ledgerSha256: sha('ledger'), pageSetSha256: sha('page-set') };

function paper(pageKey, arxivId, suffix = '') {
    return { pageKey, pagePath: `content/posts/${arxivId}-${suffix || pageKey.slice(5, 9)}.md`,
        pageContentSha256: sha(`page-${pageKey}`), primaryUrl: `https://example.test/${pageKey.slice(5, 13)}`,
        cohortDate: '2026-01-01', scope: structuredClone(scope),
        identityHints: { status: 'single', candidates: [{ scheme: 'arxiv', value: arxivId, sources: HINT_SOURCES }] } };
}
function state() {
    const papers = [paper(key('a'), '2601.00001', 'a'), paper(key('b'), '2601.00001', 'b'),
        // Same arXiv hint, deliberately absent from the handoff. A pending-page
        // sweep would incorrectly include this page.
        paper(key('c'), '2601.00001', 'c'), paper(key('d'), '2601.00002', 'd')];
    return { source: { ...source, papers }, assignments: Object.fromEntries(papers.map(item => [item.pageKey,
        { status: 'pending', sourceAuthority: null }])), completion: { verified: 0, total: papers.length } };
}
function handoffFor(current, arxivId, pageKeys, name) {
    const bindings = pageKeys.map(pageKey => {
        const item = current.source.papers.find(paperItem => paperItem.pageKey === pageKey);
        return { pageKey, pagePath: item.pagePath, pageContentSha256: item.pageContentSha256, primaryUrl: item.primaryUrl,
            cohortDate: item.cohortDate, scope: structuredClone(item.scope), mapping: 'frozen-single-arxiv-identity-hint',
            historicalArxivLink: { arxivId, canonicalUrl: `https://arxiv.org/abs/${arxivId}`, hintSources: HINT_SOURCES } };
    }).sort((left, right) => left.pageKey.localeCompare(right.pageKey));
    return { handoffName: name, fileSha256: sha(name), handoff: { arxivId, generation: 1,
        handoffSha256: sha(`handoff-${name}`), inventory: structuredClone(source), pageBindings: bindings } };
}
function mockedDependencies(current, handoffs, { failId = null } = {}) {
    const calls = { authority: [], decisions: [], records: [], handoffs: [] }; let uuidIndex = 0;
    return { calls, deps: {
        readCrosswalk: () => structuredClone(current),
        readFailureHandoff: ({ handoffName }) => {
            calls.handoffs.push(handoffName); const found = handoffs.find(item => item.handoffName === handoffName);
            if (!found) throw new Error('handoff not found'); return { fileSha256: found.fileSha256, handoff: structuredClone(found.handoff) };
        },
        prepareAuthority: async options => {
            calls.authority.push(options.arxivId); if (options.arxivId === failId) throw new Error('injected source failure');
            return { authorityHandle: { id: options.arxivId } };
        },
        buildDecision: options => ({ pageKey: options.pageKey, authorityHandle: options.authorityHandle, reason: options.reason }),
        writeDecision: options => { calls.decisions.push(options); return `/tmp/${options.decisionName}`; },
        loadDecision: (_filename, options) => ({ authorityHandle: options.authorityHandle,
            pageKey: calls.decisions.at(-1).artifact.pageKey }),
        applyDecision: options => {
            current.assignments[options.decisionHandle.pageKey].status = 'verified';
            current.assignments[options.decisionHandle.pageKey].sourceAuthority = {
                paperId: `arxiv:${options.decisionHandle.authorityHandle.id}`,
                authorityName: `arxiv-${options.decisionHandle.authorityHandle.id}-history.json` };
            current.completion.verified += 1; return structuredClone(current);
        },
        uuid: () => UUIDS[uuidIndex++ % UUIDS.length], now: () => '2026-09-07T00:00:00.000Z',
        writeAttemptRecord: (_root, record) => { calls.records.push(structuredClone(record)); return record; }
    } };
}

const options = (handoffNames, apply = true) => ({ crosswalkRoot: '/tmp/crosswalk', authorityRoot: '/tmp/authority',
    handoffRoot: '/tmp/handoffs', batchRoot: '/tmp/batch', crosswalkId: UUIDS[0], owner: 'batch.worker', handoffNames, apply });

test('selects only named fresh-failure pages and never sweeps other pending pages with the same arXiv hint', async () => {
    const current = state(); const named = handoffFor(current, '2601.00001', [key('a'), key('b')], 'arxiv-fresh-failure-a.json');
    const mock = mockedDependencies(current, [named]);
    const result = await batch.runSingleHintBatch(options([named.handoffName]), mock.deps);
    assert.equal(result.status, 'complete'); assert.deepEqual(mock.calls.authority, ['2601.00001']);
    assert.equal(result.processedPages, 2); assert.equal(current.assignments[key('a')].status, 'verified');
    assert.equal(current.assignments[key('b')].status, 'verified'); assert.equal(current.assignments[key('c')].status, 'pending');
    assert.match(mock.calls.decisions[0].artifact.reason, new RegExp(named.handoff.handoffSha256));
    assert.equal(mock.calls.records[0].handoffName, named.handoffName);
});

test('rejects an arbitrary pending sweep, an inventory mismatch, and handoff-to-page drift before authority acquisition', async () => {
    const current = state(); const named = handoffFor(current, '2601.00001', [key('a')], 'arxiv-fresh-failure-a.json');
    const mock = mockedDependencies(current, [named]);
    await assert.rejects(batch.runSingleHintBatch({ ...options([]), handoffNames: [] }, mock.deps), /named fresh-failure handoff/);
    const wrongInventory = structuredClone(named); wrongInventory.handoff.inventory.ledgerSha256 = sha('other-ledger');
    await assert.rejects(batch.runSingleHintBatch(options([wrongInventory.handoffName]), mockedDependencies(current, [wrongInventory]).deps), /another frozen inventory/);
    const drifted = structuredClone(named); drifted.handoff.pageBindings[0].pageContentSha256 = sha('drift');
    await assert.rejects(batch.runSingleHintBatch(options([drifted.handoffName]), mockedDependencies(current, [drifted]).deps), /binding drifted/);
    assert.deepEqual(mock.calls.authority, []);
});

test('one selected failure is preserved and does not stop another explicitly named handoff', async () => {
    const current = state(); const first = handoffFor(current, '2601.00001', [key('a')], 'arxiv-fresh-failure-a.json');
    const second = handoffFor(current, '2601.00002', [key('d')], 'arxiv-fresh-failure-d.json');
    const mock = mockedDependencies(current, [first, second], { failId: '2601.00001' });
    const result = await batch.runSingleHintBatch({ ...options([first.handoffName, second.handoffName]), concurrency: 3 }, mock.deps);
    assert.equal(result.status, 'partial'); assert.equal(result.failures.length, 1);
    assert.deepEqual(mock.calls.authority, ['2601.00001', '2601.00002']); assert.equal(current.assignments[key('a')].status, 'pending');
    assert.equal(current.assignments[key('d')].status, 'verified'); assert.equal(mock.calls.records[0].handoffName, first.handoffName);
});

test('dry-run is zero mutation and attempt records are append-only mode 0600', async t => {
    const current = state(); const named = handoffFor(current, '2601.00001', [key('a')], 'arxiv-fresh-failure-a.json');
    const mock = mockedDependencies(current, [named]); const result = await batch.runSingleHintBatch({ ...options([named.handoffName]), apply: false }, mock.deps);
    assert.equal(result.status, 'dry-run'); assert.equal(result.selectedPages, 1); assert.equal(mock.calls.authority.length, 0);
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-arxiv-batch-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const record = { crosswalkId: UUIDS[0], attemptId: UUIDS[1], arxivId: '2601.00001', handoffName: named.handoffName,
        handoffFileSha256: named.fileSha256, handoffSha256: named.handoff.handoffSha256, handoffGeneration: 1,
        authorityName: 'arxiv-2601.00001-history.json', status: 'complete', startedAt: '2026-09-07T00:00:00.000Z',
        finishedAt: '2026-09-07T00:01:00.000Z', requestedPageKeys: [key('a')], completedPageKeys: [key('a')], remainingPageKeys: [], error: null };
    const written = batch.writeAttemptRecord(root, record); assert.equal(fs.statSync(written.filename).mode & 0o777, 0o600);
    assert.throws(() => batch.writeAttemptRecord(root, record), /EEXIST/);
});

test('CLI requires explicitly named failure handoffs and passes the configured handoff root', async () => {
    const parsed = cli.parseArgs(['--dry-run', '--crosswalk', UUIDS[0], '--owner', 'batch.worker',
        '--handoffs', 'arxiv-fresh-failure-a.json,arxiv-fresh-failure-b.json', '--concurrency', '3']);
    assert.deepEqual(parsed.handoffNames, ['arxiv-fresh-failure-a.json', 'arxiv-fresh-failure-b.json']); assert.equal(parsed.concurrency, 3);
    assert.throws(() => cli.parseArgs(['--apply', '--crosswalk', UUIDS[0], '--owner', 'batch.worker']), /Use/);
    assert.throws(() => cli.parseArgs(['--apply', '--crosswalk', UUIDS[0], '--owner', 'batch.worker', '--handoffs', 'other.json']), /Use/);
    let received;
    const result = await cli.main(['--dry-run', '--crosswalk', UUIDS[0], '--owner', 'batch.worker', '--handoffs', 'arxiv-fresh-failure-a.json'], {
        files: { pageSourceCrosswalkDir: '/tmp/crosswalk', paperSourceAuthorityDir: '/tmp/authority', historicalArxivBatchDir: '/tmp/batch',
            historicalArxivFreshFailureHandoffDir: '/tmp/handoffs' }, runBatch: async value => { received = value; return { status: 'dry-run', exitCode: 0 }; }
    });
    assert.equal(result.status, 'dry-run'); assert.equal(received.handoffRoot, '/tmp/handoffs');
});

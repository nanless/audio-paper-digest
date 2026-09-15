'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const queue = require('../scripts/lib/conference-queue.js');
const processApi = require('../scripts/lib/conference-process.js');
const cli = require('../scripts/conference-queue.js');

const sha = value => processApi.stableHash(value);
const UUIDS = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'
];

function plan(count = 2) {
    return queue.normalizePlan({ contract: queue.PLAN_CONTRACT, version: 1, conferences: Array.from({ length: count }, (_, index) => ({
        conferenceId: `odyssey-${2026 + index}`,
        catalogName: `catalog-${index}.json`, reportName: `report-${index}.json`, filterId: UUIDS[index], concurrency: 1
    })) });
}

function fixture(t, count = 2) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-queue-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = { conferenceQueueDir: path.join(root, 'queues'), conferencePublicationDir: path.join(root, 'publications') };
    let tick = 0;
    return { root, files, plan: plan(count), now: () => `2026-09-12T00:00:${String(tick++).padStart(2, '0')}.000Z` };
}

function publisherReceipts(entry, processId) {
    const generationBody = { contract: 'conference-blog-generation-v1', version: 2,
        conferenceId: entry.conferenceId, processId, completionReceiptSha256: sha(`completion:${processId}`) };
    const generation = { ...generationBody, generationSha256: sha(generationBody) };
    const reviewBody = { contract: 'conference-blog-review-v1', version: 2,
        conferenceId: entry.conferenceId, processId, generationSha256: generation.generationSha256,
        hugo: { status: 'passed', contract: 'conference-publication-mechanical-gate-v1' } };
    const review = { ...reviewBody, reviewSha256: sha(reviewBody) };
    const publishBody = { contract: 'conference-blog-publish-v1', version: 2,
        conferenceId: entry.conferenceId, processId, generationSha256: generation.generationSha256,
        reviewSha256: review.reviewSha256, publicationCommit: 'a'.repeat(40), remoteVerifiedOid: 'a'.repeat(40),
        imagePublicationCommit: 'a'.repeat(40), urlAcceptance: {
            status: 'passed', contract: 'conference-publication-mechanical-gate-v1', checks: [] } };
    const publish = { ...publishBody, publishSha256: sha(publishBody) };
    return { generation, review, publish };
}

function legacyVerification(publishSha256) {
    const body = { contract: 'conference-legacy-publication-verification-v2', publishSha256,
        hugo: { status: 'passed', contract: 'conference-publication-mechanical-gate-v1' },
        urlAcceptance: { status: 'passed', contract: 'conference-publication-mechanical-gate-v1' } };
    return { ...body, verificationSha256: sha(body) };
}

function publicationState(entry, processId, legacy = false) {
    return { contract: 'conference-publication-status-v1', conferenceId: entry.conferenceId, processId,
        status: 'complete', complete: true, processingRequired: false, nextAction: null,
        completionScope: 'mechanical-html+remote-oid+online-urls',
        layers: { htmlMechanical: 'passed', remoteOid: 'passed', onlineUrls: 'passed',
            semanticReview: 'not_performed', visualInspection: 'not_performed', mathBrowserExecution: 'not_performed' },
        ...(legacy ? { legacyReverified: true } : {}) };
}

function writePublishReceipt(f, entry, processId, receipt) {
    const directory = path.join(f.files.conferencePublicationDir, entry.conferenceId, processId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'publish.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

function writeLegacyVerification(f, entry, processId, receipt) {
    const directory = path.join(f.files.conferencePublicationDir, entry.conferenceId, processId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'verification-v2.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

function processIdFor(entry) {
    return processApi.deterministicUuid('fixture-process', entry.conferenceId);
}

function dependencies(f, events, hooks = {}) {
    const process = {
        status: async entry => {
            events.push(`process:status:${entry.conferenceId}`);
            return hooks.status ? hooks.status(entry) : (() => { const error = new Error('state missing'); error.code = 'ENOENT'; throw error; })();
        },
        apply: async entry => {
            events.push(`process:apply:${entry.conferenceId}`);
            if (hooks.apply) return hooks.apply(entry);
            const processId = processIdFor(entry);
            return { status: 'complete', conferenceId: entry.conferenceId,
                processId, completionReceiptSha256: sha(`completion:${processId}`) };
        }
    };
    const publisher = {};
    for (const action of ['generate', 'review', 'push', 'verify']) {
        publisher[action] = async entry => {
            events.push(`${action}:${entry.conferenceId}`);
            if (hooks[action]) return hooks[action](entry);
            const processId = processIdFor(entry);
            const receipts = publisherReceipts(entry, processId);
            const receiptKey = { generate: 'generation', review: 'review', push: 'publish' }[action];
            if (action === 'push') writePublishReceipt(f, entry, processId, receipts.publish);
            if (action === 'verify') return publicationState(entry, processId);
            return { status: `${action}d`, [`${receiptKey === 'generation' ? 'generation' : receiptKey}Receipt`]: receipts[receiptKey] };
        };
    }
    if (hooks.findPublished) publisher.findPublished = hooks.findPublished;
    return { files: f.files, now: f.now, process, publisher };
}

function planFile(t, value) {
    const filename = path.join(t.context?.root || os.tmpdir(), `conference-plan-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    t.after(() => { try { fs.unlinkSync(filename); } catch {} });
    return filename;
}

test('explicit plan parsing and dry-run/status never create queue state or call workers', async t => {
    const f = fixture(t, 1); const events = [];
    const filename = path.join(f.root, 'plan.json');
    fs.writeFileSync(filename, `${JSON.stringify(f.plan)}\n`, { mode: 0o600 });
    const deps = dependencies(f, events);
    const dry = await queue.runConferenceQueue({ mode: 'dry-run', planFile: filename }, deps);
    assert.equal(dry.readOnly, true); assert.equal(dry.status, 'pending'); assert.equal(dry.entries[0].stage, 'process');
    const status = await queue.runConferenceQueue({ mode: 'status', planFile: filename }, deps);
    assert.equal(status.readOnly, true); assert.equal(status.stateSha256, null);
    assert.deepEqual(events, []); assert.equal(fs.existsSync(f.files.conferenceQueueDir), false);
});

test('apply closes each conference in order and does not rerun published entries', async t => {
    const f = fixture(t, 2); const events = []; let failSecond = true;
    const deps = dependencies(f, events, {
        apply: async entry => {
            const conferenceId = entry.conferenceId;
            if (conferenceId === 'odyssey-2027' && failSecond) { failSecond = false; throw new Error('system interruption'); }
            const processId = processIdFor({ conferenceId });
            return { status: 'complete', conferenceId, processId, completionReceiptSha256: sha(`completion:${processId}`) };
        }
    });
    const first = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan }, deps);
    assert.equal(first.status, 'paused');
    assert.deepEqual(events.map(value => value.split(':').slice(0, 2).join(':')), [
        'process:status', 'process:apply', 'generate:odyssey-2026', 'review:odyssey-2026',
        'push:odyssey-2026', 'verify:odyssey-2026', 'process:status', 'process:apply'
    ]);
    events.length = 0;
    const second = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan, retryFailed: true }, deps);
    assert.equal(second.status, 'complete');
    assert.equal(events.includes('generate:odyssey-2026'), false);
    assert.equal(events.includes('process:apply:odyssey-2026'), false);
    assert.deepEqual(second.entries.map(entry => entry.status), ['published', 'published']);
});

test('a publisher failure is retained at its stage and resume uses the complete process', async t => {
    const f = fixture(t, 1); const events = []; let failReview = true;
    const deps = dependencies(f, events, {
        review: async entry => {
            events.push(`review:${entry.conferenceId}`);
            if (failReview) { failReview = false; throw new Error('review interrupted'); }
            const processId = processIdFor(entry); return { status: 'reviewed', reviewReceipt: publisherReceipts(entry, processId).review };
        }
    });
    const first = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan }, deps);
    assert.equal(first.status, 'paused'); assert.equal(first.entries[0].stage, 'review');
    events.length = 0;
    deps.process.status = async entry => { events.push(`process:status:${entry.conferenceId}`); const processId = processIdFor(entry); return {
        status: 'complete', conferenceId: entry.conferenceId, processId,
        completionReceiptSha256: sha(`completion:${processId}`)
    }; };
    deps.process.apply = async () => { throw new Error('complete process must not reanalyze'); };
    const second = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan, retryFailed: true }, deps);
    assert.equal(second.status, 'complete'); assert.equal(events.includes('process:apply:odyssey-2026'), false);
    assert.equal(events[0], 'review:odyssey-2026');
});

test('running process is active only with a live owner; an old running checkpoint is resumed', async t => {
    const f = fixture(t, 1); const events = []; let live = true;
    const deps = dependencies(f, events, {
        status: async entry => live ? { status: 'running', conferenceId: entry.conferenceId,
            operationLock: { ownerAlive: true, ownerPid: 123 } } : { status: 'running', conferenceId: entry.conferenceId,
            operationLock: { ownerAlive: false, ownerPid: 123 } }
    });
    const blocked = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan }, deps);
    assert.equal(blocked.status, 'paused'); assert.equal(blocked.entries[0].blocked.kind, 'active');
    assert.equal(events.includes('process:apply:odyssey-2026'), false);
    live = false; events.length = 0;
    const resumed = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan, retryFailed: true }, deps);
    assert.equal(resumed.status, 'complete'); assert.equal(events.includes('process:apply:odyssey-2026'), true);
});

test('verify cannot close a queue without the publisher publish.json v2 receipt', async t => {
    const f = fixture(t, 1); const events = [];
    const deps = dependencies(f, events, { push: async entry => ({
        status: 'pushed', publishReceipt: publisherReceipts(entry, processIdFor(entry)).publish
    }), verify: async entry => {
        events.push(`verify:${entry.conferenceId}`);
        return publicationState(entry, processIdFor(entry));
    } });
    const result = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan }, deps);
    assert.equal(result.status, 'paused'); assert.equal(result.entries[0].stage, 'verify');
    assert.equal(result.entries[0].status, 'paused'); assert.match(result.entries[0].failure.message, /receipt/i);
});

test('legacy publish.json v1 is terminal published evidence and never re-enters process', async t => {
    const f = fixture(t, 1); const events = [];
    const entry = f.plan.conferences[0]; const processId = processIdFor(entry);
    const body = { contract: 'conference-blog-publish-v1', version: 1,
        conferenceId: entry.conferenceId, processId, publicationCommit: 'b'.repeat(40), remoteVerifiedOid: 'b'.repeat(40) };
    const legacy = { ...body, publishSha256: sha(body) };
    writeLegacyVerification(f, entry, processId, legacyVerification(legacy.publishSha256));
    const deps = dependencies(f, events, { findPublished: async () => legacy,
        verify: async () => publicationState(entry, processId, true),
        apply: async () => { throw new Error('legacy published batch must not reanalyze'); } });
    const result = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan }, deps);
    assert.equal(result.status, 'complete'); assert.equal(result.entries[0].legacyPublished, true);
    assert.equal(events.includes('process:apply:odyssey-2026'), false);
    assert.deepEqual(events, ['verify:odyssey-2026']);
});

test('discovered v2 publication still runs the real verify stage before queue completion', async t => {
    const f = fixture(t, 1); const events = []; const entry = f.plan.conferences[0];
    const processId = processIdFor(entry); const receipts = publisherReceipts(entry, processId);
    writePublishReceipt(f, entry, processId, receipts.publish);
    const deps = dependencies(f, events, { findPublished: async () => receipts.publish,
        status: async () => { throw new Error('published v2 must not inspect process'); },
        apply: async () => { throw new Error('published v2 must not reanalyze'); },
        generate: async () => { throw new Error('published v2 must not generate again'); },
        review: async () => { throw new Error('published v2 must not review again'); },
        push: async () => { throw new Error('published v2 must not push again'); } });
    const result = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan }, deps);
    assert.equal(result.status, 'complete'); assert.deepEqual(events, ['verify:odyssey-2026']);
});

test('apply rejects a complete queue when its durable published proof drifts', async t => {
    const f = fixture(t, 1); const events = []; const deps = dependencies(f, events);
    const first = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan }, deps);
    assert.equal(first.status, 'complete');
    const entry = f.plan.conferences[0]; const processId = first.entries[0].processId;
    const receipts = publisherReceipts(entry, processId);
    const drifted = { ...receipts.publish, remoteVerifiedOid: 'c'.repeat(40) };
    deps.publisher.findPublished = async () => drifted;
    await assert.rejects(queue.runConferenceQueue({ mode: 'apply', plan: f.plan }, deps), /self-SHA|drift/i);
});

test('public publisher subprocess boundary uses verify and closes only on publish.json v2', async t => {
    const f = fixture(t, 1); const entry = f.plan.conferences[0]; const processId = processIdFor(entry);
    const receipts = publisherReceipts(entry, processId);
    const publication = path.join(f.files.conferencePublicationDir, entry.conferenceId, processId);
    fs.mkdirSync(publication, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(publication, 'generation.json'), `${JSON.stringify(receipts.generation)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(publication, 'review.json'), `${JSON.stringify(receipts.review)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(publication, 'publish.json'), `${JSON.stringify(receipts.publish)}\n`, { mode: 0o600 });
    const calls = [];
    const deps = queue.defaultDependencies({ files: f.files, now: f.now, runCommand: (command, args) => {
        calls.push({ command, args });
        const value = args[2] === 'verify'
            ? publicationState({ conferenceId: args[4] }, args[6])
            : { status: args[2] === 'generate' ? 'generated' : args[2] === 'review' ? 'reviewed' : 'complete' };
        return `${JSON.stringify(value)}\n`;
    } });
    delete deps.publisher.findPublished;
    deps.process = {
        status: async () => { const error = new Error('state missing'); error.code = 'ENOENT'; throw error; },
        apply: async () => ({ status: 'complete', conferenceId: entry.conferenceId, processId,
            completionReceiptSha256: receipts.generation.completionReceiptSha256 })
    };
    const result = await queue.runConferenceQueue({ mode: 'apply', plan: f.plan }, deps);
    assert.equal(result.status, 'complete');
    assert.deepEqual(calls.map(call => call.args[2]), ['generate', 'review', 'push', 'verify']);
    assert.equal(calls.every(call => call.args.includes('final') === false), true);
    assert.equal(result.entries[0].receipts.verify.receiptSha256, receipts.publish.publishSha256);
});

test('published discovery scans past a stale processId and rejects non-plan or ambiguous history', async t => {
    const f = fixture(t, 1); const entry = f.plan.conferences[0];
    const staleProcessId = UUIDS[1]; const currentProcessId = UUIDS[2];
    const otherProcessId = '44444444-4444-4444-8444-444444444444';
    const paperIds = ['conference:odyssey:2026:paper-1'];
    const authority = processId => ({ status: 'complete', processId,
        completionReceiptSha256: sha(`completion:${processId}`),
        authority: { conferenceId: entry.conferenceId, catalogName: entry.catalogName,
            reportName: entry.reportName, filterId: entry.filterId,
            selectedMemberSetSha256: sha(paperIds) }, items: Object.fromEntries(paperIds.map(id => [id, {}])) });
    const receipts = publisherReceipts(entry, currentProcessId);
    const directory = path.join(f.files.conferencePublicationDir, entry.conferenceId, currentProcessId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'generation.json'), `${JSON.stringify(receipts.generation)}\n`, { mode: 0o600 });
    writePublishReceipt(f, entry, currentProcessId, receipts.publish);
    const deps = queue.defaultDependencies({ files: f.files, root: f.root,
        readProcessState: (_files, processId) => processId === currentProcessId || processId === otherProcessId
            ? authority(processId) : null });
    const found = await deps.publisher.findPublished(entry, staleProcessId, { readOnly: true });
    assert.equal(found.processId, currentProcessId);

    const other = publisherReceipts(entry, otherProcessId);
    const otherDirectory = path.join(f.files.conferencePublicationDir, entry.conferenceId, otherProcessId);
    fs.mkdirSync(otherDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(otherDirectory, 'generation.json'), `${JSON.stringify(other.generation)}\n`, { mode: 0o600 });
    writePublishReceipt(f, entry, otherProcessId, other.publish);
    assert.throws(() => deps.publisher.findPublished(entry, staleProcessId, { readOnly: true }), /multiple published|refusing/i);

    const unmatchedId = '22222222-2222-4222-8222-222222222222';
    const unmatched = publisherReceipts({ ...entry, conferenceId: entry.conferenceId }, unmatchedId);
    const unmatchedDirectory = path.join(f.files.conferencePublicationDir, entry.conferenceId, unmatchedId);
    fs.mkdirSync(unmatchedDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(unmatchedDirectory, 'generation.json'), `${JSON.stringify(unmatched.generation)}\n`, { mode: 0o600 });
    writePublishReceipt(f, entry, unmatchedId, unmatched.publish);
    assert.throws(() => deps.publisher.findPublished(entry, staleProcessId, { readOnly: true }), /current plan|refusing/i);
});

test('CLI requires an explicit absolute plan and exposes only read-only modes without apply', () => {
    assert.deepEqual(cli.parseArgs(['--dry-run', '--plan', '/tmp/selected.json']), {
        mode: 'dry-run', apply: false, statusOnly: false, planFile: '/tmp/selected.json', retryFailed: false
    });
    assert.throws(() => cli.parseArgs(['--apply']), /Use/);
    assert.throws(() => cli.parseArgs(['--status', '--plan', 'relative.json']), /Use/);
});

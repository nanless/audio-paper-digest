'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const test = require('node:test');
const processApi = require('../scripts/lib/conference-process.js');
const staging = require('../scripts/lib/conference-staging.js');
const engine = require('../scripts/analysis-engine.js');
const cli = require('../scripts/conference-process.js');
const discovery = require('../scripts/lib/conference-discovery.js');
const filter = require('../scripts/lib/conference-filter.js');
const extractionFixture = require('./helpers/conference-extraction-fixture.js');
const evidenceFixture = require('./helpers/conference-filter-evidence-fixture.js');
const utils = require('../scripts/utils.js');

const H = value => processApi.stableHash(value);
function executionIdentity({ env = {}, limits = {}, secondary = {} } = {}) {
    const analysisConfig = Object.fromEntries(processApi.DEEP_EXECUTION_LIMIT_FIELDS
        .map(field => [field, /Temperature$/.test(field) ? 0.1 : 1000]));
    return processApi.deepExecutionConfigIdentity({
        env: {
            PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
            PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1',
            PD_OPENAI_RESPONSES_REASONING_EFFORT: 'low',
            PD_OPENAI_RESPONSES_STREAM: '1',
            ...env
        },
        analysisConfig: { ...analysisConfig, ...limits },
        secondaryModelConfig: secondary,
        utilsApi: utils
    });
}
function fixture(t, count = 1) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-process-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const members = Array.from({ length: count }, (_, index) => ({
        paperId: `conference:odyssey:2026:conference-paper-id:paper.${index + 1}`,
        sourceIdentity: `conference-paper-id:paper.${index + 1}`
    }));
    const runtimeAuthority = { implementationSha256: H('implementation'),
        deepExecutionConfig: executionIdentity() };
    const authority = { conferenceId: 'odyssey-2026', catalogName: 'catalog.json', reportName: 'report.json',
        filterId: '11111111-1111-4111-8111-111111111111', catalogSha256: H('catalog'), reportSha256: H('report'),
        filterPolicySha256: H('policy'), selectionReceiptSha256: H('selection'),
        selectedMemberSetSha256: H(members.map(item => item.paperId)), taxonomyVersion: 'taxonomy-v1',
        taxonomyRegistrySha256: H('taxonomy'), implementationSha256: runtimeAuthority.implementationSha256,
        deepExecutionConfig: runtimeAuthority.deepExecutionConfig };
    const files = { conferenceProcessDir: path.join(root, 'processes') };
    const context = { authority, members, files };
    let tick = 0;
    const deps = { files, engine, now: () => `2026-09-09T00:00:${String(tick++).padStart(2, '0')}.000Z`,
        loadAuthority: () => context,
        implementationSha256: () => runtimeAuthority.implementationSha256,
        deepExecutionConfigIdentity: () => runtimeAuthority.deepExecutionConfig,
        prepareShared: async () => ({ planHandle: {}, planReceiptSha256: H('plan'), sealed: members.map(member => ({
            paperId: member.paperId, proof: { requestSha256: H(`request:${member.paperId}`),
                receiptSha256: H(`receipt:${member.paperId}`), verificationSha256: H(`verify:${member.paperId}`),
                textSha256: H(`text:${member.paperId}`), artifactsSha256: H(`artifacts:${member.paperId}`),
                pdfSha256: H(`pdf:${member.paperId}`) } })) }),
        aggregate: async (_context, _shared, ids) => ({ manifest: { aggregateId: H(ids).slice(0, 32),
            manifestSha256: H(['manifest', ids]), markdownSha256: H(['markdown', ids]),
            pagePath: 'content/posts/conference-odyssey-2026.md' } }) };
    return { root, members, authority, runtimeAuthority, files, context, deps };
}
function success(item) {
    return { analysisProof: { analysisSha256: H(`analysis:${item.paperId}`),
        completionReceiptSha256: H(`analysis-receipt:${item.paperId}`), sourceSnapshotSha256: H(`source:${item.paperId}`) },
    pageProof: { manifestSha256: H(`page:${item.paperId}`), contentSha256: H(`content:${item.paperId}`),
        pagePath: `content/posts/${item.paperId.split(':').at(-1)}.md` } };
}

test('one-paper mock E2E closes source, shared analysis, page and aggregate under one immutable receipt', async t => {
    const f = fixture(t); let calls = 0;
    const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 3 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => { calls += 1; return success(item); } });
    assert.equal(first.status, 'complete'); assert.equal(calls, 1);
    const processId = first.processId; const directory = path.join(f.files.conferenceProcessDir, processId);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    assert.equal(state.status, 'complete'); assert.equal(Object.values(state.items)[0].status, 'complete');
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'completion-receipt.json')));
    const { receiptSha256, ...body } = receipt; assert.equal(receiptSha256, processApi.stableHash(body));
    const resumed = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async () => { calls += 1; throw new Error('completed paper must not run again'); } });
    assert.equal(resumed.status, 'complete'); assert.equal(resumed.processId, processId); assert.equal(calls, 1);
});

test('partial paper resumes with the same deterministic UUID and does not rerun completed peers', async t => {
    const f = fixture(t, 2); const attempts = new Map();
    const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 2 };
    const worker = async (_context, _shared, item) => {
        attempts.set(item.paperId, (attempts.get(item.paperId) || 0) + 1);
        if (item.paperId === f.members[1].paperId && attempts.get(item.paperId) === 1) throw new Error('fixture interruption');
        return success(item);
    };
    const first = await processApi.runConferenceProcess(options, { ...f.deps, processPaper: worker });
    assert.equal(first.status, 'partial');
    const processDirectory = path.join(f.files.conferenceProcessDir, first.processId);
    const partial = processApi.assertState(JSON.parse(fs.readFileSync(path.join(processDirectory, 'state.json'))));
    assert.equal(partial.status, 'partial');
    assert.equal(partial.aggregate, null);
    assert.equal(partial.completionReceiptSha256, null);
    assert.equal(fs.existsSync(path.join(processDirectory, 'completion-receipt.json')), false);
    assert.deepEqual(cli.processStatus(options, { dependencies: f.deps }), {
        status: 'partial', processId: first.processId, conferenceId: f.authority.conferenceId,
        stateSha256: partial.stateSha256, papers: { complete: 1, analysis_partial: 1 },
        completionReceiptSha256: null
    });
    const second = await processApi.runConferenceProcess(options, { ...f.deps, processPaper: worker });
    assert.equal(second.status, 'complete');
    assert.equal(attempts.get(f.members[0].paperId), 1); assert.equal(attempts.get(f.members[1].paperId), 2);
    const state = JSON.parse(fs.readFileSync(path.join(f.files.conferenceProcessDir, second.processId, 'state.json')));
    for (const item of Object.values(state.items)) assert.equal(item.analysisRunId,
        processApi.deterministicUuid(second.processId, item.paperId, 'analysis'));
});

test('state status and completion receipt reject incoherent lifecycle claims', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const completed = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => success(item) });
    const directory = path.join(f.files.conferenceProcessDir, completed.processId);
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'completion-receipt.json')));

    const unknown = { ...state, status: 'stopped' };
    unknown.stateSha256 = processApi.stateDigest(unknown);
    assert.throws(() => processApi.assertState(unknown), /checkpoint integrity/);

    const partial = { ...state, status: 'partial', aggregate: null, completionReceiptSha256: null };
    partial.stateSha256 = processApi.stateDigest(partial);
    assert.throws(() => processApi.assertState(partial), /partial checkpoint has no incomplete item/);

    const incompleteWithProof = { ...state, status: 'running' };
    incompleteWithProof.stateSha256 = processApi.stateDigest(incompleteWithProof);
    assert.throws(() => processApi.assertState(incompleteWithProof), /incomplete checkpoint carries aggregate\/receipt proof/);

    const incompleteItem = structuredClone(state);
    incompleteItem.items[f.members[0].paperId].status = 'analysis_partial';
    incompleteItem.stateSha256 = processApi.stateDigest(incompleteItem);
    assert.throws(() => processApi.assertState(incompleteItem), /complete checkpoint lacks closed items/);

    const validPartial = structuredClone(state);
    validPartial.status = 'partial';
    validPartial.items[f.members[0].paperId].status = 'analysis_partial';
    validPartial.aggregate = null;
    validPartial.completionReceiptSha256 = null;
    validPartial.stateSha256 = processApi.stateDigest(validPartial);
    assert.doesNotThrow(() => processApi.assertState(validPartial));
    assert.throws(() => processApi.validateCompletionReceipt(validPartial, receipt),
        /completion receipt requires a complete checkpoint/);
});

test('scheduler bounds the complete per-paper lifecycle at three', async t => {
    const f = fixture(t, 7); let active = 0, maximum = 0;
    const result = await processApi.runConferenceProcess({ apply: true, catalogName: 'catalog.json',
        reportName: 'report.json', filterId: f.authority.filterId, concurrency: 3 }, { ...f.deps,
        processPaper: async (_context, _shared, item) => { active += 1; maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 5)); active -= 1; return success(item); } });
    assert.equal(result.status, 'complete'); assert.equal(maximum, 3);
});

test('implementation fingerprint binds explicit analysis, Reader, identity, and prompt dependencies', () => {
    const required = [
        'scripts/deep-analyzer.js', 'scripts/analysis-engine.js',
        'scripts/config.js', 'scripts/env-loader.js', 'scripts/llm-account-pool.js',
        'scripts/lib/conference-analysis-context.js', 'scripts/lib/paper-identity.js',
        'scripts/paper_identity.py', 'scripts/lib/reader-contract.js',
        'scripts/lib/reader-repair.js', 'scripts/lib/reader-tables.js',
        'scripts/lib/reader-resource-binding.js', 'scripts/lib/reader-resource-sync.js',
        'prompts/api-reader-article.md',
        'prompts/deep-analysis.md', 'prompts/scoring-audit.md', 'prompts/opensource-scan.md'
    ];
    assert.equal(new Set(processApi.IMPLEMENTATION_FILES).size, processApi.IMPLEMENTATION_FILES.length);
    for (const name of required) assert.ok(processApi.IMPLEMENTATION_FILES.includes(name), name);
    for (const name of processApi.IMPLEMENTATION_FILES) {
        assert.equal(fs.statSync(path.join(__dirname, '..', name)).isFile(), true, name);
    }
    assert.match(processApi.implementationSha256(), /^[a-f0-9]{64}$/);
    const root = '/virtual/conference-process-implementation';
    const sources = new Map(processApi.IMPLEMENTATION_FILES.map(name => [name, Buffer.from(`source:${name}`)]));
    const fingerprint = () => processApi.implementationSha256({ root,
        readFileSync: filename => sources.get(path.relative(root, filename)) });
    const baseline = fingerprint();
    for (const name of ['scripts/deep-analyzer.js', 'scripts/config.js', 'scripts/env-loader.js',
        'scripts/llm-account-pool.js', 'scripts/paper_identity.py',
        'scripts/lib/reader-resource-sync.js', 'prompts/api-reader-article.md']) {
        const original = sources.get(name); sources.set(name, Buffer.concat([original, Buffer.from('\nrepresentative drift')]));
        assert.notEqual(fingerprint(), baseline, name); sources.set(name, original);
    }
    assert.equal(fingerprint(), baseline);
});

test('deep execution identity canonicalizes routes, binds semantic config, and excludes every secret', () => {
    const secretA = 'sk-fixture-primary-a';
    const secretSecondary = 'sk-secondary-must-not-be-read';
    const secretHeader = 'Bearer private-header-value';
    const baseline = executionIdentity({ env: {
        PAPER_ANALYZER_API_KEY: secretA,
        PAPER_ANALYZER_FALLBACK_API_KEYS: 'sk-fixture-fallback-a',
        HTTPS_PROXY: 'http://proxy-user:proxy-secret@example.test:8080',
        PD_OPENCODE_SESSION_ID: 'private-session-a',
        PAPER_ANALYZER_AUTHORIZATION_HEADER: secretHeader
    }, secondary: {
        model: 'muse-spark-1.3-contributor', endpoint: 'https://opencode.ai/zen/go/v1/responses',
        key: secretSecondary
    } });
    const equivalentRoute = executionIdentity({ env: {
        PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1/responses',
        PAPER_ANALYZER_API_KEY: 'sk-fixture-primary-b',
        PAPER_ANALYZER_FALLBACK_API_KEYS: 'sk-fixture-fallback-b',
        HTTPS_PROXY: 'http://different-proxy.example.test:3128',
        PD_OPENCODE_SESSION_ID: 'private-session-b'
    }, secondary: {
        model: 'muse-spark-1.3-contributor', endpoint: 'https://opencode.ai/zen/go/v1'
    }, limits: { secretHeader } });
    assert.deepEqual(equivalentRoute, baseline);
    assert.equal(baseline.audit.primary.endpointIdentitySha256,
        baseline.audit.secondary.endpointIdentitySha256);
    const serialized = JSON.stringify(baseline);
    const keyHash = value => crypto.createHash('sha256').update(value).digest('hex');
    for (const forbidden of [secretA, keyHash(secretA), secretSecondary,
        keyHash(secretSecondary), secretHeader, 'fallback', 'proxy-secret', 'private-session',
        'opencode.ai', 'PAPER_ANALYZER', 'Authorization']) assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.deepEqual(Object.keys(baseline).sort(), ['audit', 'contract', 'identitySha256', 'version']);
    assert.equal(processApi.assertDeepExecutionConfigIdentity(baseline), baseline);
    assert.throws(() => executionIdentity({ env: {
        PAPER_ANALYZER_MODEL: ' muse-spark-1.3-contributor'
    } }), /model/i);
    assert.throws(() => executionIdentity({ env: {
        PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1/responses '
    } }), /endpoint/i);

    const changed = [
        executionIdentity({ env: { PAPER_ANALYZER_MODEL: 'muse-spark-1.2-contributor' } }),
        executionIdentity({ env: { PAPER_ANALYZER_ENDPOINT: 'https://api.example.test/v1' } }),
        executionIdentity({ env: { PD_OPENAI_RESPONSES_REASONING_EFFORT: 'high' } }),
        executionIdentity({ env: { PD_OPENAI_RESPONSES_STREAM: '0' } }),
        executionIdentity({ limits: { apiReaderMaxTokens: 2000 } }),
        executionIdentity({ limits: { apiReaderEvidenceMaxChars: 2000 } }),
        executionIdentity({ limits: { scoringAuditTemperature: 0.7 } }),
        executionIdentity({ secondary: { model: 'muse-spark-vision-1.3-contributor',
            endpoint: 'https://opencode.ai/zen/go/v1' } })
    ];
    for (const value of changed) assert.notEqual(value.identitySha256, baseline.identitySha256);
});

test('deep execution config drift changes process identity and cannot address an old complete process', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => success(item) });
    const oldDirectory = path.join(f.files.conferenceProcessDir, first.processId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(oldDirectory, 'state.json'))).status, 'complete');

    f.runtimeAuthority.deepExecutionConfig = executionIdentity({ env: {
        PAPER_ANALYZER_MODEL: 'muse-spark-1.2-contributor'
    } });
    f.context.authority = { ...f.context.authority,
        deepExecutionConfig: f.runtimeAuthority.deepExecutionConfig };
    const nextId = processApi.deterministicUuid(processApi.stableHash(f.context.authority), 'conference-process-v1');
    assert.notEqual(nextId, first.processId);
    assert.equal(fs.existsSync(path.join(f.files.conferenceProcessDir, nextId)), false);
    assert.throws(() => cli.processStatus(options, { dependencies: f.deps }), /ENOENT|no such file/i);
});

test('apply holds one recoverable process operation lock while dry-run takes no write lock', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    let observedLock = null;
    const dry = await processApi.runConferenceProcess({ ...options, apply: false }, { ...f.deps,
        withProcessLock: async () => { throw new Error('dry-run must not acquire a process write lock'); } });
    assert.equal(dry.status, 'dry-run');
    const applied = await processApi.runConferenceProcess(options, { ...f.deps,
        withProcessLock: async (target, callback, lockOptions) => {
            observedLock = { target, lockOptions }; return callback();
        }, processPaper: async (_context, _shared, item) => success(item) });
    assert.equal(applied.status, 'complete');
    assert.equal(observedLock.target, path.join(f.files.conferenceProcessDir, applied.processId, '.operation'));
    assert.equal(observedLock.lockOptions.recoveryPolicy, engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY);
    observedLock = null;
    assert.equal(cli.processStatus(options, { dependencies: { ...f.deps,
        withProcessLock: async () => { throw new Error('status must not acquire a process write lock'); } } }).status, 'complete');
    assert.equal(observedLock, null);
});

test('same-authority apply calls serialize and an exception releases the operation lock for recovery', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    let calls = 0; let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const first = processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => { calls += 1; await gate; return success(item); } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async () => { calls += 1; throw new Error('serialized resume must skip the completed paper'); } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1); releaseFirst();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.status, 'complete'); assert.equal(right.status, 'complete'); assert.equal(calls, 1);

    const g = fixture(t); let failPrepare = true;
    const recoverableDeps = { ...g.deps, prepareShared: async (...args) => {
        if (failPrepare) { failPrepare = false; throw new Error('fixture crash'); }
        return g.deps.prepareShared(...args);
    }, processPaper: async (_context, _shared, item) => success(item) };
    await assert.rejects(processApi.runConferenceProcess(options, recoverableDeps), /fixture crash/);
    const processId = processApi.deterministicUuid(processApi.stableHash(g.authority), 'conference-process-v1');
    assert.equal(fs.existsSync(path.join(g.files.conferenceProcessDir, processId, '.operation.lock')), false);
    assert.equal((await processApi.runConferenceProcess(options, recoverableDeps)).status, 'complete');
});

test('operation lock rejects runtime authority drift before shared preparation', async t => {
    const f = fixture(t); let prepared = false;
    f.runtimeAuthority.deepExecutionConfig = executionIdentity({ limits: { apiMaxTokens: 2001 } });
    await assert.rejects(processApi.runConferenceProcess({ apply: true, catalogName: 'catalog.json',
        reportName: 'report.json', filterId: f.authority.filterId, concurrency: 1 }, { ...f.deps,
        withProcessLock: async (_target, callback) => callback(),
        prepareShared: async () => { prepared = true; return f.deps.prepareShared(); }
    }), /deep execution config drifted before shared preparation/);
    assert.equal(prepared, false);
});

test('implementation drift before aggregate leaves the process incomplete without a completion receipt', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    await assert.rejects(processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => {
            f.runtimeAuthority.implementationSha256 = H('implementation-drifted-during-paper');
            return success(item);
        }
    }), /implementation drifted before aggregate/);
    const processId = processApi.deterministicUuid(processApi.stableHash(f.authority), 'conference-process-v1');
    const directory = path.join(f.files.conferenceProcessDir, processId);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    assert.notEqual(state.status, 'complete');
    assert.equal(state.completionReceiptSha256, null);
    assert.equal(fs.existsSync(path.join(directory, 'completion-receipt.json')), false);
});

test('final completion transaction rechecks config identity before publishing its receipt', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const checkingEngine = { ...engine,
        updateJsonFileLocked(filename, updater, lockOptions) {
            const current = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename)) : null;
            if (current?.items && Object.values(current.items).every(item => item.status === 'complete')
                && current.status !== 'complete') {
                f.runtimeAuthority.deepExecutionConfig = executionIdentity({ limits: {
                    apiReaderContextMaxChars: 2002
                } });
            }
            return engine.updateJsonFileLocked(filename, updater, lockOptions);
        }
    };
    await assert.rejects(processApi.runConferenceProcess(options, { ...f.deps, engine: checkingEngine,
        withProcessLock: async (_target, callback) => callback(),
        processPaper: async (_context, _shared, item) => success(item)
    }), /deep execution config drifted during final completion transaction/);
    const processId = processApi.deterministicUuid(processApi.stableHash(f.authority), 'conference-process-v1');
    const directory = path.join(f.files.conferenceProcessDir, processId);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    assert.notEqual(state.status, 'complete');
    assert.equal(state.aggregate, null);
    assert.equal(state.completionReceiptSha256, null);
    assert.equal(fs.existsSync(path.join(directory, 'completion-receipt.json')), false);
});

test('item CAS preserves a concurrently completed item and final transaction rechecks closure', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const processId = processApi.deterministicUuid(processApi.stableHash(f.authority), 'conference-process-v1');
    const stateFile = path.join(f.files.conferenceProcessDir, processId, 'state.json');
    const completedByPeer = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => {
            engine.updateJsonFileLocked(stateFile, current => {
                const next = structuredClone(processApi.assertState(current));
                next.items[item.paperId] = { ...next.items[item.paperId], ...success(item),
                    status: 'complete', lastError: null, updatedAt: f.deps.now() };
                next.status = 'running'; next.aggregate = null; next.completionReceiptSha256 = null;
                next.generation = current.generation + 1; next.stateSha256 = processApi.stateDigest(next);
                return next;
            });
            throw new Error('late duplicate worker failure');
        } });
    assert.equal(completedByPeer.status, 'complete');
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).items[f.members[0].paperId].status, 'complete');

    const g = fixture(t); const gProcessId = processApi.deterministicUuid(
        processApi.stableHash(g.authority), 'conference-process-v1');
    const gStateFile = path.join(g.files.conferenceProcessDir, gProcessId, 'state.json');
    await assert.rejects(processApi.runConferenceProcess(options, { ...g.deps,
        processPaper: async (_context, _shared, item) => success(item),
        aggregate: async (...args) => {
            const aggregate = await g.deps.aggregate(...args);
            engine.updateJsonFileLocked(gStateFile, current => {
                const next = structuredClone(processApi.assertState(current));
                next.items[g.members[0].paperId].status = 'analysis_partial';
                next.status = 'running'; next.aggregate = null; next.completionReceiptSha256 = null;
                next.generation = current.generation + 1; next.stateSha256 = processApi.stateDigest(next);
                return next;
            });
            return aggregate;
        } }), /completion transaction found incomplete items/);
    const incomplete = processApi.assertState(JSON.parse(fs.readFileSync(gStateFile)));
    assert.equal(incomplete.status, 'running');
    assert.equal(incomplete.items[g.members[0].paperId].status, 'analysis_partial');
});

test('checkpoint and completion receipt tampering fail closed', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const complete = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => success(item) });
    const directory = path.join(f.files.conferenceProcessDir, complete.processId); const stateFile = path.join(directory, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile)); state.authority.catalogName = 'tampered.json';
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    await assert.rejects(processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => success(item) }), /checkpoint integrity/);

    const g = fixture(t); const completed = await processApi.runConferenceProcess(options, { ...g.deps,
        processPaper: async (_context, _shared, item) => success(item) });
    const completedDirectory = path.join(g.files.conferenceProcessDir, completed.processId);
    const receiptFile = path.join(completedDirectory, 'completion-receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptFile)); receipt.aggregate.aggregateId = H('tampered');
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.throws(() => cli.processStatus(options, { dependencies: g.deps }), /completion receipt/);
});

test('automated source acceptance is explicit and cannot be called a manual review', () => {
    const members = [{ paperId: 'conference:odyssey:2026:conference-paper-id:a.1',
        sourceIdentity: 'conference-paper-id:a.1', receiptName: 'a-receipt.json' }];
    const value = staging.normalizeExtractionManifest({ contract: staging.AUTOMATED_EXTRACTION_CONTRACT,
        version: staging.VERSION, conference: { id: 'odyssey-2026', year: 2026 }, acceptance: {
            method: 'official-proceedings-exact-pdf-v1', catalogSha256: H('catalog'),
            selectionReceiptSha256: H('selection') }, members, membersSha256: staging.stableHash(members) });
    assert.equal(value.review, undefined); assert.equal(value.acceptance.method, 'official-proceedings-exact-pdf-v1');
    assert.throws(() => staging.normalizeExtractionManifest({ ...value,
        acceptance: { ...value.acceptance, method: 'manual-review' } }), /method is unsupported/);
});

test('real official exact-PDF source seal reaches authenticated staging/import/plan without a human review claim', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-process-source-seal-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const names = ['catalogs', 'reports', 'filters', 'specs', 'source', 'staging', 'cache', 'ledgers',
        'runs', 'analysis', 'pages', 'aggregates', 'processes', 'pdf'];
    for (const name of names) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const metadataFile = path.join(root, 'metadata.json'); const pdfRoot = path.join(root, 'pdf');
    const record = { id: 'ando26_odyssey', title: 'Fixture audio paper', authors: ['A. Author'],
        abstract: 'Speech processing evidence.', pdfFile: 'papers/ando26_odyssey.pdf',
        recordUrl: 'https://www.isca-archive.org/odyssey_2026/ando26_odyssey.html',
        pdfUrl: 'https://www.isca-archive.org/odyssey_2026/ando26_odyssey.pdf', doi: null, track: 'Main' };
    fs.writeFileSync(metadataFile, JSON.stringify({ conference: { id: 'odyssey-2026', year: 2026 }, papers: [record] }));
    fs.mkdirSync(path.join(pdfRoot, 'papers')); fs.writeFileSync(path.join(pdfRoot, record.pdfFile),
        extractionFixture.buildPdf(record.title, 150));
    const found = discovery.discoverConference({ adapter: 'official-proceedings', conferenceId: 'odyssey-2026',
        year: 2026, metadataFile, pdfRoot });
    fs.writeFileSync(path.join(root, 'catalogs', 'catalog.json'), discovery.canonicalBytes(found.manifest));
    fs.writeFileSync(path.join(root, 'reports', 'report.json'), discovery.canonicalBytes(found.report));
    const discoveryHandle = discovery.loadDiscoveryHandle(path.join(root, 'catalogs', 'catalog.json'),
        path.join(root, 'reports', 'report.json'));
    const { evidenceHandle } = evidenceFixture.createEvidenceHandle({ root, discoveryHandle,
        now: '2026-09-09T00:00:00.000Z' });
    const filterId = '11111111-1111-4111-8111-111111111111'; const stamp = '2026-09-09T00:00:00.000Z';
    let state = filter.prepareFilter({ filterRoot: path.join(root, 'filters'), discoveryHandle, evidenceHandle,
        filterId, now: stamp,
        spec: evidenceFixture.createFilterSpec({ discoveryHandle, evidenceHandle }) });
    const paperId = Object.keys(state.decisions)[0]; const artifact = filter.buildDecisionArtifact({ state, paperId,
        operationId: '22222222-2222-4222-8222-222222222222', actor: { type: 'manual', id: 'filter-reviewer' },
        model: null, endpointProtocol: 'manual', requestBytes: 'filter request', responseBytes: 'included',
        status: 'included', reason: 'audio paper', usage: {}, now: stamp });
    const decisionFile = filter.writeDecisionArtifact({ filterRoot: path.join(root, 'filters'), filterId,
        decisionName: 'included.json', artifact });
    filter.applyDecision({ filterRoot: path.join(root, 'filters'), filterId,
        decisionHandle: filter.loadDecisionHandle(decisionFile), owner: 'filter-reviewer', now: stamp });
    const taxonomy = path.join(root, 'taxonomy.json'); fs.writeFileSync(taxonomy, '{"version":"taxonomy-v1"}\n');
    const files = { conferenceDiscoveryCatalogDir: path.join(root, 'catalogs'),
        conferenceDiscoveryReportDir: path.join(root, 'reports'), conferenceFiltersDir: path.join(root, 'filters'),
        conferenceStagingSpecsDir: path.join(root, 'specs'), conferenceStagingSourceDir: path.join(root, 'source'),
        conferenceStagingDir: path.join(root, 'staging'), conferenceSourceCacheDir: path.join(root, 'cache'),
        conferenceSourceLedgerDir: path.join(root, 'ledgers'), conferenceRunsDir: path.join(root, 'runs'),
        conferenceAnalysisDir: path.join(root, 'analysis'), conferencePageStagingDir: path.join(root, 'pages'),
        conferenceAggregateDir: path.join(root, 'aggregates'), conferenceProcessDir: path.join(root, 'processes'),
        taxonomyRegistry: taxonomy };
    const deps = { ...processApi.defaultDependencies(), files,
        execFileSync: (_command, args, options) => {
            const code = 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[3]); from conference_extractor import run_extraction; run_extraction(sys.argv[1], apply=True, source_root=Path(sys.argv[2]))';
            return childProcess.execFileSync('bash', [args[0], '-c', code, args.at(-1), files.conferenceStagingSourceDir,
                path.join(__dirname, '..', 'scripts')], options);
        } };
    const context = processApi.loadAuthority({ catalogName: 'catalog.json', reportName: 'report.json', filterId }, deps);
    const shared = processApi.prepareShared(context, deps, stamp);
    assert.equal(shared.sealed.length, 1); assert.match(shared.sealed[0].proof.verificationSha256, /^[a-f0-9]{64}$/);
    const seal = JSON.parse(fs.readFileSync(path.join(files.conferenceStagingSpecsDir, shared.names.extraction)));
    assert.equal(seal.contract, staging.AUTOMATED_EXTRACTION_CONTRACT); assert.equal(seal.review, undefined);
    const stagingReceipt = JSON.parse(fs.readFileSync(path.join(files.conferenceStagingDir, shared.names.stagingReceipt)));
    assert.equal(stagingReceipt.extraction.acceptance.method, 'official-proceedings-exact-pdf-v1');
    assert.equal(stagingReceipt.extraction.review, undefined);
    assert.ok(fs.existsSync(path.join(files.conferenceSourceLedgerDir, shared.names.ledger)));
    assert.ok(fs.existsSync(path.join(files.conferenceRunsDir, shared.names.run)));
});

test('CLI caps concurrency and disables the old new-conference bypasses', () => {
    const parsed = cli.parseArgs(['--apply', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', '11111111-1111-4111-8111-111111111111', '--concurrency', '3']);
    assert.equal(parsed.concurrency, 3);
    assert.throws(() => cli.parseArgs(['--apply', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', '11111111-1111-4111-8111-111111111111', '--concurrency', '4']), /Use/);
    assert.throws(() => cli.parseArgs(['--legacy-disabled', 'analyze']), /must use conference:new:process/);
});

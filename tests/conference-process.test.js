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
    const deps = { files, engine, now: () => new Date(Date.parse('2026-09-09T00:00:00.000Z') + tick++ * 1000).toISOString(),
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
    const second = await processApi.runConferenceProcess({ ...options, retryFailed: true }, { ...f.deps, processPaper: worker });
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

test('real official exact-PDF source seal reaches authenticated staging/import/plan without a human review claim', async t => {
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

    // Simulate an obsolete pin. Its bytes are never accepted as current evidence:
    // the new bundle must be regenerated from the independently authenticated PDF.
    const oldReceiptFile = path.join(files.conferenceStagingSourceDir, shared.sealed[0].receiptName);
    const oldReceipt = JSON.parse(fs.readFileSync(oldReceiptFile)); oldReceipt.extractor.version = '0.0.0';
    delete oldReceipt.receiptSha256; oldReceipt.receiptSha256 = H(oldReceipt);
    const oldBytes = Buffer.from(JSON.stringify(oldReceipt)); fs.writeFileSync(oldReceiptFile, oldBytes);
    const analysisSentinel = path.join(files.conferenceAnalysisDir, 'preserved-analysis.json');
    fs.writeFileSync(analysisSentinel, '{"analysis":"must remain byte-identical"}', { mode: 0o600 });
    let extractions = 0;
    const upgradedDeps = { ...deps, execFileSync: (...args) => { extractions += 1; return deps.execFileSync(...args); } };
    // Historical process fixture binds the old receipt, while production sealer
    // must authenticate a newly extracted generation for the explicit fork.
    const legacyShared = structuredClone({ ...shared, planHandle: undefined });
    legacyShared.planHandle = shared.planHandle;
    legacyShared.sealed[0].proof.receiptSha256 = oldReceipt.receiptSha256;
    const origin = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, { ...deps,
        loadAuthority: () => context, now: () => stamp, prepareShared: async () => legacyShared,
        aggregate: async () => ({ manifest: { aggregateId: H('old aggregate').slice(0, 32),
            manifestSha256: H('old aggregate manifest'), markdownSha256: H('old aggregate page'), pagePath: 'content/posts/old-conference.md' } }),
        processPaper: async (_c, _s, item) => success(item) });
    const originalStateFile = path.join(files.conferenceProcessDir, origin.processId, 'state.json');
    const originalStateBytes = fs.readFileSync(originalStateFile);
    const upgradeApi = require('../scripts/lib/conference-source-upgrade.js');
    const upgradeOptions = { fromProcessId: origin.processId, concurrency: 1 };
    let modelCalls = 0;
    const forkDeps = { ...upgradedDeps, loadAuthority: () => context, processPaper: async (_c, newShared, item) => {
        modelCalls += 1;
        assert.notEqual(item.analysisRunId, Object.values(JSON.parse(originalStateBytes).items)[0].analysisRunId);
        assert.equal(newShared.sealed[0].proof.pdfSha256, legacyShared.sealed[0].proof.pdfSha256);
        assert.notEqual(newShared.sealed[0].proof.receiptSha256, legacyShared.sealed[0].proof.receiptSha256);
        if (modelCalls === 1) throw new Error('fixture interrupted Reader');
        return success(item);
    } };
    const beforeFiles = fs.readdirSync(files.conferenceStagingSourceDir).sort();
    const upgradePlan = upgradeApi.planSourceUpgrade(upgradeOptions, forkDeps);
    assert.deepEqual(fs.readdirSync(files.conferenceStagingSourceDir).sort(), beforeFiles);
    assert.equal(upgradePlan.papers[0].extractionUpgradeRequired, true); assert.equal(modelCalls, 0);
    assert.equal(extractions, 0);
    await assert.rejects(upgradeApi.applySourceUpgrade({ ...upgradeOptions, planSha256: upgradePlan.planSha256,
        paperIds: [paperId] }, forkDeps), /authorize-new-analysis/);
    await assert.rejects(upgradeApi.applySourceUpgrade({ ...upgradeOptions, authorizeNewAnalysis: true,
        planSha256: H('stale plan'), paperIds: [paperId] }, forkDeps), /plan drifted/);
    const authorized = { ...upgradeOptions, authorizeNewAnalysis: true, planSha256: upgradePlan.planSha256, paperIds: [paperId] };
    const fork = await upgradeApi.applySourceUpgrade(authorized, forkDeps);
    assert.equal(fork.status, 'partial'); assert.equal(fork.conferenceCompletion, false); assert.equal(modelCalls, 1);
    assert.equal((await upgradeApi.applySourceUpgrade(authorized, forkDeps)).status, 'partial'); assert.equal(modelCalls, 1);
    assert.equal((await upgradeApi.applySourceUpgrade({ ...authorized, retryFailed: true }, forkDeps)).status, 'complete'); assert.equal(modelCalls, 2);
    assert.equal((await upgradeApi.applySourceUpgrade(authorized, forkDeps)).status, 'complete'); assert.equal(modelCalls, 2);
    assert.deepEqual(fs.readFileSync(originalStateFile), originalStateBytes);
    assert.deepEqual(fs.readFileSync(oldReceiptFile), oldBytes);
    const upgraded = processApi.prepareShared(context, upgradedDeps, stamp);
    assert.equal(extractions, 1); assert.notEqual(upgraded.sealed[0].receiptName, shared.sealed[0].receiptName);
    assert.notEqual(upgraded.names.plan, shared.names.plan); assert.notEqual(upgraded.sourceCacheRoot, shared.sourceCacheRoot);
    assert.equal(fs.readFileSync(analysisSentinel, 'utf8'), '{"analysis":"must remain byte-identical"}');
    const replayed = processApi.prepareShared(context, upgradedDeps, stamp);
    assert.equal(extractions, 1); assert.equal(replayed.planReceiptSha256, upgraded.planReceiptSha256);
    const sealedPdfFile = path.join(files.conferenceStagingSourceDir,
        processApi.sourceNames(paperId, context.authority.implementationSha256).pdf);
    fs.writeFileSync(sealedPdfFile, 'corrupt sealed PDF');
    assert.throws(() => processApi.prepareShared(context, upgradedDeps, stamp), /PDF SHA drifted/);
    assert.equal(extractions, 1);
});

test('CLI caps concurrency and disables the old new-conference bypasses', () => {
    const parsed = cli.parseArgs(['--apply', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', '11111111-1111-4111-8111-111111111111', '--concurrency', '3']);
    assert.equal(parsed.concurrency, 3);
    assert.throws(() => cli.parseArgs(['--apply', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', '11111111-1111-4111-8111-111111111111', '--concurrency', '4']), /Use/);
    assert.throws(() => cli.parseArgs(['--legacy-disabled', 'analyze']), /must use conference:new:process/);
});

test('401 balance failure stops dispatch, survives resume and explicitly releases only unfinished work', async t => {
    const f = fixture(t, 5); const options = { apply: true, concurrency: 1 };
    let calls = 0;
    const worker = async (_context, _shared, item) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('HTTP 401: Insufficient balance https://billing.invalid'),
            { code: 'MODEL_HTTP_NON_RETRYABLE', retryable: false });
        return success(item);
    };
    const first = await processApi.runConferenceProcess(options, { ...f.deps, processPaper: worker });
    assert.equal(calls, 2); assert.equal(first.stopped, true); assert.equal(first.batchFailure.category, 'quota');
    assert.equal(first.batchFailure.code, 'MODEL_HTTP_NON_RETRYABLE');
    assert.doesNotMatch(first.batchFailure.message, /https:/);
    const again = await processApi.runConferenceProcess(options, { ...f.deps,
        prepareShared: () => assert.fail('blocked batch must stop before shared preparation'), processPaper: worker });
    assert.equal(again.stopped, true); assert.equal(calls, 2);
    const resumed = await processApi.runConferenceProcess({ ...options, retryFailed: true }, { ...f.deps, processPaper: worker });
    assert.equal(resumed.status, 'complete'); assert.equal(calls, 6);
});

test('ordinary retry observes cooldown and capped attempts, explicit release retains failure history', async t => {
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    let now = Date.parse('2026-09-09T00:00:00Z'), calls = 0;
    const deps = { ...f.deps, now: () => new Date(now).toISOString(), processPaper: async () => {
        calls += 1; throw new Error('fixture paper validation failed');
    } };
    const first = await processApi.runConferenceProcess(options, deps);
    await processApi.runConferenceProcess(options, deps); assert.equal(calls, 1);
    for (let n = 0; n < 4; n += 1) { now += 3600000; await processApi.runConferenceProcess(options, deps); }
    assert.equal(calls, 3);
    await processApi.runConferenceProcess({ ...options, retryFailed: true }, deps); assert.equal(calls, 4);
    const state = JSON.parse(fs.readFileSync(path.join(f.files.conferenceProcessDir, first.processId, 'state.json')));
    const item = Object.values(state.items)[0];
    assert.equal(item.retryReleases[0].attempts, 3); assert.match(item.retryReleases[0].previousFailure.message, /validation/);
});

test('partial adapter failure preserves canonical error classification', async t => {
    const f = fixture(t);
    const deps = { ...f.deps, adapter: {
        prepareConferenceAnalysis: () => {}, analyzeConference: async () => ({ status: 'partial' }),
        loadConferenceAnalysis: () => ({ analysis: { papers: [{ latestAnalysisAttemptError: 'HTTP 401: Insufficient balance',
            latestAnalysisAttemptErrorCode: 'MODEL_HTTP_NON_RETRYABLE', latestAnalysisAttemptRetryable: false }] } })
    } };
    await assert.rejects(processApi.processOne(f.context, { planHandle: {} }, { ...f.members[0], analysisRunId: 'fixture' }, deps),
        error => error.message.includes('Insufficient balance') && error.code === 'MODEL_HTTP_NON_RETRYABLE' && error.retryable === false);
});

test('implementation migration remains addressable and never reanalyzes completed papers', async t => {
    const migration = require('../scripts/migrate-conference-process.js');
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_c, _s, item) => success(item) });
    const oldImplementation = f.authority.implementationSha256;
    f.context.authority = { ...f.authority, implementationSha256: H('new implementation') };
    f.runtimeAuthority.implementationSha256 = f.context.authority.implementationSha256;
    assert.throws(() => cli.processStatus(options, { dependencies: f.deps }), /migrate with --from/);
    // A previously created empty fork must not hide the migrated completed run.
    const dormant = JSON.parse(fs.readFileSync(path.join(f.files.conferenceProcessDir, first.processId, 'state.json')));
    dormant.authority = f.context.authority;
    dormant.processId = processApi.deterministicUuid(H(dormant.authority), 'conference-process-v1');
    dormant.status = 'pending'; dormant.aggregate = null; dormant.completionReceiptSha256 = null;
    for (const item of Object.values(dormant.items)) {
        Object.assign(item, { analysisRunId: processApi.deterministicUuid(dormant.processId, item.paperId, 'analysis'),
            status: 'pending', attempts: 0, sourceProof: null, analysisProof: null, pageProof: null });
    }
    dormant.stateSha256 = processApi.stateDigest(dormant);
    fs.mkdirSync(path.join(f.files.conferenceProcessDir, dormant.processId), { mode: 0o700 });
    fs.writeFileSync(path.join(f.files.conferenceProcessDir, dormant.processId, 'state.json'), JSON.stringify(dormant), { mode: 0o600 });
    const deps = { ...f.deps, processPaper: () => assert.fail('must not repeat completed analysis'),
        postprocess: { stagePaper: ({ executionId }) => ({ status: 'staged', manifest: {
            ...success(f.members[0]).pageProof, manifestSha256: H(executionId) } }) } };
    const migrated = await migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: deps });
    assert.equal(migrated.processId, first.processId); assert.equal(migrated.status, 'complete');
    assert.equal(cli.processStatus(options, { dependencies: deps }).processId, first.processId);
    const resumed = await processApi.runConferenceProcess(options, { ...deps, prepareShared: async (context, ...rest) => {
        assert.equal(context.authority.implementationSha256, oldImplementation); return f.deps.prepareShared(context, ...rest);
    } });
    assert.equal(resumed.status, 'complete'); assert.equal(resumed.processId, first.processId);
});

test('workers drain in-flight work but do not dispatch after a systemic failure', async t => {
    const f = fixture(t, 7); let calls = 0;
    let release; const inFlight = new Promise(resolve => { release = resolve; });
    const result = await processApi.runConferenceProcess({ apply: true, concurrency: 3 }, { ...f.deps,
        processPaper: async (_c, _s, item) => {
            const call = ++calls;
            if (call === 1) { await Promise.resolve(); release(); throw new Error('HTTP 503: service unavailable'); }
            await inFlight; return success(item);
        } });
    assert.equal(result.stopped, true); assert.equal(result.batchFailure.category, 'transport');
    assert.equal(calls, 3); assert.equal(result.complete, 2);
});

test('single-paper demo failure does not stop the conference batch', async t => {
    const f = fixture(t, 4); let calls = 0;
    const result = await processApi.runConferenceProcess({ apply: true, concurrency: 2 }, { ...f.deps,
        processPaper: async (_context, _shared, item) => {
            calls += 1;
            if (item.paperId === f.members[0].paperId) {
                throw Object.assign(new Error('Demo 页面瞬时访问失败: getaddrinfo ENOTFOUND demo.example'), {
                    code: 'DEMO_TRANSIENT_FAILURE', retryable: true });
            }
            return success(item);
        } });
    assert.equal(calls, 4);
    assert.notEqual(result.stopped, true);
    assert.equal(result.batchFailure, undefined);
    assert.equal(result.complete, 3);
});

test('exhausted model network failure does not stop later conference papers', async t => {
    const f = fixture(t, 3); let calls = 0;
    const result = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, { ...f.deps,
        processPaper: async (_context, _shared, item) => {
            calls += 1;
            if (item.paperId === f.members[0].paperId) {
                throw Object.assign(new Error('aborted'), { code: 'ECONNRESET', retryable: false });
            }
            return success(item);
        } });
    assert.equal(calls, 3);
    assert.notEqual(result.stopped, true);
    assert.equal(result.batchFailure, undefined);
    assert.equal(result.complete, 2);
});

test('migration provenance survives a crash between state and migration receipt', async t => {
    const migration = require('../scripts/migrate-conference-process.js');
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const deps = { ...f.deps, processPaper: async (_c, _s, item) => success(item),
        postprocess: { stagePaper: () => ({ status: 'staged', manifest: success(f.members[0]).pageProof }) } };
    const first = await processApi.runConferenceProcess(options, deps);
    f.context.authority = { ...f.authority, implementationSha256: H('migration crash target') };
    f.runtimeAuthority.implementationSha256 = f.context.authority.implementationSha256;
    const exactFile = processApi.exactFile;
    processApi.exactFile = (filename, bytes) => {
        if (filename.endsWith('implementation-migration.json')) throw new Error('fixture power loss');
        return exactFile(filename, bytes);
    };
    try {
        await assert.rejects(migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: deps }), /power loss/);
    } finally { processApi.exactFile = exactFile; }
    const resumed = await migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: {
        ...deps, processPaper: () => assert.fail('completed analysis must survive migration crash') } });
    assert.equal(resumed.status, 'complete');
    assert.equal(cli.processStatus(options, { dependencies: deps }).processId, first.processId);
});

test('legacy partial imports canonical 401 classification before any model or source preparation', async t => {
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: () => { throw new Error('analysis remained partial'); } });
    const filename = path.join(f.files.conferenceProcessDir, first.processId, 'state.json');
    const state = JSON.parse(fs.readFileSync(filename)); const item = Object.values(state.items)[0];
    delete item.lastFailure; delete item.retryNotBefore;
    state.stateSha256 = processApi.stateDigest(state); fs.writeFileSync(filename, JSON.stringify(state));
    f.files.conferenceAnalysisDir = path.join(f.root, 'analyses');
    const directory = path.join(f.files.conferenceAnalysisDir, item.analysisRunId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'analysis.json'), JSON.stringify({ papers: [{ error: 'HTTP 401: Insufficient balance',
        latestAnalysisAttemptErrorCode: 'MODEL_HTTP_NON_RETRYABLE', latestAnalysisAttemptRetryable: false }] }), { mode: 0o600 });
    const result = await processApi.runConferenceProcess(options, { ...f.deps,
        prepareShared: () => assert.fail('must not prepare blocked legacy process'),
        processPaper: () => assert.fail('must not call model for legacy 401') });
    assert.equal(result.stopped, true); assert.equal(result.batchFailure.category, 'quota');
});

test('source generation upgrade never resets an existing analysis on plan mismatch', async t => {
    const f = fixture(t); f.files.conferenceAnalysisDir = path.join(f.root, 'analyses');
    const executionId = '11111111-1111-4111-8111-111111111111';
    const directory = path.join(f.files.conferenceAnalysisDir, executionId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'run.json'), 'preserve old run');
    await assert.rejects(processApi.processOne(f.context, { sourceGenerationChanged: true }, {
        ...f.members[0], analysisRunId: executionId
    }, { ...f.deps, adapter: {
        loadConferenceAnalysis: () => ({}), verifyPlanAuthority: () => { throw new Error('old source snapshot'); },
        prepareConferenceAnalysis: () => assert.fail('must not reset analysis'),
        analyzeConference: () => assert.fail('must not call model')
    } }), error => error.code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED' && error.retryable === false);
    assert.equal(fs.readFileSync(path.join(directory, 'run.json'), 'utf8'), 'preserve old run');
});

test('retry release is an explicit apply-only CLI flag', () => {
    const args = ['--catalog', 'catalog.json', '--report', 'report.json', '--filter', '11111111-1111-4111-8111-111111111111'];
    assert.equal(cli.parseArgs(['--apply', '--retry-failed', ...args]).retryFailed, true);
    assert.throws(() => cli.parseArgs(['--status', ...args, '--retry-failed']), /Use/);
    assert.throws(() => cli.parseArgs(['--apply', ...args, '--retry-failed', '--retry-failed']), /Use/);
    assert.equal(require('../scripts/migrate-conference-process.js').parseArgs(['--apply', ...args,
        '--from', '11111111-1111-4111-8111-111111111111', '--retry-failed']).retryFailed, true);
});

test('multi-hop legacy migrations trace receipt parents to the UUID-bound origin', async t => {
    const migration = require('../scripts/migrate-conference-process.js');
    const recovery = require('../scripts/lib/conference-process-recovery.js');
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const sources = [];
    const deps = { ...f.deps, prepareShared: async (context, ...rest) => {
        sources.push(context.authority.implementationSha256); return f.deps.prepareShared(context, ...rest);
    }, processPaper: async (_c, _s, item) => success(item),
    postprocess: { stagePaper: () => ({ status: 'staged', manifest: success(f.members[0]).pageProof }) } };
    const first = await processApi.runConferenceProcess(options, deps);
    const origin = f.authority.implementationSha256;
    const directory = path.join(f.files.conferenceProcessDir, first.processId);
    const versions = [origin];
    // Exercise twelve hops, including legacy receipts with immediate parents.
    for (let index = 1; index <= 12; index += 1) {
        const implementation = H(`multi-hop-${index}`); versions.push(implementation);
        f.context.authority = { ...f.authority, implementationSha256: implementation };
        f.runtimeAuthority.implementationSha256 = implementation;
        await migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: deps });
        const receiptFile = path.join(directory, index === 1 ? 'implementation-migration.json'
            : `implementation-migration-${implementation.slice(0, 12)}.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptFile)); receipt.fromImplementationSha256 = versions[index - 1];
        delete receipt.receiptSha256; receipt.receiptSha256 = H(receipt);
        fs.writeFileSync(receiptFile, JSON.stringify(receipt));
        const stateFile = path.join(directory, 'state.json'); const state = JSON.parse(fs.readFileSync(stateFile));
        delete state.sourceImplementationSha256; state.stateSha256 = processApi.stateDigest(state);
        fs.writeFileSync(stateFile, JSON.stringify(state));
        assert.equal(recovery.sourceImplementation(state, directory, processApi), origin);
        assert.equal(cli.processStatus(options, { dependencies: deps }).processId, first.processId);
    }
    assert.ok(sources.every(source => source === origin));
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
    const middleFile = path.join(directory, `implementation-migration-${versions[6].slice(0, 12)}.json`);
    const middleBytes = fs.readFileSync(middleFile); const middle = JSON.parse(middleBytes);
    middle.fromImplementationSha256 = versions[12]; delete middle.receiptSha256; middle.receiptSha256 = H(middle);
    fs.writeFileSync(middleFile, JSON.stringify(middle));
    assert.throws(() => recovery.sourceImplementation(state, directory, processApi), /cycle/);
    fs.writeFileSync(middleFile, middleBytes); fs.renameSync(middleFile, `${middleFile}.unavailable`);
    assert.throws(() => recovery.sourceImplementation(state, directory, processApi), /missing or ambiguous/);
});

test('changed text or artifacts reject complete proof reuse before models or migration mutation', async t => {
    const migration = require('../scripts/migrate-conference-process.js');
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_c, _s, item) => success(item) });
    const stateFile = path.join(f.files.conferenceProcessDir, first.processId, 'state.json');
    const original = fs.readFileSync(stateFile);
    for (const field of ['textSha256', 'artifactsSha256']) {
        const deps = { ...f.deps, prepareShared: async (...args) => {
            const shared = await f.deps.prepareShared(...args); shared.sealed[0].proof[field] = H(`changed-${field}`); return shared;
        }, processPaper: () => assert.fail('must not call model'),
        postprocess: { stagePaper: () => assert.fail('must not restage inconsistent complete proof') } };
        await assert.rejects(processApi.runConferenceProcess(options, deps),
            error => error.code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED');
        assert.deepEqual(fs.readFileSync(stateFile), original);
        f.context.authority = { ...f.authority, implementationSha256: H(`migration-${field}`) };
        f.runtimeAuthority.implementationSha256 = f.context.authority.implementationSha256;
        await assert.rejects(migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: deps }),
            error => error.code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED');
        assert.deepEqual(fs.readFileSync(stateFile), original);
        f.context.authority = f.authority; f.runtimeAuthority.implementationSha256 = f.authority.implementationSha256;
    }
});

test('source upgrade authorizes only an explicit subset and preserves unselected and original results', async t => {
    const upgrade = require('../scripts/lib/conference-source-upgrade.js');
    const f = fixture(t, 3); const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    f.files.conferenceStagingSourceDir = path.join(f.root, 'sources'); f.files.conferenceAnalysisDir = path.join(f.root, 'analysis');
    fs.mkdirSync(f.files.conferenceStagingSourceDir, { mode: 0o700 }); fs.mkdirSync(f.files.conferenceAnalysisDir, { mode: 0o700 });
    const sources = [];
    for (const member of f.members) {
        const names = processApi.sourceNames(member.paperId, f.authority.implementationSha256);
        const bytes = { metadata: Buffer.from('{}'), request: Buffer.from('{}'), text: Buffer.from('historical text'),
            artifacts: Buffer.from('{}'), pdf: extractionFixture.buildPdf(member.paperId) };
        const body = { paperId: member.paperId, sourceIdentity: member.sourceIdentity, version: 2,
            extractor: { version: '0.0.0', backend: { version: 'old' } } };
        const receipt = { ...body, receiptSha256: H(body) }; bytes.receipt = Buffer.from(JSON.stringify(receipt));
        for (const [key, value] of Object.entries(bytes)) fs.writeFileSync(path.join(f.files.conferenceStagingSourceDir, names[key]), value, { mode: 0o600 });
        sources.push({ paperId: member.paperId, proof: { pdfSha256: digest(bytes.pdf), textSha256: digest(bytes.text),
            artifactsSha256: digest(bytes.artifacts), requestSha256: digest(bytes.request), receiptSha256: receipt.receiptSha256,
            verificationSha256: H('historical verification') } });
    }
    let creatingNewGeneration = false, calls = []; const stagedByExecution = new Map();
    f.files.conferencePageStagingDir = path.join(f.root, 'pages'); f.files.conferenceAggregateDir = path.join(f.root, 'aggregates');
    const deps = { ...f.deps, discovery: { MAX_PDF_BYTES: discovery.MAX_PDF_BYTES,
        safeAbsoluteFile: discovery.safeAbsoluteFile,
        replayDiscoveryMember: (_handle, identity) => ({ match: { kind: 'exact', candidates: [{ sha256:
            sources[f.members.findIndex(member => member.sourceIdentity === identity)].proof.pdfSha256 }] } }) },
    prepareShared: async () => ({ planHandle: {}, planReceiptSha256: H('plan'), sealed: sources.map(source => ({
        ...source, proof: { ...source.proof, ...(creatingNewGeneration ? { receiptSha256: H(`new ${source.paperId}`) } : {}) } })) }),
    processPaper: async (_c, _s, item) => {
        calls.push(item.paperId); if (!creatingNewGeneration) return success(item);
        const prior = success(item);
        const markdown = `---\npaper_digest_paper_id: "${item.paperId}"\npaper_digest_source_kind: conference\npaper_digest_conference_id: "odyssey-2026"\n---\nFixture new Reader\n`;
        const body = { contract: 'conference-paper-page-staging-v1', version: 1, status: 'complete', paperId: item.paperId,
            analysisExecutionId: item.analysisRunId, ...prior.analysisProof,
            contentSha256: digest(Buffer.from(markdown)), pagePath: prior.pageProof.pagePath, assets: [] };
        const manifest = { ...body, manifestSha256: H(body) }; stagedByExecution.set(item.analysisRunId, manifest);
        const folder = path.join(f.files.conferencePageStagingDir, item.analysisRunId); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
        fs.writeFileSync(path.join(folder, 'page.md'), markdown, { mode: 0o600 });
        return { analysisProof: prior.analysisProof, pageProof: { manifestSha256: manifest.manifestSha256,
            contentSha256: manifest.contentSha256, pagePath: manifest.pagePath } };
    }, postprocess: { stagePaper: ({ executionId }) => ({ status: 'staged', manifest: stagedByExecution.get(executionId) }) },
    aggregate: async (...args) => {
        if (!creatingNewGeneration) return f.deps.aggregate(...args);
        const ids = args[2]; const markdown = '---\npaper_digest_page_type: index\nslug: conference-odyssey-2026\n---\nAll upgraded papers\n';
        const body = { contract: 'conference-aggregate-staging-v1', version: 1, status: 'complete', conferenceId: 'odyssey-2026',
            aggregateId: H(ids).slice(0, 32), pagePath: 'content/posts/conference-odyssey-2026.md', markdown,
            markdownSha256: digest(Buffer.from(markdown)) };
        const manifest = { ...body, manifestSha256: H(body) };
        const folder = path.join(f.files.conferenceAggregateDir, 'odyssey-2026', manifest.aggregateId);
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
        fs.writeFileSync(path.join(folder, 'aggregate.md'), markdown, { mode: 0o600 }); return { manifest };
    } };
    const original = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, deps);
    const originalFile = path.join(f.files.conferenceProcessDir, original.processId, 'state.json'), originalBytes = fs.readFileSync(originalFile);
    creatingNewGeneration = true; calls = [];
    const options = { fromProcessId: original.processId, concurrency: 1 };
    const plan = upgrade.planSourceUpgrade(options, deps); assert.equal(plan.papers.length, 3);
    await assert.rejects(upgrade.applySourceUpgrade({ ...options, authorizeNewAnalysis: true, planSha256: plan.planSha256,
        paperIds: ['conference:odyssey:2026:conference-paper-id:unknown'] }, deps), /not in the authorized plan/);
    const selected = f.members[1].paperId;
    const result = await upgrade.applySourceUpgrade({ ...options, authorizeNewAnalysis: true,
        planSha256: plan.planSha256, paperIds: [selected] }, deps);
    assert.equal(result.status, 'complete'); assert.deepEqual(calls, [selected]);
    const state = JSON.parse(fs.readFileSync(result.stateFile)); assert.deepEqual(Object.keys(state.items), [selected]);
    assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
    await assert.rejects(upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256 }, deps), /requires all conference members/);
    const remaining = f.members.map(item => item.paperId).filter(id => id !== selected);
    await upgrade.applySourceUpgrade({ ...options, authorizeNewAnalysis: true, planSha256: plan.planSha256, paperIds: remaining }, deps);
    const beforePromotionCalls = calls.length;
    const promoted = await upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256 }, deps);
    assert.equal(promoted.conferenceCompletion, true); assert.equal(promoted.papers, 3); assert.equal(calls.length, beforePromotionCalls);
    assert.notEqual(promoted.processId, original.processId);
    const promotedStateFile = path.join(f.files.conferenceProcessDir, promoted.processId, 'state.json');
    const promotedState = processApi.assertState(JSON.parse(fs.readFileSync(promotedStateFile)));
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(promotedStateFile), 'completion-receipt.json')));
    processApi.validateCompletionReceipt(promotedState, receipt);
    assert.equal(cli.processStatus(options, { dependencies: deps }).processId, promoted.processId);
    assert.equal((await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, deps)).processId, promoted.processId);
    assert.equal((await upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256 }, deps)).processId, promoted.processId);
    assert.equal(calls.length, beforePromotionCalls); assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
    const code = `import importlib.util,sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nspec=importlib.util.spec_from_file_location('publisher_readonly',Path(sys.argv[1])/'publish-conference.py')\np=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(p)\np.PROCESS_ROOT=Path(sys.argv[2]);p.PAGE_ROOT=Path(sys.argv[3]);p.AGGREGATE_ROOT=Path(sys.argv[4])\nb=p.process_bundle('odyssey-2026',sys.argv[5])\nprint(json.dumps({'files':len(b['files']),'status':b['state']['status']}))`;
    const publisherRead = childProcess.execFileSync('bash', [path.join(__dirname, '..', 'scripts', 'python-runtime.sh'), '-c', code,
        path.join(__dirname, '..', 'scripts'), f.files.conferenceProcessDir, f.files.conferencePageStagingDir,
        f.files.conferenceAggregateDir, promoted.processId], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(publisherRead), { files: 4, status: 'complete' });
    const authArgs = ['--catalog', 'catalog.json', '--report', 'report.json', '--filter', f.authority.filterId,
        '--from', original.processId];
    assert.equal(cli.parseArgs(['--source-upgrade-plan', ...authArgs]).sourceUpgrade, 'plan');
    assert.throws(() => cli.parseArgs(['--source-upgrade-apply', ...authArgs]), /Use/);
    const parsed = cli.parseArgs(['--source-upgrade-apply', ...authArgs, '--plan-sha', plan.planSha256,
        '--paper-ids', selected, '--authorize-new-analysis']);
    assert.deepEqual(parsed.paperIds, [selected]); assert.equal(parsed.authorizeNewAnalysis, true);
});

'use strict';
// Offline parameter/routing tests only. Actual source statements are exercised
// with explicit scheduling doubles; this never asserts scientific qualification.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Module = require('node:module');
const root = process.cwd();
const filename = path.join(root, 'scripts/migrate-conference-process.js');
const source = fs.readFileSync(process.env.PD_MIGRATION_CONCURRENCY_TEST_SOURCE || filename, 'utf8');
const candidate = new Module(filename, module);
candidate.filename = filename; candidate.paths = Module._nodeModulePaths(path.dirname(filename));
candidate._compile(source, filename);
const api = candidate.exports;
const deny = () => { throw Error('postprocess concurrency routing test forbids network'); };
require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny;
for (const name of ['node:http', 'node:https']) { require(name).request = deny; require(name).get = deny; }
globalThis.fetch = deny;
const argv = ['--apply', '--catalog', 'conference.json', '--report', 'report.json',
    '--filter', '11111111-1111-4111-8111-111111111111', '--from', '22222222-2222-4222-8222-222222222222'];
function fragment(start, end) {
    const a = source.indexOf(start); assert.ok(a >= 0, 'actual source fragment begins');
    const b = source.indexOf(end, a); assert.ok(b > a, 'actual source fragment ends');
    return source.slice(a, b);
}
const effective = source.match(/const postprocessConcurrency = options\.postprocessConcurrency \?\? options\.concurrency;/)?.[0];
assert.ok(effective);
const stageStatement = fragment('await stagePool.runStagePool(complete,',
    'if (deps.adapter.readJsonRecord(stateFile).sha256 !== before.sha256)');
const aggregateStatement = fragment('if ((retained || options.postprocessConcurrency !== undefined) && !deps.aggregate)',
    '// 实现迁移会让旧的完成凭证失效');

test('omitted flag retains old default and original concurrency object shape', () => {
    const defaults = api.parseArgs(argv);
    assert.equal(defaults.concurrency, 3);
    assert.equal(Object.hasOwn(defaults, 'postprocessConcurrency'), false);
    for (const value of [1, 3, 8, 60]) {
        const parsed = api.parseArgs([...argv, '--concurrency', String(value)]);
        assert.equal(parsed.concurrency, value);
        assert.equal(Object.hasOwn(parsed, 'postprocessConcurrency'), false);
    }
});
test('explicit 1–5 is independent of Reader/analysis concurrency including 60', () => {
    for (let n = 1; n <= 5; n++) {
        const parsed = api.parseArgs([...argv, '--concurrency', '60', '--postprocess-concurrency', String(n)]);
        assert.equal(parsed.postprocessConcurrency, n); assert.equal(parsed.concurrency, 60);
    }
});
test('CLI rejects invalid, duplicate, and missing postprocess concurrency', () => {
    for (const value of ['0', '6', '60', '-1', '1.5', '01', 'NaN', 'Infinity', '1e0', ' 1']) {
        assert.throws(() => api.parseArgs([...argv, '--postprocess-concurrency', value]), /用法/);
    }
    assert.throws(() => api.parseArgs([...argv, '--postprocess-concurrency']), /用法/);
    assert.throws(() => api.parseArgs([...argv, '--postprocess-concurrency', '1', '--postprocess-concurrency', '2']), /用法/);
});
test('direct invalid values reject before dependency loading, source, or locks', () => {
    const runtime = { get dependencies() { assert.fail('invalid option reached dependencies'); } };
    for (const value of [null, '1', 0, 6, -1, 1.5, NaN, Infinity]) {
        assert.throws(() => api.migrateAndRun({ postprocessConcurrency: value }, runtime), /1–5/);
    }
});
test('actual completed-stage call routes the override while preserving callback and stop checks', async () => {
    for (const [reader, post, expected] of [[1, 5, 5], [8, undefined, 8], [60, 1, 1]]) {
        let recorded, stops = 0, verified = 0, collected = 0;
        const item = { paperId: 'synthetic-routing-only' }, staged = { status: 'staged-double' };
        const context = { options: { concurrency: reader, ...(post === undefined ? {} : { postprocessConcurrency: post }) },
            complete: [item], init: Object.freeze({ synthetic: true }), canonicalResults: new Map(),
            deps: { files: {} }, stop: { assertMayStartRequest() { stops++; } },
            collect(actual, result, error) { assert.equal(actual, item); assert.equal(result, staged); assert.equal(error, null); collected++; },
            stagePool: { async runStagePool(items, operation) { recorded = operation.concurrency;
                assert.equal(items[0], item); operation.shouldStop(); operation.onResult(item, staged, null); },
                verifyStageResult(actual, current) { assert.equal(actual, staged); assert.equal(current, item); verified++; } } };
        await vm.runInNewContext(`(async () => { ${effective}\n${stageStatement} })()`, context);
        assert.equal(recorded, expected); assert.equal(context.options.concurrency, reader);
        assert.equal(stops, 1); assert.equal(verified, 1); assert.equal(collected, 1);
        assert.equal(context.canonicalResults.get(item.paperId), staged);
    }
});
async function aggregateCase({ retained, post, reader = 1, injected = false, preexisting = false }) {
    const calls = [], sentinel = () => 'preexisting';
    const options = { concurrency: reader, fromProcessId: 'process-routing-only',
        ...(post === undefined ? {} : { postprocessConcurrency: post }) };
    const make = kind => async (input, operation) => { calls.push({ kind, input, operation }); return { status: 'aggregate-double' }; };
    const deps = { files: { conferenceAnalysisDir: '/a', tagCatalogFile: '/tags', conferencePageStagingDir: '/stage', conferenceAggregateDir: '/agg' },
        postprocess: { aggregateConferenceParallel: make('parallel'), aggregateConference: make('injected') },
        ...(preexisting ? { aggregate: sentinel } : {}) };
    const migrationDeps = preexisting ? { aggregate: sentinel } : {};
    const scope = { options, retained, deps, migrationDeps, runtime: injected ? { dependencies: {} } : {},
        processApi: { stableHash: () => 'authority-double' }, context: { authority: {} } };
    vm.runInNewContext(`${effective}\n${aggregateStatement}`, scope);
    const shouldInstall = (retained || post !== undefined) && !preexisting;
    if (!shouldInstall) {
        assert.equal(migrationDeps.aggregate, preexisting ? sentinel : undefined);
        return;
    }
    const shared = { planHandle: {}, sourceCacheRoot: '/sources', retainedSources: new Map() }, ids = ['execution-double'];
    await migrationDeps.aggregate({}, shared, ids);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, injected ? 'injected' : 'parallel');
    assert.equal(calls[0].operation.concurrency, post ?? reader);
    assert.equal(calls[0].operation.processId, options.fromProcessId);
    assert.equal(calls[0].operation.authoritySha256, 'authority-double');
    assert.equal(calls[0].input.executionIds, ids);
    assert.equal(calls[0].input.planHandle, shared.planHandle);
    assert.equal(calls[0].input.retainedSources, shared.retainedSources);
    assert.equal(calls[0].input.sourceRoot, shared.sourceCacheRoot);
    assert.equal(calls[0].input.apply, true);
    assert.equal(options.concurrency, reader);
}
test('retained aggregate default and explicit flag retain source authority and use only local pool override', async () => {
    await aggregateCase({ retained: true, reader: 8 });
    await aggregateCase({ retained: true, reader: 1, post: 5 });
    await aggregateCase({ retained: true, reader: 1, post: 5, injected: true });
});
test('ordinary aggregate explicit override works; omitted flag and injected override preserve old dispatch', async () => {
    await aggregateCase({ retained: false, reader: 1, post: 5 });
    await aggregateCase({ retained: false, reader: 8 });
    await aggregateCase({ retained: true, post: 5, preexisting: true });
    await aggregateCase({ retained: false, post: 5, preexisting: true });
});
test('normal maintenance and process dispatch still consume original options; model stage controls are untouched', () => {
    assert.match(source, /runReaderReviewMaintenanceBatch\(\{ manifestPath: options\.readerReviewFeedback,[\s\S]*?directory, state, shared, options \}, deps\)/);
    assert.match(source, /runConferenceProcessLocked\(grant \? \{ \.\.\.options, recoveryGrantId: grant\.grantId,[\s\S]*?\} : options,/);
    assert.equal((source.match(/concurrency: postprocessConcurrency/g) || []).length, 2,
        'override appears only in completed-page and aggregate local pool calls');
});

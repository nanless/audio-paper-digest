'use strict';
// Synthetic transport-boundary tests only. Scientific APIs are explicitly mocked;
// no authenticated source, PDF derivation, Reader completion or publication pass.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'scripts/lib');
function runBoundary(t, kind, payload, mode = 0o600) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-cli-json-boundary-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const input = path.join(directory, 'input.json'), preload = path.join(directory, 'synthetic-api.cjs');
    fs.writeFileSync(input, JSON.stringify(payload), { mode });
    // Intercept only the three named scientific/maintenance interfaces. The
    // actual CLI entry, private FD validation and deep/log-setup stay real.
    fs.writeFileSync(preload, `
'use strict';
const assert = require('node:assert/strict'), Module = require('node:module');
const originalLoad = Module._load;
const targets = ${JSON.stringify({
        crop: path.join(LIB, 'conference-publication-figure-crop.js'),
        author: path.join(LIB, 'conference-publication-author-source.js'),
        maintenance: path.join(LIB, 'conference-reader-review-maintenance.js'),
        deep: path.join(ROOT, 'scripts/deep-analyzer.js')
    })};
function syntheticResult(operation) {
    assert.equal(process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS, '1');
    const before = process.stdout.write;
    require(targets.deep);
    assert.equal(global.__PAPER_DIGEST_LOG_SETUP_DONE__, true, 'real deep logger must initialize');
    assert.notEqual(process.stdout.write, before, 'real logger must wrap stdout');
    return {synthetic:true,scientificQualification:false,operation,realDeepLoggerInitialized:true};
}
Module._load = function(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === targets.crop) return {
        derivePublicationFigureCrops: async () => syntheticResult('derive'),
        replayPublicationFigureCrops: async () => syntheticResult('replay')
    };
    if (resolved === targets.author) return {
        verifyPublicationAuthorSources: () => [syntheticResult('author')]
    };
    if (resolved === targets.maintenance) return {
        assertNoPendingReaderReviewMaintenance: () => true
    };
    return originalLoad.call(this, request, parent, isMain);
};
`, { mode: 0o600 });
    const env = { ...process.env };
    for (const key of ['NODE_TEST_CONTEXT', 'PAPER_DIGEST_TEST_ENV_FILE', 'NODE_OPTIONS', 'NODE_PATH',
        'VERIFY_PROJECT_DISABLE_FILE_LOGS', 'PAPER_DIGEST_DISABLE_FILE_LOGS', 'PD_DISABLE_FILE_LOGS']) delete env[key];
    const descriptor = fs.openSync(input, 'r');
    try {
        const result = spawnSync(process.execPath, ['--require', preload,
            path.join(LIB, kind === 'crop' ? 'conference-publication-figure-crop-replay-cli.js'
                : 'conference-publication-author-replay-cli.js'), '3'], {
            cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', descriptor],
            encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
        });
        assert.ifError(result.error);
        return result;
    } finally { fs.closeSync(descriptor); }
}
for (const [operation, payload] of [['derive', {}], ['replay', { expectedDerivation: { synthetic: true } }]]) {
    test(`synthetic private crop CLI ${operation}: real deep logger cannot prefix JSON`, t => {
        const result = runBoundary(t, 'crop', payload);
        assert.equal(result.status, 0, result.stderr);
        const expected = {synthetic:true,scientificQualification:false,operation,realDeepLoggerInitialized:true};
        assert.deepEqual(JSON.parse(result.stdout), expected);
        assert.equal(result.stdout, JSON.stringify(expected));
    });
}
test('synthetic private author CLI: real deep logger cannot prefix JSON', t => {
    const result = runBoundary(t, 'author', {runtimeRoot:'/synthetic-not-a-source',state:{processId:'synthetic'},completion:{}});
    assert.equal(result.status, 0, result.stderr);
    const expected = {verified:true,papers:[{synthetic:true,scientificQualification:false,
        operation:'author',realDeepLoggerInitialized:true}]};
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stdout, JSON.stringify(expected));
});
for (const kind of ['crop', 'author']) {
    test(`synthetic ${kind} boundary preserves rejection of public input FD`, t => {
        const result = runBoundary(t, kind, {}, 0o644);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /私有/);
        assert.doesNotMatch(result.stdout, /scientificQualification/);
    });
}

'use strict';
// DRAFT primitive guard tests. They do not manufacture or simulate successful
// authenticated PDF capability, scientific completion or publication eligibility.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../scripts/lib/conference-publication-figure-crop.js');
const sandbox = { require: createRequire(filename), __filename: filename, __dirname: path.dirname(filename), Buffer,
    module: { exports: {} }, console, structuredClone };
// Expose only private file guards in this VM test instance, never the real API.
vm.runInNewContext(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports.testOnly={regular,findBaseGeneration,selfHash,imagePath,writeImmutable,retainNonblockingObservation,validatePublicationViewRoute,operation,maintenancePublicationHistory,freezeData};', sandbox, { filename });
const api = sandbox.module.exports.testOnly;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const scratch = path.resolve(__dirname, '../../diagnostics/node-guard-fixtures');
fs.mkdirSync(scratch, { recursive: true });
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(scratch, 'guard-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const body = { contract: 'conference-blog-generation-v1', version: 2, conferenceId: 'test-2026',
        processId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', files: [], imageFiles: [] };
    const value = { ...body, generationSha256: hash(JSON.stringify(canonical(body))) };
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), physical = hash(bytes);
    fs.writeFileSync(path.join(directory, 'generation.json'), bytes, { mode: 0o600 });
    return { directory, value, bytes, physical };
}
test('real physical and semantic generation pair finds active file', t => {
    const f = fixture(t); const found = api.findBaseGeneration(f.directory, f.value.generationSha256, f.physical);
    assert.equal(found.sha256, f.physical); assert.ok(found.bytes.equals(f.bytes));
});
test('base remains readable after actual superseded archive and new active bytes', t => {
    const f = fixture(t), archived = path.join(f.directory, 'generation.superseded-' + f.physical.slice(0, 12) + '.json');
    fs.renameSync(path.join(f.directory, 'generation.json'), archived);
    const body = { changed: true }, value = { ...body, generationSha256: hash(JSON.stringify(body)) };
    fs.writeFileSync(path.join(f.directory, 'generation.json'), JSON.stringify(value));
    assert.equal(api.findBaseGeneration(f.directory, f.value.generationSha256, f.physical).filename, archived);
});
test('same semantic JSON with different physical bytes cannot substitute original file', t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.directory, 'generation.json'), JSON.stringify(f.value));
    assert.throws(() => api.findBaseGeneration(f.directory, f.value.generationSha256, f.physical), /唯一/);
});
test('duplicate real original file is rejected instead of arbitrarily selecting', t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.directory, 'generation.superseded-' + f.physical.slice(0, 12) + '.json'), f.bytes);
    assert.throws(() => api.findBaseGeneration(f.directory, f.value.generationSha256, f.physical), /唯一/);
});
test('symlink and hardlink cannot supply authoritative generation bytes', t => {
    const f = fixture(t), active = path.join(f.directory, 'generation.json'), saved = path.join(f.directory, 'saved.json');
    fs.renameSync(active, saved); fs.symlinkSync(saved, active);
    assert.throws(() => api.regular(active), /符号链接/); fs.unlinkSync(active); fs.linkSync(saved, active);
    assert.throws(() => api.regular(active), /链接数/);
});
test('new controlled PNG path preserves existing narrow path format', () => {
    assert.equal(api.imagePath('test-2026/0123456789ab/figure-2.png', 'test-2026'), 'test-2026/0123456789ab/figure-2.png');
    for (const candidate of ['test-2026/../figure-2.png', 'other/0123456789ab/figure-2.png', 'test-2026/0123456789ab/figure-2-new.png'])
        assert.throws(() => api.imagePath(candidate, 'test-2026'), /图片路径/);
});
test('immutable derived files preserve original bytes and refuse path redirection', t => {
    const f = fixture(t), target = path.join(f.directory, 'derived', 'pixels.png');
    api.writeImmutable(target, Buffer.from('exact original draft fixture'));
    api.writeImmutable(target, Buffer.from('exact original draft fixture'));
    assert.throws(() => api.writeImmutable(target, Buffer.from('different')), /不可覆盖/);
    const link = path.join(f.directory, 'linked'); fs.symlinkSync(path.join(f.directory, 'derived'), link);
    assert.throws(() => api.writeImmutable(path.join(link, 'other.png'), Buffer.from('no')), /目录不安全/);
});

test('only actual explicit warning/info can be retained without blocking', () => {
    for (const severity of ['warning', 'info', 'WARNING']) {
        const issue = { severity, description: 'Original observation with full detail', type: 'model_content', original: ['untouched'] };
        const saved = api.retainNonblockingObservation(issue, { issueIndex: 3, failureSha256: 'a'.repeat(64) });
        assert.equal(JSON.stringify(saved.originalIssue), JSON.stringify(issue));
        assert.equal(saved.doesNotGrantReviewPass, true);
        assert.match(saved.issueSha256, /^[a-f0-9]{64}$/);
        assert.notEqual(saved.originalIssue, issue);
    }
});
test('blocking error, missing or unknown severity never becomes nonblocking', () => {
    for (const issue of [{ severity: 'error' }, {}, { severity: 'unknown' }, { severity: 'warning ' }, { severity: null }])
        assert.throws(() => api.retainNonblockingObservation(issue, { issueIndex: 0 }), /原明确warning\/info/);
});

test('source-page-view accepts real ordinal set without inventing a defect classification', () => {
    assert.equal(api.validatePublicationViewRoute({issueIndex:0,kind:'source-page-view',figureOrdinals:[1,3]}), null);
});
test('source-page-view cannot select arbitrary profile rectangle page or fake success', () => {
    for (const extra of [{profile:'full'}, {rect:[0,0,1,1]}, {page:9}, {passed:true}, {evidencePath:'/tmp/free'}]) {
        assert.throws(()=>api.validatePublicationViewRoute({issueIndex:0,kind:'source-page-view',figureOrdinals:[1],...extra}), /不得/);
    }
});
test('source-page-view still requires unique positive actual ordinal identities', () => {
    for (const ordinals of [[],[1,1],[0],['1'],[-1],[1.5]]) {
        assert.throws(()=>api.validatePublicationViewRoute({issueIndex:0,kind:'source-page-view',figureOrdinals:ordinals}), /序号/);
    }
});

test('normal public input cannot inject historical baseline or maintenance authority as JSON', () => {
    for (const extra of [{maintenanceHandle:{}}, {baselineState:{}}, {history:true}]) {
        assert.throws(()=>api.operation({runtimeRoot:'/unused',conferenceId:'test-2026',processId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',manifestPath:'/unused.json',expectedGenerationSha256:'a'.repeat(64),...extra}, false), /未知字段/);
    }
});
test('history replay bridge is synchronous and confined to expected existing derivation', () => {
    const exported = sandbox.module.exports;
    assert.throws(()=>exported.replayPublicationFigureCropsForMaintenance({}, {}), /私有能力/);
    assert.throws(()=>exported.replayPublicationFigureCropsForMaintenance({expectedDerivation:{}}, null), /私有能力/);
    assert.equal(exported.replayPublicationFigureCropsForMaintenance.constructor.name, 'Function');
});

test('private cache outcome is deeply immutable rather than a mutable permission object', () => {
    const original={derivations:[{sha256:'a'.repeat(64)}]}, frozen=api.freezeData(structuredClone(original));
    assert.ok(Object.isFrozen(frozen));assert.ok(Object.isFrozen(frozen.derivations));assert.ok(Object.isFrozen(frozen.derivations[0]));
    assert.throws(()=>{frozen.derivations[0].sha256='b'.repeat(64);}, TypeError);
    original.derivations[0].sha256='c'.repeat(64);
    assert.equal(frozen.derivations[0].sha256,'a'.repeat(64));
});

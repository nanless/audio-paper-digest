'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ledger = require('../scripts/lib/conference-source-ledger');
const run = require('../scripts/lib/conference-run');
const plan = require('../scripts/lib/conference-plan');
const codec = require('../scripts/lib/protocol-codec');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Original pre-cleanup source objects, read without checking out another tree.
// The original source constructs these records; this test never rewrites a
// current record's label or re-signs it to manufacture a historical positive.
const pins = {
    'conference-source-ledger': ['04cf46fad246f4fea46229e6a066fc1bdbc25f7e', '66522fbe0b2a6b02041ad796d992ebb73cbf2411897b09adb0b330a5d950116c'],
    'conference-run': ['3cf25b03b7f021c06887192b7982f4c5c21539b3', '37f72cc70e5e2a534201a3dd50c2d9dd65edebea7f3235ed88e3d23373ca5ff3'],
    'conference-plan': ['29fdcab47761723bcd01c1c3368aa435d5650fe5', '9585236f287d825b2af8a276454922c3b6b4072c84e602d778732a52ef53602e']
};
function original(name, dependencies = {}) {
    const [oid, expected] = pins[name];
    const bytes = execFileSync('git', ['cat-file', 'blob', oid], { cwd: root, maxBuffer: 1024 * 1024 });
    assert.equal(sha(bytes), expected);
    const filename = path.join(root, 'scripts/lib', name + '.js');
    const loaded = new Module(filename, module); loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const ordinaryRequire = loaded.require.bind(loaded);
    loaded.require = request => Object.hasOwn(dependencies, request) ? dependencies[request] : ordinaryRequire(request);
    loaded._compile(bytes.toString('utf8'), filename);
    return loaded.exports;
}

test('原Git源码生成的会议账本、运行与计划按原header及真实文件句柄重放', t => {
    for (const module of [require('node:http'), require('node:https')]) {
        t.mock.method(module, 'request', () => assert.fail('historical replay forbids network'));
        t.mock.method(module, 'get', () => assert.fail('historical replay forbids network'));
    }
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workflow-original-source-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const oldLedgerApi = original('conference-source-ledger');
    const oldRunApi = original('conference-run');
    const oldPlanApi = original('conference-plan', { './conference-run.js': oldRunApi });
    const member = { identity: { type: 'icassp-arnumber', value: '100' },
        metadataFile: 'metadata.json', metadataSha256: sha('metadata'), pdfFile: 'source.pdf', pdfSha256: sha('pdf'),
        textFile: 'source.txt', textSha256: sha('text'), artifactsFile: 'artifacts.json', artifactsSha256: sha('artifacts') };
    member.status = { state: 'verified', updatedAt: '2026-09-06T00:00:00.000Z', reason: 'original source fixture',
        evidence: ['metadata', 'pdf', 'text', 'artifacts'].map(kind => ({ kind, sha256: member[kind + 'Sha256'] })) };
    const oldLedger = oldLedgerApi.createLedger({ id: 'icassp-2026', year: 2026 }, [member]);
    const bytes = Buffer.from(JSON.stringify(oldLedger)); const filename = path.join(directory, 'ledger.json');
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    const handle = ledger.loadLedgerHandle(filename);
    assert.deepEqual(ledger.ledgerHandleSnapshot(handle).ledger, oldLedger);
    assert.equal(ledger.ledgerHandleSnapshot(handle).ledgerSha256, sha(bytes));
    const paperId = require('../scripts/lib/paper-identity').canonicalConferencePaperId(oldLedger.conference, member.identity);
    const identities = [{ paperId, sourceIdentity: 'icassp-arnumber:100' }];
    const proof = { filterPolicySha256: sha('filter policy'), selectionReceiptSha256: sha('selection receipt'),
        selectedMemberSetSha256: oldRunApi.stableHash([paperId]) };
    const oldRun = oldRunApi.createConferenceRunFromVerifiedLedger({ ledgerHandle: handle,
        tagCatalogVersion: 'original-catalog', ...proof, members: identities, shards: [{ shardId: 'all', paperIds: [paperId] }] });
    const before = JSON.stringify(oldRun);
    assert.deepEqual(run.assertConferenceRunFromVerifiedLedger(oldRun, handle), oldRun);
    const continued = run.transitionPaperState(oldRun, paperId, { status: 'source_ready', usage: { requests: 1 } });
    assert.equal(continued.contract, oldRun.contract); assert.equal(continued.version, oldRun.version);
    assert.equal(continued.identitySha256, oldRun.identitySha256); assert.equal(JSON.stringify(oldRun), before);
    const wrongVersion = { ...oldRun, version: oldRun.version + 1 };
    assert.throws(() => run.assertConferenceRun(wrongVersion), /不属于支持的组合/);
    const stripped = { ...oldRun }; delete stripped.version;
    assert.throws(() => run.assertConferenceRun(stripped), /不属于支持的组合/);
    assert.throws(() => run.assertConferenceRun({ ...oldRun, contract: run.CONTRACT }), /不属于支持的组合/);
    const oldPlan = oldPlanApi.normalizePlan({ contract: oldPlanApi.PLAN_CONTRACT, version: oldPlanApi.PLAN_VERSION,
        ledgerName: 'ledger.json', tagMetadata: { version: 'original-catalog', sha256: sha('catalog') },
        selectionPolicy: { contract: oldPlanApi.SELECTION_CONTRACT, identities,
            selectedMemberSetSha256: proof.selectedMemberSetSha256 }, shards: [{ shardId: 'all', paperIds: [paperId] }] });
    assert.deepEqual(plan.normalizePlan(oldPlan), oldPlan);
    assert.throws(() => plan.normalizePlan({ ...oldPlan, version: oldPlan.version + 1 }), /不属于支持的组合/);
    assert.throws(() => plan.normalizePlan({ ...oldPlan, schemaFingerprint: codec.schemaFingerprint('conference-run-plan') }), /包含未允许的字段/);
    const forgedLedger = { ...oldLedger, contract: ledger.CONTRACT };
    assert.throws(() => ledger.validateLedger(forgedLedger), /schemaFingerprint/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const control = require('../scripts/lib/historical-direct-control.js');
const publication = require('../scripts/lib/historical-direct-publication.js');

const hash = control.stableHash;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const now = '2026-10-22T00:00:00.000Z';

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

function directPlan(catalogFileSha256 = 'a'.repeat(64)) {
    const empty = hash([]);
    const body = { contract: 'historical-direct-rewrite-plan-v5', version: 5,
        catalogFileSha256, inventory: { ledgerSha256: 'b'.repeat(64), pageSetSha256: 'c'.repeat(64) },
        conferenceProjectionArtifactSha256: 'd'.repeat(64), queue: [], queueSha256: empty,
        projectedPages: [], projectedPageSetSha256: empty,
        dailyPrimaryArxivBindings: [], dailyPrimaryArxivBindingSetSha256: empty,
        dailyIcmlPosterBindings: [], dailyIcmlPosterBindingSetSha256: empty,
        dailyIcmlPosterRoutableBindings: [], dailyIcmlPosterRoutableBindingSetSha256: empty,
        icmlPosterAuthoritySha256: null, unprojectedCatalogEntries: [], unprojectedCatalogEntrySetSha256: empty,
        uncoveredFrozenPaperPages: [], uncoveredFrozenPaperPageSetSha256: empty,
        paperPageCoverage: { frozenPaperPages: 0, projectedPaperPages: 0, uncoveredFrozenPaperPages: 0,
            coverageComplete: true, byScope: [], uncoveredByIdentityHintStatus: [] } };
    return { ...body, planSha256: hash(body) };
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-status-interface-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const plan = directPlan();
    const planFile = path.join(root, 'direct-plan.json');
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const roots = Object.fromEntries(['registryRoot', 'sourceRoot', 'aggregateRoot',
        'aggregateProjectionRoot', 'publicationRoot'].map(name => [name, path.join(root, name)]));
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { mode: 0o700 });
    const baseline = Buffer.from('Synthetic baseline; not a production paper.\n');
    const next = Buffer.from('Synthetic replacement; not a production paper.\n');
    const artifacts = [{ path: 'content/posts/synthetic-interface-fixture.md', sha256: sha(next),
        baselineSha256: sha(baseline), producers: [{ kind: 'synthetic-interface-fixture' }],
        source: { kind: 'synthetic-interface-fixture' } }];
    const coverage = { inventoryPageCount: 1, coveredPageCount: 1, paperPageCount: 1,
        aggregatePageCount: 0, conferenceTaskPageCount: 0, retainedUnchangedPageCount: 0,
        uncoveredPageKeys: [], coveredPageSetSha256: 'e'.repeat(64), publicationReady: true };
    const projection = { retainedPageSetSha256: hash([]), pageCoverageSha256: hash(coverage), pageCoverage: coverage };
    const proofBody = { fixture: 'synthetic-interface-only', plan: { planSha256: plan.planSha256 },
        retainedDisposition: { retainedPageSetSha256: projection.retainedPageSetSha256,
            pageCoverageSha256: projection.pageCoverageSha256, pageCoverage: coverage,
            retainedCount: 0, rewrittenPageCount: 1 }, artifactSetSha256: hash(artifacts) };
    const authority = { plan, artifacts, retainedPages: [], projection,
        proof: { ...proofBody, proofSha256: hash(proofBody) }, roots: {},
        publicationScope: 'full-history', selectedPaperIds: [],
        visualDisposition: publication.buildVisualDisposition({ plan, mode: 'excluded',
            reason: 'Synthetic fixture only; not a production visual authorization.', createdAt: now }) };
    const state = { head: '1'.repeat(40), treeOid: '2'.repeat(40), contentTreeOid: '3'.repeat(40),
        branch: 'main', clean: true, remoteName: 'origin', remoteIdentitySha256: '4'.repeat(64),
        remoteOid: '1'.repeat(40), hugoConfig: { path: 'hugo.yaml', sha256: '5'.repeat(64) } };
    function createPublication(publicationId) {
        // Synthetic authority/Git boundary only. Real plan builder, writer and status loaders run below.
        const transaction = publication.buildPlan({ publicationId, blogRepo: path.join(root, 'synthetic-blog'),
            authorityOptions: {}, createdAt: now }, { loadAuthority: () => authority, blogState: () => state,
            gitBlob: () => baseline, worktreeSha: () => sha(baseline), sourceBytes: () => next });
        const written = publication.writePlan({ outputRoot: roots.publicationRoot, plan: transaction });
        return { transaction, written };
    }
    function status(publicationId, extra = {}) {
        // No publicationStatus stub: control calls the actual publication.status API.
        return control.buildStatus({ planFile, ...roots, publicationId, liveRemote: false,
            observedAt: now, ...extra }, { currentRendererImplementationSha256: '6'.repeat(64) });
    }
    return { plan, planFile, roots, createPublication, status };
}

test('真实publication.status→control用producer身份匹配，保留不同事务及原未完成状态', t => {
    const f = fixture(t);
    const ids = ['12345678-1234-4123-8123-123456789abc', '22345678-1234-4123-8123-123456789abc'];
    const transactions = ids.map(id => f.createPublication(id));
    assert.notEqual(transactions[0].transaction.planSha256, transactions[1].transaction.planSha256);
    for (const [index, id] of ids.entries()) {
        const { transaction, written } = transactions[index];
        const original = fs.readFileSync(written.filename);
        assert.notEqual(transaction.planSha256, f.plan.planSha256);
        const combined = f.status(id);
        assert.equal(combined.publication.planMatchesHistory, true);
        assert.equal(combined.publication.planSha256, transaction.planSha256, 'legacy字段仍指发布事务');
        assert.equal(combined.publication.publicationPlanSha256, transaction.planSha256);
        assert.equal(combined.publication.rewritePlanSha256, f.plan.planSha256);
        assert.equal(combined.publication.version, 1);
        assert.equal(combined.publication.complete, false);
        assert.equal(combined.publication.phase, 'planned');
        assert.equal(combined.completion.complete, false);
        assert.ok(combined.completion.blockers.some(item => item.code === 'historical-publication-incomplete'));
        assert.ok(combined.completion.blockers.some(item => item.code === 'execution-not-started'));
        assert.equal(combined.completion.blockers.some(item => item.code === 'historical-publication-plan-mismatch'), false);
        assert.deepEqual(fs.readFileSync(written.filename), original, '状态读取不改旧v1计划字节');
    }
});

test('真实publication.status→control仍拒绝不同producer、缺失或损坏的发布计划', t => {
    const f = fixture(t);
    const id = '12345678-1234-4123-8123-123456789abc';
    const { written } = f.createPublication(id);
    const other = directPlan('9'.repeat(64));
    fs.writeFileSync(f.planFile, JSON.stringify(other));
    const mismatch = f.status(id);
    assert.equal(mismatch.publication.complete, false);
    assert.equal(mismatch.publication.planMatchesHistory, false);
    assert.ok(mismatch.completion.blockers.some(item => item.code === 'historical-publication-plan-mismatch'));
    fs.writeFileSync(f.planFile, JSON.stringify(f.plan));
    const original = fs.readFileSync(written.filename);
    const corruptions = [
        { mutate: value => { delete value.authorityProof.plan.planSha256; },
            expected: /图片任务处理记录的格式、字段或 SHA 已变化/ },
        { mutate: value => {
            value.authorityProof.plan.planSha256 = 'invalid';
            value.visualDisposition.planSha256 = 'invalid';
            delete value.visualDisposition.dispositionSha256;
            value.visualDisposition.dispositionSha256 = hash(value.visualDisposition);
        }, expected: /直接发布计划的保留页面或完整页面集合证明已变化/ },
        { mutate: value => { value.authorityProof.plan.planSha256 = '9'.repeat(64); },
            expected: /图片任务处理记录的格式、字段或 SHA 已变化/ }
    ];
    for (const { mutate, expected } of corruptions) {
        const value = JSON.parse(original);
        mutate(value);
        delete value.planSha256;
        value.planSha256 = hash(value);
        fs.writeFileSync(written.filename, `${JSON.stringify(canonical(value), null, 2)}\n`);
        const status = f.status(id);
        assert.equal(status.publication.phase, 'absent');
        assert.equal(status.publication.complete, false);
        assert.equal(status.publication.planMatchesHistory, false);
        assert.ok(status.completion.blockers.some(item => item.code === 'historical-publication-plan-identity-invalid'));
        const blocker = status.publication.blockers.find(item => item.code === 'plan-missing-or-invalid');
        assert.ok(blocker);
        assert.match(blocker.detail, expected);
        assert.doesNotMatch(blocker.detail, /不是规定的规范 JSON/);
    }
    fs.unlinkSync(written.filename);
    const missing = f.status(id);
    assert.equal(missing.publication.complete, false);
    assert.equal(missing.publication.planMatchesHistory, false);
    assert.ok(missing.completion.blockers.some(item => item.code === 'historical-publication-plan-identity-invalid'));
});

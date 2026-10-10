'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
let api;

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const oid = char => char.repeat(40);
const hash = char => char.repeat(64);
const publicationId = '12345678-1234-4123-8123-123456789abc';
const now = '2026-09-08T01:00:00.000Z';

function blogState() {
    return { head: oid('a'), treeOid: oid('b'), contentTreeOid: oid('c'), branch: 'main', clean: true,
        remoteName: 'origin', remoteIdentitySha256: hash('d'), remoteOid: oid('a'),
        hugoConfig: { path: 'hugo.yaml', sha256: hash('e') } };
}
function fakeAuthority(bytes, baseline) {
    const plan = { planSha256: hash('1') };
    const visualDisposition = api.buildVisualDisposition({ plan, mode: 'excluded',
        reason: '全历史视觉由独立后续事务处理，本发布范围明确排除。', createdAt: now });
    const artifacts = [{ path: 'content/posts/2026-01-01-paper.md', sha256: sha(bytes),
        baselineSha256: sha(baseline), producers: [{ kind: 'fixture' }], source: { kind: 'fixture' } }];
    const pageCoverage = { inventoryPageCount: 1, coveredPageCount: 1, paperPageCount: 1,
        aggregatePageCount: 0, conferenceTaskPageCount: 0, retainedUnchangedPageCount: 0,
        uncoveredPageKeys: [], coveredPageSetSha256: hash('3'), publicationReady: true };
    const projection = { retainedPageSetSha256: api.stableHash([]),
        pageCoverageSha256: api.stableHash(pageCoverage), pageCoverage };
    const proofBody = { fixture: true, plan: { planSha256: plan.planSha256 },
        retainedDisposition: { retainedPageSetSha256: projection.retainedPageSetSha256,
            pageCoverageSha256: projection.pageCoverageSha256, pageCoverage,
            retainedCount: 0, rewrittenPageCount: 1 }, artifactSetSha256: api.stableHash(artifacts) };
    return { plan, artifacts, proof: { ...proofBody, proofSha256: api.stableHash(proofBody) },
        projection,
        retainedPages: [], visualDisposition, roots: {} };
}

test('本次页面内容审查失败时拒绝旧通过凭证，成功时复用页面检查点', t => {
    const child = require('node:child_process');
    const originalSpawn = child.spawnSync;
    let outcome = 'passed';
    const workerStatuses = [];
    t.after(() => { child.spawnSync = originalSpawn; });
    child.spawnSync = function (command, args, options) {
        if (command === 'bash' && args[1]?.endsWith('/historical-direct-review.py')) {
            const result = originalSpawn('bash', [
                path.resolve(__dirname, '../scripts/python-runtime.sh'),
                path.resolve(__dirname, 'helpers/historical-semantic-controlled-review.py'),
                args[1], ...args.slice(2), '--controlled-outcome', outcome
            ], options);
            workerStatuses.push(result.status);
            return result;
        }
        return originalSpawn(command, args, options);
    };
    api = require('../scripts/lib/historical-direct-publication.js');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-page-review-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outputRoot = path.join(root, 'runtime');
    const blogRepo = path.join(root, 'blog');
    fs.mkdirSync(path.join(blogRepo, 'content', 'posts'), { recursive: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    const baseline = Buffer.from('---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"\ndraft: false\n---\nold\n');
    const next = Buffer.from('---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"\ndraft: false\n---\nnew\n');
    const target = path.join(blogRepo, 'content', 'posts', '2026-01-01-paper.md');
    fs.writeFileSync(target, baseline);
    const authority = fakeAuthority(next, baseline);
    const deps = {
        loadAuthority: () => authority, blogState, gitBlob: () => baseline,
        worktreeSha: (_repo, relative) => fs.existsSync(path.join(blogRepo, relative))
            ? sha(fs.readFileSync(path.join(blogRepo, relative))) : null,
        sourceBytes: () => next, hugoVersion: 'hugo v0.fixture',
        hugoGate: () => ({ status: 'passed', engine: 'fixture', version: deps.hugoVersion }),
        validateActivatedWorktree: () => true, now: () => now,
        publishGit: () => oid('f'),
        prePublishRemote: () => ({ branch: 'main', localHead: oid('a'), remoteIdentitySha256: hash('d'), remoteOid: oid('a') }),
        pushAndVerify: () => ({ remoteName: 'origin', remoteIdentitySha256: hash('d'), remoteVerifiedOid: oid('f') }),
        liveRemote: () => ({ remoteIdentitySha256: hash('d'), remoteOid: oid('f') })
    };
    const plan = api.buildPlan({ publicationId, authorityOptions: {}, blogRepo, createdAt: now }, deps);
    api.writePlan({ outputRoot, plan });
    api.generate({ outputRoot, publicationId, authorityOptions: {}, blogRepo, apply: true }, deps);
    const first = api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps);
    assert.equal(first.status, 'reviewed');
    const directory = path.join(outputRoot, publicationId);
    const output = path.join(directory, 'semantic-review.json');
    const oldReceipt = fs.readFileSync(output);
    fs.unlinkSync(path.join(directory, 'review.json'));
    outcome = 'reuse';
    const reused = api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps);
    assert.equal(reused.status, 'reviewed');
    assert.deepEqual(fs.readFileSync(output), oldReceipt);
    fs.unlinkSync(path.join(directory, 'review.json'));
    // 模拟原通过记录保留，但本次页面检查点丢失，需要重新审查。
    fs.rmSync(path.join(directory, 'semantic-review-checkpoints'), { recursive: true, force: true });
    outcome = 'blocked';
    let error;
    try {
        api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps);
    } catch (failure) {
        error = failure;
    }
    assert.deepEqual(fs.readFileSync(output), oldReceipt);
    assert.deepEqual(workerStatuses, [0, 0, 1]);
    assert.ok(error, '本次审查退出失败时必须拒绝旧通过凭证');
    assert.match(error.message, /semantic review worker failed: 1/);
    assert.equal(fs.existsSync(path.join(directory, 'review.json')), false);
});

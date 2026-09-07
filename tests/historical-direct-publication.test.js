'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const api = require('../scripts/lib/historical-direct-publication.js');
const cli = require('../scripts/historical-direct-publication.js');

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

test('visual disposition is self-hashed and explicit', () => {
    const plan = { planSha256: hash('1') };
    const excluded = api.buildVisualDisposition({ plan, mode: 'excluded',
        reason: '视觉不属于本次全历史正文发布事务，显式排除。', createdAt: now });
    assert.equal(excluded.requestedBy, 'system-contract');
    const waived = api.buildVisualDisposition({ plan, mode: 'waived', requestedBy: 'user',
        reason: '用户明确豁免本次全历史发布后的视觉生成。', createdAt: now });
    assert.equal(waived.mode, 'waived');
    assert.throws(() => api.buildVisualDisposition({ plan, mode: 'waived', requestedBy: 'agent',
        reason: '代理不能自行签发视觉豁免，必须由用户明确提出。', createdAt: now }), /explicitly requested/);
});

test('publication transaction recovers through plan, generation, review, activation and remote receipt', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-publication-test-'));
    try {
        const outputRoot = path.join(root, 'runtime'); const blogRepo = path.join(root, 'blog');
        fs.mkdirSync(path.join(blogRepo, 'content', 'posts'), { recursive: true });
        fs.mkdirSync(outputRoot, { recursive: true });
        const baseline = Buffer.from('---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"\ndraft: false\n---\nold\n');
        const next = Buffer.from('---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"\ndraft: false\n---\nnew\n');
        const target = path.join(blogRepo, 'content', 'posts', '2026-01-01-paper.md'); fs.writeFileSync(target, baseline);
        const authority = fakeAuthority(next, baseline); const deps = {
            loadAuthority: () => authority, blogState, gitBlob: () => baseline,
            worktreeSha: (_repo, relative) => fs.existsSync(path.join(blogRepo, relative))
                ? sha(fs.readFileSync(path.join(blogRepo, relative))) : null,
            sourceBytes: () => next, hugoVersion: 'hugo v0.fixture',
            hugoGate: () => ({ status: 'passed', engine: 'fixture', version: 'hugo v0.fixture' }),
            semanticReview: ({ loadedPlan, generation, protocol }) => {
                const page = { path: 'content/posts/2026-01-01-paper.md', sha256: sha(next), textChunks: 1,
                    imageCount: 0, imageReviewMode: 'not-required', passed: true, issues: [] };
                page.resultSha256 = api.stableHash(page);
                const semanticProtocol = api.semanticReviewProtocol();
                const body = { contract: 'historical-direct-semantic-review-v1', version: 1,
                    publicationId: loadedPlan.plan.publicationId, generationSha256: generation.manifest.generationSha256,
                    reviewProtocolFingerprint: protocol, semanticProtocol, results: [page],
                    resultSetSha256: api.stableHash([page]), passed: true };
                return { receipt: { ...body, semanticReviewSha256: api.stableHash(body) }, fileSha256: hash('7') };
            },
            validateActivatedWorktree: () => true, now: () => now,
            publishGit: () => oid('f'),
            prePublishRemote: () => ({ branch: 'main', localHead: oid('a'), remoteIdentitySha256: hash('d'), remoteOid: oid('a') }),
            pushAndVerify: () => ({ remoteName: 'origin', remoteIdentitySha256: hash('d'), remoteVerifiedOid: oid('f') }),
            liveRemote: () => ({ remoteIdentitySha256: hash('d'), remoteOid: oid('f') })
        };
        const plan = api.buildPlan({ publicationId, authorityOptions: {}, blogRepo, createdAt: now }, deps);
        assert.equal(plan.exactDelta.length, 1);
        assert.equal(api.writePlan({ outputRoot, plan }).status, 'planned');
        assert.equal(api.writePlan({ outputRoot, plan }).status, 'recovered');
        assert.equal(api.generate({ outputRoot, publicationId, authorityOptions: {}, blogRepo, apply: true }, deps).status, 'generated');
        assert.equal(api.generate({ outputRoot, publicationId, authorityOptions: {}, blogRepo, apply: true }, deps).status, 'generated');
        assert.equal(api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'reviewed');
        assert.equal(api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'already-reviewed');
        assert.equal(api.activate({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'activated');
        assert.equal(fs.readFileSync(target, 'utf8'), next.toString('utf8'));
        assert.equal(api.activate({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'already-activated');
        assert.equal(api.publish({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'published');
        assert.equal(api.publish({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'already-published');
        const offlineStatus = api.status({ outputRoot, publicationId, blogRepo, liveRemote: false }, deps);
        assert.equal(offlineStatus.complete, false);
        assert.equal(offlineStatus.phase, 'awaiting-live-remote-verification');
        const status = api.status({ outputRoot, publicationId, blogRepo, liveRemote: true }, deps);
        assert.equal(status.complete, true);
        assert.equal(status.phase, 'published-with-visual-excluded');
        assert.equal(status.visual.complete, false);
        assert.equal(status.visual.audited, true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('plan rejects baseline drift and status never calls missing stages complete', () => {
    const baseline = Buffer.from('old'); const next = Buffer.from('new'); const authority = fakeAuthority(next, baseline);
    assert.throws(() => api.buildPlan({ publicationId, authorityOptions: {}, blogRepo: '/tmp', createdAt: now }, {
        loadAuthority: () => authority, blogState, gitBlob: () => baseline, worktreeSha: () => hash('9')
    }), /worktree\/baseHead drifted/);
    const absent = api.status({ outputRoot: fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-publication-absent-')), publicationId });
    assert.equal(absent.complete, false);
    assert.equal(absent.phase, 'absent');
});

test('plan validation rejects forged exact delta and incomplete 4490-style page coverage', () => {
    const baseline = Buffer.from('old'); const next = Buffer.from('new'); const authority = fakeAuthority(next, baseline);
    const plan = api.buildPlan({ publicationId, authorityOptions: {}, blogRepo: '/tmp', createdAt: now }, {
        loadAuthority: () => authority, blogState, gitBlob: () => baseline, worktreeSha: () => sha(baseline)
    });
    const forgedDelta = structuredClone(plan); forgedDelta.exactDelta = [];
    forgedDelta.exactDeltaSha256 = api.stableHash([]); delete forgedDelta.planSha256;
    forgedDelta.planSha256 = api.stableHash(forgedDelta);
    assert.throws(() => api.validatePlan(forgedDelta), /exact delta differs/);
    const forgedCoverage = structuredClone(plan); forgedCoverage.retainedDisposition.coveredPageCount = 0;
    delete forgedCoverage.planSha256; forgedCoverage.planSha256 = api.stableHash(forgedCoverage);
    assert.throws(() => api.validatePlan(forgedCoverage), /full-page coverage proof/);
});

test('CLI rejects ambiguous modes and parses explicit publication scope', () => {
    assert.equal(cli.parseArgs(['publish', '--apply', '--publication-id', publicationId]).action, 'publish');
    const parsed = cli.parseArgs(['status', '--publication-id', publicationId, '--live-remote', 'true']);
    assert.deepEqual(parsed, { action: 'status', publicationId, liveRemote: true });
    assert.equal(cli.parseArgs(['status', '--publication-id', publicationId]).liveRemote, true);
});

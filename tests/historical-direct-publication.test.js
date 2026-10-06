'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const api = require('../scripts/lib/historical-direct-publication.js');
const cli = require('../scripts/historical-direct-publication.js');
const freshSource = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const directPageStaging = require('../scripts/lib/historical-direct-page-staging.js');

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

test('视觉处置记录自带哈希且必须显式', () => {
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

test('发布事务能沿计划、生成、审查、激活和远端凭证一路恢复', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-publication-test-'));
    try {
        const outputRoot = path.join(root, 'runtime'); const blogRepo = path.join(root, 'blog');
        fs.mkdirSync(path.join(blogRepo, 'content', 'posts'), { recursive: true });
        fs.mkdirSync(outputRoot, { recursive: true });
        const baseline = Buffer.from('---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"\ndraft: false\n---\nold\n');
        const next = Buffer.from('---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"\ndraft: false\n---\nnew\n');
        const target = path.join(blogRepo, 'content', 'posts', '2026-01-01-paper.md'); fs.writeFileSync(target, baseline);
        const authority = fakeAuthority(next, baseline); const semanticPasses = new Set();
        let semanticModelCalls = 0;
        const deps = {
            loadAuthority: () => authority, blogState, gitBlob: () => baseline,
            worktreeSha: (_repo, relative) => fs.existsSync(path.join(blogRepo, relative))
                ? sha(fs.readFileSync(path.join(blogRepo, relative))) : null,
            sourceBytes: () => next, hugoVersion: 'hugo v0.fixture',
            hugoGate: () => ({ status: 'passed', engine: 'fixture', version: deps.hugoVersion }),
            semanticReview: ({ loadedPlan, generation, protocol }) => {
                const page = { path: 'content/posts/2026-01-01-paper.md', sha256: sha(next), textChunks: 1,
                    imageCount: 0, imageReviewMode: 'not-required', passed: true, issues: [] };
                const contentAddress = `${page.path}\0${page.sha256}`;
                if (!semanticPasses.has(contentAddress)) {
                    semanticPasses.add(contentAddress); semanticModelCalls += 1;
                }
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
        assert.equal(semanticModelCalls, 1);
        assert.equal(api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'already-reviewed');
        deps.hugoVersion = 'hugo v0.protocol-change';
        assert.equal(api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'reviewed');
        assert.equal(semanticModelCalls, 1, 'protocol/Hugo drift must reuse identical page bytes');
        assert.equal(api.activate({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'activated');
        assert.equal(fs.readFileSync(target, 'utf8'), next.toString('utf8'));
        assert.equal(api.activate({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'already-activated');
        deps.hugoVersion = 'hugo v0.second-protocol-change';
        assert.equal(api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'reviewed');
        assert.equal(semanticModelCalls, 1);
        assert.equal(api.activate({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'activation-rebound');
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

        const secondPublicationId = '22345678-1234-4123-8123-123456789abc';
        assert.notEqual(secondPublicationId, publicationId);
        const secondRoot = path.join(root, 'cli-transaction');
        const secondOutputRoot = path.join(secondRoot, 'runtime');
        const secondBlogRepo = path.join(secondRoot, 'blog');
        const relativePage = 'content/posts/2026-01-01-paper.md';
        const secondTarget = path.join(secondBlogRepo, relativePage);
        fs.mkdirSync(path.dirname(secondTarget), { recursive: true, mode: 0o700 });
        fs.mkdirSync(secondOutputRoot, { recursive: true, mode: 0o700 });
        fs.writeFileSync(secondTarget, baseline, { mode: 0o640 });
        const targetMode = fs.lstatSync(secondTarget).mode & 0o777;
        const events = [];
        const calls = { locks: 0, installs: 0, commits: 0, pushes: 0, remoteReplays: 0, semantic: 0 };
        let locked = false;
        function snapshotTree(directory, prefix = '') {
            return fs.readdirSync(directory).sort().flatMap(name => {
                const filename = path.join(directory, name);
                const relative = prefix ? `${prefix}/${name}` : name;
                const stat = fs.lstatSync(filename);
                return stat.isDirectory()
                    ? [{ path: relative, kind: 'directory', mode: stat.mode & 0o777 }, ...snapshotTree(filename, relative)]
                    : [{ path: relative, kind: 'file', mode: stat.mode & 0o777, bytes: fs.readFileSync(filename) }];
            });
        }
        const firstArchive = snapshotTree(outputRoot);
        const secondAuthority = fakeAuthority(next, baseline);
        const secondOptions = { outputRoot: secondOutputRoot, publicationId: secondPublicationId, blogRepo: secondBlogRepo };
        const secondDeps = {
            loadAuthority: () => secondAuthority,
            blogState: (repo, remote) => {
                assert.equal(repo, secondBlogRepo); assert.equal(remote, 'origin'); return blogState();
            },
            gitBlob: () => baseline,
            worktreeSha: (repo, relative) => {
                assert.equal(repo, secondBlogRepo);
                const filename = path.join(repo, relative);
                return fs.existsSync(filename) ? sha(fs.readFileSync(filename)) : null;
            },
            sourceBytes: () => next, hugoVersion: 'hugo v0.cli-fixture',
            hugoGate: () => ({ status: 'passed', engine: 'fixture', version: secondDeps.hugoVersion }),
            semanticReview: ({ loadedPlan, generation, protocol }) => {
                assert.equal(loadedPlan.plan.publicationId, secondPublicationId);
                assert.equal(generation.manifest.publicationId, secondPublicationId);
                calls.semantic += 1;
                const page = { path: relativePage, sha256: sha(next), textChunks: 1, imageCount: 0,
                    imageReviewMode: 'not-required', passed: true, issues: [] };
                page.resultSha256 = api.stableHash(page);
                const body = { contract: 'historical-direct-semantic-review-v1', version: 1,
                    publicationId: secondPublicationId, generationSha256: generation.manifest.generationSha256,
                    reviewProtocolFingerprint: protocol, semanticProtocol: api.semanticReviewProtocol(), results: [page],
                    resultSetSha256: api.stableHash([page]), passed: true };
                const receipt = { ...body, semanticReviewSha256: api.stableHash(body) };
                const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
                fs.writeFileSync(path.join(secondRoot, 'semantic-review.json'), bytes, { mode: 0o600 });
                return { receipt, fileSha256: sha(bytes) };
            },
            now: () => now,
            withBlogPublicationLock: callback => {
                assert.equal(locked, false); calls.locks += 1;
                assert.deepEqual(fs.readFileSync(secondTarget), calls.installs === 0 ? baseline : next);
                events.push('lock-enter'); locked = true;
                try { return callback(); }
                finally { events.push('lock-exit'); locked = false; }
            },
            replaceFile: (filename, bytes, mode) => {
                assert.equal(locked, true); assert.equal(filename, secondTarget);
                assert.deepEqual(fs.readFileSync(filename), baseline);
                assert.equal(Buffer.isBuffer(bytes), true); assert.deepEqual(bytes, next);
                assert.equal(mode, targetMode); assert.equal(mode, fs.lstatSync(filename).mode & 0o777);
                const temporary = `${filename}.${crypto.randomUUID()}.cli.tmp`;
                const fd = fs.openSync(temporary,
                    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
                try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
                finally { fs.closeSync(fd); }
                try { fs.renameSync(temporary, filename); }
                finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
                assert.equal(locked, true); assert.deepEqual(fs.readFileSync(filename), next);
                assert.equal(fs.lstatSync(filename).mode & 0o777, mode);
                calls.installs += 1; events.push('installed');
            },
            validateActivatedWorktree: (repo, paths) => {
                assert.equal(locked, true); assert.equal(repo, secondBlogRepo);
                assert.deepEqual(paths, [relativePage]); assert.deepEqual(fs.readFileSync(secondTarget), next);
                return true;
            },
            prePublishRemote: (repo, remote) => {
                assert.equal(locked, true); assert.equal(repo, secondBlogRepo); assert.equal(remote, 'origin');
                return { branch: 'main', localHead: oid('a'), remoteIdentitySha256: hash('d'), remoteOid: oid('a') };
            },
            publishGit: ({ blogRepo: repo, plan: currentPlan, publicationId: currentId }) => {
                assert.equal(locked, true); assert.equal(repo, secondBlogRepo); assert.equal(currentId, secondPublicationId);
                assert.equal(calls.installs, 1); assert.deepEqual(fs.readFileSync(secondTarget), next);
                const loaded = api.loadPlan(secondOptions);
                const generation = api.loadGeneration(loaded).manifest;
                const reviewed = api.loadReview(loaded).receipt;
                const activated = api.loadActivation(loaded).receipt;
                assert.equal(currentPlan.planSha256, loaded.plan.planSha256);
                assert.equal(activated.publicationId, secondPublicationId);
                assert.equal(activated.generationSha256, generation.generationSha256);
                assert.equal(activated.reviewSha256, reviewed.reviewSha256);
                assert.equal(activated.exactDeltaSha256, currentPlan.exactDeltaSha256);
                assert.deepEqual(activated.activatedFiles, [{ path: relativePage, sha256: sha(next) }]);
                calls.commits += 1; events.push('committed'); return oid('f');
            },
            pushAndVerify: ({ blogRepo: repo, remoteName, commit }) => {
                assert.equal(locked, true); assert.equal(repo, secondBlogRepo); assert.equal(remoteName, 'origin');
                assert.equal(commit, oid('f')); assert.equal(calls.commits, 1);
                const loaded = api.loadPlan(secondOptions);
                const committed = api.loadCommit(loaded).receipt;
                assert.equal(committed.publicationId, secondPublicationId);
                assert.equal(committed.publicationCommit, commit);
                assert.equal(committed.activationSha256, api.loadActivation(loaded).receipt.activationSha256);
                assert.equal(committed.reviewSha256, api.loadReview(loaded).receipt.reviewSha256);
                assert.equal(committed.exactDeltaSha256, loaded.plan.exactDeltaSha256);
                calls.pushes += 1; events.push('pushed-and-verified');
                return { remoteName, remoteIdentitySha256: hash('d'), remoteVerifiedOid: commit };
            },
            liveRemote: (repo, remote) => {
                assert.equal(locked, true); assert.equal(repo, secondBlogRepo); assert.equal(remote, 'origin');
                calls.remoteReplays += 1;
                return { remoteIdentitySha256: hash('d'), remoteOid: oid('f') };
            }
        };
        const secondPlan = api.buildPlan({ publicationId: secondPublicationId, authorityOptions: {},
            blogRepo: secondBlogRepo, createdAt: now }, secondDeps);
        assert.equal(secondPlan.exactDelta.length, 1);
        assert.equal(api.writePlan({ outputRoot: secondOutputRoot, plan: secondPlan }).status, 'planned');
        assert.equal(api.generate({ ...secondOptions, authorityOptions: {}, apply: true }, secondDeps).status, 'generated');
        assert.equal(api.review({ ...secondOptions, apply: true }, secondDeps).status, 'reviewed');
        const config = { FILES: { historicalDirectPublicationDir: secondOutputRoot },
            PUBLISH_CONFIG: { blogRepo: secondBlogRepo, githubRemote: 'origin' } };
        const runtime = { config, dependencies: secondDeps };
        const beforeRejectedActivation = snapshotTree(secondRoot);
        assert.throws(() => cli.main(['activate', '--apply', '--publication-id', secondPublicationId], runtime),
            /standalone activate --apply is disabled/);
        assert.deepEqual(snapshotTree(secondRoot), beforeRejectedActivation);
        assert.deepEqual(calls, { locks: 0, installs: 0, commits: 0, pushes: 0, remoteReplays: 0, semantic: 1 });
        assert.deepEqual(events, []); assert.equal(locked, false);
        const published = cli.main(['publish', '--apply', '--publication-id', secondPublicationId], runtime);
        assert.equal(published.status, 'published');
        assert.deepEqual(events, ['lock-enter', 'installed', 'committed', 'pushed-and-verified', 'lock-exit']);
        assert.deepEqual(calls, { locks: 1, installs: 1, commits: 1, pushes: 1, remoteReplays: 0, semantic: 1 });
        assert.equal(locked, false); assert.deepEqual(fs.readFileSync(secondTarget), next);
        const loadedSecond = api.loadPlan(secondOptions);
        const activationReceipt = api.loadActivation(loadedSecond).receipt;
        const commitReceipt = api.loadCommit(loadedSecond).receipt;
        const publicationReceipt = api.loadPublication(loadedSecond).receipt;
        assert.equal(publicationReceipt.publicationId, secondPublicationId);
        assert.equal(publicationReceipt.planSha256, secondPlan.planSha256);
        assert.equal(publicationReceipt.activationSha256, activationReceipt.activationSha256);
        assert.equal(publicationReceipt.commitSha256, commitReceipt.commitSha256);
        assert.equal(publicationReceipt.reviewSha256, api.loadReview(loadedSecond).receipt.reviewSha256);
        assert.equal(publicationReceipt.exactDeltaSha256, secondPlan.exactDeltaSha256);
        assert.equal(publicationReceipt.remoteIdentitySha256, hash('d'));
        assert.equal(publicationReceipt.remoteVerifiedOid, commitReceipt.publicationCommit);
        assert.equal(publicationReceipt.remoteVerifiedOid, oid('f'));
        const publicationBytes = fs.readFileSync(path.join(loadedSecond.directory, 'publication.json'));
        const commitBytes = fs.readFileSync(path.join(loadedSecond.directory, 'commit.json'));
        events.length = 0;
        const replayed = cli.main(['publish', '--apply', '--publication-id', secondPublicationId], runtime);
        assert.equal(replayed.status, 'already-published'); assert.deepEqual(replayed.receipt, publicationReceipt);
        assert.deepEqual(events, ['lock-enter', 'lock-exit']);
        assert.deepEqual(calls, { locks: 2, installs: 1, commits: 1, pushes: 1, remoteReplays: 1, semantic: 1 });
        assert.equal(locked, false); assert.deepEqual(fs.readFileSync(secondTarget), next);
        assert.deepEqual(fs.readFileSync(path.join(loadedSecond.directory, 'publication.json')), publicationBytes);
        assert.deepEqual(fs.readFileSync(path.join(loadedSecond.directory, 'commit.json')), commitBytes);
        assert.deepEqual(snapshotTree(outputRoot), firstArchive);
        assert.deepEqual(fs.readFileSync(target), next);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('计划拒绝基线漂移，状态也不会把缺失的阶段报成完成', () => {
    const baseline = Buffer.from('old'); const next = Buffer.from('new'); const authority = fakeAuthority(next, baseline);
    assert.throws(() => api.buildPlan({ publicationId, authorityOptions: {}, blogRepo: '/tmp', createdAt: now }, {
        loadAuthority: () => authority, blogState, gitBlob: () => baseline, worktreeSha: () => hash('9')
    }), /worktree\/baseHead drifted/);
    const absent = api.status({ outputRoot: fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-publication-absent-')), publicationId });
    assert.equal(absent.complete, false);
    assert.equal(absent.phase, 'absent');
});

test('计划校验拒绝伪造的精确差异和不完整的 4490 式页面覆盖', () => {
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

test('命令行拒绝有歧义的模式，并解析显式的发布范围', () => {
    assert.equal(cli.parseArgs(['publish', '--apply', '--publication-id', publicationId]).action, 'publish');
    const sample = cli.parseArgs(['plan', '--apply', '--publication-id', publicationId,
        '--plan-file', '/tmp/plan.json', '--registry-file', '/tmp/registry.json',
        '--projection-file', '/tmp/projection.json', '--visual-disposition', '/tmp/visual.json',
        '--paper-ids', 'arxiv:2605.30365,arxiv:2605.30614', '--blog-repo', '/tmp/blog']);
    assert.deepEqual(sample.paperIds, ['arxiv:2605.30365', 'arxiv:2605.30614']);
    assert.equal(sample.blogRepo, '/tmp/blog');
    const parsed = cli.parseArgs(['status', '--publication-id', publicationId, '--live-remote', 'true']);
    assert.deepEqual(parsed, { action: 'status', publicationId, liveRemote: true });
    assert.equal(cli.parseArgs(['status', '--publication-id', publicationId]).liveRemote, true);
});

function versionedFixture() {
    const arxivId = '2403.14817'; const selectedSourceId = `${arxivId}v1`;
    const sourceVersion = freshSource.historicalVersionIdentity({ arxivId, textSourceId: selectedSourceId,
        pdf: { sourceId: selectedSourceId, url: `https://arxiv.org/pdf/${selectedSourceId}.pdf`,
            currentPdfUnavailable: true, currentPdfStatus: 404 } });
    const item = { paperId: `arxiv:${arxivId}`, route: { kind: 'arxiv-fresh-fetch', arxivId } };
    const source = { sourceId: selectedSourceId, sourceManifestSha256: hash('8'), sourceVersion };
    return { arxivId, selectedSourceId, sourceVersion, item, source };
}

test('发布权威记录显式绑定注册表和暂存的历史版本身份', () => {
    const f = versionedFixture();
    const proof = api.historicalSourceVersionProof(f.item, { source: f.source }, { sourceDisclosure: f.sourceVersion });
    assert.equal(proof.sourceVersionIdentitySha256, f.sourceVersion.identitySha256);
    assert.equal(proof.sourceManifestSha256, f.source.sourceManifestSha256);
    assert.deepEqual(proof.sourceVersion, f.sourceVersion);
    const drifted = structuredClone(f.sourceVersion); drifted.selectedSourceId = `${f.arxivId}v2`;
    assert.throws(() => api.historicalSourceVersionProof(f.item, { source: f.source }, { sourceDisclosure: drifted }),
        /historical-version proof drifted|identity evidence\/SHA drifted/);
    assert.throws(() => api.historicalSourceVersionProof(f.item, { source: { ...f.source, sourceVersion: undefined } },
        { sourceDisclosure: f.sourceVersion }), /has no registry source proof/);
});

test('确定性发布审查要求带版本号的直连页面只有一条精确的顶部警告', () => {
    const f = versionedFixture();
    const producer = { kind: 'direct-page-staging', paperId: f.item.paperId, runId: publicationId,
        manifestSha256: hash('9'), sourceVersion: f.sourceVersion,
        sourceVersionIdentitySha256: f.sourceVersion.identitySha256,
        sourceManifestSha256: f.source.sourceManifestSha256 };
    const disclosure = directPageStaging.arxivHistoricalVersionPageDisclosure(f.item, f.source);
    const frontMatter = '---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"\ndraft: false\n---\n';
    const check = text => api.deterministicReview({ path: 'content/posts/versioned.md', sha256: sha(Buffer.from(text)),
        producers: [producer] }, Buffer.from(text));
    const exact = `${frontMatter}${disclosure}\n\n# body\n`;
    assert.equal(check(exact).sourceVersionIdentitySha256, f.sourceVersion.identitySha256);
    assert.throws(() => check(`${frontMatter}# body\n`), /lost or duplicated its exact top disclosure/);
    assert.throws(() => check(`${frontMatter}# body\n\n${disclosure}\n`), /lost or duplicated its exact top disclosure/);
    assert.throws(() => check(`${frontMatter}${disclosure}\n\n${disclosure}\n`), /lost or duplicated its exact top disclosure/);

    const ordinaryProducer = { kind: 'direct-page-staging', paperId: f.item.paperId, runId: publicationId,
        manifestSha256: hash('9') };
    assert.throws(() => api.deterministicReview({ path: 'content/posts/ordinary.md', sha256: sha(Buffer.from(exact)),
        producers: [ordinaryProducer] }, Buffer.from(exact)), /ordinary direct page forged/);
});

test('审查约定给全新来源、运行器和页面暂存的实现都记指纹', () => {
    const names = api.reviewProtocolImplementationFiles().map(filename => path.basename(filename));
    assert.ok(names.includes('page-tag-metadata.js'));
    assert.ok(names.includes('tag-rules.js'));
    assert.ok(names.includes('package-lock.json'));
    assert.ok(names.includes('fresh-arxiv-rewrite-source.js'));
    assert.ok(names.includes('historical-direct-rewrite-runner.js'));
    assert.ok(names.includes('historical-direct-page-staging.js'));
    assert.match(api.reviewProtocolFingerprint({ hugoVersion: 'hugo v0.fixture' }), /^[a-f0-9]{64}$/);
});

test('页面审查接受新旧单一标签字段族，先核原页面 SHA 再拒混用', () => {
    const page = fields => Buffer.from(`---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\n${fields}\ndraft: false\n---\nBody.\n`);
    const contract = 'paper-taxonomy-flat-tags-compat-v1';
    for (const family of ['tags', 'taxonomy']) {
        const bytes = page(`paper_digest_${family}_contract: "${contract}"`);
        const original = Buffer.from(bytes);
        assert.doesNotThrow(() => api.deterministicReview({ path: 'content/posts/one.md', sha256: sha(bytes) }, bytes));
        assert.deepEqual(bytes, original);
    }
    const mixed = page(`paper_digest_tags_contract: "${contract}"\n"paper_digest_taxonomy_concepts": null`);
    assert.throws(() => api.deterministicReview({ path: 'content/posts/one.md', sha256: sha(mixed) }, mixed), /新旧标签字段/);
    assert.throws(() => api.deterministicReview({ path: 'content/posts/one.md', sha256: hash('a') }, mixed), /review bytes drifted/);
});

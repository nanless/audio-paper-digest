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

test('历史发布按页面实际词表去重核验站点目录，拒绝未同步和伪身份', () => {
    const registrySha = 'a'.repeat(64), version = 'paper-tag-catalog-v2';
    const text = `---\npaper_digest_tags_contract: paper-tag-flat-tags-v2\npaper_digest_tags_registry_sha256: ${registrySha}\npaper_digest_tags_registry_version: ${version}\n---\n正文\n`;
    const bytes = Buffer.from(text), record = { path: 'content/posts/paper.md', sha256: sha(bytes) };
    const calls = [];
    const dependencies = { validatePublishedTagCatalog: (...args) => { calls.push(args); return { valid: true }; } };
    api.validatePublishedTagCatalogs('/fixture/blog', [record, { ...record, path: 'content/posts/other.md' }], () => bytes, dependencies);
    assert.deepEqual(calls, [['/fixture/blog', registrySha, version]]);
    assert.throws(() => api.validatePublishedTagCatalogs('/fixture/blog', [record], () => bytes, {
        validatePublishedTagCatalog: () => { throw Error('站点缺少本次词表原归档'); }
    }), /缺少本次词表/);
    const forged = Buffer.from(text.replace(registrySha, 'invalid'));
    assert.throws(() => api.validatePublishedTagCatalogs('/fixture/blog', [{ ...record, sha256: sha(forged) }], () => forged, dependencies), /词表身份/);
    assert.throws(() => api.validatePublishedTagCatalogs('/fixture/blog', [record], () => Buffer.concat([bytes, Buffer.from('drift')]), dependencies), /页面字节与来源不符/);
    const mixed = Buffer.from(text.replace('---\n正文', `paper_digest_taxonomy_registry_sha256: ${registrySha}\n---\n正文`));
    assert.throws(() => api.validatePublishedTagCatalogs('/fixture/blog', [{ ...record, sha256: sha(mixed) }], () => mixed, dependencies), /混用新旧/);
    for (const field of ['paper_digest_taxonomy_contract: paper-taxonomy-flat-tags-compat-v1',
        'paper_digest_tags_concepts: []']) {
        const partial = Buffer.from(`---\n${field}\n---\n正文`);
        assert.throws(() => api.validatePublishedTagCatalogs('/fixture/blog', [{ ...record, sha256: sha(partial) }], () => partial, dependencies), /词表身份/);
    }
});

test('视觉处置记录自带哈希且必须显式', () => {
    const plan = { planSha256: hash('1') };
    const excluded = api.buildVisualDisposition({ plan, mode: 'excluded',
        reason: '视觉不属于本次全历史正文发布事务，显式排除。', createdAt: now });
    assert.equal(excluded.requestedBy, 'system-contract');
    const waived = api.buildVisualDisposition({ plan, mode: 'waived', requestedBy: 'user',
        reason: '用户明确豁免本次全历史发布后的视觉生成。', createdAt: now });
    assert.equal(waived.mode, 'waived');
    assert.throws(() => api.buildVisualDisposition({ plan, mode: 'waived', requestedBy: 'agent',
        reason: '代理不能自行签发视觉豁免，必须由用户明确提出。', createdAt: now }), /必须由用户明确提出/);
});

test('发布事务能沿计划、生成、审查、激活和远端凭证一路恢复', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-publication-test-'));
    try {
        const outputRoot = path.join(root, 'runtime'); const blogRepo = path.join(root, 'blog');
        fs.mkdirSync(path.join(blogRepo, 'content', 'posts'), { recursive: true });
        fs.mkdirSync(outputRoot, { recursive: true });
        const identity = `paper_digest_taxonomy_registry_sha256: ${hash('a')}\npaper_digest_taxonomy_registry_version: paper-taxonomy-v2\n`;
        const baseline = Buffer.from('---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"\n' + identity + 'draft: false\n---\nold\n');
        const next = Buffer.from('---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"\n' + identity + 'draft: false\n---\nnew\n');
        const target = path.join(blogRepo, 'content', 'posts', '2026-01-01-paper.md'); fs.writeFileSync(target, baseline);
        const authority = fakeAuthority(next, baseline); const semanticPasses = new Set();
        let semanticModelCalls = 0;
        const deps = {
            loadAuthority: () => authority, blogState, gitBlob: () => baseline,
            worktreeSha: (_repo, relative) => fs.existsSync(path.join(blogRepo, relative))
                ? sha(fs.readFileSync(path.join(blogRepo, relative))) : null,
            sourceBytes: () => next, hugoVersion: 'hugo v0.fixture',
            validatePublishedTagCatalog: () => ({ valid: true }),
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
        const protocols = require('../scripts/lib/protocol-codec');
        assert.equal(protocols.isCurrentHeader(plan, api.PLAN_CONTRACT), true);
        const originalRoot = path.join(root, 'original-runtime');
        const originalDirectory = path.join(originalRoot, publicationId);
        const originalGeneration = path.join(originalDirectory, 'generation');
        fs.mkdirSync(originalGeneration, { recursive: true });
        const sorted = value => Array.isArray(value) ? value.map(sorted)
            : value && typeof value === 'object'
                ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
        const asBytes = value => Buffer.from(JSON.stringify(sorted(value), null, 2) + '\n');
        const { contract, schemaFingerprint, planSha256, ...originalPlanFields } = plan;
        const originalPlanBody = { contract: 'historical-direct-publication-plan-v1', version: 1, ...originalPlanFields };
        const originalPlan = { ...originalPlanBody, planSha256: api.stableHash(originalPlanBody) };
        const originalPlanBytes = asBytes(originalPlan);
        fs.writeFileSync(path.join(originalDirectory, 'plan.json'), originalPlanBytes);
        const oldOptions = { outputRoot: originalRoot, publicationId, authorityOptions: {}, blogRepo, apply: true };
        const currentGeneration = api.generate({ ...oldOptions, apply: false }, deps).manifest;
        const { contract: _generationContract, schemaFingerprint: _generationFingerprint, generationSha256, ...generationFields } = currentGeneration;
        const oldGenerationBody = { contract: 'historical-direct-publication-generation-v1', version: 1, ...generationFields };
        const oldGeneration = { ...oldGenerationBody, generationSha256: api.stableHash(oldGenerationBody) };
        const oldIntentBody = { contract: 'historical-direct-publication-generation-v1-intent', version: 1,
            publicationId, planSha256: originalPlan.planSha256, generationSha256: oldGeneration.generationSha256,
            fileSetSha256: oldGeneration.fileSetSha256 };
        const oldIntentBytes = asBytes({ ...oldIntentBody, intentSha256: api.stableHash(oldIntentBody) });
        const oldIntentFilename = path.join(originalGeneration, 'intent.json');
        fs.writeFileSync(oldIntentFilename, oldIntentBytes);
        assert.deepEqual(api.generate(oldOptions, deps).manifest, oldGeneration);
        assert.deepEqual(fs.readFileSync(oldIntentFilename), oldIntentBytes);
        assert.deepEqual(fs.readFileSync(path.join(originalDirectory, 'plan.json')), originalPlanBytes);
        assert.deepEqual(api.loadGeneration(api.loadPlan(oldOptions)).manifest, oldGeneration);
        assert.equal(api.generate({ outputRoot, publicationId, authorityOptions: {}, blogRepo, apply: true }, deps).status, 'generated');
        assert.equal(api.generate({ outputRoot, publicationId, authorityOptions: {}, blogRepo, apply: true }, deps).status, 'generated');
        assert.equal(api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'reviewed');
        assert.equal(semanticModelCalls, 1);
        // Synthetic previously signed schema fixture: an older fingerprint is
        // opaque historical evidence, never rewritten into the current recipe.
        const reviewFile = path.join(outputRoot, publicationId, 'review.json');
        const currentReviewBytes = fs.readFileSync(reviewFile);
        const legacy = JSON.parse(currentReviewBytes);
        delete legacy.schemaFingerprint;
        legacy.contract = 'historical-direct-publication-review-v1';
        legacy.version = 1;
        legacy.reviewMode = 'historical-semantic-multimodal-v1';
        legacy.reviewProtocolFingerprint = hash('9');
        delete legacy.reviewSha256;
        legacy.reviewSha256 = api.stableHash(legacy);
        const legacyBytes = Buffer.from(JSON.stringify(legacy));
        fs.writeFileSync(reviewFile, legacyBytes);
        const loadedPlan = api.loadPlan({ outputRoot, publicationId });
        assert.equal(api.loadReview(loadedPlan).receipt.reviewProtocolFingerprint, hash('9'));
        assert.deepEqual(fs.readFileSync(reviewFile), legacyBytes, 'cold legacy reads must not re-sign or save');
        fs.writeFileSync(reviewFile, JSON.stringify({ ...legacy, reviewProtocolFingerprint: hash('8') }));
        assert.throws(() => api.loadReview(loadedPlan), /字段或 SHA/);
        fs.writeFileSync(reviewFile, legacyBytes);
        assert.equal(api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'reviewed');
        const archivedReview = path.join(path.dirname(reviewFile), 'original-formats', `review.json-${sha(legacyBytes)}.json`);
        assert.deepEqual(fs.readFileSync(archivedReview), legacyBytes);
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
        const activationDirectory = path.join(outputRoot, publicationId, 'activation');
        const activationBeforeDryRun = new Map(['intent.json', 'receipt.json'].map(name => {
            const filename = path.join(activationDirectory, name);
            return [name, { bytes: fs.readFileSync(filename), stat: fs.statSync(filename) }];
        }));
        const reviewedBeforeDryRun = fs.readFileSync(path.join(outputRoot, publicationId, 'review.json'));
        const dryRebound = api.activate({ outputRoot, publicationId, blogRepo, apply: false }, deps);
        assert.equal(dryRebound.status, 'dry-run');
        assert.equal(dryRebound.deltaCount, 1);
        assert.equal(dryRebound.intent.reviewSha256, JSON.parse(reviewedBeforeDryRun).reviewSha256);
        for (const [name, before] of activationBeforeDryRun) {
            const filename = path.join(activationDirectory, name);
            assert.deepEqual(fs.readFileSync(filename), before.bytes);
            assert.equal(fs.statSync(filename).ino, before.stat.ino);
            assert.equal(fs.statSync(filename).mtimeMs, before.stat.mtimeMs);
        }
        assert.deepEqual(fs.readFileSync(path.join(outputRoot, publicationId, 'review.json')), reviewedBeforeDryRun);
        assert.deepEqual(fs.readFileSync(target), next);
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

        // 先构造真正走完各阶段的事务，再逐项破坏上游记录并重新计算自哈希。
        // 自哈希完整不能代替记录之间的对应关系，也不能绕过已发布重放的核验。
        const checkedPlan = api.loadPlan({ outputRoot, publicationId });
        const rejectedChanges = [
            ['generation/manifest.json', 'generationSha256', value => { value.files = []; value.fileSetSha256 = api.stableHash([]); }],
            ['generation/manifest.json', 'generationSha256', value => { value.authorityProofSha256 = hash('0'); }],
            ['generation/manifest.json', 'generationSha256', value => { value.remoteMainOid = oid('0'); }],
            ['review.json', 'reviewSha256', value => { value.generationSha256 = hash('0'); }],
            ['review.json', 'reviewSha256', value => { value.generationFileSha256 = hash('0'); }],
            ['review.json', 'reviewSha256', value => { value.hugoGate = { status: 'failed' }; }],
            ['review.json', 'reviewSha256', value => { value.remoteIdentitySha256 = hash('0'); }],
            ['review.json', 'reviewSha256', value => { value.reviewedAt = 'not-a-date'; }],
            ['activation/receipt.json', 'activationSha256', value => { value.reviewSha256 = hash('0'); }],
            ['activation/receipt.json', 'activationSha256', value => { value.generationSha256 = hash('0'); }],
            ['commit.json', 'commitSha256', value => { value.reviewSha256 = hash('0'); }],
            ['commit.json', 'commitSha256', value => { value.activationSha256 = hash('0'); }],
            ['commit.json', 'commitSha256', value => { value.publicationCommit = oid('0'); }],
            ['publication.json', 'publicationSha256', value => { value.reviewSha256 = hash('0'); }],
            ['publication.json', 'publicationSha256', value => { value.activationSha256 = hash('0'); }],
            ['publication.json', 'publicationSha256', value => { value.commitSha256 = hash('0'); }],
            ['publication.json', 'publicationSha256', value => { value.exactDeltaSha256 = hash('0'); }],
            ['publication.json', 'publicationSha256', value => { value.remoteName = 'another-remote'; }],
            ['publication.json', 'publicationSha256', value => { value.remoteIdentitySha256 = hash('0'); }]
        ];
        for (const [relative, hashKey, alter] of rejectedChanges) {
            const filename = path.join(checkedPlan.directory, relative);
            const original = fs.readFileSync(filename);
            const changed = JSON.parse(original);
            alter(changed); delete changed[hashKey]; changed[hashKey] = api.stableHash(changed);
            fs.writeFileSync(filename, JSON.stringify(changed));
            try {
                assert.equal(api.status({ outputRoot, publicationId, blogRepo, liveRemote: true }, deps).complete,
                    false, `损坏的 ${relative} 不得报完成`);
                assert.throws(() => api.publish({ outputRoot, publicationId, blogRepo, apply: true }, deps),
                    undefined, `损坏的 ${relative} 不得重放为已发布`);
            } finally { fs.writeFileSync(filename, original); }
        }
        const commitFilename = path.join(checkedPlan.directory, 'commit.json');
        const originalCommit = fs.readFileSync(commitFilename);
        fs.unlinkSync(commitFilename);
        try {
            assert.equal(api.status({ outputRoot, publicationId, blogRepo, liveRemote: true }, deps).complete, false);
            assert.throws(() => api.publish({ outputRoot, publicationId, blogRepo, apply: true }, deps));
        } finally { fs.writeFileSync(commitFilename, originalCommit); }
        assert.equal(api.status({ outputRoot, publicationId, blogRepo, liveRemote: true }, deps).complete, true);
        assert.equal(api.publish({ outputRoot, publicationId, blogRepo, apply: true }, deps).status, 'already-published');


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
            validatePublishedTagCatalog: () => ({ valid: true }),
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

test('发布计划拒绝工作区文件与 Git 基线不符，状态查询不把缺失阶段报成完成', () => {
    const baseline = Buffer.from('old'); const next = Buffer.from('new'); const authority = fakeAuthority(next, baseline);
    assert.throws(() => api.buildPlan({ publicationId, authorityOptions: {}, blogRepo: '/tmp', createdAt: now }, {
        loadAuthority: () => authority, blogState, gitBlob: () => baseline, worktreeSha: () => hash('9')
    }), /工作区文件与 baseHead 中的内容不同/);
    const absent = api.status({ outputRoot: fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-publication-absent-')), publicationId });
    assert.equal(absent.complete, false);
    assert.equal(absent.phase, 'absent');
});

test('计划校验拒绝伪造的精确差异和不完整的 4490 式页面覆盖', () => {
    const baseline = Buffer.from('old'); const next = Buffer.from('new'); const authority = fakeAuthority(next, baseline);
    const plan = api.buildPlan({ publicationId, authorityOptions: {}, blogRepo: '/tmp', createdAt: now }, {
        loadAuthority: () => authority, blogState, gitBlob: () => baseline, worktreeSha: () => sha(baseline), sourceBytes: () => next
    });
    const forgedDelta = structuredClone(plan); forgedDelta.exactDelta = [];
    forgedDelta.exactDeltaSha256 = api.stableHash([]); delete forgedDelta.planSha256;
    forgedDelta.planSha256 = api.stableHash(forgedDelta);
    assert.throws(() => api.validatePlan(forgedDelta), /精确改动集合与各来源生成的文件不同/);
    const forgedCoverage = structuredClone(plan); forgedCoverage.retainedDisposition.coveredPageCount = 0;
    delete forgedCoverage.planSha256; forgedCoverage.planSha256 = api.stableHash(forgedCoverage);
    assert.throws(() => api.validatePlan(forgedCoverage), /保留页面或完整页面集合证明已变化/);
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

test('正式发布只允许当前会议工作区的四个约定客户端路径', () => {
    const prefix = `static/client/papers/2026-11-03/conference-${'a'.repeat(24)}/`;
    for (const basename of ['citation.bib', 'citation.json', 'citation.ris', 'rethink-context.json']) {
        assert.equal(api.safeRelative(prefix + basename), prefix + basename);
    }
    for (const path of [prefix + 'raw.json', prefix + '../citation.bib', prefix + 'citation.json\n',
        prefix.replace('conference-', 'arxiv-') + 'citation.json']) {
        assert.throws(() => api.safeRelative(path), /路径不安全/);
    }
});

test('发布权威记录显式绑定注册表和暂存的历史版本身份', () => {
    const f = versionedFixture();
    const proof = api.historicalSourceVersionProof(f.item, { source: f.source }, { sourceDisclosure: f.sourceVersion });
    assert.equal(proof.sourceVersionIdentitySha256, f.sourceVersion.identitySha256);
    assert.equal(proof.sourceManifestSha256, f.source.sourceManifestSha256);
    assert.deepEqual(proof.sourceVersion, f.sourceVersion);
    const drifted = structuredClone(f.sourceVersion); drifted.selectedSourceId = `${f.arxivId}v2`;
    assert.throws(() => api.historicalSourceVersionProof(f.item, { source: f.source }, { sourceDisclosure: drifted }),
        /登记表与暂存页面的历史版本证明已变化|identity evidence\/SHA drifted/);
    assert.throws(() => api.historicalSourceVersionProof(f.item, { source: { ...f.source, sourceVersion: undefined } },
        { sourceDisclosure: f.sourceVersion }), /缺少登记表中的来源证明/);
    const protocols = require('../scripts/lib/protocol-codec');
    const family = freshSource.HISTORICAL_VERSION_CONTRACT;
    const originalHeader = protocols.registeredHeaders(family).find(header => !header.schemaFingerprint);
    const { contract, schemaFingerprint, identitySha256, ...fields } = f.sourceVersion;
    const rawOriginal = { ...originalHeader, ...fields };
    const original = { ...rawOriginal, identitySha256: require('node:crypto').createHash('sha256')
        .update(protocols.canonical(rawOriginal)).digest('hex') };
    const originalProof = api.historicalSourceVersionProof(f.item, { source: { ...f.source, sourceVersion: original } },
        { sourceDisclosure: original });
    assert.deepEqual(originalProof.sourceVersion, original);
    assert.throws(() => api.historicalSourceVersionProof(f.item, { source: f.source },
        { sourceDisclosure: { ...f.sourceVersion, schemaFingerprint: '0'.repeat(64) } }), /格式或原结构指纹无效/);
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
    assert.throws(() => check(`${frontMatter}# body\n`), /顶部的指定来源说明缺失、重复或位置不符/);
    assert.throws(() => check(`${frontMatter}# body\n\n${disclosure}\n`), /顶部的指定来源说明缺失、重复或位置不符/);
    assert.throws(() => check(`${frontMatter}${disclosure}\n\n${disclosure}\n`), /顶部的指定来源说明缺失、重复或位置不符/);

    const ordinaryProducer = { kind: 'direct-page-staging', paperId: f.item.paperId, runId: publicationId,
        manifestSha256: hash('9') };
    assert.throws(() => api.deterministicReview({ path: 'content/posts/ordinary.md', sha256: sha(Buffer.from(exact)),
        producers: [ordinaryProducer] }, Buffer.from(exact)), /普通直接重写页面含不属于它的历史版本来源说明/);
});

test('审查约定给全新来源、运行器和页面暂存的实现都记指纹', () => {
    const names = api.reviewProtocolImplementationFiles().map(filename => path.basename(filename));
    assert.ok(names.includes('page-tag-metadata.js'));
    assert.ok(names.includes('tag-rules.js'));
    assert.ok(names.includes('package-lock.json'));
    assert.ok(names.includes('fresh-arxiv-rewrite-source.js'));
    assert.ok(names.includes('historical-direct-rewrite-runner.js'));
    assert.ok(names.includes('historical-direct-page-staging.js'));
    for (const leaf of ['publish_common.py', 'reader-author-replay-cli.js',
        'reader-pdf-extraction-scope.js', 'workflow-error-policy.js', 'workflow-implementation-files.js']) {
        assert.ok(names.includes(leaf), `shared transitive dependency must be included: ${leaf}`);
    }
    assert.match(api.reviewProtocolFingerprint({ hugoVersion: 'hugo v0.fixture' }), /^[a-f0-9]{64}$/);
});

test('新历史审查指纹覆盖真实传递叶依赖的字节变化，不改任何源文件', t => {
    const originalRead = fs.readFileSync;
    const target = path.resolve(__dirname, '../scripts/publish_common.py');
    const baseline = api.reviewProtocolFingerprint({ hugoVersion: 'hugo v0.fixture' });
    const baselineSemantic = api.semanticReviewProtocol();
    let observed = 0;
    t.mock.method(fs, 'readFileSync', function (filename, ...options) {
        const value = originalRead.call(fs, filename, ...options);
        if (typeof filename !== 'string' || path.resolve(filename) !== target) return value;
        observed += 1;
        return typeof value === 'string' ? value + '\n# test-only changed dependency bytes\n'
            : Buffer.concat([value, Buffer.from('\n# test-only changed dependency bytes\n')]);
    });
    assert.notEqual(api.reviewProtocolFingerprint({ hugoVersion: 'hugo v0.fixture' }), baseline);
    const changedSemantic = api.semanticReviewProtocol();
    assert.notEqual(changedSemantic.implementationSha256, baselineSemantic.implementationSha256);
    assert.notEqual(changedSemantic.protocolSha256, baselineSemantic.protocolSha256,
        'a real shared leaf change must reach the unit-level content-rejection gate too');
    assert.equal(changedSemantic.promptSha256, baselineSemantic.promptSha256,
        'do not pretend a shared validator change rewrote the original prompt file');
    assert.ok(observed > 0, 'the normal public fingerprint must read the actual shared dependency');
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
    assert.throws(() => api.deterministicReview({ path: 'content/posts/one.md', sha256: hash('a') }, mixed), /待审查文件的内容已变化/);
});

test('正式发布允许规范 arXiv 工作区侧车路径并支持 status --blog-repo', () => {
    for (const slug of ['2605-30365', '2605-30365v2', '2403-14817v10']) {
        const prefix = `static/client/papers/2026-11-03/${slug}/`;
        for (const basename of ['citation.bib', 'citation.json', 'citation.ris', 'rethink-context.json']) {
            assert.equal(api.safeRelative(prefix + basename), prefix + basename);
        }
    }
    for (const invalid of [
        'static/client/papers/2026-11-03/2605-30365v0/citation.json',
        'static/client/papers/2026-11-03/arxiv-2605-30365/citation.json',
        'static/client/papers/2026-11-03/2605-30365/other.json'
    ]) {
        assert.throws(() => api.safeRelative(invalid), /路径不安全/);
    }
    const parsed = cli.parseArgs(['status', '--publication-id', publicationId, '--blog-repo', '/tmp/blog']);
    assert.deepEqual(parsed, { action: 'status', publicationId, liveRemote: true, blogRepo: '/tmp/blog' });
    assert.throws(() => cli.parseArgs(['status', '--publication-id', publicationId, '--blog-repo', 'relative/blog']), /命令写法不对/);
});

test('历史语义审查协议默认分块 20000、上限 32000 tokens 并遵循 PD_BLOG_REVIEW_TIMEOUT', t => {
    const saved = {
        PD_BLOG_REVIEW_CHUNK_CHARS: process.env.PD_BLOG_REVIEW_CHUNK_CHARS,
        PD_BLOG_REVIEW_MAX_TOKENS: process.env.PD_BLOG_REVIEW_MAX_TOKENS,
        PD_BLOG_REVIEW_TIMEOUT: process.env.PD_BLOG_REVIEW_TIMEOUT
    };
    t.after(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
    delete process.env.PD_BLOG_REVIEW_CHUNK_CHARS;
    delete process.env.PD_BLOG_REVIEW_MAX_TOKENS;
    delete process.env.PD_BLOG_REVIEW_TIMEOUT;
    const defaults = api.semanticReviewProtocol();
    assert.equal(defaults.budgets.chunkChars, 20000);
    assert.equal(defaults.budgets.maxTokens, 4000);
    assert.equal(defaults.budgets.timeoutSeconds, 120);

    process.env.PD_BLOG_REVIEW_MAX_TOKENS = '32000';
    process.env.PD_BLOG_REVIEW_TIMEOUT = '240';
    const tuned = api.semanticReviewProtocol();
    assert.equal(tuned.budgets.maxTokens, 32000);
    assert.equal(tuned.budgets.timeoutSeconds, 240);

    process.env.PD_BLOG_REVIEW_MAX_TOKENS = '99999';
    process.env.PD_BLOG_REVIEW_TIMEOUT = '999';
    const clamped = api.semanticReviewProtocol();
    assert.equal(clamped.budgets.maxTokens, 32000);
    assert.equal(clamped.budgets.timeoutSeconds, 600);
});

test('新建博客文件默认 0644，且已推送后缺 publication.json 时可按 commit.json 恢复', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-publication-recover-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outputRoot = path.join(root, 'publications');
    const blogRepo = path.join(root, 'blog');
    fs.mkdirSync(blogRepo, { recursive: true });
    const addedPath = 'content/posts/2026-09-01-new-paper.md';
    const next = Buffer.from(
        '---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\n'
        + `paper_digest_tags_contract: "paper-tag-flat-tags-v2"\npaper_digest_tags_registry_sha256: "${hash('b')}"\n`
        + 'paper_digest_tags_registry_version: "paper-tag-catalog-v2"\ndraft: false\n---\n\n# Body\n'
    );
    const authority = fakeAuthority(next, Buffer.from('old'));
    authority.artifacts[0].path = addedPath;
    authority.artifacts[0].baselineSha256 = null;
    const deps = {
        loadAuthority: () => authority,
        blogState,
        gitBlob: () => null,
        sourceBytes: () => next,
        validatePublishedTagCatalog: () => ({ valid: true }),
        hugoVersion: 'hugo v0.fixture',
        hugoGate: () => ({ status: 'passed', engine: 'hugo', version: 'hugo v0.fixture' }),
        semanticReview: ({ loadedPlan, generation, protocol }) => {
            const results = generation.manifest.files.filter(f => f.path.endsWith('.md')).map(f => {
                const item = { path: f.path, sha256: f.sha256, textChunks: 1, imageCount: 0,
                    imageReviewMode: 'not-required', passed: true, issues: [] };
                return { ...item, resultSha256: api.stableHash(item) };
            });
            const body = { ...require('../scripts/lib/protocol-codec').recordHeader('historical-direct-semantic-review', 'historical-direct-semantic-review'),
                publicationId: loadedPlan.plan.publicationId, generationSha256: generation.manifest.generationSha256,
                reviewProtocolFingerprint: protocol,
                semanticProtocol: api.semanticReviewProtocol(), results, resultSetSha256: api.stableHash(results), passed: true };
            return { receipt: { ...body, semanticReviewSha256: api.stableHash(body) }, fileSha256: hash('7') };
        },
        validateActivatedWorktree: () => {},
        now: () => now
    };
    const plan = api.buildPlan({ publicationId, authorityOptions: {}, blogRepo, createdAt: now }, deps);
    api.writePlan({ outputRoot, plan });
    api.generate({ outputRoot, publicationId, authorityOptions: {}, blogRepo, apply: true }, deps);
    api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps);
    api.activate({ outputRoot, publicationId, blogRepo, apply: true }, deps);

    const installed = path.join(blogRepo, addedPath);
    assert.equal(fs.statSync(installed).mode & 0o777, 0o644);

    // 模拟已提交并已推送到远端，但在写入 publication.json 前进程中止
    const pushedCommit = oid('e');
    const committed = {
        ...deps,
        prePublishRemote: () => ({ remoteIdentitySha256: hash('d'), remoteOid: oid('a'), localHead: oid('a'), branch: 'main' }),
        publishGit: () => pushedCommit,
        pushAndVerify: () => { throw new Error('simulated crash after push'); }
    };
    assert.throws(() => api.publish({ outputRoot, publicationId, blogRepo, apply: true }, committed), /simulated crash after push/);
    const loaded = api.loadPlan({ outputRoot, publicationId });
    assert.equal(fs.existsSync(path.join(loaded.directory, 'commit.json')), true);
    assert.equal(fs.existsSync(path.join(loaded.directory, 'publication.json')), false);

    let verifyDeltaCalled = 0;
    const recovered = api.publish({ outputRoot, publicationId, blogRepo, apply: true }, {
        ...deps,
        prePublishRemote: () => ({ remoteIdentitySha256: hash('d'), remoteOid: pushedCommit, localHead: pushedCommit, branch: 'main' }),
        verifyCommittedDelta: ({ commit }) => { assert.equal(commit, pushedCommit); verifyDeltaCalled += 1; },
        publishGit: () => { throw new Error('must not re-commit'); },
        pushAndVerify: () => { throw new Error('must not re-push'); },
        liveRemote: () => ({ remoteIdentitySha256: hash('d'), remoteOid: pushedCommit })
    });
    assert.equal(recovered.status, 'published');
    assert.equal(verifyDeltaCalled, 1);
    assert.equal(recovered.receipt.publicationCommit, pushedCommit);
    assert.equal(recovered.receipt.remoteVerifiedOid, pushedCommit);
    assert.equal(fs.existsSync(path.join(loaded.directory, 'publication.json')), true);
});

test('G13: deterministicReview 阻断乱码、重复段、内部评分锚点、未转义 HTML、裸 $ 公式与错位表格', () => {
    const fm = '---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_tags_contract: "paper-tag-flat-tags"\ndraft: false\n---\n\n';
    const check = body => {
        const bytes = Buffer.from(fm + body);
        return api.deterministicReview({ path: 'content/posts/check.md', sha256: sha(bytes) }, bytes);
    };
    const longPara = '这是一段足够长的正文段落用于检测完全重复的段落问题，它包含完整的技术描述、实验口径、误差分析与架构细节说明，整体字符长度明确超过八十个字符阈值，以确保严格触发重复段落阻断规则并防止重复粘贴上线。';
    assert.doesNotThrow(() => check('# 标题\n\n干净正文，支持 \\(\\alpha + \\beta\\) 与价格 $12.50。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n'));
    assert.throws(() => check('含乱码 \ufffd 字符。\n'), /UTF-8 乱码/);
    assert.throws(() => check(`${longPara}\n\n${longPara}\n`), /完全重复的长正文段落/);
    assert.throws(() => check('正文泄漏 [A_METHOD_01] 内部锚点。\n'), /内部评分证据锚点/);
    assert.throws(() => check('正文包含 <b>裸粗体</b> 标签。\n'), /裸 HTML/);
    assert.throws(() => check('正文包含未转义 <task> 标签。\n'), /未转义的 HTML-like 标签/);
    assert.throws(() => check('正文包含未转换公式 $\\alpha + \\beta$。\n'), /裸 \$ LaTeX 公式/);
    assert.throws(() => check('| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n'), /列数不对齐/);
});

test('G13: runHugoRenderedHtmlGate 阻断 Hugo HTML 中的 <merror> 与 katex-error，放行干净页面', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-hugo-html-gate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceDir = path.join(root, 'site');
    const publicDir = path.join(root, 'public');
    const mdRel = 'content/posts/2026-09-01-math-page.md';
    fs.mkdirSync(path.dirname(path.join(sourceDir, mdRel)), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, mdRel), '---\ntitle: "Math Page"\ndate: 2026-09-01\n---\n\n正文。\n');
    const htmlDir = path.join(publicDir, 'posts', '2026-09-01-math-page');
    fs.mkdirSync(htmlDir, { recursive: true });
    const htmlFile = path.join(htmlDir, 'index.html');

    fs.writeFileSync(htmlFile, '<html><head><title>Math Page | 音频研究门户</title></head><body><div class="post-content"><p>正常正文</p></div></body></html>');
    assert.deepEqual(api.runHugoRenderedHtmlGate({ publicDir, sourceDir, modifiedMarkdownPaths: [mdRel] }), []);

    fs.writeFileSync(htmlFile, '<html><head><title>Math Page | 音频研究门户</title></head><body><div class="post-content"><math><merror><mtext>bad</mtext></merror></math></div></body></html>');
    const merrorIssues = api.runHugoRenderedHtmlGate({ publicDir, sourceDir, modifiedMarkdownPaths: [mdRel] });
    assert.ok(merrorIssues.some(msg => msg.includes('<merror>')), JSON.stringify(merrorIssues));

    fs.writeFileSync(htmlFile, '<html><head><title>Math Page | 音频研究门户</title></head><body><div class="post-content"><span class="katex-error">\\bad</span></div></body></html>');
    const katexIssues = api.runHugoRenderedHtmlGate({ publicDir, sourceDir, modifiedMarkdownPaths: [mdRel] });
    assert.ok(katexIssues.some(msg => msg.includes('katex-error')), JSON.stringify(katexIssues));
});

test('G17 & G16: --waive-visuals 自动绑定 2026-11-02 不生图政策，status 呈现 pagesDeployVerified/webVerified 且兼容旧事务', t => {
    const parsedWaive = cli.parseArgs(['plan', '--apply', '--publication-id', publicationId,
        '--plan-file', '/tmp/plan.json', '--registry-file', '/tmp/registry.json',
        '--projection-file', '/tmp/projection.json', '--waive-visuals', '--paper-ids', 'arxiv:2605.30365']);
    assert.equal(parsedWaive.waiveVisuals, true);
    assert.equal(parsedWaive.visualDispositionFile, undefined);
    assert.throws(() => cli.parseArgs(['plan', '--apply', '--publication-id', publicationId,
        '--plan-file', '/tmp/plan.json', '--registry-file', '/tmp/registry.json',
        '--projection-file', '/tmp/projection.json', '--waive-visuals', '--visual-disposition', '/tmp/v.json']), /命令写法不对/);

    const disposition = api.buildStandingWaiveVisualDisposition({
        plan: { planSha256: hash('1') },
        scope: 'selected-sample-publication'
    });
    assert.equal(disposition.mode, 'waived');
    assert.equal(disposition.requestedBy, 'user');
    assert.match(disposition.reason, /2026-11-02/);

    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-publication-online-status-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outputRoot = path.join(root, 'runtime');
    const blogRepo = path.join(root, 'blog');
    fs.mkdirSync(path.join(blogRepo, 'content', 'posts'), { recursive: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    const identity = `paper_digest_tags_registry_sha256: ${hash('a')}\npaper_digest_tags_registry_version: paper-tag-catalog\n`;
    const baseline = Buffer.from(`---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_tags_contract: "paper-tag-flat-tags"\n${identity}draft: false\n---\nold\n`);
    const next = Buffer.from(`---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_tags_contract: "paper-tag-flat-tags"\n${identity}draft: false\n---\nnew\n`);
    fs.writeFileSync(path.join(blogRepo, 'content/posts/2026-01-01-paper.md'), baseline);
    const authority = fakeAuthority(next, baseline);
    const deps = {
        loadAuthority: () => authority, blogState, gitBlob: () => baseline,
        worktreeSha: (_repo, rel) => fs.existsSync(path.join(blogRepo, rel)) ? sha(fs.readFileSync(path.join(blogRepo, rel))) : null,
        sourceBytes: () => next, hugoVersion: 'hugo v0.fixture', validatePublishedTagCatalog: () => ({ valid: true }),
        hugoGate: () => ({ status: 'passed', engine: 'fixture', version: 'hugo v0.fixture' }),
        semanticReview: ({ loadedPlan, generation, protocol }) => {
            const page = { path: 'content/posts/2026-01-01-paper.md', sha256: sha(next), textChunks: 1, imageCount: 0, imageReviewMode: 'not-required', passed: true, issues: [] };
            page.resultSha256 = api.stableHash(page);
            const body = { ...require('../scripts/lib/protocol-codec').recordHeader('historical-direct-semantic-review', 'historical-direct-semantic-review'),
                publicationId: loadedPlan.plan.publicationId, generationSha256: generation.manifest.generationSha256,
                reviewProtocolFingerprint: protocol, semanticProtocol: api.semanticReviewProtocol(),
                results: [page], resultSetSha256: api.stableHash([page]), passed: true };
            return { receipt: { ...body, semanticReviewSha256: api.stableHash(body) }, fileSha256: hash('7') };
        },
        validateActivatedWorktree: () => true, now: () => now, publishGit: () => oid('f'),
        prePublishRemote: () => ({ branch: 'main', localHead: oid('a'), remoteIdentitySha256: hash('d'), remoteOid: oid('a') }),
        pushAndVerify: () => ({ remoteName: 'origin', remoteIdentitySha256: hash('d'), remoteVerifiedOid: oid('f') }),
        liveRemote: () => ({ remoteIdentitySha256: hash('d'), remoteOid: oid('f') })
    };
    const plan = api.buildPlan({ publicationId, authorityOptions: {}, blogRepo, createdAt: now }, deps);
    api.writePlan({ outputRoot, plan });
    api.generate({ outputRoot, publicationId, authorityOptions: {}, blogRepo, apply: true }, deps);
    api.review({ outputRoot, publicationId, blogRepo, apply: true }, deps);
    api.activate({ outputRoot, publicationId, blogRepo, apply: true }, deps);
    api.publish({ outputRoot, publicationId, blogRepo, apply: true }, deps);

    const beforeOnline = api.status({ outputRoot, publicationId, blogRepo, liveRemote: true }, deps);
    assert.equal(beforeOnline.complete, true);
    assert.equal(beforeOnline.pagesDeployVerified, false);
    assert.equal(beforeOnline.webVerified, false);

    fs.writeFileSync(path.join(outputRoot, publicationId, 'online-verification.json'), JSON.stringify({
        publicationId, planSha256: plan.planSha256, remoteVerifiedOid: oid('f'), pagesDeployVerified: true, webVerified: true,
        checked: 1, ok: 1, failed: 0, verifiedAt: now
    }, null, 2));
    const afterOnline = api.status({ outputRoot, publicationId, blogRepo, liveRemote: true }, deps);
    assert.equal(afterOnline.pagesDeployVerified, true);
    assert.equal(afterOnline.webVerified, true);
    assert.equal(afterOnline.stages.onlineVerification.complete, true);
});

test('G12: 按日期完整重写样本（selectedPaperIds 覆盖完整日批次）时，loadDirectAuthority 原子同步单篇与 YYYY-MM-DD.md 汇总页', async t => {
    const aggregateApi = require('../scripts/lib/historical-direct-aggregate.js');
    const catalogApi = require('../scripts/lib/historical-direct-rewrite-input-catalog.js');
    const planApi = require('../scripts/lib/historical-direct-rewrite-plan.js');
    const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');
    const directControl = require('../scripts/lib/historical-direct-control.js');
    const engine = require('../scripts/analysis-engine.js');
    const { validAnalysisPaper, validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture.js');

    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-pub-cohort-sync-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blog = path.join(root, 'blog');
    const DATE1 = '2026-08-08';
    const DATE2 = '2026-08-09';
    const writeFile = (filename, value) => {
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filename, value, { mode: 0o600 });
        return sha(Buffer.isBuffer(value) ? value : Buffer.from(value));
    };
    const mkPage = (rel, title, kind, scope, cohortDate) => {
        const arxiv = title.replace('arXiv ', '');
        const body = kind === 'paper' ? `[arXiv](https://arxiv.org/abs/${arxiv})` : 'summary';
        const content = `---\ntitle: ${title}\ndate: ${cohortDate}\n---\n${body}\n`;
        return {
            pageId: `page:${sha(rel)}`, path: rel, primaryUrl: `https://example.test/${path.basename(rel, '.md')}/`,
            contentSha256: writeFile(path.join(blog, rel), content), kind, scope, cohortDate,
            identityHints: kind === 'paper'
                ? { status: 'single', candidates: [{ scheme: 'arxiv', value: arxiv, sources: ['body:arxiv-link'] }] }
                : { status: 'none', candidates: [] }
        };
    };
    const pages = [
        mkPage('content/posts/2026-08-08-p1.md', 'arXiv 2608.00001', 'paper', { type: 'daily', key: DATE1 }, DATE1),
        mkPage(`content/posts/${DATE1}.md`, 'Summary 1', 'daily-summary', { type: 'daily', key: DATE1 }, DATE1),
        mkPage('content/posts/2026-08-09-p2.md', 'arXiv 2608.00002', 'paper', { type: 'daily', key: DATE2 }, DATE2),
        mkPage(`content/posts/${DATE2}.md`, 'Summary 2', 'daily-summary', { type: 'daily', key: DATE2 }, DATE2)
    ];
    const inventory = { counts: {}, ledgerSha256: sha('inv'), pageSetSha256: planApi.stableHash(pages), pages };
    const inventoryFile = path.join(root, 'inventory.json');
    writeFile(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`);
    const writtenCat = catalogApi.buildAndWrite({
        arxivOnly: true, apply: true, name: 'arxiv-only.json', inventoryFile, blogRoot: blog
    }, { files: { historicalDirectRewriteInputCatalogDir: path.join(root, 'catalogs') } });
    const plan = planApi.buildFromFiles({ catalogFile: writtenCat.filename, inventoryFile, blogRoot: blog });
    const projection = aggregateApi.buildAggregateProjection({ plan, inventory });
    const planFile = path.join(root, 'plan.json');
    const projectionFile = path.join(root, 'projection.json');
    writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    writeFile(projectionFile, `${JSON.stringify(projection, null, 2)}\n`);

    const sourceRoot = path.join(root, 'sources');
    const executionRoot = path.join(root, 'executions');
    const stagingRoot = path.join(root, 'staging');
    const registryRoot = path.join(root, 'registries');
    const publicationMetadataRoot = path.join(root, 'pub-meta');
    const aggregateRoot = path.join(root, 'aggregates');
    const captured = new Map();
    const capture = async ({ arxivId, generation }) => {
        const text = `Title ${arxivId}\nAbstract\n${'Exact text. '.repeat(10)}\nKeywords: speech\n1 Introduction\nIn our evaluation on the LibriSpeech test set, our model reduces WER from 10.2% to 9.8% compared with the baseline.`;
        const pdfBytes = Buffer.from(`%PDF-1.4\n${arxivId}\n%%EOF\n`);
        const structuredArtifacts = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha(text) };
        structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
        const rec = {
            arxivId, generation, sourceManifestSha256: sha(`m:${arxivId}`), text,
            runtimeDetails: { paperId: `arxiv:${arxivId}`, source: 'html', sourceId: arxivId, text, imageInfos: [],
                structuredArtifacts, htmlAvailability: 'available', htmlAttempts: 1, warnings: [] },
            manifest: { text: { responseSha256: sha(text), source: 'html', sourceId: arxivId }, pdf: { responseSha256: sha(pdfBytes) } }
        };
        captured.set(arxivId, rec);
        return rec;
    };
    const readPublicationMetadata = ({ arxivId, generation }) => {
        const s = captured.get(arxivId);
        const abstract = `Official abstract for ${arxivId}.`;
        const snapshot = runner.stableHash({ paperId: s.runtimeDetails.paperId, source: s.runtimeDetails.source,
            sourceId: s.runtimeDetails.sourceId, textSha256: sha(s.runtimeDetails.text), structuredArtifacts: s.runtimeDetails.structuredArtifacts });
        return {
            abstract, authors: ['Author One'], sourceManifestSha256: s.sourceManifestSha256,
            sourceSnapshotSha256: snapshot, sourceTextSha256: sha(s.runtimeDetails.text),
            proof: {
                contract: 'historical-arxiv-publication-metadata-v1', paperId: `arxiv:${arxivId}`,
                manifestSha256: sha('sm'), atomResponseSha256: sha('atom'), metadataRecordSha256: sha('meta'),
                abstractSha256: sha(abstract), entryVersion: 1, entryUpdatedAt: '2026-01-01T00:00:00.000Z',
                publishedAt: '2025-12-31T00:00:00.000Z', sourceCapturedAt: '2026-01-02T00:00:00.000Z',
                sourceEarliestCapturedAt: '2026-01-02T00:00:00.000Z', sourceLatestCapturedAt: '2026-01-02T00:00:00.000Z',
                observedAt: '2026-01-03T00:00:00.000Z', sourceId: arxivId, querySourceId: arxivId,
                sourceName: `https://export.arxiv.org/api/query?id_list=${arxivId}&max_results=1`,
                sourceManifestSha256: s.sourceManifestSha256, sourceSnapshotSha256: snapshot,
                sourceTextSha256: sha(s.runtimeDetails.text), generation
            }
        };
    };
    const freshArxiv = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
    t.mock.method(freshArxiv, 'readFreshArxivRewriteSource', args => structuredClone(captured.get(args.arxivId)));
    t.mock.method(runner, 'replayHistoricalReaderPdfSourceForStaging', args => ({
        sourceDetails: captured.get(args.item.route.arxivId).runtimeDetails
    }));
    const rendererSha256 = directPageStaging.currentRendererImplementationSha256();
    t.mock.method(directPageStaging, 'currentRendererImplementationSha256', () => rendererSha256);
    directControl.loadOrCreateSourceStatus({ sourceRoot, plan, generation: 1, apply: true, now });
    for (const item of plan.queue) {
        directControl.updateSourceStatus({ sourceRoot, plan, generation: 1, event: { paperId: item.paperId, status: 'ready' }, now });
    }
    const runRes = await runner.runDirectRewrite({
        apply: true, plan, blogRoot: blog, registryRoot, executionRoot, stagingRoot,
        freshArxivSourceRoot: sourceRoot, publicationMetadataRoot,
        freshArxivFailureHandoffRoot: path.join(root, 'handoffs'), queue: 'arxiv', arxivGeneration: 1,
        paperIds: ['arxiv:2608.00001']
    }, {
        captureFreshArxivRewriteSource: capture,
        assertPublicationMetadataReady: () => {},
        readPublicationMetadata,
        rendererImplementationSha256: () => rendererSha256,
        renderDirectPage: packet => ({ markdown: `---\ndate: ${packet.cohortDate}\n---\n${packet.paper.apiReaderArticle}`, assets: [] }),
        analyze: async ({ item, sourceDescriptor, sourceDetails }) => {
            const paper = validLegacyApiAnalysisPaper(item.route.arxivId);
            const cur = validAnalysisPaper(item.route.arxivId);
            paper.analysisManifest.stages.taxonomySeal = cur.analysisManifest.stages.taxonomySeal;
            paper.analysisManifest.stages.coreSummaryRepair = cur.analysisManifest.stages.coreSummaryRepair;
            paper.analysisManifest.contracts.taxonomy = cur.analysisManifest.contracts.taxonomy;
            paper.analysisManifest.contracts.coreSummary = cur.analysisManifest.contracts.coreSummary;
            for (const f of ['coreSummaryInputAnalysisSha256', 'inputCoreSummarySha256', 'outputCoreSummarySha256']) {
                paper.analysisManifest.stages.scoringAudit[f] = cur.analysisManifest.stages.scoringAudit[f];
            }
            const prov = runner.buildDirectSourceRecord(item, sourceDescriptor);
            paper.directPaperId = item.paperId; paper.title = `Fresh ${item.paperId}`; paper.sourceSha256 = prov.sourceSha256;
            paper.freshRewriteProvenance = prov; paper.analysisManifest.freshRewriteProvenance = structuredClone(prov);
            paper.analysisManifest.sourceAcquisition = { analysisSource: sourceDetails.source, sourceId: sourceDetails.sourceId,
                sourceTextChars: sourceDetails.text.length, usedTextChars: sourceDetails.text.length, fullTextChars: sourceDetails.text.length,
                fullTextAvailable: true, truncated: false, sourceSha256: prov.sourceSha256, usedTextSha256: prov.sourceSha256,
                structuredArtifactsSha256: prov.structuredArtifactsSha256, htmlAttempts: 1, warnings: [] };
            const ai = paper.apiReaderAuthors.identity;
            ai.sourceTextSha256 = prov.sourceSha256; ai.metadataSha256 = runner.stableHash(paper.authors);
            ai.authors[0].nameBinding.metadataSha256 = ai.metadataSha256;
            ai.authors[0].affiliationBindings[0].sourceTextSha256 = prov.sourceSha256;
            paper.apiReaderAuthors.sourceDomSha256 = prov.sourceSha256;
            paper.apiReaderAuthors.identitySha256 = runner.stableHash(ai);
            paper.apiReaderResources.sourceTextSha256 = prov.sourceSha256;
            paper.apiReaderResources.identitySha256 = runner.stableHash({ contract: paper.apiReaderResources.contract,
                sourceTextSha256: prov.sourceSha256, resources: paper.apiReaderResources.resources });
            Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
                readerAuthorsSha256: runner.stableHash(paper.apiReaderAuthors),
                readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
                resourceIdentitySha256: paper.apiReaderResources.identitySha256,
                sourceBindingsSourceTextSha256: prov.sourceSha256,
                structuredArtifactsSha256: prov.structuredArtifactsSha256
            });
            paper.analysisManifest.stages.openSourceScan.resourceEvidenceSha256 = paper.apiReaderResources.identitySha256;
            assert.equal(engine.isSuccessfulAnalysisRecord(paper), true);
            return paper;
        }
    });
    assert.equal(runRes.status, 'complete');
    const aggInputs = aggregateApi.loadDirectAggregateInputs({
        planFile, registryFile: runRes.registryFile, projectionFile, stagingRoot, executionRoot,
        freshArxivSourceRoot: sourceRoot, publicationMetadataRoot, readPublicationMetadata,
        currentRendererImplementationSha256: rendererSha256
    });
    const aggs = aggregateApi.buildDirectAggregates({ inputs: aggInputs, daily: DATE1 });
    aggregateApi.writeDirectAggregates({
        outputRoot: aggregateRoot, aggregateRunId: aggregateApi.aggregateRunIdFor(aggs), aggregates: aggs
    });

    const loaded = api.loadDirectAuthority({
        planFile, registryFile: runRes.registryFile, projectionFile, waiveVisuals: true,
        selectedPaperIds: ['arxiv:2608.00001'], stagingRoot, executionRoot, aggregateRoot,
        freshArxivSourceRoot: sourceRoot, publicationMetadataRoot, readPublicationMetadata
    });
    const paths = loaded.artifacts.map(a => a.path).sort();
    assert.ok(paths.includes('content/posts/2026-08-08-p1.md'), '应包含重写单篇页');
    assert.ok(paths.includes(`content/posts/${DATE1}.md`), '完整日批次样本重写应原子同步对应日期汇总页');
    assert.ok(!paths.includes(`content/posts/${DATE2}.md`), '未入选日期汇总页不得被修改');
    assert.equal(loaded.visualDisposition.mode, 'waived');
});

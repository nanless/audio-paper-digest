'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const api = require('../scripts/lib/historical-publication.js');
const daily = require('../scripts/lib/historical-daily-aggregate.js');
const cli = require('../scripts/historical-publication.js');

const PLAN = '11111111-1111-4111-8111-111111111111';
const STAGE = '22222222-2222-4222-8222-222222222222';
const AGG = daily.aggregateRunIdFor([STAGE]);
const DATE = '2026-09-04'; const HEAD = 'a'.repeat(40); const TREE = 'b'.repeat(40); const CONTENT_TREE = 'c'.repeat(40);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-publication-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stagingRoot = path.join(root, 'staging'); const aggregateRoot = path.join(root, 'aggregates');
    const outputRoot = path.join(root, 'output'); const blogRepo = path.join(root, 'blog');
    for (const dir of [stagingRoot, aggregateRoot, outputRoot, blogRepo]) fs.mkdirSync(dir, { recursive: true });
    const pagePath = `content/posts/${DATE}-paper.md`; const dailyPath = `content/posts/${DATE}.md`;
    const assetPath = 'static/data/papers/2026-09-04/2609-03622/citation.json';
    const oldPage = Buffer.from('OLD_PAGE_NEVER_AUTHOR_INPUT'); const oldDaily = Buffer.from('OLD_DAILY_NEVER_AUTHOR_INPUT');
    const newPage = Buffer.from('NEW_PAGE_ONLY'); const newDaily = Buffer.from('NEW_DAILY_ONLY'); const newAsset = Buffer.from('{"new":true}');
    for (const [relative, bytes] of [[pagePath, oldPage], [dailyPath, oldDaily]]) {
        const filename = path.join(blogRepo, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes);
    }
    const stageRoot = path.join(stagingRoot, STAGE); const stagePage = path.join(stageRoot, 'pages', pagePath);
    const stageAsset = path.join(stageRoot, 'assets', assetPath);
    fs.mkdirSync(path.dirname(stagePage), { recursive: true }); fs.mkdirSync(path.dirname(stageAsset), { recursive: true });
    fs.writeFileSync(stagePage, newPage); fs.writeFileSync(stageAsset, newAsset);
    const stagedPages = [{ paperId: 'arxiv:2609.03622',
        pageKey: `page:${'2'.repeat(64)}`, pagePath, cohortDate: DATE, stagedPath: `pages/${pagePath}`,
        primaryUrl: `https://example.test/posts/${DATE}-paper/`,
        contentSha256: sha(newPage), sourcePageContentSha256: sha(oldPage), analysisRunId: STAGE,
        analysisFileSha256: 'a'.repeat(64), taxonomyAssignmentSha256: 'b'.repeat(64),
        taxonomyFileSha256: 'c'.repeat(64) }];
    const stagedAssets = [{ path: assetPath, sha256: sha(newAsset), size: newAsset.length }];
    const selectedBindings = [{ paperId: stagedPages[0].paperId, pages: [stagedPages[0].pageKey] }];
    const stageBody = { contract: daily.PAGE_STAGING_CONTRACT, version: 1, stagingRunId: STAGE, crosswalkId: PLAN,
        crosswalkStateSha256: 'd'.repeat(64), identityGroupsSha256: '1'.repeat(64), createdAt: '2026-09-07T00:00:00.000Z',
        pages: stagedPages, pageSetSha256: daily.stableHash(stagedPages), assets: stagedAssets,
        assetSetSha256: daily.stableHash(stagedAssets), selectedBindings,
        selectedBindingSha256: daily.stableHash(selectedBindings) };
    const stageManifest = { ...stageBody, manifestSha256: daily.stableHash(stageBody) };
    const stageManifestFile = path.join(stageRoot, 'manifest.json'); fs.writeFileSync(stageManifestFile, `${JSON.stringify(stageManifest, null, 2)}\n`);
    const stageManifestFileSha256 = sha(fs.readFileSync(stageManifestFile));
    const stagingRuns = [{ stagingRunId: STAGE, stagingManifestSha256: stageManifest.manifestSha256,
        stagingManifestFileSha256: stageManifestFileSha256 }];
    const aggregateSource = { stagingRuns, stagingSetSha256: daily.stableHash(stagingRuns), crosswalkId: PLAN,
        crosswalkStateSha256: 'd'.repeat(64), ledgerSha256: 'e'.repeat(64), pageSetSha256: 'f'.repeat(64),
        taxonomyRegistrySha256: '0'.repeat(64) };
    const members = [{ pageKey: stageManifest.pages[0].pageKey, pagePath, singlePageContentSha256: sha(newPage) }];
    const aggregateBody = { contract: daily.CONTRACT, version: daily.VERSION, status: 'complete', date: DATE,
        outputPage: { pageKey: `page:${'3'.repeat(64)}`, path: dailyPath,
            primaryUrl: `https://example.test/posts/${DATE}/`, previousContentSha256: sha(oldDaily) },
        source: aggregateSource, members, memberSetSha256: daily.stableHash(members),
        markdown: newDaily.toString(), markdownSha256: sha(newDaily) };
    const aggregate = { ...aggregateBody, manifestSha256: daily.stableHash(aggregateBody) };
    const aggRoot = path.join(aggregateRoot, AGG); fs.mkdirSync(aggRoot, { recursive: true });
    const aggFile = path.join(aggRoot, `daily-${DATE}.json`); fs.writeFileSync(aggFile, `${JSON.stringify(aggregate, null, 2)}\n`);
    const loadPageStaging = () => ({ runRoot: stageRoot, manifest: stageManifest, manifestFileSha256: stageManifestFileSha256 });
    const loadDailyAggregate = () => ({ runRoot: aggRoot, filename: aggFile, fileSha256: sha(fs.readFileSync(aggFile)), manifest: aggregate });
    const baseline = new Map([[pagePath, oldPage], [dailyPath, oldDaily]]);
    const blogState = () => ({ head: HEAD, treeOid: TREE, contentTreeOid: CONTENT_TREE, branch: 'main', clean: true, remoteName: 'origin',
        remoteIdentitySha256: '5'.repeat(64), remoteOid: HEAD,
        hugoConfig: { path: 'hugo.yaml', sha256: '6'.repeat(64) } });
    const stagingProof = [{ stagingRunId: STAGE, manifestSha256: stageManifest.manifestSha256,
        manifestFileSha256: stageManifestFileSha256, crosswalkId: PLAN, selectedBindingSha256: stageManifest.selectedBindingSha256,
        pageSetSha256: stageManifest.pageSetSha256, assetSetSha256: stageManifest.assetSetSha256,
        analysisBindingsSha256: api.stableHash(stageManifest.pages.map(page => ({ paperId: page.paperId, pageKey: page.pageKey,
            analysisRunId: page.analysisRunId, analysisFileSha256: page.analysisFileSha256,
            taxonomyAssignmentSha256: page.taxonomyAssignmentSha256, taxonomyFileSha256: page.taxonomyFileSha256 }))) }];
    const dailyProof = [{ aggregateRunId: AGG, date: DATE, manifestSha256: aggregate.manifestSha256,
        manifestFileSha256: sha(fs.readFileSync(aggFile)), stagingSetSha256: aggregateSource.stagingSetSha256,
        memberSetSha256: aggregate.memberSetSha256, markdownSha256: aggregate.markdownSha256 }];
    const analysisSources = [{ paperId: stageManifest.pages[0].paperId, pageKey: stageManifest.pages[0].pageKey,
        analysisRunId: STAGE, analysisFileSha256: 'a'.repeat(64), authorityName: 'authority.json',
        authorityFileSha256: '1'.repeat(64), authoritySha256: '2'.repeat(64), sourceSnapshotSha256: '3'.repeat(64),
        fulltextSha256: '4'.repeat(64), sourceSha256: '5'.repeat(64), structuredArtifactsSha256: '6'.repeat(64) }];
    const proofBody = { crosswalkId: PLAN, crosswalkStateSha256: 'd'.repeat(64), identityGroupsSha256: '1'.repeat(64),
        inventoryLedgerSha256: 'e'.repeat(64), inventoryPageSetSha256: 'f'.repeat(64), inventorySourceSha256: '2'.repeat(64),
        inventoryHugoConfig: blogState().hugoConfig, inventoryHead: HEAD, inventoryContentTreeOid: CONTENT_TREE,
        inventoryRemoteName: 'origin', inventoryRemoteIdentitySha256: '5'.repeat(64),
        inventoryRemoteMain: { availability: 'available', oid: HEAD, ref: 'refs/remotes/origin/main' },
        pageStagingRuns: stagingProof, pageStagingSetSha256: api.stableHash(stagingProof), dailyRuns: dailyProof,
        dailyRunSetSha256: api.stableHash(dailyProof), analysisSources,
        analysisSourceSetSha256: api.stableHash(analysisSources) };
    const proof = { ...proofBody, proofSha256: api.stableHash(proofBody) };
    const replayProducerSet = () => ({ staged: [loadPageStaging()], aggregates: [loadDailyAggregate()], proof });
    const deps = { blogState, gitBlob: (_repo, _head, relative) => baseline.get(relative) || null, replayProducerSet };
    const plan = api.buildPlan({ planId: PLAN, pageStagingRunIds: [STAGE], blogRepo,
        dailyAggregates: [{ aggregateRunId: AGG, date: DATE }], conferenceRefs: [] }, { ...deps,
        now: () => '2026-09-07T00:00:00.000Z' });
    api.writePlan({ outputRoot, plan });
    return { root, stagingRoot, aggregateRoot, outputRoot, blogRepo, pagePath, dailyPath, assetPath,
        oldPage, oldDaily, newPage, newDaily, newAsset, stageManifest, aggregate, plan, baseline, deps };
}

test('plan freezes daily DAG, unique path ownership, producer SHA and no old authoring text', t => {
    const f = fixture(t); assert.equal(f.plan.oldGeneratedTextIncluded, false); assert.equal(f.plan.batches.length, 1);
    assert.equal(f.plan.batches[0].batchId, `daily-${DATE}`);
    assert.equal(new Set(f.plan.artifacts.map(item => item.path)).size, f.plan.artifacts.length);
    assert.ok(f.plan.artifacts.every(item => item.producer.manifestSha256));
    assert.doesNotMatch(JSON.stringify(f.plan), /OLD_PAGE|OLD_DAILY/);
    assert.throws(() => api.buildPlan({ planId: PLAN, pageStagingRunIds: [STAGE],
        dailyAggregates: [{ aggregateRunId: AGG, date: DATE }], conferenceRefs: ['conference:icassp:2026'] }, {
        loadPageStaging: () => null, loadDailyAggregate: () => null }), /reserved but unsupported/);
});

test('same plan ID reuses the validated existing plan despite a later createdAt', t => {
    const f = fixture(t);
    const rebuilt = api.buildPlan({ planId: PLAN, pageStagingRunIds: [STAGE], blogRepo: f.blogRepo,
        dailyAggregates: [{ aggregateRunId: AGG, date: DATE }], conferenceRefs: [] }, {
        ...f.deps, now: () => '2026-09-07T00:00:01.000Z' });
    assert.notEqual(rebuilt.planSha256, f.plan.planSha256);
    const written = api.writePlan({ outputRoot: f.outputRoot, plan: rebuilt });
    assert.equal(written.reused, true);
    assert.equal(written.plan.planSha256, f.plan.planSha256);
    assert.equal(api.loadPlan({ outputRoot: f.outputRoot, planId: PLAN }).plan.createdAt, '2026-09-07T00:00:00.000Z');
});

test('atomic immutable write cleans a failed temporary file and never occupies the target', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-publication-write-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'artifact.json'); let writes = 0;
    const io = Object.create(fs);
    io.writeSync = (...args) => { writes += 1; if (writes === 1) return Math.min(3, args[3]);
        const error = new Error('injected EIO'); error.code = 'EIO'; throw error; };
    assert.throws(() => api.writeExact(target, Buffer.from('complete immutable payload'), { io,
        randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), /injected EIO/);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(root), []);
    api.writeExact(target, Buffer.from('complete immutable payload'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'complete immutable payload');
    assert.throws(() => api.writeExact(target, Buffer.from('different')), /different bytes/);
});

test('plan rejects a stale inventory HEAD, content tree, or remote generation', t => {
    const f = fixture(t); const options = { planId: '77777777-7777-4777-8777-777777777777',
        pageStagingRunIds: [STAGE], blogRepo: f.blogRepo, dailyAggregates: [{ aggregateRunId: AGG, date: DATE }] };
    for (const mutate of [
        proof => { proof.inventoryHead = 'd'.repeat(40); },
        proof => { proof.inventoryContentTreeOid = 'd'.repeat(40); },
        proof => { proof.inventoryRemoteMain.oid = 'd'.repeat(40); }
    ]) {
        const replay = f.deps.replayProducerSet(); const proof = structuredClone(replay.proof); mutate(proof);
        const body = structuredClone(proof); delete body.proofSha256; proof.proofSha256 = api.stableHash(body);
        assert.throws(() => api.buildPlan(options, { ...f.deps,
            replayProducerSet: () => ({ ...replay, proof }) }), /generation differs from the inventory baseline/);
    }
});

test('public plan APIs reject traversal and reads detect parent-directory replacement', t => {
    const f = fixture(t);
    assert.throws(() => api.loadPlan({ outputRoot: f.outputRoot, planId: '../escape' }), /plan ID must be a UUID/);
    assert.throws(() => api.writePlan({ outputRoot: f.outputRoot, plan: { planId: '../escape' } }), /schema is invalid|plan ID/);
    const parent = path.join(f.root, 'read-parent'); const moved = path.join(f.root, 'read-parent-moved');
    fs.mkdirSync(parent); const target = path.join(parent, 'value'); fs.writeFileSync(target, 'safe');
    let swapped = false;
    assert.throws(() => api.readRegular(target, 1024, { afterOpen: () => {
        fs.renameSync(parent, moved); fs.symlinkSync(moved, parent); swapped = true;
    } }), /Unsafe fresh rewrite directory|source changed/);
    if (swapped) { fs.unlinkSync(parent); fs.renameSync(moved, parent); }
});

test('bundle-first generate verifies clean main/remote/baseline and never mutates blog', t => {
    const f = fixture(t); const beforePage = fs.readFileSync(path.join(f.blogRepo, f.pagePath));
    let sourceReads = 0; const deps = { ...f.deps, sourceBytes: (item, roots) => { sourceReads++; return api.sourceBytes(item, roots); } };
    const result = api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: true }, deps);
    assert.equal(result.status, 'generated'); assert.equal(result.manifest.oldGeneratedTextIncluded, false);
    assert.equal(sourceReads, result.manifest.files.length, 'each producer is read exactly once before the immutable copy');
    assert.deepEqual(result.manifest.exactDelta.map(item => [item.path, item.operation]).sort(),
        [[f.assetPath, 'create'], [f.dailyPath, 'replace'], [f.pagePath, 'replace']].sort());
    assert.equal(fs.readFileSync(path.join(result.generationRoot, 'bundle', f.pagePath), 'utf8'), 'NEW_PAGE_ONLY');
    assert.deepEqual(fs.readFileSync(path.join(f.blogRepo, f.pagePath)), beforePage);
    assert.equal(fs.existsSync(path.join(f.blogRepo, f.assetPath)), false);
});

test('crash after partial copy resumes exact bytes; producer tamper and baseline drift fail closed', t => {
    const f = fixture(t); let crashed = false;
    assert.throws(() => api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: true }, {
        ...f.deps, afterCopy: () => { if (!crashed) { crashed = true; throw new Error('crash'); } }
    }), /crash/);
    const recovered = api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: true }, f.deps);
    assert.equal(recovered.status, 'generated');
    fs.writeFileSync(path.join(f.stagingRoot, STAGE, 'pages', f.pagePath), 'TAMPER');
    assert.throws(() => api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: false }, f.deps), /producer bytes drifted/);
    fs.writeFileSync(path.join(f.stagingRoot, STAGE, 'pages', f.pagePath), f.newPage);
    fs.writeFileSync(path.join(f.blogRepo, f.pagePath), 'USER CHANGE');
    assert.throws(() => api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: false }, f.deps), /worktree\/baseHead CAS/);
});

test('path/collision/symlink and dirty or diverged remote attacks are rejected', t => {
    const f = fixture(t); const badStage = structuredClone((() => ({ runRoot: '', manifest: {
        stagingRunId: STAGE, manifestSha256: '1'.repeat(64), pages: [{ paperId: 'arxiv:2609.03622', pageKey: `page:${'2'.repeat(64)}`,
            pagePath: '../escape.md', cohortDate: DATE, stagedPath: 'pages/escape', contentSha256: '6'.repeat(64), sourcePageContentSha256: '7'.repeat(64) }], assets: [] }, manifestFileSha256: '4'.repeat(64) }))());
    assert.throws(() => api.buildPlan({ planId: PLAN, pageStagingRunIds: [STAGE], blogRepo: f.blogRepo,
        dailyAggregates: [{ aggregateRunId: AGG, date: DATE }] }, { ...f.deps,
        replayProducerSet: () => ({ staged: [badStage], aggregates: [], proof: f.plan.producerReplay }) }), /unsafe publication path/);
    assert.throws(() => api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: false }, {
        ...f.deps, blogState: () => ({ ...f.deps.blogState(), clean: false }) }), /clean main/);
    assert.throws(() => api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: false }, {
        ...f.deps, blogState: () => ({ ...f.deps.blogState(), remoteOid: 'b'.repeat(40) }) }), /clean main/);
    const linkParent = path.join(f.blogRepo, 'static', 'data'); fs.mkdirSync(path.dirname(linkParent), { recursive: true });
    fs.symlinkSync(f.root, linkParent);
    assert.throws(() => api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: false }, f.deps), /symlink/);
});

test('re-signed plan injection and duplicate path ownership are rejected', t => {
    const f = fixture(t); const filename = path.join(f.outputRoot, PLAN, 'plan.json');
    const injected = JSON.parse(fs.readFileSync(filename));
    injected.artifacts[0].oldBody = 'OLD TEXT MUST NEVER ENTER THE PLAN';
    injected.artifactSetSha256 = api.stableHash(injected.artifacts);
    const body = structuredClone(injected); delete body.planSha256; injected.planSha256 = api.stableHash(body);
    fs.writeFileSync(filename, `${JSON.stringify(injected, null, 2)}\n`);
    assert.throws(() => api.loadPlan({ outputRoot: f.outputRoot, planId: PLAN }), /schema is invalid/);

    const page = f.plan.artifacts.find(item => item.path === f.pagePath);
    const makeStage = runId => ({ runRoot: path.join(f.stagingRoot, runId), manifestFileSha256: '4'.repeat(64), manifest: {
        stagingRunId: runId, manifestSha256: '1'.repeat(64), pages: [{ paperId: page.paperId, pageKey: page.pageKey,
            pagePath: page.path, cohortDate: page.cohortDate, stagedPath: page.source.relativePath,
            contentSha256: page.newSha256, sourcePageContentSha256: page.expectedBaselineSha256 }], assets: [] } });
    const stage2 = '44444444-4444-4444-8444-444444444444';
    assert.throws(() => api.buildPlan({ planId: '55555555-5555-4555-8555-555555555555', blogRepo: f.blogRepo,
        pageStagingRunIds: [STAGE, stage2], dailyAggregates: [{ aggregateRunId: AGG, date: DATE }] }, { ...f.deps,
        replayProducerSet: () => ({ staged: [makeStage(STAGE), makeStage(stage2)], aggregates: [], proof: f.plan.producerReplay })
    }), /multiple producers claim/);
});

test('asset create ownership and generate closing CAS fail closed', t => {
    const f = fixture(t); const existingAsset = Buffer.from('FOREIGN ASSET');
    const asset = path.join(f.blogRepo, f.assetPath); fs.mkdirSync(path.dirname(asset), { recursive: true }); fs.writeFileSync(asset, existingAsset);
    f.baseline.set(f.assetPath, existingAsset);
    assert.throws(() => api.buildPlan({ planId: '66666666-6666-4666-8666-666666666666', blogRepo: f.blogRepo,
        pageStagingRunIds: [STAGE], dailyAggregates: [{ aggregateRunId: AGG, date: DATE }] }, f.deps), /unowned asset already exists/);

    const clean = fixture(t); let snapshots = 0;
    assert.throws(() => api.generateBundle({ outputRoot: clean.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: clean.blogRepo, stagingRoot: clean.stagingRoot, aggregateRoot: clean.aggregateRoot, apply: true }, {
        ...clean.deps, blogState: () => ++snapshots === 1 ? clean.deps.blogState()
            : { ...clean.deps.blogState(), head: 'd'.repeat(40), treeOid: 'e'.repeat(40), contentTreeOid: 'f'.repeat(40), remoteOid: 'd'.repeat(40) }
    }), /changed while generating/);
    assert.equal(fs.existsSync(path.join(clean.outputRoot, PLAN, 'generations', `daily-${DATE}`, 'manifest.json')), false);

    const ignored = fixture(t);
    assert.throws(() => api.generateBundle({ outputRoot: ignored.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: ignored.blogRepo, stagingRoot: ignored.stagingRoot, aggregateRoot: ignored.aggregateRoot, apply: true }, {
        ...ignored.deps, afterCopy: () => fs.writeFileSync(path.join(ignored.blogRepo, ignored.pagePath), 'IGNORED RACE')
    }), /closing worktree CAS/);
});

test('resume rejects extra bundle files, intermediate source symlinks, and duplicate-key plans', t => {
    const f = fixture(t); let crashed = false;
    assert.throws(() => api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: true }, {
        ...f.deps, afterCopy: () => { if (!crashed) { crashed = true; throw new Error('crash'); } }
    }), /crash/);
    const extra = path.join(f.outputRoot, PLAN, 'generations', `daily-${DATE}`, 'bundle/content/posts/extra.md');
    fs.mkdirSync(path.dirname(extra), { recursive: true }); fs.writeFileSync(extra, 'EXTRA');
    assert.throws(() => api.generateBundle({ outputRoot: f.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: f.blogRepo, stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: true }, f.deps), /extra entries/);

    const linked = fixture(t); const pages = path.join(linked.stagingRoot, STAGE, 'pages'); const realPages = `${pages}-real`;
    fs.renameSync(pages, realPages); fs.symlinkSync(realPages, pages);
    assert.throws(() => api.generateBundle({ outputRoot: linked.outputRoot, planId: PLAN, batchId: `daily-${DATE}`,
        blogRepo: linked.blogRepo, stagingRoot: linked.stagingRoot, aggregateRoot: linked.aggregateRoot, apply: false }, linked.deps), /Unsafe fresh rewrite directory/);

    const duplicate = fixture(t); const planFile = path.join(duplicate.outputRoot, PLAN, 'plan.json');
    const bytes = fs.readFileSync(planFile); fs.writeFileSync(planFile, Buffer.concat([Buffer.from('{"contract":"attacker",'), bytes.subarray(1)]));
    assert.throws(() => api.loadPlan({ outputRoot: duplicate.outputRoot, planId: PLAN }), /duplicate JSON key/);
});

test('git blob lookup distinguishes absent paths from Git failures', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-publication-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-b', 'main', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(root, 'hugo.yaml'), 'baseURL: https://example.test/\n');
    execFileSync('git', ['-C', root, 'add', 'hugo.yaml']); execFileSync('git', ['-C', root, 'commit', '-m', 'fixture']);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(api.defaultGitBlob(root, head, 'content/posts/missing.md'), null);
    assert.throws(() => api.defaultGitBlob(root, 'f'.repeat(40), 'content/posts/missing.md'), /git ls-tree failed/);
    assert.throws(() => api.defaultGitBlob(path.join(root, 'absent'), head, 'content/posts/missing.md'), /git ls-tree failed/);
});

test('real blog snapshot binds clean main, tree, Hugo config, remote identity and remote OID', t => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-publication-remote-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const repo = path.join(base, 'blog'); const remote = path.join(base, 'remote.git');
    execFileSync('git', ['init', '--bare', remote]); execFileSync('git', ['init', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'hugo.yaml'), 'baseURL: https://example.test/\n');
    fs.mkdirSync(path.join(repo, 'content', 'posts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'content', 'posts', 'fixture.md'), 'fixture\n');
    execFileSync('git', ['-C', repo, 'add', 'hugo.yaml', 'content/posts/fixture.md']); execFileSync('git', ['-C', repo, 'commit', '-m', 'fixture']);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]); execFileSync('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
    const state = api.defaultBlogState(repo);
    assert.equal(state.clean, true); assert.equal(state.branch, 'main'); assert.equal(state.remoteOid, state.head);
    assert.equal(state.treeOid, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim());
    assert.equal(state.contentTreeOid, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD:content/posts'], { encoding: 'utf8' }).trim());
    assert.equal(state.hugoConfig.sha256, sha(fs.readFileSync(path.join(repo, 'hugo.yaml'))));
});

test('successor generation requires an intact authenticated predecessor bundle', t => {
    const f = fixture(t); const date2 = '2026-09-05'; const batch1 = `daily-${DATE}`; const batch2 = `daily-${date2}`;
    const daily2Path = `content/posts/${date2}.md`; const old2 = Buffer.from('OLD SECOND DAILY'); const fresh2 = Buffer.from('NEW SECOND DAILY');
    const target = path.join(f.blogRepo, daily2Path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, old2);
    f.baseline.set(daily2Path, old2);
    const plan = structuredClone(f.plan); const producer = { kind: 'daily-aggregate', runId: AGG, date: date2,
        manifestSha256: '7'.repeat(64), manifestFileSha256: '8'.repeat(64) };
    plan.producers.push(producer); plan.producers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    plan.artifacts.push({ path: daily2Path, newSha256: sha(fresh2), expectedBaselineSha256: sha(old2),
        baselineSha256: sha(old2), plannedOperation: 'replace', source: { kind: 'daily-aggregate-markdown', runId: AGG, date: date2 },
        producer, cohortDate: date2, pageKey: `page:${'9'.repeat(64)}`, aggregate: true });
    plan.artifacts.sort((a, b) => a.path.localeCompare(b.path)); plan.artifactSetSha256 = api.stableHash(plan.artifacts);
    plan.batches = [{ ...plan.batches[0], predecessorBatchIds: [] }, { batchId: batch2, kind: 'daily-cohort', date: date2,
        paths: [daily2Path], predecessorBatchIds: [batch1], pathSetSha256: api.stableHash([daily2Path]) }];
    plan.batchSetSha256 = api.stableHash(plan.batches);
    const dailyProof = { aggregateRunId: AGG, date: date2, manifestSha256: producer.manifestSha256,
        manifestFileSha256: producer.manifestFileSha256, stagingSetSha256: '9'.repeat(64),
        memberSetSha256: 'a'.repeat(64), markdownSha256: sha(fresh2) };
    plan.producerReplay.dailyRuns.push(dailyProof);
    plan.producerReplay.dailyRuns.sort((a, b) => `${a.date}\0${a.aggregateRunId}`.localeCompare(`${b.date}\0${b.aggregateRunId}`));
    plan.producerReplay.dailyRunSetSha256 = api.stableHash(plan.producerReplay.dailyRuns);
    const proofBody = structuredClone(plan.producerReplay); delete proofBody.proofSha256;
    plan.producerReplay.proofSha256 = api.stableHash(proofBody); plan.producerReplaySha256 = plan.producerReplay.proofSha256;
    const planBody = structuredClone(plan); delete planBody.planSha256; plan.planSha256 = api.stableHash(planBody);
    fs.writeFileSync(path.join(f.outputRoot, PLAN, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const deps = { ...f.deps, replayProducerSet: () => ({ proof: plan.producerReplay }),
        sourceBytes: (item, roots) => item.path === daily2Path ? fresh2 : api.sourceBytes(item, roots) };
    const options = { outputRoot: f.outputRoot, planId: PLAN, blogRepo: f.blogRepo,
        stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, apply: true };
    assert.throws(() => api.generateBundle({ ...options, batchId: batch2 }, deps), /predecessor batch/);
    api.generateBundle({ ...options, batchId: batch1 }, deps);
    const extra = path.join(f.outputRoot, PLAN, 'generations', batch1, 'bundle/content/posts/attacker.md');
    fs.writeFileSync(extra, 'EXTRA');
    assert.throws(() => api.generateBundle({ ...options, batchId: batch2 }, deps), /extra entries/);
    fs.unlinkSync(extra);
    const result = api.generateBundle({ ...options, batchId: batch2 }, deps);
    assert.equal(result.manifest.predecessorProofs[0].batchId, batch1);
});

test('real producer loaders replay staged bytes and rebuild the daily manifest', t => {
    const f = fixture(t); const page = f.stageManifest.pages[0];
    const analysis = '## 评分\n8.2\n\n## 核心摘要\n只来自新 canonical 的摘要。\n\n## 方法概述和架构\nFresh method.';
    const paper = { arxivId: '2609.03622', title: 'Fresh canonical title', analysis,
        parsed: require('../scripts/utils.js').parseAnalysis(analysis) };
    const taxonomy = { status: 'assigned', assignmentSha256: page.taxonomyAssignmentSha256,
        registrySha256: '0'.repeat(64), primaryTaskId: 'task.speech-enhancement', primaryMethodId: 'method.tta',
        concepts: [{ id: 'task.speech-enhancement', facet: 'task', preferredLabel: { zh: '语音增强' } },
            { id: 'method.tta', facet: 'method', preferredLabel: { zh: '测试时自适应' } }] };
    const state = { crosswalkId: PLAN, stateSha256: 'd'.repeat(64), identityGroupsSha256: '1'.repeat(64),
        source: { papers: [{ pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
            cohortDate: DATE, pageContentSha256: page.sourcePageContentSha256, scope: { type: 'daily', key: DATE } }] },
        assignments: { [page.pageKey]: { status: 'verified', sourceAuthority: { paperId: page.paperId } } } };
    const inventory = { ledger: { ledgerSha256: 'e'.repeat(64), pageSetSha256: 'f'.repeat(64),
        source: { head: HEAD, contentTreeOid: CONTENT_TREE, hugoConfig: f.deps.blogState().hugoConfig,
            remoteName: 'origin', remoteIdentitySha256: '5'.repeat(64),
            remoteMain: { availability: 'available', oid: HEAD, ref: 'refs/remotes/origin/main' } },
        pages: [{ pageId: `page:${'3'.repeat(64)}`, path: f.dailyPath,
            primaryUrl: `https://example.test/posts/${DATE}/`, contentSha256: sha(f.oldDaily), kind: 'daily-summary',
            scope: { type: 'daily', key: DATE }, cohortDate: DATE }] } };
    const projection = { crosswalk: state, groups: [{ paperId: page.paperId, paper, taxonomy,
        taxonomyFileSha256: page.taxonomyFileSha256, analysisRunId: page.analysisRunId,
        analysisFileSha256: page.analysisFileSha256, pages: [{ pageKey: page.pageKey, pagePath: page.pagePath,
            primaryUrl: page.primaryUrl, cohortDate: DATE, pageContentSha256: page.sourcePageContentSha256 }] }] };
    const aggregateInputDependencies = { bindTopology: () => ({ state, inventory }), replaySelectedBindings: () => [],
        loadProjectionInputs: () => projection };
    const inputs = daily.loadAggregateInputs({ stagingRoot: f.stagingRoot, stagingRunIds: [STAGE],
        crosswalkRoot: '/unused', inventoryRoot: '/unused', analysisRoot: '/unused', taxonomyRoot: '/unused' },
    aggregateInputDependencies);
    const aggregate = daily.buildDailyAggregates({ inputs, date: DATE });
    fs.unlinkSync(path.join(f.aggregateRoot, AGG, `daily-${DATE}.json`));
    daily.writeAggregates({ outputRoot: f.aggregateRoot, aggregateRunId: AGG, aggregates: aggregate });
    const replay = api.replayProducerSet({ pageStagingRunIds: [STAGE], dailyAggregates: [{ aggregateRunId: AGG, date: DATE }],
        stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, crosswalkRoot: '/unused', inventoryRoot: '/unused',
        analysisRoot: '/unused', taxonomyRoot: '/unused', taxonomyRegistry: '/unused' }, {
        aggregateInputDependencies, replayAnalysisSources: () => f.plan.producerReplay.analysisSources });
    assert.equal(replay.staged[0].manifestFileSha256, sha(fs.readFileSync(path.join(f.stagingRoot, STAGE, 'manifest.json'))));
    assert.equal(replay.aggregates[0].manifest.markdownSha256, sha(Buffer.from(aggregate[0].markdown)));
    assert.equal(replay.proof.dailyRuns[0].stagingSetSha256, aggregate[0].source.stagingSetSha256);
    const { replayProducerSet: _fakeReplay, ...planDependencies } = f.deps;
    const plan = api.buildPlan({ planId: '77777777-7777-4777-8777-777777777777', pageStagingRunIds: [STAGE],
        dailyAggregates: [{ aggregateRunId: AGG, date: DATE }], blogRepo: f.blogRepo,
        stagingRoot: f.stagingRoot, aggregateRoot: f.aggregateRoot, crosswalkRoot: '/unused', inventoryRoot: '/unused',
        analysisRoot: '/unused', taxonomyRoot: '/unused', taxonomyRegistry: '/unused' }, { ...planDependencies,
        aggregateInputDependencies, replayAnalysisSources: () => f.plan.producerReplay.analysisSources,
        now: () => '2026-09-07T00:00:00.000Z' });
    assert.equal(plan.producerReplaySha256, replay.proof.proofSha256);
});

test('CLI keeps phase one explicit and rejects malformed producer refs', () => {
    assert.equal(cli.parseArgs(['plan', '--dry-run', '--plan-id', PLAN, '--page-staging-runs', STAGE,
        '--daily-aggregates', `${AGG}@${DATE}`]).dailyAggregates[0].date, DATE);
    assert.equal(cli.parseArgs(['generate', '--apply', '--plan-id', PLAN, '--batch-id', `daily-${DATE}`]).apply, true);
    assert.throws(() => cli.parseArgs(['plan', '--apply', '--plan-id', PLAN, '--page-staging-runs', '../x',
        '--daily-aggregates', `${AGG}@${DATE}`]), /Use/);
    const config = { PUBLISH_CONFIG: { blogRepo: '/blog' }, FILES: { historicalPublicationDir: '/publication',
        historicalPageStagingDir: '/staging', historicalDailyAggregateDir: '/aggregate', pageSourceCrosswalkDir: '/crosswalk',
        historicalPageInventoryDir: '/inventory', freshRewriteRunsDir: '/analysis',
        historicalTaxonomyAssignmentDir: '/taxonomy', taxonomyRegistry: '/registry' } };
    let planned; const dry = cli.main(['plan', '--dry-run', '--plan-id', PLAN, '--page-staging-runs', STAGE,
        '--daily-aggregates', `${AGG}@${DATE}`], { config, buildPlan: options => { planned = options;
            return { planId: PLAN, planSha256: '1'.repeat(64), batches: [], artifacts: [] }; } });
    assert.equal(dry.status, 'dry-run'); assert.equal(planned.analysisRoot, '/analysis'); assert.equal(planned.blogRepo, '/blog');
    let generated; cli.main(['generate', '--dry-run', '--plan-id', PLAN, '--batch-id', `daily-${DATE}`], {
        config, generateBundle: options => { generated = options; return { status: 'dry-run' }; } });
    assert.equal(generated.outputRoot, '/publication'); assert.equal(generated.taxonomyRegistry, '/registry');
});

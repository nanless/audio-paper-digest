'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/historical-page-staging.js');
const cli = require('../scripts/historical-page-staging.js');
const stableHash = require('../scripts/lib/fresh-rewrite-run.js').stableHash;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const CROSSWALK = '11111111-1111-4111-8111-111111111111';
const STAGING = '22222222-2222-4222-8222-222222222222';
const ANALYSIS_RUN = '33333333-3333-4333-8333-333333333333';
const REGISTRY_SHA = '6'.repeat(64);
const RENDERER_SHA = '5'.repeat(64);

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'page-staging-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paper = { arxivId: '2604.12527', title: 'Fresh title', analysis: 'NEW_CANONICAL_ONLY', parsed: {}, apiReaderArticle: 'NEW_READER_ONLY' };
    const assignmentBody = { contract: 'paper-taxonomy-assignment-v1', version: 1, status: 'assigned',
        paperId: 'arxiv:2604.12527', analysisRunId: ANALYSIS_RUN, registrySha256: REGISTRY_SHA,
        analysisFileSha256: 'a'.repeat(64), analysisRecordSha256: stableHash(paper), analysisSha256: sha(paper.analysis),
        primaryTaskId: 'task.speech-enhancement', primaryMethodId: 'method.tta', conceptIds: ['task.speech-enhancement', 'method.tta'],
        concepts: [{ id: 'task.speech-enhancement', preferredLabel: { zh: '语音增强' } }, { id: 'method.tta', preferredLabel: { zh: '测试时自适应' } }] };
    const assignment = { ...assignmentBody, assignmentSha256: stableHash(assignmentBody) };
    const keys = [`page:${'1'.repeat(64)}`, `page:${'2'.repeat(64)}`];
    const pages = keys.map((pageKey, index) => ({ pageKey, pagePath: `content/posts/page-${index}.md`,
        primaryUrl: `https://example.test/page-${index}/`, cohortDate: index ? '2026-04-21' : '2026-04-19', pageContentSha256: String(index + 3).repeat(64) }));
    const sourceAuthority = { paperId: 'arxiv:2604.12527', authoritySha256: 'f'.repeat(64) };
    const state = { crosswalkId: CROSSWALK, stateSha256: 'b'.repeat(64), identityGroupsSha256: 'c'.repeat(64),
        source: { papers: pages }, assignments: Object.fromEntries(keys.map(key => [key, { status: 'verified',
            decisionArtifactSha256: '9'.repeat(64), sourceAuthority }])),
        identityGroups: [{ paperId: 'arxiv:2604.12527', identitySha256: '7'.repeat(64),
            identityRecordSha256: '8'.repeat(64), groupSha256: 'd'.repeat(64), pageKeys: keys }] };
    const dependencies = { readCrosswalk: () => state, findAssignment: () => ({ value: assignment, fileSha256: 'e'.repeat(64) }),
        rendererImplementationSha256: () => RENDERER_SHA,
        loadTagCatalog: () => ({ registrySha256: REGISTRY_SHA }),
        loadRun: () => ({}), runSnapshot: () => ({ analysisFileSha256: 'a'.repeat(64), papers: [paper] }),
        buildAssignment: () => assignment,
        render: packet => {
            assert.equal(Object.hasOwn(packet, 'taxonomy'), false);
            assert.deepEqual(packet.tagMetadata, assignment);
            assert.equal(packet.paper.apiReaderArticle, 'NEW_READER_ONLY');
            return `---\ndate: ${packet.cohortDate}\n---\nNEW PAGE`;
        },
        now: () => '2026-09-07T00:00:00.000Z' };
    return { root, dependencies, state, paper, assignment };
}

test('同一篇论文生成多个已核验页面，保留页面路径和所属日期', t => {
    const f = fixture(t); const args = { apply: true, crosswalkId: CROSSWALK, stagingRunId: STAGING, limit: 'pilot',
        analysisRunId: ANALYSIS_RUN, crosswalkRoot: '/unused', analysisRoot: '/unused', tagAssignmentRoot: '/unused',
        tagCatalogPath: '/unused', stagingRoot: f.root };
    const result = api.stageHistoricalPages(args, f.dependencies);
    assert.equal(result.selectedIdentities, 1); assert.equal(result.pageCount, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.root, STAGING, 'manifest.json')));
    assert.equal(api.normalizeStagingManifest(manifest).assets.length, 0);
    assert.equal(manifest.rendererImplementationSha256, RENDERER_SHA);
    assert.equal(manifest.contract, 'historical-paper-page-staging-v2');
    assert.equal(manifest.version, 2);
    for (const page of manifest.pages) {
        assert.equal(page.tagAssignmentSha256, f.assignment.assignmentSha256);
        assert.equal(page.tagAssignmentFileSha256, 'e'.repeat(64));
        assert.equal(Object.hasOwn(page, 'taxonomyAssignmentSha256'), false);
        assert.equal(Object.hasOwn(page, 'taxonomyFileSha256'), false);
    }
    const intent = JSON.parse(fs.readFileSync(path.join(f.root, STAGING, 'intent.json')));
    assert.equal(intent.contract, 'historical-paper-page-staging-intent-v2');
    assert.equal(intent.version, 2);
    assert.equal(api.rendererImplementationIdentity().version, 1);
    assert.equal(manifest.selectedBindingSha256, stableHash(manifest.selectedBindings));
    assert.deepEqual(manifest.pages.map(page => page.cohortDate), ['2026-04-19', '2026-04-21']);
    assert.deepEqual(manifest.pages.map(page => page.pagePath), ['content/posts/page-0.md', 'content/posts/page-1.md']);
    assert.match(fs.readFileSync(path.join(f.root, STAGING, 'pages/content/posts/page-0.md'), 'utf8'), /NEW PAGE/);
    assert.doesNotMatch(JSON.stringify(manifest), /old body|OLD_/);
    assert.equal(api.stageHistoricalPages(args, f.dependencies).status, 'recovered');
});

test('完整旧页面只读恢复仍选原标签文件，旁边新版分配不能替换原双 SHA', t => {
    const f = fixture(t);
    const assignmentApi = require('../scripts/lib/historical-tag-assignment.js');
    const assignmentRoot = path.join(f.root, 'assignments');
    const assignmentRunRoot = path.join(assignmentRoot, ANALYSIS_RUN);
    fs.mkdirSync(assignmentRunRoot, { recursive: true });
    const oldFile = path.join(assignmentRunRoot, assignmentApi.legacyAssignmentFilename(f.assignment.paperId, REGISTRY_SHA));
    const oldBytes = Buffer.from(JSON.stringify(f.assignment));
    fs.writeFileSync(oldFile, oldBytes, { mode: 0o600 });
    const args = { apply: true, crosswalkId: CROSSWALK, stagingRunId: STAGING, limit: 'pilot',
        analysisRunId: ANALYSIS_RUN, crosswalkRoot: '/unused', analysisRoot: '/unused',
        tagAssignmentRoot: assignmentRoot, tagCatalogPath: '/unused', stagingRoot: f.root };
    const dependencies = { ...f.dependencies, findAssignment: api.findAssignment };
    api.stageHistoricalPages(args, dependencies);
    const runRoot = path.join(f.root, STAGING);
    // 合成完整旧表示以覆盖旧格式读取；真实当前 writer 已在上一用例核验。
    const oldFields = record => {
        const { tagAssignmentSha256, tagAssignmentFileSha256, ...rest } = record;
        return { ...rest, taxonomyAssignmentSha256: tagAssignmentSha256, taxonomyFileSha256: tagAssignmentFileSha256 };
    };
    const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'manifest.json')));
    manifest.contract = api.LEGACY_CONTRACT; manifest.version = 1;
    manifest.pages = manifest.pages.map(oldFields);
    manifest.pageSetSha256 = stableHash(manifest.pages);
    delete manifest.manifestSha256; manifest.manifestSha256 = stableHash(manifest);
    const intent = JSON.parse(fs.readFileSync(path.join(runRoot, 'intent.json')));
    intent.contract = api.LEGACY_INTENT_CONTRACT; intent.version = 1;
    intent.pageBindings = intent.pageBindings.map(oldFields);
    intent.pageBindingSha256 = stableHash(intent.pageBindings);
    delete intent.intentSha256; intent.intentSha256 = stableHash(intent);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const intentBytes = Buffer.from(`${JSON.stringify(intent, null, 2)}\n`);
    fs.writeFileSync(path.join(runRoot, 'manifest.json'), manifestBytes);
    fs.writeFileSync(path.join(runRoot, 'intent.json'), intentBytes);
    const { assignmentSha256: _oldSha, ...currentBody } = f.assignment;
    Object.assign(currentBody, { contract: assignmentApi.CONTRACT, version: assignmentApi.VERSION });
    const current = { ...currentBody, assignmentSha256: stableHash(currentBody) };
    assignmentApi.writeAssignments({ outputRoot: assignmentRoot, assignments: [current] });
    const replayDependencies = { ...dependencies, buildAssignment: () => current,
        buildLegacyAssignment: () => f.assignment, render: () => assert.fail('恢复不能重新生成正文') };
    const recovered = api.stageHistoricalPages(args, replayDependencies);
    assert.equal(recovered.status, 'recovered');
    assert.deepEqual(recovered.manifest, manifest);
    assert.deepEqual(api.tagAssignmentProofFor(recovered.manifest, recovered.manifest.pages[0]),
        { assignmentSha256: f.assignment.assignmentSha256, fileSha256: sha(oldBytes) });
    assert.deepEqual(fs.readFileSync(oldFile), oldBytes);
    assert.deepEqual(fs.readFileSync(path.join(runRoot, 'manifest.json')), manifestBytes);
    assert.deepEqual(fs.readFileSync(path.join(runRoot, 'intent.json')), intentBytes);
    for (const newValue of [manifest.pages[0].taxonomyAssignmentSha256, null]) {
        const mixed = structuredClone(manifest);
        mixed.pages[0].tagAssignmentSha256 = newValue;
        mixed.pageSetSha256 = stableHash(mixed.pages);
        delete mixed.manifestSha256; mixed.manifestSha256 = stableHash(mixed);
        assert.throws(() => api.normalizeStagingManifest(mixed), /不能混用新旧字段/);
        const badSha = structuredClone(mixed); badSha.manifestSha256 = '0'.repeat(64);
        assert.throws(() => api.normalizeStagingManifest(badSha), /清单自身的 SHA/);
    }
    const wrongGeneration = structuredClone(manifest);
    wrongGeneration.contract = api.CONTRACT; wrongGeneration.version = api.VERSION;
    delete wrongGeneration.manifestSha256; wrongGeneration.manifestSha256 = stableHash(wrongGeneration);
    assert.throws(() => api.normalizeStagingManifest(wrongGeneration), /字段与记录格式版本不一致/);
    const wrongVersion = structuredClone(manifest); wrongVersion.version = 2;
    delete wrongVersion.manifestSha256; wrongVersion.manifestSha256 = stableHash(wrongVersion);
    assert.throws(() => api.normalizeStagingManifest(wrongVersion), /不属于支持的组合/);
    const partialRoot = path.join(f.root, 'old-partial');
    fs.mkdirSync(path.join(partialRoot, STAGING), { recursive: true });
    fs.writeFileSync(path.join(partialRoot, STAGING, 'intent.json'), intentBytes);
    assert.throws(() => api.stageHistoricalPages({ ...args, stagingRoot: partialRoot }, replayDependencies), /尚无完整清单.*新的运行 ID/);
    assert.deepEqual(fs.readFileSync(path.join(partialRoot, STAGING, 'intent.json')), intentBytes);
    fs.appendFileSync(oldFile, '\n');
    assert.throws(() => api.stageHistoricalPages(args, replayDependencies), /原文件 SHA 不一致/);
    assert.deepEqual(fs.readFileSync(path.join(runRoot, 'manifest.json')), manifestBytes);
});

test('暂存意图和清单拒绝在同一个不可变运行 ID 下更换渲染器实现', t => {
    const f = fixture(t); const args = { apply: true, crosswalkId: CROSSWALK, stagingRunId: STAGING,
        limit: 'pilot', analysisRunId: ANALYSIS_RUN, crosswalkRoot: '/unused', analysisRoot: '/unused',
        tagAssignmentRoot: '/unused', tagCatalogPath: '/unused', stagingRoot: f.root,
        rendererImplementationSha256: RENDERER_SHA };
    api.stageHistoricalPages(args, f.dependencies);
    const intent = JSON.parse(fs.readFileSync(path.join(f.root, STAGING, 'intent.json')));
    assert.equal(api.normalizeStagingIntent(intent).rendererImplementationSha256, RENDERER_SHA);
    const replacement = '4'.repeat(64);
    assert.throws(() => api.stageHistoricalPages({ ...args,
        rendererImplementationSha256: replacement }, { ...f.dependencies,
        rendererImplementationSha256: () => replacement }), /已有页面生成记录与本次选择的论文、页面或生成器实现不一致|生成器的实际实现指纹与预期指纹不一致/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, STAGING, 'manifest.json')))
        .rendererImplementationSha256, RENDERER_SHA);
});

test('页面生成过程中生成器实现指纹改变时，拒绝生成清单', t => {
    const f = fixture(t); let reads = 0;
    assert.throws(() => api.stageHistoricalPages({ apply: true, crosswalkId: CROSSWALK,
        stagingRunId: STAGING, limit: 'pilot', analysisRunId: ANALYSIS_RUN,
        crosswalkRoot: '/unused', analysisRoot: '/unused', tagAssignmentRoot: '/unused',
        tagCatalogPath: '/unused', stagingRoot: f.root }, { ...f.dependencies,
        rendererImplementationSha256: () => reads++ === 0 ? RENDERER_SHA : '4'.repeat(64) }),
    /页面生成期间，生成器的实现指纹发生变化/);
    assert.equal(fs.existsSync(path.join(f.root, STAGING, 'manifest.json')), false);
});

test('写入中断后留下的精确页面在同一个意图和运行 ID 下续跑', t => {
    const f = fixture(t); const args = { apply: true, crosswalkId: CROSSWALK,
        stagingRunId: STAGING, limit: 'pilot', analysisRunId: ANALYSIS_RUN,
        crosswalkRoot: '/unused', analysisRoot: '/unused', tagAssignmentRoot: '/unused',
        tagCatalogPath: '/unused', stagingRoot: f.root };
    let reads = 0;
    assert.throws(() => api.stageHistoricalPages(args, { ...f.dependencies,
        rendererImplementationSha256: () => reads++ === 0 ? RENDERER_SHA : '4'.repeat(64) }),
    /页面生成期间，生成器的实现指纹发生变化/);
    const partial = path.join(f.root, STAGING, 'pages/content/posts/page-0.md');
    fs.mkdirSync(path.dirname(partial), { recursive: true });
    fs.writeFileSync(partial, '---\ndate: 2026-04-19\n---\nNEW PAGE');
    const resumed = api.stageHistoricalPages(args, f.dependencies);
    assert.equal(resumed.status, 'staged');
    assert.equal(fs.existsSync(path.join(f.root, STAGING, 'manifest.json')), true);
});

test('渲染器实现身份绑定来源文件和输出根路径配置', () => {
    const real = api.rendererImplementationIdentity();
    assert.match(real.rendererImplementationSha256, /^[a-f0-9]{64}$/);
    const fileBytes = relative => Buffer.from(`implementation:${relative}`);
    const first = api.rendererImplementationIdentity({ blogBasePath: '/audio-paper-digest-blog',
        readImplementationFile: (_absolute, relative) => fileBytes(relative) });
    const changedFile = api.rendererImplementationIdentity({ blogBasePath: '/audio-paper-digest-blog',
        readImplementationFile: (_absolute, relative) => Buffer.concat([
            fileBytes(relative), Buffer.from(relative === 'scripts/publish-to-blog.py' ? ':changed' : '')
        ]) });
    const changedConfig = api.rendererImplementationIdentity({ blogBasePath: '/another-base',
        readImplementationFile: (_absolute, relative) => fileBytes(relative) });
    assert.notEqual(first.rendererImplementationSha256, changedFile.rendererImplementationSha256);
    assert.notEqual(first.rendererImplementationSha256, changedConfig.rendererImplementationSha256);
    assert.deepEqual(first.files.map(item => item.relativePath), api.RENDERER_IMPLEMENTATION_FILES);
});

test('默认渲染器使用私有临时输入文件和受约束的子进程', () => {
    let observedInputFile;
    const rendered = api.defaultRender({ paper: { title: '中文' } }, {
        execFileSync: (command, args, options) => {
            assert.equal(command, 'bash');
            assert.equal(options.input, undefined);
            assert.equal(options.timeout, 60_000);
            assert.equal(options.killSignal, 'SIGKILL');
            assert.equal(args.at(-2), '--input-file');
            observedInputFile = args.at(-1);
            assert.deepEqual(JSON.parse(fs.readFileSync(observedInputFile, 'utf8')),
                { paper: { title: '中文' } });
            assert.equal(fs.statSync(observedInputFile).mode & 0o777, 0o600);
            return Buffer.from('{"markdown":"rendered","assets":[]}');
        }
    });
    assert.deepEqual(rendered, { markdown: 'rendered', assets: [] });
    assert.equal(fs.existsSync(observedInputFile), false);
    assert.equal(fs.existsSync(path.dirname(observedInputFile)), false);
});

test('新增同篇页面不影响已选页面；已选页面的对应记录改变则拒绝', t => {
    const f = fixture(t); const selected = api.loadPageGenerationInputs({ crosswalkRoot: '/unused', crosswalkId: CROSSWALK,
        analysisRoot: '/unused', tagAssignmentRoot: '/unused', tagCatalogPath: '/unused',
        analysisRunId: ANALYSIS_RUN }, f.dependencies).groups;
    const manifest = { selectedBindings: api.selectedBindingsFor(selected) };
    manifest.selectedBindingSha256 = stableHash(manifest.selectedBindings);
    const advanced = structuredClone(f.state); const extraKey = `page:${'a'.repeat(64)}`;
    advanced.source.papers.push({ ...advanced.source.papers[0], pageKey: extraKey, pagePath: 'content/posts/new.md' });
    advanced.assignments[extraKey] = structuredClone(advanced.assignments[advanced.identityGroups[0].pageKeys[0]]);
    advanced.identityGroups[0].pageKeys.push(extraKey);
    assert.equal(api.replaySelectedBindings(manifest, advanced).length, 1);
    advanced.assignments[manifest.selectedBindings[0].pages[0].pageKey].decisionArtifactSha256 = '0'.repeat(64);
    assert.throws(() => api.replaySelectedBindings(manifest, advanced), /当前论文与页面的对应记录与生成清单记录的输入不一致/);
});

test('暂存选用重建后的当前分配，只有完全精确时才接受旧文件名', t => {
    const f = fixture(t); const paperId = 'arxiv:2604.12527';
    const dir = path.join(f.root, 'taxonomy', ANALYSIS_RUN); fs.mkdirSync(dir, { recursive: true });
    const legacy = path.join(dir, `arxiv-2604.12527.taxonomy.${REGISTRY_SHA}.json`);
    fs.writeFileSync(legacy, JSON.stringify(f.assignment));
    assert.equal(api.findAssignment(path.join(f.root, 'taxonomy'), paperId, ANALYSIS_RUN,
        REGISTRY_SHA, f.assignment).value.registrySha256, REGISTRY_SHA);

    const staleBody = structuredClone(f.assignment); delete staleBody.assignmentSha256;
    staleBody.analysisFileSha256 = '4'.repeat(64);
    const stale = { ...staleBody, assignmentSha256: stableHash(staleBody) };
    fs.writeFileSync(legacy, JSON.stringify(stale));
    assert.equal(api.findAssignment(path.join(f.root, 'taxonomy'), paperId, ANALYSIS_RUN,
        REGISTRY_SHA, f.assignment), null, 'a stale legacy artifact must not shadow the current analysis');

    const canonical = path.join(dir,
        `arxiv-2604.12527.taxonomy.${REGISTRY_SHA}.${f.assignment.assignmentSha256}.json`);
    fs.writeFileSync(canonical, JSON.stringify(f.assignment));
    assert.equal(api.findAssignment(path.join(f.root, 'taxonomy'), paperId, ANALYSIS_RUN,
        REGISTRY_SHA, f.assignment).legacyFilename, false);
    assert.equal(fs.existsSync(legacy), true, 'the stale legacy audit remains immutable');
    const { assignmentSha256: _oldSha, ...currentBody } = f.assignment;
    Object.assign(currentBody, { contract: 'paper-tag-assignment-v2', version: 2 });
    const current = { ...currentBody, assignmentSha256: stableHash(currentBody) };
    const assignments = require('../scripts/lib/historical-tag-assignment.js');
    const currentFile = path.join(dir, assignments.assignmentFilename(paperId, REGISTRY_SHA, current.assignmentSha256));
    fs.writeFileSync(currentFile, JSON.stringify(current));
    const lookup = { rebuildLegacyAssignment: () => f.assignment };
    assert.deepEqual(api.findAssignment(path.join(f.root, 'taxonomy'), paperId, ANALYSIS_RUN, REGISTRY_SHA, current, lookup).value, current);
    const originalLegacyBytes = fs.readFileSync(canonical);
    fs.writeFileSync(currentFile, '{不是 JSON');
    assert.throws(() => api.findAssignment(path.join(f.root, 'taxonomy'), paperId, ANALYSIS_RUN, REGISTRY_SHA, current, lookup), /JSON/);
    assert.deepEqual(fs.readFileSync(canonical), originalLegacyBytes, '坏新版目标不会回退到有效旧文件');
    fs.unlinkSync(currentFile);
    const newRoot = path.join(f.root, 'new-default'), customRoot = path.join(f.root, 'custom');
    const files = { historicalTagAssignmentDir: newRoot, legacyHistoricalTagAssignmentDir: path.join(f.root, 'taxonomy') };
    assert.deepEqual(api.findAssignment(newRoot, paperId, ANALYSIS_RUN, REGISTRY_SHA, current, { ...lookup, files }).value, f.assignment);
    assert.equal(api.findAssignment(customRoot, paperId, ANALYSIS_RUN, REGISTRY_SHA, current, { ...lookup, files }), null);
    assert.throws(() => api.findAssignment(path.join(f.root, 'taxonomy'), paperId, null,
        REGISTRY_SHA, f.assignment), /查找标签记录所需的绝对目录、运行 ID、词表 SHA 或重新计算的预期记录缺失、格式无效或不一致/);
});

test('标签分配文件核原对象 SHA 后严格检查已知版本与对应文件名', t => {
    const f = fixture(t), assignments = require('../scripts/lib/historical-tag-assignment.js');
    const dir = path.join(f.root, 'formats'); fs.mkdirSync(dir);
    for (const [contract, version, currentName, pattern] of [
        ['paper-tag-assignment-v2', 1, true, /格式版本不受支持/],
        ['paper-tag-assignment-v3', 3, true, /格式版本不受支持/],
        ['paper-taxonomy-assignment-v1', 1, true, /格式、哈希或文件名无效/]
    ]) {
        const { assignmentSha256: _oldSha, ...body } = f.assignment;
        Object.assign(body, { contract, version });
        const value = { ...body, assignmentSha256: stableHash(body) };
        const name = (currentName ? assignments.assignmentFilename : assignments.legacyHashedAssignmentFilename)(
            value.paperId, value.registrySha256, value.assignmentSha256);
        const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value));
        assert.throws(() => api.readAssignment(file), pattern);
    }
});

test('预演只校验输入，不写暂存目录', t => {
    const f = fixture(t); const result = api.stageHistoricalPages({ apply: false, crosswalkId: CROSSWALK,
        analysisRunId: ANALYSIS_RUN, limit: 'pilot', crosswalkRoot: '/unused', analysisRoot: '/unused',
        tagAssignmentRoot: '/unused', tagCatalogPath: '/unused', stagingRoot: f.root }, f.dependencies);
    assert.equal(result.status, 'dry-run'); assert.equal(result.selectedPages, 2); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('暂存命令行要求写入时给出运行 ID，支持试点或数字批次', () => {
    assert.equal(cli.parseArgs(['--dry-run', '--crosswalk', CROSSWALK, '--analysis-run', ANALYSIS_RUN,
        '--limit', 'pilot']).limit, 'pilot');
    assert.equal(cli.parseArgs(['--apply', '--crosswalk', CROSSWALK, '--analysis-run', ANALYSIS_RUN,
        '--run-id', STAGING, '--limit', '20']).limit, 20);
    assert.throws(() => cli.parseArgs(['--apply', '--crosswalk', CROSSWALK, '--run-id', STAGING]), /^Error: 用法：/);
});

test('分配读取器拒绝重复 JSON 键和符号链接', t => {
    const f = fixture(t); const dir = path.join(f.root, 'unsafe'); fs.mkdirSync(dir);
    const name = `arxiv-2604.12527.taxonomy.${REGISTRY_SHA}.json`; const target = path.join(dir, name);
    fs.writeFileSync(target, `{"contract":"paper-taxonomy-assignment-v1","version":1,"status":"assigned","status":"blocked","paperId":"arxiv:2604.12527","analysisRunId":"${ANALYSIS_RUN}","registrySha256":"${REGISTRY_SHA}","assignmentSha256":"${'a'.repeat(64)}"}`);
    assert.throws(() => api.readAssignment(target), /JSON 中出现重复字段/);
    const link = path.join(dir, `arxiv-2604.12528.taxonomy.${REGISTRY_SHA}.json`); fs.symlinkSync(target, link);
    assert.throws(() => api.readAssignment(link), /不安全：必须是没有符号链接、硬链接数量符合读取要求且大小不超过限制的普通文件/);
});

test('页面暂存拒绝素材路径穿越和已存在的符号链接运行目录', t => {
    const f = fixture(t); const args = { apply: true, crosswalkId: CROSSWALK,
        stagingRunId: '44444444-4444-4444-8444-444444444444', analysisRunId: ANALYSIS_RUN,
        limit: 'pilot', crosswalkRoot: '/unused', analysisRoot: '/unused', tagAssignmentRoot: '/unused',
        tagCatalogPath: '/unused', stagingRoot: f.root };
    assert.throws(() => api.stageHistoricalPages(args, { ...f.dependencies,
        render: () => ({ markdown: 'FRESH', assets: [{ path: 'static/images/papers/../../../../escape.bin', base64: 'eA==' }] }) }), /资源路径或 base64 数据格式无效/);
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const symlinkRun = '55555555-5555-4555-8555-555555555555'; fs.symlinkSync(outside, path.join(f.root, symlinkRun));
    assert.throws(() => api.stageHistoricalPages({ ...args, stagingRunId: symlinkRun }, f.dependencies), /Unsafe fresh rewrite directory/);
});

test('页面暂存拒绝与当前词表重算结果不一致的标签记录', t => {
    const f = fixture(t);
    assert.throws(() => api.stageHistoricalPages({ apply: false, crosswalkId: CROSSWALK,
        analysisRunId: ANALYSIS_RUN, limit: 'pilot', crosswalkRoot: '/unused', analysisRoot: '/unused',
        tagAssignmentRoot: '/unused', tagCatalogPath: '/unused', stagingRoot: f.root }, {
        ...f.dependencies, buildAssignment: () => ({ forged: true, assignmentSha256: 'f'.repeat(64) })
    }), /标签记录与按当前词表重新计算的记录不一致/);
});

test('已准备的分配 A 不能用 A 的暂存身份去暂存分析 B', t => {
    const f = fixture(t); const staleExpected = {
        paperId: f.assignment.paperId,
        analysisRunId: f.assignment.analysisRunId,
        analysisFileSha256: '4'.repeat(64),
        analysisRecordSha256: '3'.repeat(64),
        analysisSha256: '2'.repeat(64),
        registrySha256: f.assignment.registrySha256,
        assignmentSha256: '1'.repeat(64),
        tagAssignmentFileSha256: 'e'.repeat(64)
    };
    assert.throws(() => api.stageHistoricalPages({ apply: true, crosswalkId: CROSSWALK,
        stagingRunId: STAGING, expectedStagingRunId: STAGING,
        expectedAssignment: staleExpected, analysisRunId: ANALYSIS_RUN, limit: 'pilot',
        crosswalkRoot: '/unused', analysisRoot: '/unused', tagAssignmentRoot: '/unused',
        tagCatalogPath: '/unused', stagingRoot: f.root }, f.dependencies), /预期标签记录或页面生成运行 ID 与本次选择不一致/);
    assert.equal(fs.existsSync(path.join(f.root, STAGING)), false,
        'assignment drift must fail before writing staging intent or directories');
});

test('writeExact 在恢复路径上拒绝末端和父级符号链接', t => {
    const f = fixture(t); const outside = path.join(f.root, 'outside.bin'); fs.writeFileSync(outside, 'outside');
    const safe = path.join(f.root, 'safe'); fs.mkdirSync(safe);
    const leaf = path.join(safe, 'leaf.bin'); fs.symlinkSync(outside, leaf);
    assert.throws(() => api.writeExact(leaf, Buffer.from('fresh')), /普通单链接文件/);
    const parent = path.join(f.root, 'linked-parent'); fs.symlinkSync(safe, parent);
    assert.throws(() => api.writeExact(path.join(parent, 'child.bin'), Buffer.from('fresh')), /Unsafe fresh rewrite directory/);
});

test('渲染失败只留下不可变输入意图，同一运行 ID 可安全续跑', t => {
    const f = fixture(t); const runId = '66666666-6666-4666-8666-666666666666';
    const args = { apply: true, crosswalkId: CROSSWALK, stagingRunId: runId,
        analysisRunId: ANALYSIS_RUN, limit: 'pilot', crosswalkRoot: '/unused', analysisRoot: '/unused',
        tagAssignmentRoot: '/unused', tagCatalogPath: '/unused', stagingRoot: f.root };
    assert.throws(() => api.stageHistoricalPages(args, { ...f.dependencies,
        render: () => { throw new Error('real publisher contract rejected'); } }), /publisher contract/);
    assert.deepEqual(fs.readdirSync(path.join(f.root, runId)), ['intent.json']);
    assert.equal(api.stageHistoricalPages(args, f.dependencies).status, 'staged');
    const intent = api.normalizeStagingIntent(JSON.parse(fs.readFileSync(path.join(f.root, runId, 'intent.json'))));
    const manifest = api.normalizeStagingManifest(JSON.parse(fs.readFileSync(path.join(f.root, runId, 'manifest.json'))));
    assert.equal(intent.selectedBindingSha256, manifest.selectedBindingSha256);
});

test('没有清单的旧版半成品文件因缺少输入意图而被拒绝', t => {
    const f = fixture(t); const runId = '77777777-7777-4777-8777-777777777777';
    const runRoot = path.join(f.root, runId); fs.mkdirSync(path.join(runRoot, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(runRoot, 'pages', 'orphan.md'), 'partial');
    assert.throws(() => api.stageHistoricalPages({ apply: true, crosswalkId: CROSSWALK,
        stagingRunId: runId, analysisRunId: ANALYSIS_RUN, limit: 'pilot', crosswalkRoot: '/unused',
        analysisRoot: '/unused', tagAssignmentRoot: '/unused', tagCatalogPath: '/unused', stagingRoot: f.root },
    f.dependencies), /生成目录中的文件与本次输入和生成结果不完全对应，无法生成清单/);
});

function stagingArgs(root) {
    return {
        apply: true,
        crosswalkId: CROSSWALK,
        stagingRunId: STAGING,
        limit: 'pilot',
        analysisRunId: ANALYSIS_RUN,
        crosswalkRoot: '/unused',
        analysisRoot: '/unused',
        tagAssignmentRoot: '/unused',
        tagCatalogPath: '/unused',
        stagingRoot: root
    };
}

function interruptedStage(f, target, beforeLink = false) {
    const script = `
        const fs = require('node:fs');
        const api = require(process.argv[1]);
        const { args, state, assignment, paper, target, beforeLink } = JSON.parse(process.argv[2]);
        const dependencies = {
            readCrosswalk: () => state,
            findAssignment: () => ({ value: assignment, fileSha256: 'e'.repeat(64) }),
            rendererImplementationSha256: () => ${JSON.stringify(RENDERER_SHA)},
            loadTagCatalog: () => ({ registrySha256: ${JSON.stringify(REGISTRY_SHA)} }),
            loadRun: () => ({}),
            runSnapshot: () => ({ analysisFileSha256: 'a'.repeat(64), papers: [paper] }),
            buildAssignment: () => assignment,
            render: packet => '---\\ndate: ' + packet.cohortDate + '\\n---\\nNEW PAGE',
            now: () => '2026-09-07T00:00:00.000Z'
        };
        const link = fs.linkSync;
        fs.linkSync = function(source, destination) {
            if (!beforeLink) link.call(this, source, destination);
            if (destination.endsWith(target)) process.kill(process.pid, 'SIGKILL');
            if (beforeLink) link.call(this, source, destination);
        };
        api.stageHistoricalPages(args, dependencies);
    `;
    return require('node:child_process').spawnSync(process.execPath, [
        '-e', script,
        require.resolve('../scripts/lib/historical-page-staging'),
        JSON.stringify({ args: stagingArgs(f.root), state: f.state, assignment: f.assignment,
            paper: f.paper, target, beforeLink })
    ], { encoding: 'utf8', timeout: 10000 });
}

test('页面短写失败不留下半截正式文件，同一意图可以正常重试', t => {
    const f = fixture(t);
    const args = stagingArgs(f.root);
    const original = fs.writeSync;
    let injected = false;
    fs.writeSync = function(fd, bytes, offset, length, position) {
        if (!injected) {
            injected = true;
            original.call(this, fd, bytes, offset, 4, position);
            throw Object.assign(new Error('测试页面磁盘写入失败'), { code: 'EIO' });
        }
        return original.call(this, fd, bytes, offset, length, position);
    };
    try {
        assert.throws(() => api.stageHistoricalPages(args, f.dependencies), /测试页面磁盘写入失败/);
    } finally {
        fs.writeSync = original;
    }
    assert.equal(fs.existsSync(path.join(f.root, STAGING, 'intent.json')), false);
    assert.equal(api.stageHistoricalPages(args, f.dependencies).status, 'staged');
});

test('正式链接后进程退出，意图、页面和最终清单都能从同一公开入口恢复', t => {
    for (const target of ['intent.json', 'page-0.md', 'manifest.json']) {
        const f = fixture(t);
        const child = interruptedStage(f, target);
        assert.equal(child.signal, 'SIGKILL', child.stderr);
        const relative = target === 'page-0.md' ? 'pages/content/posts/page-0.md' : target;
        const filename = path.join(f.root, STAGING, relative);
        const originalBytes = fs.readFileSync(filename);
        assert.equal(fs.lstatSync(filename).nlink, 2);
        const result = api.stageHistoricalPages(stagingArgs(f.root), f.dependencies);
        assert.equal(result.status, target === 'manifest.json' ? 'recovered' : 'staged');
        assert.deepEqual(fs.readFileSync(filename), originalBytes);
        assert.equal(fs.lstatSync(filename).nlink, 1);
        assert.equal(api.stageHistoricalPages(stagingArgs(f.root), f.dependencies).status, 'recovered');
    }
});

test('恢复前发现输入身份改变时，不删除旧清单的任何临时硬链接', t => {
    const f = fixture(t);
    assert.equal(interruptedStage(f, 'manifest.json').signal, 'SIGKILL');
    const runRoot = path.join(f.root, STAGING);
    const before = fs.readdirSync(runRoot).sort();
    const filename = path.join(runRoot, 'manifest.json');
    const originalBytes = fs.readFileSync(filename);
    const changedState = structuredClone(f.state);
    changedState.identityGroups[0].identitySha256 = '4'.repeat(64);
    assert.throws(() => api.stageHistoricalPages(stagingArgs(f.root), {
        ...f.dependencies,
        readCrosswalk: () => changedState
    }), /已有页面生成记录与本次选择.*不一致/);
    assert.deepEqual(fs.readdirSync(runRoot).sort(), before);
    assert.equal(fs.lstatSync(filename).nlink, 2);
    assert.deepEqual(fs.readFileSync(filename), originalBytes);
});

test('链接前退出留下未知临时文件时明确拒绝，不把残片当成正式意图', t => {
    const f = fixture(t);
    assert.equal(interruptedStage(f, 'intent.json', true).signal, 'SIGKILL');
    const runRoot = path.join(f.root, STAGING);
    const before = fs.readdirSync(runRoot).sort();
    assert.equal(fs.existsSync(path.join(runRoot, 'intent.json')), false);
    assert.throws(() => api.stageHistoricalPages(stagingArgs(f.root), f.dependencies), /未完成文件/);
    assert.deepEqual(fs.readdirSync(runRoot).sort(), before);
});

test('写入进程在正文尚未完整时被强制退出，不产生半截正式文件', t => {
    const f = fixture(t);
    const filename = path.join(f.root, 'page.md');
    const script = `
        const fs = require('node:fs');
        const api = require(process.argv[1]);
        const write = fs.writeSync;
        fs.writeSync = function(fd, bytes, offset, length, position) {
            write.call(this, fd, bytes, offset, 4, position);
            process.kill(process.pid, 'SIGKILL');
        };
        api.writeExact(process.argv[2], Buffer.from('complete historical page'));
    `;
    const child = require('node:child_process').spawnSync(process.execPath, [
        '-e', script, require.resolve('../scripts/lib/historical-page-staging'), filename
    ], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(fs.existsSync(filename), false);
    assert.ok(fs.readdirSync(f.root).some(name => name.endsWith('.tmp')),
        '链接前退出的未知临时文件保留供核验，不自动删除');
});

test('只读拒绝双链接，显式恢复也不能删除未知链接或活写者链接', t => {
    for (const owner of ['unknown', 'live']) {
        const f = fixture(t);
        api.stageHistoricalPages(stagingArgs(f.root), f.dependencies);
        const filename = path.join(f.root, STAGING, 'manifest.json');
        const hostId = crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
        const link = path.join(path.dirname(filename), owner === 'live'
            ? `.manifest.json.${hostId}.${process.pid}.${crypto.randomUUID()}.tmp`
            : 'unknown-hardlink');
        fs.linkSync(filename, link);
        const originalBytes = fs.readFileSync(filename);
        assert.throws(() => api.readRegular(filename, 16 * 1024 * 1024, '只读检查'), /不安全/);
        assert.throws(() => api.stageHistoricalPages(stagingArgs(f.root), f.dependencies), /普通单链接文件/);
        assert.equal(fs.existsSync(link), true);
        assert.equal(fs.lstatSync(filename).nlink, 2);
        assert.deepEqual(fs.readFileSync(filename), originalBytes);
    }
});

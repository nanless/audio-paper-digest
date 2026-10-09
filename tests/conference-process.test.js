'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const test = require('node:test');
const processApi = require('../scripts/lib/conference-process.js');
const staging = require('../scripts/lib/conference-staging.js');
const engine = require('../scripts/analysis-engine.js');
const cli = require('../scripts/conference-process.js');
const discovery = require('../scripts/lib/conference-discovery.js');
const filter = require('../scripts/lib/conference-filter.js');
const extractionFixture = require('./helpers/conference-extraction-fixture.js');
const evidenceFixture = require('./helpers/conference-filter-evidence-fixture.js');
const utils = require('../scripts/utils.js');
const { loadOriginalConferenceProcessApis } = require('./helpers/conference-process-original-fixture.js');

const H = value => processApi.stableHash(value);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function executionIdentity({ env = {}, limits = {}, secondary = {} } = {}) {
    const analysisConfig = Object.fromEntries(processApi.DEEP_EXECUTION_LIMIT_FIELDS
        .map(field => [field, /Temperature$/.test(field) ? 0.1 : 1000]));
    return processApi.deepExecutionConfigIdentity({
        env: {
            PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
            PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1',
            PD_OPENAI_RESPONSES_REASONING_EFFORT: 'low',
            PD_OPENAI_RESPONSES_STREAM: '1',
            ...env
        },
        analysisConfig: { ...analysisConfig, ...limits },
        secondaryModelConfig: secondary,
        utilsApi: utils
    });
}
function fixture(t, count = 1, original = null) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-process-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const members = Array.from({ length: count }, (_, index) => ({
        paperId: `conference:odyssey:2026:conference-paper-id:paper.${index + 1}`,
        sourceIdentity: `conference-paper-id:paper.${index + 1}`
    }));
    const runtimeAuthority = { implementationSha256: original ? original.implementationSha256 : H('implementation'),
        deepExecutionConfig: executionIdentity() };
    const authority = { conferenceId: 'odyssey-2026', catalogName: 'catalog.json', reportName: 'report.json',
        filterId: '11111111-1111-4111-8111-111111111111', catalogSha256: H('catalog'), reportSha256: H('report'),
        filterPolicySha256: H('policy'), selectionReceiptSha256: H('selection'),
        selectedMemberSetSha256: H(members.map(item => item.paperId)),
        ...(original ? { taxonomyVersion: 'taxonomy-v1', taxonomyRegistrySha256: H('taxonomy') }
            : { tagCatalogVersion: 'paper-tag-catalog-v2', tagCatalogSha256: H('tag catalog') }), implementationSha256: runtimeAuthority.implementationSha256,
        deepExecutionConfig: runtimeAuthority.deepExecutionConfig };
    const files = { conferenceProcessDir: path.join(root, 'processes') };
    const context = { authority, members, files };
    let tick = 0;
    const deps = { files, engine, now: () => new Date(Date.parse('2026-09-09T00:00:00.000Z') + tick++ * 1000).toISOString(),
        loadAuthority: () => context,
        implementationSha256: () => runtimeAuthority.implementationSha256,
        deepExecutionConfigIdentity: () => runtimeAuthority.deepExecutionConfig,
        prepareShared: async () => ({ planHandle: {}, planReceiptSha256: H('plan'), sealed: members.map(member => ({
            paperId: member.paperId, proof: { requestSha256: H(`request:${member.paperId}`),
                receiptSha256: H(`receipt:${member.paperId}`), verificationSha256: H(`verify:${member.paperId}`),
                textSha256: H(`text:${member.paperId}`), artifactsSha256: H(`artifacts:${member.paperId}`),
                pdfSha256: H(`pdf:${member.paperId}`) } })) }),
        aggregate: async (_context, _shared, ids) => ({ manifest: { aggregateId: H(ids).slice(0, 32),
            manifestSha256: H(['manifest', ids]), markdownSha256: H(['markdown', ids]),
            pagePath: 'content/posts/conference-odyssey-2026.md' } }) };
    return { root, members, authority, runtimeAuthority, files, context, deps };
}
function success(item) {
    return { analysisProof: { analysisSha256: H(`analysis:${item.paperId}`),
        completionReceiptSha256: H(`analysis-receipt:${item.paperId}`), sourceSnapshotSha256: H(`source:${item.paperId}`) },
    pageProof: { manifestSha256: H(`page:${item.paperId}`), contentSha256: H(`content:${item.paperId}`),
        pagePath: `content/posts/${item.paperId.split(':').at(-1)}.md` } };
}
// 写真实的 analysis.json 和 staging page.md/manifest.json，proof 由实际字节算出，
// 这样 --verify-files 的通过与失败都能用同一套测试样例数据区分。
function writeConferenceArtifacts(files, item) {
    const analysisDirectory = path.join(files.conferenceAnalysisDir, item.analysisRunId);
    fs.mkdirSync(analysisDirectory, { recursive: true, mode: 0o700 });
    const analysisBytes = Buffer.from(`${JSON.stringify({ status: 'complete', paperId: item.paperId,
        executionId: item.analysisRunId })}\n`);
    fs.writeFileSync(path.join(analysisDirectory, 'analysis.json'), analysisBytes, { mode: 0o600 });
    const stagingDirectory = path.join(files.conferencePageStagingDir, item.analysisRunId, H('registry'), H('implementation'));
    fs.mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    const pageBytes = Buffer.from(`---\npaper_digest_paper_id: "${item.paperId}"\n---\n# ${item.paperId}\n`);
    fs.writeFileSync(path.join(stagingDirectory, 'page.md'), pageBytes, { mode: 0o600 });
    const body = { contract: 'conference-paper-page-staging-v2', version: 2, status: 'complete',
        paperId: item.paperId, analysisExecutionId: item.analysisRunId, analysisSha256: sha256(analysisBytes),
        completionReceiptSha256: H(`analysis-receipt:${item.paperId}`), sourceSnapshotSha256: H(`source:${item.paperId}`),
        pagePath: `content/posts/${item.paperId.split(':').at(-1)}.md`, contentSha256: sha256(pageBytes) };
    const manifest = { ...body, manifestSha256: H(body) };
    fs.writeFileSync(path.join(stagingDirectory, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), { mode: 0o600 });
    return { analysisProof: { analysisSha256: body.analysisSha256,
            completionReceiptSha256: body.completionReceiptSha256, sourceSnapshotSha256: body.sourceSnapshotSha256 },
        pageProof: { manifestSha256: manifest.manifestSha256, contentSha256: manifest.contentSha256,
            pagePath: manifest.pagePath } };
}
function writeConferenceAggregate(files, context, ids) {
    const aggregateId = H(ids).slice(0, 32);
    const directory = path.join(files.conferenceAggregateDir, context.authority.conferenceId, aggregateId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const markdown = Buffer.from('# aggregate\n');
    fs.writeFileSync(path.join(directory, 'aggregate.md'), markdown, { mode: 0o600 });
    const body = { contract: 'conference-aggregate-staging-v2', version: 2, status: 'complete',
        aggregateId, conferenceId: context.authority.conferenceId, markdownSha256: sha256(markdown),
        pagePath: 'content/posts/conference-odyssey-2026.md' };
    const manifest = { ...body, manifestSha256: H(body) };
    fs.writeFileSync(path.join(directory, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), { mode: 0o600 });
    return { manifest };
}

test('单篇模拟端到端把来源、共用分析、页面和汇总收在一份不可变凭证下', async t => {
    const f = fixture(t); let calls = 0;
    const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 3 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => { calls += 1; return success(item); } });
    assert.equal(first.status, 'complete'); assert.equal(calls, 1);
    const processId = first.processId; const directory = path.join(f.files.conferenceProcessDir, processId);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    assert.equal(state.status, 'complete'); assert.equal(Object.values(state.items)[0].status, 'complete');
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'completion-receipt.json')));
    const { receiptSha256, ...body } = receipt; assert.equal(receiptSha256, processApi.stableHash(body));
    const resumed = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async () => { calls += 1; throw new Error('completed paper must not run again'); } });
    assert.equal(resumed.status, 'complete'); assert.equal(resumed.processId, processId); assert.equal(calls, 1);
});

test('部分完成的论文用同一个确定性 UUID 续跑，不重跑已完成的同伴', async t => {
    const f = fixture(t, 2); const attempts = new Map();
    const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 2 };
    const worker = async (_context, _shared, item) => {
        attempts.set(item.paperId, (attempts.get(item.paperId) || 0) + 1);
        if (item.paperId === f.members[1].paperId && attempts.get(item.paperId) === 1) throw new Error('fixture interruption');
        return success(item);
    };
    const first = await processApi.runConferenceProcess(options, { ...f.deps, processPaper: worker });
    assert.equal(first.status, 'partial');
    const processDirectory = path.join(f.files.conferenceProcessDir, first.processId);
    const partial = processApi.assertState(JSON.parse(fs.readFileSync(path.join(processDirectory, 'state.json'))));
    assert.equal(partial.status, 'partial');
    assert.equal(partial.aggregate, null);
    assert.equal(partial.completionReceiptSha256, null);
    assert.equal(fs.existsSync(path.join(processDirectory, 'completion-receipt.json')), false);
    assert.deepEqual(cli.processStatus(options, { dependencies: f.deps }), {
        status: 'partial', processId: first.processId, conferenceId: f.authority.conferenceId,
        stateSha256: partial.stateSha256, papers: { complete: 1, analysis_partial: 1 },
        completionReceiptSha256: null, tagReview: 0, filesVerified: false
    });
    const second = await processApi.runConferenceProcess({ ...options, retryFailed: true }, { ...f.deps, processPaper: worker });
    assert.equal(second.status, 'complete');
    assert.equal(attempts.get(f.members[0].paperId), 1); assert.equal(attempts.get(f.members[1].paperId), 2);
    const state = JSON.parse(fs.readFileSync(path.join(f.files.conferenceProcessDir, second.processId, 'state.json')));
    for (const item of Object.values(state.items)) assert.equal(item.analysisRunId,
        processApi.deterministicUuid(second.processId, item.paperId, 'analysis'));
});

test('状态查询和完成凭证拒绝前后矛盾的生命周期声明', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const completed = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => success(item) });
    const directory = path.join(f.files.conferenceProcessDir, completed.processId);
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'completion-receipt.json')));

    const unknown = { ...state, status: 'stopped' };
    unknown.stateSha256 = processApi.stateDigest(unknown);
    assert.throws(() => processApi.assertState(unknown), /checkpoint integrity/);

    const partial = { ...state, status: 'partial', aggregate: null, completionReceiptSha256: null };
    partial.stateSha256 = processApi.stateDigest(partial);
    assert.throws(() => processApi.assertState(partial), /标为 partial，但所有论文都已完成/);

    const incompleteWithProof = { ...state, status: 'running' };
    incompleteWithProof.stateSha256 = processApi.stateDigest(incompleteWithProof);
    assert.throws(() => processApi.assertState(incompleteWithProof), /尚未完成，不能保存汇总记录或完成凭证哈希/);

    const incompleteItem = structuredClone(state);
    incompleteItem.items[f.members[0].paperId].status = 'analysis_partial';
    incompleteItem.stateSha256 = processApi.stateDigest(incompleteItem);
    assert.throws(() => processApi.assertState(incompleteItem), /已标为完成，但仍有未完成论文/);

    const validPartial = structuredClone(state);
    validPartial.status = 'partial';
    validPartial.items[f.members[0].paperId].status = 'analysis_partial';
    validPartial.aggregate = null;
    validPartial.completionReceiptSha256 = null;
    validPartial.stateSha256 = processApi.stateDigest(validPartial);
    assert.doesNotThrow(() => processApi.assertState(validPartial));
    assert.throws(() => processApi.validateCompletionReceipt(validPartial, receipt),
        /completion receipt requires a complete checkpoint/);
});

test('--status 默认不核磁盘，--verify-files 才区分凭证自洽与文件缺失、损坏', async t => {
    const f = fixture(t, 2);
    const root = path.dirname(f.files.conferenceProcessDir);
    Object.assign(f.files, { conferenceAnalysisDir: path.join(root, 'analysis'),
        conferencePageStagingDir: path.join(root, 'staging'), conferenceAggregateDir: path.join(root, 'aggregates') });
    const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const statusOptions = { catalogName: 'catalog.json', reportName: 'report.json', filterId: f.authority.filterId };
    const written = new Map();
    const completed = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => {
            const proof = writeConferenceArtifacts(f.files, item); written.set(item.paperId, item.analysisRunId); return proof; },
        aggregate: async (context, _shared, ids) => writeConferenceAggregate(f.files, context, ids) });
    assert.equal(completed.status, 'complete');

    const blind = cli.processStatus(statusOptions, { dependencies: f.deps });
    assert.equal(blind.status, 'complete');
    assert.equal(blind.filesVerified, false);
    assert.equal(blind.fileVerification, undefined);
    const verified = cli.processStatus({ ...statusOptions, verifyFiles: true }, { dependencies: f.deps });
    assert.equal(verified.status, 'complete'); assert.equal(verified.filesVerified, true);
    assert.deepEqual(verified.fileVerification, { status: 'ok', checkedPapers: 2, failures: [] });
    assert.equal(cli.statusExitCode(verified), 0);

    const victim = f.members[0].paperId;
    const runDirectory = path.join(f.files.conferencePageStagingDir, written.get(victim));
    const [registryName] = fs.readdirSync(runDirectory);
    const [implementationName] = fs.readdirSync(path.join(runDirectory, registryName));
    const pageFile = path.join(runDirectory, registryName, implementationName, 'page.md');
    fs.rmSync(pageFile);
    // 凭证没动，所以默认 --status 仍报 complete：这正是要修的盲区。
    assert.equal(cli.processStatus(statusOptions, { dependencies: f.deps }).status, 'complete');
    const missing = cli.processStatus({ ...statusOptions, verifyFiles: true }, { dependencies: f.deps });
    assert.equal(missing.fileVerification.status, 'failed');
    assert.deepEqual(missing.fileVerification.failures.map(item => [item.paperId, item.artifact]),
        [[victim, 'page']]);
    assert.match(missing.fileVerification.failures[0].detail, /page\.md/);
    assert.equal(cli.statusExitCode(missing), 1);

    const tampered = f.members[1].paperId;
    const analysisFile = path.join(f.files.conferenceAnalysisDir, written.get(tampered), 'analysis.json');
    fs.writeFileSync(analysisFile, Buffer.from('{"status":"complete","tampered":true}\n'), { mode: 0o600 });
    const damaged = cli.processStatus({ ...statusOptions, verifyFiles: true }, { dependencies: f.deps });
    assert.deepEqual(damaged.fileVerification.failures.map(item => [item.paperId, item.artifact]),
        [[victim, 'page'], [tampered, 'analysis']]);
    assert.match(damaged.fileVerification.failures[1].detail, /analysis\.json 的 SHA/);

    const aggregateFile = path.join(f.files.conferenceAggregateDir, f.authority.conferenceId,
        completed.aggregate.aggregateId, 'aggregate.md');
    fs.rmSync(aggregateFile);
    const noAggregate = cli.processStatus({ ...statusOptions, verifyFiles: true }, { dependencies: f.deps });
    assert.deepEqual(noAggregate.fileVerification.failures.map(item => [item.paperId, item.artifact]),
        [[victim, 'page'], [tampered, 'analysis'], [null, 'aggregate']]);

    assert.equal(cli.parseArgs(['--status', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', f.authority.filterId, '--verify-files']).verifyFiles, true);
    assert.equal(cli.parseArgs(['--status', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', f.authority.filterId]).verifyFiles, undefined);
    assert.throws(() => cli.parseArgs(['--apply', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', f.authority.filterId, '--verify-files']), /Use/);
});

test('调度器把每篇论文的完整生命周期上限设为三', async t => {
    const f = fixture(t, 7); let active = 0, maximum = 0;
    const result = await processApi.runConferenceProcess({ apply: true, catalogName: 'catalog.json',
        reportName: 'report.json', filterId: f.authority.filterId, concurrency: 3 }, { ...f.deps,
        processPaper: async (_context, _shared, item) => { active += 1; maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 5)); active -= 1; return success(item); } });
    assert.equal(result.status, 'complete'); assert.equal(maximum, 3);
});

test('实现指纹绑定显式的分析、Reader、身份和提示词依赖', () => {
    const required = [
        'scripts/deep-analyzer.js', 'scripts/analysis-engine.js',
        'scripts/config.js', 'scripts/env-loader.js', 'scripts/llm-account-pool.js',
        'scripts/lib/conference-analysis-context.js', 'scripts/lib/paper-identity.js',
        'scripts/paper_identity.py', 'scripts/utils.py', 'scripts/lib/reader-contract.js',
        'scripts/lib/reader-repair.js', 'scripts/lib/reader-tables.js',
        'scripts/lib/reader-resource-binding.js', 'scripts/lib/reader-resource-sync.js',
        'prompts/api-reader-article.md',
        'prompts/deep-analysis.md', 'prompts/scoring-audit.md', 'prompts/opensource-scan.md'
    ];
    assert.equal(new Set(processApi.IMPLEMENTATION_FILES).size, processApi.IMPLEMENTATION_FILES.length);
    for (const name of required) assert.ok(processApi.IMPLEMENTATION_FILES.includes(name), name);
    for (const name of processApi.IMPLEMENTATION_FILES) {
        assert.equal(fs.statSync(path.join(__dirname, '..', name)).isFile(), true, name);
    }
    assert.match(processApi.implementationSha256(), /^[a-f0-9]{64}$/);
    const root = '/virtual/conference-process-implementation';
    const sources = new Map(processApi.currentImplementationFiles()
        .map(name => [name, Buffer.from(`source:${name}`)]));
    const fingerprint = () => processApi.implementationSha256({ root,
        readFileSync: filename => sources.get(path.relative(root, filename)) });
    const baseline = fingerprint();
    // Reader 正文已迁到 v2，当前指纹绑的是 -v2 那份；v1 那份留给旧记录复算。
    for (const name of ['scripts/deep-analyzer.js', 'scripts/config.js', 'scripts/env-loader.js',
        'scripts/llm-account-pool.js', 'scripts/paper_identity.py', 'scripts/utils.py',
        'scripts/lib/reader-resource-sync.js', 'prompts/api-reader-article-v2.md']) {
        const original = sources.get(name); sources.set(name, Buffer.concat([original, Buffer.from('\nrepresentative drift')]));
        assert.notEqual(fingerprint(), baseline, name); sources.set(name, original);
    }
    assert.equal(fingerprint(), baseline);
});

test('会议实现指纹按版本绑定提示词正文，v1 冻结清单仍可复算', () => {
    const root = '/virtual/conference-prompt-versions';
    const files = [...new Set([...processApi.currentImplementationFiles(), ...processApi.IMPLEMENTATION_FILES])];
    const sources = new Map(files.map(name => [name, Buffer.from(`source:${name}`)]));
    const fingerprint = promptTextVersion => processApi.implementationSha256({ root, promptTextVersion,
        readFileSync: filename => sources.get(path.relative(root, filename)) });
    const current = fingerprint();
    const legacy = fingerprint('v1');
    assert.notEqual(current, legacy);
    // 新写入绑定 v2：改 v2 正文会改变当前指纹，改 v1 正文不会。
    const v2Name = 'prompts/opensource-scan-v2.md';
    const v1Name = 'prompts/opensource-scan.md';
    const v2 = sources.get(v2Name); const v1 = sources.get(v1Name);
    sources.set(v2Name, Buffer.concat([v2, Buffer.from('\nv2 drift')]));
    assert.notEqual(fingerprint(), current);
    assert.equal(fingerprint('v1'), legacy);
    sources.set(v2Name, v2);
    sources.set(v1Name, Buffer.concat([v1, Buffer.from('\nv1 drift')]));
    assert.equal(fingerprint(), current);
    assert.notEqual(fingerprint('v1'), legacy);
    sources.set(v1Name, v1);
    assert.equal(fingerprint(), current);
    assert.equal(fingerprint('v1'), legacy);
    // 版本映射本身在被哈希的集合里，改映射会改变当前指纹。
    assert.ok(processApi.currentImplementationFiles().includes('scripts/lib/prompt-text-versions.js'));
    const mappingName = 'scripts/lib/prompt-text-versions.js';
    const mapping = sources.get(mappingName);
    sources.set(mappingName, Buffer.concat([mapping, Buffer.from('\nmapping drift')]));
    assert.notEqual(fingerprint(), current);
    assert.equal(fingerprint('v1'), legacy);
    sources.set(mappingName, mapping);
    assert.throws(() => fingerprint('v9'), /没有登记/);
});

test('会议实现指纹绑定来源核验文件，且不写进 v1 冻结清单', () => {
    // 这五个名字在测试里单独写死：它们从清单里被删掉时，这条断言必须失败，
    // 不能靠读被检查的那份清单来自证。
    const required = [
        'scripts/lib/conference-source-context.js',
        'scripts/lib/conference-source-ledger.js',
        'scripts/lib/conference-extraction-receipt.js',
        'scripts/lib/conference-pdf-source.js',
        'scripts/lib/conference-importer.js'
    ];
    assert.deepEqual([...processApi.SOURCE_VERIFICATION_FILES], required);
    const current = new Set(processApi.currentImplementationFiles());
    for (const name of required) {
        assert.ok(current.has(name), `${name} 不在当前实现清单里`);
        assert.equal(fs.statSync(path.join(__dirname, '..', name)).isFile(), true, name);
        assert.ok(!processApi.IMPLEMENTATION_FILES.includes(name), `${name} 不应进 v1 冻结清单`);
    }
    const root = '/virtual/conference-source-verification';
    const files = [...new Set([...processApi.currentImplementationFiles(), ...processApi.IMPLEMENTATION_FILES])];
    const sources = new Map(files.map(name => [name, Buffer.from(`source:${name}`)]));
    const fingerprint = promptTextVersion => processApi.implementationSha256({ root, promptTextVersion,
        readFileSync: filename => sources.get(path.relative(root, filename)) });
    const baseline = fingerprint(); const legacy = fingerprint('v1');
    for (const name of required) {
        const original = sources.get(name);
        sources.set(name, Buffer.concat([original, Buffer.from('\nsource verification drift')]));
        assert.notEqual(fingerprint(), baseline, `${name} 改了字节却没换当前指纹`);
        assert.equal(fingerprint('v1'), legacy, `${name} 不该出现在 v1 冻结清单`);
        sources.set(name, original);
    }
    assert.equal(fingerprint(), baseline);
    assert.equal(fingerprint('v1'), legacy);
});

test('深度执行身份会归一化路由、绑定语义配置，并排除所有密钥', () => {
    const secretA = 'sk-fixture-primary-a';
    const secretSecondary = 'sk-secondary-must-not-be-read';
    const secretHeader = 'Bearer private-header-value';
    const baseline = executionIdentity({ env: {
        PAPER_ANALYZER_API_KEY: secretA,
        PAPER_ANALYZER_FALLBACK_API_KEYS: 'sk-fixture-fallback-a',
        HTTPS_PROXY: 'http://proxy-user:proxy-secret@example.test:8080',
        PD_OPENCODE_SESSION_ID: 'private-session-a',
        PAPER_ANALYZER_AUTHORIZATION_HEADER: secretHeader
    }, secondary: {
        model: 'muse-spark-1.3-contributor', endpoint: 'https://opencode.ai/zen/go/v1/responses',
        key: secretSecondary
    } });
    const equivalentRoute = executionIdentity({ env: {
        PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1/responses',
        PAPER_ANALYZER_API_KEY: 'sk-fixture-primary-b',
        PAPER_ANALYZER_FALLBACK_API_KEYS: 'sk-fixture-fallback-b',
        HTTPS_PROXY: 'http://different-proxy.example.test:3128',
        PD_OPENCODE_SESSION_ID: 'private-session-b'
    }, secondary: {
        model: 'muse-spark-1.3-contributor', endpoint: 'https://opencode.ai/zen/go/v1'
    }, limits: { secretHeader } });
    assert.deepEqual(equivalentRoute, baseline);
    assert.equal(baseline.audit.primary.endpointIdentitySha256,
        baseline.audit.secondary.endpointIdentitySha256);
    const serialized = JSON.stringify(baseline);
    const keyHash = value => crypto.createHash('sha256').update(value).digest('hex');
    for (const forbidden of [secretA, keyHash(secretA), secretSecondary,
        keyHash(secretSecondary), secretHeader, 'fallback', 'proxy-secret', 'private-session',
        'opencode.ai', 'PAPER_ANALYZER', 'Authorization']) assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.deepEqual(Object.keys(baseline).sort(), ['audit', 'contract', 'identitySha256', 'version']);
    assert.equal(processApi.assertDeepExecutionConfigIdentity(baseline), baseline);
    assert.throws(() => executionIdentity({ env: {
        PAPER_ANALYZER_MODEL: ' muse-spark-1.3-contributor'
    } }), /model/i);
    assert.throws(() => executionIdentity({ env: {
        PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1/responses '
    } }), /endpoint/i);

    const changed = [
        executionIdentity({ env: { PAPER_ANALYZER_MODEL: 'muse-spark-1.2-contributor' } }),
        executionIdentity({ env: { PAPER_ANALYZER_ENDPOINT: 'https://api.example.test/v1' } }),
        executionIdentity({ env: { PD_OPENAI_RESPONSES_REASONING_EFFORT: 'high' } }),
        executionIdentity({ env: { PD_OPENAI_RESPONSES_STREAM: '0' } }),
        executionIdentity({ limits: { apiReaderMaxTokens: 2000 } }),
        executionIdentity({ limits: { apiReaderEvidenceMaxChars: 2000 } }),
        executionIdentity({ limits: { scoringAuditTemperature: 0.7 } }),
        executionIdentity({ secondary: { model: 'muse-spark-vision-1.3-contributor',
            endpoint: 'https://opencode.ai/zen/go/v1' } })
    ];
    for (const value of changed) assert.notEqual(value.identitySha256, baseline.identitySha256);
});

test('深度执行配置漂移会改变进程身份，也就无法再指向旧的已完成进程', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => success(item) });
    const oldDirectory = path.join(f.files.conferenceProcessDir, first.processId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(oldDirectory, 'state.json'))).status, 'complete');

    f.runtimeAuthority.deepExecutionConfig = executionIdentity({ env: {
        PAPER_ANALYZER_MODEL: 'muse-spark-1.2-contributor'
    } });
    f.context.authority = { ...f.context.authority,
        deepExecutionConfig: f.runtimeAuthority.deepExecutionConfig };
    const nextId = processApi.deterministicUuid(processApi.stableHash(f.context.authority), processApi.CONTRACT);
    assert.notEqual(nextId, first.processId);
    assert.equal(fs.existsSync(path.join(f.files.conferenceProcessDir, nextId)), false);
    assert.throws(() => cli.processStatus(options, { dependencies: f.deps }), /ENOENT|no such file/i);
});

test('实际执行持有一把可恢复的进程操作锁，预演则不取写锁', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    let observedLock = null;
    const dry = await processApi.runConferenceProcess({ ...options, apply: false }, { ...f.deps,
        withProcessLock: async () => { throw new Error('dry-run must not acquire a process write lock'); } });
    assert.equal(dry.status, 'dry-run');
    const applied = await processApi.runConferenceProcess(options, { ...f.deps,
        withProcessLock: async (target, callback, lockOptions) => {
            observedLock = { target, lockOptions }; return callback();
        }, processPaper: async (_context, _shared, item) => success(item) });
    assert.equal(applied.status, 'complete');
    assert.equal(observedLock.target, path.join(f.files.conferenceProcessDir, applied.processId, '.operation'));
    assert.equal(observedLock.lockOptions.recoveryPolicy, engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY);
    observedLock = null;
    assert.equal(cli.processStatus(options, { dependencies: { ...f.deps,
        withProcessLock: async () => { throw new Error('status must not acquire a process write lock'); } } }).status, 'complete');
    assert.equal(observedLock, null);
});

test('同授权的实际执行串行执行，抛异常时释放操作锁以便恢复', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    let calls = 0; let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const first = processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => { calls += 1; await gate; return success(item); } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async () => { calls += 1; throw new Error('serialized resume must skip the completed paper'); } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1); releaseFirst();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.status, 'complete'); assert.equal(right.status, 'complete'); assert.equal(calls, 1);

    const g = fixture(t); let failPrepare = true;
    const recoverableDeps = { ...g.deps, prepareShared: async (...args) => {
        if (failPrepare) { failPrepare = false; throw new Error('fixture crash'); }
        return g.deps.prepareShared(...args);
    }, processPaper: async (_context, _shared, item) => success(item) };
    await assert.rejects(processApi.runConferenceProcess(options, recoverableDeps), /fixture crash/);
    const processId = processApi.deterministicUuid(processApi.stableHash(g.authority), processApi.CONTRACT);
    assert.equal(fs.existsSync(path.join(g.files.conferenceProcessDir, processId, '.operation.lock')), false);
    assert.equal((await processApi.runConferenceProcess(options, recoverableDeps)).status, 'complete');
});

test('操作锁在共用准备之前就拒绝运行时授权漂移', async t => {
    const f = fixture(t); let prepared = false;
    f.runtimeAuthority.deepExecutionConfig = executionIdentity({ limits: { apiMaxTokens: 2001 } });
    await assert.rejects(processApi.runConferenceProcess({ apply: true, catalogName: 'catalog.json',
        reportName: 'report.json', filterId: f.authority.filterId, concurrency: 1 }, { ...f.deps,
        withProcessLock: async (_target, callback) => callback(),
        prepareShared: async () => { prepared = true; return f.deps.prepareShared(); }
    }), /deep execution config drifted before shared preparation/);
    assert.equal(prepared, false);
});

test('汇总之前实现漂移，会让进程停在未完成状态，且不生成完成凭证', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    await assert.rejects(processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => {
            f.runtimeAuthority.implementationSha256 = H('implementation-drifted-during-paper');
            return success(item);
        }
    }), /implementation drifted before aggregate/);
    const processId = processApi.deterministicUuid(processApi.stableHash(f.authority), processApi.CONTRACT);
    const directory = path.join(f.files.conferenceProcessDir, processId);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    assert.notEqual(state.status, 'complete');
    assert.equal(state.completionReceiptSha256, null);
    assert.equal(fs.existsSync(path.join(directory, 'completion-receipt.json')), false);
});

test('最终完成事务在发布凭证之前，会再核对一次配置身份', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const checkingEngine = { ...engine,
        updateJsonFileLocked(filename, updater, lockOptions) {
            const current = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename)) : null;
            if (current?.items && Object.values(current.items).every(item => item.status === 'complete')
                && current.status !== 'complete') {
                f.runtimeAuthority.deepExecutionConfig = executionIdentity({ limits: {
                    apiReaderContextMaxChars: 2002
                } });
            }
            return engine.updateJsonFileLocked(filename, updater, lockOptions);
        }
    };
    await assert.rejects(processApi.runConferenceProcess(options, { ...f.deps, engine: checkingEngine,
        withProcessLock: async (_target, callback) => callback(),
        processPaper: async (_context, _shared, item) => success(item)
    }), /deep execution config drifted during final completion transaction/);
    const processId = processApi.deterministicUuid(processApi.stableHash(f.authority), processApi.CONTRACT);
    const directory = path.join(f.files.conferenceProcessDir, processId);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    assert.notEqual(state.status, 'complete');
    assert.equal(state.aggregate, null);
    assert.equal(state.completionReceiptSha256, null);
    assert.equal(fs.existsSync(path.join(directory, 'completion-receipt.json')), false);
});

test('条目条件更新（CAS）保留其他任务已完成的结果，最终事务再次确认所有条目已完成', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const processId = processApi.deterministicUuid(processApi.stableHash(f.authority), processApi.CONTRACT);
    const stateFile = path.join(f.files.conferenceProcessDir, processId, 'state.json');
    const completedByPeer = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => {
            engine.updateJsonFileLocked(stateFile, current => {
                const next = structuredClone(processApi.assertState(current));
                next.items[item.paperId] = { ...next.items[item.paperId], ...success(item),
                    status: 'complete', lastError: null, updatedAt: f.deps.now() };
                next.status = 'running'; next.aggregate = null; next.completionReceiptSha256 = null;
                next.generation = current.generation + 1; next.stateSha256 = processApi.stateDigest(next);
                return next;
            });
            throw new Error('late duplicate worker failure');
        } });
    assert.equal(completedByPeer.status, 'complete');
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).items[f.members[0].paperId].status, 'complete');

    const g = fixture(t); const gProcessId = processApi.deterministicUuid(
        processApi.stableHash(g.authority), processApi.CONTRACT);
    const gStateFile = path.join(g.files.conferenceProcessDir, gProcessId, 'state.json');
    await assert.rejects(processApi.runConferenceProcess(options, { ...g.deps,
        processPaper: async (_context, _shared, item) => success(item),
        aggregate: async (...args) => {
            const aggregate = await g.deps.aggregate(...args);
            engine.updateJsonFileLocked(gStateFile, current => {
                const next = structuredClone(processApi.assertState(current));
                next.items[g.members[0].paperId].status = 'analysis_partial';
                next.status = 'running'; next.aggregate = null; next.completionReceiptSha256 = null;
                next.generation = current.generation + 1; next.stateSha256 = processApi.stateDigest(next);
                return next;
            });
            return aggregate;
        } }), /completion transaction found incomplete items/);
    const incomplete = processApi.assertState(JSON.parse(fs.readFileSync(gStateFile)));
    assert.equal(incomplete.status, 'running');
    assert.equal(incomplete.items[g.members[0].paperId].status, 'analysis_partial');
});

test('检查点或完成凭证被篡改，一律直接失败', async t => {
    const f = fixture(t); const options = { apply: true, catalogName: 'catalog.json', reportName: 'report.json',
        filterId: f.authority.filterId, concurrency: 1 };
    const complete = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => success(item) });
    const directory = path.join(f.files.conferenceProcessDir, complete.processId); const stateFile = path.join(directory, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile)); state.authority.catalogName = 'tampered.json';
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    await assert.rejects(processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_context, _shared, item) => success(item) }), /checkpoint integrity/);

    const g = fixture(t); const completed = await processApi.runConferenceProcess(options, { ...g.deps,
        processPaper: async (_context, _shared, item) => success(item) });
    const completedDirectory = path.join(g.files.conferenceProcessDir, completed.processId);
    const receiptFile = path.join(completedDirectory, 'completion-receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptFile)); receipt.aggregate.aggregateId = H('tampered');
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.throws(() => cli.processStatus(options, { dependencies: g.deps }), /completion receipt/);
});

test('自动的来源接受是显式的，不能称作人工审查', () => {
    const members = [{ paperId: 'conference:odyssey:2026:conference-paper-id:a.1',
        sourceIdentity: 'conference-paper-id:a.1', receiptName: 'a-receipt.json' }];
    const value = staging.normalizeExtractionManifest({ contract: staging.AUTOMATED_EXTRACTION_CONTRACT,
        version: staging.VERSION, conference: { id: 'odyssey-2026', year: 2026 }, acceptance: {
            method: 'official-proceedings-exact-pdf-v1', catalogSha256: H('catalog'),
            selectionReceiptSha256: H('selection') }, members, membersSha256: staging.stableHash(members) });
    assert.equal(value.review, undefined); assert.equal(value.acceptance.method, 'official-proceedings-exact-pdf-v1');
    assert.throws(() => staging.normalizeExtractionManifest({ ...value,
        acceptance: { ...value.acceptance, method: 'manual-review' } }), /method is unsupported/);
});

test('真实的官方精确 PDF 来源保存后，能在不声称人工审查的前提下进到已核验的暂存、导入和计划', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-process-source-seal-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const names = ['catalogs', 'reports', 'filters', 'specs', 'source', 'staging', 'cache', 'ledgers',
        'runs', 'analysis', 'pages', 'aggregates', 'processes', 'pdf'];
    for (const name of names) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const metadataFile = path.join(root, 'metadata.json'); const pdfRoot = path.join(root, 'pdf');
    const record = { id: 'ando26_odyssey', title: 'Fixture audio paper', authors: ['A. Author'],
        abstract: 'Speech processing evidence.', pdfFile: 'papers/ando26_odyssey.pdf',
        recordUrl: 'https://www.isca-archive.org/odyssey_2026/ando26_odyssey.html',
        pdfUrl: 'https://www.isca-archive.org/odyssey_2026/ando26_odyssey.pdf', doi: null, track: 'Main' };
    fs.writeFileSync(metadataFile, JSON.stringify({ conference: { id: 'odyssey-2026', year: 2026 }, papers: [record] }));
    fs.mkdirSync(path.join(pdfRoot, 'papers')); fs.writeFileSync(path.join(pdfRoot, record.pdfFile),
        extractionFixture.buildPdf(record.title, 150));
    const found = discovery.discoverConference({ adapter: 'official-proceedings', conferenceId: 'odyssey-2026',
        year: 2026, metadataFile, pdfRoot });
    fs.writeFileSync(path.join(root, 'catalogs', 'catalog.json'), discovery.canonicalBytes(found.manifest));
    fs.writeFileSync(path.join(root, 'reports', 'report.json'), discovery.canonicalBytes(found.report));
    const discoveryHandle = discovery.loadDiscoveryHandle(path.join(root, 'catalogs', 'catalog.json'),
        path.join(root, 'reports', 'report.json'));
    const { evidenceHandle } = evidenceFixture.createEvidenceHandle({ root, discoveryHandle,
        now: '2026-09-09T00:00:00.000Z' });
    const filterId = '11111111-1111-4111-8111-111111111111'; const stamp = '2026-09-09T00:00:00.000Z';
    let state = filter.prepareFilter({ filterRoot: path.join(root, 'filters'), discoveryHandle, evidenceHandle,
        filterId, now: stamp,
        spec: evidenceFixture.createFilterSpec({ discoveryHandle, evidenceHandle }) });
    const paperId = Object.keys(state.decisions)[0]; const artifact = filter.buildDecisionArtifact({ state, paperId,
        operationId: '22222222-2222-4222-8222-222222222222', actor: { type: 'manual', id: 'filter-reviewer' },
        model: null, endpointProtocol: 'manual', requestBytes: 'filter request', responseBytes: 'included',
        status: 'included', reason: 'audio paper', usage: {}, now: stamp });
    const decisionFile = filter.writeDecisionArtifact({ filterRoot: path.join(root, 'filters'), filterId,
        decisionName: 'included.json', artifact });
    filter.applyDecision({ filterRoot: path.join(root, 'filters'), filterId,
        decisionHandle: filter.loadDecisionHandle(decisionFile), owner: 'filter-reviewer', now: stamp });
    const tagCatalogPath = path.join(root, 'taxonomy.json'); fs.writeFileSync(tagCatalogPath, '{"version":"taxonomy-v1"}\n');
    const files = { conferenceDiscoveryCatalogDir: path.join(root, 'catalogs'),
        conferenceDiscoveryReportDir: path.join(root, 'reports'), conferenceFiltersDir: path.join(root, 'filters'),
        conferenceStagingSpecsDir: path.join(root, 'specs'), conferenceStagingSourceDir: path.join(root, 'source'),
        conferenceStagingDir: path.join(root, 'staging'), conferenceSourceCacheDir: path.join(root, 'cache'),
        conferenceSourceLedgerDir: path.join(root, 'ledgers'), conferenceRunsDir: path.join(root, 'runs'),
        conferenceAnalysisDir: path.join(root, 'analysis'), conferencePageStagingDir: path.join(root, 'pages'),
        conferenceAggregateDir: path.join(root, 'aggregates'), conferenceProcessDir: path.join(root, 'processes'),
        tagCatalogFile: tagCatalogPath };
    const deps = { ...processApi.defaultDependencies(), files,
        execFileSync: (_command, args, options) => {
            const code = 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[3]); from conference_extractor import run_extraction; run_extraction(sys.argv[1], apply=True, source_root=Path(sys.argv[2]))';
            return childProcess.execFileSync('bash', [args[0], '-c', code, args.at(-1), files.conferenceStagingSourceDir,
                path.join(__dirname, '..', 'scripts')], options);
        } };
    const context = processApi.loadAuthority({ catalogName: 'catalog.json', reportName: 'report.json', filterId }, deps);
    const shared = processApi.prepareShared(context, deps, stamp);
    assert.equal(shared.sealed.length, 1); assert.match(shared.sealed[0].proof.verificationSha256, /^[a-f0-9]{64}$/);
    const seal = JSON.parse(fs.readFileSync(path.join(files.conferenceStagingSpecsDir, shared.names.extraction)));
    assert.equal(seal.contract, staging.AUTOMATED_EXTRACTION_CONTRACT); assert.equal(seal.review, undefined);
    const stagingReceipt = JSON.parse(fs.readFileSync(path.join(files.conferenceStagingDir, shared.names.stagingReceipt)));
    assert.equal(stagingReceipt.extraction.acceptance.method, 'official-proceedings-exact-pdf-v1');
    assert.equal(stagingReceipt.extraction.review, undefined);
    assert.ok(fs.existsSync(path.join(files.conferenceSourceLedgerDir, shared.names.ledger)));
    assert.ok(fs.existsSync(path.join(files.conferenceRunsDir, shared.names.run)));

    // 模拟一个过期的 pin。它的字节永远不会被当成当前证据：
    // 新的打包文件必须从单独核验过的 PDF 重新生成。
    const oldReceiptFile = path.join(files.conferenceStagingSourceDir, shared.sealed[0].receiptName);
    const oldReceipt = JSON.parse(fs.readFileSync(oldReceiptFile)); oldReceipt.extractor.version = '0.0.0';
    delete oldReceipt.receiptSha256; oldReceipt.receiptSha256 = H(oldReceipt);
    const oldBytes = Buffer.from(JSON.stringify(oldReceipt)); fs.writeFileSync(oldReceiptFile, oldBytes);
    const analysisSentinel = path.join(files.conferenceAnalysisDir, 'preserved-analysis.json');
    fs.writeFileSync(analysisSentinel, '{"analysis":"must remain byte-identical"}', { mode: 0o600 });
    let extractions = 0;
    const upgradedDeps = { ...deps, execFileSync: (...args) => { extractions += 1; return deps.execFileSync(...args); } };
    // 历史流程固定数据绑定的是旧凭证，而生产侧的保存逻辑
    // 必须为这次显式分叉核验新提取出来的一代来源。
    const legacyShared = structuredClone({ ...shared, planHandle: undefined });
    legacyShared.planHandle = shared.planHandle;
    legacyShared.sealed[0].proof.receiptSha256 = oldReceipt.receiptSha256;
    const origin = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, { ...deps,
        loadAuthority: () => context, now: () => stamp, prepareShared: async () => legacyShared,
        aggregate: async () => ({ manifest: { aggregateId: H('old aggregate').slice(0, 32),
            manifestSha256: H('old aggregate manifest'), markdownSha256: H('old aggregate page'), pagePath: 'content/posts/old-conference.md' } }),
        processPaper: async (_c, _s, item) => success(item) });
    const originalStateFile = path.join(files.conferenceProcessDir, origin.processId, 'state.json');
    const originalStateBytes = fs.readFileSync(originalStateFile);
    const upgradeApi = require('../scripts/lib/conference-source-upgrade.js');
    const upgradeOptions = { fromProcessId: origin.processId, concurrency: 1 };
    let modelCalls = 0;
    const forkDeps = { ...upgradedDeps, loadAuthority: () => context, processPaper: async (_c, newShared, item) => {
        modelCalls += 1;
        assert.notEqual(item.analysisRunId, Object.values(JSON.parse(originalStateBytes).items)[0].analysisRunId);
        assert.equal(newShared.sealed[0].proof.pdfSha256, legacyShared.sealed[0].proof.pdfSha256);
        assert.notEqual(newShared.sealed[0].proof.receiptSha256, legacyShared.sealed[0].proof.receiptSha256);
        if (modelCalls === 1) throw new Error('fixture interrupted Reader');
        return success(item);
    } };
    const beforeFiles = fs.readdirSync(files.conferenceStagingSourceDir).sort();
    const upgradePlan = upgradeApi.planSourceUpgrade(upgradeOptions, forkDeps);
    assert.deepEqual(fs.readdirSync(files.conferenceStagingSourceDir).sort(), beforeFiles);
    assert.equal(upgradePlan.papers[0].extractionUpgradeRequired, true); assert.equal(modelCalls, 0);
    assert.equal(extractions, 0);
    await assert.rejects(upgradeApi.applySourceUpgrade({ ...upgradeOptions, planSha256: upgradePlan.planSha256,
        paperIds: [paperId] }, forkDeps), /authorize-new-analysis/);
    await assert.rejects(upgradeApi.applySourceUpgrade({ ...upgradeOptions, authorizeNewAnalysis: true,
        planSha256: H('stale plan'), paperIds: [paperId] }, forkDeps), /plan drifted/);
    const authorized = { ...upgradeOptions, authorizeNewAnalysis: true, planSha256: upgradePlan.planSha256, paperIds: [paperId] };
    const fork = await upgradeApi.applySourceUpgrade(authorized, forkDeps);
    assert.equal(fork.status, 'partial'); assert.equal(fork.conferenceCompletion, false); assert.equal(modelCalls, 1);
    assert.equal((await upgradeApi.applySourceUpgrade(authorized, forkDeps)).status, 'partial'); assert.equal(modelCalls, 1);
    assert.equal((await upgradeApi.applySourceUpgrade({ ...authorized, retryFailed: true }, forkDeps)).status, 'complete'); assert.equal(modelCalls, 2);
    assert.equal((await upgradeApi.applySourceUpgrade(authorized, forkDeps)).status, 'complete'); assert.equal(modelCalls, 2);
    assert.deepEqual(fs.readFileSync(originalStateFile), originalStateBytes);
    assert.deepEqual(fs.readFileSync(oldReceiptFile), oldBytes);
    const upgraded = processApi.prepareShared(context, upgradedDeps, stamp);
    assert.equal(extractions, 1); assert.notEqual(upgraded.sealed[0].receiptName, shared.sealed[0].receiptName);
    assert.notEqual(upgraded.names.plan, shared.names.plan); assert.notEqual(upgraded.sourceCacheRoot, shared.sourceCacheRoot);
    assert.equal(fs.readFileSync(analysisSentinel, 'utf8'), '{"analysis":"must remain byte-identical"}');
    const replayed = processApi.prepareShared(context, upgradedDeps, stamp);
    assert.equal(extractions, 1); assert.equal(replayed.planReceiptSha256, upgraded.planReceiptSha256);
    const sealedPdfFile = path.join(files.conferenceStagingSourceDir,
        processApi.sourceNames(paperId, context.authority.implementationSha256).pdf);
    fs.writeFileSync(sealedPdfFile, 'corrupt sealed PDF');
    assert.throws(() => processApi.prepareShared(context, upgradedDeps, stamp), /官方 PDF 哈希与发现记录不一致/);
    assert.equal(extractions, 1);
});

test('命令行给并发设上限，并关掉旧版新建会议的绕过口子', () => {
    const parsed = cli.parseArgs(['--apply', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', '11111111-1111-4111-8111-111111111111', '--concurrency', '3']);
    assert.equal(parsed.concurrency, 3);
    const raised = cli.parseArgs(['--apply', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', '11111111-1111-4111-8111-111111111111', '--concurrency', '5']);
    assert.equal(raised.concurrency, 5);
    assert.throws(() => cli.parseArgs(['--apply', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', '11111111-1111-4111-8111-111111111111', '--concurrency', '6']), /Use/);
    assert.throws(() => cli.parseArgs(['--legacy-disabled', 'analyze']), /must use conference:new:process/);
});

test('401 余额失败会停止派发，能跨续跑保留，并且只显式释放未完成的工作', async t => {
    const f = fixture(t, 5); const options = { apply: true, concurrency: 1 };
    let calls = 0;
    const worker = async (_context, _shared, item) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('HTTP 401: Insufficient balance https://billing.invalid'),
            { code: 'MODEL_HTTP_NON_RETRYABLE', retryable: false });
        return success(item);
    };
    const first = await processApi.runConferenceProcess(options, { ...f.deps, processPaper: worker });
    assert.equal(calls, 2); assert.equal(first.stopped, true); assert.equal(first.batchFailure.category, 'quota');
    assert.equal(first.batchFailure.code, 'MODEL_HTTP_NON_RETRYABLE');
    assert.doesNotMatch(first.batchFailure.message, /https:/);
    const again = await processApi.runConferenceProcess(options, { ...f.deps,
        prepareShared: () => assert.fail('blocked batch must stop before shared preparation'), processPaper: worker });
    assert.equal(again.stopped, true); assert.equal(calls, 2);
    const resumed = await processApi.runConferenceProcess({ ...options, retryFailed: true }, { ...f.deps, processPaper: worker });
    assert.equal(resumed.status, 'complete'); assert.equal(calls, 6);
});

test('普通重试遵守冷却和有上限的尝试次数，显式放行则保留失败历史', async t => {
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    let now = Date.parse('2026-09-09T00:00:00Z'), calls = 0;
    const deps = { ...f.deps, now: () => new Date(now).toISOString(), processPaper: async () => {
        calls += 1; throw new Error('fixture paper validation failed');
    } };
    const first = await processApi.runConferenceProcess(options, deps);
    await processApi.runConferenceProcess(options, deps); assert.equal(calls, 1);
    for (let n = 0; n < 4; n += 1) { now += 3600000; await processApi.runConferenceProcess(options, deps); }
    assert.equal(calls, 3);
    await processApi.runConferenceProcess({ ...options, retryFailed: true }, deps); assert.equal(calls, 4);
    const state = JSON.parse(fs.readFileSync(path.join(f.files.conferenceProcessDir, first.processId, 'state.json')));
    const item = Object.values(state.items)[0];
    assert.equal(item.retryReleases[0].attempts, 3); assert.match(item.retryReleases[0].previousFailure.message, /validation/);
});

test('适配器部分失败时，保留标准的错误分类', async t => {
    const f = fixture(t);
    const deps = { ...f.deps, adapter: {
        prepareConferenceAnalysis: () => {}, analyzeConference: async () => ({ status: 'partial' }),
        loadConferenceAnalysis: () => ({ analysis: { papers: [{ latestAnalysisAttemptError: 'HTTP 401: Insufficient balance',
            latestAnalysisAttemptErrorCode: 'MODEL_HTTP_NON_RETRYABLE', latestAnalysisAttemptRetryable: false }] } })
    } };
    await assert.rejects(processApi.processOne(f.context, { planHandle: {} }, { ...f.members[0], analysisRunId: 'fixture' }, deps),
        error => error.message.includes('Insufficient balance') && error.code === 'MODEL_HTTP_NON_RETRYABLE' && error.retryable === false);
});

test('迁移后旧实现仍可寻址，并且绝不重分析已完成的论文', async t => {
    const migration = require('../scripts/migrate-conference-process.js');
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_c, _s, item) => success(item) });
    const oldImplementation = f.authority.implementationSha256;
    f.context.authority = { ...f.authority, implementationSha256: H('new implementation') };
    f.runtimeAuthority.implementationSha256 = f.context.authority.implementationSha256;
    assert.throws(() => cli.processStatus(options, { dependencies: f.deps }), /migrate with --from/);
    // 之前建的空分叉不能盖住已经迁移过来的完成记录。
    const dormant = JSON.parse(fs.readFileSync(path.join(f.files.conferenceProcessDir, first.processId, 'state.json')));
    dormant.authority = f.context.authority;
    dormant.processId = processApi.deterministicUuid(H(dormant.authority), processApi.CONTRACT);
    dormant.status = 'pending'; dormant.aggregate = null; dormant.completionReceiptSha256 = null;
    for (const item of Object.values(dormant.items)) {
        Object.assign(item, { analysisRunId: processApi.deterministicUuid(dormant.processId, item.paperId, 'analysis'),
            status: 'pending', attempts: 0, sourceProof: null, analysisProof: null, pageProof: null });
    }
    dormant.stateSha256 = processApi.stateDigest(dormant);
    fs.mkdirSync(path.join(f.files.conferenceProcessDir, dormant.processId), { mode: 0o700 });
    fs.writeFileSync(path.join(f.files.conferenceProcessDir, dormant.processId, 'state.json'), JSON.stringify(dormant), { mode: 0o600 });
    const deps = { ...f.deps, processPaper: () => assert.fail('must not repeat completed analysis'),
        postprocess: { stagePaper: ({ executionId }) => ({ status: 'staged', manifest: {
            ...success(f.members[0]).pageProof, manifestSha256: H(executionId) } }) } };
    const migrated = await migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: deps });
    assert.equal(migrated.processId, first.processId); assert.equal(migrated.status, 'complete');
    assert.equal(cli.processStatus(options, { dependencies: deps }).processId, first.processId);
    const resumed = await processApi.runConferenceProcess(options, { ...deps, prepareShared: async (context, ...rest) => {
        assert.equal(context.authority.implementationSha256, oldImplementation); return f.deps.prepareShared(context, ...rest);
    } });
    assert.equal(resumed.status, 'complete'); assert.equal(resumed.processId, first.processId);
});

test('系统性失败后，正在处理论文的任务会完成手上的工作，但不再派发新任务', async t => {
    const f = fixture(t, 7); let calls = 0;
    let release; const inFlight = new Promise(resolve => { release = resolve; });
    const result = await processApi.runConferenceProcess({ apply: true, concurrency: 3 }, { ...f.deps,
        processPaper: async (_c, _s, item) => {
            const call = ++calls;
            if (call === 1) { await Promise.resolve(); release(); throw new Error('HTTP 503: service unavailable'); }
            await inFlight; return success(item);
        } });
    assert.equal(result.stopped, true); assert.equal(result.batchFailure.category, 'transport');
    assert.equal(calls, 3); assert.equal(result.complete, 2);
});

test('单篇演示失败不会中断会议批次', async t => {
    const f = fixture(t, 4); let calls = 0;
    const result = await processApi.runConferenceProcess({ apply: true, concurrency: 2 }, { ...f.deps,
        processPaper: async (_context, _shared, item) => {
            calls += 1;
            if (item.paperId === f.members[0].paperId) {
                throw Object.assign(new Error('Demo 页面瞬时访问失败: getaddrinfo ENOTFOUND demo.example'), {
                    code: 'DEMO_TRANSIENT_FAILURE', retryable: true });
            }
            return success(item);
        } });
    assert.equal(calls, 4);
    assert.notEqual(result.stopped, true);
    assert.equal(result.batchFailure, undefined);
    assert.equal(result.complete, 3);
});

test('模型网络失败已经用尽，也不影响后面的会议论文', async t => {
    const f = fixture(t, 3); let calls = 0;
    const result = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, { ...f.deps,
        processPaper: async (_context, _shared, item) => {
            calls += 1;
            if (item.paperId === f.members[0].paperId) {
                throw Object.assign(new Error('aborted'), { code: 'ECONNRESET', retryable: false });
            }
            return success(item);
        } });
    assert.equal(calls, 3);
    assert.notEqual(result.stopped, true);
    assert.equal(result.batchFailure, undefined);
    assert.equal(result.complete, 2);
});

test('标签审查让批次继续走，先扣住页面，并报告一个可见的队列', async t => {
    const f = fixture(t, 3); const options = { apply: true, concurrency: 2 };
    const processId = processApi.deterministicUuid(processApi.stableHash(f.authority), processApi.CONTRACT);
    const executionOf = paperId => processApi.deterministicUuid(processId, paperId, 'analysis');
    const reviewPaperId = f.members[1].paperId;
    const blockedReasons = ['primary-task:unknown:#不存在的主任务', 'selection:标签不是 active 中文首选标签: #不存在的主任务'];
    let fixed = false; let stageCalls = 0;
    const deps = { ...f.deps,
        adapter: { prepareConferenceAnalysis: () => {},
            analyzeConference: async () => ({ status: 'complete', analysisSha256: H('analysis') }),
            loadConferenceAnalysis: () => ({ analysis: { papers: [{}] } }) },
        postprocess: { stagePaper: ({ executionId }) => {
            stageCalls += 1;
            if (!fixed && executionId === executionOf(reviewPaperId)) {
                return { status: 'blocked', assignment: { contract: 'conference-taxonomy-assignment-v1',
                    version: 1, paperId: reviewPaperId, analysisExecutionId: executionId, status: 'blocked',
                    blockedReasons, registrySha256: H('registry'), assignmentSha256: H('assignment'),
                    primaryTaskId: null, primaryMethodId: null, conceptIds: [] } };
            }
            return { status: 'staged', manifest: { manifestSha256: H(`page:${executionId}`),
                contentSha256: H(`content:${executionId}`), pagePath: `content/posts/${executionId}.md`,
                completionReceiptSha256: H(`receipt:${executionId}`),
                sourceSnapshotSha256: H(`source:${executionId}`) } };
        } } };

    const first = await processApi.runConferenceProcess(options, deps);
    assert.equal(first.status, 'partial');
    assert.equal(first.complete, 2); assert.equal(first.failed, 1);
    assert.notEqual(first.stopped, true); assert.equal(first.batchFailure, undefined);
    assert.equal(first.tagReview, 1);
    assert.deepEqual(first.tagReviewQueue.map(item => item.blockedReasons), [blockedReasons]);
    const directory = path.join(f.files.conferenceProcessDir, first.processId);
    assert.equal(first.tagReviewQueueFile, path.join(directory, 'tag-review-queue.json'));
    // 只要还有标签分配没定下来，这一批就不算结束：不会生成凭证。
    assert.equal(fs.existsSync(path.join(directory, 'completion-receipt.json')), false);

    const queue = JSON.parse(fs.readFileSync(first.tagReviewQueueFile, 'utf8'));
    assert.equal(queue.contract, 'conference-tag-review-queue-v2');
    assert.equal(queue.version, 2);
    assert.equal(queue.tagReview, 1);
    assert.equal(queue.items[0].paperId, reviewPaperId);
    assert.equal(queue.items[0].status, 'needs_tag_review');
    assert.deepEqual(queue.items[0].blockedReasons, blockedReasons);
    assert.match(queue.queueSha256, /^[a-f0-9]{64}$/);

    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
    const review = state.items[reviewPaperId];
    assert.equal(review.status, 'analysis_partial');
    assert.equal(review.pageProof, null);
    assert.equal(review.lastFailure.code, 'CONFERENCE_TAG_REVIEW_REQUIRED');
    assert.equal(review.lastFailure.category, 'tag_review');
    assert.equal(review.lastFailure.systemic, false);
    assert.equal(review.lastFailure.retryable, false);
    assert.deepEqual(review.reviewRequired.blockedReasons, blockedReasons);
    for (const [paperId, peer] of Object.entries(state.items)) {
        if (paperId === reviewPaperId) continue;
        assert.equal(peer.status, 'complete'); assert.ok(peer.pageProof); assert.equal(peer.reviewRequired, null);
    }

    const status = cli.processStatus(options, { dependencies: f.deps });
    assert.equal(status.tagReview, 1);
    assert.equal(status.tagReviewQueue[0].paperId, reviewPaperId);
    assert.deepEqual(status.tagReviewQueue[0].blockedReasons, blockedReasons);
    assert.equal(status.tagReviewQueueFile, first.tagReviewQueueFile);

    // 旧检查点和队列保留有效原始哈希，读取状态时只按新名称展示字段。
    const stateFile = path.join(directory, 'state.json');
    const legacyQueueFile = path.join(directory, 'taxonomy-review-queue.json');
    review.lastFailure.code = 'CONFERENCE_TAXONOMY_REVIEW_REQUIRED';
    review.lastFailure.category = 'taxonomy_review';
    review.reviewRequired.status = 'needs_taxonomy_review';
    state.stateSha256 = processApi.stateDigest(state);
    const legacyStateBytes = Buffer.from(JSON.stringify(state));
    fs.writeFileSync(stateFile, legacyStateBytes);
    const legacyQueue = { ...queue, contract: 'conference-taxonomy-review-queue-v1', version: 1,
        taxonomyReview: queue.tagReview,
        items: queue.items.map(item => ({ ...item, status: 'needs_taxonomy_review' })) };
    delete legacyQueue.tagReview; delete legacyQueue.queueSha256;
    legacyQueue.queueSha256 = processApi.stableHash(legacyQueue);
    const legacyQueueBytes = Buffer.from(JSON.stringify(legacyQueue));
    fs.rmSync(first.tagReviewQueueFile);
    fs.writeFileSync(legacyQueueFile, legacyQueueBytes);
    assert.equal(processApi.assertState(state).stateSha256, state.stateSha256);
    const legacyStatus = cli.processStatus(options, { dependencies: f.deps });
    assert.equal(legacyStatus.tagReview, 1);
    assert.equal(legacyStatus.tagReviewQueue[0].status, 'needs_tag_review');
    assert.equal(legacyStatus.tagReviewQueueFile, legacyQueueFile);
    assert.equal(legacyStatus.taxonomyReview, undefined);
    assert.deepEqual(fs.readFileSync(stateFile), legacyStateBytes);
    assert.deepEqual(fs.readFileSync(legacyQueueFile), legacyQueueBytes);
    assert.equal(fs.existsSync(first.tagReviewQueueFile), false);
    fs.rmSync(legacyQueueFile);
    assert.equal(cli.processStatus(options, { dependencies: f.deps }).tagReviewQueueFile, undefined);
    fs.writeFileSync(legacyQueueFile, legacyQueueBytes);
    const codeOnlyState = structuredClone(state);
    delete codeOnlyState.items[reviewPaperId].reviewRequired;
    codeOnlyState.stateSha256 = processApi.stateDigest(codeOnlyState);
    const codeOnlyBytes = JSON.stringify(codeOnlyState);
    assert.equal(processApi.buildTagReviewQueue(codeOnlyState).items[0].status, 'needs_tag_review');
    assert.equal(JSON.stringify(codeOnlyState), codeOnlyBytes);

    // 结果确定的审查不会盲目重试……
    const quiet = await processApi.runConferenceProcess(options, deps);
    assert.equal(quiet.status, 'partial'); assert.equal(quiet.tagReview, 1);
    assert.equal(stageCalls, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'state.json')))
        .items[reviewPaperId].attempts, 1);
    assert.equal(fs.existsSync(legacyQueueFile), false);
    const rebuiltQueue = JSON.parse(fs.readFileSync(quiet.tagReviewQueueFile));
    assert.equal(rebuiltQueue.contract, 'conference-tag-review-queue-v2');
    assert.equal(rebuiltQueue.version, 2);
    assert.equal(rebuiltQueue.items[0].status, 'needs_tag_review');
    const queueBody = { ...rebuiltQueue }; delete queueBody.queueSha256;
    assert.equal(rebuiltQueue.queueSha256, processApi.stableHash(queueBody));
    const quietState = processApi.assertState(JSON.parse(fs.readFileSync(stateFile)));
    assert.equal(quietState.items[reviewPaperId].lastFailure.code, 'CONFERENCE_TAXONOMY_REVIEW_REQUIRED');
    assert.equal(quietState.items[reviewPaperId].reviewRequired.status, 'needs_taxonomy_review');

    // ……但标签修好之后显式放行，它就能升级。
    fixed = true;
    const resumed = await processApi.runConferenceProcess({ ...options, retryFailed: true }, deps);
    assert.equal(resumed.status, 'complete'); assert.equal(resumed.tagReview, 0);
    assert.equal(stageCalls, 4);
    assert.equal(fs.existsSync(path.join(directory, 'tag-review-queue.json')), false);
    assert.equal(fs.existsSync(legacyQueueFile), false);
    assert.equal(fs.existsSync(path.join(directory, 'completion-receipt.json')), true);
    const done = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
    assert.equal(done.items[reviewPaperId].status, 'complete');
    assert.equal(done.items[reviewPaperId].reviewRequired, null);
    assert.ok(done.items[reviewPaperId].pageProof);
    assert.equal(cli.processStatus(options, { dependencies: f.deps }).tagReview, 0);
});

test('标签审查分类接受旧错误码，但不授权盲目重试', () => {
    const recovery = require('../scripts/lib/conference-process-recovery.js');
    for (const code of ['CONFERENCE_TAG_REVIEW_REQUIRED', 'CONFERENCE_TAXONOMY_REVIEW_REQUIRED']) {
        const failure = recovery.classifyFailure(Object.assign(new Error('标签选择尚未确定'), { code }),
            '2026-09-09T00:00:00Z');
        assert.equal(failure.code, code); assert.equal(failure.category, 'tag_review');
        assert.equal(failure.systemic, false); assert.equal(failure.retryable, false);
        assert.equal(recovery.eligible({ status: 'analysis_partial', attempts: 1, lastFailure: failure }, failure.at), false);
    }
});

test('失败分类器认中文的代理/隧道/认证失败，但不把代理项和未授权算进来', () => {
    const recovery = require('../scripts/lib/conference-process-recovery.js');
    const classify = message => recovery.classifyFailure(new Error(message), '2026-09-09T00:00:00Z');
    // 中文消息必须和它们的英文原文同判：proxy/CONNECT tunnel 属 systemic 的 transport。
    for (const message of [
        '缺少项目代理配置',
        '当前 Node arXiv 抓取只支持 HTTP CONNECT 代理，收到不兼容协议: socks5:',
        'GitHub 的 raw 节点偶尔会重置 CONNECT 隧道'
    ]) {
        const failure = classify(message);
        assert.equal(failure.category, 'transport');
        assert.equal(failure.systemic, true);
    }
    // 「代理项」是 Unicode surrogate，与 proxy 无关；「未授权」会出现在修复指引正文里，
    // 而那段正文会被拼进单篇拒稿消息。两者都不能触发整批停机的 transport/authentication。
    assert.equal(classify('对象键包含非法 Unicode 代理项').category, 'paper');
    assert.equal(classify('不要试图改动未授权的另一张表').category, 'paper');
    // authentication：中文「认证失败」与英文 authentication 同判，且不可重试。
    const auth = classify('OpenCode Go 认证失败，已停止请求；未切换账号');
    assert.equal(auth.category, 'authentication');
    assert.equal(auth.systemic, true); assert.equal(auth.retryable, false);
    // 英文词逐字未动：旧失败记录里的英文消息分类不变。
    assert.equal(classify('missing project proxy').category, 'transport');
    assert.equal(classify('HTTP 401 Unauthorized').category, 'authentication');
});

test('标签队列替换在重命名失败时保留旧缓存，空队列则把两个名字都清掉', t => {
    const f = fixture(t); const directory = f.root;
    const legacyFile = path.join(directory, 'taxonomy-review-queue.json');
    const currentFile = path.join(directory, 'tag-review-queue.json');
    const oldBytes = Buffer.from('saved legacy queue'); fs.writeFileSync(legacyFile, oldBytes);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (to === currentFile) throw new Error('fixture queue rename failed');
        return rename(from, to);
    };
    try {
        assert.throws(() => processApi.writeTagReviewQueue(directory, { tagReview: 1, items: [] }), /rename failed/);
    } finally { fs.renameSync = rename; }
    assert.deepEqual(fs.readFileSync(legacyFile), oldBytes);
    assert.equal(fs.existsSync(currentFile), false);
    fs.writeFileSync(currentFile, 'current queue');
    assert.equal(processApi.writeTagReviewQueue(directory, { tagReview: 0, items: [] }), null);
    assert.equal(fs.existsSync(legacyFile), false); assert.equal(fs.existsSync(currentFile), false);
});

test('状态与迁移凭证之间崩溃时，迁移来源记录仍然保留', async t => {
    const migration = require('../scripts/migrate-conference-process.js');
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const deps = { ...f.deps, processPaper: async (_c, _s, item) => success(item),
        postprocess: { stagePaper: () => ({ status: 'staged', manifest: success(f.members[0]).pageProof }) } };
    const first = await processApi.runConferenceProcess(options, deps);
    f.context.authority = { ...f.authority, implementationSha256: H('migration crash target') };
    f.runtimeAuthority.implementationSha256 = f.context.authority.implementationSha256;
    const exactFile = processApi.exactFile;
    processApi.exactFile = (filename, bytes) => {
        if (filename.endsWith('implementation-migration.json')) throw new Error('fixture power loss');
        return exactFile(filename, bytes);
    };
    try {
        await assert.rejects(migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: deps }), /power loss/);
    } finally { processApi.exactFile = exactFile; }
    const resumed = await migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: {
        ...deps, processPaper: () => assert.fail('completed analysis must survive migration crash') } });
    assert.equal(resumed.status, 'complete');
    assert.equal(cli.processStatus(options, { dependencies: deps }).processId, first.processId);
});

test('旧版部分导入在模型或来源准备之前，先把 401 归类写进正式记录', async t => {
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: () => { throw new Error('analysis remained partial'); } });
    const filename = path.join(f.files.conferenceProcessDir, first.processId, 'state.json');
    const state = JSON.parse(fs.readFileSync(filename)); const item = Object.values(state.items)[0];
    delete item.lastFailure; delete item.retryNotBefore;
    state.stateSha256 = processApi.stateDigest(state); fs.writeFileSync(filename, JSON.stringify(state));
    f.files.conferenceAnalysisDir = path.join(f.root, 'analyses');
    const directory = path.join(f.files.conferenceAnalysisDir, item.analysisRunId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'analysis.json'), JSON.stringify({ papers: [{ error: 'HTTP 401: Insufficient balance',
        latestAnalysisAttemptErrorCode: 'MODEL_HTTP_NON_RETRYABLE', latestAnalysisAttemptRetryable: false }] }), { mode: 0o600 });
    const result = await processApi.runConferenceProcess(options, { ...f.deps,
        prepareShared: () => assert.fail('must not prepare blocked legacy process'),
        processPaper: () => assert.fail('must not call model for legacy 401') });
    assert.equal(result.stopped, true); assert.equal(result.batchFailure.category, 'quota');
});

test('计划对不上时，来源代次升级不会重置已有分析', async t => {
    const f = fixture(t); f.files.conferenceAnalysisDir = path.join(f.root, 'analyses');
    const executionId = '11111111-1111-4111-8111-111111111111';
    const directory = path.join(f.files.conferenceAnalysisDir, executionId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'run.json'), 'preserve old run');
    await assert.rejects(processApi.processOne(f.context, { sourceGenerationChanged: true }, {
        ...f.members[0], analysisRunId: executionId
    }, { ...f.deps, adapter: {
        loadConferenceAnalysis: () => ({}), verifyPlanAuthority: () => { throw new Error('old source snapshot'); },
        prepareConferenceAnalysis: () => assert.fail('must not reset analysis'),
        analyzeConference: () => assert.fail('must not call model')
    } }), error => error.code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED' && error.retryable === false);
    assert.equal(fs.readFileSync(path.join(directory, 'run.json'), 'utf8'), 'preserve old run');
});

test('重试放行是一个显式的、只在 apply 时可用的命令行参数', () => {
    const args = ['--catalog', 'catalog.json', '--report', 'report.json', '--filter', '11111111-1111-4111-8111-111111111111'];
    assert.equal(cli.parseArgs(['--apply', '--retry-failed', ...args]).retryFailed, true);
    assert.throws(() => cli.parseArgs(['--status', ...args, '--retry-failed']), /Use/);
    assert.throws(() => cli.parseArgs(['--apply', ...args, '--retry-failed', '--retry-failed']), /Use/);
    assert.equal(require('../scripts/migrate-conference-process.js').parseArgs(['--apply', ...args,
        '--from', '11111111-1111-4111-8111-111111111111', '--retry-failed']).retryFailed, true);
});

test('多跳的旧版迁移沿凭证父级一路追到绑定 UUID 的起点', async t => {
    const migration = require('../scripts/migrate-conference-process.js');
    const recovery = require('../scripts/lib/conference-process-recovery.js');
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const sources = [];
    const deps = { ...f.deps, prepareShared: async (context, ...rest) => {
        sources.push(context.authority.implementationSha256); return f.deps.prepareShared(context, ...rest);
    }, processPaper: async (_c, _s, item) => success(item),
    postprocess: { stagePaper: () => ({ status: 'staged', manifest: success(f.members[0]).pageProof }) } };
    const first = await processApi.runConferenceProcess(options, deps);
    const origin = f.authority.implementationSha256;
    const directory = path.join(f.files.conferenceProcessDir, first.processId);
    const versions = [origin];
    // 走满十二跳，其中包含父提交就是直接父级、中间没有其他提交的旧凭证。
    for (let index = 1; index <= 12; index += 1) {
        const implementation = H(`multi-hop-${index}`); versions.push(implementation);
        f.context.authority = { ...f.authority, implementationSha256: implementation };
        f.runtimeAuthority.implementationSha256 = implementation;
        await migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: deps });
        const receiptFile = path.join(directory, index === 1 ? 'implementation-migration.json'
            : `implementation-migration-${implementation.slice(0, 12)}.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptFile)); receipt.fromImplementationSha256 = versions[index - 1];
        delete receipt.receiptSha256; receipt.receiptSha256 = H(receipt);
        fs.writeFileSync(receiptFile, JSON.stringify(receipt));
        const stateFile = path.join(directory, 'state.json'); const state = JSON.parse(fs.readFileSync(stateFile));
        delete state.sourceImplementationSha256; state.stateSha256 = processApi.stateDigest(state);
        fs.writeFileSync(stateFile, JSON.stringify(state));
        assert.equal(recovery.sourceImplementation(state, directory, processApi), origin);
        assert.equal(cli.processStatus(options, { dependencies: deps }).processId, first.processId);
    }
    assert.ok(sources.every(source => source === origin));
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
    const middleFile = path.join(directory, `implementation-migration-${versions[6].slice(0, 12)}.json`);
    const middleBytes = fs.readFileSync(middleFile); const middle = JSON.parse(middleBytes);
    middle.fromImplementationSha256 = versions[12]; delete middle.receiptSha256; middle.receiptSha256 = H(middle);
    fs.writeFileSync(middleFile, JSON.stringify(middle));
    assert.throws(() => recovery.sourceImplementation(state, directory, processApi), /cycle/);
    fs.writeFileSync(middleFile, middleBytes); fs.renameSync(middleFile, `${middleFile}.unavailable`);
    assert.throws(() => recovery.sourceImplementation(state, directory, processApi), /missing or ambiguous/);
});

test('文本或产物一变，就在调用模型或改动迁移之前拒绝复用完整证明', async t => {
    const migration = require('../scripts/migrate-conference-process.js');
    const f = fixture(t); const options = { apply: true, concurrency: 1 };
    const first = await processApi.runConferenceProcess(options, { ...f.deps,
        processPaper: async (_c, _s, item) => success(item) });
    const stateFile = path.join(f.files.conferenceProcessDir, first.processId, 'state.json');
    const original = fs.readFileSync(stateFile);
    for (const field of ['textSha256', 'artifactsSha256']) {
        const deps = { ...f.deps, prepareShared: async (...args) => {
            const shared = await f.deps.prepareShared(...args); shared.sealed[0].proof[field] = H(`changed-${field}`); return shared;
        }, processPaper: () => assert.fail('must not call model'),
        postprocess: { stagePaper: () => assert.fail('must not restage inconsistent complete proof') } };
        await assert.rejects(processApi.runConferenceProcess(options, deps),
            error => error.code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED');
        assert.deepEqual(fs.readFileSync(stateFile), original);
        f.context.authority = { ...f.authority, implementationSha256: H(`migration-${field}`) };
        f.runtimeAuthority.implementationSha256 = f.context.authority.implementationSha256;
        await assert.rejects(migration.migrateAndRun({ ...options, fromProcessId: first.processId }, { dependencies: deps }),
            error => error.code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED');
        assert.deepEqual(fs.readFileSync(stateFile), original);
        f.context.authority = f.authority; f.runtimeAuthority.implementationSha256 = f.authority.implementationSha256;
    }
});

// 来源升级各种结果登记模式共用的固定数据：已保存并核验的历史来源、
// 模拟的来源发现、共享准备、单篇暂存和汇总步骤，以及
// 一个可切换的「新来源代次」，好让升级结果与原始记录明显不同。
function sourceUpgradeFixture(t, count = 3, original = null) {
    const f = fixture(t, count, original); const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    f.files.conferenceStagingSourceDir = path.join(f.root, 'sources'); f.files.conferenceAnalysisDir = path.join(f.root, 'analysis');
    fs.mkdirSync(f.files.conferenceStagingSourceDir, { mode: 0o700 }); fs.mkdirSync(f.files.conferenceAnalysisDir, { mode: 0o700 });
    const sources = [];
    for (const member of f.members) {
        const names = processApi.sourceNames(member.paperId, f.authority.implementationSha256);
        const bytes = { metadata: Buffer.from('{}'), request: Buffer.from('{}'), text: Buffer.from('historical text'),
            artifacts: Buffer.from('{}'), pdf: extractionFixture.buildPdf(member.paperId) };
        const body = { paperId: member.paperId, sourceIdentity: member.sourceIdentity, version: 2,
            extractor: { version: '0.0.0', backend: { version: 'old' } } };
        const receipt = { ...body, receiptSha256: H(body) }; bytes.receipt = Buffer.from(JSON.stringify(receipt));
        for (const [key, value] of Object.entries(bytes)) fs.writeFileSync(path.join(f.files.conferenceStagingSourceDir, names[key]), value, { mode: 0o600 });
        sources.push({ paperId: member.paperId, proof: { pdfSha256: digest(bytes.pdf), textSha256: digest(bytes.text),
            artifactsSha256: digest(bytes.artifacts), requestSha256: digest(bytes.request), receiptSha256: receipt.receiptSha256,
            verificationSha256: H('historical verification') } });
    }
    f.files.conferencePageStagingDir = path.join(f.root, 'pages'); f.files.conferenceAggregateDir = path.join(f.root, 'aggregates');
    const control = { creatingNewGeneration: false, calls: [], stageCalls: [], preservedCalls: [], originalItems: null };
    const stagedByExecution = new Map();
    const deps = { ...f.deps, discovery: { MAX_PDF_BYTES: discovery.MAX_PDF_BYTES,
        safeAbsoluteFile: discovery.safeAbsoluteFile,
        replayDiscoveryMember: (_handle, identity) => ({ match: { kind: 'exact', candidates: [{ sha256:
            sources[f.members.findIndex(member => member.sourceIdentity === identity)].proof.pdfSha256 }] } }) },
    prepareShared: async () => ({ planHandle: {}, planReceiptSha256: H('plan'), sealed: sources.map(source => ({
        ...source, proof: { ...source.proof, ...(control.creatingNewGeneration ? { receiptSha256: H(`new ${source.paperId}`) } : {}) } })) }),
    processPaper: async (_c, _s, item) => {
        control.calls.push(item.paperId); if (!control.creatingNewGeneration) return success(item);
        const prior = success(item);
        const markdown = `---\npaper_digest_paper_id: "${item.paperId}"\npaper_digest_source_kind: conference\npaper_digest_conference_id: "odyssey-2026"\n---\nFixture new Reader\n`;
        const body = { contract: 'conference-paper-page-staging-v1', version: 1, status: 'complete', paperId: item.paperId,
            analysisExecutionId: item.analysisRunId, ...prior.analysisProof,
            contentSha256: digest(Buffer.from(markdown)), pagePath: prior.pageProof.pagePath, assets: [] };
        const manifest = { ...body, manifestSha256: H(body) }; stagedByExecution.set(item.analysisRunId, manifest);
        const folder = path.join(f.files.conferencePageStagingDir, item.analysisRunId); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
        fs.writeFileSync(path.join(folder, 'page.md'), markdown, { mode: 0o600 });
        return { analysisProof: prior.analysisProof, pageProof: { manifestSha256: manifest.manifestSha256,
            contentSha256: manifest.contentSha256, pagePath: manifest.pagePath } };
    },
    postprocess: { stagePaper: ({ executionId }) => {
            control.stageCalls.push(executionId);
            return { status: 'staged', manifest: stagedByExecution.get(executionId) };
        },
        // 保留的账目成员会照原样重新核对当时记录的阶段字节。
        loadPreservedStage: ({ executionId, paperId }) => {
            control.preservedCalls.push(paperId);
            const item = control.originalItems && control.originalItems.get(paperId);
            if (!item) throw new Error(`preserved promotion has no original item: ${paperId}`);
            if (item.analysisRunId !== executionId) throw new Error(`preserved promotion execution drifted: ${paperId}`);
            return { status: 'staged', manifest: { analysisSha256: item.analysisProof.analysisSha256,
                completionReceiptSha256: item.analysisProof.completionReceiptSha256,
                sourceSnapshotSha256: item.analysisProof.sourceSnapshotSha256,
                manifestSha256: item.pageProof.manifestSha256, contentSha256: item.pageProof.contentSha256,
                pagePath: item.pageProof.pagePath } };
        } },
    aggregate: async (...args) => {
        if (!control.creatingNewGeneration) return f.deps.aggregate(...args);
        const ids = args[2]; const markdown = '---\npaper_digest_page_type: index\nslug: conference-odyssey-2026\n---\nAll upgraded papers\n';
        const body = { contract: 'conference-aggregate-staging-v1', version: 1, status: 'complete', conferenceId: 'odyssey-2026',
            aggregateId: H(ids).slice(0, 32), pagePath: 'content/posts/conference-odyssey-2026.md', markdown,
            markdownSha256: digest(Buffer.from(markdown)) };
        const manifest = { ...body, manifestSha256: H(body) };
        const folder = path.join(f.files.conferenceAggregateDir, 'odyssey-2026', manifest.aggregateId);
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
        fs.writeFileSync(path.join(folder, 'aggregate.md'), markdown, { mode: 0o600 }); return { manifest };
    } };
    const rememberOriginal = stateFile => {
        control.originalItems = new Map(Object.entries(JSON.parse(fs.readFileSync(stateFile)).items));
    };
    return { ...f, deps, sources, control, stagedByExecution, rememberOriginal };
}

test('来源升级只授权显式子集，并保留未选中的和原始的结果', async t => {
    const upgrade = require('../scripts/lib/conference-source-upgrade.js');
    const h = require('./helpers/conference-upgrade-publication-fixture.cjs').bindUpgradePublicationFixture(sourceUpgradeFixture(t, 3)); const f = h; const deps = h.deps;
    const original = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, deps);
    const originalFile = path.join(f.files.conferenceProcessDir, original.processId, 'state.json'), originalBytes = fs.readFileSync(originalFile);
    h.rememberOriginal(originalFile);
    h.control.creatingNewGeneration = true; h.control.calls = [];
    const options = { fromProcessId: original.processId, concurrency: 1 };
    const plan = upgrade.planSourceUpgrade(options, deps); assert.equal(plan.papers.length, 3);
    assert.equal(plan.contract, 'conference-source-upgrade-plan-v2');
    assert.equal(plan.version, 2);
    assert.equal(Object.hasOwn(plan.authority, 'taxonomyRegistrySha256'), false);
    await assert.rejects(upgrade.applySourceUpgrade({ ...options, authorizeNewAnalysis: true, planSha256: plan.planSha256,
        paperIds: ['conference:odyssey:2026:conference-paper-id:unknown'] }, deps), /not in the authorized plan/);
    const selected = f.members[1].paperId;
    const result = await upgrade.applySourceUpgrade({ ...options, authorizeNewAnalysis: true,
        planSha256: plan.planSha256, paperIds: [selected] }, deps);
    assert.equal(result.status, 'complete'); assert.deepEqual(h.control.calls, [selected]);
    const state = JSON.parse(fs.readFileSync(result.stateFile)); assert.deepEqual(Object.keys(state.items), [selected]);
    assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
    await assert.rejects(upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256 }, deps), /requires all conference members/);
    const remaining = f.members.map(item => item.paperId).filter(id => id !== selected);
    await upgrade.applySourceUpgrade({ ...options, authorizeNewAnalysis: true, planSha256: plan.planSha256, paperIds: remaining }, deps);
    const beforePromotionCalls = h.control.calls.length;
    const promoted = await upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256 }, deps);
    assert.equal(promoted.conferenceCompletion, true); assert.equal(promoted.papers, 3); assert.equal(h.control.calls.length, beforePromotionCalls);
    assert.notEqual(promoted.processId, original.processId);
    const promotedStateFile = path.join(f.files.conferenceProcessDir, promoted.processId, 'state.json');
    const promotedState = processApi.assertState(JSON.parse(fs.readFileSync(promotedStateFile)));
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(promotedStateFile), 'completion-receipt.json')));
    processApi.validateCompletionReceipt(promotedState, receipt);
    assert.equal(promotedState.contract, 'conference-process-v2');
    assert.equal(promotedState.version, 2);
    assert.equal(receipt.contract, 'conference-process-completion-receipt-v2');
    assert.equal(receipt.version, 2);
    assert.equal(cli.processStatus(options, { dependencies: deps }).processId, promoted.processId);
    assert.equal((await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, deps)).processId, promoted.processId);
    assert.equal((await upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256 }, deps)).processId, promoted.processId);
    assert.equal(h.control.calls.length, beforePromotionCalls); assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
    const code = `import importlib.util,sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nspec=importlib.util.spec_from_file_location('publisher_readonly',Path(sys.argv[1])/'publish-conference.py')\np=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(p)\np.RUNTIME=Path(sys.argv[2]).parent;p.PROCESS_ROOT=Path(sys.argv[2]);p.PAGE_ROOT=Path(sys.argv[3]);p.AGGREGATE_ROOT=Path(sys.argv[4])\nb=p.process_bundle('odyssey-2026',sys.argv[5])\nprint(json.dumps({'files':len(b['files']),'status':b['state']['status']}))`;
    const publisherRead = childProcess.execFileSync('bash', [path.join(__dirname, '..', 'scripts', 'python-runtime.sh'), '-c', code,
        path.join(__dirname, '..', 'scripts'), f.files.conferenceProcessDir, f.files.conferencePageStagingDir,
        f.files.conferenceAggregateDir, promoted.processId], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(publisherRead), { files: 4, status: 'complete' });
    // 原 v1 文件保持；以下均为独立合成资料，用真实发布读取门核格式及原 SHA 顺序。
    // 当前 writer 的实际 v2 输出由 conference-postprocess 测试另行覆盖。
    const aggregateDirectory = path.join(f.files.conferenceAggregateDir, 'odyssey-2026', promotedState.aggregate.aggregateId);
    const originalAggregateBytes = fs.readFileSync(path.join(aggregateDirectory, 'manifest.json'));
    const originalReceiptBytes = fs.readFileSync(path.join(path.dirname(promotedStateFile), 'completion-receipt.json'));
    const legacyAggregate = JSON.parse(originalAggregateBytes);
    const { manifestSha256: _legacySha, ...legacyBody } = legacyAggregate;
    const currentBody = { ...legacyBody, contract: 'conference-aggregate-staging-v2', version: 2,
        tagMetadata: { contract: 'paper-tag-flat-tags-v2' },
        tagHierarchy: { contract: 'conference-tag-hierarchy-v2' },
        members: f.members.map(item => ({ paperId: item.paperId, tagAssignmentSha256: H(item.paperId) })) };
    const variants = [
        ['current', null],
        ['page-current', null, null],
        ['page-mixed-metadata-same', null, x => { x.taxonomy = x.tagMetadata; }],
        ['page-mixed-metadata-null', null, x => { x.taxonomy = null; x.tagMetadata = null; }],
        ['page-mixed-file-sha-same', null, x => { x.taxonomyAssignmentFileSha256 = x.tagAssignmentFileSha256; }],
        ['page-mixed-file-sha-null', null, x => { x.taxonomyAssignmentFileSha256 = null; x.tagAssignmentFileSha256 = null; }],
        ['page-wrong-version', null, x => { x.version = 1; }],
        ['page-unknown-format', null, x => { x.contract = 'conference-paper-page-staging-v3'; }],
        ['page-wrong-family', null, x => { x.taxonomy = x.tagMetadata; delete x.tagMetadata; }],
        ['page-null-metadata', null, x => { x.tagMetadata = null; }],
        ['page-null-file-sha', null, x => { x.tagAssignmentFileSha256 = null; }],
        ['page-old-assignment', null, x => { x.tagMetadata.contract = 'conference-taxonomy-assignment-v1'; x.tagMetadata.version = 1; }],
        ['page-legacy-new-assignment', null, x => {
            x.contract = 'conference-paper-page-staging-v1'; x.version = 1;
            x.taxonomy = x.tagMetadata; delete x.tagMetadata;
            x.taxonomyAssignmentFileSha256 = x.tagAssignmentFileSha256; delete x.tagAssignmentFileSha256;
        }],
        ['page-legacy-unknown-assignment', null, x => {
            x.contract = 'conference-paper-page-staging-v1'; x.version = 1;
            x.taxonomy = { contract: 'conference-tag-assignment-v3', version: 3 }; delete x.tagMetadata;
            x.taxonomyAssignmentFileSha256 = x.tagAssignmentFileSha256; delete x.tagAssignmentFileSha256;
        }],
        ['page-legacy-partial-assignment', null, x => {
            x.contract = 'conference-paper-page-staging-v1'; x.version = 1;
            x.taxonomy = { contract: 'conference-taxonomy-assignment-v1' }; delete x.tagMetadata;
            x.taxonomyAssignmentFileSha256 = x.tagAssignmentFileSha256; delete x.tagAssignmentFileSha256;
        }],
        ['page-bad-sha-before-mixed', null, x => { x.taxonomy = x.tagMetadata; }],
        ['wrong-version', x => { x.version = 1; }],
        ['unknown-format', x => { x.contract = 'conference-aggregate-staging-v3'; }],
        ['missing-metadata', x => { delete x.tagMetadata; }],
        ['missing-hierarchy', x => { delete x.tagHierarchy; }],
        ['null-metadata', x => { x.tagMetadata = null; }],
        ['null-member-sha', x => { x.members[0].tagAssignmentSha256 = null; }],
        ['wrong-hierarchy', x => { x.tagHierarchy.contract = 'conference-taxonomy-hierarchy-v1'; }],
        ['mixed-metadata-same', x => { x.taxonomy = x.tagMetadata; }],
        ['mixed-metadata-null', x => { x.taxonomy = null; x.tagMetadata = null; }],
        ['mixed-hierarchy-same', x => { x.taxonomyHierarchy = x.tagHierarchy; }],
        ['mixed-hierarchy-null', x => { x.taxonomyHierarchy = null; x.tagHierarchy = null; }],
        ['mixed-member-same', x => { x.members[0].taxonomyAssignmentSha256 = x.members[0].tagAssignmentSha256; }],
        ['mixed-member-null', x => { x.members[0].taxonomyAssignmentSha256 = null; x.members[0].tagAssignmentSha256 = null; }],
        ['wrong-root-family', x => { x.taxonomy = x.tagMetadata; delete x.tagMetadata; }],
        ['wrong-member-family', x => { x.members[0].taxonomyAssignmentSha256 = x.members[0].tagAssignmentSha256; delete x.members[0].tagAssignmentSha256; }],
        ['legacy-wrong-family', x => { x.contract = 'conference-aggregate-staging-v1'; x.version = 1; }],
        ['bad-sha-before-mixed', x => { x.taxonomy = x.tagMetadata; }]
    ];
    const formatRoot = path.join(f.root, 'aggregate-format-fixtures');
    const originalPageFiles = [...h.stagedByExecution.keys()].flatMap(executionId =>
        ['manifest.json', 'page.md'].map(name => {
            const filename = path.join(f.files.conferencePageStagingDir, executionId, name);
            return { filename, bytes: fs.readFileSync(filename) };
        }));
    for (const [name, change, pageChange] of variants) {
        const body = structuredClone(currentBody); change?.(body);
        const manifest = { ...body, manifestSha256: H(name === 'bad-sha-before-mixed' ? currentBody : body) };
        const state = structuredClone(promotedState);
        // 子页也是合成格式资料；保原正文，只重绑此独立样本的父记录。
        const pages = path.join(formatRoot, name, 'pages');
        fs.cpSync(f.files.conferencePageStagingDir, pages, { recursive: true });
        if (name.startsWith('page-')) {
            const paperId = Object.keys(state.items).sort()[0], item = state.items[paperId];
            const filename = path.join(pages, item.analysisRunId, 'manifest.json');
            const { manifestSha256: _oldPageSha, ...oldPageBody } = JSON.parse(fs.readFileSync(filename));
            const pageBody = { ...oldPageBody, contract: 'conference-paper-page-staging-v2', version: 2,
                tagMetadata: { contract: 'conference-tag-assignment-v2', version: 2 },
                tagAssignmentFileSha256: H('synthetic assignment file bytes') };
            const correctPageSha = H(pageBody); pageChange?.(pageBody);
            const pageManifest = { ...pageBody, manifestSha256:
                name === 'page-bad-sha-before-mixed' ? correctPageSha : H(pageBody) };
            fs.writeFileSync(filename, JSON.stringify(pageManifest));
            item.pageProof.manifestSha256 = pageManifest.manifestSha256;
        }
        state.aggregate = { ...state.aggregate, manifestSha256: manifest.manifestSha256 };
        state.stateSha256 = processApi.stateDigest(state);
        const completionBody = processApi.completionBodyFor(state, receipt.planReceiptSha256, state.aggregate);
        const completion = { ...completionBody, receiptSha256: H(completionBody) };
        state.completionReceiptSha256 = completion.receiptSha256;
        state.stateSha256 = processApi.stateDigest(state);
        processApi.validateCompletionReceipt(processApi.assertState(state), completion);
        const processDirectory = path.join(formatRoot, name, 'processes', promoted.processId);
        const aggregate = path.join(formatRoot, name, 'aggregates', 'odyssey-2026', manifest.aggregateId);
        fs.mkdirSync(processDirectory, { recursive: true }); fs.mkdirSync(aggregate, { recursive: true });
        fs.writeFileSync(path.join(processDirectory, 'state.json'), JSON.stringify(state));
        fs.writeFileSync(path.join(processDirectory, 'completion-receipt.json'), JSON.stringify(completion));
        fs.writeFileSync(path.join(aggregate, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(aggregate, 'aggregate.md'), legacyBody.markdown);
    }
    const formatCode = `import importlib.util,sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nspec=importlib.util.spec_from_file_location('publisher_formats',Path(sys.argv[1])/'publish-conference.py')\np=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(p)\nroot=Path(sys.argv[3]);p.RUNTIME=root.parent;results={}\nfor folder in sorted(root.iterdir()):\n p.PAGE_ROOT=folder/'pages';p.PROCESS_ROOT=folder/'processes';p.AGGREGATE_ROOT=folder/'aggregates'\n try:\n  b=p.process_bundle('odyssey-2026',sys.argv[4]);results[folder.name]={'files':len(b['files']),'status':b['state']['status']}\n except p.ConferencePublicationError as error:\n  results[folder.name]={'error':str(error)}\nprint(json.dumps(results))`;
    const formats = JSON.parse(childProcess.execFileSync('bash', [path.join(__dirname, '..', 'scripts', 'python-runtime.sh'),
        '-c', formatCode, path.join(__dirname, '..', 'scripts'), f.files.conferencePageStagingDir,
        formatRoot, promoted.processId], { encoding: 'utf8' }));
    assert.deepEqual(formats.current, { files: 4, status: 'complete' });
    assert.deepEqual(formats['page-current'], { files: 4, status: 'complete' });
    assert.match(formats['bad-sha-before-mixed'].error, /aggregate staging 与 completion proof 不一致/);
    const specificErrors = {
        'page-bad-sha-before-mixed': /论文暂存记录与进程凭证不一致：/,
        'page-null-metadata': /会议论文页面的标签分配记录格式版本无效。/,
        'page-null-file-sha': /会议论文页面的标签分配文件哈希格式无效。/,
        'page-old-assignment': /会议论文页面的标签分配记录格式版本无效。/,
        'page-legacy-new-assignment': /旧版会议论文页面的标签分配记录格式版本无效。/,
        'page-legacy-unknown-assignment': /旧版会议论文页面的标签分配记录格式版本无效。/,
        'page-legacy-partial-assignment': /旧版会议论文页面的标签分配记录格式版本无效。/,
        'missing-metadata': /新版会议汇总缺少标签记录或层级字段。/,
        'missing-hierarchy': /新版会议汇总缺少标签记录或层级字段。/,
        'null-metadata': /新版会议汇总的标签记录格式无效。/,
        'null-member-sha': /新版会议汇总成员的标签分配哈希格式无效。/
    };
    for (const [name] of variants.slice(1, -1)) {
        if (name === 'page-current') continue;
        assert.match(formats[name].error, specificErrors[name] || /不能混用|格式版本不受支持|格式版本不一致/);
    }
    for (const saved of originalPageFiles) assert.deepEqual(fs.readFileSync(saved.filename), saved.bytes);
    assert.deepEqual(fs.readFileSync(path.join(aggregateDirectory, 'manifest.json')), originalAggregateBytes);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(promotedStateFile), 'completion-receipt.json')), originalReceiptBytes);
    assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
    const authArgs = ['--catalog', 'catalog.json', '--report', 'report.json', '--filter', f.authority.filterId,
        '--from', original.processId];
    assert.equal(cli.parseArgs(['--source-upgrade-plan', ...authArgs]).sourceUpgrade, 'plan');
    assert.throws(() => cli.parseArgs(['--source-upgrade-apply', ...authArgs]), /Use/);
    const parsed = cli.parseArgs(['--source-upgrade-apply', ...authArgs, '--plan-sha', plan.planSha256,
        '--paper-ids', selected, '--authorize-new-analysis']);
    assert.deepEqual(parsed.paperIds, [selected]); assert.equal(parsed.authorizeNewAnalysis, true);
});

test('promote 命令行只接受一个 promote 账目模式参数', () => {
    const shared = ['--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', '11111111-1111-4111-8111-111111111111', '--from', '22222222-2222-4222-8222-222222222222'];
    const promote = ['--source-upgrade-promote', ...shared, '--plan-sha', 'a'.repeat(64)];
    assert.equal(cli.parseArgs(promote).preserveOriginalComplete, undefined);
    assert.equal(cli.parseArgs(promote).preferUpgrade, undefined);
    assert.equal(cli.parseArgs([...promote, '--preserve-original-complete']).preserveOriginalComplete, true);
    assert.equal(cli.parseArgs([...promote, '--prefer-upgrade']).preferUpgrade, true);
    assert.throws(() => cli.parseArgs([...promote, '--preserve-original-complete', '--prefer-upgrade']), /Use/);
    assert.throws(() => cli.parseArgs([...promote, '--prefer-upgrade', '--preserve-original-complete']), /Use/);
    assert.throws(() => cli.parseArgs(['--source-upgrade-plan', ...shared, '--prefer-upgrade']), /Use/);
    assert.throws(() => cli.parseArgs(['--source-upgrade-apply', ...shared, '--plan-sha', 'a'.repeat(64),
        '--paper-ids', 'conference:odyssey:2026:conference-paper-id:paper.1', '--authorize-new-analysis',
        '--prefer-upgrade']), /Use/);
});

test('promote --prefer-upgrade 先登记升级过的成员，保留其余成员，并生成可核对的账目', async t => {
    const upgrade = require('../scripts/lib/conference-source-upgrade.js');
    const h = sourceUpgradeFixture(t, 3);
    const original = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, h.deps);
    const originalFile = path.join(h.files.conferenceProcessDir, original.processId, 'state.json');
    h.rememberOriginal(originalFile);
    h.control.creatingNewGeneration = true; h.control.calls = [];
    const options = { fromProcessId: original.processId, concurrency: 1 };
    const plan = upgrade.planSourceUpgrade(options, h.deps);
    const upgradedIds = [h.members[0].paperId, h.members[1].paperId].sort();
    const kept = h.members[2].paperId;
    const applied = await upgrade.applySourceUpgrade({ ...options, authorizeNewAnalysis: true,
        planSha256: plan.planSha256, paperIds: upgradedIds }, h.deps);
    assert.equal(applied.status, 'complete');
    const runsBeforePromotion = h.control.calls.length;
    // 无 flag 的默认模式仍然要求全量升级完成。
    await assert.rejects(upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256 }, h.deps),
        /Promotion requires all conference members upgraded and complete/);
    assert.equal(h.control.calls.length, runsBeforePromotion);
    const promoted = await upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256,
        preferUpgrade: true }, h.deps);
    assert.equal(promoted.conferenceCompletion, true); assert.equal(promoted.papers, 3);
    assert.equal(h.control.calls.length, runsBeforePromotion, 'promote 不调用模型');
    const directory = path.join(h.files.conferenceProcessDir, promoted.processId);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'completion-receipt.json')));
    processApi.validateCompletionReceipt(state, receipt);
    assert.equal(cli.processStatus(options, { dependencies: h.deps }).processId, promoted.processId);
    const promotion = receipt.sourceUpgradePromotion;
    assert.equal(promotion.preferUpgrade, true);
    assert.deepEqual(promotion.upgradedPaperIds, upgradedIds);
    assert.deepEqual(promotion.preservedOriginalCompletePaperIds, [kept]);
    assert.equal(Object.hasOwn(promotion, 'preservedPriorUpgradePaperIds'), false);
    // 升级优先：已升级的成员取升级结果。
    for (const id of upgradedIds) {
        const item = state.items[id];
        assert.equal(item.analysisRunId, processApi.deterministicUuid(promoted.processId, id, 'analysis'));
        assert.equal(item.preservedOriginalComplete, undefined);
        assert.equal(item.pageProof.contentSha256, h.stagedByExecution.get(item.analysisRunId).contentSha256);
    }
    // 其余成员回填原样结果。
    const preserved = state.items[kept];
    assert.equal(preserved.preservedOriginalComplete, true);
    assert.notEqual(preserved.analysisRunId, processApi.deterministicUuid(promoted.processId, kept, 'analysis'));
    assert.deepEqual(preserved.pageProof, h.control.originalItems.get(kept).pageProof);
    assert.deepEqual(h.control.preservedCalls, [kept]);
    assert.deepEqual(h.control.stageCalls, upgradedIds.map(id => state.items[id].analysisRunId));
    // 完成后的用途：promoted 进程只供 --status 查询和发布读取，后续 --apply 按设计拒绝重绑。
    await assert.rejects(processApi.runConferenceProcess({ apply: true, concurrency: 1 }, h.deps),
        error => error.code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED'
            && /请先检查 --source-upgrade-plan --from /.test(error.message));
    // 凭证字段的顺序、唯一性、成员范围或类型不符合要求时，一律拒绝。
    const tamper = (mutation, pattern) => {
        const copy = structuredClone(state);
        mutation(copy.sourceUpgradePromotion);
        copy.stateSha256 = processApi.stateDigest(copy);
        assert.throws(() => processApi.assertState(copy), pattern);
    };
    tamper(p => { const [first, second] = p.upgradedPaperIds; p.upgradedPaperIds = [second, first]; },
        /Source upgrade upgradedPaperIds is invalid/);
    tamper(p => { p.upgradedPaperIds = [p.upgradedPaperIds[0], p.upgradedPaperIds[0]]; },
        /Source upgrade upgradedPaperIds is invalid/);
    tamper(p => { p.upgradedPaperIds = [...p.upgradedPaperIds, 'conference:odyssey:2026:conference-paper-id:unknown']; },
        /Source upgrade upgradedPaperIds is invalid/);
    tamper(p => { p.preferUpgrade = 'true'; }, /Source upgrade preferUpgrade is invalid/);
    tamper(p => { delete p.preservedOriginalCompletePaperIds; },
        /Source upgrade preferUpgrade ledger arrays are missing/);
});

test('promote --preserve-original-complete 原样保留原始结果，忽略升级后的结果', async t => {
    const upgrade = require('../scripts/lib/conference-source-upgrade.js');
    const h = sourceUpgradeFixture(t, 3);
    const original = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, h.deps);
    const originalFile = path.join(h.files.conferenceProcessDir, original.processId, 'state.json');
    h.rememberOriginal(originalFile);
    h.control.creatingNewGeneration = true; h.control.calls = [];
    const options = { fromProcessId: original.processId, concurrency: 1 };
    const plan = upgrade.planSourceUpgrade(options, h.deps);
    const upgradedId = h.members[0].paperId;
    const applied = await upgrade.applySourceUpgrade({ ...options, authorizeNewAnalysis: true,
        planSha256: plan.planSha256, paperIds: [upgradedId] }, h.deps);
    assert.equal(applied.status, 'complete');
    await assert.rejects(upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256 }, h.deps),
        /Promotion requires all conference members upgraded and complete/);
    const beforePromotionCalls = h.control.calls.length;
    const promoted = await upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256,
        preserveOriginalComplete: true }, h.deps);
    assert.equal(promoted.conferenceCompletion, true); assert.equal(promoted.papers, 3);
    assert.equal(h.control.calls.length, beforePromotionCalls);
    assert.deepEqual(h.control.stageCalls, [], 'preserve 模式不走 stagePaper，升级结果被整体忽略');
    const directory = path.join(h.files.conferenceProcessDir, promoted.processId);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'completion-receipt.json')));
    processApi.validateCompletionReceipt(state, receipt);
    const promotion = receipt.sourceUpgradePromotion;
    assert.equal(Object.hasOwn(promotion, 'preferUpgrade'), false);
    assert.equal(Object.hasOwn(promotion, 'upgradedPaperIds'), false);
    const allIds = h.members.map(item => item.paperId).sort();
    assert.deepEqual(promotion.preservedOriginalCompletePaperIds, allIds);
    assert.deepEqual(promotion.preservedPriorUpgradePaperIds, []);
    assert.deepEqual(h.control.preservedCalls, allIds);
    const upgradedRunId = processApi.deterministicUuid(promoted.processId, upgradedId, 'analysis');
    assert.equal(h.stagedByExecution.has(upgradedRunId), true, '升级结果存在但必须被忽略');
    for (const id of allIds) {
        const item = state.items[id];
        assert.equal(item.preservedOriginalComplete, true);
        assert.equal(item.analysisRunId, h.control.originalItems.get(id).analysisRunId);
        assert.notEqual(item.analysisRunId, processApi.deterministicUuid(promoted.processId, id, 'analysis'));
        assert.deepEqual(item.pageProof, h.control.originalItems.get(id).pageProof);
    }
});

test('成员原本不完整又没有升级结果时，promote --prefer-upgrade 仍然拒绝', async t => {
    const upgrade = require('../scripts/lib/conference-source-upgrade.js');
    const h = sourceUpgradeFixture(t, 3);
    const failed = h.members[2].paperId;
    const original = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, { ...h.deps,
        processPaper: async (_context, _shared, item) => {
            if (item.paperId === failed) throw new Error('fixture original failure');
            return success(item);
        } });
    assert.equal(original.status, 'partial');
    h.rememberOriginal(path.join(h.files.conferenceProcessDir, original.processId, 'state.json'));
    h.control.creatingNewGeneration = true; h.control.calls = [];
    const options = { fromProcessId: original.processId, concurrency: 1 };
    const plan = upgrade.planSourceUpgrade(options, h.deps);
    const upgraded = [h.members[0].paperId];
    const applied = await upgrade.applySourceUpgrade({ ...options, authorizeNewAnalysis: true,
        planSha256: plan.planSha256, paperIds: upgraded }, h.deps);
    assert.equal(applied.status, 'complete');
    await assert.rejects(upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256,
        preferUpgrade: true }, h.deps),
        error => /^Promotion requires all conference members upgraded and complete; missing: /.test(error.message)
            && error.message.endsWith(failed));
});

function useCurrentTagAuthority(f, implementationSha256 = f.runtimeAuthority.implementationSha256) {
    const authority = { ...f.context.authority,
        tagCatalogVersion: f.context.authority.taxonomyVersion,
        tagCatalogSha256: f.context.authority.taxonomyRegistrySha256, implementationSha256 };
    delete authority.taxonomyVersion;
    delete authority.taxonomyRegistrySha256;
    f.context.authority = authority;
    f.runtimeAuthority.implementationSha256 = implementationSha256;
}

test('原实现生成的完整旧进程按原 UUID 恢复，已完成论文不再次调用模型', async t => {
    const original = loadOriginalConferenceProcessApis();
    const f = fixture(t, 1, original);
    let calls = 0;
    const deps = { ...f.deps, processPaper: async (_c, _s, item) => { calls += 1; return success(item); } };
    const first = await original.processApi.runConferenceProcess({ apply: true, concurrency: 1 }, deps);
    const directory = path.join(f.files.conferenceProcessDir, first.processId);
    const receiptBytes = fs.readFileSync(path.join(directory, 'completion-receipt.json'));
    const originalState = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
    assert.equal(originalState.contract, 'conference-process-v1');
    assert.equal(originalState.authority.implementationSha256, original.implementationSha256);
    useCurrentTagAuthority(f);
    const resumed = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
        ...deps, processPaper: () => assert.fail('完成论文不能再次请求模型')
    });
    assert.equal(resumed.processId, first.processId);
    assert.equal(calls, 1);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    assert.equal(state.contract, originalState.contract);
    assert.deepEqual(state.authority, originalState.authority);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'completion-receipt.json')), receiptBytes);
    assert.equal(Object.hasOwn(state.authority, 'tagCatalogSha256'), false);
    f.context.authority.implementationSha256 = H('explicit migrated completed implementation');
    f.runtimeAuthority.implementationSha256 = f.context.authority.implementationSha256;
    const migrated = await require('../scripts/migrate-conference-process.js').migrateAndRun({
        apply: true, concurrency: 1, fromProcessId: first.processId
    }, { dependencies: { ...deps,
        processPaper: () => assert.fail('迁移完成论文不能再次请求模型'),
        postprocess: { stagePaper: () => ({ status: 'staged', manifest: success(f.members[0]).pageProof }) }
    } });
    assert.equal(migrated.processId, first.processId);
    assert.equal(calls, 1);
    const migratedState = processApi.assertState(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))));
    assert.equal(migratedState.contract, 'conference-process-v1');
    assert.equal(migratedState.sourceImplementationSha256, original.implementationSha256);
    assert.equal(migratedState.authority.taxonomyRegistrySha256, originalState.authority.taxonomyRegistrySha256);
    assert.equal(Object.hasOwn(migratedState.authority, 'tagCatalogSha256'), false);
    const archived = fs.readdirSync(directory).filter(name => /^completion-receipt-[a-f0-9]+(?:-[0-9]+)?\.json$/.test(name));
    assert.ok(archived.some(name => fs.readFileSync(path.join(directory, name)).equals(receiptBytes)));
});

test('原费用失败记录先要求显式迁移，再沿原 UUID 和尝试记录恢复', async t => {
    const original = loadOriginalConferenceProcessApis();
    const f = fixture(t, 1, original);
    let calls = 0;
    const failed = await original.processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
        ...f.deps, processPaper: () => {
            calls += 1;
            throw Object.assign(new Error('HTTP 401: Insufficient balance offline mock'),
                { code: 'MODEL_HTTP_NON_RETRYABLE', retryable: false });
        }
    });
    const directory = path.join(f.files.conferenceProcessDir, failed.processId);
    const filename = path.join(directory, 'state.json');
    const before = fs.readFileSync(filename), issued = JSON.parse(before);
    useCurrentTagAuthority(f);
    const blocked = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
        ...f.deps, prepareShared: () => assert.fail('费用阻断不应重做来源准备'),
        processPaper: () => assert.fail('费用阻断不应再次请求模型')
    });
    assert.equal(blocked.processId, failed.processId);
    assert.equal(blocked.stopped, true);
    assert.deepEqual(fs.readFileSync(filename), before);
    // 实现变化是独立、明确的模拟；原实现生成的记录保持原字节。
    f.context.authority.implementationSha256 = H('explicit current implementation');
    f.runtimeAuthority.implementationSha256 = f.context.authority.implementationSha256;
    await assert.rejects(processApi.runConferenceProcess({ apply: true, concurrency: 1 }, f.deps), /migrate with --from/);
    assert.deepEqual(fs.readFileSync(filename), before);
    const migrated = await require('../scripts/migrate-conference-process.js').migrateAndRun({
        apply: true, concurrency: 1, fromProcessId: failed.processId, retryFailed: true
    }, { dependencies: { ...f.deps, processPaper: async (_c, _s, item) => { calls += 1; return success(item); } } });
    assert.equal(migrated.processId, failed.processId);
    assert.equal(migrated.status, 'complete');
    assert.equal(calls, 2);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(filename)));
    const item = state.items[f.members[0].paperId];
    assert.equal(state.contract, 'conference-process-v1');
    assert.equal(state.authority.taxonomyVersion, issued.authority.taxonomyVersion);
    assert.equal(state.authority.taxonomyRegistrySha256, issued.authority.taxonomyRegistrySha256);
    assert.equal(Object.hasOwn(state.authority, 'tagCatalogSha256'), false);
    assert.equal(item.attempts, 2);
    assert.equal(item.retryReleases[0].attempts, 1);
    assert.equal(item.retryReleases[0].previousFailure.category, 'quota');
    assert.equal(item.analysisRunId, issued.items[item.paperId].analysisRunId);
});

test('原零尝试初始化例外保留，实现变化只创建新版进程而不覆盖旧状态', async t => {
    const original = loadOriginalConferenceProcessApis();
    const f = fixture(t, 1, original);
    await assert.rejects(original.processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
        ...f.deps, prepareShared: () => { throw new Error('offline preparation interruption'); }
    }), /offline preparation interruption/);
    const oldId = original.processApi.deterministicUuid(H(f.authority), original.processApi.CONTRACT);
    const oldFile = path.join(f.files.conferenceProcessDir, oldId, 'state.json');
    const oldBytes = fs.readFileSync(oldFile);
    assert.equal(Object.values(JSON.parse(oldBytes).items)[0].attempts, 0);
    useCurrentTagAuthority(f, H('new implementation without prior analysis'));
    const current = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
        ...f.deps, processPaper: async (_c, _s, item) => success(item)
    });
    assert.notEqual(current.processId, oldId);
    assert.deepEqual(fs.readFileSync(oldFile), oldBytes);
    const state = processApi.assertState(JSON.parse(fs.readFileSync(path.join(f.files.conferenceProcessDir, current.processId, 'state.json'))));
    assert.equal(state.contract, 'conference-process-v2');
    assert.equal(state.version, 2);
    assert.equal(Object.hasOwn(state.authority, 'taxonomyRegistrySha256'), false);
});

test('出现混用的新旧词表字段时拒绝继续；优先检查原状态的 SHA-256', async t => {
    const f = fixture(t);
    const result = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
        ...f.deps, processPaper: async (_c, _s, item) => success(item)
    });
    const state = JSON.parse(fs.readFileSync(path.join(f.files.conferenceProcessDir, result.processId, 'state.json')));
    for (const value of [state.authority.tagCatalogSha256, null]) {
        const mixed = structuredClone(state);
        mixed.authority.taxonomyRegistrySha256 = value;
        assert.throws(() => processApi.assertState(mixed), /checkpoint integrity failed/);
        mixed.stateSha256 = processApi.stateDigest(mixed);
        assert.throws(() => processApi.assertState(mixed), /不能混用/);
    }
    for (const change of [x => { x.tagCatalogSha256 = [x.tagCatalogSha256]; },
        x => { x.tagCatalogVersion = '   '; }]) {
        const invalid = structuredClone(state);
        change(invalid.authority);
        invalid.stateSha256 = processApi.stateDigest(invalid);
        assert.throws(() => processApi.assertState(invalid), /词表版本或原文件 SHA 无效/);
    }
    const wrong = structuredClone(state);
    wrong.version = 1;
    wrong.stateSha256 = processApi.stateDigest(wrong);
    assert.throws(() => processApi.assertState(wrong), /格式/);
    const original = loadOriginalConferenceProcessApis();
    const legacy = fixture(t, 1, original);
    const issued = await original.processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
        ...legacy.deps, processPaper: async (_c, _s, item) => success(item)
    });
    const legacyFile = path.join(legacy.files.conferenceProcessDir, issued.processId, 'state.json');
    const mixedLegacy = JSON.parse(fs.readFileSync(legacyFile));
    mixedLegacy.authority.tagCatalogSha256 = null;
    useCurrentTagAuthority(legacy);
    const directories = fs.readdirSync(legacy.files.conferenceProcessDir).sort();
    const noWork = { ...legacy.deps,
        prepareShared: () => assert.fail('混用状态不能进入来源准备'),
        processPaper: () => assert.fail('混用状态不能请求模型') };
    fs.writeFileSync(legacyFile, JSON.stringify(mixedLegacy), { mode: 0o600 });
    await assert.rejects(processApi.runConferenceProcess({ apply: true, concurrency: 1 }, noWork),
        /checkpoint integrity failed/);
    assert.deepEqual(fs.readdirSync(legacy.files.conferenceProcessDir).sort(), directories);
    mixedLegacy.stateSha256 = processApi.stateDigest(mixedLegacy);
    fs.writeFileSync(legacyFile, JSON.stringify(mixedLegacy), { mode: 0o600 });
    await assert.rejects(processApi.runConferenceProcess({ apply: true, concurrency: 1 }, noWork),
        /不能混用新旧词表身份字段/);
    assert.deepEqual(fs.readdirSync(legacy.files.conferenceProcessDir).sort(), directories);
});

test('原来源升级计划及费用检查点恢复时保持授权、原计划字节和尝试次数', async t => {
    const original = loadOriginalConferenceProcessApis();
    const h = sourceUpgradeFixture(t, 1, original);
    const first = await original.processApi.runConferenceProcess({ apply: true, concurrency: 1 }, h.deps);
    const parentFile = path.join(h.files.conferenceProcessDir, first.processId, 'state.json');
    const parentBytes = fs.readFileSync(parentFile);
    h.rememberOriginal(parentFile);
    h.control.creatingNewGeneration = true;
    const options = { fromProcessId: first.processId, concurrency: 1 };
    const plan = original.upgrade.planSourceUpgrade(options, h.deps);
    let calls = 0;
    const deps = { ...h.deps, processPaper: async (...args) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('HTTP 401: Insufficient balance offline mock'),
            { code: 'MODEL_HTTP_NON_RETRYABLE', retryable: false });
        return h.deps.processPaper(...args);
    } };
    const authorized = { ...options, authorizeNewAnalysis: true, planSha256: plan.planSha256,
        paperIds: h.members.map(item => item.paperId) };
    const partial = await original.upgrade.applySourceUpgrade(authorized, deps);
    const directory = path.join(path.dirname(parentFile), `source-upgrade-${partial.upgradeId}`);
    const planFile = path.join(directory, 'plan.json'), stateFile = path.join(directory, 'state.json');
    const planBytes = fs.readFileSync(planFile), partialBytes = fs.readFileSync(stateFile);
    const issued = JSON.parse(partialBytes);
    assert.equal(plan.contract, 'conference-source-upgrade-plan-v1');
    assert.equal(Object.values(issued.items)[0].attempts, 1);
    useCurrentTagAuthority(h);
    const upgrade = require('../scripts/lib/conference-source-upgrade.js');
    const blocked = await upgrade.applySourceUpgrade(authorized, deps);
    assert.equal(blocked.stopped, true);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(stateFile), partialBytes);
    const complete = await upgrade.applySourceUpgrade({ ...authorized, retryFailed: true }, deps);
    assert.equal(complete.status, 'complete');
    assert.equal(calls, 2);
    const state = JSON.parse(fs.readFileSync(stateFile));
    assert.deepEqual(state.authorization, issued.authorization);
    assert.equal(state.planSha256, issued.planSha256);
    assert.equal(Object.values(state.items)[0].analysisRunId, Object.values(issued.items)[0].analysisRunId);
    assert.equal(Object.values(state.items)[0].attempts, 2);
    assert.deepEqual(fs.readFileSync(planFile), planBytes);
    assert.deepEqual(fs.readFileSync(parentFile), parentBytes);
    const promoted = await upgrade.promoteSourceUpgrade({ ...options, planSha256: plan.planSha256 }, deps);
    const childFile = path.join(h.files.conferenceProcessDir, promoted.processId, 'state.json');
    const child = processApi.assertState(JSON.parse(fs.readFileSync(childFile)));
    assert.equal(child.contract, 'conference-process-v1');
    assert.equal(calls, 2);
    const mixedChild = structuredClone(child);
    mixedChild.contract = 'conference-process-v2'; mixedChild.version = 2;
    mixedChild.authority.tagCatalogVersion = mixedChild.authority.taxonomyVersion;
    mixedChild.authority.tagCatalogSha256 = mixedChild.authority.taxonomyRegistrySha256;
    delete mixedChild.authority.taxonomyVersion; delete mixedChild.authority.taxonomyRegistrySha256;
    mixedChild.stateSha256 = processApi.stateDigest(mixedChild);
    fs.writeFileSync(childFile, processApi.canonicalBytes(mixedChild), { mode: 0o600 });
    assert.throws(() => require('../scripts/lib/conference-process-recovery.js').sourceImplementation(
        mixedChild, path.dirname(childFile), processApi), /promotion plan integrity failed/);
});

test('原升级计划写入后中断，可在原授权选择下补建检查点而不改计划', async t => {
    const original = loadOriginalConferenceProcessApis();
    const h = sourceUpgradeFixture(t, 1, original);
    const result = await original.processApi.runConferenceProcess({ apply: true, concurrency: 1 }, h.deps);
    const parentFile = path.join(h.files.conferenceProcessDir, result.processId, 'state.json');
    const parentBytes = fs.readFileSync(parentFile);
    h.rememberOriginal(parentFile);
    h.control.creatingNewGeneration = true;
    h.control.calls = [];
    const options = { fromProcessId: result.processId, concurrency: 1 };
    const plan = original.upgrade.planSourceUpgrade(options, h.deps);
    const selected = h.members.map(item => item.paperId).sort();
    const authorized = { ...options, authorizeNewAnalysis: true, planSha256: plan.planSha256, paperIds: selected };
    await assert.rejects(original.upgrade.applySourceUpgrade(authorized, { ...h.deps, engine: {
        ...engine, updateJsonFileLocked: (filename, ...args) => {
            if (/source-upgrade-[a-f0-9]{64}\/state\.json$/.test(filename)) {
                throw new Error('offline interruption before upgrade checkpoint');
            }
            return engine.updateJsonFileLocked(filename, ...args);
        }
    } }), /offline interruption before upgrade checkpoint/);
    const upgradeId = H({ planSha256: plan.planSha256, selected });
    const directory = path.join(path.dirname(parentFile), `source-upgrade-${upgradeId}`);
    const planFile = path.join(directory, 'plan.json');
    const planBytes = fs.readFileSync(planFile);
    assert.equal(fs.existsSync(path.join(directory, 'state.json')), false);
    assert.deepEqual(h.control.calls, []);
    useCurrentTagAuthority(h);
    const restored = await require('../scripts/lib/conference-source-upgrade.js').applySourceUpgrade(authorized, h.deps);
    assert.equal(restored.upgradeId, upgradeId);
    assert.equal(restored.status, 'complete');
    const checkpoint = JSON.parse(fs.readFileSync(restored.stateFile));
    assert.equal(checkpoint.planSha256, plan.planSha256);
    assert.deepEqual(checkpoint.authorization, { newAnalysis: true, selectedPaperIds: selected, planSha256: plan.planSha256 });
    assert.equal(Object.values(checkpoint.items)[0].attempts, 1);
    assert.deepEqual(fs.readFileSync(planFile), planBytes);
    assert.deepEqual(fs.readFileSync(parentFile), parentBytes);
});

test('无关原任务的损坏状态不会阻断目标任务，实际匹配状态仍先核原 SHA-256', async t => {
    const original = loadOriginalConferenceProcessApis();
    const target = fixture(t, 1, original);
    const completed = await original.processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
        ...target.deps, processPaper: async (_c, _s, item) => success(item)
    });
    const targetFile = path.join(target.files.conferenceProcessDir, completed.processId, 'state.json');
    for (const change of [
        f => {
            f.authority.catalogName = 'another-catalog.json';
            f.authority.reportName = 'another-report.json';
            f.members[0].paperId = 'conference:odyssey:2026:conference-paper-id:another-paper';
            f.members[0].sourceIdentity = 'conference-paper-id:another-paper';
            f.authority.selectedMemberSetSha256 = H(f.members.map(item => item.paperId));
        },
        f => {
            f.authority.taxonomyVersion = 'another-issued-catalog';
            f.authority.taxonomyRegistrySha256 = H('another issued catalog bytes');
        }
    ]) {
        const unrelated = fixture(t, 1, original);
        change(unrelated);
        const result = await original.processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
            ...unrelated.deps, processPaper: async (_c, _s, item) => success(item)
        });
        const originalFile = path.join(unrelated.files.conferenceProcessDir, result.processId, 'state.json');
        const state = JSON.parse(fs.readFileSync(originalFile));
        state.generation += 1; // 故意使原 SHA-256 不再匹配；不是把新版对象改头伪造旧记录。
        const directory = path.join(target.files.conferenceProcessDir, result.processId);
        fs.mkdirSync(directory, { mode: 0o700 });
        const filename = path.join(directory, 'state.json');
        fs.writeFileSync(filename, JSON.stringify(state), { mode: 0o600 });
    }
    useCurrentTagAuthority(target);
    const restored = await processApi.runConferenceProcess({ apply: true, concurrency: 1 }, {
        ...target.deps, processPaper: () => assert.fail('目标论文已完成，不应再次调用模型')
    });
    assert.equal(restored.processId, completed.processId);
    const matching = JSON.parse(fs.readFileSync(targetFile));
    matching.generation += 1;
    fs.writeFileSync(targetFile, JSON.stringify(matching), { mode: 0o600 });
    await assert.rejects(processApi.runConferenceProcess({ apply: true, concurrency: 1 }, target.deps),
        /checkpoint integrity failed/);
});


test('来源与后处理完整性错误优先按稳定错误码分类，不随诊断措辞重试', () => {
    const recovery = require('../scripts/lib/conference-process-recovery.js');
    for (const code of ['CONFERENCE_POSTPROCESS_INTEGRITY', 'CONFERENCE_SOURCE_CONTEXT_INTEGRITY']) {
        for (const message of [
            '会议后处理检查未通过：读者文章与正式分析的对应记录未通过校验。',
            'structuredArtifacts payload is invalid',
            '来源校验失败，记录中包含 HTTP 401 和 proxy 文本'
        ]) {
            const failure = recovery.classifyFailure(Object.assign(new Error(message), { code }),
                '2026-10-09T00:00:00.000Z');
            assert.equal(failure.category, 'integrity');
            assert.equal(failure.retryable, false);
            assert.equal(failure.systemic, false);
            assert.equal(recovery.eligible({ status: 'failed', attempts: 1, lastFailure: failure },
                '2026-10-09T01:00:00.000Z'), false);
        }
    }
});

test('提示词渲染迁移实现只进入当前会议清单，v1 旧清单与重算保持不变', () => {
    const helper = 'scripts/lib/prompt-rendering-contract.js';
    assert.ok(!processApi.IMPLEMENTATION_FILES.includes(helper));
    assert.equal(processApi.currentImplementationFiles().filter(name => name === helper).length, 1);
    const root = '/virtual/prompt-rendering';
    const files = [...new Set([...processApi.currentImplementationFiles(), ...processApi.IMPLEMENTATION_FILES])];
    const sources = new Map(files.map(name => [name, Buffer.from(`source:${name}`)]));
    const fingerprint = promptTextVersion => processApi.implementationSha256({ root, promptTextVersion,
        readFileSync: filename => sources.get(path.relative(root, filename)) });
    const current = fingerprint(); const legacy = fingerprint('v1');
    sources.set(helper, Buffer.from('updated prompt rendering helper'));
    assert.notEqual(fingerprint(), current);
    assert.equal(fingerprint('v1'), legacy);
});


test('来源升级CLI保留合法OpenReview身份大小写，仍拒绝路径和空身份', () => {
    const identity = require('../scripts/lib/paper-identity.js');
    const paperId = identity.canonicalConferencePaperId({ id: 'icml-2026', year: 2026 },
        { type: 'openreview-forum-id', value: 'n1mAjfRDZ6' });
    const argsFor = value => ['--source-upgrade-apply', '--catalog', 'catalog.json', '--report', 'report.json',
        '--filter', '11111111-1111-4111-8111-111111111111',
        '--from', '22222222-2222-4222-8222-222222222222', '--plan-sha', 'a'.repeat(64),
        '--paper-ids', value, '--authorize-new-analysis'];
    const parsed = cli.parseArgs(argsFor(paperId));
    assert.deepEqual(parsed.paperIds, ['conference:icml:2026:openreview-forum-id:n1mAjfRDZ6']);
    assert.equal(parsed.authorizeNewAnalysis, true);
    assert.equal(parsed.planSha256, 'a'.repeat(64));
    for (const invalid of ['', `${paperId},`, `,${paperId}`, `${paperId}/../../state.json`,
        `${paperId}\\state.json`, `${paperId} other`, `${paperId}?x=1`]) {
        assert.throws(() => cli.parseArgs(argsFor(invalid)), /Use/);
    }
    assert.throws(() => cli.parseArgs(argsFor(paperId).slice(0, -1)), /Use/);
});

test('真实抽取凭证拒绝后停止该论文的自动重试，其他论文继续；显式重试保留旧失败', async t => {
    const f = fixture(t, 2);
    f.files.conferenceAnalysisDir = path.join(f.root, 'analysis');
    const sourceRoot = fs.realpathSync(f.root);
    const receiptPath = path.join(sourceRoot, 'invalid.receipt.json');
    fs.writeFileSync(receiptPath, '{}', { mode: 0o600 });
    const extraction = require('../scripts/lib/conference-extraction-receipt.js');
    const beforeReceipt = fs.readFileSync(receiptPath);
    let now = Date.parse('2026-09-09T00:00:00.000Z');
    const analyzed = [];
    const dependencies = { ...f.deps,
        now: () => new Date(now++).toISOString(),
        adapter: {
            prepareConferenceAnalysis: () => {},
            analyzeConference: async ({ executionId }) => {
                analyzed.push(executionId);
                return { status: 'complete', analysisSha256: H(executionId) };
            }
        },
        postprocess: {
            stagePaper: ({ executionId }) => {
                // 使用实际来源校验器拒绝损坏凭证，再让真实逐篇处理及调度入口接收原异常。
                // 用已开始分析的顺序识别成员，不依赖额外的伪造错误或英文关键词。
                if (executionId === analyzed[0]) {
                    extraction.loadExtractionHandle(sourceRoot, 'invalid.receipt.json', { replay: false });
                }
                return { status: 'staged', manifest: { completionReceiptSha256: H('completion'),
                    sourceSnapshotSha256: H('snapshot'), manifestSha256: H('manifest'),
                    contentSha256: H('content'), pagePath: 'content/posts/valid-peer.md' } };
            }
        }
    };
    const options = { apply: true, concurrency: 1 };
    const first = await processApi.runConferenceProcess(options, dependencies);
    assert.equal(first.status, 'partial');
    assert.equal(analyzed.length, 2);
    const statePath = path.join(f.files.conferenceProcessDir, first.processId, 'state.json');
    const readState = () => processApi.assertState(JSON.parse(fs.readFileSync(statePath)));
    const initial = readState();
    const failed = initial.items[f.members[0].paperId];
    assert.equal(failed.lastFailure.code, 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY');
    assert.equal(failed.lastFailure.category, 'integrity');
    assert.equal(failed.lastFailure.retryable, false);
    assert.equal(failed.lastFailure.systemic, false);
    assert.equal(initial.items[f.members[1].paperId].status, 'complete');
    assert.equal(initial.batchFailure == null, true);
    const originalFailure = structuredClone(failed.lastFailure);
    now += 20 * 60 * 1000;
    await processApi.runConferenceProcess(options, dependencies);
    assert.equal(analyzed.length, 2);
    assert.equal(readState().items[f.members[0].paperId].attempts, 1);
    assert.deepEqual(readState().items[f.members[0].paperId].lastFailure, originalFailure);
    assert.deepEqual(fs.readFileSync(receiptPath), beforeReceipt);
    await processApi.runConferenceProcess({ ...options, retryFailed: true }, dependencies);
    assert.equal(analyzed.length, 3);
    const explicitlyRetried = readState().items[f.members[0].paperId];
    assert.equal(explicitlyRetried.attempts, 2);
    assert.deepEqual(explicitlyRetried.retryReleases[0].previousFailure, originalFailure);
    assert.equal(explicitlyRetried.lastFailure.code, originalFailure.code);
    assert.equal(explicitlyRetried.lastFailure.retryable, false);
    assert.deepEqual(fs.readFileSync(receiptPath), beforeReceipt);
});

test('抽取凭证的稳定错误码优先于被引用的认证、网络及普通文字', () => {
    const recovery = require('../scripts/lib/conference-process-recovery.js');
    const extraction = require('../scripts/lib/conference-extraction-receipt.js');
    for (const message of ['字段无效', '引用中含 HTTP 401 proxy', '普通正文']) {
        const failure = recovery.classifyFailure(new extraction.ConferenceExtractionReceiptError(message),
            '2026-09-09T00:00:00.000Z');
        assert.equal(failure.category, 'integrity');
        assert.equal(failure.retryable, false);
        assert.equal(failure.systemic, false);
    }
    assert.equal(recovery.classifyFailure(new Error('HTTP 401 Unauthorized'),
        '2026-09-09T00:00:00.000Z').category, 'authentication');
    const network = recovery.classifyFailure(new Error('HTTP 503 upstream'), '2026-09-09T00:00:00.000Z');
    assert.equal(network.category, 'transport');
    assert.equal(network.systemic, true);
});

test('旧可重试的抽取凭证失败须显式授权，原失败记录保持原样', () => {
    const recovery = require('../scripts/lib/conference-process-recovery.js');
    const now = '2026-10-10T00:00:00.000Z';
    const item = { status: 'failed', attempts: 1,
        lastFailure: { code: 'CONFERENCE_EXTRACTION_RECEIPT_INTEGRITY', category: 'paper',
            retryable: true, systemic: false, message: 'Extraction receipt shape invalid' } };
    const before = structuredClone(item);
    assert.equal(recovery.eligible(item, now), false);
    assert.deepEqual(item, before);
    assert.equal(recovery.eligible({ ...item, retryAuthorizedAtAttempt: 0 }, now), false);
    assert.equal(recovery.eligible({ ...item, retryAuthorizedAtAttempt: 1 }, now), true);
    assert.equal(recovery.eligible({ ...item, attempts: 2, retryAuthorizedAtAttempt: 1 }, now), false);
    assert.equal(recovery.eligible({ ...item, retryAuthorizedAtAttempt: 1,
        retryNotBefore: '2026-10-10T00:15:00.000Z' }, now), false);
    assert.equal(recovery.eligible({ ...item, status: 'complete', retryAuthorizedAtAttempt: 1 }, now), false);
    assert.equal(recovery.eligible({ ...item, status: 'analyzing', retryAuthorizedAtAttempt: 1 }, now), false);
    assert.equal(recovery.eligible({ ...item, attempts: 3, retryAuthorizedAtAttempt: 3 }, now), false);
    const ordinary = { ...item, lastFailure: { ...item.lastFailure, code: 'REQUEST_SOCKET_TIMEOUT' } };
    assert.equal(recovery.eligible(ordinary, now), true);
    assert.equal(recovery.eligible({ ...ordinary,
        lastFailure: { ...ordinary.lastFailure, retryable: false } }, now), false);
});

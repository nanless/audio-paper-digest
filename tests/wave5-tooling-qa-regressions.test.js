'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('F-P0-2: workflow-implementation-files 不再因自扫字面量或角色表坍塌至全仓，且包含动态加载配置文件', () => {
    const { collectWorkflowImplementationFiles } = require('../scripts/lib/workflow-implementation-files');
    const leafClosure = collectWorkflowImplementationFiles({
        root: ROOT,
        entryFiles: ['scripts/lib/strict-json.js']
    });
    assert.deepEqual(leafClosure, [
        'scripts/lib/strict-json.js',
        'scripts/lib/workflow-implementation-files.js'
    ]);

    const envLoaderClosure = collectWorkflowImplementationFiles({
        root: ROOT,
        entryFiles: ['scripts/env-loader.js']
    });
    assert.equal(envLoaderClosure.includes('scripts/full-fetch.js'), false, 'env-loader 角色表不应把 full-fetch 拉入闭包');
    assert.equal(envLoaderClosure.includes('scripts/workspace-role.js'), true, 'env-loader 真实 require 必须保留');

    const rendererClosure = collectWorkflowImplementationFiles({
        root: ROOT,
        entryFiles: ['scripts/lib/paper-page-staging.js']
    });
    assert.equal(rendererClosure.includes('config/tag-display-policy.json'), true, '页面渲染闭包必须包含 tag-display-policy.json');
    assert.equal(rendererClosure.includes('config/publish-image-exclusions.json'), true, '页面渲染闭包必须包含 publish-image-exclusions.json');
    assert.equal(rendererClosure.includes('config/tag-catalog.json'), true, '页面渲染闭包必须包含 tag-catalog.json');

    const tagRulesClosure = collectWorkflowImplementationFiles({
        root: ROOT,
        entryFiles: ['scripts/lib/tag-rules.js']
    });
    assert.equal(tagRulesClosure.includes('config/tag-catalog.json'), true, 'tag-rules 闭包必须包含 tag-catalog.json');

    const replayClosure = collectWorkflowImplementationFiles({
        root: ROOT,
        entryFiles: ['scripts/publication_local_replay.py']
    });
    assert.equal(replayClosure.includes('scripts/publication_replay_policy.json'), true, 'publication_local_replay 闭包必须包含 publication_replay_policy.json');
});

test('F-P0-5: generate-client-protocols.py Kotlin 切块在合成 $ / """ / 边界引号下均合法且无损还原', () => {
    const py = [
        'import importlib.util, re',
        `spec = importlib.util.spec_from_file_location("gen", ${JSON.stringify(path.join(ROOT, 'apps/generate-client-protocols.py'))})`,
        'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
        'outputs = mod.rendered_sources()',
        'kt = [v for k, v in outputs.items() if str(k).endswith(".kt")][0]',
        'assert \'""""\' not in kt, "generated Kotlin must not contain 4 consecutive quotes"',
        'def unescape_kt_raw(chunk):',
        '    out = chunk.replace("${\'\\"\'}", \'"\').replace("${\'$\'}", "$")',
        '    return out',
        'samples = [',
        '    "a" * 7 + \'"\' + "b" * 7,',
        '    \'"\' * 25,',
        '    \'{"price":"$100","triple":"\\"\\"\\"","edge":"x\\"\\"\\"y"}\' * 3,',
        '    \'"""$foo${bar}""""""\',',
        ']',
        'for sample in samples:',
        '    chunks = mod.encode_kotlin_raw_string_chunks(sample, chunk_size=8)',
        '    assert chunks, "must emit at least one chunk"',
        '    for c in chunks:',
        '        literal = \'"""\' + c + \'"""\'',
        '        assert not c.startswith(\'"\'), f"chunk starts with quote: {c!r}"',
        '        assert not c.endswith(\'"\'), f"chunk ends with quote: {c!r}"',
        '        assert \'"""\' not in c, f"chunk contains triple quote: {c!r}"',
        '        assert \'""""\' not in literal, f"literal contains quadruple quote: {literal!r}"',
        '        stripped = c.replace("${\'$\'}", "").replace("${\'\\"\'}", "")',
        '        assert "$" not in stripped, f"raw dollar left unescaped: {c!r}"',
        '    assert "".join(unescape_kt_raw(c) for c in chunks) == sample, f"roundtrip mismatch for {sample!r}"',
        'print("OK")'
    ].join('\n');
    const res = spawnSync('bash', ['scripts/python-runtime.sh', '-c', py], {
        cwd: ROOT, encoding: 'utf8', timeout: 15000
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /OK/);
});

test('F-P1-11: table-check 对普通粘连/混合单元格/括号复写按 error 判错，仅完整版本令牌内降为 warn', () => {
    const tableCheck = require('../scripts/table-check');
    const mk = cell => `| 模型 | WER (%) |\n| --- | --- |\n| ${cell} | 7.3 |`;

    // 普通粘连、混合单元格、括号复写、带尾随字母粘连均必须判 error
    for (const cell of ['7.37.3', 'v1.21.2 (7.37.3)', 'v1.21.2 1.21.2', 'v(x)(x)', 'v1.21.2v1.21.2', 'v1.21.2v2.0', 'v7.37.3dB', 'v7.37.3ms', 'v1.21.2.3dB']) {
        const issues = tableCheck.checkText(mk(cell));
        assert.equal(issues.length, 1, `cell=${cell}`);
        assert.equal(issues[0].code, 'table-glued-duplicate', `cell=${cell}`);
        assert.equal(issues[0].severity, 'error', `cell=${cell} should be error`);
    }

    // 真实版本令牌（含多位小节、句末句号与常见分隔后缀）仅降为 warn
    for (const cell of ['Model v1.21.2', 'Model v1.21.20', 'Model v11.11.1', 'Model v1.21.2.3', 'Model v1.21.2-rc1', 'Model v1.21.2.', 'v1.21.2+build', 'v1.21.2/v2.0', 'v1.21.2模型']) {
        const issues = tableCheck.checkText(mk(cell));
        assert.equal(issues.length, 1, `cell=${cell}`);
        assert.equal(issues[0].code, 'table-glued-duplicate', `cell=${cell}`);
        assert.equal(issues[0].severity, 'warn', `cell=${cell} should be warn`);
    }
});

test('F-P2-12: error-codes 精准分类配置错误且不被泛泛“配置/未配置/config”劫持领域与推送错误', () => {
    const codes = require('../scripts/lib/error-codes');
    assert.equal(codes.classify('API key 认证失败，请检查配置').id, 'llm-account-pool');
    assert.equal(codes.classify('当前模型配置下出现表格单元格粘连复写').id, 'reader-table-adhesion');
    assert.equal(codes.classify('消融实验配置缺少对照').id, 'reader-table-ablation-missing');
    assert.equal(codes.classify('HTTP 429 Too Many Requests from arxiv config').id, 'arxiv-rate-limit');
    // blog-push-guard 必须优先于 config-invalid
    assert.equal(codes.classify('Hugo 渲染失败：站点主题未配置').id, 'blog-push-guard');
    assert.equal(codes.classify('推送门禁未通过：博客仓库远端未配置').id, 'blog-push-guard');
    assert.equal(codes.classify('Hugo preflight 检查失败：hugo.toml 配置错误').id, 'blog-push-guard');
    assert.equal(codes.classify('推送前 preflight 渲染失败：缺少样式配置').id, 'blog-push-guard');
    // 论文事实/审查语句里的普通“未配置”或“<前缀>模型未配置”以及论文域“训练/硬件/实验配置缺失/错误”不能误判为 config-invalid
    assert.equal(codes.classify('摘要声称基线未配置外部语言模型，原文未披露该细节').id, 'generic-fallback');
    assert.equal(codes.classify('摘要说明基线模型未配置外部词典，原文未提及').id, 'generic-fallback');
    assert.equal(codes.classify('实验节声称声学模型未配置语言模型解码').id, 'generic-fallback');
    assert.equal(codes.classify('实验部分缺少超参数配置细节').id, 'generic-fallback');
    assert.equal(codes.classify('论文训练配置不完整，原文未说明批大小').id, 'generic-fallback');
    assert.equal(codes.classify('实验硬件配置缺失，原文表2未披露 GPU 型号').id, 'generic-fallback');
    assert.equal(codes.classify('摘要中实验配置错误，原文写的是 16kHz 采样率').id, 'generic-fallback');
    // 真正的系统/环境配置错误（含真实生产中文 LLM_ACCOUNT_POOL_CONFIG_ERROR / OAI PROXY_CONFIG_ERROR 与前置“未配置 <ENV>”）仍命中 config-invalid
    assert.equal(codes.classify('缺少 PAPER_ANALYZER_API_KEY 环境变量').id, 'config-invalid');
    assert.equal(codes.classify('未配置 PAPER_ANALYZER_API_KEY，无法执行 博客审查').id, 'config-invalid');
    assert.equal(codes.classify('未配置 HTTPS_PROXY/HTTP_PROXY').id, 'config-invalid');
    assert.equal(codes.classify('PROXY_CONFIG_ERROR arXiv OAI 抓取必须通过 .env 配置 HTTP CONNECT 代理').id, 'config-invalid');
    assert.equal(codes.classify('MODEL_ENDPOINT_CONFIG_ERROR endpoint invalid').id, 'config-invalid');
    assert.equal(codes.classify('LLM_ACCOUNT_POOL_CONFIG_ERROR 同一 OpenCode Go 账号池内的 API key 不能相同或重复').id, 'config-invalid');
    assert.equal(codes.classify('LLM_ACCOUNT_POOL_CONFIG_ERROR OpenCode Go 账号池没有可用 API key').id, 'config-invalid');
    assert.equal(codes.classify('ENV_MISSING 缺少 .env').id, 'config-invalid');
    assert.equal(codes.classify('LLM_ACCOUNT_AUTH_ERROR 账号池认证失败').id, 'llm-account-pool');
    assert.equal(codes.classify('deep execution Responses config is invalid').id, 'config-invalid');
    assert.equal(codes.classify('missing project proxy for HuggingFace').id, 'config-invalid');
    assert.equal(codes.classify('博客审查 的 LLM endpoint 配置不安全: http://evil.invalid').id, 'config-invalid');
    assert.equal(codes.classify('invalid configuration: missing endpoint').id, 'config-invalid');
    assert.equal(codes.classify('PAPER_DIGEST_BLOG_REPO 未配置').id, 'config-invalid');
    assert.equal(codes.classify('HTTPS_PROXY 无效').id, 'config-invalid');
    assert.equal(codes.classify('配置文件损坏，无法解析 JSON').id, 'config-invalid');
    assert.equal(codes.classify('missing HTTPS_PROXY for arXiv').id, 'config-invalid');
    assert.equal(codes.classify('模型未配置').id, 'config-invalid');
    assert.equal(codes.classify('主模型未配置').id, 'config-invalid');
});

test('F-P2-13: manifest-new、daily-reader-operator-correction 与 reader-signed-operator 路径白名单严格按集合区分', async (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const manifest = require('../scripts/manifest-new');
    const correction = require('../scripts/lib/daily-reader-operator-correction');
    const repair = require('../scripts/lib/reader-repair');
    const codec = require('../scripts/lib/protocol-codec');
    const runner = require('../scripts/lib/fresh-rewrite-run');
    const Config = require('../scripts/config');
    const { fixture, sign } = require('./reader-signed-draft-fixture');
    const { reconstructReaderDraftFromVerifiedArticle } = require('../scripts/lib/reader-signed-draft');
    const { prepareReaderOperatorPatchResult } = require('../scripts/lib/reader-signed-operator');

    const draft = {
        readerTitle: 'T',
        oneSentenceThesis: 'S',
        sections: [{ heading: 'H', body: 'B' }],
        conceptBridges: [{ term: 'X', explanation: 'E' }],
        tableBindings: [{ tableId: 't1' }],
        formulaBindings: [{ formulaId: 'f1' }],
        figurePlacements: [{ ordinal: 1 }]
    };

    assert.doesNotThrow(() => manifest.validateSpec({
        paperId: '2611.12345',
        replacements: [{ path: '/sections/0/body', value: 'valid body' }]
    }));
    assert.doesNotThrow(() => manifest.validateSpec({
        paperId: '2611.12345',
        replacements: [{ path: '/conceptBridges/0/explanation', value: 'valid explanation' }]
    }));
    assert.throws(() => manifest.validateSpec({
        paperId: '2611.12345',
        replacements: [{ path: '/tableBindings/0/body', value: 'bad' }]
    }), /not allowed/);
    assert.throws(() => manifest.validateSpec({
        paperId: '2611.12345',
        replacements: [{ path: '/sections/0/explanation', value: 'bad' }]
    }), /not allowed/);

    // nodeAt 也必须按集合拒绝非法叶子路径
    assert.equal(manifest.nodeAt(draft, '/sections/0/body'), 'B');
    assert.equal(manifest.nodeAt(draft, '/conceptBridges/0/explanation'), 'E');
    assert.throws(() => manifest.nodeAt(draft, '/sections/0/explanation'), /不支持的节点路径/);
    assert.throws(() => manifest.nodeAt(draft, '/tableBindings/0/body'), /不支持的节点路径/);
    assert.throws(() => manifest.nodeAt(draft, '/conceptBridges/0/body'), /不支持的节点路径/);
    assert.throws(() => manifest.nodeAt(draft, '/figurePlacements/0/explanation'), /不支持的节点路径/);

    // 真实调用 daily-reader-operator-correction.replay 与 reader-signed-operator.prepareReaderOperatorPatchResult
    const f = fixture({
        noFigures: true,
        sourceText: 'The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(100)
    });
    f.paper.title = 'Signed operator controlled source';
    f.paper.abstract = 'Original metadata for the controlled source.';
    Object.assign(f.sourceDetails, { source: 'html', sourceId: f.paper.arxivId });
    const { freshSourceDescriptor, ...snapshot } = f.sourceDetails;
    freshSourceDescriptor.sourceSnapshotSha256 = runner.sha256(JSON.stringify(snapshot));
    f.paper.freshRewriteProvenance.sourceSnapshotSha256 = freshSourceDescriptor.sourceSnapshotSha256;
    f.paper.analysisManifest.freshRewriteProvenance = structuredClone(f.paper.freshRewriteProvenance);
    sign(f.paper);
    const inverse = reconstructReaderDraftFromVerifiedArticle(f);

    // 1) daily-reader-operator-correction.replay：/conceptBridges/0/explanation 通过，跨集合叶子被拒
    const validDraft = structuredClone(inverse.draft);
    if (!Array.isArray(validDraft.conceptBridges) || !validDraft.conceptBridges.length) {
        validDraft.conceptBridges = [{ term: '术语甲', explanation: '原始解释文本。' }];
    }
    const candidate = { identity: { paperId: f.paper.arxivId, runId: f.runId }, payload: { draft: validDraft } };
    const baseHeader = codec.recordHeader('reader-human-source-edit', 'reader-human-source-edit');
    const baseFile = `${repair.hashDraft(candidate.identity)}.json`;
    const baseSha = repair.hashDraft(validDraft);
    const updatedBridgeDraft = structuredClone(validDraft);
    updatedBridgeDraft.conceptBridges[0].explanation = `${validDraft.conceptBridges[0].explanation} 补充核验说明。`;
    const goodRecord = {
        ...baseHeader,
        notLlmResponse: true,
        baselineCandidateFile: baseFile,
        baselineDraftSha256: baseSha,
        draft: updatedBridgeDraft,
        patch: {
            version: 1,
            draftSha256: baseSha,
            replacements: [{
                path: '/conceptBridges/0/explanation',
                oldSha256: repair.hashDraft(validDraft.conceptBridges[0].explanation),
                value: updatedBridgeDraft.conceptBridges[0].explanation
            }]
        }
    };
    assert.deepEqual(correction.replay(goodRecord, candidate), updatedBridgeDraft);
    for (const badPath of ['/sections/0/explanation', '/conceptBridges/0/body', '/tableBindings/0/body']) {
        const badRecord = {
            ...goodRecord,
            patch: { version: 1, draftSha256: baseSha, replacements: [{ path: badPath, oldSha256: baseSha, value: 'bad' }] }
        };
        assert.throws(() => correction.replay(badRecord, candidate), /unauthorized node/, `replay must reject ${badPath}`);
    }

    // 2) reader-signed-operator.prepareReaderOperatorPatchResult：跨集合叶子路径被拒
    const rootDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wave5-signed-op-'));
    const prevRoot = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = rootDir;
    t.after(() => { Config.FILES.freshRewriteRunsDir = prevRoot; fs.rmSync(rootDir, { recursive: true, force: true }); });
    const runDir = path.join(rootDir, f.runId);
    fs.mkdirSync(path.join(runDir, 'sources', f.paper.arxivId), { recursive: true, mode: 0o700 });
    const inputs = { contract: runner.INPUT_CONTRACT, runId: f.runId, date: '2026-09-06', papers: [runner.metadataOnly(f.paper)] };
    const inputBytes = JSON.stringify(inputs);
    const run = {
        version: 1, contract: runner.RUN_CONTRACT, date: inputs.date, runId: f.runId, status: 'complete',
        inputsSha256: runner.sha256(inputBytes), paperIds: [f.paper.arxivId],
        paperSetSha256: runner.stableHash([f.paper.arxivId]),
        sourceExpectations: {
            [f.paper.arxivId]: {
                sourceSha256: f.paper.sourceSha256,
                structuredArtifactsSha256: f.sourceDetails.structuredArtifacts.payloadSha256
            }
        }
    };
    run.identitySha256 = runner.stableHash({
        version: run.version, contract: run.contract, runId: run.runId, date: run.date,
        paperIds: run.paperIds, paperSetSha256: run.paperSetSha256, inputsSha256: run.inputsSha256,
        baseline: run.baseline, sourceExpectations: run.sourceExpectations, metadataSources: run.metadataSources
    });
    const analysis = {
        contract: runner.ANALYSIS_CONTRACT, runId: f.runId, batchDate: run.date,
        status: 'complete', generation: 1, papers: [f.paper]
    };
    const { freshSourceDescriptor: srcDesc, ...srcSnapshot } = f.sourceDetails;
    fs.writeFileSync(path.join(runDir, 'analysis.json'), JSON.stringify(analysis), { mode: 0o600 });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run), { mode: 0o600 });
    fs.writeFileSync(path.join(runDir, 'inputs.json'), inputBytes, { mode: 0o600 });
    const sourceDir = path.join(runDir, 'sources', f.paper.arxivId);
    for (const [filename, bytes] of Object.entries({
        'source.json': JSON.stringify(srcDesc),
        'source-details.json': JSON.stringify(srcSnapshot),
        'source.txt': srcSnapshot.text,
        'artifacts.json': JSON.stringify(srcSnapshot.structuredArtifacts)
    })) {
        fs.writeFileSync(path.join(sourceDir, filename), bytes, { mode: 0o600 });
    }

    const makeSignedReq = (badPath) => ({
        version: 1, runId: f.runId, paperId: f.paper.arxivId,
        parentPaperSha256: runner.stableHash(f.paper),
        parentArticleSha256: f.paper.apiReaderArticleSha256,
        parentPlanSha256: f.paper.apiReaderPlanSha256,
        sourceSha256: f.paper.sourceSha256,
        reason: '测试非法路径拦截。',
        patch: {
            version: 1, draftSha256: inverse.proof.draftSha256,
            replacements: [{ path: badPath, oldSha256: repair.hashDraft(inverse.draft.sections[0].body), value: 'x' }]
        }
    });
    for (const badPath of ['/sections/0/explanation', '/tableBindings/0/body', '/conceptBridges/0/body']) {
        await assert.rejects(
            () => prepareReaderOperatorPatchResult({
                parent: f.paper, sourceDetails: f.sourceDetails, run,
                request: makeSignedReq(badPath), patchFileSha256: 'c'.repeat(64), appliedAt: '2026-09-06T00:00:00.000Z'
            }),
            /unknown or unauthorized target/,
            `reader-signed-operator must reject ${badPath}`
        );
    }
    // Positive path: /conceptBridges/0/explanation must succeed end-to-end through prepareReaderOperatorPatchResult
    const updatedExplanation = `${inverse.draft.conceptBridges[0].explanation}补充按原文协议约束解释边界。`;
    const goodSignedRes = await prepareReaderOperatorPatchResult({
        parent: f.paper, sourceDetails: f.sourceDetails, run,
        request: {
            version: 1, runId: f.runId, paperId: f.paper.arxivId,
            parentPaperSha256: runner.stableHash(f.paper),
            parentArticleSha256: f.paper.apiReaderArticleSha256,
            parentPlanSha256: f.paper.apiReaderPlanSha256,
            sourceSha256: f.paper.sourceSha256,
            reason: '验证 conceptBridges/0/explanation 正向路径。',
            patch: {
                version: 1, draftSha256: inverse.proof.draftSha256,
                replacements: [{
                    path: '/conceptBridges/0/explanation',
                    oldSha256: repair.hashDraft(inverse.draft.conceptBridges[0].explanation),
                    value: updatedExplanation
                }]
            }
        },
        patchFileSha256: 'd'.repeat(64),
        appliedAt: '2026-09-06T00:00:00.000Z'
    });
    assert.ok(goodSignedRes.paper.apiReaderArticle.includes(updatedExplanation));
});

test('F-P2-15: source-probe / llm-accounts-report / review-overrides-cli 严格拒绝非法参数、支持 --help/-h 优先与退出码 2', () => {
    const sourceProbe = require('../scripts/source-probe');
    assert.throws(() => sourceProbe.parseArgs(['--date', '2026-02-30']), /日历日期/);
    assert.throws(() => sourceProbe.parseArgs(['--date', '--json']), /缺少/);
    assert.throws(() => sourceProbe.parseArgs(['--timeout-ms', 'abc']), /正整数/);
    assert.throws(() => sourceProbe.parseArgs(['--timeout-ms', '0']), /正整数/);
    assert.throws(() => sourceProbe.parseArgs(['--timeout-ms', '99999999999999999999']), /正整数/);
    assert.throws(() => sourceProbe.parseArgs(['--timeout-ms', '2147483648']), /正整数/);
    assert.equal(sourceProbe.parseArgs(['--timeout-ms', '2147483647']).timeoutMs, 2147483647);
    assert.equal(sourceProbe.parseArgs(['--bad-flag', '--help']).help, true);
    assert.equal(sourceProbe.parseArgs(['-h']).help, true);

    const llmAccounts = require('../scripts/llm-accounts-report');
    assert.throws(() => llmAccounts.main(['--unknown-flag']), /未知参数/);
    assert.throws(() => llmAccounts.main(['--state']), /缺少文件路径/);
    assert.throws(() => llmAccounts.main(['--state', '--json']), /缺少文件路径/);
    assert.equal(llmAccounts.main(['--unknown-flag', '--help']), 0);
    assert.equal(llmAccounts.main(['-h']), 0);
    const report = llmAccounts.describeConfigured({
        PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1',
        PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
        PAPER_ANALYZER_API_KEY: 'sk-pri-1',
        PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://opencode.ai/zen/go/v1',
        PAPER_ANALYZER_SECONDARY_MODEL: 'mimo-v2.6-flash',
        PAPER_ANALYZER_SECONDARY_API_KEY: 'sk-sec-primary-1',
        PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS: 'sk-sec-fallback-2',
        PAPER_ANALYZER_SECONDARY_TERTIARY_FALLBACK_API_KEY: 'sk-sec-tertiary-3'
    }, null, Date.now());
    const secondaryRoute = report.configured.routes.find(r => r.role === 'secondary');
    assert.equal(secondaryRoute.accountCount, 3, 'secondary route must include tertiary fallback key');

    const cliRes = spawnSync('node', [path.join(ROOT, 'scripts/llm-accounts-report.js'), '--unknown-flag'], {
        cwd: ROOT, encoding: 'utf8', timeout: 10000
    });
    assert.equal(cliRes.status, 2, 'llm-accounts-report CLI 参数错误应返回退出码 2');

    const reviewOverrides = require('../scripts/review-overrides-cli');
    assert.throws(() => reviewOverrides.main(['--date', '2026-02-30', '--file', 'a.json']), /日历日期/);
    assert.throws(() => reviewOverrides.main(['--date', '--file', 'a.json']), /缺少非空参数值/);
    assert.throws(() => reviewOverrides.main(['--date', '2026-11-20', '--file']), /缺少非空参数值/);
    assert.equal(reviewOverrides.main(['-h']), 0);
    assert.equal(reviewOverrides.main(['--unknown', '-h']), 0);
});

test('F-P3-17: recover.plan/render/main 保留多错误码与布尔 retryable，docs-consistency 覆盖 manual/README.en.md，impact 覆盖 tests/helpers 的 JS 与 Python', () => {
    const recover = require('../scripts/recover');
    const groups = recover.plan([
        { command: 'npm run table:check -- --draft a.json', code: 'reader-table-adhesion', label: '表格单元格粘连复写', retryable: undefined, message: 'a' },
        { command: 'npm run table:check -- --draft a.json', code: 'reader-table-header-units', label: '表头单位缺少来源证据', retryable: true, message: 'b' }
    ]);
    assert.equal(groups.length, 1);
    assert.strictEqual(groups[0].retryable, false, 'retryable 必须严格归约为布尔值');
    assert.deepEqual(groups[0].codes, ['reader-table-adhesion', 'reader-table-header-units']);
    assert.deepEqual(groups[0].labels, ['表格单元格粘连复写', '表头单位缺少来源证据']);
    const rendered = recover.render('2026-11-20', groups[0].items, groups);
    assert.match(rendered, /reader-table-adhesion, reader-table-header-units/);

    // recover.main 执行分支日志必须完整展示 group.codes（多错误码）
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let exitCode;
    try {
        exitCode = recover.main(['--date', '2026-11-20', '--execute', '--yes'], {
            readFile: filePath => {
                if (filePath.endsWith('deep-analysis-result.json')) {
                    return JSON.stringify({
                        batchDate: '2026-11-20',
                        papers: [
                            { arxivId: '2611.00001', latestAnalysisAttemptError: 'Reader 同组问题无进展 (no progress)' },
                            { arxivId: '2611.00002', latestAnalysisAttemptError: '缺少消融实验对照 (ablation)' }
                        ]
                    });
                }
                if (filePath.endsWith('blog-review-failure-2026-11-20.json')) {
                    return JSON.stringify({ date: '2026-11-20', files: [], issues: [] });
                }
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            },
            spawnSync: () => ({ status: 0 })
        });
    } finally {
        console.log = origLog;
    }
    assert.equal(exitCode, 0);
    assert.ok(
        logs.some(line => line.includes('来自 reader-repair-no-progress, reader-table-ablation-missing')),
        `recover.main 应输出完整多错误码列表，实际日志：\n${logs.join('\n')}`
    );

    const docs = require('../scripts/docs-consistency');
    const files = docs.markdownFiles();
    for (const required of ['SKILL.md', 'scripts/README.en.md', 'manual/README.md', 'manual/README.en.md']) {
        assert.equal(files.includes(required), true, `docs-consistency 必须覆盖 ${required}`);
    }

    const impact = require('../scripts/impact');
    const graph = impact.buildDependencyGraph({ fresh: true });
    assert.equal(graph.files.has('tests/helpers/synthetic-legacy-reader-allowance.js'), true, 'impact 必须扫描 tests/helpers/ JS 文件');
    assert.equal(graph.files.has('tests/helpers/historical_page_scan_original_fixture.py'), true, 'impact 必须扫描 tests/helpers/ Python 文件');
    assert.equal(
        graph.reverse.get('tests/helpers/historical_page_scan_original_fixture.py')?.has('tests/python/test_historical_page_scan.py'),
        true,
        'impact 必须建立 tests/helpers/*.py 到 tests/python 的反向依赖边'
    );
});

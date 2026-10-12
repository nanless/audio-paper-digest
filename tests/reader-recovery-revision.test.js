const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');
const { withFreshAnalysisContext } = require('../scripts/lib/fresh-analysis-context.js');
const { loadReaderRecoveryRevision } = require('../scripts/lib/reader-recovery-revision.js');
const { saveFailedCandidate, loadFailedCandidate, hashDraft,
    TABLE_COUNT_ISSUE_CODE, collectDraftIssues } = require('../scripts/lib/reader-repair.js');
const { READER_SECTION_KINDS, normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order.js');
const directContext = require('../scripts/lib/direct-rewrite-analysis-context.js');
const conferenceContext = require('../scripts/lib/conference-analysis-context.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-revision-'));
    const previous = Config.FILES.freshRewriteRunsDir; Config.FILES.freshRewriteRunsDir = root;
    t.after(() => { Config.FILES.freshRewriteRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const runId = crypto.randomUUID(), runDir = path.join(root, runId), paperId = '2609.99971';
    fs.mkdirSync(runDir, { mode: 0o700 });
    const sourceExpectations = { [paperId]: { sourceSha256: 'a'.repeat(64), structuredArtifactsSha256: 'b'.repeat(64) } };
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ version: 1, contract: 'fresh-rewrite-run-v1',
        runId, paperIds: [paperId], sourceExpectations }), { mode: 0o600 });
    const context = { runId, runDir, sourceExpectations, refreshReaderDiagnostics: true };
    const directory = path.join(runDir, 'reader-attempts');
    const oldIdentity = { paperId, freshAnalysis: { runId, paperId, ...sourceExpectations[paperId] },
        sourceSha256: 'a'.repeat(64), inputFingerprint: 'same input', model: { model: 'test-model', maxTokens: 48000 },
        promptSha256: 'p', repairPromptSha256: 'q', maxAttempts: 6, repairMaxTokens: 8000,
        repairImplementationSha256: 'c'.repeat(64) };
    const identity = { ...oldIdentity, repairImplementationSha256: 'd'.repeat(64),
        draftOrderContract: 'reader-draft-order-v1', draftOrderImplementationSha256: 'e'.repeat(64),
        sourceDiagnosticsImplementationSha256: 'f'.repeat(64),
        parserImplementationSha256: '1'.repeat(64), editorialImplementationSha256: '2'.repeat(64),
        mechanicalContractSha256: '3'.repeat(64) };
    const draft = { version: 3, readerTitle: '只读恢复测试正文', oneSentenceThesis: '保持所有来源和调用预算不变。',
        sections: READER_SECTION_KINDS.map(kind => ({ kind, heading: kind, body: kind.repeat(130) })),
        conceptBridges: Array.from({ length: 4 }, () => ({})), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    [draft.sections[6], draft.sections[7]] = [draft.sections[7], draft.sections[6]];
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft),
        issues: [{ path: null, message: 'old diagnostic' }], attempts: 4, fullAttempts: 1,
        transportFailures: 2, noProgress: 2, failureSignature: 'old failure',
        validationFailureStreak: 2, validationFailureSignature: 'old normalized failure', imageEvidence: [] };
    return { root, context, directory, oldIdentity, identity, payload,
        enabled: fn => withFreshAnalysisContext(context, fn) };
}

function ambiguousLegacyFixture(t) {
    const f = fixture(t);
    f.oldIdentity = { ...f.identity, repairImplementationSha256: 'c'.repeat(64) };
    const table = '| 比较项 | 指标 |\n| --- | --- |\n| 方法甲 | 10 |\n| 方法乙 | 20 |';
    f.payload.draft.sections[6].body += `\n\n${table}\n\n${table}`;
    let actualError;
    try { normalizeReaderDraftOrder(f.payload.draft); } catch (error) { actualError = error; }
    assert.equal(actualError.code, 'READER_DRAFT_ORDER_AMBIGUOUS');
    assert.deepEqual(actualError.readerIssues.map(issue => issue.path), ['/sections/6/body', '/sections/6/body']);
    const oldMessage = 'Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格';
    const actualIssues = collectDraftIssues(f.payload.draft, actualError);
    f.payload.issues = [{ path: null, message: oldMessage },
        ...actualError.readerIssues.map(issue => ({ path: issue.path, message: oldMessage })),
        ...actualIssues.slice(1 + actualError.readerIssues.length)];
    f.payload.rawDraft = JSON.stringify(f.payload.draft);
    f.payload.draftOrderMappings = [];
    return f;
}

test('真实表格歧义的旧失败仍以失败状态迁移，原草稿、归档和已付费计数保持', t => {
    const f = ambiguousLegacyFixture(t);
    const oldDraft = structuredClone(f.payload.draft);
    const filename = saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const originalBytes = fs.readFileSync(filename);
    const envelope = JSON.parse(originalBytes);
    assert.equal(envelope.payloadSha256, hashDraft(f.payload));
    assert.deepEqual(loadFailedCandidate(f.directory, f.oldIdentity), f.payload);
    const pixels = { pixelEvidenceSha256: hashDraft(f.payload.imageEvidence) };
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity, pixels));
    assert.equal(migrated.status, 'failed');
    assert.deepEqual(migrated.draft, oldDraft);
    assert.equal(migrated.rawDraft, f.payload.rawDraft);
    assert.deepEqual(migrated.draftOrderMappings, []);
    assert.deepEqual(migrated.issues, f.payload.issues);
    assert.deepEqual(migrated.imageEvidence, f.payload.imageEvidence);
    for (const key of ['attempts', 'fullAttempts', 'transportFailures']) {
        assert.equal(migrated[key], f.payload[key]);
    }
    const audit = migrated.readerRecoveryRevisions[0];
    assert.deepEqual(audit.changedFields, ['repairImplementationSha256']);
    assert.equal(audit.inputDraftSha256, hashDraft(oldDraft));
    assert.equal(audit.outputDraftSha256, hashDraft(oldDraft));
    assert.equal(audit.oldPayloadSha256, envelope.payloadSha256);
    assert.equal(audit.oldEnvelopeSha256, crypto.createHash('sha256').update(originalBytes).digest('hex'));
    assert.deepEqual(fs.readFileSync(path.join(f.directory, audit.archivedName)), originalBytes);
    assert.equal(fs.statSync(path.join(f.directory, audit.archivedName)).mode & 0o777, 0o600);
    const names = fs.readdirSync(f.directory);
    assert.deepEqual(f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity, pixels)), migrated);
    assert.deepEqual(fs.readdirSync(f.directory), names);
    assert.match(migrated.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    const consumedProof = migrated.implementationRepairAllowanceProof;
    saveFailedCandidate(f.directory, f.identity, {
        ...migrated, attempts: migrated.attempts + 1, implementationRepairAllowanceProof: null
    });
    const nextIdentity = { ...f.identity, repairImplementationSha256: '9'.repeat(64) };
    const next = f.enabled(() => loadReaderRecoveryRevision(f.directory, nextIdentity, pixels));
    assert.equal(next.attempts, f.payload.attempts + 1);
    assert.equal(next.fullAttempts, f.payload.fullAttempts);
    assert.equal(next.transportFailures, f.payload.transportFailures);
    assert.equal(next.implementationRepairAllowanceProof, null);
    assert.ok(next.consumedImplementationAllowanceSha256.includes(consumedProof.allowanceSha256));
    assert.deepEqual(next.draft, oldDraft);
    assert.equal(next.rawDraft, f.payload.rawDraft);
    assert.deepEqual(next.draftOrderMappings, []);
});

test('表格排序说明不参与数词规范化，独立真实数词诊断仍按原规则处理', async t => {
    const code = 'reader_table_binding_order_ambiguous';
    const message = 'quantitative_chinese_numeral:两阶段 tableBindings source-binding v4';
    const cases = [
        ['合法诊断', { path: null, code, message }],
        ['参考诊断', { path: null, code, message, diagnosticOnly: true }],
        ['直接 typed 的无效路径拒读', { path: '/sections/01/body', code, message }, true],
        ['失效顶层证据', { path: null, code: 'READER_DRAFT_ORDER_AMBIGUOUS', message,
            readerIssues: [{ path: '/sections/0/body', code, message }] }]
    ];
    for (const [name, issue, refuseLoad = false] of cases) {
        await t.test(name, tt => {
            const f = fixture(tt);
            f.payload.draft.sections[0].body = '训练采用两阶段流程，另有三阶段对照。';
            f.payload.draft.conceptBridges[0] = { explanation: '两阶段流程连接三阶段对照。' };
            f.payload.issues = [issue,
                { path: null, message: '读者文章文风校验失败: quantitative_chinese_numeral:三阶段' }];
            f.payload.rawDraft = JSON.stringify(f.payload.draft);
            const filename = saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
            const bytes = fs.readFileSync(filename);
            if (refuseLoad) {
                const names = fs.readdirSync(f.directory);
                assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)),
                    /Reader candidate refused/);
                assert.deepEqual(fs.readFileSync(filename), bytes);
                assert.deepEqual(fs.readdirSync(f.directory), names);
                assert.equal(fs.existsSync(path.join(f.directory, `${hashDraft(f.identity)}.json`)), false);
                return;
            }
            const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
            assert.equal(migrated.draft.sections[0].body, '训练采用两阶段流程，另有 3 个阶段对照。');
            assert.equal(migrated.draft.conceptBridges[0].explanation, '两阶段流程连接 3 个阶段对照。');
            assert.deepEqual(migrated.issues, f.payload.issues);
            for (const key of ['attempts', 'fullAttempts', 'transportFailures']) {
                assert.equal(migrated[key], f.payload[key]);
            }
            const archive = migrated.readerRecoveryRevisions[0].archivedName;
            assert.deepEqual(fs.readFileSync(path.join(f.directory, archive)), bytes);
        });
    }
});

test('仅捕获严格合法排序异常，依赖注入的其他错误或坏子项原样抛出且不安装文件', async t => {
    const code = 'reader_table_binding_order_ambiguous';
    const message = 'tableBindings source-binding v4';
    const cases = [
        ['其他代码', Object.assign(new Error(message), { code: 'SOURCE_BINDING_FAILED' })],
        ['缺子项', Object.assign(new Error(message), { code: 'READER_DRAFT_ORDER_AMBIGUOUS' })],
        ['非法路径', Object.assign(new Error(message), { code: 'READER_DRAFT_ORDER_AMBIGUOUS',
            readerIssues: [{ path: '/sections/01/body', code, message }] })],
        ['未知子项代码', Object.assign(new Error(message), { code: 'READER_DRAFT_ORDER_AMBIGUOUS',
            readerIssues: [{ path: '/sections/0/body', code: 'other', message }] })],
        ['参考子项', Object.assign(new Error(message), { code: 'READER_DRAFT_ORDER_AMBIGUOUS',
            readerIssues: [{ path: '/sections/0/body', code, message, diagnosticOnly: true }] })],
        ['不同说明', Object.assign(new Error(message), { code: 'READER_DRAFT_ORDER_AMBIGUOUS',
            readerIssues: [{ path: '/sections/0/body', code, message: '不同说明' }] })],
        ['顶层参考', Object.assign(new Error(message), { code: 'READER_DRAFT_ORDER_AMBIGUOUS', diagnosticOnly: true,
            readerIssues: [{ path: '/sections/0/body', code, message }] })],
        ['顶层参考坏类型', Object.assign(new Error(message), { code: 'READER_DRAFT_ORDER_AMBIGUOUS', diagnosticOnly: 'true',
            readerIssues: [{ path: '/sections/0/body', code, message }] })]
    ];
    for (const [name, injectedError] of cases) {
        await t.test(name, tt => {
            const f = fixture(tt);
            const filename = saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
            const bytes = fs.readFileSync(filename);
            const names = fs.readdirSync(f.directory);
            const draftOrder = require('../scripts/lib/reader-draft-order.js');
            const revisionPath = require.resolve('../scripts/lib/reader-recovery-revision.js');
            const originalModule = require.cache[revisionPath];
            const originalNormalize = draftOrder.normalizeReaderDraftOrder;
            let called = 0;
            try {
                draftOrder.normalizeReaderDraftOrder = () => { called += 1; throw injectedError; };
                delete require.cache[revisionPath];
                const injectedRevision = require(revisionPath);
                assert.throws(() => f.enabled(() => injectedRevision.loadReaderRecoveryRevision(f.directory, f.identity)),
                    error => error === injectedError);
                assert.equal(called, 1);
            } finally {
                draftOrder.normalizeReaderDraftOrder = originalNormalize;
                require.cache[revisionPath] = originalModule;
            }
            assert.deepEqual(fs.readFileSync(filename), bytes);
            assert.deepEqual(fs.readdirSync(f.directory), names);
            assert.equal(loadFailedCandidate(f.directory, f.identity), null);
            assert.deepEqual(loadFailedCandidate(f.directory, f.oldIdentity), f.payload);
        });
    }
});

test('显式的同一次运行修订保留已付费额度、记录映射、归档证据，并且幂等', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    for (const key of ['attempts', 'fullAttempts', 'transportFailures']) assert.equal(migrated[key], f.payload[key]);
    assert.equal(migrated.noProgress, 0); assert.equal(migrated.failureSignature, '');
    assert.equal(migrated.validationFailureStreak, 0); assert.equal(migrated.validationFailureSignature, '');
    assert.match(migrated.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(migrated.draft, normalizeReaderDraftOrder(f.payload.draft).draft);
    assert.equal(migrated.draftOrderMappings.length, 1);
    assert.equal(migrated.readerRecoveryRevisions[0].oldNoProgress, 2);
    assert.equal(migrated.status, 'failed');
    const names = fs.readdirSync(f.directory);
    assert.equal(names.length, 2);
    const archive = names.find(name => name.includes('.migrated-'));
    assert.ok(archive);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, archive))).payload, f.payload);
    assert.equal(fs.statSync(path.join(f.directory, archive)).mode & 0o777, 0o600);
    assert.equal(loadFailedCandidate(f.directory, f.oldIdentity), null);
    assert.deepEqual(f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), migrated);
    assert.deepEqual(fs.readdirSync(f.directory), names);
});

test('诊断迁移只删除已证实的段末悬空连接词', t => {
    const f = fixture(t);
    const dangling = '模型在 2 个数据集上有一定鲁棒性，但';
    const complete = '模型虽然下降，但回落更平缓，但未测试关系型提示。';
    f.payload.draft.sections[0].body = `${f.payload.draft.sections[0].body}\n\n${dangling}`;
    f.payload.draft.sections[1].body = `${f.payload.draft.sections[1].body}\n\n${complete}`;
    f.payload.rawDraft = JSON.stringify(f.payload.draft);
    saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.ok(migrated.draft.sections[0].body.endsWith('模型在 2 个数据集上有一定鲁棒性。'));
    assert.ok(migrated.draft.sections[1].body.endsWith(complete));
    assert.equal(migrated.draft.sections[0].body.includes(dangling), false);
    assert.equal(migrated.readerRecoveryRevisions.at(-1).inputDraftSha256,
        hashDraft(f.payload.draft));
    assert.equal(migrated.readerRecoveryRevisions.at(-1).outputDraftSha256,
        hashDraft(migrated.draft));
});

test('诊断迁移只归一化普通正文里与问题绑定的阶段数', t => {
    const f = fixture(t);
    const protectedText = '`三阶段`、“三阶段”、$三阶段$、[[CONCEPT_BRIDGE_3]]';
    f.payload.draft.sections[0].body = `训练采用三阶段课程。\n\n${protectedText}`;
    f.payload.draft.sections[1].body = '未命中 issue 的两阶段流程保持原样。';
    f.payload.draft.conceptBridges[0] = { explanation: '课程学习连接三阶段数据。' };
    f.payload.issues = [{ path: null,
        message: '读者文章文风校验失败: quantitative_chinese_numeral:三阶段' }];
    f.payload.rawDraft = JSON.stringify(f.payload.draft);
    saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(migrated.draft.sections[0].body,
        `训练采用 3 个阶段课程。\n\n${protectedText}`);
    assert.equal(migrated.draft.sections[1].body, '未命中 issue 的两阶段流程保持原样。');
    assert.equal(migrated.draft.conceptBridges[0].explanation,
        '课程学习连接 3 个阶段数据。');
    assert.notEqual(migrated.readerRecoveryRevisions.at(-1).inputDraftSha256,
        migrated.readerRecoveryRevisions.at(-1).outputDraftSha256);
});

test('普通调用和未启用的全新范围都不扫描也不迁移旧候选', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    assert.equal(loadReaderRecoveryRevision(f.directory, f.identity), null);
    assert.equal(withFreshAnalysisContext({ ...f.context, refreshReaderDiagnostics: false }, () =>
        loadReaderRecoveryRevision(f.directory, f.identity)), null);
    assert.equal(fs.readdirSync(f.directory).length, 1);
});

test('诊断迁移不能用带码的表格计数正文改写数字表面', t => {
    const f = fixture(t);
    f.payload.draft.sections[0].body = '训练采用两阶段流程，另有三阶段对照。';
    f.payload.draft.conceptBridges[0] = { explanation: '两阶段流程连接三阶段对照。' };
    f.payload.issues = [{ path: null, code: TABLE_COUNT_ISSUE_CODE,
        requiredCount: 4, actualCount: 3, message: 'quantitative_chinese_numeral:两阶段' },
    { path: null, message: '读者文章文风校验失败: quantitative_chinese_numeral:三阶段' }];
    f.payload.rawDraft = JSON.stringify(f.payload.draft);
    const filename = saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const bytes = fs.readFileSync(filename);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(migrated.draft.sections[0].body, '训练采用两阶段流程，另有 3 个阶段对照。');
    assert.equal(migrated.draft.conceptBridges[0].explanation, '两阶段流程连接 3 个阶段对照。');
    assert.deepEqual(migrated.issues, f.payload.issues);
    const archive = fs.readdirSync(f.directory).find(name => name.includes('.migrated-'));
    assert.deepEqual(fs.readFileSync(path.join(f.directory, archive)), bytes);
    for (const key of ['attempts', 'fullAttempts', 'transportFailures']) {
        assert.equal(migrated[key], f.payload[key]);
    }
});

test('未启用的全新范围优先于日更分析使用的嵌套直接来源上下文', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const sourceDetails = { paperId: `arxiv:${f.identity.paperId}`, source: 'html',
        sourceId: f.identity.paperId, text: 'sealed daily source',
        structuredArtifacts: { payloadSha256: f.context.sourceExpectations[f.identity.paperId].structuredArtifactsSha256 } };
    const loaded = withFreshAnalysisContext({ ...f.context, refreshReaderDiagnostics: false }, () =>
        directContext.withDirectRewriteAnalysisSource({ paperId: `arxiv:${f.identity.paperId}`,
            runId: f.context.runId, route: 'arxiv-fresh-fetch', sourceDetails,
            sourceSha256: crypto.createHash('sha256').update(sourceDetails.text).digest('hex'),
            structuredArtifactsSha256: sourceDetails.structuredArtifacts.payloadSha256,
            sourceSnapshotSha256: 'c'.repeat(64), sourceGeneration: 1,
            sourceManifestSha256: 'd'.repeat(64), readerAttemptsDir: f.directory },
        () => loadReaderRecoveryRevision(f.directory, f.identity)));
    assert.equal(loaded, null);
    assert.equal(fs.readdirSync(f.directory).length, 1);
});

test('来源、运行身份、提示词、输入指纹或请求额度变化时，不能复用旧候选', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    for (const mutate of [id => { id.model.maxTokens = 24000; }, id => { id.maxAttempts = 5; },
        id => { id.repairMaxTokens = 16000; }, id => { id.promptSha256 = 'new prompt'; },
        id => { id.repairPromptSha256 = 'new repair prompt'; }, id => { id.inputFingerprint = 'new input'; }]) {
        const identity = structuredClone(f.identity); mutate(identity);
        assert.equal(f.enabled(() => loadReaderRecoveryRevision(f.directory, identity)), null);
    }
    for (const mutate of [id => { id.sourceSha256 = '0'.repeat(64); }, id => { id.freshAnalysis.runId = crypto.randomUUID(); }]) {
        const identity = structuredClone(f.identity); mutate(identity);
        assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, identity)), /scope/);
    }
    assert.equal(fs.readdirSync(f.directory).length, 1);
});

test('新认证的 Reader 能力策略不能复用旧的失败候选', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const policyIdentity = {
        ...f.oldIdentity,
        readerCapabilityPolicyContract: conferenceContext.WEAK_READER_CAPABILITY_POLICY_CONTRACT,
        readerCapabilityPolicySha256: conferenceContext.WEAK_READER_CAPABILITY_POLICY.policySha256
    };
    assert.equal(loadFailedCandidate(f.directory, policyIdentity), null);
    assert.equal(f.enabled(() => loadReaderRecoveryRevision(f.directory, policyIdentity)), null);
    assert.deepEqual(fs.readdirSync(f.directory), [`${hashDraft(f.oldIdentity)}.json`]);
});

test('多个兼容候选拒绝迁移，不猜哪个额度最新', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    saveFailedCandidate(f.directory, { ...f.oldIdentity, repairImplementationSha256: '9'.repeat(64) }, { ...f.payload, attempts: 5 });
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /Ambiguous/);
    assert.equal(fs.readdirSync(f.directory).length, 2);
});

test('精确匹配的新候选胜出，不碰旧候选及其无进展标记', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    saveFailedCandidate(f.directory, f.identity, { ...f.payload, attempts: 6 });
    const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(loaded.attempts, 6); assert.equal(loaded.noProgress, 2);
    assert.equal(fs.readdirSync(f.directory).length, 2);
});

test('只修改草稿顺序格式标记，不清除旧候选的无进展计数', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, { ...f.oldIdentity, draftOrderContract: 'label only' }));
    assert.equal(loaded.noProgress, 2); assert.equal(loaded.failureSignature, 'old failure');
    assert.equal(loaded.readerRecoveryRevisions[0].clearedNoProgress, false);
});

test('表格编译器实现变化会迁移草稿以做完整重新校验，但不恢复额度', t => {
    const f = fixture(t);
    const oldIdentity = { ...f.oldIdentity, repairImplementationSha256: f.identity.repairImplementationSha256,
        tableCompilerSha256: '1'.repeat(64) };
    const currentIdentity = { ...f.identity, tableCompilerSha256: '2'.repeat(64) };
    saveFailedCandidate(f.directory, oldIdentity, f.payload);
    const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, currentIdentity));
    assert.equal(loaded.attempts, f.payload.attempts); assert.equal(loaded.fullAttempts, f.payload.fullAttempts);
    assert.equal(loaded.noProgress, 0); assert.equal(loaded.validationFailureStreak, 0);
    assert.match(loaded.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    assert.ok(loaded.readerRecoveryRevisions[0].changedFields.includes('tableCompilerSha256'));
});

test('历史直接范围在表格编译器修复后迁移同一个绑定来源的失败候选', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-direct-revision-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'reader-attempts'); const runId = crypto.randomUUID();
    const paperId = '2609.99970'; const text = 'sealed historical direct source';
    const sourceSha256 = crypto.createHash('sha256').update(text).digest('hex');
    const oldIdentity = { paperId, sourceSha256, inputFingerprint: 'same direct input',
        model: { model: 'test-model', maxTokens: 48000 }, promptSha256: 'p', repairPromptSha256: 'q',
        maxAttempts: 6, repairMaxTokens: 8000, tableCompilerSha256: '1'.repeat(64),
        repairImplementationSha256: '2'.repeat(64) };
    const identity = { ...oldIdentity, tableCompilerSha256: '3'.repeat(64),
        repairImplementationSha256: '4'.repeat(64) };
    const base = fixture(t); saveFailedCandidate(directory, oldIdentity, base.payload);
    const sourceDetails = { paperId: `arxiv:${paperId}`, source: 'pdf', sourceId: paperId, text,
        structuredArtifacts: { payloadSha256: 'b'.repeat(64) } };
    const enabled = (callback, overrides = {}) => {
        const scopedDetails = overrides.sourceDetails || sourceDetails;
        return directContext.withDirectRewriteAnalysisSource({ paperId: overrides.paperId || `arxiv:${paperId}`,
            runId: overrides.runId || runId, route: 'arxiv-fresh-fetch', sourceDetails: scopedDetails,
            sourceSha256: overrides.sourceSha256 || sourceSha256,
            structuredArtifactsSha256: scopedDetails.structuredArtifacts.payloadSha256,
            sourceSnapshotSha256: 'c'.repeat(64), sourceGeneration: 1,
            sourceManifestSha256: 'd'.repeat(64), readerAttemptsDir: overrides.readerAttemptsDir || directory }, callback);
    };
    const migrated = enabled(() => loadReaderRecoveryRevision(directory, identity));
    assert.equal(migrated.attempts, base.payload.attempts);
    assert.equal(migrated.validationFailureStreak, 0);
    assert.equal(migrated.readerRecoveryRevisions.at(-1).scope, 'historical-direct');
    assert.equal(migrated.readerRecoveryRevisions.at(-1).runId, runId);
    assert.match(migrated.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(enabled(() => loadReaderRecoveryRevision(directory, identity)), migrated);
    const wrong = { ...identity, sourceSha256: '0'.repeat(64) };
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(directory, wrong)), /historical direct run\/source scope/);
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(directory, identity), { runId: crypto.randomUUID() }),
        /implementation repair allowance|historical direct/i);
    const otherPaper = '2609.99969'; const otherDetails = { ...sourceDetails, paperId: `arxiv:${otherPaper}` };
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(directory, identity), {
        paperId: `arxiv:${otherPaper}`, sourceDetails: otherDetails }), /implementation repair allowance|historical direct/i);
    const differentText = 'different sealed historical source';
    const differentDetails = { ...sourceDetails, text: differentText };
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(directory, identity), {
        sourceDetails: differentDetails,
        sourceSha256: crypto.createHash('sha256').update(differentText).digest('hex')
    }), /implementation repair allowance|historical direct/i);
    const moved = path.join(root, 'moved-reader-attempts'); fs.cpSync(directory, moved, { recursive: true });
    assert.throws(() => enabled(() => loadReaderRecoveryRevision(moved, identity)),
        /implementation repair allowance|historical direct/i);
    assert.throws(() => loadReaderRecoveryRevision(directory, identity),
        /implementation repair allowance|historical direct/i);
});

test('已耗尽的付费额度保留计数，但恰好得到一个实现修复名额', t => {
    const f = fixture(t); const pointer = '/sections/8/body';
    const exhausted = { ...f.payload, attempts: 6, fullAttempts: 2,
        issues: [{ path: null, message: `Reader patch rejected: Reader patch has stale node SHA: ${pointer}` }] };
    saveFailedCandidate(f.directory, f.oldIdentity, exhausted);
    const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.equal(loaded.attempts, 6); assert.equal(loaded.fullAttempts, 2);
    assert.equal(loaded.implementationRepairAllowanceLineage,
        'reader-implementation-repair-lineage-v1');
    assert.match(loaded.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    const repair = require('../scripts/lib/reader-repair.js');
    const targets = repair.buildRepairTargets(loaded.draft, loaded.issues);
    assert.deepEqual(targets.map(target => target.path), [pointer]);
    assert.equal(targets[0].oldSha256, repair.hashDraft(loaded.draft.sections[8].body));
    assert.equal(repair.readerAttemptLimit(6, loaded.attempts, loaded.draft,
        loaded.implementationRepairAllowanceProof ? 1 : 0), 7);
    assert.equal(repair.readerAttemptLimit(6, 7, loaded.draft, 0), 7);
});

test('实现更新带来的额外修复名额只能使用一次，不能重新启用', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    const proof = migrated.implementationRepairAllowanceProof;
    saveFailedCandidate(f.directory, f.identity, { ...migrated, implementationRepairAllowanceProof: null });
    const consumed = loadFailedCandidate(f.directory, f.identity);
    assert.ok(consumed.consumedImplementationAllowanceSha256.includes(proof.allowanceSha256));
    assert.throws(() => saveFailedCandidate(f.directory, f.identity,
        { ...consumed, implementationRepairAllowanceProof: proof }), /already consumed/);
});

test('额外修复名额用完后，再次更新实现不会增加尝试次数', t => {
    const f = fixture(t); const exhausted = { ...f.payload, attempts: 6, fullAttempts: 2 };
    saveFailedCandidate(f.directory, f.oldIdentity, exhausted);
    const first = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.match(first.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    saveFailedCandidate(f.directory, f.identity, { ...first, attempts: 7,
        implementationRepairAllowanceProof: null });
    const afterCall = loadFailedCandidate(f.directory, f.identity);
    assert.equal(afterCall.implementationRepairAllowanceLineage,
        'reader-implementation-repair-lineage-v1');
    assert.ok(afterCall.consumedImplementationAllowanceSha256.includes(
        first.implementationRepairAllowanceProof.allowanceSha256));

    const nextIdentity = { ...f.identity, repairImplementationSha256: '9'.repeat(64) };
    const next = f.enabled(() => loadReaderRecoveryRevision(f.directory, nextIdentity));
    assert.equal(next.attempts, 7);
    assert.equal(next.fullAttempts, 2);
    assert.equal(next.implementationRepairAllowanceProof, null);
    assert.equal(next.implementationRepairAllowanceLineage,
        'reader-implementation-repair-lineage-v1');
    const repair = require('../scripts/lib/reader-repair.js');
    assert.equal(repair.readerAttemptLimit(6, next.attempts, next.draft, 0), 7);
});

test('未使用的沿袭额度在身份变化后转移，不会产生第二个名额', t => {
    const f = fixture(t); const exhausted = { ...f.payload, attempts: 6, fullAttempts: 2 };
    saveFailedCandidate(f.directory, f.oldIdentity, exhausted);
    const first = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    const firstProof = first.implementationRepairAllowanceProof;
    const nextIdentity = { ...f.identity, repairImplementationSha256: '8'.repeat(64) };
    const transferred = f.enabled(() => loadReaderRecoveryRevision(f.directory, nextIdentity));
    assert.match(transferred.implementationRepairAllowanceProof.allowanceSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(transferred.implementationRepairAllowanceProof.allowanceSha256,
        firstProof.allowanceSha256);
    assert.ok(transferred.consumedImplementationAllowanceSha256.includes(firstProof.allowanceSha256));
    assert.equal(transferred.attempts, 6);
    const repair = require('../scripts/lib/reader-repair.js');
    assert.equal(repair.readerAttemptLimit(6, transferred.attempts, transferred.draft, 1), 7);
});

test('解析器、文字检查及固定规则检查的实现变化，各允许迁移一次诊断记录', async t => {
    for (const field of ['parserImplementationSha256', 'editorialImplementationSha256',
        'mechanicalContractSha256']) {
        await t.test(field, tt => {
            const f = fixture(tt); const baseline = structuredClone(f.identity);
            const oldIdentity = { ...baseline, [field]: '4'.repeat(64) };
            const currentIdentity = { ...baseline, [field]: '5'.repeat(64) };
            saveFailedCandidate(f.directory, oldIdentity, f.payload);
            const loaded = f.enabled(() => loadReaderRecoveryRevision(f.directory, currentIdentity));
            assert.equal(loaded.attempts, f.payload.attempts);
            assert.equal(loaded.fullAttempts, f.payload.fullAttempts);
            assert.equal(loaded.validationFailureStreak, 0);
            assert.deepEqual(loaded.readerRecoveryRevisions.at(-1).changedFields, [field]);
        });
    }
});

test('图片 SHA 变化时拒绝迁移，并保留旧候选记录', t => {
    const f = fixture(t); const oldPixels = [{ ordinal: 1, sha256: '6'.repeat(64) }];
    const oldIdentity = { ...f.identity, parserImplementationSha256: '4'.repeat(64) };
    const oldPayload = { ...f.payload, imageEvidence: oldPixels };
    saveFailedCandidate(f.directory, oldIdentity, oldPayload);
    const changedPixels = hashDraft([{ ordinal: 1, sha256: '7'.repeat(64) }]);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity,
        { pixelEvidenceSha256: changedPixels })), /image evidence drifted/);
    assert.deepEqual(loadFailedCandidate(f.directory, oldIdentity), oldPayload);
});

test('临时图片及补充图片记录的 SHA 变化时拒绝迁移，一致时保留原记录', t => {
    const f = fixture(t);
    const oldIdentity = { ...f.identity, parserImplementationSha256: '4'.repeat(64) };
    const ephemeralImageEvidence = {
        imageEvidence: [{ ordinal: 1, sha256: '6'.repeat(64), url: 'https://example.invalid/figure.png' }],
        directSupplementaryEvidence: [{ ordinal: 2, sha256: '7'.repeat(64), mediaType: 'image/png', caption: null }]
    };
    const oldPayload = { ...f.payload, ephemeralImageEvidence };
    saveFailedCandidate(f.directory, oldIdentity, oldPayload);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity, {
        ephemeralImageEvidenceSha256: hashDraft({ ...ephemeralImageEvidence,
            directSupplementaryEvidence: [{ ...ephemeralImageEvidence.directSupplementaryEvidence[0], sha256: '8'.repeat(64) }] })
    })), /ephemeral image evidence drifted/);
    assert.deepEqual(loadFailedCandidate(f.directory, oldIdentity), oldPayload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity, {
        ephemeralImageEvidenceSha256: hashDraft(ephemeralImageEvidence)
    }));
    assert.deepEqual(migrated.ephemeralImageEvidence, ephemeralImageEvidence);
});

test('候选文件损坏或是符号链接时，在装入新候选之前直接失败', t => {
    const f = fixture(t); const filename = saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    fs.writeFileSync(filename, '{invalid JSON', { mode: 0o600 });
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /JSON/);
    fs.unlinkSync(filename); const target = path.join(f.root, 'outside.json');
    fs.writeFileSync(target, '{}', { mode: 0o600 }); fs.symlinkSync(target, filename);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /ELOOP|symlink/i);
    assert.equal(fs.existsSync(path.join(f.directory, `${hashDraft(f.identity)}.json`)), false);
});

function interruptArchival(f) {
    const filename = saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (from === filename && to.includes('.migrated-')) {
            const error = new Error('injected archive EIO'); error.code = 'EIO'; throw error;
        }
        return rename(from, to);
    };
    try { assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /archive EIO/); }
    finally { fs.renameSync = rename; }
    assert.ok(loadFailedCandidate(f.directory, f.identity));
    assert.ok(loadFailedCandidate(f.directory, f.oldIdentity));
    return filename;
}

test('装入新候选后归档出现 EIO，精确候选重入时补完，不重置额度', t => {
    const f = fixture(t); interruptArchival(f);
    const before = loadFailedCandidate(f.directory, f.identity);
    assert.match(before.readerRecoveryRevisions[0].oldEnvelopeSha256, /^[a-f0-9]{64}$/);
    assert.equal(before.readerRecoveryRevisions[0].oldPayloadSha256, hashDraft(f.payload));
    const resumed = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    assert.deepEqual(resumed, before);
    assert.equal(resumed.attempts, 4); assert.equal(resumed.fullAttempts, 1); assert.equal(resumed.transportFailures, 2);
    assert.equal(loadFailedCandidate(f.directory, f.oldIdentity), null);
    assert.ok(fs.existsSync(path.join(f.directory, resumed.readerRecoveryRevisions[0].archivedName)));
    assert.deepEqual(f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), resumed);
});

test('归档中断后重试，即使草稿和次数不变，也拒绝旧诊断和图片记录被改动', t => {
    const f = fixture(t); interruptArchival(f);
    saveFailedCandidate(f.directory, f.oldIdentity, { ...f.payload,
        issues: [{ path: null, message: 'changed old diagnostics' }], imageEvidence: [{ changed: true }] });
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /drifted/);
    assert.ok(loadFailedCandidate(f.directory, f.oldIdentity));
});

test('归档或旧证据缺失就拒绝重入，之后加载时归档字节仍保持已核验', t => {
    const f = fixture(t); const filename = interruptArchival(f);
    fs.unlinkSync(filename);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /ENOENT|changed during audit|审查期间消失/);
    saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const resumed = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    const archived = path.join(f.directory, resumed.readerRecoveryRevisions[0].archivedName);
    fs.appendFileSync(archived, '\n');
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /drifted/);
});

test('精确候选重入时拒绝归档路径穿越和归档符号链接', t => {
    const f = fixture(t); saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    const archive = path.join(f.directory, migrated.readerRecoveryRevisions[0].archivedName);
    const outside = path.join(f.root, 'archive-copy.json'); fs.renameSync(archive, outside); fs.symlinkSync(outside, archive);
    assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /ELOOP|symlink/i);
    const tampered = structuredClone(migrated); tampered.readerRecoveryRevisions[0].archivedName = '../outside.json';
    assert.throws(() => saveFailedCandidate(f.directory, f.identity, tampered), /allowance lacks a valid recovery-revision proof|ELOOP|symbolic/i);
});


test('真实失败候选恢复只更正完整数词，不改较长数词内的相同后缀', t => {
    const f = fixture(t);
    const original = '训练采用三阶段课程。对照采用十三阶段课程，网络包含十三层。另一个模型使用三层。';
    f.payload.draft.sections[0].body = original;
    f.payload.issues = [
        { path: null, message: 'quantitative_chinese_numeral:三阶段' },
        { path: null, message: 'quantitative_chinese_numeral:三层' }
    ];
    f.payload.rawDraft = JSON.stringify(f.payload.draft);
    saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity, {
        pixelEvidenceSha256: hashDraft(f.payload.imageEvidence)
    }));
    assert.equal(migrated.draft.sections[0].body,
        '训练采用 3 个阶段课程。对照采用十三阶段课程，网络包含十三层。另一个模型使用 3 层。');
    assert.equal(migrated.status, 'failed');
    assert.equal(migrated.attempts, f.payload.attempts);
    const archived = JSON.parse(fs.readFileSync(path.join(f.directory,
        migrated.readerRecoveryRevisions[0].archivedName), 'utf8'));
    assert.equal(archived.payload.draft.sections[0].body, original);
});

test('完整原表标记的旧付费候选迁移不在无来源上下文中生成原表', t => {
    const sample = fixture(t);
    const resultSection = sample.payload.draft.sections.find(section => section.kind === 'result');
    resultSection.body += '\n\n[[TABLE_1]]';
    sample.payload.draft.tableBindings = [{
        tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1,
        sourceQuotes: [],
        cellBindings: [0, 1].flatMap(row => [0, 1].map(column => ({
            renderedRow: row, renderedColumn: column, sourceRow: row, sourceColumn: column
        })))
    }];
    sample.payload.rawDraft = JSON.stringify(sample.payload.draft);
    const filename = saveFailedCandidate(sample.directory, sample.oldIdentity, sample.payload);
    const originalBytes = fs.readFileSync(filename);
    const recovered = sample.enabled(() => loadReaderRecoveryRevision(sample.directory, sample.identity));
    assert.equal(recovered.attempts, sample.payload.attempts);
    assert.equal(recovered.fullAttempts, sample.payload.fullAttempts);
    assert.equal(recovered.status, 'failed');
    assert.deepEqual(recovered.draft, sample.payload.draft);
    assert.equal(recovered.rawDraft, sample.payload.rawDraft);
    assert.deepEqual(
        fs.readFileSync(path.join(sample.directory, recovered.readerRecoveryRevisions[0].archivedName)),
        originalBytes
    );
});


test('保留已付费草稿、次数和归档字节', t => {
    const sample = fixture(t);
    sample.payload.draft = normalizeReaderDraftOrder(sample.payload.draft).draft;
    sample.payload.rawDraft = JSON.stringify(sample.payload.draft);
    const oldPromptSha = '89faba16d2b3af5a1549e13c85800bc7301d3a4217a1d9ae362b33c76cff9a34';
    const newPromptSha = '7cb7332fa3085b4497c31d73a7075eb10f8700cd84d23f68875d8341cb97f5de';
    sample.oldIdentity = { ...sample.identity, repairPromptSha256: oldPromptSha };
    sample.identity = { ...sample.identity, repairPromptSha256: newPromptSha };
    const filename = saveFailedCandidate(sample.directory, sample.oldIdentity, sample.payload);
    const originalBytes = fs.readFileSync(filename);
    const recovered = sample.enabled(() => loadReaderRecoveryRevision(sample.directory, sample.identity));
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.attempts, sample.payload.attempts);
    assert.equal(recovered.fullAttempts, sample.payload.fullAttempts);
    assert.equal(recovered.transportFailures, sample.payload.transportFailures);
    assert.equal(recovered.noProgress, sample.payload.noProgress);
    assert.equal(recovered.implementationRepairAllowanceProof, null);
    assert.deepEqual(recovered.draft, sample.payload.draft);
    assert.equal(recovered.rawDraft, sample.payload.rawDraft);
    assert.deepEqual(fs.readFileSync(path.join(sample.directory,
        recovered.readerRecoveryRevisions[0].archivedName)), originalBytes);
});

test('其他修复提示词SHA不得冒充固定v5到v6迁移', t => {
    const sample = fixture(t);
    sample.oldIdentity = { ...sample.identity, repairPromptSha256: 'a'.repeat(64) };
    sample.identity = { ...sample.identity,
        repairPromptSha256: '7cb7332fa3085b4497c31d73a7075eb10f8700cd84d23f68875d8341cb97f5de' };
    const filename = saveFailedCandidate(sample.directory, sample.oldIdentity, sample.payload);
    const originalBytes = fs.readFileSync(filename);
    assert.equal(sample.enabled(() => loadReaderRecoveryRevision(sample.directory, sample.identity)), null);
    assert.deepEqual(fs.readFileSync(filename), originalBytes);
});

test('完整原表固定提示词升级保留已付费草稿、次数和归档字节', t => {
    const sample = fixture(t);
    sample.payload.draft = normalizeReaderDraftOrder(sample.payload.draft).draft;
    sample.payload.rawDraft = JSON.stringify(sample.payload.draft);
    const oldPromptSha = '7cb7332fa3085b4497c31d73a7075eb10f8700cd84d23f68875d8341cb97f5de';
    const newPromptSha = 'cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965';
    sample.oldIdentity = { ...sample.identity, promptSha256: '929ec8f6e93b06edf85158e2fdf46de498111581373e54c06d457b265b00aea5', repairPromptSha256: oldPromptSha };
    sample.identity = { ...sample.identity, promptSha256: 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380', repairPromptSha256: newPromptSha };
    const filename = saveFailedCandidate(sample.directory, sample.oldIdentity, sample.payload);
    const originalBytes = fs.readFileSync(filename);
    const recovered = sample.enabled(() => loadReaderRecoveryRevision(sample.directory, sample.identity));
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.attempts, sample.payload.attempts);
    assert.equal(recovered.fullAttempts, sample.payload.fullAttempts);
    assert.equal(recovered.transportFailures, sample.payload.transportFailures);
    assert.equal(recovered.noProgress, sample.payload.noProgress);
    assert.equal(recovered.implementationRepairAllowanceProof, null);
    assert.deepEqual(recovered.draft, sample.payload.draft);
    assert.equal(recovered.rawDraft, sample.payload.rawDraft);
    assert.deepEqual(fs.readFileSync(path.join(sample.directory,
        recovered.readerRecoveryRevisions[0].archivedName)), originalBytes);
});

test('完整原表升级只接受固定正文及局部修复提示词配对', t => {
    const sample = fixture(t);
    sample.payload.draft = normalizeReaderDraftOrder(sample.payload.draft).draft;
    sample.payload.rawDraft = JSON.stringify(sample.payload.draft);
    sample.oldIdentity = { ...sample.identity,
        promptSha256: '929ec8f6e93b06edf85158e2fdf46de498111581373e54c06d457b265b00aea5',
        repairPromptSha256: '7cb7332fa3085b4497c31d73a7075eb10f8700cd84d23f68875d8341cb97f5de' };
    const filename = saveFailedCandidate(sample.directory, sample.oldIdentity, sample.payload);
    const originalBytes = fs.readFileSync(filename);
    const currentIdentity = { ...sample.identity,
        promptSha256: 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380',
        repairPromptSha256: 'cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965' };
    for (const identity of [
        { ...currentIdentity, promptSha256: 'a'.repeat(64) },
        { ...currentIdentity, repairPromptSha256: 'a'.repeat(64) },
        { ...currentIdentity, promptSha256: sample.oldIdentity.promptSha256 }
    ]) {
        assert.equal(sample.enabled(() => loadReaderRecoveryRevision(sample.directory, identity)), null);
        assert.deepEqual(fs.readFileSync(filename), originalBytes);
    }
});


test('固定局部修复版本升级保留原始元数据草稿、付费次数和归档字节', t => {
    const sample = fixture(t);
    sample.payload.draft = null;
    const originalDraft = { version: 3, readerTitle: '元数据草稿', oneSentenceThesis: '保留正文。',
        sections: [{ kind: 'component', heading: '原正文', body: '原始正文保持不变。' }],
        conceptBridges: [], figurePlacements: [], tableBindings: [], formulaBindings: [],
        sourceBindingsContract: 'api-reader-source-bindings-v4', sourceBindingsSha256: 'a'.repeat(64) };
    sample.payload.rawDraft = JSON.stringify(originalDraft, null, 2);
    sample.oldIdentity = { ...sample.identity,
        promptSha256: 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380',
        repairPromptSha256: 'cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965' };
    sample.identity = { ...sample.oldIdentity,
        repairPromptSha256: '9a7e72d75fdd05f7004c132533425fa140d237c22bc98a3c6c64333e5d76e22e' };
    const filename = saveFailedCandidate(sample.directory, sample.oldIdentity, sample.payload);
    const originalBytes = fs.readFileSync(filename);
    assert.equal(sample.enabled(() => loadReaderRecoveryRevision(sample.directory,
        { ...sample.identity, repairPromptSha256: 'a'.repeat(64) })), null);
    const recovered = sample.enabled(() => loadReaderRecoveryRevision(sample.directory, sample.identity));
    assert.equal(recovered.draft, null);
    assert.equal(recovered.rawDraft, sample.payload.rawDraft);
    for (const field of ['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'validationFailureStreak']) {
        assert.equal(recovered[field], sample.payload[field]);
    }
    assert.equal(recovered.implementationRepairAllowanceProof, null);
    assert.deepEqual(fs.readFileSync(path.join(sample.directory,
        recovered.readerRecoveryRevisions[0].archivedName)), originalBytes);
});

test('固定 v9 到 v10 升级保留完整超节数草稿、次数和归档字节', t => {
    const sample = fixture(t);
    sample.payload.draft = null;
    const originalDraft = { version: 3, readerTitle: '元数据草稿', oneSentenceThesis: '保留正文。',
        sections: Array.from({ length: 19 }, (_, index) => ({ kind: 'component', heading: `原正文${index}`, body: '原始正文保持不变。' })),
        conceptBridges: [], figurePlacements: [], tableBindings: [], formulaBindings: [] };
    sample.payload.rawDraft = JSON.stringify(originalDraft, null, 2);
    sample.oldIdentity = { ...sample.identity,
        promptSha256: 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380',
        repairPromptSha256: '5164ce17261a13a009c34bfcf8a71fc2c44f1ae2246f0651de5eda82a7645f65' };
    sample.identity = { ...sample.oldIdentity,
        repairPromptSha256: 'f50f85a04017de568f8225e97d7b4e230ae40b969d99266afcef045e011829a4' };
    const filename = saveFailedCandidate(sample.directory, sample.oldIdentity, sample.payload);
    const originalBytes = fs.readFileSync(filename);
    assert.equal(sample.enabled(() => loadReaderRecoveryRevision(sample.directory,
        { ...sample.identity, repairPromptSha256: 'a'.repeat(64) })), null);
    const recovered = sample.enabled(() => loadReaderRecoveryRevision(sample.directory, sample.identity));
    assert.deepEqual(recovered.draft, originalDraft);
    assert.deepEqual(JSON.parse(recovered.rawDraft), originalDraft);
    for (const field of ['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'validationFailureStreak']) {
        assert.equal(recovered[field], sample.payload[field]);
    }
    assert.equal(recovered.implementationRepairAllowanceProof, null);
    assert.deepEqual(fs.readFileSync(path.join(sample.directory,
        recovered.readerRecoveryRevisions[0].archivedName)), originalBytes);
});

test('输入未变时从完整原始响应恢复草稿，不改存档和调用预算', t => {
    const f = fixture(t);
    const draft = structuredClone(f.payload.draft);
    draft.sections = Array.from({ length: 37 }, (_, index) => ({ ...draft.sections[index % draft.sections.length] }));
    f.payload.draft = null;
    f.payload.rawDraft = JSON.stringify(draft);
    saveFailedCandidate(f.directory, f.identity, f.payload);
    const filename = path.join(f.directory, `${hashDraft(f.identity)}.json`);
    const before = fs.readFileSync(filename);
    const loaded = loadReaderRecoveryRevision(f.directory, f.identity);
    assert.deepEqual(loaded.draft, draft);
    for (const key of Object.keys(f.payload).filter(key => key !== 'draft')) assert.deepEqual(loaded[key], f.payload[key]);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.equal(loadFailedCandidate(f.directory, f.identity).draft, null);
});

test('输入未变的恢复仍拒绝缺失正文、损坏JSON和超过64节', t => {
    const f = fixture(t);
    for (const rawDraft of ['{"version":3}', '{', JSON.stringify({ ...f.payload.draft,
        sections: Array.from({ length: 65 }, () => f.payload.draft.sections[0]) })]) {
        saveFailedCandidate(f.directory, f.identity, { ...f.payload, draft: null, rawDraft });
        assert.equal(loadReaderRecoveryRevision(f.directory, f.identity).draft, null);
    }
});

test('实现许可后的索引分组与后续失败不污染迁移审计，下一次读取及再次迁移可恢复', t => {
    const repair = require('../scripts/lib/reader-repair');
    const f = fixture(t);
    f.payload.draft.sections.push(...Array.from({ length: 8 }, (_, index) => ({
        kind: 'component', heading: `补充组件 ${index}`, body: '原组件正文与条件保持。'.repeat(20)
    })));
    f.payload.rawDraft = JSON.stringify(f.payload.draft);
    saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const pixels = { pixelEvidenceSha256: hashDraft(f.payload.imageEvidence) };
    const migrated = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity, pixels));
    const allowance = migrated.implementationRepairAllowanceProof;
    assert.ok(allowance?.allowanceSha256);
    assert.equal(repair.validateImplementationAllowance(migrated, f.identity, f.directory), true);
    const context = repair.buildRepairContext(migrated.draft, [], '', '');
    const groups = [];
    migrated.draft.sections.forEach((section, index) => {
        if (index && section.kind === migrated.draft.sections[index - 1].kind) groups.at(-1).sectionIndexes.push(index);
        else groups.push({ sectionIndexes: [index], heading: section.heading });
    });
    assert.equal(groups.length, 12);
    const plan = { contract: repair.SECTION_GROUP_PLAN_CONTRACT, version: 1,
        draftSha256: context.draftSha256, sectionsSha256: context.targets[0].oldSha256, groups };
    const compiled = repair.compileSectionIndexGroupPlan(migrated.draft, plan, context);
    const draft = repair.applyReaderPatch(migrated.draft, compiled.patch, ['/sections'], { atomicOperation: context.atomicOperation });
    // 新模型回包占用原许可；编译证明仅在真实请求/响应日志或返回值里，不混入迁移审计。
    const failed = { ...migrated, draft, rawDraft: JSON.stringify(draft),
        attempts: migrated.attempts + 1, implementationRepairAllowanceProof: null,
        noProgress: 0, validationFailureStreak: 0, failureSignature: '后续完整来源检查仍失败',
        issues: [{ path: '/sections/0/body', message: '后续完整来源检查仍失败' }] };
    saveFailedCandidate(f.directory, f.identity, failed);
    const loaded = loadFailedCandidate(f.directory, f.identity);
    assert.equal(loaded.draft.sections.length, 12);
    assert.deepEqual(loaded.readerRecoveryRevisions, migrated.readerRecoveryRevisions);
    assert.ok(loaded.readerRecoveryRevisions.every(audit => audit.contract === 'reader-recovery-diagnostics-revision-v1'));
    const again = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity, pixels));
    assert.deepEqual(again, loaded);
    const nextIdentity = { ...f.identity, parserImplementationSha256: '9'.repeat(64) };
    const next = f.enabled(() => loadReaderRecoveryRevision(f.directory, nextIdentity, pixels));
    assert.equal(next.attempts, failed.attempts);
    assert.equal(next.fullAttempts, failed.fullAttempts);
    assert.equal(next.transportFailures, failed.transportFailures);
    assert.equal(next.implementationRepairAllowanceProof, null);
    assert.ok(next.consumedImplementationAllowanceSha256.includes(allowance.allowanceSha256));
    assert.deepEqual(next.draft, draft);
    assert.ok(next.readerRecoveryRevisions.every(audit => audit.contract === 'reader-recovery-diagnostics-revision-v1'));
});


test('同输入签名Reader收紧为资源局部模式不清空任何计费计数，禁止降级', t => {
    const sample = fixture(t);
    sample.oldIdentity.contentMode = 'reader-source-signed-revision-v1';
    sample.identity.contentMode = 'reader-source-signed-revision-v1';
    sample.identity.resourceLocalRevisionContract = 'signed-reader-resource-local-repair-v1';
    saveFailedCandidate(sample.directory, sample.oldIdentity, sample.payload);
    const recovered = sample.enabled(() => loadReaderRecoveryRevision(sample.directory, sample.identity));
    assert.ok(recovered);
    for (const key of ['attempts', 'fullAttempts', 'transportFailures']) assert.equal(recovered[key], sample.payload[key]);
    const downgrade = { ...sample.identity, parserImplementationSha256: '9'.repeat(64) };
    delete downgrade.resourceLocalRevisionContract;
    assert.equal(sample.enabled(() => loadReaderRecoveryRevision(sample.directory, downgrade)), null);
    assert.throws(() => loadReaderRecoveryRevision(sample.directory, {
        ...sample.identity, resourceLocalRevisionContract: '其它模式'
    }), /恢复模式记录无效/);
    assert.throws(() => loadReaderRecoveryRevision(sample.directory, {
        ...sample.identity, contentMode: 'reader-source-only-v1'
    }), /恢复模式记录无效/);
});

test('固定中文提示升级连同实现指纹变化仍保留已付费次数和失败计数，不新增额度', t => {
    const f = fixture(t);
    f.oldIdentity.promptSha256 = 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380';
    f.oldIdentity.repairPromptSha256 = 'f50f85a04017de568f8225e97d7b4e230ae40b969d99266afcef045e011829a4';
    f.identity.promptSha256 = 'b4f0b864fd338cc3a58a2e061ec952947a6faa4a09971167d6daa7add9ebbd9f';
    f.identity.repairPromptSha256 = 'd3fa5851973b36e0944a9abf13f719aa34b1782f784ee086e6e637deea8979c2';
    saveFailedCandidate(f.directory, f.oldIdentity, f.payload);
    const revised = f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity));
    for (const field of ['attempts','fullAttempts','transportFailures','noProgress','failureSignature',
        'validationFailureStreak','validationFailureSignature']) assert.deepEqual(revised[field], f.payload[field]);
    assert.equal(revised.implementationRepairAllowanceProof, null);
    assert.equal(revised.readerRecoveryRevisions.at(-1).clearedNoProgress, false);
});
for (const field of ['sourceSha256','inputFingerprint','readerRecoveryEpochSha256','promptSha256']) {
    test(`中文提示升级不接受改变${field}的恢复上下文`, t => {
        const f = fixture(t);
        f.oldIdentity.promptSha256 = 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380';
        f.oldIdentity.repairPromptSha256 = 'f50f85a04017de568f8225e97d7b4e230ae40b969d99266afcef045e011829a4';
        f.identity.promptSha256 = 'b4f0b864fd338cc3a58a2e061ec952947a6faa4a09971167d6daa7add9ebbd9f';
        f.identity.repairPromptSha256 = 'd3fa5851973b36e0944a9abf13f719aa34b1782f784ee086e6e637deea8979c2';
        f.identity[field] = '9'.repeat(64);
        if (field === 'readerRecoveryEpochSha256') f.oldIdentity[field] = '8'.repeat(64);
        const file = saveFailedCandidate(f.directory, f.oldIdentity, f.payload), bytes = fs.readFileSync(file);
        if (field === 'sourceSha256') assert.throws(() => f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), /exact fresh run\/source scope/);
        else assert.equal(f.enabled(() => loadReaderRecoveryRevision(f.directory, f.identity)), null);
        assert.deepEqual(fs.readFileSync(file), bytes);
    });
}

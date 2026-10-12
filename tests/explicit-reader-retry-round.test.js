'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config');
const engine = require('../scripts/analysis-engine');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const repair = require('../scripts/lib/reader-repair');
const retry = require('../scripts/lib/explicit-reader-retry-round');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let plan, paper, oldEnvelope, directory;
let fixtureRoot;
const previousRoot = Config.FILES.dailyFreshSourceRunsDir;
test.before(async () => {
    const os = require('node:os');
    const fresh = require('../scripts/lib/fresh-analysis-context');
    const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
    fixtureRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'explicit-reader-round-'));
    Config.FILES.dailyFreshSourceRunsDir = path.join(fixtureRoot, 'runs');
    paper = { arxivId: '2610.90071v1', title: 'Controlled retry fixture', analysisCheckpoint: '原主文正确且保留。',
        analysisManifest: { stages: { apiReaderArticle: { status: 'failed' } } }, fullTextAvailable: true };
    plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'explicit-reader-round', papers: [paper] });
    const text = 'Official controlled source methods and experimental limitations. '.repeat(100);
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => sourceApi.captureFreshArxivRewriteSource(options, {
        fetchText: async id => ({ text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`,
            fetchedAt: '2026-10-11T00:00:00.000Z', imageInfos: [], warnings: [] }),
        fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`), url: `https://arxiv.org/pdf/${id}`,
            fetchedAt: '2026-10-11T00:00:01.000Z' })
    }) });
    const details = daily.readDailyFreshSource(plan, paper);
    paper.sourceSha256 = details.freshSourceDescriptor.sourceSha256;
    daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, details));
    const sourceIdentity = daily.withDailyFreshAnalysisContext(plan, () => fresh.freshAnalysisIdentity(paper.arxivId));
    oldEnvelope = { identity: { paperId: paper.arxivId, maxAttempts: 6, freshAnalysis: sourceIdentity,
        sourceSha256: paper.sourceSha256, inputFingerprint: sha(text) }, payload: {
        status: 'failed', draft: null, rawDraft: '', issues: [{ path: null, message: 'controlled exhausted fixture' }],
        attempts: 6, fullAttempts: 2, noProgress: 0, failureSignature: '', validationFailureSignature: '',
        validationFailureStreak: 0, transportFailures: 0, implementationRepairAllowanceProof: null } };
    directory = plan.readerAttemptsDir;
});
test.after(() => {
    Config.FILES.dailyFreshSourceRunsDir = previousRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});
function setup(t, mutate = () => {}) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const identity = structuredClone(oldEnvelope.identity);
    const payload = structuredClone(oldEnvelope.payload);
    mutate(payload);
    repair.saveFailedCandidate(directory, identity, payload);
    const file = path.join(directory, `${repair.hashDraft(identity)}.json`);
    const sourceDirectory = path.join(plan.sourcesDir, '2610.90071', 'generation-000001');
    const sourceFiles = Object.fromEntries(['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'].map(name => [name, sha(fs.readFileSync(path.join(sourceDirectory, name)))]));
    const grant = { contract: retry.CONTRACT, batchDate: plan.batchDate, runId: plan.runId, sourceFiles, originalIdentitySha256: repair.hashDraft(identity), paperId: '2610.90071', roundId: crypto.randomUUID(),
        identitySha256: repair.hashDraft(identity), envelopeSha256: sha(fs.readFileSync(file)),
        payloadSha256: repair.hashDraft(payload), wholeSha256: sha(paper.analysisCheckpoint || paper.analysis),
        maxResponses: 3, maxFullResponses: 1, maxPhysicalRequests: 6, maxReservedOutputTokens: 80000 };
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const locked = callback => daily.withDailyFreshAnalysisContext(plan, () =>
        daily.withDailyFreshPaperSource(plan, paper, () => engine.withPaperAnalysisLock(paper, callback)));
    return { identity, payload, file, grant, locked };
}
test('显式新轮只在真实四来源与规范论文锁内安装，旧字节和次数保留', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        assert.equal(next.attempts, 0);
        assert.equal(next.explicitReaderRetryRound.maxResponses, 3);
        const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
        assert.equal(receipt.oldAttempts, 6);
        assert.equal(receipt.oldFullAttempts, 2);
        assert.equal(sha(fs.readFileSync(receipt.archivedFile)), f.grant.envelopeSha256);
        assert.equal(retry.beginExplicitRound(directory, f.identity, next, paper), null);
    }));
});
test('尚有次数及错误原稿 SHA 均拒，原文件不动', async t => {
    const f = setup(t, p => { p.attempts = 2; p.noProgress = 0; p.validationFailureStreak = 0; });
    await f.locked(() => retry.withExplicitRound(paper, f.grant, () => {
        assert.throws(() => retry.beginExplicitRound(directory, f.identity, f.payload, paper), /仍有合法尝试/);
        assert.equal(sha(fs.readFileSync(f.file)), f.grant.envelopeSha256);
    }));
});
test('无来源上下文、无规范锁和错当前正文授权都不能安装', async t => {
    const f = setup(t);
    assert.throws(() => retry.withExplicitRound(paper, f.grant, () => {}), /完整封存日更来源/);
    await daily.withDailyFreshAnalysisContext(plan, () => daily.withDailyFreshPaperSource(plan, paper, () => {
        assert.throws(() => retry.withExplicitRound(paper, f.grant, () => {}), /ENOENT/);
    }));
    await f.locked(() => assert.throws(() => retry.withExplicitRound(paper,
        { ...f.grant, wholeSha256: '0'.repeat(64) }, () => {}), /当前论文不匹配/));
});
test('实际请求发出前持久计费，80k token与6次请求均严格挡住', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, () => {
            retry.consumePhysicalRequest({ max_tokens: 48000 }, { usageContext: { paperId: paper.arxivId, stage: 'apiReaderArticle' } });
            retry.consumePhysicalRequest({ max_tokens: 16000 }, { usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' } });
            retry.consumePhysicalRequest({ max_tokens: 16000 }, { usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' } });
            assert.throws(() => retry.consumePhysicalRequest({ max_tokens: 1 },
                { usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' } }), /输出预算耗尽/);
        });
        const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
        assert.equal(receipt.reservedOutputTokens, 80000);
        assert.equal(receipt.physicalRequests, 3);
    }));
});
test('普通恢复携带新轮证明，三次已耗尽不会被同授权清零', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        repair.saveFailedCandidate(directory, f.identity, { ...next, attempts: 3, fullAttempts: 1 });
        const stored = repair.loadFailedCandidate(directory, f.identity);
        assert.equal(retry.beginExplicitRound(directory, f.identity, stored, paper), null);
        assert.equal(stored.attempts, 3);
        assert.equal(stored.explicitReaderRetryRound.roundId, f.grant.roundId);
        assert.throws(() => retry.beginExplicitRound(directory, { ...f.identity, inputFingerprint: '0'.repeat(64) }, stored, paper), /不同当前输入/);
    }));
});
test('真实公共传输层最多6次，拒绝发生在第7次传输之前', async t => {
    const f = setup(t);
    let transports = 0;
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        await retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, async () => {
            const utils = require('../scripts/utils');
            const send = () => utils.requestLlmJson('https://example.invalid/v1/chat/completions',
                'https://example.invalid/v1', 'test-model', { max_tokens: 100, messages: [] }, {}, {
                    usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' }, usageSink: () => {},
                    transportRequestFn: async () => {
                        transports += 1;
                        return { statusCode: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } };
                    }
                });
            for (let i = 0; i < 6; i += 1) await send();
            await assert.rejects(send(), /实际请求或输出预算耗尽/);
            assert.equal(transports, 6);
        });
    }));
});
test('安装前崩溃由普通恢复完成同一事务；原稿或当前记录丢失绝不默认首次生成', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        const file = next.explicitReaderRetryRound.receiptFile;
        const receipt = JSON.parse(fs.readFileSync(file));
        receipt.status = 'prepared';
        fs.writeFileSync(file, JSON.stringify(receipt));
        fs.unlinkSync(f.file);
    }));
    await f.locked(() => {
        const next = retry.beginExplicitRound(directory, f.identity, null, paper);
        assert.equal(next.explicitReaderRetryRound.roundId, f.grant.roundId);
        assert.equal(next.attempts, 0);
        fs.unlinkSync(f.file);
        assert.throws(() => retry.beginExplicitRound(directory, f.identity, null, paper), /拒绝自动首次生成/);
    });
});
test('新轮字段、次数及原稿篡改不能被普通缓存续用', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        repair.saveFailedCandidate(directory, f.identity, { ...next, attempts: 2, fullAttempts: 1 });
        assert.throws(() => repair.saveFailedCandidate(directory, f.identity, { ...next, attempts: 0 }), /次数不能减少/);
        assert.throws(() => repair.saveFailedCandidate(directory, f.identity,
            { ...next, attempts: 4, fullAttempts: 1 }), /正文预算或证明不合法/);
        const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
        fs.appendFileSync(receipt.archivedFile, 'drift');
        assert.throws(() => repair.loadFailedCandidate(directory, f.identity), /原稿或实际请求预算证明不一致/);
    }));
});
test('坏请求账明细不能靠合法总数重新获得额度，实际0传输', async t => {
    const f = setup(t);
    let transports = 0;
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        const file = next.explicitReaderRetryRound.receiptFile;
        const pristine = JSON.parse(fs.readFileSync(file));
        for (const change of [
            { physicalRequests: 0, reservedOutputTokens: 100, requests: [{ at: new Date().toISOString(), stage: 'apiReaderRepair', tokens: 100 }] },
            { physicalRequests: 1, reservedOutputTokens: 99, requests: [{ at: new Date().toISOString(), stage: 'apiReaderRepair', tokens: 100 }] },
            { physicalRequests: 1, reservedOutputTokens: 100, requests: [{ at: 'not a time', stage: 'apiReaderRepair', tokens: 100 }] },
            { physicalRequests: 1, reservedOutputTokens: 100, requests: [{ at: new Date().toISOString(), stage: 'primaryAnalysis', tokens: 100 }] }
        ]) {
            fs.writeFileSync(file, JSON.stringify({ ...pristine, ...change }));
            await retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, async () => {
                const utils = require('../scripts/utils');
                await assert.rejects(utils.requestLlmJson('https://example.invalid/v1/chat/completions',
                    'https://example.invalid/v1', 'test-model', { max_tokens: 100, messages: [] }, {}, {
                        usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' }, usageSink: () => {},
                        transportRequestFn: async () => { transports += 1; return { statusCode: 200, body: {} }; }
                    }), /明细与次数或输出预算不一致/);
            });
        }
        assert.equal(transports, 0);
    }));
});
test('只读预检使用实际 Reader 身份构造，0模型和0缓存写入', async t => {
    const f = setup(t);
    const deep = require('../scripts/deep-analyzer');
    let models = 0;
    await f.locked(async () => {
        const details = daily.readDailyFreshSource(plan, paper);
        const before = fs.readdirSync(directory).sort();
        const prepared = await deep.prepareApiReaderRetryIdentity(paper, paper.analysisCheckpoint, details.text, {
            sourceText: details.text, structuredArtifacts: details.structuredArtifacts,
            readerCallModel: async () => { models += 1; throw new Error('不许预检调用模型'); },
            readerRecordDisposition() {}
        });
        assert.equal(prepared.identity.paperId, paper.arxivId);
        assert.equal(prepared.identity.freshAnalysis.runId, plan.runId);
        assert.equal(prepared.identity.sourceSha256, paper.sourceSha256);
        assert.deepEqual(fs.readdirSync(directory).sort(), before);
        assert.equal(models, 0);
    });
});
test('实际输入改变和来源字节变化不能借旧失败稿开新轮', async t => {
    const f = setup(t);
    await f.locked(() => {
        const changed = { ...f.identity, inputFingerprint: 'f'.repeat(64) };
        const grant = { ...f.grant, identitySha256: repair.hashDraft(changed) };
        repair.saveFailedCandidate(directory, changed, f.payload);
        assert.throws(() => retry.withExplicitRound(paper, grant, () =>
            retry.beginExplicitRound(directory, changed, f.payload, paper)), /完整实际输入已变化/);
        assert.ok(!fs.existsSync(path.join(directory, 'explicit-retry-rounds')));
        assert.equal(sha(fs.readFileSync(f.file)), f.grant.envelopeSha256);
        assert.throws(() => retry.withExplicitRound(paper,
            { ...f.grant, sourceFiles: { ...f.grant.sourceFiles, 'source.pdf': 'a'.repeat(64) } }, () => {}), /四份来源 SHA/);
        assert.throws(() => retry.withExplicitRound(paper,
            { ...f.grant, runId: crypto.randomUUID() }, () => {}), /批次或运行/);
    });
});
test('原身份与最终身份分开绑定，只接已有公有实现恢复来源和实现变更记录', async t => {
    const f = setup(t, payload => {
        payload.implementationRepairAllowanceLineage = repair.IMPLEMENTATION_ALLOWANCE_LINEAGE_CONTRACT;
        payload.consumedImplementationAllowanceSha256 = ['a'.repeat(64)];
    });
    await daily.withDailyFreshAnalysisContext(plan, () => daily.withDailyFreshPaperSource(plan, paper,
        () => engine.withPaperAnalysisLock(paper, () => {
            const current = { ...f.identity, parserImplementationSha256: 'f'.repeat(64) };
            const revision = require('../scripts/lib/reader-recovery-revision');
            const recovered = revision.loadReaderRecoveryRevision(directory, current);
            assert.ok(recovered);
            assert.equal(recovered.attempts, 6);
            assert.equal(recovered.implementationRepairAllowanceProof, null);
            const grant = { ...f.grant, identitySha256: repair.hashDraft(current) };
            const next = retry.withExplicitRound(paper, grant, () =>
                retry.beginExplicitRound(directory, current, recovered, paper));
            const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
            assert.equal(sha(fs.readFileSync(receipt.archivedFile)), f.grant.envelopeSha256);
            assert.equal(receipt.grant.originalIdentitySha256, repair.hashDraft(f.identity));
            assert.equal(receipt.grant.identitySha256, repair.hashDraft(current));
            assert.equal(next.attempts, 0);
        })), { refreshReaderDiagnostics: true });
});


test('模型返回后保存前中断仍累计请求账，8000 token 恢复最多六次传输', async t => {
    const f = setup(t);
    let responses = 0;
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        const utils = require('../scripts/utils');
        const invoke = () => retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, () =>
            utils.requestLlmJson('https://example.invalid/v1/chat/completions',
                'https://example.invalid/v1', 'test-model', { max_tokens: 8000, messages: [] }, {}, {
                    usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' }, usageSink: () => {},
                    transportRequestFn: async () => {
                        responses += 1;
                        return { statusCode: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } };
                    }
                }));
        for (let index = 0; index < 6; index += 1) {
            await invoke();
            // 模拟返回后保存前中断：重新读取已保存稿，不保存本次响应。
            const persisted = repair.loadFailedCandidate(directory, f.identity);
            assert.equal(persisted.attempts, 0);
            retry.validatePersistedRound(directory, f.identity, persisted);
        }
        await assert.rejects(invoke(), /实际请求或输出预算耗尽/);
        const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
        assert.equal(responses, 6);
        assert.equal(receipt.physicalRequests, 6);
        assert.equal(receipt.reservedOutputTokens, 48000);
    }));
});

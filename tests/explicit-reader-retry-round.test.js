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
        assert.throws(() => retry.beginExplicitRound(directory, { ...f.identity, inputFingerprint: '0'.repeat(64) }, stored, paper), /当前输入与重试许可不一致/);
    }));
});
test('新轮输入不符只检查一次，保留原稿且不开新轮', async t => {
    const f = setup(t);
    let attempts = 0;
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const result = await engine.analyzePaperWithRetry(structuredClone(paper), {
            maxRetries: 2, retryDelayMs: 0,
            analyzeFn: async () => {
                attempts++;
                return retry.beginExplicitRound(directory,
                    { ...f.identity, inputFingerprint: '0'.repeat(64) }, f.payload, paper);
            }
        });
        assert.equal(result.success, false);
        assert.equal(attempts, 1);
        assert.equal(result.result.latestAnalysisAttemptErrorCode, 'READER_RETRY_INPUT_MISMATCH');
        assert.equal(result.result.latestAnalysisAttemptRetryable, false);
        assert.equal(result.result.latestAnalysisAttemptErrorScope, 'paper');
        assert.match(result.error, /当前输入/);
        assert.equal(sha(fs.readFileSync(f.file)), f.grant.envelopeSha256);
        assert.equal(fs.existsSync(path.join(directory, 'explicit-retry-rounds')), false);
    }));
});
test('新轮拒绝分别说明论文不符和已完成，均保留原稿', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, () => {
        assert.throws(() => retry.beginExplicitRound(directory, f.identity, f.payload,
            { ...paper, arxivId: '2610.90072v1' }), error =>
            error.code === 'READER_RETRY_PAPER_MISMATCH' && error.retryable === false);
        t.mock.method(engine, 'isSuccessfulAnalysisRecord', () => true);
        assert.throws(() => retry.beginExplicitRound(directory, f.identity, f.payload, paper), error =>
            error.code === 'READER_RETRY_ALREADY_COMPLETE' && error.retryable === false);
        assert.equal(sha(fs.readFileSync(f.file)), f.grant.envelopeSha256);
        assert.equal(fs.existsSync(path.join(directory, 'explicit-retry-rounds')), false);
    }));
});
test('真实公共传输层最多6次，拒绝发生在第7次传输之前', async t => {
    const f = setup(t);
    let transports = 0;
    const usage = [];
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        await retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, async () => {
            const utils = require('../scripts/utils');
            const send = () => utils.requestLlmJson('https://example.invalid/v1/chat/completions',
                'https://example.invalid/v1', 'test-model', { max_tokens: 100, messages: [] }, {}, {
                    usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' }, usageSink: event => usage.push(event),
                    transportRequestFn: async () => {
                        transports += 1;
                        return { statusCode: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } };
                    }
                });
            for (let i = 0; i < 6; i += 1) await send();
            await assert.rejects(send(), /实际请求或输出预算耗尽/);
            assert.equal(transports, 6);
            assert.equal(usage.length, 7);
            assert.ok(usage.slice(0, 6).every(event => event.transportStarted === true));
            assert.equal(usage[6].transportStarted, false);
            assert.equal(usage[6].outcome, 'blocked_before_transport');
            assert.equal(usage[6].errorCode, 'READER_EXPLICIT_ROUND_BUDGET_EXHAUSTED');
            const summary = require('../scripts/lib/llm-usage').summarizeLlmUsage(usage).groups[0];
            assert.equal(summary.requests, 7);
            assert.equal(summary.blockedBeforeTransport, 1);
            assert.equal(summary.transportErrors, 0);
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


test('本地新轮预算耗尽经真实公共模型入口立即停止，零传输且零重试等待', async t => {
    const utils = require('../scripts/utils');
    const deep = require('../scripts/deep-analyzer');
    for (const budget of ['requests', 'tokens']) {
        const f = setup(t);
        let transports = 0;
        let logicalRequests = 0;
        let retryWaits = 0;
        await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
            const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
            await retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, async () => {
                const context = { paperId: paper.arxivId, stage: 'apiReaderRepair' };
                for (let i = 0; i < (budget === 'requests' ? 6 : 2); i += 1) {
                    // 持久登记此前可能已发送但未保存响应的请求，不退回额度。
                    retry.consumePhysicalRequest({ max_tokens: budget === 'requests' ? 100 : 40000 }, { usageContext: context });
                }
                const transport = async () => { transports += 1; throw new Error('耗尽后不应进入传输'); };
                const send = (url, endpoint, model, body, headers, options) => utils.requestLlmJson(
                    url, endpoint, model, body, headers, { ...options, usageContext: context, usageSink() {}, transportRequestFn: transport }
                );
                const terminal = error => error.code === 'READER_EXPLICIT_ROUND_BUDGET_EXHAUSTED'
                    && error.retryable === false && error.scope === 'paper';
                await assert.rejects(send('https://example.invalid/v1/chat/completions',
                    'https://example.invalid/v1', 'test-model', { max_tokens: 100 }, {}, {}), terminal);
                const originalTimer = global.setTimeout;
                global.setTimeout = (callback, milliseconds, ...args) => {
                    if (milliseconds >= 10000 && milliseconds <= 30000) {
                        retryWaits += 1;
                        throw new Error('本地预算错误不能等待网络重试');
                    }
                    return originalTimer(callback, milliseconds, ...args);
                };
                try {
                    await assert.rejects(deep.callModelWithConfig([], 100, 3, {
                        endpoint: 'https://example.invalid/v1', model: 'test-model', key: 'test-only',
                        overallTimeoutMs: 60000, usageContext: context,
                        requestFn: (...args) => { logicalRequests += 1; return send(...args); }
                    }), terminal);
                } finally {
                    global.setTimeout = originalTimer;
                }
                assert.equal(logicalRequests, 1);
                assert.equal(transports, 0);
                assert.equal(retryWaits, 0);
            });
        }));
    }
});


test('已开始的新轮公共实现迁移保原许可与64000预算，只能继续剩余16000', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        const proof = next.explicitReaderRetryRound;
        const receiptBefore = fs.readFileSync(proof.receiptFile);
        await retry.withPhysicalBudget(proof, paper, () => {
            for (let i = 0; i < 2; i += 1) retry.consumePhysicalRequest({ max_tokens: 32000 }, {
                usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' }
            });
        });
        repair.saveFailedCandidate(directory, f.identity, { ...next, attempts: 2, fullAttempts: 1 });
        const chargedReceipt = fs.readFileSync(proof.receiptFile);
        const current = { ...f.identity, parserImplementationSha256: 'f'.repeat(64) };
        const revised = await daily.withDailyFreshAnalysisContext(plan, () =>
            require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(directory, current),
            { refreshReaderDiagnostics: true });
        assert.ok(revised);
        assert.equal(revised.attempts, 2);
        assert.equal(revised.fullAttempts, 1);
        assert.equal(revised.implementationRepairAllowanceProof, null);
        assert.deepEqual(revised.explicitReaderRetryRound, proof);
        assert.deepEqual(fs.readFileSync(proof.receiptFile), chargedReceipt);
        assert.equal(sha(fs.readFileSync(JSON.parse(receiptBefore).archivedFile)), f.grant.envelopeSha256);
        assert.equal(repair.loadFailedCandidate(directory, current).attempts, 2);
        await retry.withPhysicalBudget(proof, paper, async () => {
            let transports = 0;
            const request = tokens => require('../scripts/utils').requestLlmJson(
                'https://example.invalid/v1/chat/completions', 'https://example.invalid/v1', 'test-model',
                { max_tokens: tokens, messages: [] }, {}, {
                    usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' }, usageSink() {},
                    transportRequestFn: async () => {
                        transports += 1;
                        return { statusCode: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } };
                    }
                });
            await request(16000);
            repair.saveFailedCandidate(directory, current, { ...revised, attempts: 3 });
            await assert.rejects(request(1), error => error.code === 'READER_EXPLICIT_ROUND_BUDGET_EXHAUSTED');
            assert.equal(transports, 1);
        });
    }));
});

test('三次内容一次完整及80000已耗尽的新轮再迁移不获额外实现许可', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        const proof = next.explicitReaderRetryRound;
        await retry.withPhysicalBudget(proof, paper, () => retry.consumePhysicalRequest({ max_tokens: 80000 }, {
            usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' }
        }));
        repair.saveFailedCandidate(directory, f.identity, { ...next, attempts: 3, fullAttempts: 1 });
        const current = { ...f.identity, parserImplementationSha256: 'e'.repeat(64) };
        const revised = await daily.withDailyFreshAnalysisContext(plan, () =>
            require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(directory, current),
            { refreshReaderDiagnostics: true });
        assert.equal(revised.attempts, 3);
        assert.equal(revised.fullAttempts, 1);
        assert.equal(revised.implementationRepairAllowanceProof, null);
        const second = { ...current, parserImplementationSha256: 'd'.repeat(64) };
        const twice = await daily.withDailyFreshAnalysisContext(plan, () =>
            require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(directory, second),
            { refreshReaderDiagnostics: true });
        assert.equal(twice.attempts, 3);
        retry.validatePersistedRound(directory, second, twice);
        await retry.withPhysicalBudget(proof, paper, () => assert.throws(() => retry.consumePhysicalRequest({ max_tokens: 1 }, {
            usageContext: { paperId: paper.arxivId, stage: 'apiReaderRepair' }
        }), error => error.retryable === false));
    }));
});


test('新轮实现恢复拒绝坏原档、断链、别轮证明与真实输入变化', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        repair.saveFailedCandidate(directory, f.identity, { ...next, attempts: 1, fullAttempts: 1, transportFailures: 2 });
        const current = { ...f.identity, parserImplementationSha256: 'c'.repeat(64) };
        const revised = await daily.withDailyFreshAnalysisContext(plan, () =>
            require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(directory, current),
            { refreshReaderDiagnostics: true });
        const last = revised.readerRecoveryRevisions.at(-1);
        const archive = path.join(directory, last.archivedName);
        const bytes = fs.readFileSync(archive);
        fs.writeFileSync(archive, Buffer.concat([bytes, Buffer.from(' ')]));
        assert.throws(() => retry.validatePersistedRound(directory, current, revised), /改变实际输入/);
        fs.writeFileSync(archive, bytes);
        for (const mutation of [
            value => { value.readerRecoveryRevisions = []; },
            value => { value.readerRecoveryRevisions.at(-1).runId = crypto.randomUUID(); },
            value => { value.readerRecoveryRevisions.at(-1).oldEnvelopeSha256 = '0'.repeat(64); },
            value => { value.readerRecoveryRevisions.at(-1).changedFields = ['model']; },
            value => { value.transportFailures = 1; }
        ]) {
            const altered = structuredClone(revised);
            mutation(altered);
            assert.throws(() => retry.validatePersistedRound(directory, current, altered), /Reader 新轮/);
        }
        for (const changed of [
            { ...current, inputFingerprint: '1'.repeat(64) },
            { ...current, readerRecoveryEpochSha256: '2'.repeat(64) },
            { ...current, sourceSha256: '3'.repeat(64) },
            { ...current, model: { changed: true } }
        ]) assert.throws(() => retry.validatePersistedRound(directory, changed, revised), /Reader 新轮/);
        const beforeReceipt = fs.readFileSync(next.explicitReaderRetryRound.receiptFile);
        retry.validatePersistedRound(directory, current, revised);
        assert.deepEqual(fs.readFileSync(next.explicitReaderRetryRound.receiptFile), beforeReceipt);
    }));
});


test('请求先登记而响应未保存的中断，公共迁移不退还48000预留', async t => {
    const f = setup(t);
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        await retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, () => retry.consumePhysicalRequest(
            { max_tokens: 48000 }, { usageContext: { paperId: paper.arxivId, stage: 'apiReaderArticle' } }
        ));
        const receiptBefore = fs.readFileSync(next.explicitReaderRetryRound.receiptFile);
        const current = { ...f.identity, parserImplementationSha256: 'b'.repeat(64) };
        const revised = await daily.withDailyFreshAnalysisContext(plan, () =>
            require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(directory, current),
            { refreshReaderDiagnostics: true });
        assert.equal(revised.attempts, 0);
        assert.equal(revised.fullAttempts, 0);
        assert.equal(revised.implementationRepairAllowanceProof, null);
        assert.deepEqual(fs.readFileSync(next.explicitReaderRetryRound.receiptFile), receiptBefore);
        let transports = 0;
        await retry.withPhysicalBudget(revised.explicitReaderRetryRound, paper, () => assert.rejects(
            require('../scripts/utils').requestLlmJson('https://example.invalid/v1/chat/completions',
                'https://example.invalid/v1', 'test-model', { max_tokens: 48000 }, {}, {
                    usageContext: { paperId: paper.arxivId, stage: 'apiReaderArticle' }, usageSink() {},
                    transportRequestFn: async () => { transports += 1; throw Error('不应传输'); }
                }), error => error.code === 'READER_EXPLICIT_ROUND_BUDGET_EXHAUSTED'
        ));
        assert.equal(transports, 0);
        assert.equal(JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile)).reservedOutputTokens, 48000);
    }));
});

test('新轮只允许已审V9到固定V10修复能力，未知提示词升级仍拒', async t => {
    const previous = oldEnvelope.identity;
    oldEnvelope.identity = { ...previous,
        promptSha256: 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380',
        repairPromptSha256: '5164ce17261a13a009c34bfcf8a71fc2c44f1ae2246f0651de5eda82a7645f65' };
    const f = setup(t);
    oldEnvelope.identity = previous;
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        const revision = require('../scripts/lib/reader-recovery-revision');
        const unknown = { ...f.identity, repairPromptSha256: 'a'.repeat(64) };
        assert.equal(await daily.withDailyFreshAnalysisContext(plan, () =>
            revision.loadReaderRecoveryRevision(directory, unknown), { refreshReaderDiagnostics: true }), null);
        const allowed = { ...f.identity,
            repairPromptSha256: 'f50f85a04017de568f8225e97d7b4e230ae40b969d99266afcef045e011829a4' };
        const revised = await daily.withDailyFreshAnalysisContext(plan, () =>
            revision.loadReaderRecoveryRevision(directory, allowed), { refreshReaderDiagnostics: true });
        assert.ok(revised);
        assert.equal(revised.implementationRepairAllowanceProof, null);
        assert.deepEqual(revised.explicitReaderRetryRound, next.explicitReaderRetryRound);
        assert.equal(revised.attempts, 0);
        assert.equal(revised.fullAttempts, 0);
    }));
});

function createReaderTestArticle() {
    const kinds = ['background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const draft = { version: 3, readerTitle: '从声音输入到执行输出的机制解释',
        oneSentenceThesis: '语音方法依次处理输入表征与条件约束，实验需保持对照设置一致，再解释指标变化支持的有限结论。',
        sections: kinds.map((kind, index) => ({ kind, heading: `声音处理中步骤 ${index + 1} 的输入输出如何衔接？`,
            body: `这一部分解释声音处理的${kind}环节，先限定输入信号，再描述信息如何沿组件传递。`.repeat(6) })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: ['声学表示', '语义条件'], sectionKind: 'method_overview',
            marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            explanation: '声学表示保存输入信号的发音结构，语义条件限定合理的内容范围，两者分工使预测既遵循声音证据也满足当前任务约束。'
        })), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    draft.sections[3].body += '\n\n' + draft.conceptBridges.map(item => item.marker).join('\n\n');
    return draft;
}

test('新轮保留完整原稿，真实 Reader 首次请求走局部修复，原次数和账不重置', async t => {
    const deep = require('../scripts/deep-analyzer');
    const draft = createReaderTestArticle();
    draft.readerTitle = '短';
    const raw = JSON.stringify(draft, null, 2);
    const f = setup(t, p => { p.draft = draft; p.rawDraft = raw; p.ephemeralImageEvidence = { imageEvidence: [], directSupplementaryEvidence: [] }; });
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        const source = daily.readDailyFreshSource(plan, paper);
        const stages = [];
        const stop = Object.assign(new Error('实际局部请求受控停止'), { retryable: false, scope: 'run' });
        const options = { sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
            readerAttemptsDir: directory, readerMaterializeFigures: async () => [],
            readerRecordDisposition: () => {},
            readerCallModel: async (_messages, _budget, request) => {
                stages.push(request.usageContext.stage);
                throw stop;
            } };
        const prepared = await deep.prepareApiReaderRetryIdentity(paper, paper.analysisCheckpoint, '', options);
        fs.unlinkSync(f.file);
        repair.saveFailedCandidate(directory, prepared.identity, f.payload);
        const file = path.join(directory, repair.hashDraft(prepared.identity) + '.json');
        f.grant.identitySha256 = repair.hashDraft(prepared.identity);
        f.grant.originalIdentitySha256 = f.grant.identitySha256;
        f.grant.envelopeSha256 = sha(fs.readFileSync(file));
        await retry.withExplicitRound(paper, f.grant, async () => {
            await assert.rejects(deep.generateApiReaderArticleDetailed(paper, paper.analysisCheckpoint, '', options), /实际局部请求受控停止/);
            assert.deepEqual(stages, ['apiReaderRepair']);
            const saved = repair.loadFailedCandidate(directory, prepared.identity);
            const receipt = JSON.parse(fs.readFileSync(saved.explicitReaderRetryRound.receiptFile));
            assert.equal(receipt.oldAttempts, 6);
            assert.equal(receipt.oldFullAttempts, 2);
            assert.equal(sha(fs.readFileSync(receipt.archivedFile)), f.grant.envelopeSha256);
            assert.equal(saved.fullAttempts, 0);
            assert.equal(saved.rawDraft, raw);
        });
    }));
});

async function setupExhaustedParent(t, tokensUsed = [48000, 16000, 16000], savedAttempts = tokensUsed.length) {
    const draft = createReaderTestArticle();
    draft.readerTitle = '短';
    const raw = JSON.stringify(draft, null, 2);
    const f = setup(t, p => {
        p.draft = draft;
        p.rawDraft = raw;
        p.ephemeralImageEvidence = { imageEvidence: [], directSupplementaryEvidence: [] };
    });
    let parent;
    await f.locked(() => retry.withExplicitRound(paper, f.grant, async () => {
        parent = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        await retry.withPhysicalBudget(parent.explicitReaderRetryRound, paper, async () => {
            for (const tokens of tokensUsed) {
                await sendLocalRepairRequest(paper, tokens, tokens === 48000 ? 'apiReaderArticle' : 'apiReaderRepair');
            }
        });
        parent = { ...parent, attempts: savedAttempts, fullAttempts: 1 };
        repair.saveFailedCandidate(directory, f.identity, parent);
    }));
    const parentReceipt = fs.readFileSync(parent.explicitReaderRetryRound.receiptFile);
    const file = path.join(directory, repair.hashDraft(f.identity) + '.json');
    const childGrant = { ...f.grant, contract: retry.LOCAL_REPAIR_CONTRACT,
        roundId: crypto.randomUUID(), parentRoundId: f.grant.roundId,
        parentReceiptSha256: sha(parentReceipt), envelopeSha256: sha(fs.readFileSync(file)),
        payloadSha256: repair.hashDraft(parent), maxResponses: 1, maxFullResponses: 0,
        maxPhysicalRequests: 2, maxReservedOutputTokens: 32000 };
    return { ...f, parent, parentReceipt, childGrant, raw };
}
test('首次经真实长文入口开始父轮局部修复，不丢原稿或请求全文', async t => {
    const deep = require('../scripts/deep-analyzer');
    const draft = createReaderTestArticle();
    draft.readerTitle = '短';
    const raw = JSON.stringify(draft);
    const f = setup(t, p => {
        p.draft = draft; p.rawDraft = raw;
        p.ephemeralImageEvidence = { imageEvidence: [], directSupplementaryEvidence: [] };
    });
    await f.locked(async () => {
        const source = daily.readDailyFreshSource(plan, paper);
        const stages = [];
        const stop = Object.assign(new Error('首次局部调用受控停止'), { retryable: false, scope: 'run' });
        const options = { sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
            readerAttemptsDir: directory, readerMaterializeFigures: async () => [],
            readerRecordDisposition: () => {}, readerCallModel: async (_messages, _budget, request) => {
                stages.push(request.usageContext.stage); throw stop;
            } };
        const { identity } = await deep.prepareApiReaderRetryIdentity(paper, paper.analysisCheckpoint, '', options);
        fs.unlinkSync(f.file);
        repair.saveFailedCandidate(directory, identity, f.payload);
        const file = path.join(directory, repair.hashDraft(identity) + '.json');
        f.grant.identitySha256 = repair.hashDraft(identity);
        f.grant.originalIdentitySha256 = f.grant.identitySha256;
        f.grant.envelopeSha256 = sha(fs.readFileSync(file));
        let parent;
        await retry.withExplicitRound(paper, f.grant, async () => {
            parent = retry.beginExplicitRound(directory, identity, f.payload, paper);
            await retry.withPhysicalBudget(parent.explicitReaderRetryRound, paper, async () => {
                for (const tokens of [48000, 16000, 16000]) {
                    await sendLocalRepairRequest(paper, tokens, tokens === 48000 ? 'apiReaderArticle' : 'apiReaderRepair');
                }
            });
            parent = { ...parent, attempts: 3, fullAttempts: 1 };
            repair.saveFailedCandidate(directory, identity, parent);
        });
        const parentReceipt = fs.readFileSync(parent.explicitReaderRetryRound.receiptFile);
        const originalBytes = fs.readFileSync(file);
        const child = { ...f.grant, contract: retry.LOCAL_REPAIR_CONTRACT,
            roundId: crypto.randomUUID(), parentRoundId: f.grant.roundId,
            parentReceiptSha256: sha(parentReceipt), envelopeSha256: sha(originalBytes),
            payloadSha256: repair.hashDraft(parent), maxResponses: 1, maxFullResponses: 0,
            maxPhysicalRequests: 2, maxReservedOutputTokens: 32000 };
        await retry.withExplicitLocalRepairRound(paper, child, async () => {
            await assert.rejects(deep.generateApiReaderArticleDetailed(paper, paper.analysisCheckpoint, '', options), /首次局部调用受控停止/);
        });
        assert.deepEqual(stages, ['apiReaderRepair']);
        assert.deepEqual(fs.readFileSync(parent.explicitReaderRetryRound.receiptFile), parentReceipt);
        const saved = repair.loadFailedCandidate(directory, identity);
        assert.equal(saved.explicitReaderRetryRound.roundId, child.roundId);
        assert.equal(saved.fullAttempts, 0);
        assert.equal(saved.rawDraft, raw);
        const receipt = JSON.parse(fs.readFileSync(saved.explicitReaderRetryRound.receiptFile));
        assert.deepEqual(fs.readFileSync(receipt.archivedFile), originalBytes);
        assert.equal(receipt.oldAttempts, 3);
        assert.equal(receipt.oldFullAttempts, 1);
    });
});
function sendLocalRepairRequest(paper, tokens, stage = 'apiReaderRepair', transport = async () => ({
    statusCode: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }
})) {
    return require('../scripts/utils').requestLlmJson('https://example.invalid/v1/chat/completions',
        'https://example.invalid/v1', 'test-model', { max_tokens: tokens, messages: [] }, {}, {
            usageContext: { paperId: paper.arxivId, stage }, usageSink() {}, transportRequestFn: transport
        });
}
test('父轮局部修复真实请求最多2次32k，父80k账与原稿字节不动，全文0传输', async t => {
    const f = await setupExhaustedParent(t);
    await f.locked(() => retry.withExplicitLocalRepairRound(paper, f.childGrant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.parent, paper);
        assert.equal(next.rawDraft, f.raw);
        assert.equal(next.explicitReaderRetryRound.maxResponses, 1);
        assert.equal(next.explicitReaderRetryRound.maxFullResponses, 0);
        let actual = 0;
        await retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, async () => {
            const transport = async () => {
                actual += 1;
                return { statusCode: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } };
            };
            await assert.rejects(sendLocalRepairRequest(paper, 48000, 'apiReaderArticle', transport),
                error => error.code === 'READER_LOCAL_REPAIR_FULL_REQUEST_FORBIDDEN' && error.retryable === false);
            assert.equal(actual, 0);
            await sendLocalRepairRequest(paper, 16000, 'apiReaderRepair', transport);
            await sendLocalRepairRequest(paper, 16000, 'apiReaderRepair', transport);
            await assert.rejects(sendLocalRepairRequest(paper, 1, 'apiReaderRepair', transport),
                error => error.code === 'READER_EXPLICIT_ROUND_BUDGET_EXHAUSTED');
            assert.equal(actual, 2);
        });
        assert.deepEqual(fs.readFileSync(f.parent.explicitReaderRetryRound.receiptFile), f.parentReceipt);
        const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
        assert.equal(receipt.oldAttempts, 3);
        assert.equal(receipt.oldFullAttempts, 1);
        assert.equal(sha(fs.readFileSync(receipt.archivedFile)), f.childGrant.envelopeSha256);
        assert.throws(() => repair.saveFailedCandidate(directory, f.identity, { ...next, fullAttempts: 1 }), /正文预算/);
        repair.saveFailedCandidate(directory, f.identity, { ...next, attempts: 1 });
        assert.throws(() => repair.saveFailedCandidate(directory, f.identity, { ...next, attempts: 2 }), /正文预算/);
    }));
});
test('父轮证据变化与同父第二授权拒绝，普通恢复续子轮，不重复安装', async t => {
    const f = await setupExhaustedParent(t);
    await f.locked(() => {
        assert.throws(() => retry.withExplicitLocalRepairRound(paper,
            { ...f.childGrant, parentReceiptSha256: '0'.repeat(64) }, () =>
                retry.beginExplicitRound(directory, f.identity, f.parent, paper)), /父轮调用记录已变化/);
        const next = retry.withExplicitLocalRepairRound(paper, f.childGrant, () =>
            retry.beginExplicitRound(directory, f.identity, f.parent, paper));
        assert.equal(retry.beginExplicitRound(directory, f.identity, next, paper), null);
        assert.throws(() => retry.withExplicitLocalRepairRound(paper,
            { ...f.childGrant, roundId: crypto.randomUUID() }, () =>
                retry.beginExplicitRound(directory, f.identity, next, paper)), /另一局部修复轮/);
        assert.deepEqual(fs.readFileSync(f.parent.explicitReaderRetryRound.receiptFile), f.parentReceipt);
    });
});
test('请求返回但子稿尚未保存的崩溃保留16k，恢复只续剩余16k', async t => {
    const f = await setupExhaustedParent(t);
    await f.locked(() => retry.withExplicitLocalRepairRound(paper, f.childGrant, async () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.parent, paper);
        await retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, () => sendLocalRepairRequest(paper, 16000));
        const restored = repair.loadFailedCandidate(directory, f.identity);
        assert.equal(restored.attempts, 0);
        assert.equal(retry.beginExplicitRound(directory, f.identity, restored, paper), null);
        await retry.withPhysicalBudget(restored.explicitReaderRetryRound, paper, async () => {
            let actual = 0;
            const transport = async () => {
                actual += 1;
                return { statusCode: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } };
            };
            await sendLocalRepairRequest(paper, 16000, 'apiReaderRepair', transport);
            await assert.rejects(sendLocalRepairRequest(paper, 1, 'apiReaderRepair', transport), /预算耗尽/);
            assert.equal(actual, 1);
        });
        assert.deepEqual(fs.readFileSync(f.parent.explicitReaderRetryRound.receiptFile), f.parentReceipt);
    }));
});


test('父轮仍有正常余额时拒绝后续授权，不改变原稿和原调用账', async t => {
    const f = await setupExhaustedParent(t, [48000, 16000]);
    await f.locked(() => {
        const before = fs.readFileSync(path.join(directory, repair.hashDraft(f.identity) + '.json'));
        assert.throws(() => retry.withExplicitLocalRepairRound(paper, f.childGrant, () =>
            retry.beginExplicitRound(directory, f.identity, f.parent, paper)), /仍有正常剩余额度/);
        assert.deepEqual(fs.readFileSync(path.join(directory, repair.hashDraft(f.identity) + '.json')), before);
        assert.deepEqual(fs.readFileSync(f.parent.explicitReaderRetryRound.receiptFile), f.parentReceipt);
    });
});

test('父轮实际80k耗尽但保存逻辑仅一次时允许局部轮，保留真实1次旧计数', async t => {
    const f = await setupExhaustedParent(t, [48000, 16000, 16000], 1);
    const currentFile = path.join(directory, repair.hashDraft(f.identity) + '.json');
    f.childGrant.envelopeSha256 = sha(fs.readFileSync(currentFile));
    f.childGrant.payloadSha256 = repair.hashDraft(f.parent);
    await f.locked(() => retry.withExplicitLocalRepairRound(paper, f.childGrant, () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.parent, paper);
        assert.equal(next.attempts, 0);
        assert.equal(next.fullAttempts, 0);
        assert.equal(next.rawDraft, f.raw);
        const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
        assert.equal(receipt.oldAttempts, 1);
        assert.equal(receipt.oldFullAttempts, 1);
        assert.deepEqual(fs.readFileSync(f.parent.explicitReaderRetryRound.receiptFile), f.parentReceipt);
    }));
});

test('内存中恢复原始文章后，仍按磁盘原记录SHA核验新轮许可', async t => {
    const draft = { version: 3, readerTitle: '受控原稿', oneSentenceThesis: '保留原稿。',
        sections: Array.from({ length: 37 }, () => ({ kind: 'result', heading: '原文结果', body: '来源报告。'.repeat(30) })),
        conceptBridges: Array.from({ length: 4 }, () => ({})), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    const f = setup(t, payload => { payload.rawDraft = JSON.stringify(draft); });
    await f.locked(() => retry.withExplicitRound(paper, f.grant, () => {
        const recovered = require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(directory, f.identity);
        assert.deepEqual(recovered.draft, draft);
        assert.notEqual(repair.hashDraft(recovered), f.grant.payloadSha256);
        const next = retry.beginExplicitRound(directory, f.identity, recovered, paper);
        const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
        assert.equal(sha(fs.readFileSync(receipt.archivedFile)), f.grant.envelopeSha256);
        assert.equal(receipt.oldAttempts, 6);
        assert.equal(receipt.oldFullAttempts, 2);
        assert.equal(retry.beginExplicitRound(directory, f.identity, next, paper), null);
    }));
});

const parentRecovery = require('../scripts/lib/reader-parent-recovery');
function bindPlannerPaper() {
    paper.analysisManifest.sourceAcquisition = { ...(paper.analysisManifest.sourceAcquisition || {}), sourceSha256: paper.sourceSha256 };
}

test('已用一补丁的旧局部子轮可显式追加至三轮，原账不变且第四轮拒绝', async t => {
    const f = await setupExhaustedParent(t);
    bindPlannerPaper();
    let previous;
    await f.locked(() => retry.withExplicitLocalRepairRound(paper, f.childGrant, async () => {
        previous = retry.beginExplicitRound(directory, f.identity, f.parent, paper);
        await retry.withPhysicalBudget(previous.explicitReaderRetryRound, paper, () => sendLocalRepairRequest(paper, 16000));
        previous = { ...previous, attempts: 1 };
        repair.saveFailedCandidate(directory, f.identity, previous);
    }));
    const originalParent = fs.readFileSync(f.parent.explicitReaderRetryRound.receiptFile);
    const originalChild = fs.readFileSync(previous.explicitReaderRetryRound.receiptFile);
    for (const depth of [2, 3]) {
        const manifest = parentRecovery.planParentRecoveryManifest([{ directory, identity: f.identity, paper, plan, mode: 'local' }]);
        assert.equal(manifest.installs, 0);
        assert.equal(manifest.modelRequests, 0);
        assert.equal(manifest.budget.newReservedOutputTokens, 96000);
        assert.equal(manifest.budget.priorReservedOutputTokens, depth === 2 ? 96000 : 176000);
        const grant = manifest.rounds[0];
        assert.equal(grant.chainDepth, depth);
        assert.equal(fs.existsSync(path.join(directory, 'explicit-retry-rounds', grant.roundId + '.json')), false);
        const before = fs.readFileSync(path.join(directory, repair.hashDraft(f.identity) + '.json'));
        assert.equal(grant.envelopeSha256, sha(before));
        await f.locked(() => retry.withExplicitRound(paper, grant, async () => {
            const next = retry.beginExplicitRound(directory, f.identity, previous, paper);
            let calls = 0;
            await retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, async () => {
                await assert.rejects(sendLocalRepairRequest(paper, 48000, 'apiReaderArticle'), /不允许全文请求/);
                for (const tokens of [16000, 32000, 32000]) await sendLocalRepairRequest(paper, tokens, 'apiReaderRepair', async () => {
                    calls++;
                    return { statusCode: 200, body: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } };
                });
            });
            assert.equal(calls, 3);
            previous = { ...next, attempts: 3 };
            repair.saveFailedCandidate(directory, f.identity, previous);
            assert.equal(retry.beginExplicitRound(directory, f.identity, previous, paper), null);
        }));
    }
    assert.deepEqual(fs.readFileSync(f.parent.explicitReaderRetryRound.receiptFile), originalParent);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'explicit-retry-rounds', f.childGrant.roundId + '.json')), originalChild);
    assert.throws(() => parentRecovery.planParentRecovery({ directory, identity: f.identity, paper, plan, mode: 'local' }), /上限|深度/);
});

test('缺sections父稿的只读完整再生计划绑定原账原因，首次真实入口只增加新轮的一次全文请求', async t => {
    const deep = require('../scripts/deep-analyzer');
    const raw = JSON.stringify({ version: 3, readerTitle: '父失败稿', oneSentenceThesis: '未收到正文。', conceptBridges: [] });
    const issues = [{ path: null, message: '读者文章顶层 缺少字段: sections, figurePlacements, tableBindings, formulaBindings' }];
    const f = setup(t, payload => { payload.rawDraft = raw; payload.issues = issues; });
    bindPlannerPaper();
    let identity, parent;
    const stages = [];
    await f.locked(async () => {
        const source = daily.readDailyFreshSource(plan, paper);
        const options = { sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
            readerAttemptsDir: directory, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
            readerCallModel: async (_messages, tokens, request) => {
                stages.push(request.usageContext.stage);
                await sendLocalRepairRequest(paper, tokens, request.usageContext.stage);
                return raw;
            } };
        identity = (await deep.prepareApiReaderRetryIdentity(paper, paper.analysisCheckpoint, '', options)).identity;
        fs.unlinkSync(f.file);
        repair.saveFailedCandidate(directory, identity, f.payload);
        const file = path.join(directory, repair.hashDraft(identity) + '.json');
        Object.assign(f.grant, { identitySha256: repair.hashDraft(identity), originalIdentitySha256: repair.hashDraft(identity),
            envelopeSha256: sha(fs.readFileSync(file)) });
        await retry.withExplicitRound(paper, f.grant, async () => {
            parent = retry.beginExplicitRound(directory, identity, f.payload, paper);
            await retry.withPhysicalBudget(parent.explicitReaderRetryRound, paper, () => sendLocalRepairRequest(paper, 48000, 'apiReaderArticle'));
            parent = { ...parent, rawDraft: raw, issues, attempts: 1, fullAttempts: 1,
                ephemeralImageEvidence: { imageEvidence: [], directSupplementaryEvidence: [] } };
            repair.saveFailedCandidate(directory, identity, parent);
        });
        const parentBytes = fs.readFileSync(parent.explicitReaderRetryRound.receiptFile);
        const original = fs.readFileSync(file);
        const grant = parentRecovery.planParentRecovery({ directory, identity, paper, plan, mode: 'full' });
        assert.equal(grant.recoveryReason.code, 'missing_sections_full_response');
        assert.equal(grant.recoveryReason.rawDraftSha256, sha(raw));
        assert.deepEqual(fs.readFileSync(file), original);
        assert.deepEqual(fs.readFileSync(parent.explicitReaderRetryRound.receiptFile), parentBytes);
        await retry.withExplicitRound(paper, grant, async () => {
            await assert.rejects(deep.generateApiReaderArticleDetailed(paper, paper.analysisCheckpoint, '', options), /缺少字段/);
        });
        assert.deepEqual(stages, ['apiReaderArticle']);
        assert.deepEqual(fs.readFileSync(parent.explicitReaderRetryRound.receiptFile), parentBytes);
        const saved = repair.loadFailedCandidate(directory, identity);
        const receipt = JSON.parse(fs.readFileSync(saved.explicitReaderRetryRound.receiptFile));
        assert.equal(receipt.physicalRequests, 1);
        assert.equal(receipt.reservedOutputTokens, 48000);
        assert.equal(receipt.oldAttempts, 1);
        assert.equal(receipt.oldFullAttempts, 1);
        assert.deepEqual(fs.readFileSync(receipt.archivedFile), original);
        assert.throws(() => parentRecovery.planParentRecovery({ directory, identity, paper, plan, mode: 'full' }), /整链/);
    });
});

test('有完整稿或原因不明丢失不能偷开完整轮，模式与整链预算不可改', async t => {
    const f = await setupExhaustedParent(t);
    bindPlannerPaper();
    assert.throws(() => parentRecovery.planParentRecovery({ directory, identity: f.identity, paper, plan, mode: 'full' }), /完整再生|父恢复原因/);
    assert.equal(parentRecovery.fullReason({ status: 'failed', draft: null, rawDraft: '无', issues: [] }), null);
    assert.equal(parentRecovery.fullReason({ status: 'failed', draft: null, rawDraft: '{}', issues: [] }), null);
    const grant = parentRecovery.planParentRecovery({ directory, identity: f.identity, paper, plan, mode: 'local' });
    for (const change of [{ maxResponses: 4 }, { chainDepth: 4 }, { chainBudget: { ...grant.chainBudget, maxAdditionalRounds: 99 } }]) {
        assert.throws(() => retry.assertGrant({ ...grant, ...change }), /预算|上限/);
    }
    await f.locked(() => retry.withExplicitRound(paper, { ...grant, parentReceiptSha256: 'a'.repeat(64) }, () => {
        assert.throws(() => retry.beginExplicitRound(directory, f.identity, f.parent, paper), /SHA|身份/);
    }));
    assert.deepEqual(fs.readFileSync(f.parent.explicitReaderRetryRound.receiptFile), f.parentReceipt);
});

test('代码SHA升级经0API公有迁移准备后，真正generate首次追加旧子轮仍只发局部请求', async t => {
    const deep = require('../scripts/deep-analyzer');
    const draft = createReaderTestArticle();
    draft.readerTitle = '短';
    const raw = JSON.stringify(draft);
    const f = setup(t, payload => { payload.draft = draft; payload.rawDraft = raw;
        payload.ephemeralImageEvidence = { imageEvidence: [], directSupplementaryEvidence: [] }; });
    bindPlannerPaper();
    let identity, targetIdentity, options, parent, legacy, parentReceipt, legacyReceipt, originalBytes;
    const stages = [];
    await f.locked(async () => {
        const source = daily.readDailyFreshSource(plan, paper);
        const stop = Object.assign(new Error('追加局部首次请求受控停止'), { retryable: false, scope: 'run' });
        options = { sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
            readerAttemptsDir: directory, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
            readerCallModel: async (_messages, tokens, request) => {
                stages.push(request.usageContext.stage);
                await sendLocalRepairRequest(paper, tokens, request.usageContext.stage);
                throw stop;
            } };
        targetIdentity = (await deep.prepareApiReaderRetryIdentity(paper, paper.analysisCheckpoint, '', options)).identity;
        identity = { ...targetIdentity, parserImplementationSha256: 'd'.repeat(64) };
        fs.unlinkSync(f.file);
        repair.saveFailedCandidate(directory, identity, f.payload);
        const file = path.join(directory, repair.hashDraft(identity) + '.json');
        Object.assign(f.grant, { identitySha256: repair.hashDraft(identity), originalIdentitySha256: repair.hashDraft(identity),
            envelopeSha256: sha(fs.readFileSync(file)) });
        await retry.withExplicitRound(paper, f.grant, async () => {
            parent = retry.beginExplicitRound(directory, identity, f.payload, paper);
            await retry.withPhysicalBudget(parent.explicitReaderRetryRound, paper, async () => {
                for (const tokens of [48000, 16000, 16000]) await sendLocalRepairRequest(paper, tokens, tokens === 48000 ? 'apiReaderArticle' : 'apiReaderRepair');
            });
            parent = { ...parent, attempts: 3, fullAttempts: 1 };
            repair.saveFailedCandidate(directory, identity, parent);
        });
        legacy = { ...f.grant, contract: retry.LOCAL_REPAIR_CONTRACT,
            roundId: crypto.randomUUID(), parentRoundId: f.grant.roundId,
            parentReceiptSha256: sha(fs.readFileSync(parent.explicitReaderRetryRound.receiptFile)),
            envelopeSha256: sha(fs.readFileSync(file)), payloadSha256: repair.hashDraft(parent),
            maxResponses: 1, maxFullResponses: 0, maxPhysicalRequests: 2, maxReservedOutputTokens: 32000 };
        await retry.withExplicitLocalRepairRound(paper, legacy, async () => {
            let previous = retry.beginExplicitRound(directory, identity, parent, paper);
            await retry.withPhysicalBudget(previous.explicitReaderRetryRound, paper, () => sendLocalRepairRequest(paper, 16000));
            previous = { ...previous, attempts: 1 };
            repair.saveFailedCandidate(directory, identity, previous);
            legacyReceipt = fs.readFileSync(previous.explicitReaderRetryRound.receiptFile);
        });
        parentReceipt = fs.readFileSync(parent.explicitReaderRetryRound.receiptFile);
        originalBytes = fs.readFileSync(file);
        assert.equal(fs.existsSync(path.join(directory, repair.hashDraft(targetIdentity) + '.json')), false);
    });
    const prepared = await parentRecovery.prepareParentRecoveryCandidate({ directory, originalIdentity: identity,
        targetIdentity, paper, plan });
    assert.equal(prepared.installs, 0);
    assert.equal(prepared.modelRequests, 0);
    assert.equal(prepared.payload.attempts, 1);
    assert.equal(prepared.payload.fullAttempts, 0);
    assert.equal(prepared.payload.explicitReaderRetryRound.roundId, legacy.roundId);
    const audit = prepared.payload.readerRecoveryRevisions.at(-1);
    assert.deepEqual(fs.readFileSync(path.join(directory, audit.archivedName)), originalBytes);
    await parentRecovery.prepareParentRecoveryCandidate({ directory, originalIdentity: identity, targetIdentity, paper, plan });
    const grant = parentRecovery.planParentRecovery({ directory, identity: targetIdentity, paper, plan, mode: 'local' });
    await f.locked(() => retry.withExplicitRound(paper, grant, async () => {
        await assert.rejects(deep.generateApiReaderArticleDetailed(paper, paper.analysisCheckpoint, '', options), /追加局部首次请求受控停止/);
    }));
    assert.deepEqual(stages, ['apiReaderRepair']);
    assert.deepEqual(fs.readFileSync(parent.explicitReaderRetryRound.receiptFile), parentReceipt);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'explicit-retry-rounds', legacy.roundId + '.json')), legacyReceipt);
    const saved = repair.loadFailedCandidate(directory, targetIdentity);
    const receipt = JSON.parse(fs.readFileSync(saved.explicitReaderRetryRound.receiptFile));
    assert.equal(saved.fullAttempts, 0);
    assert.equal(saved.rawDraft, raw);
    assert.equal(receipt.physicalRequests, 1);
    assert.equal(receipt.reservedOutputTokens, 8000);
    assert.equal(receipt.oldAttempts, 1);
    assert.equal(receipt.oldFullAttempts, 0);
    assert.throws(() => parentRecovery.planParentRecovery({ directory, identity: targetIdentity, paper, plan, mode: 'local', roundId: grant.roundId }), /UUID 已使用/);
    await assert.rejects(parentRecovery.prepareParentRecoveryCandidate({ directory, originalIdentity: identity,
        targetIdentity: { ...targetIdentity, readerRecoveryEpochSha256: 'f'.repeat(64) }, paper, plan }), /epoch/);
});

test('完整sections独立于恢复解析上限判断，过多图和已封装完整JSON都不能开full', () => {
    const draft = createReaderTestArticle();
    draft.figurePlacements = Array.from({ length: 8 }, (_, index) => ({ figureOrdinal: index + 1 }));
    assert.ok(repair.parseRecoveryDraft(draft));
    assert.equal(parentRecovery.fullReason({ status: 'failed', draft: null, rawDraft: JSON.stringify(draft) }), null);
    draft.figurePlacements = Array.from({ length: 17 }, (_, index) => ({ figureOrdinal: index + 1 }));
    assert.equal(repair.parseRecoveryDraft(draft), null);
    const payload = { status: 'failed', draft: null, rawDraft: JSON.stringify(draft),
        issues: [{ message: '读者文章 JSON 无法解析: old diagnostic' }] };
    assert.equal(parentRecovery.fullReason(payload), null);
    payload.rawDraft = '```json\n' + JSON.stringify(draft) + '\n```';
    assert.equal(parentRecovery.fullReason(payload), null);
});

test('旧父轮占位稿从同轮原档恢复，首次真实入口只发16k局部并保留原48k账', async t => {
    const deep = require('../scripts/deep-analyzer');
    const previousBudget = Config.ANALYSIS_CONFIG.apiReaderRepairMaxTokens;
    Config.ANALYSIS_CONFIG.apiReaderRepairMaxTokens = 16000;
    t.after(() => { Config.ANALYSIS_CONFIG.apiReaderRepairMaxTokens = previousBudget; });
    const draft = createReaderTestArticle(); draft.readerTitle = '短';
    const raw = JSON.stringify(draft, null, 2);
    const f = setup(t, p => { p.draft = draft; p.rawDraft = raw; p.ephemeralImageEvidence = { imageEvidence: [], directSupplementaryEvidence: [] }; });
    const source = daily.readDailyFreshSource(plan, paper);
    const options = { sourceText: source.text, structuredArtifacts: source.structuredArtifacts, readerRepairMaxTokens: 16000,
        readerAttemptsDir: directory, readerMaterializeFigures: async () => [], readerRecordDisposition() {} };
    await f.locked(async () => {
        const prepared = await deep.prepareApiReaderRetryIdentity(paper, paper.analysisCheckpoint, '', options);
        fs.unlinkSync(f.file); repair.saveFailedCandidate(directory, prepared.identity, f.payload);
        const file = path.join(directory, repair.hashDraft(prepared.identity) + '.json');
        Object.assign(f.grant, { identitySha256: repair.hashDraft(prepared.identity), originalIdentitySha256: repair.hashDraft(prepared.identity), envelopeSha256: sha(fs.readFileSync(file)) });
        let next;
        await retry.withExplicitRound(paper, f.grant, () => {
            next = retry.beginExplicitRound(directory, prepared.identity, f.payload, paper);
            retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, () => retry.consumePhysicalRequest({ max_tokens: 48000 }, { usageContext: { paperId: paper.arxivId, stage: 'apiReaderArticle' } }));
        });
        const placeholder = { ...next, draft: null, rawDraft: '无', issues: [], transportFailures: 3,
            lastTransportError: '明确 Reader 新轮实际请求或输出预算耗尽' };
        repair.saveFailedCandidate(directory, prepared.identity, placeholder);
        const placeholderBytes = fs.readFileSync(file);
        const receiptFile = next.explicitReaderRetryRound.receiptFile;
        const receiptBefore = fs.readFileSync(receiptFile), receipt = JSON.parse(receiptBefore);
        const originalBytes = fs.readFileSync(receipt.archivedFile);
        const stages = [];
        const stop = Object.assign(new Error('已核实首个16k局部请求'), { retryable: false, scope: 'run' });
        options.readerCallModel = async (messages, tokens, request) => {
            stages.push(request.usageContext.stage);
            assert.equal(tokens, 16000);
            assert.match(JSON.stringify(messages), /从声音输入到执行输出|readerTitle/);
            retry.consumePhysicalRequest({ max_tokens: tokens }, request);
            throw stop;
        };
        await assert.rejects(deep.generateApiReaderArticleDetailed(paper, paper.analysisCheckpoint, '', options), /已核实首个16k局部请求/);
        assert.deepEqual(stages, ['apiReaderRepair']);
        const saved = repair.loadFailedCandidate(directory, prepared.identity);
        assert.equal(saved.attempts, 0); assert.equal(saved.fullAttempts, 0);
        assert.equal(saved.explicitReaderRetryRound.roundId, f.grant.roundId);
        assert.deepEqual(saved.draft, draft); assert.equal(saved.rawDraft, JSON.stringify(draft));
        assert.equal(saved.transportFailures, 4);
        const audit = saved.readerOriginalDraftRestorations[0];
        assert.equal(audit.originalEnvelopeSha256, sha(originalBytes));
        assert.equal(audit.placeholderEnvelopeSha256, sha(placeholderBytes));
        assert.deepEqual(fs.readFileSync(path.join(directory, audit.placeholderArchiveName)), placeholderBytes);
        assert.deepEqual(fs.readFileSync(receipt.archivedFile), originalBytes);
        const paid = JSON.parse(fs.readFileSync(receiptFile));
        assert.equal(paid.physicalRequests, 2); assert.equal(paid.reservedOutputTokens, 64000);
        assert.deepEqual(paid.requests[0], receipt.requests[0]); assert.equal(paid.oldAttempts, 6); assert.equal(paid.oldFullAttempts, 2);
        const savedBytes = fs.readFileSync(file), paidBytes = fs.readFileSync(receiptFile);
        assert.deepEqual(retry.restoreExplicitRoundOriginalDraft(directory, prepared.identity, saved, paper), saved);
        assert.deepEqual(fs.readFileSync(file), savedBytes); assert.deepEqual(fs.readFileSync(receiptFile), paidBytes);
    });
});

test('同一轮原档恢复拒绝覆盖真实新稿、已保存响应、局部子轮或未验证原档', async t => {
    const draft = createReaderTestArticle();
    const f = setup(t, p => { p.draft = draft; p.rawDraft = JSON.stringify(draft); });
    await f.locked(() => retry.withExplicitRound(paper, f.grant, () => {
        const next = retry.beginExplicitRound(directory, f.identity, f.payload, paper);
        retry.withPhysicalBudget(next.explicitReaderRetryRound, paper, () => retry.consumePhysicalRequest({ max_tokens: 48000 }, { usageContext: { paperId: paper.arxivId, stage: 'apiReaderArticle' } }));
        for (const change of [{ draft }, { rawDraft: '{"received":"new actual content"}' }, { attempts: 1 }, { fullAttempts: 1 }]) {
            const current = { ...next, draft: null, rawDraft: '无', ...change };
            repair.saveFailedCandidate(directory, f.identity, current);
            const bytes = fs.readFileSync(f.file);
            assert.deepEqual(retry.restoreExplicitRoundOriginalDraft(directory, f.identity, current, paper), current);
            assert.deepEqual(fs.readFileSync(f.file), bytes);
            // 每个控制独立回到0只写测试磁盘快照；生产save接口仍禁止减次数。
            fs.writeFileSync(f.file, JSON.stringify({ version:repair.REPAIR_VERSION,identity:f.identity,payload:next,payloadSha256:repair.hashDraft(next) }), {mode:0o600});
        }
        const current = { ...next, draft:null, rawDraft:'无' };
        repair.saveFailedCandidate(directory, f.identity, current);
        const receipt = JSON.parse(fs.readFileSync(next.explicitReaderRetryRound.receiptFile));
        fs.appendFileSync(receipt.archivedFile,' ');
        assert.throws(() => retry.restoreExplicitRoundOriginalDraft(directory,f.identity,current,paper), error => error.code === 'READER_ORIGINAL_DRAFT_RESTORATION_PROOF_INVALID' && error.retryable === false && error.scope === 'paper');
    }));
});

test('同一轮原稿恢复不能覆盖已经实际请求局部补丁的轮，即使当前占位状态计数为零', async t => {
 const draft=createReaderTestArticle();const f=setup(t,p=>{p.draft=draft;p.rawDraft=JSON.stringify(draft);});
 await f.locked(()=>retry.withExplicitRound(paper,f.grant,()=>{
  const next=retry.beginExplicitRound(directory,f.identity,f.payload,paper);
  retry.withPhysicalBudget(next.explicitReaderRetryRound,paper,()=>retry.consumePhysicalRequest({max_tokens:16000},{usageContext:{paperId:paper.arxivId,stage:'apiReaderRepair'}}));
  const current={...next,draft:null,rawDraft:'无'};repair.saveFailedCandidate(directory,f.identity,current);
  const bytes=fs.readFileSync(f.file),receiptBytes=fs.readFileSync(next.explicitReaderRetryRound.receiptFile);
  assert.deepEqual(retry.restoreExplicitRoundOriginalDraft(directory,f.identity,current,paper),current);
  assert.deepEqual(fs.readFileSync(f.file),bytes);assert.deepEqual(fs.readFileSync(next.explicitReaderRetryRound.receiptFile),receiptBytes);
 }));
});

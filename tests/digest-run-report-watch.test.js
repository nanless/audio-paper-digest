'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    inferStage,
    logStageHint,
    inferAnalysisCounts,
    collectFailedPapers,
    inferCurrentPaper,
    buildLiveStatus,
    formatLiveStatus,
    readAccountPoolStatus
} = require('../scripts/lib/digest-live-status.js');
const { createUsageSummaryCache } = require('../scripts/lib/llm-usage-summary.js');
const {
    parseDate,
    parseWatchOptions,
    runWatch,
    formatDigestRunSummary
} = require('../scripts/digest-run-report.js');

const DATE = '2026-01-02';
const NOW_MS = Date.parse(`${DATE}T12:00:00+08:00`);

function temporaryRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-live-status-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const currentDir = path.join(root, 'data', 'current');
    const runtimeDir = path.join(root, 'data', 'runtime');
    const logsDir = path.join(root, 'logs');
    fs.mkdirSync(currentDir, { recursive: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const paths = {
        currentDir,
        rawCandidates: path.join(currentDir, 'raw-candidates.json'),
        fetchCheckpoint: path.join(currentDir, 'fetch-checkpoint.json'),
        filterDecisions: path.join(currentDir, 'filter-decisions.json'),
        filteredPapers: path.join(currentDir, 'filtered-papers.json'),
        deepAnalysisResult: path.join(currentDir, 'deep-analysis-result.json'),
        generationManifestDir: currentDir,
        reviewReceiptDir: currentDir,
        visualManifestDir: path.join(currentDir, 'visual-summary-manifests'),
        coverManifestDir: path.join(currentDir, 'digest-cover-manifests'),
        logsDir,
        accountPoolState: path.join(runtimeDir, 'llm-account-pool.json'),
        llmUsageDir: path.join(runtimeDir, 'llm-usage')
    };
    fs.mkdirSync(paths.visualManifestDir, { recursive: true });
    fs.mkdirSync(paths.coverManifestDir, { recursive: true });
    fs.mkdirSync(paths.llmUsageDir, { recursive: true });
    return { root, paths };
}

function writeJson(filePath, value, mtimeMs) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value));
    if (Number.isFinite(mtimeMs)) {
        const value2 = new Date(mtimeMs);
        fs.utimesSync(filePath, value2, value2);
    }
}

function stageEvidence(overrides = {}) {
    return {
        date: DATE,
        raw: { batchDate: DATE, papers: [{ arxivId: 'a' }] },
        fetchCheckpoint: { batchDate: DATE },
        decisions: { batchDate: DATE, stats: { complete: true, totalCandidates: 1, decided: 1, related: 1 } },
        filtered: { batchDate: DATE, status: 'complete', papers: [{ arxivId: 'a' }] },
        deep: null,
        generation: null,
        review: null,
        visualManifest: null,
        coverManifest: null,
        counts: null,
        latestLog: null,
        ...overrides
    };
}

function completedDeep() {
    return {
        batchDate: DATE,
        papers: [{
            arxivId: 'a',
            title: 'done',
            analysis: 'analysis body',
            apiReaderArticle: 'reader body',
            analysisManifest: {
                stages: {
                    primaryAnalysis: { status: 'complete', updatedAt: `${DATE}T10:00:00+08:00` },
                    scoringAudit: { status: 'complete', updatedAt: `${DATE}T10:01:00+08:00` },
                    apiReaderArticle: { status: 'complete', updatedAt: `${DATE}T10:02:00+08:00` }
                }
            }
        }]
    };
}

describe('digest-live-status 阶段推断', () => {
    it('按产物从抓取推进到完成', () => {
        assert.strictEqual(inferStage(stageEvidence({ raw: null, fetchCheckpoint: null })).stage, 'fetch');
        assert.strictEqual(inferStage(stageEvidence({ filtered: null })).stage, 'filter');
        assert.strictEqual(inferStage(stageEvidence({ deep: null })).stage, 'analysis');
        const readerDeep = {
            batchDate: DATE,
            papers: [{
                arxivId: 'a',
                analysis: 'body',
                analysisManifest: {
                    stages: {
                        primaryAnalysis: { status: 'complete' },
                        apiReaderArticle: { status: 'transient_failure', error: 'timeout' }
                    }
                }
            }]
        };
        assert.strictEqual(inferStage(stageEvidence({ deep: readerDeep })).stage, 'reader');
        assert.strictEqual(inferStage(stageEvidence({ deep: completedDeep() })).stage, 'pages');
        const generation = { date: DATE, files: [{ path: 'content/posts/a.md' }], visualSummaryRequired: true, digestCoverRequired: true };
        assert.strictEqual(inferStage(stageEvidence({ deep: completedDeep(), generation })).stage, 'review');
        const review = { date: DATE, strictReview: true, files: [{ path: 'content/posts/a.md' }], publicationCommit: null };
        assert.strictEqual(inferStage(stageEvidence({ deep: completedDeep(), generation, review })).stage, 'push');
        const pushed = { ...review, publicationCommit: 'abc123', remoteVerifiedOid: 'abc123' };
        assert.strictEqual(inferStage(stageEvidence({ deep: completedDeep(), generation, review: pushed })).stage, 'visual');
        const visualManifest = { batchDate: DATE, overallStatus: 'complete', counts: { completeCards: 1, totalCards: 1, pendingCards: 0 } };
        const coverManifest = { batchDate: DATE, overallStatus: 'complete' };
        assert.strictEqual(inferStage(stageEvidence({
            deep: completedDeep(), generation, review: pushed, visualManifest, coverManifest
        })).stage, 'complete');
    });

    it('最新日志只能把阶段往前推，新鲜度不足时忽略', () => {
        const freshReaderLog = { file: 'api-reader-refresh-20260102-120000-1-0.log', message: 'start', ageSeconds: 10 };
        const analysisEvidence = stageEvidence({ deep: null, latestLog: freshReaderLog });
        assert.strictEqual(inferStage(analysisEvidence).stage, 'reader');
        assert.strictEqual(inferStage(analysisEvidence).logStageHint, 'reader');

        const staleLog = { ...freshReaderLog, ageSeconds: 3600 };
        assert.strictEqual(inferStage(stageEvidence({ deep: null, latestLog: staleLog })).stage, 'analysis');
        assert.strictEqual(logStageHint(staleLog), null);
        assert.strictEqual(logStageHint({ file: 'validate-data-files-1-0.log', message: '筛选 未完成', ageSeconds: 5 }), null);
    });
});

describe('digest-live-status 单屏合成', () => {
    function prepareRoot(t) {
        const { root, paths } = temporaryRoot(t);
        writeJson(paths.rawCandidates, { batchDate: DATE, papers: [{ arxivId: '2601.00001' }, { arxivId: '2601.00002' }] }, NOW_MS - 600000);
        writeJson(paths.fetchCheckpoint, { batchDate: DATE }, NOW_MS - 600000);
        writeJson(paths.filterDecisions, {
            batchDate: DATE,
            stats: { complete: true, totalCandidates: 2, decided: 2, related: 2, retryable: 0 }
        }, NOW_MS - 500000);
        writeJson(paths.filteredPapers, {
            batchDate: DATE,
            status: 'complete',
            papers: [{ arxivId: '2601.00001' }, { arxivId: '2601.00002' }]
        }, NOW_MS - 400000);
        writeJson(paths.deepAnalysisResult, {
            batchDate: DATE,
            papers: [
                {
                    arxivId: '2601.00001',
                    title: 'Done paper',
                    analysis: 'analysis body',
                    apiReaderArticle: 'reader body',
                    analysisManifest: {
                        updatedAt: `${DATE}T11:50:00+08:00`,
                        stages: {
                            primaryAnalysis: { status: 'complete', updatedAt: `${DATE}T10:00:00+08:00` },
                            scoringAudit: { status: 'complete', updatedAt: `${DATE}T10:01:00+08:00` },
                            apiReaderArticle: { status: 'complete', updatedAt: `${DATE}T10:02:00+08:00` }
                        }
                    }
                },
                {
                    arxivId: '2601.00002',
                    title: 'Stuck paper',
                    analysis: '',
                    error: 'timeout',
                    analysisManifest: {
                        updatedAt: `${DATE}T11:58:00+08:00`,
                        stages: {
                            primaryAnalysis: {
                                status: 'transient_failure',
                                error: 'request timed out',
                                updatedAt: `${DATE}T11:58:00+08:00`
                            }
                        }
                    }
                }
            ]
        }, NOW_MS - 120000);
        writeJson(paths.accountPoolState, {
            schemaVersion: 1,
            policyVersion: 'opencode-go-sticky-quota-failover-v1',
            generation: 1,
            services: {
                service: {
                    endpoint: 'https://opencode.ai/zen/go',
                    accounts: {
                        cooling: { blockedUntilMs: NOW_MS + 3600000 },
                        available: { blockedUntilMs: NOW_MS - 3600000 }
                    },
                    groups: {}
                }
            }
        }, NOW_MS - 120000);
        const usageEvent = {
            version: 'llm-usage-v1',
            kind: 'request',
            eventId: crypto.randomUUID(),
            at: `${DATE}T11:58:00+08:00`,
            stage: 'primaryAnalysis',
            model: 'muse-spark-1.3-contributor',
            accountId: 'acct-a',
            outcome: 'completed',
            estimatedCost: 0.5,
            usage: { status: 'reported', inputTokens: 10, outputTokens: 5 }
        };
        writeJson(path.join(paths.llmUsageDir, `${crypto.randomUUID()}.json`), usageEvent, NOW_MS - 60000);
        const logPath = path.join(paths.logsDir, 'deep-analyzer-20260102-120000-1-0.log');
        fs.writeFileSync(logPath, `[2026-01-02 11:59:30.000+08:00] analysis 2601.00002 primaryAnalysis start\n`);
        const logMtime = new Date(NOW_MS - 30000);
        fs.utimesSync(logPath, logMtime, logMtime);
        return { root, paths };
    }

    it('合成阶段、数量、当前论文、失败、账号池、费用与无进度秒数', t => {
        const { paths } = prepareRoot(t);
        const status = buildLiveStatus({
            date: DATE,
            nowMs: NOW_MS,
            paths,
            usageCache: createUsageSummaryCache()
        });
        assert.strictEqual(status.stage, 'analysis');
        assert.strictEqual(status.stageLabel, '深度分析');
        assert.strictEqual(status.counts.candidates, 2);
        assert.strictEqual(status.counts.selected, 2);
        assert.strictEqual(status.counts.analysisTotal, 2);
        assert.strictEqual(status.counts.analysisPassed, 1);
        assert.strictEqual(status.counts.analysisFailed, 1);
        assert.strictEqual(status.counts.readerTotal, 1);
        assert.strictEqual(status.counts.readerPassed, 1);
        assert.strictEqual(status.currentPaper.id, '2601.00002');
        assert.strictEqual(status.currentPaper.index, 2);
        assert.strictEqual(status.currentPaper.total, 2);
        assert.strictEqual(status.failedCount, 1);
        assert.strictEqual(status.failedPapers[0].id, '2601.00002');
        assert.strictEqual(status.failedPapers[0].stage, 'analysis');
        assert.strictEqual(status.latestLog.message, 'analysis 2601.00002 primaryAnalysis start');
        assert.strictEqual(status.latestLog.ageSeconds, 30);
        assert.strictEqual(status.accountPool.available, 1);
        assert.strictEqual(status.accountPool.cooling, 1);
        assert.strictEqual(status.accountPool.total, 2);
        assert.strictEqual(status.usage.total, 1);
        assert.strictEqual(status.usage.cost, 0.5);
        assert.strictEqual(status.secondsSinceProgress, 120);
        assert.strictEqual(status.stalled, false);
        assert.ok(status.suggestions.includes(`npm run deep -- --date ${DATE}`));
        const text = formatLiveStatus(status);
        assert.match(text, /阶段=深度分析/);
        assert.match(text, /候选=2 入选=2/);
        assert.match(text, /分析通过=1\/2 失败=1/);
        assert.match(text, /当前论文=2\/2 2601.00002/);
        assert.match(text, /账号池 可用=1 冷却=1/);
        assert.match(text, /本次费用 调用=1 成功=1 失败=0 费用=\$0.5000/);
        assert.match(text, /建议: npm run deep -- --date 2026-01-02/);
    });

    it('超过无进度阈值时给出明确提示', t => {
        const { paths } = prepareRoot(t);
        const status = buildLiveStatus({
            date: DATE,
            nowMs: NOW_MS + 600000,
            paths,
            usageCache: createUsageSummaryCache()
        });
        assert.strictEqual(status.secondsSinceProgress, 720);
        assert.strictEqual(status.stalled, true);
        assert.strictEqual(status.stallThresholdSeconds, 300);
        // 日志已经超过新鲜度窗口，不应再把阶段往前推。
        assert.strictEqual(status.logStageHint, null);
        const text = formatLiveStatus(status);
        assert.match(text, /连续无进度=720 秒/);
        assert.match(text, /超过 300 秒，可能卡在模型请求或网络等待/);
    });

    it('账号池状态缺失或损坏时只报告，不抛错', t => {
        const { paths } = temporaryRoot(t);
        const missing = readAccountPoolStatus(paths.accountPoolState, { nowMs: NOW_MS });
        assert.strictEqual(missing.missing, true);
        assert.strictEqual(missing.available, null);
        fs.writeFileSync(paths.accountPoolState, '{not json');
        const broken = readAccountPoolStatus(paths.accountPoolState, { nowMs: NOW_MS });
        assert.match(broken.error, /JSON/);
        assert.strictEqual(broken.available, null);
    });
});

describe('digest-run-report --watch 参数与循环', () => {
    it('默认无 --watch 时保持原报告参数，--json 不改变默认格式', () => {
        assert.deepStrictEqual(parseWatchOptions([`--date`, DATE]), {
            watch: false,
            json: false,
            intervalSeconds: 10,
            intervalMs: 10000
        });
        assert.strictEqual(parseDate([`--date`, DATE]), DATE);

        const report = {
            batchDate: '2026-10-10', overallStatus: 'complete', errors: [],
            fetch: { complete: true, rawCandidateCount: 1 },
            filter: { complete: true, selectedCount: 1, totalCandidates: 1, pendingDecisions: 0 },
            analysis: { complete: true, successful: 1, total: 1, expected: 1, missing: 0, failed: 0 },
            blog: { complete: true, strictReview: true, publicationVerified: true, remoteOidVerified: true },
            visuals: { gateComplete: true, status: 'complete', complete: 1, total: 1, pending: 0, failed: 0 },
            cover: { complete: true, status: 'complete' }
        };
        const summary = formatDigestRunSummary(report);
        assert.strictEqual(summary.split('\n')[0], '[digest-status] 2026-10-10 本报告状态=完成 问题数=0');
        assert.ok(!summary.includes('[digest-live]'));
    });

    it('解析 --watch/--interval/--json', () => {
        const parsed = parseWatchOptions([`--date`, DATE, '--watch', '--interval', '2', '--json']);
        assert.strictEqual(parsed.watch, true);
        assert.strictEqual(parsed.json, true);
        assert.strictEqual(parsed.intervalMs, 2000);
        assert.strictEqual(parseWatchOptions(['--watch', '--interval=3']).intervalMs, 3000);
        assert.throws(() => parseWatchOptions(['--watch', '--interval', '0']), /--interval/);
        assert.throws(() => parseWatchOptions(['--watch', '--interval']), /--interval/);
        assert.throws(() => parseWatchOptions(['--watch', '--interval', 'abc']), /--interval/);
    });

    it('--json --watch 每行一个 JSON，并可干净停止', async () => {
        const lines = [];
        const result = await runWatch({
            targetDate: DATE,
            intervalMs: 1,
            json: true,
            maxSnapshots: 2,
            print: line => lines.push(line),
            buildSnapshot: () => ({ n: lines.length + 1, date: DATE })
        });
        assert.strictEqual(lines.length, 2);
        assert.deepStrictEqual(lines.map(line => JSON.parse(line).n), [1, 2]);
        assert.deepStrictEqual(result, { iterations: 2, stoppedBy: 'maxSnapshots' });
    });

    it('文本 watch 打印快照，Ctrl-C 通过 abort 干净退出', async () => {
        const controller = new AbortController();
        const status = buildLiveStatus({
            date: DATE,
            nowMs: NOW_MS,
            paths: { ...temporaryRootPathsForFormatting() },
            usage: { date: DATE, total: 0, success: 0, failed: 0, cost: 0 }
        });
        const lines = [];
        const result = await runWatch({
            targetDate: DATE,
            intervalMs: 5,
            signal: controller.signal,
            print: line => {
                lines.push(line);
                controller.abort();
            },
            buildSnapshot: () => status
        });
        assert.strictEqual(result.stoppedBy, 'signal');
        assert.strictEqual(result.iterations, 1);
        assert.strictEqual(lines.length, 1);
        assert.match(lines[0], /^\[digest-live\]/);
    });

    it('单次快照失败不终止循环', async () => {
        let calls = 0;
        const lines = [];
        const result = await runWatch({
            targetDate: DATE,
            intervalMs: 1,
            maxSnapshots: 1,
            print: line => lines.push(line),
            buildSnapshot: () => {
                calls += 1;
                if (calls === 1) throw new Error('boom');
                return buildLiveStatus({
                    date: DATE,
                    nowMs: NOW_MS,
                    paths: temporaryRootPathsForFormatting(),
                    usage: { date: DATE, total: 0, success: 0, failed: 0, cost: 0 }
                });
            }
        });
        assert.strictEqual(calls, 2);
        assert.strictEqual(result.iterations, 1);
        assert.match(lines[0], /快照失败: boom/);
        assert.match(lines[1], /^\[digest-live\]/);
    });

    it('缺 --date 时 watch 明确拒绝', async () => {
        await assert.rejects(runWatch({ intervalMs: 1 }), /--date/);
    });
});

// 文本格式化只需要一份不依赖真实 data/ 的空白路径；这些文件都不存在。
function temporaryRootPathsForFormatting() {
    const root = path.join(os.tmpdir(), `digest-live-format-${crypto.randomUUID()}`);
    return {
        currentDir: root,
        rawCandidates: path.join(root, 'raw-candidates.json'),
        fetchCheckpoint: path.join(root, 'fetch-checkpoint.json'),
        filterDecisions: path.join(root, 'filter-decisions.json'),
        filteredPapers: path.join(root, 'filtered-papers.json'),
        deepAnalysisResult: path.join(root, 'deep-analysis-result.json'),
        generationManifestDir: root,
        reviewReceiptDir: root,
        visualManifestDir: path.join(root, 'visual'),
        coverManifestDir: path.join(root, 'cover'),
        logsDir: path.join(root, 'logs'),
        accountPoolState: path.join(root, 'account-pool.json'),
        llmUsageDir: path.join(root, 'usage')
    };
}

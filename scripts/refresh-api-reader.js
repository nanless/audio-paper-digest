#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const Config = require('./config.js');
const {
    fetchArxivTextDetailed,
    refreshApiReaderArticleFromSource,
    refreshApiScoringAndReaderFromSource,
    refreshApiReaderAuthorsFromSource,
    refreshApiReaderFiguresFromSource,
    API_READER_ARTICLE_CONTRACT,
    stableFingerprint,
    repairApiReaderPlanSurfaceBinding
} = require('./deep-analyzer.js');
const {
    readJsonFileStrict,
    updateJsonFileLocked,
    isSuccessfulAnalysisRecord,
    withPaperAnalysisLock
} = require('./analysis-engine.js');
const {
    updateAnalysisDigestStatuses,
    inferAnalysisBatchDate
} = require('./digest-status.js');
const { normalizedId, getBeijingISOString } = require('./utils.js');

const MAX_REFRESH_CONCURRENCY = 5;

function parseRefreshCliArgs(args) {
    const options = {
        authorsOnly: false,
        scoringAndReader: false,
        figuresOnly: false,
        surfaceBindingsOnly: false,
        all: false,
        date: null,
        concurrency: 1,
        ids: []
    };
    const seenFlags = new Set();
    for (let index = 0; index < args.length; index++) {
        const value = args[index];
        if (value.startsWith('--')) {
            if (seenFlags.has(value)) throw new Error(`参数重复: ${value}`);
            seenFlags.add(value);
        }
        if (value === '--authors-only') options.authorsOnly = true;
        else if (value === '--scoring-and-reader') options.scoringAndReader = true;
        else if (value === '--figures-only') options.figuresOnly = true;
        else if (value === '--surface-bindings-only') options.surfaceBindingsOnly = true;
        else if (value === '--all') options.all = true;
        else if (value === '--date' || value === '--concurrency') {
            const next = args[index + 1];
            if (!next || next.startsWith('--')) throw new Error(`${value} 缺少参数`);
            index += 1;
            if (value === '--date') options.date = next;
            else {
                if (!/^\d+$/.test(next)) throw new Error('--concurrency 必须为整数');
                options.concurrency = Number.parseInt(next, 10);
            }
        } else if (value.startsWith('--')) {
            throw new Error(`未知参数: ${value}`);
        } else {
            options.ids.push(value);
        }
    }
    if ([options.authorsOnly, options.scoringAndReader, options.figuresOnly,
        options.surfaceBindingsOnly]
        .filter(Boolean).length > 1) {
        throw new Error('刷新模式参数不能同时使用');
    }
    if (!Number.isInteger(options.concurrency)
        || options.concurrency < 1 || options.concurrency > MAX_REFRESH_CONCURRENCY) {
        throw new Error(`--concurrency 必须为 1-${MAX_REFRESH_CONCURRENCY} 的整数`);
    }
    if (options.all) {
        if (options.ids.length > 0) throw new Error('--all 不能与显式论文 ID 同时使用');
        const dateMatch = String(options.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const validDate = dateMatch && (() => {
            const year = Number(dateMatch[1]);
            const month = Number(dateMatch[2]);
            const day = Number(dateMatch[3]);
            const parsed = new Date(Date.UTC(year, month - 1, day));
            return parsed.getUTCFullYear() === year
                && parsed.getUTCMonth() === month - 1
                && parsed.getUTCDate() === day;
        })();
        if (!validDate) {
            throw new Error('--all 必须同时提供 --date YYYY-MM-DD');
        }
    } else if (options.date) {
        throw new Error('--date 只能与 --all 同时使用');
    }
    if (!options.all && options.ids.length === 0) {
        throw new Error('必须提供论文 ID，或使用 --all --date YYYY-MM-DD');
    }
    return options;
}

function paperRefreshInputIdentity(paper) {
    return stableFingerprint({
        paperId: normalizedId(paper),
        sourceSha256: paper?.sourceSha256 || '',
        analysisSha256: stableFingerprint(String(paper?.analysis || '')),
        scoringAuditSha256: paper?.analysisManifest?.stages?.scoringAudit?.auditSha256 || '',
        scoringOutputSha256: paper?.analysisManifest?.stages?.scoringAudit?.outputAnalysisSha256 || '',
        readerFingerprint: paper?.analysisManifest?.stages?.apiReaderArticle?.fingerprint || '',
        readerArticleSha256: paper?.apiReaderArticleSha256 || '',
        readerPlanSha256: paper?.apiReaderPlanSha256 || ''
    });
}

function hasCurrentReaderV3(paper) {
    if (!paper?.apiReaderPlan || typeof paper.apiReaderPlan !== 'object') return false;
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle;
    const articleSha256 = crypto.createHash('sha256')
        .update(String(paper?.apiReaderArticle || ''))
        .digest('hex');
    const planSha256 = stableFingerprint(paper?.apiReaderPlan);
    return paper?.analysisManifest?.contracts?.apiReaderArticle === API_READER_ARTICLE_CONTRACT
        && stage?.status === 'complete'
        && paper?.apiReaderPlan?.version === 3
        && Boolean(String(paper?.apiReaderArticle || '').trim())
        && paper?.apiReaderArticleSha256 === articleSha256
        && stage?.articleSha256 === articleSha256
        && paper?.apiReaderPlanSha256 === planSha256
        && stage?.planSha256 === planSha256
        && !paper?.latestAnalysisAttemptError;
}

function resolveBatchRefreshIds(options) {
    if (!options.all) return options.ids;
    const payload = readJsonFileStrict(Config.FILES.deepAnalysisResult);
    if (Array.isArray(payload) || !Array.isArray(payload?.papers)) {
        throw new Error('按日期全量刷新只接受带 batchDate 的 canonical object envelope');
    }
    const papers = payload.papers;
    if (payload.batchDate !== options.date) {
        throw new Error(`当前深度分析批次为 ${payload.batchDate || '未知'}，拒绝按 ${options.date} 全量刷新`);
    }
    const pending = options.surfaceBindingsOnly
        ? papers
        : papers.filter(paper => !hasCurrentReaderV3(paper));
    console.log(
        `📋 API reader 全量刷新: date=${options.date}`
        + ` | papers=${papers.length} | pending=${pending.length}`
        + ` | current_v3=${papers.length - pending.length}`
        + ` | concurrency=${options.concurrency}`
    );
    return pending.map(paper => normalizedId(paper)).filter(Boolean);
}

async function refreshApiReaders(targetIds, options = {}) {
    const ids = [...new Set(targetIds.map(normalizedId).filter(Boolean))];
    const concurrency = Math.min(options.concurrency || 1, ids.length || 1);
    const results = new Array(ids.length);
    const failures = [];
    let cursor = 0;
    async function worker() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= ids.length) return;
            const id = ids[index];
            try {
                results[index] = await refreshApiReader(id, options);
            } catch (error) {
                failures.push({ id, error: error.message });
                console.error(`❌ ${id} 刷新失败: ${error.message}`);
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (failures.length > 0) {
        const error = new Error(
            `API reader 批量刷新失败 ${failures.length}/${ids.length}: `
            + failures.map(item => item.id).join(', ')
        );
        error.failures = failures;
        throw error;
    }
    return results.filter(Boolean);
}

function canRepairScoringBinding(paper) {
    const manifest = paper?.analysisManifest;
    const scoring = manifest?.stages?.scoringAudit;
    const reader = manifest?.stages?.apiReaderArticle;
    return typeof paper?.analysis === 'string' && paper.analysis.trim().length > 0
        && manifest?.version === 1
        && scoring?.status === 'complete'
        && scoring?.scoringContract === 'api-scoring-audit-v2'
        && reader?.status === 'complete'
        && ['beginner-researcher-v2', 'beginner-researcher-v3']
            .includes(manifest?.contracts?.apiReaderArticle)
        && !paper?.latestAnalysisAttemptError;
}

async function refreshApiReader(targetId, options = {}) {
    const requested = normalizedId(targetId);
    if (!requested) throw new Error('用法: node scripts/refresh-api-reader.js <arxiv-id>');
    const resultPath = Config.FILES.deepAnalysisResult;
    const current = readJsonFileStrict(resultPath);
    const papers = Array.isArray(current) ? current : current.papers;
    const existing = papers.find(paper => normalizedId(paper) === requested);
    if (!existing || (!isSuccessfulAnalysisRecord(existing)
        && !(options.scoringAndReader && canRepairScoringBinding(existing)))) {
        throw new Error(`${requested} 不存在完整 canonical，拒绝只刷新读者文章`);
    }

    return withPaperAnalysisLock(existing, async () => {
        const latest = readJsonFileStrict(resultPath);
        const latestPapers = Array.isArray(latest) ? latest : latest.papers;
        const canonical = latestPapers.find(paper => normalizedId(paper) === requested);
        if (!canonical || (!isSuccessfulAnalysisRecord(canonical)
            && !(options.scoringAndReader && canRepairScoringBinding(canonical)))) {
            throw new Error(`${requested} canonical 在加锁后发生变化`);
        }
        const inputIdentity = paperRefreshInputIdentity(canonical);
        const refreshLabel = options.authorsOnly
            ? '作者机构绑定'
            : options.figuresOnly
                ? '论文图资产'
            : options.surfaceBindingsOnly
                ? '读者计划表面绑定'
            : options.scoringAndReader
                ? '评分复验与读者文章'
                : '读者文章';
        console.log(`📄 只刷新${refreshLabel}: ${canonical.title || requested}`);
        const sourceDetails = options.surfaceBindingsOnly
            ? null
            : await fetchArxivTextDetailed(
                canonical.arxivId || canonical.paper_id || targetId
            );
        const refreshed = options.surfaceBindingsOnly
            ? (() => {
                const repaired = JSON.parse(JSON.stringify(canonical));
                repairApiReaderPlanSurfaceBinding(repaired, repaired.analysisManifest);
                const bridges = repaired.apiReaderPlan?.conceptBridges;
                if (!Array.isArray(bridges) || bridges.some(bridge => (
                    typeof bridge?.explanation !== 'string'
                    || !repaired.apiReaderArticle.includes(bridge.explanation)
                    || repaired.apiReaderArticle.includes(String(bridge?.marker || ''))
                ))) {
                    throw new Error(`${requested} 读者计划表面绑定无法从最终正文闭环`);
                }
                const articleFigureUrls = [...repaired.apiReaderArticle
                    .matchAll(/!\[(?:\\.|[^\]\\])*\]\((https:\/\/[^\s)]+)\)/g)]
                    .map(match => match[1]);
                const boundFigureUrls = Array.isArray(repaired.apiReaderFigures)
                    ? repaired.apiReaderFigures.map(item => item?.url)
                    : [];
                if (articleFigureUrls.length !== boundFigureUrls.length
                    || articleFigureUrls.some((url, index) => url !== boundFigureUrls[index])) {
                    throw new Error(`${requested} 正文图片顺序无法与结构化 figure 闭环`);
                }
                return repaired;
            })()
            : options.authorsOnly
                ? refreshApiReaderAuthorsFromSource(canonical, sourceDetails)
            : options.figuresOnly
                ? await refreshApiReaderFiguresFromSource(canonical, sourceDetails)
            : options.scoringAndReader
                ? await refreshApiScoringAndReaderFromSource(canonical, sourceDetails)
                : await refreshApiReaderArticleFromSource(canonical, sourceDetails);
        const savedPayload = updateJsonFileLocked(resultPath, payload => {
            const rows = Array.isArray(payload) ? payload : payload.papers;
            if (!Array.isArray(rows)) throw new Error('deep canonical papers 不是数组');
            const matches = rows.map((paper, index) => (
                normalizedId(paper) === requested ? index : -1
            )).filter(index => index >= 0);
            if (matches.length !== 1) {
                throw new Error(`${requested} canonical 提交时命中 ${matches.length} 条，拒绝覆盖`);
            }
            const targetIndex = matches[0];
            if (paperRefreshInputIdentity(rows[targetIndex]) !== inputIdentity) {
                throw new Error(`${requested} canonical_changed_during_refresh`);
            }
            if (normalizedId(refreshed) !== requested) {
                throw new Error(`${requested} 刷新结果 ID 漂移`);
            }
            const updated = [...rows];
            updated[targetIndex] = refreshed;
            if (Array.isArray(payload)) return updated;
            return { ...payload, papers: updated, lastUpdated: getBeijingISOString() };
        });
        const savedRows = Array.isArray(savedPayload) ? savedPayload : savedPayload.papers;
        const savedRecord = savedRows.find(paper => normalizedId(paper) === requested);
        const batchDate = inferAnalysisBatchDate(
            [savedRecord], Array.isArray(savedPayload) ? {} : savedPayload
        );
        const sync = updateAnalysisDigestStatuses([savedRecord], { batchDate });
        console.log(options.surfaceBindingsOnly
            ? `✅ 读者计划表面绑定完成 | plan_sha=${savedRecord.apiReaderPlanSha256}`
                + ` | papers_sync=${sync.updated}`
            : options.authorsOnly
            ? `✅ 作者机构刷新完成 | authors=${refreshed.apiReaderAuthors.authors.length} | papers_sync=${sync.updated}`
            : options.figuresOnly
                ? `✅ 论文图资产刷新完成 | figures=${refreshed.apiReaderFigures.length} | papers_sync=${sync.updated}`
            : `✅ ${options.scoringAndReader ? '评分复验与读者文章' : '读者文章'}刷新完成`
                + ` | score=${refreshed.parsed?.score}`
                + ` | sections=${refreshed.apiReaderPlan.sections.length}`
                + ` | figures=${refreshed.apiReaderFigures.length}`
                + ` | article_sha=${refreshed.apiReaderArticleSha256}`
                + ` | papers_sync=${sync.updated}`);
        return savedRecord;
    });
}

if (require.main === module) {
    try {
        const options = parseRefreshCliArgs(process.argv.slice(2));
        const ids = resolveBatchRefreshIds(options);
        refreshApiReaders(ids, options).then(results => {
            console.log(`✅ API reader 批量刷新完成: ${results.length} 篇`);
        }).catch(error => {
            console.error(`❌ API 读者文章刷新失败: ${error.message}`);
            process.exitCode = 1;
        });
    } catch (error) {
        console.error(`❌ ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    refreshApiReader,
    refreshApiReaders,
    parseRefreshCliArgs,
    resolveBatchRefreshIds,
    hasCurrentReaderV3,
    paperRefreshInputIdentity,
    MAX_REFRESH_CONCURRENCY
};

#!/usr/bin/env node
'use strict';

const Config = require('./config.js');
const {
    fetchArxivTextDetailed,
    refreshApiReaderArticleFromSource,
    refreshApiScoringAndReaderFromSource,
    refreshApiReaderAuthorsFromSource,
    refreshApiReaderFiguresFromSource
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
        const refreshLabel = options.authorsOnly
            ? '作者机构绑定'
            : options.figuresOnly
                ? '论文图资产'
            : options.scoringAndReader
                ? '评分复验与读者文章'
                : '读者文章';
        console.log(`📄 只刷新${refreshLabel}: ${canonical.title || requested}`);
        const sourceDetails = await fetchArxivTextDetailed(
            canonical.arxivId || canonical.paper_id || targetId
        );
        const refreshed = options.authorsOnly
            ? refreshApiReaderAuthorsFromSource(canonical, sourceDetails)
            : options.figuresOnly
                ? await refreshApiReaderFiguresFromSource(canonical, sourceDetails)
            : options.scoringAndReader
                ? await refreshApiScoringAndReaderFromSource(canonical, sourceDetails)
                : await refreshApiReaderArticleFromSource(canonical, sourceDetails);
        updateJsonFileLocked(resultPath, payload => {
            const rows = Array.isArray(payload) ? payload : payload.papers;
            const updated = rows.map(paper => (
                normalizedId(paper) === requested ? refreshed : paper
            ));
            if (Array.isArray(payload)) return updated;
            return { ...payload, papers: updated, lastUpdated: getBeijingISOString() };
        });
        const batchDate = inferAnalysisBatchDate(
            [refreshed], Array.isArray(latest) ? {} : latest
        );
        const sync = updateAnalysisDigestStatuses([refreshed], { batchDate });
        console.log(options.authorsOnly
            ? `✅ 作者机构刷新完成 | authors=${refreshed.apiReaderAuthors.authors.length} | papers_sync=${sync.updated}`
            : options.figuresOnly
                ? `✅ 论文图资产刷新完成 | figures=${refreshed.apiReaderFigures.length} | papers_sync=${sync.updated}`
            : `✅ ${options.scoringAndReader ? '评分复验与读者文章' : '读者文章'}刷新完成`
                + ` | score=${refreshed.parsed?.score}`
                + ` | sections=${refreshed.apiReaderPlan.sections.length}`
                + ` | figures=${refreshed.apiReaderFigures.length}`
                + ` | article_sha=${refreshed.apiReaderArticleSha256}`
                + ` | papers_sync=${sync.updated}`);
        return refreshed;
    });
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const authorsOnly = args.includes('--authors-only');
    const scoringAndReader = args.includes('--scoring-and-reader');
    const figuresOnly = args.includes('--figures-only');
    if ([authorsOnly, scoringAndReader, figuresOnly].filter(Boolean).length > 1) {
        console.error('❌ --authors-only、--figures-only 与 --scoring-and-reader 不能同时使用');
        process.exitCode = 1;
    } else {
        const ids = args.filter(value => !value.startsWith('--'));
        if (ids.length === 0) {
        console.error('❌ 用法: node scripts/refresh-api-reader.js [--authors-only] <arxiv-id> [arxiv-id ...]');
        process.exitCode = 1;
        } else {
            (async () => {
                for (const id of ids) {
                await refreshApiReader(id, { authorsOnly, figuresOnly, scoringAndReader });
                }
            })().catch(error => {
                console.error(`❌ API 读者文章刷新失败: ${error.message}`);
                process.exitCode = 1;
            });
        }
    }
}

module.exports = { refreshApiReader };

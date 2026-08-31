#!/usr/bin/env node
'use strict';

const Config = require('./config.js');
const {
    fetchArxivTextDetailed,
    refreshApiReaderArticleFromSource,
    refreshApiReaderAuthorsFromSource
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

async function refreshApiReader(targetId, options = {}) {
    const requested = normalizedId(targetId);
    if (!requested) throw new Error('用法: node scripts/refresh-api-reader.js <arxiv-id>');
    const resultPath = Config.FILES.deepAnalysisResult;
    const current = readJsonFileStrict(resultPath);
    const papers = Array.isArray(current) ? current : current.papers;
    const existing = papers.find(paper => normalizedId(paper) === requested);
    if (!existing || !isSuccessfulAnalysisRecord(existing)) {
        throw new Error(`${requested} 不存在完整 canonical，拒绝只刷新读者文章`);
    }

    return withPaperAnalysisLock(existing, async () => {
        const latest = readJsonFileStrict(resultPath);
        const latestPapers = Array.isArray(latest) ? latest : latest.papers;
        const canonical = latestPapers.find(paper => normalizedId(paper) === requested);
        if (!canonical || !isSuccessfulAnalysisRecord(canonical)) {
            throw new Error(`${requested} canonical 在加锁后发生变化`);
        }
        console.log(`📄 只刷新${options.authorsOnly ? '作者机构绑定' : '读者文章'}: ${canonical.title || requested}`);
        const sourceDetails = await fetchArxivTextDetailed(
            canonical.arxivId || canonical.paper_id || targetId
        );
        const refreshed = options.authorsOnly
            ? refreshApiReaderAuthorsFromSource(canonical, sourceDetails)
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
            : `✅ 读者文章刷新完成 | sections=${refreshed.apiReaderPlan.sections.length}`
                + ` | figures=${refreshed.apiReaderFigures.length}`
                + ` | article_sha=${refreshed.apiReaderArticleSha256}`
                + ` | papers_sync=${sync.updated}`);
        return refreshed;
    });
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const authorsOnly = args.includes('--authors-only');
    const ids = args.filter(value => !value.startsWith('--'));
    if (ids.length === 0) {
        console.error('❌ 用法: node scripts/refresh-api-reader.js [--authors-only] <arxiv-id> [arxiv-id ...]');
        process.exitCode = 1;
    } else {
        (async () => {
            for (const id of ids) await refreshApiReader(id, { authorsOnly });
        })().catch(error => {
            console.error(`❌ API 读者文章刷新失败: ${error.message}`);
            process.exitCode = 1;
        });
    }
}

module.exports = { refreshApiReader };

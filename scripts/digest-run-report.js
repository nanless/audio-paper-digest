#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Config = require('./config.js');
const {
    getBeijingISOString,
    normalizedId,
    writeFileAtomic
} = require('./utils.js');
const { isSuccessfulAnalysisRecord } = require('./analysis-engine.js');
const { setupScriptLogging } = require('./log-setup.js');
const {
    cardTaskToken,
    validateCompletedCard,
    assertVisualArchiveUniqueness,
    visualSummaryAssetPath,
    assertPublishedBlogReceipt,
    assertVisualManifestCurrent,
    paperBatchDate
} = require('./visual-summary-state.js');
const {
    coverTaskToken,
    validateCompletedCover,
    assertDigestCoverManifestCurrent
} = require('./digest-cover-state.js');

function parseDate(argv) {
    const index = argv.indexOf('--date');
    const value = index >= 0 ? argv[index + 1] : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('用法: digest-run-report.js --date YYYY-MM-DD');
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error(`日期非法: ${value}`);
    }
    return value;
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
        return null;
    }
}

function papersFrom(value) {
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.papers) ? value.papers : [];
}

function paperDate(paper) {
    return paperBatchDate(paper);
}

function sourceHealthComplete(raw, targetDate) {
    const categories = raw?.sourceHealth?.arxiv?.categories;
    const expectedIds = new Set(Config.ARXIV_CATEGORIES.map(item => item.id));
    const actualIds = new Set(Array.isArray(categories) ? categories.map(item => item?.id) : []);
    return Boolean(
        raw?.batchDate === targetDate
        && papersFrom(raw).length > 0
        && raw?.sourceHealth?.arxiv?.ok === true
        && Array.isArray(categories)
        && categories.length === Config.ARXIV_CATEGORIES.length
        && actualIds.size === expectedIds.size
        && [...expectedIds].every(id => actualIds.has(id))
        && categories.every(item => item?.ok === true)
        && raw?.sourceHealth?.huggingface?.ok === true
    );
}

function samePaperIds(left, right) {
    const leftValues = left.map(normalizedId).filter(Boolean);
    const rightValues = right.map(normalizedId).filter(Boolean);
    const leftIds = new Set(leftValues);
    const rightIds = new Set(rightValues);
    return (
        leftValues.length === left.length
        && rightValues.length === right.length
        && leftIds.size === leftValues.length
        && rightIds.size === rightValues.length
        && leftIds.size === rightIds.size
        && [...leftIds].every(id => rightIds.has(id))
    );
}

function visualAssetsAreValid(visual) {
    const visualCards = Object.entries(visual?.papers || {})
        .flatMap(([id, paper]) => Object.entries(paper?.cards || {})
            .map(([kind, card]) => ({ id, paper, kind, card })));
    const assetsValid = visualCards.length > 0 && visualCards.every(({ id, paper, kind, card }) => (
        validateCompletedCard(
            card,
            paper.analysisSha256,
            paper.promptSha256,
            cardTaskToken(
                paper.normalizedArxivId || normalizedId(id),
                kind,
                paper.analysisSha256,
                paper.promptSha256,
                paper.rank,
                visual?.publication
            ),
            visualSummaryAssetPath(
                visual.batchDate, id, kind, paper.rank, paper.title || ''
            )
        )
    ));
    let archiveUnique = false;
    try {
        archiveUnique = Boolean(visual && assertVisualArchiveUniqueness(visual));
    } catch (_error) {
        archiveUnique = false;
    }
    return { visualCards, assetsValid, archiveUnique };
}

function buildDigestRunReport(targetDate) {
    const raw = readJson(Config.FILES.rawCandidates);
    const filtered = readJson(Config.FILES.filteredPapers);
    const decisions = readJson(Config.FILES.filterDecisions);
    const deep = readJson(Config.FILES.deepAnalysisResult);
    const review = readJson(path.join(Config.CURRENT_DIR, `blog-review-receipt-${targetDate}.json`));
    const visual = readJson(path.join(Config.FILES.visualSummaryManifestDir, `${targetDate}.json`));
    const cover = readJson(path.join(Config.FILES.digestCoverManifestDir, `${targetDate}.json`));
    const deepBatch = papersFrom(deep).filter(paper => paperDate(paper) === targetDate);
    const successful = deepBatch.filter(isSuccessfulAnalysisRecord);
    const failed = deepBatch.filter(paper => !isSuccessfulAnalysisRecord(paper));
    const rawCount = papersFrom(raw).length;
    const fetchComplete = sourceHealthComplete(raw, targetDate);
    const decisionStats = decisions?.stats || {};
    const decisionsComplete = Boolean(
        decisions?.batchDate === targetDate
        && decisionStats.complete === true
        && decisionStats.totalCandidates === rawCount
        && decisionStats.decided === rawCount
        && decisionStats.retryable === 0
    );
    let publication = null;
    let publicationVerified = false;
    try {
        publication = assertPublishedBlogReceipt(targetDate);
        publicationVerified = true;
    } catch (_error) {
        publicationVerified = false;
    }
    const {
        visualCards,
        assetsValid: visualAssetsValid,
        archiveUnique: visualArchiveUnique
    } = visualAssetsAreValid(visual);
    let visualManifestCurrent = false;
    if (publication && visual) {
        try {
            assertVisualManifestCurrent(visual, publication, targetDate);
            visualManifestCurrent = true;
        } catch (_error) {
            visualManifestCurrent = false;
        }
    }
    const visualComplete = visual?.batchDate === targetDate
        && visual?.overallStatus === 'complete'
        && visual?.counts?.completeCards === visual?.counts?.totalCards
        && visualCards.length === visual?.counts?.totalCards
        && visual?.counts?.pendingCards === 0
        && visual?.counts?.failedCards === 0
        && visualAssetsValid
        && visualArchiveUnique
        && visualManifestCurrent;
    const expectedCoverToken = coverTaskToken(
        cover?.dataSha256,
        cover?.promptSha256,
        cover?.publication
    );
    let coverManifestCurrent = false;
    if (publication && cover) {
        try {
            assertDigestCoverManifestCurrent(cover, publication, targetDate);
            coverManifestCurrent = true;
        } catch (_error) {
            coverManifestCurrent = false;
        }
    }
    const coverComplete = cover?.batchDate === targetDate
        && cover?.overallStatus === 'complete'
        && validateCompletedCover(cover?.cover, cover?.dataSha256, cover?.promptSha256, expectedCoverToken)
        && coverManifestCurrent;
    const filteredBatch = papersFrom(filtered).filter(paper => paperDate(paper) === targetDate);
    const filteredComplete = Boolean(
        filtered?.batchDate === targetDate
        && filtered?.status === 'complete'
        && decisionsComplete
    );
    const analysisComplete = (
        failed.length === 0
        && successful.length === filteredBatch.length
        && samePaperIds(successful, filteredBatch)
    );
    const reviewComplete = review?.strictReview === true && publicationVerified;
    const errors = [];
    if (!fetchComplete) errors.push('抓取来源健康或批次绑定不完整');
    if (!filteredComplete) errors.push('筛选状态、决定覆盖或批次绑定不完整');
    if (!analysisComplete) errors.push('深度分析集合未精确覆盖筛选结果');
    if (!reviewComplete) errors.push('博客严格 review 或远端发布验证未完成');
    if (!visualComplete) errors.push('TOP 10 论文长图状态或资产校验未完成');
    if (!coverComplete) errors.push('汇总封面状态或资产校验未完成');
    const overallComplete = (
        fetchComplete
        && filteredComplete
        && analysisComplete
        && reviewComplete
        && visualComplete
        && coverComplete
    );
    return {
        version: 1,
        batchDate: targetDate,
        generatedAt: getBeijingISOString(),
        overallStatus: overallComplete ? 'complete' : 'incomplete',
        errors,
        fetch: {
            complete: fetchComplete,
            rawCandidateCount: rawCount,
            sourceHealth: raw?.sourceHealth || null
        },
        filter: {
            complete: filteredComplete,
            status: filtered?.status || 'missing',
            selectedCount: filteredBatch.length,
            totalCandidates: decisionStats.totalCandidates ?? null,
            keywordRejected: decisionStats.keywordRejected ?? null,
            llmCandidates: decisionStats.llmCandidates ?? null,
            pendingDecisions: decisionStats.retryable ?? null
        },
        analysis: {
            complete: analysisComplete,
            total: deepBatch.length,
            successful: successful.length,
            failed: failed.length,
            failedIds: failed.map(normalizedId).filter(Boolean)
        },
        blog: {
            complete: reviewComplete,
            strictReview: review?.strictReview === true,
            publicationVerified,
            publicationCommit: review?.publicationCommit || null,
            remoteVerifiedOid: review?.remoteVerifiedOid || null
        },
        visuals: {
            status: visual?.overallStatus || 'missing',
            complete: visual?.counts?.completeCards || 0,
            total: visual?.counts?.totalCards || 0,
            pending: visual?.counts?.pendingCards || 0,
            failed: visual?.counts?.failedCards || 0,
            assetsValid: visualAssetsValid,
            archiveUnique: visualArchiveUnique
        },
        cover: {
            status: cover?.cover?.status || 'missing',
            complete: coverComplete
        }
    };
}

function main(argv = process.argv.slice(2)) {
    setupScriptLogging(__filename);
    const targetDate = parseDate(argv);
    const report = buildDigestRunReport(targetDate);
    const output = path.join(Config.FILES.digestRunReportDir, `${targetDate}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    writeFileAtomic(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`[digest-status] 报告: ${output}`);
    if (report.overallStatus !== 'complete') process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
    parseDate,
    sourceHealthComplete,
    samePaperIds,
    visualAssetsAreValid,
    buildDigestRunReport
};

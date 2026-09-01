#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

function sha256File(filePath) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch (_error) {
        return null;
    }
}

function postPublishVisualWaiverIsValid(waiver, targetDate, publication, visualPath, coverPath) {
    return Boolean(
        waiver?.version === 1
        && waiver?.batchDate === targetDate
        && waiver?.status === 'waived'
        && waiver?.requestedBy === 'user'
        && typeof waiver?.reason === 'string' && waiver.reason.trim().length >= 10
        && waiver?.publicationCommit === publication?.publicationCommit
        && waiver?.remoteVerifiedOid === publication?.remoteVerifiedOid
        && waiver?.remoteVerifiedOid === waiver?.publicationCommit
        && waiver?.generationManifestSha256 === publication?.generationManifestSha256
        && waiver?.visualManifestSha256 === sha256File(visualPath)
        && waiver?.coverManifestSha256 === sha256File(coverPath)
    );
}

function papersFrom(value) {
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.papers) ? value.papers : [];
}

function productionV6PaperComplete(paper) {
    const contracts = paper?.analysisManifest?.contracts;
    const provenance = paper?.manualV6Provenance;
    const acquisition = paper?.analysisManifest?.sourceAcquisition;
    const requiredShaFields = [
        'specRootSha256', 'paperSpecSha256', 'sealedRecordSha256',
        'recordFileSha256', 'artifactIndexSha256', 'artifactIndexFileSha256',
        'recordsEnvelopeFileSha256', 'taskEvidenceSha256',
        'readerLongformSha256', 'readerLongformArticleSha256'
    ];
    return Boolean(
        paper?.manualDepth === 'full-text-evidence-v6'
        && contracts?.manualDepth === 'full-text-evidence-v6'
        && contracts?.readerLongform === 'reader-longform-v2'
        && contracts?.artifactIndex === 'manual-artifact-parser-v2-structured'
        && provenance?.specVersion === 6
        && provenance?.runtimeMode === 'production'
        && paper?.manualArtifactIndex?.inventoryHealth?.status === 'complete'
        && paper?.manualReaderLongform?.contract === 'reader-longform-v2'
        && requiredShaFields.every(field => (
            /^[a-f0-9]{64}$/.test(String(provenance?.[field] || ''))
            && (!Object.hasOwn(acquisition || {}, field)
                || acquisition[field] === provenance[field])
        ))
    );
}

function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
    }
    return value;
}

function stableSha256(value) {
    return crypto.createHash('sha256')
        .update(Buffer.from(JSON.stringify(stableJson(value)), 'utf8')).digest('hex');
}

function textSha256(value) {
    return crypto.createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

function llmApiPaperComplete(paper) {
    const manifest = paper?.analysisManifest;
    const contracts = manifest?.contracts;
    const source = manifest?.sourceAcquisition;
    const scoring = manifest?.stages?.scoringAudit;
    const reader = manifest?.stages?.apiReaderArticle;
    const analysis = typeof paper?.analysis === 'string' ? paper.analysis : '';
    const article = typeof paper?.apiReaderArticle === 'string' ? paper.apiReaderArticle : '';
    const parsedScore = Number(paper?.parsed?.score);
    const finalScore = Number(scoring?.finalScore);
    const isSha256 = value => /^[a-f0-9]{64}$/.test(String(value || ''));
    return Boolean(
        contracts?.apiReaderArticle === 'beginner-researcher-v2'
        && source?.fullTextAvailable === true
        && isSha256(source?.sourceSha256)
        && paper?.sourceSha256 === source.sourceSha256
        && scoring?.status === 'complete'
        && scoring?.scoringContract === 'api-scoring-audit-v2'
        && isSha256(scoring?.auditSha256)
        && isSha256(scoring?.evidenceSha256)
        && scoring?.outputAnalysisSha256 === textSha256(analysis)
        && Number.isFinite(parsedScore) && Number.isFinite(finalScore)
        && Math.abs(parsedScore - finalScore) <= 1e-9
        && reader?.status === 'complete'
        && typeof reader?.model === 'string' && reader.model.trim()
        && typeof reader?.protocol === 'string' && reader.protocol.trim()
        && isSha256(paper?.apiReaderArticleSha256)
        && paper.apiReaderArticleSha256 === textSha256(article)
        && reader.articleSha256 === paper.apiReaderArticleSha256
        && isSha256(paper?.apiReaderPlanSha256)
        && paper.apiReaderPlanSha256 === stableSha256(paper?.apiReaderPlan)
        && reader.planSha256 === paper.apiReaderPlanSha256
        && reader.figuresSha256 === stableSha256(paper?.apiReaderFigures || [])
        && reader.readerAuthorsSha256 === stableSha256(paper?.apiReaderAuthors || {})
    );
}

function paperDate(paper) {
    return paperBatchDate(paper);
}

function snapshotMatchesDate(value, targetDate, kind) {
    if (!value || typeof value !== 'object') return false;
    if (kind === 'decisions') return value.batchDate === targetDate;
    if (kind !== 'deep' && value.batchDate !== targetDate) return false;
    if (kind === 'deep' && value.batchDate && value.batchDate !== targetDate) return false;
    const papers = papersFrom(value);
    try {
        return papers.every(paper => paperDate(paper) === targetDate);
    } catch (_error) {
        return false;
    }
}

function resolveDigestRuntimeSnapshot(
    currentPath, targetDate, kind,
    { archiveDir = Config.ARCHIVE_DIR, today = getBeijingISOString().slice(0, 10) } = {}
) {
    const current = readJson(currentPath);
    if (snapshotMatchesDate(current, targetDate, kind)) {
        return { value: current, source: 'current', path: currentPath };
    }
    // Today's status must describe today's mutable runtime state. Falling back
    // to a stale archive would conceal a missing, corrupt, or rolled-forward
    // current file. Future dates are equally ineligible for historical reuse.
    if (targetDate >= today) {
        return { value: null, source: 'missing', path: currentPath };
    }
    const archivedPath = path.join(archiveDir, targetDate, path.basename(currentPath));
    if (!fs.existsSync(archivedPath)) {
        return { value: null, source: 'missing', path: archivedPath };
    }
    const archived = readJson(archivedPath);
    if (!snapshotMatchesDate(archived, targetDate, kind)) {
        return { value: null, source: 'invalid', path: archivedPath };
    }
    return { value: archived, source: 'archive', path: archivedPath };
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

function uniquePaperIds(papers) {
    const values = papers.map(normalizedId).filter(Boolean);
    if (values.length !== papers.length || new Set(values).size !== values.length) return null;
    return new Set(values);
}

function filterSnapshotsAreConsistent(raw, decisions, filtered, targetDate) {
    if (
        !snapshotMatchesDate(raw, targetDate, 'raw')
        || !snapshotMatchesDate(decisions, targetDate, 'decisions')
        || !snapshotMatchesDate(filtered, targetDate, 'filtered')
        || filtered?.status !== 'complete'
        || !decisions?.decisions
        || typeof decisions.decisions !== 'object'
        || Array.isArray(decisions.decisions)
    ) return false;

    const rawPapers = papersFrom(raw);
    const filteredPapers = papersFrom(filtered);
    const rawIds = uniquePaperIds(rawPapers);
    const filteredIds = uniquePaperIds(filteredPapers);
    if (!rawIds || !filteredIds || rawIds.size === 0) return false;

    const normalizedDecisions = new Map();
    for (const [key, decision] of Object.entries(decisions.decisions)) {
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return false;
        const keyId = normalizedId(key);
        const recordId = normalizedId(decision);
        const id = recordId || keyId;
        if (
            !id
            || (recordId && keyId && recordId !== keyId)
            || normalizedDecisions.has(id)
            || typeof decision.related !== 'boolean'
            || decision.retryable === true
            || decision.fallback === true
        ) return false;
        normalizedDecisions.set(id, decision);
    }
    if (
        normalizedDecisions.size !== rawIds.size
        || [...rawIds].some(id => !normalizedDecisions.has(id))
        || [...normalizedDecisions].some(([id]) => !rawIds.has(id))
    ) return false;

    const excludedValues = Array.isArray(filtered.excludedRelatedIds)
        ? filtered.excludedRelatedIds.map(normalizedId).filter(Boolean)
        : [];
    const excluded = new Set(excludedValues);
    if (excluded.size !== excludedValues.length) return false;
    for (const id of excluded) {
        if (!rawIds.has(id) || normalizedDecisions.get(id)?.related !== true) return false;
    }
    const related = new Set(
        [...normalizedDecisions]
            .filter(([, decision]) => decision.related === true)
            .map(([id]) => id)
    );
    const expectedFiltered = new Set([...related].filter(id => !excluded.has(id)));
    if (
        expectedFiltered.size !== filteredIds.size
        || [...expectedFiltered].some(id => !filteredIds.has(id))
    ) return false;

    const decisionStats = decisions.stats || {};
    const filteredStats = filtered.stats || {};
    if (
        decisionStats.complete !== true
        || decisionStats.retryable !== 0
        || decisionStats.totalCandidates !== rawIds.size
        || decisionStats.decided !== rawIds.size
        || decisionStats.related !== related.size
        || filteredStats.afterBlogSkip !== rawIds.size
        || filteredStats.decisionCount !== rawIds.size
        || filteredStats.afterFilter !== related.size
        || filteredStats.afterArchiveSkip !== filteredIds.size
        || filteredStats.skippedFromArchive !== excluded.size
    ) return false;
    if (
        Number.isInteger(raw?.stats?.afterBlogSkip)
        && raw.stats.afterBlogSkip !== rawIds.size
    ) return false;
    return true;
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

function buildDigestRunReport(targetDate, options = {}) {
    const today = options.today || getBeijingISOString().slice(0, 10);
    const snapshotOptions = {
        archiveDir: options.archiveDir || Config.ARCHIVE_DIR,
        today
    };
    const rawSnapshot = resolveDigestRuntimeSnapshot(
        Config.FILES.rawCandidates, targetDate, 'raw', snapshotOptions
    );
    const filteredSnapshot = resolveDigestRuntimeSnapshot(
        Config.FILES.filteredPapers, targetDate, 'filtered', snapshotOptions
    );
    const decisionsSnapshot = resolveDigestRuntimeSnapshot(
        Config.FILES.filterDecisions, targetDate, 'decisions', snapshotOptions
    );
    const deepSnapshot = resolveDigestRuntimeSnapshot(
        Config.FILES.deepAnalysisResult, targetDate, 'deep', snapshotOptions
    );
    const raw = rawSnapshot.value;
    const filtered = filteredSnapshot.value;
    const decisions = decisionsSnapshot.value;
    const deep = deepSnapshot.value;
    const review = readJson(path.join(Config.CURRENT_DIR, `blog-review-receipt-${targetDate}.json`));
    const visualPath = path.join(Config.FILES.visualSummaryManifestDir, `${targetDate}.json`);
    const coverPath = path.join(Config.FILES.digestCoverManifestDir, `${targetDate}.json`);
    const visual = readJson(visualPath);
    const cover = readJson(coverPath);
    const visualWaiver = readJson(path.join(
        Config.FILES.postPublishVisualWaiverDir, `${targetDate}.json`
    ));
    const deepBatch = papersFrom(deep);
    const successful = deepBatch.filter(isSuccessfulAnalysisRecord);
    const failed = deepBatch.filter(paper => !isSuccessfulAnalysisRecord(paper));
    const rawCount = papersFrom(raw).length;
    const fetchComplete = sourceHealthComplete(raw, targetDate);
    const decisionStats = decisions?.stats || {};
    const filterSnapshotsComplete = filterSnapshotsAreConsistent(
        raw, decisions, filtered, targetDate
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
    const reviewComplete = review?.strictReview === true && publicationVerified;
    const visualsWaived = reviewComplete
        && postPublishVisualWaiverIsValid(
            visualWaiver, targetDate, review, visualPath, coverPath
        );
    const visualGateComplete = visualComplete || visualsWaived;
    const coverGateComplete = coverComplete || visualsWaived;
    const filteredBatch = papersFrom(filtered);
    const filteredComplete = Boolean(
        filtered?.batchDate === targetDate
        && filtered?.status === 'complete'
        && filterSnapshotsComplete
    );
    const productionV6Complete = deepBatch.length > 0
        && deepBatch.every(productionV6PaperComplete);
    const llmApiComplete = deepBatch.length > 0
        && deepBatch.every(llmApiPaperComplete);
    const analysisPublicationMode = productionV6Complete
        ? 'manual_v6_production'
        : (llmApiComplete ? 'llm_api_production' : 'invalid_or_legacy');
    const productionAnalysisComplete = productionV6Complete || llmApiComplete;
    const analysisComplete = Boolean(deep && filtered) && productionAnalysisComplete && (
        failed.length === 0
        && successful.length === filteredBatch.length
        && samePaperIds(successful, filteredBatch)
    );
    const errors = [];
    if (!fetchComplete) errors.push('抓取来源健康或批次绑定不完整');
    if (!filteredComplete) errors.push('筛选状态、决定覆盖或批次绑定不完整');
    if (!analysisComplete) errors.push(
        productionAnalysisComplete
            ? '深度分析集合未精确覆盖筛选结果'
            : '正式 current canonical 既不是完整 Manual v6，也不是完整 LLM API production'
    );
    if (!reviewComplete) errors.push('博客严格 review 或远端发布验证未完成');
    if (!visualGateComplete) errors.push('TOP 10 论文长图状态或资产校验未完成');
    if (!coverGateComplete) errors.push('汇总封面状态或资产校验未完成');
    const overallComplete = (
        fetchComplete
        && filteredComplete
        && analysisComplete
        && reviewComplete
        && visualGateComplete
        && coverGateComplete
    );
    return {
        version: 1,
        batchDate: targetDate,
        generatedAt: getBeijingISOString(),
        overallStatus: overallComplete ? 'complete' : 'incomplete',
        errors,
        dataSources: {
            rawCandidates: rawSnapshot.source,
            filteredPapers: filteredSnapshot.source,
            filterDecisions: decisionsSnapshot.source,
            deepAnalysisResult: deepSnapshot.source
        },
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
            publicationMode: analysisPublicationMode,
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
            gateComplete: visualGateComplete,
            status: visualsWaived ? 'waived' : (visual?.overallStatus || 'missing'),
            waived: visualsWaived,
            complete: visual?.counts?.completeCards || 0,
            total: visual?.counts?.totalCards || 0,
            pending: visual?.counts?.pendingCards || 0,
            failed: visual?.counts?.failedCards || 0,
            assetsValid: visualAssetsValid,
            archiveUnique: visualArchiveUnique
        },
        cover: {
            status: visualsWaived ? 'waived' : (cover?.cover?.status || 'missing'),
            complete: coverGateComplete,
            waived: visualsWaived
        }
    };
}

function formatDigestRunSummary(report) {
    const state = value => value ? 'complete' : 'incomplete';
    const lines = [
        `[digest-status] ${report.batchDate} overall=${report.overallStatus} errors=${report.errors.length}`,
        `  抓取 ${state(report.fetch.complete)} | candidates=${report.fetch.rawCandidateCount}`,
        `  筛选 ${state(report.filter.complete)} | selected=${report.filter.selectedCount} | candidates=${report.filter.totalCandidates ?? '?'} | pending=${report.filter.pendingDecisions ?? '?'}`,
        `  分析 ${state(report.analysis.complete)} | success=${report.analysis.successful}/${report.analysis.total} | failed=${report.analysis.failed}`,
        `  博客 ${state(report.blog.complete)} | strictReview=${report.blog.strictReview} | remoteVerified=${report.blog.publicationVerified}`,
        `  长图 ${report.visuals.waived ? 'waived' : state(report.visuals.gateComplete === true)} | complete=${report.visuals.complete}/${report.visuals.total} | pending=${report.visuals.pending} | failed=${report.visuals.failed}`,
        `  封面 ${report.cover.waived ? 'waived' : state(report.cover.complete)} | status=${report.cover.status}`
    ];
    for (const error of report.errors) lines.push(`  错误: ${error}`);
    return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
    setupScriptLogging(__filename);
    const targetDate = parseDate(argv);
    const report = buildDigestRunReport(targetDate);
    const output = path.join(Config.FILES.digestRunReportDir, `${targetDate}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    writeFileAtomic(output, JSON.stringify(report, null, 2));
    console.log(formatDigestRunSummary(report));
    console.log(`[digest-status] 报告: ${output}`);
    if (report.overallStatus !== 'complete') process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
    parseDate,
    snapshotMatchesDate,
    resolveDigestRuntimeSnapshot,
    sourceHealthComplete,
    samePaperIds,
    filterSnapshotsAreConsistent,
    visualAssetsAreValid,
    postPublishVisualWaiverIsValid,
    productionV6PaperComplete,
    llmApiPaperComplete,
    buildDigestRunReport,
    formatDigestRunSummary
};

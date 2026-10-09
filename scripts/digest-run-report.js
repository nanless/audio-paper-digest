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
const {
    isSuccessfulAnalysisRecord,
    scoringAuditBindsFinalAnalysis,
    scoringStabilityIsResolved,
    hasValidApiReaderV3Records
} = require('./analysis-engine.js');
const { setupScriptLogging } = require('./log-setup.js');
const { validateDailyFreshSourceRun } = require('./validate-data-files.js');
const { loadAnalysisWaiver, validateAnalysisWaiver } = require('./analysis-waiver.js');
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

// 文件不存在表示阶段尚未运行；读取或解析失败须单独记入诊断。
function readJson(filePath, readProblems = null) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT' && readProblems) {
            readProblems.push({ path: filePath, kind: 'unreadable', code: error?.code || null });
        }
        return null;
    }
    try {
        return JSON.parse(text);
    } catch (_error) {
        if (readProblems) readProblems.push({ path: filePath, kind: 'invalid-json' });
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
        contracts?.apiReaderArticle === 'beginner-researcher-v3'
        && paper?.apiReaderPlan?.version === 3
        && source?.fullTextAvailable === true
        && isSha256(source?.sourceSha256)
        && paper?.sourceSha256 === source.sourceSha256
        && scoring?.status === 'complete'
        && scoring?.scoringContract === 'api-scoring-audit-v2'
        && scoringStabilityIsResolved(scoring)
        && isSha256(scoring?.auditSha256)
        && isSha256(scoring?.evidenceSha256)
        && scoringAuditBindsFinalAnalysis(paper)
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
        && hasValidApiReaderV3Records(paper)
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
    {
        archiveDir = Config.ARCHIVE_DIR,
        today = getBeijingISOString().slice(0, 10),
        readProblems = null
    } = {}
) {
    const current = readJson(currentPath, readProblems);
    if (snapshotMatchesDate(current, targetDate, kind)) {
        return { value: current, source: 'current', path: currentPath };
    }
    // 当天的状态必须反映当天可变的运行数据。退回旧归档会把 current 文件缺失、
    // 损坏或已被滚到后一天的情况掩盖掉。未来日期同样不能拿历史数据来顶。
    if (targetDate >= today) {
        return { value: null, source: 'missing', path: currentPath };
    }
    const archivedPath = path.join(archiveDir, targetDate, path.basename(currentPath));
    if (!fs.existsSync(archivedPath)) {
        return { value: null, source: 'missing', path: archivedPath };
    }
    const archived = readJson(archivedPath, readProblems);
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
    const assetsValid = visualCards.length > 0 && visualCards.every(({ id, paper, kind, card }) => {
        let assetPath;
        try {
            assetPath = visualSummaryAssetPath(
                visual.batchDate, id, kind, paper.rank, paper.title || ''
            );
        } catch (_error) {
            // 清单里的归档路径参数非法时，这张卡本来就不可能核验通过。按无效处理，
            // 不要让整个状态报告抛栈——运维要的是报告，不是崩溃。
            return false;
        }
        return validateCompletedCard(
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
            assetPath
        );
    });
    let archiveUnique = false;
    try {
        archiveUnique = Boolean(visual && assertVisualArchiveUniqueness(visual));
    } catch (_error) {
        archiveUnique = false;
    }
    return { visualCards, assetsValid, archiveUnique };
}

// 未知长图数量用 null 表示；零表示已知数量为零。
function visualCount(value) {
    return Number.isInteger(value) ? value : null;
}

// 分开报告逐篇核验失败和集合缺口，避免把旧记录不兼容误报成缺篇。
function analysisFailureMessage({
    productionAnalysisComplete, failedCount, failedIds, missing, total, expected
}) {
    if (!productionAnalysisComplete) {
        return '当前分析资料既未满足 Manual v6 的完整要求，也未满足 API 正式发布的完整要求。';
    }
    // 缺口篇数读不到时说「未知」，不要把它拼成「还缺 null 篇」——这个组合是可达的
    // （归档里有分析结果、而当天筛选快照已经不在 data/current）。
    const coverage = Number.isInteger(missing)
        ? (missing === 0 ? '集合覆盖精确' : `集合还缺 ${missing} 篇`)
        : '集合缺口未知';
    if (failedCount > 0) {
        const sample = (failedIds || []).slice(0, 3).join(', ') || '?';
        // 尾句只能限定「未通过核验」这一项。集合缺篇是另一件事，不能被这句话一起带过去，
        // 否则真的缺篇会被读成「反正不是运行失败」。
        return `深度分析有 ${failedCount} 篇未通过逐篇核验（如 ${sample}）；${coverage}。`
            + '未通过核验的这部分是拿当前词表与契约复验已存记录，不等于当时那次运行失败。';
    }
    if (!Number.isInteger(missing)) {
        return '深度分析集合未精确覆盖筛选结果，缺口篇数未知';
    }
    // 没有缺篇却没精确覆盖，说明成员对不上。**不要写「篇数相同」**：分析结果是筛选入选集
    // 的超集时 missing 也是 0，而两边篇数并不相等，那样写会和同一份报告里的
    // total/expected 自相矛盾。把两个数直接摆出来。
    if (missing === 0) {
        const counts = Number.isInteger(total) && Number.isInteger(expected)
            ? `（分析结果 ${total} 篇、筛选入选 ${expected} 篇）`
            : '';
        return `深度分析集合没有缺篇，但成员与筛选入选集对不上${counts}`;
    }
    return `深度分析集合未精确覆盖筛选结果：还缺 ${missing} 篇`;
}

function buildDigestRunReport(targetDate, options = {}) {
    const today = options.today || getBeijingISOString().slice(0, 10);
    const readProblems = [];
    const snapshotOptions = {
        archiveDir: options.archiveDir || Config.ARCHIVE_DIR,
        today,
        readProblems
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
    const review = readJson(
        path.join(Config.CURRENT_DIR, `blog-review-receipt-${targetDate}.json`), readProblems
    );
    const visualPath = path.join(Config.FILES.visualSummaryManifestDir, `${targetDate}.json`);
    const coverPath = path.join(Config.FILES.digestCoverManifestDir, `${targetDate}.json`);
    const visual = readJson(visualPath, readProblems);
    const cover = readJson(coverPath, readProblems);
    const visualWaiver = readJson(path.join(
        Config.FILES.postPublishVisualWaiverDir, `${targetDate}.json`
    ), readProblems);
    const analysisWaiver = loadAnalysisWaiver(targetDate, Config.FILES);
    const analysisWaiverCheck = validateAnalysisWaiver(
        analysisWaiver, targetDate, Config.FILES, { deep }
    );
    const analysisWaivedIds = analysisWaiverCheck.valid ? analysisWaiverCheck.paperIds : new Set();
    const deepBatch = papersFrom(deep);
    const successful = deepBatch.filter(isSuccessfulAnalysisRecord);
    const failed = deepBatch.filter(paper => (
        !isSuccessfulAnalysisRecord(paper) && !analysisWaivedIds.has(normalizedId(paper))
    ));
    // 成功结果继续按成功核验；豁免只覆盖失败结果，避免同一篇同时计入两组。
    const waived = deepBatch.filter(paper => analysisWaivedIds.has(normalizedId(paper))
        && !isSuccessfulAnalysisRecord(paper));
    const waivedPaperIds = new Set(waived.map(normalizedId));
    const requiredAnalysis = deepBatch.filter(paper => !waivedPaperIds.has(normalizedId(paper)));
    const failedIds = failed.map(normalizedId).filter(Boolean);
    // 候选快照读不到时报 null，不报 0。0 是「快照在、候选就是空」这一种真实取值，
    // 和「快照根本不在」不是一回事；旧写法两者都是 0，摘要于是出现
    // `candidates=0` 同屏 `selected=53` 这种不可能的组合。
    const rawCount = raw ? papersFrom(raw).length : null;
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
    // 凭证整体有效与保存的远端 OID 一致是两项独立检查。
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
    // 远端 OID 是否核验，与整份凭证是否有效分开。凭证无效时这一项仍可能是 true，
    // 那时该说的是「推送到了远端，但凭证别处没过」，而不是「没推到远端」。
    const remoteOidVerified = Boolean(review?.publicationCommit)
        && review?.remoteVerifiedOid === review?.publicationCommit;
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
    // total 统计实际分析记录，expected 和 missing 另行表示入选集合及缺口。
    const deepIds = new Set(deepBatch.map(normalizedId).filter(Boolean));
    const analysisExpected = filtered ? filteredBatch.length : null;
    const analysisMissing = filtered
        ? filteredBatch.filter(paper => {
            const id = normalizedId(paper);
            return !id || !deepIds.has(id);
        }).length
        : null;
    const productionV6Complete = deepBatch.length > 0
        && deepBatch.every(productionV6PaperComplete);
    // 至少有一篇可发布的分析；豁免不会把全失败批次变成空内容发布。
    const llmApiComplete = requiredAnalysis.length > 0
        && requiredAnalysis.every(llmApiPaperComplete);
    const dailySourceIssues = [];
    if (deep && !Array.isArray(deep)) {
        validateDailyFreshSourceRun(deepSnapshot.path || Config.FILES.deepAnalysisResult, deep, deepBatch, dailySourceIssues);
    }
    const dailySourceComplete = llmApiComplete && dailySourceIssues.length === 0
        && Boolean(deep?.dailyFreshSourceRun);
    const analysisPublicationMode = productionV6Complete
        ? 'manual_v6_production'
        : (llmApiComplete
            ? (waived.length ? 'llm_api_production_with_operator_waiver' : 'llm_api_production')
            : 'invalid_or_legacy');
    const productionAnalysisComplete = productionV6Complete || (llmApiComplete && dailySourceComplete);
    const unresolvedScoringIds = requiredAnalysis.filter(paper => {
        const scoring = paper?.analysisManifest?.stages?.scoringAudit;
        return scoring?.scoringContract === 'api-scoring-audit-v2'
            && !scoringStabilityIsResolved(scoring);
    }).map(normalizedId).filter(Boolean);
    const analysisComplete = Boolean(deep && filtered) && analysisWaiverCheck.valid
        && productionAnalysisComplete && (
        failed.length === 0
        && successful.length + waived.length === filteredBatch.length
        && samePaperIds([...successful, ...waived], filteredBatch)
    );
    const errors = [];
    if (!fetchComplete) errors.push('抓取来源健康或批次绑定不完整');
    if (!filteredComplete) errors.push('筛选状态、决定覆盖或批次绑定不完整');
    if (unresolvedScoringIds.length > 0) {
        errors.push(`评分稳定性二次审计尚未收敛: ${unresolvedScoringIds.join(', ')}`);
    }
    if (analysisWaiver && !analysisWaiverCheck.valid) {
        errors.push(`日更分析 waiver 无效: ${analysisWaiverCheck.issues.join('; ')}`);
    }
    if (!analysisComplete) errors.push(analysisFailureMessage({
        productionAnalysisComplete,
        failedCount: failed.length,
        failedIds,
        missing: analysisMissing,
        total: deepBatch.length,
        expected: analysisExpected
    }));
    if (llmApiComplete && !dailySourceComplete) {
        errors.push(`日更来源运行记录及封存的 TXT/PDF 不完整：${dailySourceIssues.join('; ') || '缺少 dailyFreshSourceRun'}`);
    }
    if (!reviewComplete) errors.push('博客审查或远端发布验证尚未完成。');
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
    // 未决候选数。筛选运行在写完全部决定前被杀时，缺口里没有可重试项，所以只能用
    // 「候选总数减去已决定数」来算还差多少篇。两个数任缺一个就报 null，不要猜。
    const decidedTotal = decisions?.stats?.totalCandidates;
    const decidedCount = decisions?.stats?.decided;
    const undecidedDecisionCount = (
        Number.isInteger(decidedTotal) && Number.isInteger(decidedCount)
    ) ? Math.max(0, decidedTotal - decidedCount) : null;
    return {
        // v3 区分未知计数与零，并单列读取问题；视觉状态由核验结果确定。
        version: 3,
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
        // 只列实际读取或解析失败，不包括尚未创建的文件。
        readProblems,
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
            decided: decisionStats.decided ?? null,
            keywordRejected: decisionStats.keywordRejected ?? null,
            llmCandidates: decisionStats.llmCandidates ?? null,
            // 尚未保存决定的候选与已标为可重试的决定分开计数。
            pendingDecisions: undecidedDecisionCount,
            retryableDecisions: decisionStats.retryable ?? null
        },
        analysis: {
            complete: analysisComplete,
            publicationMode: analysisPublicationMode,
            total: deepBatch.length,
            expected: analysisExpected,
            missing: analysisMissing,
            successful: successful.length,
            waived: waived.length,
            waivedIds: waived.map(normalizedId).filter(Boolean),
            failed: failed.length,
            failedIds,
            waiver: analysisWaiverCheck.valid && analysisWaiver ? {
                contract: analysisWaiver.contract,
                reason: analysisWaiver.reason,
                waivedAt: analysisWaiver.waivedAt,
                sha256: analysisWaiver.waiverSha256
            } : null,
            scoringStabilityUnresolvedIds: unresolvedScoringIds,
            dailyFreshSource: {
                complete: dailySourceComplete,
                reference: deep?.dailyFreshSourceRun || null,
                issues: dailySourceIssues
            }
        },
        blog: {
            complete: reviewComplete,
            strictReview: review?.strictReview === true,
            publicationVerified,
            remoteOidVerified,
            publicationCommit: review?.publicationCommit || null,
            remoteVerifiedOid: review?.remoteVerifiedOid || null
        },
        visuals: {
            gateComplete: visualGateComplete,
            // 核验未通过时，不能沿用清单自报的 complete。
            status: visualsWaived
                ? 'waived'
                : (visualGateComplete
                    ? 'complete'
                    : (visual?.overallStatus && visual.overallStatus !== 'complete'
                        ? visual.overallStatus
                        : (visual ? 'incomplete' : 'missing'))),
            waived: visualsWaived,
            // 未知数量保留为 null，摘要显示问号。
            complete: visualCount(visual?.counts?.completeCards),
            total: visualCount(visual?.counts?.totalCards),
            pending: visualCount(visual?.counts?.pendingCards),
            failed: visualCount(visual?.counts?.failedCards),
            assetsValid: visualAssetsValid,
            archiveUnique: visualArchiveUnique
        },
        cover: {
            // 封面的完成状态同样以核验结果为准。
            status: visualsWaived
                ? 'waived'
                : (coverGateComplete
                    ? 'complete'
                    : (cover?.cover?.status && cover.cover.status !== 'complete'
                        ? cover.cover.status : 'incomplete')),
            complete: coverGateComplete,
            waived: visualsWaived
        }
    };
}

function formatDigestRunSummary(report) {
    const displayStatus = value => {
        const labels = { complete: '完成', incomplete: '未完成', waived: '已豁免', missing: '缺失', pending: '待处理', failed: '失败', partial_failed: '部分失败' };
        return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : `未知状态（${String(value)}）`;
    };
    const displayBoolean = value => value === true ? '是' : value === false ? '否' : `未知值（${String(value)}）`;
    const state = value => value ? '完成' : '未完成';
    // 封面没有通过完整检查时，不能因清单自称 complete 就在摘要中显示完成。
    // 构建报告时已核验过一次；这里也检查传入状态，兼容旧报告或手工构造的报告。
    const printedCoverStatus = cover => {
        if (cover?.waived) return 'waived';
        if (cover?.complete) return 'complete';
        return cover?.status === 'complete' ? 'incomplete' : (cover?.status ?? 'missing');
    };
    // 长图也按实际检查结果显示状态；没有通过检查时，不能显示 complete。
    // 旧 JSON 或手工构造的报告即使自称 complete，这里仍会显示 incomplete。
    const printedVisualStatus = visuals => {
        if (visuals?.waived) return 'waived';
        if (visuals?.gateComplete === true) return 'complete';
        return visuals?.status === 'complete' ? 'incomplete' : (visuals?.status ?? 'missing');
    };
    const lines = [
        `[digest-status] ${report.batchDate} 本报告状态=${displayStatus(report.overallStatus)} 问题数=${report.errors.length}`,
        `  抓取 ${state(report.fetch.complete)} | 候选数=${report.fetch.rawCandidateCount ?? '?'}`,
        `  筛选 ${state(report.filter.complete)} | 入选数=${report.filter.selectedCount} | 候选数=${report.filter.totalCandidates ?? '?'} | 尚未保存决定数=${report.filter.pendingDecisions ?? '?'}`,
        `  分析 ${state(report.analysis.complete)} | 通过分析检查数=${report.analysis.successful}/${report.analysis.total} | 预期入选数=${report.analysis.expected ?? '?'} | 缺少分析记录数=${report.analysis.missing ?? '?'} | 已豁免分析数=${report.analysis.waived || 0} | 失败数=${report.analysis.failed}`,
        ...(report.analysis.scoringStabilityUnresolvedIds?.length
            ? [`  评分稳定性 尚未解决的论文=${report.analysis.scoringStabilityUnresolvedIds.join(',')}`]
            : []),
        `  博客 ${state(report.blog.complete)} | 严格审查记录=${displayBoolean(report.blog.strictReview)} | 发布提交与已存远端提交一致=${displayBoolean(report.blog.remoteOidVerified === true)} | 发布凭证有效=${displayBoolean(report.blog.publicationVerified)}`,
        `  长图 ${report.visuals.waived ? '已豁免' : state(report.visuals.gateComplete === true)} | 状态=${displayStatus(printedVisualStatus(report.visuals))} | 清单记录的完成数=${report.visuals.complete ?? '?'}/${report.visuals.total ?? '?'} | 待处理数=${report.visuals.pending ?? '?'} | 失败数=${report.visuals.failed ?? '?'}`,
        `  封面 ${report.cover.waived ? '已豁免' : state(report.cover.complete)} | 状态=${displayStatus(printedCoverStatus(report.cover))}`,
        '  本报告未核验网站上线：还须检查对应提交的构建和部署结果，以及全部目标网页的正式地址、HTTP 200 和标题；报告显示“完成”不表示网站已上线。'
    ];
    for (const error of report.errors) lines.push(`  错误: ${error}`);
    // 文件存在却读不出来时要说出来。文件不存在不会进这个数组，也不该报成错误。
    for (const problem of report.readProblems || []) {
        const what = problem?.kind === 'invalid-json'
            ? '存在，但 JSON 解析失败'
            : `存在，但无法读取（${problem?.code || '未知错误'}）`;
        lines.push(`  读取告警: ${problem?.path} ${what}`);
    }
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
    formatDigestRunSummary,
    analysisFailureMessage
};

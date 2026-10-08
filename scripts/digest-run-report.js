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

// 读不到 JSON 有两种原因，后果不一样：文件不存在（这一步还没跑）与文件在但解析失败（坏了）。
// 旧写法两者都返回 null，报告上分不出来，运维会把「损坏」当成「没生成」。
// 现在把后者记进 readProblems，前者保持安静——文件不存在是正常状态，不是错误。
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

// 长图计数读不到时返回 null 而不是 0：0 是一个真实可能的取值（清单在、但一张都没做），
// 和「清单根本不存在」是两件事，不能显示成同一个数。
function visualCount(value) {
    return Number.isInteger(value) ? value : null;
}

// 分析未完成时该报什么。原来的判别式只看 productionAnalysisComplete，而它用的是粗粒度的
// llmApiComplete；successful 用的却是逐篇复验（含 validateTagStageProof）。两者错位，会把
// 「今天拿当前词表复验旧记录不通过」写成「集合未精确覆盖筛选结果」。
// 实测：归档里 101 个有 deep 快照的日期共 2799 篇失败，2799 篇全部是标签阶段复验没过，
// 真正计数不匹配只有 5 天。09-25 那天 75 篇全是词表破坏性变更导致复验不过、集合其实精确
// 覆盖，运维照旧文案会白跑一次 reanalyze（要调模型）。
// 这里要把「复验不通过」和「集合缺篇」分开，并说明复验不是在评价当时那次运行。
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
    const waived = deepBatch.filter(paper => analysisWaivedIds.has(normalizedId(paper)));
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
    // publicationVerified 是「整份凭证通过校验」，它失败的原因可能跟远端无关——实测
    // data/current 下 62 份 receipt 里有 35 份 OID 明明对得上，却因为别的校验项没过而被
    // 摘要报成 remoteVerified=false，读的人会以为推送没到远端。两件事分开报。
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
    // analysis.total 一直只数 deep 集合，于是「筛选出了 N 篇、分析结果里只有 M 篇」这种缺口
    // 显示不出来：08-25 筛选出 46 篇而 deep 快照缺失时，摘要是 `success=0/0 | failed=0`，
    // 看着像没有失败项。这两个字段把分母和缺口补齐，total 的含义不动（仍是 deep 集合大小）。
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
    const llmApiComplete = deepBatch.length > 0
        && deepBatch.every(llmApiPaperComplete);
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
    const unresolvedScoringIds = deepBatch.filter(paper => {
        const scoring = paper?.analysisManifest?.stages?.scoringAudit;
        return scoring?.scoringContract === 'api-scoring-audit-v2'
            && !scoringStabilityIsResolved(scoring);
    }).map(normalizedId).filter(Boolean);
    const analysisComplete = Boolean(deep && filtered) && productionAnalysisComplete && (
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
        // 3：v2 之后又改了两处取值域，旧报告分不出来，所以再升一档。
        //   - visuals.status 由门禁派生，门禁不过时不会再出现 status=complete；
        //   - fetch.rawCandidateCount 读不到快照时是 null，不再伪装成 0；
        //   - 新增 readProblems，区分「文件不存在」与「文件在但解析失败」。
        // 2：这次不只是新增字段，还改了取值域——长图计数可能是 null（未知不再伪装成 0）、
        // cover.status 不再镜像清单内层说法、分析多了 expected/missing、博客把远端 OID
        // 核验与凭证有效性分开。旧报告仍是 1 且是旧口径，靠 version 就能分辨，
        // 不必再去猜某个字段在不在。仓库内没有任何代码读这个 version。
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
        // 存在的文件读不出来时列在这里；真·不存在的文件不会出现在这个数组里。
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
            // 未决数必须是「候选总数减去已决定数」，不能取 retryable：后者只数已经
            // 有决定、但决定本身可重试的条目。运行在写完全部决定之前被杀时，缺口
            // 里没有任何 retryable 项，取 retryable 会显示 pending=0，把还差多少篇
            // 没有决定这件事藏起来。
            // 未获明确决定的候选数（总候选数 − 已决定数）。旧版这里报的是
            // decisions.stats.retryable，只数已经有决定但可重试的条目；运行在
            // 写完全部决定之前被杀时缺口里没有可重试项，旧版会显示 0，把还差
            // 多少篇没有决定藏起来。字段名与报告 version 未变，但语义已改。
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
            // 和封面一样，状态由门禁派生。旧写法直接镜像清单内层的 overallStatus，
            // 于是清单自称 complete、而资产校验或发布绑定已经失败时，摘要会打出
            // `长图 incomplete | status=complete | complete=10/10 | pending=0 | failed=0`。
            // 门禁不过就不替它宣布完成：清单里写的是 pending/partial_failed 就照说，
            // 清单自称 complete 而门禁不过则说 incomplete，清单根本不在才是 missing。
            status: visualsWaived
                ? 'waived'
                : (visualGateComplete
                    ? 'complete'
                    : (visual?.overallStatus && visual.overallStatus !== 'complete'
                        ? visual.overallStatus
                        : (visual ? 'incomplete' : 'missing'))),
            waived: visualsWaived,
            // 这几项原来写成 `|| 0`，于是「没有长图清单」和「清单里长图数为 0」显示成
            // 同一个 0。今天的批次就是这样：摘要显示 complete=0/0、pending=0、failed=0，
            // 看着像全做完了，而真实状态是 missing。读不到计数就报 null，让摘要打印 `?`。
            complete: visualCount(visual?.counts?.completeCards),
            total: visualCount(visual?.counts?.totalCards),
            pending: visualCount(visual?.counts?.pendingCards),
            failed: visualCount(visual?.counts?.failedCards),
            assetsValid: visualAssetsValid,
            archiveUnique: visualArchiveUnique
        },
        cover: {
            // 原来直接取清单内层的 cover.cover.status，于是出现过「封面 incomplete 但
            // status=complete」这种自相矛盾的摘要。状态由门禁派生，内层说法只在门禁
            // 通过时才采纳；门禁不过时最多说「未完成」，不会替它宣布完成。
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
    const state = value => value ? 'complete' : 'incomplete';
    // 摘要不要在同一个「封面」行里既说 incomplete 又说 status=complete。构建报告时
    // 已经按门禁派生过状态，这里再兜一道：门禁不过就不打印 complete。
    const printedCoverStatus = cover => {
        if (cover?.waived) return 'waived';
        if (cover?.complete) return 'complete';
        return cover?.status === 'complete' ? 'incomplete' : (cover?.status ?? 'missing');
    };
    // 长图行同理：门禁不过时不能印 status=complete。构建报告时已经派生过，
    // 这里再兜一道，免得手工拼的报告或旧 JSON 又把矛盾打出来。
    const printedVisualStatus = visuals => {
        if (visuals?.waived) return 'waived';
        if (visuals?.gateComplete === true) return 'complete';
        return visuals?.status === 'complete' ? 'incomplete' : (visuals?.status ?? 'missing');
    };
    const lines = [
        `[digest-status] ${report.batchDate} overall=${report.overallStatus} errors=${report.errors.length}`,
        `  抓取 ${state(report.fetch.complete)} | candidates=${report.fetch.rawCandidateCount ?? '?'}`,
        `  筛选 ${state(report.filter.complete)} | selected=${report.filter.selectedCount} | candidates=${report.filter.totalCandidates ?? '?'} | pending=${report.filter.pendingDecisions ?? '?'}`,
        `  分析 ${state(report.analysis.complete)} | success=${report.analysis.successful}/${report.analysis.total} | expected=${report.analysis.expected ?? '?'} | missing=${report.analysis.missing ?? '?'} | waived=${report.analysis.waived || 0} | failed=${report.analysis.failed}`,
        ...(report.analysis.scoringStabilityUnresolvedIds?.length
            ? [`  评分稳定性 unresolved=${report.analysis.scoringStabilityUnresolvedIds.join(',')}`]
            : []),
        `  博客 ${state(report.blog.complete)} | strictReview=${report.blog.strictReview} | remoteOidVerified=${report.blog.remoteOidVerified === true} | receiptValid=${report.blog.publicationVerified}`,
        `  长图 ${report.visuals.waived ? 'waived' : state(report.visuals.gateComplete === true)} | status=${printedVisualStatus(report.visuals)} | complete=${report.visuals.complete ?? '?'}/${report.visuals.total ?? '?'} | pending=${report.visuals.pending ?? '?'} | failed=${report.visuals.failed ?? '?'}`,
        `  封面 ${report.cover.waived ? 'waived' : state(report.cover.complete)} | status=${printedCoverStatus(report.cover)}`
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

#!/usr/bin/env node
/**
 * Offline/manual deep-analysis ingestion.
 *
 * This command never calls an LLM API.  The operator supplies a
 * per-paper analysis draft, the exact full-text file used to write it, an
 * evidence ledger, and an audited review record.  Every paper is validated and
 * persisted under its own analysis lock; failures are saved only as resumable
 * ingestion checkpoints and never as publishable manual_complete content.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Config = require('./config.js');
const {
    parseAnalysis,
    normalizedId,
    getBeijingISOString
} = require('./utils.js');
const {
    REQUIRED_RECOVERY_STAGES,
    MANUAL_COMPLETE_STATUS,
    MANUAL_STAGE_EXECUTION_KIND,
    manualSha256,
    manualTextSha256,
    validateManualTakeoverManifest,
    validateManualDepthContract,
    MANUAL_DEPTH_CONTRACT_VERSION_V3,
    getInvalidAnalysisReason
} = require('./analysis-contract.js');
const {
    mergeAndSaveResults,
    isSuccessfulAnalysisRecord,
    withPaperAnalysisLock,
    loadCanonicalAnalysisRecord,
    updateJsonFileLocked
} = require('./analysis-engine.js');
const {
    normalizeImageInfos,
    selectImageCandidates,
    cachePublicImageDetailed,
    applyImageInsertionPlan,
    buildImageAnchorCatalog
} = require('./deep-analyzer.js');
const { updateAnalysisDigestStatuses } = require('./digest-status.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const MANUAL_AUTHORING_PROMPT_PATH = path.join(PROJECT_ROOT, 'prompts', 'manual-analysis-record.md');
const STAGE_PROMPT_FILES = Object.freeze({
    primaryAnalysis: 'deep-analysis.md',
    openSourceScan: 'opensource-scan.md',
    revision: 'gap-fill.md',
    tableRepair: 'table-fill.md',
    methodRepair: 'method-fill.md',
    structureRepair: 'structure-repair.md',
    scoringAudit: 'scoring-audit.md',
    imageSupplement: 'image-supplement.md'
});

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
    return sha256Buffer(fs.readFileSync(filePath));
}

function readJson(filePath, label) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`${label} 不可读或 JSON 损坏: ${filePath}: ${error.message}`);
    }
    if (!value || typeof value !== 'object') throw new Error(`${label} 顶层必须是对象: ${filePath}`);
    return value;
}

function parseArgs(argv) {
    const options = { force: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--force') {
            if (options.force) throw new Error('参数重复: --force');
            options.force = true;
            continue;
        }
        if (!['--date', '--spec'].includes(arg)) throw new Error(`未知参数: ${arg}`);
        if (options[arg.slice(2)] !== undefined) throw new Error(`参数重复: ${arg}`);
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        options[arg.slice(2)] = value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date 必须是 YYYY-MM-DD');
    if (!options.spec) throw new Error('--spec 必须指定人工分析规格 JSON');
    return options;
}

function filteredPapersForDate(date) {
    const data = readJson(Config.FILES.filteredPapers, 'filtered-papers');
    if (data.batchDate !== date || data.status !== 'complete' || !Array.isArray(data.papers)) {
        throw new Error(`filtered-papers.json 不是 ${date} 的 complete 批次`);
    }
    const ids = new Set();
    for (const paper of data.papers) {
        const id = normalizedId(paper);
        if (!id || ids.has(id)) throw new Error(`filtered papers 含非法或重复 ID: ${id || '(missing)'}`);
        ids.add(id);
    }
    return data.papers;
}

function stageStatusMap() {
    return Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage, MANUAL_COMPLETE_STATUS]));
}

function buildStagePromptBindings() {
    return Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => {
        const promptFile = STAGE_PROMPT_FILES[stage];
        if (promptFile) {
            return [stage, {
                source: `prompts/${promptFile}`,
                sha256: sha256File(path.join(PROJECT_ROOT, 'prompts', promptFile))
            }];
        }
        return [stage, {
            source: `manual-stage-contract:${stage}:v1`,
            sha256: manualSha256({ contract: 'manual-stage-contract-v1', stage })
        }];
    }));
}

function manualCanonicalReuseFingerprint(record) {
    if (!record || typeof record !== 'object') return null;
    const manifest = record.analysisManifest;
    const takeover = manifest?.manualTakeover;
    if (!manifest || !takeover || takeover.mode !== MANUAL_COMPLETE_STATUS) return null;
    const stages = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => {
        const stageManifest = manifest.stages?.[stage];
        const stageEvidence = takeover.stageEvidence?.[stage];
        return [stage, {
            status: stageManifest?.status || null,
            protocol: stageManifest?.protocol || null,
            promptSource: stageManifest?.promptSource || null,
            promptSha256: stageManifest?.promptSha256 || null,
            fingerprint: stageManifest?.fingerprint || null,
            evidence: {
                status: stageEvidence?.status || null,
                protocol: stageEvidence?.protocol || null,
                inputSha256: stageEvidence?.inputSha256 || null,
                outputSha256: stageEvidence?.outputSha256 || null,
                auditSha256: stageEvidence?.auditSha256 || null,
                attempts: stageEvidence?.attempts ?? null,
                promptSource: stageEvidence?.promptSource || null,
                promptSha256: stageEvidence?.promptSha256 || null,
                contextSha256: stageEvidence?.contextSha256 || null,
                reviewedClaimsSha256: manualSha256(stageEvidence?.reviewedClaims || null)
            }
        }];
    }));
    const imageManifest = record.imageManifest || {};
    const normalizedImage = image => ({
        url: image?.url || null,
        caption: image?.caption || '',
        source: image?.source || null,
        sourceOrder: image?.sourceOrder ?? null,
        candidateScore: image?.candidateScore ?? null,
        mime: image?.mime || null,
        sha256: image?.sha256 || null,
        bytes: image?.bytes ?? null,
        selectionReason: image?.selectionReason || null
    });
    return manualSha256({
        contract: 'manual-canonical-reuse-v1',
        id: normalizedId(record),
        analysisSha256: manualTextSha256(record.analysis || ''),
        declaredAnalysisSha256: takeover.analysisSha256 || null,
        manualAuthoringPromptSha256: takeover.manualAuthoringPromptSha256 || null,
        sourceSha256: record.sourceSha256 || null,
        manifestSourceSha256: manifest.sourceAcquisition?.sourceSha256 || null,
        takeoverSourceSha256: takeover.sourceSha256 || null,
        evidenceLedgerSha256: takeover.evidenceLedgerSha256 || null,
        computedEvidenceLedgerSha256: manualSha256(takeover.evidenceLedger || null),
        auditSha256: manualSha256(takeover.audit || null),
        stages,
        image: {
            version: imageManifest.version ?? null,
            source: imageManifest.source || null,
            totalFound: imageManifest.totalFound ?? null,
            downloadEvidenceSha256: imageManifest.downloadEvidenceSha256 || null,
            selectionEvidenceSha256: imageManifest.selectionEvidenceSha256 || null,
            candidates: (imageManifest.candidates || []).map(normalizedImage),
            downloaded: (imageManifest.downloaded || []).map(normalizedImage),
            downloadOutcomes: imageManifest.downloadOutcomes || [],
            selected: (imageManifest.selected || []).map(normalizedImage)
        }
    });
}

function shouldReuseCanonical(canonical, expectedRecord, force = false) {
    if (force || !isSuccessfulAnalysisRecord(canonical) || !isSuccessfulAnalysisRecord(expectedRecord)) {
        return false;
    }
    const canonicalFingerprint = manualCanonicalReuseFingerprint(canonical);
    const expectedFingerprint = manualCanonicalReuseFingerprint(expectedRecord);
    return Boolean(canonicalFingerprint && canonicalFingerprint === expectedFingerprint);
}

function finalizeManualCanonicalState(filePath, options) {
    const date = options?.date;
    const expectedIds = [...new Set((options?.expectedIds || []).map(normalizedId).filter(Boolean))];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || expectedIds.length === 0) {
        throw new Error('finalizeManualCanonicalState 需要合法 date 与非空 expectedIds');
    }
    return updateJsonFileLocked(filePath, current => {
        const currentObject = current && !Array.isArray(current) ? current : {};
        const papers = Array.isArray(current) ? current : (currentObject.papers || []);
        const byId = new Map(papers.map(paper => [normalizedId(paper), paper]));
        const expectedRecords = expectedIds.map(id => byId.get(id) || null);
        const failedIds = expectedIds.filter((id, index) => !isSuccessfulAnalysisRecord(expectedRecords[index]));
        const success = expectedIds.length - failedIds.length;
        const status = failedIds.length === 0 ? 'complete' : 'partial_failed';
        const now = getBeijingISOString();
        const payload = {
            ...currentObject,
            timestamp: now,
            batchDate: date,
            status,
            papers,
            stats: {
                ...(currentObject.stats || {}),
                ...(options.stats || {}),
                analysisStatus: status,
                pipelineStatus: status === 'complete' ? 'analysis_complete' : 'analysis_partial_failed',
                total: expectedIds.length,
                success,
                failed: failedIds.length,
                failedIds,
                manualComplete: expectedRecords.filter(record => (
                    isSuccessfulAnalysisRecord(record)
                    && record.analysisManifest?.manualTakeover?.mode === MANUAL_COMPLETE_STATUS
                )).length,
                failedCheckpoints: expectedRecords.filter(record => (
                    !isSuccessfulAnalysisRecord(record) && Boolean(record?.manualIngestionCheckpoint)
                )).length
            }
        };
        if (status === 'complete') payload.deepAnalysisCompletedAt = now;
        else delete payload.deepAnalysisCompletedAt;
        return payload;
    }, { allowMissing: false });
}

function buildStageEvidence(
    spec,
    sourceSha256,
    analysisSha256,
    auditSha256,
    promptBindings,
    stageContextSha256 = {}
) {
    const byStage = spec.reviewedClaimsByStage;
    if (!byStage || typeof byStage !== 'object') throw new Error('manualAudit.reviewedClaimsByStage 缺失');
    const result = {};
    for (const stage of REQUIRED_RECOVERY_STAGES) {
        const claims = byStage[stage];
        if (!Array.isArray(claims) || claims.length === 0
            || claims.some(claim => typeof claim !== 'string' || claim.trim().length < 12)) {
            throw new Error(`manualAudit.reviewedClaimsByStage.${stage} 必须包含具体审查声明`);
        }
        // A manual run has no remote model response to fingerprint.  Bind
        // each offline stage to its own reviewed claim bundle instead of
        // pretending every stage consumed the same generic analysis input.
        // The final output may legitimately have one SHA (the offline editor
        // writes once), but the stage input/audit hashes must remain distinct.
        const binding = promptBindings[stage];
        const attempts = spec.stageReviewAttemptsByStage?.[stage]
            ?? spec.manualAudit?.passes?.length;
        if (!Number.isInteger(attempts) || attempts < 2) {
            throw new Error(`manualAudit.stageReviewAttemptsByStage.${stage} 必须记录至少两次实际审查`);
        }
        const stageInputSha256 = manualSha256({
            stage,
            executionKind: MANUAL_STAGE_EXECUTION_KIND,
            sourceSha256,
            analysisSha256,
            claims,
            stagePromptSha256: binding.sha256,
            stageContextSha256: stageContextSha256[stage] || null
        });
        const stageAuditSha256 = manualSha256({ stage, claims, auditSha256, stageInputSha256 });
        result[stage] = {
            status: MANUAL_COMPLETE_STATUS,
            executionKind: MANUAL_STAGE_EXECUTION_KIND,
            protocol: 'manual-offline-review-v1',
            inputSha256: stageInputSha256,
            outputSha256: analysisSha256,
            auditSha256: stageAuditSha256,
            attempts,
            promptSource: binding.source,
            promptSha256: binding.sha256,
            ...(stageContextSha256[stage]
                ? { contextSha256: stageContextSha256[stage] }
                : {}),
            reviewedClaims: claims
        };
    }
    return result;
}

function manualImageSection(caption) {
    const text = String(caption || '').toLowerCase();
    if (/(?:result|comparison|ablation|accuracy|performance|metric|curve|plot|visualization|case study|confusion|similarity|correlation|heatmap|cka|wer|cer|mos|error rate)/.test(text)) {
        return '实验结果';
    }
    if (/(?:architecture|framework|pipeline|overview|workflow|system|network|module|algorithm|signal flow)/.test(text)) {
        return '方法概述和架构';
    }
    return '细节详述';
}

function conciseManualImageCaption(value, maxChars = 240) {
    const text = String(value || '')
        .replace(/^(?:fig(?:ure)?\.?\s*)\d+[a-z]?(?:\s*[:.\-–—]\s*|\s+)/i, '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/([A-Za-z]{1,12}\s*[=<>]\s*-?\d+(?:\.\d+)?%?)\s*\1/gi, '$1')
        .trim();
    if (!text) return '论文图示';
    // Blog alt text must remain a complete semantic unit.  A previous hard
    // character slice produced captions ending at half a clause (or even half
    // a word), which looked materially worse than the API-authored pages and
    // could hide the condition attached to a result.  Prefer a complete first
    // sentence when a genuinely multi-sentence caption is long; otherwise keep
    // the source caption intact.  Semicolons are deliberately not terminators.
    if (text.length <= maxChars) return text;
    const firstSentence = text.match(/^.{20,}?[.!?。！？](?=\s|$)/)?.[0];
    if (firstSentence && firstSentence.length <= maxChars) return firstSentence;
    // arXiv HTML occasionally exposes an already-truncated caption that is
    // shorter than our own limit.  A long clause without terminal punctuation
    // is not safe to publish verbatim; replace it with a complete semantic alt.
    const section = manualImageSection(text);
    if (section === '方法概述和架构') return '论文方法与系统结构总览图';
    if (section === '实验结果') return '论文关键实验比较图';
    if (/(?:setting|scenario|dataset|sample|example|condition|setup)/i.test(text)) {
        return '论文实验设置与数据关系示意图';
    }
    return '论文实现细节示意图';
}

function buildAutomaticManualImagePlan(analysis, imageInfos, maxInsertions = 3) {
    const anchors = buildImageAnchorCatalog(analysis);
    const usedCaptions = new Set();
    const usedAnchorIds = new Set();
    const plans = [];
    for (const [index, info] of imageInfos.entries()) {
        if (plans.length >= maxInsertions) break;
        const caption = String(info?.caption || '').replace(/\s+/g, ' ').trim();
        if (caption.length < 20) continue;
        const normalizedCaption = caption.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
        if (usedCaptions.has(normalizedCaption)) continue;
        const section = manualImageSection(caption);
        const anchor = anchors.find(item => item.section === section && !usedAnchorIds.has(item.id))
            || anchors.find(item => item.section === '方法概述和架构' && !usedAnchorIds.has(item.id))
            || anchors[0];
        if (!anchor) continue;
        usedCaptions.add(normalizedCaption);
        usedAnchorIds.add(anchor.id);
        const isResult = section === '实验结果';
        const captionPreview = conciseManualImageCaption(caption);
        const chineseCaption = /[\u4e00-\u9fff]/.test(captionPreview) ? `“${captionPreview}”` : null;
        plans.push({
            imageNumber: index + 1,
            section: anchor.section,
            paragraphId: anchor.id,
            lead: isResult
                ? `下图展示${chineseCaption || '论文的关键实验比较'}；读图时需同时保留正文列出的数据集、指标方向和实验条件。`
                : (section === '方法概述和架构'
                    ? `下图概括${chineseCaption || '论文的系统结构或处理流程'}，可与上文的组件职责和数据流逐项对照。`
                    : `下图补充${chineseCaption || '论文的实现细节或数据示例'}，用于核对实现条件与适用边界。`),
            explanation: isResult
                ? '这项视觉证据只支持图注与正文对应设置下的比较，不能外推为未测试条件中的统一结论。'
                : (section === '方法概述和架构'
                    ? '图中的箭头和分支用于说明已披露的组件关系，不代表正文未声明的额外训练阶段。'
                    : '图示用于补足实现语境，不替代论文未报告的配置、消融或部署测量。')
        });
    }
    return plans;
}

function buildManualRecord(paper, spec, date, promptInput, options = {}) {
    const promptBindings = typeof promptInput === 'string'
        ? Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage, {
            source: stage === 'primaryAnalysis' ? 'prompts/deep-analysis.md' : `manual-stage-contract:${stage}:legacy-test`,
            sha256: stage === 'primaryAnalysis' ? promptInput : manualSha256({ stage, promptInput })
        }]))
        : promptInput;
    const promptSha256 = promptBindings.primaryAnalysis.sha256;
    if (!spec || typeof spec !== 'object') throw new Error(`${normalizedId(paper)} 缺少规格对象`);
    if (typeof spec.analysis !== 'string' || !spec.analysis.trim()) throw new Error(`${normalizedId(paper)} 缺少 analysis`);
    const sourcePath = path.resolve(PROJECT_ROOT, String(spec.fullTextPath || ''));
    const tempRoot = fs.realpathSync(os.tmpdir());
    const resolvedSourcePath = fs.existsSync(sourcePath) ? fs.realpathSync(sourcePath) : sourcePath;
    if (!resolvedSourcePath.startsWith(`${PROJECT_ROOT}${path.sep}`)
        && !resolvedSourcePath.startsWith(`${tempRoot}${path.sep}`)
        && !resolvedSourcePath.startsWith('/private/tmp/')) {
        throw new Error(`${normalizedId(paper)} fullTextPath 不在项目或受控临时目录内`);
    }
    if (!fs.existsSync(sourcePath)) throw new Error(`${normalizedId(paper)} fullTextPath 不存在: ${sourcePath}`);
    const sourceBuffer = fs.readFileSync(sourcePath);
    const sourceText = sourceBuffer.toString('utf8');
    if (sourceText.length < 1000) throw new Error(`${normalizedId(paper)} 全文过短，拒绝降级为 manual full_text`);
    const sourceSha256 = sha256Buffer(sourceBuffer);
    if (spec.sourceSha256 && spec.sourceSha256 !== sourceSha256) {
        throw new Error(`${normalizedId(paper)} sourceSha256 与 fullTextPath 不一致`);
    }
    const parsed = parseAnalysis(spec.analysis);
    const invalidReason = getInvalidAnalysisReason(spec.analysis, parsed, {
        enforceExperimentTableContract: true,
        enforceMethodDetailContract: true,
        enforceManualDepthContract: true,
        manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3,
        sourceText
    });
    if (invalidReason) throw new Error(`${normalizedId(paper)} 分析契约失败: ${invalidReason}`);
    const preparedImages = Array.isArray(options.preparedImages) ? options.preparedImages : [];
    const hasConfiguredImageSelection = Array.isArray(spec.selectedImageUrls);
    const configuredImageUrls = new Set(hasConfiguredImageSelection ? spec.selectedImageUrls : []);
    const selectedPreparedImages = (hasConfiguredImageSelection
        ? preparedImages.filter(info => configuredImageUrls.has(info.url))
        : preparedImages).map(info => ({
        ...info,
        displayCaption: conciseManualImageCaption(info.caption || info.alt || '')
    }));
    const automaticImagePlan = buildAutomaticManualImagePlan(
        spec.analysis,
        selectedPreparedImages,
        Math.min(3, Config.ANALYSIS_CONFIG.imageInsertionMax || 3)
    );
    const imageInsertion = applyImageInsertionPlan(
        spec.analysis,
        automaticImagePlan,
        selectedPreparedImages,
        Config.ANALYSIS_CONFIG.imageInsertionMax
    );
    const finalAnalysis = imageInsertion.analysis;
    const finalParsed = parseAnalysis(finalAnalysis);
    const finalInvalidReason = getInvalidAnalysisReason(finalAnalysis, finalParsed, {
        enforceExperimentTableContract: true,
        enforceMethodDetailContract: true,
        enforceManualDepthContract: true,
        manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3,
        sourceText
    });
    if (finalInvalidReason) throw new Error(`${normalizedId(paper)} 插图后分析契约失败: ${finalInvalidReason}`);
    const manualDepthIssue = validateManualDepthContract(finalAnalysis, {
        sourceText,
        manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3
    });
    if (manualDepthIssue) throw new Error(`${normalizedId(paper)} manual 深度契约失败: ${manualDepthIssue}`);
    const analysisSha256 = manualTextSha256(finalAnalysis);
    const audit = spec.manualAudit;
    if (!audit || typeof audit !== 'object' || audit.version !== 1) {
        throw new Error(`${normalizedId(paper)} 缺少 manualAudit v1`);
    }
    if (!Array.isArray(audit.passes) || audit.attempts !== audit.passes.length) {
        throw new Error(`${normalizedId(paper)} manualAudit.attempts 必须等于实际 passes 数量`);
    }
    const auditSha256 = manualSha256(audit);
    const evidenceLedger = spec.evidenceLedger;
    const imageInfos = Array.isArray(spec.imageInfos) ? spec.imageInfos : [];
    const imageUrls = preparedImages.map(info => info.url);
    const selectedRequested = configuredImageUrls;
    const unavailableRequested = [...selectedRequested].filter(url => !preparedImages.some(info => info.url === url));
    if (unavailableRequested.length > 0 && spec.imageSelectionMode === 'manual_explicit') {
        throw new Error(`${normalizedId(paper)} selectedImageUrls 含未通过安全下载校验的图片: ${unavailableRequested.join(', ')}`);
    }
    const insertedUrlSet = new Set(imageInsertion.selectedImageUrls);
    const selectedImages = preparedImages.filter(info => insertedUrlSet.has(info.url));
    const imageDownloadEvidenceSha256 = manualSha256({
        candidates: preparedImages.map(info => ({
            url: info.url,
            caption: info.caption || '',
            source: info.source || null,
            sourceOrder: info.sourceOrder ?? null,
            candidateScore: info.candidateScore ?? null,
            mime: info.mime,
            sha256: info.sha256,
            bytes: info.bytes
        })),
        outcomes: Array.isArray(options.imageDownloadOutcomes) ? options.imageDownloadOutcomes : []
    });
    const normalizedSelectedEvidence = selectedImages.map(info => ({
        url: info.url, caption: info.caption || '', source: info.source || null,
        sourceOrder: info.sourceOrder ?? null, candidateScore: info.candidateScore ?? null,
        mime: info.mime, sha256: info.sha256, bytes: info.bytes
    }));
    const imageSelectionEvidenceSha256 = manualSha256({
        selected: normalizedSelectedEvidence,
        insertionPlan: automaticImagePlan,
        insertionDiagnostics: imageInsertion.insertionDiagnostics
    });
    const stageContextSha256 = {
        imageDownload: imageDownloadEvidenceSha256,
        imageSupplement: imageSelectionEvidenceSha256
    };
    const takeover = {
        version: 2,
        mode: MANUAL_COMPLETE_STATUS,
        agent: spec.agent || 'Codex',
        basis: 'full_text',
        sourceSha256,
        promptSha256,
        manualAuthoringPromptSha256: spec.manualAuthoringPromptSha256,
        analysisSha256,
        completedAt: getBeijingISOString().replace(/\.(\d{3})\d+/, '.$1'),
        reason: spec.reason || '无 API 离线人工分析；基于完整全文逐篇复核并完成二次审计。',
        review: {
            sourceVerified: true,
            analysisContractVerified: true,
            scoringVerified: true,
            stageEvidenceVerified: true
        },
        evidenceLedger,
        evidenceLedgerSha256: manualSha256(evidenceLedger),
        audit,
        stageEvidence: buildStageEvidence(
            spec,
            sourceSha256,
            analysisSha256,
            auditSha256,
            promptBindings,
            stageContextSha256
        )
    };
    const stages = Object.fromEntries(Object.entries(stageStatusMap()).map(([stage, status]) => [stage, {
        status,
        executionKind: MANUAL_STAGE_EXECUTION_KIND,
        protocol: 'manual-offline-review-v1',
        updatedAt: takeover.completedAt,
        promptSource: promptBindings[stage].source,
        promptSha256: promptBindings[stage].sha256,
        fingerprint: manualSha256({
            date,
            id: normalizedId(paper),
            stage,
            executionKind: MANUAL_STAGE_EXECUTION_KIND,
            stagePromptSha256: promptBindings[stage].sha256,
            stageContextSha256: stageContextSha256[stage] || null,
            sourceSha256,
            analysisSha256
        })
    }]));
    const analysisManifest = {
        version: 1,
        contracts: {
            experimentTables: 'bounded-v1',
            methodDetail: 'detailed-v1',
            manualDepth: MANUAL_DEPTH_CONTRACT_VERSION_V3
        },
        sourceAcquisition: {
            analysisSource: 'provided_full_text',
            sourceId: normalizedId(paper),
            sourceTextChars: sourceText.length,
            usedTextChars: sourceText.length,
            fullTextChars: sourceText.length,
            fullTextAvailable: true,
            truncated: false,
            sourceSha256,
            warnings: ['manual_offline_no_llm_api']
        },
        stages,
        manualTakeover: takeover
    };
    const imageManifest = {
        version: 2,
        source: imageInfos.length > 0 ? 'manual_full_text_html' : 'manual_no_image_metadata',
        totalFound: imageInfos.length,
        candidates: preparedImages.map((info, index) => ({
            index: index + 1,
            ...info
        })),
        downloaded: preparedImages.map(info => ({ ...info })),
        downloadOutcomes: Array.isArray(options.imageDownloadOutcomes) ? options.imageDownloadOutcomes : [],
        downloadEvidenceSha256: imageDownloadEvidenceSha256,
        selectionEvidenceSha256: imageSelectionEvidenceSha256,
        insertionPlan: automaticImagePlan,
        insertionDiagnostics: imageInsertion.insertionDiagnostics,
        selected: selectedImages.map((info, index) => ({
            index: index + 1,
            ...info,
            selectionReason: selectedRequested.size > 0
                ? 'manual_explicit_secure_figure_review_and_caption_plan'
                : 'manual_secure_candidate_ranking_and_caption_plan'
        }))
    };
    const manifestIssue = validateManualTakeoverManifest(analysisManifest, sourceSha256, {
        analysis: finalAnalysis,
        sourceText,
        imageManifest
    });
    if (manifestIssue) throw new Error(`${normalizedId(paper)} manual provenance 失败: ${manifestIssue}`);
    return {
        ...paper,
        analysis: finalAnalysis,
        parsed: finalParsed,
        scoringRubricVersion: finalParsed.scoringRubricVersion,
        analysisSource: 'provided_full_text',
        sourceId: normalizedId(paper),
        sourceTextChars: sourceText.length,
        usedTextChars: sourceText.length,
        fullTextChars: sourceText.length,
        fullTextAvailable: true,
        truncated: false,
        sourceSha256,
        usedTextSha256: sourceSha256,
        analysisConfidence: 'manual_full_text',
        sourceWarnings: ['manual_offline_no_llm_api'],
        imageManifest,
        imageUrls,
        allImageUrls: imageUrls,
        selectedImageUrls: imageManifest.selected.map(item => item.url),
        analysisManifest,
        manualIngestionCheckpoint: undefined,
        latestAnalysisAttemptError: undefined,
        latestAnalysisAttemptAt: undefined,
        digestStatus: {
            ...(paper.digestStatus || {}),
            status: 'analyzed',
            latestAttemptStatus: 'analyzed',
            batchDate: date,
            error: null,
            updatedAt: takeover.completedAt
        }
    };
}

function buildManualFailureRecord(paper, paperSpec, date, error, promptBindings, options = {}) {
    const now = getBeijingISOString();
    const sourcePath = path.resolve(PROJECT_ROOT, String(paperSpec?.fullTextPath || ''));
    let sourceSha256 = null;
    try {
        if (fs.existsSync(sourcePath)) sourceSha256 = sha256File(sourcePath);
    } catch (_error) {
        sourceSha256 = null;
    }
    return {
        ...paper,
        analysis: null,
        parsed: null,
        error: `manual_complete ingestion failed: ${error.message}`,
        manualIngestionCheckpoint: {
            version: 1,
            mode: MANUAL_COMPLETE_STATUS,
            failedAt: now,
            sourceSha256,
            analysisSha256: typeof paperSpec?.analysis === 'string' ? manualTextSha256(paperSpec.analysis) : null,
            protocol: 'manual-offline-review-v1',
            stagePromptSha256: Object.fromEntries(
                Object.entries(promptBindings).map(([stage, binding]) => [stage, binding.sha256])
            ),
            stages: Object.fromEntries(Object.entries(promptBindings).map(([stage, binding]) => [stage, {
                protocol: 'manual-offline-review-v1',
                promptSource: binding.source,
                promptSha256: binding.sha256,
                attempts: Number.isInteger(paperSpec?.stageReviewAttemptsByStage?.[stage])
                    ? paperSpec.stageReviewAttemptsByStage[stage]
                    : (Array.isArray(paperSpec?.manualAudit?.passes)
                        ? paperSpec.manualAudit.passes.length
                        : null)
            }])),
            imageDownloadOutcomes: Array.isArray(options.imageDownloadOutcomes)
                ? options.imageDownloadOutcomes
                : [],
            preparedImages: Array.isArray(options.preparedImages)
                ? options.preparedImages.map(info => ({
                    url: info.url,
                    cachePath: info.cachePath,
                    mime: info.mime,
                    sha256: info.sha256,
                    bytes: info.bytes
                }))
                : []
        },
        digestStatus: {
            ...(paper.digestStatus || {}),
            status: 'analysis_failed',
            latestAttemptStatus: 'analysis_failed',
            batchDate: date,
            error: error.message,
            updatedAt: now
        }
    };
}

async function prepareManualImages(spec) {
    const imageInfos = normalizeImageInfos(spec.imageInfos);
    const requestedUrls = Array.isArray(spec.selectedImageUrls)
        ? new Set(spec.selectedImageUrls)
        : null;
    const candidatePool = requestedUrls
        ? imageInfos.filter(candidate => requestedUrls.has(candidate.url))
        : imageInfos;
    const candidates = selectImageCandidates(
        candidatePool,
        requestedUrls ? Math.min(4, requestedUrls.size) : Config.ANALYSIS_CONFIG.imageCandidateMax
    );
    const preparedImages = [];
    const imageDownloadOutcomes = [];
    for (const candidate of candidates) {
        try {
            const cached = await cachePublicImageDetailed(candidate.url);
            if (cached?.cachePath && cached?.mime && cached?.sha256) {
                preparedImages.push({
                    url: candidate.url,
                    caption: candidate.caption || '',
                    source: candidate.source || 'arxiv_html',
                    sourceOrder: candidate.sourceOrder,
                    candidateScore: candidate.candidateScore,
                    cachePath: cached.cachePath,
                    mime: cached.mime,
                    sha256: cached.sha256,
                    bytes: cached.bytes,
                    cacheHit: cached.cacheHit
                });
                imageDownloadOutcomes.push({ url: candidate.url, status: 'complete' });
            } else {
                imageDownloadOutcomes.push({
                    url: candidate.url,
                    status: cached?.failureType || 'transient_failure',
                    reason: cached?.reason || 'download_failed'
                });
            }
        } catch (error) {
            if (error.code === 'PROXY_CONFIG_ERROR') throw error;
            imageDownloadOutcomes.push({ url: candidate.url, status: 'transient_failure', reason: error.message });
        }
    }
    return { preparedImages, imageDownloadOutcomes };
}

async function run() {
    const { date, spec: specPathArg, force } = parseArgs(process.argv.slice(2));
    const specPath = path.resolve(PROJECT_ROOT, specPathArg);
    const spec = readJson(specPath, 'manual spec');
    if (spec.version !== 3 || spec.mode !== MANUAL_COMPLETE_STATUS) {
        throw new Error('manual spec 必须是 version=3、mode=manual_complete');
    }
    if (spec.date !== date) throw new Error('manual spec.date 与 --date 不一致');
    const promptBindings = buildStagePromptBindings();
    const promptSha256 = promptBindings.primaryAnalysis.sha256;
    if (spec.promptSha256 && spec.promptSha256 !== promptSha256) {
        throw new Error('manual spec.promptSha256 与当前 deep-analysis prompt 不一致');
    }
    if (spec.manualAuthoringPromptPath !== 'prompts/manual-analysis-record.md'
        || spec.manualAuthoringPromptSha256 !== sha256File(MANUAL_AUTHORING_PROMPT_PATH)) {
        throw new Error('manual spec 的 Manual 成稿规范路径或 SHA 与当前 prompts/manual-analysis-record.md 不一致');
    }
    if (spec.stagePromptSha256 !== undefined) {
        if (!spec.stagePromptSha256 || typeof spec.stagePromptSha256 !== 'object' || Array.isArray(spec.stagePromptSha256)) {
            throw new Error('manual spec.stagePromptSha256 必须是逐阶段对象');
        }
        for (const stage of REQUIRED_RECOVERY_STAGES) {
            if (spec.stagePromptSha256[stage] !== promptBindings[stage].sha256) {
                throw new Error(`manual spec.stagePromptSha256.${stage} 与当前阶段模板/契约不一致`);
            }
        }
    }
    const papers = filteredPapersForDate(date);
    const specPapers = spec.papers;
    if (!specPapers || typeof specPapers !== 'object' || Array.isArray(specPapers)) {
        throw new Error('manual spec.papers 必须是对象');
    }
    const expectedIds = new Set(papers.map(normalizedId));
    const suppliedIds = new Set(Object.keys(specPapers).map(normalizedId));
    const missing = [...expectedIds].filter(id => !suppliedIds.has(id));
    const extra = [...suppliedIds].filter(id => !expectedIds.has(id));
    if (missing.length || extra.length) {
        throw new Error(`manual spec 论文集合不一致: missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
    }
    const failures = new Map();
    let persisted = 0;
    let failedPersisted = 0;
    let skipped = 0;
    let successfulAttempts = 0;
    for (const paper of papers) {
        const id = normalizedId(paper);
        const paperSpec = specPapers[id] || specPapers[paper.arxivId];
        try {
            await withPaperAnalysisLock(paper, async () => {
                const canonical = loadCanonicalAnalysisRecord(Config.FILES.deepAnalysisResult, paper);
                const effectivePaper = {
                    ...paper,
                    ...(canonical || {}),
                    ...(paperSpec.titleOverride ? { title: paperSpec.titleOverride } : {})
                };
                let record;
                let success = false;
                let imagePreparation = {};
                try {
                    imagePreparation = await prepareManualImages(paperSpec);
                    const expectedRecord = buildManualRecord(
                        effectivePaper,
                        paperSpec,
                        date,
                        promptBindings,
                        imagePreparation
                    );
                    if (shouldReuseCanonical(canonical, expectedRecord, force)) {
                        skipped++;
                        successfulAttempts++;
                        return;
                    }
                    record = expectedRecord;
                    success = true;
                } catch (error) {
                    record = buildManualFailureRecord(
                        effectivePaper,
                        paperSpec,
                        date,
                        error,
                        promptBindings,
                        imagePreparation
                    );
                    failures.set(id, error.message);
                }

                await mergeAndSaveResults([record], Config.FILES.deepAnalysisResult, {
                    batchDate: date,
                    status: 'running',
                    stats: { analysisStatus: 'running', pipelineStatus: 'analysis_running' }
                });
                updateAnalysisDigestStatuses([record], { batchDate: date });
                if (success) {
                    persisted++;
                    successfulAttempts++;
                } else {
                    failedPersisted++;
                }
            });
        } catch (error) {
            failures.set(id, `锁内保存失败: ${error.message}`);
        }
    }
    const saved = finalizeManualCanonicalState(Config.FILES.deepAnalysisResult, {
        date,
        expectedIds: papers.map(normalizedId),
        stats: {
            skippedCanonical: skipped,
            persistedThisRun: persisted,
            failedCheckpointsThisRun: failedPersisted,
            forced: force,
            apiCalls: 0,
            promptSha256,
            stagePromptSha256: Object.fromEntries(Object.entries(promptBindings).map(([stage, binding]) => [stage, binding.sha256]))
        }
    });
    console.log(`manual_complete 离线分析 canonical 共 ${saved.papers.length} 篇，本轮成功写入 ${persisted} 篇、失败 checkpoint ${failedPersisted} 篇、复用 ${skipped} 篇；当前批次成功 ${saved.stats.success} 篇、失败 ${saved.stats.failed} 篇，API 调用 0 次`);
    if (saved.stats.failed > 0) {
        console.error(`manual_complete 当前 canonical 仍有 ${saved.stats.failed} 篇失败:`);
        for (const id of saved.stats.failedIds) {
            console.error(`  - ${id}: ${failures.get(id) || '当前 canonical 未达到成功契约'}`);
        }
        process.exitCode = 2;
    }
    console.log(`全文/Prompt provenance 已写入: ${Config.FILES.deepAnalysisResult}`);
}

if (require.main === module) {
    run().catch(error => {
        console.error(`manual_complete 失败: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    buildManualRecord,
    buildManualFailureRecord,
    buildStageEvidence,
    buildStagePromptBindings,
    conciseManualImageCaption,
    manualCanonicalReuseFingerprint,
    finalizeManualCanonicalState,
    prepareManualImages,
    filteredPapersForDate,
    parseArgs,
    shouldReuseCanonical,
    run
};

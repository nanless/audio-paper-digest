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
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    EDITORIAL_QUALITY_CONTRACT_VERSION,
    EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
    MANUAL_COMPLETE_STATUS,
    MANUAL_STAGE_EXECUTION_KIND,
    manualSha256,
    manualTextSha256,
    validateManualTakeoverManifest,
    validateManualDepthContract,
    normalizeExperimentTableNumericFormatting,
    MANUAL_DEPTH_CONTRACT_VERSION_V3,
    MANUAL_DEPTH_CONTRACT_VERSION_V4,
    getInvalidAnalysisReason
} = require('./analysis-contract.js');
const {
    validateEditorialQuality,
    validateResultClaims,
    validateReadabilityRubric
} = require('./editorial-quality.js');
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
    IMAGE_NARRATIVE_CONTRACT_VERSION
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

function resolveManualSpecPromptBindings(spec, currentBindings = buildStagePromptBindings()) {
    if (!spec || ![3, 4].includes(spec.version)) {
        throw new Error('manual spec prompt 绑定只支持 version=3/4');
    }
    if (spec.manualAuthoringPromptPath !== 'prompts/manual-analysis-record.md') {
        throw new Error('manual spec 的 Manual 成稿规范路径非法');
    }
    const currentAuthoringSha256 = sha256File(MANUAL_AUTHORING_PROMPT_PATH);
    if (spec.version === 4) {
        if (spec.promptSha256 && spec.promptSha256 !== currentBindings.primaryAnalysis.sha256) {
            throw new Error('manual spec.promptSha256 与当前 deep-analysis prompt 不一致');
        }
        if (spec.manualAuthoringPromptSha256 !== currentAuthoringSha256) {
            throw new Error('manual spec 的 Manual 成稿规范 SHA 与当前 prompts/manual-analysis-record.md 不一致');
        }
        if (spec.stagePromptSha256 !== undefined) {
            if (!spec.stagePromptSha256 || typeof spec.stagePromptSha256 !== 'object'
                || Array.isArray(spec.stagePromptSha256)) {
                throw new Error('manual spec.stagePromptSha256 必须是逐阶段对象');
            }
            for (const stage of REQUIRED_RECOVERY_STAGES) {
                if (spec.stagePromptSha256[stage] !== currentBindings[stage].sha256) {
                    throw new Error(`manual spec.stagePromptSha256.${stage} 与当前阶段模板/契约不一致`);
                }
            }
        }
        return currentBindings;
    }

    // Historical v3 specs are immutable, already-materialized attestations.
    // Requiring their hashes to equal today's edited prompts would make the
    // documented v3 replay path impossible.  Preserve the hashes declared by
    // that spec, while still requiring a complete, internally consistent set
    // of known stage bindings.  Current v4 never enters this branch.
    if (!/^[a-f0-9]{64}$/.test(String(spec.promptSha256 || ''))
        || !/^[a-f0-9]{64}$/.test(String(spec.manualAuthoringPromptSha256 || ''))) {
        throw new Error('历史 manual v3 spec 缺少合法 prompt SHA-256');
    }
    if (!spec.stagePromptSha256 || typeof spec.stagePromptSha256 !== 'object'
        || Array.isArray(spec.stagePromptSha256)
        || Object.keys(spec.stagePromptSha256).length !== REQUIRED_RECOVERY_STAGES.length) {
        throw new Error('历史 manual v3 spec.stagePromptSha256 必须精确覆盖全部阶段');
    }
    const historicalBindings = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => {
        const sha256 = spec.stagePromptSha256[stage];
        if (!/^[a-f0-9]{64}$/.test(String(sha256 || ''))) {
            throw new Error(`历史 manual v3 spec.stagePromptSha256.${stage} 不是合法 SHA-256`);
        }
        return [stage, { source: currentBindings[stage].source, sha256 }];
    }));
    if (historicalBindings.primaryAnalysis.sha256 !== spec.promptSha256) {
        throw new Error('历史 manual v3 spec.promptSha256 与 primaryAnalysis 阶段不一致');
    }
    return historicalBindings;
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
        contract: 'manual-canonical-reuse-v2',
        id: normalizedId(record),
        manifestVersion: manifest.version ?? null,
        manifestContracts: manifest.contracts || null,
        takeoverVersion: takeover.version ?? null,
        analysisSha256: manualTextSha256(record.analysis || ''),
        declaredAnalysisSha256: takeover.analysisSha256 || null,
        manualAuthoringPromptSha256: takeover.manualAuthoringPromptSha256 || null,
        sourceSha256: record.sourceSha256 || null,
        manifestSourceSha256: manifest.sourceAcquisition?.sourceSha256 || null,
        takeoverSourceSha256: takeover.sourceSha256 || null,
        evidenceLedgerSha256: takeover.evidenceLedgerSha256 || null,
        computedEvidenceLedgerSha256: manualSha256(takeover.evidenceLedger || null),
        resultClaimsSha256: takeover.resultClaimsSha256 || null,
        computedResultClaimsSha256: manualSha256({
            claims: takeover.resultClaims || null,
            exception: takeover.resultClaimsException || null
        }),
        readabilityRubricSha256: takeover.readabilityRubricSha256 || null,
        computedReadabilityRubricSha256: manualSha256(takeover.readabilityRubric || null),
        editorialQualityMetricsSha256: manualSha256(takeover.editorialQualityMetrics || null),
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

function manualCanonicalWriteDecision(canonical, expectedRecord, force = false) {
    if (!isSuccessfulAnalysisRecord(canonical)) return 'write';
    if (force) return 'write';
    if (shouldReuseCanonical(canonical, expectedRecord, false)) return 'reuse';
    throw new Error(
        `${normalizedId(expectedRecord) || '当前论文'} 已有成功 canonical，`
        + '但本次 spec/prompt/全文/图片或审计指纹不同；拒绝无 --force 覆盖'
    );
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

// Kept only so an already-materialized v3 spec can still be replayed. New v4
// specs must carry explicit, context-bound imageInsertions and never enter this
// branch.
function buildLegacyV3ManualImagePlan(analysis, imageInfos, maxInsertions = 3) {
    const anchors = require('./deep-analyzer.js').buildImageAnchorCatalog(analysis);
    const plans = [];
    const usedAnchorIds = new Set();
    for (const [index, info] of imageInfos.entries()) {
        if (plans.length >= maxInsertions) break;
        const caption = String(info?.caption || '').replace(/\s+/g, ' ').trim();
        if (caption.length < 20) continue;
        const section = manualImageSection(caption);
        const anchor = anchors.find(item => item.section === section && !usedAnchorIds.has(item.id))
            || anchors.find(item => item.section === '方法概述和架构' && !usedAnchorIds.has(item.id))
            || anchors[0];
        if (!anchor) continue;
        usedAnchorIds.add(anchor.id);
        plans.push({
            imageNumber: index + 1,
            section: anchor.section,
            paragraphId: anchor.id,
            legacyNarrative: true,
            lead: section === '实验结果'
                ? '下图展示论文的关键实验比较；读图时需同时保留正文列出的数据集、指标方向和实验条件。'
                : '下图概括论文的系统结构或处理流程，可与上文的组件职责和数据流逐项对照。',
            explanation: section === '实验结果'
                ? '这项视觉证据只支持图注与正文对应设置下的比较，不能外推为未测试条件中的统一结论。'
                : '图中的箭头和分支用于说明已披露的组件关系，不代表正文未声明的额外训练阶段。'
        });
    }
    return plans;
}

function normalizeManualV4ImageArtifacts({
    configuredImageUrls,
    preparedImages,
    insertionPlan,
    insertionDiagnostics,
    orderedSelectedImageUrls
}) {
    const expectedCount = configuredImageUrls.length;
    if (preparedImages.length !== expectedCount
        || insertionPlan.length !== expectedCount
        || insertionDiagnostics.length !== expectedCount
        || orderedSelectedImageUrls.length !== expectedCount) {
        throw new Error('Manual v4 图片、插图计划、诊断与最终正文出现次数不一致');
    }

    const preparedByUrl = new Map(preparedImages.map(info => [info.url, info]));
    const planByUrl = new Map(configuredImageUrls.map((url, index) => [url, insertionPlan[index]]));
    const diagnosticByImageNumber = new Map(
        insertionDiagnostics.map(item => [item.imageNumber, item])
    );
    if (preparedByUrl.size !== expectedCount || planByUrl.size !== expectedCount
        || diagnosticByImageNumber.size !== expectedCount
        || new Set(orderedSelectedImageUrls).size !== expectedCount) {
        throw new Error('Manual v4 图片 URL 或插图编号重复，无法保持逐图计划绑定');
    }

    const selectedImages = [];
    const orderedInsertionPlan = [];
    const orderedInsertionDiagnostics = [];
    for (const [index, url] of orderedSelectedImageUrls.entries()) {
        const prepared = preparedByUrl.get(url);
        const plan = planByUrl.get(url);
        const diagnostic = plan && diagnosticByImageNumber.get(plan.imageNumber);
        if (!prepared || !plan || !diagnostic || diagnostic.inserted !== true) {
            throw new Error(`Manual v4 最终正文图片未与已验证计划闭环: ${url}`);
        }
        const imageNumber = index + 1;
        selectedImages.push(prepared);
        orderedInsertionPlan.push({ ...plan, imageNumber });
        orderedInsertionDiagnostics.push({ ...diagnostic, imageNumber });
    }
    return {
        selectedImages,
        insertionPlan: orderedInsertionPlan,
        insertionDiagnostics: orderedInsertionDiagnostics
    };
}

function buildManualRecord(paper, spec, date, promptInput, options = {}) {
    const manualDepthContractVersion = options.manualDepthContractVersion
        || MANUAL_DEPTH_CONTRACT_VERSION_V4;
    const isManualV4 = manualDepthContractVersion === MANUAL_DEPTH_CONTRACT_VERSION_V4;
    const experimentTableContractVersion = manualDepthContractVersion === MANUAL_DEPTH_CONTRACT_VERSION_V4
        ? EXPERIMENT_TABLE_CONTRACT_VERSION
        : EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION;
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
        experimentTableContractVersion,
        enforceMethodDetailContract: true,
        enforceManualDepthContract: true,
        manualDepthContractVersion,
        sourceText
    });
    if (invalidReason) throw new Error(`${normalizedId(paper)} 分析契约失败: ${invalidReason}`);
    const preparedImages = Array.isArray(options.preparedImages) ? options.preparedImages : [];
    const hasConfiguredImageSelection = Array.isArray(spec.selectedImageUrls);
    const configuredImageUrls = hasConfiguredImageSelection ? spec.selectedImageUrls : [];
    const selectedPreparedImages = (hasConfiguredImageSelection
        ? configuredImageUrls.map(url => preparedImages.find(info => info.url === url)).filter(Boolean)
        : (isManualV4 ? [] : preparedImages)).map(info => ({
        ...info,
        displayCaption: conciseManualImageCaption(info.caption || info.alt || '')
    }));
    const unavailableRequested = configuredImageUrls.filter(
        url => !preparedImages.some(info => info.url === url)
    );
    if (unavailableRequested.length > 0 && spec.imageSelectionMode === 'manual_explicit') {
        throw new Error(`${normalizedId(paper)} selectedImageUrls 含未通过安全下载校验的图片: ${unavailableRequested.join(', ')}`);
    }
    const configuredImagePlan = Array.isArray(spec.imageInsertions) ? spec.imageInsertions : [];
    if (isManualV4 && configuredImagePlan.length !== configuredImageUrls.length) {
        throw new Error(`${normalizedId(paper)} 每个 selectedImageUrls 必须有一条人工 imageInsertions 叙事绑定`);
    }
    const manualImagePlan = isManualV4
        ? configuredImagePlan.map((item, index) => ({
            imageNumber: index + 1,
            section: item.section,
            paragraphId: item.paragraphId || item.paragraph_id,
            conclusionParagraphId: item.conclusionParagraphId || item.conclusion_paragraph_id,
            lead: item.lead,
            explanation: item.explanation
        }))
        : buildLegacyV3ManualImagePlan(
            spec.analysis,
            selectedPreparedImages,
            Math.min(3, Config.ANALYSIS_CONFIG.imageInsertionMax || 3)
        );
    const imageInsertion = applyImageInsertionPlan(
        spec.analysis,
        manualImagePlan,
        selectedPreparedImages,
        Config.ANALYSIS_CONFIG.imageInsertionMax
    );
    const rejectedImageInsertions = imageInsertion.insertionDiagnostics.filter(item => !item.inserted);
    if (isManualV4 && configuredImageUrls.length > 0
        && (imageInsertion.selectedImageUrls.length !== configuredImageUrls.length
            || rejectedImageInsertions.length > 0)) {
        const reasons = rejectedImageInsertions.map(item => item.rejectionReason || 'unknown').join(', ');
        throw new Error(`${normalizedId(paper)} 人工逐图叙事未完整插入: ${reasons || 'selected_count_mismatch'}`);
    }
    const finalAnalysis = normalizeExperimentTableNumericFormatting(imageInsertion.analysis);
    const finalParsed = parseAnalysis(finalAnalysis);
    const finalInvalidReason = getInvalidAnalysisReason(finalAnalysis, finalParsed, {
        enforceExperimentTableContract: true,
        experimentTableContractVersion,
        enforceMethodDetailContract: true,
        enforceManualDepthContract: true,
        manualDepthContractVersion,
        sourceText
    });
    if (finalInvalidReason) throw new Error(`${normalizedId(paper)} 插图后分析契约失败: ${finalInvalidReason}`);
    const manualDepthIssue = validateManualDepthContract(finalAnalysis, {
        sourceText,
        manualDepthContractVersion
    });
    if (manualDepthIssue) throw new Error(`${normalizedId(paper)} manual 深度契约失败: ${manualDepthIssue}`);
    const editorialQuality = validateEditorialQuality(finalAnalysis);
    if (isManualV4 && !editorialQuality.valid) {
        throw new Error(`${normalizedId(paper)} Manual v4 读者文本质量失败: ${editorialQuality.issues.slice(0, 8).map(item => item.code).join(', ')}`);
    }
    const resultClaims = Array.isArray(spec.resultClaims) ? spec.resultClaims : [];
    const resultClaimsValidation = validateResultClaims(resultClaims, sourceText, {
        documentType: finalParsed.documentType,
        exception: spec.resultClaimsException,
        readerResultsText: finalParsed.results || ''
    });
    if (isManualV4 && !resultClaimsValidation.valid) {
        throw new Error(`${normalizedId(paper)} Manual v4 resultClaims 失败: ${resultClaimsValidation.errors.join('；')}`);
    }
    const readability = validateReadabilityRubric(spec.readabilityRubric);
    if (isManualV4 && (!readability.valid || !readability.passing)) {
        throw new Error(`${normalizedId(paper)} Manual v4 readabilityRubric 失败: ${readability.errors.join('；') || `total=${readability.total}`}`);
    }
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
    const insertedUrlSet = new Set(imageInsertion.selectedImageUrls);
    const legacySelectedImages = preparedImages.filter(info => insertedUrlSet.has(info.url));
    const canonicalImageArtifacts = isManualV4
        ? normalizeManualV4ImageArtifacts({
            configuredImageUrls,
            preparedImages: configuredImageUrls.map(
                url => preparedImages.find(info => info.url === url)
            ).filter(Boolean),
            insertionPlan: manualImagePlan,
            insertionDiagnostics: imageInsertion.insertionDiagnostics,
            orderedSelectedImageUrls: imageInsertion.selectedImageUrls
        })
        : {
            selectedImages: legacySelectedImages,
            insertionPlan: manualImagePlan,
            insertionDiagnostics: imageInsertion.insertionDiagnostics
        };
    const selectedImages = canonicalImageArtifacts.selectedImages;
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
        insertionPlan: canonicalImageArtifacts.insertionPlan,
        insertionDiagnostics: canonicalImageArtifacts.insertionDiagnostics
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
            stageEvidenceVerified: true,
            ...(isManualV4 ? { readerQualityVerified: true } : {})
        },
        evidenceLedger,
        evidenceLedgerSha256: manualSha256(evidenceLedger),
        ...(isManualV4 ? {
            documentType: finalParsed.documentType,
            resultClaims,
            ...(spec.resultClaimsException ? { resultClaimsException: spec.resultClaimsException } : {}),
            resultClaimsSha256: manualSha256({
                claims: resultClaims,
                exception: spec.resultClaimsException || null
            }),
            readabilityRubric: spec.readabilityRubric,
            readabilityRubricSha256: manualSha256(spec.readabilityRubric),
            editorialQualityMetrics: editorialQuality.metrics
        } : {}),
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
            experimentTables: experimentTableContractVersion,
            methodDetail: 'detailed-v1',
            manualDepth: manualDepthContractVersion,
            ...(isManualV4 ? {
                imageNarrative: IMAGE_NARRATIVE_CONTRACT_VERSION,
                editorialQuality: EDITORIAL_QUALITY_CONTRACT_VERSION
            } : {})
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
        insertionPlan: canonicalImageArtifacts.insertionPlan,
        insertionDiagnostics: canonicalImageArtifacts.insertionDiagnostics,
        selected: selectedImages.map((info, index) => ({
            index: index + 1,
            ...info,
            selectionReason: selectedRequested.length > 0
                ? 'manual_explicit_secure_figure_review_and_context_bound_plan'
                : 'manual_no_selected_images'
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
        ...(isManualV4 ? {
            manualReadabilityRubric: spec.readabilityRubric,
            manualResultClaims: resultClaims,
            manualEditorialQualityMetrics: editorialQuality.metrics
        } : {}),
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
    if (![3, 4].includes(spec.version) || spec.mode !== MANUAL_COMPLETE_STATUS) {
        throw new Error('manual spec 必须是历史 version=3 或当前 version=4，且 mode=manual_complete');
    }
    if (spec.date !== date) throw new Error('manual spec.date 与 --date 不一致');
    const currentPromptBindings = buildStagePromptBindings();
    const promptBindings = resolveManualSpecPromptBindings(spec, currentPromptBindings);
    const promptSha256 = promptBindings.primaryAnalysis.sha256;
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
                        {
                            ...imagePreparation,
                            manualDepthContractVersion: spec.version === 4
                                ? MANUAL_DEPTH_CONTRACT_VERSION_V4
                                : MANUAL_DEPTH_CONTRACT_VERSION_V3
                        }
                    );
                    const writeDecision = manualCanonicalWriteDecision(
                        canonical, expectedRecord, force,
                    );
                    if (writeDecision === 'reuse') {
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
    normalizeManualV4ImageArtifacts,
    manualCanonicalReuseFingerprint,
    manualCanonicalWriteDecision,
    resolveManualSpecPromptBindings,
    finalizeManualCanonicalState,
    prepareManualImages,
    filteredPapersForDate,
    parseArgs,
    shouldReuseCanonical,
    run
};

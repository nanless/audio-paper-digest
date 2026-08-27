#!/usr/bin/env node
/** Validate one Manual v5 records file without requiring the rest of the batch. */
const fs = require('fs');
const path = require('path');
const Config = require('./config.js');
const { normalizedId, parseAnalysis } = require('./utils.js');
const {
    validateRecordsEnvelope,
    buildAnalysis,
    validateEvidenceLedger,
    resolveManualImageInsertions
} = require('./create-manual-analysis-spec.js');
const {
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    MANUAL_DEPTH_CONTRACT_VERSION_V5,
    normalizeExperimentTableNumericFormatting,
    getInvalidAnalysisReason,
    REQUIRED_RECOVERY_STAGES
} = require('./analysis-contract.js');
const {
    validateEditorialQuality,
    validateResultClaims
} = require('./editorial-quality.js');
const { applyImageInsertionPlan } = require('./deep-analyzer.js');
const { conciseManualImageCaption } = require('./manual-deep-analysis.js');
const {
    validateResearchBrief,
    validateStageReviews,
    validateFigureReview,
    validateManualAllRejectedImageException,
    validateOpenSourceEvidence,
    validateExactFactCoverage,
    validateResultClaimCoverageV5,
    validateEditorialPlanBindings,
    validateReaderArticle,
    validateEditorialReview
} = require('./manual-research-contract.js');

function parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        if (arg === '--date') result.date = value;
        else if (arg === '--paper') result.paper = normalizedId(value);
        else if (arg === '--records') result.records = value;
        else throw new Error(`未知参数: ${arg}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result.date || '')) throw new Error('--date 非法');
    if (!result.paper || !result.records) throw new Error('--paper/--records 必填');
    return result;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function replayManualImageInsertions(analysis, record, imageInfos, label) {
    const selectedImageUrls = record.selectedImageUrls || [];
    const imageUrlsIn = value => String(value).split(/\n\s*\n/).map(block => block.trim())
        .map(block => block.match(/^!\[(?:\\.|[^\]\\])*\]\((https:\/\/[^)\s]+)(?:\s+["'][^"']*["'])?\)$/)?.[1])
        .filter(Boolean);
    if (selectedImageUrls.length === 0) {
        if (imageUrlsIn(analysis).length > 0) {
            throw new Error(`${label} 未选图时正文不得手写 Markdown 图片`);
        }
        return analysis;
    }
    const resolvedPlans = resolveManualImageInsertions(
        analysis, record.imageInsertions, selectedImageUrls, label
    ).map((plan, index) => ({ ...plan, imageNumber: index + 1 }));
    const selectedImages = selectedImageUrls.map(url => {
        const image = imageInfos.find(item => item.url === url);
        if (!image) throw new Error(`${label} 含全文 manifest 中不存在的图片: ${url}`);
        return {
            ...image,
            displayCaption: conciseManualImageCaption(image.caption || image.alt || '')
        };
    });
    const insertion = applyImageInsertionPlan(
        analysis, resolvedPlans, selectedImages, Config.ANALYSIS_CONFIG.imageInsertionMax
    );
    const rejected = insertion.insertionDiagnostics.filter(item => item.inserted !== true);
    if (insertion.selectedImageUrls.length !== selectedImageUrls.length || rejected.length > 0) {
        const reasons = rejected.map(item => item.rejectionReason || 'unknown').join(', ');
        throw new Error(`${label} 未完整插入: ${reasons || 'selected_count_mismatch'}`);
    }
    const finalAnalysis = normalizeExperimentTableNumericFormatting(insertion.analysis);
    const finalImageUrls = imageUrlsIn(finalAnalysis);
    if (finalImageUrls.length !== selectedImageUrls.length
        || finalImageUrls.some((url, index) => url !== selectedImageUrls[index])) {
        throw new Error(`${label} 最终正文图片 URL/数量/顺序与 selectedImageUrls 不一致`);
    }
    return finalAnalysis;
}

function validateOne(options) {
    const recordsPath = path.resolve(options.records);
    const envelope = readJson(recordsPath);
    const normalized = validateRecordsEnvelope(envelope, recordsPath, options.date);
    if (normalized.version !== 3 || Object.keys(normalized.papers).length !== 1
        || !normalized.papers[options.paper]) {
        throw new Error('单篇校验只接受仅含目标 paper 的 records v3 envelope');
    }
    const filtered = readJson(Config.FILES.filteredPapers);
    const paper = filtered.papers.find(item => normalizedId(item) === options.paper);
    if (!paper) throw new Error('目标 paper 不在 filtered 批次');
    const manifestPath = path.join(Config.CURRENT_DIR, 'manual-full-text', options.date, 'manifest.json');
    const manifest = readJson(manifestPath);
    const entry = manifest.papers?.[options.paper];
    if (!entry || entry.status !== 'complete') throw new Error('目标 paper 缺少 complete 全文');
    const sourceText = fs.readFileSync(entry.path, 'utf8');
    const record = normalized.papers[options.paper];
    const normalizedSource = sourceText.normalize('NFKC').replace(/\s+/g, '');
    if (!normalizedSource.includes(record.authorInfo.sourceQuote.normalize('NFKC').replace(/\s+/g, ''))) {
        throw new Error('authorInfo.sourceQuote 不存在于本篇全文');
    }
    validateEvidenceLedger(record.evidenceLedger, sourceText, options.paper);
    const analysis = normalizeExperimentTableNumericFormatting(buildAnalysis(paper, record));
    const parsed = parseAnalysis(analysis);
    validateResearchBrief(record.researchBrief, {
        paperId: options.paper, documentType: record.type,
        sourceText, analysis, requireBindings: true
    });
    validateStageReviews({ version: 2, stages: record.stageReviews }, {
        stages: REQUIRED_RECOVERY_STAGES, sourceText,
        evidenceLedger: record.evidenceLedger, requireSourceBinding: true,
        label: `${options.paper}.stageReviews`
    });
    validateOpenSourceEvidence(record.openSourceEvidence, {
        dims: record.dims, resourceFlags: record, sourceText,
        requireSourceBinding: true, label: `${options.paper}.openSourceEvidence`
    });
    const claimResult = validateResultClaims(record.resultClaims, sourceText, {
        documentType: record.type, exception: record.resultClaimsException,
        readerResultsText: parsed.results || '', requireReaderNarrative: true
    });
    if (!claimResult.valid) throw new Error(`resultClaims: ${claimResult.errors.join('；')}`);
    validateResultClaimCoverageV5(record.resultClaims, {
        documentType: record.type, evidenceProfile: record.researchBrief.evidenceProfile,
        label: `${options.paper}.resultClaims`
    });
    const selectedImageUrls = record.selectedImageUrls || [];
    const explicitAllRejectedImageException = Array.isArray(record.selectedImageUrls)
        && selectedImageUrls.length === 0
        && Array.isArray(record.imageInsertions) && record.imageInsertions.length === 0;
    if (explicitAllRejectedImageException) {
        validateManualAllRejectedImageException({
            figureReview: record.figureReview,
            imageInfos: entry.imageInfos || [],
            selectedImageUrls,
            imageInsertions: record.imageInsertions,
            paperId: options.paper
        });
    } else {
        validateFigureReview(record.figureReview, {
            imageInfos: entry.imageInfos || [], selectedImageUrls, paperId: options.paper
        });
        if (Array.isArray(record.selectedImageUrls) && selectedImageUrls.length === 0
            && (entry.imageInfos || []).length > 0) {
            throw new Error(`${options.paper} 存在全文 manifest 候选图时，空 selectedImageUrls 仅允许逐图明确 reject 且显式 imageInsertions=[]`);
        }
    }
    const contractOptions = {
        enforceExperimentTableContract: true,
        experimentTableContractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        enforceMethodDetailContract: true,
        enforceManualDepthContract: true,
        manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V5,
        sourceText,
        researchBrief: record.researchBrief,
        openSourceEvidence: record.openSourceEvidence,
        resultClaims: record.resultClaims,
        evidenceLedger: record.evidenceLedger
    };
    const rawInvalid = getInvalidAnalysisReason(analysis, parsed, contractOptions);
    if (rawInvalid) throw new Error(`插图前 canonical 无效: ${rawInvalid}`);
    const finalAnalysis = replayManualImageInsertions(
        analysis, record, entry.imageInfos || [], `${options.paper}.imageInsertions`
    );
    const finalParsed = parseAnalysis(finalAnalysis);
    if (record.researchBrief?.editorialPlan?.version === 2) {
        validateEditorialPlanBindings(
            record.researchBrief.editorialPlan,
            analysis,
            record.evidenceLedger,
            `${options.paper}.researchBrief.editorialPlan`
        );
        const readerArticle = validateReaderArticle(
            record.researchBrief.editorialPlan,
            record.editorial?.readerArticle,
            record.evidenceLedger,
            {
                label: `${options.paper}.editorial.readerArticle`, sourceText,
                externalEvidence: record.openSourceEvidence.sourceQuotes,
                boundEvidence: [
                    ...record.resultClaims.map(claim => claim.sourceQuote),
                    ...record.evidenceLedger.map(item => item.sourceQuote)
                ],
                derivedFacts: record.researchBrief.derivedFacts,
                readerNarratives: record.resultClaims.map(claim => claim.readerNarrative),
                imageInsertions: record.imageInsertions || []
            }
        );
        validateEditorialReview(record.editorial.review, readerArticle, {
            label: `${options.paper}.editorial.review`
        });
    }
    validateExactFactCoverage(finalAnalysis, sourceText, {
        label: `${options.paper}.analysis`,
        externalEvidence: record.openSourceEvidence.sourceQuotes,
        boundEvidence: [
            ...record.resultClaims.map(claim => claim.sourceQuote),
            ...record.evidenceLedger.map(item => item.sourceQuote)
        ],
        derivedFacts: record.researchBrief.derivedFacts
    });
    const invalid = getInvalidAnalysisReason(finalAnalysis, finalParsed, contractOptions);
    if (invalid) throw new Error(invalid);
    const editorial = validateEditorialQuality(finalAnalysis);
    if (!editorial.valid) throw new Error(`editorialQuality: ${editorial.issues.map(item => item.code).join(',')}`);
    return {
        id: options.paper,
        analysisChars: finalAnalysis.length,
        score: finalParsed.score,
        images: record.selectedImageUrls.length
    };
}

function run(argv = process.argv.slice(2)) {
    const result = validateOne(parseArgs(argv));
    console.log(JSON.stringify(result));
    return result;
}

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('validate-manual-record.js');
    try { run(); } catch (error) { console.error(`manual record 校验失败: ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, replayManualImageInsertions, validateOne, run };

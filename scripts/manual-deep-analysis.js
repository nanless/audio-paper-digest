#!/usr/bin/env node
/**
 * Offline/manual deep-analysis ingestion.
 *
 * This command never calls an LLM or any remote API.  The operator supplies a
 * per-paper analysis draft, the exact full-text file used to write it, an
 * evidence ledger, and a two-pass audit record.  The command refuses to write
 * canonical data until every paper passes the normal analysis contract plus
 * the stricter manual_complete v2 provenance contract.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Config = require('./config.js');
const {
    parseAnalysis,
    normalizedId,
    getBeijingISOString,
    writeFileAtomic
} = require('./utils.js');
const {
    REQUIRED_RECOVERY_STAGES,
    MANUAL_COMPLETE_STATUS,
    manualSha256,
    manualTextSha256,
    validateManualTakeoverManifest,
    validateManualDepthContract,
    MANUAL_DEPTH_CONTRACT_VERSION,
    getInvalidAnalysisReason
} = require('./analysis-contract.js');
const {
    mergeAndSaveResults,
    isSuccessfulAnalysisRecord
} = require('./analysis-engine.js');
const { updateAnalysisDigestStatuses } = require('./digest-status.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const PROMPT_PATH = path.join(PROJECT_ROOT, 'prompts', 'deep-analysis.md');

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
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
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

function buildStageEvidence(spec, sourceSha256, analysisSha256, auditSha256) {
    const byStage = spec.reviewedClaimsByStage;
    if (!byStage || typeof byStage !== 'object') throw new Error('manualAudit.reviewedClaimsByStage 缺失');
    const result = {};
    for (const stage of REQUIRED_RECOVERY_STAGES) {
        const claims = byStage[stage];
        if (!Array.isArray(claims) || claims.length === 0
            || claims.some(claim => typeof claim !== 'string' || claim.trim().length < 12)) {
            throw new Error(`manualAudit.reviewedClaimsByStage.${stage} 必须包含具体审查声明`);
        }
        const stageAuditSha256 = manualSha256({ stage, claims, auditSha256 });
        result[stage] = {
            status: MANUAL_COMPLETE_STATUS,
            inputSha256: stage === 'primaryAnalysis' ? sourceSha256 : analysisSha256,
            outputSha256: analysisSha256,
            auditSha256: stageAuditSha256,
            attempts: 2,
            reviewedClaims: claims
        };
    }
    return result;
}

function buildManualRecord(paper, spec, date, promptSha256) {
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
        sourceText
    });
    if (invalidReason) throw new Error(`${normalizedId(paper)} 分析契约失败: ${invalidReason}`);
    const manualDepthIssue = validateManualDepthContract(spec.analysis, { sourceText });
    if (manualDepthIssue) throw new Error(`${normalizedId(paper)} manual 深度契约失败: ${manualDepthIssue}`);
    const analysisSha256 = manualTextSha256(spec.analysis);
    const audit = spec.manualAudit;
    if (!audit || typeof audit !== 'object' || audit.version !== 1) {
        throw new Error(`${normalizedId(paper)} 缺少 manualAudit v1`);
    }
    const auditSha256 = manualSha256(audit);
    const evidenceLedger = spec.evidenceLedger;
    const takeover = {
        version: 2,
        mode: MANUAL_COMPLETE_STATUS,
        agent: spec.agent || 'Codex',
        basis: 'full_text',
        sourceSha256,
        promptSha256,
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
        stageEvidence: buildStageEvidence(spec, sourceSha256, analysisSha256, auditSha256)
    };
    const stages = Object.fromEntries(Object.entries(stageStatusMap()).map(([stage, status]) => [stage, {
        status,
        updatedAt: takeover.completedAt,
        fingerprint: manualSha256({ date, id: normalizedId(paper), stage, promptSha256, sourceSha256, analysisSha256 })
    }]));
    const analysisManifest = {
        version: 1,
        contracts: {
            experimentTables: 'bounded-v1',
            methodDetail: 'detailed-v1',
            manualDepth: MANUAL_DEPTH_CONTRACT_VERSION
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
    const manifestIssue = validateManualTakeoverManifest(analysisManifest, sourceSha256, {
        analysis: spec.analysis,
        sourceText
    });
    if (manifestIssue) throw new Error(`${normalizedId(paper)} manual provenance 失败: ${manifestIssue}`);
    const imageInfos = Array.isArray(spec.imageInfos) ? spec.imageInfos : [];
    const imageUrls = imageInfos
        .filter(info => info && typeof info.url === 'string' && /^https:\/\/[^\s)]+/i.test(info.url)
            && !/(?:\/static\/|funders?|sponsor|logo|icon|avatar|favicon)/i.test(info.url))
        .map(info => info.url);
    const usableImageInfos = imageInfos.filter(info => info && imageUrls.includes(info.url));
    const imageManifest = {
        version: 1,
        source: imageInfos.length > 0 ? 'manual_full_text_html' : 'manual_no_image_metadata',
        totalFound: usableImageInfos.length,
        candidates: usableImageInfos.map((info, index) => ({
            index: index + 1,
            url: info.url,
            caption: info.caption || info.alt || '',
            source: info.source || 'arxiv_html'
        })),
        selected: usableImageInfos.slice(0, 4).map((info, index) => ({
            index: index + 1,
            url: info.url,
            caption: info.caption || info.alt || '',
            selectionReason: 'manual_full_text_figure_review'
        }))
    };
    return {
        ...paper,
        analysis: spec.analysis,
        parsed,
        scoringRubricVersion: parsed.scoringRubricVersion,
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

async function run() {
    const { date, spec: specPathArg } = parseArgs(process.argv.slice(2));
    const specPath = path.resolve(PROJECT_ROOT, specPathArg);
    const spec = readJson(specPath, 'manual spec');
    if (spec.version !== 2 || spec.mode !== MANUAL_COMPLETE_STATUS) {
        throw new Error('manual spec 必须是 version=2、mode=manual_complete');
    }
    if (spec.date !== date) throw new Error('manual spec.date 与 --date 不一致');
    const promptSha256 = sha256File(PROMPT_PATH);
    if (spec.promptSha256 && spec.promptSha256 !== promptSha256) {
        throw new Error('manual spec.promptSha256 与当前 deep-analysis prompt 不一致');
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
    const records = [];
    const failures = [];
    for (const paper of papers) {
        try {
            records.push(buildManualRecord(paper, specPapers[normalizedId(paper)] || specPapers[paper.arxivId], date, promptSha256));
        } catch (error) {
            failures.push(`${normalizedId(paper)}: ${error.message}`);
        }
    }
    if (failures.length > 0) {
        console.error(`manual_complete 拒绝写入；${failures.length} 篇未通过二次审计:`);
        failures.forEach(item => console.error(`  - ${item}`));
        process.exitCode = 2;
        return;
    }
    const saved = await mergeAndSaveResults(records, Config.FILES.deepAnalysisResult, {
        batchDate: date,
        status: 'complete',
        stats: {
            analysisStatus: 'complete',
            pipelineStatus: 'analysis_complete',
            total: records.length,
            success: records.length,
            failed: 0,
            manualComplete: records.length,
            apiCalls: 0,
            promptSha256
        },
        deepAnalysisCompletedAt: getBeijingISOString()
    });
    updateAnalysisDigestStatuses(records, { batchDate: date });
    const summary = records.reduce((acc, paper) => {
        acc.success += isSuccessfulAnalysisRecord(paper) ? 1 : 0;
        return acc;
    }, { success: 0 });
    console.log(`manual_complete 离线分析写入 ${saved.totalMerged} 篇，成功 ${summary.success} 篇，API 调用 0 次`);
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
    buildStageEvidence,
    filteredPapersForDate,
    run
};

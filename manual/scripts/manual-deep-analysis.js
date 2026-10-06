#!/usr/bin/env node
/**
 * 离线人工深度分析的录入命令。
 *
 * 这条命令不调用任何 LLM。操作者自己提供每篇论文的分析稿、写稿时实际使用的
 * 全文文件、证据清单和审查记录。每篇论文都在自己的分析锁内校验并落盘；中途
 * 失败只留下可续跑的录入检查点，不会写成能发布的 manual_complete 内容。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const Config = require('../../scripts/config.js');
const {
    parseAnalysis,
    normalizedId,
    getBeijingISOString
} = require('../../scripts/utils.js');
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
    extractSection,
    getInvalidAnalysisReason
} = require('../../scripts/analysis-contract.js');
const {
    validateEditorialQuality,
    validateResultClaims,
    validateReadabilityRubric
} = require('../../scripts/editorial-quality.js');
const {
    mergeAndSaveResults,
    isSuccessfulAnalysisRecord,
    withPaperAnalysisLock,
    loadStoredAnalysisRecord,
    updateJsonFileLocked
} = require('../../scripts/analysis-engine.js');
const {
    normalizeImageInfos,
    selectImageCandidates,
    cachePublicImageDetailed,
    checkDemoPageForOpensource,
    requestPinnedPublicHttps,
    validatePublicHttpUrl,
    applyImageInsertionPlan,
    IMAGE_NARRATIVE_CONTRACT_VERSION
} = require('../../scripts/deep-analyzer.js');
const { updateAnalysisDigestStatuses } = require('../../scripts/digest-status.js');
const {
    MANUAL_RESEARCH_CONTRACT_VERSION,
    validateEditorialReview
} = require('./manual-research-contract.js');
const {
    validateManualTutorialReaderBundle
} = require('./manual-tutorial-contract-orchestrator.js');
const MANUAL_DEPTH_CONTRACT_VERSION_V5 = require('../../scripts/analysis-contract.js').MANUAL_DEPTH_CONTRACT_VERSION_V5
    || MANUAL_DEPTH_CONTRACT_VERSION_V4;
const {
    MANUAL_SPEC_VERSION_V6,
    MANUAL_DEPTH_V6,
    MANUAL_V6_RUNTIME_MODE_PRODUCTION,
    MANUAL_V6_RUNTIME_MODE_SHADOW,
    MANUAL_V6_AUTHOR_LINEAGE_CONTRACT,
    resolveManualV6RuntimePaths,
    stableSha256: manualV6StableSha256
} = require('./manual-v6-workflow.js');
const {
    monotonicNs,
    persistStageMetricSafely
} = require('./manual-performance-metrics.js');
const {
    FRESH_AUTHORING_CONTRACT,
    AUTHORING_PROMPT_PATH: FRESH_AUTHORING_PROMPT_PATH,
    EDITORIAL_CONTRACT_PATH,
    BLANK_SCHEMA_PATH,
    defaultArticlePath,
    resolveArtifactAuthority,
    validateFreshAuthoringReceipt
} = require('./manual-fresh-authoring-contract.js');
const {
    MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
    defaultTutorialPayloadPaths,
    validateTutorialPayloadReceipt
} = require('./manual-v5-tutorial-payload.js');
const { TUTORIAL_ARTIFACT_PLAN_VERSION } = require('./manual-tutorial-artifacts.js');
const {
    MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT,
    validateManualPaperSourceIdentity
} = require('./manual-paper-source-identity.js');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const MANUAL_AUTHORING_PROMPT_PATH = path.join(PROJECT_ROOT, 'manual', 'prompts', 'manual-analysis-record.md');
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
const CURRENT_MANUAL_SPEC_VERSIONS = new Set([4, 5]);
const MANUAL_ANALYSIS_WORKER_COUNT = 3;
const MANUAL_EXTERNAL_RESOURCE_CACHE_VERSION = 1;
const MANUAL_EXTERNAL_RESOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Hugging Face 数据集页面走项目代理时可能超过 15 秒。这里给一个有限的绝对
// 截止时间，同时避免把一个实际能访问的公开资源误判成发布失败。
const MANUAL_EXTERNAL_RESOURCE_TIMEOUT_MS = 45 * 1000;
const externalResourceVerificationInFlight = new Map();
const execFileAsync = promisify(execFile);

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
        throw new Error(`${label} 无法读取，或其中的 JSON 内容无效：${filePath}；原因：${error.message}`);
    }
    if (!value || typeof value !== 'object') throw new Error(`${label} 的顶层内容必须是对象或数组：${filePath}`);
    return value;
}

function parseArgs(argv) {
    const options = { force: false, v6Production: false, v6Shadow: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--force') {
            if (options.force) throw new Error('--force 不能重复指定。');
            options.force = true;
            continue;
        }
        if (arg === '--v6-shadow') {
            if (options.v6Shadow || options.v6Production) {
                throw new Error('--v6-production 与 --v6-shadow 不能同时指定，也不能重复指定。');
            }
            options.v6Shadow = true;
            continue;
        }
        if (arg === '--v6-production') {
            if (options.v6Production || options.v6Shadow) {
                throw new Error('--v6-production 与 --v6-shadow 不能同时指定，也不能重复指定。');
            }
            options.v6Production = true;
            continue;
        }
        if (!['--date', '--spec'].includes(arg)) throw new Error(`无法识别参数 ${arg}。`);
        if (options[arg.slice(2)] !== undefined) throw new Error(`参数 ${arg} 不能重复指定。`);
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`参数 ${arg} 后必须提供一个值。`);
        options[arg.slice(2)] = value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date 必须按 YYYY-MM-DD 格式填写。');
    if (!options.spec) throw new Error('请通过 --spec 指定人工分析配置的 JSON 文件。');
    return options;
}

function assertExplicitManualV6Mode(spec, options = {}) {
    if (typeof options === 'boolean') options = { v6Shadow: options };
    const isV6 = spec?.version === MANUAL_SPEC_VERSION_V6;
    const selected = Number(Boolean(options.v6Production)) + Number(Boolean(options.v6Shadow));
    if ((isV6 && selected !== 1) || (!isV6 && selected !== 0)) {
        throw new Error('人工分析 v6 必须明确选择 --v6-production 或 --v6-shadow，且只能选择一种模式；其他版本不能使用这两个选项。');
    }
    return isV6;
}

function filteredPapersForDate(date) {
    return loadFilteredBatchForDate(date).papers;
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
    if (!spec || (spec.version !== 3 && !CURRENT_MANUAL_SPEC_VERSIONS.has(spec.version)
        && spec.version !== MANUAL_SPEC_VERSION_V6)) {
        throw new Error('人工分析提示文件的对应记录只支持历史 v3、兼容 v4/v5，以及明确选择正式或影子模式的 v6 配置。');
    }
    if (spec.manualAuthoringPromptPath !== 'manual/prompts/manual-analysis-record.md') {
        throw new Error('人工分析配置必须引用指定的 Manual 成稿规范文件。');
    }
    const currentAuthoringSha256 = sha256File(MANUAL_AUTHORING_PROMPT_PATH);
    if (CURRENT_MANUAL_SPEC_VERSIONS.has(spec.version) || spec.version === MANUAL_SPEC_VERSION_V6) {
        if (spec.promptSha256 && spec.promptSha256 !== currentBindings.primaryAnalysis.sha256) {
            throw new Error('人工分析配置的 promptSha256 与当前主分析提示文件的 SHA 不一致。');
        }
        if (spec.manualAuthoringPromptSha256 !== currentAuthoringSha256) {
            throw new Error('人工分析配置中的成稿规范 SHA 与当前 manual/prompts/manual-analysis-record.md 文件不一致。');
        }
        if (spec.stagePromptSha256 !== undefined) {
            if (!spec.stagePromptSha256 || typeof spec.stagePromptSha256 !== 'object'
                || Array.isArray(spec.stagePromptSha256)) {
                throw new Error('人工分析配置的 stagePromptSha256 必须是按阶段记录 SHA 的对象，不能是数组。');
            }
            for (const stage of REQUIRED_RECOVERY_STAGES) {
                if (spec.stagePromptSha256[stage] !== currentBindings[stage].sha256) {
                    throw new Error(`人工分析配置中 ${stage} 阶段的提示文件或阶段规则 SHA 与当前值不一致。`);
                }
            }
        }
        return currentBindings;
    }

    // 历史的 v3 配置保留它当初声明的提示哈希。这里只检查所有必需阶段都在、
    // 而且彼此自洽；要是强求今天的提示哈希，这些旧配置就再也读不进来了。
    // 当前的 v4、v5、v6 配置走上面那套当前绑定。
    if (!/^[a-f0-9]{64}$/.test(String(spec.promptSha256 || ''))
        || !/^[a-f0-9]{64}$/.test(String(spec.manualAuthoringPromptSha256 || ''))) {
        throw new Error('历史人工分析 v3 配置中的主分析提示 SHA 或成稿规范 SHA 缺失或格式无效。');
    }
    if (!spec.stagePromptSha256 || typeof spec.stagePromptSha256 !== 'object'
        || Array.isArray(spec.stagePromptSha256)
        || Object.keys(spec.stagePromptSha256).length !== REQUIRED_RECOVERY_STAGES.length) {
        throw new Error('历史人工分析 v3 配置必须在 stagePromptSha256 中完整记录所有阶段，不能缺少或多出阶段。');
    }
    const historicalBindings = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => {
        const sha256 = spec.stagePromptSha256[stage];
        if (!/^[a-f0-9]{64}$/.test(String(sha256 || ''))) {
            throw new Error(`历史人工分析 v3 配置中 ${stage} 阶段的 SHA-256 格式无效。`);
        }
        return [stage, { source: currentBindings[stage].source, sha256 }];
    }));
    if (historicalBindings.primaryAnalysis.sha256 !== spec.promptSha256) {
        throw new Error('历史人工分析 v3 配置的 promptSha256 与主分析阶段记录的 SHA 不一致。');
    }
    return historicalBindings;
}

function loadFilteredBatchForDate(date, filteredPath = Config.FILES.filteredPapers) {
    const data = readJson(filteredPath, 'filtered-papers');
    if (data.batchDate !== date || data.status !== 'complete' || !Array.isArray(data.papers)) {
        throw new Error(`filtered-papers.json 的日期不是 ${date}、筛选尚未完成，或论文列表不是数组。`);
    }
    const ids = new Set();
    for (const paper of data.papers) {
        const id = normalizedId(paper);
        if (!id || ids.has(id)) throw new Error(`筛选论文列表中的 ID 在规范化后为空或重复：${id || '(missing)'}`);
        ids.add(id);
    }
    return data;
}

/**
 * 检查筛选批次、全文清单和分析记录文件，再用这些输入重新装配一遍 v4 或 v5
 * 配置。重新装配出来的配置必须与传进来的配置有相同的稳定对象哈希。
 */
function validateManualV4AssemblyInputs(spec, options = {}) {
    if (!spec || !CURRENT_MANUAL_SPEC_VERSIONS.has(spec.version)) {
        throw new Error('组装输入核验只支持人工分析 v4/v5 配置。');
    }
    const date = options.date || spec.date;
    const filteredPath = options.filteredPath || Config.FILES.filteredPapers;
    const filtered = options.filtered || loadFilteredBatchForDate(date, filteredPath);
    const expectedManifestPath = options.manifestPath
        || path.join(Config.CURRENT_DIR, 'manual-full-text', date, 'manifest.json');
    const declaredManifest = spec.fullTextManifest;
    if (!declaredManifest || typeof declaredManifest !== 'object' || Array.isArray(declaredManifest)) {
        throw new Error('人工分析 v4/v5 配置中的全文清单记录缺失或格式无效。');
    }
    if (path.resolve(String(declaredManifest.path || '')) !== path.resolve(expectedManifestPath)) {
        throw new Error('人工分析配置中的全文清单路径与当前日期指定的路径不一致。');
    }
    if (fs.lstatSync(expectedManifestPath).isSymbolicLink()) {
        throw new Error('人工分析全文清单不能是符号链接。');
    }
    const manifestBuffer = fs.readFileSync(expectedManifestPath);
    if (sha256Buffer(manifestBuffer) !== declaredManifest.sha256) {
        throw new Error('人工分析配置记录的全文清单 SHA 与当前文件内容不一致。');
    }
    const manifest = readJson(expectedManifestPath, 'manual full-text manifest');
    const {
        stableSha256,
        buildManifestContext,
        isReusableFullTextCheckpoint
    } = require('./manual-fetch-fulltext.js');
    const context = buildManifestContext(filtered, date, path.dirname(expectedManifestPath));
    if (manifest.version !== 2 || manifest.mode !== 'manual_full_text_fetch'
        || manifest.date !== date || manifest.status !== 'complete' || manifest.failed !== 0
        || manifest.count !== filtered.papers.length
        || manifest.filteredBatchSha256 !== context.filteredBatchSha256
        || manifest.filteredPapersSha256 !== context.filteredBatchSha256
        || stableSha256(manifest.expectedPaperInputs) !== stableSha256(context.expectedPaperInputs)
        || spec.filteredBatchSha256 !== context.filteredBatchSha256
        || declaredManifest.filteredBatchSha256 !== context.filteredBatchSha256
        || declaredManifest.paperCount !== filtered.papers.length) {
        throw new Error('人工分析配置、全文清单或筛选结果的批次信息、论文数量、状态或输入记录不一致。');
    }
    if (!manifest.papers || typeof manifest.papers !== 'object' || Array.isArray(manifest.papers)) {
        throw new Error('人工分析全文清单中的 papers 必须是对象，不能是数组。');
    }
    const manifestIds = Object.keys(manifest.papers).map(normalizedId);
    if (manifestIds.length !== context.inputs.length || new Set(manifestIds).size !== context.inputs.length) {
        throw new Error('全文清单中的论文数量与筛选结果不一致，或规范化后的论文 ID 存在重复。');
    }
    for (const input of context.inputs) {
        const entry = manifest.papers[input.id];
        if (!isReusableFullTextCheckpoint(entry, input.filePath, input)) {
            throw new Error(`${input.id} 的全文检查点路径、版本、来源记录或内容 SHA 无效。`);
        }
        const realEntryPath = fs.realpathSync(entry.path);
        const realManifestDir = fs.realpathSync(path.dirname(expectedManifestPath));
        const relativeEntryPath = path.relative(realManifestDir, realEntryPath);
        if (fs.lstatSync(entry.path).isSymbolicLink()
            || !relativeEntryPath || relativeEntryPath.startsWith(`..${path.sep}`)
            || path.isAbsolute(relativeEntryPath)) {
            throw new Error(`${input.id} 的全文检查点使用了符号链接，或没有位于同一批次的指定目录中。`);
        }
        const paperSpec = spec.papers?.[input.id];
        if (!paperSpec
            || path.resolve(String(paperSpec.fullTextPath || '')) !== path.resolve(entry.path)
            || paperSpec.sourceSha256 !== entry.sourceSha256
            || paperSpec.sourceIdentitySha256 !== entry.sourceIdentitySha256
            || paperSpec.paperMetadataSha256 !== input.paperMetadataSha256
            || paperSpec.paperInputSha256 !== input.paperInputSha256
            || paperSpec.filteredBatchSha256 !== context.filteredBatchSha256
            || stableSha256(paperSpec.imageInfos || []) !== stableSha256(entry.imageInfos || [])) {
            throw new Error(`${input.id} 的全文路径、论文元数据、输入与来源记录或图片列表，与同批全文清单不一致。`);
        }
    }
    if (!Array.isArray(spec.recordsSources) || spec.recordsSources.length === 0) {
        throw new Error('人工分析配置必须在 recordsSources 中提供至少一份分析记录文件。');
    }
    const sourcePaths = new Set();
    const recordInputs = spec.recordsSources.map((source, index) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)
            || typeof source.path !== 'string' || !/^[a-f0-9]{64}$/.test(String(source.sha256 || ''))) {
            throw new Error(`人工分析配置中的 recordsSources[${index}] 必须提供文件路径和格式有效的 SHA-256。`);
        }
        const sourcePath = path.resolve(source.path);
        if (sourcePaths.has(sourcePath)) throw new Error(`人工分析配置的 recordsSources 重复引用了同一文件：${sourcePath}`);
        sourcePaths.add(sourcePath);
        if (fs.lstatSync(sourcePath).isSymbolicLink()) {
            throw new Error(`人工分析记录文件不能是符号链接：${sourcePath}`);
        }
        const buffer = fs.readFileSync(sourcePath);
        if (sha256Buffer(buffer) !== source.sha256) {
            throw new Error(`人工分析记录文件的 SHA 与配置中的值不一致：${sourcePath}`);
        }
        return { path: sourcePath, document: readJson(sourcePath, 'manual analysis records') };
    });

    // 这里延迟 require：装配器反过来依赖本文件的提示绑定，直接放在顶部会形成
    // 初始化循环。
    const assembler = require('./create-manual-analysis-spec.js');
    const mergedRecords = assembler.mergeRecordsEnvelopes(recordInputs, date);
    const expectedRecordsVersion = spec.version === 5
        ? assembler.RECORDS_VERSION
        : assembler.LEGACY_RECORDS_VERSION;
    if (mergedRecords.recordsVersion !== expectedRecordsVersion
        || spec.recordsVersion !== expectedRecordsVersion) {
        throw new Error(
            `人工分析配置 v${spec.version} 与分析记录 v${mergedRecords.recordsVersion} 不符合对应的版本要求。`
        );
    }
    const rebuilt = assembler.buildSpec({
        date,
        filtered,
        filteredPath,
        manifest,
        manifestPath: expectedManifestPath,
        mergedRecords,
        generatedAt: spec.generatedAt,
        promptBindings: buildStagePromptBindings()
    });
    if (rebuilt.version !== spec.version) {
        throw new Error(
            `提供的人工分析配置为 v${spec.version}，重新组装的配置为 v${rebuilt.version}；两者版本必须一致。`
        );
    }
    if (stableSha256(rebuilt) !== stableSha256(spec)) {
        throw new Error('人工分析配置与当前组装程序根据已记录的分析文件和全文文件重新生成的结果不一致。');
    }
    return {
        filtered, manifest, context, rebuilt,
        filteredPath,
        artifactManifestPath: rebuilt.artifactManifest?.path || null,
        currentRoot: path.resolve(path.dirname(expectedManifestPath), '..', '..')
    };
}

function validateManualV6AssemblyInputs(spec, options = {}) {
    if (!spec || spec.version !== MANUAL_SPEC_VERSION_V6 || spec.status !== 'complete') {
        throw new Error('人工分析配置的版本必须为 v6，状态必须为 complete。');
    }
    const date = options.date || spec.date;
    const runtimeMode = options.runtimeMode;
    const runtimePaths = resolveManualV6RuntimePaths(Config.CURRENT_DIR, date, runtimeMode);
    if (spec.runtimeMode !== runtimeMode) {
        throw new Error('人工分析 v6 配置中的 runtimeMode 与明确选择的运行模式不一致。');
    }
    const filteredPath = options.filteredPath || Config.FILES.filteredPapers;
    const fullTextManifestPath = path.join(Config.CURRENT_DIR, 'manual-full-text', date, 'manifest.json');
    const artifactManifestPath = path.join(
        Config.CURRENT_DIR, 'manual-full-text', date, 'artifacts', 'manifest.json'
    );
    const expectedInputs = [
        [spec.filteredPapers, filteredPath, 'filteredPapers'],
        [spec.fullTextManifest, fullTextManifestPath, 'fullTextManifest'],
        [spec.artifactManifest, artifactManifestPath, 'artifactManifest']
    ];
    for (const [declared, expectedPath, label] of expectedInputs) {
        if (!declared || path.resolve(String(declared.path || '')) !== path.resolve(expectedPath)
            || fs.lstatSync(expectedPath).isSymbolicLink()
            || sha256File(expectedPath) !== declared.sha256) {
            throw new Error(`人工分析 v6 配置中的 ${label} 缺失、路径或 SHA 与指定文件不一致，或该文件是符号链接。`);
        }
    }
    const assembler = require('./create-manual-analysis-spec-v6.js');
    const records = assembler.loadRecordsV4Envelopes(
        (spec.recordsSources || []).map(source => source.path), date, { runtimeMode }
    );
    const recordsEnvelope = spec.recordsEnvelope || null;
    if (runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION) {
        const recordsEnvelopeBytes = fs.readFileSync(runtimePaths.recordsEnvelopePath);
        if (!recordsEnvelope
            || recordsEnvelope.version !== 4
            || recordsEnvelope.mode !== 'manual_analysis_records'
            || path.resolve(String(recordsEnvelope.path || '')) !== path.resolve(runtimePaths.recordsEnvelopePath)
            || fs.lstatSync(runtimePaths.recordsEnvelopePath).isSymbolicLink()
            || sha256Buffer(recordsEnvelopeBytes) !== recordsEnvelope.sha256
            || spec.recordsSources?.length !== 1
            || path.resolve(String(spec.recordsSources[0]?.path || '')) !== path.resolve(runtimePaths.recordsEnvelopePath)
            || spec.recordsSources[0]?.sha256 !== recordsEnvelope.sha256) {
            throw new Error('正式人工分析 v6 配置必须只引用指定的 records-v4.json 文件，且文件信息、路径和 SHA 必须一致。');
        }
    }
    const rebuilt = assembler.buildSpecV6({
        date,
        filtered: readJson(filteredPath, 'filtered-papers'),
        filteredPath,
        fullTextManifest: readJson(fullTextManifestPath, 'manual full-text manifest'),
        fullTextManifestPath,
        artifactManifest: readJson(artifactManifestPath, 'ArtifactIndex manifest'),
        artifactManifestPath,
        records,
        runtimeMode,
        allowSignedV6CompatibilityOverride: runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
            && spec.v5BridgeMode === 'signed-v6-task-evidence-override-v1',
        ...(recordsEnvelope ? { recordsEnvelope } : {}),
        generatedAt: spec.generatedAt
    });
    if (manualV6StableSha256(rebuilt) !== manualV6StableSha256(spec)) {
        throw new Error('人工分析 v6 配置与当前组装程序根据这些文件重新生成的结果不一致。');
    }
    return {
        filtered: readJson(filteredPath, 'filtered-papers'),
        rebuilt,
        records,
        specRootSha256: rebuilt.rootSha256
    };
}

function getManualAnalysisReuseHash(record) {
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
        sourceAcquisitionSha256: manualSha256(manifest.sourceAcquisition || null),
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
        researchBriefSha256: takeover.researchBriefSha256 || null,
        computedResearchBriefSha256: manualSha256(takeover.researchBrief || null),
        readerArticleSha256: takeover.readerArticleSha256 || null,
        computedReaderArticleSha256: manualTextSha256(takeover.readerArticle || ''),
        editorialReviewSha256: takeover.editorialReviewSha256 || null,
        computedEditorialReviewSha256: manualTextSha256(takeover.editorialReview || ''),
        stageReviewsSha256: takeover.stageReviewsSha256 || null,
        computedStageReviewsSha256: manualSha256(takeover.stageReviews || null),
        scoringCalibrationSha256: takeover.scoringCalibrationSha256 || null,
        computedScoringCalibrationSha256: manualSha256(takeover.scoringCalibration || null),
        openSourceEvidenceSha256: takeover.openSourceEvidenceSha256 || null,
        computedOpenSourceEvidenceSha256: manualSha256(takeover.openSourceEvidence || null),
        figureReviewSha256: takeover.figureReviewSha256 || null,
        computedFigureReviewSha256: manualSha256(takeover.figureReview || null),
        externalResourceVerificationSha256: takeover.externalResourceVerificationSha256 || null,
        computedExternalResourceVerificationSha256: manualSha256(takeover.externalResourceVerification || null),
        freshAuthoringSha256: takeover.freshAuthoringSha256 || null,
        computedFreshAuthoringSha256: manualSha256(takeover.freshAuthoring || null),
        tutorialPayloadSha256: takeover.tutorialPayloadSha256 || null,
        computedTutorialPayloadSha256: manualSha256(takeover.tutorialPayload || null),
        v6ProvenanceSha256: manualSha256(takeover.v6Provenance || null),
        topLevelV6ProvenanceSha256: manualSha256(record.manualV6Provenance || null),
        manualArtifactIndexSha256: manualSha256(record.manualArtifactIndex || null),
        manualReaderLongformSha256: manualSha256(record.manualReaderLongform || null),
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

function canReuseSavedManualAnalysis(storedAnalysisRecord, expectedRecord, force = false) {
    if (force || !isSuccessfulAnalysisRecord(storedAnalysisRecord) || !isSuccessfulAnalysisRecord(expectedRecord)) {
        return false;
    }
    const savedRecordReuseHash = getManualAnalysisReuseHash(storedAnalysisRecord);
    const expectedFingerprint = getManualAnalysisReuseHash(expectedRecord);
    return Boolean(savedRecordReuseHash && savedRecordReuseHash === expectedFingerprint);
}

function getManualAnalysisWriteDecision(storedAnalysisRecord, expectedRecord, force = false) {
    if (!isSuccessfulAnalysisRecord(storedAnalysisRecord)) return 'write';
    if (force) return 'write';
    if (canReuseSavedManualAnalysis(storedAnalysisRecord, expectedRecord, false)) return 'reuse';
    throw new Error(
        `${normalizedId(expectedRecord) || '当前论文'} 已有成功的分析记录，`
        + '但本次记录未通过复用检查；请核对正文、来源、提示文件、图片和审查记录，确认需要覆盖后再明确使用 --force。'
    );
}

function finalizeManualAnalysisBatchState(filePath, options) {
    const date = options?.date;
    const expectedIds = [...new Set((options?.expectedIds || []).map(normalizedId).filter(Boolean))];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || expectedIds.length === 0) {
        throw new Error('finalizeManualAnalysisBatchState 的 date 必须符合 YYYY-MM-DD 格式，目标论文 ID 列表 expectedIds 在规范化后不能为空。');
    }
    return updateJsonFileLocked(filePath, current => {
        const currentObject = current && !Array.isArray(current) ? current : {};
        const papers = Array.isArray(current) ? current : (currentObject.papers || []);
        const byId = new Map(papers.map(paper => [normalizedId(paper), paper]));
        const expectedRecords = expectedIds.map(id => byId.get(id) || null);
        const isExpectedSuccess = record => (
            isSuccessfulAnalysisRecord(record)
            && (!options.requiredManualV6Runtime || (
                record.manualDepth === MANUAL_DEPTH_V6
                && record.manualV6Provenance?.runtimeMode === options.requiredManualV6Runtime
                && record.analysisManifest?.manualTakeover?.v6Provenance?.runtimeMode
                    === options.requiredManualV6Runtime
                && record.analysisManifest?.contracts?.manualV6Runtime
                    === options.requiredManualV6Runtime
            ))
        );
        const currentBatchPapers = expectedRecords.filter(Boolean);
        const failedIds = expectedIds.filter((id, index) => !isExpectedSuccess(expectedRecords[index]));
        const success = expectedIds.length - failedIds.length;
        const status = failedIds.length === 0 ? 'complete' : 'partial_failed';
        const now = getBeijingISOString();
        const payload = {
            ...currentObject,
            timestamp: now,
            batchDate: date,
            status,
            // 当前数据只装一个批次。这里只保留本批次应有的论文，免得旧批次的
            // 论文被拿去对照本批次的来源清单，或者被算进本批次的覆盖率。
            papers: currentBatchPapers,
            stats: {
                ...(currentObject.stats || {}),
                ...(options.stats || {}),
                analysisStatus: status,
                pipelineStatus: status === 'complete' ? 'analysis_complete' : 'analysis_partial_failed',
                total: expectedIds.length,
                totalAfterMerge: currentBatchPapers.length,
                expected: expectedIds.length,
                success,
                successfulExpected: success,
                failed: failedIds.length,
                remainingFailed: failedIds.length,
                failedIds,
                manualComplete: expectedRecords.filter(record => (
                    isExpectedSuccess(record)
                    && record.analysisManifest?.manualTakeover?.mode === MANUAL_COMPLETE_STATUS
                )).length,
                failedCheckpoints: expectedRecords.filter(record => (
                    !isExpectedSuccess(record) && Boolean(record?.manualIngestionCheckpoint)
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
    if (!byStage || typeof byStage !== 'object') throw new Error('人工分析必须在 reviewedClaimsByStage 中按阶段提供审查声明。');
    const result = {};
    for (const stage of REQUIRED_RECOVERY_STAGES) {
        const claims = byStage[stage];
        if (!Array.isArray(claims) || claims.length === 0
            || claims.some(claim => typeof claim !== 'string' || claim.trim().length < 12)) {
            throw new Error(`${stage} 阶段的审查声明必须是非空数组，每条声明都必须是字符串，去除首尾空白后至少包含 12 个字符。`);
        }
        // 人工运行没有远端模型响应可以取指纹。这里把每个离线阶段绑到它自己那份
        // 审查过的声明上，而不是假装所有阶段吃的是同一份通用分析输入。最终输出
        // 可以只有一个 SHA（离线编辑只写一次），但各阶段的输入哈希和审查哈希必须
        // 各不相同。
        const binding = promptBindings[stage];
        const attempts = spec.stageReviewAttemptsByStage?.[stage]
            ?? spec.manualAudit?.passes?.length;
        if (!Number.isInteger(attempts) || attempts < 2) {
            throw new Error(`${stage} 阶段的实际审查次数必须是整数，且至少为两次。`);
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
    // 博客的替代文本必须是一段完整的意思。以前按固定字符数硬切，结果图注会
    // 断在半个分句甚至半个词上，看起来比 API 生成的页面差很多，还可能把结论
    // 附带的前提条件切掉。原文图注确实有多句又太长时，优先取完整的第一句；
    // 否则整条原图注照用。这里刻意不把分号当句末。
    if (text.length <= maxChars) return text;
    const firstSentence = text.match(/^.{20,}?[.!?。！？](?=\s|$)/)?.[0];
    if (firstSentence && firstSentence.length <= maxChars) return firstSentence;
    // arXiv HTML 偶尔给出的图注本身就已经被截断，比我们自己的长度上限还短。
    // 一个没有句末标点的长分句不适合原样发布，换成一条完整的替代文本。
    const section = manualImageSection(text);
    if (section === '方法概述和架构') return '论文方法与系统结构总览图';
    if (section === '实验结果') return '论文关键实验比较图';
    if (/(?:setting|scenario|dataset|sample|example|condition|setup)/i.test(text)) {
        return '论文实验设置与数据关系示意图';
    }
    return '论文实现细节示意图';
}

// 保留这段代码只是为了还能重新核对已经写好的 v3 配置。新的 v4 配置必须带上
// 明确、与上下文绑定的 imageInsertions，不会走到这个分支。
function buildLegacyV3ManualImagePlan(analysis, imageInfos, maxInsertions = 3) {
    const anchors = require('../../scripts/deep-analyzer.js').buildImageAnchorCatalog(analysis);
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
        throw new Error('Manual v4 的图片、插图计划、插入检查结果和最终正文中的图片数量必须一致。');
    }

    const preparedByUrl = new Map(preparedImages.map(info => [info.url, info]));
    const planByUrl = new Map(configuredImageUrls.map((url, index) => [url, insertionPlan[index]]));
    const diagnosticByImageNumber = new Map(
        insertionDiagnostics.map(item => [item.imageNumber, item])
    );
    if (preparedByUrl.size !== expectedCount || planByUrl.size !== expectedCount
        || diagnosticByImageNumber.size !== expectedCount
        || new Set(orderedSelectedImageUrls).size !== expectedCount) {
        throw new Error('Manual v4 的图片网址或插图编号重复，无法将每张图片与其插图计划一一对应。');
    }

    const selectedImages = [];
    const orderedInsertionPlan = [];
    const orderedInsertionDiagnostics = [];
    for (const [index, url] of orderedSelectedImageUrls.entries()) {
        const prepared = preparedByUrl.get(url);
        const plan = planByUrl.get(url);
        const diagnostic = plan && diagnosticByImageNumber.get(plan.imageNumber);
        if (!prepared || !plan || !diagnostic || diagnostic.inserted !== true) {
            throw new Error(`Manual v4 正文中的图片缺少对应的已下载图片、插图计划或成功插入记录：${url}`);
        }
        const imageNumber = index + 1;
        selectedImages.push(prepared);
        // 保存下来的插图计划会用来重建并检查读者文章。把每张选中的图对应的
        // URL 留在它自己的计划条目上，检查时才能找到那张图。
        orderedInsertionPlan.push({ ...plan, imageNumber, url });
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
    const isManualV6 = manualDepthContractVersion === MANUAL_DEPTH_V6;
    const validationDepthContractVersion = isManualV6
        ? MANUAL_DEPTH_CONTRACT_VERSION_V5
        : manualDepthContractVersion;
    const isManualV4 = [MANUAL_DEPTH_CONTRACT_VERSION_V4, MANUAL_DEPTH_CONTRACT_VERSION_V5, MANUAL_DEPTH_V6]
        .includes(manualDepthContractVersion);
    const isManualV5 = manualDepthContractVersion === MANUAL_DEPTH_CONTRACT_VERSION_V5;
    const isManualV5Plus = isManualV5 || isManualV6;
    const signedV6CompatibilityOverride = isManualV6
        && spec.v5BridgeMode === 'signed-v6-task-evidence-override-v1';
    const experimentTableContractVersion = isManualV4
        ? EXPERIMENT_TABLE_CONTRACT_VERSION
        : EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION;
    const promptBindings = typeof promptInput === 'string'
        ? Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage, {
            source: stage === 'primaryAnalysis' ? 'prompts/deep-analysis.md' : `manual-stage-contract:${stage}:legacy-test`,
            sha256: stage === 'primaryAnalysis' ? promptInput : manualSha256({ stage, promptInput })
        }]))
        : promptInput;
    const promptSha256 = promptBindings.primaryAnalysis.sha256;
    if (!spec || typeof spec !== 'object') throw new Error(`${normalizedId(paper)} 的人工分析配置缺失或不是对象。`);
    if (typeof spec.analysis !== 'string' || !spec.analysis.trim()) throw new Error(`${normalizedId(paper)} 的分析正文缺失、不是字符串或为空白。`);
    const sourcePath = path.resolve(PROJECT_ROOT, String(spec.fullTextPath || ''));
    const tempRoot = fs.realpathSync(os.tmpdir());
    const resolvedSourcePath = fs.existsSync(sourcePath) ? fs.realpathSync(sourcePath) : sourcePath;
    if (!resolvedSourcePath.startsWith(`${PROJECT_ROOT}${path.sep}`)
        && !resolvedSourcePath.startsWith(`${tempRoot}${path.sep}`)
        && !resolvedSourcePath.startsWith('/private/tmp/')) {
        throw new Error(`${normalizedId(paper)} 的全文文件必须位于项目目录或允许的临时目录中。`);
    }
    if (!fs.existsSync(sourcePath)) throw new Error(`${normalizedId(paper)} 的全文文件不存在：${sourcePath}`);
    const sourceBuffer = fs.readFileSync(sourcePath);
    const sourceText = sourceBuffer.toString('utf8');
    if (sourceText.length < 1000) throw new Error(`${normalizedId(paper)} 的全文不足 1000 个字符，不能据此生成完整全文分析记录。`);
    const sourceSha256 = sha256Buffer(sourceBuffer);
    if (spec.sourceSha256 && spec.sourceSha256 !== sourceSha256) {
        throw new Error(`${normalizedId(paper)} 配置中的 sourceSha256 与全文文件内容的 SHA 不一致。`);
    }
    let freshAuthoring = null;
    let tutorialPayload = null;
    let paperSourceIdentity = null;
    if (isManualV5) {
        const provenance = options.manualProvenance || {};
        const authority = provenance.freshAuthority || {};
        const artifact = resolveArtifactAuthority(authority.artifactManifestPath, {
            date,
            paperId: normalizedId(paper),
            filteredBatchSha256: spec.filteredBatchSha256,
            sourceSha256: spec.sourceSha256,
            sourceIdentitySha256: spec.sourceIdentitySha256,
            paperInputSha256: spec.paperInputSha256
        });
        if (spec.paperSourceIdentity?.contract !== MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT) {
            throw new Error(`${normalizedId(paper)} 的配置缺少有效的逐篇论文来源记录。`);
        }
        paperSourceIdentity = validateManualPaperSourceIdentity(spec.paperSourceIdentity, {
            date,
            paperId: normalizedId(paper),
            fullTextEntry: {
                status: 'complete',
                requestedArxivId: spec.requestedArxivId,
                path: spec.fullTextPath,
                sourceSha256: spec.sourceSha256,
                sourceIdentitySha256: spec.sourceIdentitySha256,
                paperMetadataSha256: spec.paperMetadataSha256,
                paperInputSha256: spec.paperInputSha256,
                bytes: sourceBuffer.length,
                imageInfos: spec.imageInfos,
                structuredArtifactsSnapshot: {
                    healthStatus: 'complete',
                    payloadSha256: artifact.entry.structuredArtifactsSha256
                }
            },
            artifactEntry: artifact.entry
        });
        freshAuthoring = validateFreshAuthoringReceipt(spec.freshAuthoring, {
            paperId: normalizedId(paper),
            articlePath: defaultArticlePath(authority.currentRoot, date, normalizedId(paper)),
            readerArticle: spec.readerArticle,
            authorityPaths: {
                filteredPath: authority.filteredPath,
                sourcePath,
                artifactPath: artifact.path,
                authoringPromptPath: FRESH_AUTHORING_PROMPT_PATH,
                editorialContractPath: EDITORIAL_CONTRACT_PATH,
                blankSchemaPath: BLANK_SCHEMA_PATH,
                ...(() => {
                    const evidencePath = path.join(
                        authority.currentRoot, 'manual-full-text', date, 'external-evidence',
                        `${normalizedId(paper)}-official-project.json`
                    );
                    return fs.existsSync(evidencePath)
                        ? { officialProjectEvidencePath: evidencePath }
                        : {};
                })()
            }
        });
        const payloadMarker = provenance.tutorialPayloadContract;
        if (payloadMarker !== undefined && payloadMarker !== null
            && payloadMarker !== MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT) {
            throw new Error(`${normalizedId(paper)} 的教程内容记录使用了不支持的格式标识。`);
        }
        if (payloadMarker === MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT) {
            const tutorialPaths = defaultTutorialPayloadPaths(
                authority.currentRoot, date, normalizedId(paper)
            );
            tutorialPayload = validateTutorialPayloadReceipt(spec.tutorialPayload, {
                date,
                paperId: normalizedId(paper),
                currentRoot: authority.currentRoot,
                qualityPath: tutorialPaths.qualityPath,
                artifactPlanPath: tutorialPaths.artifactPlanPath,
                article: spec.readerArticle,
                articleFileSha256: freshAuthoring.articleFileSha256,
                freshAuthoring,
                artifactIndex: artifact.index
            });
        }
    }
    const parsed = parseAnalysis(spec.analysis);
    const invalidReason = signedV6CompatibilityOverride ? null : getInvalidAnalysisReason(spec.analysis, parsed, {
        enforceExperimentTableContract: true,
        experimentTableContractVersion,
        enforceMethodDetailContract: true,
        enforceManualDepthContract: true,
        manualDepthContractVersion: validationDepthContractVersion,
        sourceText,
        researchBrief: spec.researchBrief,
        openSourceEvidence: spec.openSourceEvidence,
        resultClaims: spec.resultClaims,
        evidenceLedger: spec.evidenceLedger
    });
    if (invalidReason) throw new Error(`${normalizedId(paper)} 的分析正文未通过检查：${invalidReason}`);
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
        throw new Error(`${normalizedId(paper)} 选择的以下图片未通过安全下载检查：${unavailableRequested.join(', ')}`);
    }
    const configuredImagePlan = Array.isArray(spec.imageInsertions) ? spec.imageInsertions : [];
    if (isManualV4 && configuredImagePlan.length !== configuredImageUrls.length) {
        throw new Error(`${normalizedId(paper)} 选择的每张图片都必须有一条对应的人工插图说明。`);
    }
    const manualImagePlan = isManualV4
        ? configuredImagePlan.map((item, index) => ({
            imageNumber: index + 1,
            ...(item.section ? { section: item.section } : {}),
            ...((item.paragraphId || item.paragraph_id)
                ? { paragraphId: item.paragraphId || item.paragraph_id } : {}),
            ...((item.conclusionParagraphId || item.conclusion_paragraph_id)
                ? { conclusionParagraphId: item.conclusionParagraphId || item.conclusion_paragraph_id } : {}),
            lead: item.lead,
            explanation: item.explanation
        }))
        : buildLegacyV3ManualImagePlan(
            spec.analysis,
            selectedPreparedImages,
            Math.min(3, Config.ANALYSIS_CONFIG.imageInsertionMax || 3)
        );
    const readerImagesPreembedded = isManualV6 && spec.readerImagesPreembedded === true;
    const imageInsertion = readerImagesPreembedded
        ? {
            analysis: spec.analysis,
            selectedImageUrls: [...configuredImageUrls],
            insertionDiagnostics: manualImagePlan.map((plan, index) => ({
                imageNumber: index + 1,
                section: plan.section || null,
                paragraphId: plan.paragraphId || null,
                inserted: true,
                preembeddedReaderArticle: true
            }))
        }
        : applyImageInsertionPlan(
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
        throw new Error(`${normalizedId(paper)} 的图片未全部按人工说明插入正文：${reasons || 'selected_count_mismatch'}`);
    }
    const finalAnalysis = normalizeExperimentTableNumericFormatting(imageInsertion.analysis);
    const finalParsed = parseAnalysis(finalAnalysis);
    const finalInvalidReason = signedV6CompatibilityOverride ? null : getInvalidAnalysisReason(finalAnalysis, finalParsed, {
        enforceExperimentTableContract: true,
        experimentTableContractVersion,
        enforceMethodDetailContract: true,
        enforceManualDepthContract: true,
        manualDepthContractVersion: validationDepthContractVersion,
        sourceText,
        researchBrief: spec.researchBrief,
        openSourceEvidence: spec.openSourceEvidence,
        resultClaims: spec.resultClaims,
        evidenceLedger: spec.evidenceLedger
    });
    if (finalInvalidReason) throw new Error(`${normalizedId(paper)} 插入图片后的分析正文未通过检查：${finalInvalidReason}`);
    const manualDepthIssue = signedV6CompatibilityOverride ? null : validateManualDepthContract(finalAnalysis, {
        sourceText,
        manualDepthContractVersion: validationDepthContractVersion,
        researchBrief: spec.researchBrief,
        openSourceEvidence: spec.openSourceEvidence
    });
    if (manualDepthIssue) throw new Error(`${normalizedId(paper)} 的人工分析未达到规定的内容深度：${manualDepthIssue}`);
    const editorialQuality = validateEditorialQuality(finalAnalysis);
    if (isManualV4 && !editorialQuality.valid && !signedV6CompatibilityOverride) {
        throw new Error(`${normalizedId(paper)} 的 Manual v4 正文未通过文本质量检查：${editorialQuality.issues.slice(0, 8).map(item => item.code).join(', ')}`);
    }
    const resultClaims = Array.isArray(spec.resultClaims) ? spec.resultClaims : [];
    const resultClaimsValidation = validateResultClaims(resultClaims, sourceText, {
        documentType: finalParsed.documentType,
        exception: spec.resultClaimsException,
        readerResultsText: finalParsed.results || ''
    });
    if (isManualV4 && !resultClaimsValidation.valid && !signedV6CompatibilityOverride) {
        throw new Error(`${normalizedId(paper)} 的 Manual v4 结果声明未通过检查：${resultClaimsValidation.errors.join('；')}`);
    }
    const signedV6ReaderArticle = signedV6CompatibilityOverride
        ? spec.readerLongform.blocks.map(block => `### ${block.heading}\n\n${block.markdown}`).join('\n\n')
        : null;
    const readerArticle = signedV6ReaderArticle || (isManualV5Plus && spec.researchBrief?.editorialPlan?.version === 2
        ? validateManualTutorialReaderBundle(spec.researchBrief.editorialPlan, spec.readerArticle, spec.evidenceLedger, {
            label: `${normalizedId(paper)}.readerArticle`, sourceText,
            externalEvidence: spec.openSourceEvidence?.sourceQuotes || [],
            boundEvidence: [
                ...resultClaims.map(claim => claim.sourceQuote),
                ...spec.evidenceLedger.map(item => item.sourceQuote)
            ],
            derivedFacts: spec.researchBrief.derivedFacts || [],
            readerNarratives: resultClaims.map(claim => claim.readerNarrative),
            imageInsertions: spec.imageInsertions || [],
            summary: extractSection(finalAnalysis, '核心摘要'),
            ...(isManualV6 ? {
                longformBundle: spec.readerLongform,
                artifactIndex: spec.artifactIndex,
                paperId: normalizedId(paper)
            } : {})
        })
        : null);
    const editorialReview = readerArticle && !signedV6CompatibilityOverride
        ? validateEditorialReview(spec.editorialReview, readerArticle, {
            label: `${normalizedId(paper)}.editorialReview`
        })
        : null;
    const readability = validateReadabilityRubric(spec.readabilityRubric);
    if (isManualV4 && (!readability.valid || !readability.passing)) {
        throw new Error(`${normalizedId(paper)} 的 Manual v4 可读性检查未通过：${readability.errors.join('；') || `total=${readability.total}`}`);
    }
    const analysisSha256 = manualTextSha256(finalAnalysis);
    const audit = spec.manualAudit;
    if (!audit || typeof audit !== 'object' || audit.version !== 1) {
        throw new Error(`${normalizedId(paper)} 的人工审查记录缺失、格式无效或版本不是 v1。`);
    }
    if (!Array.isArray(audit.passes) || audit.attempts !== audit.passes.length) {
        throw new Error(`${normalizedId(paper)} 的人工审查 passes 必须是数组，attempts 必须等于该数组记录的实际审查次数。`);
    }
    const auditSha256 = manualSha256(audit);
    const evidenceLedger = spec.evidenceLedger;
    const imageInfos = Array.isArray(spec.imageInfos) ? spec.imageInfos : [];
    const imageUrls = imageInfos.map(info => info.url);
    const selectedRequested = configuredImageUrls;
    const insertedUrlSet = new Set(imageInsertion.selectedImageUrls);
    const legacySelectedImages = preparedImages.filter(info => insertedUrlSet.has(info.url));
    const imageInsertionArtifacts = isManualV4
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
    const selectedImages = imageInsertionArtifacts.selectedImages;
    const preparedByUrl = new Map(preparedImages.map(info => [info.url, info]));
    const figureDecisionByUrl = new Map(
        (spec.figureReview?.decisions || []).map(item => [item.url, item])
    );
    const allCandidateEvidence = imageInfos.map((info, index) => {
        const prepared = preparedByUrl.get(info.url) || {};
        const decision = figureDecisionByUrl.get(info.url);
        return {
            url: info.url,
            caption: info.caption || '',
            source: info.source || null,
            sourceOrder: info.sourceOrder ?? index,
            candidateScore: info.candidateScore ?? null,
            mime: prepared.mime,
            sha256: prepared.sha256,
            bytes: prepared.bytes,
            ...(decision ? {
                reviewDecision: decision.decision,
                reviewReason: decision.reason,
                figureNumber: decision.figureNumber,
                visibleFacts: decision.visibleFacts || [],
                renderPlan: decision.renderPlan || null
            } : {})
        };
    });
    const imageDownloadEvidenceSha256 = manualSha256({
        candidates: allCandidateEvidence,
        outcomes: Array.isArray(options.imageDownloadOutcomes) ? options.imageDownloadOutcomes : []
    });
    const normalizedSelectedEvidence = selectedImages.map(info => {
        const decision = figureDecisionByUrl.get(info.url);
        return {
            url: info.url, caption: info.caption || '', source: info.source || null,
            sourceOrder: info.sourceOrder ?? null, candidateScore: info.candidateScore ?? null,
            mime: info.mime, sha256: info.sha256, bytes: info.bytes,
            ...(isManualV5Plus ? {
                reviewDecision: decision?.decision || null,
                reviewReason: decision?.reason || null,
                figureNumber: decision?.figureNumber || null,
                visibleFacts: decision?.visibleFacts || [],
                renderPlan: decision?.renderPlan || null
            } : {})
        };
    });
    const imageSelectionEvidenceSha256 = manualSha256({
        selected: normalizedSelectedEvidence,
        insertionPlan: imageInsertionArtifacts.insertionPlan,
        insertionDiagnostics: imageInsertionArtifacts.insertionDiagnostics
    });
    const stageContextSha256 = {
        imageDownload: imageDownloadEvidenceSha256,
        imageSupplement: imageSelectionEvidenceSha256
    };
    let manualV6Provenance = null;
    if (isManualV6) {
        if (spec.manualDepth !== MANUAL_DEPTH_V6
            || ![MANUAL_V6_RUNTIME_MODE_PRODUCTION, MANUAL_V6_RUNTIME_MODE_SHADOW].includes(spec.runtimeMode)
            || options.manualProvenance?.runtimeMode !== spec.runtimeMode
            || spec.readerLongform?.contract !== 'reader-longform-v2'
            || !spec.taskEvidence?.taskNames
            || spec.artifactIndex?.outputSha256 !== spec.recordProvenance?.artifactIndexSha256
            || manualV6StableSha256(spec.readerLongform) !== spec.recordProvenance?.readerLongformSha256) {
            throw new Error(`${normalizedId(paper)} 的人工分析 v6 深度版本、运行模式、正文格式或任务记录不符合要求，或正文及内容索引的 SHA 与对应记录不一致。`);
        }
        manualV6Provenance = {
            specVersion: MANUAL_SPEC_VERSION_V6,
            runtimeMode: spec.runtimeMode,
            specRootSha256: options.manualProvenance?.specRootSha256,
            paperSpecSha256: spec.paperSpecSha256,
            sealedRecordSha256: spec.recordProvenance.sealedRecordSha256,
            recordFileSha256: spec.recordProvenance.recordFileSha256,
            artifactIndexSha256: spec.recordProvenance.artifactIndexSha256,
            artifactIndexFileSha256: spec.recordProvenance.artifactIndexFileSha256,
            recordsEnvelopeFileSha256: spec.recordProvenance.recordsEnvelopeFileSha256,
            taskEvidenceSha256: spec.recordProvenance.taskEvidenceSha256,
            readerLongformSha256: spec.recordProvenance.readerLongformSha256,
            readerLongformContract: spec.readerLongform.contract,
            readerLongformArticleSha256: spec.readerLongform.articleSha256,
            taskNames: spec.taskEvidence.taskNames
        };
        const taskNames = manualV6Provenance.taskNames;
        if (!taskNames || Object.keys(taskNames).length !== 4
            || new Set(Object.values(taskNames)).size !== 4
            || taskNames.author !== spec.readerLongform.authorReceipt?.taskName
            || taskNames.authorRevision !== spec.readerLongform.finalRevisionAuthorReceipt?.taskName) {
            throw new Error(`${normalizedId(paper)} 的人工分析 v6 必须完整记录四项不同的任务名称，且写稿与修订任务名必须与正文的作者记录一致。`);
        }
        if (Object.entries(manualV6Provenance).some(([key, value]) => (
            key.endsWith('Sha256') && !/^[a-f0-9]{64}$/.test(String(value || ''))
        ))) {
            throw new Error(`${normalizedId(paper)} 的人工分析 v6 对应记录中的 SHA-256 缺失或格式无效。`);
        }
    }
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
        ...(isManualV5Plus ? {
            researchBrief: spec.researchBrief,
            researchBriefSha256: manualSha256(spec.researchBrief),
            ...(readerArticle ? {
                readerArticle,
                readerArticleSha256: manualTextSha256(readerArticle),
                editorialReview,
                editorialReviewSha256: manualTextSha256(editorialReview)
            } : {}),
            stageReviews: { version: 2, stages: spec.stageReviews },
            stageReviewsSha256: manualSha256({ version: 2, stages: spec.stageReviews }),
            scoringCalibration: spec.scoringCalibration,
            scoringCalibrationSha256: manualSha256(spec.scoringCalibration),
            openSourceEvidence: spec.openSourceEvidence,
            openSourceEvidenceSha256: manualSha256(spec.openSourceEvidence),
            figureReview: spec.figureReview,
            figureReviewSha256: manualSha256(spec.figureReview),
            externalResourceVerification: options.externalResourceVerification,
            externalResourceVerificationSha256: manualSha256(options.externalResourceVerification)
        } : {}),
        ...(isManualV5 ? {
            freshAuthoring,
            freshAuthoringSha256: manualSha256(freshAuthoring),
            ...(tutorialPayload ? {
                tutorialPayload,
                tutorialPayloadSha256: manualSha256(tutorialPayload)
            } : {})
        } : {}),
        ...(isManualV6 ? { v6Provenance: manualV6Provenance } : {}),
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
            } : {}),
            ...(isManualV5Plus ? {
                researcherFocus: MANUAL_RESEARCH_CONTRACT_VERSION,
                perPaperSubagent: 'isolated-single-paper-v1',
                ...(isManualV5 ? {
                    freshAuthoring: FRESH_AUTHORING_CONTRACT,
                    paperSourceIdentity: MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT
                } : {}),
                ...(tutorialPayload ? {
                    tutorialPayload: MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
                    tutorialQuality: tutorialPayload.qualityContract,
                    tutorialArtifactPlan: `tutorial-artifact-plan-v${TUTORIAL_ARTIFACT_PLAN_VERSION}`
                } : {}),
                ...(isManualV6 ? {
                    readerLongform: spec.readerLongform.contract,
                    artifactIndex: spec.artifactIndex.parserVersion,
                    manualV6Runtime: spec.runtimeMode,
                    authorLineage: MANUAL_V6_AUTHOR_LINEAGE_CONTRACT
                } : {})
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
            ...(isManualV4 ? {
                manualSpecVersion: options.manualProvenance?.specVersion || null,
                requestedArxivId: spec.requestedArxivId,
                fullTextPath: resolvedSourcePath,
                sourceIdentitySha256: spec.sourceIdentitySha256,
                paperMetadataSha256: spec.paperMetadataSha256,
                paperInputSha256: spec.paperInputSha256,
                filteredBatchSha256: spec.filteredBatchSha256,
                ...(!isManualV5 ? {
                    fullTextManifestSha256: options.manualProvenance?.fullTextManifestSha256 || null
                } : {
                    paperSourceIdentity
                }),
                recordsSourcesSha256: options.manualProvenance?.recordsSourcesSha256 || null,
                imageInfosSha256: manualSha256(spec.imageInfos || [])
            } : {}),
            ...(isManualV6 ? {
                manualV6Runtime: manualV6Provenance.runtimeMode,
                specRootSha256: manualV6Provenance.specRootSha256,
                paperSpecSha256: manualV6Provenance.paperSpecSha256,
                sealedRecordSha256: manualV6Provenance.sealedRecordSha256,
                recordFileSha256: manualV6Provenance.recordFileSha256,
                artifactIndexSha256: manualV6Provenance.artifactIndexSha256,
                artifactIndexFileSha256: manualV6Provenance.artifactIndexFileSha256,
                recordsEnvelopeFileSha256: manualV6Provenance.recordsEnvelopeFileSha256,
                taskEvidenceSha256: manualV6Provenance.taskEvidenceSha256,
                readerLongformSha256: manualV6Provenance.readerLongformSha256,
                readerLongformArticleSha256: manualV6Provenance.readerLongformArticleSha256
            } : {}),
            warnings: ['manual_offline_no_llm_api']
        },
        stages,
        manualTakeover: takeover
    };
    const imageManifest = {
        version: 2,
        source: imageInfos.length > 0 ? 'manual_full_text_html' : 'manual_no_image_metadata',
        totalFound: imageInfos.length,
        candidates: allCandidateEvidence.map((info, index) => ({
            index: index + 1,
            ...info
        })),
        downloaded: preparedImages.map(info => ({ ...info })),
        downloadOutcomes: Array.isArray(options.imageDownloadOutcomes) ? options.imageDownloadOutcomes : [],
        downloadEvidenceSha256: imageDownloadEvidenceSha256,
        selectionEvidenceSha256: imageSelectionEvidenceSha256,
        insertionPlan: imageInsertionArtifacts.insertionPlan,
        insertionDiagnostics: imageInsertionArtifacts.insertionDiagnostics,
        selected: selectedImages.map((info, index) => ({
            index: index + 1,
            ...info,
            ...(isManualV5Plus ? (() => {
                const decision = figureDecisionByUrl.get(info.url);
                return {
                    reviewDecision: decision?.decision || null,
                    reviewReason: decision?.reason || null,
                    figureNumber: decision?.figureNumber || null,
                    visibleFacts: decision?.visibleFacts || [],
                    renderPlan: decision?.renderPlan || null
                };
            })() : {}),
            selectionReason: selectedRequested.length > 0
                ? 'manual_explicit_secure_figure_review_and_context_bound_plan'
                : 'manual_no_selected_images'
        }))
    };
    const compatibilityManifest = isManualV6
        ? {
            ...analysisManifest,
            contracts: { ...analysisManifest.contracts, manualDepth: MANUAL_DEPTH_CONTRACT_VERSION_V5 }
        }
        : analysisManifest;
    const manifestIssue = signedV6CompatibilityOverride ? null : validateManualTakeoverManifest(compatibilityManifest, sourceSha256, {
        analysis: finalAnalysis,
        sourceText,
        imageManifest,
        ...(isManualV6 ? {
            readerLongform: spec.readerLongform,
            artifactIndex: spec.artifactIndex,
            runtimeMode: spec.runtimeMode
        } : {})
    });
    if (manifestIssue) throw new Error(`${normalizedId(paper)} 的人工分析记录未通过来源和阶段检查：${manifestIssue}`);
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
        ...(isManualV6 ? {
            manualDepth: MANUAL_DEPTH_V6,
            manualArtifactIndex: spec.artifactIndex,
            manualReaderLongform: spec.readerLongform,
            manualV6Provenance
        } : {}),
        ...(isManualV4 ? {
            manualReadabilityRubric: spec.readabilityRubric,
            manualResultClaims: resultClaims,
            manualEditorialQualityMetrics: editorialQuality.metrics
        } : {}),
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
    if (requestedUrls) {
        const reviewByUrl = new Map(
            (spec.figureReview?.decisions || []).map(item => [item.url, item])
        );
        for (const candidate of imageInfos) {
            if (requestedUrls.has(candidate.url)) continue;
            const review = reviewByUrl.get(candidate.url);
            imageDownloadOutcomes.push({
                url: candidate.url,
                status: 'manual_rejected',
                reason: review?.reason || 'not_selected_by_manual_figure_review'
            });
        }
    }
    return { preparedImages, imageDownloadOutcomes };
}

async function verifyManualExternalResources(spec) {
    const evidence = spec?.openSourceEvidence;
    if (!evidence || typeof evidence !== 'object') {
        return { version: 1, state: 'missing', checkedAt: getBeijingISOString(), outcomes: [] };
    }
    const urls = Array.isArray(evidence.urls) ? evidence.urls : [];
    const outcomes = [];
    for (const url of urls) {
        const cached = readCachedExternalResourceOutcome(url);
        if (cached) {
            outcomes.push(cached);
            continue;
        }
        let pending = externalResourceVerificationInFlight.get(url);
        if (!pending) {
            pending = verifyAndCacheExternalResource(url)
                .finally(() => externalResourceVerificationInFlight.delete(url));
            externalResourceVerificationInFlight.set(url, pending);
        }
        outcomes.push(await pending);
    }
    if (['released', 'demo_only'].includes(evidence.state)
        && outcomes.length !== urls.length) {
        throw new Error('Manual v5 已发布资源/Demo 未完成逐 URL 外部验证');
    }
    return {
        version: 1,
        state: evidence.state,
        checkedAt: outcomes.map(item => item.verifiedAt).filter(Boolean).sort().at(-1)
            || evidence.checkedAt
            || null,
        outcomes
    };
}

function externalResourceCacheKey(url) {
    return sha256Buffer(Buffer.from(String(url), 'utf8'));
}

function normalizeDiscoveredHttpsLinks(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(value => {
        const text = String(value || '').trim();
        if (/^https:\/\//i.test(text)) return text;
        if (/^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[^\s]*)?$/.test(text)) {
            return `https://${text}`;
        }
        return null;
    }).filter(Boolean))];
}

function readExternalResourceCache() {
    const cachePath = Config.FILES.manualExternalResourceCache;
    if (!cachePath || !fs.existsSync(cachePath)) {
        return { version: MANUAL_EXTERNAL_RESOURCE_CACHE_VERSION, entries: {} };
    }
    try {
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (cache?.version !== MANUAL_EXTERNAL_RESOURCE_CACHE_VERSION
            || !cache.entries || typeof cache.entries !== 'object' || Array.isArray(cache.entries)) {
            return { version: MANUAL_EXTERNAL_RESOURCE_CACHE_VERSION, entries: {} };
        }
        return cache;
    } catch (_error) {
        return { version: MANUAL_EXTERNAL_RESOURCE_CACHE_VERSION, entries: {} };
    }
}

function readCachedExternalResourceOutcome(url, nowMs = Date.now()) {
    const entry = readExternalResourceCache().entries[externalResourceCacheKey(url)];
    if (!entry || entry.url !== url || entry.status !== 'reachable_public_https') return null;
    const checkedAtMs = Date.parse(entry.checkedAt || '');
    if (!Number.isFinite(checkedAtMs)
        || checkedAtMs > nowMs
        || nowMs - checkedAtMs > MANUAL_EXTERNAL_RESOURCE_CACHE_TTL_MS) {
        return null;
    }
    return {
        url: entry.url,
        status: entry.status,
        finalUrl: entry.finalUrl,
        httpStatus: entry.httpStatus,
        discoveredLinks: normalizeDiscoveredHttpsLinks(entry.discoveredLinks),
        verifiedAt: entry.checkedAt
    };
}

function writeCachedExternalResourceOutcome(outcome, checkedAt = getBeijingISOString()) {
    const cachePath = Config.FILES.manualExternalResourceCache;
    const key = externalResourceCacheKey(outcome.url);
    updateJsonFileLocked(cachePath, current => {
        const entries = current?.version === MANUAL_EXTERNAL_RESOURCE_CACHE_VERSION
            && current.entries && typeof current.entries === 'object' && !Array.isArray(current.entries)
            ? current.entries
            : {};
        return {
            version: MANUAL_EXTERNAL_RESOURCE_CACHE_VERSION,
            entries: {
                ...entries,
                [key]: {
                    url: outcome.url,
                    status: outcome.status,
                    finalUrl: outcome.finalUrl,
                    httpStatus: outcome.httpStatus,
                    discoveredLinks: normalizeDiscoveredHttpsLinks(outcome.discoveredLinks),
                    checkedAt
                }
            }
        };
    });
}

async function verifyHuggingFaceResourceViaCurl(url) {
    const allProxy = String(process.env.ALL_PROXY || '').trim();
    if (!/^socks5h?:\/\//i.test(allProxy)) {
        const error = new Error('Hugging Face SOCKS 兜底要求项目 .env 配置 ALL_PROXY=socks5(h)://...');
        error.code = 'PROXY_CONFIG_ERROR';
        throw error;
    }
    let currentUrl = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
        const parsed = await validatePublicHttpUrl(currentUrl);
        const hostname = parsed.hostname.toLowerCase();
        if (hostname !== 'huggingface.co' && !hostname.endsWith('.huggingface.co')) {
            throw new Error(`Hugging Face SOCKS 兜底拒绝跨站重定向: ${hostname}`);
        }
        const childEnv = {
            PATH: process.env.PATH || '/usr/bin:/bin',
            ALL_PROXY: allProxy,
            NO_PROXY: ''
        };
        const { stdout } = await execFileAsync('curl', [
            '--silent', '--show-error', '--head', '--proto', '=https',
            '--max-redirs', '0', '--connect-timeout', '15',
            '--max-time', String(Math.ceil(MANUAL_EXTERNAL_RESOURCE_TIMEOUT_MS / 1000)),
            '--user-agent', 'paper-digest-manual-v6/1.0', currentUrl
        ], {
            encoding: 'utf8', env: childEnv,
            timeout: MANUAL_EXTERNAL_RESOURCE_TIMEOUT_MS + 5000,
            maxBuffer: 256 * 1024
        });
        const headerBlocks = stdout.split(/\r?\n\r?\n/)
            .map(block => block.trim()).filter(block => /^HTTP\//i.test(block));
        const header = headerBlocks.at(-1) || '';
        const status = Number((header.match(/^HTTP\/\S+\s+(\d{3})/i) || [])[1]);
        const location = (header.match(/^location:\s*(.+)$/im) || [])[1]?.trim();
        if (status >= 300 && status < 400 && location) {
            if (redirects >= 3) throw new Error(`外部资源重定向超过 3 次: ${url}`);
            currentUrl = new URL(location, parsed).href;
            continue;
        }
        if (status !== 200) throw new Error(`外部资源不可达: ${url} (HTTP ${status || 'unknown'})`);
        const checkedAt = getBeijingISOString();
        const outcome = {
            url, status: 'reachable_public_https', finalUrl: currentUrl,
            httpStatus: status, discoveredLinks: [], verifiedAt: checkedAt,
            transport: 'curl_socks_huggingface'
        };
        writeCachedExternalResourceOutcome(outcome, checkedAt);
        return outcome;
    }
    throw new Error(`Hugging Face 资源校验未收口: ${url}`);
}

async function verifyAndCacheExternalResource(url) {
    const initial = await validatePublicHttpUrl(url);
    const initialHostname = initial.hostname.toLowerCase();
    if (initialHostname === 'huggingface.co' || initialHostname.endsWith('.huggingface.co')) {
        return verifyHuggingFaceResourceViaCurl(url);
    }
    let currentUrl = url;
    let response = null;
    for (let redirects = 0; redirects <= 3; redirects++) {
        const parsed = await validatePublicHttpUrl(currentUrl);
        response = await requestPinnedPublicHttps(currentUrl, {
            headers: { 'User-Agent': 'paper-digest-manual-v6/1.0', Accept: 'text/html,text/plain,*/*' },
            timeoutMs: MANUAL_EXTERNAL_RESOURCE_TIMEOUT_MS,
            maxBytes: 1024 * 1024
        });
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
            if (redirects >= 3) throw new Error(`外部资源重定向超过 3 次: ${url}`);
            currentUrl = new URL(location, parsed).href;
            continue;
        }
        break;
    }
    if (!response || response.status !== 200) {
        throw new Error(`外部资源不可达: ${url} (HTTP ${response?.status || 'unknown'})`);
    }
    const discoveredLinks = normalizeDiscoveredHttpsLinks(
        await checkDemoPageForOpensource(url)
    );
    const checkedAt = getBeijingISOString();
    const outcome = {
        url,
        status: 'reachable_public_https',
        finalUrl: currentUrl,
        httpStatus: response.status,
        discoveredLinks,
        verifiedAt: checkedAt
    };
    writeCachedExternalResourceOutcome(outcome, checkedAt);
    return outcome;
}

async function runFixedWorkers(items, processItem, workerCount = MANUAL_ANALYSIS_WORKER_COUNT) {
    if (!Array.isArray(items)) throw new Error('待处理条目 items 必须是数组。');
    if (typeof processItem !== 'function') throw new Error('处理每个条目的 processItem 必须是函数。');
    if (!Number.isInteger(workerCount) || workerCount < 1) throw new Error('工作池的并发数量 workerCount 必须是正整数。');
    let nextIndex = 0;
    const workers = Array.from(
        { length: Math.min(workerCount, items.length) },
        async () => {
            while (true) {
                const index = nextIndex++;
                if (index >= items.length) return;
                await processItem(items[index], index);
            }
        }
    );
    await Promise.all(workers);
}

async function run() {
    const { date, spec: specPathArg, force, v6Production, v6Shadow } = parseArgs(process.argv.slice(2));
    const v6MetricStartedNs = (v6Production || v6Shadow) ? monotonicNs() : null;
    const specPath = path.resolve(PROJECT_ROOT, specPathArg);
    const specFileSha256 = sha256File(specPath);
    const spec = readJson(specPath, 'manual spec');
    if ((spec.version !== 3 && !CURRENT_MANUAL_SPEC_VERSIONS.has(spec.version)
        && spec.version !== MANUAL_SPEC_VERSION_V6)
        || spec.mode !== MANUAL_COMPLETE_STATUS) {
        throw new Error('人工分析配置只支持历史 v3、兼容 v4/v5，以及正式或影子模式的 v6，且 mode 必须为 manual_complete。');
    }
    assertExplicitManualV6Mode(spec, { v6Production, v6Shadow });
    if (spec.date !== date) throw new Error('人工分析配置中的日期与 --date 指定的日期不一致。');
    const v6RuntimeMode = v6Production
        ? MANUAL_V6_RUNTIME_MODE_PRODUCTION
        : (v6Shadow ? MANUAL_V6_RUNTIME_MODE_SHADOW : null);
    if (v6RuntimeMode) {
        const expectedSpecPath = resolveManualV6RuntimePaths(
            Config.CURRENT_DIR, date, v6RuntimeMode
        ).specPath;
        if (path.resolve(specPath) !== path.resolve(expectedSpecPath)
            || fs.lstatSync(specPath).isSymbolicLink()) {
            throw new Error(`人工分析 v6 配置必须使用 ${v6RuntimeMode} 模式下为该日期指定的文件路径，且该文件不能是符号链接。`);
        }
    }
    const verifiedAssemblyInputs = spec.version === MANUAL_SPEC_VERSION_V6
        ? validateManualV6AssemblyInputs(spec, { date, runtimeMode: v6RuntimeMode })
        : (CURRENT_MANUAL_SPEC_VERSIONS.has(spec.version)
            ? validateManualV4AssemblyInputs(spec, { date })
            : null);
    const analysisFilePath = v6RuntimeMode
        ? resolveManualV6RuntimePaths(Config.CURRENT_DIR, date, v6RuntimeMode).canonicalPath
        : Config.FILES.deepAnalysisResult;
    const currentPromptBindings = buildStagePromptBindings();
    const promptBindings = resolveManualSpecPromptBindings(spec, currentPromptBindings);
    const promptSha256 = promptBindings.primaryAnalysis.sha256;
    const papers = verifiedAssemblyInputs ? verifiedAssemblyInputs.filtered.papers : filteredPapersForDate(date);
    const specPapers = spec.papers;
    if (!specPapers || typeof specPapers !== 'object' || Array.isArray(specPapers)) {
        throw new Error('人工分析配置中的 papers 必须是对象，不能是数组。');
    }
    const expectedIds = new Set(papers.map(normalizedId));
    const suppliedKeys = Object.keys(specPapers);
    const suppliedIds = new Set(suppliedKeys.map(normalizedId));
    if (suppliedIds.size !== suppliedKeys.length || suppliedKeys.some(key => !normalizedId(key))) {
        throw new Error('人工分析配置中的论文 ID 在规范化后为空，或出现重复 ID。');
    }
    const missing = [...expectedIds].filter(id => !suppliedIds.has(id));
    const extra = [...suppliedIds].filter(id => !expectedIds.has(id));
    if (missing.length || extra.length) {
        throw new Error(`人工分析配置中的论文集合与筛选结果不一致：缺少 ${missing.join(',') || '-'}；多出 ${extra.join(',') || '-'}。`);
    }
    if (v6Production && !force) {
        const legacySuccessIds = papers.map(paper => {
            const current = loadStoredAnalysisRecord(analysisFilePath, paper);
            return current?.analysisStatus === 'success' && current.manualDepth !== MANUAL_DEPTH_V6
                ? normalizedId(paper)
                : null;
        }).filter(Boolean);
        if (legacySuccessIds.length) {
            throw new Error(`正式人工分析 v6 不能直接复用以下非 v6 成功记录；请先核对差异，再明确使用 --force：${legacySuccessIds.join(',')}`);
        }
    }
    const failures = new Map();
    let persisted = 0;
    let failedPersisted = 0;
    let skipped = 0;
    let successfulAttempts = 0;
    await runFixedWorkers(papers, async paper => {
        const id = normalizedId(paper);
        const paperSpec = specPapers[id] || specPapers[paper.arxivId];
        try {
            await withPaperAnalysisLock(paper, async () => {
                const storedAnalysisRecord = loadStoredAnalysisRecord(analysisFilePath, paper);
                const effectivePaper = {
                    ...paper,
                    ...(storedAnalysisRecord || {}),
                    ...(paperSpec.titleOverride ? { title: paperSpec.titleOverride } : {})
                };
                let record;
                let success = false;
                let imagePreparation = {};
                let externalResourceVerification = null;
                try {
                    imagePreparation = await prepareManualImages(paperSpec);
                    if (spec.version === 5 || spec.version === MANUAL_SPEC_VERSION_V6) {
                        externalResourceVerification = await verifyManualExternalResources(paperSpec);
                    }
                    const expectedRecord = buildManualRecord(
                        effectivePaper,
                        paperSpec,
                        date,
                        promptBindings,
                        {
                            ...imagePreparation,
                            externalResourceVerification,
                            manualDepthContractVersion: spec.version === MANUAL_SPEC_VERSION_V6
                                ? MANUAL_DEPTH_V6
                                : (spec.version === 5
                                    ? MANUAL_DEPTH_CONTRACT_VERSION_V5
                                : (spec.version === 4
                                    ? MANUAL_DEPTH_CONTRACT_VERSION_V4
                                    : MANUAL_DEPTH_CONTRACT_VERSION_V3)),
                            ...(verifiedAssemblyInputs ? {
                                manualProvenance: {
                                    specVersion: spec.version,
                                    fullTextManifestSha256: spec.fullTextManifest.sha256,
                                    recordsSourcesSha256: manualSha256(spec.recordsSources),
                                    ...(spec.version === 5 ? {
                                        tutorialPayloadContract: spec.tutorialPayloadContract || null,
                                        freshAuthority: {
                                            currentRoot: verifiedAssemblyInputs.currentRoot,
                                            filteredPath: verifiedAssemblyInputs.filteredPath,
                                            artifactManifestPath: verifiedAssemblyInputs.artifactManifestPath
                                        }
                                    } : {}),
                                    ...(spec.version === MANUAL_SPEC_VERSION_V6
                                        ? {
                                            specRootSha256: spec.rootSha256,
                                            runtimeMode: spec.runtimeMode
                                        }
                                        : {})
                                }
                            } : {})
                        }
                    );
                    const writeDecision = getManualAnalysisWriteDecision(
                        storedAnalysisRecord, expectedRecord, force,
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

                await mergeAndSaveResults([record], analysisFilePath, {
                    batchDate: date,
                    status: 'running',
                    stats: { analysisStatus: 'running', pipelineStatus: 'analysis_running' }
                });
                if (!v6Shadow) updateAnalysisDigestStatuses([record], { batchDate: date });
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
    });
    if (v6RuntimeMode) {
        if (sha256File(specPath) !== specFileSha256) {
            throw new Error('人工分析 v6 配置文件在处理期间发生变化；已保存的逐篇检查点会保留，本次不再更新最终批次状态。');
        }
        validateManualV6AssemblyInputs(spec, { date, runtimeMode: v6RuntimeMode });
    }
    const saved = finalizeManualAnalysisBatchState(analysisFilePath, {
        date,
        expectedIds: papers.map(normalizedId),
        ...(v6RuntimeMode ? { requiredManualV6Runtime: v6RuntimeMode } : {}),
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
    if (v6RuntimeMode) {
        persistStageMetricSafely({
            shadowRoot: v6RuntimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
                ? Config.FILES.manualV6Dir
                : Config.FILES.manualV6ShadowDir,
            containmentRoot: Config.CURRENT_DIR,
            date,
            stage: 'canonical_v6',
            status: saved.stats.failed > 0 ? 'partial_failed' : 'complete',
            wallNs: monotonicNs() - v6MetricStartedNs,
            wallAggregation: 'single_ingestion_run_wall',
            cache: { hits: skipped, misses: papers.length - skipped },
            paperCount: papers.length,
            taskCount: papers.length,
            inputFiles: [{ role: 'spec_v6', path: specPath }],
            outputFiles: [{
                role: v6RuntimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
                    ? 'production_canonical_v6'
                    : 'shadow_canonical_v6',
                path: analysisFilePath
            }]
        });
    }
    console.log(`人工离线分析记录共 ${saved.papers.length} 篇，本轮成功写入 ${persisted} 篇、保存失败检查点 ${failedPersisted} 篇、复用 ${skipped} 篇；当前批次成功 ${saved.stats.success} 篇、失败 ${saved.stats.failed} 篇，API 调用 0 次。`);
    if (saved.stats.failed > 0) {
        console.error(`当前批次仍有 ${saved.stats.failed} 篇人工分析失败：`);
        for (const id of saved.stats.failedIds) {
            console.error(`  - ${id}: ${failures.get(id) || '当前分析记录尚未通过成功条件检查'}`);
        }
        process.exitCode = 2;
    }
    console.log(`人工分析记录及全文、提示文件的对应信息已保存至：${analysisFilePath}`);
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
    getManualAnalysisReuseHash,
    getManualAnalysisWriteDecision,
    resolveManualSpecPromptBindings,
    loadFilteredBatchForDate,
    validateManualV4AssemblyInputs,
    validateManualV6AssemblyInputs,
    finalizeManualAnalysisBatchState,
    prepareManualImages,
    verifyManualExternalResources,
    readCachedExternalResourceOutcome,
    writeCachedExternalResourceOutcome,
    normalizeDiscoveredHttpsLinks,
    runFixedWorkers,
    filteredPapersForDate,
    parseArgs,
    assertExplicitManualV6Mode,
    canReuseSavedManualAnalysis,
    run
};

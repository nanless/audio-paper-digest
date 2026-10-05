'use strict';

// 标签记录更新测试的共享夹具：当前词表运行信息、按 SHA 命名的旧词表快照、
// 依据旧词表保存的规范分析记录。只读重放与 --apply 写入测试共用，
// 保证两边构造出的原记录字节完全一致。
//
// 只读取 config/ 下的真实词表与 config/tag-catalog-history/ 的按内容
// 字节 SHA 命名快照，不写任何配置文件。

const path = require('node:path');
const crypto = require('node:crypto');
const { validAnalysisText } = require('../valid-analysis-fixture.js');
const contract = require('../../scripts/analysis-contract.js');
const { parseAnalysis } = require('../../scripts/utils.js');
const { createTagRules, LEGACY_TAG_PROMPT_TEXT_CONTRACT, LEGACY_TAG_SELECTION_CONTRACT } = require('../../scripts/lib/tag-rules.js');
const registryChange = require('../../scripts/lib/tag-catalog-change.js');
const tagCatalogApi = require('../../scripts/lib/tag-catalog.js');
const resealApi = require('../../scripts/lib/tag-record-update.js');

const REGISTRY_FILE = path.resolve(__dirname, '../../config/tag-catalog.json');
const REGISTRY_HISTORY_DIR = path.resolve(__dirname, '../../config/tag-catalog-history');
const ADDITIVE_OLD_SHA = 'dcf83f84857d45d6a36ee20d9235d7566d9a3a53644ab442d8eb64b5e81a9adf';
const DESTRUCTIVE_OLD_SHA = '3f9a14c9d753716b428b8ca27a9d93b92b3ae93cfbffc1a24f60573ff8ef234a';
const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';
const PAPER_ID = 'conference:test:2026:paper-one';

const runtime = () => createTagRules({ registryPath: REGISTRY_FILE });
const textSha = value => crypto.createHash('sha256').update(value).digest('hex');

function annotationFor(fromRegistrySha256, options = {}) {
    const current = tagCatalogApi.loadTagCatalog(REGISTRY_FILE);
    const from = registryChange.resolveRegistrySnapshot(fromRegistrySha256);
    const { changeLevel, detail } = registryChange.classifyRegistryChange(from, current);
    // 换表（v1.1）后 dcf83f84→当前 的分级由 additive 变为可确认的 destructive；
    // happy-path 夹具的意图是“构造一份合法可放行的注记”，因此在调用方未显式指定时，
    // 对落在可确认白名单内的 destructive 自动携带 ack。显式传
    // acknowledgeDestructive:false 的用例仍按原样被拒（用于验证无 ack 失败路径）。
    const eligible = changeLevel === 'destructive'
        && registryChange.canAcknowledgeRegistryChange(detail) === true;
    const acknowledge = options.acknowledgeDestructive === undefined
        ? eligible : options.acknowledgeDestructive === true;
    return registryChange.buildRegistryUpgradeAnnotation({
        from, to: current, changeLevel, detail,
        note: `确定性重投影，升级自 ${fromRegistrySha256.slice(0, 8)}`,
        acknowledgeDestructive: acknowledge,
        acknowledgementNote: options.acknowledgementNote ?? null });
}

// 构造一份“旧 registry 下封口”的 canonical analysis 记录。
function analysisRecord(options = {}) {
    const current = runtime();
    const text = options.analysis ?? validAnalysisText();
    const parsed = parseAnalysis(text, { tagRules: current });
    const registrySha256 = options.registrySha256 ?? current.registrySha256;
    const projectionSha256 = options.projectionSha256 ?? current.projectionSha256;
    const priorCatalog = registrySha256 !== current.registrySha256
        ? registryChange.resolveRegistrySnapshot(registrySha256) : null;
    const registryVersion = options.registryVersion ?? priorCatalog?.version ?? current.registryVersion;
    const binding = {
        registryVersion,
        registrySha256,
        projectionContract: options.projectionContract ?? (registrySha256 !== current.registrySha256
            ? LEGACY_TAG_PROMPT_TEXT_CONTRACT : current.projectionContract),
        projectionSha256,
        selectionContract: options.selectionContract ?? LEGACY_TAG_SELECTION_CONTRACT,
        inputAnalysisSha256: textSha(text),
        outputAnalysisSha256: textSha(text),
        inputProtectedProjectionSha256: textSha(contract.maskClassificationFields(text)),
        outputProtectedProjectionSha256: textSha(contract.maskClassificationFields(text)),
        taxonomySurfaceSha256: contract.hashTagSectionAndPrimaryTags(text),
        primaryTaskId: parsed.tagValidation.primaryTaskId,
        primaryMethodId: parsed.tagValidation.primaryMethodId,
        conceptIds: parsed.tagValidation.conceptIds
    };
    const stage = { status: 'not_needed', ...binding, bindingSha256: contract.manualSha256(binding) };
    if (options.annotation) stage.registryUpgradeFrom = options.annotation;
    // 保留旧字段的缓存种子：词表 SHA 与原阶段记录一致。
    const cachedParsed = Object.fromEntries(Object.entries(parsed).map(([key, value]) =>
        key === 'tagValidation' ? ['taxonomyValidation', { ...value, registryVersion, registrySha256 }] : [key, value]));
    const paper = {
        id: options.paperId ?? PAPER_ID,
        analysis: text,
        parsed: cachedParsed,
        analysisStageCheckpoints: { taxonomySeal: text },
        analysisManifest: {
            contracts: { taxonomy: options.selectionContract ?? LEGACY_TAG_SELECTION_CONTRACT },
            stages: {
                structureRepair: { outputAnalysisSha256: binding.inputAnalysisSha256 },
                taxonomySeal: stage,
                coreSummaryRepair: { inputAnalysisSha256: binding.outputAnalysisSha256 }
            }
        }
    };
    const record = {
        contract: 'conference-analysis-canonical-v1',
        version: 1,
        executionId: options.executionId ?? EXECUTION_ID,
        paperId: options.paperId ?? PAPER_ID,
        status: 'complete',
        papers: [paper]
    };
    if (options.completedAt) record.completedAt = options.completedAt;
    return record;
}

function reproject(options = {}) {
    return resealApi.reprojectAnalysis({
        analysis: options.analysis || analysisRecord(options),
        runtime: options.tagRules || runtime(),
        mode: options.mode || 'reproject',
        snapshotOptions: options.snapshotOptions || {},
        acknowledgeDestructive: options.acknowledgeDestructive === true,
        acknowledgementNote: options.acknowledgementNote ?? null
    });
}

module.exports = {
    REGISTRY_FILE,
    REGISTRY_HISTORY_DIR,
    ADDITIVE_OLD_SHA,
    DESTRUCTIVE_OLD_SHA,
    EXECUTION_ID,
    PAPER_ID,
    runtime,
    textSha,
    annotationFor,
    analysisRecord,
    reproject
};

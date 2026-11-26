'use strict';

/**
 * Deterministic Cross-Stage Consistency Gate:
 * Verifies alignment across:
 *   1. Core Summary (`## 核心摘要`) & Machine Summary (`## 机器摘要`) & Open Source Details (`## 开源详情`)
 *   2. API Reader Article (`apiReaderArticle`) & Plan (`sections`, `implementationSpecs`)
 *
 * Four high-precision, zero-false-positive checks:
 *   - `cross_stage_opensource_contradiction`: open-source code/model/dataset availability contradictions
 *   - `cross_stage_dangling_guide_target`: Core Summary deep-read guide pointing to retired/non-existent sections
 *   - `cross_stage_terminology_drift`: conflicting Chinese translations of the same term across Core Summary & Reader
 *   - `cross_stage_metric_scale_drift`: 100x decimal-vs-percentage contradictions on percentage-convertible metrics
 */

const RETIRED_GUIDE_HEADINGS = [
    { token: '毒舌点评', reason: '已更名为「论文评价」' },
    { token: '实验设置小节', kindRequired: 'experiment_setup', reason: '当前长文未单设 experiment_setup 小节' },
    { token: '背景小节', kindRequired: 'background', reason: '当前长文未单设 background 小节' },
    { token: '相关工作小节', kindRequired: 'related_work', reason: '当前长文未单设 related_work 小节' }
];

// Generic topic labels Core Summary may use to refer to corresponding Reader section kinds
const GENERIC_GUIDE_TOPIC_KINDS = [
    { re: /^(?:问题|问题背景|问题定义|核心问题|问题与瓶颈)$/, kinds: ['problem', 'background'] },
    { re: /^(?:方法|方法概述|方法架构|核心架构|架构设计|方法细节|方法概述和架构|模型架构)$/, kinds: ['method_overview', 'component'] },
    { re: /^(?:训练|训练细节|训练目标|训练与优化)$/, kinds: ['training', 'method_overview', 'component'] },
    { re: /^(?:实验|实验结果|主实验|主实验结果|实验对比|评测结果)$/, kinds: ['result'] },
    { re: /^(?:消融|消融分析|消融实验|失败案例|失效分析)$/, kinds: ['ablation', 'result'] },
    { re: /^(?:局限|局限与问题|局限分析|适用边界|工程选型|复现细节|总结与选型|结论)$/, kinds: ['limitation', 'synthesis', 'reproduction'] }
];

// Strictly percentage-convertible metrics only (0..1 decimal vs 0..100% percentage).
// Non-percentage metrics (FAD, RTF, PESQ, MOS, UTMOS, ViSQOL, SI-SDR, LSD, MCD, CLAP) are intentionally excluded.
const PERCENTAGE_CONVERTIBLE_METRICS = [
    'WER', 'CER', 'PER', 'EER', 'STOI', 'ESTOI', 'F1', 'BLEU', 'PR-AUC', 'AUROC'
];

function extractSectionBody(markdown, heading) {
    const src = String(markdown || '');
    const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
    const m = re.exec(src);
    if (!m) return '';
    const after = src.slice(m.index + m[0].length);
    const next = after.search(/^##\s+/m);
    return (next >= 0 ? after.slice(0, next) : after).trim();
}

function parseMachineSummaryFlags(analysis) {
    const block = extractSectionBody(analysis, '机器摘要');
    const flags = {};
    for (const line of block.split(/\r?\n/)) {
        const m = /^\s*([a-z_]+)\s*[:：]\s*(.+?)\s*$/.exec(line);
        if (m) flags[m[1]] = m[2];
    }
    return flags;
}

function parseFirstPartyOpenSourceLines(analysis) {
    const block = extractSectionBody(analysis, '开源详情');
    const out = { code: '', model: '', dataset: '', demo: '' };
    for (const line of block.split(/\r?\n/)) {
        const cleaned = line.replace(/^[-*]\s*/, '').trim();
        if (/^代码\s*[:：]/.test(cleaned)) out.code = cleaned;
        else if (/^模型权重\s*[:：]/.test(cleaned)) out.model = cleaned;
        else if (/^数据集\s*[:：]/.test(cleaned)) out.dataset = cleaned;
        else if (/^Demo\s*[:：]/i.test(cleaned)) out.demo = cleaned;
    }
    return out;
}

function splitAtomicClauses(text) {
    return String(text || '')
        .split(/(?:[。！？!?；;，,\n]+|(?:但是|然而|不过|但(?=[\u4e00-\u9fffA-Za-z])))/)
        .map(s => s.trim())
        .filter(Boolean);
}

const THIRD_PARTY_CONTEXT_RE = /(?:基于|使用|采用|复用|依托|依赖|对比|相比|借鉴|引用|第三方|现有|已有|外部|开源基线|开放权重(?:模型|系统|架构|基线|生态|家族|版本|系列|音视频|语音|音频|社区|评测|对比))/;

function hasPositiveResourceClaim(text, resourcePattern) {
    const clauses = splitAtomicClauses(text);
    const negRe = /(?:未开源|未公开|未发布|未提供|尚未开源|尚未公开|尚未发布|暂未开源|暂未公开|并未开源|并未公开|没有开源|没有公开|不可用|仅承诺|计划未来|待开源|待公开|未提及|未披露|仅提供演示|仅公开演示|无公开|伪代码|注意力权重|损失权重|门控权重|融合权重)/;
    // Require explicit open-source/public release verbs (never bare "提供...权重/代码" or adjective "开放权重")
    const posRe = new RegExp(`(?:已开源|已公开|已发布|公开了|开源了|提供(?:了)?(?:开源|公开|可下载的?))(?:[^，,]{0,12})(?:${resourcePattern})`);
    const posRevRe = new RegExp(`(?:${resourcePattern})(?:[^，,]{0,8})(?:已开源|已公开|已发布|可下载|已上线|均已公开|均已开源)`);
    for (const sent of clauses) {
        if (negRe.test(sent) || THIRD_PARTY_CONTEXT_RE.test(sent)) continue;
        // Guard against "开放权重" adjective ("open-weight")
        if (sent.includes('开放权重')) continue;
        if (posRe.test(sent) || posRevRe.test(sent)) return sent;
    }
    return null;
}

function hasNegativeResourceClaim(text, resourcePattern) {
    const clauses = splitAtomicClauses(text);
    const negRe = new RegExp(`(?:未开源|未公开|未提供|尚未开源|尚未公开|没有公开|无公开|未提及|原文未披露)(?:[^，,]{0,10})(?:${resourcePattern})`);
    const negRevRe = new RegExp(`(?:${resourcePattern})(?:[^，,]{0,10})(?:未开源|未公开|未提供|未提及|原文未披露|尚未发布|不可获取)`);
    for (const sent of clauses) {
        if (/(?:已开源|已公开|已发布|https?:\/\/)/i.test(sent)) continue;
        if (negRe.test(sent) || negRevRe.test(sent)) return sent;
    }
    return null;
}

function checkOpenSourceConsistency(analysis, apiReaderPlan) {
    const issues = [];
    const flags = parseMachineSummaryFlags(analysis);
    const osLines = parseFirstPartyOpenSourceLines(analysis);
    const coreSummary = extractSectionBody(analysis, '核心摘要');
    const specsText = String(apiReaderPlan?.implementationSpecs?.openSourceArtifacts || '').trim();
    if (!specsText && !coreSummary) return issues;

    const specsUrlRe = /https?:\/\/[^\s)）]+/i;
    const checks = [
        {
            key: 'has_code',
            label: '代码',
            osLine: osLines.code,
            pattern: '代码仓库|源码|训练代码|推理代码|开源代码|代码'
        },
        {
            key: 'has_model',
            label: '模型权重',
            osLine: osLines.model,
            pattern: '模型权重|预训练权重|权重文件|检查点权重|权重'
        },
        {
            key: 'has_dataset',
            label: '数据集',
            osLine: osLines.dataset,
            pattern: '自建数据集|评测数据集|基准数据集|完整数据集|语料库'
        }
    ];

    for (const item of checks) {
        const flagVal = String(flags[item.key] || '').trim();
        const osHasUrl = specsUrlRe.test(item.osLine);

        if (flagVal === '否' && !osHasUrl) {
            const specConflict = specsText ? hasPositiveResourceClaim(specsText, item.pattern) : null;
            if (specConflict) {
                issues.push({
                    code: 'cross_stage_opensource_contradiction',
                    stage: 'implementationSpecs.openSourceArtifacts',
                    field: item.key,
                    message: `跨阶段开源状态冲突：机器摘要标明 ${item.key}=否 且开源详情无第一方链接，但 implementationSpecs.openSourceArtifacts 声称已公开${item.label}（「${specConflict.slice(0, 80)}」）`
                });
            }
            const coreConflict = coreSummary ? hasPositiveResourceClaim(coreSummary, item.pattern) : null;
            if (coreConflict) {
                issues.push({
                    code: 'cross_stage_opensource_contradiction',
                    stage: 'coreSummary',
                    field: item.key,
                    message: `跨阶段开源状态冲突：机器摘要标明 ${item.key}=否 且开源详情无第一方链接，但核心摘要声称已公开${item.label}（「${coreConflict.slice(0, 80)}」）`
                });
            }
        } else if (flagVal === '是' && osHasUrl && specsText) {
            // Allow partial releases (e.g., "已开源推理代码（https://...），但未开源训练代码"):
            // only flag when specsText has NO positive release claim for this resource class AND claims it undisclosed.
            const specAlreadyAcknowledgesRelease = Boolean(hasPositiveResourceClaim(specsText, item.pattern));
            if (!specAlreadyAcknowledgesRelease) {
                const specNegConflict = hasNegativeResourceClaim(specsText, item.pattern);
                if (specNegConflict) {
                    issues.push({
                        code: 'cross_stage_opensource_contradiction',
                        stage: 'implementationSpecs.openSourceArtifacts',
                        field: item.key,
                        message: `跨阶段开源状态冲突：机器摘要标明 ${item.key}=是 且开源详情列有第一方链接，但 implementationSpecs.openSourceArtifacts 声称未公开${item.label}（「${specNegConflict.slice(0, 80)}」）`
                    });
                }
            }
        }
    }
    return issues;
}

function checkCoreSummaryGuideTargets(analysis, apiReaderPlan) {
    const issues = [];
    const coreSummary = extractSectionBody(analysis, '核心摘要');
    const sections = Array.isArray(apiReaderPlan?.sections) ? apiReaderPlan.sections : [];
    if (!coreSummary || sections.length === 0) return issues;

    const sectionKinds = new Set(sections.map(s => String(s?.kind || '').trim()));
    const sectionHeadings = sections.map(s => String(s?.heading || '').trim()).filter(Boolean);
    const normalizedHeadings = sectionHeadings.map(h => h.replace(/[？?！!：:，,。.\s]/g, '').toLowerCase());

    const guideSentences = coreSummary
        .split(/[。！？!?\n]+/)
        .map(s => s.trim())
        .filter(s => /(?:深读导览|下方长文|后文|下方|查阅|阅读|详见|参见)/.test(s));

    for (const sent of guideSentences) {
        for (const retired of RETIRED_GUIDE_HEADINGS) {
            if (!sent.includes(retired.token)) continue;
            if (retired.kindRequired && sectionKinds.has(retired.kindRequired)) continue;
            issues.push({
                code: 'cross_stage_dangling_guide_target',
                stage: 'coreSummary',
                target: retired.token,
                message: `核心摘要深读导览指向了不存在或已退役的栏目「${retired.token}」（${retired.reason}）`
            });
        }

        // Require explicit forward-guide verb/pointer before quoted section title (never match "论文在「消融分析」小节报告...")
        const refRe = /(?:查阅|阅读|参见|跳转至|见下方|见后文|见长文|下方长文|后文|详见)(?:下方|后文|长文)?(?:的)?[「《“"']([^」》”"'\n]{4,36})[」》”"']\s*(?:小节|一节|章节)/g;
        let m;
        while ((m = refRe.exec(sent)) !== null) {
            const quoted = m[1].trim();
            const qNorm = quoted.replace(/[？?！!：:，,。.\s]/g, '').toLowerCase();
            if (qNorm.length < 4) continue;
            // Allow standard generic topic names when a matching section kind exists
            const matchesGenericKind = GENERIC_GUIDE_TOPIC_KINDS.some(
                entry => entry.re.test(quoted) && entry.kinds.some(k => sectionKinds.has(k))
            );
            if (matchesGenericKind) continue;
            const matched = normalizedHeadings.some(h => h.includes(qNorm) || qNorm.includes(h));
            if (!matched) {
                issues.push({
                    code: 'cross_stage_dangling_guide_target',
                    stage: 'coreSummary',
                    target: quoted,
                    message: `核心摘要深读导览显式引用了「${quoted}」小节，但长文实际小节标题（${sectionHeadings.slice(0, 6).join(' / ')}）中不存在该标题`
                });
            }
        }
    }
    return issues;
}

const LEGITIMATE_LOG_VALUE_RE = /(?:功率谱|幅度谱|梅尔谱|频谱|能量|基频|音量|声压|分贝|概率|似然|方差|取|的)对数值/;

function hasMistranslatedLogit(text) {
    const src = String(text || '');
    if (!src.includes('对数值')) return false;
    const stripped = src.replace(new RegExp(LEGITIMATE_LOG_VALUE_RE.source, 'g'), '');
    return stripped.includes('对数值');
}

function checkTerminologyDrift(analysis, apiReaderArticle) {
    const issues = [];
    const coreSummary = extractSectionBody(analysis, '核心摘要');
    const reader = String(apiReaderArticle || '');
    if (!coreSummary || !reader) return issues;

    const pairRe = /([\u4e00-\u9fff]{2,4})(精确率|准确率)/g;
    const collectPairs = text => {
        const map = new Map();
        let m;
        while ((m = pairRe.exec(text)) !== null) {
            const prefix = m[1];
            const kind = m[2];
            if (/^(?:平均|整体|总体|最高|最低|提升|提高|降低|保持|达到|获得|以及|或者|与|和|及|的|其|该|在|对|将|把)/.test(prefix)) continue;
            if (!map.has(prefix)) map.set(prefix, new Set());
            map.get(prefix).add(kind);
        }
        return map;
    };
    const corePairs = collectPairs(coreSummary);
    const readerPairs = collectPairs(reader);
    for (const [prefix, coreKinds] of corePairs.entries()) {
        const readerKinds = readerPairs.get(prefix);
        if (!readerKinds) continue;
        if (coreKinds.size === 1 && readerKinds.size === 1) {
            const cKind = [...coreKinds][0];
            const rKind = [...readerKinds][0];
            if (cKind !== rKind) {
                issues.push({
                    code: 'cross_stage_terminology_drift',
                    stage: 'coreSummary_vs_reader',
                    termA: `${prefix}${cKind}`,
                    termB: `${prefix}${rKind}`,
                    message: `跨阶段术语译名冲突：核心摘要使用「${prefix}${cKind}」，而长文解读使用「${prefix}${rKind}」，须对照原文核实是 precision（精确率）还是 accuracy（准确率）并统一`
                });
            }
        }
    }

    const coreBadLogit = hasMistranslatedLogit(coreSummary);
    const readerBadLogit = hasMistranslatedLogit(reader);
    if ((coreBadLogit && reader.includes('对数几率') && !readerBadLogit)
        || (readerBadLogit && coreSummary.includes('对数几率') && !coreBadLogit)) {
        issues.push({
            code: 'cross_stage_terminology_drift',
            stage: 'coreSummary_vs_reader',
            termA: '对数值',
            termB: '对数几率',
            message: '跨阶段术语误译冲突（logit）：一侧使用准确译名「对数几率」，另一侧出现误译「对数值」'
        });
    }

    const simplePairs = [
        { bad: '评论家', good: '价值评估模型', label: 'critic' },
        { bad: '虚拟语音质量客观听众', good: 'ViSQOL', label: 'ViSQOL' }
    ];
    for (const pair of simplePairs) {
        const coreHasBad = coreSummary.includes(pair.bad);
        const readerHasBad = reader.includes(pair.bad);
        const coreHasGood = coreSummary.includes(pair.good);
        const readerHasGood = reader.includes(pair.good);
        if ((coreHasBad && readerHasGood && !readerHasBad) || (readerHasBad && coreHasGood && !coreHasBad)) {
            issues.push({
                code: 'cross_stage_terminology_drift',
                stage: 'coreSummary_vs_reader',
                termA: pair.bad,
                termB: pair.good,
                message: `跨阶段术语误译冲突（${pair.label}）：一侧使用准确译名「${pair.good}」，另一侧出现误译「${pair.bad}」`
            });
        }
    }
    return issues;
}

function extractPercentageMetricNumbers(text) {
    const map = new Map();
    const src = String(text || '').replace(/\u2212/g, '-');
    for (const metric of PERCENTAGE_CONVERTIBLE_METRICS) {
        const esc = metric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Exclude hyphen-prefixed compound metrics (CS-WER / SA-WER must not collide with bare WER)
        // and properly parse leading-dot decimals (.58 -> 0.58, NOT 58!).
        const re = new RegExp(`(?<![A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])[^。！？!?\n\\d.]{0,18}?([+-]?(?:\\d+\\.\\d+|\\.\\d+|\\d+))(%?)`, 'gi');
        let m;
        while ((m = re.exec(src)) !== null) {
            const val = Number(m[1]);
            if (!Number.isFinite(val) || val === 0) continue;
            if (!map.has(metric)) map.set(metric, []);
            map.get(metric).push({ value: val, hasPercent: m[2] === '%', raw: `${m[1]}${m[2]}` });
        }
    }
    return map;
}

function checkMetricScaleDrift(analysis, apiReaderArticle) {
    const issues = [];
    const coreSummary = extractSectionBody(analysis, '核心摘要');
    const reader = String(apiReaderArticle || '');
    if (!coreSummary || !reader) return issues;

    const coreMetrics = extractPercentageMetricNumbers(coreSummary);
    const readerMetrics = extractPercentageMetricNumbers(reader);

    for (const [metric, cVals] of coreMetrics.entries()) {
        const rVals = readerMetrics.get(metric);
        if (!rVals || rVals.length === 0) continue;
        for (const cv of cVals) {
            if (rVals.some(rv => Math.abs(rv.value - cv.value) <= 1e-6)) continue;
            // Require the small (0..1) value NOT to carry '%' so "WER 0.85%" vs "WER 85.0%" (both %) never false-triggers!
            // Also catch [1, 10)% vs <0.1 bare decimal (e.g. "WER 5.2%" vs "WER 0.052") strictly when the larger value carries '%'.
            const scaledMatch = rVals.find(rv => {
                if (!cv.hasPercent && cv.value > 0 && cv.value < 1 && rv.value >= 10 && rv.value <= 100) {
                    return Math.abs(cv.value * 100 - rv.value) <= 0.05;
                }
                if (!rv.hasPercent && rv.value > 0 && rv.value < 1 && cv.value >= 10 && cv.value <= 100) {
                    return Math.abs(rv.value * 100 - cv.value) <= 0.05;
                }
                if (!cv.hasPercent && cv.value > 0 && cv.value < 0.1 && rv.hasPercent && rv.value >= 1 && rv.value < 10) {
                    return Math.abs(rv.value / 100 - cv.value) <= 0.002;
                }
                if (!rv.hasPercent && rv.value > 0 && rv.value < 0.1 && cv.hasPercent && cv.value >= 1 && cv.value < 10) {
                    return Math.abs(cv.value / 100 - rv.value) <= 0.002;
                }
                return false;
            });
            if (scaledMatch) {
                issues.push({
                    code: 'cross_stage_metric_scale_drift',
                    stage: 'coreSummary_vs_reader',
                    metric,
                    coreRaw: cv.raw,
                    readerRaw: scaledMatch.raw,
                    message: `跨阶段量纲换算冲突（${metric}）：核心摘要记为 ${cv.raw}，而长文解读记为 ${scaledMatch.raw}（小数与百分制相差 100 倍），须按原文精度统一`
                });
                break;
            }
        }
    }
    return issues;
}

function checkCrossStageConsistency({ analysis = '', apiReaderArticle = '', apiReaderPlan = null } = {}) {
    return [
        ...checkOpenSourceConsistency(analysis, apiReaderPlan),
        ...checkCoreSummaryGuideTargets(analysis, apiReaderPlan),
        ...checkTerminologyDrift(analysis, apiReaderArticle),
        ...checkMetricScaleDrift(analysis, apiReaderArticle)
    ];
}

module.exports = {
    checkCrossStageConsistency,
    checkOpenSourceConsistency,
    checkCoreSummaryGuideTargets,
    checkTerminologyDrift,
    checkMetricScaleDrift
};

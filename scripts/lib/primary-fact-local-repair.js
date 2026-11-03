'use strict';
const crypto = require('node:crypto');
const protocols = require('./protocol-codec');
const CONTRACT = 'primary-local-fact-repair';
const ORIGINAL_HEADER = Object.freeze(protocols.historicalHeader(CONTRACT, 'bounded-source-backed-paragraphs'));
const VALIDATION_CONTRACT = protocols.historicalContract('primary-local-fact-validation', 'historic-replay-only');
const history = require('../../config/primary-local-fact-history.json');
const currentHeader = () => protocols.recordHeader(CONTRACT, CONTRACT);
function readHeader(record) {
    if (!protocols.hasValidHeader(record, CONTRACT)) reject('局部修订格式或结构指纹不合法');
    return protocols.recordHeader(record.contract, CONTRACT, record.schemaFingerprint);
}
function originalImplementationSha() {
    const entry = history.originalImplementation;
    const raw = require('./git-file-bytes').readGitBlob(require('node:path').resolve(__dirname, '../..'), entry.blobOid, entry.sha256);
    return crypto.createHash('sha256').update(raw).digest('hex');
}
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function validateHeadings(analysis) {
    const contract = require('../analysis-contract');
    const issue = contract.validateTopLevelSectionContract(analysis);
    if (!issue) return;
    // 原始主分析的标签由后续结构修复与独立标签阶段补齐。
    // 局部事实修复可保留这一种中间稿；其他缺节、乱序或重复仍拒绝。
    const headings = require('./analysis-section-titles').analysisSectionHeadings(analysis)
        .map(heading => heading.section);
    const pendingTags = contract.REQUIRED_ANALYSIS_SECTIONS.filter(title => title !== '标签');
    if (headings.length === pendingTags.length
        && headings.every((heading, index) => heading === pendingTags[index])) return;
    reject(`原正文固定章节不合法：${issue}`);
}
function reject(message) {
    const error = new Error(`局部主文事实纠错拒绝：${message}`);
    error.code = 'CONTRACT_REJECTED';
    throw error;
}
function uniqueKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}
function buildPlan(analysis, feedback, header = currentHeader()) {
    header = readHeader(header);
    if (typeof analysis !== 'string' || sha(analysis) !== feedback.coreAnalysisSha256) reject('原正文SHA不对应受控反馈');
    if (!String(feedback.primaryFeedback || '').trim()) reject('缺少主文纠错范围');
    const paragraphs = [];
    const headings = [...analysis.matchAll(/^## ([^\n]+)\r?$/gm)];
    for (let index = 0; index < headings.length; index += 1) {
        const heading = headings[index];
        const start = heading.index + heading[0].length;
        const end = headings[index + 1]?.index ?? analysis.length;
        const section = analysis.slice(start, end);
        for (const match of section.matchAll(/\S[\s\S]*?(?=\n[ \t]*\n|$)/g)) {
            paragraphs.push({ start: start + match.index, end: start + match.index + match[0].length,
                heading: heading[1].trim(), text: match[0] });
        }
    }
    const allowed = new Map();
    for (const claim of feedback.rejectedPrimaryClaims || []) {
        const first = analysis.indexOf(claim);
        if (first < 0 || analysis.indexOf(claim, first + 1) >= 0) reject('错误原句必须在当前正文唯一出现');
        const paragraph = paragraphs.find(item => item.start <= first && item.end >= first + claim.length);
        if (!paragraph || ['评分', '机器摘要', '评分理由', '核心摘要', '标签'].includes(paragraph.heading)) {
            reject('主文局部范围不能跨段或修改评分、标签、核心摘要');
        }
        allowed.set(paragraph.start, paragraph);
    }
    if (!allowed.size) reject('没有可定位错误原句');
    const targets = [...allowed.values()].sort((left, right) => left.start - right.start);
    return { ...header, inputSha256: sha(analysis), targets,
        targetsSha256: sha(JSON.stringify(targets)) };
}
function applyPatch(analysis, plan, raw) {
    let patch;
    try { patch = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { reject('输出必须是完整JSON'); }
    const header = readHeader(plan);
    if (!uniqueKeys(patch, [...Object.keys(header), 'inputSha256', 'replacements'])
        || !Object.entries(header).every(([key, expected]) => patch[key] === expected)
        || patch.inputSha256 !== plan.inputSha256
        || sha(analysis) !== plan.inputSha256 || !Array.isArray(patch.replacements)
        || patch.replacements.length !== plan.targets.length) reject('补丁字段、原稿SHA或片段数量不匹配');
    const used = new Set();
    const changes = patch.replacements.map(item => {
        if (!uniqueKeys(item, ['from', 'to']) || typeof item.from !== 'string'
            || typeof item.to !== 'string' || !item.to.trim() || /^## /m.test(item.to)
            || item.to.length > Math.max(4000, item.from.length * 2)) reject('替换片段类型或范围非法');
        const target = plan.targets.find(target => target.text === item.from);
        if (!target || used.has(target.start) || analysis.indexOf(item.from) !== target.start
            || analysis.indexOf(item.from, target.start + 1) >= 0) reject('from必须是授权且唯一的原段落');
        used.add(target.start);
        return { ...target, to: item.to };
    }).sort((left, right) => right.start - left.start);
    let output = analysis;
    for (const change of changes) output = output.slice(0, change.start) + change.to + output.slice(change.end);
    return { analysis: output, receipt: { ...header, inputSha256: plan.inputSha256,
        outputSha256: sha(output), targetsSha256: plan.targetsSha256,
        responseSha256: sha(typeof raw === 'string' ? raw : JSON.stringify(raw)) } };
}
function fingerprintFields(receipt) {
    if (!receipt) return {};
    const header = readHeader(receipt);
    const bindings = ['inputSha256', 'outputSha256', 'targetsSha256', 'responseSha256'];
    if (!uniqueKeys(receipt, [...Object.keys(header), ...bindings])
        || bindings.some(key => typeof receipt[key] !== 'string' || !/^[a-f0-9]{64}$/.test(receipt[key]))) {
        reject('保存的局部修订凭证不合法');
    }
    return { primaryLocalFactRepair: receipt };
}
module.exports = { CONTRACT, VALIDATION_CONTRACT, readHeader, currentHeader, ORIGINAL_HEADER,
    originalPromptPath: history.originalPromptPath, originalImplementationSha, sha, buildPlan, applyPatch, fingerprintFields, validateHeadings };

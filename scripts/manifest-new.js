#!/usr/bin/env node
'use strict';
// 从简单 spec 生成账号池无关的 operator 修正清单/记录。
// spec: { paperId, replacements: [{ path, value }], notes? }
// dry/write 共核完整尾集和候选材料；完整当前输入/付费身份未核。
// 正式采用仍另核来源、材料与正常 Reader 资格。
// 默认 --dry-run，--write 才写入 data/runtime/operator-corrections-<uuid>/。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('./env-loader.js');
const Config = require('./config.js');
const { readJsonFileStrict } = require('./analysis-engine.js');
const daily = require('./lib/daily-fresh-source-plan.js');
const repair = require('./lib/reader-repair.js');
const utils = require('./utils.js');
const correction = require('./lib/daily-reader-operator-correction.js');

const hashDraft = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function nodeAt(draft, pointer) {
    if (['/readerTitle', '/oneSentenceThesis'].includes(pointer)) return draft[pointer.slice(1)];
    if (['/sections', '/tableBindings', '/conceptBridges', '/formulaBindings', '/figurePlacements'].includes(pointer)) return draft[pointer.slice(1)];
    const match = /^\/(sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(0|[1-9]\d*)(\/(?:body|explanation))?$/.exec(pointer);
    if (!match) throw new Error(`不支持的节点路径：${pointer}`);
    const collection = draft[match[1]];
    if (!Array.isArray(collection)) throw new Error(`节点不存在：${pointer}`);
    const node = collection[Number(match[2])];
    if (!node || typeof node !== 'object') throw new Error(`节点不存在：${pointer}`);
    return match[3] ? node[match[3].slice(1)] : node;
}

function validateSpec(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec 必须是对象');
    if (typeof spec.paperId !== 'string' || !/^\d{4}\.\d{4,5}$/.test(spec.paperId)) throw new Error('spec.paperId 非法');
    if (!Array.isArray(spec.replacements) || spec.replacements.length < 1 || spec.replacements.length > 8) throw new Error('replacements 须为 1–8 项');
    for (const replacement of spec.replacements) {
        if (!replacement || typeof replacement.path !== 'string' || !/^\/(?:sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)(?:\/(?:body|explanation))?$/.test(replacement.path)) {
            throw new Error(`replacement.path 非法：${replacement && replacement.path}`);
        }
        if (replacement.path.endsWith('/body') || replacement.path.endsWith('/explanation')) {
            if (typeof replacement.value !== 'string' || !replacement.value.trim()) throw new Error('replacement.value 须为非空字符串');
        } else if (!replacement.value || typeof replacement.value !== 'object' || Array.isArray(replacement.value)) {
            throw new Error('replacement.value 须为单个节点对象');
        }
    }
}

function findCandidate(attemptsDir, paperId, planRunId = null, sourceSha256 = null) {
    if (!/^[a-f0-9]{64}$/.test(sourceSha256 || '')) throw new Error('候选检查需要当前封存来源 sourceSha256');
    const candidates = fs.readdirSync(attemptsDir)
        .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .sort().map(name => ({ absolutePath: path.join(attemptsDir, name) }));
    const target = utils.normalizedId({ arxivId: paperId });
    const matches = [];
    for (const candidate of candidates) {
        const envelope = repair.readFailedCandidateEnvelope(attemptsDir, null, candidate.absolutePath);
        if (!envelope) throw new Error(`候选读取期间消失：${candidate.absolutePath}`);
        const candidateId = utils.normalizedId({ arxivId: envelope?.envelope?.identity?.paperId || '' });
        if (envelope && candidateId === target && envelope.envelope?.identity?.freshAnalysis?.runId
            && envelope.envelope?.identity?.freshAnalysis?.runId === planRunId
            && envelope.envelope?.identity?.freshAnalysis?.sourceOnly === true) {
            if (envelope.envelope.identity.sourceSha256 !== sourceSha256)
                throw new Error(`${paperId} 候选与当前封存来源 sourceSha256 不同`);
            if (!envelope.envelope.payload.draft) throw new Error(`${paperId} 候选没有可准备修正的草稿 draft`);
            matches.push({ absolutePath: candidate.absolutePath, ...envelope });
        }
    }
    if (matches.length > 1) throw new Error(`${paperId} 存在多个活动候选，当前输入身份未核，不能消除歧义`);
    return matches[0] || null;
}

function readOperatorFeedbackFiles(files) {
    const feedbacks = new Map();
    for (const filename of files) {
        const feedback = require('./lib/daily-fact-review').readFeedback(filename);
        if (feedbacks.has(feedback.paperId)) throw new Error(`同一论文不能提供两份事实反馈：${feedback.paperId}`);
        feedbacks.set(feedback.paperId, feedback);
    }
    return feedbacks;
}

function buildSpecPreview({ paper, draft, spec, found, sourceDescriptor }) {
    const replacements = spec.replacements.map(item => ({
        path: item.path,
        oldSha256: hashDraft(nodeAt(draft, item.path)),
        value: item.value
    }));
    const patch = { version: 1, draftSha256: hashDraft(draft), replacements };
    const finalDraft = repair.applyReaderPatch(JSON.parse(JSON.stringify(draft)), patch, replacements.map(item => item.path));
    const paperId = utils.normalizedId({ arxivId: paper.arxivId || paper.paper_id || paper.paperId });
    const record = {
        contract: 'reader-human-source-edit-v1', notLlmResponse: true,
        runId: null, batchDate: null, paperId, arxivId: paper.arxivId || paper.paper_id,
        baselineCandidateFile: path.resolve(found.absolutePath),
        baselineCandidateEnvelopeSha256: found.envelopeSha256,
        baselineDraftSha256: hashDraft(draft), draft: finalDraft, patch,
        sourceDescriptor
    };
    return { record, replacements, finalDraft };
}

function main(argv = process.argv.slice(2)) {
    const options = { specFiles: [], feedbackFiles: [], write: false, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--spec' || value === '--fact-feedback-file') {
            const filename = argv[++index];
            if (typeof filename !== 'string' || !filename.trim() || filename.startsWith('--'))
                throw new Error(`${value} 需要非空文件路径参数`);
            options[value === '--spec' ? 'specFiles' : 'feedbackFiles'].push(path.resolve(filename));
        }
        else if (value === '--write') options.write = true;
        else if (value === '--dry-run') options.write = false;
        else if (value === '--json') options.json = true;
        else if (value === '--help') options.help = true;
        else throw new Error(`未知参数：${value}`);
    }
    if (options.help || !options.specFiles.length) {
        console.log('用法: node scripts/manifest-new.js --spec SPEC.json [--spec SPEC2.json ...] [--fact-feedback-file FILE ...] [--dry-run|--write] [--json]');
        console.log('SPEC 可以是单个 {paperId,replacements}、其数组，或 {papers:[...]}；dry-run/write 均须覆盖当前完整失败集，仅准备材料，正式采用仍核来源、材料与正常Reader资格。');
        return options.help ? 0 : 2;
    }
    const specs = options.specFiles.flatMap(file => {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(value) ? value : (Array.isArray(value.papers) ? value.papers : [value]);
    });
    if (!specs.length) throw new Error('SPEC 须至少包含一篇当前失败论文');
    specs.forEach(validateSpec);
    const data = readJsonFileStrict(Config.FILES.deepAnalysisResult);
    const papers = Array.isArray(data) ? data : (data.papers || []);
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data, { papers, label: 'manifest-new' });
    const factFeedbacks = readOperatorFeedbackFiles(options.feedbackFiles);
    const tail = correction.inspectDailyOperatorTail(plan, papers, factFeedbacks);
    correction.assertCompleteOperatorTail(tail, specs.map(spec => spec.paperId));
    const built = [];
    for (const spec of specs) {
        const paper = papers.find(item => utils.normalizedId({ arxivId: item.arxivId || item.paper_id || item.paperId }) === utils.normalizedId({ arxivId: spec.paperId }));
        if (!paper) throw new Error(`当前批次找不到论文：${spec.paperId}`);
        const details = daily.readDailyFreshSource(plan, paper);
        const found = findCandidate(plan.readerAttemptsDir, spec.paperId, plan.runId, details.freshSourceDescriptor.sourceSha256);
        if (!found) throw new Error(`找不到 ${spec.paperId} 的活动失败候选；未核当前身份或付费来源`);
        const preview = buildSpecPreview({ paper, draft: found.envelope.payload.draft, spec, found, sourceDescriptor: details.freshSourceDescriptor });
        preview.record.runId = plan.runId;
        preview.record.batchDate = plan.batchDate;
        built.push({ spec, paper, found, preview, paperId: utils.normalizedId({ arxivId: paper.arxivId || paper.paper_id || paper.paperId }) });
    }
    const summary = built.map(item => ({
        paperId: item.paperId, replacements: item.preview.replacements.map(entry => entry.path),
        baselineCandidate: item.found.absolutePath, baselineDraftSha256: item.preview.record.baselineDraftSha256,
        draftSha256: hashDraft(item.preview.finalDraft)
    }));
    const report = { records: summary, dryRun: !options.write, tailCheck: 'passed',
        failedIds: tail.failedIds, limit: tail.limit, feedbackCount: tail.feedbackCount,
        candidateEnvelope: 'checked', candidateIdentity: 'not_checked', paidOrigin: 'not_checked',
        purpose: 'material_preparation_only', notRequestAuthorization: true };
    if (options.write) {
        const outDir = path.join(path.dirname(Config.FILES.dailyFreshSourceRunsDir), `operator-corrections-${plan.batchDate.replace(/-/g, '')}-${crypto.randomUUID()}`);
        fs.mkdirSync(outDir, { recursive: false, mode: 0o700 });
        const correctionFiles = [];
        for (const item of built) {
            const recordFile = path.join(outDir, `${item.paperId}.json`);
            fs.writeFileSync(recordFile, JSON.stringify(item.preview.record), { mode: 0o600 });
            correctionFiles.push(recordFile);
        }
        const manifest = {
            contract: 'daily-reader-operator-correction-batch-v1', runId: plan.runId, batchDate: plan.batchDate,
            authorization: built[0].spec.authorization || '用户明确要求人工处理当前日更失败论文（零请求本地修正）',
            correctionFiles
        };
        const manifestFile = path.join(outDir, 'operator-manifest.json');
        fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
        report.manifestFile = manifestFile;
    }
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
        for (const item of summary) console.log(`论文 ${item.paperId}：${item.replacements.length} 个节点，draft ${item.draftSha256.slice(0, 10)}${options.write ? '' : '（dry-run，不写材料）'}`);
        console.log('完整失败集与候选材料已核对；完整当前输入身份和付费来源未核验，正式采用仍核来源、材料与正常Reader资格。');
        if (report.manifestFile) console.log(`已写入 ${report.manifestFile}（仅准备修正材料）`);
    }
    return 0;
}

module.exports = { validateSpec, nodeAt, buildSpecPreview, findCandidate, readOperatorFeedbackFiles, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[manifest-new] ${error.message}`); process.exitCode = 1; }
}

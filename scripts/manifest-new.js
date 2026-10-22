#!/usr/bin/env node
'use strict';
// 从简单 spec 生成账号池无关的 operator 修正清单/记录。
// spec: { paperId, replacements: [{ path, value }], notes? }
// 默认 --dry-run（只计算并打印 oldSha/draftSha 与新内容），--write 才写入 data/runtime/operator-corrections-<uuid>/。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
require('./env-loader.js');
const Config = require('./config.js');
const { readJsonFileStrict } = require('./analysis-engine.js');
const daily = require('./lib/daily-fresh-source-plan.js');
const repair = require('./lib/reader-repair.js');
const utils = require('./utils.js');

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
        if (typeof replacement.value !== 'string' || !replacement.value.trim()) throw new Error('replacement.value 不能为空');
    }
}

function findCandidate(attemptsDir, paperId) {
    const candidates = fs.readdirSync(attemptsDir)
        .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .map(name => ({ name, absolutePath: path.join(attemptsDir, name), mtime: fs.statSync(path.join(attemptsDir, name)).mtimeMs }))
        .sort((left, right) => right.mtime - left.mtime);
    for (const candidate of candidates) {
        const envelope = repair.readFailedCandidateEnvelope(attemptsDir, null, candidate.absolutePath);
        if (envelope && String(envelope.envelope.identity.paperId || '').startsWith(paperId)) {
            return { absolutePath: candidate.absolutePath, ...envelope };
        }
    }
    return null;
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
    const options = { specFile: null, write: false, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--spec') options.specFile = path.resolve(argv[++index] || '');
        else if (value === '--write') options.write = true;
        else if (value === '--dry-run') options.write = false;
        else if (value === '--json') options.json = true;
        else if (value === '--help') options.help = true;
        else throw new Error(`未知参数：${value}`);
    }
    if (options.help || !options.specFile) {
        console.log('用法: node scripts/manifest-new.js --spec SPEC.json [--dry-run|--write] [--json]');
        return options.help ? 0 : 2;
    }
    const spec = JSON.parse(fs.readFileSync(options.specFile, 'utf8'));
    validateSpec(spec);
    const data = readJsonFileStrict(Config.FILES.deepAnalysisResult);
    const papers = Array.isArray(data) ? data : (data.papers || []);
    const plan = daily.requireDailyFreshSourceRecoveryPlan(data, { papers, label: 'manifest-new' });
    const paper = papers.find(item => utils.normalizedId({ arxivId: item.arxivId || item.paper_id || item.paperId }) === utils.normalizedId({ arxivId: spec.paperId }));
    if (!paper) throw new Error(`当前批次找不到论文：${spec.paperId}`);
    const details = daily.readDailyFreshSource(plan, paper);
    const found = findCandidate(plan.readerAttemptsDir, spec.paperId);
    if (!found) throw new Error(`找不到 ${spec.paperId} 的活动付费候选`);
    const preview = buildSpecPreview({ paper, draft: found.envelope.payload.draft, spec, found, sourceDescriptor: details.freshSourceDescriptor });
    preview.record.runId = plan.runId;
    preview.record.batchDate = plan.batchDate;
    const summary = {
        paperId: spec.paperId, replacements: preview.replacements.map(item => item.path),
        baselineCandidate: found.absolutePath, baselineDraftSha256: preview.record.baselineDraftSha256,
        draftSha256: hashDraft(preview.finalDraft), dryRun: !options.write
    };
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else console.log(`论文 ${spec.paperId}：${preview.replacements.length} 个节点，候选 ${path.basename(found.absolutePath).slice(0, 10)}，draft ${summary.draftSha256.slice(0, 10)}${options.write ? '' : '（dry-run，不写文件）'}`);
    if (!options.write) return 0;
    const outDir = path.join(ROOT, 'data', 'runtime', `operator-corrections-${plan.batchDate.replace(/-/g, '')}-${crypto.randomUUID()}`);
    fs.mkdirSync(outDir, { recursive: false, mode: 0o700 });
    const recordFile = path.join(outDir, `${spec.paperId}.json`);
    fs.writeFileSync(recordFile, JSON.stringify(preview.record), { mode: 0o600 });
    const manifest = {
        contract: 'daily-reader-operator-correction-batch-v1', runId: plan.runId, batchDate: plan.batchDate,
        authorization: spec.authorization || '用户明确要求人工处理当前日更失败论文（零请求本地修正）',
        correctionFiles: [recordFile]
    };
    const manifestFile = path.join(outDir, 'operator-manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    console.log(`已写入 ${manifestFile}`);
    return 0;
}

module.exports = { validateSpec, nodeAt, buildSpecPreview, findCandidate, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[manifest-new] ${error.message}`); process.exitCode = 1; }
}

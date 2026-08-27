#!/usr/bin/env node
/** Merge independently reviewed Manual filter shards into one exact-coverage spec. */
const fs = require('fs');
const path = require('path');
const Config = require('./config.js');
const { normalizedId, writeFileAtomic } = require('./utils.js');
const { assertUniqueNormalizedDecisionKeys } = require('./manual-fetch.js');

function parseArgs(argv) {
    const options = { parts: [] };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        if (arg === '--date') options.date = value;
        else if (arg === '--reviewer') options.reviewer = value;
        else if (arg === '--part') options.parts.push(value);
        else if (arg === '--output') options.output = value;
        else throw new Error(`未知参数: ${arg}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date || '')) throw new Error('--date 必须是 YYYY-MM-DD');
    if (!options.reviewer || options.reviewer.trim().length < 2) throw new Error('--reviewer 缺失');
    if (options.parts.length < 2) throw new Error('--part 至少需要两份独立筛选分片');
    return options;
}

function readJson(filePath, label) {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 非法: ${filePath}`);
    return value;
}

function mergeParts(raw, parts, options) {
    if (raw.batchDate !== options.date || !Array.isArray(raw.papers)) throw new Error('raw 批次日期或 papers 非法');
    const decisions = {};
    for (const [partIndex, document] of parts.entries()) {
        const source = document.decisions;
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`part[${partIndex}].decisions 非法`);
        assertUniqueNormalizedDecisionKeys(source);
        for (const [rawId, decision] of Object.entries(source)) {
            const id = normalizedId(rawId);
            if (decisions[id]) throw new Error(`分片之间重复论文: ${id}`);
            if (!decision || typeof decision.related !== 'boolean'
                || typeof decision.reason !== 'string' || decision.reason.trim().length < 20
                || !Array.isArray(decision.reviewedFields)
                || !['title', 'abstract', 'categories', 'sources'].every(field => decision.reviewedFields.includes(field))) {
                throw new Error(`${id} 分片决定不满足 Manual filter 契约`);
            }
            decisions[id] = {
                related: decision.related,
                reason: decision.reason.trim(),
                reviewedFields: ['title', 'abstract', 'categories', 'sources']
            };
        }
    }
    const expected = new Set(raw.papers.map(normalizedId));
    const actual = new Set(Object.keys(decisions));
    const missing = [...expected].filter(id => !actual.has(id));
    const extra = [...actual].filter(id => !expected.has(id));
    if (missing.length || extra.length || expected.size !== actual.size) {
        throw new Error(`分片覆盖不完整: missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
    }
    return {
        version: 1,
        mode: 'manual_offline',
        date: options.date,
        reviewer: options.reviewer,
        decisions
    };
}

function run(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const raw = readJson(Config.FILES.rawCandidates, 'raw-candidates');
    const parts = options.parts.map(value => readJson(path.resolve(value), 'manual filter part'));
    const spec = mergeParts(raw, parts, options);
    const output = path.resolve(options.output || path.join(Config.CURRENT_DIR, `manual-filter-spec-${options.date}.json`));
    writeFileAtomic(output, JSON.stringify(spec, null, 2));
    console.log(`已合并 Manual filter：${Object.keys(spec.decisions).length} 篇，related=${Object.values(spec.decisions).filter(item => item.related).length}`);
    console.log(output);
    return { output, spec };
}

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('merge-manual-filter-spec.js');
    try { run(); } catch (error) { console.error(`manual filter merge 失败: ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, mergeParts, run };

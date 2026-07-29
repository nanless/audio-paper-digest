#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 用历史 filtered-papers.json 的正样本回放关键词预筛，评估召回率。
 *
 * 这是只读诊断工具：历史 LLM 最终保留的论文视为正样本；同一 arXiv ID
 * 跨日期只计一次，同时保留逐文件统计和所有漏召回明细。
 */

const fs = require('fs');
const path = require('path');
const Config = require('./config.js');
const { normalizedId } = require('./utils.js');
const {
    KEYWORD_PREFILTER_VERSION,
    evaluateKeywordPrefilter
} = require('./lib/keyword-prefilter.js');
const DEFAULT_GOLD_FILE = path.join(Config.PROJECT_ROOT, 'tests', 'fixtures', 'keyword-prefilter-gold.json');

function loadGoldSet(filePath = DEFAULT_GOLD_FILE) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.cases) || !Array.isArray(data.historicalFalsePositives)) {
        throw new Error(`关键词金标准格式无效: ${filePath}`);
    }
    return data;
}

function evaluateGoldSet(goldSet = loadGoldSet()) {
    const cases = goldSet.cases.map(item => {
        const result = evaluateKeywordPrefilter(item.paper);
        return { id: item.id, expectedPass: item.expectedPass, actualPass: result.pass, result };
    });
    return {
        cases,
        positives: cases.filter(item => item.expectedPass).length,
        negatives: cases.filter(item => !item.expectedPass).length,
        positiveMisses: cases.filter(item => item.expectedPass && !item.actualPass),
        negativeLeaks: cases.filter(item => !item.expectedPass && item.actualPass)
    };
}

function findFilteredFiles(rootDir) {
    const files = [];
    const visit = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) visit(fullPath);
            else if (entry.isFile() && entry.name === 'filtered-papers.json') files.push(fullPath);
        }
    };
    if (fs.existsSync(rootDir)) visit(rootDir);
    return files.sort();
}

function readPapers(filePath) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(data) ? data : (Array.isArray(data?.papers) ? data.papers : []);
    } catch (error) {
        console.warn(`[keyword-recall] 跳过无法读取的文件 ${filePath}: ${error.message}`);
        return [];
    }
}

function evaluateHistoricalRecall(rootDir = Config.ARCHIVE_DIR, goldSet = loadGoldSet()) {
    const files = findFilteredFiles(rootDir);
    const uniquePapers = new Map();
    const perFile = [];

    for (const filePath of files) {
        const papers = readPapers(filePath);
        let passed = 0;
        const misses = [];
        for (const paper of papers) {
            const result = evaluateKeywordPrefilter(paper);
            if (result.pass) passed += 1;
            else misses.push(normalizedId(paper) || paper?.arxivId || paper?.paper_id || paper?.title || 'unknown');
            const id = normalizedId(paper);
            const key = id || `${paper?.title || ''}\u0000${paper?.abstract || paper?.summary || ''}`;
            if (!uniquePapers.has(key)) uniquePapers.set(key, { paper, files: [filePath] });
            else uniquePapers.get(key).files.push(filePath);
        }
        perFile.push({
            file: path.relative(rootDir, filePath),
            positives: papers.length,
            passed,
            missed: papers.length - passed,
            recall: papers.length > 0 ? passed / papers.length : 1,
            missedIds: misses
        });
    }

    const misses = [];
    const adjudicatedFalsePositiveIds = new Set(
        goldSet.historicalFalsePositives.map(item => normalizedId(item.arxivId)).filter(Boolean)
    );
    let adjudicatedHistoricalFalsePositives = 0;
    const matchedGroups = {};
    let passed = 0;
    let categoryFallbackOnly = 0;
    for (const { paper, files: sourceFiles } of uniquePapers.values()) {
        const result = evaluateKeywordPrefilter(paper);
        if (result.pass) {
            passed += 1;
            if (result.categoryFallback && result.matchedKeywords.length === 0) categoryFallbackOnly += 1;
            for (const group of result.matchedGroups) matchedGroups[group] = (matchedGroups[group] || 0) + 1;
        } else if (adjudicatedFalsePositiveIds.has(normalizedId(paper))) {
            adjudicatedHistoricalFalsePositives += 1;
        } else {
            misses.push({
                arxivId: normalizedId(paper) || paper?.arxivId || paper?.paper_id || '',
                title: paper?.title || '',
                categories: paper?.categories || paper?.category || [],
                reason: result.reason,
                files: sourceFiles.map(filePath => path.relative(rootDir, filePath))
            });
        }
    }

    const historicalSelected = uniquePapers.size;
    const adjudicatedPositives = historicalSelected - adjudicatedHistoricalFalsePositives;
    return {
        keywordPrefilterVersion: KEYWORD_PREFILTER_VERSION,
        rootDir,
        files: files.length,
        positives: historicalSelected,
        historicalSelected,
        adjudicatedPositives,
        passed,
        missed: misses.length,
        rawRecall: historicalSelected > 0 ? passed / historicalSelected : 1,
        recall: adjudicatedPositives > 0 ? passed / adjudicatedPositives : 1,
        categoryFallbackOnly,
        adjudicatedHistoricalFalsePositives,
        matchedGroups,
        misses,
        perFile
    };
}

function main() {
    const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : Config.ARCHIVE_DIR;
    const gold = evaluateGoldSet();
    const report = evaluateHistoricalRecall(rootDir);
    console.log(`[keyword-recall] 人工金标准: ${gold.cases.length} | 正样本漏召回: ${gold.positiveMisses.length} | 负样本误放: ${gold.negativeLeaks.length}`);
    console.log(`[keyword-recall] 词表版本: ${report.keywordPrefilterVersion}`);
    console.log(`[keyword-recall] 历史文件: ${report.files}`);
    console.log(`[keyword-recall] 历史 LLM 入选: ${report.historicalSelected} | 已裁决历史误筛: ${report.adjudicatedHistoricalFalsePositives}`);
    console.log(`[keyword-recall] 裁决后有效正样本: ${report.adjudicatedPositives} | 通过: ${report.passed} | 漏召回: ${report.missed} | 有效正样本召回率: ${(report.recall * 100).toFixed(3)}%`);
    console.log(`[keyword-recall] 未经裁决原始命中率: ${(report.rawRecall * 100).toFixed(3)}%`);
    console.log(`[keyword-recall] 仅靠核心类别兜底: ${report.categoryFallbackOnly}`);
    console.log(`[keyword-recall] 命中词族: ${JSON.stringify(report.matchedGroups)}`);
    if (report.misses.length > 0) {
        console.log('[keyword-recall] 漏召回明细:');
        for (const miss of report.misses) console.log(JSON.stringify(miss));
    }
    process.exitCode = (
        report.missed === 0
        && gold.positiveMisses.length === 0
        && gold.negativeLeaks.length === 0
    ) ? 0 : 2;
}

if (require.main === module) main();

module.exports = {
    DEFAULT_GOLD_FILE,
    findFilteredFiles,
    readPapers,
    loadGoldSet,
    evaluateGoldSet,
    evaluateHistoricalRecall
};

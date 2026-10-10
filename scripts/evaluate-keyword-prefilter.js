#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 对历史 filtered-papers.json 的入选论文重新执行关键词预筛，检查保留了多少。
 *
 * 不修改历史论文记录。人工登记的误筛论文从正样本中剔除，其余用于计算召回率；
 * 同一 arXiv ID 跨日期只计一次，并保留逐文件统计和未通过预筛的论文列表。
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
        throw new Error(`关键词测试样例格式无效: ${filePath}`);
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
    visit(rootDir);
    return files.sort();
}

function readPapers(filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const papers = Array.isArray(data) ? data : data?.papers;
    if (!Array.isArray(papers) || papers.some(paper => !paper || typeof paper !== 'object' || Array.isArray(paper))) {
        throw new Error(`历史入选记录必须是论文对象数组: ${filePath}`);
    }
    return papers;
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
            recall: papers.length > 0 ? passed / papers.length : null,
            missedIds: misses
        });
    }

    const misses = [];
    const adjudicatedFalsePositiveIds = new Set(
        goldSet.historicalFalsePositives.map(item => normalizedId(item.arxivId)).filter(Boolean)
    );
    let adjudicatedHistoricalFalsePositives = 0;
    let rawPassed = 0;
    const historicalFalsePositiveLeaks = [];
    const matchedGroups = {};
    let passed = 0;
    let categoryFallbackOnly = 0;
    for (const { paper, files: sourceFiles } of uniquePapers.values()) {
        const result = evaluateKeywordPrefilter(paper);
        if (result.pass) rawPassed += 1;
        if (adjudicatedFalsePositiveIds.has(normalizedId(paper))) {
            adjudicatedHistoricalFalsePositives += 1;
            if (result.pass) historicalFalsePositiveLeaks.push(normalizedId(paper));
            continue;
        }
        if (result.pass) {
            passed += 1;
            if (result.categoryFallback && result.matchedKeywords.length === 0) categoryFallbackOnly += 1;
            for (const group of result.matchedGroups) matchedGroups[group] = (matchedGroups[group] || 0) + 1;
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
        rawPassed,
        rawRecall: historicalSelected > 0 ? rawPassed / historicalSelected : null,
        recall: adjudicatedPositives > 0 ? passed / adjudicatedPositives : null,
        historicalFalsePositiveLeaks,
        categoryFallbackOnly,
        adjudicatedHistoricalFalsePositives,
        matchedGroups,
        misses,
        perFile
    };
}

function formatRecall(value) {
    return value === null ? '无有效样本' : `${(value * 100).toFixed(3)}%`;
}

function main() {
    const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : Config.ARCHIVE_DIR;
    const gold = evaluateGoldSet();
    const report = evaluateHistoricalRecall(rootDir);
    console.log(`[keyword-recall] 人工标注样例: ${gold.cases.length} | 应保留却被排除: ${gold.positiveMisses.length} | 应排除却被保留: ${gold.negativeLeaks.length}`);
    console.log(`[keyword-recall] 词表版本: ${report.keywordPrefilterVersion}`);
    console.log(`[keyword-recall] 历史文件: ${report.files}`);
    console.log(`[keyword-recall] 历史模型入选: ${report.historicalSelected} | 人工已确认的误筛: ${report.adjudicatedHistoricalFalsePositives}`);
    console.log(`[keyword-recall] 剔除误筛后的正样本: ${report.adjudicatedPositives} | 通过: ${report.passed} | 被排除: ${report.missed} | 正样本保留比例: ${formatRecall(report.recall)}`);
    console.log(`[keyword-recall] 未剔除误筛时的原始通过比例: ${formatRecall(report.rawRecall)}`);
    console.log(`[keyword-recall] 人工已确认误筛、但仍通过预筛: ${report.historicalFalsePositiveLeaks.length} | ${report.historicalFalsePositiveLeaks.join(', ')}`);
    console.log(`[keyword-recall] 未命中关键词、仅因核心音频类别通过: ${report.categoryFallbackOnly}`);
    console.log(`[keyword-recall] 命中的关键词分组及论文数: ${JSON.stringify(report.matchedGroups)}`);
    if (report.misses.length > 0) {
        console.log('[keyword-recall] 历史入选却未通过预筛的论文（已剔除人工误筛）:');
        for (const miss of report.misses) console.log(JSON.stringify(miss));
    }
    process.exitCode = (
        report.adjudicatedPositives > 0
        && report.missed === 0
        && report.historicalFalsePositiveLeaks.length === 0
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

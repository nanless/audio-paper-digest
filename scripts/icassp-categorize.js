#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * ICASSP 2026 论文分类整理
 * 读取深度分析结果，按标签分类统计，生成 Markdown 报告
 *
 * 用法:
 *   node scripts/icassp-categorize.js [input_file] [output_dir]
 *
 * 默认:
 *   input: data/current/icassp-2026-analysis.json
 *   output: data/current/output/icassp-2026-report.md
 */

const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeFileAtomic, getBeijingISOString } = require('./utils.js');

const DEFAULT_INPUT = path.join(__dirname, '..', 'data', 'current', 'icassp-2026-analysis.json');
const DEFAULT_OUTPUT_DIR = path.join(__dirname, '..', 'data', 'current', 'output');

const inputFile = process.argv[2] || DEFAULT_INPUT;
const outputDir = process.argv[3] || DEFAULT_OUTPUT_DIR;

if (!fs.existsSync(inputFile)) {
    console.error(`输入文件不存在: ${inputFile}`);
    process.exit(1);
}

const data = readJsonSafe(inputFile, null);
if (!data) {
    console.error('读取分析结果失败');
    process.exit(1);
}

const papers = data.papers || (Array.isArray(data) ? data : []);
const analyzedPapers = papers.filter(p => p.analysis && p.parsed);

console.log(`总论文数: ${papers.length}`);
console.log(`已分析论文数: ${analyzedPapers.length}`);

if (analyzedPapers.length === 0) {
    console.log('没有已分析的论文，无需分类');
    process.exit(0);
}

// ═══════════════════════════════════════════════════════
// 统计分类
// ═══════════════════════════════════════════════════════

// 1. 按主任务标签分类
const taskTagMap = new Map();
// 2. 按主方法标签分类
const methodTagMap = new Map();
// 3. 按所有标签分类
const allTagMap = new Map();
// 4. 按分档分类
const rankMap = new Map();
// 5. 按评分区间分类
const scoreBuckets = {
    '9.0-10.0 (里程碑)': [],
    '7.5-8.5 (优秀)': [],
    '5.5-7.0 (良好)': [],
    '3.0-5.0 (一般)': [],
    '1.0-2.5 (不推荐)': []
};

for (const p of analyzedPapers) {
    const parsed = p.parsed;
    const score = parseFloat(parsed.score) || 0;

    // 主任务
    const taskTag = parsed.primaryTaskTag || '';
    if (taskTag) {
        if (!taskTagMap.has(taskTag)) taskTagMap.set(taskTag, []);
        taskTagMap.get(taskTag).push(p);
    }

    // 主方法
    const methodTag = parsed.primaryMethodTag || '';
    if (methodTag) {
        if (!methodTagMap.has(methodTag)) methodTagMap.set(methodTag, []);
        methodTagMap.get(methodTag).push(p);
    }

    // 所有标签
    for (const tag of (parsed.tags || [])) {
        if (!allTagMap.has(tag)) allTagMap.set(tag, []);
        allTagMap.get(tag).push(p);
    }

    // 分档
    const rank = parsed.rankBucket || '未分档';
    if (!rankMap.has(rank)) rankMap.set(rank, []);
    rankMap.get(rank).push(p);

    // 评分区间
    if (score >= 9.0) scoreBuckets['9.0-10.0 (里程碑)'].push(p);
    else if (score >= 7.5) scoreBuckets['7.5-8.5 (优秀)'].push(p);
    else if (score >= 5.5) scoreBuckets['5.5-7.0 (良好)'].push(p);
    else if (score >= 3.0) scoreBuckets['3.0-5.0 (一般)'].push(p);
    else scoreBuckets['1.0-2.5 (不推荐)'].push(p);
}

// 排序函数：按评分降序
function sortByScore(list) {
    return [...list].sort((a, b) => {
        const sa = parseFloat(a.parsed?.score) || 0;
        const sb = parseFloat(b.parsed?.score) || 0;
        return sb - sa;
    });
}

// ═══════════════════════════════════════════════════════
// 生成 Markdown 报告
// ═══════════════════════════════════════════════════════

let md = `# ICASSP 2026 论文深度分析与分类报告\n\n`;
md += `生成时间: ${getBeijingISOString()}\n\n`;
md += `## 概览\n\n`;
md += `- 总论文数: **${papers.length}**\n`;
md += `- 已分析论文数: **${analyzedPapers.length}**\n`;
md += `- 平均评分: **${(analyzedPapers.reduce((sum, p) => sum + (parseFloat(p.parsed?.score) || 0), 0) / analyzedPapers.length).toFixed(2)}**\n`;
md += `\n`;

// 评分分布
md += `## 评分分布\n\n`;
for (const [bucket, list] of Object.entries(scoreBuckets)) {
    if (list.length === 0) continue;
    md += `### ${bucket} — ${list.length} 篇\n\n`;
    md += '| # | 论文 | 评分 | 分档 | 主任务 | 主方法 |\n';
    md += '|---|------|------|------|--------|--------|\n';
    const sorted = sortByScore(list);
    for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        const parsed = p.parsed;
        md += `| ${i + 1} | ${p.title} | ${parsed.score} | ${parsed.rankBucket} | ${parsed.primaryTaskTag} | ${parsed.primaryMethodTag} |\n`;
    }
    md += '\n';
}

// 按主任务分类
md += `## 按主任务分类\n\n`;
const sortedTasks = [...taskTagMap.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [tag, list] of sortedTasks) {
    md += `### ${tag} — ${list.length} 篇\n\n`;
    md += '| # | 论文 | 评分 | 分档 | 主方法 | 毒舌点评 |\n';
    md += '|---|------|------|------|--------|----------|\n';
    const sorted = sortByScore(list);
    for (let i = 0; i < Math.min(sorted.length, 50); i++) {
        const p = sorted[i];
        const parsed = p.parsed;
        const roast = (parsed.roast || '').replace(/\n/g, ' ').substring(0, 80);
        md += `| ${i + 1} | ${p.title.substring(0, 60)}${p.title.length > 60 ? '...' : ''} | ${parsed.score} | ${parsed.rankBucket} | ${parsed.primaryMethodTag} | ${roast}${parsed.roast?.length > 80 ? '...' : ''} |\n`;
    }
    if (sorted.length > 50) {
        md += `| ... | 还有 ${sorted.length - 50} 篇 | | | | |\n`;
    }
    md += '\n';
}

// 按主方法分类
md += `## 按主方法分类\n\n`;
const sortedMethods = [...methodTagMap.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [tag, list] of sortedMethods) {
    md += `### ${tag} — ${list.length} 篇\n\n`;
    md += '| # | 论文 | 评分 | 分档 | 主任务 |\n';
    md += '|---|------|------|------|--------|\n';
    const sorted = sortByScore(list);
    for (let i = 0; i < Math.min(sorted.length, 30); i++) {
        const p = sorted[i];
        const parsed = p.parsed;
        md += `| ${i + 1} | ${p.title.substring(0, 60)}${p.title.length > 60 ? '...' : ''} | ${parsed.score} | ${parsed.rankBucket} | ${parsed.primaryTaskTag} |\n`;
    }
    if (sorted.length > 30) {
        md += `| ... | 还有 ${sorted.length - 30} 篇 | | | |\n`;
    }
    md += '\n';
}

// 按分档分类
md += `## 按分档分类\n\n`;
const sortedRanks = [...rankMap.entries()].sort((a, b) => {
    const order = { '前10%': 0, '前25%': 1, '前50%': 2, '后50%': 3, '未分档': 4 };
    return (order[a[0]] ?? 5) - (order[b[0]] ?? 5);
});
for (const [rank, list] of sortedRanks) {
    md += `### ${rank} — ${list.length} 篇\n\n`;
    md += '| # | 论文 | 评分 | 主任务 | 主方法 |\n';
    md += '|---|------|------|--------|--------|\n';
    const sorted = sortByScore(list);
    for (let i = 0; i < Math.min(sorted.length, 30); i++) {
        const p = sorted[i];
        const parsed = p.parsed;
        md += `| ${i + 1} | ${p.title.substring(0, 60)}${p.title.length > 60 ? '...' : ''} | ${parsed.score} | ${parsed.primaryTaskTag} | ${parsed.primaryMethodTag} |\n`;
    }
    if (sorted.length > 30) {
        md += `| ... | 还有 ${sorted.length - 30} 篇 | | | |\n`;
    }
    md += '\n';
}

// 标签云/统计
md += `## 标签统计\n\n`;
md += '| 标签 | 出现次数 | 平均评分 |\n';
md += '|------|----------|----------|\n';
const sortedAllTags = [...allTagMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .filter(([tag]) => tag.startsWith('#'));
for (const [tag, list] of sortedAllTags) {
    const avgScore = (list.reduce((sum, p) => sum + (parseFloat(p.parsed?.score) || 0), 0) / list.length).toFixed(2);
    md += `| ${tag} | ${list.length} | ${avgScore} |\n`;
}
md += '\n';

// 完整列表（附录）
md += `## 完整论文列表\n\n`;
md += '| # | arnumber | 论文 | 评分 | 分档 | 标签 |\n';
md += '|---|----------|------|------|------|------|\n';
const allSorted = sortByScore(analyzedPapers);
for (let i = 0; i < allSorted.length; i++) {
    const p = allSorted[i];
    const parsed = p.parsed;
    const tags = (parsed.tags || []).slice(0, 5).join(' ');
    md += `| ${i + 1} | ${p.arnumber || p.paper_id || ''} | ${p.title.substring(0, 50)}${p.title.length > 50 ? '...' : ''} | ${parsed.score} | ${parsed.rankBucket} | ${tags} |\n`;
}
md += '\n';

// ═══════════════════════════════════════════════════════
// 保存报告
// ═══════════════════════════════════════════════════════

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

const outputFile = path.join(outputDir, 'icassp-2026-report.md');
writeFileAtomic(outputFile, md);
console.log(`\n报告已保存到: ${outputFile}`);
console.log(`  - 总论文: ${papers.length}`);
console.log(`  - 已分析: ${analyzedPapers.length}`);
console.log(`  - 主任务分类: ${taskTagMap.size} 个`);
console.log(`  - 主方法分类: ${methodTagMap.size} 个`);
console.log(`  - 标签总数: ${allTagMap.size} 个`);

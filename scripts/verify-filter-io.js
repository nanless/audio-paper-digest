#!/usr/bin/env node
/**
 * 批量验证所有筛选输入输出文件
 */

const fs = require('fs');
const path = require('path');

const IO_DIR = '/Users/francis7999/code/github_repos/audio-paper-digest/data/current/filter_input_output';
const PAPERS_JSON = '/Users/francis7999/Documents/icassp-2026-papers/papers_2026.json';

const papers = JSON.parse(fs.readFileSync(PAPERS_JSON, 'utf8'));
const paperMap = new Map();
for (const p of papers) {
    paperMap.set(String(p.arnumber), p);
}

const files = fs.readdirSync(IO_DIR).filter(f => f.endsWith('.json'));
console.log(`IO 文件总数: ${files.length}`);
console.log('');

const issues = {
    titleMismatch: [],
    abstractEmpty: [],
    promptTooShort: [],
    outputNotYesNo: [],
    outputEmpty: [],
    paperIdNotFound: [],
    fileUnreadable: []
};

let checked = 0;

for (const file of files) {
    const paperId = file.replace('.json', '');
    const paper = paperMap.get(paperId);

    if (!paper) {
        issues.paperIdNotFound.push(paperId);
        continue;
    }

    let io;
    try {
        io = JSON.parse(fs.readFileSync(path.join(IO_DIR, file), 'utf8'));
    } catch (e) {
        issues.fileUnreadable.push(paperId);
        continue;
    }

    // 检查输入
    const prompt = io.input?.prompt || '';

    // 从 prompt 中提取标题
    const titleMatch = prompt.match(/论文标题：(.+?)(?:\n|$)/);
    const promptTitle = titleMatch ? titleMatch[1].trim() : '';

    // 检查标题是否匹配
    if (promptTitle !== paper.title) {
        issues.titleMismatch.push({
            paperId,
            jsonTitle: paper.title,
            promptTitle,
            similarity: promptTitle.substring(0, 60) === paper.title.substring(0, 60) ? '前60字符相同' : '完全不同'
        });
    }

    // 检查摘要是否为空
    const abstractMatch = prompt.match(/论文摘要：([\s\S]+?)(?:\n\n判断标准)/);
    const abstract = abstractMatch ? abstractMatch[1].trim() : '';
    if (abstract.length < 50) {
        issues.abstractEmpty.push({ paperId, title: paper.title, abstractLen: abstract.length });
    }

    // 检查 prompt 长度
    if (prompt.length < 500) {
        issues.promptTooShort.push({ paperId, title: paper.title, promptLen: prompt.length });
    }

    // 检查输出
    const content = io.output?.parsedContent;
    if (content === null || content === undefined || content === '') {
        issues.outputEmpty.push({ paperId, title: paper.title });
    } else if (!/^(是|否)$/s.test(content.trim())) {
        issues.outputNotYesNo.push({ paperId, title: paper.title, content: String(content).substring(0, 100) });
    }

    checked++;
}

console.log(`成功检查: ${checked}/${files.length}`);
console.log('');

// 报告问题
function reportIssue(name, list, maxShow = 10) {
    console.log(`=== ${name}: ${list.length} 篇 ===`);
    if (list.length === 0) {
        console.log('无问题');
    } else {
        for (const item of list.slice(0, maxShow)) {
            if (typeof item === 'string') {
                console.log(`  - ${item}`);
            } else {
                console.log(`  - ${item.paperId} | ${(item.title || '').substring(0, 60)}${item.content ? ' | 输出: ' + item.content : ''}${item.abstractLen !== undefined ? ' | 摘要长度: ' + item.abstractLen : ''}${item.promptLen !== undefined ? ' | prompt长度: ' + item.promptLen : ''}`);
            }
        }
        if (list.length > maxShow) {
            console.log(`  ... 还有 ${list.length - maxShow} 篇`);
        }
    }
    console.log('');
}

reportIssue('标题不匹配 (paper_id 映射错误)', issues.titleMismatch);
reportIssue('摘要过短 (<50字符)', issues.abstractEmpty);
reportIssue('prompt 过短 (<500字符)', issues.promptTooShort);
reportIssue('输出为空', issues.outputEmpty);
reportIssue('输出非"是/否"', issues.outputNotYesNo);
reportIssue('paper_id 在论文集中未找到', issues.paperIdNotFound);
reportIssue('文件无法读取', issues.fileUnreadable);

// 统计输出分布
const included = [];
const excluded = [];
for (const file of files) {
    try {
        const io = JSON.parse(fs.readFileSync(path.join(IO_DIR, file), 'utf8'));
        const content = io.output?.parsedContent;
        const paperId = file.replace('.json', '');
        if (content === '是') included.push(paperId);
        else if (content === '否') excluded.push(paperId);
    } catch (e) {}
}
console.log('=== 筛选结果统计 ===');
console.log(`保留: ${included.length}`);
console.log(`排除: ${excluded.length}`);
console.log(`异常: ${files.length - included.length - excluded.length}`);

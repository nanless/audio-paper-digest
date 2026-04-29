#!/usr/bin/env node
/**
 * 文本-only 重新分析（跳过图片，避免 API 安全过滤）
 */
const fs = require('fs');
const path = require('path');
const { callModel, parseAnalysis } = require('./deep-analyzer.js');
const Config = require('./config.js');
const { loadPrompt, getBeijingISOString } = require('./utils.js');

const DATA_FILE = path.join(Config.CURRENT_DIR, 'icassp_2026_deep_analyzers.json');
const DEEP_CONFIG = require('./config.js').ANALYSIS_CONFIG;

async function analyzeTextOnly(paper) {
    const paperId = paper.arnumber || paper.paper_id;
    const textForAnalysis = paper.fullText
        ? paper.fullText.substring(0, 15000)
        : (paper.abstract || paper.summary || '');

    const paperInfo = `论文ID: ${paperId}\n来源: ICASSP 2026 本地PDF`;

    const prompt = loadPrompt('prompts/deep-analysis.md', {
        hasFullText: paper.fullText ? '以下是论文全文，请仔细阅读所有技术细节。' : '以下是论文摘要。',
        title: paper.title,
        authors: Array.isArray(paper.authors) ? paper.authors.join(', ') : (paper.authors || '未知'),
        categories: Array.isArray(paper.categories) ? paper.categories.join(', ') : (paper.categories || '未知'),
        paperInfo: paperInfo,
        textForAnalysis: textForAnalysis
    });

    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    const analysis = await callModel(messages, 32000);
    return analysis;
}

async function main() {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const paper = data.papers.find(p => p.arnumber === '11463033');
    if (!paper) {
        console.log('Paper not found');
        return;
    }

    console.log(`[retry-text] 文本-only 分析: ${paper.arnumber}`);
    try {
        const analysis = await analyzeTextOnly(paper);
        if (typeof analysis === 'string' && analysis.includes('rejected')) {
            console.log(`[retry-text] ⚠️ API 拒绝: ${analysis}`);
        } else {
            const parsed = parseAnalysis(analysis);
            if (parsed && parsed.score) {
                paper.analysis = analysis;
                paper.parsed = parsed;
                console.log(`[retry-text] ✅ 评分 ${parsed.score}/10`);
                fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
            } else {
                console.log(`[retry-text] ⚠️ 无评分`);
            }
        }
    } catch (e) {
        console.log(`[retry-text] ❌ ${e.message}`);
    }
}

main().catch(console.error);

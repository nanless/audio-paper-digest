#!/usr/bin/env node
/**
 * 测试筛选逻辑：手动跑几篇论文，检查 LLM 输入输出
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const {
    writeFileAtomic, readJsonSafe, getBeijingISOString,
    loadPrompt, loadEnvFile, detectApiType, buildApiUrl,
    buildRequestBody, buildHeaders, parseResponseText
} = require('./utils.js');
const { extractPdfContent } = require('./deep-analyzer.js');
const Config = require('./config.js');

loadEnvFile();

const PAPERS_DIR = '/Users/francis7999/Documents/icassp-2026-papers/papers_2026';
const JSON_FILE = '/Users/francis7999/Documents/icassp-2026-papers/papers_2026.json';
const FILTER_IO_DIR = path.join(Config.CURRENT_DIR, 'filter_input_output');

const FILTER_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || ''
};

const TEST_PAPERS = [
    { arnumber: '11460678', title: 'BSMP-SENet:Band-Split Magnitude-Phase Network for Speech Enhancement' },
    { arnumber: '11463775', title: 'LipsAM: Lipschitz-Continuous Amplitude Modifier for Audio Signal Processing and its Application to Plug-And-Play Dereverberation' },
    { arnumber: '11465005', title: 'MR-FlowDPO: Multi-Reward Direct Preference Optimization for Flow-Matching Text-to-Music Generation' },
    { arnumber: '11461379', title: 'Learning Latent Space for Multi-Order / Resolution Graph-Regularized Image Denoiser' },
    { arnumber: '11461599', title: 'Learning Graph from Smooth Signals under Partial Observation: A Robustness Analysis' },
    { arnumber: '11464104', title: 'An Exact Penalty Method for Sparsity-Constrained Optimization' }
];

function normalizeForFilename(title) {
    return title.replace(/[^\w\s]/g, '').trim();
}

async function extractPdfSnippet(pdfPath, maxChars = 5000) {
    try {
        const result = await extractPdfContent(pdfPath);
        return result.text ? result.text.substring(0, maxChars) : '';
    } catch (e) {
        return '';
    }
}

function buildPdfPath(paper) {
    const norm = normalizeForFilename(paper.title).toLowerCase();
    const pdfs = fs.readdirSync(PAPERS_DIR).filter(f => f.endsWith('.pdf'));
    for (const f of pdfs) {
        const fnorm = normalizeForFilename(f.replace(/\.pdf$/, '')).toLowerCase();
        if (fnorm === norm) {
            return path.join(PAPERS_DIR, f);
        }
    }
    return null;
}

function llmFilterCall(url, apiType, config, prompt, paperId) {
    return new Promise((resolve, reject) => {
        const messages = [{ role: 'user', content: prompt }];
        const bodyObj = buildRequestBody(apiType, config.model, messages, 2000, 0.3);
        const postData = JSON.stringify(bodyObj);
        const headers = { ...buildHeaders(apiType, config.key, postData) };

        const req = https.request({
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers, timeout: 60000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    const content = parseResponseText(apiType, response);
                    // 保存输入输出
                    if (paperId) {
                        const ioFile = path.join(FILTER_IO_DIR, `${paperId}.json`);
                        writeFileAtomic(ioFile, JSON.stringify({
                            paperId, timestamp: getBeijingISOString(),
                            input: { prompt, messages },
                            output: { statusCode: res.statusCode, rawResponse: response, parsedContent: content }
                        }, null, 2));
                    }
                    if (content !== null) {
                        const isRelevant = /是|yes|y/i.test(content) && !/否|no|n/i.test(content);
                        resolve({ isRelevant, raw: content });
                    } else {
                        reject(new Error('Invalid response'));
                    }
                } catch (e) {
                    reject(new Error('Parse error: ' + e.message));
                }
            });
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(postData);
        req.end();
    });
}

async function testFilter() {
    if (!fs.existsSync(FILTER_IO_DIR)) {
        fs.mkdirSync(FILTER_IO_DIR, { recursive: true });
    }

    const apiType = detectApiType(FILTER_CONFIG.endpoint, FILTER_CONFIG.model);
    const modelUrl = buildApiUrl(apiType, FILTER_CONFIG.endpoint);
    const url = new URL(modelUrl);

    console.log('=== 筛选测试 ===');
    console.log(`模型: ${FILTER_CONFIG.model} | API: ${apiType}`);
    console.log('');

    for (const paper of TEST_PAPERS) {
        const pdfPath = buildPdfPath(paper);
        const snippet = pdfPath ? await extractPdfSnippet(pdfPath, 3000) : '';
        const abstract = snippet.substring(0, 2000);

        const prompt = loadPrompt('prompts/filter.md', {
            title: paper.title,
            abstract: abstract || '(无摘要)'
        });

        try {
            const result = await llmFilterCall(url, apiType, FILTER_CONFIG, prompt, paper.arnumber);
            const status = result.isRelevant ? '✅ 保留' : '❌ 排除';
            console.log(`${status} | ${paper.arnumber} | ${paper.title}`);
            console.log(`   LLM 输出: "${result.raw}"`);
        } catch (err) {
            console.log(`💥 失败 | ${paper.arnumber} | ${err.message}`);
        }
        console.log('');
    }

    console.log(`输入输出已保存到: ${FILTER_IO_DIR}`);
}

testFilter().catch(console.error);

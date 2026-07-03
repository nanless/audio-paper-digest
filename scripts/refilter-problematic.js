#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const {
    writeFileAtomic, getBeijingISOString,
    loadPrompt, loadEnvFile, detectApiType, buildApiUrl,
    buildRequestBody, buildHeaders, parseResponseText
} = require('./utils.js');

loadEnvFile();

const FILTER_IO_DIR = path.join(__dirname, '..', 'data', 'current', 'filter_input_output');
const FILTER_CONFIG = {
    endpoint: process.env.PAPER_ANALYZER_ENDPOINT || '',
    key: process.env.PAPER_ANALYZER_API_KEY || '',
    model: process.env.PAPER_ANALYZER_MODEL || ''
};

const PAPERS_JSON = process.env.ICASSP_JSON_FILE || path.join(os.homedir(), 'Documents/icassp-2026-papers/papers_2026.json');
const papers = JSON.parse(fs.readFileSync(PAPERS_JSON, 'utf8'));

const SNIPPETS_FILE = path.join(__dirname, '..', 'data', 'current', 'icassp-2026-snippets.json');
const snippetsData = JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf8'));
const snippetMap = new Map();
for (const s of snippetsData.papers) {
    snippetMap.set(s.paper_id, s.snippet);
}

async function filterSingle(paper) {
    const apiType = detectApiType(FILTER_CONFIG.endpoint, FILTER_CONFIG.model);
    const modelUrl = buildApiUrl(apiType, FILTER_CONFIG.endpoint);
    const url = new URL(modelUrl);
    const abstract = (snippetMap.get(paper.arnumber) || '').substring(0, 2000);
    const prompt = loadPrompt('prompts/filter.md', {
        title: paper.title || '(无标题)',
        abstract: abstract || '(无摘要)'
    });
    const paperId = paper.arnumber;

    return new Promise((resolve, reject) => {
        const messages = [{ role: 'user', content: prompt }];
        const bodyObj = buildRequestBody(apiType, FILTER_CONFIG.model, messages, 2000, 0.3);
        const postData = JSON.stringify(bodyObj);
        const headers = { ...buildHeaders(apiType, FILTER_CONFIG.key, postData) };

        const req = https.request({
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers, timeout: 60000
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf8');
                try {
                    const response = JSON.parse(data);
                    const content = parseResponseText(apiType, response);
                    // Save IO
                    const ioFile = path.join(FILTER_IO_DIR, `${paperId}.json`);
                    writeFileAtomic(ioFile, JSON.stringify({
                        paperId, timestamp: getBeijingISOString(),
                        input: { prompt, messages },
                        output: { statusCode: res.statusCode, rawResponse: response, parsedContent: content }
                    }, null, 2));
                    // Validate
                    if (response.error || (content && /rejected|error|invalid/i.test(content))) {
                        reject(new Error('API error: ' + (response.error?.message || content)));
                        return;
                    }
                    if (content !== null) {
                        const trimmed = content.trim();
                        if (!/^(是|否|yes|no)$/i.test(trimmed)) {
                            reject(new Error('Unexpected response: ' + trimmed.substring(0, 100)));
                            return;
                        }
                        const isRelevant = /^(是|yes)$/i.test(trimmed);
                        resolve({ paper, isRelevant, raw: trimmed });
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

async function main() {
    const ids = ['11462621', '11461539', '11462752'];
    for (const id of ids) {
        const paper = papers.find(p => p.arnumber === id);
        if (!paper) { console.log(id + ' | paper not found'); continue; }
        try {
            const result = await filterSingle(paper);
            console.log((result.isRelevant ? '✅ 保留' : '❌ 排除') + ' | ' + id + ' | ' + paper.title);
        } catch (err) {
            console.log('💥 失败 | ' + id + ' | ' + err.message);
        }
    }
}

main().catch(console.error);

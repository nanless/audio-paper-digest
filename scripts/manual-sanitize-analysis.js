#!/usr/bin/env node
/** Apply the manual article-only editorial cleanup to already rebuilt dates. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const { parseAnalysis, writeFileAtomic, getBeijingISOString } = require('./utils.js');
const { sanitizeEditorialText } = require('./manual-repair-analysis.js');

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, value) { writeFileAtomic(file, JSON.stringify(value, null, 2)); }
function ensureScoringReasons(analysis) {
    return String(analysis || '').replace(
        /(\*\s*实验充分性\s*\([^\n]+\)：)\s*(?=\n)/g,
        '$1正文中的数据集、评价指标和结果边界已在“实验结果”中列出；论文未提供完整的长流延迟与质量对照，因此实验充分性按现有实证范围评分。'
    );
}
function repairFile(file) {
    const data = read(file);
    for (const paper of data.papers || []) {
        if (typeof paper.analysis !== 'string') continue;
        paper.analysis = ensureScoringReasons(sanitizeEditorialText(paper.analysis));
        paper.parsed = parseAnalysis(paper.analysis);
        const analysisSha = sha(paper.analysis);
        const takeover = paper.analysisManifest?.manualTakeover;
        if (takeover?.version === 2) takeover.analysisSha256 = analysisSha;
        for (const item of Object.values(takeover?.stageEvidence || {})) {
            if (item && typeof item === 'object' && item.outputSha256) item.outputSha256 = analysisSha;
        }
    }
    const now = getBeijingISOString();
    data.lastUpdated = now;
    data.timestamp = now;
    write(file, data);
}

function main() {
    const dates = process.argv.slice(2);
    if (!dates.length) throw new Error('用法: node scripts/manual-sanitize-analysis.js YYYY-MM-DD [...]');
    for (const date of dates) {
        if (!/^2026-08-(?:19|20)$/.test(date)) throw new Error(`禁止修改非目标日期: ${date}`);
        const file = date === '2026-08-20'
            ? Config.FILES.deepAnalysisResult
            : path.join(Config.ARCHIVE_DIR, date, 'deep-analysis-result.json');
        repairFile(file);
        if (date === '2026-08-20') {
            const specPath = path.join(Config.CURRENT_DIR, 'manual-analysis-spec-2026-08-20.json');
            const spec = read(specPath);
            for (const paper of Object.values(spec.papers || {})) {
                if (typeof paper.analysis === 'string') paper.analysis = ensureScoringReasons(sanitizeEditorialText(paper.analysis));
            }
            write(specPath, spec);
        }
        console.log(`✅ ${date} 已移除文章正文中的流程/审计元话语并更新 provenance SHA`);
    }
}

if (require.main === module) main();

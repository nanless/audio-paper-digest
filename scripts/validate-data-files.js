#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Config = require('./config.js');
const { readJsonSafe, normalizedId } = require('./utils.js');

const ALLOWED_DIGEST_STATUSES = new Set(['seen', 'pending_analysis', 'analyzed', 'analysis_failed']);

function addIssue(issues, file, message) {
    issues.push(`${path.basename(file)}: ${message}`);
}

function ensurePaperId(paper, file, index, issues) {
    const id = normalizedId(paper);
    if (!id) {
        addIssue(issues, file, `papers[${index}] 缺少可识别的 arxivId/paper_id`);
    }
    return id;
}

function validatePapersDatabase(filePath = Config.FILES.papers) {
    const issues = [];
    if (!fs.existsSync(filePath)) return issues;

    const data = readJsonSafe(filePath, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        addIssue(issues, filePath, '根对象必须是 { papers, lastUpdated }');
        return issues;
    }
    if (!data.papers || typeof data.papers !== 'object' || Array.isArray(data.papers)) {
        addIssue(issues, filePath, 'papers 必须是对象映射');
        return issues;
    }

    for (const [key, paper] of Object.entries(data.papers)) {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            addIssue(issues, filePath, `${key} 不是论文对象`);
            continue;
        }
        const id = normalizedId(paper) || normalizedId(key);
        if (!id) addIssue(issues, filePath, `${key} 缺少可识别 ID`);
        const status = paper.digestStatus?.status;
        if (status && !ALLOWED_DIGEST_STATUSES.has(status)) {
            addIssue(issues, filePath, `${key} digestStatus.status 非法: ${status}`);
        }
    }
    return issues;
}

function validateSourceHealth(filePath, sourceHealth, issues) {
    if (!sourceHealth || typeof sourceHealth !== 'object') return;
    const categories = sourceHealth.arxiv?.categories;
    if (categories !== undefined && !Array.isArray(categories)) {
        addIssue(issues, filePath, 'sourceHealth.arxiv.categories 必须是数组');
    }
    const hfOk = sourceHealth.huggingface?.ok;
    if (hfOk !== undefined && typeof hfOk !== 'boolean') {
        addIssue(issues, filePath, 'sourceHealth.huggingface.ok 必须是布尔值');
    }
}

function validatePaperListFile(filePath, options = {}) {
    const issues = [];
    if (!fs.existsSync(filePath)) return issues;

    const data = readJsonSafe(filePath, null);
    if (!data) {
        addIssue(issues, filePath, 'JSON 无法解析');
        return issues;
    }

    const papers = Array.isArray(data) ? data : data.papers;
    if (!Array.isArray(papers)) {
        addIssue(issues, filePath, 'papers 必须是数组');
        return issues;
    }

    if (!Array.isArray(data)) {
        validateSourceHealth(filePath, data.sourceHealth || data.stats?.sourceHealth, issues);
    }

    papers.forEach((paper, index) => {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            addIssue(issues, filePath, `papers[${index}] 不是论文对象`);
            return;
        }
        ensurePaperId(paper, filePath, index, issues);
        if (options.deepAnalysis) {
            if (paper.parsed?.score !== undefined) {
                const score = Number(paper.parsed.score);
                if (!Number.isFinite(score) || score < 0 || score > 10) {
                    addIssue(issues, filePath, `papers[${index}] parsed.score 非法: ${paper.parsed.score}`);
                }
            }
            for (const key of ['selectedImageUrls', 'imageUrls', 'allImageUrls']) {
                if (paper[key] !== undefined && !Array.isArray(paper[key])) {
                    addIssue(issues, filePath, `papers[${index}].${key} 必须是数组`);
                }
            }
            if (paper.imageManifest !== undefined && paper.imageManifest !== null && typeof paper.imageManifest !== 'object') {
                addIssue(issues, filePath, `papers[${index}].imageManifest 必须是对象或 null`);
            }
        }
    });

    return issues;
}

function validateCurrentDataFiles(files = Config.FILES) {
    return [
        ...validatePapersDatabase(files.papers),
        ...validatePaperListFile(files.filteredPapers),
        ...validatePaperListFile(files.deepAnalysisResult, { deepAnalysis: true })
    ];
}

function main() {
    const issues = validateCurrentDataFiles();
    if (issues.length > 0) {
        console.error('数据文件校验失败:');
        for (const issue of issues) {
            console.error(`  - ${issue}`);
        }
        process.exit(1);
    }
    console.log('数据文件校验通过');
}

if (require.main === module) {
    main();
}

module.exports = {
    validatePapersDatabase,
    validatePaperListFile,
    validateCurrentDataFiles,
    validateSourceHealth
};

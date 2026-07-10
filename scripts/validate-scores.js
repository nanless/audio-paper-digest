#!/usr/bin/env node
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

/**
 * 验证并修复论文评分
 * 检查：子项越界、总分一致性、开源矛盾
 */

const {
    parseAnalysis,
    writeFileAtomic,
    readJsonSafe,
    normalizeScoreToOneDecimal,
    isOpenSourceScoreAnchor,
    OPEN_SOURCE_SCORE_ANCHORS
} = require('./utils.js');
const Config = require('./config.js');

const DIM_MAX = {
    innovationScore: 2,
    technicalRigorScore: 1.5,
    experimentalSufficiencyScore: 1.5,
    clarityScore: 1,
    impactScore: 1.5,
    openSourceScore: 1.5,
    reproducibilityScore: 0.5,
    engineeringScore: 1.5
};

function numericScore(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) && Number.isInteger(value * 10) ? value : Number.NaN;
    }
    if (typeof value !== 'string' || !/^-?\d+(?:\.\d)?$/.test(value.trim())) return Number.NaN;
    return Number(value);
}

function validateAndFix(papers) {
    let fixedCount = 0;
    const issues = [];

    papers.forEach((p, idx) => {
        if (!p.analysis) return;

        const oldParsed = p.parsed;
        const freshParsed = parseAnalysis(p.analysis);
        const paperIssues = [];
        const sourceValidation = freshParsed?.scoreValidation;
        const sourceIssues = sourceValidation?.valid
            ? getParsedScoreIssues(freshParsed)
            : (sourceValidation?.errors || ['analysis 无法解析出合法八维评分'])
                .map(message => `源分析评分非法: ${message}`);

        if (sourceIssues.length > 0) {
            paperIssues.push(...sourceIssues);
        } else {
            const cacheIssues = getParsedScoreIssues(oldParsed);
            paperIssues.push(...cacheIssues.map(message => `缓存非法: ${message}`));
            if (!sameScoringSnapshot(oldParsed, freshParsed)) {
                paperIssues.push('评分缓存与 analysis 重解析结果不一致');
            }
        }

        if (paperIssues.length === 0) return;

        let stillHasIssues = sourceIssues.length > 0;
        if (!stillHasIssues) {
            p.parsed = freshParsed;
            fixedCount++;
            stillHasIssues = getParsedScoreIssues(p.parsed).length > 0;
        }

        issues.push({
            idx: idx + 1,
            title: p.title?.substring(0, 40),
            arxivId: p.arxivId,
            oldScore: oldParsed?.score,
            newScore: p.parsed?.score,
            oldIssues: paperIssues,
            stillHasIssues
        });
    });

    return {
        fixedCount,
        issues,
        remainingIssueCount: issues.filter(issue => issue.stillHasIssues).length
    };
}

function getParsedScoreIssues(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return ['缺少 parsed 评分缓存'];
    }

    const issues = [];
    const values = [];
    for (const [key, max] of Object.entries(DIM_MAX)) {
        if (parsed[key] === undefined || parsed[key] === '') {
            issues.push(`缺少子项: ${key}`);
            continue;
        }
        const value = numericScore(parsed[key]);
        if (!Number.isFinite(value) || value < 0 || value > max) {
            issues.push(`子项非法: ${key}=${parsed[key]} (范围 0-${max}，最多一位小数)`);
            continue;
        }
        if (key === 'openSourceScore' && !isOpenSourceScoreAnchor(value)) {
            issues.push(`子项非法: ${key}=${parsed[key]} (固定锚点 ${OPEN_SOURCE_SCORE_ANCHORS.join('/')})`);
            continue;
        }
        values.push(normalizeScoreToOneDecimal(value));
    }

    const actualTotal = numericScore(parsed.score);
    if (parsed.score === undefined || parsed.score === '' || !Number.isFinite(actualTotal) || actualTotal < 0 || actualTotal > 10) {
        issues.push(`总分非法: ${parsed.score}`);
    } else if (values.length === Object.keys(DIM_MAX).length) {
        const subtotal = values.reduce((sum, value) => sum + value, 0);
        const expectedTotal = normalizeScoreToOneDecimal(Math.min(10, subtotal));
        if (Math.abs(expectedTotal - actualTotal) > 0.01) {
            issues.push(`总分不一致: 子项和=${subtotal.toFixed(1)} 期望=${expectedTotal} 实际=${actualTotal}`);
        }
    }

    const openScore = numericScore(parsed.openSourceScore);
    const hasResource = [parsed.hasCode, parsed.hasModel, parsed.hasDataset]
        .some(value => value === '是' || value === 'yes');
    if (parsed.documentType !== '理论研究' && Number.isFinite(openScore) && openScore >= 1 && !hasResource) {
        issues.push(`开源矛盾: ${openScore}分但无代码、模型或数据资源`);
    }
    return issues;
}

function sameScoringSnapshot(left, right) {
    if (!left || !right) return false;
    const fields = ['score', 'documentType', ...Object.keys(DIM_MAX), 'hasCode', 'hasModel', 'hasDataset'];
    return fields.every(field => {
        if (field === 'documentType' || field === 'hasCode' || field === 'hasModel' || field === 'hasDataset') {
            return String(left[field] || '') === String(right[field] || '');
        }
        const leftValue = numericScore(left[field]);
        const rightValue = numericScore(right[field]);
        return Number.isFinite(leftValue) && Number.isFinite(rightValue) && Math.abs(leftValue - rightValue) <= 0.01;
    });
}

// 主入口
if (require.main === module) {
    const dataFile = process.argv[2] || Config.FILES.deepAnalysisResult;
    const data = readJsonSafe(dataFile);
    if (!data || !data.papers) {
        console.error('无法读取数据文件:', dataFile);
        process.exit(1);
    }

    console.log(`[validate] 验证 ${data.papers.length} 篇论文...`);
    const { fixedCount, issues, remainingIssueCount } = validateAndFix(data.papers);

    if (fixedCount > 0) {
        writeFileAtomic(dataFile, JSON.stringify(data, null, 2));
        console.log(`[validate] 已修复 ${fixedCount} 篇`);
    }

    if (issues.length > 0) {
        console.log('');
        issues.forEach(iss => {
            const status = iss.stillHasIssues ? '⚠️ 仍有问题' : '✅ 已修复';
            console.log(`  ${iss.idx}. ${iss.title} | ${iss.arxivId} | ${status}`);
            console.log(`     旧总分: ${iss.oldScore} -> 新总分: ${iss.newScore}`);
            iss.oldIssues.forEach(i => console.log(`     ⚠️ ${i}`));
        });
    } else {
        console.log('[validate] ✅ 所有论文评分正确');
    }

    console.log(`[validate] 剩余问题论文: ${remainingIssueCount}`);
    process.exit(remainingIssueCount > 0 ? 1 : 0);
}

module.exports = { validateAndFix, getParsedScoreIssues, sameScoringSnapshot, DIM_MAX };

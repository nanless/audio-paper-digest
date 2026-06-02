#!/usr/bin/env node
/**
 * 验证并修复论文评分
 * 检查：子项越界、总分一致性、开源矛盾
 */

const fs = require('fs');
const path = require('path');
const { parseAnalysis, writeFileAtomic, readJsonSafe } = require('./utils.js');

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

function validateAndFix(papers) {
    let fixedCount = 0;
    const issues = [];

    papers.forEach((p, idx) => {
        if (!p.analysis) return;

        const pa = p.parsed;
        if (!pa) return;

        const paperIssues = [];
        let needsReparse = false;

        // 1. 检查子项越界
        for (const [key, max] of Object.entries(DIM_MAX)) {
            const val = parseFloat(pa[key] || 0);
            if (val > max + 0.01) {
                paperIssues.push(`子项越界: ${key}=${val} (上限${max})`);
                needsReparse = true;
            }
        }

        // 2. 检查开源矛盾：高分但无链接
        const openScore = parseFloat(pa.openSourceScore || 0);
        const hasCode = pa.hasCode === '是' || pa.hasCode === 'yes';
        const hasModel = pa.hasModel === '是' || pa.hasModel === 'yes';
        const hasDataset = pa.hasDataset === '是' || pa.hasDataset === 'yes';
        if (openScore >= 1.0 && !hasCode && !hasModel && !hasDataset) {
            paperIssues.push(`开源矛盾: ${openScore}分但无链接`);
            needsReparse = true;
        }

        // 3. 检查总分与子项之和一致性
        const subtotal = Object.keys(DIM_MAX).reduce((sum, k) => sum + parseFloat(pa[k] || 0), 0);
        const expectedTotal = Math.round(Math.min(10, Math.max(1, subtotal)) * 10) / 10;
        const actualTotal = parseFloat(pa.score || 0);
        if (Math.abs(expectedTotal - actualTotal) > 0.15) {
            paperIssues.push(`总分不一致: 子项和=${subtotal.toFixed(1)} 期望=${expectedTotal} 实际=${actualTotal}`);
            needsReparse = true;
        }

        // 4. 重新解析（如果有问题）
        if (needsReparse) {
            const newParsed = parseAnalysis(p.analysis);
            if (newParsed) {
                p.parsed = newParsed;
                fixedCount++;

                // 检查修复后是否还有问题
                const newSubtotal = Object.keys(DIM_MAX).reduce((sum, k) => sum + parseFloat(newParsed[k] || 0), 0);
                const newExpected = Math.round(Math.min(10, Math.max(1, newSubtotal)) * 10) / 10;
                const newActual = parseFloat(newParsed.score || 0);

                issues.push({
                    idx: idx + 1,
                    title: p.title?.substring(0, 40),
                    arxivId: p.arxivId,
                    oldScore: pa.score,
                    newScore: newParsed.score,
                    oldIssues: paperIssues,
                    stillHasIssues: Math.abs(newExpected - newActual) > 0.15
                });
            }
        }
    });

    return { fixedCount, issues };
}

// 主入口
if (require.main === module) {
    const dataFile = process.argv[2] || path.join(__dirname, '..', 'data', 'current', 'deep-analysis-result.json');
    const data = readJsonSafe(dataFile);
    if (!data || !data.papers) {
        console.error('无法读取数据文件:', dataFile);
        process.exit(1);
    }

    console.log(`[validate] 验证 ${data.papers.length} 篇论文...`);
    const { fixedCount, issues } = validateAndFix(data.papers);

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

    // 输出统计
    const dimMax = DIM_MAX;
    let totalIssues = 0;
    data.papers.forEach(p => {
        const pa = p.parsed;
        if (!pa) return;
        for (const [k, max] of Object.entries(dimMax)) {
            if (parseFloat(pa[k] || 0) > max + 0.01) totalIssues++;
        }
        const sub = Object.keys(dimMax).reduce((s,k) => s + parseFloat(pa[k]||0), 0);
        const exp = Math.round(Math.min(10, Math.max(1, sub)) * 10) / 10;
        if (Math.abs(exp - parseFloat(pa.score||0)) > 0.15) totalIssues++;
        const os = parseFloat(pa.openSourceScore || 0);
        const hc = pa.hasCode === '是' || pa.hasCode === 'yes';
        const hm = pa.hasModel === '是' || pa.hasModel === 'yes';
        const hd = pa.hasDataset === '是' || pa.hasDataset === 'yes';
        if (os >= 1.0 && !hc && !hm && !hd) totalIssues++;
    });
    console.log(`[validate] 剩余问题: ${totalIssues}`);
    process.exit(totalIssues > 0 ? 1 : 0);
}

module.exports = { validateAndFix, DIM_MAX };

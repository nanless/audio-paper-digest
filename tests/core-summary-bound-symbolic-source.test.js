'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const input = process.env.PD_CORE_SYMBOLIC_COMPLETE_PAPER;
const root = process.env.PD_CORE_SYMBOLIC_SOURCE_PROJECT;
const contract = require('../scripts/analysis-contract');
const Config = require('../scripts/config');
const engine = require('../scripts/analysis-engine');

test('数学实例不能在没有原文的情况下绕过量化检查', () => {
    const samples = require('./fixtures/core-symbolic-geometry-paid-summaries.json');
    for (const text of samples) {
        assert.match(contract.validateCoreSummarySemanticContract(text), /关键定量结果/);
    }
});

test('完整论文检查重新读取真实封存来源，缺来源或来源身份错误均拒绝', {
    skip: !input || !root ? '需显式提供完整已付费论文副本和封存来源项目路径' : false
}, () => {
    const oldFile = Config.FILES.deepAnalysisResult;
    const oldRoot = Config.FILES.dailyFreshSourceRunsDir;
    try {
        Config.FILES.deepAnalysisResult = path.join(root, 'data/current/deep-analysis-result.json');
        Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'data/runtime/daily-fresh-source-runs');
        const paper = JSON.parse(fs.readFileSync(input, 'utf8'));
        const before = JSON.stringify(paper);
        assert.equal(engine.getIncompleteAnalysisContentReason(paper), null);
        assert.equal(JSON.stringify(paper), before);
        const wrong = structuredClone(paper);
        wrong.sourceSha256 = '0'.repeat(64);
        assert.match(engine.getIncompleteAnalysisContentReason(wrong), /封存来源未通过核验/);
        Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'data/runtime/missing-symbolic-source');
        assert.match(engine.getIncompleteAnalysisContentReason(paper), /封存来源未通过核验/);
        assert.equal(JSON.stringify(paper), before);
    } finally {
        Config.FILES.deepAnalysisResult = oldFile;
        Config.FILES.dailyFreshSourceRunsDir = oldRoot;
    }
});

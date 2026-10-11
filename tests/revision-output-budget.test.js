'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Config = require('../scripts/config.js');

describe('完整分析审校的输出容量', () => {
    it('完整重写使用独立预算，截断错误仍传给调用方', async () => {
        const deep = require('../scripts/deep-analyzer.js');
        const calls = [];
        const failure = Object.assign(new Error('完整审校未输出完'), { code: 'MODEL_OUTPUT_TRUNCATED' });
        await assert.rejects(deep.reviseAnalysis(
            { arxivId: '2610.02582', title: '论文标题' }, '已有分析', '正式来源正文', '本次证据',
            { callModelFn: async (messages, budget, options) => {
                calls.push({ messages, budget, options });
                throw failure;
            } }
        ), error => error === failure);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].budget, Config.ANALYSIS_CONFIG.revisionMaxTokens);
        assert.equal(calls[0].options.usageContext.stage, 'revision');
        assert.match(calls[0].messages[0].content, /以下 13 个一级章节/);
        assert.match(calls[0].messages[0].content, /本次证据/);
        assert.equal(deep.classifyModelRequestError(failure).retryable, false);
    });

    it('改变完整审校容量只改变当前审校指纹，保留主分析和旧版本预算', () => {
        const modulePath = require.resolve('../scripts/deep-analyzer.js');
        const originalModule = require.cache[modulePath];
        const originalBudget = Config.ANALYSIS_CONFIG.revisionMaxTokens;
        const before = require(modulePath);
        const paper = { arxivId: '2610.02582', title: '同一论文', authors: [], categories: [] };
        const fingerprints = deep => ({
            current: deep.buildTextStageFingerprint('revision', '已有分析', '原文证据', 'analysis-prompt-text-v3'),
            legacy: deep.buildTextStageFingerprint('revision', '已有分析', '原文证据'),
            v1: deep.buildTextStageFingerprint('revision', '已有分析', '原文证据', 'analysis-prompt-text-v1'),
            v2: deep.buildTextStageFingerprint('revision', '已有分析', '原文证据', 'analysis-prompt-text-v2'),
            migrated: deep.buildLegacyCoreSummaryV2TextFingerprint('revision', '已有分析', '原文证据'),
            table: deep.buildTextStageFingerprint('tableRepair', '已有分析', '原文证据', deep.currentPromptTextContract('tableRepair')),
            primary: deep.buildRecoveryFingerprints(paper, '同一来源', paper.arxivId).primaryAnalysis
        });
        const old = fingerprints(before);
        try {
            Config.ANALYSIS_CONFIG.revisionMaxTokens = originalBudget + 1000;
            delete require.cache[modulePath];
            const changed = fingerprints(require(modulePath));
            assert.notEqual(changed.current, old.current);
            for (const key of ['legacy', 'v1', 'v2', 'migrated', 'table', 'primary']) {
                assert.equal(changed[key], old[key], `${key} 不应因完整审校容量变化而改变`);
            }
        } finally {
            Config.ANALYSIS_CONFIG.revisionMaxTokens = originalBudget;
            if (originalModule) require.cache[modulePath] = originalModule;
            else delete require.cache[modulePath];
        }
    });
});

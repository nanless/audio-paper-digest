'use strict';

// 选定重分析与强制全量重分析的共享恢复语义。只测纯函数，不加载
// reanalyze.js 的顶层 CLI 和模型入口，避免测试进程被环境检查中断。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    papersFromAnalysisData,
    parseReanalyzeConcurrency,
    resetReaderForForcedReanalysis
} = require('../scripts/lib/reanalysis-helpers.js');

test('分析结果读取同时支持当前对象格式和旧数组格式', () => {
    const rows = [{ arxivId: '2611.00001' }];
    assert.deepEqual(papersFromAnalysisData(rows), rows);
    assert.deepEqual(papersFromAnalysisData({ papers: rows }), rows);
    assert.deepEqual(papersFromAnalysisData({}), []);
    assert.deepEqual(papersFromAnalysisData(null), []);
    assert.deepEqual(papersFromAnalysisData({ papers: null }), []);
});

test('并发配置只接受十进制正整数，不再截断小数或静默回退', () => {
    assert.equal(parseReanalyzeConcurrency({ cliValue: '3', envValue: undefined, fallback: 2 }), 3);
    assert.equal(parseReanalyzeConcurrency({ cliValue: '60', envValue: undefined, fallback: 2 }), 60);
    assert.equal(parseReanalyzeConcurrency({ cliValue: undefined, envValue: '4', fallback: 2 }), 4);
    assert.equal(parseReanalyzeConcurrency({ cliValue: undefined, envValue: '', fallback: 2 }), 2);
    assert.equal(parseReanalyzeConcurrency({ cliValue: undefined, envValue: undefined, fallback: 2 }), 2);
    for (const [cliValue, envValue] of [['2.5', undefined], ['3abc', undefined], ['0', undefined],
        [undefined, '2.5'], [undefined, '0'], [undefined, 'abc']]) {
        assert.throws(() => parseReanalyzeConcurrency({ cliValue, envValue, fallback: 2 }),
            /必须是正整数/);
    }
});

test('强制全量重分析清 Reader 前登记序号接替历史，并保留主文与评分', () => {
    const stage = {
        status: 'complete',
        articleSha256: 'a'.repeat(64),
        planSha256: 'b'.repeat(64),
        ordinalPatchCompilations: [{ requestId: '5ec2344f-e3e1-4f7c-8ab2-aa374781cc1c' }],
        ordinalCompletionProof: { path: '/tmp/ordinal-completions/2611.11507-00000001.json', sha256: 'c'.repeat(64) }
    };
    const next = resetReaderForForcedReanalysis({
        arxivId: '2611.11507',
        analysis: '保留的主文',
        parsed: { score: 7 },
        analysisManifest: {
            stages: { apiReaderArticle: stage, imageSupplement: { status: 'complete' } },
            contracts: { apiReaderArticle: 'beginner-researcher-v3', imageNarrative: 'v1' }
        },
        analysisStageCheckpoints: { apiReaderArticle: 'checkpoint', imageSupplement: 'image-checkpoint' },
        apiReaderArticle: '正文',
        apiReaderPlan: { version: 3 },
        apiReaderFigures: [],
        apiReaderAuthors: {},
        apiReaderResources: {},
        apiReaderArticleSha256: 'd'.repeat(64),
        apiReaderPlanSha256: 'e'.repeat(64)
    });
    assert.equal(next.analysis, '保留的主文');
    assert.deepEqual(next.parsed, { score: 7 });
    assert.equal(next.analysisManifest.stages.apiReaderArticle, undefined);
    assert.equal(next.analysisManifest.stages.imageSupplement, undefined);
    assert.deepEqual(next.analysisManifest.contracts, undefined);
    assert.equal(next.analysisStageCheckpoints.apiReaderArticle, undefined);
    assert.equal(next.analysisStageCheckpoints.imageSupplement, undefined);
    for (const key of ['apiReaderArticle', 'apiReaderPlan', 'apiReaderFigures', 'apiReaderAuthors',
        'apiReaderResources', 'apiReaderArticleSha256', 'apiReaderPlanSha256']) {
        assert.equal(Object.hasOwn(next, key), false, key);
    }
    assert.equal(next.readerRevisionHistory.reason, 'stage-invalidated');
    assert.deepEqual(next.readerRevisionHistory.completionProof, stage.ordinalCompletionProof);
    assert.equal(next.readerRevisionHistory.previousArticleSha256, stage.articleSha256);
    // 原始对象不被就地修改。
    assert.equal(stage.status, 'complete');
});

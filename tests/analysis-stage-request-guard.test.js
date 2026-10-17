'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../scripts/lib/analysis-stage-request-guard');

test('旧失败模型阶段逐项保留，已完成、未消费及 Reader 不纳入辅助阶段禁令', () => {
    const stages = Object.fromEntries(guard.AUXILIARY_STAGES.map((stage, i) => [stage,
        { status: ['contract_rejected', 'failed', 'invalid_output', 'transient_failure'][i % 4] }]));
    stages.apiReaderArticle = { status: 'contract_rejected' };
    stages.imageDownload = { status: 'failed' };
    const before = JSON.stringify(stages);
    assert.deepEqual(guard.failedAuxiliaryStages({ stages }), [...guard.AUXILIARY_STAGES]);
    assert.equal(JSON.stringify(stages), before);
    for (const status of ['complete', 'not_needed', 'pending', 'skipped']) {
        assert.deepEqual(guard.failedAuxiliaryStages({ stages: { tagSelection: { status } } }), []);
    }
    assert.deepEqual(guard.failedAuxiliaryStages(null), []);
});

test('重入不阻止无请求的结构纯检查及付费摘要重放，只拒同阶段新请求', async () => {
    const original = { attempts: 2, fees: [{ outcome: 'completed' }], body: '已保存原稿' };
    const before = JSON.stringify(original);
    const result = await guard.withStageModelRequestsForbidden(['structureRepair', 'coreSummaryRepair'], async () => {
        await Promise.resolve();
        assert.throws(() => guard.assertStageModelRequestAllowed('structureRepair'),
            { code: guard.CODE, retryable: false, scope: 'paper' });
        assert.throws(() => guard.assertStageModelRequestAllowed('coreSummaryRepair'), { code: guard.CODE });
        for (const stage of ['tagSelection', 'scoringAudit', 'apiReaderArticle', 'apiReaderRepair', 'imageSupplement']) {
            assert.doesNotThrow(() => guard.assertStageModelRequestAllowed(stage));
        }
        return original.body;
    });
    assert.equal(result, original.body);
    assert.equal(JSON.stringify(original), before);
    assert.doesNotThrow(() => guard.assertStageModelRequestAllowed('structureRepair'));
});

test('嵌套禁令只增不减且不受调用方数组修改影响', async () => {
    const stages = ['tagSelection'];
    await guard.withStageModelRequestsForbidden(stages, async () => {
        stages.length = 0;
        await guard.withStageModelRequestsForbidden(['structureRepair'], async () => {
            await Promise.resolve();
            for (const stage of ['tagSelection', 'structureRepair']) {
                assert.throws(() => guard.assertStageModelRequestAllowed(stage), { code: guard.CODE });
            }
            guard.withStageModelRequestsForbidden([], () => {
                assert.throws(() => guard.assertStageModelRequestAllowed('tagSelection'), { code: guard.CODE });
            });
        });
        assert.doesNotThrow(() => guard.assertStageModelRequestAllowed('structureRepair'));
        assert.throws(() => guard.assertStageModelRequestAllowed('tagSelection'), { code: guard.CODE });
    });
});

test('异步并行论文互不串扰，异常退出也恢复外层作用域', async () => {
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    await Promise.all([
        guard.withStageModelRequestsForbidden(['tagSelection'], async () => {
            release(); await ready;
            assert.throws(() => guard.assertStageModelRequestAllowed('tagSelection'), { code: guard.CODE });
            await assert.rejects(guard.withStageModelRequestsForbidden(['structureRepair'], async () => {
                throw new Error('原失败原样传播');
            }), /原失败原样传播/);
            assert.doesNotThrow(() => guard.assertStageModelRequestAllowed('structureRepair'));
        }),
        (async () => { await ready; assert.doesNotThrow(() => guard.assertStageModelRequestAllowed('tagSelection')); })()
    ]);
    assert.doesNotThrow(() => guard.assertStageModelRequestAllowed('tagSelection'));
});

test('有禁令时缺失或伪造阶段不能规避；无禁令时不改变其他业务调用', () => {
    for (const stage of [undefined, null, '', 'TagSelection', 'custom-stage']) {
        guard.withStageModelRequestsForbidden(['tagSelection'], () => {
            assert.throws(() => guard.assertStageModelRequestAllowed(stage), { code: guard.CODE });
        });
        assert.doesNotThrow(() => guard.assertStageModelRequestAllowed(stage));
    }
    assert.throws(() => guard.withStageModelRequestsForbidden(['apiReaderArticle'], () => {}), TypeError);
    assert.throws(() => guard.withStageModelRequestsForbidden('tagSelection', () => {}), TypeError);
});

test('公共请求封装在费用登记和真实传输前拦截旧失败阶段，未消费阶段正常发送', async () => {
    const utils = require('../scripts/utils');
    const endpoint = 'http://127.0.0.1:9/v1', model = 'ci-test-model';
    let transports = 0; const events = [];
    const request = stage => utils.requestLlmJson(
        utils.buildApiUrl(utils.detectApiType(endpoint, model), endpoint), endpoint, model,
        { model, max_tokens: 16, messages: [{ role: 'user', content: '离线阶段禁令测试' }] }, {},
        { usageContext: { stage }, recordUsage: false, usageSink: event => events.push(event),
            transportRequestFn: async () => {
                transports++;
                return { statusCode: 200, body: { choices: [{ message: { content: '收到' } }] } };
            } });
    await guard.withStageModelRequestsForbidden(['tagSelection'], async () => {
        await assert.rejects(request('tagSelection'), { code: guard.CODE, scope: 'paper', retryable: false });
        assert.equal(transports, 0); assert.equal(events.length, 0);
        const result = await request('scoringAudit');
        assert.equal(result.statusCode, 200); assert.equal(transports, 1);
        assert.ok(events.length > 0);
    });
});

test('深度分析自定义传输也不能绕过旧失败阶段禁令，不消耗内部传输重试', async () => {
    const deep = require('../scripts/deep-analyzer');
    let requests = 0, sleeps = 0;
    const config = { endpoint: 'http://127.0.0.1:9/v1', model: 'ci-test-model', key: 'offline-fixture',
        recordUsage: false, sleepFn: async () => { sleeps++; },
        requestFn: async () => {
            requests++;
            return { statusCode: 200, body: { choices: [{ message: { content: '收到' } }] } };
        } };
    await guard.withStageModelRequestsForbidden([...guard.AUXILIARY_STAGES], async () => {
        for (const stage of guard.AUXILIARY_STAGES) {
            await assert.rejects(deep.callModelWithConfig([{ role: 'user', content: '离线' }], 16, 3,
                { ...config, usageContext: { stage } }),
            { code: guard.CODE, scope: 'paper', retryable: false });
        }
        assert.equal(requests, 0); assert.equal(sleeps, 0);
        assert.equal(await deep.callModelWithConfig([{ role: 'user', content: '离线' }], 16, 3,
            { ...config, usageContext: { stage: 'apiReaderRepair' } }), '收到');
        assert.equal(requests, 1); assert.equal(sleeps, 0);
    });
});

test('真实标签修复循环在显式重入时不能重开两次内容额度', async () => {
    const deep = require('../scripts/deep-analyzer');
    const paper = { arxivId: '2610.90031', title: '已付标签失败稿' };
    const analysis = '## 标签\n原已付但不合格的标签内容';
    const before = JSON.stringify(paper);
    for (let outerRound = 0; outerRound < 3; outerRound++) {
        await guard.withStageModelRequestsForbidden(['tagSelection'], () => assert.rejects(
            deep.repairTagSelection(paper, analysis, '已封存来源', '原标签校验失败'),
            { code: guard.CODE, scope: 'paper', retryable: false }));
    }
    assert.equal(JSON.stringify(paper), before);
    assert.equal(analysis, '## 标签\n原已付但不合格的标签内容');
});

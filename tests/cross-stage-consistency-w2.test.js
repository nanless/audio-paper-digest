'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { checkMetricScaleDrift } = require('../scripts/lib/cross-stage-consistency.js');
const { buildReaderContractNotice, readerRequirements } = require('../scripts/lib/reader-contract.js');

describe('PC-P2-3: cross-stage-consistency checkMetricScaleDrift [1, 10)% vs <0.1 decimal check', () => {
    const analysisOf = summary => `## 核心摘要\n${summary}\n\n## 方法概述和架构\n正文。`;

    it('detects 100x decimal-vs-percent drift in [1, 10)% when larger carries % and smaller is bare <0.1', () => {
        const forward = checkMetricScaleDrift(
            analysisOf('模型在测试集上取得 WER 为 0.052。'),
            '实验表明模型 WER 为 5.2%。'
        );
        assert.equal(forward.length, 1);
        assert.equal(forward[0].code, 'cross_stage_metric_scale_drift');
        assert.equal(forward[0].metric, 'WER');

        const reverse = checkMetricScaleDrift(
            analysisOf('模型在中文测试集上 CER 达到 3.8%。'),
            '实验表明模型 CER 为 0.038。'
        );
        assert.equal(reverse.length, 1);
        assert.equal(reverse[0].metric, 'CER');

        const withinTol = checkMetricScaleDrift(
            analysisOf('说话人验证 EER 为 0.043。'),
            '说话人验证 EER 为 4.35%。'
        );
        assert.equal(withinTol.length, 1);
    });

    it('avoids false positives when larger lacks %, smaller has %, or discrepancy exceeds 0.002', () => {
        assert.deepEqual(
            checkMetricScaleDrift(
                analysisOf('模型 WER 为 0.052。'),
                '实验表明模型 WER 为 5.2。'
            ),
            []
        );
        assert.deepEqual(
            checkMetricScaleDrift(
                analysisOf('模型 WER 为 0.05%。'),
                '实验表明模型 WER 为 5.0%。'
            ),
            []
        );
        assert.deepEqual(
            checkMetricScaleDrift(
                analysisOf('模型 WER 为 0.050。'),
                '实验表明模型 WER 为 5.3%。'
            ),
            []
        );
    });
});

describe('PC-P3-2: reader-contract buildReaderContractNotice renders minimumProseChineseChars directly', () => {
    it('renders exact minimumProseChineseChars for short, compact, and normal v5 sources as well as legacy compact', () => {
        const shortNotice = buildReaderContractNotice({ sourceTextChars: 10000 });
        assert.equal(readerRequirements({ sourceTextChars: 10000 }).minimumProseChineseChars, 2800);
        assert.match(shortNotice, /建议不少于 2800 个/);

        const compactNotice = buildReaderContractNotice({ sourceTextChars: 25000 });
        assert.equal(readerRequirements({ sourceTextChars: 25000 }).minimumProseChineseChars, 3400);
        assert.match(compactNotice, /建议不少于 3400 个/);

        const normalNotice = buildReaderContractNotice({ sourceTextChars: 60000 });
        assert.equal(readerRequirements({ sourceTextChars: 60000 }).minimumProseChineseChars, 4500);
        assert.match(normalNotice, /建议不少于 4500 个/);

        const legacyCompactNotice = buildReaderContractNotice({ profile: 'compact-article' });
        assert.match(legacyCompactNotice, /建议不少于 2520 个/);
    });
});

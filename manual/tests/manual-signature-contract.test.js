'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    MANUAL_SIGNATURE_CONTRACT,
    canonicalJson,
    stableSignatureSha256,
    normalizeNfkcText
} = require('../scripts/manual-signature-contract.js');

const vectors = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'manual-stable-json-vectors.json'), 'utf8'
));

describe('Manual 跨运行时签名约定', () => {
    it('共享向量固定 stable JSON、Unicode 字节、NFKC 文本与 SHA', () => {
        assert.equal(vectors.contract, MANUAL_SIGNATURE_CONTRACT);
        for (const vector of vectors.accepted) {
            assert.equal(canonicalJson(vector.value), vector.canonicalJson, vector.name);
            assert.equal(stableSignatureSha256(vector.value), vector.sha256, vector.name);
            assert.equal(normalizeNfkcText(vector.nfkcInput), vector.nfkcText, vector.name);
        }
    });

    it('非 ASCII key 与非法数字签名对象 fail closed', () => {
        for (const vector of vectors.rejected) {
            assert.throws(() => canonicalJson(vector.value), new RegExp(vector.error), vector.name);
        }
        assert.throws(() => canonicalJson({ value: -0 }), /负零/);
        assert.throws(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 }), /非安全整数/);
        assert.throws(() => canonicalJson({ value: Number.NaN }), /NaN/);
        assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /Infinity/);
    });

    it('真实技术审查输出的附加字段必须进入凭证 SHA', () => {
        const workflow = require('../scripts/manual-v6-workflow.js');
        const taskName='technical-review-one';
        const output = {
            "version": 1,
            "role": "technical_scoring",
            "paperId": "2608.12345",
            "taskName": "technical-review-one",
            "passed": true,
            "issues": [],
            "findings": [
                "逐项检查方法描述与来源正文的一致性并记录真实限制。",
                "逐项检查实验数据与来源表格的一致性并记录真实限制。"
            ],
            "evidenceChecks": [
                {
                    "claim": "方法说明与论文正文对应位置保持一致。",
                    "evidenceId": "method",
                    "verified": true
                },
                {
                    "claim": "实验数据与论文表格对应位置保持一致。",
                    "evidenceId": "table",
                    "verified": true
                }
            ],
            "dims": [
                1,
                1,
                1,
                1,
                1,
                1,
                0.5,
                0.5
            ],
            "confidence": "中",
            "scoringReasons": [
                "这项评分只依据论文实际提供的证据，并保留未说明的限制条件。",
                "这项评分只依据论文实际提供的证据，并保留未说明的限制条件。",
                "这项评分只依据论文实际提供的证据，并保留未说明的限制条件。",
                "这项评分只依据论文实际提供的证据，并保留未说明的限制条件。",
                "这项评分只依据论文实际提供的证据，并保留未说明的限制条件。",
                "这项评分只依据论文实际提供的证据，并保留未说明的限制条件。",
                "这项评分只依据论文实际提供的证据，并保留未说明的限制条件。",
                "这项评分只依据论文实际提供的证据，并保留未说明的限制条件。"
            ],
            "scoringCalibration": {
                "version": 1,
                "independentReview": true,
                "reviewerTaskName": "technical-review-one",
                "model": "gpt-5.6-terra",
                "reasoningEffort": "high",
                "crossDimensionChecked": true,
                "batchScaleChecked": true,
                "calibrationNotes": "各维度依据原文独立核对评分，不重复扣除同一问题；缺失证据不当成技术错误，同时核对当前批次评分尺度。",
                "evidenceIdsByDimension": {
                    "innovation": [
                        "source:1"
                    ],
                    "technicalRigor": [
                        "source:1"
                    ],
                    "experimentalSufficiency": [
                        "source:1"
                    ],
                    "clarity": [
                        "source:1"
                    ],
                    "impact": [
                        "source:1"
                    ],
                    "openSource": [
                        "source:1"
                    ],
                    "reproducibility": [
                        "source:1"
                    ],
                    "engineering": [
                        "source:1"
                    ]
                }
            }
        };
        const receipt = { taskName, outputSha256: workflow.stableSha256(output) };
        assert.doesNotThrow(() => workflow.validateReviewOutput(output, 'technical_scoring',
            output.paperId, receipt, 'review'));
        for (const nested of [false, true]) {
            const changed = JSON.parse(JSON.stringify(output));
            const target = nested ? changed.evidenceChecks[0] : changed;
            Object.defineProperty(target, '__proto__', { value: { hidden: '必须覆盖的审查内容' }, enumerable: true });
            assert.throws(() => workflow.validateReviewOutput(changed, 'technical_scoring',
                changed.paperId, receipt, 'review'), /真实输出 SHA/);
            const nextReceipt = { ...receipt, outputSha256: workflow.stableSha256(changed) };
            assert.doesNotThrow(() => workflow.validateReviewOutput(changed, 'technical_scoring',
                changed.paperId, nextReceipt, 'review'));
            assert.equal(Object.getPrototypeOf(target), Object.prototype);
        }
    });
});

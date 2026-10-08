'use strict';

// 提示词历史字节归档接到 deep-analyzer 的评分审计指纹与读者阶段记录之后，这里锁定四件事：
// 声明值就是当前文件时解析结果不变；归档里确有声明字节时按声明值走；归档里没有就退回
// 当前值（保持改动前「指纹变化、清掉阶段重跑」的判定）；写回新记录的身份一律按当前文件
// 算，不会把核验用的历史 SHA 带进去。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const deep = require('../scripts/deep-analyzer.js');
const history = require('../scripts/lib/prompt-history.js');
const {
    promptFilePathForContract,
    currentPromptTextContract
} = require('../scripts/lib/prompt-text-versions.js');

// 存量记录里真实出现过、且 prompts/history/ 归档里确有对应字节的两个模板 SHA。
const ARCHIVED_SCORING_TEMPLATE =
    '12a6f804bcdb1f3e1caaf915a8e886221bef583c512f322ebecd8d5bac38ddf0';
const ARCHIVED_READER_TEMPLATE =
    '3ca9bbffb5a42685036f6bde011cc85c0bc22d78af78787df799e579dc48ee8d';

function currentTemplateSha(relativePath) {
    return deep.runtimePromptTemplateSha256(relativePath, '');
}

function readerManifest(declaredPromptTemplateSha256) {
    const contract = currentPromptTextContract('apiReaderArticle');
    const repairContract = currentPromptTextContract('apiReaderRepair');
    return {
        stages: {
            apiReaderArticle: {
                status: 'complete',
                fingerprint: 'f'.repeat(64),
                promptTextContract: contract,
                repairPromptTextContract: repairContract,
                promptTemplateSha256: declaredPromptTemplateSha256,
                repairPromptTemplateSha256: currentTemplateSha(
                    promptFilePathForContract('apiReaderRepair', repairContract))
            },
            coreSummaryRepair: {
                status: 'complete',
                outputAnalysisSha256: 'a'.repeat(64)
            }
        }
    };
}

function readerBase(manifest) {
    const paper = { arxivId: '2601.00001', analysisStageCheckpoints: { apiReaderArticle: '正文' } };
    return deep.buildRecoveryFingerprints(paper, '', '2601.00001', manifest).apiReaderArticle;
}

test('评分审计提示词：声明值就是当前文件时返回当前值', () => {
    const relativePath = promptFilePathForContract('scoringAudit', '');
    const current = currentTemplateSha(relativePath);
    assert.equal(
        deep.resolvedRuntimePromptTemplateSha256(current, relativePath, ''),
        current);
});

test('评分审计提示词：归档里确有声明字节时按声明值走', () => {
    const relativePath = promptFilePathForContract('scoringAudit', '');
    assert.notEqual(currentTemplateSha(relativePath), ARCHIVED_SCORING_TEMPLATE);
    assert.ok(history.historicalPromptTemplateBytesForSha256(ARCHIVED_SCORING_TEMPLATE, ''));
    assert.equal(
        deep.resolvedRuntimePromptTemplateSha256(ARCHIVED_SCORING_TEMPLATE, relativePath, ''),
        ARCHIVED_SCORING_TEMPLATE);
});

test('评分审计提示词：归档里没有声明字节时退回当前值', () => {
    const relativePath = promptFilePathForContract('scoringAudit', '');
    assert.equal(
        deep.resolvedRuntimePromptTemplateSha256('0'.repeat(64), relativePath, ''),
        currentTemplateSha(relativePath));
});

test('读者阶段：核验按记录声明的历史提示词算，写回按当前文件算', () => {
    const declared = readerManifest(ARCHIVED_READER_TEMPLATE);
    const withoutDeclared = readerManifest(undefined);
    const verifyBase = readerBase(declared);
    const writeBase = readerBase(withoutDeclared);
    assert.notEqual(verifyBase, writeBase,
        '归档解析必须只改核验指纹，不能让写回的身份跟着历史 SHA 走');
});

test('读者阶段：没有归档可解析时，核验与写回逐字节相同', () => {
    for (const declared of [undefined, '0'.repeat(64)]) {
        assert.equal(readerBase(readerManifest(declared)), readerBase(readerManifest(undefined)),
            `声明值 ${declared} 在归档里查不到时不应该改变核验指纹`);
    }
});

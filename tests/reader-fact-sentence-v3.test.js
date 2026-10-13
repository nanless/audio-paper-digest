'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const firstClaim = '已核验的第一条完整错误句。';
const secondClaim = '已核验的第二条完整错误句。';

function sampleDraft() {
    return {
        sections: [{ body: `开头字节\n\n${firstClaim}中间字节\n${secondClaim}结尾字节` }],
        conceptBridges: [{ terms: ['模块甲', '模块乙'], explanation: '保留桥解释' }],
    };
}
function repairContext(draft, claims = [firstClaim, secondClaim]) {
    const issues = repair.assertReaderFactLocalCoverage(draft, claims);
    return repair.buildRepairContext(draft, issues, '', '', {
        readerFactLocalPaths: issues.map(issue => issue.path), readerFactLocalClaims: claims,
    });
}
function sentenceResponse(context) {
    return {
        version: 1, draftSha256: context.draftSha256,
        sentenceReplacements: repair.factLocalSentenceTargets(context)
            .map(({ originalSentence, ...identity }) => ({
                ...identity, value: '根据原文纠正后的事实句。',
            })),
    };
}
function parseCompileApply(draft, response, context) {
    const parsed = repair.parseReaderPatchJson(JSON.stringify(response));
    const patch = repair.compileFactLocalSentencePatch(draft, parsed, context, {
        readerFactLocalRevision: true,
    });
    return repair.applyReaderPatch(draft, patch, context.targets.map(target => target.path), {
        readerFactLocalClaims: Object.fromEntries(context.targets
            .map(target => [target.path, target.authorizedClaims])),
    });
}

test('实际JSON解析→原句编译→原apply：乱序两句长度变化，句外字节不变', () => {
    const draft = sampleDraft();
    const context = repairContext(draft);
    const response = sentenceResponse(context);
    response.sentenceReplacements.reverse();
    const result = parseCompileApply(draft, response, context);
    assert.equal(result.sections[0].body, draft.sections[0].body
        .replace(firstClaim, '根据原文纠正后的事实句。')
        .replace(secondClaim, '根据原文纠正后的事实句。'));
    assert.deepEqual(result.conceptBridges, draft.conceptBridges);
    assert.ok(draft.sections[0].body.includes(firstClaim));
});

test('桥解释换句保留terms，Markdown术语标题和新增结构均拒绝', () => {
    const draft = sampleDraft();
    draft.conceptBridges[0].explanation = `桥前${firstClaim}桥后`;
    draft.sections[0].body = secondClaim;
    const context = repairContext(draft);
    const response = sentenceResponse(context);
    const result = parseCompileApply(draft, response, context);
    assert.deepEqual(result.conceptBridges[0].terms, draft.conceptBridges[0].terms);
    for (const value of ['## 模块甲与模块乙', '**模块甲与模块乙**解释',
        '解释\n标题', '[[FIGURE_1]]', '|表|', '![图](url)', '`公式`']) {
        const rejected = structuredClone(response);
        rejected.sentenceReplacements[0].value = value;
        assert.throws(() => parseCompileApply(draft, rejected, context));
    }
});

test('窄回应拒少项、多项、重复、未知目标、过期身份、未改句和重叠授权', () => {
    const draft = sampleDraft();
    const context = repairContext(draft);
    const response = sentenceResponse(context);
    assert.throws(() => repair.compileFactLocalSentencePatch(draft, response, context, {}));
    const invalidChanges = [
        item => item.sentenceReplacements.pop(),
        item => item.sentenceReplacements.push(item.sentenceReplacements[0]),
        item => { item.sentenceReplacements[1] = item.sentenceReplacements[0]; },
        item => { item.sentenceReplacements[0].path = '/sections/0/heading'; },
        item => { item.draftSha256 = '0'.repeat(64); },
        item => { item.sentenceReplacements[0].claimSha256 = '0'.repeat(64); },
        item => { item.sentenceReplacements[0].start++; },
        item => { item.sentenceReplacements[0].value = firstClaim; },
    ];
    for (const modify of invalidChanges) {
        const rejected = structuredClone(response);
        modify(rejected);
        assert.throws(() => parseCompileApply(draft, rejected, context));
    }
    const duplicate = sampleDraft();
    duplicate.readerTitle = firstClaim;
    assert.throws(() => parseCompileApply(duplicate, response, context));
    assert.throws(() => repair.factLocalSentenceTargets({ targets: [{
        path: '/sections/0/body', value: firstClaim, oldSha256: repair.hashDraft(firstClaim),
        authorizedClaims: [firstClaim, firstClaim.slice(1)],
    }] }));
});

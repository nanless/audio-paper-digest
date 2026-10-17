'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
const section = (heading, kind = 'method') => ({ heading, kind });
const article = (headings, bodies = headings.map(() => '原来的小节正文。')) =>
    headings.map((heading, index) => `### ${heading}\n\n${bodies[index]}`).join('\n\n');

test('resource replay accepts only the existing numeric heading typography without editing saved input', () => {
    // Actual mismatches from saved conference plans; shortened fixtures are
    // structural tests, not a source/paid/full-page qualification proof.
    for (const [planned, rendered] of [
        ['为什么要检查每一帧？', '为什么要检查每 1 帧？'],
        ['怎样得到一天向量？', '怎样得到 1 天向量？']
    ]) {
        const plan = { sections: [section(planned), section('最后如何核对资源？', 'reproduction')] };
        const page = article([rendered, plan.sections[1].heading], ['方法正文。', '本文权重已公开。']);
        const before = JSON.stringify(plan);
        const draft = deep.readerResourceClaimDraftFromArticle(plan, page);
        assert.equal(draft.sections[0].heading, rendered);
        assert.equal(draft.sections[0].body.trim(), '方法正文。');
        assert.equal(draft.sections[1].body, '本文权重已公开。');
        assert.equal(JSON.stringify(plan), before);
        assert.equal(page, article([rendered, plan.sections[1].heading], ['方法正文。', '本文权重已公开。']));
    }
});

test('resource replay still rejects changed numbers, semantics, order, cardinality and ambiguous headings', () => {
    const plan = { sections: [section('为什么要检查每一帧？'), section('最后如何核对资源？')] };
    for (const headings of [
        ['为什么要检查每 2 帧？', '最后如何核对资源？'],
        ['为什么逐帧检查？', '最后如何核对资源？'],
        ['最后如何核对资源？', '为什么要检查每 1 帧？'],
        ['为什么要检查每 1 帧？'],
        ['为什么要检查每 1 帧？', '最后如何核对资源？', '额外的标题？']
    ]) assert.throws(() => deep.readerResourceClaimDraftFromArticle(plan, article(headings)),
        { code: 'READER_RESOURCE_ARTICLE_STRUCTURE_INVALID' });
    assert.throws(() => deep.readerResourceClaimDraftFromArticle(
        { sections: [section('为什么检查一帧？'), section('为什么检查 1 帧？')] },
        article(['为什么检查 1 帧？', '为什么检查 1 帧？'])),
    { code: 'READER_RESOURCE_ARTICLE_STRUCTURE_INVALID' });
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deep = require('../scripts/deep-analyzer.js');

test('正式公开长文生成无像素时只清独立图标记，不发额外修复请求', async t => {
    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    const draft = signed.draft;
    draft.sections[7].body += '\n\n[[FIGURE_1]]\n\n';
    draft.figurePlacements = [{ figureOrdinal: 1, targetKind: 'result', marker: '[[FIGURE_1]]',
        focusPoints: ['确认机制的输入与输出', '核对数据的比较条件'] }];
    const originalBody = draft.sections[7].body;
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-no-pixels-normal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let calls = 0;
    const result = await deep.generateApiReaderArticleDetailed(signed.paper, '', '来源证据', {
        sourceText: signed.sourceDetails.text,
        structuredArtifacts: signed.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory,
        readerMaterializeFigures: async () => [],
        readerRecordDisposition: () => {},
        readerMaxAttempts: 1,
        readerCallModel: async (_messages, _tokens, options) => {
            calls += 1;
            assert.equal(options.usageContext.stage, 'apiReaderArticle');
            return JSON.stringify(draft);
        }
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.plan.figurePlacements, []);
    assert.doesNotMatch(result.article, /\[\[FIGURE_1\]\]/);
    assert.equal(result.attempts, 1);
    assert.equal(result.fullAttempts, 1);
    assert.ok(result.draftOrderMappings.some(item => item.contract === 'reader-no-figure-marker-cleanup-v1'));
    assert.equal(draft.sections[7].body, originalBody);
});

test('有像素、行内图标记、代码围栏或超过八个目标时不做机械清理', () => {
    const repair = require('../scripts/lib/reader-repair.js');
    const base = { figurePlacements: [{ figureOrdinal: 1 }], sections: [
        { kind: 'result', heading: '结果', body: '固定数值512。\n\n[[FIGURE_1]]\n\n其余正文保持。' }
    ] };
    assert.equal(repair.normalizeUnavailableReaderFigures(base, [1]), null);
    assert.equal(repair.normalizeUnavailableReaderFigures(base, undefined), null);
    for (const body of ['正文[[FIGURE_1]]行内标记。', '```text\n[[FIGURE_1]]\n```']) {
        const draft = structuredClone(base);
        draft.sections[0].body = body;
        assert.equal(repair.normalizeUnavailableReaderFigures(draft, []), null);
    }
    const tooMany = structuredClone(base);
    tooMany.sections = Array.from({ length: 8 }, () => structuredClone(base.sections[0]));
    assert.equal(repair.normalizeUnavailableReaderFigures(tooMany, []), null);
});

test('机械删除标记不改颜色曲线陈述，不给正文合格证明', () => {
    const repair = require('../scripts/lib/reader-repair.js');
    const body = '蓝色曲线下降且指标值512保持。\n\n[[FIGURE_1]]\n\n其余事实不变。';
    const draft = { figurePlacements: [{ figureOrdinal: 1 }], sections: [{ kind: 'result', body }] };
    const cleaned = repair.normalizeUnavailableReaderFigures(draft, []);
    assert.equal(cleaned.draft.sections[0].body, body.replace('[[FIGURE_1]]\n', ''));
    assert.equal(cleaned.mapping.contentValidated, false);
    assert.deepEqual(cleaned.mapping.paths, ['/figurePlacements', '/sections/0/body']);
    assert.equal(draft.sections[0].body, body);
});

test('已耗尽候选机械清理仍不合格时保存新草稿而不增加请求或清除次数', async t => {
    const repair = require('../scripts/lib/reader-repair.js');
    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    const draft = signed.draft;
    draft.readerTitle = '短';
    draft.sections[7].body += '\n\n正文[[FIGURE_1]]行内。';
    draft.figurePlacements = [{ figureOrdinal: 1, targetKind: 'result', marker: '[[FIGURE_1]]',
        focusPoints: ['确认输入和输出', '核对比较设置'] }];
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-exhausted-no-pixels-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let calls = 0;
    const options = { sourceText: signed.sourceDetails.text,
        structuredArtifacts: signed.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory, readerMaterializeFigures: async () => [],
        readerRecordDisposition: () => {}, readerMaxAttempts: 1,
        readerCallModel: async () => { calls += 1; return JSON.stringify(draft); } };
    await assert.rejects(deep.generateApiReaderArticleDetailed(signed.paper, '', '来源证据', options));
    assert.equal(calls, 1);
    const filename = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    const standalone = structuredClone(envelope.payload.draft);
    standalone.sections[7].body = standalone.sections[7].body.replace('正文[[FIGURE_1]]行内。', '正文保持。\n\n[[FIGURE_1]]\n\n');
    // 合成已有耗尽状态，仅验证恢复分支；不冒真实旧producer生成此形状。
    repair.saveFailedCandidate(directory, envelope.identity, { ...envelope.payload,
        draft: standalone, rawDraft: JSON.stringify(standalone), noProgress: 2 });
    const before = repair.loadFailedCandidate(directory, envelope.identity);
    await assert.rejects(deep.generateApiReaderArticleDetailed(signed.paper, '', '来源证据', options), error => error.code === 'READER_REPAIR_ATTEMPTS_EXHAUSTED' && error.retryable === false);
    const after = repair.loadFailedCandidate(directory, envelope.identity);
    assert.equal(calls, 1);
    assert.deepEqual(after.draft.figurePlacements, []);
    assert.doesNotMatch(after.draft.sections[7].body, /\[\[FIGURE_1\]\]/);
    assert.equal(after.status, 'failed');
    for (const key of ['attempts', 'fullAttempts', 'transportFailures', 'noProgress']) {
        assert.equal(after[key], before[key]);
    }
    assert.ok(after.draftOrderMappings.some(item => item.contract === 'reader-no-figure-marker-cleanup-v1'));
});

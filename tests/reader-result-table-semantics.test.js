'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const { loadPrompt } = require('../scripts/utils');
const prompts = require('../scripts/lib/prompt-text-versions');
const evidence = require('../scripts/lib/prompt-evidence');
const paid = require('./fixtures/reader-resource-paid-tail-20261018.json').cases.find(row => row.name === 'zhang');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

test('真实付费坏稿的参考文献数字占位表由完整正常解析拒绝，原稿不变', () => {
    const draft = structuredClone(paid.draft), before = JSON.stringify(draft);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(draft), {
        requiredVersion: 3, requireIntegratedTables: true, requireSourceBindings: true
    }), error => error.code === 'reader_placeholder_result_table'
        && error.readerIssues.length === 6
        && error.readerIssues.some(issue => issue.path === '/sections/8/body')
        && error.readerIssues.some(issue => issue.path === '/tableBindings/0'));
    assert.equal(JSON.stringify(draft), before);
    assert.match(draft.sections[8].body, /3830/);
});

test('占位签名同时识别中英文序号与加粗空格，不把引用说明表泛化成结果错误', () => {
    for (const body of [
        '| 来源证据 | 量化值一 | 量化值二 |\n|---|---|---|\n| 来源句一 | 2025 | 3834 |',
        '| **来源证据** | 量化值 1 | 量化值 2 |\n|---|---|---|\n| 来源句 1 | 2025 | 3834 |',
        '| 条目 | 量化值一 |\n|---|---|\n| 来源句一 | 2025 |'
    ]) assert.equal(deep.readerPlaceholderResultTableIssues({ sections: [{ body }] }).length, 1);
    for (const body of [
        '| 来源证据 | 原文引句 | 解释 |\n|---|---|---|\n| 来源句一 | 参考文献明确给出年份 | 只是引用说明 |',
        '| 方法 | WER (%) | SDR (dB) |\n|---|---|---|\n| Baseline | 12.4 | 8.1 |\n| Proposed | 9.8 | 9.3 |',
        '| 来源证据 | WER (%) |\n|---|---|\n| 实验甲 | 12.4 |',
        '| 定义 | 量化值的含义 |\n|---|---|\n| 变量 | 指标读数 |'
    ]) assert.deepEqual(deep.readerPlaceholderResultTableIssues({ sections: [{ body }] }), []);
});

test('有语义指标和来源绑定的正常 Reader 仍通过完整解析', () => {
    const fixture = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    assert.deepEqual(deep.readerPlaceholderResultTableIssues(fixture.draft), []);
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(fixture.draft), {
        arxivId: fixture.paper.id, requiredVersion: 3, requireIntegratedTables: true,
        minimumIntegratedTables: 2, requireSourceBindings: true,
        structuredArtifacts: fixture.sourceDetails.structuredArtifacts,
        sourceText: fixture.sourceDetails.text
    });
    assert.match(parsed.article, /报告值/);
    assert.equal(parsed.plan.tableBindings.length, 2);
});

test('会议归一不会从引文抽数字造表、凭重叠选表或搬到结果小节', () => {
    const sourceText = 'References: [22] Author. Interspeech 2025, pages 3830–3834.';
    const draft = { version: 3, readerTitle: '同一测试条件下的原有论文标题',
        oneSentenceThesis: '本测试只检查是否保留原来的标记和来源，不产生实验结果或改变请求次数。',
        sections: [{ kind: 'experiment_setup', heading: '原有设置位置', body: '原有输入条件。\n\n[[TABLE_1]]\n\n原有解释。' },
            { kind: 'result', heading: '原有结果位置', body: '原有结果解释，不接收由参考文献数字拼成的表。' }],
        tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: [sourceText] }], conceptBridges: [], figurePlacements: [], formulaBindings: [] };
    const before = structuredClone(draft), state = {};
    deep.normalizeApiReaderRecoveryDraftForSource(draft, [], {
        paperId: 'conference:interspeech:2026:conference-paper-id:fixture', sourceText,
        structuredArtifacts: { sourceKind: 'conference_pdf', tables: [{ ordinal: 1, recoveryStatus: 'complete',
            caption: 'Unrelated result table', matrix: [['Method', 'WER'], ['2025', '22']], headerRows: [0] }] },
        pixelFigureOrdinals: []
    }, state);
    assert.deepEqual(state.draft.sections, before.sections);
    assert.deepEqual(state.draft.tableBindings, before.tableBindings);
    assert.equal(state.draft.tableBindings.some(binding => binding.selection), false);
    assert.doesNotMatch(JSON.stringify(state.draft), /量化值一|来源句一/);
});

test('两份当前 Prompt 实际首围栏要求语义结果且旧模板仍有原 Git 字节证明', () => {
    for (const [stage, oldSha] of [
        ['apiReaderArticle', 'e294f105592995d6dbe494e47b111e588fc61d96c87e3a905a8d32686b87cc83'],
        ['apiReaderRepair', '55aa1eb2d663b69bcaff0df77ec371fdc9764173449279b0139c85be0cba68f5']
    ]) {
        const file = prompts.currentTextStagePromptPath(stage);
        const bytes = fs.readFileSync(path.resolve(__dirname, '..', file));
        const old = evidence.historicalPromptEvidenceBytesForSha256(oldSha, { relativePath: file });
        assert.equal(sha(old), oldSha);
        assert.notEqual(sha(bytes), oldSha);
        const block = bytes.toString().match(/~~~[^\n]*\n([\s\S]*?)\n~~~/)?.[1];
        const values = Object.fromEntries([...block.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
            .map(match => [match[1], '本次真实输入']));
        const loaded = loadPrompt(file, values);
        assert.match(loaded, /来源句一／量化值一/);
        assert.match(loaded, /逐字数字存在不代表结果归属成立/);
        assert.match(loaded, /真实(?:原表和比较问题|列数)/);
        assert.doesNotMatch(loaded, /\{(?:title|arxivId|sourceEvidence|repairTargets)\}/);
    }
});

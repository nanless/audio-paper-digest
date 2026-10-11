'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectDraftIssues, parseRepairableDraft, buildRepairContext, applyReaderPatch, hashDraft } = require('../scripts/lib/reader-repair');
const { parseApiReaderArticleResult } = require('../scripts/deep-analyzer');

function createReaderDraft() {
    return { version: 3, readerTitle: '论文中的输入如何形成可核对结果', oneSentenceThesis: '这篇论文通过明确的任务设置解释方法和实验，关键结论只适用于原文报告的比较条件。',
        sections: Array.from({ length: 12 }, (_, index) => ({ kind: 'component', heading: `第 ${index + 1} 节`, body: '已有正文。'.repeat(30) })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({ terms: ['术语甲', '术语乙'], sectionKind: 'component', marker: `[[CONCEPT_BRIDGE_${index + 1}]]`, explanation: '已有解释。'.repeat(20) })),
        figurePlacements: [], tableBindings: [], formulaBindings: [] };
}

test('原始20节输出同时指出所有多余字段和超量图片，不成为合法草稿', () => {
    const draft = createReaderDraft();
    draft.sections.push(...structuredClone(draft.sections.slice(0, 8)));
    Object.assign(draft.sections[5], { body2: '有待核对的解释', formula: '不能丢弃的说明', tables: [] });
    draft.sections[13].tableIntro = '表前说明';
    draft.conceptBridges[0].marker_note = '实质解释';
    draft.figurePlacements = Array.from({ length: 5 }, (_, index) => ({ figureOrdinal: index + 1, targetKind: 'component', marker: `[[FIGURE_${index + 1}]]`, focusPoints: [] }));
    const raw = JSON.stringify(draft);
    assert.equal(parseRepairableDraft(raw), null);
    const issues = collectDraftIssues(null, new Error('节数错误'), { rawDraft: raw });
    const text = issues.map(issue => issue.message).join('\n');
    for (const value of ['20 节', 'body2', 'formula', 'tables', 'tableIntro', 'marker_note', '5 项']) assert.ok(text.includes(value), value);
    assert.ok(issues.slice(1).every(issue => issue.path === null && issue.diagnosticOnly === true));
    assert.equal(JSON.stringify(draft), raw);
    assert.throws(() => parseApiReaderArticleResult(raw), /12-18/);
    const fewerSections = structuredClone(draft);
    fewerSections.sections = fewerSections.sections.slice(0, 12);
    fewerSections.figurePlacements = [];
    assert.throws(() => parseApiReaderArticleResult(JSON.stringify(fewerSections)), /额外字段.*body2/);
});

test('合法字段输出和无法解析的响应不新增原始诊断', () => {
    const draft = createReaderDraft();
    assert.deepEqual(collectDraftIssues(null, null, { rawDraft: JSON.stringify(draft) }), []);
    assert.deepEqual(parseRepairableDraft(JSON.stringify(draft)), draft);
    assert.deepEqual(collectDraftIssues(null, new Error('原错误'), { rawDraft: '{broken' }), [{ path: null, message: '原错误' }]);
});

test('原始字段诊断不能授权局部修改或让假SHA通过', () => {
    const draft = createReaderDraft();
    const issues = collectDraftIssues(null, new Error('原错误'), { rawDraft: JSON.stringify({ ...draft, extra: '未知字段' }) });
    const context = buildRepairContext(draft, issues, '原文证据');
    const originalContext = buildRepairContext(draft, [{ path: null, message: '原错误' }], '原文证据');
    assert.deepEqual(context.targets, originalContext.targets);
    const patch = { version: 1, draftSha256: hashDraft(draft), replacements: [{ path: '/conceptBridges/3', oldSha256: 'PLACEHOLDER', value: '擅自修改' }] };
    assert.throws(() => applyReaderPatch(draft, patch, []), /unknown or unauthorized target/);
});

test('同一运行第二次全篇请求和旧空草稿恢复都收到完整原始诊断', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const deep = require('../scripts/deep-analyzer');
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'raw-reader-feedback-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const paper = { arxivId: '2610.99971', title: '原始输出诊断的离线回放' };
    const sourceText = '原文只用于离线核对，不提供未验证的新事实。';
    const artifacts = { parserVersion: 'unstructured-text-signals-v1', tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex') };
    artifacts.payloadSha256 = deep.stableFingerprint(artifacts);
    const draft = createReaderDraft();
    draft.sections.push(...structuredClone(draft.sections.slice(0, 8)));
    draft.sections[5].body2 = '保留待核对的解释';
    draft.sections[13].tableIntro = '保留待核对的表前说明';
    const raw = JSON.stringify(draft);
    const base = { sourceText, structuredArtifacts: artifacts, readerAttemptsDir: directory,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {}, readerMaxAttempts: 2 };
    let requests = 0;
    const assertFullPrompt = messages => {
        const prompt = messages[0].content[0].text;
        assert.match(prompt, /提交时仍要输出完整 JSON/);
        assert.match(prompt, /原始输出 sections 实际 20 节/);
        assert.match(prompt, /sections\[5\].*body2/);
        assert.match(prompt, /sections\[13\].*tableIntro/);
    };
    await assert.rejects(deep.generateApiReaderArticleDetailed(paper, '', '', { ...base,
        readerCallModel: async messages => {
            requests += 1;
            if (requests === 1) return raw;
            assertFullPrompt(messages);
            throw new Error('offline interruption after inspecting prompt');
        }
    }), /offline interruption/);
    assert.equal(requests, 2);
    const filename = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json')));
    const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(envelope.payload.draft, null);
    assert.equal(envelope.payload.attempts, 1);
    assert.equal(envelope.payload.fullAttempts, 1);
    envelope.payload.issues = envelope.payload.issues.filter(issue => issue.diagnosticOnly !== true);
    envelope.payloadSha256 = hashDraft(envelope.payload);
    fs.writeFileSync(filename, JSON.stringify(envelope), { mode: 0o600 });
    let resumedRequests = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed(paper, '', '', { ...base,
        readerCallModel: async messages => {
            resumedRequests += 1;
            assertFullPrompt(messages);
            throw new Error('offline resumed interruption');
        }
    }), /offline resumed interruption/);
    assert.equal(resumedRequests, 1);
    const recovered = JSON.parse(fs.readFileSync(filename, 'utf8')).payload;
    assert.equal(recovered.draft, null);
    assert.equal(recovered.attempts, 1);
    assert.equal(recovered.fullAttempts, 1);
});

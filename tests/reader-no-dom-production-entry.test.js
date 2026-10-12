'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');

test('正式生成入口恢复已保存错误稿时，局部请求携带无原表指导且保留证据与目标', async t => {
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const draft = sample.draft;
    const sectionIndex = draft.sections.findIndex(section => section.kind === 'training');
    draft.sections[sectionIndex].body = draft.sections[sectionIndex].body.replace(/\| 比较条件[^]*?仅支持当前口径 \|/, '[[TABLE_1]]');
    draft.tableBindings[0] = { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1], sourceColumns: [0, 1] } };
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-no-dom-entry-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sourceEvidence = 'TABLE_ORDINALS_AVAILABLE: []\n原始来源证据必须逐字保留。';
    const options = { sourceText: sample.sourceDetails.text, structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory, readerMaxAttempts: 3, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
    let initialCalls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2609.99961', title: '无原表正式入口' }, '', sourceEvidence, {
        ...options, readerCallModel: async () => {
            if (++initialCalls === 1) return JSON.stringify(draft);
            throw new Error('离线传输中断');
        }
    }), /离线传输中断/);
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2609.99961', title: '无原表正式入口' }, '', sourceEvidence, {
        ...options, readerCallModel: async (messages, tokens, request) => {
            calls += 1;
            assert.equal(request.usageContext.stage, 'apiReaderRepair');
            const prompt = messages[0].content[0].text;
            assert.match(prompt, new RegExp('在已授权 /tableBindings/0 与 /sections/' + sectionIndex + '/body 内'));
            assert.match(prompt, /sourceTableOrdinal:null、cellBindings:\[\]/);
            assert.ok(prompt.includes(sourceEvidence));
            const start = prompt.indexOf('{"draftSha256":');
            const end = prompt.indexOf('\n', start);
            const context = JSON.parse(prompt.slice(start, end));
            const storedFile = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
            const stored = JSON.parse(fs.readFileSync(path.join(directory, storedFile), 'utf8')).payload;
            const expected = repair.buildRepairContext(stored.draft, stored.issues, sourceEvidence, options.sourceText,
                { structuredArtifacts: options.structuredArtifacts, availableFigureOrdinals: [] });
            assert.deepEqual(context.targets, expected.targets);
            assert.equal(context.draftSha256, expected.draftSha256);
            throw new Error('离线请求检查已完成');
        }
    }), /离线请求检查已完成/);
    assert.equal(calls, 1);
});

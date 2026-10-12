const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture: createReaderSample } = require('./reader-signed-draft-fixture');
const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer');

test('实际全文与下一次局部修补请求都收到可见标记要求，不改变授权范围', async t => {
    const sample = createReaderSample({ noFigures: true });
    sample.draft.sections[5].body = '这一节正文太短，需要依据原文继续说明。';
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'visible-reader-guidance-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let calls = 0;
    const stop = Object.assign(new Error('只截获请求，不调用模型'), { scope: 'run', retryable: false });
    await assert.rejects(generateApiReaderArticleDetailed({ arxivId: '2609.12345', title: '可见标记测试' }, 'canonical', '', {
        sourceText: sample.sourceDetails.text, structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory, readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
        readerCallModel: async messages => {
            calls += 1;
            const prompt = messages[0].content[0].text;
            assert.match(prompt, /装配标记必须放在可见正文中/);
            assert.match(prompt, /不得放入 HTML 注释、代码块、行内代码或引用中/);
            if (calls === 1) return JSON.stringify(sample.draft);
            assert.match(prompt, /\/sections\/5\/body/);
            throw stop;
        }
    }), /只截获请求/);
    assert.equal(calls, 2);
});

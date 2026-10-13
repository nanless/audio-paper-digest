'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const requestDirectory = process.env.PD_READER_QUOTE_REQUEST_DIR;
const sourceProject = process.env.PD_READER_QUOTE_SOURCE_PROJECT;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function createSample(quotes) { return { sections: [{ body: '正文及原表不改。' }], tableBindings: [
    { tableIndex: 1, sourceType: 'source_quotes', sourceQuotes: quotes, sourceTableOrdinal: null, cellBindings: [] },
] }; }
test('只恢复完整原句的原文空白，映射记录真实前后草稿SHA', () => {
    const source = 'The result is\n10.0 ms under\tthe same protocol.';
    const quote = 'The result is 10.0 ms under the same protocol.';
    const draft = createSample([quote]);
    const before = structuredClone(draft);
    const mapping = deep.normalizeReaderSourceQuoteWhitespace(draft, source);
    assert.deepEqual(draft.sections, before.sections);
    assert.equal(draft.tableBindings[0].sourceQuotes[0], source);
    assert.equal(mapping.beforeDraftSha256, deep.stableFingerprint(before));
    assert.equal(mapping.afterDraftSha256, deep.stableFingerprint(draft));
    assert.equal(mapping.sourceTextSha256, sha(source));
    assert.equal(mapping.quotes.length, 1);
    assert.equal(deep.normalizeReaderSourceQuoteWhitespace(draft, source), null);
});
test('异值、不同精度、缺词、错单位、错误类型和越界引文不作格式恢复', () => {
    const source = 'The measured result is 10.0 ms under the same protocol.';
    for (const quote of ['The measured result is 11.0 ms under the same protocol.',
        'The measured result is 10 ms under the same protocol.',
        'The result is 10.0 ms under the same protocol.',
        'The measured result is 10.0 s under the same protocol.', { quote: source }, 12, '', 'short']) {
        const draft = createSample([quote]), before = JSON.stringify(draft);
        assert.equal(deep.normalizeReaderSourceQuoteWhitespace(draft, source), null);
        assert.equal(JSON.stringify(draft), before);
    }
    const long = 'a '.repeat(2100), draft = createSample([long]);
    assert.equal(deep.normalizeReaderSourceQuoteWhitespace(draft, long.replace(/ /g, '\n')), null);
    const artifact = { tableBindings: [{ sourceType: 'artifact_table', sourceQuotes: [source.replace(' ', '\n')] }] };
    assert.equal(deep.normalizeReaderSourceQuoteWhitespace(artifact, source), null);
});
test('正常生成器先恢复空白引文再发两个真实语言正文目标，原响应对象不动', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-quote-spacing-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceText = 'The source reports a controlled measurement\nof 1.0 under the same protocol.';
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText });
    const draft = structuredClone(sample.draft);
    for (const binding of draft.tableBindings) binding.sourceQuotes = [sourceText.replace(/\s+/g, ' ')];
    draft.sections[5].body += '\n\n表前说明：当前设置只用于解释已测量的结果。';
    draft.sections[7].body += '\n\n表后解释：当前设置只用于解释已测量的结果。';
    const original = JSON.stringify(draft);
    let calls = 0;
    const result = await deep.generateApiReaderArticleDetailed({ arxivId: '2609.12345', title: '完整原句空白恢复' },
        '', '只使用给定来源', {
            sourceText, structuredArtifacts: sample.sourceDetails.structuredArtifacts,
            readerAttemptsDir: root,
            readerRecordDisposition: async () => {},
            readerCallModel: async (messages, _tokens, request) => {
                calls++;
                if (calls === 1) {
                    assert.equal(request.usageContext.stage, 'apiReaderArticle');
                    return original;
                }
                assert.equal(request.usageContext.stage, 'apiReaderRepair');
                const prompt = typeof messages[0].content === 'string' ? messages[0].content
                    : messages[0].content.filter(item => item.type === 'text').map(item => item.text).join('\n');
                const targetsLine = prompt.split('\n').find(line => line.startsWith('{"draftSha256"') && line.includes('"targets"'));
                assert.ok(targetsLine);
                const context = JSON.parse(targetsLine);
                assert.deepEqual(context.targets.map(target => target.path).sort(), ['/sections/5/body', '/sections/7/body']);
                assert.ok(!prompt.includes('sourceQuotes 中以下数组项不是全文'));
                return JSON.stringify({ version: 1, draftSha256: context.draftSha256,
                    replacements: context.targets.map(target => ({ path: target.path, oldSha256: target.oldSha256,
                        value: target.value.replace('表前说明：', '').replace('表后解释：', '') })) });
            },
        });
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.fullAttempts, 1);
    assert.ok(result.draftOrderMappings.some(mapping => mapping.contract === 'reader-source-quote-whitespace-v1'));
    assert.equal(JSON.stringify(draft), original);
});
test('真实05055只剩两个正文目标，04570七条空白恢复而四条实质差异仍拒',
    { skip: !requestDirectory || !sourceProject }, () => {
        for (const [id, requestId, changed, invalid, targets] of [
            ['2610.05055', '5427b35c-cb98-4117-aff0-263469e6ce60', 4, 0, ['/sections/8/body', '/sections/11/body']],
            ['2610.04570', 'ab62066e-c6ac-445b-9495-81d83018ff89', 7, 4,
                ['/tableBindings/0', '/sections/8/body', '/tableBindings/1', '/sections/9/body']],
        ]) {
            const filename = path.join(requestDirectory, requestId + '.request.json');
            const bytes = fs.readFileSync(filename), request = JSON.parse(bytes);
            const sourceDir = path.join(sourceProject, 'data/runtime/daily-fresh-source-runs/132fc843-0afe-434c-b0b7-4d98e2235b3e/sources', id, 'generation-000001');
            const sourceFiles = Object.fromEntries(['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
                .map(name => [name, sha(fs.readFileSync(path.join(sourceDir, name)))]));
            const paidPath = path.join(path.dirname(requestDirectory), repair.hashDraft(request.identity) + '.json');
            const paidBytes = fs.readFileSync(paidPath);
            const originalFees = JSON.parse(paidBytes).payload;
            const sourceBytes = fs.readFileSync(path.join(sourceDir, 'source.txt'));
            const sourceText = sourceBytes.toString('utf8');
            assert.equal(sha(sourceBytes), request.identity.sourceSha256);
            const sourceRuntime = JSON.parse(fs.readFileSync(path.join(sourceDir, 'source-runtime.json')));
            const draft = typeof request.draft === 'string' ? JSON.parse(request.draft) : structuredClone(request.draft);
            const sections = JSON.stringify(draft.sections);
            const mapping = deep.normalizeReaderSourceQuoteWhitespace(draft, sourceText);
            assert.equal(mapping.quotes.length, changed);
            assert.equal(JSON.stringify(draft.sections), sections);
            let error;
            try { deep.parseApiReaderArticleResult(JSON.stringify(draft), { arxivId: id, requiredVersion: 3,
                requireIntegratedTables: true, minimumIntegratedTables: 2, requireSourceBindings: true,
                sourceText, structuredArtifacts: sourceRuntime.structuredArtifacts,
                allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true }); }
            catch (caught) { error = caught; }
            assert.ok(error);
            const issues = repair.collectDraftIssues(draft, error, { sourceText, structuredArtifacts: sourceRuntime.structuredArtifacts });
            const remaining = draft.tableBindings.flatMap(binding => binding.sourceType === 'source_quotes'
                ? binding.sourceQuotes.filter(quote => !sourceText.includes(quote)) : []);
            assert.equal(remaining.length, invalid);
            const context = repair.buildRepairContext(draft, issues, '实际原文证据', sourceText,
                { structuredArtifacts: sourceRuntime.structuredArtifacts });
            assert.deepEqual(context.targets.map(target => target.path).sort(), targets.sort());
            assert.equal(context.draftSha256, repair.hashDraft(draft));
            assert.equal(sha(fs.readFileSync(filename)), sha(bytes));
            for (const [name, expected] of Object.entries(sourceFiles))
                assert.equal(sha(fs.readFileSync(path.join(sourceDir, name))), expected);
            assert.equal(sha(fs.readFileSync(paidPath)), sha(paidBytes));
            const finalFees = JSON.parse(fs.readFileSync(paidPath)).payload;
            for (const key of ['attempts', 'fullAttempts', 'transportFailures']) assert.equal(finalFees[key], originalFees[key]);
        }
    });

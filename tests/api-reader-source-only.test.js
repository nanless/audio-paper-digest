'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { READER_SOURCE_CONTENT_MODE } = require('../scripts/lib/reader-contract.js');

test('Reader evidence is invariant to canonical prose and retains original-source markers', () => {
    const { buildApiReaderEvidenceContext } = require('../scripts/deep-analyzer.js');
    const source = 'ORIGINAL_SOURCE_ONLY_MARKER. The paper reports the evaluation protocol and measured results.';
    const artifacts = { tables: [], formulas: [], figures: [] };
    const first = buildApiReaderEvidenceContext('## 方法概述和架构\nOLD_CANONICAL_CLAIM', source, artifacts);
    const second = buildApiReaderEvidenceContext('## 机器摘要\ndocument_type: 理论研究\n## 方法概述和架构\nDIFFERENT_GENERATED_CLAIM', source, artifacts);
    assert.equal(first, second);
    assert.match(first, /ORIGINAL_SOURCE_ONLY_MARKER/);
    assert.doesNotMatch(first, /OLD_CANONICAL_CLAIM|DIFFERENT_GENERATED_CLAIM/);
});

test('first actual Reader request excludes canonical and existing Reader while preserving source evidence', async t => {
    const { generateApiReaderArticleDetailed, buildApiReaderEvidenceContext } = require('../scripts/deep-analyzer.js');
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-source-only-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const oldCanonical = 'OLD_CANONICAL_UNIQUE_MARKER: unsupported scientific inference';
    const oldReader = 'OLD_READER_UNIQUE_MARKER: previously generated article';
    const paper = { arxivId: '2609.88881', title: 'Source-grounded speech research',
        analysis: oldCanonical, apiReaderArticle: oldReader, parsed: { score: 9.9 } };
    const sourceText = 'ORIGINAL_SOURCE_UNIQUE_MARKER. The paper describes the actual measured protocol.';
    const sourceEvidence = buildApiReaderEvidenceContext(oldCanonical, sourceText,
        { tables: [], formulas: [], figures: [] });
    let requests = 0;
    await assert.rejects(generateApiReaderArticleDetailed(paper, oldCanonical, sourceEvidence, {
        sourceText, readerAttemptsDir: directory, readerMaxAttempts: 1,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async messages => {
            requests++;
            const captured = JSON.stringify(messages);
            assert.match(captured, /ORIGINAL_SOURCE_UNIQUE_MARKER/);
            assert.doesNotMatch(captured, /OLD_CANONICAL_UNIQUE_MARKER|OLD_READER_UNIQUE_MARKER/);
            assert.doesNotMatch(captured, /\{existingAnalysis\}/);
            throw new Error('source-only request captured without sending');
        }
    }), /source-only request captured/);
    assert.equal(requests, 1);
    const envelopes = fs.readdirSync(directory).map(filename => JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8')));
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].identity.contentMode, READER_SOURCE_CONTENT_MODE);
    assert.doesNotMatch(JSON.stringify(envelopes[0]), /OLD_CANONICAL_UNIQUE_MARKER|OLD_READER_UNIQUE_MARKER/);
    assert.equal(envelopes[0].payload.rawDraft, '无');
});

test('source-only prompt removes canonical context and avoids prompting untested causal explanations', () => {
    const prompt = fs.readFileSync(path.resolve(__dirname, '../prompts/api-reader-article.md'), 'utf8');
    assert.doesNotMatch(prompt, /\{existingAnalysis\}|现有 canonical 分析/);
    assert.match(prompt, /原文给出的安排理由和已验证对照/);
    assert.match(prompt, /区分分布曲线和单样本标记/);
    assert.match(prompt, /比较必须保留原文实际可运行的策略/);
});

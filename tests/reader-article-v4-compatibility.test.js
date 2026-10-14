const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const versions = require('../scripts/lib/prompt-text-versions');
const fresh = require('../scripts/lib/fresh-analysis-context');
const Config = require('../scripts/config');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('旧完成 Reader 保留冻结 v3 正文，新待处理记录使用 v8', () => {
    const paper = { id: '2610.90011', title: '读者文章版本测试' };
    const old = { status: 'complete', promptTextContract: 'analysis-prompt-text-v3',
        repairPromptTextContract: versions.currentPromptTextContract('apiReaderRepair') };
    const bytes = JSON.stringify(old);
    const fingerprint = stage => deep.buildRecoveryFingerprints(paper, '来源', paper.id,
        { stages: { apiReaderArticle: stage } }).apiReaderArticle;
    const oldFingerprint = fingerprint(old);
    assert.equal(versions.promptFilePathForContract('apiReaderArticle', old.promptTextContract), 'prompts/api-reader-article-v3.md');
    assert.equal(versions.currentPromptTextContract('apiReaderArticle'), 'analysis-prompt-text-v8');
    assert.notEqual(fingerprint({ status: 'pending' }), oldFingerprint);
    assert.equal(fingerprint(old), oldFingerprint);
    assert.equal(JSON.stringify(old), bytes);
    assert.equal(sha(require('../scripts/lib/prompt-evidence.js').readPromptEvidenceBytes('prompts/api-reader-article-v3.md')),
        'ebb4c613fa60464f826f41a931c9bce5998559a685cd11ab16f7a6f4290ace63');
});

test('正常公开 Reader 首请求实际渲染新节数要求，模型请求由本地函数阻断', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-v4-input-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const previous = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = root;
    t.after(() => { Config.FILES.freshRewriteRunsDir = previous; });
    const runId = crypto.randomUUID(), runDir = path.join(root, runId), id = '2610.90011';
    fs.mkdirSync(runDir, { mode: 0o700 });
    const text = 'This controlled acoustic source describes speech analysis. '.repeat(1000);
    const body = { figures: [], formulas: [], tables: [], flattenedTextSha256: sha(text), parserVersion: 'offline-empty-source-v1', version: 1 };
    const artifacts = { ...body, payloadSha256: sha(JSON.stringify(body)) };
    const sourceExpectations = { [id]: { sourceSha256: sha(text), structuredArtifactsSha256: artifacts.payloadSha256 } };
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ version: 1, contract: 'fresh-rewrite-run-v1', runId, paperIds: [id], sourceExpectations }), { mode: 0o600 });
    let calls = 0;
    const stop = Object.assign(new Error('本地捕获后停止'), { retryable: false, scope: 'run' });
    await fresh.withFreshAnalysisContext({ runId, runDir, sourceExpectations }, async () => {
        await fresh.fetchFreshSource(id, async () => ({ source: 'html', sourceId: id, text, structuredArtifacts: artifacts }));
        await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: id, title: '本地新提示词请求' }, '', '', {
            sourceText: text, structuredArtifacts: artifacts, readerAttemptsDir: path.join(runDir, 'reader-attempts'),
            readerMaxAttempts: 1, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
            readerCallModel: async (messages, budget, options) => {
                calls++;
                assert.equal(options.usageContext.stage, 'apiReaderArticle');
                const prompt = messages[0].content[0].text;
                assert.match(prompt, /建议安排 14–16 节/);
                assert.match(prompt, /实际数一次数组项数/);
                assert.match(prompt, /不得为压缩节数删掉证据、数字、单位/);
                throw stop;
            }
        }), /本地捕获后停止/);
    });
    assert.equal(calls, 1);
});

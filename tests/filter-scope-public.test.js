'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');
const pipeline = require('../scripts/fetch-papers.js');
const scope = require('../scripts/lib/filter-scope-evidence.js');
const batchDate = '2026-10-11';
function treeSnapshot(root) {
    if (!fs.existsSync(root)) return null;
    const rows = [];
    const visit = directory => {
        for (const name of fs.readdirSync(directory).sort()) {
            const filename = path.join(directory, name);
            const stat = fs.lstatSync(filename);
            if (stat.isDirectory()) visit(filename);
            else rows.push([path.relative(root, filename), stat.mode, stat.isSymbolicLink()
                ? fs.readlinkSync(filename)
                : crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')]);
        }
    };
    visit(root);
    return rows;
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'filter-scope-public-'));
    const original = Config.FILES.freshArxivFetchedSourcesDir;
    const before = treeSnapshot(original);
    Config.FILES.freshArxivFetchedSourcesDir = path.join(root, 'sources');
    t.after(() => {
        Config.FILES.freshArxivFetchedSourcesDir = original;
        try {
            assert.deepEqual(treeSnapshot(original), before, '默认来源目录原字节必须保持');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}
function paper(id = '2610.90011', title = 'A general multimodal model') {
    return { arxivId: id, title, abstract: 'We study multimodal representations and evaluate general capabilities.', categories: ['cs.AI'] };
}
function officialSources(counts, text = 'The model has an audio tokenizer and evaluates music generation. '.repeat(50)) {
    return {
        fetchText: async id => {
            counts.text++;
            return { text, source: 'html', sourceId: `${id}v1`, url: `https://arxiv.org/html/${id}v1`, fetchedAt: '2026-10-11T00:00:00.000Z' };
        },
        fetchPdf: async id => {
            counts.pdf++;
            return { bytes: Buffer.from(`%PDF-1.7\nOfficial paper ${id}\n%%EOF\n`), url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: '2026-10-11T00:00:01.000Z' };
        }
    };
}
function options(overrides, decisionFn, initialDecisions) {
    return { batchSize: 2, delayBetweenBatches: 0, decisionMetadata: { batchDate, filterModel: 'local-test-model', filterPromptHash: require('../scripts/full-fetch.js').getFilterPromptHash() },
        decisionOptions: { scopeSourceOverrides: overrides }, decisionFn, initialDecisions };
}
function decision(related) {
    return { related, reason: related ? '官方正文包含音频实验' : '官方正文仅包含视觉实验', rawResponse: JSON.stringify({ related }), parseSource: 'json', retryable: false, fallback: false };
}
async function run(papers, runOptions) {
    let saved;
    const callback = runOptions.onBatchComplete;
    runOptions.onBatchComplete = async snapshot => {
        saved = snapshot;
        if (callback) await callback(snapshot);
    };
    const selected = await pipeline.filterPapersWithLLM(papers, runOptions);
    assert.ok(saved, '正常筛选必须保存正式批次结果');
    return { selected, ...saved };
}
test('泛多模态论文先封存官方材料，正文与输入 SHA 对应且原候选不变', async t => {
    fixture(t);
    const candidate = paper();
    const before = JSON.stringify(candidate);
    const counts = { text: 0, pdf: 0, model: 0 };
    assert.equal(pipeline.evaluateKeywordPrefilter(candidate).requiresScopeEvidence, true);
    const result = await run([candidate], options(officialSources(counts), async input => {
        counts.model++;
        assert.match(input.filterScopeEvidence.text, /audio tokenizer/);
        scope.assertFilterScopeEvidence(input, input.filterScopeEvidence, batchDate);
        return decision(true);
    }));
    const saved = result.decisions[candidate.arxivId];
    assert.equal(saved.related, true);
    assert.notEqual(saved.inputSha256, pipeline.buildFilterInputSha256(candidate));
    assert.equal(saved.inputSha256, scope.validatedDecisionInputSha256(candidate, saved));
    assert.equal(JSON.stringify(candidate), before);
    assert.deepEqual(counts, { text: 1, pdf: 1, model: 1 });
});
test('任一范围来源失败时，所有论文都尚未请求模型或保存否定决定', async t => {
    fixture(t);
    const counts = { text: 0, pdf: 0, model: 0, saved: 0 };
    const overrides = officialSources(counts);
    overrides.fetchText = async () => { throw new Error('本地官方来源获取失败'); };
    const audio = { ...paper('2610.90012', 'Speech recognition'), abstract: 'We evaluate speech recognition.' };
    const runOptions = options(overrides, async () => { counts.model++; return decision(false); });
    runOptions.onBatchComplete = async () => { counts.saved++; };
    await assert.rejects(pipeline.filterPapersWithLLM([audio, paper()], runOptions), /本地官方来源获取失败/);
    assert.equal(counts.model, 0);
    assert.equal(counts.saved, 0);
});
test('封存完成但尚无决定时继续筛选不重抓，明确非音频结果可正常保存', async t => {
    fixture(t);
    const candidate = paper();
    const counts = { text: 0, pdf: 0, model: 0 };
    await scope.captureFilterScopeEvidence(candidate, batchDate, officialSources(counts, 'The model processes RGB images and text only. '.repeat(50)));
    const overrides = {
        fetchText: async () => { throw new Error('已有封存文本不应再次获取'); },
        fetchPdf: async () => { throw new Error('已有封存 PDF 不应再次获取'); }
    };
    const result = await run([candidate], options(overrides, async input => {
        counts.model++;
        assert.match(input.filterScopeEvidence.text, /RGB images/);
        return decision(false);
    }));
    assert.equal(result.decisions[candidate.arxivId].related, false);
    assert.deepEqual(counts, { text: 1, pdf: 1, model: 1 });
    const resumed = await run([candidate], options(overrides, async () => {
        throw new Error('同来源有效决定不应重新请求模型');
    }, result.decisions));
    assert.equal(resumed.decisions[candidate.arxivId].inputSha256, result.decisions[candidate.arxivId].inputSha256);
});
test('封存文本字节损坏时，在模型请求前拒绝恢复', async t => {
    fixture(t);
    const candidate = paper();
    const counts = { text: 0, pdf: 0, model: 0 };
    const evidence = await scope.captureFilterScopeEvidence(candidate, batchDate, officialSources(counts));
    const filename = path.join(evidence.rootDir, candidate.arxivId, 'generation-000001', 'source.txt');
    fs.appendFileSync(filename, '被修改的内容');
    await assert.rejects(pipeline.filterPapersWithLLM([candidate], options(officialSources(counts), async () => {
        counts.model++; return decision(false);
    })));
    assert.equal(counts.model, 0);
});
test('真实筛选请求正文包含封存材料，输入 SHA 与仅摘要输入不同', async t => {
    fixture(t);
    const candidate = paper();
    const counts = { text: 0, pdf: 0, model: 0 };
    const old = { ...decision(false), inputSha256: pipeline.buildFilterInputSha256(candidate) };
    const runOptions = options(officialSources(counts), undefined);
    delete runOptions.decisionFn;
    runOptions.decisionOptions.filterConfig = { endpoint: 'https://example.invalid/v1', key: 'local-test', model: 'local-test-model' };
    runOptions.decisionOptions.requestFn = async (url, endpoint, model, body) => {
        counts.model++;
        assert.match(body.messages[0].content, /<official-paper-scope>/);
        assert.match(body.messages[0].content, /audio tokenizer/);
        return { statusCode: 200, body: { choices: [{ message: { content: '{"related":true,"reason":"官方音频实验"}' }, finish_reason: 'stop' }] } };
    };
    const result = await run([candidate], runOptions);
    assert.equal(counts.model, 1);
    assert.equal(result.decisions[candidate.arxivId].related, true);
    assert.notEqual(result.decisions[candidate.arxivId].inputSha256, old.inputSha256);
});
test('需要官方范围的决定不能删除来源证明后改用仅摘要 SHA', async t => {
    fixture(t);
    const candidate = paper();
    const counts = { text: 0, pdf: 0, model: 0 };
    const result = await run([candidate], options(officialSources(counts), async () => decision(false)));
    const removed = { ...result.decisions[candidate.arxivId] };
    delete removed.filterScopeEvidence;
    removed.inputSha256 = pipeline.buildFilterInputSha256(candidate);
    assert.throws(() => scope.validatedDecisionInputSha256(candidate, removed), /来源|范围/);
});
test('单篇公开筛选入口没有现成证明时也先封存再发送正文', async t => {
    fixture(t);
    const candidate = paper();
    const counts = { text: 0, pdf: 0, model: 0 };
    const result = await pipeline.getSpeechAudioDecision(candidate, {
        batchDate,
        scopeSourceOverrides: officialSources(counts),
        filterConfig: { endpoint: 'https://example.invalid/v1', key: 'local-test', model: 'local-test-model' },
        requestFn: async (url, endpoint, model, body) => {
            counts.model++;
            assert.match(body.messages[0].content, /audio tokenizer/);
            assert.match(body.messages[0].content, /<official-paper-scope>/);
            return { statusCode: 200, body: { choices: [{ message: { content: '{"related":true,"reason":"官方音频实验"}' }, finish_reason: 'stop' }] } };
        }
    });
    assert.equal(result.related, true);
    assert.deepEqual(counts, { text: 1, pdf: 1, model: 1 });
    assert.equal(candidate.filterScopeEvidence, undefined);
});
test('明确待重筛的占位不冒充正式决定，允许原输入等待模型', () => {
    const candidate = paper();
    const pending = { related: null, retryable: true, fallback: true, rawResponse: '', parseSource: 'explicit_recheck_pending' };
    assert.equal(scope.validatedDecisionInputSha256(candidate, pending, { filterModel: 'local-test-model', filterPromptHash: 'current' }), pipeline.buildFilterInputSha256(candidate));
    assert.throws(() => scope.validatedDecisionInputSha256(candidate, { ...pending, related: false }, { filterModel: 'local-test-model', filterPromptHash: 'current' }), error => error.code === 'FILTER_SCOPE_SOURCE_INTEGRITY', '正式否定决定不能冒用待重筛标记');
});
test('口语与韵律术语交给模型筛选，不需用论文 ID 放行', () => {
    for (const term of ['spoken dialogue', 'prosodic features']) {
        const candidate = { ...paper(), title: 'Representation study', abstract: `We evaluate ${term} through controlled experiments and report the resulting model behavior.` };
        const result = pipeline.evaluateKeywordPrefilter(candidate);
        assert.equal(result.pass, true);
        assert.equal(result.requiresScopeEvidence, false);
    }
});
test('API 恢复不复用冒称人工筛选的缺来源决定', async t => {
    fixture(t);
    const fullFetch = require('../scripts/full-fetch.js');
    const candidate = paper();
    const counts = { text: 0, pdf: 0, model: 0 };
    const result = await run([candidate], options(officialSources(counts), async () => decision(false)));
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'filter-scope-resume-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const common = { timestamp: '2026-10-11T10:00:00+08:00', batchDate, batchId: 'local-scope',
        candidateFingerprint: 'candidate-local', sourceConfigFingerprint: 'source-local', blogDedupFingerprint: 'blog-local' };
    const categories = Config.ARXIV_CATEGORIES.map(category => category.id);
    const checkpointFile = path.join(directory, 'fetch-checkpoint.json');
    fullFetch.saveFetchCheckpoint({ ...common, batchStartedAt: common.timestamp, historicalDedupIds: [], categoryOrder: categories,
        arxiv: Object.fromEntries(categories.map(id => [id, { status: 'complete', papers: [candidate], health: { id, ok: true } }])),
        huggingface: { status: 'complete', papers: [], health: { ok: true } } }, checkpointFile);
    const checkpoint = JSON.parse(fs.readFileSync(checkpointFile));
    const raw = { ...common, papers: [candidate], rawPapersSha256: fullFetch.stableContentSha256([candidate]),
        fetchSourcesSha256: checkpoint.fetchSourcesSha256,
        sourceHealth: { arxiv: { categories: categories.map(id => ({ id, ok: true })) }, huggingface: { ok: true } } };
    const rawFile = path.join(directory, 'raw-candidates.json');
    const decisionFile = path.join(directory, 'filter-decisions.json');
    fs.writeFileSync(rawFile, JSON.stringify(raw));
    const expected = { ...common, filterModel: 'local-test-model', filterPromptHash: fullFetch.getFilterPromptHash(), filterConfigFingerprint: 'config-local' };
    const saved = { ...expected, rawPapersSha256: raw.rawPapersSha256, fetchSourcesSha256: raw.fetchSourcesSha256,
        decisions: result.decisions };
    fs.writeFileSync(decisionFile, JSON.stringify(saved));
    const files = { rawCandidates: rawFile, filterDecisions: decisionFile, fetchCheckpoint: checkpointFile };
    assert.equal(fullFetch.loadResumableFilterForToday(batchDate, expected, files).coverage.complete, true);
    const previousOptions = options(officialSources(counts), async () => decision(false));
    previousOptions.decisionMetadata.batchDate = '2026-10-10';
    const previous = await run([candidate], previousOptions);
    assert.equal(previous.decisions[candidate.arxivId].batchDate, '2026-10-10');
    fs.writeFileSync(decisionFile, JSON.stringify({ ...saved, decisions: previous.decisions }));
    assert.throws(() => fullFetch.loadResumableFilterForToday(batchDate, expected, files),
        error => error.code === 'FILTER_SCOPE_SOURCE_INTEGRITY',
        '当前批次不能复用旧日期封存的官方范围来源');
    const changed = { ...saved.decisions[candidate.arxivId], filterModel: 'manual_offline', inputSha256: pipeline.buildFilterInputSha256(candidate) };
    delete changed.filterScopeEvidence;
    fs.writeFileSync(decisionFile, JSON.stringify({ ...saved, filterModel: 'manual_offline', decisions: { [candidate.arxivId]: changed } }));
    const resumed = fullFetch.loadResumableFilterForToday(batchDate, expected, files);
    assert.equal(resumed.coverage.complete, false);
    assert.deepEqual(resumed.decisionsData.decisions, {});
    fs.writeFileSync(decisionFile, JSON.stringify({ ...saved, decisions: { [candidate.arxivId]: changed } }));
    let mixedResult;
    let mixedError;
    try {
        mixedResult = fullFetch.loadResumableFilterForToday(batchDate, expected, files);
    } catch (error) {
        mixedError = error;
    }
    assert.ok(mixedError?.code === 'FILTER_SCOPE_SOURCE_INTEGRITY'
        || mixedResult?.coverage.complete === false,
    'API 顶层模型下单项人工标记不能省略来源证明');
    for (const field of ['filterModel', 'filterPromptHash']) {
        const mismatched = { ...saved.decisions[candidate.arxivId], [field]: 'other-version' };
        fs.writeFileSync(decisionFile, JSON.stringify({ ...saved, decisions: { [candidate.arxivId]: mismatched } }));
        assert.throws(() => fullFetch.loadResumableFilterForToday(batchDate, expected, files),
            error => error.code === 'FILTER_SCOPE_SOURCE_INTEGRITY',
            `单篇 ${field} 与实际批次不符时必须拒绝复用`);
    }
});

test('人工筛选真实保存的整批决定通过公共来源校验，API 不借用该许可', t => {
    const fullFetch = require('../scripts/full-fetch.js');
    const manual = require('../manual/scripts/manual-fetch.js');
    const validator = require('../scripts/validate-data-files.js');
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'filter-scope-manual-'));
    const originalFiles = { ...Config.FILES };
    const originalDataDir = Config.DATA_DIR;
    const originalTree = treeSnapshot(originalDataDir);
    Config.DATA_DIR = directory;
    for (const key of Object.keys(Config.FILES)) {
        if (typeof Config.FILES[key] === 'string') Config.FILES[key] = path.join(directory, key);
    }
    t.after(() => {
        Object.assign(Config.FILES, originalFiles);
        Config.DATA_DIR = originalDataDir;
        try { assert.deepEqual(treeSnapshot(originalDataDir), originalTree, '默认证据与论文库原字节必须保持'); }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
    const candidate = { ...paper(), sources: ['arxiv'], fetchedAt: '2026-10-11T10:00:00+08:00' };
    const categories = Config.ARXIV_CATEGORIES.map(category => category.id);
    const common = { timestamp: candidate.fetchedAt, batchStartedAt: candidate.fetchedAt, batchDate, batchId: 'aaaaaaaaaaaaaaaa',
        candidateFingerprint: 'bbbbbbbbbbbbbbbb', sourceConfigFingerprint: 'cccccccccccccccc', blogDedupFingerprint: 'dddddddddddddddd' };
    fullFetch.saveFetchCheckpoint({ ...common, historicalDedupIds: [], categoryOrder: categories,
        arxiv: Object.fromEntries(categories.map(id => [id, { status: 'complete', papers: [candidate], health: { id, ok: true } }])),
        huggingface: { status: 'complete', papers: [], health: { ok: true } } }, Config.FILES.fetchCheckpoint);
    const checkpoint = JSON.parse(fs.readFileSync(Config.FILES.fetchCheckpoint));
    const raw = { ...common, filterContract: 'manual-offline-v1', papers: [candidate],
        rawPapersSha256: fullFetch.stableContentSha256([candidate]), fetchSourcesSha256: checkpoint.fetchSourcesSha256,
        sourceHealth: { arxiv: { categories: categories.map(id => ({ id, ok: true })) }, huggingface: { ok: true } },
        stats: { beforeBlogSkip: 1, afterBlogSkip: 1, skippedFromBlog: 0, arxivOnly: 1, hfOnly: 0, both: 0 } };
    fs.writeFileSync(Config.FILES.rawCandidates, JSON.stringify(raw));
    const specPath = path.join(directory, 'selection.json');
    fs.writeFileSync(specPath, JSON.stringify({ version: 1, mode: 'manual_offline', date: batchDate, reviewer: '本地审查员',
        decisions: { [candidate.arxivId]: { related: false, reason: '已逐项阅读原题摘要类别与来源，本文没有实际音频研究证据。',
            reviewedFields: ['title', 'abstract', 'categories', 'sources'] } } }));
    manual.writeSelection(batchDate, specPath);
    const saved = JSON.parse(fs.readFileSync(Config.FILES.filterDecisions));
    assert.equal(saved.filterContract, 'manual-offline-v1');
    assert.equal(saved.decisions[candidate.arxivId].filterModel, 'manual_offline');
    const issues = validator.validateCurrentDataFiles(Config.FILES);
    assert.deepEqual(issues, [], '真实人工保存的整批数据必须通过公共校验');
    assert.throws(() => scope.validatedDecisionInputSha256(candidate, saved.decisions[candidate.arxivId]),
        error => error.code === 'FILTER_SCOPE_SOURCE_INTEGRITY');
});

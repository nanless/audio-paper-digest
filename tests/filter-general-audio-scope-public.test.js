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

test('通用声音表示与推理采样先取官方方法实验，真实请求收到正文且原候选不变', async t => {
    fixture(t);
    const candidates = [
        { ...paper('2610.90021', 'General latent representations with speech decoding'), abstract: 'We examine a general representation framework and evaluate speech decoding with an interface.' },
        { ...paper('2610.90022', 'Inference sampling for music generation'), abstract: 'We propose a general sampling algorithm and evaluate music generation without training a new module.' }
    ];
    const before = JSON.stringify(candidates);
    for (const candidate of candidates) {
        const counts = { text: 0, pdf: 0, model: 0 };
        const route = pipeline.evaluateKeywordPrefilter(candidate);
        assert.equal(route.pass, true);
        assert.equal(route.requiresScopeEvidence, true);
        const text = candidate.arxivId.endsWith('21')
            ? 'Methods: We train a speech adapter and acoustic decoder. Experiments: We evaluate generated speech with word error rate. '
            : 'Methods: We modify the inference-time sampler of a music generator without training. Experiments: We measure generated music quality. ';
        const requestOptions = options(officialSources(counts, text.repeat(50)), undefined);
        delete requestOptions.decisionFn;
        Object.assign(requestOptions.decisionOptions, {
            filterConfig: { endpoint: 'https://example.invalid/v1', key: 'local-test', model: 'local-test-model' },
            requestFn: async (url, endpoint, model, requestBody) => {
                counts.model++;
                assert.match(requestBody.messages[0].content, /<official-paper-scope>/);
                assert.ok(requestBody.messages[0].content.includes(text));
                return { statusCode: 200, body: { choices: [{ message: { content: '{"related":true,"reason":"本地响应确认收到方法实验"}' }, finish_reason: 'stop' }] } };
            }
        });
        const result = await run([candidate], requestOptions);
        const saved = result.decisions[candidate.arxivId];
        assert.equal(saved.related, true);
        assert.notEqual(saved.inputSha256, pipeline.buildFilterInputSha256(candidate));
        scope.assertFilterScopeEvidence(candidate, saved.filterScopeEvidence, batchDate);
        assert.deepEqual(counts, { text: 1, pdf: 1, model: 1 });
    }
    assert.equal(JSON.stringify(candidates), before);
});
test('固定音频基准也先核正文，同四件来源及有效否定恢复不重抓或重请求', async t => {
    fixture(t);
    const candidate = { ...paper('2610.90023', 'General optimization on an audio benchmark'), abstract: 'We study a general optimization theory and report an existing audio benchmark.' };
    const counts = { text: 0, pdf: 0, model: 0 };
    assert.equal(pipeline.evaluateKeywordPrefilter(candidate).requiresScopeEvidence, true);
    const result = await run([candidate], options(officialSources(counts, 'Methods: The audio system remains unchanged. Experiments: A fixed benchmark only verifies a general convergence property. '.repeat(50)), async input => {
        counts.model++;
        assert.match(input.filterScopeEvidence.text, /audio system remains unchanged/);
        return decision(false);
    }));
    const saved = result.decisions[candidate.arxivId];
    assert.equal(saved.related, false);
    assert.notEqual(saved.inputSha256, pipeline.buildFilterInputSha256(candidate));
    const resumed = await run([candidate], options({
        fetchText: async () => { throw new Error('已有官方文本不能重新获取'); },
        fetchPdf: async () => { throw new Error('已有官方 PDF 不能重新获取'); }
    }, async () => { throw new Error('有效同来源决定不能重新请求模型'); }, result.decisions));
    assert.equal(resumed.decisions[candidate.arxivId].inputSha256, saved.inputSha256);
    assert.deepEqual(counts, { text: 1, pdf: 1, model: 1 });
});
test('通用音频方法取证失败时，全批尚无模型请求或否定决定', async t => {
    fixture(t);
    const candidate = { ...paper('2610.90024', 'A sampling algorithm for audio generation'), abstract: 'We propose a general inference algorithm for audio generation.' };
    let calls = 0;
    let saved = 0;
    const runOptions = options({ fetchText: async () => { throw new Error('本地官方方法实验不可获取'); }, fetchPdf: async () => { throw new Error('本地 PDF 不应请求'); } }, async () => { calls++; return decision(false); });
    runOptions.onBatchComplete = async () => { saved++; };
    await assert.rejects(pipeline.filterPapersWithLLM([candidate], runOptions), /本地官方方法实验不可获取/);
    assert.equal(calls, 0);
    assert.equal(saved, 0);
});
test('通用音频方法封存损坏拒绝模型，旧仅摘要决定不能冒用完整来源', async t => {
    fixture(t);
    const candidate = { ...paper('2610.90025', 'Latent representation for speech generation'), abstract: 'We analyze a general latent representation and evaluate speech generation.' };
    const counts = { text: 0, pdf: 0, model: 0 };
    const evidence = await scope.captureFilterScopeEvidence(candidate, batchDate, officialSources(counts));
    const old = { ...decision(false), filterModel: 'local-test-model', filterPromptHash: require('../scripts/full-fetch.js').getFilterPromptHash(), batchDate, inputSha256: pipeline.buildFilterInputSha256(candidate) };
    assert.throws(() => scope.validatedDecisionInputSha256(candidate, old), /来源|范围/);
    fs.appendFileSync(path.join(evidence.rootDir, candidate.arxivId, 'generation-000001', 'source.txt'), '损坏的正文');
    await assert.rejects(pipeline.filterPapersWithLLM([candidate], options(officialSources(counts), async () => { counts.model++; return decision(false); })));
    assert.equal(counts.model, 0);
});

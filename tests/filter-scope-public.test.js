'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
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
// 默认路径的保护检查也在独立目录完成，不遍历用户累积的论文、PDF 和付费记录。
// 各测试仍须证明它没有改动自己未获授权的默认文件。
const savedFiles = { ...Config.FILES };
const savedDataDir = Config.DATA_DIR;
const savedArchiveDir = Config.ARCHIVE_DIR;
const savedCurrentDir = Config.CURRENT_DIR;
let isolatedDefaults;
test.before(() => {
    isolatedDefaults = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'filter-scope-defaults-'));
    Config.DATA_DIR = isolatedDefaults;
    Config.ARCHIVE_DIR = path.join(isolatedDefaults, 'archive');
    Config.CURRENT_DIR = path.join(isolatedDefaults, 'current');
    for (const key of Object.keys(Config.FILES)) {
        if (typeof Config.FILES[key] === 'string') Config.FILES[key] = path.join(isolatedDefaults, key);
    }
    fs.mkdirSync(Config.FILES.freshArxivFetchedSourcesDir, { recursive: true });
    fs.writeFileSync(path.join(Config.FILES.freshArxivFetchedSourcesDir, '保留来源.txt'), '未经授权不能改动的原始来源。');
    fs.writeFileSync(path.join(isolatedDefaults, '保留记录.json'), JSON.stringify({ note: '已有论文和付费记录必须保留' }));
    const archiveDay = path.join(Config.ARCHIVE_DIR, '2026-10-01');
    fs.mkdirSync(archiveDay, { recursive: true });
    fs.writeFileSync(path.join(archiveDay, 'deep-analysis-result.json'), JSON.stringify({ papers: [] }));
});
test.after(() => {
    Object.assign(Config.FILES, savedFiles);
    Config.DATA_DIR = savedDataDir;
    Config.ARCHIVE_DIR = savedArchiveDir;
    Config.CURRENT_DIR = savedCurrentDir;
    if (isolatedDefaults) fs.rmSync(isolatedDefaults, { recursive: true, force: true });
});
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

test('scope windows preserve complete mathematical Unicode code points and bind the corrected selection', async t => {
    fixture(t);
    const candidate = paper('2610.90091');
    const text = 'a'.repeat(11999) + '𝐱' + 'b'.repeat(11998) + '𝐱' + ('audio 𝐲 speech 𝛽 '.repeat(11000));
    assert.equal(text.isWellFormed(), true);
    const evidence = await scope.captureFilterScopeEvidence(candidate, batchDate, officialSources({ text: 0, pdf: 0 }, text));
    assert.equal(evidence.text.isWellFormed(), true);
    assert.ok(evidence.text.length <= scope.MAX_SCOPE_CHARACTERS_V2);
    assert.equal(evidence.selectionProfile, 'codepoint-safe-excerpt-v2');
    assert.equal(evidence.selectedTextSha256, crypto.createHash('sha256').update(evidence.text).digest('hex'));
    scope.assertFilterScopeEvidence(candidate, evidence, batchDate);
    const corrupt = { ...evidence, text: evidence.text + '\ud835' };
    assert.throws(() => scope.assertFilterScopeEvidence(candidate, corrupt, batchDate), /来源四文件/);
    // 冷重放兼容：历史 120K codepoint-safe-excerpt 档案仍通过 assertFilterScopeEvidence
    const legacyStored = require('../scripts/lib/fresh-arxiv-rewrite-source.js').readFreshArxivRewriteSource({
        rootDir: evidence.rootDir, arxivId: candidate.arxivId, generation: 1
    });
    const legacyEvidence = scope.buildFilterScopeEvidence(candidate, batchDate, legacyStored, { profile: 'v1' });
    assert.equal(legacyEvidence.selectionProfile, 'codepoint-safe-excerpt');
    assert.ok(legacyEvidence.text.length <= scope.MAX_SCOPE_CHARACTERS);
    assert.equal(scope.assertFilterScopeEvidence(candidate, legacyEvidence, batchDate), legacyEvidence);
});

test('unaffected scope selection retains its input version and safely samples varying Unicode boundaries', async t => {
    fixture(t);
    const candidate = paper('2610.90092');
    const evidence = await scope.captureFilterScopeEvidence(candidate, batchDate,
        officialSources({ text: 0, pdf: 0 }, 'audio and speech '.repeat(11000)));
    assert.equal(evidence.selectionProfile, 'codepoint-safe-excerpt-v2');
    assert.ok(evidence.text.length <= scope.MAX_SCOPE_CHARACTERS_V2);
    // 冷重放兼容：历史 120K unchanged-excerpt 档案仍通过 assertFilterScopeEvidence
    const legacyStored = require('../scripts/lib/fresh-arxiv-rewrite-source.js').readFreshArxivRewriteSource({
        rootDir: evidence.rootDir, arxivId: candidate.arxivId, generation: 1
    });
    const legacyUnchanged = scope.buildFilterScopeEvidence(candidate, batchDate, legacyStored, { profile: 'v1' });
    assert.equal(legacyUnchanged.selectionProfile, 'unchanged-excerpt');
    assert.ok(legacyUnchanged.text.length <= scope.MAX_SCOPE_CHARACTERS);
    assert.equal(scope.assertFilterScopeEvidence(candidate, legacyUnchanged, batchDate), legacyUnchanged);
    for (let prefix = 0; prefix < 12; prefix++) {
        const text = 'x'.repeat(prefix) + '𝐱𝛽 audio speech '.repeat(12000);
        const selected = scope.selectScopeText(text);
        assert.equal(selected.isWellFormed(), true, `prefix ${prefix}`);
        assert.ok(selected.length <= scope.MAX_SCOPE_CHARACTERS_V2);
        const selectedV1 = scope.selectScopeText(text, { profile: 'v1' });
        assert.equal(selectedV1.isWellFormed(), true, `v1 prefix ${prefix}`);
        assert.ok(selectedV1.length <= scope.MAX_SCOPE_CHARACTERS);
    }
});
test('旧范围证明和已有封存来源可按原字节复用', async t => {
    fixture(t);
    const candidate = paper('2610.90093');
    const counts = { text: 0, pdf: 0 };
    const overrides = officialSources(counts);
    const current = await scope.captureFilterScopeEvidence(candidate, batchDate, overrides);
    const root = Config.FILES.freshArxivFetchedSourcesDir;
    const previousRoot = path.join(root, 'filter-scope-v1');
    fs.renameSync(path.join(root, 'filter-scope'), previousRoot);
    const originalRoot = path.join(previousRoot, batchDate, path.basename(current.rootDir));
    const { schemaFingerprint, selectionProfile, ...fields } = current;
    const original = { ...fields, contract: 'official-modality-scope-v1', rootDir: originalRoot,
        selectionVersion: 'official-modality-scope-v1' };
    const before = treeSnapshot(previousRoot);
    assert.equal(scope.assertFilterScopeEvidence(candidate, original, batchDate), original);
    assert.throws(() => scope.assertFilterScopeEvidence(candidate, { ...original, schemaFingerprint }, batchDate), /来源证明/);
    assert.throws(() => scope.assertFilterScopeEvidence(candidate, { ...original, selectionVersion: 'wrong' }, batchDate), /来源四文件/);
    const reused = await scope.captureFilterScopeEvidence(candidate, batchDate, overrides);
    assert.equal(reused.rootDir, originalRoot);
    assert.equal(reused.selectionProfile, selectionProfile);
    assert.equal(reused.schemaFingerprint, schemaFingerprint);
    assert.deepEqual(counts, { text: 1, pdf: 1 });
    assert.deepEqual(treeSnapshot(previousRoot), before);
});
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
test('官方 PDF 全部返回 404 时记录跳过并继续筛选其他论文', async t => {
    fixture(t);
    const counts = { text: 0, pdf: 0, model: 0 };
    const overrides = officialSources(counts);
    const fetchPdf = overrides.fetchPdf;
    overrides.fetchPdf = async id => {
        if (id === '2610.90011') {
            const error = new Error(`arXiv PDF ${id} download failed: HTTP 404`);
            error.code = 'ARXIV_PDF_NOT_FOUND'; error.status = 404; error.arxivId = id;
            throw error;
        }
        return fetchPdf(id);
    };
    const skipped = paper();
    const other = paper('2610.90012');
    const result = await run([skipped, other], options(overrides, async () => {
        counts.model++; return decision(true);
    }));
    assert.deepEqual(result.selected.map(item => item.arxivId), [other.arxivId]);
    const record = result.decisions[skipped.arxivId];
    assert.equal(record.parseSource, 'official_pdf_404_skipped');
    assert.match(record.reason, /未判断论文是否相关/);
    assert.equal(record.arxivId, skipped.arxivId);
    assert.equal(scope.validatedDecisionInputSha256(skipped, record), record.inputSha256);
    assert.throws(() => scope.validatedDecisionInputSha256(skipped, { ...record, errorStatus: 500 }), /跳过记录/);
    assert.equal(counts.model, 1);
});
function skipped404Record(candidate, error = `arXiv PDF ${candidate.arxivId} download failed: HTTP 404`) {
    return {
        id: candidate.arxivId, arxivId: candidate.arxivId, paper_id: candidate.arxivId, title: candidate.title,
        related: false, reason: '官方 PDF 返回 404，本批跳过，未判断论文是否相关',
        rawResponse: '', parseSource: 'official_pdf_404_skipped',
        error, errorCode: 'ARXIV_PDF_NOT_FOUND', errorStatus: 404,
        fallback: false, retryable: false, decidedAt: '2026-10-11T00:00:00.000Z',
        inputSha256: pipeline.buildFilterInputSha256(candidate)
    };
}
test('404 跳过记录的身份契约是结构化字段加含 arXiv ID 的 error，改写文案后仍可核验', async t => {
    fixture(t);
    const candidate = paper();
    const record = skipped404Record(candidate, '官方 PDF 地址全部返回 404，已跳过（arXiv 2610.90011）');
    assert.equal(scope.validatedDecisionInputSha256(candidate, record), record.inputSha256);
    const legacyLiteral = skipped404Record(candidate);
    assert.equal(scope.validatedDecisionInputSha256(candidate, legacyLiteral), legacyLiteral.inputSha256);
    // 旧记录没有 arxivId 字段，逐字旧文案照常通过。
    const { arxivId, ...legacyWithoutId } = legacyLiteral;
    assert.equal(scope.validatedDecisionInputSha256(candidate, legacyWithoutId), legacyWithoutId.inputSha256);
    // 其它字段仍然是严格契约。
    for (const corrupted of [{ errorCode: 'ARXIV_PDF_ERROR' }, { errorStatus: 500 }, { related: true },
        { retryable: true }, { fallback: true }, { filterScopeEvidence: { contract: 'x' } }, { arxivId: '2610.90012' }]) {
        assert.throws(() => scope.validatedDecisionInputSha256(candidate, { ...record, ...corrupted }), /跳过记录/,
            JSON.stringify(corrupted));
    }
});
test('404 跳过记录的 error 不含规范化的 arXiv ID 时必须拒绝', async t => {
    fixture(t);
    const candidate = paper();
    for (const error of ['arXiv PDF download failed: HTTP 404', '', '   ', 404, null,
        'arXiv PDF 2610.90012 download failed: HTTP 404']) {
        assert.throws(() => scope.validatedDecisionInputSha256(candidate, skipped404Record(candidate, error)), /跳过记录/,
            String(error));
    }
});
test('404 跳过记录的 error 按 arXiv ID 边界匹配，不能被更长编号的子串冒充', async t => {
    fixture(t);
    const shorter = paper('2610.9001');
    const longer = paper('2610.90011');
    // `2610.90011` 里包含 `2610.9001`，但不能用来给论文 2610.9001 作证。
    assert.throws(() => scope.validatedDecisionInputSha256(shorter,
        skipped404Record(shorter, 'arXiv PDF 2610.90011 download failed: HTTP 404')), /跳过记录/);
    // 反过来，较短编号的文案同样不能证明较长编号。
    assert.throws(() => scope.validatedDecisionInputSha256(longer,
        skipped404Record(longer, 'arXiv PDF 2610.9001 download failed: HTTP 404')), /跳过记录/);
    // 带版本号的写法及原始文案仍按边界命中。
    for (const error of ['arXiv PDF 2610.9001v2 download failed: HTTP 404',
        'arXiv PDF 2610.9001 download failed: HTTP 404',
        '官方 PDF 地址全部返回 404，已跳过（arXiv 2610.9001v3）']) {
        const record = skipped404Record(shorter, error);
        assert.equal(scope.validatedDecisionInputSha256(shorter, record), record.inputSha256, error);
    }
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
test('通用表示与口语或韵律线索交给模型，并先核验官方材料', () => {
    for (const term of ['spoken dialogue', 'prosodic features']) {
        const candidate = { ...paper(), title: 'Representation study', abstract: `We evaluate ${term} through controlled experiments and report the resulting model behavior.` };
        const result = pipeline.evaluateKeywordPrefilter(candidate);
        assert.equal(result.pass, true);
        assert.equal(result.requiresScopeEvidence, true);
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
test('官方全文取证支持有界并发、保持顺序一致并拦截非法并发参数', async t => {
    fixture(t);
    const candidates = [1, 2, 3, 4, 5].map(idx => ({
        ...paper(),
        arxivId: `2610.9100${idx}`,
        paper_id: `2610.9100${idx}`,
        title: `Unified multimodal foundation model ${idx}`,
        abstract: 'We propose a unified multimodal foundation framework for cross-modal representation learning and benchmark general reasoning across standard datasets.'
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const baseSources = officialSources({ text: 0, pdf: 0, model: 0 });
    const delayedSources = {
        ...baseSources,
        fetchText: async id => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(resolve => setTimeout(resolve, 25));
            inFlight -= 1;
            if (id === '2610.91002') {
                return {
                    ...(await baseSources.fetchText(id)),
                    text: 'Introduction. This purely visual multimodal study only benchmarks static image, document layout, and text retrieval pairs across vision-language datasets. '.repeat(30)
                };
            }
            return baseSources.fetchText(id);
        },
        fetchPdf: async (id, opts) => {
            if (id === '2610.91004') {
                const err = new Error(`PDF 404 for ${id}`);
                err.code = 'ARXIV_PDF_NOT_FOUND';
                err.status = 404;
                err.arxivId = id;
                throw err;
            }
            return baseSources.fetchPdf(id, opts);
        }
    };
    const seenModelIds = [];
    const runOptions = {
        ...options(delayedSources, async item => {
            seenModelIds.push(item.arxivId);
            return decision(true);
        }),
        scopeConcurrency: 3
    };
    const result = await run(candidates, runOptions);
    assert.ok(maxInFlight >= 2 && maxInFlight <= 3, `期望并发峰值在 2..3，实际 ${maxInFlight}`);
    assert.deepEqual(result.selected.map(item => item.arxivId), ['2610.91001', '2610.91003', '2610.91005']);
    assert.equal(result.decisions['2610.91002'].parseSource, 'scope_body_audio_anchor_prefilter');
    assert.equal(result.decisions['2610.91004'].parseSource, 'official_pdf_404_skipped');
    assert.deepEqual(seenModelIds, ['2610.91001', '2610.91003', '2610.91005']);

    for (const bad of [0, 9, 1.5, NaN]) {
        await assert.rejects(
            () => pipeline.filterPapersWithLLM(candidates, { ...runOptions, scopeConcurrency: bad }),
            RangeError
        );
    }
});
test('官方全文并发取证遇到非 404 致命错误立即停止后续派发且不调用筛选模型', async t => {
    fixture(t);
    const candidates = [1, 2, 3, 4, 5, 6].map(idx => ({
        ...paper(),
        arxivId: `2610.9200${idx}`,
        paper_id: `2610.9200${idx}`,
        title: `Unified multimodal model fatal test ${idx}`
    }));
    let started = 0;
    let modelCalls = 0;
    const baseSources = officialSources({ text: 0, pdf: 0, model: 0 });
    const failingSources = {
        ...baseSources,
        fetchText: async id => {
            started += 1;
            if (id === '2610.92001') throw new Error('模拟非 404 网络错误');
            await new Promise(resolve => setTimeout(resolve, 40));
            return baseSources.fetchText(id);
        }
    };
    const runOptions = {
        ...options(failingSources, async () => { modelCalls += 1; return decision(true); }),
        scopeConcurrency: 2
    };
    await assert.rejects(() => pipeline.filterPapersWithLLM(candidates, runOptions), /模拟非 404 网络错误/);
    assert.equal(modelCalls, 0);
    assert.ok(started <= 3, `期望遇错后停止派发，实际启动 ${started} 篇`);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const freshSource = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fresh-analysis-test-'));
    const previousRoot = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = directory;
    t.after(() => { Config.FILES.freshRewriteRunsDir = previousRoot; fs.rmSync(directory, { recursive: true, force: true }); });
    const id = '2609.99970';
    const text = 'Original paper evidence with full experimental and method context.\n'.repeat(120);
    const artifacts = { version: 1, tables: [], formulas: [], figures: [], flattenedTextSha256: sha(text) };
    artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
    const details = { text, source: 'html', sourceId: `${id}v1`, imageInfos: [], structuredArtifacts: artifacts,
        readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
    const sourceExpectations = { [id]: { sourceSha256: sha(text), structuredArtifactsSha256: artifacts.payloadSha256 } };
    function makeRun() {
        const runId = crypto.randomUUID(); const runDir = path.join(directory, runId);
        fs.mkdirSync(runDir, { mode: 0o700 });
        const run = { version: 1, contract: 'fresh-rewrite-run-v1', runId, paperIds: [id], sourceExpectations };
        fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run), { mode: 0o600 });
        return { runId, runDir, sourceExpectations };
    }
    return { directory, id, text, artifacts, details, sourceExpectations, makeRun, context: makeRun() };
}

test('当日上下文限定 UUID、根目录、清单和来源集合身份，绝不泄漏到范围之外', async t => {
    const f = fixture(t);
    assert.equal(fresh.getFreshAnalysisContext(), null);
    await fresh.withFreshAnalysisContext(f.context, async () => {
        assert.equal(fresh.getFreshAnalysisContext().refreshReaderDiagnostics, false);
        assert.equal(fresh.getFreshAnalysisContext().runId, f.context.runId);
        assert.ok(Object.isFrozen(fresh.getFreshAnalysisContext()));
        await Promise.resolve();
        assert.equal(fresh.getFreshAnalysisContext().runId, f.context.runId);
    });
    assert.equal(fresh.getFreshAnalysisContext(), null);
    fresh.withFreshAnalysisContext({ ...f.context, refreshReaderDiagnostics: true }, () => {
        assert.equal(fresh.getFreshAnalysisContext().refreshReaderDiagnostics, true);
    });
    assert.throws(() => fresh.withFreshAnalysisContext({ ...f.context, refreshReaderDiagnostics: 'true' }, () => {}), /explicit boolean/);
    assert.throws(() => fresh.withFreshAnalysisContext({ ...f.context, runId: '../outside' }, () => {}), /UUID/);
    assert.throws(() => fresh.withFreshAnalysisContext({ ...f.context, runDir: f.directory }, () => {}), /configured root/);
    const changed = structuredClone(f.context); changed.sourceExpectations[f.id].sourceSha256 = '0'.repeat(64);
    assert.throws(() => fresh.withFreshAnalysisContext(changed, () => {}), /expectations differ/);
});

test('当日运行的用量上下文能跨 await 和嵌套论文范围，且不在并发运行之间泄漏', async t => {
    const f = fixture(t);
    const usage = require('../scripts/lib/llm-usage.js');
    const secondRun = f.makeRun();
    assert.equal(usage.usageContext().runId ?? null, null);
    const observed = await Promise.all([f.context, secondRun].map(identity => fresh.withFreshAnalysisContext(identity, async () => {
        await Promise.resolve();
        return usage.withLlmUsageContext({ paperId: f.id, stage: 'primaryAnalysis' }, async () => {
            await Promise.resolve();
            const inherited = usage.usageContext();
            assert.equal(inherited.runId, identity.runId);
            assert.equal(inherited.paperId, f.id);
            return inherited.runId;
        });
    })));
    assert.deepEqual(observed, [f.context.runId, secondRun.runId]);
    assert.equal(usage.usageContext().runId ?? null, null);
});

test('当日来源抓取按原样保存完整原文，并发抓取去重，复核时不联网', async t => {
    const f = fixture(t); let calls = 0;
    assert.equal(fresh.readFreshSource(f.context.runDir, f.id, f.context), null);
    await fresh.withFreshAnalysisContext(f.context, async () => {
        const fetcher = async () => { calls++; await Promise.resolve(); return structuredClone(f.details); };
        const [first, second] = await Promise.all([fresh.fetchFreshSource(f.id, fetcher), fresh.fetchFreshSource(`${f.id}v1`, fetcher)]);
        assert.equal(calls, 1);
        assert.deepEqual(first, second);
        first.text = 'caller mutation';
        const replayed = await fresh.fetchFreshSource(f.id, async () => { throw new Error('network must not run'); });
        assert.equal(replayed.text, f.text);
        assert.equal(replayed.freshSourceDescriptor.sourceSnapshotSha256, sha(JSON.stringify(f.details)));
    });
    const source = fresh.readFreshSource(f.context.runDir, f.id, f.context);
    const directory = path.join(f.context.runDir, 'sources', f.id);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['artifacts.json', 'source-details.json', 'source.json', 'source.txt']);
    for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
    assert.equal(source.structuredArtifacts.payloadSha256, f.artifacts.payloadSha256);
    assert.equal(fs.readFileSync(path.join(directory, 'source-details.json'), 'utf8'), JSON.stringify(f.details));
});

test('日更打包模式只保存一次 PDF、TXT 和清单，复核时只用这一代，不读旧版文本缓存', async t => {
    const f = fixture(t); const generation = 1;
    const sourceExpectations = { [f.id]: { sourceMode: fresh.BUNDLE_SOURCE_MODE, sourceGeneration: generation } };
    const manifest = JSON.parse(fs.readFileSync(path.join(f.context.runDir, 'run.json'), 'utf8'));
    manifest.sourceExpectations = sourceExpectations;
    fs.writeFileSync(path.join(f.context.runDir, 'run.json'), JSON.stringify(manifest), { mode: 0o600 });
    const identity = { ...f.context, sourceExpectations };
    const sourceRoot = path.join(f.context.runDir, 'sources'); let captures = 0; const originalCapture = freshSource.captureFreshArxivRewriteSource;
    freshSource.captureFreshArxivRewriteSource = options => { captures++; return originalCapture(options, {
        fetchText: async id => {
            const text = `fresh daily HTML source ${id}. `.repeat(100);
            const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text),
                tables: [{ ordinal: 1, caption: 'daily table', rows: [] }],
                formulas: [{ ordinal: 1, latex: 'x=y' }],
                figures: [{ ordinal: 1, caption: 'daily figure', images: [{ kind: 'external_url', url: `https://arxiv.org/html/${id}/f.png` }] }] };
            artifacts.payloadSha256 = sha(JSON.stringify({ ...artifacts }));
            return { text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`,
                fetchedAt: '2026-09-07T00:00:01.000Z', imageInfos: [{ url: `https://arxiv.org/html/${id}/f.png`, caption: 'daily figure' }],
                structuredArtifacts: artifacts, htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
        },
        fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.4\nfresh daily ${id}\n%%EOF\n`),
            url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: '2026-09-07T00:00:02.000Z' })
    }); };
    t.after(() => { freshSource.captureFreshArxivRewriteSource = originalCapture; });
    const first = await fresh.withFreshAnalysisContext(identity, () => fresh.fetchFreshSource(f.id, async () => {
        captures++; throw new Error('legacy text-only fetch must not run');
    }));
    assert.equal(captures, 1, 'daily sources phase must use one sealed bundle capture');
    assert.equal(first.freshSourceDescriptor.contract, fresh.BUNDLE_CACHE_CONTRACT);
    assert.equal(first.freshSourceDescriptor.sourceGeneration, generation);
    assert.match(first.freshSourceDescriptor.sourceManifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.structuredArtifacts.tables[0].caption, 'daily table');
    assert.equal(first.structuredArtifacts.formulas[0].latex, 'x=y');
    assert.match(first.imageInfos[0].url, /\/f\.png$/);
    const directory = path.join(sourceRoot, f.id, 'generation-000001');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt']);
    const replayed = await fresh.withFreshAnalysisContext(identity, () => fresh.fetchFreshSource(f.id, async () => {
        throw new Error('same generation must replay the sealed bundle');
    }));
    assert.equal(captures, 1, 'same generation must not fetch again');
    assert.equal(replayed.freshSourceDescriptor.sourceManifestSha256, first.freshSourceDescriptor.sourceManifestSha256);
    const paper = { arxivId: f.id }; const analysisManifest = { stages: {} };
    await fresh.withFreshAnalysisContext(identity, () => fresh.attachFreshSourceRecord(paper, analysisManifest, replayed));
    assert.equal(paper.freshRewriteProvenance.sourceGeneration, generation);
    assert.equal(paper.freshRewriteProvenance.sourceManifestSha256, replayed.freshSourceDescriptor.sourceManifestSha256);
});

test('来源解析保留基线版本或调用方版本，拒绝跨论文的 sourceId', async t => {
    const f = fixture(t);
    const deep = require('../scripts/deep-analyzer.js');
    const originalFetch = deep.fetchArxivTextDetailed;
    const requested = [];
    deep.fetchArxivTextDetailed = async id => { requested.push(id); return { requestedId: id }; };
    t.after(() => { deep.fetchArxivTextDetailed = originalFetch; });
    await fresh.resolveFreshSource(f.context.runDir, { arxivId: `${f.id}v1` }, f.context);
    await fresh.resolveFreshSource(f.context.runDir, `${f.id}v2`, f.context);
    await fresh.resolveFreshSource(f.context.runDir, { arxivId: f.id }, f.context);
    assert.deepEqual(requested, [`${f.id}v1`, `${f.id}v2`, f.id]);
    const updated = structuredClone(f.context);
    updated.sourceExpectations[f.id].sourceId = `${f.id}v1`;
    const manifestPath = path.join(f.context.runDir, 'run.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.sourceExpectations = updated.sourceExpectations;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await fresh.resolveFreshSource(updated.runDir, { arxivId: `${f.id}v2` }, updated);
    assert.equal(requested.at(-1), `${f.id}v1`, 'baseline source identity takes precedence');
    updated.sourceExpectations[f.id].sourceId = '2609.99971v1';
    assert.throws(() => fresh.resolveFreshSource(updated.runDir, f.id, updated), /another paper/);
    assert.equal(requested.length, 4);
});

test('原始抓取还在进行时，来源预期不能漂移', async t => {
    const f = fixture(t);
    await assert.rejects(fresh.withFreshAnalysisContext(f.context, () => fresh.fetchFreshSource(f.id, async () => {
        const filename = path.join(f.context.runDir, 'run.json');
        const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
        manifest.sourceExpectations[f.id].sourceSha256 = '0'.repeat(64);
        fs.writeFileSync(filename, JSON.stringify(manifest));
        return structuredClone(f.details);
    })), /expectations differ/);
    assert.equal(fs.existsSync(path.join(f.context.runDir, 'sources', f.id, 'source.json')), false);
});

test('缓存提交之前，来源文本或产物漂移、摘要和旧的生成状态一律拒绝', async t => {
    const f = fixture(t);
    for (const mutate of [details => { details.text += 'drift'; },
        details => { details.structuredArtifacts.tables.push({ invented: true }); },
        details => { details.source = 'abstract'; },
        details => { details.analysis = 'old generated text'; },
        details => { details.apiReaderArticle = 'old reader'; }]) {
        const value = structuredClone(f.details); mutate(value);
        await assert.rejects(fresh.withFreshAnalysisContext(f.context, () => fresh.fetchFreshSource(f.id, async () => value)),
            error => error.code === 'FRESH_ANALYSIS_INTEGRITY');
        assert.equal(fresh.readFreshSource(f.context.runDir, f.id, f.context), null);
    }
});

test('只读缓存复核拒绝被改动的附属文件和符号链接目录，且不回退去重新抓取', async t => {
    const f = fixture(t);
    await fresh.withFreshAnalysisContext(f.context, () => fresh.fetchFreshSource(f.id, async () => structuredClone(f.details)));
    const directory = path.join(f.context.runDir, 'sources', f.id);
    fs.writeFileSync(path.join(directory, 'source.txt'), 'changed');
    assert.throws(() => fresh.readFreshSource(f.context.runDir, f.id, f.context), /The source text or artifact files do not match the saved source details/);
    fs.writeFileSync(path.join(directory, 'source.txt'), f.text);
    const moved = `${directory}-saved`; fs.renameSync(directory, moved); fs.symlinkSync(moved, directory);
    assert.throws(() => fresh.readFreshSource(f.context.runDir, f.id, f.context), /Unsafe fresh directory/);
    await assert.rejects(fresh.withFreshAnalysisContext(f.context, () => fresh.fetchFreshSource(f.id,
        async () => { throw new Error('unexpected network'); })), /Unsafe fresh directory/);
});

test('来源提交中断后，可以凭已核验的原始明细写完，不必重新抓取', async t => {
    const f = fixture(t);
    await fresh.withFreshAnalysisContext(f.context, () => fresh.fetchFreshSource(f.id, async () => structuredClone(f.details)));
    const marker = path.join(f.context.runDir, 'sources', f.id, 'source.json');
    fs.unlinkSync(marker);
    assert.equal(fresh.readFreshSource(f.context.runDir, f.id, f.context), null);
    const source = await fresh.withFreshAnalysisContext(f.context, () => fresh.fetchFreshSource(f.id,
        async () => { throw new Error('unexpected network'); }));
    assert.equal(source.text, f.text);
    assert.ok(fs.existsSync(marker));
});

test('当日论文拒绝旧版或跨运行生成的文本，并把同一次运行的检查点绑定到原始快照', async t => {
    const f = fixture(t);
    await fresh.withFreshAnalysisContext(f.context, async () => {
        assert.doesNotThrow(() => fresh.assertFreshPaper({ arxivId: f.id, title: 'Original metadata', abstract: 'Original abstract' }));
        assert.throws(() => fresh.assertFreshPaper({ arxivId: f.id, analysis: 'old analysis' }), /Generated analysis has no corresponding source files in this run/);
        assert.throws(() => fresh.assertFreshPaper({ arxivId: f.id, fullText: f.text }), /caller-provided text/);
        const source = await fresh.fetchFreshSource(f.id, async () => structuredClone(f.details));
        const paper = { arxivId: f.id }; const manifest = { stages: {} };
        fresh.attachFreshSourceRecord(paper, manifest, source);
        assert.equal(paper.freshRewriteProvenance.sourceOnly, true);
        assert.equal(paper.freshRewriteProvenance.oldGeneratedTextIncluded, false);
        paper.analysisManifest = manifest; paper.analysisCheckpoint = 'new run partial analysis';
        assert.doesNotThrow(() => fresh.assertFreshPaper(paper));
        paper.freshRewriteProvenance = { ...paper.freshRewriteProvenance, runId: crypto.randomUUID() };
        assert.throws(() => fresh.assertFreshPaper(paper), /The analysis or its stage manifest has a missing or inconsistent source record for this run/);
        assert.throws(() => fresh.assertFreshPaper({ arxivId: f.id, apiReaderArticle: 'old reader' }), /The analysis or its stage manifest has a missing or inconsistent source record for this run/);
    });
});

test('第一个落盘的分析检查点就已经带上精确的当日来源出处', async t => {
    const f = fixture(t); const deep = require('../scripts/deep-analyzer.js');
    await fresh.withFreshAnalysisContext(f.context, async () => {
        const source = await fresh.fetchFreshSource(f.id, async () => structuredClone(f.details));
        const paper = { arxivId: f.id }; const manifest = { stages: {} };
        fresh.attachFreshSourceRecord(paper, manifest, source);
        let observed = 0;
        paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')] = checkpoint => {
            observed++;
            assert.deepEqual(checkpoint.freshRewriteProvenance, checkpoint.analysisManifest.freshRewriteProvenance);
            assert.equal(checkpoint.freshRewriteProvenance.runId, f.context.runId);
            assert.equal(checkpoint.freshRewriteProvenance.sourceSnapshotSha256, sha(JSON.stringify(f.details)));
            assert.equal(checkpoint.freshRewriteProvenance.oldGeneratedTextIncluded, false);
        };
        deep.saveAnalysisCheckpoint(paper, 'new run checkpoint', manifest);
        assert.equal(observed, 1);
    });
});

test('深度主分析和 Reader 指纹按运行隔离，普通指纹保持不变', async t => {
    const f = fixture(t);
    const deep = require('../scripts/deep-analyzer.js');
    const paper = { arxivId: f.id, title: 'Original title', authors: ['Original author'] };
    const normal = deep.buildRecoveryFingerprints(paper, f.text, f.id);
    const first = await fresh.withFreshAnalysisContext(f.context, async () => {
        await fresh.fetchFreshSource(f.id, async () => structuredClone(f.details));
        assert.equal((await deep.fetchArxivTextDetailed(f.id)).text, f.text, 'production wrapper reads this run cache');
        return deep.buildRecoveryFingerprints(paper, f.text, f.id);
    });
    const other = f.makeRun();
    const second = await fresh.withFreshAnalysisContext(other, async () => {
        await fresh.fetchFreshSource(f.id, async () => structuredClone(f.details));
        return deep.buildRecoveryFingerprints(paper, f.text, f.id);
    });
    assert.notEqual(first.primaryAnalysis, normal.primaryAnalysis);
    assert.notEqual(first.primaryAnalysis, second.primaryAnalysis);
    assert.notEqual(first.apiReaderArticle, second.apiReaderArticle);
    assert.deepEqual(deep.buildRecoveryFingerprints(paper, f.text, f.id), normal);
});

test('当日 Reader 候选不能用旧的全局目录，已签名修订也不能录入另一次运行', async t => {
    const f = fixture(t); const deep = require('../scripts/deep-analyzer.js');
    await fresh.withFreshAnalysisContext(f.context, async () => {
        await fresh.fetchFreshSource(f.id, async () => structuredClone(f.details));
        let calls = 0;
        const options = { sourceText: f.text, structuredArtifacts: f.artifacts, readerCallModel: async () => { calls++; return 'invalid JSON'; },
            readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [], readerMaxAttempts: 1 };
        await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: f.id }, '', '', {
            ...options, readerAttemptsDir: path.join(f.directory, 'old-global-candidates')
        }), /current run/);
        assert.equal(calls, 0);
        await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: f.id }, '', '', options), /JSON/);
        assert.equal(calls, 1);
        const candidates = path.join(f.context.runDir, 'reader-attempts');
        const envelope = JSON.parse(fs.readFileSync(path.join(candidates, fs.readdirSync(candidates)[0]), 'utf8'));
        assert.equal(envelope.identity.freshAnalysis.runId, f.context.runId);
        assert.equal(envelope.identity.freshAnalysis.sourceSnapshotSha256, sha(JSON.stringify(f.details)));
        await assert.rejects(deep.analyzePaperDeep({ arxivId: f.id, analysis: 'previous date generated text' }), /The analysis or its stage manifest has a missing or inconsistent source record for this run/);
    });
});

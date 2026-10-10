'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-fresh-source-plan-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    return { root, sourceRoot: Config.FILES.dailyFreshSourceRunsDir };
}

function sourcePayload(id) {
    const text = `Fresh daily official HTML text for ${id}; methods, data, results, and limitations. `.repeat(120);
    const structuredArtifacts = { version: 1, source: 'html', flattenedTextSha256: sha(Buffer.from(text)),
        tables: [{ ordinal: 1, caption: 'Result table', rows: [] }], formulas: [],
        figures: [{ ordinal: 1, caption: 'Architecture', images: [{ kind: 'external_url', url: `https://arxiv.org/html/${id}/figure.png` }] }] };
    structuredArtifacts.payloadSha256 = sha(JSON.stringify({ ...structuredArtifacts }));
    return {
        text, source: 'html', sourceId: `${id}v2`, url: `https://arxiv.org/html/${id}v2`,
        fetchedAt: new Date().toISOString(), imageInfos: [{ url: `https://arxiv.org/html/${id}/figure.png`, caption: 'Architecture' }],
        structuredArtifacts, readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: []
    };
}

async function captureHistoricalSource(plan, id, pdfSuffix = '') {
    const selected = `${id}v2`;
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
            .captureFreshArxivRewriteSource(options, {
                fetchText: async () => ({ ...sourcePayload(id), title: 'Official historical paper title' }),
                fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nHistorical paper\n%%EOF\n'),
                    url: `https://arxiv.org/pdf/${selected}${pdfSuffix}`, sourceId: selected,
                    currentPdfUnavailable: true, currentPdfStatus: 404 }),
                extractPdfText: async () => ({ text: 'Historical PDF methods, experiments, results, and limitations. '.repeat(120) })
            })
    });
}

test('历史版本信息进入日更分析和结果，两条来源证明保持一致', async t => {
    fixture(t); const id = '2609.12401';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'historical-source', papers: [{ arxivId: id }] });
    await captureHistoricalSource(plan, id, '.pdf');
    const runtimePath = path.join(plan.sourcesDir, id, 'generation-000001', 'source-runtime.json');
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    const source = daily.readDailyFreshSource(plan, { arxivId: id });
    assert.equal(source.title, runtime.title);
    assert.deepEqual(source.sourceVersion, runtime.sourceVersion);

    const analyze = daily.createDailyAnalyzeFn(plan, {
        analyze: async paper => {
            const directSource = direct.getDirectRewriteSource(paper);
            assert.deepEqual(paper.sourceVersion, runtime.sourceVersion);
            assert.deepEqual(directSource.sourceVersion, runtime.sourceVersion);
            const manifest = { sourceAcquisition: { sourceSha256: sha(source.text) } };
            direct.attachDirectSourceRecord(paper, manifest, directSource);
            assert.equal(paper.freshRewriteProvenance.sourceVersionIdentitySha256, runtime.sourceVersion.identitySha256);
            assert.equal(fresh.freshAnalysisIdentity(id).sourceVersionIdentitySha256, runtime.sourceVersion.identitySha256);
            // 分析器保存阶段检查点时会复制输入的论文对象。要确认
            // 第一次保存之前，来源版本元数据就已经在了。
            const checkpoint = JSON.parse(JSON.stringify({ ...paper, analysisManifest: manifest }));
            assert.deepEqual(checkpoint.sourceVersion, runtime.sourceVersion);
            assert.equal(checkpoint.analysisManifest.freshRewriteProvenance.sourceVersionIdentitySha256,
                runtime.sourceVersion.identitySha256);
            paper.sourceVersion.selectedSourceId = `${id}v1`;
            // 返回一个独立对象，用来确认包装层既保留了来源元数据，
            // 也保留了常规分析器做出的修改。
            return { arxivId: id, analysis: 'new analysis', sourceSha256: sha(source.text),
                freshRewriteProvenance: paper.freshRewriteProvenance, analysisManifest: manifest };
        }
    });
    const result = await daily.withDailyFreshAnalysisContext(plan, () => analyze({ arxivId: id }));
    assert.deepEqual(result.sourceVersion, runtime.sourceVersion);
    assert.equal(daily.isPaperBoundToPlan(result, plan), true);
    daily.withDailyFreshAnalysisContext(plan, () => fresh.assertFreshPaper(result));

    const oldResult = structuredClone(result);
    delete oldResult.sourceVersion;
    delete oldResult.freshRewriteProvenance.sourceVersionIdentitySha256;
    delete oldResult.analysisManifest.freshRewriteProvenance.sourceVersionIdentitySha256;
    assert.equal(daily.isPaperBoundToPlan(oldResult, plan), false);
    const prepared = daily.prepareDailyPaper({ ...oldResult, sourceVersion: runtime.sourceVersion }, plan);
    assert.equal(prepared.analysis, undefined);
    assert.equal(prepared.sourceVersion, undefined);
    assert.equal(prepared.freshRewriteProvenance, undefined);
    const tampered = structuredClone(result);
    tampered.sourceVersion.selectedSourceId = `${id}v1`;
    assert.equal(daily.isPaperBoundToPlan(tampered, plan), false);
});

test('传递标题和历史版本信息不改变已有来源快照的字段与哈希', async t => {
    fixture(t); const id = '2609.12402';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'snapshot-compatibility', papers: [{ arxivId: id }] });
    await captureHistoricalSource(plan, id);
    const directory = path.join(plan.sourcesDir, id, 'generation-000001');
    const runtime = JSON.parse(fs.readFileSync(path.join(directory, 'source-runtime.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'source-manifest.json'), 'utf8'));
    const text = fs.readFileSync(path.join(directory, 'source.txt'), 'utf8');
    const oldDetails = { text, source: manifest.text.source, sourceId: manifest.text.sourceId,
        imageInfos: runtime.imageInfos, structuredArtifacts: runtime.structuredArtifacts,
        readerAuthors: runtime.readerAuthors === null ? { authors: [] } : runtime.readerAuthors,
        htmlAvailability: runtime.htmlAvailability, htmlAttempts: runtime.htmlAttempts, warnings: runtime.warnings };
    const oldSnapshot = { sourceManifestSha256: sha(fs.readFileSync(path.join(directory, 'source-manifest.json'))),
        sourceGeneration: 1, details: oldDetails };
    const source = daily.readDailyFreshSource(plan, { arxivId: id });
    assert.equal(source.freshSourceDescriptor.sourceSnapshotSha256, sha(JSON.stringify(oldSnapshot)));
    assert.deepEqual(source.sourceVersion, runtime.sourceVersion);
});

test('日更 Reader 生成器复用同一次调用里抓到的图片字节', async () => {
    const bytes = Buffer.from('same-invocation-image-bytes');
    const url = 'https://arxiv.org/html/2609.12345/figure.png';
    const cached = {
        base64: bytes.toString('base64'),
        mime: 'image/png',
        sha256: sha(bytes)
    };
    const materialized = await daily.ephemeralReaderFigures(
        '2609.12345',
        [{ ordinal: 1, url, caption: 'Architecture' }],
        {},
        { figureCache: new Map([[url, cached]]) }
    );
    assert.equal(materialized.length, 1);
    assert.ok(materialized[0].rawBytes.equals(bytes));
    assert.equal(materialized[0].assetSha256, cached.sha256);
    assert.equal(materialized[0].assetMediaType, cached.mime);
});

test('日更 Reader 生成器复用同一次调用里抓到的官方 SVG', async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    const url = 'https://arxiv.org/html/2609.12345/figure.svg';
    const cached = {
        base64: bytes.toString('base64'),
        mime: 'image/svg+xml',
        sha256: sha(bytes)
    };
    const materialized = await daily.ephemeralReaderFigures(
        '2609.12345',
        [{ ordinal: 1, url, caption: 'Architecture' }],
        {},
        { figureCache: new Map([[url, cached]]) }
    );
    assert.equal(materialized.length, 1);
    assert.ok(materialized[0].rawBytes.equals(bytes));
    assert.equal(materialized[0].assetSha256, cached.sha256);
    assert.equal(materialized[0].assetMediaType, cached.mime);
});

test('默认的日更来源计划在分析回调之前就保存 PDF、TXT 和清单，绝不走旧版文本路径', async t => {
    const f = fixture(t); const id = '2609.12345'; let captureCalls = 0; let legacyTextCalls = 0; let analysisCalls = 0;
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'daily-mocked-batch',
        papers: [{ arxivId: id, title: 'Daily source test', abstract: 'metadata only' }] });

    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => {
            captureCalls++;
            return require('../scripts/lib/fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource(options, {
                fetchText: async requested => sourcePayload(requested),
                fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.7\nDaily sealed ${requested}\n%%EOF\n`),
                    url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: new Date().toISOString() })
            });
        }
    });
    assert.equal(captureCalls, 1);
    const directory = path.join(plan.sourcesDir, id, 'generation-000001');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt']);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'source-manifest.json'), 'utf8'));
    assert.match(manifest.pdf.responseSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.text.responseSha256, /^[a-f0-9]{64}$/);
    assert.ok(fs.readFileSync(path.join(directory, 'source.pdf')).subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.equal(fs.readFileSync(path.join(directory, 'source.txt'), 'utf8'), sourcePayload(id).text);

    const analyze = daily.createDailyAnalyzeFn(plan, {
        analyze: async paper => {
            analysisCalls++;
            assert.equal(paper.fullText, undefined, 'daily caller must not inject legacy/caller text');
            assert.equal(fresh.getFreshAnalysisContext().runId, plan.runId);
            assert.equal(fresh.isDailyFreshSourceScope(), true,
                'daily source bundles retain the ephemeral-pixel Reader gate');
            const source = direct.getDirectRewriteSource(paper);
            assert.equal(source.text, sourcePayload(id).text, 'analysis receives the sealed TXT, not a legacy fetch result');
            assert.equal(source.freshSourceDescriptor.sourceManifestSha256, manifest && sha(fs.readFileSync(path.join(directory, 'source-manifest.json'))));
            const active = direct.getDirectRewriteAnalysisContext();
            assert.equal(active.readerAttemptsDir, plan.readerAttemptsDir, 'daily Reader candidates stay in the fresh run root');
            const materialized = await active.materializeReaderFigures([
                { ordinal: 1, url: `https://arxiv.org/html/${id}/figure.png` },
                { ordinal: 2, url: `https://arxiv.org/html/${id}/oversized.png` }
            ], id);
            assert.equal(materialized.length, 1);
            assert.equal(materialized[0].rawBytes.toString(), 'ephemeral-daily-pixels');
            assert.equal(legacyTextCalls, 0, 'sealed source is ready before analysis; legacy text acquisition is never called');
            return { arxivId: id, analysis: 'new analysis generated from sealed source only' };
        },
        fetchFigure: async url => {
            if (url.endsWith('/oversized.png')) {
                const error = new Error('response body 6.0MB exceeds limit');
                error.code = 'RESPONSE_TOO_LARGE';
                throw error;
            }
            return { bytes: Buffer.from('ephemeral-daily-pixels'), mediaType: 'image/png' };
        }
    });
    await daily.withDailyFreshAnalysisContext(plan, () => analyze({ arxivId: id, title: 'Daily source test' }));
    assert.equal(analysisCalls, 1);
    assert.equal(legacyTextCalls, 0);
    const allFiles = [];
    const visit = directoryPath => {
        for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
            const filename = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) visit(filename); else allFiles.push(path.relative(plan.runDir, filename));
        }
    };
    visit(plan.runDir);
    assert.deepEqual(allFiles.sort(), [
        'run.json',
        `sources/${id}/generation-000001/source-manifest.json`,
        `sources/${id}/generation-000001/source-runtime.json`,
        `sources/${id}/generation-000001/source.pdf`,
        `sources/${id}/generation-000001/source.txt`
    ]);
    assert.doesNotMatch(JSON.stringify(manifest), /(?:rawBytes|assetBytes|base64|image-cache|api-reader-assets)/);
});

test('旧版成功分析若不能证明它对应当前保存的清单，日更来源计划就把它清掉', async t => {
    fixture(t); const id = '2609.12346';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'daily-mocked-batch-2', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
        .captureFreshArxivRewriteSource(options, {
            fetchText: async requested => sourcePayload(requested),
            fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.4\n${requested}\n%%EOF\n`), url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: new Date().toISOString() })
        }) });
    const prepared = daily.prepareDailyPaper({ arxivId: id, analysis: 'legacy body', parsed: { score: 9 },
        apiReaderArticle: 'legacy reader', sourceSha256: '0'.repeat(64), fullText: 'legacy full text',
        imageUrls: ['https://old.example/poison.png'], allImageUrls: ['https://old.example/poison.png'],
        selectedImageUrls: ['https://old.example/poison.png'],
        analysisRecoveryImageManifest: { candidates: [{ url: 'https://old.example/poison.png' }] } }, plan);
    assert.equal(prepared.analysis, undefined);
    assert.equal(prepared.parsed, undefined);
    assert.equal(prepared.apiReaderArticle, undefined);
    assert.equal(prepared.fullText, undefined);
    assert.equal(prepared.imageUrls, undefined);
    assert.equal(prepared.allImageUrls, undefined);
    assert.equal(prepared.selectedImageUrls, undefined);
    assert.equal(prepared.analysisRecoveryImageManifest, undefined);
    assert.equal(daily.isPaperBoundToPlan(prepared, plan), false);
});

test('日更来源绑定要求清单来源镜像和来源获取 SHA', async t => {
    fixture(t); const id = '2609.12348';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'daily-mocked-batch-4', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
        .captureFreshArxivRewriteSource(options, {
            fetchText: async requested => sourcePayload(requested),
            fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.4\n${requested}\n%%EOF\n`), url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: new Date().toISOString() })
        }) });
    const descriptor = daily.readDailyFreshSource(plan, { arxivId: id }).freshSourceDescriptor;
    const proof = { contract: 'fresh-source-analysis-v1', runId: plan.runId,
        sourceSha256: descriptor.sourceSha256, structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
        sourceSnapshotSha256: descriptor.sourceSnapshotSha256, sourceGeneration: descriptor.sourceGeneration,
        sourceManifestSha256: descriptor.sourceManifestSha256, sourceOnly: true, oldGeneratedTextIncluded: false };
    const incomplete = { arxivId: id, analysis: 'generated body', freshRewriteProvenance: proof,
        sourceSha256: proof.sourceSha256, analysisManifest: { sourceAcquisition: { sourceSha256: proof.sourceSha256 } } };
    assert.equal(daily.isPaperBoundToPlan(incomplete, plan), false);
    assert.equal(daily.prepareDailyPaper(incomplete, plan).analysis, undefined);
    const complete = structuredClone(incomplete);
    complete.analysisManifest.freshRewriteProvenance = structuredClone(proof);
    assert.equal(daily.isPaperBoundToPlan(complete, plan), true);
    assert.equal(daily.isPaperBoundToPlan({ ...complete, sourceVersion: null }, plan), false);
    const forgedProof = { ...proof, sourceVersionIdentitySha256: null };
    assert.equal(daily.isPaperBoundToPlan({ ...complete, freshRewriteProvenance: forgedProof,
        analysisManifest: { ...complete.analysisManifest, freshRewriteProvenance: forgedProof } }, plan), false);

    const source = daily.readDailyFreshSource(plan, { arxivId: id });
    const directory = path.join(plan.sourcesDir, id, 'generation-000001');
    const runtime = JSON.parse(fs.readFileSync(path.join(directory, 'source-runtime.json'), 'utf8'));
    const oldDetails = { text: source.text, source: source.source, sourceId: source.sourceId,
        imageInfos: runtime.imageInfos, structuredArtifacts: runtime.structuredArtifacts,
        readerAuthors: runtime.readerAuthors === null ? { authors: [] } : runtime.readerAuthors,
        htmlAvailability: runtime.htmlAvailability, htmlAttempts: runtime.htmlAttempts, warnings: runtime.warnings };
    assert.equal(source.freshSourceDescriptor.sourceSnapshotSha256, sha(JSON.stringify({
        sourceManifestSha256: source.freshSourceDescriptor.sourceManifestSha256,
        sourceGeneration: 1, details: oldDetails
    })));
    assert.equal(Object.hasOwn(source.freshSourceDescriptor, 'sourceVersionIdentitySha256'), false);
    const staleInput = { arxivId: id, sourceVersion: { selectedSourceId: `${id}v1` } };
    const output = await daily.withDailyFreshPaperSource(plan, staleInput, () => {
        assert.equal(Object.hasOwn(staleInput, 'sourceVersion'), false);
        return { arxivId: id, sourceVersion: { selectedSourceId: `${id}v1` } };
    });
    assert.equal(Object.hasOwn(output, 'sourceVersion'), false);
});

test('日更来源引用只复核那次精确保存的运行清单', async t => {
    fixture(t); const id = '2609.12347';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'daily-mocked-batch-3', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
        .captureFreshArxivRewriteSource(options, {
            fetchText: async requested => sourcePayload(requested),
            fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.4\n${requested}\n%%EOF\n`), url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: new Date().toISOString() })
        }) });
    const reference = daily.dailyFreshSourceReference(plan);
    const replayed = daily.readDailyFreshSourcePlan(reference);
    assert.equal(replayed.runId, plan.runId);
    assert.equal(daily.readDailyFreshSource(replayed, { arxivId: id }).freshSourceDescriptor.sourceGeneration, 1);
    assert.throws(() => daily.readDailyFreshSourcePlan({ ...reference, runManifestSha256: '0'.repeat(64) }), /每日来源运行清单的 SHA 已变化/);
});

// root 运行 chmod 000 拦不住读，Windows 上 chmod 也基本无效，这两种环境跳过权限用例。
const permissionChecksApply = process.platform !== 'win32'
    && !(typeof process.getuid === 'function' && process.getuid() === 0);

async function capturedPlanWithBoundPaper(t, id, batchId) {
    fixture(t);
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId, papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
        .captureFreshArxivRewriteSource(options, {
            fetchText: async requested => sourcePayload(requested),
            fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.4\n${requested}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: new Date().toISOString() })
        }) });
    const descriptor = daily.readDailyFreshSource(plan, { arxivId: id }).freshSourceDescriptor;
    const proof = { contract: 'fresh-source-analysis-v1', runId: plan.runId, sourceGeneration: 1,
        sourceManifestSha256: descriptor.sourceManifestSha256, sourceSha256: descriptor.sourceSha256,
        sourceSnapshotSha256: descriptor.sourceSnapshotSha256, sourceOnly: true, oldGeneratedTextIncluded: false };
    const bound = { arxivId: id, title: '已完成的论文', analysis: '已完成的整篇分析', parsed: { score: 9 },
        apiReaderArticle: '已完成的读者文章', sourceSha256: proof.sourceSha256, fullText: '旧全文',
        imageUrls: ['https://old.example/poison.png'],
        freshRewriteProvenance: structuredClone(proof),
        analysisManifest: { freshRewriteProvenance: structuredClone(proof),
            sourceAcquisition: { sourceSha256: proof.sourceSha256 } } };
    return { plan, bound, generation: path.join(plan.sourcesDir, id, 'generation-000001') };
}

test('来源存在但读不出来时，日更绑定判定报错，不把读取失败当成来源换新', async t => {
    const id = '2609.12351';
    const { plan, bound, generation } = await capturedPlanWithBoundPaper(t, id, 'read-failure-binding');
    assert.equal(daily.isPaperBoundToPlan(bound, plan), true);
    const snapshot = JSON.stringify(bound);
    const readFailure = error => error.code === 'DAILY_FRESH_SOURCE_PLAN_INTEGRITY'
        && /封存来源读不出来/.test(error.message);

    // 清单损坏：文件在，JSON 读不出来。
    const manifestPath = path.join(generation, 'source-manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    fs.appendFileSync(manifestPath, 'x');
    try {
        assert.throws(() => daily.isPaperBoundToPlan(bound, plan), readFailure);
        assert.throws(() => daily.prepareDailyPaper(bound, plan), readFailure);
    } finally { fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o600 }); }

    // 文件存在但权限不足：读不出来，同样不能当成未绑定。
    if (permissionChecksApply) {
        const textPath = path.join(generation, 'source.txt');
        fs.chmodSync(textPath, 0o000);
        try {
            assert.throws(() => daily.isPaperBoundToPlan(bound, plan), readFailure);
            assert.throws(() => daily.prepareDailyPaper(bound, plan), readFailure);
        } finally { fs.chmodSync(textPath, 0o600); }
    }

    // 报错之后原记录一个字段都没被删掉，也就不会重新请求模型。
    assert.equal(JSON.stringify(bound), snapshot);
    assert.equal(bound.analysis, '已完成的整篇分析');
    assert.equal(bound.apiReaderArticle, '已完成的读者文章');

    // 来源文件可读取，但分析记录与当前来源不对应时，清除旧分析字段。
    const unbound = { ...structuredClone(bound),
        freshRewriteProvenance: { ...bound.freshRewriteProvenance, sourceSha256: '0'.repeat(64) } };
    assert.equal(daily.isPaperBoundToPlan(unbound, plan), false);
    assert.equal(daily.prepareDailyPaper(unbound, plan).analysis, undefined);

    // 来源目录确实不存在：ENOENT 仍然是未绑定，行为不变。
    fs.rmSync(path.join(plan.sourcesDir, id), { recursive: true, force: true });
    assert.equal(daily.isPaperBoundToPlan(bound, plan), false);
    assert.equal(daily.prepareDailyPaper(bound, plan).analysis, undefined);
});

test('来源目录权限不足时也算读不出来，existsSync 不吞 EACCES', async t => {
    if (!permissionChecksApply) return;
    const id = '2609.12352';
    const { plan, bound } = await capturedPlanWithBoundPaper(t, id, 'parent-permission-binding');
    assert.equal(daily.isPaperBoundToPlan(bound, plan), true);
    const paperDirectory = path.join(plan.sourcesDir, id);
    fs.chmodSync(paperDirectory, 0o000);
    try {
        assert.throws(() => daily.isPaperBoundToPlan(bound, plan),
            error => error.code === 'DAILY_FRESH_SOURCE_PLAN_INTEGRITY' && /封存来源读不出来/.test(error.message));
        assert.throws(() => daily.prepareDailyPaper(bound, plan), /封存来源读不出来/);
    } finally { fs.chmodSync(paperDirectory, 0o700); }
});

test('即使调用方绕过论文准备，直连日更范围也拒绝调用方自带的旧版图片 URL', () => {
    const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
    const deep = require('../scripts/deep-analyzer.js');
    const source = { paperId: 'arxiv:2609.12349', source: 'html', sourceId: '2609.12349', text: 'fresh source text',
        imageInfos: [], structuredArtifacts: { payloadSha256: 'a'.repeat(64), tables: [], formulas: [], figures: [] } };
    const result = direct.withDirectRewriteAnalysisSource({ paperId: source.paperId, route: 'arxiv-fresh-fetch',
        sourceDetails: source, readerAttemptsDir: path.join(os.tmpdir(), 'daily-direct-reader-attempts') }, () => (
        deep.getPreProvidedImageUrls({ imageUrls: ['https://old.example/poison.png'],
            analysisRecoveryImageManifest: { candidates: [{ url: 'https://old.example/poison.png' }] } })
    ));
    assert.deepEqual(result, []);
});

test('旧成功日更遇到封存数学字母必须重分析，普通旧结果和新清洗记录仍可恢复', async t => {
    fixture(t);
    const contract = require('../scripts/lib/model-text-sanitization.js');
    for (const [index, prefix] of ['', '原式 𝑥 = 𝑦。'].entries()) {
        const id = `2610.1000${index}`;
        const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-09', batchId: `unicode-${index}`,
            papers: [{ arxivId: id }] });
        await daily.captureDailyFreshSources(plan, {
            capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
                .captureFreshArxivRewriteSource(options, {
                    fetchText: async () => {
                        const source = sourcePayload(id);
                        source.text = prefix + source.text;
                        source.structuredArtifacts.flattenedTextSha256 = sha(source.text);
                        delete source.structuredArtifacts.payloadSha256;
                        source.structuredArtifacts.payloadSha256 = sha(JSON.stringify(source.structuredArtifacts));
                        return source;
                    },
                    fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nUnicode source\n%%EOF\n'),
                        url: `https://arxiv.org/pdf/${id}.pdf` })
                })
        });
        const details = daily.readDailyFreshSource(plan, { arxivId: id });
        const descriptor = details.freshSourceDescriptor;
        const proof = { contract: 'fresh-source-analysis-v1', runId: plan.runId,
            sourceSha256: descriptor.sourceSha256, structuredArtifactsSha256: descriptor.structuredArtifactsSha256,
            sourceSnapshotSha256: descriptor.sourceSnapshotSha256, sourceGeneration: descriptor.sourceGeneration,
            sourceManifestSha256: descriptor.sourceManifestSha256, sourceOnly: true, oldGeneratedTextIncluded: false };
        const paper = { arxivId: id, analysis: '旧成功正文', analysisCheckpoint: '旧检查点',
            sourceSha256: proof.sourceSha256, freshRewriteProvenance: proof,
            analysisManifest: { version: 1, sourceAcquisition: { sourceSha256: proof.sourceSha256 },
                freshRewriteProvenance: structuredClone(proof),
                stages: { primaryAnalysis: { status: 'complete', fingerprint: 'old-primary' } } } };
        const before = JSON.stringify(paper);
        assert.equal(daily.isPaperBoundToPlan(paper, plan), index === 0);
        assert.equal(JSON.stringify(paper), before, '只读资格检查不改旧成功记录');
        const prepared = daily.prepareDailyPaper(paper, plan);
        assert.equal(prepared.analysis, index === 0 ? '旧成功正文' : undefined);
        if (index === 1) {
            assert.equal(prepared.analysisStaleSnapshots[0].payload.sourceAcquisition.sourceSha256, proof.sourceSha256);
            assert.equal(prepared.analysisStaleSnapshots[0].payload.analysisCheckpoint, '旧检查点');
        }
        paper.analysisManifest.sourceAcquisition.modelTextSanitizationContract = contract.MODEL_TEXT_SANITIZATION_CONTRACT;
        assert.equal(daily.isPaperBoundToPlan(paper, plan), true);
        assert.equal(daily.readDailyFreshSource(plan, paper).freshSourceDescriptor.sourceSha256, proof.sourceSha256);
    }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const source = require('../scripts/lib/fresh-arxiv-rewrite-source.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fresh-arxiv-rewrite-source-'));
    const sourceRoot = path.join(root, 'runtime', 'fetched-arxiv-sources');
    const temporaryRoot = path.join(root, 'temporary-figures');
    const currentRoot = path.join(root, 'data', 'current');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, sourceRoot, temporaryRoot, currentRoot };
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const filesUnder = root => {
    if (!fs.existsSync(root)) return [];
    const output = [];
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(filename);
            else output.push(path.relative(root, filename).split(path.sep).join('/'));
        }
    };
    visit(root); return output.sort();
};
function textResponse(id, suffix = 'one') {
    return {
        text: `Fresh official arXiv HTML-derived text ${suffix}. `.repeat(80),
        source: 'html', sourceId: `${id}v3`, url: `https://arxiv.org/html/${id}v3`,
        fetchedAt: '2026-09-07T00:00:01.000Z'
    };
}
function pdfResponse(id, suffix = 'one') {
    return { bytes: Buffer.from(`%PDF-1.7\nFresh official PDF ${id} ${suffix}\n%%EOF\n`, 'utf8'),
        url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: '2026-09-07T00:00:02.000Z' };
}

test('当日 arXiv 来源获取用原子写入保存官方文本、PDF 和不含图片像素的来源元数据', async t => {
    const f = fixture(t); const id = '2403.14817'; let textCalls = 0; let pdfCalls = 0;
    const result = await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z', extractorVersion: 'test-extractor-v9' }, {
        fetchText: async requested => { textCalls++; assert.equal(requested, id); return textResponse(id); },
        fetchPdf: async requested => { pdfCalls++; assert.equal(requested, id); return pdfResponse(id); }
    });
    assert.equal(result.status, 'captured'); assert.equal(result.fetched, true);
    assert.deepEqual({ textCalls, pdfCalls }, { textCalls: 1, pdfCalls: 1 });
    const directory = source.sourceDirectory(f.sourceRoot, id, 1);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt']);
    for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
    assert.equal(result.text, textResponse(id).text);
    assert.deepEqual(result.pdf, pdfResponse(id).bytes);
    assert.equal(result.manifest.text.url, `https://arxiv.org/html/${id}v3`);
    assert.equal(result.manifest.pdf.url, `https://arxiv.org/pdf/${id}.pdf`);
    assert.equal(result.manifest.text.responseBytes, Buffer.byteLength(result.text));
    assert.equal(result.manifest.text.responseSha256, sha256(Buffer.from(result.text)));
    assert.equal(result.manifest.pdf.responseBytes, result.pdf.length);
    assert.equal(result.manifest.pdf.responseSha256, sha256(result.pdf));
    assert.equal(result.manifest.text.extractor.version, 'test-extractor-v9');
    assert.equal(result.manifest.runtimeMetadata.filename, 'source-runtime.json');
    assert.deepEqual(Object.keys(result.manifest).sort(), ['arxivId', 'capturedAt', 'contract', 'generation',
        'paperId', 'pdf', 'runtimeMetadata', 'text', 'version']);
    assert.equal(Object.hasOwn(result.runtimeDetails, 'sourceVersion'), false,
        '普通当前版本的来源记录保持原字段结构');
    assert.equal(result.runtimeDetails.title, textResponse(id).text.slice(0, 2000), 'HTML 没有明确标题字段时，从本次来源文本中截取并保存标题');
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'source-runtime.json'), 'utf8'), /(?:cachePath|tempPath|rawBytes|assetBytes|base64|buffer)/);
    assert.equal(fs.existsSync(f.currentRoot), false, '来源抓取不能写入 data/current');
});

test('当前 PDF 已撤下时，保存一份参与自哈希的同版本回退，并强制用这些 PDF 字节作为来源文本', async t => {
    const f = fixture(t); const id = '2604.14654'; const selected = `${id}v1`;
    const rawPdf = { bytes: Buffer.from('%PDF-1.7\nwithdrawn historical version\n%%EOF\n'),
        sourceId: selected, url: `https://arxiv.org/pdf/${selected}.pdf`,
        fetchedAt: '2026-09-07T00:00:02.000Z', currentPdfUnavailable: true, currentPdfStatus: 404 };
    let extracted = 0;
    const result = await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z' }, {
        fetchText: async () => ({ ...textResponse(id), title: 'Historical paper title', sourceId: selected,
            url: `https://arxiv.org/html/${selected}`, htmlAvailability: 'available', htmlAttempts: 1,
            structuredArtifacts: { forbiddenMixedHtmlEvidence: true } }),
        fetchPdf: async (requested, options) => {
            assert.equal(requested, id); assert.equal(options.preferredSourceId, selected); return rawPdf;
        },
        extractPdfText: async (requested, bytes, options) => {
            extracted += 1; assert.equal(requested, id); assert.deepEqual(bytes, rawPdf.bytes);
            assert.equal(options.sourceId, selected);
            return { text: 'Text extracted exclusively from the selected historical PDF bytes. '.repeat(20) };
        }
    });
    assert.equal(extracted, 1, '版本回退必须从选定的 PDF 提取文本，不使用撤稿说明或当前 HTML 页面');
    assert.equal(result.manifest.text.source, 'pdf');
    assert.equal(result.manifest.text.sourceId, selected);
    assert.equal(result.manifest.text.url, rawPdf.url);
    assert.equal(result.manifest.pdf.url, rawPdf.url);
    assert.equal(result.runtimeDetails.title, 'Historical paper title');
    assert.doesNotMatch(result.runtimeDetails.title, /来源版本警告/,
        '必要的来源版本警告不能替代论文标题');
    assert.equal(result.runtimeDetails.sourceVersion.selectedSourceId, selected);
    assert.equal(result.runtimeDetails.sourceVersion.attemptedCurrentPdfStatus, 404);
    assert.match(result.text, /^【来源版本警告】arXiv 当前无版本 PDF/);
    assert.match(result.text, /当前稿不可用/);
    assert.doesNotMatch(JSON.stringify(result.runtimeDetails.structuredArtifacts), /forbiddenMixedHtmlEvidence/);
    const runtime = JSON.parse(fs.readFileSync(path.join(result.directory, 'source-runtime.json'), 'utf8'));
    assert.equal(runtime.sourceVersion.identitySha256, result.runtimeDetails.sourceVersion.identitySha256);
    assert.ok(runtime.warnings.includes(runtime.sourceVersion.warning));
    const replay = source.readFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1 });
    assert.deepEqual(replay.runtimeDetails.sourceVersion, result.runtimeDetails.sourceVersion);
    assert.equal(replay.sourceManifestSha256, result.sourceManifestSha256);
});

test('带版本的 PDF 校验拒绝跨论文 URL、查询串或片段夹带，以及无法证明的当前可用性', async t => {
    const f = fixture(t); const id = '2604.14654'; const common = { rootDir: f.sourceRoot, arxivId: id,
        now: '2026-09-07T00:00:00.000Z' };
    const text = async () => ({ ...textResponse(id), sourceId: `${id}v1`, url: `https://arxiv.org/html/${id}v1` });
    const candidate = url => ({ bytes: Buffer.from('%PDF-1.7\nversion\n%%EOF\n'), sourceId: `${id}v1`, url,
        currentPdfUnavailable: true, currentPdfStatus: 404 });
    await assert.rejects(source.captureFreshArxivRewriteSource({ ...common, generation: 1 }, {
        fetchText: text, fetchPdf: async () => candidate('https://arxiv.org/pdf/2605.03462v1.pdf')
    }), /PDF URL 的路径必须对应本次请求的 arXiv ID 和版本/);
    await assert.rejects(source.captureFreshArxivRewriteSource({ ...common, generation: 2 }, {
        fetchText: text, fetchPdf: async () => candidate(`https://arxiv.org/pdf/${id}v1.pdf?download=1`)
    }), /URL 不得包含查询参数或片段标识/);
    await assert.rejects(source.captureFreshArxivRewriteSource({ ...common, generation: 3 }, {
        fetchText: text, fetchPdf: async () => ({ ...candidate(`https://arxiv.org/pdf/${id}v1.pdf`),
            currentPdfUnavailable: false, currentPdfStatus: null })
    }), /必须记录当前无版本 PDF 返回 HTTP 404 且不可用/);
});

test('带版本的 PDF 校验接受官方 arXiv 那种不带 .pdf 后缀的重定向写法', async t => {
    const f = fixture(t); const id = '2604.14654'; const selected = `${id}v1`;
    const result = await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z' }, {
        fetchText: async () => ({ ...textResponse(id), sourceId: selected,
            url: `https://arxiv.org/html/${selected}` }),
        fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nofficial redirect spelling\n%%EOF\n'),
            sourceId: selected, url: `https://arxiv.org/pdf/${selected}`,
            currentPdfUnavailable: true, currentPdfStatus: 404 }),
        extractPdfText: async () => ({ text: 'Historical PDF text with an official redirect URL. '.repeat(40) })
    });
    assert.equal(result.manifest.pdf.url, `https://arxiv.org/pdf/${selected}`);
    assert.equal(result.runtimeDetails.sourceVersion.selectedPdfUrl, `https://arxiv.org/pdf/${selected}`);
    assert.equal(source.readFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1 })
        .runtimeDetails.sourceVersion.selectedSourceId, selected);
});

test('每个新代次都重新抓取文本和 PDF 配对，同代次续跑则只复核已保存的那一对', async t => {
    const f = fixture(t); const id = '2403.14817'; let textCalls = 0; let pdfCalls = 0;
    const deps = {
        fetchText: async requested => textResponse(requested, `text-${++textCalls}`),
        fetchPdf: async requested => pdfResponse(requested, `pdf-${++pdfCalls}`)
    };
    const first = await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z' }, deps);
    const second = await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 2,
        now: '2026-09-07T00:10:00.000Z' }, deps);
    assert.deepEqual({ textCalls, pdfCalls }, { textCalls: 2, pdfCalls: 2 });
    assert.notEqual(first.manifest.text.responseSha256, second.manifest.text.responseSha256);
    assert.notEqual(first.manifest.pdf.responseSha256, second.manifest.pdf.responseSha256);
    const resumed = await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 2,
        now: '2026-09-07T00:20:00.000Z' }, {
        fetchText: async () => { throw new Error('same-generation retry must not refetch sealed text'); },
        fetchPdf: async () => { throw new Error('same-generation retry must not refetch sealed PDF'); }
    });
    assert.equal(resumed.status, 'recovered'); assert.equal(resumed.fetched, false);
    assert.equal(resumed.manifest.pdf.responseSha256, second.manifest.pdf.responseSha256);
    assert.deepEqual({ textCalls, pdfCalls }, { textCalls: 2, pdfCalls: 2 });
});

test('抓取中断后清除未完成目录，重试时重新获取并保存文本与 PDF', async t => {
    const f = fixture(t); const id = '2403.14817'; let textCalls = 0; let pdfCalls = 0;
    const options = { rootDir: f.sourceRoot, arxivId: id, generation: 1, now: '2026-09-07T00:00:00.000Z' };
    const fetchers = {
        fetchText: async requested => textResponse(requested, `text-${++textCalls}`),
        fetchPdf: async requested => pdfResponse(requested, `pdf-${++pdfCalls}`)
    };
    await assert.rejects(source.captureFreshArxivRewriteSource(options, {
        ...fetchers, beforeCommit: async () => { throw new Error('simulated interruption'); }
    }), /simulated interruption/);
    assert.equal(source.generationExists(f.sourceRoot, id, 1), false);
    const paperDirectory = path.join(f.sourceRoot, id);
    assert.deepEqual(fs.readdirSync(paperDirectory), [], '失败后清除本次创建的未完成临时目录');
    const recovered = await source.captureFreshArxivRewriteSource(options, fetchers);
    assert.equal(recovered.status, 'captured');
    assert.deepEqual({ textCalls, pdfCalls }, { textCalls: 2, pdfCalls: 2 },
        '封存前中断后，须重新抓取官方文本和 PDF 两份响应');
    assert.deepEqual(fs.readdirSync(source.sourceDirectory(f.sourceRoot, id, 1)).sort(),
        ['source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt']);
});

test('默认适配器只用不走缓存的官方文本、PDF 和图片抓取器，绝不用旧版本地缓存', async t => {
    const f = fixture(t); const id = '2403.14817'; const deep = require('../scripts/deep-analyzer.js');
    const originalText = deep.fetchArxivHtmlTextDetailedUncached;
    const originalPdf = deep.fetchArxivPdfUncached;
    const originalFigure = deep.fetchArxivFigureBytesUncached;
    const calls = [];
    deep.fetchArxivHtmlTextDetailedUncached = async requested => {
        calls.push(`text:${requested}`); return textResponse(requested);
    };
    deep.fetchArxivPdfUncached = async requested => {
        calls.push(`pdf:${requested}`); return pdfResponse(requested);
    };
    deep.fetchArxivFigureBytesUncached = async requested => {
        calls.push(`figure:${requested}`); return { bytes: Buffer.from('pixels'), mediaType: 'image/png' };
    };
    t.after(() => {
        deep.fetchArxivHtmlTextDetailedUncached = originalText;
        deep.fetchArxivPdfUncached = originalPdf;
        deep.fetchArxivFigureBytesUncached = originalFigure;
    });
    await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z' });
    await source.withEphemeralArxivFigures({ arxivId: id,
        figures: [{ ordinal: 1, url: `https://arxiv.org/html/${id}/x.png` }], temporaryRoot: f.temporaryRoot,
        sourceRoot: f.sourceRoot }, async bundle => {
        assert.equal(fs.readFileSync(bundle.figures[0].tempPath).toString(), 'pixels');
    });
    assert.deepEqual(calls, [
        `text:${id}`, `pdf:${id}`, `figure:https://arxiv.org/html/${id}/x.png`
    ]);
    assert.equal(fs.existsSync(f.currentRoot), false);
});

test('HTML 回退只从那一份已保存的 PDF 响应里提取文本，拒绝另外抓来的 PDF 文本结果', async t => {
    const f = fixture(t); const id = '2403.14817'; let pdfCalls = 0; let extracted = 0;
    const rawPdf = pdfResponse(id, 'the-only-raw-pdf');
    const captured = await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z' }, {
        fetchText: async () => ({ text: '', source: 'unavailable', sourceId: '', htmlAvailability: 'permanent_miss',
            htmlAttempts: 2, warnings: ['no HTML'] }),
        fetchPdf: async () => { pdfCalls++; return rawPdf; },
        extractPdfText: async (requested, bytes, options) => {
            extracted++; assert.equal(requested, id); assert.deepEqual(bytes, rawPdf.bytes);
            assert.equal(options.htmlAvailability, 'permanent_miss');
            return { text: `PDF fallback source for ${requested}. `.repeat(100), source: 'pdf', sourceId: requested,
                structuredArtifacts: { never: 'persisted here' } };
        }
    });
    assert.equal(pdfCalls, 1); assert.equal(extracted, 1);
    assert.equal(captured.manifest.text.source, 'pdf');
    assert.equal(captured.manifest.pdf.responseSha256, sha256(rawPdf.bytes));
    assert.deepEqual(captured.pdf, rawPdf.bytes, '封存的 PDF 必须与回退时使用的原始字节完全一致');
    await assert.rejects(source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 2,
        now: '2026-09-07T00:10:00.000Z' }, {
        fetchText: async () => ({ text: 'a separately fetched PDF text', source: 'pdf', sourceId: id,
            url: rawPdf.url, fetchedAt: rawPdf.fetchedAt }), fetchPdf: async () => rawPdf
    }), /HTML 正文抓取函数不得自行另取 PDF 作为备用正文/);
});

test('临时图片不把 URL 和字节写进运行目录，只提供临时字节，成功后清理', async t => {
    const f = fixture(t); const id = '2403.14817';
    await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z' }, {
        fetchText: async requested => textResponse(requested), fetchPdf: async requested => pdfResponse(requested)
    });
    const figureUrl = `https://arxiv.org/html/${id}v3/x1.png`;
    const observed = await source.withEphemeralArxivFigures({ arxivId: id,
        figures: [{ ordinal: 1, url: figureUrl }], temporaryRoot: f.temporaryRoot,
        sourceRoot: f.sourceRoot, persistentRoots: [f.currentRoot] }, async bundle => {
        assert.equal(bundle.arxivId, id);
        assert.equal(bundle.figures.length, 1);
        assert.equal('url' in bundle.figures[0], false, '返回的图片记录不能带 URL 字段');
        assert.equal(fs.readFileSync(bundle.figures[0].tempPath).toString('utf8'), 'ephemeral-pixels');
        assert.ok(path.resolve(bundle.figures[0].tempPath).startsWith(`${path.resolve(f.temporaryRoot)}${path.sep}`));
        return { temporaryDirectory: bundle.temporaryDirectory, sha256: bundle.figures[0].sha256 };
    }, { fetchFigure: async requested => {
        assert.equal(requested, figureUrl);
        return { bytes: Buffer.from('ephemeral-pixels'), mediaType: 'image/png' };
    } });
    assert.ok(observed.sha256);
    assert.deepEqual(fs.readdirSync(f.temporaryRoot), [], '成功后清除本次运行的临时图片');
    assert.deepEqual(filesUnder(f.sourceRoot), [
        `${id}/generation-000001/source-manifest.json`, `${id}/generation-000001/source-runtime.json`,
        `${id}/generation-000001/source.pdf`, `${id}/generation-000001/source.txt`
    ]);
    assert.equal(fs.existsSync(f.currentRoot), false, '图片处理不能写入 data/current 的图片缓存或 api-reader-assets');
    assert.doesNotMatch(JSON.stringify(source.readFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1 }).manifest),
        /x1\.png|image-cache|api-reader-assets/);
});

test('临时图片在回调或抓取失败时也会清理，并且拒绝持久的临时根目录', async t => {
    const f = fixture(t); const id = '2403.14817'; const figureUrl = `https://arxiv.org/html/${id}/x1.png`;
    await assert.rejects(source.withEphemeralArxivFigures({ arxivId: id, figures: [{ ordinal: 1, url: figureUrl }],
        temporaryRoot: f.temporaryRoot, sourceRoot: f.sourceRoot }, async () => {
        throw new Error('reader failed');
    }, { fetchFigure: async () => ({ bytes: Buffer.from('pixels'), mediaType: 'image/png' }) }), /reader failed/);
    assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);
    await assert.rejects(source.withEphemeralArxivFigures({ arxivId: id, figures: [{ ordinal: 1, url: figureUrl }],
        temporaryRoot: f.temporaryRoot, sourceRoot: f.sourceRoot }, async () => {}, {
        fetchFigure: async () => { throw new Error('figure transport failed'); }
    }), /figure transport failed/);
    assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);
    await assert.rejects(source.withEphemeralArxivFigures({ arxivId: id, figures: [], temporaryRoot: f.sourceRoot,
        sourceRoot: f.sourceRoot }, async () => {}), /临时图片目录不得位于来源目录或其他长期保存目录内/);
    const Config = require('../scripts/config.js');
    await assert.rejects(source.withEphemeralArxivFigures({ arxivId: id, figures: [],
        temporaryRoot: path.join(Config.DATA_DIR, 'runtime', 'forbidden-figures') }, async () => {}),
    /临时图片目录必须位于系统临时目录内，且与 Config\.DATA_DIR 互不包含/);
});

test('临时图片抓取只重试暂时性的网络或状态失败，永久性检查照旧', async t => {
    const f = fixture(t); const id = '2403.14817';
    const figureUrl = `https://arxiv.org/html/${id}/x1.png`;
    for (const status of [408, 425, 429, 500, 503]) {
        assert.equal(source.isTransientEphemeralFigureFetchError(
            new Error(`arXiv Figure download failed: HTTP ${status}`)
        ), true, `HTTP ${status} 被归为可重试的临时错误`);
    }
    for (const status of [400, 401, 403, 404]) {
        assert.equal(source.isTransientEphemeralFigureFetchError(
            new Error(`arXiv Figure download failed: HTTP ${status}`)
        ), false, `HTTP ${status} 不作为临时错误重试`);
    }
    let calls = 0; const waits = [];
    const result = await source.withEphemeralArxivFigures({ arxivId: id,
        figures: [{ ordinal: 1, url: figureUrl }], temporaryRoot: f.temporaryRoot,
        sourceRoot: f.sourceRoot }, async bundle => fs.readFileSync(bundle.figures[0].tempPath, 'utf8'), {
        figureRetrySleep: async ms => { waits.push(ms); },
        fetchFigure: async () => {
            calls += 1;
            if (calls < 3) {
                const error = new TypeError('fetch failed');
                error.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
                throw error;
            }
            return { bytes: Buffer.from('pixels'), mediaType: 'image/png' };
        }
    });
    assert.equal(result, 'pixels'); assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 2000]);
    assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);

    calls = 0;
    await assert.rejects(source.withEphemeralArxivFigures({ arxivId: id,
        figures: [{ ordinal: 1, url: figureUrl }], temporaryRoot: f.temporaryRoot,
        sourceRoot: f.sourceRoot }, async () => {}, {
        figureRetrySleep: async () => {}, fetchFigure: async () => {
            calls += 1; throw new TypeError('fetch failed');
        }
    }), error => error.retryable === true && error.ephemeralFigureFetch === true
        && error.attempts === source.EPHEMERAL_FIGURE_FETCH_MAX_ATTEMPTS);
    assert.equal(calls, 3); assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);

    calls = 0;
    await assert.rejects(source.withEphemeralArxivFigures({ arxivId: id,
        figures: [{ ordinal: 1, url: figureUrl }], temporaryRoot: f.temporaryRoot,
        sourceRoot: f.sourceRoot }, async () => {}, {
        figureRetrySleep: async () => {}, fetchFigure: async () => {
            calls += 1; throw new Error('arXiv Figure download failed: HTTP 404');
        }
    }), error => error.retryable !== true && /HTTP 404/.test(error.message));
    assert.equal(calls, 1, '收到 HTTP 404 后只请求一次，不重试');
    assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);

    calls = 0;
    await assert.rejects(source.withEphemeralArxivFigures({ arxivId: id,
        figures: [{ ordinal: 1, url: 'https://arxiv.org/html/2403.99999/x1.png' }],
        temporaryRoot: f.temporaryRoot, sourceRoot: f.sourceRoot }, async () => {}, {
        fetchFigure: async () => { calls += 1; return { bytes: Buffer.from('pixels'), mediaType: 'image/png' }; }
    }), /图片 URL 的 HTML 路径指向另一篇论文/);
    assert.equal(calls, 0, '图片地址属于另一篇论文时，在请求前拒绝');

    calls = 0;
    await assert.rejects(source.withEphemeralArxivFigures({ arxivId: id,
        figures: [{ ordinal: 1, url: figureUrl }], temporaryRoot: f.temporaryRoot,
        sourceRoot: f.sourceRoot }, async () => {}, {
        fetchFigure: async () => { calls += 1; return { bytes: Buffer.from('not pixels'), mediaType: 'text/plain' }; }
    }), /临时图片的 mediaType 只接受 PNG、JPEG、WebP 或 SVG 类型/);
    assert.equal(calls, 1, '响应不是支持的图片类型时，只请求一次');
    assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);
});


test('同代次恢复会复核绑定哈希的表格、公式和图片元数据，但不存像素', async t => {
    const f = fixture(t); const id = '2403.14817';
    const table = { ordinal: 1, caption: 'Table 1', rows: [[{ text: 'metric' }, { text: '0.91' }]], sourceDomSha256: sha256('table') };
    const formula = { ordinal: 1, latex: 'x=y', sourceDomSha256: sha256('formula') };
    const figureUrl = `https://arxiv.org/html/${id}/figure-1.png`;
    const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha256(Buffer.from(textResponse(id).text)),
        tables: [table], formulas: [formula], figures: [{ ordinal: 1, caption: 'Figure 1',
            images: [{ kind: 'external_url', url: figureUrl }] }] };
    artifacts.payloadSha256 = sha256(JSON.stringify({ ...artifacts }));
    const first = await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z' }, {
        fetchText: async () => ({ ...textResponse(id), imageInfos: [{ url: figureUrl, caption: 'Figure 1' }],
            structuredArtifacts: artifacts, readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: [] }),
        fetchPdf: async () => pdfResponse(id)
    });
    assert.equal(first.runtimeDetails.structuredArtifacts.tables[0].caption, 'Table 1');
    const recovered = await source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1 }, {
        fetchText: async () => { throw new Error('sealed text must not be fetched on recovery'); },
        fetchPdf: async () => { throw new Error('sealed PDF must not be fetched on recovery'); }
    });
    assert.equal(recovered.status, 'recovered');
    assert.deepEqual(recovered.runtimeDetails.structuredArtifacts.tables, [table]);
    assert.deepEqual(recovered.runtimeDetails.structuredArtifacts.formulas, [formula]);
    assert.equal(recovered.runtimeDetails.imageInfos[0].url, figureUrl);
    const metadata = fs.readFileSync(path.join(source.sourceDirectory(f.sourceRoot, id, 1), 'source-runtime.json'), 'utf8');
    assert.doesNotMatch(metadata, /(?:rawBytes|assetBytes|cachePath|tempPath|base64|buffer)/);
    let figureFetches = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
        await source.withEphemeralArxivFigures({ arxivId: id, figures: [{ ordinal: 1, url: figureUrl }],
            temporaryRoot: f.temporaryRoot, sourceRoot: f.sourceRoot }, async bundle => {
            assert.equal(fs.readFileSync(bundle.figures[0].tempPath).toString(), `pixel-${attempt}`);
        }, { fetchFigure: async () => ({ bytes: Buffer.from(`pixel-${figureFetches++}`), mediaType: 'image/png' }) });
        assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);
    }
    assert.equal(figureFetches, 2, '每次调用都重新获取图片字节，不复用图片缓存');
});

test('真实来源捕获拒绝 HTML 地址与来源 ID 的显式版本冲突', async t => {
    const f = fixture(t);
    const id = '2601.00001';
    await assert.rejects(source.captureFreshArxivRewriteSource({
        rootDir: f.sourceRoot, arxivId: id, generation: 1
    }, {
        fetchText: async () => ({ ...textResponse(id), sourceId: `${id}v1`,
            url: `https://arxiv.org/html/${id}v2` }),
        fetchPdf: async () => pdfResponse(id)
    }), /HTML 来源地址的版本与来源 ID 不一致/);
    assert.equal(fs.existsSync(source.sourceDirectory(f.sourceRoot, id, 1)), false);
});

test('来源重读拒绝自洽清单中 HTML 地址与来源 ID 的显式版本冲突', async t => {
    const f = fixture(t);
    const id = '2601.00001';
    const options = { rootDir: f.sourceRoot, arxivId: id, generation: 1 };
    await source.captureFreshArxivRewriteSource(options, {
        fetchText: async () => textResponse(id),
        fetchPdf: async () => pdfResponse(id)
    });
    const filename = path.join(source.sourceDirectory(f.sourceRoot, id, 1), source.MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    manifest.text.url = `https://arxiv.org/html/${id}v2`;
    const canonical = value => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
            .map(key => [key, canonical(value[key])])) : value;
    const bytes = Buffer.from(`${JSON.stringify(canonical(manifest), null, 2)}\n`);
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    assert.throws(() => source.readFreshArxivRewriteSource(options), /HTML 来源地址的版本与来源 ID 不一致/);
    assert.deepEqual(fs.readFileSync(filename), bytes);
    await assert.rejects(source.captureFreshArxivRewriteSource(options, {
        fetchText: async () => { throw new Error('损坏来源不能触发重新抓取'); },
        fetchPdf: async () => { throw new Error('损坏来源不能触发重新抓取'); }
    }), /HTML 来源地址的版本与来源 ID 不一致/);
});

test('真实 HTML 来源捕获与恢复保留同版本、无版本地址和无版本来源 ID 的兼容', async t => {
    const f = fixture(t);
    const id = '2601.00001';
    const cases = [
        { sourceId: `${id}v3`, url: `https://arxiv.org/html/${id}v3` },
        { sourceId: `${id}v3`, url: `https://arxiv.org/html/${id}` },
        { sourceId: id, url: `https://arxiv.org/html/${id}v3/` },
        { sourceId: id, url: `https://arxiv.org/html/${id}/` }
    ];
    for (const [index, input] of cases.entries()) {
        const options = { rootDir: f.sourceRoot, arxivId: id, generation: index + 1 };
        const captured = await source.captureFreshArxivRewriteSource(options, {
            fetchText: async () => ({ ...textResponse(id), ...input }),
            fetchPdf: async () => pdfResponse(id)
        });
        const recovered = source.readFreshArxivRewriteSource(options);
        assert.equal(recovered.manifest.text.sourceId, input.sourceId);
        assert.equal(recovered.manifest.text.url, input.url);
        assert.equal(recovered.sourceManifestSha256, captured.sourceManifestSha256);
    }
});


test('四个来源文件变为 FIFO 时，公开读取及时拒绝并保留其余来源文件', {
    skip: process.platform === 'win32' ? '该检查需要 POSIX FIFO' : false
}, async t => {
    const f = fixture(t);
    const id = '2403.14817';
    const options = { rootDir: f.sourceRoot, arxivId: id, generation: 1,
        now: '2026-09-07T00:00:00.000Z' };
    const captured = await source.captureFreshArxivRewriteSource(options, {
        fetchText: async () => textResponse(id),
        fetchPdf: async () => pdfResponse(id)
    });
    const originalResult = source.readFreshArxivRewriteSource(options);
    const originalBytes = Object.fromEntries(source.SOURCE_FILES.map(name =>
        [name, fs.readFileSync(path.join(captured.directory, name))]));
    const { execFileSync, spawnSync } = require('node:child_process');
    const modulePath = require.resolve('../scripts/lib/fresh-arxiv-rewrite-source.js');
    for (const name of source.SOURCE_FILES) {
        await t.test(name, () => {
            const filename = path.join(captured.directory, name);
            const originalMode = fs.statSync(filename).mode & 0o777;
            fs.unlinkSync(filename);
            execFileSync('mkfifo', ['-m', '600', filename]);
            const fifo = fs.lstatSync(filename);
            try {
                const childScript = `
                    const source = require(${JSON.stringify(modulePath)});
                    try {
                        source.readFreshArxivRewriteSource(${JSON.stringify(options)});
                        process.exitCode = 3;
                    } catch (error) {
                        process.stdout.write(JSON.stringify({ code: error.code,
                            retryable: error.retryable, message: error.message }));
                    }
                `;
                const child = spawnSync(process.execPath, ['-e', childScript], {
                    encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL'
                });
                assert.equal(child.error, undefined, 'FIFO 必须在会阻塞的文件读取之前被拒绝');
                assert.equal(child.signal, null);
                assert.equal(child.status, 0, child.stderr);
                const error = JSON.parse(child.stdout);
                assert.equal(error.code, 'FRESH_ARXIV_REWRITE_SOURCE_INTEGRITY');
                assert.equal(error.retryable, false);
                assert.match(error.message, /不安全：必须是只有一个硬链接且大小不超过允许上限的普通文件/);
                const after = fs.lstatSync(filename);
                assert.equal(after.isFIFO(), true);
                assert.equal(after.ino, fifo.ino);
                assert.equal(after.dev, fifo.dev);
                assert.equal(after.mode, fifo.mode);
                for (const peer of source.SOURCE_FILES.filter(value => value !== name)) {
                    assert.deepEqual(fs.readFileSync(path.join(captured.directory, peer)), originalBytes[peer]);
                }
            } finally {
                fs.unlinkSync(filename);
                fs.writeFileSync(filename, originalBytes[name], { mode: originalMode });
            }
            assert.deepEqual(source.readFreshArxivRewriteSource(options), originalResult);
        });
    }
});

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

test('fresh arXiv generation atomically persists official text/PDF plus non-pixel source metadata', async t => {
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
    assert.equal(result.runtimeDetails.title, textResponse(id).text.slice(0, 2000), 'source title is persisted from fresh source text when HTML has no explicit title field');
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'source-runtime.json'), 'utf8'), /(?:cachePath|tempPath|rawBytes|assetBytes|base64|buffer)/);
    assert.equal(fs.existsSync(f.currentRoot), false, 'source capture must not touch data/current');
});

test('each new generation fetches a fresh text/PDF pair while same-generation resume replays only its sealed pair', async t => {
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

test('interrupted capture leaves no partial generation and retry re-fetches then seals both artifacts', async t => {
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
    assert.deepEqual(fs.readdirSync(paperDirectory), [], 'owned temporary directory is removed after failure');
    const recovered = await source.captureFreshArxivRewriteSource(options, fetchers);
    assert.equal(recovered.status, 'captured');
    assert.deepEqual({ textCalls, pdfCalls }, { textCalls: 2, pdfCalls: 2 },
        'unsealed interruption must fetch both official responses again');
    assert.deepEqual(fs.readdirSync(source.sourceDirectory(f.sourceRoot, id, 1)).sort(),
        ['source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt']);
});

test('default adapters use only uncached official text/PDF/figure fetchers, never legacy local caches', async t => {
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

test('HTML fallback extracts text from the single sealed PDF response and rejects an independently fetched PDF text result', async t => {
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
    assert.deepEqual(captured.pdf, rawPdf.bytes, 'the exact fallback bytes are the sealed PDF');
    await assert.rejects(source.captureFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 2,
        now: '2026-09-07T00:10:00.000Z' }, {
        fetchText: async () => ({ text: 'a separately fetched PDF text', source: 'pdf', sourceId: id,
            url: rawPdf.url, fetchedAt: rawPdf.fetchedAt }), fetchPdf: async () => rawPdf
    }), /independent PDF fallback/);
});

test('ephemeral figures keep URLs and bytes out of runtime, provide only temporary bytes, and clean up after success', async t => {
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
        assert.equal('url' in bundle.figures[0], false, 'figure URL is not returned for serialization');
        assert.equal(fs.readFileSync(bundle.figures[0].tempPath).toString('utf8'), 'ephemeral-pixels');
        assert.ok(path.resolve(bundle.figures[0].tempPath).startsWith(`${path.resolve(f.temporaryRoot)}${path.sep}`));
        return { temporaryDirectory: bundle.temporaryDirectory, sha256: bundle.figures[0].sha256 };
    }, { fetchFigure: async requested => {
        assert.equal(requested, figureUrl);
        return { bytes: Buffer.from('ephemeral-pixels'), mediaType: 'image/png' };
    } });
    assert.ok(observed.sha256);
    assert.deepEqual(fs.readdirSync(f.temporaryRoot), [], 'success removes active-run temporary figures');
    assert.deepEqual(filesUnder(f.sourceRoot), [
        `${id}/generation-000001/source-manifest.json`, `${id}/generation-000001/source-runtime.json`,
        `${id}/generation-000001/source.pdf`, `${id}/generation-000001/source.txt`
    ]);
    assert.equal(fs.existsSync(f.currentRoot), false, 'figure path cannot write data/current image-cache or api-reader-assets');
    assert.doesNotMatch(JSON.stringify(source.readFreshArxivRewriteSource({ rootDir: f.sourceRoot, arxivId: id, generation: 1 }).manifest),
        /x1\.png|image-cache|api-reader-assets/);
});

test('ephemeral figures are cleaned on callback and fetch failure and reject persistent temporary roots', async t => {
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
        sourceRoot: f.sourceRoot }, async () => {}), /persistent runtime directory/);
    const Config = require('../scripts/config.js');
    await assert.rejects(source.withEphemeralArxivFigures({ arxivId: id, figures: [],
        temporaryRoot: path.join(Config.DATA_DIR, 'runtime', 'forbidden-figures') }, async () => {}),
    /OS-temporary directory outside Config\.DATA_DIR/);
});


test('same-generation recovery replays hash-bound table/formula/figure metadata without storing pixels', async t => {
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
    assert.equal(figureFetches, 2, 'each direct attempt refetches pixels; no image cache exists');
});

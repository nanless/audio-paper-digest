
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');
const Config = require('../scripts/config.js');
const deep = require('../scripts/deep-analyzer.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const capturer = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const parser = require('../scripts/lib/reader-author-parser.js');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
const { spawnSync } = require('node:child_process');
const expected = ['Alice Brown', 'Bob White', 'Carol Green'].map((name, i) => ({ name, affiliations: ['University ' + ['A','B','C'][i]] }));
async function sealed(t, noAuthors = false, captureSet = expected) {
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sealed-authors-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(folder, 'daily-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(folder, { recursive: true, force: true }); });
    const id = '2610.12345';
    const html = '<html><head>' + (noAuthors ? '' : captureSet.map(author => '<meta name="citation_author" content="' + author.name + '"><meta name="citation_author_institution" content="' + author.affiliations[0] + '">').join('')) + '</head><body><section>' + 'Methods, controlled observations, experiments and limitations. '.repeat(160) + '</section></body></html>';
    const text = cheerio.load(html).text();
    const structuredArtifacts = deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(html, id + 'v1', id), text);
    const readerAuthors = noAuthors ? null : parser.parseArxivReaderAuthors(cheerio.load(html));
    if (!noAuthors) assert.deepEqual(readerAuthors.authors, captureSet);
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'sealed-authors-test', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => capturer.captureFreshArxivRewriteSource(options, {
        fetchText: async () => ({ title: 'Official title', source: 'html', text, sourceId: id + 'v1', url: 'https://arxiv.org/html/' + id + 'v1', structuredArtifacts, readerAuthors }),
        fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nFixture\n%%EOF\n'), url: 'https://arxiv.org/pdf/' + id, sourceId: id }),
        extractPdfText: async () => ({ text: 'PDF methods, experiments and limitations. '.repeat(160) })
    }) });
    return { plan, id, source: daily.readDailyFreshSource(plan, { arxivId: id }), runtimePath: path.join(plan.sourcesDir, id, 'generation-000001', 'source-runtime.json') };
}
test('公开封存来源在不保留 HTML 字符串时仍提供三位作者机构，复制对象没有封存许可', async t => {
    const { source } = await sealed(t);
    assert.equal(source.readerAuthors.sourceHtml, undefined);
    assert.deepEqual(parser.verifiedReaderAuthorDetails(source).readerAuthors.authors, expected);
    assert.equal(parser.verifiedReaderAuthorDetails(structuredClone(source)).readerAuthors, null);
    assert.equal(parser.verifiedReaderAuthorDetails({ ...source }).readerAuthors, null);
});
test('封存对象字段和物理来源发生变化均拒绝作者凭证', async t => {
    const { source, runtimePath } = await sealed(t);
    source.readerAuthors.authors[0].name = 'Other Person';
    assert.throws(() => parser.verifiedReaderAuthorDetails(source));
    source.readerAuthors.authors[0].name = expected[0].name;
    assert.deepEqual(parser.verifiedReaderAuthorDetails(source).readerAuthors.authors, expected);
    fs.appendFileSync(runtimePath, ' ');
    assert.throws(() => parser.verifiedReaderAuthorDetails(source));
});
test('合法封存来源未提供作者时返回不可得而不抛异常', async t => {
    const { source, plan, id } = await sealed(t, true);
    assert.equal(parser.verifiedReaderAuthorDetails(source).readerAuthors, null);
    const analyze = daily.createDailyAnalyzeFn(plan, { analyze: async paper => {
        assert.equal(parser.verifiedReaderAuthorDetails(direct.getDirectRewriteSource(paper)).readerAuthors, null);
        return paper;
    } });
    await daily.withDailyFreshAnalysisContext(plan, () => analyze({ arxivId: id }));
});

test('正常每日分析的直接来源克隆在已核验作用域内保持作者证明，外部对象不能建立作用域', async t => {
    const { plan, id, source } = await sealed(t);
    let calls = 0;
    const analyze = daily.createDailyAnalyzeFn(plan, { analyze: async paper => {
        calls++;
        const actual = direct.getDirectRewriteSource(paper);
        assert.notEqual(actual, source);
        assert.equal(actual.readerAuthors.sourceHtml, undefined);
        assert.deepEqual(parser.verifiedReaderAuthorDetails(actual).readerAuthors.authors, expected);
        console.log(JSON.stringify({ control: 'normalDirect', authors: parser.verifiedReaderAuthorDetails(actual).readerAuthors.authors, sourceHtmlSha256: actual.structuredArtifacts.sourceHtmlSha256 }));
        actual.readerAuthors.authors[0].affiliations = ['Tampered Institute'];
        assert.throws(() => parser.verifiedReaderAuthorDetails(actual));
        return paper;
    } });
    await daily.withDailyFreshAnalysisContext(plan, () => analyze({ arxivId: id }));
    assert.equal(calls, 1);
    assert.throws(() => fresh.withVerifiedBundleReaderAuthorSource(structuredClone(source), () => {}));
});

 test('封存作者集合污染时正常每日直接来源全部机构降级，保留原物理凭证', async t => {
    const metadata = [...expected.map(author => author.name), 'Dave Black'];
    const captured = [...expected, { name: 'Dave Black', affiliations: ['University D'] }, { name: 'Aalto University', affiliations: ['University E'] }];
    const { plan, id, runtimePath } = await sealed(t, false, captured);
    const before = fs.readFileSync(runtimePath);
    let calls = 0;
    const analyze = daily.createDailyAnalyzeFn(plan, { analyze: async paper => {
        calls++;
        const source = direct.getDirectRewriteSource(paper);
        const verified = parser.verifiedReaderAuthorDetails(source);
        assert.equal(verified.readerAuthors.authors.length, 5);
        const authors = parser.resolveApiReaderAuthors(paper, verified);
        assert.deepEqual(authors.authors.map(author => author.name), metadata);
        for (const author of authors.identity.authors) {
            assert.match(author.affiliations[0], /未.*可靠/);
            assert.equal(author.nameBinding.sourceKind, 'paper_metadata');
            assert.equal(author.affiliationBindings[0].sourceKind, 'explicit_unavailable');
        }
        return paper;
    } });
    await daily.withDailyFreshAnalysisContext(plan, () => analyze({ arxivId: id, authors: metadata }));
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(runtimePath), before);
});

async function publicationInput(t) {
    const { source, plan, id, runtimePath } = await sealed(t);
    const paper = { arxivId: id, authors: expected.map(author => author.name),
        sourceSha256: source.freshSourceDescriptor.sourceSha256,
        analysisManifest: { contracts: { apiReaderArticle: 'beginner-researcher-v3' },
            sourceAcquisition: { sourceSha256: source.freshSourceDescriptor.sourceSha256 },
            stages: { apiReaderArticle: { status: 'complete',
                structuredArtifactsSha256: source.structuredArtifacts.payloadSha256 } } } };
    await daily.withDailyFreshAnalysisContext(plan, () => {
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
        paper.apiReaderAuthors = parser.resolveVerifiedReaderAuthors(paper, source);
    });
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    stage.readerAuthorIdentitySha256 = paper.apiReaderAuthors.identitySha256;
    stage.readerAuthorsSha256 = daily.stableHash(paper.apiReaderAuthors);
    return { input: { paper, sourceDetails: source, sealedBundleRoot: plan.sourcesDir }, runtimePath };
}

function runPrivateAuthorReplay(input) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'author-fd-replay-'));
    const filename = path.join(directory, 'input.json');
    fs.writeFileSync(filename, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
    const descriptor = fs.openSync(filename, 'r');
    try {
        const result = spawnSync(process.execPath,
            [path.resolve(__dirname, '../scripts/lib/reader-author-replay-cli.js'), '3'], {
                stdio: ['ignore', 'pipe', 'pipe', descriptor], encoding: 'utf8', timeout: 30000,
                env: {}
            });
        assert.equal(result.signal, null);
        return { status: result.status, output: result.stdout };
    } finally {
        fs.closeSync(descriptor);
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('实际发布子进程重新核四文件后保留无 HTML 字符串的真实作者机构', async t => {
    const { input, runtimePath } = await publicationInput(t);
    assert.equal(input.sourceDetails.readerAuthors.sourceHtml, undefined);
    const before = fs.readFileSync(runtimePath);
    assert.deepEqual(runPrivateAuthorReplay(input), { status: 0, output: '{"verified":true}' });
    assert.deepEqual(fs.readFileSync(runtimePath), before);
    const unbound = structuredClone(input);
    delete unbound.sealedBundleRoot;
    assert.equal(runPrivateAuthorReplay(unbound).output, '{"verified":false}');
});

test('发布作者重放仍拒错误机构、伪传入来源、错清单快照与错论文或运行身份', async t => {
    const { input } = await publicationInput(t);
    for (const mutate of [
        value => {
            const record = value.paper.apiReaderAuthors;
            record.authors[0].affiliations = ['Invented University'];
            record.identity.authors[0].affiliations = ['Invented University'];
            record.identity.authors[0].affiliationBindings[0].sourceValue = 'Invented University';
            record.identitySha256 = daily.stableHash(record.identity);
            value.paper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = record.identitySha256;
            value.paper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = daily.stableHash(record);
        },
        value => { value.sourceDetails.readerAuthors.authors[0].affiliations = ['Invented University']; },
        value => { value.paper.freshRewriteProvenance.sourceManifestSha256 = 'f'.repeat(64); },
        value => { value.paper.freshRewriteProvenance.sourceSnapshotSha256 = 'f'.repeat(64); },
        value => { value.paper.sourceSha256 = 'f'.repeat(64); },
        value => { value.paper.analysisManifest.sourceAcquisition.sourceSha256 = 'f'.repeat(64); },
        value => { value.paper.arxivId = '2610.54321'; },
        value => { value.sealedBundleRoot = path.join(path.dirname(value.sealedBundleRoot), 'another-root', 'sources'); }
    ]) {
        const invalid = structuredClone(input);
        mutate(invalid);
        assert.equal(runPrivateAuthorReplay(invalid).output, '{"verified":false}');
    }
});

test('作者发布重放逐次核实际封存文件，物理文件损坏后拒绝而不删除证据', async t => {
    const { input, runtimePath } = await publicationInput(t);
    fs.appendFileSync(runtimePath, ' ');
    const damaged = fs.readFileSync(runtimePath);
    assert.equal(runPrivateAuthorReplay(input).output, '{"verified":false}');
    assert.deepEqual(fs.readFileSync(runtimePath), damaged);
});

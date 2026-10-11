
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
const expected = ['Alice Brown', 'Bob White', 'Carol Green'].map((name, i) => ({ name, affiliations: ['University ' + ['A','B','C'][i]] }));
async function sealed(t, noAuthors = false) {
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sealed-authors-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(folder, 'daily-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(folder, { recursive: true, force: true }); });
    const id = '2610.12345';
    const html = '<html><head>' + (noAuthors ? '' : expected.map(author => '<meta name="citation_author" content="' + author.name + '"><meta name="citation_author_institution" content="' + author.affiliations[0] + '">').join('')) + '</head><body><section>' + 'Methods, controlled observations, experiments and limitations. '.repeat(160) + '</section></body></html>';
    const text = cheerio.load(html).text();
    const structuredArtifacts = deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(html, id + 'v1', id), text);
    const readerAuthors = noAuthors ? null : parser.parseArxivReaderAuthors(cheerio.load(html));
    if (!noAuthors) assert.deepEqual(readerAuthors.authors, expected);
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

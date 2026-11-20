'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');

const Config = require('../scripts/config.js');
const deep = require('../scripts/deep-analyzer.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const capturer = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const parser = require('../scripts/lib/reader-author-parser.js');
const authorSource = require('../scripts/lib/reader-author-source.js');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = value => {
    const normalize = item => Array.isArray(item)
        ? item.map(normalize)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
            : item;
    return sha256(JSON.stringify(normalize(value)));
};

function buildHtmlFixture({
    arxivId = '2611.12345',
    authorName = 'Alice Brown',
    institution = 'University Alpha',
    bodyText = 'Controlled audio representation learning experiments and observations.'
} = {}) {
    const html = '<html><head>'
        + `<meta name="citation_author" content="${authorName}">`
        + `<meta name="citation_author_institution" content="${institution}">`
        + '</head><body>'
        + '<div class="ltx_authors"><div class="ltx_creator ltx_role_author">'
        + `<span class="ltx_personname">${authorName}</span>`
        + '</div></div>'
        + `<section><p>${bodyText}</p></section></body></html>`;
    const text = cheerio.load(html).text();
    const structuredArtifacts = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html, `${arxivId}v1`, arxivId),
        text
    );
    const details = {
        source: 'html',
        text,
        structuredArtifacts,
        readerAuthors: parser.retainAuthorSourceHtml(
            parser.parseArxivReaderAuthors(cheerio.load(html)),
            html
        )
    };
    const paper = {
        arxivId: `${arxivId}v1`,
        authors: [authorName],
        sourceSha256: sha256(text),
        analysisManifest: {
            contracts: { apiReaderArticle: 'beginner-researcher-v3' },
            sourceAcquisition: {
                sourceSha256: sha256(text),
                structuredArtifactsSha256: structuredArtifacts.payloadSha256
            },
            stages: {
                apiReaderArticle: {
                    status: 'complete',
                    structuredArtifactsSha256: structuredArtifacts.payloadSha256
                }
            }
        }
    };
    paper.apiReaderAuthors = parser.resolveVerifiedReaderAuthors(paper, details);
    paper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = paper.apiReaderAuthors.identitySha256;
    paper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = stableHash(paper.apiReaderAuthors);
    return { html, text, details, paper };
}

test('冷启动与缓存命中对正向、反向及作者集合不一致告警场景保持完全一致结果', t => {
    parser.clearReaderAuthorVerificationCaches();
    const valid = buildHtmlFixture({ arxivId: '2611.10001', authorName: 'Alice Brown', institution: 'University Alpha' });
    parser.clearReaderAuthorVerificationCaches();

    const coldTrue = parser.readerAuthorIdentityMatchesSource(valid.paper, valid.details);
    const statsAfterColdTrue = parser.getReaderAuthorVerificationCacheStats();
    assert.equal(coldTrue, true);
    assert.equal(statsAfterColdTrue.htmlMisses, 1);
    assert.equal(statsAfterColdTrue.htmlHits, 0);
    assert.equal(statsAfterColdTrue.verifiedMatchMisses, 1);
    assert.equal(statsAfterColdTrue.verifiedMatchHits, 0);

    const warmTrue = parser.readerAuthorIdentityMatchesSource(valid.paper, valid.details);
    const statsAfterWarmTrue = parser.getReaderAuthorVerificationCacheStats();
    assert.equal(warmTrue, coldTrue);
    assert.equal(statsAfterWarmTrue.htmlHits, 1);
    assert.equal(statsAfterWarmTrue.verifiedMatchHits, 1);
    assert.equal(authorSource.canReuseReaderAuthorInputs(valid.paper, valid.details), true);

    // 反向场景：保存的机构与原始 HTML 不一致
    const wrongPaper = structuredClone(valid.paper);
    wrongPaper.apiReaderAuthors.authors[0].affiliations = ['Tampered Institute'];
    wrongPaper.apiReaderAuthors.identity.authors[0].affiliations = ['Tampered Institute'];
    wrongPaper.apiReaderAuthors.identity.authors[0].affiliationBindings[0].sourceValue = 'Tampered Institute';
    wrongPaper.apiReaderAuthors.identitySha256 = stableHash(wrongPaper.apiReaderAuthors.identity);
    wrongPaper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = wrongPaper.apiReaderAuthors.identitySha256;
    wrongPaper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = stableHash(wrongPaper.apiReaderAuthors);

    parser.clearReaderAuthorVerificationCaches();
    const coldFalse = parser.readerAuthorIdentityMatchesSource(wrongPaper, valid.details);
    const warmFalse = parser.readerAuthorIdentityMatchesSource(wrongPaper, valid.details);
    assert.equal(coldFalse, false);
    assert.equal(warmFalse, false);
    assert.equal(parser.getReaderAuthorVerificationCacheStats().verifiedMatchHits, 1);

    // 作者元数据与 DOM 作者集合不一致：首次检查触发告警，后续重复校验命中缓存且结果完全一致
    const mismatchFixture = buildHtmlFixture({ arxivId: '2611.10002', authorName: 'Alice Brown', institution: 'University Alpha' });
    const mismatchPaper = structuredClone(mismatchFixture.paper);
    mismatchPaper.authors = ['Charlie Green'];
    mismatchPaper.apiReaderAuthors = parser.resolveVerifiedReaderAuthors(mismatchPaper, mismatchFixture.details);
    mismatchPaper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = mismatchPaper.apiReaderAuthors.identitySha256;
    mismatchPaper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = stableHash(mismatchPaper.apiReaderAuthors);

    parser.clearReaderAuthorVerificationCaches();
    const warnings = [];
    t.mock.method(console, 'warn', message => warnings.push(String(message)));
    const firstMismatchCheck = parser.readerAuthorIdentityMatchesSource(mismatchPaper, mismatchFixture.details);
    const secondMismatchCheck = parser.readerAuthorIdentityMatchesSource(mismatchPaper, mismatchFixture.details);
    const thirdMismatchCheck = authorSource.canReuseReaderAuthorInputs(mismatchPaper, mismatchFixture.details);
    assert.equal(firstMismatchCheck, true);
    assert.equal(secondMismatchCheck, true);
    assert.equal(thirdMismatchCheck, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2611\.10002v1 姓名集合与论文元数据不一致/);
});

test('返回值具备深拷贝隔离，调用方修改返回对象不会污染后续缓存结果', () => {
    parser.clearReaderAuthorVerificationCaches();
    const { details } = buildHtmlFixture({ arxivId: '2611.20001', authorName: 'Bob White', institution: 'Institute Beta' });

    const replayed1 = parser.replayHtmlReaderAuthors(details);
    assert.deepEqual(replayed1.authors, [{ name: 'Bob White', affiliations: ['Institute Beta'] }]);
    replayed1.authors[0].name = 'Mutated Person';
    replayed1.authors[0].affiliations.push('Mutated Lab');
    replayed1.sourceDomSha256 = '0'.repeat(64);

    const replayed2 = parser.replayHtmlReaderAuthors(details);
    assert.deepEqual(replayed2.authors, [{ name: 'Bob White', affiliations: ['Institute Beta'] }]);
    assert.notEqual(replayed2.sourceDomSha256, '0'.repeat(64));

    const verified1 = parser.verifiedReaderAuthorDetails(details);
    verified1.readerAuthors.authors[0].affiliations[0] = 'Corrupted Institute';
    const verified2 = parser.verifiedReaderAuthorDetails(details);
    assert.deepEqual(verified2.readerAuthors.authors, [{ name: 'Bob White', affiliations: ['Institute Beta'] }]);

    const confText = 'Dai Gao1, Peng Zhang2\n'
        + '1 School of Computer Science, Soochow University, China\n'
        + '2 Qilu University of\n'
        + '    Technology, China\n\nAbstract\nConference body.';
    const confV1 = parser.parseConferencePdfAuthors(confText);
    confV1.authors[0].name = 'Tampered V1';
    confV1.authors[0].affiliations[0] = 'Tampered Aff V1';
    assert.equal(parser.parseConferencePdfAuthors(confText).authors[0].name, 'Dai Gao');
    assert.match(parser.parseConferencePdfAuthors(confText).authors[0].affiliations[0], /Soochow University/);

    const confV2 = parser.parseConferencePdfAuthorsV2(confText);
    confV2.authors[1].affiliations[0] = 'Tampered Aff V2';
    assert.equal(parser.parseConferencePdfAuthorsV2(confText).authors[1].affiliations[0], 'Qilu University of Technology, China');
});

test('HTML 单字节、sourceSha256、authors、apiReaderAuthors 或磁盘封存文件变化均立即失效', async t => {
    const fixture = buildHtmlFixture({ arxivId: '2611.30001', authorName: 'Alice Brown', institution: 'University Alpha' });
    parser.clearReaderAuthorVerificationCaches();
    assert.equal(parser.readerAuthorIdentityMatchesSource(fixture.paper, fixture.details), true);
    assert.equal(parser.readerAuthorIdentityMatchesSource(fixture.paper, fixture.details), true);

    // 1. HTML 单字节变化（未同步更新 artifacts SHA -> 拒绝重放并判定不匹配）
    const singleByteHtmlDetails = structuredClone(fixture.details);
    singleByteHtmlDetails.readerAuthors.sourceHtml = fixture.html.replace('University Alpha', 'University Alphb');
    assert.equal(parser.replayHtmlReaderAuthors(singleByteHtmlDetails), null);
    assert.equal(parser.readerAuthorIdentityMatchesSource(fixture.paper, singleByteHtmlDetails), false);

    // 2. 完整重绑定的新单字节 HTML（不同机构 -> 生成不同缓存键并判定旧 paper 不匹配）
    const updatedHtmlFixture = buildHtmlFixture({
        arxivId: '2611.30001',
        authorName: 'Alice Brown',
        institution: 'University Alphb',
        bodyText: 'Controlled audio representation learning experiments and observations.'
    });
    assert.equal(parser.readerAuthorIdentityMatchesSource(fixture.paper, updatedHtmlFixture.details), false);
    assert.equal(parser.readerAuthorIdentityMatchesSource(updatedHtmlFixture.paper, updatedHtmlFixture.details), true);

    // 3. sourceSha256 变化
    const changedSourceShaPaper = structuredClone(fixture.paper);
    changedSourceShaPaper.sourceSha256 = 'a'.repeat(64);
    changedSourceShaPaper.analysisManifest.sourceAcquisition.sourceSha256 = 'a'.repeat(64);
    assert.equal(parser.readerAuthorIdentityMatchesSource(changedSourceShaPaper, fixture.details), false);

    // 4. paper.authors 变化
    const changedAuthorsPaper = structuredClone(fixture.paper);
    changedAuthorsPaper.authors = ['Alice Browne'];
    assert.equal(parser.readerAuthorIdentityMatchesSource(changedAuthorsPaper, fixture.details), false);

    // 5. paper.apiReaderAuthors 变化（包括重算自身签名但机构不符）
    const changedSavedAuthorsPaper = structuredClone(fixture.paper);
    changedSavedAuthorsPaper.apiReaderAuthors.authors[0].affiliations = ['University Gamma'];
    changedSavedAuthorsPaper.apiReaderAuthors.identity.authors[0].affiliations = ['University Gamma'];
    changedSavedAuthorsPaper.apiReaderAuthors.identity.authors[0].affiliationBindings[0].sourceValue = 'University Gamma';
    changedSavedAuthorsPaper.apiReaderAuthors.identitySha256 = stableHash(changedSavedAuthorsPaper.apiReaderAuthors.identity);
    changedSavedAuthorsPaper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = changedSavedAuthorsPaper.apiReaderAuthors.identitySha256;
    changedSavedAuthorsPaper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = stableHash(changedSavedAuthorsPaper.apiReaderAuthors);
    assert.equal(parser.readerAuthorIdentityMatchesSource(changedSavedAuthorsPaper, fixture.details), false);

    // 6. 物理磁盘封存四文件被篡改：即使先前已命中缓存，后续调用仍重读磁盘并立即拒绝！
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'author-cache-sealed-'));
    const previousRunsDir = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(folder, 'daily-runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previousRunsDir;
        fs.rmSync(folder, { recursive: true, force: true });
    });

    const id = '2611.30002';
    const sealedHtml = '<html><head><meta name="citation_author" content="Carol Green">'
        + '<meta name="citation_author_institution" content="Institute Delta"></head>'
        + '<body><section>' + 'Sealed verification source paragraph. '.repeat(180) + '</section></body></html>';
    const sealedText = cheerio.load(sealedHtml).text();
    const sealedArtifacts = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(sealedHtml, `${id}v1`, id),
        sealedText
    );
    // 模拟含内联 SVG 导致不保留 sourceHtml、仅依靠四文件封存证明核验作者的真实日更场景
    const sealedReaderAuthors = parser.parseArxivReaderAuthors(cheerio.load(sealedHtml));
    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-11-19',
        batchId: 'author-cache-sealed-test',
        papers: [{ arxivId: id }]
    });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => capturer.captureFreshArxivRewriteSource(options, {
            fetchText: async () => ({
                title: 'Official sealed title',
                source: 'html',
                text: sealedText,
                sourceId: `${id}v1`,
                url: `https://arxiv.org/html/${id}v1`,
                structuredArtifacts: sealedArtifacts,
                readerAuthors: sealedReaderAuthors
            }),
            fetchPdf: async () => ({
                bytes: Buffer.from('%PDF-1.7\nSealedFixture\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${id}`,
                sourceId: id
            }),
            extractPdfText: async () => ({ text: 'Fallback PDF text. '.repeat(180) })
        })
    });

    const sealedSource = daily.readDailyFreshSource(plan, { arxivId: id });
    assert.equal(sealedSource.readerAuthors.sourceHtml, undefined);
    const sealedPaper = {
        arxivId: `${id}v1`,
        authors: ['Carol Green'],
        sourceSha256: sealedSource.freshSourceDescriptor.sourceSha256,
        analysisManifest: {
            contracts: { apiReaderArticle: 'beginner-researcher-v3' },
            sourceAcquisition: { sourceSha256: sealedSource.freshSourceDescriptor.sourceSha256 },
            stages: {
                apiReaderArticle: {
                    status: 'complete',
                    structuredArtifactsSha256: sealedSource.structuredArtifacts.payloadSha256
                }
            }
        }
    };
    await daily.withDailyFreshAnalysisContext(plan, () => {
        fresh.attachFreshSourceRecord(sealedPaper, sealedPaper.analysisManifest, sealedSource);
        sealedPaper.apiReaderAuthors = parser.resolveVerifiedReaderAuthors(sealedPaper, sealedSource);
    });
    sealedPaper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = sealedPaper.apiReaderAuthors.identitySha256;
    sealedPaper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = stableHash(sealedPaper.apiReaderAuthors);

    parser.clearReaderAuthorVerificationCaches();
    assert.equal(parser.readerAuthorIdentityMatchesSource(sealedPaper, sealedSource), true);
    assert.equal(parser.readerAuthorIdentityMatchesSource(sealedPaper, sealedSource), true);
    assert.equal(parser.getReaderAuthorVerificationCacheStats().verifiedMatchHits, 1);

    // 篡改磁盘上的 source-runtime.json 后，即使传入同一 sealedSource 引用且之前缓存命中，也必须立即抛错／返回 false！
    const runtimePath = path.join(plan.sourcesDir, id, 'generation-000001', 'source-runtime.json');
    fs.appendFileSync(runtimePath, ' ');
    assert.throws(() => parser.readerAuthorIdentityMatchesSource(sealedPaper, sealedSource));
    assert.equal(authorSource.canReuseReaderAuthorInputs(sealedPaper, sealedSource), false);
    assert.throws(() => daily.isPaperReusableForAnalysis(sealedPaper, plan), /封存来源读不出来/);
});

test('缓存容量严格受限于上限并在超限时按 LRU 淘汰最久未使用条目', () => {
    parser.clearReaderAuthorVerificationCaches();
    const maxEntries = parser.AUTHOR_VERIFICATION_CACHE_MAX_ENTRIES;
    assert.equal(maxEntries, 256);

    const makeMinimalHtml = index => (
        `<html><head><meta name="citation_author" content="Author ${index}">`
        + `<meta name="citation_author_institution" content="University ${index}"></head>`
        + `<body><div class="ltx_authors"><div class="ltx_creator ltx_role_author">`
        + `<span class="ltx_personname">Author ${index}</span></div></div>`
        + `<section><p>Observation ${index}</p></section></body></html>`
    );

    const htmlZero = makeMinimalHtml(0);
    const htmlOne = makeMinimalHtml(1);
    for (let i = 0; i < maxEntries; i++) {
        assert.equal(parser.canRetainAuthorSourceHtml(i === 0 ? htmlZero : i === 1 ? htmlOne : makeMinimalHtml(i)), true);
    }
    let stats = parser.getReaderAuthorVerificationCacheStats();
    assert.equal(stats.htmlEntries, maxEntries);
    assert.equal(stats.htmlMisses, maxEntries);
    assert.equal(stats.htmlHits, 0);

    // 访问第 0 条刷新其 LRU 位置，随后再写入 4 条新记录：第 0 条应保留，第 1..4 条应被淘汰
    assert.equal(parser.canRetainAuthorSourceHtml(htmlZero), true);
    assert.equal(parser.getReaderAuthorVerificationCacheStats().htmlHits, 1);

    for (let i = maxEntries; i < maxEntries + 4; i++) {
        assert.equal(parser.canRetainAuthorSourceHtml(makeMinimalHtml(i)), true);
        assert.equal(parser.getReaderAuthorVerificationCacheStats().htmlEntries, maxEntries);
    }

    const beforeCheckZero = parser.getReaderAuthorVerificationCacheStats();
    assert.equal(parser.canRetainAuthorSourceHtml(htmlZero), true);
    const afterCheckZero = parser.getReaderAuthorVerificationCacheStats();
    assert.equal(afterCheckZero.htmlHits, beforeCheckZero.htmlHits + 1, '最近访问过的条目不应被淘汰');

    assert.equal(parser.canRetainAuthorSourceHtml(htmlOne), true);
    const afterCheckOne = parser.getReaderAuthorVerificationCacheStats();
    assert.equal(afterCheckOne.htmlMisses, afterCheckZero.htmlMisses + 1, '最久未访问的条目应已按 LRU 淘汰并重新解析');
    assert.equal(afterCheckOne.htmlEntries, maxEntries);
});

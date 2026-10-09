'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const deep = require('../scripts/deep-analyzer.js');
const parser = require('../scripts/lib/reader-author-parser.js');

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const html = '<html><head><meta name="citation_author" content="Alice Brown">'
    + '<meta name="citation_author_institution" content="University A"></head>'
    + '<body><div class="ltx_authors"><div class="ltx_creator ltx_role_author">'
    + '<span class="ltx_personname">Alice Brown</span></div></div>'
    + '<section><p>The controlled source reports a stable observation.</p></section></body></html>';

function source(originalHtml = html) {
    const text = cheerio.load(originalHtml).text();
    const structuredArtifacts = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(originalHtml, '2610.12345v1', '2610.12345'), text
    );
    return {
        source: 'html', text, structuredArtifacts,
        readerAuthors: parser.retainAuthorSourceHtml(parser.parseArxivReaderAuthors(cheerio.load(originalHtml)), originalHtml)
    };
}

test('完整原始 HTML、结构化数据和全文 SHA 一致后，才重新解析作者机构', () => {
    const details = source();
    const replayed = parser.replayHtmlReaderAuthors(details);
    assert.deepEqual(replayed.authors, [{ name: 'Alice Brown', affiliations: ['University A'] }]);
    assert.equal(sha256(details.readerAuthors.sourceHtml), details.structuredArtifacts.sourceHtmlSha256);
    assert.equal(sha256(details.text), details.structuredArtifacts.flattenedTextSha256);
    assert.deepEqual(deep.resolveApiReaderAuthors({ authors: ['Charlie Green'] }, {
        ...details, readerAuthors: replayed
    }).authors, [{ name: 'Charlie Green', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'] }]);
});

test('旧数组内部一致也不能替代原始作者来源，错误 HTML、全文或结构化数据均拒绝', () => {
    for (const mutate of [
        details => { delete details.readerAuthors.sourceHtml; },
        details => { details.readerAuthors.sourceHtml = html.replace('University A', 'University B'); },
        details => { details.text += 'modified'; },
        details => { details.structuredArtifacts.sourceHtmlSha256 = 'f'.repeat(64); },
        details => { details.structuredArtifacts.payloadSha256 = 'f'.repeat(64); }
    ]) {
        const details = source();
        mutate(details);
        assert.equal(parser.replayHtmlReaderAuthors(details), null);
    }
});

test('原始 HTML 有大小限制且不保存内联图片，符合条件的 HTML 保留原始字节', () => {
    const original = source();
    assert.equal(original.readerAuthors.sourceHtml, html);
    for (const invalid of [
        'x'.repeat(parser.MAX_AUTHOR_SOURCE_HTML_BYTES + 1),
        '<div class="ltx_authors">Only an author fragment</div>',
        html.replace('</body>', '<img src="data:image/png;base64,not-a-real-image"></body>'),
        html.replace('</body>', '<img src="d&#97;ta:image/png;base64,not-a-real-image"></body>'),
        html.replace('</body>', '<iframe srcdoc="&lt;svg&gt;&lt;path d=&quot;M0 0&quot;/&gt;&lt;/svg&gt;"></body>'),
        html.replace('</body>', '<svg><path d="M0 0"/></svg></body>')
    ]) {
        assert.equal(parser.canRetainAuthorSourceHtml(invalid), false);
        assert.equal(parser.retainAuthorSourceHtml({ authors: [] }, invalid).sourceHtml, undefined);
    }
});

test('实际作者刷新按原HTML重建，无原HTML保留元数据姓名并明确机构不可得', () => {
    for (const originalAvailable of [true, false]) {
        const details = source();
        if (!originalAvailable) delete details.readerAuthors.sourceHtml;
        const paper = {
            authors: ['Alice Brown'], sourceSha256: sha256(details.text),
            apiReaderAuthors: { authors: [{ name: 'Alice Brown', affiliations: ['Wrong University'] }] },
            analysisManifest: {
                contracts: { apiReaderArticle: 'beginner-researcher-v3' },
                sourceAcquisition: {
                    sourceSha256: sha256(details.text),
                    structuredArtifactsSha256: details.structuredArtifacts.payloadSha256
                },
                stages: { apiReaderArticle: {
                    status: 'complete', structuredArtifactsSha256: details.structuredArtifacts.payloadSha256
                } }
            }
        };
        deep.refreshApiReaderAuthorsFromSource(paper, details);
        assert.deepEqual(paper.apiReaderAuthors.authors, [{
            name: 'Alice Brown',
            affiliations: [originalAvailable ? 'University A' : '机构信息未在 arXiv HTML 中可靠披露']
        }]);
        assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details), true);
        assert.equal(paper.analysisManifest.sourceAcquisition.sourceSha256, sha256(details.text));
    }
});

test('分析引擎提前跳过或持锁后跳过，都须重新核验原始 HTML；旧记录中的错误机构不能复用', async () => {
    const engine = require('../scripts/analysis-engine.js');
    const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
    for (const locked of [false, true]) {
        for (const kind of ['correct', 'wrong', 'missing']) {
            const details = source();
            details.sourceId = '2610.12345v1';
            if (kind === 'missing') delete details.readerAuthors.sourceHtml;
            const paper = {
                arxivId: '2610.12345', authors: ['Alice Brown'], sourceSha256: sha256(details.text),
                analysisManifest: {
                    contracts: { apiReaderArticle: 'beginner-researcher-v3' },
                    sourceAcquisition: {
                        sourceSha256: sha256(details.text),
                        modelTextSanitizationContract: 'model-text-unicode-scalars-v1'
                    },
                    stages: {
                        primaryAnalysis: { status: 'complete' },
                        apiReaderArticle: { status: 'complete', structuredArtifactsSha256: details.structuredArtifacts.payloadSha256 }
                    }
                }
            };
            paper.apiReaderAuthors = parser.resolveApiReaderAuthors(paper, source());
            const hash = require('../scripts/lib/fresh-rewrite-run.js').stableHash;
            paper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = paper.apiReaderAuthors.identitySha256;
            paper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = hash(paper.apiReaderAuthors);
            if (kind === 'wrong') paper.apiReaderAuthors.authors[0].affiliations = ['Wrong University'];
            assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details), kind === 'correct', 'direct author check ' + kind);
            let calls = 0;
            const result = await direct.withDirectRewriteAnalysisSource({
                paperId: 'arxiv:2610.12345', route: 'arxiv-fresh-fetch', sourceDetails: details,
                runId: '00000000-0000-4000-8000-000000000001', sourceGeneration: 1,
                sourceSha256: sha256(details.text), structuredArtifactsSha256: details.structuredArtifacts.payloadSha256,
                sourceSnapshotSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64),
                readerAttemptsDir: '/tmp/author-source-proof-attempts'
            }, () => engine.analyzeBatch([paper], {
                maxRetries: 0,
                shouldSkip: locked ? null : () => true,
                preparePaperLocked: locked ? value => ({ paper: value, skip: true }) : null,
                analyzeFn: async () => {
                    calls++;
                    const error = new Error('测试替身在模型请求前停止');
                    error.retryable = false;
                    throw error;
                }
            }));
            assert.equal(result.stats.skipped, kind === 'correct' ? 1 : 0, `${locked}/${kind}`);
            assert.equal(calls, kind === 'correct' ? 0 : 1, `${locked}/${kind}`);
        }
    }
});

test('来源运行记录保留合格的完整 HTML，拒绝超限内容或实体编码图片；读者文章的模型输入不含原始 HTML', () => {
    const fresh = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
    const details = source();
    const text = { source: 'html', sourceId: '2610.12345v1', bytes: Buffer.from(details.text), responseSha256: sha256(details.text) };
    const runtime = fresh.runtimeDetailsFromFreshCapture(details, text, '2610.12345');
    const stored = fresh.runtimeMetadataFromDetails(runtime, text, '2610.12345');
    assert.equal(stored.readerAuthors.sourceHtml, html);
    const modelEvidence = deep.buildApiReaderEvidenceContext('', details.text, details.structuredArtifacts, '2610.12345');
    assert.equal(modelEvidence.includes('<html>'), false);
    assert.equal(modelEvidence.includes('citation_author_institution'), false);
    for (const invalid of [
        'x'.repeat(parser.MAX_AUTHOR_SOURCE_HTML_BYTES + 1),
        html.replace('</body>', '<img src="d&#97;ta:image/png;base64,pixels"></body>')
    ]) {
        const changed = structuredClone(runtime);
        changed.readerAuthors.sourceHtml = invalid;
        assert.equal(fresh.runtimeMetadataFromDetails(changed, text, '2610.12345').readerAuthors.sourceHtml, undefined);
    }
});

test('会议 PDF 无法还原作者上标对应关系时，使用论文信息中的姓名并明确机构不可得，允许继续处理', () => {
    const text = 'Original conference PDF text';
    const details = { source: 'conference_pdf_text', text, structuredArtifacts: { payloadSha256: 'a'.repeat(64) } };
    const paper = { authors: ['Alice Brown'], sourceSha256: sha256(text), analysisManifest: {
        sourceAcquisition: { sourceSha256: sha256(text), structuredArtifactsSha256: 'a'.repeat(64) },
        contracts: { apiReaderArticle: 'beginner-researcher-v3' },
        stages: { apiReaderArticle: { status: 'complete', structuredArtifactsSha256: 'a'.repeat(64) } }
    } };
    deep.refreshApiReaderAuthorsFromSource(paper, details);
    assert.deepEqual(paper.apiReaderAuthors.authors, [{ name: 'Alice Brown', affiliations: ['机构信息未能从会议 PDF 纯文本可靠映射'] }]);
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details), true);
});

test('没有全文的旧会议记录必须对应已核验的完整作者姓名并明确机构不可得，重算自身 SHA 也不能伪造', () => {
    const details = source();
    delete details.readerAuthors.sourceHtml;
    const paper = { authors: ['Alice Brown'], sourceSha256: sha256(details.text), analysisManifest: {
        sourceAcquisition: { sourceSha256: sha256(details.text) },
        stages: { apiReaderArticle: { structuredArtifactsSha256: details.structuredArtifacts.payloadSha256 } }
    } };
    const sign = value => {
        const hash = require('../scripts/lib/fresh-rewrite-run.js').stableHash;
        value.apiReaderAuthors.identitySha256 = hash(value.apiReaderAuthors.identity);
        value.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = value.apiReaderAuthors.identitySha256;
        value.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = hash(value.apiReaderAuthors);
    };
    paper.apiReaderAuthors = parser.resolveVerifiedReaderAuthors(paper, details);
    sign(paper);
    const authority = { sourceSha256: paper.sourceSha256, metadataAuthors: ['Alice Brown'] };
    assert.equal(parser.readerAuthorUnavailableIdentityMatches(paper, authority), true);
    for (const mutate of [
        value => { value.authors = ['Charlie Green']; },
        value => { value.apiReaderAuthors.authors.push(value.apiReaderAuthors.authors[0]); },
        value => { value.apiReaderAuthors.identity.authors[0].nameBinding.sourceKind = 'html_dom'; },
        value => {
            value.apiReaderAuthors.authors[0].affiliations = ['University A'];
            value.apiReaderAuthors.identity.authors[0].affiliations = ['University A'];
            value.apiReaderAuthors.identity.authors[0].affiliationBindings[0].sourceValue = 'University A';
        },
        value => {
            const label = '机构信息未披露，属于 University A';
            value.apiReaderAuthors.authors[0].affiliations = [label];
            value.apiReaderAuthors.identity.authors[0].affiliations = [label];
            value.apiReaderAuthors.identity.authors[0].affiliationBindings[0].sourceValue = label;
        }
    ]) {
        const changed = structuredClone(paper); mutate(changed); sign(changed);
        assert.equal(parser.readerAuthorUnavailableIdentityMatches(changed, authority), false);
    }
    assert.equal(parser.readerAuthorUnavailableIdentityMatches(paper, { ...authority, metadataAuthors: [] }), false);
    assert.equal(parser.readerAuthorUnavailableIdentityMatches(paper, { ...authority, sourceSha256: 'f'.repeat(64) }), false);
});

test('复用检查拒绝旧机构不可得记录中的错误 SHA 和不对应的身份字段', () => {
    const { canReuseReaderAuthorInputs } = require('../scripts/lib/reader-author-source.js');
    const details = source(); delete details.readerAuthors.sourceHtml;
    const paper = { authors: ['Alice Brown'], sourceSha256: sha256(details.text), analysisManifest: {
        contracts: { apiReaderArticle: 'beginner-researcher-v3' },
        sourceAcquisition: { sourceSha256: sha256(details.text) },
        stages: { apiReaderArticle: { structuredArtifactsSha256: details.structuredArtifacts.payloadSha256 } }
    } };
    paper.apiReaderAuthors = parser.resolveVerifiedReaderAuthors(paper, details);
    const hash = require('../scripts/lib/fresh-rewrite-run.js').stableHash;
    const sign = value => {
        value.apiReaderAuthors.identitySha256 = hash(value.apiReaderAuthors.identity);
        value.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = value.apiReaderAuthors.identitySha256;
        value.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = hash(value.apiReaderAuthors);
    };
    sign(paper);
    assert.equal(canReuseReaderAuthorInputs(paper, details), true);
    for (const key of ['readerAuthorIdentitySha256', 'readerAuthorsSha256']) {
        const changed = structuredClone(paper);
        changed.analysisManifest.stages.apiReaderArticle[key] = 'f'.repeat(64);
        assert.equal(canReuseReaderAuthorInputs(changed, details), false);
    }
    const unavailable = '机构信息未可靠披露';
    paper.apiReaderAuthors.authors[0].affiliations = [unavailable];
    paper.apiReaderAuthors.identity.authors[0].affiliations = [unavailable];
    paper.apiReaderAuthors.identity.authors[0].affiliationBindings[0].sourceValue = unavailable;
    sign(paper);
    assert.equal(canReuseReaderAuthorInputs(paper, details), true);
    for (const mutate of [
        value => { value.apiReaderAuthors.identitySha256 = 'f'.repeat(64); },
        value => { value.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = 'f'.repeat(64); },
        value => { value.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = 'f'.repeat(64); },
        value => { value.apiReaderAuthors.identity.authors[0].name = 'Charlie Green'; sign(value); },
        value => { value.apiReaderAuthors.identity.authors[0].affiliations = ['University A']; sign(value); }
    ]) {
        const changed = structuredClone(paper); mutate(changed);
        assert.equal(canReuseReaderAuthorInputs(changed, details), false);
    }
});

test('复用检查保留受支持的 TeX 重音姓名展示和旧机构不可得提示语', () => {
    const { canReuseReaderAuthorInputs } = require('../scripts/lib/reader-author-source.js');
    const details = source(); delete details.readerAuthors.sourceHtml;
    const paper = { authors: ['Ga{ë}l'], sourceSha256: sha256(details.text), analysisManifest: {
        contracts: { apiReaderArticle: 'beginner-researcher-v3' },
        sourceAcquisition: { sourceSha256: sha256(details.text) },
        stages: { apiReaderArticle: { structuredArtifactsSha256: details.structuredArtifacts.payloadSha256 } }
    } };
    paper.apiReaderAuthors = parser.resolveVerifiedReaderAuthors(paper, details);
    const hash = require('../scripts/lib/fresh-rewrite-run.js').stableHash;
    const label = '机构信息未可靠披露';
    paper.apiReaderAuthors.authors[0].affiliations = [label];
    paper.apiReaderAuthors.identity.authors[0].affiliations = [label];
    paper.apiReaderAuthors.identity.authors[0].affiliationBindings[0].sourceValue = label;
    paper.apiReaderAuthors.identitySha256 = hash(paper.apiReaderAuthors.identity);
    paper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = paper.apiReaderAuthors.identitySha256;
    paper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = hash(paper.apiReaderAuthors);
    assert.equal(paper.apiReaderAuthors.authors[0].name, 'Gaël');
    assert.equal(canReuseReaderAuthorInputs(paper, details), true);
    assert.equal(parser.readerAuthorUnavailableIdentityMatches(paper, { sourceSha256: paper.sourceSha256, metadataAuthors: paper.authors }), true);
    assert.equal(parser.readerAuthorUnavailableIdentityMatches(paper, { sourceSha256: paper.sourceSha256, metadataAuthors: ['Gaël'] }), false);
});

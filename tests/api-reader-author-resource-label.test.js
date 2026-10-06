'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const { parseArxivReaderAuthors, resolveApiReaderAuthors, refreshApiReaderAuthorsFromSource }
    = require('../scripts/deep-analyzer.js');

// 从 arXiv 2609.03423 原样读出的作者 DOM，其 SHA 与不可变的
// 当日来源快照一致；里面没有引文机构信息，也没有致谢。
const authorDom = `<div class="ltx_authors">
<span class="ltx_creator ltx_role_author">
<span class="ltx_personname">Puneet Mathur
</span><span class="ltx_author_notes"><span class="ltx_author_notes_content">
<span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation:&nbsp;</span>University of Maryland College Park, USA
</span></span></span></span>
<span class="ltx_author_before">  </span><span class="ltx_creator ltx_role_author">
<span class="ltx_personname">Dinesh Manocha
</span><span class="ltx_author_notes"><span class="ltx_author_notes_content">
<span class="ltx_contact ltx_role_affiliation"><span class="ltx_contact_name">Affiliation:&nbsp;</span>Project Page: <a href="https://dsb-ifeval.github.io" title="" class="ltx_ref ltx_url ltx_font_typewriter">dsb-ifeval.github.io</a>
</span></span></span></span></div>`;
const domSha = '0413b82cf6348bb40ca2d887c825e937ef49774bd536b164d804cb391a3a40a2';
const unavailable = '机构信息未在 arXiv HTML 中可靠披露';
const expected = [
    { name: 'Puneet Mathur', affiliations: ['University of Maryland College Park, USA'] },
    { name: 'Dinesh Manocha', affiliations: [unavailable] }
];
const oldParsed = { sourceDomSha256: domSha, authors: [expected[0],
    { name: 'Dinesh Manocha', affiliations: ['Project Page:'] }] };

describe('Reader 资源标签不是作者机构', () => {
    it('照原样复核 03423 的 DOM，绝不借用别的作者机构', () => {
        const parsed = parseArxivReaderAuthors(cheerio.load(authorDom));
        assert.equal(parsed.sourceDomSha256, domSha);
        assert.deepEqual(parsed.authors, expected);
    });
    it('只在派生身份里修正旧来源元数据，保留来源字节', () => {
        const source = { text: 'Immutable full source', readerAuthors: structuredClone(oldParsed) };
        const before = JSON.stringify(source);
        const result = resolveApiReaderAuthors({ authors: expected.map(a => a.name) }, source);
        assert.deepEqual(result.authors, expected);
        assert.equal(result.identity.authors[1].affiliationBindings[0].sourceKind, 'explicit_unavailable');
        assert.equal(result.identity.authors[1].nameBinding.sourceKind, 'html_dom');
        assert.equal(JSON.stringify(source), before);
    });
    it('论文元数据里没有作者姓名时，不跳过标签校验', () => {
        const result = resolveApiReaderAuthors({}, { text: 'source', readerAuthors: oldParsed });
        assert.deepEqual(result.authors, expected);
    });
    it('只认明确的资源标签，保留真实的机构名称', () => {
        for (const label of ['Project Page:', 'Project website:', 'Code:', 'Demo page:', 'Dataset link:']) {
            const html = authorDom.replace('Project Page:', label);
            assert.deepEqual(parseArxivReaderAuthors(cheerio.load(html)).authors, expected);
        }
        const html = authorDom.replace('Project Page:', 'Project Research Institute')
            .replace(/<a href="https:\/\/dsb-ifeval.github.io"[^>]*>.*?<\/a>/, '');
        assert.equal(parseArxivReaderAuthors(cheerio.load(html)).authors[1].affiliations[0], 'Project Research Institute');
    });
    it('只刷新作者时，绑定证明会变，Reader、计划、评分和来源不变', () => {
        const source = { text: 'Immutable full source', readerAuthors: structuredClone(oldParsed) };
        const sourceSha256 = crypto.createHash('sha256').update(source.text).digest('hex');
        const paper = { authors: expected.map(a => a.name), sourceSha256,
            apiReaderArticle: 'signed Reader bytes', apiReaderPlan: { signed: true }, score: 8,
            analysisManifest: { contracts: { apiReaderArticle: 'beginner-researcher-v3' },
                sourceAcquisition: { sourceSha256 }, stages: { apiReaderArticle: { status: 'complete' } } } };
        refreshApiReaderAuthorsFromSource(paper, source);
        assert.deepEqual(paper.apiReaderAuthors.authors, expected);
        assert.equal(paper.apiReaderArticle, 'signed Reader bytes');
        assert.deepEqual(paper.apiReaderPlan, { signed: true });
        assert.equal(paper.score, 8);
        assert.equal(paper.sourceSha256, sourceSha256);
        assert.equal(paper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256,
            paper.apiReaderAuthors.identitySha256);
    });
});

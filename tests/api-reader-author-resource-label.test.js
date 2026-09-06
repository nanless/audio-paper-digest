'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const { parseArxivReaderAuthors, resolveApiReaderAuthors, refreshApiReaderAuthorsFromSource }
    = require('../scripts/deep-analyzer.js');

// Exact author DOM read from arXiv 2609.03423. Its SHA matches the immutable
// fresh source snapshot; there are no citation affiliation metadata or thanks.
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

describe('Reader resource labels are not author affiliations', () => {
    it('replays the exact 03423 DOM and never borrows another author institution', () => {
        const parsed = parseArxivReaderAuthors(cheerio.load(authorDom));
        assert.equal(parsed.sourceDomSha256, domSha);
        assert.deepEqual(parsed.authors, expected);
    });
    it('repairs old source metadata only in derived identity, retaining source bytes', () => {
        const source = { text: 'Immutable full source', readerAuthors: structuredClone(oldParsed) };
        const before = JSON.stringify(source);
        const result = resolveApiReaderAuthors({ authors: expected.map(a => a.name) }, source);
        assert.deepEqual(result.authors, expected);
        assert.equal(result.identity.authors[1].affiliationBindings[0].sourceKind, 'explicit_unavailable');
        assert.equal(result.identity.authors[1].nameBinding.sourceKind, 'html_dom');
        assert.equal(JSON.stringify(source), before);
    });
    it('does not bypass label validation when paper metadata author names are absent', () => {
        const result = resolveApiReaderAuthors({}, { text: 'source', readerAuthors: oldParsed });
        assert.deepEqual(result.authors, expected);
    });
    it('recognizes only explicit resource labels and preserves real institution words', () => {
        for (const label of ['Project Page:', 'Project website:', 'Code:', 'Demo page:', 'Dataset link:']) {
            const html = authorDom.replace('Project Page:', label);
            assert.deepEqual(parseArxivReaderAuthors(cheerio.load(html)).authors, expected);
        }
        const html = authorDom.replace('Project Page:', 'Project Research Institute')
            .replace(/<a href="https:\/\/dsb-ifeval.github.io"[^>]*>.*?<\/a>/, '');
        assert.equal(parseArxivReaderAuthors(cheerio.load(html)).authors[1].affiliations[0], 'Project Research Institute');
    });
    it('authors-only refresh changes binding proof but not Reader, plan, score or source', () => {
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

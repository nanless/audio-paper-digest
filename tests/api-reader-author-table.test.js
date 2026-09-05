'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cheerio = require('cheerio');
const { parseArxivReaderAuthors, resolveApiReaderAuthors } = require('../scripts/deep-analyzer.js');

// Structural excerpt of arXiv 2609.03622 HTML: no .ltx_authors or citation
// metadata; author superscripts and affiliation superscripts are explicit.
const authorTable = `<table id="p2.1" class="ltx_tabular ltx_guessed_headers">
<thead><tr><th><span class="ltx_text ltx_font_italic">Sofiene Kammoun<sup><span>1</span></sup>   Simon Leglaive<sup><span>1</span></sup>   Xavier Alameda-Pineda<sup><span>2</span></sup>   Timo Gerkmann<sup>3</sup></span></th></tr></thead>
<tbody>
<tr><td><sup><span>1</span></sup><span>CentraleSupélec, IETR (UMR CNRS 6164), France</span></td></tr>
<tr><td><sup><span>2</span></sup><span>Inria at Univ. Grenoble Alpes, CNRS, LJK, France</span></td></tr>
<tr><td><sup><span>3</span></sup><span>Signal Processing Group, University of Hamburg, Germany</span></td></tr>
</tbody></table>`;
const expected = [
    { name: 'Sofiene Kammoun', affiliations: ['CentraleSupélec, IETR (UMR CNRS 6164), France'] },
    { name: 'Simon Leglaive', affiliations: ['CentraleSupélec, IETR (UMR CNRS 6164), France'] },
    { name: 'Xavier Alameda-Pineda', affiliations: ['Inria at Univ. Grenoble Alpes, CNRS, LJK, France'] },
    { name: 'Timo Gerkmann', affiliations: ['Signal Processing Group, University of Hamburg, Germany'] }
];

describe('API Reader explicit author-table identity', () => {
    it('maps each author superscript to its unique institution row and binds the whole DOM', () => {
        const $ = cheerio.load(authorTable + '<section class="ltx_section">Introduction</section>');
        const parsed = parseArxivReaderAuthors($);
        assert.deepEqual(parsed.authors, expected);
        assert.equal(parsed.sourceDomSha256, crypto.createHash('sha256').update($.html($('table').first())).digest('hex'));
        const bound = resolveApiReaderAuthors({ authors: expected.map(author => author.name) }, {
            text: 'Original full text stays unchanged.', readerAuthors: parsed
        });
        assert.deepEqual(bound.authors, expected);
        for (const author of bound.identity.authors) {
            assert.equal(author.nameBinding.sourceKind, 'html_dom');
            assert.equal(author.affiliationBindings[0].sourceKind, 'html_dom');
            assert.equal(author.affiliationBindings[0].association, 'direct_author');
            assert.equal(author.affiliationBindings[0].sourceDomSha256, parsed.sourceDomSha256);
        }
    });

    it('follows labels rather than institution-row order and supports explicit multiple affiliations', () => {
        const table = `<table><tr><th>Ada Example<sup>2,1</sup> Ben Example<sup>1</sup></th></tr>
        <tr><td><sup>2</sup>Institute Two</td></tr><tr><td><sup>1</sup>Institute One</td></tr></table>`;
        assert.deepEqual(parseArxivReaderAuthors(cheerio.load(table)).authors, [
            { name: 'Ada Example', affiliations: ['Institute Two', 'Institute One'] },
            { name: 'Ben Example', affiliations: ['Institute One'] }
        ]);
    });

    it('refuses missing, duplicated, nonnumeric and ambiguous mappings instead of guessing', () => {
        const variants = [
            authorTable.replace('Timo Gerkmann<sup>3</sup>', 'Timo Gerkmann<sup>4</sup>'),
            authorTable.replace('<sup><span>3</span></sup>', '<sup><span>2</span></sup>'),
            authorTable.replace('Timo Gerkmann<sup>3</sup>', 'Timo Gerkmann<sup>*</sup>'),
            authorTable + authorTable,
            '<section class="ltx_section">' + authorTable + '</section>',
            '<section>Introduction</section>' + authorTable,
            authorTable.replace('Timo Gerkmann<sup>3</sup>', 'Timo Gerkmann')
        ];
        for (const html of variants) assert.deepEqual(parseArxivReaderAuthors(cheerio.load(html)).authors, []);
    });

    it('preserves existing author metadata precedence and changes proof when an institution changes', () => {
        const withMetadata = '<meta name="citation_author" content="Metadata Author">' + authorTable;
        assert.deepEqual(parseArxivReaderAuthors(cheerio.load(withMetadata)).authors, [
            { name: 'Metadata Author', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'] }
        ]);
        const before = parseArxivReaderAuthors(cheerio.load(authorTable));
        const after = parseArxivReaderAuthors(cheerio.load(authorTable.replace('University of Hamburg', 'University of Example')));
        assert.notEqual(before.sourceDomSha256, after.sourceDomSha256);
        assert.equal(after.authors[3].affiliations[0], 'Signal Processing Group, University of Example, Germany');
    });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const authors = require('../scripts/lib/reader-author-parser');

test('作者机构末尾的有效 ORCID 不作为机构展示，原封存记录保持原样', () => {
    const affiliation = 'Signal Processing Research Centre Tampere University Tampere, Finland';
    const details = {
        source: 'html', text: 'Sofoklis Kakouros\n' + affiliation + '\n0000-0001-8996-0793',
        readerAuthors: { sourceDomSha256: 'a'.repeat(64), authors: [{
            name: 'Sofoklis Kakouros', affiliations: [affiliation + ' 0000-0001-8996-0793']
        }] }
    };
    const original = structuredClone(details);
    const resolved = authors.resolveApiReaderAuthors({ authors: ['Sofoklis Kakouros'] }, details);
    assert.deepEqual(resolved.authors, [{ name: 'Sofoklis Kakouros', affiliations: [affiliation] }]);
    assert.equal(resolved.identity.authors[0].affiliationBindings[0].sourceValue, affiliation);
    assert.equal(resolved.identity.authors[0].affiliationBindings[0].sourceDomSha256, 'a'.repeat(64));
    assert.deepEqual(details, original);
    assert.throws(() => authors.bindApiReaderAuthorIdentity({ authors: ['Sofoklis Kakouros'] }, details, {
        authors: [{ name: 'Sofoklis Kakouros', affiliations: ['Invented University'] }]
    }), /缺少对应/);
});

test('纯文本 ORCID、标明 ORCID 的文本及新解析 DOM 使用同一清理规则', () => {
    for (const identifier of ['0000-0001-8996-0793', 'ORCID: 0000-0002-7858-5331', 'ORCID iD 0000-0002-0537-0946', '0000-0002-9079-593X']) {
        assert.equal(authors.sanitizeReaderAffiliationValue('Tampere University ' + identifier), 'Tampere University');
    }
    const html = '<div class="ltx_authors"><div class="ltx_creator ltx_role_author">'
        + '<span class="ltx_personname">Sofoklis Kakouros</span>'
        + '<span class="ltx_contact ltx_role_affiliation">Tampere University<br>0000-0001-8996-0793</span>'
        + '</div></div>';
    assert.deepEqual(authors.parseArxivReaderAuthors(cheerio.load(html)).authors,
        [{ name: 'Sofoklis Kakouros', affiliations: ['Tampere University'] }]);
});

test('校验位不对、不是末尾的编号和机构中的普通数字保持原样，不据编号补猜机构', () => {
    for (const text of ['Tampere University 0000-0001-8996-0794', 'Lab 0000-0001-8996-0793 Finland',
        '3D AI Lab 12345', 'University 2026', 'Lab 0000-0002-9079-593x']) {
        assert.equal(authors.sanitizeReaderAffiliationValue(text), text);
    }
    assert.equal(authors.sanitizeReaderAffiliationValue('0000-0001-8996-0793'), '');
    const details = { source: 'html', text: 'Alice Brown', readerAuthors: {
        sourceDomSha256: 'b'.repeat(64), authors: [{ name: 'Alice Brown', affiliations: ['0000-0001-8996-0793'] }]
    } };
    assert.deepEqual(authors.resolveApiReaderAuthors({ authors: ['Alice Brown'] }, details).authors,
        [{ name: 'Alice Brown', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'] }]);
});

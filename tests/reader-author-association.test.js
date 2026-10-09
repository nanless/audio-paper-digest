'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const {
    parseArxivReaderAuthors,
    resolveApiReaderAuthors,
    bindApiReaderAuthorIdentity
} = require('../scripts/deep-analyzer.js');

const unknown = '机构信息未在 arXiv HTML 中可靠披露';
function source(html) {
    const $ = cheerio.load(html);
    return {
        text: $.text(),
        source: 'html',
        readerAuthors: parseArxivReaderAuthors($)
    };
}
function author(name, institution = '') {
    return `<div class="ltx_creator ltx_role_author"><span class="ltx_personname">${name}</span>`
        + (institution ? `<span class="ltx_contact ltx_role_affiliation">${institution}</span>` : '')
        + '</div>';
}

test('不同姓名但作者数量相同，不把DOM作者机构按位置移给元数据作者', () => {
    const details = source('<div class="ltx_authors">'
        + author('Alice Brown', 'University A') + author('Bob White', 'University B') + '</div>');
    const result = resolveApiReaderAuthors({ authors: ['Charlie Green', 'Bob White'] }, details);
    assert.deepEqual(result.authors, [
        { name: 'Charlie Green', affiliations: [unknown] },
        { name: 'Bob White', affiliations: ['University B'] }
    ]);
    assert.equal(result.identity.authors[0].nameBinding.sourceKind, 'paper_metadata');
    assert.equal(result.identity.authors[0].affiliationBindings[0].sourceKind, 'explicit_unavailable');
    assert.equal(result.identity.authors[1].affiliationBindings[0].association, 'direct_author');
});

test('DOM作者与citation元数据顺序不同，机构仍按明确姓名对应', () => {
    const details = source('<head>'
        + '<meta name="citation_author" content="Alice Brown">'
        + '<meta name="citation_author_institution" content="University A">'
        + '<meta name="citation_author" content="Bob White">'
        + '<meta name="citation_author_institution" content="University B"></head>'
        + '<div class="ltx_authors">' + author('Bob White') + author('Alice Brown') + '</div>');
    assert.deepEqual(details.readerAuthors.authors, [
        { name: 'Bob White', affiliations: ['University B'] },
        { name: 'Alice Brown', affiliations: ['University A'] }
    ]);
    const result = resolveApiReaderAuthors({ authors: ['Alice Brown', 'Bob White'] }, details);
    assert.deepEqual(result.authors.map(item => item.affiliations), [['University A'], ['University B']]);
});

test('来源没有对应姓名时，唯一机构也不能证明另一作者所属；姓名后缀不作为同一人', () => {
    const details = source('<div class="ltx_authors">' + author('Alice Brown', 'University A') + '</div>');
    const result = resolveApiReaderAuthors({ authors: ['John Alice Brown'] }, details);
    assert.deepEqual(result.authors, [{ name: 'John Alice Brown', affiliations: [unknown] }]);
});

test('公开身份绑定拒绝把多机构伪称唯一全局机构，明确同名绑定保留', () => {
    const details = source('<div class="ltx_authors">'
        + author('Alice Brown', 'University A') + author('Bob White', 'University B') + '</div>');
    assert.throws(() => bindApiReaderAuthorIdentity({ authors: ['Charlie Green'] }, details, {
        authors: [{ name: 'Charlie Green', affiliations: ['University A'] }]
    }), /缺少对应的来源机构记录/);
    const sameName = resolveApiReaderAuthors({ authors: ['Alice Brown', 'Bob White'] }, details);
    assert.deepEqual(sameName.authors, details.readerAuthors.authors);
});


test('作者个人机构不能作为共同机构，真正作者块外共享机构可以对应全部已命名作者', () => {
    const individual = source('<div class="ltx_authors">'
        + author('Alice Brown', 'University A') + author('Bob White') + '</div>');
    const paper = { authors: ['Alice Brown', 'Bob White'] };
    assert.deepEqual(resolveApiReaderAuthors(paper, individual).authors, [
        { name: 'Alice Brown', affiliations: ['University A'] },
        { name: 'Bob White', affiliations: [unknown] }
    ]);
    assert.throws(() => bindApiReaderAuthorIdentity(paper, individual, {
        authors: [{ name: 'Bob White', affiliations: ['University A'] }]
    }), /缺少对应的来源机构记录/);
    const shared = source('<div class="ltx_authors">'
        + author('Alice Brown') + author('Bob White')
        + '<div class="ltx_role_affiliation">University A</div></div>');
    assert.deepEqual(resolveApiReaderAuthors(paper, shared).authors, [
        { name: 'Alice Brown', affiliations: ['University A'] },
        { name: 'Bob White', affiliations: ['University A'] }
    ]);
});


test('citation按明确作者分组保留多机构，等长数组和集中排列不能推对应关系', () => {
    const named = name => `<meta name="citation_author" content="${name}">`;
    const institution = name => `<meta name="citation_author_institution" content="${name}">`;
    const details = source(named('Alice Brown') + institution('University A')
        + institution('University B') + named('Bob White'));
    assert.deepEqual(resolveApiReaderAuthors({ authors: ['Alice Brown', 'Bob White'] }, details).authors, [
        { name: 'Alice Brown', affiliations: ['University A', 'University B'] },
        { name: 'Bob White', affiliations: [unknown] }
    ]);
    const grouped = source(named('Alice Brown') + named('Bob White')
        + institution('University A') + institution('University B'));
    assert.deepEqual(grouped.readerAuthors.authors, [
        { name: 'Alice Brown', affiliations: [unknown] },
        { name: 'Bob White', affiliations: [unknown] }
    ]);
});

test('真实解析与解析后消费者不把同名首项机构移给另一同名作者', () => {
    const details = source('<div class="ltx_authors">'
        + author('John Smith', 'Alpha University') + author('John Smith', 'Beta University') + '</div>');
    assert.deepEqual(details.readerAuthors.authors.map(value => value.affiliations), [['Alpha University'], ['Beta University']]);
    const paper = { authors: ['John Smith', 'John Smith'] };
    assert.deepEqual(resolveApiReaderAuthors(paper, details).authors.map(value => value.affiliations), [[unknown], [unknown]]);
    assert.throws(() => bindApiReaderAuthorIdentity(paper, details, {
        authors: [{name:'John Smith',affiliations:['Alpha University']}, {name:'John Smith',affiliations:['Beta University']}]
    }), /缺少对应的来源机构记录/);
    assert.deepEqual(resolveApiReaderAuthors({ authors: ['John Smith'] }, details).authors[0].affiliations, [unknown]);
    const one = source('<div class="ltx_authors">' + author('JOHN SMITH', 'Alpha University') + '</div>');
    assert.throws(() => bindApiReaderAuthorIdentity(paper, one, {
        authors: [{name:'John Smith',affiliations:['Alpha University']}]
    }), /缺少对应的来源机构记录/);
    assert.deepEqual(resolveApiReaderAuthors(paper, one).authors.map(value => value.affiliations), [[unknown], [unknown]]);
    assert.throws(() => bindApiReaderAuthorIdentity(paper, one, {
        authors: [{name:'John Smith',affiliations:['Alpha University']}, {name:'John Smith',affiliations:['Alpha University']}]
    }), /缺少对应的来源机构记录/);
});

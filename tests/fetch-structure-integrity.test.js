'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchCategoryPapers, parseArxivXML, parseRecentPageHTML } = require('../scripts/fetch-papers.js');

const entry = '<entry><id>https://arxiv.org/abs/2610.00001v2</id>'
    + '<title>Speech &amp; Audio\nModels</title><summary>Audio summary\nwith details.</summary>'
    + '<author><name>First Author</name></author><published>2026-10-01T00:00:00Z</published>'
    + '<category term="cs.SD"/></entry>';
const feed = value => `<feed xmlns="http://www.w3.org/2005/Atom">${value}</feed>`;

async function fetchWithAtom(xml, recent = null) {
    return fetchCategoryPapers('cs.SD', 1, 1, new Set(), {
        requestFn: async url => {
            if (url.includes('/list/') && recent !== null) return { status: 200, data: recent };
            if (url.includes('export.arxiv.org')) return { status: 200, data: xml };
            return { status: 503, data: 'unavailable' };
        },
        sleepFn: async () => {},
        maxRetries: 1,
        schedulerHandlesPacing: true
    });
}

test('实际类别抓取不把截断或结构损坏的 Atom 当成完整空结果', async () => {
    for (const xml of [
        '<feed><entry><id>https://arxiv.org/abs/2610.00001</id>',
        '<feed><entry></feed>',
        `<html>${entry}</html>`,
        feed(`<container>${entry}</container>`),
        feed(entry.replace('<entry>', '<entry xmlns="">')),
        feed(entry.replace('<entry>', '<entry xmlns="https://example.invalid/other">')),
        '<!DOCTYPE feed [<!ENTITY source "text">]><feed></feed>',
        feed(entry.replace('<summary>', '<summary duplicate="1" duplicate="2">'))
    ]) {
        await assert.rejects(fetchWithAtom(xml), /所有抓取请求均失败|抓取覆盖不完整/);
    }
});

test('实际类别抓取拒绝官方错误条目、不完整ID及缺少必需字段', async () => {
    for (const xml of [
        feed(entry.replace('https://arxiv.org/abs/2610.00001v2', 'http://arxiv.org/api/errors#incorrect_id_format')),
        feed(entry.replace('2610.00001v2', '2610.00001v2.evil')),
        feed(entry.replace('<title>Speech &amp; Audio\nModels</title>', '<title> </title>')),
        feed(entry.replace('<summary>Audio summary\nwith details.</summary>', '')),
        feed(entry.replace('<id>', '<id></id><id>'))
    ]) {
        await assert.rejects(fetchWithAtom(xml), /Atom XML 解析失败/);
    }
});

test('recent空标题不能证明覆盖完成；其他来源失败时整个类别失败', async () => {
    const recent = '<div id="dlpage"><dl><dt><a href="/abs/2610.00001">arXiv:2610.00001</a></dt>'
        + '<dd><div class="list-title"></div></dd></dl></div>';
    await assert.rejects(fetchWithAtom('<feed>', recent), /recent 页条目解析不完整/);
    const mixed = recent.replace('</dl>', '<dt><a href="/abs/2610.00002">arXiv:2610.00002</a></dt>'
        + '<dd><div class="list-title">Valid title</div></dd></dl>');
    await assert.rejects(fetchWithAtom('<feed>', mixed), /recent 页条目解析不完整/);
    const recovered = await fetchWithAtom(feed(entry), recent);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].arxivId, '2610.00001v2');
    assert.equal(recovered._sourceHealth.methods.recent.coverageComplete, false);
    assert.equal(recovered._sourceHealth.methods.api.coverageComplete, true);
});

test('完整命名空间Atom仍可返回正常论文，字符引用和换行按XML语义读取', async () => {
    const result = await fetchWithAtom(feed(entry));
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Speech & Audio Models');
    assert.equal(result[0].abstract, 'Audio summary with details.');
    assert.deepEqual(result[0].authors, ['First Author']);
    assert.deepEqual(result[0].categories, ['cs.SD']);
    assert.equal(result._sourceHealth.ok, true);
    const prefixed = '<a:feed xmlns:a="http://www.w3.org/2005/Atom">'
        + entry.replace(/<(\/)?(entry|id|title|summary|author|name|published|category)(?=[\s>/])/g, '<$1a:$2')
        + '</a:feed>';
    assert.equal(parseArxivXML(prefixed, 'cs.SD')[0].arxivId, '2610.00001v2');
    const legacy = feed(entry.replace('2610.00001v2', 'math.GT/0309136v1'));
    assert.equal(parseArxivXML(legacy, 'cs.SD')[0].arxivId, 'math.GT/0309136v1');
    const recentLegacy = '<dl><dt><a href="/abs/math.GT/0309136v1">arXiv:math.GT/0309136v1</a></dt>'
        + '<dd><div class="list-title">Legacy paper</div></dd></dl>';
    assert.equal(parseRecentPageHTML(recentLegacy, 'math.GT')[0].arxivId, 'math.GT/0309136');
    assert.throws(() => parseArxivXML(legacy.replace('math.GT', 'math.GT-extra'), 'cs.SD'), /完整的官方/);
});

test('合法空Atom仍是成功空结果，不与截断响应混淆', async () => {
    for (const xml of ['<feed></feed>', feed(''), '<a:feed xmlns:a="http://www.w3.org/2005/Atom"/>']) {
        const result = await fetchWithAtom(xml);
        assert.equal(result.length, 0);
        assert.equal(result._sourceHealth.ok, true);
        assert.equal(result._sourceHealth.coverageComplete, true);
    }
});

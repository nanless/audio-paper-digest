'use strict';

// 2026 年通用 AI/ML/CV/NLP 会议权威来源的纯适配器。它们只解析调用方传入的响应
// 体：不联网，也不写文件。

const path = require('node:path');
const cheerio = require('cheerio');

const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const PAPER_FIELDS = ['id', 'title', 'authors', 'abstract', 'pdfFile', 'recordUrl', 'pdfUrl', 'doi', 'track'];
const MAX_HTML_CHARS = 16 * 1024 * 1024;

function frozen(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) frozen(child);
        Object.freeze(value);
    }
    return value;
}

const REGISTRY = frozen({
    'aaai-2026': {
        conference: { id: 'aaai-2026', year: 2026 }, parser: 'aaai-ojs',
        collections: ['AAAI-volume-40'], host: 'ojs.aaai.org',
        recordPath: /^\/index\.php\/AAAI\/article\/view\/[1-9]\d*$/u,
        pdfPath: /^\/index\.php\/AAAI\/article\/download\/[1-9]\d*\/[1-9]\d*(?:\/[1-9]\d*)?$/u,
        trackByCollection: { 'AAAI-volume-40': 'Main' }
    },
    'aistats-2026': {
        conference: { id: 'aistats-2026', year: 2026 }, parser: 'pmlr',
        collections: ['v300'], host: 'proceedings.mlr.press',
        recordPath: /^\/v300\/[A-Za-z0-9_-]+\.html$/u,
        pdfAuthorities: [
            { host: 'proceedings.mlr.press', path: /^\/v300\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/u },
            { host: 'raw.githubusercontent.com', path: /^\/mlresearch\/v300\/main\/assets\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/u }
        ],
        trackByCollection: { v300: 'Main' }
    },
    'uai-2026': {
        conference: { id: 'uai-2026', year: 2026 }, parser: 'pmlr',
        collections: ['v337'], host: 'proceedings.mlr.press',
        recordPath: /^\/v337\/[A-Za-z0-9_-]+\.html$/u,
        pdfAuthorities: [
            { host: 'proceedings.mlr.press', path: /^\/v337\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/u },
            { host: 'raw.githubusercontent.com', path: /^\/mlresearch\/v337\/main\/assets\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/u }
        ],
        trackByCollection: { v337: 'Main' }
    },
    'cvpr-2026': {
        conference: { id: 'cvpr-2026', year: 2026 }, parser: 'cvf-openaccess',
        collections: ['CVPR2026-main'], host: 'openaccess.thecvf.com',
        recordPath: /^\/content\/CVPR2026\/html\/[A-Za-z0-9_-]+\.html$/u,
        pdfPath: /^\/content\/CVPR2026\/papers\/[A-Za-z0-9_-]+\.pdf$/u,
        trackByCollection: { 'CVPR2026-main': 'Main' }
    },
    'acl-2026': {
        conference: { id: 'acl-2026', year: 2026 }, parser: 'acl-anthology',
        collections: ['2026.acl-long', '2026.acl-short', '2026.findings-acl'], host: 'aclanthology.org',
        recordPath: /^\/2026\.(?:acl-(?:long|short)|findings-acl)\.[1-9]\d*\/$/u,
        pdfPath: /^\/2026\.(?:acl-(?:long|short)|findings-acl)\.[1-9]\d*\.pdf$/u,
        trackByCollection: { '2026.acl-long': 'Long Papers', '2026.acl-short': 'Short Papers',
            '2026.findings-acl': 'Findings' }
    },
    'eacl-2026': {
        conference: { id: 'eacl-2026', year: 2026 }, parser: 'acl-anthology',
        collections: ['2026.eacl-long', '2026.eacl-short', '2026.findings-eacl'], host: 'aclanthology.org',
        recordPath: /^\/2026\.(?:eacl-(?:long|short)|findings-eacl)\.[1-9]\d*\/$/u,
        pdfPath: /^\/2026\.(?:eacl-(?:long|short)|findings-eacl)\.[1-9]\d*\.pdf$/u,
        trackByCollection: { '2026.eacl-long': 'Long Papers', '2026.eacl-short': 'Short Papers',
            '2026.findings-eacl': 'Findings' }
    }
});

class OfficialConferenceProviderError extends Error {
    constructor(message) {
        super(`Official conference provider rejected: ${message}`);
        this.name = 'OfficialConferenceProviderError';
        this.code = 'OFFICIAL_CONFERENCE_PROVIDER_INTEGRITY';
    }
}

const fail = message => { throw new OfficialConferenceProviderError(message); };
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));

function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} 必须是纯对象`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}

function cleanText(value, label, { allowEmpty = false, max = 20000 } = {}) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        fail(`${label} 无效`);
    }
    const result = value.replace(/\s+/gu, ' ').trim();
    if (!allowEmpty && !result) fail(`${label} 为空`);
    return result;
}

function optionalText(value, label, max = 1000) {
    return value === null || value === undefined || value === '' ? null : cleanText(value, label, { max });
}

function providerFor(conferenceId) {
    const provider = REGISTRY[String(conferenceId || '')];
    if (!provider) fail(`conferenceId 必须是以下之一：${Object.keys(REGISTRY).join(', ')}`);
    return provider;
}

function canonicalUrl(value, label, provider, pathPattern, { query = false } = {}) {
    const source = cleanText(value, label, { max: 4096 });
    let parsed;
    try { parsed = new URL(source); } catch { fail(`${label} 不是 URL`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash
        || parsed.hostname !== provider.host || (!query && parsed.search) || !pathPattern.test(parsed.pathname)
        || parsed.toString() !== source) {
        fail(`${label} left the fixed official host/path`);
    }
    return source;
}

function canonicalPdfUrl(value, label, provider) {
    if (!provider.pdfAuthorities) return canonicalUrl(value, label, provider, provider.pdfPath);
    const source = cleanText(value, label, { max: 4096 });
    let parsed;
    try { parsed = new URL(source); } catch { fail(`${label} 不是 URL`); }
    const authority = provider.pdfAuthorities.find(item => item.host === parsed.hostname && item.path.test(parsed.pathname));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash
        || parsed.search || !authority || parsed.toString() !== source) {
        fail(`${label} 离开了固定的官方出版主机或路径`);
    }
    return source;
}

function metaValues($, name) {
    return $(`meta[name="${name}"], meta[property="${name}"]`).map((_index, element) => (
        String($(element).attr('content') || '').replace(/\s+/gu, ' ').trim()
    )).get().filter(Boolean);
}

function firstMeta($, names) {
    for (const name of names) {
        const value = metaValues($, name)[0];
        if (value) return value;
    }
    return '';
}

function uniqueAuthors($) {
    const values = metaValues($, 'citation_author');
    if (!values.length) fail('记录没有官方 citation_author 元数据');
    if (new Set(values).size !== values.length) fail('记录含重复的官方作者');
    return values.map((value, index) => cleanText(value, `authors[${index}]`, { max: 500 }));
}

function normalizeDoi(value) {
    if (!value) return null;
    let doi = String(value).trim();
    if (/^https:\/\/doi\.org\//iu.test(doi)) doi = decodeURIComponent(new URL(doi).pathname.slice(1));
    doi = cleanText(doi, 'doi', { max: 1000 });
    if (!/^10\.\d{4,9}\/\S+$/u.test(doi)) fail('DOI 元数据格式错误');
    return doi;
}

function paperRecord({ id, title, authors, abstract = '', pdfUrl = null, recordUrl, doi = null, track }) {
    const normalizedId = cleanText(id, 'paper id', { max: 200 });
    if (!ID_RE.test(normalizedId)) fail('论文 id 不是稳定的官方标识串');
    if (!Array.isArray(authors) || !authors.length) fail('论文作者必须非空');
    const normalizedAuthors = authors.map((author, index) => cleanText(author, `paper authors[${index}]`, { max: 500 }));
    if (new Set(normalizedAuthors).size !== normalizedAuthors.length) fail('论文作者含重复项');
    const record = {
        id: normalizedId,
        title: cleanText(title, 'paper title', { max: 4000 }),
        authors: normalizedAuthors,
        abstract: cleanText(abstract, 'paper abstract', { allowEmpty: true, max: 500000 }),
        pdfFile: pdfUrl === null ? null : `pdfs/${normalizedId}.pdf`,
        recordUrl,
        pdfUrl,
        doi: normalizeDoi(doi),
        track: optionalText(track, 'paper track', 500)
    };
    exact(record, PAPER_FIELDS, 'paper record');
    return record;
}

function finalize(records) {
    const byId = new Map();
    for (const record of records) {
        const previous = byId.get(record.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) {
            fail(`duplicate official paper ID has conflicting metadata: ${record.id}`);
        }
        if (!previous) byId.set(record.id, record);
    }
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function htmlPayload(provider, payload) {
    exact(payload, ['collection', 'records'], 'HTML provider payload');
    if (!provider.collections.includes(payload.collection)) fail('payload collection differs from the fixed 2026 registry');
    if (!Array.isArray(payload.records) || !payload.records.length) fail('HTML provider 记录必须非空');
    return payload.records.map((record, index) => {
        exact(record, ['recordUrl', 'html'], `HTML provider records[${index}]`);
        if (typeof record.html !== 'string' || !record.html || record.html.length > MAX_HTML_CHARS) {
            fail(`HTML provider records[${index}].html 无效`);
        }
        return { recordUrl: canonicalUrl(record.recordUrl, `records[${index}].recordUrl`, provider, provider.recordPath),
            html: record.html, collection: payload.collection };
    });
}

function abstractFrom($) {
    const meta = firstMeta($, ['citation_abstract', 'dc.description', 'description']);
    if (meta) return meta;
    const visible = $('#abstract, .abstract, .acl-abstract, #abstractExample').first().text().replace(/^\s*Abstract\s*/iu, '');
    return visible.replace(/\s+/gu, ' ').trim();
}

function htmlCommon(provider, input, id, pdfUrl, track) {
    const $ = cheerio.load(input.html);
    return paperRecord({
        id,
        title: firstMeta($, ['citation_title', 'dc.title']),
        authors: uniqueAuthors($),
        abstract: abstractFrom($),
        pdfUrl,
        recordUrl: input.recordUrl,
        doi: firstMeta($, ['citation_doi', 'dc.identifier']) || null,
        track
    });
}

function invocation(providerOrId, payload, parser, defaultId = null) {
    let provider;
    if (plain(providerOrId) && providerOrId.parser) provider = providerOrId;
    else if (payload !== undefined) provider = providerFor(providerOrId);
    else {
        if (!defaultId) fail(`${parser} 解析器需要显式的 conferenceId`);
        payload = providerOrId; provider = providerFor(defaultId);
    }
    if (provider.parser !== parser) fail(`会议 provider 未使用 ${parser}`);
    return { provider, payload };
}

function parseAaaiOjs(providerOrPayload, rawPayload) {
    const { provider, payload } = invocation(providerOrPayload, rawPayload, 'aaai-ojs', 'aaai-2026');
    return finalize(htmlPayload(provider, payload).map(input => {
        const $ = cheerio.load(input.html);
        if (firstMeta($, ['citation_volume']) !== '40') fail('AAAI 记录不在固定的 proceedings volume 40 内');
        const id = new URL(input.recordUrl).pathname.split('/').at(-1);
        const rawPdf = firstMeta($, ['citation_pdf_url']);
        const pdfUrl = rawPdf ? canonicalUrl(rawPdf, 'AAAI PDF URL', provider, provider.pdfPath) : null;
        return htmlCommon(provider, input, id, pdfUrl, provider.trackByCollection[input.collection]);
    }));
}

function parsePmlr(providerOrId, rawPayload) {
    const { provider, payload } = invocation(providerOrId, rawPayload, 'pmlr');
    return finalize(htmlPayload(provider, payload).map(input => {
        const stem = path.posix.basename(new URL(input.recordUrl).pathname, '.html');
        const $ = cheerio.load(input.html); const rawPdf = firstMeta($, ['citation_pdf_url']);
        const pdfUrl = rawPdf ? canonicalPdfUrl(rawPdf, 'PMLR PDF URL', provider) : null;
        if (pdfUrl && path.posix.basename(new URL(pdfUrl).pathname, '.pdf') !== stem) {
            fail('PMLR record and PDF stable identifiers differ');
        }
        return htmlCommon(provider, input, stem, pdfUrl, provider.trackByCollection[input.collection]);
    }));
}

function parseCvfOpenAccess(providerOrPayload, rawPayload) {
    const { provider, payload } = invocation(providerOrPayload, rawPayload, 'cvf-openaccess', 'cvpr-2026');
    return finalize(htmlPayload(provider, payload).map(input => {
        const stem = path.posix.basename(new URL(input.recordUrl).pathname, '.html');
        const $ = cheerio.load(input.html); const rawPdf = firstMeta($, ['citation_pdf_url']);
        const pdfUrl = rawPdf ? canonicalUrl(rawPdf, 'CVF PDF URL', provider, provider.pdfPath) : null;
        if (pdfUrl && path.posix.basename(new URL(pdfUrl).pathname, '.pdf') !== stem) {
            fail('CVF 记录与 PDF 的稳定标识符不同');
        }
        return htmlCommon(provider, input, stem, pdfUrl, provider.trackByCollection[input.collection]);
    }));
}

function parseAclAnthology(providerOrId, rawPayload) {
    const { provider, payload } = invocation(providerOrId, rawPayload, 'acl-anthology');
    return finalize(htmlPayload(provider, payload).map(input => {
        const id = new URL(input.recordUrl).pathname.split('/').filter(Boolean).at(-1);
        if (!id.startsWith(`${input.collection}.`)) fail('ACL Anthology record differs from the exact venue collection');
        const $ = cheerio.load(input.html); const rawPdf = firstMeta($, ['citation_pdf_url']);
        const expected = `https://${provider.host}/${id}.pdf`;
        const pdfUrl = rawPdf ? canonicalUrl(rawPdf, 'ACL Anthology PDF URL', provider, provider.pdfPath) : expected;
        if (pdfUrl !== expected) fail('ACL Anthology PDF 未绑定记录的 venue ID');
        const record = htmlCommon(provider, input, id, pdfUrl, provider.trackByCollection[input.collection]);
        if (record.doi === null) record.doi = `10.18653/v1/${id}`;
        return record;
    }));
}

function parseConferenceRecords(conferenceId, payload) {
    const provider = providerFor(conferenceId);
    if (provider.parser === 'aaai-ojs') return parseAaaiOjs(provider, payload);
    if (provider.parser === 'pmlr') return parsePmlr(provider, payload);
    if (provider.parser === 'cvf-openaccess') return parseCvfOpenAccess(provider, payload);
    if (provider.parser === 'acl-anthology') return parseAclAnthology(provider, payload);
    fail('固定注册表中的解析器不受支持');
}

function parseConferenceSnapshot(conferenceId, payload) {
    const provider = providerFor(conferenceId);
    return { conference: clone(provider.conference), papers: parseConferenceRecords(conferenceId, payload) };
}

module.exports = {
    REGISTRY, PAPER_FIELDS, OfficialConferenceProviderError, providerFor,
    parseAaaiOjs, parsePmlr, parseCvfOpenAccess, parseAclAnthology,
    parseConferenceRecords, parseConferenceSnapshot
};

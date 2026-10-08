'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cheerio = require('cheerio');
const { detectHttpConnectProxyUrl, createProxyDispatcher } = require('../utils.js');

const VERSION = 1;
const HTTP_RECEIPT_CONTRACT = 'official-conference-http-response-v1';
const CATALOG_RECEIPT_CONTRACT = 'official-conference-catalog-receipt-v1';
const PDF_RECEIPT_CONTRACT = 'official-conference-pdf-receipt-v1';
const PARSER_VERSION = 'official-proceedings-cheerio-v1';
// ACL 2026 的官方事件索引有几千条记录，超过 16 MiB。给已保存的索引留一个明确的大小上限。
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_COMBINED_PDF_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 180000;
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const PAPER_FIELDS = ['abstract', 'authors', 'doi', 'id', 'pdfFile', 'pdfUrl', 'recordUrl', 'title', 'track'];

// 第 40 卷分成 48 个独立的 OJS issue 发布。OJS 的 issue ID 不连续（issue 6 是 733，
// issue 25 是 707），靠推算或者跟着 /issue/current 走，都会悄悄生成一份不完整的目录。
const AAAI_2026_ISSUE_IDS = Object.freeze([
    683, 684, 685, 686, 687, 733, 688, 689, 690, 691, 692, 693,
    694, 695, 696, 697, 698, 699, 700, 701, 702, 703, 704, 705,
    707, 708, 709, 710, 711, 712, 713, 714, 715, 716, 717, 718,
    719, 720, 721, 722, 723, 724, 725, 726, 727, 728, 729, 732
]);
const AAAI_2026_TRAILING_TITLES = Object.freeze({
    44: 'AAAI-26 Special Track on AI Alignment',
    45: 'AAAI-26 Special Track AI for Social Impact I',
    46: 'AAAI-26 Special Track AI for Social Impact II and Senior Member Presentations',
    47: 'AAAI-26 New Faculty Highlights, Journal Track, IAAI-26 and EAAI-26 Main Track',
    48: 'EAAI-26 AI for Education, Model AI Assignments, AAAI-26 Emerging Trends, Doctoral Consortium, Student Abstracts, Undergraduate Consortium and Demonstrations'
});
const AAAI_2026_ISSUES = Object.freeze(AAAI_2026_ISSUE_IDS.map((issueId, offset) => {
    const number = offset + 1;
    const title = number <= 43 ? `AAAI-26 Technical Tracks ${number}` : AAAI_2026_TRAILING_TITLES[number];
    return Object.freeze({ number, issueId, title,
        url: `https://ojs.aaai.org/index.php/AAAI/issue/view/${issueId}`,
        path: `/index.php/AAAI/issue/view/${issueId}` });
}));

const PROVIDERS = Object.freeze({
    'odyssey-2026': Object.freeze({
        conference: Object.freeze({ id: 'odyssey-2026', year: 2026 }),
        indexUrl: 'https://www.isca-archive.org/odyssey_2026/index.html',
        host: 'www.isca-archive.org',
        indexPath: '/odyssey_2026/index.html',
        recordPath: /^\/odyssey_2026\/[A-Za-z0-9_-]+_odyssey\.html$/,
        pdfPath: /^\/odyssey_2026\/[A-Za-z0-9_-]+_odyssey\.pdf$/,
        parser: 'isca'
    }),
    'chime-2026': Object.freeze({
        conference: Object.freeze({ id: 'chime-2026', year: 2026 }),
        indexUrl: 'https://www.isca-archive.org/chime_2026/index.html',
        host: 'www.isca-archive.org',
        indexPath: '/chime_2026/index.html',
        recordPath: /^\/chime_2026\/[A-Za-z0-9_-]+_chime\.html$/,
        pdfPath: /^\/chime_2026\/[A-Za-z0-9_-]+_chime\.pdf$/,
        parser: 'isca'
    }),
    'jep-2026': Object.freeze({
        conference: Object.freeze({ id: 'jep-2026', year: 2026 }),
        indexUrl: 'https://www.isca-archive.org/jep_2026/index.html',
        host: 'www.isca-archive.org',
        indexPath: '/jep_2026/index.html',
        recordPath: /^\/jep_2026\/[A-Za-z0-9_-]+_jep\.html$/,
        pdfPath: /^\/jep_2026\/[A-Za-z0-9_-]+_jep\.pdf$/,
        parser: 'isca'
    }),
    'speechprosody-2026': Object.freeze({
        conference: Object.freeze({ id: 'speechprosody-2026', year: 2026 }),
        indexUrl: 'https://www.isca-archive.org/speechprosody_2026/index.html',
        host: 'www.isca-archive.org',
        indexPath: '/speechprosody_2026/index.html',
        recordPath: /^\/speechprosody_2026\/[A-Za-z0-9_-]+_speechprosody\.html$/,
        pdfPath: /^\/speechprosody_2026\/[A-Za-z0-9_-]+_speechprosody\.pdf$/,
        parser: 'isca'
    }),
    'interspeech-2026': Object.freeze({
        conference: Object.freeze({ id: 'interspeech-2026', year: 2026 }),
        indexUrl: 'https://www.isca-archive.org/interspeech_2026/index.html',
        host: 'www.isca-archive.org',
        indexPath: '/interspeech_2026/index.html',
        recordPath: /^\/interspeech_2026\/[A-Za-z0-9_-]+_interspeech\.html$/,
        pdfPath: /^\/interspeech_2026\/[A-Za-z0-9_-]+_interspeech\.pdf$/,
        parser: 'isca'
    }),
    'icmc-2026': Object.freeze({
        conference: Object.freeze({ id: 'icmc-2026', year: 2026 }),
        indexUrl: 'https://icmc2026.ligeti-zentrum.de/proceedings/',
        host: 'icmc2026.ligeti-zentrum.de',
        indexPath: '/proceedings/',
        recordPath: /^\/proceedings\/$/,
        pdfPath: /^\/wp-content\/uploads\/2026\/07\/ICMC2026_proceedings_V2showcase\.pdf$/,
        combinedPdfUrl: 'https://icmc2026.ligeti-zentrum.de/wp-content/uploads/2026/07/ICMC2026_proceedings_V2showcase.pdf',
        parser: 'icmc-combined'
    }),
    'iwslt-2026': Object.freeze({
        conference: Object.freeze({ id: 'iwslt-2026', year: 2026 }),
        indexUrl: 'https://aclanthology.org/events/iwslt-2026/',
        host: 'aclanthology.org',
        indexPath: '/events/iwslt-2026/',
        recordPath: /^\/2026\.iwslt-1\.[1-9]\d*\/$/,
        pdfPath: /^\/2026\.iwslt-1\.[1-9]\d*\.pdf$/,
        parser: 'iwslt'
    }),
    'eusipco-2026': Object.freeze({
        conference: Object.freeze({ id: 'eusipco-2026', year: 2026 }),
        indexUrl: 'https://eurasip.org/Proceedings/Eusipco/Eusipco2026/HTML/session-index/index.html',
        host: 'eurasip.org',
        indexPath: '/Proceedings/Eusipco/Eusipco2026/HTML/session-index/index.html',
        recordPath: /^\/Proceedings\/Eusipco\/Eusipco2026\/HTML\/session-index\/index\.html$/,
        pdfPath: /^\/Proceedings\/Eusipco\/Eusipco2026\/pdfs\/[0-9]+\.pdf$/,
        parser: 'eusipco'
    }),
    'nime-2026': Object.freeze({
        conference: Object.freeze({ id: 'nime-2026', year: 2026 }),
        indexUrl: 'https://nime.org/papers/',
        host: 'nime.org',
        indexPath: '/papers/',
        recordPath: /^\/proc\/nime2026_[0-9]+\/index\.html$/,
        pdfPath: /^\/proceedings\/2026\/nime2026_[0-9]+\.pdf$/,
        parser: 'nime'
    }),
    'dafx-2026': Object.freeze({
        conference: Object.freeze({ id: 'dafx-2026', year: 2026 }),
        indexUrl: 'https://dafx26.mit.edu/program/',
        host: 'dafx26.mit.edu',
        indexPath: '/program/',
        recordPath: /^\/program\/$/,
        pdfPath: /^\/assets\/papers\/DAFx26_(?:paper|challenge|demo)_[0-9]+\.pdf$/,
        parser: 'dafx'
    }),
    'aaai-2026': Object.freeze({
        conference: Object.freeze({ id: 'aaai-2026', year: 2026 }),
        archiveUrl: 'https://ojs.aaai.org/index.php/AAAI/issue/archive',
        host: 'ojs.aaai.org',
        issues: AAAI_2026_ISSUES,
        recordPath: /^\/index\.php\/AAAI\/article\/view\/[1-9]\d*$/,
        pdfPath: /^\/index\.php\/AAAI\/article\/view\/[1-9]\d*\/[1-9]\d*$/,
        pdfRedirectPath: /^\/index\.php\/AAAI\/article\/download\/[1-9]\d*\/[1-9]\d*$/,
        parser: 'aaai-multi'
    }),
    'aistats-2026': Object.freeze({
        conference: Object.freeze({ id: 'aistats-2026', year: 2026 }),
        indexUrl: 'https://proceedings.mlr.press/v300/',
        host: 'proceedings.mlr.press',
        indexPath: '/v300/',
        recordPath: /^\/v300\/[A-Za-z0-9_-]+\.html$/,
        pdfPath: /^\/v300\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/,
        alternatePdfAuthorities: Object.freeze([Object.freeze({
            host: 'raw.githubusercontent.com',
            path: /^\/mlresearch\/v300\/main\/assets\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/
        })]),
        parser: 'pmlr', volume: 'v300'
    }),
    'uai-2026': Object.freeze({
        conference: Object.freeze({ id: 'uai-2026', year: 2026 }),
        indexUrl: 'https://proceedings.mlr.press/v337/',
        host: 'proceedings.mlr.press',
        indexPath: '/v337/',
        recordPath: /^\/v337\/[A-Za-z0-9_-]+\.html$/,
        pdfPath: /^\/v337\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/,
        alternatePdfAuthorities: Object.freeze([Object.freeze({
            host: 'raw.githubusercontent.com',
            path: /^\/mlresearch\/v337\/main\/assets\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/
        })]),
        parser: 'pmlr', volume: 'v337'
    }),
    'cvpr-2026': Object.freeze({
        conference: Object.freeze({ id: 'cvpr-2026', year: 2026 }),
        indexUrl: 'https://openaccess.thecvf.com/CVPR2026?day=all',
        host: 'openaccess.thecvf.com',
        indexPath: '/CVPR2026',
        recordPath: /^\/content\/CVPR2026\/html\/[A-Za-z0-9_-]+\.html$/,
        pdfPath: /^\/content\/CVPR2026\/papers\/[A-Za-z0-9_-]+\.pdf$/,
        parser: 'cvf'
    }),
    'acl-2026': Object.freeze({
        conference: Object.freeze({ id: 'acl-2026', year: 2026 }),
        indexUrl: 'https://aclanthology.org/events/acl-2026/',
        host: 'aclanthology.org',
        indexPath: '/events/acl-2026/',
        recordPath: /^\/2026\.(?:acl-(?:long|short)|findings-acl)\.[1-9]\d*\/$/,
        pdfPath: /^\/2026\.(?:acl-(?:long|short)|findings-acl)\.[1-9]\d*\.pdf$/,
        parser: 'acl', venue: 'acl'
    }),
    'eacl-2026': Object.freeze({
        conference: Object.freeze({ id: 'eacl-2026', year: 2026 }),
        indexUrl: 'https://aclanthology.org/events/eacl-2026/',
        host: 'aclanthology.org',
        indexPath: '/events/eacl-2026/',
        recordPath: /^\/2026\.(?:eacl-(?:long|short)|findings-eacl)\.[1-9]\d*\/$/,
        pdfPath: /^\/2026\.(?:eacl-(?:long|short)|findings-eacl)\.[1-9]\d*\.pdf$/,
        parser: 'acl', venue: 'eacl'
    })
});

class OfficialConferenceAcquisitionError extends Error {
    constructor(message) {
        super(`Official conference acquisition rejected: ${message}`);
        this.name = 'OfficialConferenceAcquisitionError';
        this.code = 'OFFICIAL_CONFERENCE_ACQUISITION_INTEGRITY';
    }
}

const fail = message => { throw new OfficialConferenceAcquisitionError(message); };
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = value => sha256(Buffer.from(JSON.stringify(canonical(value)), 'utf8'));
const prettyBytes = value => Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');

function exact(value, keys, label) {
    if (!plain(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
        fail(`${label} 的 schema 无效`);
    }
}

function cleanText(value, label, { allowEmpty = false, max = 20000 } = {}) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        fail(`${label} 无效`);
    }
    const normalized = value.replace(/\s+/gu, ' ').trim();
    if (!allowEmpty && !normalized) fail(`${label} 为空`);
    return normalized;
}

function cleanOptional(value, label, max = 2048) {
    return value === null ? null : cleanText(value, label, { max });
}

function canonicalPublicHttps(value, label) {
    const text = cleanText(value, label, { max: 2048 });
    let url;
    try { url = new URL(text); } catch { fail(`${label} 不是 URL`); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
        || net.isIP(host) || host === 'localhost' || !host.includes('.')
        || host.endsWith('.local') || host.endsWith('.localhost')) {
        fail(`${label} 必须是规范的公开 HTTPS 地址`);
    }
    if (url.toString() !== text) fail(`${label} 必须使用规范 URL 拼写`);
    return text;
}

function providerFor(providerId) {
    const provider = PROVIDERS[String(providerId || '')];
    if (!provider) fail(`provider 必须是以下之一：${Object.keys(PROVIDERS).join(', ')}`);
    return provider;
}

function validateFetchUrl(provider, rawUrl, kind) {
    const value = canonicalPublicHttps(rawUrl, `${kind} URL`);
    const url = new URL(value);
    if (kind === 'index') {
        const fixedIssue = provider.issues?.find(issue => issue.url === value);
        if (provider.issues ? (!fixedIssue || url.hostname !== provider.host || url.pathname !== fixedIssue.path)
            : (url.hostname !== provider.host || url.pathname !== provider.indexPath || value !== provider.indexUrl)) {
            fail('index URL differs from the fixed official URL');
        }
    } else if (kind === 'pdf') {
        if (url.search || (url.hostname !== provider.host || !provider.pdfPath.test(url.pathname))
            && !(provider.alternatePdfAuthorities || []).some(authority => (
                url.hostname === authority.host && authority.path.test(url.pathname)
            ))) fail('PDF URL left the official proceedings path');
    } else if (kind === 'record') {
        if (url.hostname !== provider.host || url.search || !provider.recordPath || !provider.recordPath.test(url.pathname)) {
            fail('record URL left the official proceedings path');
        }
    } else fail('URL 类型未知');
    return value;
}

function validateRedirectTarget(provider, rawFrom, rawTo, kind) {
    if (kind === 'pdf' && provider.pdfRedirectPath) {
        const from = canonicalPublicHttps(rawFrom, 'redirect source URL');
        const to = canonicalPublicHttps(rawTo, 'redirect target URL');
        const source = new URL(from); const target = new URL(to);
        if (source.hostname !== provider.host || source.search || !provider.pdfPath.test(source.pathname)
            || target.hostname !== provider.host || target.search || !provider.pdfRedirectPath.test(target.pathname)) {
            fail('PDF redirect must be the fixed same-host view-to-download transition');
        }
        const sourceIdentity = source.pathname.split('/').filter(Boolean).slice(-2);
        const targetIdentity = target.pathname.split('/').filter(Boolean).slice(-2);
        if (sourceIdentity.length !== 2 || targetIdentity.length !== 2
            || sourceIdentity[0] !== targetIdentity[0] || sourceIdentity[1] !== targetIdentity[1]) {
            fail('PDF redirect changed the article or galley identity');
        }
        return to;
    }
    validateFetchUrl(provider, rawFrom, kind);
    return validateFetchUrl(provider, rawTo, kind);
}

function hrefUrl(href, base) {
    try { return new URL(String(href || ''), base).toString(); } catch { return null; }
}

function uniqueTexts($, selection) {
    const seen = new Set(); const values = [];
    selection.each((_index, element) => {
        const value = $(element).text().replace(/\s+/gu, ' ').trim();
        if (value && !seen.has(value)) { seen.add(value); values.push(value); }
    });
    return values;
}

function authorsFrom($, container) {
    const selectors = [
        '[data-author]', '.authors [itemprop="author"]', '.authors .author', '.authors a',
        '.acl-paper-authors a', '.paper-authors a', 'a[href^="/people/"]', 'a[href*="author-index"]',
        '[itemprop="author"]', '.author'
    ];
    for (const selector of selectors) {
        const values = uniqueTexts($, container.find(selector));
        if (values.length) return values;
    }
    const encoded = container.attr('data-authors');
    return encoded ? encoded.split(';').map(item => item.trim()).filter(Boolean) : [];
}

function fieldText(container, selectors) {
    for (const selector of selectors) {
        const value = container.find(selector).first().text().replace(/\s+/gu, ' ').trim();
        if (value) return value;
    }
    return '';
}

function splitAuthorLine(value) {
    return [...new Set(String(value || '').replace(/\s+/gu, ' ').trim().replace(/[.,\s]+$/u, '')
        .split(/,\s+(?:and\s+)?|\s+and\s+/u).map(item => item.trim()).filter(Boolean))];
}

function closestPaper($, element) {
    const anchor = $(element);
    const container = anchor.closest('tr, li, article, p, .paper, .paper-entry, .acl-paper, .card, .d-sm-flex');
    return container.length ? container.first() : anchor.parent();
}

function doiFrom(container) {
    const href = container.find('a[href*="doi.org/"]').first().attr('href');
    if (href) {
        try { return decodeURIComponent(new URL(href).pathname.replace(/^\//, '')).trim() || null; } catch { /* 继续往下试 */ }
    }
    const match = container.text().match(/\b10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+/u);
    return match ? match[0].replace(/[.,;)]+$/u, '') : null;
}

function makePaper({ id, title, authors = [], abstract = '', pdfUrl, recordUrl = null, doi = null, track = null }) {
    return { id, title, authors, abstract, pdfFile: pdfUrl ? `pdfs/${id}.pdf` : null,
        recordUrl, pdfUrl, doi, track };
}

function parseIsca(provider, html) {
    const $ = cheerio.load(html); const papers = [];
    $('a[href]').each((_index, element) => {
        const recordUrl = hrefUrl($(element).attr('href'), provider.indexUrl);
        if (!recordUrl) return;
        let parsed;
        try { parsed = new URL(recordUrl); } catch { return; }
        if (parsed.hostname !== provider.host || !provider.recordPath.test(parsed.pathname)) return;
        const id = path.posix.basename(parsed.pathname, '.html');
        const card = $(element).closest('.w3-card');
        const heading = card.find('h4').first().text().replace(/\s+/gu, ' ').trim();
        // ISCA 把主题演讲摘要页也放在同一个索引里。它们不是正式论文，有意不提供 PDF，
        // 所以在建目录时就排除，而不是编一个固定的 404 PDF 地址。
        if (/keynote/iu.test(heading)) return;
        const container = card.length ? card : closestPaper($, element);
        const titleNode = $(element).find('p').first().clone();
        titleNode.find('.w3-text-theme, br').remove();
        const title = ($(element).attr('data-title') || $(element).find('.title').text()
            || titleNode.text() || $(element).text()).trim();
        let authors = authorsFrom($, container);
        if (!authors.length) authors = $(element).find('.w3-text-theme').toArray()
            .flatMap(author => splitAuthorLine($(author).text()));
        const pdfAnchor = container.find('a[href$=".pdf"]').first().attr('href');
        const pdfUrl = pdfAnchor ? hrefUrl(pdfAnchor, provider.indexUrl)
            : new URL(`${id}.pdf`, provider.indexUrl).toString();
        papers.push(makePaper({ id, title, authors,
            abstract: fieldText(container, ['.abstract', '[data-abstract]']), recordUrl, pdfUrl,
            doi: doiFrom(container), track: cleanMaybe(container.attr('data-track') || heading) }));
    });
    return papers;
}

function parseOdyssey(provider, html) {
    return parseIsca(provider, html);
}

function parseIwslt(provider, html) {
    const $ = cheerio.load(html); const papers = [];
    $('a[href]').each((_index, element) => {
        const recordUrl = hrefUrl($(element).attr('href'), provider.indexUrl);
        if (!recordUrl) return;
        let parsed;
        try { parsed = new URL(recordUrl); } catch { return; }
        if (parsed.hostname !== provider.host || !provider.recordPath.test(parsed.pathname)) return;
        const id = parsed.pathname.split('/').filter(Boolean).at(-1);
        const container = closestPaper($, element);
        const title = ($(element).attr('data-title') || $(element).find('.title').text() || $(element).text()).trim();
        papers.push(makePaper({ id, title, authors: authorsFrom($, container),
            abstract: fieldText(container, ['.abstract', '.acl-abstract']), recordUrl,
            pdfUrl: `https://${provider.host}/${id}.pdf`, doi: `10.18653/v1/${id}`,
            track: cleanMaybe(container.attr('data-track')) }));
    });
    return papers;
}

function parseEusipco(provider, html) {
    const $ = cheerio.load(html); const papers = [];
    $('a[href]').each((_index, element) => {
        const pdfUrl = hrefUrl($(element).attr('href'), provider.indexUrl);
        if (!pdfUrl) return;
        let parsed;
        try { parsed = new URL(pdfUrl); } catch { return; }
        if (parsed.hostname !== provider.host || !provider.pdfPath.test(parsed.pathname)) return;
        const id = path.posix.basename(parsed.pathname, '.pdf');
        const container = closestPaper($, element);
        const authorRow = $(element).closest('p').nextAll('p').first();
        const rawTitle = ($(element).attr('data-title') || $(element).find('.title').text() || $(element).text()).trim();
        const prefix = rawTitle.match(/^([A-Z][A-Z0-9-]*(?:\.[0-9]+)?):\s*/u);
        const title = prefix ? rawTitle.slice(prefix[0].length) : rawTitle;
        let authors = authorsFrom($, container);
        if (!authors.length && authorRow.length) authors = uniqueTexts($, authorRow.find('a[href*="author-index"]'));
        papers.push(makePaper({ id, title, authors,
            abstract: fieldText(container, ['.abstract']), pdfUrl, recordUrl: provider.indexUrl,
            doi: doiFrom(container), track: cleanMaybe(container.attr('data-track') || prefix?.[1]) }));
    });
    return papers;
}

function parseNime(provider, html) {
    const $ = cheerio.load(html); const papers = [];
    $('li').each((_index, element) => {
        const container = $(element);
        const pdfAnchor = container.find('a[href]').filter((_i, anchor) => {
            const absolute = hrefUrl($(anchor).attr('href'), provider.indexUrl);
            if (!absolute) return false;
            try { const parsed = new URL(absolute); return parsed.hostname === provider.host && provider.pdfPath.test(parsed.pathname); }
            catch { return false; }
        }).first();
        if (!pdfAnchor.length || !/(?:^|\D)2026(?:\D|$)/u.test(container.text())) return;
        const parsedPdfUrl = new URL(hrefUrl(pdfAnchor.attr('href'), provider.indexUrl));
        if (parsedPdfUrl.protocol === 'http:' && parsedPdfUrl.hostname === provider.host) parsedPdfUrl.protocol = 'https:';
        const pdfUrl = parsedPdfUrl.toString();
        const id = path.posix.basename(parsedPdfUrl.pathname, '.pdf');
        let titleAnchor = container.find('a.title, a[data-title]').first();
        if (!titleAnchor.length) {
            titleAnchor = container.find('a[href]').filter((_i, anchor) => {
                const text = $(anchor).text().trim(); const href = String($(anchor).attr('href') || '');
                return text && !/^pdf$/iu.test(text) && !/doi\.org/u.test(href) && anchor !== pdfAnchor.get(0);
            }).first();
        }
        const title = (titleAnchor.attr('data-title') || titleAnchor.text()).trim();
        const possibleRecord = hrefUrl(titleAnchor.attr('href'), provider.indexUrl);
        const recordUrl = possibleRecord && !possibleRecord.endsWith('.pdf') ? possibleRecord : provider.indexUrl;
        let authors = authorsFrom($, container);
        if (!authors.length) {
            const citation = container.text().replace(/\s+/gu, ' ').trim();
            const marker = citation.indexOf(' 2026. ');
            if (marker > 0) authors = splitAuthorLine(citation.slice(0, marker));
        }
        papers.push(makePaper({ id, title, authors,
            abstract: fieldText(container, ['.abstract']), pdfUrl, recordUrl,
            doi: doiFrom(container), track: cleanMaybe(container.attr('data-track') || 'papers') }));
    });
    return papers;
}

function parseDafx(provider, html) {
    const $ = cheerio.load(html); const byId = new Map();
    $('.paper-item').each((_index, element) => {
        const container = $(element);
        const pdfAnchor = container.find('a[href]').filter((_i, anchor) => {
            const candidate = hrefUrl($(anchor).attr('href'), provider.indexUrl);
            if (!candidate) return false;
            try { return validateFetchUrl(provider, candidate, 'pdf') === candidate; } catch { return false; }
        }).first();
        if (!pdfAnchor.length) return;
        const pdfUrl = hrefUrl(pdfAnchor.attr('href'), provider.indexUrl);
        const id = path.posix.basename(new URL(pdfUrl).pathname, '.pdf');
        const title = fieldText(container, ['.p-title']);
        const authors = splitAuthorLine(fieldText(container, ['.p-authors']));
        const abstract = fieldText(container, ['.p-abstract']);
        const sessionCell = container.closest('td');
        const session = fieldText(sessionCell, ['.s-name']) || sessionCell.children('b').first().text().trim();
        const subtrack = container.closest('.sub-poster').find('.sub-label').first().text().trim();
        const track = cleanMaybe([session, subtrack].filter(Boolean).join(' — '));
        const paper = makePaper({ id, title, authors, abstract, pdfUrl,
            recordUrl: provider.indexUrl, doi: null, track });
        const previous = byId.get(id);
        if (!previous) { byId.set(id, paper); return; }
        for (const field of ['title', 'authors', 'abstract', 'pdfUrl', 'recordUrl', 'doi']) {
            if (JSON.stringify(previous[field]) !== JSON.stringify(paper[field])) {
                fail(`DAFx duplicate PDF identity has conflicting ${field}: ${id}`);
            }
        }
        const tracks = [...new Set([previous.track, paper.track].filter(Boolean)
            .flatMap(value => value.split(' | ')))];
        previous.track = cleanMaybe(tracks.join(' | '));
    });
    return [...byId.values()];
}

function parseAaaiIssue(providerOrId, issueOrNumber, html) {
    const provider = typeof providerOrId === 'string' ? providerFor(providerOrId) : providerOrId;
    if (provider.parser !== 'aaai-multi' || !Array.isArray(provider.issues)) fail('AAAI 期号解析器要求固定的多期号 provider');
    const issue = typeof issueOrNumber === 'number'
        ? provider.issues.find(candidate => candidate.number === issueOrNumber)
        : issueOrNumber;
    if (!issue || provider.issues.find(candidate => candidate.number === issue.number) !== issue) {
        fail('AAAI 期号不在固定的 volume 40 清单内');
    }
    const source = cleanText(String(html), `AAAI issue ${issue.number} HTML`, { max: MAX_INDEX_BYTES });
    const $ = cheerio.load(source);
    const expectedHeading = `Vol. 40 No. ${issue.number}: ${issue.title}`;
    const heading = $('main h1, .page_issue > h1, h1').first().text().replace(/\s+/gu, ' ').trim();
    if (heading !== expectedHeading) fail(`AAAI issue ${issue.number} identity differs from the fixed volume 40 manifest`);
    const papers = [];
    $('.obj_article_summary').each((_index, element) => {
        const container = $(element);
        const recordAnchor = container.find('h3.title a[href], .title a[href]').first();
        const recordUrl = hrefUrl(recordAnchor.attr('href'), issue.url);
        if (!recordUrl) fail(`AAAI 期号 ${issue.number} 的文章没有官方 record URL`);
        validateFetchUrl(provider, recordUrl, 'record');
        const recordId = path.posix.basename(new URL(recordUrl).pathname);
        const pdfAnchor = container.find('a.obj_galley_link.pdf[href]').first();
        if (!pdfAnchor.length) fail(`AAAI 文章 ${recordId} 没有 proceedings PDF`);
        const pdfUrl = hrefUrl(pdfAnchor.attr('href'), issue.url);
        validateFetchUrl(provider, pdfUrl, 'pdf');
        const pdfParts = new URL(pdfUrl).pathname.split('/').filter(Boolean);
        if (pdfParts.at(-2) !== recordId) fail(`AAAI article ${recordId} PDF identity differs from its official record`);
        // OJS 文章 37523 把显示名 "Shuai Wang" 列了两次。共用的九字段 schema 无法表达
        // 两个无法区分的作者字符串，所以保留首次出现的顺序，去掉完全相同的显示名
        // （不用标题当身份）。
        const authors = [...new Set(container.find('.authors').first().text().replace(/\s+/gu, ' ').trim()
            .split(/\s*,\s*/u).map(item => item.trim()).filter(Boolean))];
        const track = container.closest('.section').find('h2').first().text().replace(/\s+/gu, ' ').trim();
        papers.push(makePaper({ id: recordId, title: recordAnchor.text().replace(/\s+/gu, ' ').trim(),
            authors, abstract: '', recordUrl, pdfUrl, doi: null, track: cleanMaybe(track || issue.title) }));
    });
    if (!papers.length) fail(`AAAI 期号 ${issue.number} 没有 proceedings 论文`);
    return papers;
}

function pmlrPdfIdentity(provider, pdfUrl, expectedId) {
    const parsed = new URL(pdfUrl); const parts = parsed.pathname.split('/').filter(Boolean);
    const basename = path.posix.basename(parsed.pathname, '.pdf');
    const parent = parts.at(-2);
    if (basename !== expectedId || parent !== expectedId) fail('PMLR PDF 身份与其官方 record 不一致');
    if (parsed.hostname === provider.host && parts[0] !== provider.volume) fail('PMLR PDF 离开了其固定 volume');
    if (parsed.hostname === 'raw.githubusercontent.com'
        && (parts[0] !== 'mlresearch' || parts[1] !== provider.volume || parts[2] !== 'main' || parts[3] !== 'assets')) {
        fail('PMLR 原始 PDF 离开了其固定仓库路径');
    }
}

function parsePmlr(provider, html) {
    const $ = cheerio.load(html); const papers = [];
    $('a[href]').each((_index, element) => {
        const recordUrl = hrefUrl($(element).attr('href'), provider.indexUrl);
        if (!recordUrl) return;
        let parsed;
        try { parsed = new URL(recordUrl); } catch { return; }
        if (parsed.hostname !== provider.host || !provider.recordPath.test(parsed.pathname)) return;
        const id = path.posix.basename(parsed.pathname, '.html');
        const container = $(element).closest('.paper, article, li, tr');
        if (!container.length) return;
        const pdfAnchor = container.find('a[href]').filter((_i, anchor) => {
            const candidate = hrefUrl($(anchor).attr('href'), provider.indexUrl);
            if (!candidate) return false;
            try { validateFetchUrl(provider, candidate, 'pdf'); pmlrPdfIdentity(provider, candidate, id); return true; }
            catch { return false; }
        }).first();
        if (!pdfAnchor.length) fail(`PMLR record ${id} 没有绑定身份的 proceedings PDF`);
        const title = fieldText(container, ['.title', '.paper-title'])
            || ($(element).attr('data-title') || '').trim();
        let authors = authorsFrom($, container);
        if (!authors.length) authors = splitAuthorLine(fieldText(container, ['.authors', '.paper-authors']));
        const pdfUrl = hrefUrl(pdfAnchor.attr('href'), provider.indexUrl);
        papers.push(makePaper({ id, title, authors, abstract: '', recordUrl, pdfUrl,
            doi: doiFrom(container), track: 'Main' }));
    });
    return papers;
}

function cvfAuthorLine($, container) {
    const values = [];
    for (const node of container.contents().toArray()) {
        if (node.type === 'tag' && node.name === 'br') break;
        values.push($(node).text());
    }
    return splitAuthorLine(values.join(' '));
}

function parseCvf(provider, html) {
    const $ = cheerio.load(html); const papers = [];
    $('dt.ptitle a[href], .ptitle a[href]').each((_index, element) => {
        const recordUrl = hrefUrl($(element).attr('href'), provider.indexUrl);
        if (!recordUrl) return;
        let parsed;
        try { parsed = new URL(recordUrl); } catch { return; }
        if (parsed.hostname !== provider.host || !provider.recordPath.test(parsed.pathname)) return;
        const id = path.posix.basename(parsed.pathname, '.html');
        const heading = $(element).closest('dt, .ptitle');
        const details = heading.is('dt') ? heading.next('dd') : heading.parent();
        const pdfAnchor = details.find('a[href]').filter((_i, anchor) => {
            const candidate = hrefUrl($(anchor).attr('href'), provider.indexUrl);
            if (!candidate) return false;
            try { return validateFetchUrl(provider, candidate, 'pdf') === candidate; } catch { return false; }
        }).first();
        // CVF 偶尔会漏掉可见的 PDF 链接，但记录本身和身份等价的 PDF 端点还在。
        const pdfUrl = pdfAnchor.length ? hrefUrl(pdfAnchor.attr('href'), provider.indexUrl)
            : `https://${provider.host}/content/CVPR2026/papers/${id}.pdf`;
        validateFetchUrl(provider, pdfUrl, 'pdf');
        if (path.posix.basename(new URL(pdfUrl).pathname, '.pdf') !== id) fail('CVF 的 record 与 PDF 身份不一致');
        let authors = authorsFrom($, details);
        if (!authors.length) authors = cvfAuthorLine($, details);
        papers.push(makePaper({ id, title: $(element).text().trim(), authors, abstract: '', recordUrl, pdfUrl,
            doi: doiFrom(details), track: 'Main' }));
    });
    return papers;
}

function aclTrack(id, venue) {
    if (id.startsWith(`2026.${venue}-long.`)) return 'Long Papers';
    if (id.startsWith(`2026.${venue}-short.`)) return 'Short Papers';
    if (id.startsWith(`2026.findings-${venue}.`)) return 'Findings';
    fail('ACL Anthology record 离开了已准入的主会议卷');
}

function parseAcl(provider, html) {
    const $ = cheerio.load(html); const papers = [];
    $('a[href]').each((_index, element) => {
        const recordUrl = hrefUrl($(element).attr('href'), provider.indexUrl);
        if (!recordUrl) return;
        let parsed;
        try { parsed = new URL(recordUrl); } catch { return; }
        if (parsed.hostname !== provider.host || !provider.recordPath.test(parsed.pathname)) return;
        const id = parsed.pathname.split('/').filter(Boolean).at(-1);
        const container = closestPaper($, element);
        let authors = authorsFrom($, container);
        if (!authors.length) authors = splitAuthorLine(fieldText(container, ['.authors', '.acl-paper-authors']));
        papers.push(makePaper({ id,
            title: ($(element).attr('data-title') || $(element).find('.title').text() || $(element).text()).trim(),
            authors, abstract: fieldText(container, ['.abstract', '.acl-abstract']), recordUrl,
            pdfUrl: `https://${provider.host}/${id}.pdf`, doi: `10.18653/v1/${id}`,
            track: aclTrack(id, provider.venue) }));
    });
    return papers;
}

function cleanMaybe(value) {
    const text = String(value || '').replace(/\s+/gu, ' ').trim();
    return text || null;
}

function normalizePaper(value, provider, index) {
    exact(value, PAPER_FIELDS, `papers[${index}]`);
    const id = cleanText(value.id, `papers[${index}].id`, { max: 200 });
    if (!ID_RE.test(id)) fail(`papers[${index}].id 无效`);
    if (!Array.isArray(value.authors) || !value.authors.length) fail(`papers[${index}].authors 必须是非空数组`);
    const authors = []; const seen = new Set();
    for (const [authorIndex, author] of value.authors.entries()) {
        const normalized = cleanText(author, `papers[${index}].authors[${authorIndex}]`, { max: 500 });
        if (seen.has(normalized)) fail(`papers[${index}].authors 含重复项`);
        seen.add(normalized); authors.push(normalized);
    }
    const pdfUrl = value.pdfUrl === null ? null : validateFetchUrl(provider, value.pdfUrl, 'pdf');
    const expectedPdfFile = pdfUrl === null ? null : `pdfs/${id}.pdf`;
    if (value.pdfFile !== expectedPdfFile) fail(`papers[${index}].pdfFile 必须绑定其官方 ID 和 PDF URL`);
    const recordUrl = validateFetchUrl(provider, value.recordUrl, 'record');
    return { id, title: cleanText(value.title, `papers[${index}].title`, { max: 4000 }), authors,
        abstract: cleanText(value.abstract, `papers[${index}].abstract`, { allowEmpty: true }),
        pdfFile: expectedPdfFile, recordUrl, pdfUrl, doi: cleanOptional(value.doi, `papers[${index}].doi`, 500),
        track: cleanOptional(value.track, `papers[${index}].track`, 500) };
}

function normalizeMetadata(value, providerOrId) {
    const provider = typeof providerOrId === 'string' ? providerFor(providerOrId) : providerOrId;
    exact(value, ['conference', 'papers'], 'metadata');
    exact(value.conference, ['id', 'year'], 'metadata.conference');
    if (value.conference.id !== provider.conference.id || value.conference.year !== provider.conference.year) {
        fail('metadata 的会议身份与 provider 不一致');
    }
    if (!Array.isArray(value.papers) || !value.papers.length) fail('metadata 的 papers 必须是非空数组');
    const papers = value.papers.map((paper, index) => normalizePaper(paper, provider, index))
        .sort((left, right) => left.id.localeCompare(right.id, 'en'));
    for (let index = 1; index < papers.length; index += 1) {
        if (papers[index - 1].id === papers[index].id) fail(`官方论文 ID 重复：${papers[index].id}`);
    }
    return { conference: clone(provider.conference), papers };
}

function parseCatalog(providerId, html) {
    const provider = providerFor(providerId);
    if (provider.parser === 'aaai-multi') {
        fail('AAAI catalog requires all 48 fixed issue snapshots; a single issue cannot represent the proceedings');
    }
    if (provider.parser === 'icmc-combined') {
        fail('ICMC catalog 需要合并后的 proceedings PDF，不能只有 index HTML');
    }
    const source = cleanText(String(html), 'official index HTML', { max: MAX_INDEX_BYTES });
    const parsers = { isca: parseIsca, odyssey: parseOdyssey, iwslt: parseIwslt, eusipco: parseEusipco, nime: parseNime, dafx: parseDafx,
        pmlr: parsePmlr, cvf: parseCvf, acl: parseAcl };
    const papers = parsers[provider.parser](provider, source);
    return normalizeMetadata({ conference: clone(provider.conference), papers }, provider);
}

function plannedRoot(outputRoot) {
    if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot) || path.resolve(outputRoot) !== outputRoot
        || outputRoot === path.parse(outputRoot).root) fail('output-root 必须是规范化的绝对非根路径');
    let cursor = outputRoot;
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor); if (parent === cursor) fail('output-root 没有可安全使用的已有祖先目录'); cursor = parent;
    }
    safeDirectory(cursor, 'output-root existing ancestor', false);
    return outputRoot;
}

function safeDirectory(directory, label, create) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) {
        fail(`${label} 必须是规范化的绝对路径`);
    }
    if (!fs.existsSync(directory)) {
        if (!create) fail(`${label} 不存在`);
        const parent = path.dirname(directory); safeDirectory(parent, `${label} parent`, false);
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail(`${label} 不安全`);
    return directory;
}

function acquisitionPaths(outputRoot, create = false) {
    const root = create ? plannedRoot(outputRoot) : plannedRoot(outputRoot);
    if (create && !fs.existsSync(root)) {
        const missing = []; let cursor = root;
        while (!fs.existsSync(cursor)) { missing.push(cursor); cursor = path.dirname(cursor); }
        for (const directory of missing.reverse()) { fs.mkdirSync(directory, { mode: 0o700 }); safeDirectory(directory, 'output-root', false); }
    }
    if (!create) safeDirectory(root, 'output-root', false);
    const responses = path.join(root, 'responses'); const pdfs = path.join(root, 'pdfs'); const receipts = path.join(root, 'receipts');
    if (create) for (const [directory, label] of [[responses, 'responses'], [pdfs, 'pdfs'], [receipts, 'receipts']]) {
        if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
        safeDirectory(directory, label, false);
    }
    return { root, responses, pdfs, receipts, indexFile: path.join(responses, 'index.html'),
        indexReceiptFile: path.join(responses, 'index.receipt.json'), metadataFile: path.join(root, 'metadata.json'),
        catalogReceiptFile: path.join(root, 'catalog.receipt.json'),
        combinedPdfFile: path.join(responses, 'proceedings.source'),
        combinedPdfReceiptFile: path.join(responses, 'proceedings.receipt.json'),
        pageMapFile: path.join(root, 'page-map.json') };
}

function issueArtifactPaths(paths, issue, create = false) {
    const issuesDirectory = path.join(paths.responses, 'issues');
    if (create && !fs.existsSync(issuesDirectory)) fs.mkdirSync(issuesDirectory, { mode: 0o700 });
    if (fs.existsSync(issuesDirectory)) safeDirectory(issuesDirectory, 'issue responses', false);
    const stem = `issue-${String(issue.number).padStart(2, '0')}-${issue.issueId}`;
    return { issuesDirectory, responseFile: path.join(issuesDirectory, `${stem}.html`),
        receiptFile: path.join(issuesDirectory, `${stem}.receipt.json`),
        responseRelativePath: `responses/issues/${stem}.html`,
        receiptRelativePath: `responses/issues/${stem}.receipt.json` };
}

function readStableFile(filename, label, maxBytes) {
    const parent = safeDirectory(path.dirname(filename), `${label} parent`, false); const absolute = path.resolve(filename);
    if (path.dirname(absolute) !== parent) fail(`${label} 路径超出其父目录`);
    let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size < 1 || opened.size > maxBytes) {
            fail(`${label} 不安全或超出大小上限`);
        }
        if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) fail(`${label} permissions must be 0600`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
            fail(`读取时 ${label} 已变化`);
        }
        return { bytes, sha256: sha256(bytes), size: bytes.length };
    } catch (error) {
        if (error instanceof OfficialConferenceAcquisitionError) throw error;
        fail(`无法读取 ${label}：${error.code || error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeExclusiveOrCompare(filename, bytes, label, maxBytes) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
        return 'created';
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = readStableFile(filename, label, maxBytes);
        const mode = fs.statSync(filename).mode & 0o777;
        if (mode !== 0o600 || !existing.bytes.equals(bytes)) fail(`拒绝覆盖内容不同或非私有的 ${label}`);
        return 'recovered';
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function rejectDuplicateJsonKeys(text, label) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token); if (top.keys.has(key)) fail(`${label} 含重复键`);
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function readCanonicalJson(filename, label, maxBytes) {
    const loaded = readStableFile(filename, label, maxBytes); let value;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text, label); value = JSON.parse(text);
    } catch (error) {
        if (error instanceof OfficialConferenceAcquisitionError) throw error;
        fail(`${label} 不是严格的 UTF-8 JSON`);
    }
    if (!loaded.bytes.equals(prettyBytes(value))) fail(`${label} 的字节不规范`);
    return { ...loaded, value };
}

function validObservedAt(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function responseReceipt(provider, fetched, relativePath, issue = null) {
    const body = { contract: HTTP_RECEIPT_CONTRACT, version: VERSION, providerId: provider.conference.id,
        resource: issue ? 'catalog-issue' : 'catalog-index', requestedUrl: fetched.requestedUrl, finalUrl: fetched.finalUrl,
        redirects: fetched.redirects, responseStatus: fetched.responseStatus, contentType: fetched.contentType,
        observedAt: fetched.observedAt, body: { relativePath, bytes: fetched.bytes.length, sha256: sha256(fetched.bytes) } };
    if (issue) { body.issueNumber = issue.number; body.issueId = issue.issueId; }
    return { ...body, receiptSha256: stableHash(body) };
}

function pdfReceipt(provider, paper, fetched, metadataSha256) {
    const body = { contract: PDF_RECEIPT_CONTRACT, version: VERSION, providerId: provider.conference.id,
        paperId: paper.id, metadataSha256, requestedUrl: fetched.requestedUrl, finalUrl: fetched.finalUrl,
        redirects: fetched.redirects, responseStatus: fetched.responseStatus, contentType: fetched.contentType,
        observedAt: fetched.observedAt,
        pdf: { relativePath: paper.pdfFile, bytes: fetched.bytes.length, sha256: sha256(fetched.bytes) } };
    return { ...body, receiptSha256: stableHash(body) };
}

function validateRedirects(provider, receipt, kind) {
    if (!Array.isArray(receipt.redirects) || receipt.redirects.length > MAX_REDIRECTS) fail('receipt 的重定向无效');
    let current = validateFetchUrl(provider, receipt.requestedUrl, kind);
    for (const item of receipt.redirects) {
        exact(item, ['from', 'status', 'to'], 'redirect');
        if (![301, 302, 303, 307, 308].includes(item.status) || item.from !== current) fail('重定向链不连续');
        current = validateRedirectTarget(provider, item.from, item.to, kind);
    }
    if (receipt.finalUrl !== current) fail('receipt 的最终 URL 与重定向链不一致');
}

function replayResponseReceipt(provider, responseFile, receiptFile, relativePath, issue = null) {
    const label = issue ? `issue ${issue.number} response` : 'index response';
    const loaded = readCanonicalJson(receiptFile, `${label} receipt`, 1024 * 1024); const receipt = loaded.value;
    const keys = ['body', 'contentType', 'contract', 'finalUrl', 'observedAt', 'providerId', 'receiptSha256',
        'redirects', 'requestedUrl', 'resource', 'responseStatus', 'version'];
    if (issue) keys.push('issueId', 'issueNumber');
    exact(receipt, keys, `${label} receipt`);
    if (receipt.contract !== HTTP_RECEIPT_CONTRACT || receipt.version !== VERSION
        || receipt.providerId !== provider.conference.id || receipt.resource !== (issue ? 'catalog-issue' : 'catalog-index')
        || receipt.responseStatus !== 200 || !/^text\/html(?:\s*;|$)/iu.test(receipt.contentType)
        || !validObservedAt(receipt.observedAt)
        || (issue && (receipt.issueNumber !== issue.number || receipt.issueId !== issue.issueId
            || receipt.requestedUrl !== issue.url))) fail(`${label} 的 receipt envelope 无效`);
    const body = { ...receipt }; delete body.receiptSha256;
    if (!SHA_RE.test(receipt.receiptSha256) || receipt.receiptSha256 !== stableHash(body)) fail(`${label} receipt self-SHA drifted`);
    validateRedirects(provider, receipt, 'index');
    exact(receipt.body, ['bytes', 'relativePath', 'sha256'], `${label} body binding`);
    if (receipt.body.relativePath !== relativePath || !Number.isSafeInteger(receipt.body.bytes)
        || receipt.body.bytes < 1 || receipt.body.bytes > MAX_INDEX_BYTES || !SHA_RE.test(receipt.body.sha256)) {
        fail(`${label} 的 body 绑定无效`);
    }
    const index = readStableFile(responseFile, `sealed ${label}`, MAX_INDEX_BYTES);
    if (index.size !== receipt.body.bytes || index.sha256 !== receipt.body.sha256) fail(`sealed ${label} differs from receipt`);
    return { receipt, receiptFileSha256: loaded.sha256, index };
}

function replayIndexReceipt(provider, paths) {
    return replayResponseReceipt(provider, paths.indexFile, paths.indexReceiptFile, 'responses/index.html');
}

function icmcCombinedResponseReceipt(provider, fetched) {
    const body = { contract: HTTP_RECEIPT_CONTRACT, version: VERSION, providerId: provider.conference.id,
        resource: 'catalog-proceedings-pdf', requestedUrl: fetched.requestedUrl, finalUrl: fetched.finalUrl,
        redirects: fetched.redirects, responseStatus: fetched.responseStatus, contentType: fetched.contentType,
        observedAt: fetched.observedAt,
        body: { relativePath: 'responses/proceedings.source', bytes: fetched.bytes.length, sha256: sha256(fetched.bytes) } };
    return { ...body, receiptSha256: stableHash(body) };
}

function replayIcmcCombinedReceipt(provider, paths) {
    const loaded = readCanonicalJson(paths.combinedPdfReceiptFile, 'ICMC combined proceedings receipt', 1024 * 1024);
    const receipt = loaded.value;
    exact(receipt, ['body', 'contentType', 'contract', 'finalUrl', 'observedAt', 'providerId', 'receiptSha256',
        'redirects', 'requestedUrl', 'resource', 'responseStatus', 'version'], 'ICMC combined proceedings receipt');
    if (receipt.contract !== HTTP_RECEIPT_CONTRACT || receipt.version !== VERSION
        || receipt.providerId !== provider.conference.id || receipt.resource !== 'catalog-proceedings-pdf'
        || receipt.responseStatus !== 200 || !validObservedAt(receipt.observedAt)
        || !/^(?:application\/pdf|application\/octet-stream)(?:\s*;|$)/iu.test(receipt.contentType)) {
        fail('ICMC 合并 proceedings 的 receipt envelope 无效');
    }
    const body = { ...receipt }; delete body.receiptSha256;
    if (!SHA_RE.test(receipt.receiptSha256) || receipt.receiptSha256 !== stableHash(body)) {
        fail('ICMC 合并 proceedings 的 receipt 自校验 SHA 已变化');
    }
    validateRedirects(provider, receipt, 'pdf');
    exact(receipt.body, ['bytes', 'relativePath', 'sha256'], 'ICMC combined proceedings byte binding');
    if (receipt.body.relativePath !== 'responses/proceedings.source' || !Number.isSafeInteger(receipt.body.bytes)
        || receipt.body.bytes < 5 || receipt.body.bytes > MAX_COMBINED_PDF_BYTES || !SHA_RE.test(receipt.body.sha256)) {
        fail('ICMC 合并 proceedings 的字节绑定无效');
    }
    const pdf = readStableFile(paths.combinedPdfFile, 'sealed ICMC combined proceedings PDF', MAX_COMBINED_PDF_BYTES);
    if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || pdf.size !== receipt.body.bytes
        || pdf.sha256 !== receipt.body.sha256) fail('ICMC 合并 proceedings 的 PDF 与其 receipt 不一致');
    return { receipt, receiptFileSha256: loaded.sha256, pdf };
}

function runIcmcMetadataExtractor(combinedPdfFile, provider) {
    const script = path.join(__dirname, '..', 'icmc-proceedings.py');
    const result = spawnSync('bash', [path.join(__dirname, '..', 'python-runtime.sh'), script, 'metadata', combinedPdfFile,
        '--index-url', provider.indexUrl, '--pdf-url', provider.combinedPdfUrl], {
        cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error || result.status !== 0) {
        const reason = String(result.stderr || result.error?.message || 'metadata extractor failed')
            .replace(/[^A-Za-z0-9_.: -]/g, '').slice(0, 240);
        fail(`ICMC 合并 proceedings 的元数据提取失败：${reason}`);
    }
    let value;
    try { value = JSON.parse(String(result.stdout || '')); }
    catch { fail('ICMC 合并 proceedings 的元数据提取器返回了无效 JSON'); }
    exact(value, ['metadata', 'pageMap'], 'ICMC metadata extraction result');
    const metadata = normalizeMetadata(value.metadata, provider);
    exact(value.pageMap, ['contract', 'papers', 'sourcePages', 'version'], 'ICMC page map');
    if (value.pageMap.contract !== 'icmc-combined-proceedings-page-map-v1' || value.pageMap.version !== 1
        || !Number.isSafeInteger(value.pageMap.sourcePages) || value.pageMap.sourcePages < 1
        || !Array.isArray(value.pageMap.papers)) fail('ICMC 页码映射的 envelope 无效');
    const expectedIds = metadata.papers.map(paper => paper.id);
    const pageMap = value.pageMap.papers.map((item, index) => {
        exact(item, ['endPage', 'id', 'outlineOrder', 'paperNumber', 'startPage'], `ICMC page map paper[${index}]`);
        if (typeof item.id !== 'string' || !ID_RE.test(item.id) || !Number.isSafeInteger(item.paperNumber)
            || !Number.isSafeInteger(item.outlineOrder) || !Number.isSafeInteger(item.startPage)
            || !Number.isSafeInteger(item.endPage) || item.startPage < 1 || item.startPage > item.endPage
            || item.endPage > value.pageMap.sourcePages) fail('ICMC 页码映射的范围无效');
        return { id: item.id, paperNumber: item.paperNumber, outlineOrder: item.outlineOrder,
            startPage: item.startPage, endPage: item.endPage };
    }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
    if (pageMap.length !== expectedIds.length || pageMap.some((item, index) => item.id !== expectedIds[index])) {
        fail('ICMC 页码映射与提取出的论文集合不匹配');
    }
    return { metadata, pageMap: { contract: value.pageMap.contract, version: value.pageMap.version,
        sourcePages: value.pageMap.sourcePages, papers: pageMap } };
}

function icmcCatalogReceipt(provider, indexSnapshot, combinedSnapshot, metadataBytes, pageMapBytes) {
    const body = { contract: CATALOG_RECEIPT_CONTRACT, version: VERSION, providerId: provider.conference.id,
        parserVersion: PARSER_VERSION, indexReceiptSha256: indexSnapshot.receipt.receiptSha256,
        indexReceiptFileSha256: indexSnapshot.receiptFileSha256,
        combinedPdfReceiptSha256: combinedSnapshot.receipt.receiptSha256,
        combinedPdfReceiptFileSha256: combinedSnapshot.receiptFileSha256,
        metadata: { relativePath: 'metadata.json', bytes: metadataBytes.length, sha256: sha256(metadataBytes) },
        pageMap: { relativePath: 'page-map.json', bytes: pageMapBytes.length, sha256: sha256(pageMapBytes) },
        paperSetSha256: stableHash(JSON.parse(metadataBytes.toString('utf8')).papers) };
    return { ...body, receiptSha256: stableHash(body) };
}

function replayIssueReceipt(provider, paths, issue) {
    const artifacts = issueArtifactPaths(paths, issue, false);
    return { ...replayResponseReceipt(provider, artifacts.responseFile, artifacts.receiptFile,
        artifacts.responseRelativePath, issue), artifacts, issue };
}

function catalogReceipt(provider, indexSnapshot, metadataBytes) {
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    const body = { contract: CATALOG_RECEIPT_CONTRACT, version: VERSION, providerId: provider.conference.id,
        parserVersion: PARSER_VERSION, indexReceiptSha256: indexSnapshot.receipt.receiptSha256,
        indexReceiptFileSha256: indexSnapshot.receiptFileSha256,
        metadata: { relativePath: 'metadata.json', bytes: metadataBytes.length, sha256: sha256(metadataBytes) },
        paperSetSha256: stableHash(metadata.papers) };
    return { ...body, receiptSha256: stableHash(body) };
}

function combineAaaiIssueSnapshots(provider, snapshots) {
    if (snapshots.length !== provider.issues.length) fail('AAAI catalog 未包含全部 48 份固定期号');
    const papers = []; const owner = new Map(); const issuePaperSets = [];
    for (let index = 0; index < provider.issues.length; index += 1) {
        const issue = provider.issues[index]; const snapshot = snapshots[index];
        if (snapshot.issue !== issue) fail('AAAI 期号快照顺序与固定清单不一致');
        const issuePapers = parseAaaiIssue(provider, issue,
            new TextDecoder('utf-8', { fatal: true }).decode(snapshot.index.bytes));
        for (const paper of issuePapers) {
            const previous = owner.get(paper.id);
            if (previous) fail(`duplicate official paper ID across AAAI issues ${previous} and ${issue.number}: ${paper.id}`);
            owner.set(paper.id, issue.number); papers.push(paper);
        }
        issuePaperSets.push({ issue, papers: issuePapers });
    }
    return { metadata: normalizeMetadata({ conference: clone(provider.conference), papers }, provider), issuePaperSets };
}

function multiIssueCatalogReceipt(provider, snapshots, issuePaperSets, metadataBytes) {
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    const issues = snapshots.map((snapshot, index) => ({
        number: snapshot.issue.number,
        issueId: snapshot.issue.issueId,
        url: snapshot.issue.url,
        indexSha256: snapshot.index.sha256,
        indexReceiptSha256: snapshot.receipt.receiptSha256,
        indexReceiptFileSha256: snapshot.receiptFileSha256,
        papers: issuePaperSets[index].papers.length,
        paperSetSha256: stableHash(issuePaperSets[index].papers)
    }));
    const issueManifest = provider.issues.map(issue => ({ number: issue.number, issueId: issue.issueId,
        title: issue.title, url: issue.url }));
    const body = { contract: CATALOG_RECEIPT_CONTRACT, version: VERSION, providerId: provider.conference.id,
        parserVersion: PARSER_VERSION, issueManifestSha256: stableHash(issueManifest), issues,
        metadata: { relativePath: 'metadata.json', bytes: metadataBytes.length, sha256: sha256(metadataBytes) },
        paperSetSha256: stableHash(metadata.papers) };
    return { ...body, receiptSha256: stableHash(body) };
}

function replayIcmcCatalog(provider, paths) {
    const indexSnapshot = replayIndexReceipt(provider, paths);
    const combinedSnapshot = replayIcmcCombinedReceipt(provider, paths);
    const metadataLoaded = readCanonicalJson(paths.metadataFile, 'ICMC proceedings metadata', MAX_INDEX_BYTES);
    const pageMapLoaded = readCanonicalJson(paths.pageMapFile, 'ICMC proceedings page map', MAX_INDEX_BYTES);
    const extracted = runIcmcMetadataExtractor(paths.combinedPdfFile, provider);
    const expectedMetadataBytes = prettyBytes(extracted.metadata);
    const expectedPageMapBytes = prettyBytes(extracted.pageMap);
    if (!metadataLoaded.bytes.equals(expectedMetadataBytes)) fail('ICMC 元数据与合并 proceedings PDF 不一致');
    if (!pageMapLoaded.bytes.equals(expectedPageMapBytes)) fail('ICMC 页码映射与合并 proceedings PDF 不一致');
    const catalogLoaded = readCanonicalJson(paths.catalogReceiptFile, 'ICMC catalog receipt', 1024 * 1024);
    const receipt = catalogLoaded.value;
    exact(receipt, ['combinedPdfReceiptFileSha256', 'combinedPdfReceiptSha256', 'contract',
        'indexReceiptFileSha256', 'indexReceiptSha256', 'metadata', 'pageMap', 'paperSetSha256',
        'parserVersion', 'providerId', 'receiptSha256', 'version'], 'ICMC catalog receipt');
    const expected = icmcCatalogReceipt(provider, indexSnapshot, combinedSnapshot,
        metadataLoaded.bytes, pageMapLoaded.bytes);
    if (!catalogLoaded.bytes.equals(prettyBytes(expected))) fail('ICMC catalog receipt 与其来源 bundle 不一致');
    return { provider, paths, metadata: extracted.metadata, pageMap: extracted.pageMap,
        metadataSha256: metadataLoaded.sha256, receipt, combinedSnapshot };
}

function replayCatalog(providerId, outputRoot) {
    const provider = providerFor(providerId); const paths = acquisitionPaths(outputRoot, false);
    if (provider.parser === 'icmc-combined') return replayIcmcCatalog(provider, paths);
    if (provider.issues) {
        const snapshots = provider.issues.map(issue => replayIssueReceipt(provider, paths, issue));
        const combined = combineAaaiIssueSnapshots(provider, snapshots);
        const metadataLoaded = readCanonicalJson(paths.metadataFile, 'official proceedings metadata', MAX_INDEX_BYTES);
        if (!metadataLoaded.bytes.equals(prettyBytes(combined.metadata))) fail('metadata 与重放出的完整 AAAI 期号集合不一致');
        const catalogLoaded = readCanonicalJson(paths.catalogReceiptFile, 'catalog receipt', 1024 * 1024);
        const receipt = catalogLoaded.value;
        exact(receipt, ['contract', 'issueManifestSha256', 'issues', 'metadata', 'paperSetSha256',
            'parserVersion', 'providerId', 'receiptSha256', 'version'], 'multi-issue catalog receipt');
        const expected = multiIssueCatalogReceipt(provider, snapshots, combined.issuePaperSets, metadataLoaded.bytes);
        if (!catalogLoaded.bytes.equals(prettyBytes(expected))) fail('catalog receipt 与重放出的完整 AAAI catalog 不一致');
        return { provider, paths, metadata: combined.metadata, metadataSha256: metadataLoaded.sha256, receipt };
    }
    const indexSnapshot = replayIndexReceipt(provider, paths);
    const metadataLoaded = readCanonicalJson(paths.metadataFile, 'official proceedings metadata', MAX_INDEX_BYTES);
    const metadata = normalizeMetadata(metadataLoaded.value, provider);
    if (!metadataLoaded.bytes.equals(prettyBytes(metadata))) fail('metadata 字节与规范化 schema 不一致');
    const replayed = parseCatalog(providerId, new TextDecoder('utf-8', { fatal: true }).decode(indexSnapshot.index.bytes));
    if (!prettyBytes(replayed).equals(metadataLoaded.bytes)) fail('metadata 与重放出的官方 index 不一致');
    const catalogLoaded = readCanonicalJson(paths.catalogReceiptFile, 'catalog receipt', 1024 * 1024);
    const receipt = catalogLoaded.value;
    exact(receipt, ['contract', 'indexReceiptFileSha256', 'indexReceiptSha256', 'metadata', 'paperSetSha256',
        'parserVersion', 'providerId', 'receiptSha256', 'version'], 'catalog receipt');
    const expected = catalogReceipt(provider, indexSnapshot, metadataLoaded.bytes);
    if (!catalogLoaded.bytes.equals(prettyBytes(expected))) fail('catalog receipt 与重放出的 catalog 不一致');
    return { provider, paths, metadata, metadataSha256: metadataLoaded.sha256, receipt };
}

async function readResponseBytes(response, maxBytes, label) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) fail(`${label} exceeds the byte limit`);
    if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > maxBytes) fail(`${label} 为空或超过字节上限`);
        return bytes;
    }
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            const chunk = Buffer.from(value); total += chunk.length;
            if (total > maxBytes) { await reader.cancel(); fail(`${label} exceeds the byte limit`); }
            chunks.push(chunk);
        }
    } finally { reader.releaseLock?.(); }
    if (!total) fail(`${label} 为空`);
    return Buffer.concat(chunks, total);
}

async function fetchOfficial({ provider, url, kind, maxBytes, timeoutMs = REQUEST_TIMEOUT_MS }, dependencies = {}) {
    const proxyUrl = (dependencies.detectProxy || detectHttpConnectProxyUrl)();
    if (!proxyUrl) fail('project HTTP CONNECT proxy is required');
    const dispatcher = (dependencies.createDispatcher || createProxyDispatcher)(proxyUrl);
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') fail('fetch 不可用');
    const requestedUrl = validateFetchUrl(provider, url, kind); let current = requestedUrl; const redirects = [];
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    try {
        for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
            const response = await fetchImpl(current, { method: 'GET', redirect: 'manual', dispatcher,
                signal: controller.signal, headers: { Accept: kind === 'pdf' ? 'application/pdf' : 'text/html,application/xhtml+xml',
                    'User-Agent': 'audio-paper-digest-official-conference/1.0' } });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                if (count >= MAX_REDIRECTS) fail('官方响应超过重定向上限');
                const location = response.headers?.get?.('location'); if (!location) fail('官方重定向没有 Location');
                const next = validateRedirectTarget(provider, current, new URL(location, current).toString(), kind);
                redirects.push({ from: current, to: next, status: response.status }); current = next;
                try { await response.body?.cancel?.(); } catch { /* 忽略重定向响应体 */ }
                continue;
            }
            if (response.status !== 200) fail(`official ${kind} returned HTTP ${response.status}`);
            const contentType = String(response.headers?.get?.('content-type') || '').trim();
            if (kind === 'pdf' ? !/^(?:application\/pdf|application\/octet-stream)(?:\s*;|$)/iu.test(contentType)
                : !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(contentType)) {
                fail(`官方 ${kind} 响应的 Content-Type 无效`);
            }
            const bytes = await readResponseBytes(response, maxBytes, `official ${kind} response`);
            if (kind === 'pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') fail('官方 PDF 响应缺少 PDF 文件头');
            const observedAt = (dependencies.now || (() => new Date().toISOString()))();
            if (!validObservedAt(observedAt)) fail('observedAt 无效');
            return { bytes, requestedUrl, finalUrl: current, redirects, responseStatus: response.status,
                contentType, observedAt };
        }
        fail('官方响应超过重定向上限');
    } catch (error) {
        if (error instanceof OfficialConferenceAcquisitionError) throw error;
        if (error?.name === 'AbortError') fail(`official ${kind} request timed out`);
        const reason = String(error?.cause?.code || error?.code || error?.message || 'network error')
            .replace(/[^A-Za-z0-9_.: -]/g, '').slice(0, 160);
        fail(`official ${kind} request failed: ${reason}`);
    } finally { clearTimeout(timer); }
}

async function acquireMultiIssueCatalog(provider, outputRoot, dependencies) {
    const paths = acquisitionPaths(outputRoot, true);
    issueArtifactPaths(paths, provider.issues[0], true);
    const snapshots = []; const writes = { issueResponsesCreated: 0, issueResponsesRecovered: 0,
        issueReceiptsCreated: 0, issueReceiptsRecovered: 0 };
    for (const issue of provider.issues) {
        const artifacts = issueArtifactPaths(paths, issue, false);
        const rawPresent = fs.existsSync(artifacts.responseFile);
        const receiptPresent = fs.existsSync(artifacts.receiptFile);
        if (receiptPresent && !rawPresent) fail(`AAAI 期号 ${issue.number} 的 receipt 存在，却没有对应响应字节`);
        if (rawPresent && receiptPresent) {
            snapshots.push(replayIssueReceipt(provider, paths, issue));
            writes.issueResponsesRecovered += 1; writes.issueReceiptsRecovered += 1;
            continue;
        }
        const fetched = await fetchOfficial({ provider, url: issue.url, kind: 'index', maxBytes: MAX_INDEX_BYTES }, dependencies);
        const responseStatus = writeExclusiveOrCompare(artifacts.responseFile, fetched.bytes,
            `AAAI issue ${issue.number} response`, MAX_INDEX_BYTES);
        const receipt = responseReceipt(provider, fetched, artifacts.responseRelativePath, issue);
        const receiptStatus = writeExclusiveOrCompare(artifacts.receiptFile, prettyBytes(receipt),
            `AAAI issue ${issue.number} response receipt`, 1024 * 1024);
        writes[`issueResponses${responseStatus === 'created' ? 'Created' : 'Recovered'}`] += 1;
        writes[`issueReceipts${receiptStatus === 'created' ? 'Created' : 'Recovered'}`] += 1;
        snapshots.push(replayIssueReceipt(provider, paths, issue));
    }
    const combined = combineAaaiIssueSnapshots(provider, snapshots);
    const metadataBytes = prettyBytes(combined.metadata);
    writes.metadata = writeExclusiveOrCompare(paths.metadataFile, metadataBytes,
        'official proceedings metadata', MAX_INDEX_BYTES);
    const catalog = multiIssueCatalogReceipt(provider, snapshots, combined.issuePaperSets, metadataBytes);
    writes.catalogReceipt = writeExclusiveOrCompare(paths.catalogReceiptFile, prettyBytes(catalog),
        'catalog receipt', 1024 * 1024);
    replayCatalog(provider.conference.id, outputRoot);
    return { command: 'catalog', mode: 'apply', providerId: provider.conference.id, outputRoot,
        issues: provider.issues.length, papers: combined.metadata.papers.length, writes,
        metadataSha256: sha256(metadataBytes), catalogReceiptSha256: catalog.receiptSha256 };
}

async function acquireIcmcCatalog(provider, outputRoot, dependencies) {
    const paths = acquisitionPaths(outputRoot, true);
    const rawPresent = fs.existsSync(paths.indexFile); const receiptPresent = fs.existsSync(paths.indexReceiptFile);
    if (receiptPresent && !rawPresent) fail('ICMC index receipt 存在，却没有对应响应字节');
    let indexSnapshot; let indexStatus = 'recovered'; let receiptStatus = 'recovered';
    if (rawPresent && receiptPresent) indexSnapshot = replayIndexReceipt(provider, paths);
    else {
        const fetched = await fetchOfficial({ provider, url: provider.indexUrl, kind: 'index', maxBytes: MAX_INDEX_BYTES }, dependencies);
        indexStatus = writeExclusiveOrCompare(paths.indexFile, fetched.bytes, 'ICMC proceedings index response', MAX_INDEX_BYTES);
        const receipt = responseReceipt(provider, fetched, 'responses/index.html');
        receiptStatus = writeExclusiveOrCompare(paths.indexReceiptFile, prettyBytes(receipt),
            'ICMC proceedings index response receipt', 1024 * 1024);
        indexSnapshot = replayIndexReceipt(provider, paths);
    }
    const combinedPresent = fs.existsSync(paths.combinedPdfFile); const combinedReceiptPresent = fs.existsSync(paths.combinedPdfReceiptFile);
    if (combinedReceiptPresent && !combinedPresent) fail('ICMC 合并 proceedings receipt 存在，却没有对应 PDF');
    let combinedSnapshot; let combinedStatus = 'recovered'; let combinedReceiptStatus = 'recovered';
    if (combinedPresent && combinedReceiptPresent) combinedSnapshot = replayIcmcCombinedReceipt(provider, paths);
    else {
        const fetched = await fetchOfficial({ provider, url: provider.combinedPdfUrl, kind: 'pdf', maxBytes: MAX_COMBINED_PDF_BYTES }, dependencies);
        combinedStatus = writeExclusiveOrCompare(paths.combinedPdfFile, fetched.bytes,
            'ICMC combined proceedings PDF', MAX_COMBINED_PDF_BYTES);
        const receipt = icmcCombinedResponseReceipt(provider, fetched);
        combinedReceiptStatus = writeExclusiveOrCompare(paths.combinedPdfReceiptFile, prettyBytes(receipt),
            'ICMC combined proceedings PDF receipt', 1024 * 1024);
        combinedSnapshot = replayIcmcCombinedReceipt(provider, paths);
    }
    const extracted = runIcmcMetadataExtractor(paths.combinedPdfFile, provider);
    const metadataBytes = prettyBytes(extracted.metadata); const pageMapBytes = prettyBytes(extracted.pageMap);
    const metadataStatus = writeExclusiveOrCompare(paths.metadataFile, metadataBytes, 'ICMC proceedings metadata', MAX_INDEX_BYTES);
    const pageMapStatus = writeExclusiveOrCompare(paths.pageMapFile, pageMapBytes, 'ICMC proceedings page map', MAX_INDEX_BYTES);
    const catalog = icmcCatalogReceipt(provider, indexSnapshot, combinedSnapshot, metadataBytes, pageMapBytes);
    const catalogStatus = writeExclusiveOrCompare(paths.catalogReceiptFile, prettyBytes(catalog), 'ICMC catalog receipt', 1024 * 1024);
    replayCatalog(provider.conference.id, outputRoot);
    return { command: 'catalog', mode: 'apply', providerId: provider.conference.id, outputRoot,
        papers: extracted.metadata.papers.length, sourcePages: extracted.pageMap.sourcePages,
        writes: { index: indexStatus, indexReceipt: receiptStatus, combinedPdf: combinedStatus,
            combinedPdfReceipt: combinedReceiptStatus, metadata: metadataStatus, pageMap: pageMapStatus,
            catalogReceipt: catalogStatus }, metadataSha256: sha256(metadataBytes), catalogReceiptSha256: catalog.receiptSha256 };
}

async function acquireCatalog({ providerId, outputRoot, apply = false } = {}, dependencies = {}) {
    const provider = providerFor(providerId); plannedRoot(outputRoot);
    if (provider.parser === 'icmc-combined' && !apply) return { command: 'catalog', mode: 'dry-run', providerId, outputRoot,
        indexUrl: provider.indexUrl, combinedPdfUrl: provider.combinedPdfUrl,
        writes: ['responses/index.html', 'responses/index.receipt.json', 'responses/proceedings.source',
            'responses/proceedings.receipt.json', 'metadata.json', 'page-map.json', 'catalog.receipt.json'] };
    if (provider.issues && !apply) return { command: 'catalog', mode: 'dry-run', providerId, outputRoot,
        archiveUrl: provider.archiveUrl, issueCount: provider.issues.length,
        indexUrls: provider.issues.map(issue => issue.url),
        writes: { issueResponses: provider.issues.length, issueReceipts: provider.issues.length,
            metadata: 'metadata.json', catalogReceipt: 'catalog.receipt.json' } };
    if (!apply) return { command: 'catalog', mode: 'dry-run', providerId, outputRoot,
        indexUrl: provider.indexUrl, writes: ['responses/index.html', 'responses/index.receipt.json',
            'metadata.json', 'catalog.receipt.json'] };
    if (provider.parser === 'icmc-combined') return acquireIcmcCatalog(provider, outputRoot, dependencies);
    if (provider.issues) return acquireMultiIssueCatalog(provider, outputRoot, dependencies);
    const paths = acquisitionPaths(outputRoot, true);
    const rawPresent = fs.existsSync(paths.indexFile); const receiptPresent = fs.existsSync(paths.indexReceiptFile);
    if (receiptPresent && !rawPresent) fail('index receipt 存在，却没有对应响应字节');
    let indexSnapshot; let indexStatus = 'recovered'; let receiptStatus = 'recovered';
    if (rawPresent && receiptPresent) indexSnapshot = replayIndexReceipt(provider, paths);
    else {
        const fetched = await fetchOfficial({ provider, url: provider.indexUrl, kind: 'index', maxBytes: MAX_INDEX_BYTES }, dependencies);
        indexStatus = writeExclusiveOrCompare(paths.indexFile, fetched.bytes, 'index response', MAX_INDEX_BYTES);
        const receipt = responseReceipt(provider, fetched, 'responses/index.html');
        receiptStatus = writeExclusiveOrCompare(paths.indexReceiptFile, prettyBytes(receipt), 'index response receipt', 1024 * 1024);
        indexSnapshot = replayIndexReceipt(provider, paths);
    }
    const metadata = parseCatalog(providerId, new TextDecoder('utf-8', { fatal: true }).decode(indexSnapshot.index.bytes));
    const metadataBytes = prettyBytes(metadata);
    const metadataStatus = writeExclusiveOrCompare(paths.metadataFile, metadataBytes, 'official proceedings metadata', MAX_INDEX_BYTES);
    const catalog = catalogReceipt(provider, indexSnapshot, metadataBytes);
    const catalogStatus = writeExclusiveOrCompare(paths.catalogReceiptFile, prettyBytes(catalog), 'catalog receipt', 1024 * 1024);
    replayCatalog(providerId, outputRoot);
    return { command: 'catalog', mode: 'apply', providerId, outputRoot, papers: metadata.papers.length,
        writes: { index: indexStatus, indexReceipt: receiptStatus, metadata: metadataStatus, catalogReceipt: catalogStatus },
        metadataSha256: sha256(metadataBytes), catalogReceiptSha256: catalog.receiptSha256 };
}

function pdfReceiptPath(paths, paper) {
    if (!ID_RE.test(paper.id)) fail('论文 ID 不适合用作 receipt 文件名');
    return path.join(paths.receipts, `${paper.id}.json`);
}

function pdfPath(paths, paper) {
    const expected = `pdfs/${paper.id}.pdf`;
    if (paper.pdfFile !== expected) fail('论文 PDF 路径不规范');
    const filename = path.resolve(paths.root, paper.pdfFile);
    if (path.dirname(filename) !== paths.pdfs) fail('论文 PDF 路径超出 output root');
    return filename;
}

function icmcPageRange(catalog, paper) {
    if (!Array.isArray(catalog.pageMap?.papers)) fail(`缺少 ${paper.id} 的 ICMC 页码映射`);
    const range = catalog.pageMap.papers.find(item => item.id === paper.id);
    if (!range) fail(`${paper.id} 的 ICMC 页码映射没有范围`);
    return range;
}

function icmcPdfReceipt(catalog, paper, pdf, range) {
    const combined = catalog.combinedSnapshot;
    const body = { contract: PDF_RECEIPT_CONTRACT, version: VERSION, providerId: catalog.provider.conference.id,
        paperId: paper.id, metadataSha256: catalog.metadataSha256, requestedUrl: paper.pdfUrl,
        finalUrl: paper.pdfUrl, redirects: [], responseStatus: 200, contentType: 'application/pdf',
        observedAt: combined.receipt.observedAt,
        pdf: { relativePath: paper.pdfFile, bytes: pdf.length, sha256: sha256(pdf) },
        derivation: { contract: 'icmc-combined-paper-slice-v1', version: 1,
            sourceReceiptSha256: combined.receipt.receiptSha256,
            sourceRelativePath: 'responses/proceedings.source', sourceSha256: combined.receipt.body.sha256,
            startPage: range.startPage, endPage: range.endPage } };
    return { ...body, receiptSha256: stableHash(body) };
}

function replayIcmcPdfReceipt(catalog, paper) {
    const filename = pdfReceiptPath(catalog.paths, paper);
    const loaded = readCanonicalJson(filename, `${paper.id} ICMC PDF receipt`, 1024 * 1024);
    const receipt = loaded.value;
    exact(receipt, ['contentType', 'contract', 'derivation', 'finalUrl', 'metadataSha256', 'observedAt', 'paperId',
        'pdf', 'providerId', 'receiptSha256', 'redirects', 'requestedUrl', 'responseStatus', 'version'],
        'ICMC PDF receipt');
    if (receipt.contract !== PDF_RECEIPT_CONTRACT || receipt.version !== VERSION
        || receipt.providerId !== catalog.provider.conference.id || receipt.paperId !== paper.id
        || receipt.metadataSha256 !== catalog.metadataSha256 || receipt.requestedUrl !== paper.pdfUrl
        || receipt.finalUrl !== paper.pdfUrl || receipt.responseStatus !== 200 || !validObservedAt(receipt.observedAt)
        || receipt.contentType !== 'application/pdf') fail(`${paper.id} 的 ICMC PDF receipt envelope 无效`);
    const body = { ...receipt }; delete body.receiptSha256;
    if (!SHA_RE.test(receipt.receiptSha256) || receipt.receiptSha256 !== stableHash(body)) fail(`${paper.id} 的 ICMC PDF receipt 自校验 SHA 已变化`);
    validateRedirects(catalog.provider, receipt, 'pdf');
    exact(receipt.pdf, ['bytes', 'relativePath', 'sha256'], 'ICMC PDF byte binding');
    if (receipt.pdf.relativePath !== paper.pdfFile || !Number.isSafeInteger(receipt.pdf.bytes)
        || receipt.pdf.bytes < 5 || receipt.pdf.bytes > MAX_PDF_BYTES || !SHA_RE.test(receipt.pdf.sha256)) {
        fail(`${paper.id} 的 ICMC PDF 字节绑定无效`);
    }
    exact(receipt.derivation, ['contract', 'endPage', 'sourceReceiptSha256', 'sourceRelativePath', 'sourceSha256',
        'startPage', 'version'], 'ICMC PDF derivation');
    const range = icmcPageRange(catalog, paper); const combined = catalog.combinedSnapshot;
    if (receipt.derivation.contract !== 'icmc-combined-paper-slice-v1' || receipt.derivation.version !== 1
        || receipt.derivation.sourceReceiptSha256 !== combined.receipt.receiptSha256
        || receipt.derivation.sourceRelativePath !== 'responses/proceedings.source'
        || receipt.derivation.sourceSha256 !== combined.receipt.body.sha256
        || receipt.derivation.startPage !== range.startPage || receipt.derivation.endPage !== range.endPage) {
        fail(`${paper.id} 的 ICMC PDF 派生结果与合并来源不匹配`);
    }
    const pdf = readStableFile(pdfPath(catalog.paths, paper), `${paper.id} sealed ICMC PDF`, MAX_PDF_BYTES);
    if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || pdf.size !== receipt.pdf.bytes
        || pdf.sha256 !== receipt.pdf.sha256) fail(`${paper.id} 已封存的 ICMC PDF 与其 receipt 不一致`);
    return receipt;
}

function replayPdfReceipt(catalog, paper) {
    if (catalog.provider.parser === 'icmc-combined') return replayIcmcPdfReceipt(catalog, paper);
    const filename = pdfReceiptPath(catalog.paths, paper);
    const loaded = readCanonicalJson(filename, `${paper.id} PDF receipt`, 1024 * 1024); const receipt = loaded.value;
    exact(receipt, ['contentType', 'contract', 'finalUrl', 'metadataSha256', 'observedAt', 'paperId', 'pdf',
        'providerId', 'receiptSha256', 'redirects', 'requestedUrl', 'responseStatus', 'version'], 'PDF receipt');
    if (receipt.contract !== PDF_RECEIPT_CONTRACT || receipt.version !== VERSION
        || receipt.providerId !== catalog.provider.conference.id || receipt.paperId !== paper.id
        || receipt.metadataSha256 !== catalog.metadataSha256 || receipt.requestedUrl !== paper.pdfUrl
        || receipt.responseStatus !== 200 || !validObservedAt(receipt.observedAt)
        || !/^(?:application\/pdf|application\/octet-stream)(?:\s*;|$)/iu.test(receipt.contentType)) {
        fail(`${paper.id} 的 PDF receipt envelope 无效`);
    }
    const body = { ...receipt }; delete body.receiptSha256;
    if (!SHA_RE.test(receipt.receiptSha256) || receipt.receiptSha256 !== stableHash(body)) fail(`${paper.id} 的 PDF receipt 自校验 SHA 已变化`);
    validateRedirects(catalog.provider, receipt, 'pdf');
    exact(receipt.pdf, ['bytes', 'relativePath', 'sha256'], 'PDF byte binding');
    if (receipt.pdf.relativePath !== paper.pdfFile || !Number.isSafeInteger(receipt.pdf.bytes)
        || receipt.pdf.bytes < 5 || receipt.pdf.bytes > MAX_PDF_BYTES || !SHA_RE.test(receipt.pdf.sha256)) {
        fail(`${paper.id} 的 PDF 字节绑定无效`);
    }
    const pdf = readStableFile(pdfPath(catalog.paths, paper), `${paper.id} sealed PDF`, MAX_PDF_BYTES);
    if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || pdf.size !== receipt.pdf.bytes
        || pdf.sha256 !== receipt.pdf.sha256) fail(`${paper.id} sealed PDF differs from receipt`);
    return receipt;
}

function splitIcmcPapers(catalog, papers) {
    // macOS 常把 /tmp 暴露成符号链接。获取读取器有意拒绝父目录是符号链接的情况，
    // 所以临时目录建在解析后的系统临时目录下面。
    const temporaryParent = fs.realpathSync(os.tmpdir());
    const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'audio-paper-digest-icmc-'));
    try {
        const script = path.join(__dirname, '..', 'icmc-proceedings.py');
        const result = spawnSync('bash', [path.join(__dirname, '..', 'python-runtime.sh'), script, 'split',
            catalog.paths.combinedPdfFile, catalog.paths.pageMapFile, temporaryRoot], {
            cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        if (result.error || result.status !== 0) {
            const reason = String(result.stderr || result.error?.message || 'ICMC PDF splitter failed')
                .replace(/[^A-Za-z0-9_.: -]/g, '').slice(0, 240);
            fail(`ICMC 合并 proceedings 拆分失败：${reason}`);
        }
        const output = JSON.parse(String(result.stdout || '{}'));
        if (!Array.isArray(output.written) || output.total !== catalog.metadata.papers.length) {
            fail('ICMC PDF 拆分器返回了无效结果');
        }
        return papers.map(paper => readStableFile(path.join(temporaryRoot, `${paper.id}.pdf`),
            `${paper.id} derived ICMC PDF`, MAX_PDF_BYTES).bytes);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

function icmcDownloadPapers({ providerId, outputRoot, apply = false, limit = null, concurrency = 1, retries = 0 } = {}) {
    const catalog = replayCatalog(providerId, outputRoot);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) fail('limit 必须是正整数');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) fail('concurrency 必须是 1 到 5 的整数');
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) fail('retries 必须是 0 到 5 的整数');
    const before = acquisitionStatus({ providerId, outputRoot });
    if (!apply) return { command: 'download', mode: 'dry-run', providerId, outputRoot,
        total: catalog.metadata.papers.length, downloaded: before.downloaded, pending: before.missing,
        limit, concurrency: 1, retries };
    const pending = catalog.metadata.papers.filter(paper => {
        const target = pdfPath(catalog.paths, paper); const receipt = pdfReceiptPath(catalog.paths, paper);
        const targetPresent = fs.existsSync(target); const receiptPresent = fs.existsSync(receipt);
        if (targetPresent && receiptPresent) { replayIcmcPdfReceipt(catalog, paper); return false; }
        // 中断的凭证迁移之后，派生出的 PDF 可能还在。只有确定性切分重新产出同样的字节，
        // 才能重建它的凭证；有凭证却没有 PDF 仍然是硬失败。
        if (receiptPresent && !targetPresent) fail(`${paper.id} 的 ICMC PDF 与 receipt 只存在一半`);
        return true;
    }).slice(0, limit === null ? undefined : limit);
    const derived = splitIcmcPapers(catalog, pending);
    let created = 0; let recovered = 0;
    for (let index = 0; index < pending.length; index += 1) {
        const paper = pending[index]; const target = pdfPath(catalog.paths, paper);
        const receiptFile = pdfReceiptPath(catalog.paths, paper); const range = icmcPageRange(catalog, paper);
        const pdfStatus = writeExclusiveOrCompare(target, derived[index], `${paper.id} ICMC PDF`, MAX_PDF_BYTES);
        const receipt = icmcPdfReceipt(catalog, paper, derived[index], range);
        writeExclusiveOrCompare(receiptFile, prettyBytes(receipt), `${paper.id} ICMC PDF receipt`, 1024 * 1024);
        replayIcmcPdfReceipt(catalog, paper);
        if (pdfStatus === 'created') created += 1; else recovered += 1;
    }
    const after = acquisitionStatus({ providerId, outputRoot });
    return { command: 'download', mode: 'apply', providerId, outputRoot,
        total: catalog.metadata.papers.length, created, recovered, downloaded: after.downloaded,
        missing: after.missing, complete: after.complete, concurrency: 1, retries };
}

function icmcAcquisitionStatus(provider, outputRoot) {
    const paths = acquisitionPaths(outputRoot, false);
    const catalogFiles = [paths.indexFile, paths.indexReceiptFile, paths.combinedPdfFile,
        paths.combinedPdfReceiptFile, paths.metadataFile, paths.pageMapFile, paths.catalogReceiptFile];
    const present = catalogFiles.filter(filename => fs.existsSync(filename)).length;
    if (present !== catalogFiles.length) return { command: 'status', providerId: provider.conference.id, outputRoot,
        catalog: present ? 'partial' : 'missing', total: 0, downloadable: 0, downloaded: 0, missing: 0,
        partial: present, complete: false };
    const catalog = replayCatalog(provider.conference.id, outputRoot);
    let downloaded = 0; let partial = 0; let missing = 0;
    for (const paper of catalog.metadata.papers) {
        const hasPdf = fs.existsSync(pdfPath(paths, paper)); const hasReceipt = fs.existsSync(pdfReceiptPath(paths, paper));
        if (hasPdf && hasReceipt) { replayIcmcPdfReceipt(catalog, paper); downloaded += 1; }
        else if (hasPdf || hasReceipt) partial += 1;
        else missing += 1;
    }
    return { command: 'status', providerId: provider.conference.id, outputRoot, catalog: 'complete',
        total: catalog.metadata.papers.length, downloadable: catalog.metadata.papers.length,
        downloaded, missing, partial, complete: missing === 0 && partial === 0,
        sourcePages: catalog.pageMap.sourcePages };
}

async function downloadPapers({ providerId, outputRoot, apply = false, limit = null, concurrency = 1, retries = 0 } = {}, dependencies = {}) {
    const catalog = replayCatalog(providerId, outputRoot);
    if (catalog.provider.parser === 'icmc-combined') {
        return icmcDownloadPapers({ providerId, outputRoot, apply, limit, concurrency, retries });
    }
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) fail('limit 必须是正整数');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) fail('concurrency 必须是 1 到 5 的整数');
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) fail('retries 必须是 0 到 5 的整数');
    const downloadable = catalog.metadata.papers.filter(paper => paper.pdfUrl !== null);
    const before = acquisitionStatus({ providerId, outputRoot });
    if (!apply) return { command: 'download', mode: 'dry-run', providerId, outputRoot,
        total: downloadable.length, downloaded: before.downloaded, pending: before.missing, limit, concurrency, retries };
    let created = 0; let recovered = 0; let attempted = 0; let cursor = 0; let firstError = null;
    const processPaper = async paper => {
        const target = pdfPath(catalog.paths, paper); const receiptFile = pdfReceiptPath(catalog.paths, paper);
        const targetPresent = fs.existsSync(target); const receiptPresent = fs.existsSync(receiptFile);
        if (receiptPresent && !targetPresent) fail(`${paper.id} 的 receipt 存在，却没有对应 PDF`);
        if (targetPresent && receiptPresent) { replayPdfReceipt(catalog, paper); recovered += 1; return; }
        if (limit !== null && attempted >= limit) return;
        attempted += 1;
        let fetched;
        for (let retry = 0; ; retry += 1) {
            try {
                fetched = await fetchOfficial({ provider: catalog.provider, url: paper.pdfUrl,
                    kind: 'pdf', maxBytes: MAX_PDF_BYTES }, dependencies);
                break;
            } catch (error) {
                const transient = /request failed|request timed out|HTTP (?:429|5\d\d)/u.test(String(error?.message || ''));
                if (!transient || retry >= retries) throw error;
                const delay = Math.min(8000, 500 * (2 ** retry));
                await (dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
            }
        }
        const pdfStatus = writeExclusiveOrCompare(target, fetched.bytes, `${paper.id} PDF`, MAX_PDF_BYTES);
        const receipt = pdfReceipt(catalog.provider, paper, fetched, catalog.metadataSha256);
        writeExclusiveOrCompare(receiptFile, prettyBytes(receipt), `${paper.id} PDF receipt`, 1024 * 1024);
        replayPdfReceipt(catalog, paper);
        if (pdfStatus === 'created') created += 1; else recovered += 1;
    };
    const worker = async () => {
        while (!firstError && cursor < downloadable.length) {
            const paper = downloadable[cursor]; cursor += 1;
            try { await processPaper(paper); } catch (error) { firstError ||= error; }
        }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (firstError) throw firstError;
    const after = acquisitionStatus({ providerId, outputRoot });
    return { command: 'download', mode: 'apply', providerId, outputRoot, total: downloadable.length,
        created, recovered, downloaded: after.downloaded, missing: after.missing, complete: after.complete, concurrency, retries };
}

function acquisitionStatus({ providerId, outputRoot } = {}) {
    const provider = providerFor(providerId); plannedRoot(outputRoot);
    if (provider.parser === 'icmc-combined') return icmcAcquisitionStatus(provider, outputRoot);
    if (!fs.existsSync(outputRoot)) return { command: 'status', providerId, outputRoot, catalog: 'missing',
        total: 0, downloadable: 0, downloaded: 0, missing: 0, partial: 0, complete: false };
    const paths = acquisitionPaths(outputRoot, false);
    const issueFiles = provider.issues ? provider.issues.flatMap(issue => {
        const artifacts = issueArtifactPaths(paths, issue, false);
        return [artifacts.responseFile, artifacts.receiptFile];
    }) : [];
    const catalogFiles = provider.issues
        ? [...issueFiles, paths.metadataFile, paths.catalogReceiptFile]
        : [paths.indexFile, paths.indexReceiptFile, paths.metadataFile, paths.catalogReceiptFile];
    const present = catalogFiles.filter(filename => fs.existsSync(filename)).length;
    if (present !== catalogFiles.length) return { command: 'status', providerId, outputRoot,
        catalog: present ? 'partial' : 'missing', total: 0, downloadable: 0, downloaded: 0,
        missing: 0, partial: present, complete: false,
        ...(provider.issues ? { issuesExpected: provider.issues.length,
            issuesSealed: provider.issues.filter(issue => {
                const artifacts = issueArtifactPaths(paths, issue, false);
                return fs.existsSync(artifacts.responseFile) && fs.existsSync(artifacts.receiptFile);
            }).length } : {}) };
    const catalog = replayCatalog(provider.conference.id, outputRoot);
    let downloaded = 0; let partial = 0; let missing = 0;
    for (const paper of catalog.metadata.papers.filter(item => item.pdfUrl !== null)) {
        const hasPdf = fs.existsSync(pdfPath(paths, paper)); const hasReceipt = fs.existsSync(pdfReceiptPath(paths, paper));
        if (hasPdf && hasReceipt) downloaded += 1;
        else if (hasPdf || hasReceipt) partial += 1;
        else missing += 1;
    }
    return { command: 'status', providerId, outputRoot, catalog: 'complete', total: catalog.metadata.papers.length,
        downloadable: catalog.metadata.papers.filter(item => item.pdfUrl !== null).length,
        downloaded, missing, partial, complete: missing === 0 && partial === 0,
        ...(provider.issues ? { issuesExpected: provider.issues.length, issuesSealed: provider.issues.length } : {}) };
}

function verifyMultiIssueResponseArtifacts(catalog) {
    if (!catalog.provider.issues) return;
    const expected = new Set();
    for (const issue of catalog.provider.issues) {
        const artifacts = issueArtifactPaths(catalog.paths, issue, false);
        expected.add(path.basename(artifacts.responseFile)); expected.add(path.basename(artifacts.receiptFile));
    }
    const entries = fs.readdirSync(catalog.paths.responses, { withFileTypes: true });
    if (entries.length !== 1 || entries[0].name !== 'issues' || !entries[0].isDirectory() || entries[0].isSymbolicLink()) {
        fail('AAAI 响应目录含固定期号集合之外的产物');
    }
    const issueDirectory = path.join(catalog.paths.responses, 'issues');
    for (const entry of fs.readdirSync(issueDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) {
            fail(`出现意外的 AAAI 期号响应产物：${entry.name}`);
        }
        expected.delete(entry.name);
    }
    if (expected.size) fail('AAAI 响应目录缺少固定期号产物');
}

function verifyAcquisition({ providerId, outputRoot } = {}) {
    const catalog = replayCatalog(providerId, outputRoot); const expectedPdfs = new Set(); const expectedReceipts = new Set();
    verifyMultiIssueResponseArtifacts(catalog);
    let verified = 0; const missing = [];
    for (const paper of catalog.metadata.papers.filter(item => item.pdfUrl !== null)) {
        expectedPdfs.add(path.basename(paper.pdfFile)); expectedReceipts.add(`${paper.id}.json`);
        const target = pdfPath(catalog.paths, paper); const receipt = pdfReceiptPath(catalog.paths, paper);
        const hasPdf = fs.existsSync(target); const hasReceipt = fs.existsSync(receipt);
        if (!hasPdf && !hasReceipt) { missing.push(paper.id); continue; }
        if (!hasPdf || !hasReceipt) fail(`${paper.id} 的 PDF 与 receipt 只存在一半`);
        replayPdfReceipt(catalog, paper); verified += 1;
    }
    for (const [directory, expected, label] of [[catalog.paths.pdfs, expectedPdfs, 'PDF'], [catalog.paths.receipts, expectedReceipts, 'receipt']]) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) fail(`出现意外的 ${label} 产物：${entry.name}`);
        }
    }
    return { command: 'verify', providerId, outputRoot, metadataSha256: catalog.metadataSha256,
        catalogReceiptSha256: catalog.receipt.receiptSha256, papers: catalog.metadata.papers.length,
        verified, missing, complete: missing.length === 0 };
}

module.exports = {
    VERSION, HTTP_RECEIPT_CONTRACT, CATALOG_RECEIPT_CONTRACT, PDF_RECEIPT_CONTRACT, PARSER_VERSION,
    MAX_INDEX_BYTES, MAX_PDF_BYTES, MAX_COMBINED_PDF_BYTES, MAX_REDIRECTS, REQUEST_TIMEOUT_MS, AAAI_2026_ISSUES, PROVIDERS,
    OfficialConferenceAcquisitionError, sha256, stableHash, prettyBytes, providerFor, validateFetchUrl,
    validateRedirectTarget,
    normalizeMetadata, parseAaaiIssue, parseCatalog, acquireCatalog, downloadPapers, acquisitionStatus, verifyAcquisition,
    replayCatalog, replayPdfReceipt
};

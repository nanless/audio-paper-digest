'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const cheerio = require('cheerio');
const { detectHttpConnectProxyUrl, createProxyDispatcher } = require('../utils.js');

const VERSION = 1;
const HTTP_RECEIPT_CONTRACT = 'official-conference-http-response-v1';
const CATALOG_RECEIPT_CONTRACT = 'official-conference-catalog-receipt-v1';
const PDF_RECEIPT_CONTRACT = 'official-conference-pdf-receipt-v1';
const PARSER_VERSION = 'official-proceedings-cheerio-v1';
// ACL 2026's official event index contains several thousand records and is
// larger than 16 MiB. Keep one explicit bounded ceiling for sealed indexes.
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 180000;
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const PAPER_FIELDS = ['abstract', 'authors', 'doi', 'id', 'pdfFile', 'pdfUrl', 'recordUrl', 'title', 'track'];

// Volume 40 is published as 48 separate OJS issues. The OJS issue IDs are not
// contiguous (notably issue 6 is 733 and issue 25 is 707), so deriving them or
// following /issue/current would silently produce an incomplete catalog.
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
        parser: 'odyssey'
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
        fail(`${label} schema is invalid`);
    }
}

function cleanText(value, label, { allowEmpty = false, max = 20000 } = {}) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        fail(`${label} is invalid`);
    }
    const normalized = value.replace(/\s+/gu, ' ').trim();
    if (!allowEmpty && !normalized) fail(`${label} is empty`);
    return normalized;
}

function cleanOptional(value, label, max = 2048) {
    return value === null ? null : cleanText(value, label, { max });
}

function canonicalPublicHttps(value, label) {
    const text = cleanText(value, label, { max: 2048 });
    let url;
    try { url = new URL(text); } catch { fail(`${label} is not a URL`); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
        || net.isIP(host) || host === 'localhost' || !host.includes('.')
        || host.endsWith('.local') || host.endsWith('.localhost')) {
        fail(`${label} must be canonical public HTTPS`);
    }
    if (url.toString() !== text) fail(`${label} must use canonical URL spelling`);
    return text;
}

function providerFor(providerId) {
    const provider = PROVIDERS[String(providerId || '')];
    if (!provider) fail(`provider must be one of: ${Object.keys(PROVIDERS).join(', ')}`);
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
    } else fail('unknown URL kind');
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
        try { return decodeURIComponent(new URL(href).pathname.replace(/^\//, '')).trim() || null; } catch { /* fall through */ }
    }
    const match = container.text().match(/\b10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+/u);
    return match ? match[0].replace(/[.,;)]+$/u, '') : null;
}

function makePaper({ id, title, authors = [], abstract = '', pdfUrl, recordUrl = null, doi = null, track = null }) {
    return { id, title, authors, abstract, pdfFile: pdfUrl ? `pdfs/${id}.pdf` : null,
        recordUrl, pdfUrl, doi, track };
}

function parseOdyssey(provider, html) {
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
        // ISCA includes keynote abstract pages in the same index. They are not
        // proceedings papers and deliberately have no PDF, so exclude them at
        // catalog time instead of inventing a deterministic 404 PDF URL.
        if (/^Keynote:/iu.test(heading)) return;
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
    if (provider.parser !== 'aaai-multi' || !Array.isArray(provider.issues)) fail('AAAI issue parser requires the fixed multi-issue provider');
    const issue = typeof issueOrNumber === 'number'
        ? provider.issues.find(candidate => candidate.number === issueOrNumber)
        : issueOrNumber;
    if (!issue || provider.issues.find(candidate => candidate.number === issue.number) !== issue) {
        fail('AAAI issue is outside the fixed volume 40 manifest');
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
        if (!recordUrl) fail(`AAAI issue ${issue.number} article has no official record URL`);
        validateFetchUrl(provider, recordUrl, 'record');
        const recordId = path.posix.basename(new URL(recordUrl).pathname);
        const pdfAnchor = container.find('a.obj_galley_link.pdf[href]').first();
        if (!pdfAnchor.length) fail(`AAAI article ${recordId} has no proceedings PDF`);
        const pdfUrl = hrefUrl(pdfAnchor.attr('href'), issue.url);
        validateFetchUrl(provider, pdfUrl, 'pdf');
        const pdfParts = new URL(pdfUrl).pathname.split('/').filter(Boolean);
        if (pdfParts.at(-2) !== recordId) fail(`AAAI article ${recordId} PDF identity differs from its official record`);
        // OJS article 37523 lists the display name "Shuai Wang" twice. The
        // shared nine-field schema cannot represent two indistinguishable
        // author strings, so preserve first-seen order while removing exact
        // display-name duplicates (without using the title as identity).
        const authors = [...new Set(container.find('.authors').first().text().replace(/\s+/gu, ' ').trim()
            .split(/\s*,\s*/u).map(item => item.trim()).filter(Boolean))];
        const track = container.closest('.section').find('h2').first().text().replace(/\s+/gu, ' ').trim();
        papers.push(makePaper({ id: recordId, title: recordAnchor.text().replace(/\s+/gu, ' ').trim(),
            authors, abstract: '', recordUrl, pdfUrl, doi: null, track: cleanMaybe(track || issue.title) }));
    });
    if (!papers.length) fail(`AAAI issue ${issue.number} has no proceedings papers`);
    return papers;
}

function pmlrPdfIdentity(provider, pdfUrl, expectedId) {
    const parsed = new URL(pdfUrl); const parts = parsed.pathname.split('/').filter(Boolean);
    const basename = path.posix.basename(parsed.pathname, '.pdf');
    const parent = parts.at(-2);
    if (basename !== expectedId || parent !== expectedId) fail('PMLR PDF identity differs from its official record');
    if (parsed.hostname === provider.host && parts[0] !== provider.volume) fail('PMLR PDF left its fixed volume');
    if (parsed.hostname === 'raw.githubusercontent.com'
        && (parts[0] !== 'mlresearch' || parts[1] !== provider.volume || parts[2] !== 'main' || parts[3] !== 'assets')) {
        fail('PMLR raw PDF left its fixed repository path');
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
        if (!pdfAnchor.length) fail(`PMLR record ${id} has no identity-bound proceedings PDF`);
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
        // CVF occasionally omits the visible PDF anchor while retaining the
        // canonical record and the identity-equivalent PDF endpoint.
        const pdfUrl = pdfAnchor.length ? hrefUrl(pdfAnchor.attr('href'), provider.indexUrl)
            : `https://${provider.host}/content/CVPR2026/papers/${id}.pdf`;
        validateFetchUrl(provider, pdfUrl, 'pdf');
        if (path.posix.basename(new URL(pdfUrl).pathname, '.pdf') !== id) fail('CVF record and PDF identities differ');
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
    fail('ACL Anthology record left the admitted main-conference volumes');
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
    if (!ID_RE.test(id)) fail(`papers[${index}].id is invalid`);
    if (!Array.isArray(value.authors) || !value.authors.length) fail(`papers[${index}].authors must be a non-empty array`);
    const authors = []; const seen = new Set();
    for (const [authorIndex, author] of value.authors.entries()) {
        const normalized = cleanText(author, `papers[${index}].authors[${authorIndex}]`, { max: 500 });
        if (seen.has(normalized)) fail(`papers[${index}].authors contains duplicates`);
        seen.add(normalized); authors.push(normalized);
    }
    const pdfUrl = value.pdfUrl === null ? null : validateFetchUrl(provider, value.pdfUrl, 'pdf');
    const expectedPdfFile = pdfUrl === null ? null : `pdfs/${id}.pdf`;
    if (value.pdfFile !== expectedPdfFile) fail(`papers[${index}].pdfFile must bind its official ID and PDF URL`);
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
        fail('metadata conference identity differs from provider');
    }
    if (!Array.isArray(value.papers) || !value.papers.length) fail('metadata papers must be a non-empty array');
    const papers = value.papers.map((paper, index) => normalizePaper(paper, provider, index))
        .sort((left, right) => left.id.localeCompare(right.id, 'en'));
    for (let index = 1; index < papers.length; index += 1) {
        if (papers[index - 1].id === papers[index].id) fail(`duplicate official paper ID: ${papers[index].id}`);
    }
    return { conference: clone(provider.conference), papers };
}

function parseCatalog(providerId, html) {
    const provider = providerFor(providerId);
    if (provider.parser === 'aaai-multi') {
        fail('AAAI catalog requires all 48 fixed issue snapshots; a single issue cannot represent the proceedings');
    }
    const source = cleanText(String(html), 'official index HTML', { max: MAX_INDEX_BYTES });
    const parsers = { odyssey: parseOdyssey, iwslt: parseIwslt, eusipco: parseEusipco, nime: parseNime, dafx: parseDafx,
        pmlr: parsePmlr, cvf: parseCvf, acl: parseAcl };
    const papers = parsers[provider.parser](provider, source);
    return normalizeMetadata({ conference: clone(provider.conference), papers }, provider);
}

function plannedRoot(outputRoot) {
    if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot) || path.resolve(outputRoot) !== outputRoot
        || outputRoot === path.parse(outputRoot).root) fail('output-root must be a normalized absolute non-root path');
    let cursor = outputRoot;
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor); if (parent === cursor) fail('output-root has no safe existing ancestor'); cursor = parent;
    }
    safeDirectory(cursor, 'output-root existing ancestor', false);
    return outputRoot;
}

function safeDirectory(directory, label, create) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) {
        fail(`${label} must be a normalized absolute path`);
    }
    if (!fs.existsSync(directory)) {
        if (!create) fail(`${label} does not exist`);
        const parent = path.dirname(directory); safeDirectory(parent, `${label} parent`, false);
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail(`${label} is unsafe`);
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
        catalogReceiptFile: path.join(root, 'catalog.receipt.json') };
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
    if (path.dirname(absolute) !== parent) fail(`${label} path escapes its parent`);
    let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size < 1 || opened.size > maxBytes) {
            fail(`${label} is unsafe or outside its size limit`);
        }
        if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600) fail(`${label} permissions must be 0600`);
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
            fail(`${label} changed while read`);
        }
        return { bytes, sha256: sha256(bytes), size: bytes.length };
    } catch (error) {
        if (error instanceof OfficialConferenceAcquisitionError) throw error;
        fail(`${label} cannot be read: ${error.code || error.message}`);
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
        if (mode !== 0o600 || !existing.bytes.equals(bytes)) fail(`refuses to overwrite different or non-private ${label}`);
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
            const key = JSON.parse(token); if (top.keys.has(key)) fail(`${label} has duplicate keys`);
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
        fail(`${label} is not strict UTF-8 JSON`);
    }
    if (!loaded.bytes.equals(prettyBytes(value))) fail(`${label} bytes are not canonical`);
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
    if (!Array.isArray(receipt.redirects) || receipt.redirects.length > MAX_REDIRECTS) fail('receipt redirects are invalid');
    let current = validateFetchUrl(provider, receipt.requestedUrl, kind);
    for (const item of receipt.redirects) {
        exact(item, ['from', 'status', 'to'], 'redirect');
        if (![301, 302, 303, 307, 308].includes(item.status) || item.from !== current) fail('redirect chain is not continuous');
        current = validateRedirectTarget(provider, item.from, item.to, kind);
    }
    if (receipt.finalUrl !== current) fail('receipt final URL differs from redirect chain');
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
            || receipt.requestedUrl !== issue.url))) fail(`${label} receipt envelope is invalid`);
    const body = { ...receipt }; delete body.receiptSha256;
    if (!SHA_RE.test(receipt.receiptSha256) || receipt.receiptSha256 !== stableHash(body)) fail(`${label} receipt self-SHA drifted`);
    validateRedirects(provider, receipt, 'index');
    exact(receipt.body, ['bytes', 'relativePath', 'sha256'], `${label} body binding`);
    if (receipt.body.relativePath !== relativePath || !Number.isSafeInteger(receipt.body.bytes)
        || receipt.body.bytes < 1 || receipt.body.bytes > MAX_INDEX_BYTES || !SHA_RE.test(receipt.body.sha256)) {
        fail(`${label} body binding is invalid`);
    }
    const index = readStableFile(responseFile, `sealed ${label}`, MAX_INDEX_BYTES);
    if (index.size !== receipt.body.bytes || index.sha256 !== receipt.body.sha256) fail(`sealed ${label} differs from receipt`);
    return { receipt, receiptFileSha256: loaded.sha256, index };
}

function replayIndexReceipt(provider, paths) {
    return replayResponseReceipt(provider, paths.indexFile, paths.indexReceiptFile, 'responses/index.html');
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
    if (snapshots.length !== provider.issues.length) fail('AAAI catalog does not contain all 48 fixed issues');
    const papers = []; const owner = new Map(); const issuePaperSets = [];
    for (let index = 0; index < provider.issues.length; index += 1) {
        const issue = provider.issues[index]; const snapshot = snapshots[index];
        if (snapshot.issue !== issue) fail('AAAI issue snapshot order differs from the fixed manifest');
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

function replayCatalog(providerId, outputRoot) {
    const provider = providerFor(providerId); const paths = acquisitionPaths(outputRoot, false);
    if (provider.issues) {
        const snapshots = provider.issues.map(issue => replayIssueReceipt(provider, paths, issue));
        const combined = combineAaaiIssueSnapshots(provider, snapshots);
        const metadataLoaded = readCanonicalJson(paths.metadataFile, 'official proceedings metadata', MAX_INDEX_BYTES);
        if (!metadataLoaded.bytes.equals(prettyBytes(combined.metadata))) fail('metadata differs from replayed complete AAAI issue set');
        const catalogLoaded = readCanonicalJson(paths.catalogReceiptFile, 'catalog receipt', 1024 * 1024);
        const receipt = catalogLoaded.value;
        exact(receipt, ['contract', 'issueManifestSha256', 'issues', 'metadata', 'paperSetSha256',
            'parserVersion', 'providerId', 'receiptSha256', 'version'], 'multi-issue catalog receipt');
        const expected = multiIssueCatalogReceipt(provider, snapshots, combined.issuePaperSets, metadataLoaded.bytes);
        if (!catalogLoaded.bytes.equals(prettyBytes(expected))) fail('catalog receipt differs from replayed complete AAAI catalog');
        return { provider, paths, metadata: combined.metadata, metadataSha256: metadataLoaded.sha256, receipt };
    }
    const indexSnapshot = replayIndexReceipt(provider, paths);
    const metadataLoaded = readCanonicalJson(paths.metadataFile, 'official proceedings metadata', MAX_INDEX_BYTES);
    const metadata = normalizeMetadata(metadataLoaded.value, provider);
    if (!metadataLoaded.bytes.equals(prettyBytes(metadata))) fail('metadata bytes differ from normalized schema');
    const replayed = parseCatalog(providerId, new TextDecoder('utf-8', { fatal: true }).decode(indexSnapshot.index.bytes));
    if (!prettyBytes(replayed).equals(metadataLoaded.bytes)) fail('metadata differs from replayed official index');
    const catalogLoaded = readCanonicalJson(paths.catalogReceiptFile, 'catalog receipt', 1024 * 1024);
    const receipt = catalogLoaded.value;
    exact(receipt, ['contract', 'indexReceiptFileSha256', 'indexReceiptSha256', 'metadata', 'paperSetSha256',
        'parserVersion', 'providerId', 'receiptSha256', 'version'], 'catalog receipt');
    const expected = catalogReceipt(provider, indexSnapshot, metadataLoaded.bytes);
    if (!catalogLoaded.bytes.equals(prettyBytes(expected))) fail('catalog receipt differs from replayed catalog');
    return { provider, paths, metadata, metadataSha256: metadataLoaded.sha256, receipt };
}

async function readResponseBytes(response, maxBytes, label) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) fail(`${label} exceeds the byte limit`);
    if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > maxBytes) fail(`${label} is empty or exceeds the byte limit`);
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
    if (!total) fail(`${label} is empty`);
    return Buffer.concat(chunks, total);
}

async function fetchOfficial({ provider, url, kind, maxBytes, timeoutMs = REQUEST_TIMEOUT_MS }, dependencies = {}) {
    const proxyUrl = (dependencies.detectProxy || detectHttpConnectProxyUrl)();
    if (!proxyUrl) fail('project HTTP CONNECT proxy is required');
    const dispatcher = (dependencies.createDispatcher || createProxyDispatcher)(proxyUrl);
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') fail('fetch is unavailable');
    const requestedUrl = validateFetchUrl(provider, url, kind); let current = requestedUrl; const redirects = [];
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    try {
        for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
            const response = await fetchImpl(current, { method: 'GET', redirect: 'manual', dispatcher,
                signal: controller.signal, headers: { Accept: kind === 'pdf' ? 'application/pdf' : 'text/html,application/xhtml+xml',
                    'User-Agent': 'audio-paper-digest-official-conference/1.0' } });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                if (count >= MAX_REDIRECTS) fail('official response exceeded the redirect limit');
                const location = response.headers?.get?.('location'); if (!location) fail('official redirect has no Location');
                const next = validateRedirectTarget(provider, current, new URL(location, current).toString(), kind);
                redirects.push({ from: current, to: next, status: response.status }); current = next;
                try { await response.body?.cancel?.(); } catch { /* ignore redirect body */ }
                continue;
            }
            if (response.status !== 200) fail(`official ${kind} returned HTTP ${response.status}`);
            const contentType = String(response.headers?.get?.('content-type') || '').trim();
            if (kind === 'pdf' ? !/^(?:application\/pdf|application\/octet-stream)(?:\s*;|$)/iu.test(contentType)
                : !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(contentType)) {
                fail(`official ${kind} response has an invalid Content-Type`);
            }
            const bytes = await readResponseBytes(response, maxBytes, `official ${kind} response`);
            if (kind === 'pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') fail('official PDF response lacks a PDF header');
            const observedAt = (dependencies.now || (() => new Date().toISOString()))();
            if (!validObservedAt(observedAt)) fail('observedAt is invalid');
            return { bytes, requestedUrl, finalUrl: current, redirects, responseStatus: response.status,
                contentType, observedAt };
        }
        fail('official response exceeded the redirect limit');
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
        if (receiptPresent && !rawPresent) fail(`AAAI issue ${issue.number} receipt exists without its response bytes`);
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

async function acquireCatalog({ providerId, outputRoot, apply = false } = {}, dependencies = {}) {
    const provider = providerFor(providerId); plannedRoot(outputRoot);
    if (provider.issues && !apply) return { command: 'catalog', mode: 'dry-run', providerId, outputRoot,
        archiveUrl: provider.archiveUrl, issueCount: provider.issues.length,
        indexUrls: provider.issues.map(issue => issue.url),
        writes: { issueResponses: provider.issues.length, issueReceipts: provider.issues.length,
            metadata: 'metadata.json', catalogReceipt: 'catalog.receipt.json' } };
    if (!apply) return { command: 'catalog', mode: 'dry-run', providerId, outputRoot,
        indexUrl: provider.indexUrl, writes: ['responses/index.html', 'responses/index.receipt.json',
            'metadata.json', 'catalog.receipt.json'] };
    if (provider.issues) return acquireMultiIssueCatalog(provider, outputRoot, dependencies);
    const paths = acquisitionPaths(outputRoot, true);
    const rawPresent = fs.existsSync(paths.indexFile); const receiptPresent = fs.existsSync(paths.indexReceiptFile);
    if (receiptPresent && !rawPresent) fail('index receipt exists without its response bytes');
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
    if (!ID_RE.test(paper.id)) fail('paper ID is unsafe for a receipt filename');
    return path.join(paths.receipts, `${paper.id}.json`);
}

function pdfPath(paths, paper) {
    const expected = `pdfs/${paper.id}.pdf`;
    if (paper.pdfFile !== expected) fail('paper PDF path is not canonical');
    const filename = path.resolve(paths.root, paper.pdfFile);
    if (path.dirname(filename) !== paths.pdfs) fail('paper PDF path escapes output root');
    return filename;
}

function replayPdfReceipt(catalog, paper) {
    const filename = pdfReceiptPath(catalog.paths, paper);
    const loaded = readCanonicalJson(filename, `${paper.id} PDF receipt`, 1024 * 1024); const receipt = loaded.value;
    exact(receipt, ['contentType', 'contract', 'finalUrl', 'metadataSha256', 'observedAt', 'paperId', 'pdf',
        'providerId', 'receiptSha256', 'redirects', 'requestedUrl', 'responseStatus', 'version'], 'PDF receipt');
    if (receipt.contract !== PDF_RECEIPT_CONTRACT || receipt.version !== VERSION
        || receipt.providerId !== catalog.provider.conference.id || receipt.paperId !== paper.id
        || receipt.metadataSha256 !== catalog.metadataSha256 || receipt.requestedUrl !== paper.pdfUrl
        || receipt.responseStatus !== 200 || !validObservedAt(receipt.observedAt)
        || !/^(?:application\/pdf|application\/octet-stream)(?:\s*;|$)/iu.test(receipt.contentType)) {
        fail(`${paper.id} PDF receipt envelope is invalid`);
    }
    const body = { ...receipt }; delete body.receiptSha256;
    if (!SHA_RE.test(receipt.receiptSha256) || receipt.receiptSha256 !== stableHash(body)) fail(`${paper.id} PDF receipt self-SHA drifted`);
    validateRedirects(catalog.provider, receipt, 'pdf');
    exact(receipt.pdf, ['bytes', 'relativePath', 'sha256'], 'PDF byte binding');
    if (receipt.pdf.relativePath !== paper.pdfFile || !Number.isSafeInteger(receipt.pdf.bytes)
        || receipt.pdf.bytes < 5 || receipt.pdf.bytes > MAX_PDF_BYTES || !SHA_RE.test(receipt.pdf.sha256)) {
        fail(`${paper.id} PDF byte binding is invalid`);
    }
    const pdf = readStableFile(pdfPath(catalog.paths, paper), `${paper.id} sealed PDF`, MAX_PDF_BYTES);
    if (pdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || pdf.size !== receipt.pdf.bytes
        || pdf.sha256 !== receipt.pdf.sha256) fail(`${paper.id} sealed PDF differs from receipt`);
    return receipt;
}

async function downloadPapers({ providerId, outputRoot, apply = false, limit = null, concurrency = 1, retries = 0 } = {}, dependencies = {}) {
    const catalog = replayCatalog(providerId, outputRoot);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) fail('limit must be a positive integer');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) fail('concurrency must be an integer from 1 to 5');
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) fail('retries must be an integer from 0 to 5');
    const downloadable = catalog.metadata.papers.filter(paper => paper.pdfUrl !== null);
    const before = acquisitionStatus({ providerId, outputRoot });
    if (!apply) return { command: 'download', mode: 'dry-run', providerId, outputRoot,
        total: downloadable.length, downloaded: before.downloaded, pending: before.missing, limit, concurrency, retries };
    let created = 0; let recovered = 0; let attempted = 0; let cursor = 0; let firstError = null;
    const processPaper = async paper => {
        const target = pdfPath(catalog.paths, paper); const receiptFile = pdfReceiptPath(catalog.paths, paper);
        const targetPresent = fs.existsSync(target); const receiptPresent = fs.existsSync(receiptFile);
        if (receiptPresent && !targetPresent) fail(`${paper.id} receipt exists without its PDF`);
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
        fail('AAAI responses directory contains artifacts outside the fixed issue set');
    }
    const issueDirectory = path.join(catalog.paths.responses, 'issues');
    for (const entry of fs.readdirSync(issueDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) {
            fail(`unexpected AAAI issue response artifact: ${entry.name}`);
        }
        expected.delete(entry.name);
    }
    if (expected.size) fail('AAAI response directory is missing fixed issue artifacts');
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
        if (!hasPdf || !hasReceipt) fail(`${paper.id} has a partial PDF/receipt pair`);
        replayPdfReceipt(catalog, paper); verified += 1;
    }
    for (const [directory, expected, label] of [[catalog.paths.pdfs, expectedPdfs, 'PDF'], [catalog.paths.receipts, expectedReceipts, 'receipt']]) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) fail(`unexpected ${label} artifact: ${entry.name}`);
        }
    }
    return { command: 'verify', providerId, outputRoot, metadataSha256: catalog.metadataSha256,
        catalogReceiptSha256: catalog.receipt.receiptSha256, papers: catalog.metadata.papers.length,
        verified, missing, complete: missing.length === 0 };
}

module.exports = {
    VERSION, HTTP_RECEIPT_CONTRACT, CATALOG_RECEIPT_CONTRACT, PDF_RECEIPT_CONTRACT, PARSER_VERSION,
    MAX_INDEX_BYTES, MAX_PDF_BYTES, MAX_REDIRECTS, REQUEST_TIMEOUT_MS, AAAI_2026_ISSUES, PROVIDERS,
    OfficialConferenceAcquisitionError, sha256, stableHash, prettyBytes, providerFor, validateFetchUrl,
    validateRedirectTarget,
    normalizeMetadata, parseAaaiIssue, parseCatalog, acquireCatalog, downloadPapers, acquisitionStatus, verifyAcquisition,
    replayCatalog, replayPdfReceipt
};

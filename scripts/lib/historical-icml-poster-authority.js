'use strict';

// Authenticate the retained ICML miniconf snapshot as an identity bridge:
// frozen poster ID -> OpenReview forum ID -> a forum-ID-named local PDF.
// Historical prose and retained generated analysis never enter this module.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'historical-icml-official-poster-snapshot-v1';
const VERSION = 1;
const DAILY_BINDING_CONTRACT = 'historical-daily-icml-poster-binding-v2';
const DAILY_BINDING_VERSION = 2;
const PDF_DESCRIPTOR_CONTRACT = 'historical-icml-local-forum-pdf-v1';
const PDF_DESCRIPTOR_VERSION = 1;
const SOURCE_KIND = 'retained-local-icml-miniconf-raw-snapshot';
const DIRECT_PAGE_MAPPING = 'frozen-daily-page-official-poster';
const SUMMARY_SECTION_MAPPING = 'frozen-daily-summary-section-official-poster';
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const SHA_RE = /^[a-f0-9]{64}$/;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const FORUM_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const ACCEPT_RE = /^Accept \((?:regular|spotlight)\)$/;
const SOURCE_GROUPS = new Set([
    'https://openreview.net/group?id=ICML.cc/2026/Conference',
    'https://openreview.net/group?id=ICML.cc/2026/Position_Paper_Track'
]);
const HANDLES = new WeakSet();
const HANDLE_DATA = new WeakMap();

class HistoricalIcmlPosterAuthorityError extends Error {
    constructor(message) {
        super(`Historical ICML poster authority rejected: ${message}`);
        this.name = 'HistoricalIcmlPosterAuthorityError';
        this.code = 'HISTORICAL_ICML_POSTER_AUTHORITY_INTEGRITY';
    }
}

const fail = message => { throw new HistoricalIcmlPosterAuthorityError(message); };
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = value => sha256(JSON.stringify(canonical(value)));
const validSha = value => SHA_RE.test(String(value || ''));

function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} must be an object`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}

function safeDirectory(directory, label) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} must be absolute`);
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe`);
    }
    if (fs.realpathSync(absolute) !== absolute) fail(`${label} is unsafe`);
    return absolute;
}

function readStableFile(filename, label, maxBytes) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail(`${label} must be an absolute file`);
    const absolute = path.resolve(filename); safeDirectory(path.dirname(absolute), `${label} parent`); let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > maxBytes) {
            fail(`${label} is unsafe or too large`);
        }
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size) fail(`${label} changed while read`);
        return { filename: absolute, bytes, sha256: sha256(bytes), dev: opened.dev, ino: opened.ino };
    } catch (error) {
        if (error instanceof HistoricalIcmlPosterAuthorityError) throw error;
        fail(`${label} cannot be read: ${error.code || error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function rejectDuplicateJsonKeys(text) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) fail('snapshot JSON has duplicate keys');
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function readStrictJson(filename, label) {
    const loaded = readStableFile(filename, label, MAX_SNAPSHOT_BYTES); let value;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text); value = JSON.parse(text);
    } catch (error) {
        if (error instanceof HistoricalIcmlPosterAuthorityError) throw error;
        fail(`${label} is not strict UTF-8 JSON`);
    }
    return { ...loaded, value };
}

function forumIdFromUrl(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^https:\/\/openreview\.net\/forum\?id=([A-Za-z0-9_-]{6,128})$/u);
    return match ? match[1] : null;
}

function normalizeRawRecord(record, recordIndex, snapshotSha256) {
    if (!plain(record) || !Number.isSafeInteger(record.id) || record.id < 1
        || String(record.id) !== `${record.id}` || typeof record.name !== 'string' || !record.name.trim()) {
        fail(`snapshot record ${recordIndex} has an invalid poster identity`);
    }
    const posterId = String(record.id); const forumId = forumIdFromUrl(record.paper_url);
    if (!forumId || record.virtualsite_url !== `/virtual/2026/poster/${posterId}`
        || record.eventtype !== 'Poster' || record.event_type !== 'Poster' || record.visible !== true
        || !ACCEPT_RE.test(String(record.decision || '')) || !SOURCE_GROUPS.has(record.sourceurl)) {
        fail(`snapshot record ${recordIndex} is not an accepted visible ICML 2026 poster with a canonical forum URL`);
    }
    const body = { posterId, forumId, officialUrl: `https://icml.cc/virtual/2026/poster/${posterId}`,
        openreviewUrl: `https://openreview.net/forum?id=${forumId}`, sourceGroup: record.sourceurl,
        decision: record.decision, recordIndex, snapshotSha256 };
    return { ...body, recordBindingSha256: stableHash(body) };
}

function authorityFromLoaded(loaded) {
    const raw = loaded.value;
    if (!plain(raw) || Object.keys(raw).sort().join('\0') !== ['count', 'next', 'previous', 'results'].sort().join('\0')
        || !Number.isSafeInteger(raw.count) || raw.count < 1 || !Array.isArray(raw.results)
        || raw.count !== raw.results.length || raw.next !== null || raw.previous !== null) {
        fail('snapshot must be the complete raw ICML count/next/previous/results response');
    }
    const records = raw.results.map((record, index) => normalizeRawRecord(record, index, loaded.sha256));
    const posterIds = new Set(); const forumIds = new Set();
    for (const record of records) {
        if (posterIds.has(record.posterId)) fail(`snapshot duplicates poster ID ${record.posterId}`);
        if (forumIds.has(record.forumId)) fail(`snapshot duplicates forum ID ${record.forumId}`);
        posterIds.add(record.posterId); forumIds.add(record.forumId);
    }
    records.sort((left, right) => Number(left.posterId) - Number(right.posterId));
    const body = { contract: CONTRACT, version: VERSION, sourceKind: SOURCE_KIND,
        snapshot: { absolutePath: loaded.filename, sha256: loaded.sha256, records: records.length },
        records, recordSetSha256: stableHash(records) };
    return { ...body, authoritySha256: stableHash(body) };
}

function normalizeAuthority(value) {
    exact(value, ['contract', 'version', 'sourceKind', 'snapshot', 'records', 'recordSetSha256',
        'authoritySha256'], 'ICML poster authority');
    if (value.contract !== CONTRACT || value.version !== VERSION || value.sourceKind !== SOURCE_KIND
        || !plain(value.snapshot) || !Array.isArray(value.records)) fail('ICML poster authority envelope is invalid');
    exact(value.snapshot, ['absolutePath', 'sha256', 'records'], 'ICML poster authority snapshot');
    if (!path.isAbsolute(value.snapshot.absolutePath) || !validSha(value.snapshot.sha256)
        || !Number.isSafeInteger(value.snapshot.records) || value.snapshot.records !== value.records.length) {
        fail('ICML poster authority snapshot binding is invalid');
    }
    const posterIds = new Set(); const forumIds = new Set(); let previous = 0;
    const records = value.records.map((record, index) => {
        exact(record, ['posterId', 'forumId', 'officialUrl', 'openreviewUrl', 'sourceGroup', 'decision',
            'recordIndex', 'snapshotSha256', 'recordBindingSha256'], `ICML poster authority record ${index}`);
        const numericPoster = Number(record.posterId);
        const body = { ...clone(record) }; delete body.recordBindingSha256;
        if (!/^[1-9]\d*$/u.test(record.posterId) || !Number.isSafeInteger(numericPoster) || numericPoster <= previous
            || !FORUM_ID_RE.test(record.forumId) || record.officialUrl !== `https://icml.cc/virtual/2026/poster/${record.posterId}`
            || record.openreviewUrl !== `https://openreview.net/forum?id=${record.forumId}`
            || !SOURCE_GROUPS.has(record.sourceGroup) || !ACCEPT_RE.test(record.decision)
            || !Number.isSafeInteger(record.recordIndex) || record.recordIndex < 0
            || record.snapshotSha256 !== value.snapshot.sha256 || !validSha(record.recordBindingSha256)
            || stableHash(body) !== record.recordBindingSha256 || posterIds.has(record.posterId)
            || forumIds.has(record.forumId)) fail('ICML poster authority record binding is invalid');
        previous = numericPoster; posterIds.add(record.posterId); forumIds.add(record.forumId); return clone(record);
    });
    const body = { contract: CONTRACT, version: VERSION, sourceKind: SOURCE_KIND,
        snapshot: clone(value.snapshot), records, recordSetSha256: value.recordSetSha256 };
    if (!validSha(value.recordSetSha256) || value.recordSetSha256 !== stableHash(records)
        || !validSha(value.authoritySha256) || value.authoritySha256 !== stableHash(body)) {
        fail('ICML poster authority self-SHA is invalid');
    }
    return { ...body, authoritySha256: value.authoritySha256 };
}

function loadPosterAuthority({ snapshotFile } = {}) {
    const loaded = readStrictJson(snapshotFile, 'ICML raw poster snapshot');
    const authority = normalizeAuthority(authorityFromLoaded(loaded));
    const byPoster = new Map(authority.records.map(record => [record.posterId, record]));
    const byForum = new Map(authority.records.map(record => [record.forumId, record]));
    const handle = Object.freeze(Object.create(null)); HANDLES.add(handle);
    HANDLE_DATA.set(handle, Object.freeze({ snapshotFile: loaded.filename, dev: loaded.dev, ino: loaded.ino,
        authority: Object.freeze(authority), byPoster, byForum }));
    return handle;
}

function handleData(handle) {
    if (!handle || typeof handle !== 'object' || !HANDLES.has(handle)) fail('authenticated ICML poster authority handle required');
    return HANDLE_DATA.get(handle);
}

function replayPosterAuthority(handle) {
    const stored = handleData(handle); const loaded = readStrictJson(stored.snapshotFile, 'ICML raw poster snapshot');
    const authority = normalizeAuthority(authorityFromLoaded(loaded));
    if (loaded.dev !== stored.dev || loaded.ino !== stored.ino
        || stableHash(authority) !== stableHash(stored.authority)) fail('ICML raw poster snapshot changed after authentication');
    return handle;
}

function authorityHandleSnapshot(handle) {
    replayPosterAuthority(handle); return clone(handleData(handle).authority);
}

function lookupByPoster(handle, posterId) {
    replayPosterAuthority(handle);
    if (!/^[1-9]\d*$/u.test(String(posterId || ''))) fail('poster ID is invalid');
    const record = handleData(handle).byPoster.get(String(posterId));
    if (!record) fail(`poster ID ${posterId} is absent from the authenticated snapshot`);
    return clone(record);
}

function lookupByForum(handle, forumId) {
    replayPosterAuthority(handle);
    if (!FORUM_ID_RE.test(String(forumId || ''))) fail('forum ID is invalid');
    const record = handleData(handle).byForum.get(String(forumId));
    if (!record) fail(`forum ID ${forumId} is absent from the authenticated snapshot`);
    return clone(record);
}

function normalizePage(page, expectedKind, label) {
    if (!plain(page)) fail(`${label} is required`);
    const pageKey = page.pageKey ?? page.pageId; const pagePath = page.pagePath ?? page.path;
    const pageContentSha256 = page.pageContentSha256 ?? page.contentSha256;
    if (!PAGE_KEY_RE.test(String(pageKey || '')) || typeof pagePath !== 'string' || !pagePath
        || !validSha(pageContentSha256) || !plain(page.scope) || page.scope.type !== 'daily'
        || typeof page.scope.key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(page.scope.key)
        || (expectedKind && page.kind !== undefined && page.kind !== expectedKind)) fail(`${label} is malformed`);
    return { pageKey, pagePath, pageContentSha256, scope: { type: 'daily', key: page.scope.key } };
}

function readFrozenPage(blogRoot, page, label, maxBytes) {
    const root = safeDirectory(blogRoot, 'blogRoot'); const filename = path.resolve(root, page.pagePath);
    if (!filename.startsWith(`${root}${path.sep}`)) fail(`${label} escapes blogRoot`);
    const loaded = readStableFile(filename, label, maxBytes);
    if (loaded.sha256 !== page.pageContentSha256) fail(`${label} bytes differ from frozen inventory`);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); }
    catch { fail(`${label} is not strict UTF-8`); }
    return { ...loaded, text };
}

function bodyAfterFrontmatter(text, label) {
    const match = text.match(/^---\n[\s\S]*?\n---\n/u);
    if (!match) fail(`${label} lacks strict frontmatter`);
    return text.slice(match[0].length);
}

function posterIdsInText(text, label) {
    const ids = new Set(); let occurrences = 0;
    for (const match of text.matchAll(/(?:https?:\/\/)?(?:www\.)?icml\.cc\/virtual\/2026\/poster\/[^\s<>"'\])]+/giu)) {
        occurrences += 1; let url;
        if (!match[0].startsWith('https://icml.cc/')) fail(`${label} contains a non-canonical ICML poster URL`);
        try { url = new URL(match[0]); } catch { fail(`${label} contains an invalid ICML poster URL`); }
        const poster = url.pathname.match(/^\/virtual\/2026\/poster\/([1-9]\d*)\/?$/u);
        if (url.protocol !== 'https:' || url.hostname !== 'icml.cc' || url.port || url.username || url.password
            || url.search || url.hash || !poster) fail(`${label} contains a non-canonical ICML poster URL`);
        ids.add(poster[1]);
    }
    return { ids: [...ids].sort((left, right) => Number(left) - Number(right)), occurrences };
}

function regexEscape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function summarySectionBinding({ blogRoot, summaryPage, childPage, blogBasePath }) {
    const summary = normalizePage(summaryPage, 'daily-summary', 'frozen daily summary page');
    if (summary.scope.key !== childPage.scope.key) fail('daily summary and child page belong to different cohorts');
    const loaded = readFrozenPage(blogRoot, summary, 'frozen daily summary page', MAX_SUMMARY_BYTES);
    const body = bodyAfterFrontmatter(loaded.text, 'frozen daily summary page');
    const slug = path.basename(childPage.pagePath, path.extname(childPage.pagePath));
    const childUrl = `${blogBasePath}/posts/${slug}`;
    const headings = [...body.matchAll(/^###\s+/gmu)]; const matching = [];
    for (let index = 0; index < headings.length; index += 1) {
        const start = headings[index].index; const end = headings[index + 1]?.index ?? body.length;
        const section = body.slice(start, end);
        const childLinks = [...section.matchAll(new RegExp(`\\]\\(${regexEscape(childUrl)}\\)`, 'gu'))];
        if (childLinks.length) matching.push({ start, end, section, childLinks: childLinks.length });
    }
    if (matching.length !== 1 || matching[0].childLinks !== 1) {
        fail('daily summary must have exactly one section with exactly one child-page link');
    }
    const selected = matching[0]; const poster = posterIdsInText(selected.section, 'daily summary child section');
    if (poster.ids.length !== 1) fail('daily summary child section must identify exactly one ICML poster');
    const frontmatterBytes = Buffer.byteLength(loaded.text) - Buffer.byteLength(body);
    const startByte = frontmatterBytes + Buffer.byteLength(body.slice(0, selected.start));
    const endByte = frontmatterBytes + Buffer.byteLength(body.slice(0, selected.end));
    const sectionBytes = loaded.bytes.subarray(startByte, endByte);
    return { posterId: poster.ids[0], summary: { pageKey: summary.pageKey, pagePath: summary.pagePath,
        pageContentSha256: summary.pageContentSha256, scope: summary.scope, section: { childUrl, startByte, endByte,
            sha256: sha256(sectionBytes) } } };
}

function normalizeDailyPageBinding(value) {
    exact(value, ['contract', 'version', 'mapping', 'page', 'poster', 'summary', 'bindingSha256'], 'daily ICML binding');
    if (value.contract !== DAILY_BINDING_CONTRACT || value.version !== DAILY_BINDING_VERSION
        || ![DIRECT_PAGE_MAPPING, SUMMARY_SECTION_MAPPING].includes(value.mapping)) fail('daily ICML binding contract is invalid');
    exact(value.page, ['pageKey', 'pagePath', 'pageContentSha256', 'scope'], 'daily ICML binding page');
    const page = normalizePage(value.page, null, 'daily ICML binding page');
    exact(value.poster, ['posterId', 'forumId', 'officialUrl', 'openreviewUrl', 'authoritySha256',
        'recordBindingSha256'], 'daily ICML binding poster');
    if (!/^[1-9]\d*$/u.test(value.poster.posterId) || !FORUM_ID_RE.test(value.poster.forumId)
        || value.poster.officialUrl !== `https://icml.cc/virtual/2026/poster/${value.poster.posterId}`
        || value.poster.openreviewUrl !== `https://openreview.net/forum?id=${value.poster.forumId}`
        || !validSha(value.poster.authoritySha256) || !validSha(value.poster.recordBindingSha256)) {
        fail('daily ICML binding poster is invalid');
    }
    let summary = null;
    if (value.mapping === DIRECT_PAGE_MAPPING) {
        if (value.summary !== null) fail('direct daily ICML binding cannot include a summary');
    } else {
        if (!plain(value.summary)) fail('summary daily ICML binding requires summary evidence');
        exact(value.summary, ['pageKey', 'pagePath', 'pageContentSha256', 'scope', 'section'], 'daily ICML binding summary');
        const normalized = normalizePage(value.summary, null, 'daily ICML binding summary');
        if (normalized.scope.key !== page.scope.key) fail('daily ICML binding summary belongs to a different cohort');
        exact(value.summary.section, ['childUrl', 'startByte', 'endByte', 'sha256'], 'daily ICML binding summary section');
        if (typeof value.summary.section.childUrl !== 'string' || !value.summary.section.childUrl.startsWith('/')
            || !Number.isSafeInteger(value.summary.section.startByte) || value.summary.section.startByte < 0
            || !Number.isSafeInteger(value.summary.section.endByte)
            || value.summary.section.endByte <= value.summary.section.startByte || !validSha(value.summary.section.sha256)) {
            fail('daily ICML binding summary section is invalid');
        }
        summary = clone(value.summary);
    }
    const body = { contract: DAILY_BINDING_CONTRACT, version: DAILY_BINDING_VERSION, mapping: value.mapping,
        page, poster: clone(value.poster), summary };
    if (!validSha(value.bindingSha256) || value.bindingSha256 !== stableHash(body)) fail('daily ICML binding self-SHA is invalid');
    return { ...body, bindingSha256: value.bindingSha256 };
}

function bindDailyPage({ authorityHandle, blogRoot, page, summaryPage = null,
    blogBasePath = '/audio-paper-digest-blog' } = {}) {
    replayPosterAuthority(authorityHandle);
    if (typeof blogBasePath !== 'string' || !/^\/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$/u.test(blogBasePath)
        || blogBasePath.includes('//') || blogBasePath.includes('..')) fail('blogBasePath is invalid');
    const child = normalizePage(page, 'paper', 'frozen daily child page');
    const loaded = readFrozenPage(blogRoot, child, 'frozen daily child page', MAX_PAGE_BYTES);
    const direct = posterIdsInText(bodyAfterFrontmatter(loaded.text, 'frozen daily child page'), 'daily child page');
    let posterId; let mapping; let summary = null;
    if (direct.ids.length === 1) { [posterId] = direct.ids; mapping = DIRECT_PAGE_MAPPING; }
    else if (direct.ids.length > 1) fail('daily child page identifies multiple ICML posters');
    else {
        if (!summaryPage) fail('daily child page has no poster and no frozen daily summary evidence');
        const recovered = summarySectionBinding({ blogRoot, summaryPage, childPage: child, blogBasePath });
        posterId = recovered.posterId; summary = recovered.summary; mapping = SUMMARY_SECTION_MAPPING;
    }
    const record = lookupByPoster(authorityHandle, posterId); const authority = handleData(authorityHandle).authority;
    const body = { contract: DAILY_BINDING_CONTRACT, version: DAILY_BINDING_VERSION, mapping, page: child,
        poster: { posterId: record.posterId, forumId: record.forumId, officialUrl: record.officialUrl,
            openreviewUrl: record.openreviewUrl, authoritySha256: authority.authoritySha256,
            recordBindingSha256: record.recordBindingSha256 }, summary };
    return normalizeDailyPageBinding({ ...body, bindingSha256: stableHash(body) });
}

function replayDailyPageBinding({ binding, authorityHandle, blogRoot, page, summaryPage = null,
    blogBasePath = '/audio-paper-digest-blog' } = {}) {
    const normalized = normalizeDailyPageBinding(binding);
    const rebuilt = bindDailyPage({ authorityHandle, blogRoot, page, summaryPage, blogBasePath });
    if (stableHash(rebuilt) !== stableHash(normalized)) fail('daily ICML binding no longer replays');
    return normalized;
}

function normalizePdfDescriptor(value) {
    exact(value, ['contract', 'version', 'posterId', 'forumId', 'absolutePath', 'bytes', 'sha256',
        'authoritySha256', 'recordBindingSha256', 'descriptorSha256'], 'ICML local PDF descriptor');
    const body = { ...clone(value) }; delete body.descriptorSha256;
    if (value.contract !== PDF_DESCRIPTOR_CONTRACT || value.version !== PDF_DESCRIPTOR_VERSION
        || !/^[1-9]\d*$/u.test(value.posterId) || !FORUM_ID_RE.test(value.forumId)
        || !path.isAbsolute(value.absolutePath) || !Number.isSafeInteger(value.bytes) || value.bytes < 5
        || !validSha(value.sha256) || !validSha(value.authoritySha256) || !validSha(value.recordBindingSha256)
        || !validSha(value.descriptorSha256) || stableHash(body) !== value.descriptorSha256) {
        fail('ICML local PDF descriptor is invalid');
    }
    return clone(value);
}

function verifyLocalForumPdf({ authorityHandle, pdfRoot, posterId = null, forumId = null } = {}) {
    replayPosterAuthority(authorityHandle);
    if ((posterId === null) === (forumId === null)) fail('provide exactly one posterId or forumId');
    const record = posterId !== null ? lookupByPoster(authorityHandle, posterId) : lookupByForum(authorityHandle, forumId);
    const root = safeDirectory(pdfRoot, 'ICML local PDF root'); const filename = path.resolve(root, `${record.forumId}.pdf`);
    if (path.dirname(filename) !== root) fail('ICML local PDF path escapes its root');
    const loaded = readStableFile(filename, 'ICML local forum PDF', MAX_PDF_BYTES);
    if (loaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') fail('ICML local forum file is not a PDF');
    const authority = handleData(authorityHandle).authority;
    const body = { contract: PDF_DESCRIPTOR_CONTRACT, version: PDF_DESCRIPTOR_VERSION,
        posterId: record.posterId, forumId: record.forumId, absolutePath: filename,
        bytes: loaded.bytes.length, sha256: loaded.sha256, authoritySha256: authority.authoritySha256,
        recordBindingSha256: record.recordBindingSha256 };
    return normalizePdfDescriptor({ ...body, descriptorSha256: stableHash(body) });
}

function replayLocalForumPdfDescriptor({ descriptor, authorityHandle, pdfRoot } = {}) {
    const normalized = normalizePdfDescriptor(descriptor);
    const rebuilt = verifyLocalForumPdf({ authorityHandle, pdfRoot, posterId: normalized.posterId });
    if (stableHash(rebuilt) !== stableHash(normalized)) fail('ICML local PDF descriptor no longer replays');
    return normalized;
}

module.exports = {
    CONTRACT, VERSION, DAILY_BINDING_CONTRACT, DAILY_BINDING_VERSION, PDF_DESCRIPTOR_CONTRACT,
    PDF_DESCRIPTOR_VERSION, SOURCE_KIND, DIRECT_PAGE_MAPPING, SUMMARY_SECTION_MAPPING,
    HistoricalIcmlPosterAuthorityError, stableHash, loadPosterAuthority, normalizeAuthority,
    authorityHandleSnapshot, replayPosterAuthority, lookupByPoster, lookupByForum,
    bindDailyPage, normalizeDailyPageBinding, replayDailyPageBinding,
    verifyLocalForumPdf, normalizePdfDescriptor, replayLocalForumPdfDescriptor
};

'use strict';

// Resolve the deliberately narrow primary-paper marker used by legacy daily
// posts. The historical body is identity evidence only: callers receive byte
// offsets and hashes, never prose that could leak into a rewrite prompt.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'historical-daily-primary-arxiv-binding-v1';
const VERSION = 1;
const MAPPING = 'frozen-daily-score-row-primary-arxiv-link';
const SHA_RE = /^[a-f0-9]{64}$/;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const SOURCE_RE = /^(?:filename|frontmatter:[A-Za-z0-9_]+|body:(?:arxiv|openreview|ieee)-link)$/;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const SCORE_ROW_RE = /^(?:✅|🔥|📝) \*\*(?:10(?:\.0+)?|[0-9](?:\.[0-9]+)?)\/10\*\*(?: \| [^|\n]+)+ \| \[arxiv\]\((https:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?)\)$/u;

class HistoricalDailyPrimaryArxivBindingError extends Error {
    constructor(message) {
        super(`Historical daily primary arXiv binding rejected: ${message}`);
        this.name = 'HistoricalDailyPrimaryArxivBindingError';
        this.code = 'HISTORICAL_DAILY_PRIMARY_ARXIV_BINDING_INTEGRITY';
    }
}

const fail = message => { throw new HistoricalDailyPrimaryArxivBindingError(message); };
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
    if (!fs.existsSync(absolute)) fail(`${label} does not exist`);
    let cursor = path.parse(absolute).root;
    for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe`);
    }
    if (fs.realpathSync(absolute) !== absolute) fail(`${label} is unsafe`);
    return absolute;
}

function readFrozenPage(blogRoot, pagePath) {
    const root = safeDirectory(blogRoot, 'blogRoot');
    if (typeof pagePath !== 'string' || !pagePath || path.isAbsolute(pagePath)
        || pagePath.includes('\\') || pagePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        fail('pagePath must be a safe relative path');
    }
    const filename = path.resolve(root, ...pagePath.split('/'));
    if (!filename.startsWith(`${root}${path.sep}`)) fail('pagePath escapes blogRoot');
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > MAX_PAGE_BYTES) {
            fail('frozen daily page is unsafe or too large');
        }
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size) fail('frozen daily page changed while read');
        return { bytes, sha256: sha256(bytes) };
    } catch (error) {
        if (error instanceof HistoricalDailyPrimaryArxivBindingError) throw error;
        fail(`cannot read frozen daily page: ${error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function frontmatterArxivId(frontmatter) {
    const declarations = frontmatter.split('\n').filter(line => /^paper_digest_arxiv_id\s*:/u.test(line));
    if (!declarations.length) return null;
    if (declarations.length !== 1) fail('paper_digest_arxiv_id must not be duplicated');
    const match = declarations[0].match(/^paper_digest_arxiv_id:[ \t]*(?:"(\d{4}\.\d{4,5})"|'(\d{4}\.\d{4,5})'|(\d{4}\.\d{4,5}))[ \t]*$/u);
    if (!match) fail('paper_digest_arxiv_id is malformed');
    return match[1] || match[2] || match[3];
}

function filenameArxivId(pagePath) {
    const match = path.posix.basename(pagePath, '.md').match(/-(\d{4})-(\d{4,5})(?:v[1-9]\d*)?$/u);
    return match ? `${match[1]}.${match[2]}` : null;
}

function selectedCandidate(identityHints, arxivId) {
    if (!plain(identityHints) || !['conflict', 'multiple'].includes(identityHints.status)
        || !Array.isArray(identityHints.candidates)) {
        fail('resolver requires raw conflict/multiple identityHints');
    }
    const matches = identityHints.candidates.filter(candidate => plain(candidate)
        && candidate.scheme === 'arxiv' && candidate.value === arxivId);
    if (matches.length !== 1 || !Array.isArray(matches[0].sources)) {
        fail('selected arXiv ID is not a unique frozen identity candidate');
    }
    const sources = [...matches[0].sources];
    if (!sources.length || sources.some(source => typeof source !== 'string' || !SOURCE_RE.test(source))
        || [...sources].sort().some((source, index) => source !== sources[index])
        || new Set(sources).size !== sources.length || !sources.includes('body:arxiv-link')) {
        fail('selected arXiv candidate has invalid or missing body source evidence');
    }
    return sources;
}

function parsePrimaryRow(text, bodyStart) {
    const body = text.slice(bodyStart);
    const labelledStarts = [...body.matchAll(/\[arxiv\]\(/giu)];
    if (labelledStarts.length !== 1) fail('frozen page must contain exactly one [arxiv] link marker');
    const rows = []; let cursor = 0;
    for (const line of body.split('\n')) {
        const match = line.match(SCORE_ROW_RE);
        if (match) rows.push({ line, charStart: bodyStart + cursor, originalUrl: match[1], arxivId: match[2] });
        cursor += line.length + 1;
    }
    if (rows.length !== 1) fail('frozen page must contain exactly one strict score metadata row');
    const selected = rows[0];
    const sourceByteStart = Buffer.byteLength(text.slice(0, selected.charStart), 'utf8');
    const sourceByteEnd = sourceByteStart + Buffer.byteLength(selected.line, 'utf8');
    return { originalUrl: selected.originalUrl, arxivId: selected.arxivId,
        sourceByteStart, sourceByteEnd, semanticLineSha256: sha256(Buffer.from(selected.line, 'utf8')) };
}

function buildDailyPrimaryArxivBinding({ blogRoot, page, identityHints = page?.identityHints } = {}) {
    if (!plain(page) || !PAGE_KEY_RE.test(String(page.pageKey || '')) || typeof page.pagePath !== 'string'
        || !SHA_RE.test(String(page.pageContentSha256 || '')) || page.scope?.type !== 'daily') {
        fail('normalized daily inventory page is invalid');
    }
    const loaded = readFrozenPage(blogRoot, page.pagePath);
    if (loaded.sha256 !== page.pageContentSha256) fail('frozen page bytes differ from inventory');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); }
    catch { fail('frozen daily page is not strict UTF-8'); }
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/u);
    if (!frontmatter) fail('frozen daily page lacks strict frontmatter');
    const selected = parsePrimaryRow(text, frontmatter[0].length);
    const candidateSources = selectedCandidate(identityHints, selected.arxivId);
    const declaredId = frontmatterArxivId(frontmatter[1]);
    const namedId = filenameArxivId(page.pagePath);
    if (declaredId && declaredId !== selected.arxivId) fail('frontmatter arXiv ID disagrees with score row');
    if (namedId && namedId !== selected.arxivId) fail('filename arXiv ID disagrees with score row');
    if (declaredId && !candidateSources.includes('frontmatter:paper_digest_arxiv_id')) {
        fail('frontmatter arXiv evidence is absent from frozen candidate sources');
    }
    if (namedId && !candidateSources.includes('filename')) {
        fail('filename arXiv evidence is absent from frozen candidate sources');
    }
    const body = { contract: CONTRACT, version: VERSION, mapping: MAPPING, pageKey: page.pageKey,
        pagePath: page.pagePath, pageContentSha256: page.pageContentSha256,
        sourceByteStart: selected.sourceByteStart, sourceByteEnd: selected.sourceByteEnd,
        semanticLineSha256: selected.semanticLineSha256, linkLabel: 'arxiv',
        originalUrl: selected.originalUrl, arxivId: selected.arxivId, candidateSources,
        frontmatterArxivId: declaredId, filenameArxivId: namedId };
    return { ...body, bindingSha256: stableHash(body) };
}

function normalizeDailyPrimaryArxivBinding(value) {
    exact(value, ['contract', 'version', 'mapping', 'pageKey', 'pagePath', 'pageContentSha256',
        'sourceByteStart', 'sourceByteEnd', 'semanticLineSha256', 'linkLabel', 'originalUrl',
        'arxivId', 'candidateSources', 'frontmatterArxivId', 'filenameArxivId', 'bindingSha256'],
    'daily primary arXiv binding');
    const body = clone(value); delete body.bindingSha256;
    const urlMatch = String(value.originalUrl || '').match(/^https:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?$/u);
    if (value.contract !== CONTRACT || value.version !== VERSION || value.mapping !== MAPPING
        || !PAGE_KEY_RE.test(String(value.pageKey || '')) || typeof value.pagePath !== 'string' || !value.pagePath
        || path.isAbsolute(value.pagePath) || value.pagePath.includes('\\')
        || value.pagePath.split('/').some(segment => !segment || segment === '.' || segment === '..')
        || !SHA_RE.test(String(value.pageContentSha256 || ''))
        || !Number.isSafeInteger(value.sourceByteStart) || value.sourceByteStart < 0
        || !Number.isSafeInteger(value.sourceByteEnd) || value.sourceByteEnd <= value.sourceByteStart
        || !SHA_RE.test(String(value.semanticLineSha256 || '')) || value.linkLabel !== 'arxiv'
        || !ARXIV_ID_RE.test(String(value.arxivId || '')) || !urlMatch || urlMatch[1] !== value.arxivId
        || !Array.isArray(value.candidateSources) || !value.candidateSources.includes('body:arxiv-link')
        || value.candidateSources.some(source => typeof source !== 'string' || !SOURCE_RE.test(source))
        || [...value.candidateSources].sort().some((source, index) => source !== value.candidateSources[index])
        || new Set(value.candidateSources).size !== value.candidateSources.length
        || ![null, value.arxivId].includes(value.frontmatterArxivId)
        || ![null, value.arxivId].includes(value.filenameArxivId)
        || (value.frontmatterArxivId && !value.candidateSources.includes('frontmatter:paper_digest_arxiv_id'))
        || (value.filenameArxivId && !value.candidateSources.includes('filename'))
        || !SHA_RE.test(String(value.bindingSha256 || '')) || stableHash(body) !== value.bindingSha256) {
        fail('daily primary arXiv binding is invalid');
    }
    return clone(value);
}

module.exports = {
    CONTRACT, VERSION, MAPPING,
    contract: CONTRACT, mapping: MAPPING,
    HistoricalDailyPrimaryArxivBindingError,
    build: buildDailyPrimaryArxivBinding,
    normalize: normalizeDailyPrimaryArxivBinding,
    buildDailyPrimaryArxivBinding,
    normalizeDailyPrimaryArxivBinding
};

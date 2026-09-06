'use strict';

// Cross-runtime identity record for papers that may be sourced from arXiv or
// conference proceedings.  This deliberately does not import the historic
// arXiv helpers: consumers must opt into this v1 contract instead of silently
// changing legacy daily-digest identity behaviour.

const crypto = require('node:crypto');

const CONTRACT = 'paper-identity-v1';
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCHEMES = new Set(['icassp-arnumber', 'openreview-forum-id', 'conference-paper-id']);
const SHA_RE = /^[a-f0-9]{64}$/;

function fail(message) { throw new Error(`Invalid paper identity: ${message}`); }

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        fail(`${label} must be a plain object`);
    }
}

function assertExactFields(value, fields, label) {
    assertPlainObject(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}

function assertText(value, label, { allowEmpty = false, max = 4096 } = {}) {
    if (typeof value !== 'string' || value !== value.trim() || value.length > max
        || (!allowEmpty && !value) || /[\u0000-\u001f\u007f]/u.test(value)) {
        fail(`${label} must be a trimmed text value without controls`);
    }
    return value;
}

function assertYear(value, label) {
    if (!Number.isInteger(value) || value < 1900 || value > 2100) fail(`${label} must be a supported four-digit year`);
    return value;
}

function validateExternalId(value) {
    assertExactFields(value, ['scheme', 'value'], 'externalId');
    if (!SCHEMES.has(value.scheme)) fail('externalId.scheme is unsupported');
    assertText(value.value, 'externalId.value', { max: 128 });
    const valid = (value.scheme === 'icassp-arnumber' || value.scheme === 'conference-paper-id')
        ? /^[1-9]\d*$/.test(value.value)
        : /^[A-Za-z0-9_-]{6,128}$/.test(value.value);
    if (!valid) fail('externalId.value is invalid for its scheme');
    return { scheme: value.scheme, value: value.value };
}

function isPublicDnsName(hostname) {
    // The source URL is a display/provenance pointer, not a network admission
    // decision.  Still reject literals and special-use local names here so an
    // identity record cannot smuggle a localhost/private URL into a renderer.
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
        || hostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
    if (hostname.length > 253 || !hostname.includes('.')) return false;
    return hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function validateOfficialUrl(value, label) {
    assertText(value, label, { max: 2048 });
    let parsed;
    try { parsed = new URL(value); } catch { fail(`${label} is not a URL`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || parsed.search || parsed.hash || !isPublicDnsName(parsed.hostname)) {
        fail(`${label} must be a canonical public HTTPS URL without credentials, port, query, or fragment`);
    }
    // Require a non-root, portable, unambiguous path.  Checking both the raw
    // spelling and URL form prevents URL() from normalising a traversal away.
    const rawPath = value.slice(`https://${parsed.host}`.length);
    if (parsed.pathname === '/' || rawPath !== parsed.pathname || parsed.pathname.includes('//')
        || parsed.pathname.split('/').slice(1).some(part => !/^[A-Za-z0-9._~-]+$/.test(part))) {
        fail(`${label} has an unsafe or non-canonical path`);
    }
    if (parsed.toString() !== value) fail(`${label} must use canonical URL spelling`);
    return value;
}

function validateSource(value) {
    assertExactFields(value, ['status', 'url'], 'source');
    if (value.status === 'unavailable') {
        if (value.url !== null) fail('source.url must be null when unavailable');
        return { status: 'unavailable', url: null };
    }
    if (value.status !== 'official') fail('source.status must be official or unavailable');
    return { status: 'official', url: validateOfficialUrl(value.url, 'source.url') };
}

function validateCitation(value) {
    if (value === null) return null;
    assertExactFields(value, ['title', 'authors', 'venue', 'year'], 'citation');
    assertText(value.title, 'citation.title', { max: 2048 });
    if (!Array.isArray(value.authors) || value.authors.length > 100) fail('citation.authors must be an array of at most 100 names');
    const authors = value.authors.map((author, index) => assertText(author, `citation.authors[${index}]`, { max: 512 }));
    if (new Set(authors).size !== authors.length) fail('citation.authors must not contain duplicate names');
    if (value.venue !== null) assertText(value.venue, 'citation.venue', { max: 512 });
    if (value.year !== null) assertYear(value.year, 'citation.year');
    return { title: value.title, authors, venue: value.venue, year: value.year };
}

function canonicalConferenceId(conference, externalId) {
    return `conference:${conference.slug}:${conference.year}:${externalId.scheme}:${externalId.value}`;
}

function normalizeIdentity(value) {
    assertExactFields(value, ['contract', 'kind', 'canonicalId', 'arxivId', 'conference', 'externalId', 'source', 'citation'], 'paper identity');
    if (value.contract !== CONTRACT) fail(`contract must be ${CONTRACT}`);
    if (value.kind !== 'arxiv' && value.kind !== 'conference') fail('kind must be arxiv or conference');
    const source = validateSource(value.source);
    const citation = validateCitation(value.citation);

    if (value.kind === 'arxiv') {
        if (!ARXIV_ID_RE.test(String(value.arxivId || ''))) fail('arxivId is invalid');
        if (value.conference !== null || value.externalId !== null) fail('arxiv identity must not contain conference fields');
        const canonicalId = `arxiv:${value.arxivId}`;
        if (value.canonicalId !== canonicalId) fail('canonicalId does not bind arxivId');
        if (source.status === 'official' && source.url !== `https://arxiv.org/abs/${value.arxivId}`) {
            fail('official arxiv source.url must bind its exact canonical abs URL');
        }
        return { contract: CONTRACT, kind: 'arxiv', canonicalId, arxivId: value.arxivId,
            conference: null, externalId: null, source, citation };
    }

    if (value.arxivId !== null) fail('conference identity must not contain arxivId');
    assertExactFields(value.conference, ['slug', 'year'], 'conference');
    if (!SLUG_RE.test(String(value.conference.slug || ''))) fail('conference.slug must be a normalized slug');
    const conference = { slug: value.conference.slug, year: assertYear(value.conference.year, 'conference.year') };
    const externalId = validateExternalId(value.externalId);
    const canonicalId = canonicalConferenceId(conference, externalId);
    if (value.canonicalId !== canonicalId) fail('canonicalId does not bind conference, year, scheme, and value');
    return { contract: CONTRACT, kind: 'conference', canonicalId, arxivId: null,
        conference, externalId, source, citation };
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
    }
    return value;
}

function stableJson(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableSha256(value) { return sha256(stableJson(value)); }
function identityPayload(value) {
    const normalized = normalizeIdentity(value);
    return normalized.kind === 'arxiv'
        ? { contract: CONTRACT, kind: 'arxiv', canonicalId: normalized.canonicalId, arxivId: normalized.arxivId }
        : { contract: CONTRACT, kind: 'conference', canonicalId: normalized.canonicalId,
            conference: normalized.conference, externalId: normalized.externalId };
}
function identitySha256(value) { return stableSha256(identityPayload(value)); }
function recordSha256(value) { return stableSha256(normalizeIdentity(value)); }
function isSha256(value) { return SHA_RE.test(String(value || '')); }

module.exports = {
    CONTRACT, ARXIV_ID_RE, SCHEMES, canonicalConferenceId, validateExternalId,
    validateOfficialUrl, validateSource, validateCitation, normalizeIdentity,
    identityPayload, stableJson, sha256, stableSha256, identitySha256, recordSha256, isSha256
};

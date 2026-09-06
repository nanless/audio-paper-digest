'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const identity = require('../scripts/lib/paper-identity.js');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'paper-identity-v1-vectors.json'), 'utf8'));

test('paper-identity-v1 vectors are canonical and cross-runtime stable', () => {
    assert.equal(vectors.contract, identity.CONTRACT);
    for (const vector of vectors.vectors) {
        const normalized = identity.normalizeIdentity(vector.record);
        assert.deepEqual(normalized, vector.normalized, vector.name);
        assert.equal(identity.stableJson(normalized), vector.stableJson, vector.name);
        assert.equal(identity.identitySha256(normalized), vector.identitySha256, vector.name);
        assert.equal(identity.recordSha256(normalized), vector.recordSha256, vector.name);
    }
});

test('conference canonical identity includes meeting slug, year, scheme and external value; citation is never an identity', () => {
    const record = structuredClone(vectors.vectors[1].record);
    assert.equal(record.canonicalId, 'conference:icassp:2026:icassp-arnumber:10910001');
    const before = identity.identitySha256(record);
    record.citation.title = 'A different display title is not an identifier';
    assert.equal(identity.identitySha256(record), before);
    assert.notEqual(identity.recordSha256(record), vectors.vectors[1].recordSha256);
    record.canonicalId = 'conference:icassp:2026:icassp-arnumber:A-title';
    assert.throws(() => identity.normalizeIdentity(record), /canonicalId|invalid/);
});

test('conference ledger coordinates produce the same canonical ID and reject the retired temporary form', () => {
    const conference = { id: 'icassp-2026', year: 2026 };
    const sourceIdentity = { type: 'icassp-arnumber', value: '10910001' };
    const expected = 'conference:icassp:2026:icassp-arnumber:10910001';
    assert.equal(identity.canonicalConferencePaperId(conference, sourceIdentity), expected);
    assert.equal(identity.assertCanonicalConferencePaperId(expected, conference, sourceIdentity), expected);
    assert.throws(() => identity.assertCanonicalConferencePaperId(
        'icassp-2026:icassp-arnumber:10910001', conference, sourceIdentity), /conference paperId/);
    assert.throws(() => identity.canonicalConferencePaperId(
        { id: 'icassp-2025', year: 2026 }, sourceIdentity), /exact year/);
});

test('all unknown fields and arxiv/conference field confusion fail closed', () => {
    const arxiv = structuredClone(vectors.vectors[0].record);
    arxiv.title = 'titles are citation metadata only';
    assert.throws(() => identity.normalizeIdentity(arxiv), /unknown or missing/);
    const confusedArxiv = structuredClone(vectors.vectors[0].record);
    confusedArxiv.conference = { slug: 'icassp', year: 2026 };
    assert.throws(() => identity.normalizeIdentity(confusedArxiv), /must not contain conference/);
    const conference = structuredClone(vectors.vectors[1].record);
    conference.arxivId = '2609.03622';
    assert.throws(() => identity.normalizeIdentity(conference), /must not contain arxivId/);
    const unknownScheme = structuredClone(vectors.vectors[1].record);
    unknownScheme.externalId.scheme = 'title';
    assert.throws(() => identity.normalizeIdentity(unknownScheme), /unsupported/);
});

test('source URLs must be official HTTPS or explicitly unavailable, never credentials, IP literals, traversal, or loose paths', () => {
    const base = structuredClone(vectors.vectors[1].record);
    for (const url of [
        'http://ieeexplore.ieee.org/document/10910001',
        'https://user:pass@ieeexplore.ieee.org/document/10910001',
        'https://127.0.0.1/document/10910001',
        'https://[::1]/document/10910001',
        'https://ieeexplore.ieee.org/document/../10910001',
        'https://ieeexplore.ieee.org/'
    ]) {
        const changed = structuredClone(base); changed.source.url = url;
        assert.throws(() => identity.normalizeIdentity(changed), /source\.url/);
    }
    base.source = { status: 'unavailable', url: null };
    assert.equal(identity.normalizeIdentity(base).source.status, 'unavailable');
    base.source.url = 'https://ieeexplore.ieee.org/document/10910001';
    assert.throws(() => identity.normalizeIdentity(base), /must be null/);
});

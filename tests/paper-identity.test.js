'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const identity = require('../scripts/lib/paper-identity.js');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'paper-identity-v1-vectors.json'), 'utf8'));

test('paper-identity-v1 的测试向量是正式的，且跨运行时稳定', () => {
    assert.equal(vectors.contract, identity.CONTRACT);
    for (const vector of vectors.vectors) {
        const normalized = identity.normalizeIdentity(vector.record);
        assert.deepEqual(normalized, vector.normalized, vector.name);
        assert.equal(identity.stableJson(normalized), vector.stableJson, vector.name);
        assert.equal(identity.identitySha256(normalized), vector.identitySha256, vector.name);
        assert.equal(identity.recordSha256(normalized), vector.recordSha256, vector.name);
    }
});

test('会议正式身份包含会议标识、年份、方案和外部值；引文永远不算身份', () => {
    const record = structuredClone(vectors.vectors[1].record);
    assert.equal(record.canonicalId, 'conference:icassp:2026:icassp-arnumber:10910001');
    const before = identity.identitySha256(record);
    record.citation.title = 'A different display title is not an identifier';
    assert.equal(identity.identitySha256(record), before);
    assert.notEqual(identity.recordSha256(record), vectors.vectors[1].recordSha256);
    record.canonicalId = 'conference:icassp:2026:icassp-arnumber:A-title';
    assert.throws(() => identity.normalizeIdentity(record), /canonicalId|invalid/);
});

test('会议台账坐标产生同一个正式 ID，并拒绝已停用的临时形式', () => {
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

test('conference-paper-id 接受官方稳定 token 写法，但不放宽其他身份方案', () => {
    for (const value of ['1', 'AAAI.2026-001_camera', 'x'.repeat(200)]) {
        assert.deepEqual(identity.validateExternalId({ scheme: 'conference-paper-id', value }),
            { scheme: 'conference-paper-id', value });
    }
    for (const value of ['contains space', 'path/segment', 'doi:10.1', 'x'.repeat(201)]) {
        assert.throws(() => identity.validateExternalId({ scheme: 'conference-paper-id', value }), /invalid|trimmed/);
    }
    assert.throws(() => identity.validateExternalId({ scheme: 'icassp-arnumber', value: 'AAAI.2026-001' }), /invalid/);
    assert.throws(() => identity.validateExternalId({ scheme: 'openreview-forum-id', value: 'short' }), /invalid/);
    assert.throws(() => identity.validateExternalId({ scheme: 'openreview-forum-id', value: 'Forum.2026' }), /invalid/);
});

test('所有未知字段以及 arXiv 与会议字段混用都直接失败', () => {
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

test('大型官方合作作者名单保持有界，不被截断', () => {
    const record = structuredClone(vectors.vectors[1].record);
    record.citation.authors = Array.from({ length: 102 }, (_, index) => `Author ${index + 1}`);
    assert.equal(identity.normalizeIdentity(record).citation.authors.length, 102);
    record.citation.authors = Array.from({ length: 1001 }, (_, index) => `Author ${index + 1}`);
    assert.throws(() => identity.normalizeIdentity(record), /at most 1000 names/);
});

test('来源 URL 必须是官方 HTTPS 或明确标记不可得，绝不允许凭证、IP 字面量、路径穿越或松散路径', () => {
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

test('官方 URL 接受一个正式末尾斜杠，但拒绝空、点、编码和非正式的路径写法', () => {
    assert.equal(identity.validateOfficialUrl(
        'https://aclanthology.org/2026.eacl-long.102/', 'official record URL'
    ), 'https://aclanthology.org/2026.eacl-long.102/');
    assert.equal(identity.validateOfficialUrl(
        'https://aclanthology.org/2026.eacl-long.102', 'official record URL'
    ), 'https://aclanthology.org/2026.eacl-long.102');
    for (const url of [
        'https://aclanthology.org/2026.eacl-long.102//',
        'https://aclanthology.org/2026.eacl-long.102//appendix',
        'https://aclanthology.org/2026.eacl-long.102/./appendix',
        'https://aclanthology.org/2026.eacl-long.102/../appendix',
        'https://aclanthology.org/2026.eacl-long.102/%2e%2e/appendix',
        'https://aclanthology.org/2026.eacl-long.102/%2Fappendix',
        'https://ACLANthology.org/2026.eacl-long.102/'
    ]) {
        assert.throws(() => identity.validateOfficialUrl(url, 'official record URL'),
            /unsafe or non-canonical|canonical URL spelling/);
    }
});

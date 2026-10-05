'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPageTagMetadata } = require('../scripts/lib/page-tag-metadata.js');
const page = fields => Buffer.from(`---\n${fields}\n---\nOriginal body.\n`);
const contract = 'paper-taxonomy-flat-tags-compat-v1';

test('页面标签识别支持当前字段及原样旧字段，不读取正文中的字段', () => {
    for (const family of ['tags', 'taxonomy']) {
        const bytes = page(`paper_digest_${family}_contract: "${contract}"`);
        const original = Buffer.from(bytes);
        assert.equal(hasPageTagMetadata(bytes), true);
        assert.deepEqual(bytes, original);
    }
    assert.equal(hasPageTagMetadata(page('title: Old page')), false);
    assert.equal(hasPageTagMetadata(Buffer.from(`---\ntitle: Old page\n---\npaper_digest_tags_contract: "${contract}"\n`)), false);
});

test('页面新旧标签字段不能混用，包括等值、null 和带引号的键', () => {
    for (const old of [
        `paper_digest_taxonomy_contract: "${contract}"`,
        'paper_digest_taxonomy_concepts: null',
        '"paper_digest_taxonomy_scope": null',
        "'paper_digest_taxonomy_registry_sha256': null",
        '"paper_digest_\\u0074axonomy_concepts": null'
    ]) {
        assert.throws(() => hasPageTagMetadata(page(`paper_digest_tags_contract: "${contract}"\n${old}`)), /新旧标签字段/);
    }
});

test('页面标签格式标识须完整匹配，缺少或未知标识仍可进入旧页面补充', () => {
    for (const value of ['null', 'paper-taxonomy-flat-tags-compat-v1-other', '"paper-taxonomy-flat-tags-compat-v1 trailing"']) {
        assert.equal(hasPageTagMetadata(page(`paper_digest_tags_contract: ${value}`)), false);
    }
    assert.equal(hasPageTagMetadata(page('paper_digest_tags_concepts: []')), false);
    assert.throws(() => hasPageTagMetadata(page(`paper_digest_tags_contract: "${contract}"\n"paper_digest_tags_contract": null`)), /无法解析/);
});

test('页面标签只检查实际顶层 YAML 字段，识别 flow 和 quoted 映射', () => {
    const nested = `paper_digest_tags_contract: "${contract}"\ndescription: |\n  paper_digest_taxonomy_contract: null\nmetadata:\n  paper_digest_taxonomy_concepts: []`;
    assert.equal(hasPageTagMetadata(page(nested)), true);
    assert.equal(hasPageTagMetadata(page(`{"paper_digest_tags_contract": "${contract}"}`)), true);
    assert.throws(() => hasPageTagMetadata(page(`{paper_digest_tags_contract: "${contract}", paper_digest_taxonomy_concepts: null}`)), /新旧标签字段/);
    assert.throws(() => hasPageTagMetadata(page('{paper_digest_tags_contract: null, paper_digest_tags_contract: null}')), /无法解析/);
});

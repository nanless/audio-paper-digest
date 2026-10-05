'use strict';

const YAML = require('yaml');
const { TAG_FLAT_COMPAT_CONTRACT, LEGACY_TAG_FLAT_COMPAT_CONTRACT } = require('./tag-rules.js');

const PAGE_TAG_FIELD_SUFFIXES = ['contract', 'selection_contract', 'registry_version',
    'registry_sha256', 'concepts', 'scope'];
const PAGE_TAG_FIELDS = PAGE_TAG_FIELD_SUFFIXES.map(suffix => `paper_digest_tags_${suffix}`);
const LEGACY_PAGE_TAG_FIELDS = PAGE_TAG_FIELD_SUFFIXES.map(suffix => `paper_digest_taxonomy_${suffix}`);

function hasPageTagMetadata(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) throw new Error('页面缺少完整的 YAML 页首字段。');
    let fields;
    try {
        fields = YAML.parse(frontmatter[1], { mapAsMap: true, uniqueKeys: true, maxAliasCount: 100 });
    } catch (cause) {
        throw new Error('页面的 YAML 页首字段无法解析。', { cause });
    }
    if (!(fields instanceof Map)) throw new Error('页面的 YAML 页首字段必须是映射。');
    const current = PAGE_TAG_FIELDS.some(key => fields.has(key));
    const legacy = LEGACY_PAGE_TAG_FIELDS.some(key => fields.has(key));
    if (current && legacy) throw new Error('页面不能同时包含新旧标签字段。');
    if (!current && !legacy) return false;
    const contract = fields.get(current ? 'paper_digest_tags_contract' : 'paper_digest_taxonomy_contract');
    return [TAG_FLAT_COMPAT_CONTRACT, LEGACY_TAG_FLAT_COMPAT_CONTRACT].includes(contract);
}

module.exports = { PAGE_TAG_FIELDS, LEGACY_PAGE_TAG_FIELDS, hasPageTagMetadata };

'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const FACET_IDS = Object.freeze(['task', 'method', 'setting', 'signal', 'application', 'research_focus', 'artifact', 'scientific_topic', 'model_family']);
const TAG_CATALOG_VERSION = 'paper-tag-catalog-v2';
const LEGACY_TAG_CATALOG_VERSION = 'paper-taxonomy-v1';
const CONCEPT_KEYS = ['id', 'facet', 'preferredLabel', 'aliases', 'broaderId', 'definition', 'scopeNote', 'status', 'replacedBy'];

// 有意与 Python 保持一致：NFKC、strip、一个 #、仅 ASCII 小写。
function normalizeLabel(value) {
    if (typeof value !== 'string') return '';
    let result = value.normalize('NFKC').trim();
    if (result.startsWith('#')) result = result.slice(1).trim();
    return result.replace(/[A-Z]/g, c => c.toLowerCase());
}

function object(value, keys, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} 必须是普通对象。`);
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || actual.some((key, i) => key !== [...keys].sort()[i])) throw new Error(`${name} 包含未知字段或缺少必需字段。`);
}

function string(value, name) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()
        || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} 必须是非空字符串，且不能包含首尾空白或控制字符。`);
}

function validateTagCatalog(data) {
    object(data, ['version', 'facets', 'concepts'], '标签词表');
    if (![TAG_CATALOG_VERSION, LEGACY_TAG_CATALOG_VERSION].includes(data.version)) throw new Error('标签词表的版本不受支持。');
    if (!Array.isArray(data.facets) || data.facets.length !== FACET_IDS.length) throw new Error('标签词表必须包含全部九个分类维度。');
    const facets = new Set();
    for (const facet of data.facets) {
        object(facet, ['id', 'label'], '分类维度');
        if (!FACET_IDS.includes(facet.id) || facets.has(facet.id)) throw new Error(`分类维度无效或重复：${facet.id}`);
        string(facet.label, 'facet.label');
        facets.add(facet.id);
    }
    if (!Array.isArray(data.concepts) || !data.concepts.length) throw new Error('标签词表的 concepts 必须是非空数组。');
    const ids = new Map();
    const labels = new Map();
    for (const concept of data.concepts) {
        object(concept, CONCEPT_KEYS, '分类概念');
        if (!facets.has(concept.facet) || typeof concept.id !== 'string'
            || !new RegExp(`^${concept.facet}\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`).test(concept.id)
            || ids.has(concept.id)) throw new Error(`概念 ID 的格式或所属分类维度无效，或 ID 重复：${concept.id}`);
        object(concept.preferredLabel, ['zh', 'en'], `${concept.id}.preferredLabel`);
        for (const language of ['zh', 'en']) string(concept.preferredLabel[language], `${concept.id}.${language}`);
        string(concept.definition, `${concept.id}.definition`);
        string(concept.scopeNote, `${concept.id}.scopeNote`);
        if (!Array.isArray(concept.aliases)) throw new Error(`概念 ${concept.id} 的 aliases 必须是数组。`);
        const aliases = new Set();
        for (const alias of concept.aliases) {
            string(alias, `${concept.id}.alias`);
            const normalized = normalizeLabel(alias);
            if (!normalized || aliases.has(normalized)) throw new Error(`概念 ${concept.id} 的别名在规范化后为空或重复。`);
            aliases.add(normalized);
        }
        if (!['active', 'deprecated'].includes(concept.status)) throw new Error(`概念 ${concept.id} 的状态必须为 active 或 deprecated。`);
        if (concept.broaderId !== null && typeof concept.broaderId !== 'string') throw new Error(`概念 ${concept.id} 的 broaderId 必须是字符串或 null。`);
        if (concept.status === 'active' && concept.replacedBy !== null) throw new Error(`已启用的概念 ${concept.id} 不能指定替代概念。`);
        if (concept.status === 'deprecated' && (typeof concept.replacedBy !== 'string' || !concept.replacedBy)) throw new Error(`已停用的概念 ${concept.id} 必须指定非空的替代概念 ID。`);
        ids.set(concept.id, concept);
        for (const label of [...Object.values(concept.preferredLabel), ...concept.aliases]) {
            const normalized = normalizeLabel(label);
            if (!normalized) throw new Error(`概念 ${concept.id} 的标签在规范化后为空。`);
            const key = `${concept.facet}\0${normalized}`;
            if (labels.has(key) && labels.get(key) !== concept.id) throw new Error(`分类维度 ${concept.facet} 中的标签对应了多个概念：${label}`);
            labels.set(key, concept.id);
        }
    }
    for (const concept of data.concepts) {
        if (concept.broaderId !== null) {
            const parent = ids.get(concept.broaderId);
            if (!parent || parent.facet !== concept.facet || parent.status !== 'active') throw new Error(`概念 ${concept.id} 的上级概念必须存在、已启用，并属于同一分类维度。`);
        }
        if (concept.status === 'deprecated') {
            const replacement = ids.get(concept.replacedBy);
            if (!replacement || replacement.id === concept.id || replacement.status !== 'active' || replacement.facet !== concept.facet) throw new Error(`概念 ${concept.id} 的替代概念必须存在、已启用、属于同一分类维度，且不能是自身。`);
        }
        const seen = new Set([concept.id]);
        let parent = concept.broaderId;
        while (parent !== null) {
            if (seen.has(parent)) throw new Error(`概念 ${concept.id} 的上级关系形成了循环。`);
            seen.add(parent);
            const node = ids.get(parent);
            if (!node) throw new Error(`概念 ${concept.id} 的上级关系引用了不存在的概念。`);
            parent = node.broaderId;
        }
    }
    return data;
}

function registryData(tagCatalog) {
    if (!tagCatalog || typeof tagCatalog !== 'object') throw new Error('标签词表必须是对象。');
    if (Object.prototype.hasOwnProperty.call(tagCatalog, 'registrySha256')) {
        object(tagCatalog, ['version', 'facets', 'concepts', 'registrySha256'], '已加载的标签词表');
        if (typeof tagCatalog.registrySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tagCatalog.registrySha256)) throw new Error('词表记录中的 registrySha256 格式无效。');
    } else {
        object(tagCatalog, ['version', 'facets', 'concepts'], '标签词表');
    }
    // 加载时取得的 SHA 是文件元数据；这里校验词表内容，不以这个字段判断标签是否有效。
    const data = { version: tagCatalog.version, facets: tagCatalog.facets, concepts: tagCatalog.concepts };
    validateTagCatalog(data);
    return data;
}

function loadTagCatalog(filePath) {
    const target = filePath === undefined ? require('../config.js').FILES.tagCatalogFile : filePath;
    if (typeof target !== 'string' || !target) throw new Error('必须提供标签词表文件路径。');
    const bytes = fs.readFileSync(target);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('标签词表文件不能超过 2 MiB。');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text);
    // JSON.parse 会保留重复字段的最后一个值，因此需要另行检查重复字段。
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) throw new Error(`JSON 中出现重复字段：${key}`);
            top.keys.add(key);
            top.expectKey = false;
        }
    }
    const data = validateTagCatalog(parsed);
    if (filePath === undefined && data.version !== TAG_CATALOG_VERSION) {
        throw new Error('当前标签词表必须使用 paper-tag-catalog-v2。');
    }
    return { ...data, registrySha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function resolveLabel(tagCatalog, label, facet) {
    const matches = resolveLabelCandidates(tagCatalog, label, facet);
    // 已废弃的概念仍然是显式对象；不做悄无声息的前向迁移。
    return matches.length === 1 ? matches[0] : null;
}

function resolveLabelCandidates(tagCatalog, label, facet) {
    const data = registryData(tagCatalog);
    if (facet === null) facet = undefined;
    if (facet !== undefined && !FACET_IDS.includes(facet)) throw new Error(`未知的分类维度：${facet}`);
    const normalized = normalizeLabel(label);
    if (!normalized) return [];
    const matches = data.concepts.filter(c => (facet === undefined || c.facet === facet)
        && [...Object.values(c.preferredLabel), ...c.aliases].some(value => normalizeLabel(value) === normalized));
    return matches.map(item => structuredClone(item));
}

function ancestors(tagCatalog, id) {
    const data = registryData(tagCatalog);
    const byId = new Map(data.concepts.map(c => [c.id, c]));
    if (!byId.has(id)) throw new Error(`未知的概念 ID：${id}`);
    const result = [];
    let parent = byId.get(id).broaderId;
    while (parent !== null) {
        result.push(parent);
        parent = byId.get(parent).broaderId;
    }
    return result;
}

function pruneAncestors(tagCatalog, ids) {
    registryData(tagCatalog);
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('概念 ID 列表必须是字符串数组。');
    const covered = new Set(ids.flatMap(id => ancestors(tagCatalog, id)));
    return ids.filter(id => !covered.has(id));
}

module.exports = { TAG_CATALOG_VERSION, LEGACY_TAG_CATALOG_VERSION, loadTagCatalog, validateTagCatalog, normalizeLabel, resolveLabelCandidates,
    resolveLabel, ancestors, pruneAncestors };

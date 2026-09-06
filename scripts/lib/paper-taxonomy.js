'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const FACET_IDS = Object.freeze(['task', 'method', 'setting', 'signal', 'application', 'research_focus', 'artifact', 'scientific_topic', 'model_family']);
const CONCEPT_KEYS = ['id', 'facet', 'preferredLabel', 'aliases', 'broaderId', 'definition', 'scopeNote', 'status', 'replacedBy'];

// Keep this deliberately identical to Python: NFKC, strip, one #, ASCII-only lower.
function normalizeLabel(value) {
    if (typeof value !== 'string') return '';
    let result = value.normalize('NFKC').trim();
    if (result.startsWith('#')) result = result.slice(1).trim();
    return result.replace(/[A-Z]/g, c => c.toLowerCase());
}

function object(value, keys, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name}: expected plain object`);
    const actual = Object.keys(value).sort();
    if (actual.length !== keys.length || actual.some((key, i) => key !== [...keys].sort()[i])) throw new Error(`${name}: unexpected or missing fields`);
}

function string(value, name) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()
        || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name}: expected nonempty trimmed string without controls`);
}

function validateTaxonomy(data) {
    object(data, ['version', 'facets', 'concepts'], 'taxonomy');
    if (data.version !== 'paper-taxonomy-v1') throw new Error('Unsupported taxonomy version');
    if (!Array.isArray(data.facets) || data.facets.length !== FACET_IDS.length) throw new Error('taxonomy: all nine facets required');
    const facets = new Set();
    for (const facet of data.facets) {
        object(facet, ['id', 'label'], 'facet');
        if (!FACET_IDS.includes(facet.id) || facets.has(facet.id)) throw new Error(`Invalid/duplicate facet: ${facet.id}`);
        string(facet.label, 'facet.label');
        facets.add(facet.id);
    }
    if (!Array.isArray(data.concepts) || !data.concepts.length) throw new Error('taxonomy: nonempty concepts required');
    const ids = new Map();
    const labels = new Map();
    for (const concept of data.concepts) {
        object(concept, CONCEPT_KEYS, 'concept');
        if (!facets.has(concept.facet) || typeof concept.id !== 'string'
            || !new RegExp(`^${concept.facet}\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`).test(concept.id)
            || ids.has(concept.id)) throw new Error(`Invalid/duplicate concept ID: ${concept.id}`);
        object(concept.preferredLabel, ['zh', 'en'], `${concept.id}.preferredLabel`);
        for (const language of ['zh', 'en']) string(concept.preferredLabel[language], `${concept.id}.${language}`);
        string(concept.definition, `${concept.id}.definition`);
        string(concept.scopeNote, `${concept.id}.scopeNote`);
        if (!Array.isArray(concept.aliases)) throw new Error(`${concept.id}: aliases must be array`);
        const aliases = new Set();
        for (const alias of concept.aliases) {
            string(alias, `${concept.id}.alias`);
            const normalized = normalizeLabel(alias);
            if (!normalized || aliases.has(normalized)) throw new Error(`${concept.id}: empty/duplicate alias`);
            aliases.add(normalized);
        }
        if (!['active', 'deprecated'].includes(concept.status)) throw new Error(`${concept.id}: invalid status`);
        if (concept.broaderId !== null && typeof concept.broaderId !== 'string') throw new Error(`${concept.id}: invalid broaderId`);
        if (concept.status === 'active' && concept.replacedBy !== null) throw new Error(`${concept.id}: active concept cannot have replacement`);
        if (concept.status === 'deprecated' && (typeof concept.replacedBy !== 'string' || !concept.replacedBy)) throw new Error(`${concept.id}: deprecated concept requires replacement`);
        ids.set(concept.id, concept);
        for (const label of [...Object.values(concept.preferredLabel), ...concept.aliases]) {
            const normalized = normalizeLabel(label);
            if (!normalized) throw new Error(`${concept.id}: empty normalized label`);
            const key = `${concept.facet}\0${normalized}`;
            if (labels.has(key) && labels.get(key) !== concept.id) throw new Error(`Ambiguous label in facet ${concept.facet}: ${label}`);
            labels.set(key, concept.id);
        }
    }
    for (const concept of data.concepts) {
        if (concept.broaderId !== null) {
            const parent = ids.get(concept.broaderId);
            if (!parent || parent.facet !== concept.facet || parent.status !== 'active') throw new Error(`${concept.id}: parent must be existing active same-facet concept`);
        }
        if (concept.status === 'deprecated') {
            const replacement = ids.get(concept.replacedBy);
            if (!replacement || replacement.id === concept.id || replacement.status !== 'active' || replacement.facet !== concept.facet) throw new Error(`${concept.id}: replacement must be another active same-facet concept`);
        }
        const seen = new Set([concept.id]);
        let parent = concept.broaderId;
        while (parent !== null) {
            if (seen.has(parent)) throw new Error(`${concept.id}: taxonomy cycle`);
            seen.add(parent);
            const node = ids.get(parent);
            if (!node) throw new Error(`${concept.id}: missing ancestor`);
            parent = node.broaderId;
        }
    }
    return data;
}

function registryData(taxonomy) {
    if (!taxonomy || typeof taxonomy !== 'object') throw new Error('taxonomy: expected registry');
    if (Object.prototype.hasOwnProperty.call(taxonomy, 'registrySha256')) {
        object(taxonomy, ['version', 'facets', 'concepts', 'registrySha256'], 'loaded taxonomy');
        if (typeof taxonomy.registrySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(taxonomy.registrySha256)) throw new Error('Invalid registrySha256');
    } else {
        object(taxonomy, ['version', 'facets', 'concepts'], 'taxonomy');
    }
    // Loaded SHA is metadata, never part of validation or label authority.
    const data = { version: taxonomy.version, facets: taxonomy.facets, concepts: taxonomy.concepts };
    validateTaxonomy(data);
    return data;
}

function loadTaxonomy(filePath) {
    const target = filePath === undefined ? require('../config.js').FILES.taxonomyRegistry : filePath;
    if (typeof target !== 'string' || !target) throw new Error('taxonomyRegistry path required');
    const bytes = fs.readFileSync(target);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('taxonomyRegistry exceeds 2 MiB');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text);
    // JSON.parse otherwise silently keeps the last duplicate object key.
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
            if (top.keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`);
            top.keys.add(key);
            top.expectKey = false;
        }
    }
    const data = validateTaxonomy(parsed);
    return { ...data, registrySha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function resolveLabel(taxonomy, label, facet) {
    const data = registryData(taxonomy);
    if (facet === null) facet = undefined;
    if (facet !== undefined && !FACET_IDS.includes(facet)) throw new Error(`Unknown facet: ${facet}`);
    const normalized = normalizeLabel(label);
    if (!normalized) return null;
    const matches = data.concepts.filter(c => (facet === undefined || c.facet === facet)
        && [...Object.values(c.preferredLabel), ...c.aliases].some(value => normalizeLabel(value) === normalized));
    // Deprecated concepts remain explicit objects; no silent forward migration.
    return matches.length === 1 ? matches[0] : null;
}

function ancestors(taxonomy, id) {
    const data = registryData(taxonomy);
    const byId = new Map(data.concepts.map(c => [c.id, c]));
    if (!byId.has(id)) throw new Error(`Unknown concept ID: ${id}`);
    const result = [];
    let parent = byId.get(id).broaderId;
    while (parent !== null) {
        result.push(parent);
        parent = byId.get(parent).broaderId;
    }
    return result;
}

function pruneAncestors(taxonomy, ids) {
    registryData(taxonomy);
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('ids must be string array');
    const covered = new Set(ids.flatMap(id => ancestors(taxonomy, id)));
    return ids.filter(id => !covered.has(id));
}

module.exports = { loadTaxonomy, validateTaxonomy, resolveLabel, ancestors, pruneAncestors };

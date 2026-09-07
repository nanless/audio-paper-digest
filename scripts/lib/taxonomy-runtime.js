'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const taxonomyApi = require('./paper-taxonomy.js');

const TAXONOMY_PROJECTION_CONTRACT = 'paper-taxonomy-prompt-projection-v1';
const TAXONOMY_SELECTION_CONTRACT = 'paper-taxonomy-selection-v1';
const TAXONOMY_FLAT_COMPAT_CONTRACT = 'paper-taxonomy-flat-tags-compat-v1';
const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '../../config/paper-taxonomy.json');

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function preferredTag(concept) {
    return `#${concept.preferredLabel.zh}`;
}

function compactText(value) {
    return String(value || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildPromptProjection(taxonomy) {
    const facets = new Map(taxonomy.facets.map((facet, index) => [facet.id, { ...facet, index }]));
    const active = taxonomy.concepts.filter(concept => concept.status === 'active')
        .sort((a, b) => facets.get(a.facet).index - facets.get(b.facet).index
            || a.id.localeCompare(b.id));
    const lines = [
        `contract=${TAXONOMY_PROJECTION_CONTRACT}`,
        `registry_version=${taxonomy.version}`,
        `registry_sha256=${taxonomy.registrySha256}`,
        '只允许输出下列 active 概念的中文首选标签；ID 用于消歧，不得自造标签或输出同义词。'
    ];
    let currentFacet = null;
    for (const concept of active) {
        if (concept.facet !== currentFacet) {
            currentFacet = concept.facet;
            lines.push(`[${currentFacet}]`);
        }
        lines.push([
            concept.id,
            preferredTag(concept),
            compactText(concept.definition),
            compactText(concept.scopeNote)
        ].join('|'));
    }
    return `${lines.join('\n')}\n`;
}

function createTaxonomyRuntime(options = {}) {
    const taxonomy = options.taxonomy || taxonomyApi.loadTaxonomy(
        options.registryPath || DEFAULT_REGISTRY_PATH
    );
    taxonomyApi.validateTaxonomy({
        version: taxonomy.version,
        facets: taxonomy.facets,
        concepts: taxonomy.concepts
    });
    if (!/^[a-f0-9]{64}$/.test(String(taxonomy.registrySha256 || ''))) {
        throw new Error('taxonomy runtime requires a raw registry SHA');
    }

    const active = taxonomy.concepts.filter(concept => concept.status === 'active');
    const byPreferredTag = new Map();
    for (const concept of active) {
        const tag = preferredTag(concept);
        if (byPreferredTag.has(tag)) {
            throw new Error(`active preferred Chinese label is not globally unique: ${tag}`);
        }
        byPreferredTag.set(tag, concept);
    }
    const projection = buildPromptProjection(taxonomy);
    const allowedTags = new Set(byPreferredTag.keys());
    const taskTags = new Set(active.filter(concept => concept.facet === 'task').map(preferredTag));
    const methodTags = new Set(active.filter(concept => concept.facet === 'method').map(preferredTag));

    function resolveCurrentTag(value, facet) {
        if (typeof value !== 'string') return null;
        const tag = value.trim();
        const concept = byPreferredTag.get(tag);
        if (!concept || (facet && concept.facet !== facet)) return null;
        return structuredClone(concept);
    }

    function resolveLegacyTag(value, facet) {
        if (facet === 'method' && String(value || '').trim().replace(/^#/, '') === '端到端') {
            const historicalMethod = active.find(
                concept => concept.id === 'method.end-to-end-learning'
            );
            return historicalMethod ? structuredClone(historicalMethod) : null;
        }
        const candidates = taxonomyApi.resolveLabelCandidates(taxonomy, value, facet)
            .filter(concept => concept.status === 'active');
        return candidates.length === 1 ? candidates[0] : null;
    }

    function validateTagSelection(selection = {}) {
        const rawTags = Array.isArray(selection.tags) ? selection.tags : [];
        const errors = [];
        if (rawTags.length < 3 || rawTags.length > 5) errors.push('标签总数必须为 3-5 个');
        const concepts = rawTags.map(tag => resolveCurrentTag(tag));
        rawTags.forEach((tag, index) => {
            if (!concepts[index]) errors.push(`标签不是 active 中文首选标签: ${String(tag)}`);
        });
        const ids = concepts.filter(Boolean).map(concept => concept.id);
        if (new Set(ids).size !== ids.length) errors.push('标签包含重复概念');

        const task = resolveCurrentTag(selection.primaryTaskTag, 'task');
        const method = resolveCurrentTag(selection.primaryMethodTag, 'method');
        if (!task) errors.push('主任务标签必须是 active task 中文首选标签');
        if (!method) errors.push('主方法标签必须是 active method 中文首选标签');
        if (task && !ids.includes(task.id)) errors.push('主任务标签必须出现在完整标签列表');
        if (method && !ids.includes(method.id)) errors.push('主方法标签必须出现在完整标签列表');
        if (task && ids.some(id => taxonomyApi.ancestors(taxonomy, id).includes(task.id))) {
            errors.push('主任务标签不是所选任务中的最具体概念');
        }
        if (ids.length && taxonomyApi.pruneAncestors(taxonomy, ids).length !== ids.length) {
            errors.push('标签不得同时包含祖先与后代概念');
        }
        return {
            valid: errors.length === 0,
            errors: [...new Set(errors)],
            registryVersion: taxonomy.version,
            registrySha256: taxonomy.registrySha256,
            primaryTaskId: task?.id || null,
            primaryMethodId: method?.id || null,
            conceptIds: errors.length ? [] : ids
        };
    }

    return Object.freeze({
        taxonomy,
        registryVersion: taxonomy.version,
        registrySha256: taxonomy.registrySha256,
        projection,
        projectionSha256: sha256(projection),
        projectionContract: TAXONOMY_PROJECTION_CONTRACT,
        selectionContract: TAXONOMY_SELECTION_CONTRACT,
        flatCompatContract: TAXONOMY_FLAT_COMPAT_CONTRACT,
        allowedTags,
        taskTags,
        methodTags,
        resolveCurrentTag,
        resolveLegacyTag,
        validateTagSelection
    });
}

let defaultRuntime;
function getDefaultTaxonomyRuntime() {
    if (!defaultRuntime) defaultRuntime = createTaxonomyRuntime();
    return defaultRuntime;
}

module.exports = {
    TAXONOMY_PROJECTION_CONTRACT,
    TAXONOMY_SELECTION_CONTRACT,
    TAXONOMY_FLAT_COMPAT_CONTRACT,
    DEFAULT_REGISTRY_PATH,
    buildPromptProjection,
    createTaxonomyRuntime,
    getDefaultTaxonomyRuntime
};

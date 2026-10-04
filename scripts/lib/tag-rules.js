'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const tagCatalogApi = require('./tag-catalog.js');

const TAG_PROMPT_TEXT_CONTRACT = 'paper-taxonomy-prompt-projection-v1';
const TAG_SELECTION_CONTRACT = 'paper-taxonomy-selection-v1';
const TAG_FLAT_COMPAT_CONTRACT = 'paper-taxonomy-flat-tags-compat-v1';
const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '../../config/tag-catalog.json');

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function preferredTag(concept) {
    return `#${concept.preferredLabel.zh}`;
}

function compactText(value) {
    return String(value || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildTagPromptText(tagCatalog) {
    const facets = new Map(tagCatalog.facets.map((facet, index) => [facet.id, { ...facet, index }]));
    const active = tagCatalog.concepts.filter(concept => concept.status === 'active')
        .sort((a, b) => facets.get(a.facet).index - facets.get(b.facet).index
            || a.id.localeCompare(b.id));
    const lines = [
        `contract=${TAG_PROMPT_TEXT_CONTRACT}`,
        `registry_version=${tagCatalog.version}`,
        `registry_sha256=${tagCatalog.registrySha256}`,
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

function createTagRules(options = {}) {
    const tagCatalog = options.tagCatalog || tagCatalogApi.loadTagCatalog(
        options.registryPath || DEFAULT_REGISTRY_PATH
    );
    tagCatalogApi.validateTagCatalog({
        version: tagCatalog.version,
        facets: tagCatalog.facets,
        concepts: tagCatalog.concepts
    });
    if (!/^[a-f0-9]{64}$/.test(String(tagCatalog.registrySha256 || ''))) {
        throw new Error('标签规则需要提供格式有效的词表文件 SHA。');
    }

    const active = tagCatalog.concepts.filter(concept => concept.status === 'active');
    const byPreferredTag = new Map();
    for (const concept of active) {
        const tag = preferredTag(concept);
        if (byPreferredTag.has(tag)) {
            throw new Error(`已启用概念的中文首选标签在词表中重复：${tag}`);
        }
        byPreferredTag.set(tag, concept);
    }
    const projection = buildTagPromptText(tagCatalog);
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
        const candidates = tagCatalogApi.resolveLabelCandidates(tagCatalog, value, facet)
            .filter(concept => concept.status === 'active');
        return candidates.length === 1 ? candidates[0] : null;
    }

    // 在整个词表中查找主任务的已启用下级概念，并按词表原始顺序返回，
    // 以便 Node 与 Python 给出一致的告警。告警不改变标签选择的 valid 结果。
    // tag-catalog.ancestors() 每次调用都会重新校验整个词表；逐概念调用会使
    // 检查耗时增长为 O(N²)。词表在创建规则时已校验，这里使用本地上级关系。
    const parentByConceptId = new Map(
        tagCatalog.concepts.map(concept => [concept.id, concept.broaderId])
    );
    function ancestorIds(conceptId) {
        const chain = [];
        let parent = parentByConceptId.get(conceptId);
        while (parent !== null && parent !== undefined) {
            chain.push(parent);
            parent = parentByConceptId.get(parent);
        }
        return chain;
    }
    function activeDescendants(conceptId) {
        return tagCatalog.concepts.filter(concept =>
            concept.status === 'active'
            && concept.id !== conceptId
            && ancestorIds(concept.id).includes(conceptId));
    }

    function validateTagSelection(selection = {}) {
        const rawTags = Array.isArray(selection.tags) ? selection.tags : [];
        const errors = [];
        if (rawTags.length < 3 || rawTags.length > 5) errors.push('标签总数必须为 3–5 个。');
        const concepts = rawTags.map(tag => resolveCurrentTag(tag));
        rawTags.forEach((tag, index) => {
            if (!concepts[index]) errors.push(`标签不是词表中已启用概念的中文首选名称：${String(tag)}`);
        });
        const ids = concepts.filter(Boolean).map(concept => concept.id);
        if (new Set(ids).size !== ids.length) errors.push('标签列表包含重复概念。');

        const task = resolveCurrentTag(selection.primaryTaskTag, 'task');
        const method = resolveCurrentTag(selection.primaryMethodTag, 'method');
        if (!task) errors.push('主任务标签必须使用词表中已启用任务概念的中文首选名称。');
        if (!method) errors.push('主方法标签必须使用词表中已启用方法概念的中文首选名称。');
        if (task && !ids.includes(task.id)) errors.push('主任务标签必须出现在完整标签列表中。');
        if (method && !ids.includes(method.id)) errors.push('主方法标签必须出现在完整标签列表中。');
        if (task && ids.some(id => tagCatalogApi.ancestors(tagCatalog, id).includes(task.id))) {
            errors.push('主任务标签必须是所选任务中最具体的概念。');
        }
        if (ids.length && tagCatalogApi.pruneAncestors(tagCatalog, ids).length !== ids.length) {
            errors.push('标签不能同时包含上级概念及其下级概念。');
        }

        // 任务类标签须有 1–3 个，其中一个是主任务，次任务最多两个。
        // 标签总数的 3–5 个限制仍单独检查，不能代替任务类标签的数量要求。
        const taskConcepts = concepts.filter(concept => concept && concept.facet === 'task');
        if (taskConcepts.length < 1 || taskConcepts.length > 3) {
            const taskTagList = taskConcepts.map(preferredTag).join(' ');
            errors.push(`任务标签须有 1–3 个，其中主任务为 1 个，次任务不超过 2 个；`
                + `当前 ${taskConcepts.length} 个${taskTagList ? `: ${taskTagList}` : ''}`);
        }

        // 如果主任务还有尚未选择的已启用下级概念，返回告警供新标签选择阶段
        // 决定是否局部修复。告警不改变 valid，也不阻断已保存标签阶段记录的核验。
        let specificityWarning = null;
        if (task) {
            const missingDescendants = activeDescendants(task.id)
                .filter(concept => !ids.includes(concept.id));
            if (missingDescendants.length > 0) {
                const sample = missingDescendants.slice(0, 8).map(preferredTag).join(' ');
                const tail = missingDescendants.length > 8 ? ' …' : '';
                specificityWarning = `主任务标签过于宽泛：${preferredTag(task)} 的下级概念中有未被选中的已启用概念`
                    + `（共 ${missingDescendants.length} 个）：${sample}${tail}`;
            }
        }

        return {
            valid: errors.length === 0,
            errors: [...new Set(errors)],
            registryVersion: tagCatalog.version,
            registrySha256: tagCatalog.registrySha256,
            primaryTaskId: task?.id || null,
            primaryMethodId: method?.id || null,
            conceptIds: errors.length ? [] : ids,
            specificityWarning
        };
    }

    return Object.freeze({
        tagCatalog: tagCatalog,
        registryVersion: tagCatalog.version,
        registrySha256: tagCatalog.registrySha256,
        projection,
        projectionSha256: sha256(projection),
        projectionContract: TAG_PROMPT_TEXT_CONTRACT,
        selectionContract: TAG_SELECTION_CONTRACT,
        flatCompatContract: TAG_FLAT_COMPAT_CONTRACT,
        allowedTags,
        taskTags,
        methodTags,
        resolveCurrentTag,
        resolveLegacyTag,
        validateTagSelection
    });
}

let defaultRuntime;
function getDefaultTagRules() {
    if (!defaultRuntime) defaultRuntime = createTagRules();
    return defaultRuntime;
}

module.exports = {
    TAG_PROMPT_TEXT_CONTRACT,
    TAG_SELECTION_CONTRACT,
    TAG_FLAT_COMPAT_CONTRACT,
    DEFAULT_REGISTRY_PATH,
    buildTagPromptText,
    createTagRules,
    getDefaultTagRules
};

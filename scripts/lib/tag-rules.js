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
        throw new Error('taxonomy runtime requires a raw registry SHA');
    }

    const active = tagCatalog.concepts.filter(concept => concept.status === 'active');
    const byPreferredTag = new Map();
    for (const concept of active) {
        const tag = preferredTag(concept);
        if (byPreferredTag.has(tag)) {
            throw new Error(`active preferred Chinese label is not globally unique: ${tag}`);
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

    // 主任务“最具体”检查需要全 registry 视角：主任务只要还有 active 后代，
    // 就必须至少选中其中一个，否则欠具体回退不可判。descendants 按 registry
    // 原始顺序返回，Node/Python 两侧逐字一致。
    // 热路径不能用 tag-catalog.ancestors()：它每次调用都会全量重校验
    // registry，逐概念调用会把选择校验退化成 O(N²)。runtime 创建时已经
    // 校验过一次，这里只保留本地 id→parent 映射；Python 侧
    // utils._validate_tag_selection 是同构实现。
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
        if (task && ids.some(id => tagCatalogApi.ancestors(tagCatalog, id).includes(task.id))) {
            errors.push('主任务标签不是所选任务中的最具体概念');
        }
        if (ids.length && tagCatalogApi.pruneAncestors(tagCatalog, ids).length !== ids.length) {
            errors.push('标签不得同时包含祖先与后代概念');
        }

        // 选择合同规则①：主任务恰好 1 个 + 次任务 ≤2 个，即 task 分面总数
        // 必须落在 [1,3]。总数 3-5 只约束标签条数，不约束 task 分面占比。
        const taskConcepts = concepts.filter(concept => concept && concept.facet === 'task');
        if (taskConcepts.length < 1 || taskConcepts.length > 3) {
            const taskTagList = taskConcepts.map(preferredTag).join(' ');
            errors.push(`task 分面标签必须为 1-3 个（主任务 1 个 + 次任务 ≤2 个），`
                + `当前 ${taskConcepts.length} 个${taskTagList ? `: ${taskTagList}` : ''}`);
        }

        // 选择合同规则②：主任务“最具体”是全 registry 性质，不是所选集合内
        // 性质。欠具体只返回结构化告警，不改变 valid——已封口 stage 的回放
        // （seal binding、validate:data、发布侧 parse）因此不受影响；新指派
        // 路径（deep-analyzer taxonomySeal fresh 分支）用它触发标签局部修复。
        let specificityWarning = null;
        if (task) {
            const missingDescendants = activeDescendants(task.id)
                .filter(concept => !ids.includes(concept.id));
            if (missingDescendants.length > 0) {
                const sample = missingDescendants.slice(0, 8).map(preferredTag).join(' ');
                const tail = missingDescendants.length > 8 ? ' …' : '';
                specificityWarning = `主任务标签欠具体: ${preferredTag(task)} 存在未选择的 active 后代`
                    + `（共 ${missingDescendants.length} 个）: ${sample}${tail}`;
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

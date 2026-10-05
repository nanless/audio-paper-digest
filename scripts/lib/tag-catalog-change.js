'use strict';

// 比较新旧词表，判断已有分类记录能否继续沿用。判断依据是词表内容，
// 不要求两份文件的字节完全相同，也不依赖运行时间或环境。
// additive 不只包括新增概念，也包括定义等不会被程序判为破坏性的改动。
// 沿用旧记录前，调用方仍须核对快照、升级说明、正文标签及原概念 ID。
// destructive 默认拒绝沿用；只有所有破坏性原因都属于可确认范围，且提供
// 对应的显式确认时，才能继续其他检查。确认不能代替这些检查，也不能允许删除概念。

const path = require('node:path');
const crypto = require('node:crypto');
const tagCatalogApi = require('./tag-catalog.js');

const CHANGE_LEVELS = Object.freeze(['none', 'additive', 'destructive']);
const REGISTRY_UPGRADE_CONTRACT = 'paper-taxonomy-registry-upgrade-v1';
const REGISTRY_UPGRADE_VERSION = 1;
const REGISTRY_UPGRADE_NOTE_MAX_CHARS = 500;
const REGISTRY_UPGRADE_REASON_CAP = 32;
const SHA256_RE = /^[a-f0-9]{64}$/;

// 人工确认只适用于以下破坏性变更原因。同次变更可以新增概念，但不能包含
// 删除概念等白名单外的破坏性原因；原概念、旧快照和升级说明仍须通过核验。
// 确认写入 registryUpgradeFrom，不参与 bindingSha256，也不改变变更等级。
const ACKNOWLEDGEMENT_ELIGIBLE_CODES = Object.freeze([
    // 更改首选标签、上级关系或删除别名后，正文标签仍须解析为原概念 ID。
    'preferred-label-changed',
    'broader-id-changed',
    'alias-removed',
    // 不同分类维度的标签重复时，人工确认不能替代正文标签的解析和概念核验。
    'label-collision',
    // 定义与适用范围说明的改动目前判为 additive；即使以后判为 destructive，
    // 这两个原因也属于允许显式确认的范围。
    'definition-updated',
    'scope-note-updated'
]);
// 删除概念或分类维度、停用概念、更改版本或所属维度，以及启用概念的中文
// 首选标签重复，都不允许人工确认。下表用于文档和测试对照；实际判断使用
// canAcknowledgeRegistryChange 中的允许列表。
const ACKNOWLEDGEMENT_FORBIDDEN_CODES = Object.freeze([
    'concept-removed',
    'facet-removed',
    'status-deactivated',
    'version-changed',
    'concept-facet-changed',
    'active-label-not-globally-unique'
]);
const DESTRUCTIVE_ACK_CONCEPT_ID_IMPACT = 'none';
const DESTRUCTIVE_ACK_FIELDS = Object.freeze([
    'acknowledged', 'reasonsHash', 'conceptIdImpact', 'note'
]);

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// 接受文件路径或词表对象，返回通过 validateTagCatalog 校验的词表快照。
// 对象未提供 registrySha256 时记为 null；变更分级不依赖文件字节 SHA，
// 查找旧快照和核验升级说明时才需要这个 SHA。
function normalizeRegistry(value, label = '词表') {
    if (typeof value === 'string') {
        const loaded = tagCatalogApi.loadTagCatalog(value);
        return { version: loaded.version, facets: loaded.facets,
            concepts: loaded.concepts, registrySha256: loaded.registrySha256 };
    }
    if (!isPlainObject(value)) throw new Error(`${label} 必须是词表对象或词表文件路径。`);
    const data = { version: value.version, facets: value.facets, concepts: value.concepts };
    tagCatalogApi.validateTagCatalog(data);
    const registrySha256 = value.registrySha256;
    if (registrySha256 !== undefined && registrySha256 !== null
        && !SHA256_RE.test(String(registrySha256))) throw new Error(`${label} 中的 registrySha256 格式无效。`);
    return { ...data, registrySha256: registrySha256 ?? null };
}

// 已启用概念的中文首选标签在整个词表中须唯一，否则无法创建标签规则。
function activeGlobalTags(registry) {
    const seen = new Map();
    for (const concept of registry.concepts) {
        if (concept.status !== 'active') continue;
        const tag = `#${concept.preferredLabel.zh}`;
        if (seen.has(tag)) return { ok: false, tag, ids: [seen.get(tag), concept.id] };
        seen.set(tag, concept.id);
    }
    return { ok: true };
}

// validateTagCatalog 只检查同一分类维度内的标签是否唯一。这里继续检查
// 不同维度之间的重复，避免更新词表后，同一个标签对应多个分类概念。
// 检查涵盖所有概念的中英文首选标签和别名，包括已停用概念，并使用相同的归一化规则。
function crossFacetLabelCollisions(registry) {
    const byLabel = new Map();
    for (const concept of registry.concepts) {
        const labels = [concept.preferredLabel.zh, concept.preferredLabel.en, ...concept.aliases];
        for (const raw of labels) {
            const label = tagCatalogApi.normalizeLabel(raw);
            if (!label) continue;
            let entry = byLabel.get(label);
            if (!entry) {
                entry = { facets: [], conceptIds: [] };
                byLabel.set(label, entry);
            }
            if (!entry.facets.includes(concept.facet)) entry.facets.push(concept.facet);
            if (!entry.conceptIds.includes(concept.id)) entry.conceptIds.push(concept.id);
        }
    }
    const collisions = [];
    for (const [label, entry] of byLabel) {
        if (entry.facets.length > 1) collisions.push({ label, ...entry });
    }
    return collisions;
}

function classifyRegistryChange(oldRegistry, newRegistry) {
    const from = normalizeRegistry(oldRegistry, '旧词表');
    const to = normalizeRegistry(newRegistry, '新词表');
    const reasons = [];
    const note = (level, code, message, extra = {}) => {
        reasons.push({ level, code, message, ...extra });
    };
    const counts = {
        oldConcepts: from.concepts.length,
        newConcepts: to.concepts.length,
        conceptsAdded: 0,
        conceptsRemoved: 0,
        conceptsChanged: 0,
        aliasesAdded: 0,
        aliasesRemoved: 0,
        facetsAdded: 0,
        facetsRemoved: 0
    };

    if (from.version !== to.version) {
        note('destructive', 'version-changed',
            `词表版本从 ${from.version} 改为 ${to.version}，必须重新分析整篇论文`);
    }

    const oldFacets = new Map(from.facets.map(facet => [facet.id, facet]));
    const newFacets = new Map(to.facets.map(facet => [facet.id, facet]));
    for (const id of [...oldFacets.keys()].sort()) {
        if (!newFacets.has(id)) {
            counts.facetsRemoved += 1;
            note('destructive', 'facet-removed', `删除了分面 ${id}，旧记录中的这一分类维度在新词表中已没有定义`, { facet: id });
        }
    }
    for (const id of [...newFacets.keys()].sort()) {
        if (!oldFacets.has(id)) {
            counts.facetsAdded += 1;
            note('additive', 'facet-added', `新增了分面 ${id}`, { facet: id });
        } else if (oldFacets.get(id).label !== newFacets.get(id).label) {
            // 分类维度的 id 决定标签解析结果，label 只用于展示。
            note('additive', 'facet-label-updated',
                `分面 ${id} 的显示名称由“${oldFacets.get(id).label}”改为“${newFacets.get(id).label}”，标签解析方式不变`,
                { facet: id });
        }
    }

    const oldConcepts = new Map(from.concepts.map(concept => [concept.id, concept]));
    const newConcepts = new Map(to.concepts.map(concept => [concept.id, concept]));

    for (const id of [...oldConcepts.keys()].sort()) {
        if (newConcepts.has(id)) continue;
        counts.conceptsRemoved += 1;
        note('destructive', 'concept-removed',
            `删除了概念 ${id}，引用它的旧分类绑定无法通过当前词表校验`, { conceptId: id });
    }

    for (const concept of to.concepts) {
        if (oldConcepts.has(concept.id)) continue;
        counts.conceptsAdded += 1;
        note('additive',
            concept.status === 'active' ? 'concept-added' : 'deprecated-concept-added',
            concept.status === 'active'
                ? `新增了可选择的概念 ${concept.id}`
                : `新增了已停用的概念 ${concept.id}，不能用于新的分类选择`,
            { conceptId: concept.id });
    }

    for (const concept of to.concepts) {
        const previous = oldConcepts.get(concept.id);
        if (!previous) continue;
        const changes = [];
        if (previous.facet !== concept.facet) {
            changes.push(['destructive', 'concept-facet-changed',
                `概念 ${concept.id} 所属分面由 ${previous.facet} 改为 ${concept.facet}`]);
        }
        for (const language of ['zh', 'en']) {
            if (previous.preferredLabel[language] !== concept.preferredLabel[language]) {
                changes.push(['destructive', 'preferred-label-changed',
                    `概念 ${concept.id} 的首选标签（preferredLabel.${language}）由“${previous.preferredLabel[language]}”改为“${concept.preferredLabel[language]}”`]);
            }
        }
        if (previous.broaderId !== concept.broaderId) {
            changes.push(['destructive', 'broader-id-changed',
                `概念 ${concept.id} 的上级概念（broaderId）由 ${previous.broaderId ?? 'null'} 改为 ${concept.broaderId ?? 'null'}，祖先关系随之改变，也可能影响主任务是否符合最具体概念的要求`]);
        }
        if (previous.status !== concept.status) {
            if (concept.status !== 'active') {
                changes.push(['destructive', 'status-deactivated',
                    `概念 ${concept.id} 的状态由可选择改为停用（${concept.status}），引用它的旧分类绑定不能继续沿用`]);
            } else {
                changes.push(['additive', 'status-reactivated',
                    `概念 ${concept.id} 已恢复为可选择状态，可用于新的分类`]);
            }
        }
        const oldAliases = new Set(previous.aliases.map(value => tagCatalogApi.normalizeLabel(value)).filter(Boolean));
        const newAliases = new Set(concept.aliases.map(value => tagCatalogApi.normalizeLabel(value)).filter(Boolean));
        for (const alias of [...oldAliases].sort()) {
            if (newAliases.has(alias)) continue;
            counts.aliasesRemoved += 1;
            changes.push(['destructive', 'alias-removed',
                `概念 ${concept.id} 删除了别名“${alias}”，使用该别名的旧标签需要重新核对`]);
        }
        for (const alias of [...newAliases].sort()) {
            if (oldAliases.has(alias)) continue;
            counts.aliasesAdded += 1;
            changes.push(['additive', 'alias-added',
                `概念 ${concept.id} 新增了别名“${alias}”`]);
        }
        if (previous.definition !== concept.definition) {
            changes.push(['additive', 'definition-updated',
                `概念 ${concept.id} 的定义（definition）已更新，标签解析规则不变`]);
        }
        if (previous.scopeNote !== concept.scopeNote) {
            changes.push(['additive', 'scope-note-updated',
                `概念 ${concept.id} 的适用范围说明（scopeNote）已更新，标签解析规则不变`]);
        }
        if (previous.replacedBy !== concept.replacedBy) {
            changes.push(['additive', 'replacement-updated',
                `概念 ${concept.id} 的替代概念（replacedBy）由 ${previous.replacedBy ?? 'null'} 改为 ${concept.replacedBy ?? 'null'}，标签解析规则不变`]);
        }
        if (changes.length) counts.conceptsChanged += 1;
        for (const [level, code, message] of changes) note(level, code, message, { conceptId: concept.id });
    }

    const globalTags = activeGlobalTags(to);
    if (!globalTags.ok) {
        note('destructive', 'active-label-not-globally-unique',
            `可选择概念的中文首选标签 ${globalTags.tag} 在概念 ${globalTags.ids.join(' / ')} 中重复，分类程序会拒绝这份词表`,
            { tag: globalTags.tag, conceptIds: globalTags.ids });
    }

    for (const collision of crossFacetLabelCollisions(to)) {
        note('destructive', 'label-collision',
            `标签“#${collision.label}”同时对应分面 ${collision.facets.join(' / ')} 中的概念 ${collision.conceptIds.join(' / ')}，无法唯一确定分类概念`,
            { tag: `#${collision.label}`, facets: collision.facets, conceptIds: collision.conceptIds });
    }

    reasons.sort((a, b) => a.code.localeCompare(b.code)
        || String(a.conceptId || a.facet || '').localeCompare(String(b.conceptId || b.facet || ''))
        || a.message.localeCompare(b.message));
    const destructive = reasons.filter(reason => reason.level === 'destructive');
    const additive = reasons.filter(reason => reason.level === 'additive');
    const changeLevel = destructive.length ? 'destructive' : additive.length ? 'additive' : 'none';

    const tally = level => {
        const grouped = new Map();
        for (const reason of reasons.filter(item => item.level === level)) {
            grouped.set(reason.code, (grouped.get(reason.code) || 0) + 1);
        }
        return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            .map(([code, count]) => `${code}×${count}`);
    };
    const summary = changeLevel === 'none'
        ? '本次检查未发现会影响分类的词表变化；文件字节或未检查的内容仍可能不同。'
        : `词表变更属于 ${changeLevel}；各项原因及数量为：${[...tally('destructive'), ...tally('additive')].join('、')}。`;

    return {
        changeLevel,
        detail: {
            changeLevel,
            oldRegistrySha256: from.registrySha256,
            newRegistrySha256: to.registrySha256,
            oldVersion: from.version,
            newVersion: to.version,
            counts,
            reasons,
            summary
        }
    };
}

// 确认原因的指纹只使用结构化字段，不包含 level 和 message。
// 每条原因的键按字典序排列，再把各条序列化结果排序、拼接并计算 SHA。
// Node 与 Python 使用相同规则，确保同一组原因得到相同的 reasonsHash。
function destructiveReasonFingerprint(reason) {
    const canonical = {};
    for (const key of Object.keys(reason).sort()) {
        if (key === 'level' || key === 'message') continue;
        canonical[key] = reason[key];
    }
    return JSON.stringify(canonical);
}

function destructiveReasons(changeDetail) {
    const reasons = Array.isArray(changeDetail?.reasons) ? changeDetail.reasons : [];
    return reasons.filter(reason => reason && reason.level === 'destructive');
}

function destructiveReasonsHash(changeDetail) {
    const fingerprints = destructiveReasons(changeDetail).map(destructiveReasonFingerprint).sort();
    return crypto.createHash('sha256').update(fingerprints.join('\n')).digest('hex');
}

// 这里只判断破坏性原因是否全部属于可确认范围，不改变原变更等级。
function acknowledgementEligibility(changeDetail) {
    const changeLevel = changeDetail?.changeLevel;
    const codes = [...new Set(destructiveReasons(changeDetail).map(reason => reason.code))].sort();
    const eligibleReasons = codes.filter(code => ACKNOWLEDGEMENT_ELIGIBLE_CODES.includes(code));
    const ineligibleReasons = codes.filter(code => !ACKNOWLEDGEMENT_ELIGIBLE_CODES.includes(code));
    // 等级缺失或未知、破坏性变更没有相应原因，或者存在白名单外的原因时，
    // 都不能人工确认。
    const knownLevel = CHANGE_LEVELS.includes(changeLevel);
    const eligible = knownLevel && ineligibleReasons.length === 0
        && (changeLevel === 'destructive'
            ? eligibleReasons.length > 0
            : codes.length === 0);
    return { eligible, eligibleReasons, ineligibleReasons };
}

function canAcknowledgeRegistryChange(changeDetail) {
    return acknowledgementEligibility(changeDetail).eligible;
}

// 默认确认说明包含新旧词表的文件字节 SHA，便于核对本次词表更新。
function buildDestructiveAcknowledgement({ detail, fromRegistrySha256, toRegistrySha256, note }) {
    const eligibility = acknowledgementEligibility(detail);
    if (!eligibility.eligible) {
        throw new Error('本次破坏性变更不属于可人工确认的范围：'
            + (eligibility.ineligibleReasons.join('、') || '变更详情缺失'));
    }
    const text = String(note ?? '').trim()
        || `已明确确认本次词表更新中的破坏性变更：${fromRegistrySha256} → ${toRegistrySha256}；所选概念 ID 保持不变。`;
    if (!text || text.length > REGISTRY_UPGRADE_NOTE_MAX_CHARS) {
        throw new Error(`生成的人工确认说明不能为空，且长度不能超过 ${REGISTRY_UPGRADE_NOTE_MAX_CHARS} 个字符。`);
    }
    return {
        acknowledged: true,
        reasonsHash: destructiveReasonsHash(detail),
        conceptIdImpact: DESTRUCTIVE_ACK_CONCEPT_ID_IMPACT,
        note: text
    };
}

// 核对升级说明中的确认字段。字段缺失或无效、原因哈希不一致，以及变更
// 不属于可确认范围时，都返回拒绝原因。调用方仍须核对旧快照、升级说明和原概念。
function validateDestructiveAcknowledgement(annotation, expected = {}) {
    const eligibility = acknowledgementEligibility(expected.detail);
    if (!eligibility.eligible) {
        return '本次破坏性变更不属于可人工确认的范围：'
            + (eligibility.ineligibleReasons.join('、') || '重新计算的变更详情缺失');
    }
    const ack = isPlainObject(annotation) ? annotation.destructiveAcknowledgement : undefined;
    if (!isPlainObject(ack)) return '破坏性变更必须在 destructiveAcknowledgement 中提供显式确认。';
    const unknown = Object.keys(ack).filter(key => !DESTRUCTIVE_ACK_FIELDS.includes(key));
    if (unknown.length) return `destructiveAcknowledgement 包含未知字段：${unknown.join('、')}`;
    if (ack.acknowledged !== true) return 'destructiveAcknowledgement.acknowledged 必须为 true，以明确确认本次变更。';
    if (ack.conceptIdImpact !== DESTRUCTIVE_ACK_CONCEPT_ID_IMPACT) {
        return 'destructiveAcknowledgement.conceptIdImpact 必须为 none，表明所选概念 ID 不变。';
    }
    if (!SHA256_RE.test(String(ack.reasonsHash || ''))) {
        return 'destructiveAcknowledgement.reasonsHash 必须是 64 位十六进制 SHA。';
    }
    if (ack.reasonsHash !== destructiveReasonsHash(expected.detail)) {
        return 'destructiveAcknowledgement.reasonsHash 与本次重新计算的破坏性变更原因不一致。';
    }
    const note = ack.note;
    if (typeof note !== 'string' || !note.trim() || note !== note.trim()
        || note.length > REGISTRY_UPGRADE_NOTE_MAX_CHARS) {
        return `destructiveAcknowledgement.note 必须是长度为 1–${REGISTRY_UPGRADE_NOTE_MAX_CHARS} 字符的非空说明，且首尾不能有空白。`;
    }
    return null;
}

function defaultHistoryDir() {
    try {
        return require('../config.js').FILES.tagCatalogHistoryDir;
    } catch {
        return null;
    }
}

// 按文件字节 SHA 查找旧词表快照。文件名必须与内容 SHA 一致；快照缺失、
// 读取失败或内容不符时返回 null，由调用方拒绝继续更新记录。
function resolveRegistrySnapshot(registrySha256, options = {}) {
    const sha = String(registrySha256 || '');
    if (!SHA256_RE.test(sha)) return null;
    const explicit = options.registryHistory;
    if (explicit instanceof Map) {
        if (explicit.has(sha)) return normalizeRegistry(explicit.get(sha), `词表快照 ${sha}`);
    } else if (isPlainObject(explicit) && Object.hasOwn(explicit, sha)) {
        return normalizeRegistry(explicit[sha], `词表快照 ${sha}`);
    }
    if (typeof options.resolveSnapshot === 'function') {
        const resolved = options.resolveSnapshot(sha);
        if (resolved) return normalizeRegistry(resolved, `词表快照 ${sha}`);
    }
    const directory = options.historyDir || defaultHistoryDir();
    if (!directory) return null;
    try {
        const loaded = tagCatalogApi.loadTagCatalog(path.join(directory, `${sha}.json`));
        if (loaded.registrySha256 !== sha) return null;
        return { version: loaded.version, facets: loaded.facets,
            concepts: loaded.concepts, registrySha256: loaded.registrySha256 };
    } catch {
        return null;
    }
}

function buildRegistryUpgradeAnnotation({ from, to, changeLevel, detail, note,
    acknowledgeDestructive = false, acknowledgementNote = null }) {
    const fromRegistry = from && typeof from === 'object' ? from : null;
    const toRegistry = to && typeof to === 'object' ? to : null;
    const text = String(note ?? '').trim();
    if (!text || text.length > REGISTRY_UPGRADE_NOTE_MAX_CHARS) {
        throw new Error(`生成的词表升级说明不能为空，且长度不能超过 ${REGISTRY_UPGRADE_NOTE_MAX_CHARS} 个字符。`);
    }
    if (!CHANGE_LEVELS.includes(changeLevel)) {
        throw new Error('registryUpgradeFrom.changeLevel 必须为 none、additive 或 destructive。');
    }
    if (changeLevel === 'destructive' && acknowledgeDestructive !== true) {
        throw new Error('为破坏性变更生成升级说明时，必须明确设置 acknowledgeDestructive=true。');
    }
    const annotation = {
        contract: REGISTRY_UPGRADE_CONTRACT,
        version: REGISTRY_UPGRADE_VERSION,
        fromRegistrySha256: String(fromRegistry?.registrySha256 || ''),
        fromRegistryVersion: String(fromRegistry?.version || ''),
        toRegistrySha256: String(toRegistry?.registrySha256 || ''),
        toRegistryVersion: String(toRegistry?.version || ''),
        changeLevel,
        reasons: [...new Set((detail?.reasons || []).map(reason => reason.code))].sort()
            .slice(0, REGISTRY_UPGRADE_REASON_CAP),
        note: text
    };
    if (!SHA256_RE.test(annotation.fromRegistrySha256) || !SHA256_RE.test(annotation.toRegistrySha256)) {
        throw new Error('registryUpgradeFrom 中的新旧词表 SHA 必须格式有效。');
    }
    if (!annotation.fromRegistryVersion || annotation.fromRegistryVersion !== annotation.toRegistryVersion) {
        throw new Error('registryUpgradeFrom 中的新旧词表版本必须非空且一致。');
    }
    if (changeLevel === 'destructive') {
        // 破坏性变更的升级说明必须包含与本次重新计算结果对应的显式确认。
        annotation.destructiveAcknowledgement = buildDestructiveAcknowledgement({
            detail,
            fromRegistrySha256: annotation.fromRegistrySha256,
            toRegistrySha256: annotation.toRegistrySha256,
            note: acknowledgementNote
        });
    } else if (acknowledgeDestructive) {
        throw new Error('非破坏性变更不能包含 destructiveAcknowledgement 确认记录。');
    }
    return annotation;
}

// 升级说明用于记录核验依据，不能改变重新计算的变更等级。
// 破坏性变更须另外核对显式确认；其他字段仍须与本次词表和阶段记录一致。
function validateRegistryUpgradeAnnotation(annotation, expected = {}) {
    if (!isPlainObject(annotation)) return 'registryUpgradeFrom 升级说明缺失或不是普通对象。';
    if (annotation.contract !== REGISTRY_UPGRADE_CONTRACT || annotation.version !== REGISTRY_UPGRADE_VERSION) {
        return `registryUpgradeFrom 的格式标识和版本必须为 ${REGISTRY_UPGRADE_CONTRACT} v${REGISTRY_UPGRADE_VERSION}。`;
    }
    if (!SHA256_RE.test(String(annotation.fromRegistrySha256 || ''))
        || annotation.fromRegistrySha256 !== expected.fromRegistrySha256) {
        return 'registryUpgradeFrom.fromRegistrySha256 格式无效，或与标签阶段记录中的旧词表 SHA 不一致。';
    }
    if (!SHA256_RE.test(String(annotation.toRegistrySha256 || ''))
        || annotation.toRegistrySha256 !== expected.toRegistrySha256) {
        return 'registryUpgradeFrom.toRegistrySha256 格式无效，或与当前词表 SHA 不一致。';
    }
    if (!annotation.fromRegistryVersion || annotation.fromRegistryVersion !== expected.registryVersion
        || annotation.toRegistryVersion !== expected.registryVersion) {
        return 'registryUpgradeFrom 中的新旧词表版本缺失或与当前版本不一致。';
    }
    if (!CHANGE_LEVELS.includes(annotation.changeLevel)) {
        return 'registryUpgradeFrom.changeLevel 必须为 none、additive 或 destructive。';
    }
    if (annotation.changeLevel !== expected.changeLevel) {
        return `registryUpgradeFrom.changeLevel=${annotation.changeLevel} 与重新计算的变更等级 ${expected.changeLevel} 不一致。`;
    }
    if (annotation.changeLevel === 'destructive') {
        const ackIssue = validateDestructiveAcknowledgement(annotation, expected);
        if (ackIssue) return ackIssue;
    } else if (annotation.destructiveAcknowledgement !== undefined) {
        return '非破坏性变更不能包含 destructiveAcknowledgement 确认记录。';
    }
    if (!Array.isArray(annotation.reasons) || annotation.reasons.some(code => typeof code !== 'string' || !code)) {
        return 'registryUpgradeFrom.reasons 必须是数组，且各项必须是非空字符串。';
    }
    const note = annotation.note;
    if (typeof note !== 'string' || !note.trim() || note !== note.trim()
        || note.length > REGISTRY_UPGRADE_NOTE_MAX_CHARS) {
        return `registryUpgradeFrom.note 必须是长度为 1–${REGISTRY_UPGRADE_NOTE_MAX_CHARS} 字符的非空说明，且首尾不能有空白。`;
    }
    return null;
}

// 沿用旧标签阶段记录前，须取得旧快照并重新判断变更，核对升级说明，
// 再确认原概念在当前词表中仍启用。破坏性变更还须符合白名单并提供有效确认。
// 无法完成核验时返回拒绝结果，不向调用方抛出异常。
function validateSealRegistryUpgrade(options = {}) {
    try {
        return sealRegistryUpgrade(options);
    } catch (error) {
        return {
            ok: false,
            error: `无法完成词表升级核验：${error.message}`,
            changeLevel: null,
            detail: null
        };
    }
}

function sealRegistryUpgrade({
    fromRegistrySha256, currentRegistry, currentRegistrySha256, conceptIds,
    annotation, snapshotOptions = {}
} = {}) {
    const fail = error => ({ ok: false, error, changeLevel: null, detail: null });
    const current = normalizeRegistry(currentRegistry, '当前词表');
    const currentSha = String(currentRegistrySha256 || current.registrySha256 || '');
    if (!SHA256_RE.test(currentSha)) return fail('当前词表的 SHA 缺失或格式无效，不能沿用标签阶段记录。');
    if (!SHA256_RE.test(String(fromRegistrySha256 || ''))) {
        return fail('标签阶段记录中的 registrySha256 格式无效，不能沿用该记录。');
    }
    if (String(fromRegistrySha256) === currentSha) return fail('标签阶段记录中的词表 SHA 与当前值相同，无需进行词表升级核验。');
    const snapshot = resolveRegistrySnapshot(fromRegistrySha256, snapshotOptions);
    if (!snapshot) {
        return fail(`无法取得更新前的词表快照 ${fromRegistrySha256}，不能沿用标签阶段记录。`);
    }
    const { changeLevel, detail } = classifyRegistryChange(snapshot, current);
    // 有效的人工确认只能满足破坏性变更这一项，不能跳过快照、升级说明或概念检查。
    if (changeLevel === 'destructive') {
        const reasons = detail.reasons.filter(reason => reason.level === 'destructive').slice(0, 3)
            .map(reason => reason.message);
        const ackIssue = validateDestructiveAcknowledgement(annotation, { detail });
        if (ackIssue) {
            const suffix = ackIssue.startsWith('本次破坏性变更不属于可人工确认的范围')
                ? `；${ackIssue}` : `；显式确认无效：${ackIssue}`;
            return {
                ok: false,
                error: `词表包含破坏性变更，原标签阶段记录不能直接沿用（${reasons.join('；')}）${suffix}`,
                changeLevel,
                detail
            };
        }
    }
    const issue = validateRegistryUpgradeAnnotation(annotation, {
        fromRegistrySha256: String(fromRegistrySha256),
        toRegistrySha256: currentSha,
        registryVersion: current.version,
        changeLevel,
        detail
    });
    if (issue) return { ok: false, error: `词表升级说明未通过核验：${issue}`, changeLevel, detail };
    const byId = new Map(current.concepts.map(concept => [concept.id, concept]));
    const stale = [];
    for (const id of Array.isArray(conceptIds) ? conceptIds : []) {
        const concept = byId.get(id);
        if (!concept) stale.push(`${id}(缺失)`);
        else if (concept.status !== 'active') stale.push(`${id}(${concept.status})`);
    }
    if (stale.length) {
        return {
            ok: false,
            error: `原标签阶段记录引用的以下概念在当前词表中缺失或已停用：${stale.join('、')}`,
            changeLevel,
            detail
        };
    }
    return { ok: true, error: null, changeLevel, detail };
}

module.exports = {
    CHANGE_LEVELS,
    REGISTRY_UPGRADE_CONTRACT,
    REGISTRY_UPGRADE_VERSION,
    REGISTRY_UPGRADE_NOTE_MAX_CHARS,
    ACKNOWLEDGEMENT_ELIGIBLE_CODES,
    ACKNOWLEDGEMENT_FORBIDDEN_CODES,
    DESTRUCTIVE_ACK_CONCEPT_ID_IMPACT,
    normalizeRegistry,
    classifyRegistryChange,
    resolveRegistrySnapshot,
    destructiveReasons,
    destructiveReasonsHash,
    acknowledgementEligibility,
    canAcknowledgeRegistryChange,
    buildDestructiveAcknowledgement,
    validateDestructiveAcknowledgement,
    buildRegistryUpgradeAnnotation,
    validateRegistryUpgradeAnnotation,
    validateSealRegistryUpgrade
};

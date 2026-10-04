'use strict';

// Registry 版本化（评审改进 P2-2/C7）：把“词表改动能否沿用已封口分析”从
// 字节硬等值升级成一个可复算的分级判定。
//
// 分级只回答一个问题：旧封口（taxonomySeal.stage.conceptIds 与正文中逐字
// 写下的中文首选标签）在新词表里是否仍然逐字成立。
//   - additive：新词表只会“多出可选项”，旧标签仍解析到同一 concept、旧
//     conceptId 仍 active → 允许确定性重投影后重封（不需要 LLM）。
//   - destructive：任何可能改变标签解析结果的改动 → 默认一律拒绝放行，只能
//     重新分析或人工/LLM 重新选标签；唯一的显式例外是“可确认白名单 + 注记携带
//     与本次复算绑定的 destructiveAcknowledgement”（见下方白名单常量），且只放行
//     概念零删除的语义重封，四条基础门一条不少。
// 判定只依赖两份 registry JSON 内容，不含时间戳与环境，保证任何一方独立
// 复算都得到同一份 detail。

const path = require('node:path');
const crypto = require('node:crypto');
const tagCatalogApi = require('./tag-catalog.js');

const CHANGE_LEVELS = Object.freeze(['none', 'additive', 'destructive']);
const REGISTRY_UPGRADE_CONTRACT = 'paper-taxonomy-registry-upgrade-v1';
const REGISTRY_UPGRADE_VERSION = 1;
const REGISTRY_UPGRADE_NOTE_MAX_CHARS = 500;
const REGISTRY_UPGRADE_REASON_CAP = 32;
const SHA256_RE = /^[a-f0-9]{64}$/;

// ——— destructive 显式确认通道（AGENTS.md“显式授权的白名单例外”） ———
// destructive 变更默认拒绝；只有其中的破坏性理由全部属于可确认白名单，
// 并携带与本次复算绑定的显式确认时，才可能沿用旧分类记录。
// 同一次变更可以新增概念，但不能混入删除概念等白名单外的破坏性理由；
// 旧 conceptIds 对应的概念仍须全部有效，旧快照与升级注记也须通过核验。
// 确认只写入 registryUpgradeFrom，不参与 bindingSha256，也不改变变更分级。
const ACKNOWLEDGEMENT_ELIGIBLE_CODES = Object.freeze([
    // 改首选标签 / 改祖先边 / 删别名：正文里的中文首选标签仍解析到同一 conceptId，
    // 只是“旧标签文字”在新表里的落点变了，重投影后 conceptIds 逐字不变。
    'preferred-label-changed',
    'broader-id-changed',
    'alias-removed',
    // 新表自身标签跨分面重复：会先被运行时拒绝加载，人工确认只针对“确认该碰撞
    // 不触及已封口 conceptIds”，任何触达封口概念的碰撞仍会被 conceptIds 门拦下。
    'label-collision',
    // definition / scopeNote 类改动当前判为 additive；列进白名单是显式声明
    // “这类纯文本语义即便将来重判为 destructive 也可确认”，不含任何概念增删。
    'definition-updated',
    'scope-note-updated'
]);
// 白名单之外一律不可确认：删概念、删分面、降级、版本升级、迁分面、active
// 首选标签全局撞车 —— 这些改动会让已封口 conceptIds 或运行时本身失效，
// 只能整篇重新分析或人工/LLM 重新选标签。canAcknowledgeRegistryChange 用白名单
// 判定，本常量只作为文档与测试的显式对照表。
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

// 接受文件路径或已解析对象；返回经 validateTagCatalog 校验的 registry 快照。
// 对象若没有 registrySha256 就记 null —— 分级不依赖字节 SHA，只有升级
// 注记与快照查找才要求真实字节 SHA。
function normalizeRegistry(value, label = 'registry') {
    if (typeof value === 'string') {
        const loaded = tagCatalogApi.loadTagCatalog(value);
        return { version: loaded.version, facets: loaded.facets,
            concepts: loaded.concepts, registrySha256: loaded.registrySha256 };
    }
    if (!isPlainObject(value)) throw new Error(`${label}: expected registry object or file path`);
    const data = { version: value.version, facets: value.facets, concepts: value.concepts };
    tagCatalogApi.validateTagCatalog(data);
    const registrySha256 = value.registrySha256;
    if (registrySha256 !== undefined && registrySha256 !== null
        && !SHA256_RE.test(String(registrySha256))) throw new Error(`${label}: invalid registrySha256`);
    return { ...data, registrySha256: registrySha256 ?? null };
}

// active 概念的中文首选标签在全 registry 范围内必须唯一，否则
// createTagRules 会直接抛错并让整个运行时不可用。
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

// 跨分面标签碰撞：validateTagCatalog 的标签唯一性只在分面内成立（key 是
// facet\0归一标签），所以把一个已被别的分面占用的标签（首选或别名）塞进
// 另一个分面时，registry 校验能过、分级却会误判 additive —— 可解析期该
// 标签的候选数会从 1 变 2，运行时直接爆。这里对 to registry 的全部标签
// （active+deprecated 概念的 zh/en 首选 + 全部别名，经 normalizeLabel 归一）
// 做跨分面重复扫描；同一归一标签落在 ≥2 个分面即为解析歧义。
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
    const from = normalizeRegistry(oldRegistry, 'old registry');
    const to = normalizeRegistry(newRegistry, 'new registry');
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
            // 分面 id 决定解析与投影，label 只用于展示。
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

// ——— destructive reasons 的稳定指纹 ———
// 指纹只吃“结构化字段”，故意排除 message：Node 用 localeCompare 排序、文案与
// Python 镜像也有细微差别，而 code/conceptId/facet/tag/conceptIds/facets 两侧
// 逐字一致。键按字典序、无空白 JSON 序列化，再按码序排序后拼接取 SHA，保证
// Node 与 Python 对同一份复算 detail 得到同一个 reasonsHash。
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

// 可确认性与分级解耦：classifyRegistryChange 的输出永远不变（destructive 就是
// destructive），这里只回答“这一组 destructive 理由是否落在显式确认白名单内”。
function acknowledgementEligibility(changeDetail) {
    const changeLevel = changeDetail?.changeLevel;
    const codes = [...new Set(destructiveReasons(changeDetail).map(reason => reason.code))].sort();
    const eligibleReasons = codes.filter(code => ACKNOWLEDGEMENT_ELIGIBLE_CODES.includes(code));
    const ineligibleReasons = codes.filter(code => !ACKNOWLEDGEMENT_ELIGIBLE_CODES.includes(code));
    // fail-closed：分级缺失/未知、判为 destructive 却数不出理由、或混入任一
    // 白名单外的 destructive 理由 → 一律不可确认。
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

// 默认确认模板必须自带 from/to 字节 SHA，人工确认可直接与换表记录对账。
function buildDestructiveAcknowledgement({ detail, fromRegistrySha256, toRegistrySha256, note }) {
    const eligibility = acknowledgementEligibility(detail);
    if (!eligibility.eligible) {
        throw new Error('destructive 变更不在可确认白名单: '
            + (eligibility.ineligibleReasons.join('、') || 'detail 缺失'));
    }
    const text = String(note ?? '').trim()
        || `显式确认 destructive 重封：${fromRegistrySha256} → ${toRegistrySha256}，conceptId 影响 none`;
    if (!text || text.length > REGISTRY_UPGRADE_NOTE_MAX_CHARS) {
        throw new Error(`destructiveAcknowledgement.note 必须是 1-${REGISTRY_UPGRADE_NOTE_MAX_CHARS} 字符的说明`);
    }
    return {
        acknowledged: true,
        reasonsHash: destructiveReasonsHash(detail),
        conceptIdImpact: DESTRUCTIVE_ACK_CONCEPT_ID_IMPACT,
        note: text
    };
}

// 注记里的确认字段校验：缺、字段不符、哈希与本次复算不一致、或该 destructive
// 根本不可确认 → 返回拒绝理由；四条基础门的其余三条仍由调用方各自把守。
function validateDestructiveAcknowledgement(annotation, expected = {}) {
    const eligibility = acknowledgementEligibility(expected.detail);
    if (!eligibility.eligible) {
        return 'destructive 不在可确认白名单: '
            + (eligibility.ineligibleReasons.join('、') || '复算 detail 缺失');
    }
    const ack = isPlainObject(annotation) ? annotation.destructiveAcknowledgement : undefined;
    if (!isPlainObject(ack)) return 'destructive 变更必须携带 destructiveAcknowledgement 显式确认';
    const unknown = Object.keys(ack).filter(key => !DESTRUCTIVE_ACK_FIELDS.includes(key));
    if (unknown.length) return `destructiveAcknowledgement 含未知字段: ${unknown.join('、')}`;
    if (ack.acknowledged !== true) return 'destructiveAcknowledgement.acknowledged 必须为 true';
    if (ack.conceptIdImpact !== DESTRUCTIVE_ACK_CONCEPT_ID_IMPACT) {
        return 'destructiveAcknowledgement.conceptIdImpact 必须为 none';
    }
    if (!SHA256_RE.test(String(ack.reasonsHash || ''))) {
        return 'destructiveAcknowledgement.reasonsHash 必须是 64 位十六进制 SHA';
    }
    if (ack.reasonsHash !== destructiveReasonsHash(expected.detail)) {
        return 'destructiveAcknowledgement.reasonsHash 与本次复算 destructive reasons 不一致';
    }
    const note = ack.note;
    if (typeof note !== 'string' || !note.trim() || note !== note.trim()
        || note.length > REGISTRY_UPGRADE_NOTE_MAX_CHARS) {
        return `destructiveAcknowledgement.note 必须是 1-${REGISTRY_UPGRADE_NOTE_MAX_CHARS} 字符的说明`;
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

// 用字节 SHA 找回升级前的 registry 快照。快照文件名必须等于其内容字节
// SHA，找不到或对不上就返回 null —— 调用方必须 fail-closed。
function resolveRegistrySnapshot(registrySha256, options = {}) {
    const sha = String(registrySha256 || '');
    if (!SHA256_RE.test(sha)) return null;
    const explicit = options.registryHistory;
    if (explicit instanceof Map) {
        if (explicit.has(sha)) return normalizeRegistry(explicit.get(sha), `registry snapshot ${sha}`);
    } else if (isPlainObject(explicit) && Object.hasOwn(explicit, sha)) {
        return normalizeRegistry(explicit[sha], `registry snapshot ${sha}`);
    }
    if (typeof options.resolveSnapshot === 'function') {
        const resolved = options.resolveSnapshot(sha);
        if (resolved) return normalizeRegistry(resolved, `registry snapshot ${sha}`);
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
        throw new Error(`registryUpgradeFrom.note 必须是 1-${REGISTRY_UPGRADE_NOTE_MAX_CHARS} 字符的说明`);
    }
    if (!CHANGE_LEVELS.includes(changeLevel)) {
        throw new Error('registryUpgradeFrom.changeLevel 只允许 none/additive/destructive');
    }
    if (changeLevel === 'destructive' && acknowledgeDestructive !== true) {
        throw new Error('registryUpgradeFrom.changeLevel=destructive 必须显式 acknowledgeDestructive=true 才能注记放行');
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
        throw new Error('registryUpgradeFrom 需要真实的新旧 registry 字节 SHA');
    }
    if (!annotation.fromRegistryVersion || annotation.fromRegistryVersion !== annotation.toRegistryVersion) {
        throw new Error('registryUpgradeFrom 新旧 registry 版本必须一致');
    }
    if (changeLevel === 'destructive') {
        // destructive 唯一的注记形态：白名单内 + 与本次复算逐字绑定的显式确认。
        annotation.destructiveAcknowledgement = buildDestructiveAcknowledgement({
            detail,
            fromRegistrySha256: annotation.fromRegistrySha256,
            toRegistrySha256: annotation.toRegistrySha256,
            note: acknowledgementNote
        });
    } else if (acknowledgeDestructive) {
        throw new Error('非 destructive 变更不得携带 destructiveAcknowledgement');
    }
    return annotation;
}

// 注记只承载审计说明：判定本身永远由 classifyRegistryChange 复算，注记
// 篡改无法把 destructive 变成 additive；destructive 只有在“显式确认 +
// 确认对象为零概念删除（白名单）”时才可能放行，且四条基础门一条不少。
function validateRegistryUpgradeAnnotation(annotation, expected = {}) {
    if (!isPlainObject(annotation)) return '缺少 registryUpgradeFrom 升级说明';
    if (annotation.contract !== REGISTRY_UPGRADE_CONTRACT || annotation.version !== REGISTRY_UPGRADE_VERSION) {
        return `registryUpgradeFrom 合同不是 ${REGISTRY_UPGRADE_CONTRACT} v${REGISTRY_UPGRADE_VERSION}`;
    }
    if (!SHA256_RE.test(String(annotation.fromRegistrySha256 || ''))
        || annotation.fromRegistrySha256 !== expected.fromRegistrySha256) {
        return 'registryUpgradeFrom.fromRegistrySha256 与封口记录的旧 SHA 不一致';
    }
    if (!SHA256_RE.test(String(annotation.toRegistrySha256 || ''))
        || annotation.toRegistrySha256 !== expected.toRegistrySha256) {
        return 'registryUpgradeFrom.toRegistrySha256 与当前 registry SHA 不一致';
    }
    if (!annotation.fromRegistryVersion || annotation.fromRegistryVersion !== expected.registryVersion
        || annotation.toRegistryVersion !== expected.registryVersion) {
        return 'registryUpgradeFrom registry 版本与当前版本不一致';
    }
    if (!CHANGE_LEVELS.includes(annotation.changeLevel)) {
        return 'registryUpgradeFrom.changeLevel 只允许 none/additive/destructive';
    }
    if (annotation.changeLevel !== expected.changeLevel) {
        return `registryUpgradeFrom.changeLevel=${annotation.changeLevel} 与复算结果 ${expected.changeLevel} 不一致`;
    }
    if (annotation.changeLevel === 'destructive') {
        const ackIssue = validateDestructiveAcknowledgement(annotation, expected);
        if (ackIssue) return ackIssue;
    } else if (annotation.destructiveAcknowledgement !== undefined) {
        return '非 destructive 变更不得携带 destructiveAcknowledgement';
    }
    if (!Array.isArray(annotation.reasons) || annotation.reasons.some(code => typeof code !== 'string' || !code)) {
        return 'registryUpgradeFrom.reasons 必须是字符串数组';
    }
    const note = annotation.note;
    if (typeof note !== 'string' || !note.trim() || note !== note.trim()
        || note.length > REGISTRY_UPGRADE_NOTE_MAX_CHARS) {
        return `registryUpgradeFrom.note 必须是 1-${REGISTRY_UPGRADE_NOTE_MAX_CHARS} 字符的说明`;
    }
    return null;
}

// taxonomySeal 放宽入口：四条同时成立才放行 ——
//   ① 旧快照按字节 SHA 可取回；
//   ② 复算分级为 additive/none，或 destructive 落在可确认白名单且注记携带与
//      本次复算绑定的 destructiveAcknowledgement（概念零删除）；
//   ③ 注记其余字段与复算自洽；
//   ④ 旧 conceptIds 在当前 registry 全部 active。
// 任何异常都折算成 fail-closed 的拒绝理由，绝不向调用方抛错。
function validateSealRegistryUpgrade(options = {}) {
    try {
        return sealRegistryUpgrade(options);
    } catch (error) {
        return {
            ok: false,
            error: `registry 升级判定无法完成: ${error.message}`,
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
    const current = normalizeRegistry(currentRegistry, 'current registry');
    const currentSha = String(currentRegistrySha256 || current.registrySha256 || '');
    if (!SHA256_RE.test(currentSha)) return fail('当前 registry 缺少字节 SHA，拒绝放行 taxonomySeal');
    if (!SHA256_RE.test(String(fromRegistrySha256 || ''))) {
        return fail('taxonomySeal 记录的 registrySha256 非法，拒绝放行');
    }
    if (String(fromRegistrySha256) === currentSha) return fail('taxonomySeal 的 registrySha256 已等于当前 SHA，无需升级');
    const snapshot = resolveRegistrySnapshot(fromRegistrySha256, snapshotOptions);
    if (!snapshot) {
        return fail(`无法取得 registry 升级前快照 ${fromRegistrySha256}，按 fail-closed 拒绝 taxonomySeal`);
    }
    const { changeLevel, detail } = classifyRegistryChange(snapshot, current);
    // destructive 默认无条件拒绝；唯一的例外是“可确认白名单 + 与本次复算绑定的
    // 显式 destructiveAcknowledgement”，且确认只在第 ② 条门上放行，第 ①③④ 条门
    // 一条不少。不可确认的 destructive（删概念/删分面/降级/版本升级等）写得再
    // 自洽也翻不了案。
    if (changeLevel === 'destructive') {
        const reasons = detail.reasons.filter(reason => reason.level === 'destructive').slice(0, 3)
            .map(reason => reason.message);
        const ackIssue = validateDestructiveAcknowledgement(annotation, { detail });
        if (ackIssue) {
            const suffix = ackIssue.startsWith('destructive 不在可确认白名单')
                ? `；${ackIssue}` : `；显式确认无效: ${ackIssue}`;
            return {
                ok: false,
                error: `registry 变更判定为 destructive，taxonomySeal 不得沿用（${reasons.join('；')}）${suffix}`,
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
    if (issue) return { ok: false, error: `registryUpgradeFrom 校验失败: ${issue}`, changeLevel, detail };
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
            error: `taxonomySeal 的 conceptIds 在当前 registry 中不再全部 active: ${stale.join('、')}`,
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

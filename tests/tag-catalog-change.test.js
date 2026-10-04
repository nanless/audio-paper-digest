'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const tagCatalogApi = require('../scripts/lib/tag-catalog.js');
const api = require('../scripts/lib/tag-catalog-change.js');

const CURRENT = path.resolve(__dirname, '../config/tag-catalog.json');
const HISTORY = path.resolve(__dirname, '../config/tag-catalog-history');
const OLD_SEED = path.join(HISTORY,
    'dcf83f84857d45d6a36ee20d9235d7566d9a3a53644ab442d8eb64b5e81a9adf.json');
const OLD_ALIAS_REMOVAL = path.join(HISTORY,
    '3f9a14c9d753716b428b8ca27a9d93b92b3ae93cfbffc1a24f60573ff8ef234a.json');

const raw = () => JSON.parse(fs.readFileSync(CURRENT, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const byId = (registry, id) => registry.concepts.find(concept => concept.id === id);
const codes = detail => detail.reasons.map(reason => reason.code);

function expectLevel(oldRegistry, newRegistry, expected, expectedCodes = []) {
    const { changeLevel, detail } = api.classifyRegistryChange(oldRegistry, newRegistry);
    assert.equal(changeLevel, expected, detail.summary);
    for (const code of expectedCodes) {
        assert.ok(codes(detail).includes(code), `${code} 缺失于 ${codes(detail).join(',')}`);
    }
    return detail;
}

// ——— 合成 additive 过渡（换表口径下唯一可复现的 additive 路径） ———
// 三份历史快照（dcf83f84 / 3f9a14c9 / 15c82a56）→ current(v1.1) 现在全部复算为
// destructive；“additive 放行 / additive 不得带确认字段”这类门只能用一份合成旧表
// 来复现：从当前表去掉一个无人引用的叶子概念，旧 → 新就只剩 concept-added。
// 合成表不落盘，按字节 SHA 注入 registryHistory 后由快照门原样取回。
const ADDITIVE_FROM_CONCEPT_ID = 'task.wake-word';

function syntheticAdditiveUpgrade(current) {
    const from = clone(raw());
    from.concepts = from.concepts.filter(concept => concept.id !== ADDITIVE_FROM_CONCEPT_ID);
    tagCatalogApi.validateTagCatalog(from);
    const registrySha256 = crypto.createHash('sha256')
        .update(JSON.stringify(from, null, 2), 'utf8').digest('hex');
    const withSha = { ...from, registrySha256 };
    const snapshotOptions = { registryHistory: { [withSha.registrySha256]: withSha } };
    const { changeLevel, detail } = api.classifyRegistryChange(withSha, current);
    assert.equal(changeLevel, 'additive', detail.summary);
    assert.ok(codes(detail).includes('concept-added'));
    return { from: withSha, snapshotOptions, changeLevel, detail };
}

test('identical registry bytes classify as none with empty reasons', () => {
    const registry = tagCatalogApi.loadTagCatalog(CURRENT);
    const detail = expectLevel(registry, registry, 'none');
    assert.equal(detail.reasons.length, 0);
    assert.equal(detail.oldRegistrySha256, detail.newRegistrySha256);
    assert.equal(detail.summary, '本次检查未发现会影响分类的词表变化；文件字节或未检查的内容仍可能不同。');
});

test('adding concepts, aliases, definitions and deprecation-free fields is additive', () => {
    const next = clone(raw());
    next.concepts.push({
        id: 'task.example-new-task',
        facet: 'task',
        preferredLabel: { zh: '示例新任务', en: 'Example New Task' },
        aliases: ['ExampleNT'],
        broaderId: null,
        definition: '新增概念只增加可选项。',
        scopeNote: '仅用于分级判定测试。',
        status: 'active',
        replacedBy: null
    });
    byId(next, 'task.asr').aliases.push('ASR-alias-extra');
    byId(next, 'task.asr').definition = '只改定义，不参与标签解析。';
    byId(next, 'task.keyword-detection').scopeNote = '只改范围注释。';

    const detail = expectLevel(raw(), next, 'additive',
        ['concept-added', 'alias-added', 'definition-updated', 'scope-note-updated']);
    assert.equal(detail.counts.conceptsAdded, 1);
    assert.equal(detail.counts.aliasesAdded, 1);
    assert.equal(detail.counts.conceptsRemoved, 0);
    assert.equal(detail.reasons.some(reason => reason.level === 'destructive'), false);
});

test('deleting a concept, relabelling, repointing broaderId, deactivating and dropping aliases are destructive', () => {
    const removal = clone(raw());
    removal.concepts = removal.concepts.filter(concept => concept.id !== 'task.wake-word');
    expectLevel(raw(), removal, 'destructive', ['concept-removed']);

    const relabel = clone(raw());
    byId(relabel, 'task.asr').preferredLabel.zh = '自动语音转写';
    expectLevel(raw(), relabel, 'destructive', ['preferred-label-changed']);

    const relabelEn = clone(raw());
    byId(relabelEn, 'task.asr').preferredLabel.en = 'Automatic Transcription';
    expectLevel(raw(), relabelEn, 'destructive', ['preferred-label-changed']);

    const reparent = clone(raw());
    byId(reparent, 'task.asr').broaderId = 'task.keyword-detection';
    expectLevel(raw(), reparent, 'destructive', ['broader-id-changed']);

    const deactivate = clone(raw());
    const victim = byId(deactivate, 'task.wake-word');
    victim.status = 'deprecated';
    victim.replacedBy = 'task.keyword-detection';
    expectLevel(raw(), deactivate, 'destructive', ['status-deactivated']);

    const aliasDrop = clone(raw());
    const aliasOwner = aliasDrop.concepts.find(concept => concept.aliases.length);
    const dropped = aliasOwner.aliases[0];
    aliasOwner.aliases = aliasOwner.aliases.slice(1);
    tagCatalogApi.validateTagCatalog(aliasDrop);
    expectLevel(raw(), aliasDrop, 'destructive', ['alias-removed']);
    assert.ok(dropped);
});

test('reactivating a deprecated concept is additive', () => {
    const deprecated = clone(raw());
    const victim = byId(deprecated, 'task.wake-word');
    victim.status = 'deprecated';
    victim.replacedBy = 'task.keyword-detection';
    tagCatalogApi.validateTagCatalog(deprecated);

    const detail = expectLevel(deprecated, raw(), 'additive', ['status-reactivated']);
    assert.equal(detail.counts.conceptsAdded, 0);
});

test('colliding active Chinese preferred labels across facets are destructive', () => {
    const next = clone(raw());
    next.concepts.push({
        id: 'artifact.voice-recognition',
        facet: 'artifact',
        preferredLabel: { zh: '语音识别', en: 'Voice Recognition Artifact' },
        aliases: ['VR-artifact'],
        broaderId: null,
        definition: '与 task.asr 的中文首选标签撞车。',
        scopeNote: '运行时会因全局不唯一而拒绝加载。',
        status: 'active',
        replacedBy: null
    });
    tagCatalogApi.validateTagCatalog(next);

    const detail = expectLevel(raw(), next, 'destructive', ['active-label-not-globally-unique']);
    assert.ok(detail.reasons.some(reason => reason.code === 'active-label-not-globally-unique'
        && reason.conceptIds.length === 2));
});

// 评审复现场景：把另一分面已占用的标签当别名加进来 —— validateTagCatalog 的
// 标签唯一性只在分面内（scripts/lib/tag-catalog.js 的 key 是 facet\0归一
// 标签），registry 校验能过、旧分级还会判 additive，但解析期该标签的候选数
// 会由 1 变 2，所以必须判 destructive / label-collision。
test('cross-facet collisions over every registry label are destructive (label-collision)', () => {
    const aliasCollision = clone(raw());
    byId(aliasCollision, 'method.transformer').aliases.push('语音识别');
    tagCatalogApi.validateTagCatalog(aliasCollision);

    const detail = expectLevel(raw(), aliasCollision, 'destructive', ['label-collision']);
    const collisions = detail.reasons.filter(reason => reason.code === 'label-collision');
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].level, 'destructive');
    assert.equal(collisions[0].tag, '#语音识别');
    assert.deepEqual([...collisions[0].conceptIds].sort(), ['method.transformer', 'task.asr']);
    assert.deepEqual([...collisions[0].facets].sort(), ['method', 'task']);
    assert.equal(collisions[0].message, '标签“#语音识别”同时对应分面 task / method 中的概念 task.asr / method.transformer，无法唯一确定分类概念');
    assert.equal(detail.summary.includes('label-collision×1'), true);

    // 英文首选标签同样参与扫描。
    const enCollision = clone(raw());
    byId(enCollision, 'method.transformer').aliases.push('Automatic speech recognition');
    tagCatalogApi.validateTagCatalog(enCollision);
    expectLevel(raw(), enCollision, 'destructive', ['label-collision']);

    // deprecated 概念的标签也参与扫描（解析器不会因 deprecated 而跳过 legacy 模式）。
    const deprecatedCollision = clone(raw());
    deprecatedCollision.concepts.push({
        id: 'signal.voice-recognition',
        facet: 'signal',
        preferredLabel: { zh: '语音识别', en: 'Voice Recognition Signal' },
        aliases: [],
        broaderId: null,
        definition: 'deprecated 概念同样参与跨分面标签扫描。',
        scopeNote: '仅用于分级判定测试。',
        status: 'deprecated',
        replacedBy: 'signal.speech'
    });
    tagCatalogApi.validateTagCatalog(deprecatedCollision);
    const deprecatedDetail = expectLevel(raw(), deprecatedCollision, 'destructive',
        ['label-collision', 'deprecated-concept-added']);
    assert.ok(deprecatedDetail.reasons.some(reason => reason.code === 'label-collision'
        && reason.tag === '#语音识别'
        && reason.conceptIds.includes('signal.voice-recognition')));

    // 只在同一分面内出现的重复不会走到这里：validateTagCatalog 直接抛错。
    assert.throws(() => {
        const inFacet = clone(raw());
        byId(inFacet, 'method.transformer').aliases.push('端到端学习');
        tagCatalogApi.validateTagCatalog(inFacet);
        api.classifyRegistryChange(raw(), inFacet);
    }, /Ambiguous label in facet/);
});

test('registry validation still fails closed on an impossible facet migration', () => {
    const migrated = clone(raw());
    byId(migrated, 'task.asr').facet = 'method';
    assert.throws(() => api.classifyRegistryChange(raw(), migrated), /Invalid\/duplicate concept ID/);
});

// 换表口径（config/tag-catalog.json 已于 09-30 换为 v1.1 / 262 概念 /
// SHA a3b75a14…）：本文件早先的期望是换表前（current=15c82a56，228 概念）写的，
// 下面三对过渡的分级、counts、summary 全部按当前代码实测重算 —— 旧表“只增概念”
// 的 additive 过渡在 v1.1 里同时删了别名、改了 broaderId 与首选标签，所以
// seed → current 也翻成了 destructive（可确认白名单内）。“按文档分类”的测试
// 意图不变：期望仍逐条写死，任何分级漂移都会立刻暴露。
test('real historical registry transitions classify as documented', () => {
    const seed = tagCatalogApi.loadTagCatalog(OLD_SEED);
    const aliasRemoval = tagCatalogApi.loadTagCatalog(OLD_ALIAS_REMOVAL);
    const current = tagCatalogApi.loadTagCatalog(CURRENT);

    // 历史 seed → aliasRemoval 新增 method.end-to-end-learning，其别名“端到端”
    // 与“End-to-end”撞上既有 setting.end-to-end 的 zh/en 首选（跨分面、候选由 1
    // 变 2）：补上 label-collision 后这一过渡必须判 destructive —— 这正是当年
    // 被误判为 additive 的漏判点；concept-added 仍保留在 reasons 里。
    const introduced = expectLevel(seed, aliasRemoval, 'destructive',
        ['concept-added', 'label-collision']);
    assert.equal(introduced.reasons.filter(reason => reason.code === 'label-collision').length, 2);
    assert.equal(introduced.counts.conceptsAdded, 1);
    assert.equal(introduced.summary, '词表变更属于 destructive；各项原因及数量为：label-collision×2、concept-added×1。');

    // seed → current(v1.1)：+58 概念 / +5 别名 / 2 处 definition / 8 处 scopeNote，
    // 但同时删了 flow-matching、self-supervised 两条别名，task.speech-spoofing 的
    // broaderId 由 null 指向 task.audio-forgery，task.music-understanding 中英文
    // 首选标签改名 —— 解析语义改变即 destructive。
    const upgraded = expectLevel(seed, current, 'destructive', [
        'concept-added', 'alias-added', 'alias-removed', 'broader-id-changed',
        'preferred-label-changed', 'definition-updated', 'scope-note-updated'
    ]);
    assert.equal(upgraded.summary, '词表变更属于 destructive；各项原因及数量为：alias-removed×2、broader-id-changed×1'
        + '、preferred-label-changed×2、alias-added×5、concept-added×58'
        + '、definition-updated×2、scope-note-updated×8。');
    assert.equal(upgraded.counts.oldConcepts, 204);
    assert.equal(upgraded.counts.newConcepts, 262);
    assert.equal(upgraded.counts.conceptsAdded, 58);
    assert.equal(upgraded.counts.conceptsChanged, 13);

    // aliasRemoval → current(v1.1)：比上一对多删 end-to-end-learning 的 3 条别名，
    // 故 alias-removed 由 2 升到 5、conceptsAdded 少 1（旧表已含该概念）。
    const detail = expectLevel(aliasRemoval, current, 'destructive',
        ['alias-removed', 'broader-id-changed', 'preferred-label-changed', 'concept-added']);
    const removals = detail.reasons.filter(reason => reason.code === 'alias-removed');
    assert.equal(removals.length, 5);
    assert.deepEqual([...new Set(removals.map(reason => reason.conceptId))].sort(), [
        'method.end-to-end-learning', 'method.flow-matching', 'method.self-supervised'
    ]);
    assert.equal(removals.filter(reason =>
        reason.conceptId === 'method.end-to-end-learning').length, 3);
    assert.equal(detail.counts.conceptsAdded, 57);
    assert.equal(detail.summary, '词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1'
        + '、preferred-label-changed×2、alias-added×7、concept-added×57'
        + '、definition-updated×2、scope-note-updated×8。');
});

test('snapshots resolve by byte SHA and refuse mismatching content', () => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(OLD_SEED)).digest('hex');
    const snapshot = api.resolveRegistrySnapshot(sha);
    assert.equal(snapshot.registrySha256, sha);
    assert.equal(snapshot.version, 'paper-taxonomy-v1');
    assert.equal(api.resolveRegistrySnapshot('0'.repeat(64)), null);
    assert.equal(api.resolveRegistrySnapshot('not-a-sha'), null);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-history-'));
    try {
        fs.writeFileSync(path.join(directory, `${'a'.repeat(64)}.json`), fs.readFileSync(CURRENT));
        assert.equal(api.resolveRegistrySnapshot('a'.repeat(64), { historyDir: directory }), null);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }

    const map = api.resolveRegistrySnapshot(sha, { registryHistory: { [sha]: OLD_SEED } });
    assert.equal(map.registrySha256, sha);
});

// 换表口径：seed → current(v1.1) 复算是**可确认 destructive**（删 2 条别名、
// 改 broaderId、改首选标签），不再有“additive 注记直接放行”的形态；destructive
// 注记的唯一合法构造就是显式 acknowledgeDestructive=true（构建期 fail-closed）。
test('registryUpgradeFrom annotation is built and verified against the recomputed level', () => {
    const from = tagCatalogApi.loadTagCatalog(OLD_SEED);
    const to = tagCatalogApi.loadTagCatalog(CURRENT);
    const { changeLevel, detail } = api.classifyRegistryChange(from, to);
    assert.equal(changeLevel, 'destructive');
    assert.equal(api.canAcknowledgeRegistryChange(detail), true);

    const annotation = api.buildRegistryUpgradeAnnotation({
        from, to, changeLevel, detail, note: '确定性重投影：可确认 destructive 显式确认',
        acknowledgeDestructive: true
    });
    assert.equal(annotation.contract, api.REGISTRY_UPGRADE_CONTRACT);
    assert.equal(annotation.version, 1);
    assert.equal(annotation.fromRegistrySha256, from.registrySha256);
    assert.equal(annotation.toRegistrySha256, to.registrySha256);
    assert.ok(annotation.reasons.includes('concept-added'));
    // destructive 注记必须自带与本次复算逐字绑定的确认字段。
    assert.equal(annotation.destructiveAcknowledgement.acknowledged, true);
    assert.equal(annotation.destructiveAcknowledgement.conceptIdImpact, 'none');
    assert.equal(annotation.destructiveAcknowledgement.reasonsHash,
        api.destructiveReasonsHash(detail));

    const expected = {
        fromRegistrySha256: from.registrySha256,
        toRegistrySha256: to.registrySha256,
        registryVersion: to.version,
        changeLevel,
        detail
    };
    assert.equal(api.validateRegistryUpgradeAnnotation(annotation, expected), null);
    assert.match(api.validateRegistryUpgradeAnnotation({ ...annotation, note: '' }, expected), /note/);
    assert.match(api.validateRegistryUpgradeAnnotation(
        { ...annotation, toRegistrySha256: 'b'.repeat(64) }, expected), /toRegistrySha256/);
    assert.match(api.validateRegistryUpgradeAnnotation(
        { ...annotation, changeLevel: 'none' }, expected), /changeLevel/);
    assert.match(api.validateRegistryUpgradeAnnotation(
        { ...annotation, contract: 'other' }, expected), /合同/);
    assert.match(api.validateRegistryUpgradeAnnotation(null, expected), /registryUpgradeFrom/);
    // 显式确认缺失/不可确认 → 连注记都构不出来。
    assert.throws(() => api.buildRegistryUpgradeAnnotation({
        from, to, changeLevel: 'destructive', detail, note: 'x'
    }), /destructive/);
    assert.throws(() => api.buildRegistryUpgradeAnnotation({
        from, to, changeLevel, detail, note: 'x'.repeat(api.REGISTRY_UPGRADE_NOTE_MAX_CHARS + 1)
    }), /note/);
});

// 换表口径：历史快照 → current(v1.1) 全部复算为 destructive，四门中的第 ② 条门
// 只能由“与本次复算绑定的 destructiveAcknowledgement”打开；第 ①③④ 条门（快照
// 取回、注记自洽、conceptIds 仍 active）一条不少，缺任一仍 fail-closed。additive
// 复算的放行路径改用合成旧表复现（见 syntheticAdditiveUpgrade）。
test('seal upgrade gate admits acknowledged destructive upgrades, fails closed otherwise', () => {
    const current = tagCatalogApi.loadTagCatalog(CURRENT);
    const conceptIds = ['task.asr', 'method.transformer'];
    const seed = tagCatalogApi.loadTagCatalog(OLD_SEED);
    const { changeLevel, detail } = api.classifyRegistryChange(seed, current);
    assert.equal(changeLevel, 'destructive');
    assert.equal(api.canAcknowledgeRegistryChange(detail), true);
    const annotation = api.buildRegistryUpgradeAnnotation({
        from: seed,
        to: current,
        changeLevel,
        detail,
        note: '确定性重投影：可确认 destructive 显式确认',
        acknowledgeDestructive: true
    });

    // 可确认 destructive + 合法 ack 注记 → 放行，且分级仍是 destructive（不翻案）。
    const allowed = api.validateSealRegistryUpgrade({
        fromRegistrySha256: seed.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        annotation
    });
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(allowed.changeLevel, 'destructive');

    // destructive 缺 ack 注记 → 第 ② 条门先拒（注记字段门还没轮到）。
    const missingAnnotation = api.validateSealRegistryUpgrade({
        fromRegistrySha256: seed.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds
    });
    assert.equal(missingAnnotation.ok, false);
    assert.match(missingAnnotation.error, /显式确认无效.*destructiveAcknowledgement/);

    const missingSnapshot = api.validateSealRegistryUpgrade({
        fromRegistrySha256: '0'.repeat(64),
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        annotation
    });
    assert.equal(missingSnapshot.ok, false);
    assert.match(missingSnapshot.error, /快照/);

    const aliasRemoval = tagCatalogApi.loadTagCatalog(OLD_ALIAS_REMOVAL);
    const lying = api.buildRegistryUpgradeAnnotation({
        from: aliasRemoval,
        to: current,
        changeLevel: 'additive',
        detail: api.classifyRegistryChange(seed, current).detail,
        note: '谎报 additive'
    });
    const destructive = api.validateSealRegistryUpgrade({
        fromRegistrySha256: aliasRemoval.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        annotation: lying
    });
    assert.equal(destructive.ok, false);
    assert.match(destructive.error, /additive|destructive/);
    assert.equal(destructive.changeLevel, 'destructive');

    const staleConcept = api.validateSealRegistryUpgrade({
        fromRegistrySha256: seed.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds: [...conceptIds, 'task.not-a-concept'],
        annotation
    });
    assert.equal(staleConcept.ok, false);
    assert.match(staleConcept.error, /active/);

    // —— additive 路径（合成旧表）：放行，且注记不携带确认字段 ——
    const additive = syntheticAdditiveUpgrade(current);
    const additiveAllowed = api.validateSealRegistryUpgrade({
        fromRegistrySha256: additive.from.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        snapshotOptions: additive.snapshotOptions,
        annotation: api.buildRegistryUpgradeAnnotation({
            from: additive.from,
            to: current,
            changeLevel: additive.changeLevel,
            detail: additive.detail,
            note: 'additive 升级'
        })
    });
    assert.equal(additiveAllowed.ok, true, additiveAllowed.error);
    assert.equal(additiveAllowed.changeLevel, 'additive');

    // additive 缺注记：拒在注记门本身（与 destructive 的 ack 门区分开）。
    const additiveMissingAnnotation = api.validateSealRegistryUpgrade({
        fromRegistrySha256: additive.from.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        snapshotOptions: additive.snapshotOptions
    });
    assert.equal(additiveMissingAnnotation.ok, false);
    assert.match(additiveMissingAnnotation.error, /registryUpgradeFrom/);
});

// ——— 跨端一致性：同一 (旧SHA, 注记, conceptIds) 输入必须让 Node 与 Python 同向 ———
const CROSS_END_FIXTURE = path.resolve(__dirname, 'fixtures/registry-upgrade-cross-end.json');
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 同码原因的 message 排序依赖 localeCompare 所在 locale（LANG 会影响 Node 的
// ICU 排序），而 Python 侧按码点排序；两侧的 ok/changeLevel/summary/counts/
// reasonCodes 必须逐字一致，error 只在“（…）内分号列表”上做排序归一 ——
// 括号**之后**的尾巴（destructive 显式确认的拒绝理由）必须逐字保留并比对，
// 否则两端的确认语义漂移会被归一掩盖。
function normalizeError(value) {
    if (value === null || value === undefined) return null;
    const start = String(value).indexOf('（');
    const end = String(value).lastIndexOf('）');
    if (start !== -1 && end > start) {
        return String(value).slice(0, start)
            + String(value).slice(start + 1, end).split('；').sort().join('；')
            + String(value).slice(end + 1);
    }
    return String(value);
}

function nodeViewOf(result) {
    return {
        ok: result.ok,
        changeLevel: result.changeLevel,
        summary: result.detail ? result.detail.summary : null,
        reasonCodes: result.detail
            ? [...new Set(result.detail.reasons.map(reason => reason.code))].sort() : null,
        counts: result.detail ? result.detail.counts : null,
        error: normalizeError(result.error)
    };
}


// 原共享向量的输入、确认哈希与结构期望保持；这里只列新的完整显示文字。
const CROSS_END_DISPLAY_EXPECTATIONS = {
    "additive-upgrade-allowed": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×2、broader-id-changed×1、preferred-label-changed×2、alias-added×5、concept-added×58、definition-updated×2、scope-note-updated×8。",
        "error": null
    },
    "missing-annotation-rejected": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×2、broader-id-changed×1、preferred-label-changed×2、alias-added×5、concept-added×58、definition-updated×2、scope-note-updated×8。",
        "error": "registry 变更判定为 destructive，taxonomySeal 不得沿用概念 method.flow-matching 删除了别名“flow matching”，使用该别名的旧标签需要重新核对；概念 method.self-supervised 删除了别名“ssl learning”，使用该别名的旧标签需要重新核对；概念 task.speech-spoofing 的上级概念（broaderId）由 null 改为 task.audio-forgery，祖先关系随之改变，也可能影响主任务是否符合最具体概念的要求；显式确认无效: destructive 变更必须携带 destructiveAcknowledgement 显式确认"
    },
    "no-snapshot-rejected": {
        "summary": null,
        "error": "无法取得 registry 升级前快照 0000000000000000000000000000000000000000000000000000000000000000，按 fail-closed 拒绝 taxonomySeal"
    },
    "destructive-lying-annotation-rejected": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。",
        "error": "registry 变更判定为 destructive，taxonomySeal 不得沿用概念 method.end-to-end-learning 删除了别名“e2e”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“end-to-end”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“端到端”，使用该别名的旧标签需要重新核对；显式确认无效: destructive 变更必须携带 destructiveAcknowledgement 显式确认"
    },
    "annotation-level-mismatch-rejected": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×2、broader-id-changed×1、preferred-label-changed×2、alias-added×5、concept-added×58、definition-updated×2、scope-note-updated×8。",
        "error": "registryUpgradeFrom 校验失败: registryUpgradeFrom.changeLevel=none 与复算结果 destructive 不一致"
    },
    "stale-concept-id-rejected": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×2、broader-id-changed×1、preferred-label-changed×2、alias-added×5、concept-added×58、definition-updated×2、scope-note-updated×8。",
        "error": "taxonomySeal 的 conceptIds 在当前 registry 中不再全部 active: task.not-a-concept(缺失)"
    },
    "invalid-from-sha-rejected": {
        "summary": null,
        "error": "taxonomySeal 记录的 registrySha256 非法，拒绝放行"
    },
    "destructive-acknowledged-allowed": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。",
        "error": null
    },
    "destructive-ack-missing-rejected": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。",
        "error": "registry 变更判定为 destructive，taxonomySeal 不得沿用概念 method.end-to-end-learning 删除了别名“e2e”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“end-to-end”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“端到端”，使用该别名的旧标签需要重新核对；显式确认无效: destructive 变更必须携带 destructiveAcknowledgement 显式确认"
    },
    "destructive-ack-wrong-hash-rejected": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。",
        "error": "registry 变更判定为 destructive，taxonomySeal 不得沿用概念 method.end-to-end-learning 删除了别名“e2e”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“end-to-end”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“端到端”，使用该别名的旧标签需要重新核对；显式确认无效: destructiveAcknowledgement.reasonsHash 与本次复算 destructive reasons 不一致"
    },
    "destructive-ack-concept-impact-rejected": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。",
        "error": "registry 变更判定为 destructive，taxonomySeal 不得沿用概念 method.end-to-end-learning 删除了别名“e2e”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“end-to-end”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“端到端”，使用该别名的旧标签需要重新核对；显式确认无效: destructiveAcknowledgement.conceptIdImpact 必须为 none"
    },
    "destructive-ack-stale-concept-id-rejected": {
        "summary": "词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。",
        "error": "taxonomySeal 的 conceptIds 在当前 registry 中不再全部 active: task.not-a-concept(缺失)"
    }
};

const ORDERED_HISTORY_REASON_EXPECTATIONS = [
    {
        "level": "destructive",
        "code": "alias-removed",
        "message": "概念 method.end-to-end-learning 删除了别名“e2e”，使用该别名的旧标签需要重新核对",
        "conceptId": "method.end-to-end-learning"
    },
    {
        "level": "destructive",
        "code": "alias-removed",
        "message": "概念 method.end-to-end-learning 删除了别名“end-to-end”，使用该别名的旧标签需要重新核对",
        "conceptId": "method.end-to-end-learning"
    },
    {
        "level": "destructive",
        "code": "alias-removed",
        "message": "概念 method.end-to-end-learning 删除了别名“端到端”，使用该别名的旧标签需要重新核对",
        "conceptId": "method.end-to-end-learning"
    },
    {
        "level": "destructive",
        "code": "preferred-label-changed",
        "message": "概念 task.music-understanding 的首选标签（preferredLabel.en）由“Music understanding”改为“Music analysis”",
        "conceptId": "task.music-understanding"
    },
    {
        "level": "destructive",
        "code": "preferred-label-changed",
        "message": "概念 task.music-understanding 的首选标签（preferredLabel.zh）由“音乐理解”改为“音乐分析”",
        "conceptId": "task.music-understanding"
    }
];

function historyReasonSubset(reasons) {
    return reasons.filter(reason => (reason.code === 'alias-removed'
        && reason.conceptId === 'method.end-to-end-learning')
        || (reason.code === 'preferred-label-changed'
            && reason.conceptId === 'task.music-understanding'));
}

// 完整 reason 对象按出现次数比对；本函数不用于证明各端原→新顺序。
function fullReasonCounts(reasons) {
    const counts = new Map();
    for (const reason of reasons) {
        const key = JSON.stringify(Object.fromEntries(
            Object.keys(reason).sort().map(field => [field, reason[field]])
        ));
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

test('Node and Python registry upgrade gates agree on the shared fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(CROSS_END_FIXTURE, 'utf8'));
    assert.equal(fixture.contract, 'paper-taxonomy-registry-upgrade-cross-end-fixture-v1');
    const current = tagCatalogApi.loadTagCatalog(CURRENT);
    assert.deepEqual(Object.keys(CROSS_END_DISPLAY_EXPECTATIONS).sort(),
        fixture.cases.map(item => item.name).sort());
    const classificationInputs = [
        { name: 'alias-removal-to-current',
            from: JSON.parse(fs.readFileSync(OLD_ALIAS_REMOVAL, 'utf8')), to: raw() },
        { name: 'seed-to-current',
            from: JSON.parse(fs.readFileSync(OLD_SEED, 'utf8')), to: raw() },
        { name: 'current-to-current', from: raw(), to: raw() }
    ];
    const pythonProgram = [
        'import json, runpy, sys',
        "runpy.run_path(sys.argv[1], run_name='__main__')",
        'from publish_common import _classify_registry_change, _destructive_reasons_hash, _acknowledgement_eligibility',
        'rows = []',
        'for item in json.load(sys.stdin):',
        "    result = _classify_registry_change(item['from'], item['to'])",
        "    detail = result['detail']",
        "    rows.append({'name': item['name'], 'result': result, 'destructiveReasonsHash': _destructive_reasons_hash(detail), 'eligibility': _acknowledgement_eligibility(detail)})",
        "print('CROSS_END_REASONS:' + json.dumps(rows, ensure_ascii=False, sort_keys=True))"
    ].join('\n');
    const run = spawnSync('bash', [
        path.join(PROJECT_ROOT, 'scripts/python-runtime.sh'), '-c', pythonProgram,
        path.join(PROJECT_ROOT, 'tests/python/registry_upgrade_cross_end.py')
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 180000,
        input: JSON.stringify(classificationInputs) });
    assert.equal(run.status, 0, `Python harness 失败:\n${run.stderr}`);
    const lines = String(run.stdout).split(/\r?\n/);
    const resultLines = lines.filter(text => text.startsWith('CROSS_END_RESULT:'));
    const reasonLines = lines.filter(text => text.startsWith('CROSS_END_REASONS:'));
    assert.equal(resultLines.length, 1, run.stdout);
    assert.equal(reasonLines.length, 1, run.stdout);
    const line = resultLines[0];
    assert.ok(line, `Python harness 缺少结果行:\n${run.stdout}`);
    const pythonResults = JSON.parse(line.slice('CROSS_END_RESULT:'.length));
    assert.equal(pythonResults.length, fixture.cases.length);
    const pythonClassifications = JSON.parse(reasonLines[0].slice('CROSS_END_REASONS:'.length));
    assert.equal(pythonClassifications.length, classificationInputs.length);
    for (const item of classificationInputs) {
        const nodeResult = api.classifyRegistryChange(item.from, item.to);
        const pythonResult = pythonClassifications.find(entry => entry.name === item.name);
        assert.ok(pythonResult, item.name);
        assert.equal(nodeResult.changeLevel, pythonResult.result.changeLevel, item.name);
        const { reasons: nodeReasons, ...nodeDetail } = nodeResult.detail;
        const { reasons: pythonReasons, ...pythonDetail } = pythonResult.result.detail;
        assert.deepEqual(nodeDetail, pythonDetail, item.name);
        assert.deepEqual(fullReasonCounts(nodeReasons), fullReasonCounts(pythonReasons), item.name);
        assert.equal(api.destructiveReasonsHash(nodeResult.detail),
            pythonResult.destructiveReasonsHash, item.name);
        assert.deepEqual(api.acknowledgementEligibility(nodeResult.detail),
            pythonResult.eligibility, item.name);
        if (item.name === 'alias-removal-to-current') {
            assert.deepEqual(historyReasonSubset(nodeReasons), ORDERED_HISTORY_REASON_EXPECTATIONS);
            assert.deepEqual(historyReasonSubset(pythonReasons), ORDERED_HISTORY_REASON_EXPECTATIONS);
        }
    }

    for (const item of fixture.cases) {
        const expected = { ...item.expect, ...CROSS_END_DISPLAY_EXPECTATIONS[item.name] };
        const nodeResult = api.validateSealRegistryUpgrade({
            fromRegistrySha256: item.fromRegistrySha256,
            currentRegistry: current,
            currentRegistrySha256: current.registrySha256,
            conceptIds: item.conceptIds,
            annotation: item.annotation
        });
        const pythonResult = pythonResults.find(entry => entry.name === item.name);
        assert.ok(pythonResult, `Python 侧缺少用例 ${item.name}`);

        assert.deepEqual(nodeViewOf(nodeResult), expected, `Node 输出偏离 fixture: ${item.name}`);
        assert.deepEqual({
            ok: pythonResult.ok,
            changeLevel: pythonResult.changeLevel,
            summary: pythonResult.summary,
            reasonCodes: pythonResult.reasonCodes,
            counts: pythonResult.counts,
            error: normalizeError(pythonResult.error)
        }, expected, `Python 输出偏离 fixture: ${item.name}`);
    }
});

// ——— destructive 显式确认通道（换表前的人工确认） ———
const DESTRUCTIVE_OLD_SHA = '3f9a14c9d753716b428b8ca27a9d93b92b3ae93cfbffc1a24f60573ff8ef234a';
const ACK_FIELD_CODES = [
    'preferred-label-changed', 'broader-id-changed', 'alias-removed',
    'label-collision', 'definition-updated', 'scope-note-updated'
];
const UNACKNOWLEDGEABLE_CODES = [
    'concept-removed', 'facet-removed', 'status-deactivated',
    'version-changed', 'concept-facet-changed', 'active-label-not-globally-unique'
];

const detailWith = codes => ({
    changeLevel: 'destructive',
    reasons: codes.map(code => ({ level: 'destructive', code, message: `${code} 的说明` }))
});

test('acknowledgement eligibility is an explicit whitelist of parse-semantic changes', () => {
    for (const code of ACK_FIELD_CODES) {
        const eligibility = api.acknowledgementEligibility(detailWith([code]));
        assert.equal(eligibility.eligible, true, code);
        assert.deepEqual(eligibility.eligibleReasons, [code]);
        assert.deepEqual(eligibility.ineligibleReasons, []);
        assert.equal(api.canAcknowledgeRegistryChange(detailWith([code])), true, code);
    }
    for (const code of UNACKNOWLEDGEABLE_CODES) {
        const eligibility = api.acknowledgementEligibility(detailWith([code]));
        assert.equal(eligibility.eligible, false, code);
        assert.deepEqual(eligibility.ineligibleReasons, [code]);
        assert.equal(api.canAcknowledgeRegistryChange(detailWith([code])), false, code);
    }
    // 白名单与不可确认集合必须互斥。
    for (const code of api.ACKNOWLEDGEMENT_FORBIDDEN_CODES) {
        assert.equal(api.ACKNOWLEDGEMENT_ELIGIBLE_CODES.includes(code), false, code);
        assert.ok(UNACKNOWLEDGEABLE_CODES.includes(code), code);
    }
    // 混入任一白名单外的 destructive 理由即整体不可确认。
    assert.equal(api.canAcknowledgeRegistryChange(detailWith(['alias-removed', 'concept-removed'])), false);
    assert.equal(api.canAcknowledgeRegistryChange(detailWith(['concept-removed', 'alias-removed'])), false);
    // additive/none 无需确认，天然放行；分级缺失或 destructive 却数不出理由 → fail-closed。
    assert.equal(api.canAcknowledgeRegistryChange({ changeLevel: 'additive',
        reasons: [{ level: 'additive', code: 'concept-added', message: 'x' }] }), true);
    assert.equal(api.canAcknowledgeRegistryChange({ changeLevel: 'none', reasons: [] }), true);
    assert.equal(api.canAcknowledgeRegistryChange({ changeLevel: 'destructive', reasons: [] }), false);
    assert.equal(api.canAcknowledgeRegistryChange(null), false);
    assert.equal(api.canAcknowledgeRegistryChange({ reasons: [] }), false);
    // 真实改动的分级不被确认逻辑改写。
    const relabel = clone(raw());
    byId(relabel, 'task.asr').preferredLabel.zh = '自动语音转写';
    const real = api.classifyRegistryChange(raw(), relabel);
    assert.equal(real.changeLevel, 'destructive');
    assert.equal(api.canAcknowledgeRegistryChange(real.detail), true);
    const removal = clone(raw());
    removal.concepts = removal.concepts.filter(concept => concept.id !== 'task.wake-word');
    const gone = api.classifyRegistryChange(raw(), removal);
    assert.equal(gone.changeLevel, 'destructive');
    assert.equal(api.canAcknowledgeRegistryChange(gone.detail), false);
});

test('destructive reasonsHash is a stable, message-independent fingerprint of the recomputed detail', () => {
    const from = tagCatalogApi.loadTagCatalog(OLD_ALIAS_REMOVAL);
    const current = tagCatalogApi.loadTagCatalog(CURRENT);
    const { detail } = api.classifyRegistryChange(from, current);
    const hash = api.destructiveReasonsHash(detail);
    assert.match(hash, /^[a-f0-9]{64}$/);
    // 固定输入 → 固定哈希（跨 run、跨端都必须等于这个字面量）。
    // 换表口径：detail 复算自 aliasRemoval(3f9a14c9) → current(v1.1)，
    // 指纹随复算结果更新为下面这个值（旧值 4549df39… 属于换表前的 228 概念表）。
    assert.equal(hash, '2442f16185af5300754e2b7d948728df085e6895880b9bcfa0c23ba60f9f8273');
    assert.equal(api.destructiveReasonsHash(detail), hash, '同 detail 必须同哈希');
    // 与 reason 顺序无关（Node/Python 排序规则不同）。
    assert.equal(api.destructiveReasonsHash({ ...detail,
        reasons: [...detail.reasons].reverse() }), hash);
    // 与 message 文案无关（两端 message 不逐字相同，指纹只吃结构化字段）。
    assert.equal(api.destructiveReasonsHash({ ...detail,
        reasons: detail.reasons.map(reason => ({ ...reason, message: `${reason.message}（改写）` })) }), hash);
    // 任一结构化字段变化 → 哈希变化。
    const mutated = detail.reasons.map(reason => reason.code === 'alias-removed'
        ? { ...reason, conceptId: 'method.other-concept' } : reason);
    assert.notEqual(api.destructiveReasonsHash({ ...detail, reasons: mutated }), hash);
    assert.notEqual(api.destructiveReasonsHash({ ...detail, reasons: [] }), hash);
    // 确认字段默认模板自带 from/to 字节 SHA。
    const acknowledgement = api.buildDestructiveAcknowledgement({
        detail, fromRegistrySha256: from.registrySha256, toRegistrySha256: current.registrySha256
    });
    assert.equal(acknowledgement.acknowledged, true);
    assert.equal(acknowledgement.conceptIdImpact, 'none');
    assert.equal(acknowledgement.reasonsHash, hash);
    assert.ok(acknowledgement.note.includes(from.registrySha256));
    assert.ok(acknowledgement.note.includes(current.registrySha256));
    assert.equal(api.buildDestructiveAcknowledgement({
        detail, fromRegistrySha256: from.registrySha256, toRegistrySha256: current.registrySha256,
        note: '人工确认'
    }).note, '人工确认');
    // 不可确认的变更不能生成确认字段。
    const removal = clone(raw());
    removal.concepts = removal.concepts.filter(concept => concept.id !== 'task.wake-word');
    const ineligible = api.classifyRegistryChange(raw(), removal);
    assert.throws(() => api.buildDestructiveAcknowledgement({
        detail: ineligible.detail, fromRegistrySha256: from.registrySha256,
        toRegistrySha256: current.registrySha256
    }), /白名单/);
});

test('the seal gate admits an acknowledged destructive upgrade only when all four doors hold', () => {
    const current = tagCatalogApi.loadTagCatalog(CURRENT);
    const from = tagCatalogApi.loadTagCatalog(OLD_ALIAS_REMOVAL);
    const conceptIds = ['task.asr', 'method.transformer'];
    const { changeLevel, detail } = api.classifyRegistryChange(from, current);
    assert.equal(changeLevel, 'destructive');
    assert.equal(api.canAcknowledgeRegistryChange(detail), true);
    const annotation = api.buildRegistryUpgradeAnnotation({
        from, to: current, changeLevel, detail,
        note: '确定性重投影：别名语义人工确认',
        acknowledgeDestructive: true,
        acknowledgementNote: '人工确认：仅改标签解析语义（删别名/改 broaderId/改首选标签），conceptId 影响 none'
    });
    const seal = (overrides = {}) => api.validateSealRegistryUpgrade({
        fromRegistrySha256: from.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        annotation,
        ...overrides
    });

    // ①+②+③+④ 全部成立 → 放行（分级仍是 destructive，不被翻案）。
    const allowed = seal();
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(allowed.changeLevel, 'destructive');
    assert.equal(allowed.detail.changeLevel, 'destructive');

    // ② 确认缺失 / 哈希不符 / 影响面非 none / 未知字段 / note 非法 → 拒。
    const ack = annotation.destructiveAcknowledgement;
    const withAck = patch => ({ ...annotation,
        destructiveAcknowledgement: { ...ack, ...patch } });
    const noAck = { ...annotation };
    delete noAck.destructiveAcknowledgement;
    assert.match(seal({ annotation: noAck }).error, /显式确认无效.*destructiveAcknowledgement/);
    assert.match(seal({ annotation: withAck({ acknowledged: false }) }).error, /acknowledged/);
    assert.match(seal({ annotation: withAck({ reasonsHash: '0'.repeat(64) }) }).error, /reasonsHash/);
    assert.match(seal({ annotation: withAck({ reasonsHash: 'nope' }) }).error, /64 位十六进制/);
    assert.match(seal({ annotation: withAck({ conceptIdImpact: 'removed' }) }).error, /conceptIdImpact/);
    assert.match(seal({ annotation: withAck({ extra: true }) }).error, /未知字段/);
    assert.match(seal({ annotation: withAck({ note: '   ' }) }).error, /note/);

    // ③ 注记其余字段仍逐项自洽（谎报 changeLevel 一律拒）。
    assert.match(seal({ annotation: { ...annotation, changeLevel: 'additive' } }).error,
        /changeLevel/);
    assert.match(seal({ annotation: { ...annotation, toRegistrySha256: 'b'.repeat(64) } }).error,
        /toRegistrySha256/);
    assert.match(seal({ annotation: { ...annotation, contract: 'other' } }).error, /合同/);
    // additive 变更不得携带确认字段（注记形态被锁死）。
    // 换表口径：历史快照 → current 已无 additive 对，用合成旧表复现 additive 复算。
    const additive = syntheticAdditiveUpgrade(current);
    const additiveAnnotation = api.buildRegistryUpgradeAnnotation({
        from: additive.from, to: current,
        changeLevel: additive.changeLevel, detail: additive.detail,
        note: 'additive'
    });
    const annotatedAdditive = api.validateSealRegistryUpgrade({
        fromRegistrySha256: additive.from.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        snapshotOptions: additive.snapshotOptions,
        annotation: { ...additiveAnnotation, destructiveAcknowledgement: ack }
    });
    assert.equal(annotatedAdditive.ok, false);
    assert.match(annotatedAdditive.error, /非 destructive/);

    // ④ conceptIds 非 active → 即便确认合法也拒。
    assert.match(seal({ conceptIds: [...conceptIds, 'task.not-a-concept'] }).error, /active/);
    // ① 快照取不回 → 拒（确认无法替代快照）。
    assert.match(seal({ fromRegistrySha256: '0'.repeat(64),
        annotation: { ...annotation, fromRegistrySha256: '0'.repeat(64) } }).error, /快照/);

    // 不可确认的 destructive：即便注记带完整合法确认也拒。
    const synthetic = clone(raw());
    synthetic.concepts.push({
        id: 'task.legacy-only', facet: 'task',
        preferredLabel: { zh: '旧表独有概念', en: 'Legacy Only Concept' },
        aliases: ['LegacyOnly'], broaderId: null,
        definition: '旧表独有、新表已删除的概念。', scopeNote: '仅用于不可确认集合测试。',
        status: 'active', replacedBy: null
    });
    const syntheticSha = 'a'.repeat(64);
    const syntheticRegistry = { ...synthetic, registrySha256: syntheticSha };
    const snapshotOptions = { registryHistory: { [syntheticSha]: syntheticRegistry } };
    const syntheticDetail = api.classifyRegistryChange(syntheticRegistry, current).detail;
    assert.equal(api.canAcknowledgeRegistryChange(syntheticDetail), false);
    const ineligibleAnnotation = api.buildRegistryUpgradeAnnotation({
        from: syntheticRegistry, to: current, changeLevel: 'additive',
        detail: api.classifyRegistryChange(syntheticRegistry, current).detail, note: 'x'
    });
    const ineligible = api.validateSealRegistryUpgrade({
        fromRegistrySha256: syntheticSha,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        snapshotOptions,
        annotation: { ...ineligibleAnnotation, changeLevel: 'destructive',
            destructiveAcknowledgement: { ...ack,
                reasonsHash: api.destructiveReasonsHash(syntheticDetail) } }
    });
    assert.equal(ineligible.ok, false);
    assert.equal(ineligible.changeLevel, 'destructive');
    assert.match(ineligible.error, /不在可确认白名单/);
    assert.match(ineligible.error, /concept-removed/);
});

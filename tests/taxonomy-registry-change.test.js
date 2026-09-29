'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const taxonomyApi = require('../scripts/lib/paper-taxonomy.js');
const api = require('../scripts/lib/taxonomy-registry-change.js');

const CURRENT = path.resolve(__dirname, '../config/paper-taxonomy.json');
const HISTORY = path.resolve(__dirname, '../config/taxonomy-registry-history');
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

test('identical registry bytes classify as none with empty reasons', () => {
    const registry = taxonomyApi.loadTaxonomy(CURRENT);
    const detail = expectLevel(registry, registry, 'none');
    assert.equal(detail.reasons.length, 0);
    assert.equal(detail.oldRegistrySha256, detail.newRegistrySha256);
    assert.match(detail.summary, /语义零变化/);
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
    taxonomyApi.validateTaxonomy(aliasDrop);
    expectLevel(raw(), aliasDrop, 'destructive', ['alias-removed']);
    assert.ok(dropped);
});

test('reactivating a deprecated concept is additive', () => {
    const deprecated = clone(raw());
    const victim = byId(deprecated, 'task.wake-word');
    victim.status = 'deprecated';
    victim.replacedBy = 'task.keyword-detection';
    taxonomyApi.validateTaxonomy(deprecated);

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
    taxonomyApi.validateTaxonomy(next);

    const detail = expectLevel(raw(), next, 'destructive', ['active-label-not-globally-unique']);
    assert.ok(detail.reasons.some(reason => reason.code === 'active-label-not-globally-unique'
        && reason.conceptIds.length === 2));
});

// 评审复现场景：把另一分面已占用的标签当别名加进来 —— validateTaxonomy 的
// 标签唯一性只在分面内（scripts/lib/paper-taxonomy.js 的 key 是 facet\0归一
// 标签），registry 校验能过、旧分级还会判 additive，但解析期该标签的候选数
// 会由 1 变 2，所以必须判 destructive / label-collision。
test('cross-facet collisions over every registry label are destructive (label-collision)', () => {
    const aliasCollision = clone(raw());
    byId(aliasCollision, 'method.transformer').aliases.push('语音识别');
    taxonomyApi.validateTaxonomy(aliasCollision);

    const detail = expectLevel(raw(), aliasCollision, 'destructive', ['label-collision']);
    const collisions = detail.reasons.filter(reason => reason.code === 'label-collision');
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].level, 'destructive');
    assert.equal(collisions[0].tag, '#语音识别');
    assert.deepEqual([...collisions[0].conceptIds].sort(), ['method.transformer', 'task.asr']);
    assert.deepEqual([...collisions[0].facets].sort(), ['method', 'task']);
    assert.match(collisions[0].message, /跨分面重复/);
    assert.equal(detail.summary.includes('label-collision×1'), true);

    // 英文首选标签同样参与扫描。
    const enCollision = clone(raw());
    byId(enCollision, 'method.transformer').aliases.push('Automatic speech recognition');
    taxonomyApi.validateTaxonomy(enCollision);
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
    taxonomyApi.validateTaxonomy(deprecatedCollision);
    const deprecatedDetail = expectLevel(raw(), deprecatedCollision, 'destructive',
        ['label-collision', 'deprecated-concept-added']);
    assert.ok(deprecatedDetail.reasons.some(reason => reason.code === 'label-collision'
        && reason.tag === '#语音识别'
        && reason.conceptIds.includes('signal.voice-recognition')));

    // 只在同一分面内出现的重复不会走到这里：validateTaxonomy 直接抛错。
    assert.throws(() => {
        const inFacet = clone(raw());
        byId(inFacet, 'method.transformer').aliases.push('端到端学习');
        taxonomyApi.validateTaxonomy(inFacet);
        api.classifyRegistryChange(raw(), inFacet);
    }, /Ambiguous label in facet/);
});

test('registry validation still fails closed on an impossible facet migration', () => {
    const migrated = clone(raw());
    byId(migrated, 'task.asr').facet = 'method';
    assert.throws(() => api.classifyRegistryChange(raw(), migrated), /Invalid\/duplicate concept ID/);
});

test('real historical registry transitions classify as documented', () => {
    const seed = taxonomyApi.loadTaxonomy(OLD_SEED);
    const aliasRemoval = taxonomyApi.loadTaxonomy(OLD_ALIAS_REMOVAL);
    const current = taxonomyApi.loadTaxonomy(CURRENT);

    // 历史 seed → aliasRemoval 新增 method.end-to-end-learning，其别名“端到端”
    // 与“End-to-end”撞上既有 setting.end-to-end 的 zh/en 首选（跨分面、候选由 1
    // 变 2）：补上 label-collision 后这一过渡必须判 destructive —— 这正是当年
    // 被误判为 additive 的漏判点；concept-added 仍保留在 reasons 里。
    const introduced = expectLevel(seed, aliasRemoval, 'destructive',
        ['concept-added', 'label-collision']);
    assert.equal(introduced.reasons.filter(reason => reason.code === 'label-collision').length, 2);
    expectLevel(seed, current, 'additive', ['concept-added']);

    const detail = expectLevel(aliasRemoval, current, 'destructive', ['alias-removed']);
    const removals = detail.reasons.filter(reason => reason.code === 'alias-removed');
    assert.equal(removals.length, 3);
    assert.ok(removals.every(reason => reason.conceptId === 'method.end-to-end-learning'));
    assert.equal(detail.counts.conceptsAdded, 23);
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

test('registryUpgradeFrom annotation is built and verified against the recomputed level', () => {
    const from = taxonomyApi.loadTaxonomy(OLD_SEED);
    const to = taxonomyApi.loadTaxonomy(CURRENT);
    const { changeLevel, detail } = api.classifyRegistryChange(from, to);
    assert.equal(changeLevel, 'additive');

    const annotation = api.buildRegistryUpgradeAnnotation({
        from, to, changeLevel, detail, note: '确定性重投影：只增新概念'
    });
    assert.equal(annotation.contract, api.REGISTRY_UPGRADE_CONTRACT);
    assert.equal(annotation.version, 1);
    assert.equal(annotation.fromRegistrySha256, from.registrySha256);
    assert.equal(annotation.toRegistrySha256, to.registrySha256);
    assert.ok(annotation.reasons.includes('concept-added'));

    const expected = {
        fromRegistrySha256: from.registrySha256,
        toRegistrySha256: to.registrySha256,
        registryVersion: to.version,
        changeLevel
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

    assert.throws(() => api.buildRegistryUpgradeAnnotation({
        from, to, changeLevel: 'destructive', detail, note: 'x'
    }), /destructive/);
    assert.throws(() => api.buildRegistryUpgradeAnnotation({
        from, to, changeLevel, detail, note: 'x'.repeat(api.REGISTRY_UPGRADE_NOTE_MAX_CHARS + 1)
    }), /note/);
});

test('seal upgrade gate passes additive upgrades and fails closed otherwise', () => {
    const current = taxonomyApi.loadTaxonomy(CURRENT);
    const conceptIds = ['task.asr', 'method.transformer'];
    const seed = taxonomyApi.loadTaxonomy(OLD_SEED);
    const annotation = api.buildRegistryUpgradeAnnotation({
        from: seed,
        to: current,
        changeLevel: api.classifyRegistryChange(seed, current).changeLevel,
        detail: api.classifyRegistryChange(seed, current).detail,
        note: 'additive 升级'
    });

    const allowed = api.validateSealRegistryUpgrade({
        fromRegistrySha256: seed.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        annotation
    });
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(allowed.changeLevel, 'additive');

    const missingAnnotation = api.validateSealRegistryUpgrade({
        fromRegistrySha256: seed.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds
    });
    assert.equal(missingAnnotation.ok, false);
    assert.match(missingAnnotation.error, /registryUpgradeFrom/);

    const missingSnapshot = api.validateSealRegistryUpgrade({
        fromRegistrySha256: '0'.repeat(64),
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        annotation
    });
    assert.equal(missingSnapshot.ok, false);
    assert.match(missingSnapshot.error, /快照/);

    const aliasRemoval = taxonomyApi.loadTaxonomy(OLD_ALIAS_REMOVAL);
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

test('Node and Python registry upgrade gates agree on the shared fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(CROSS_END_FIXTURE, 'utf8'));
    assert.equal(fixture.contract, 'paper-taxonomy-registry-upgrade-cross-end-fixture-v1');
    const current = taxonomyApi.loadTaxonomy(CURRENT);

    const run = spawnSync('bash', [
        path.join(PROJECT_ROOT, 'scripts/python-runtime.sh'),
        path.join(PROJECT_ROOT, 'tests/python/registry_upgrade_cross_end.py')
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 180000 });
    assert.equal(run.status, 0, `Python harness 失败:\n${run.stderr}`);
    const line = String(run.stdout).split(/\r?\n/)
        .find(text => text.startsWith('CROSS_END_RESULT:'));
    assert.ok(line, `Python harness 缺少结果行:\n${run.stdout}`);
    const pythonResults = JSON.parse(line.slice('CROSS_END_RESULT:'.length));
    assert.equal(pythonResults.length, fixture.cases.length);

    for (const item of fixture.cases) {
        const nodeResult = api.validateSealRegistryUpgrade({
            fromRegistrySha256: item.fromRegistrySha256,
            currentRegistry: current,
            currentRegistrySha256: current.registrySha256,
            conceptIds: item.conceptIds,
            annotation: item.annotation
        });
        const pythonResult = pythonResults.find(entry => entry.name === item.name);
        assert.ok(pythonResult, `Python 侧缺少用例 ${item.name}`);

        assert.deepEqual(nodeViewOf(nodeResult), item.expect, `Node 输出偏离 fixture: ${item.name}`);
        assert.deepEqual({
            ok: pythonResult.ok,
            changeLevel: pythonResult.changeLevel,
            summary: pythonResult.summary,
            reasonCodes: pythonResult.reasonCodes,
            counts: pythonResult.counts,
            error: normalizeError(pythonResult.error)
        }, item.expect, `Python 输出偏离 fixture: ${item.name}`);
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
        assert.equal(api.isAcknowledgementEligible(detailWith([code])), true, code);
    }
    for (const code of UNACKNOWLEDGEABLE_CODES) {
        const eligibility = api.acknowledgementEligibility(detailWith([code]));
        assert.equal(eligibility.eligible, false, code);
        assert.deepEqual(eligibility.ineligibleReasons, [code]);
        assert.equal(api.isAcknowledgementEligible(detailWith([code])), false, code);
    }
    // 白名单与不可确认集合必须互斥。
    for (const code of api.ACKNOWLEDGEMENT_FORBIDDEN_CODES) {
        assert.equal(api.ACKNOWLEDGEMENT_ELIGIBLE_CODES.includes(code), false, code);
        assert.ok(UNACKNOWLEDGEABLE_CODES.includes(code), code);
    }
    // 混入任一白名单外的 destructive 理由即整体不可确认。
    assert.equal(api.isAcknowledgementEligible(detailWith(['alias-removed', 'concept-removed'])), false);
    assert.equal(api.isAcknowledgementEligible(detailWith(['concept-removed', 'alias-removed'])), false);
    // additive/none 无需确认，天然放行；分级缺失或 destructive 却数不出理由 → fail-closed。
    assert.equal(api.isAcknowledgementEligible({ changeLevel: 'additive',
        reasons: [{ level: 'additive', code: 'concept-added', message: 'x' }] }), true);
    assert.equal(api.isAcknowledgementEligible({ changeLevel: 'none', reasons: [] }), true);
    assert.equal(api.isAcknowledgementEligible({ changeLevel: 'destructive', reasons: [] }), false);
    assert.equal(api.isAcknowledgementEligible(null), false);
    assert.equal(api.isAcknowledgementEligible({ reasons: [] }), false);
    // 真实改动的分级不被确认逻辑改写。
    const relabel = clone(raw());
    byId(relabel, 'task.asr').preferredLabel.zh = '自动语音转写';
    const real = api.classifyRegistryChange(raw(), relabel);
    assert.equal(real.changeLevel, 'destructive');
    assert.equal(api.isAcknowledgementEligible(real.detail), true);
    const removal = clone(raw());
    removal.concepts = removal.concepts.filter(concept => concept.id !== 'task.wake-word');
    const gone = api.classifyRegistryChange(raw(), removal);
    assert.equal(gone.changeLevel, 'destructive');
    assert.equal(api.isAcknowledgementEligible(gone.detail), false);
});

test('destructive reasonsHash is a stable, message-independent fingerprint of the recomputed detail', () => {
    const from = taxonomyApi.loadTaxonomy(OLD_ALIAS_REMOVAL);
    const current = taxonomyApi.loadTaxonomy(CURRENT);
    const { detail } = api.classifyRegistryChange(from, current);
    const hash = api.destructiveReasonsHash(detail);
    assert.match(hash, /^[a-f0-9]{64}$/);
    // 固定输入 → 固定哈希（跨 run、跨端都必须等于这个字面量）。
    assert.equal(hash, '4549df39536d53414388cd1620efbf8d639cb791f8df17d8a157e1ad88b4677a');
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
    const current = taxonomyApi.loadTaxonomy(CURRENT);
    const from = taxonomyApi.loadTaxonomy(OLD_ALIAS_REMOVAL);
    const conceptIds = ['task.asr', 'method.transformer'];
    const { changeLevel, detail } = api.classifyRegistryChange(from, current);
    assert.equal(changeLevel, 'destructive');
    assert.equal(api.isAcknowledgementEligible(detail), true);
    const annotation = api.buildRegistryUpgradeAnnotation({
        from, to: current, changeLevel, detail,
        note: '确定性重投影：别名语义人工确认',
        acknowledgeDestructive: true,
        acknowledgementNote: '人工确认：仅删别名，conceptId 影响 none'
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
    const additiveFrom = taxonomyApi.loadTaxonomy(OLD_SEED);
    const additive = api.buildRegistryUpgradeAnnotation({
        from: additiveFrom, to: current,
        ...api.classifyRegistryChange(additiveFrom, current),
        note: 'additive'
    });
    const annotatedAdditive = api.validateSealRegistryUpgrade({
        fromRegistrySha256: additiveFrom.registrySha256,
        currentRegistry: current,
        currentRegistrySha256: current.registrySha256,
        conceptIds,
        annotation: { ...additive, destructiveAcknowledgement: ack }
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
    assert.equal(api.isAcknowledgementEligible(syntheticDetail), false);
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

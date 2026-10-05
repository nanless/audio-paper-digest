'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validAnalysisText } = require('./valid-analysis-fixture.js');
const contract = require('../scripts/analysis-contract.js');
const { parseAnalysis } = require('../scripts/utils.js');
const resealApi = require('../scripts/lib/tag-record-update.js');
const cli = require('../scripts/tag-record-update.js');
const { buildTagPromptText, TAG_PROMPT_TEXT_CONTRACT, LEGACY_TAG_PROMPT_TEXT_CONTRACT }
    = require('../scripts/lib/tag-rules.js');
const crypto = require('node:crypto');
const { ADDITIVE_OLD_SHA, DESTRUCTIVE_OLD_SHA, EXECUTION_ID, PAPER_ID,
    runtime, analysisRecord, reproject } = require('./helpers/tag-record-update-fixture.js');

test('标签阶段已使用当前词表时，只核验记录，不写入文件', () => {
    const plan = reproject();
    assert.equal(plan.ok, false);
    assert.equal(plan.analysis, null);
    assert.equal(plan.item.status, 'assigned');
    assert.equal(plan.item.outcome, 'already-current');
    assert.equal(plan.item.needsHuman, false);
    assert.deepEqual(plan.item.conceptIdsDiff, { added: [], removed: [] });
    assert.deepEqual(plan.item.oldConceptIds, plan.item.newConceptIds);
    assert.equal(plan.item.pageRestageRequired, false);
});

test('旧选择协议按原绑定读取；未知选择协议即使原签名有效也不能更新', () => {
    const saved = analysisRecord({ selectionContract: 'paper-taxonomy-selection-v1' });
    const bytes = JSON.stringify(saved);
    const plan = reproject({ analysis: saved });
    assert.equal(plan.item.outcome, 'already-current');
    assert.equal(JSON.stringify(saved), bytes);
    const unknown = analysisRecord({ selectionContract: 'unknown' });
    const unknownBytes = JSON.stringify(unknown);
    const rejected = reproject({ analysis: unknown });
    assert.equal(rejected.item.outcome, 'binding-refused');
    assert.equal(rejected.analysis, null);
    assert.equal(JSON.stringify(unknown), unknownBytes);
});

// dcf83f84 快照更新到当前 v1.1 词表时，首选标签、上级关系和别名发生了变化，
// 程序将其判为允许明确确认的破坏性变更。本用例保持所选概念 ID，并提供对应确认。
test('明确确认允许的破坏性变更后，工具按当前词表更新标签阶段记录，不调用模型', () => {
    const plan = reproject({ registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64),
        acknowledgeDestructive: true });
    assert.equal(plan.ok, true, plan.item.errors.join('; '));
    assert.equal(plan.item.status, 'assigned');
    assert.equal(plan.item.outcome, 'resealed');
    assert.equal(plan.item.changeLevel, 'destructive');
    assert.equal(plan.item.needsHuman, false);
    assert.deepEqual(plan.item.conceptIdsDiff, { added: [], removed: [] });
    assert.deepEqual(plan.item.oldConceptIds, plan.item.newConceptIds);
    assert.equal(plan.item.pageRestageRequired, true);
    assert.equal(plan.item.registry.from, ADDITIVE_OLD_SHA);
    assert.equal(plan.item.registry.to, runtime().registrySha256);

    const nextStage = plan.analysis.papers[0].analysisManifest.stages.tagSelection;
    assert.equal(nextStage.selectionContract, 'paper-tag-selection-v2');
    assert.equal(nextStage.registryUpgradeFrom.contract, 'paper-tag-catalog-upgrade-v2');
    assert.equal(nextStage.registryUpgradeFrom.version, 2);
    assert.equal(nextStage.registrySha256, runtime().registrySha256);
    assert.equal(nextStage.projectionSha256, runtime().projectionSha256);
    assert.equal(nextStage.projectionContract, TAG_PROMPT_TEXT_CONTRACT);
    assert.equal(nextStage.registryUpgradeFrom.changeLevel, 'destructive');
    assert.equal(nextStage.registryUpgradeFrom.destructiveAcknowledgement.acknowledged, true);
    assert.equal(nextStage.registryUpgradeFrom.fromRegistrySha256, ADDITIVE_OLD_SHA);
    assert.notEqual(nextStage.bindingSha256, analysisRecord({
        registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64)
    }).papers[0].analysisManifest.stages.taxonomySeal.bindingSha256);
    // 正文内容保持不变；阶段记录更新词表与提示文本字段、内容哈希及升级说明。
    assert.equal(plan.analysis.papers[0].analysis,
        analysisRecord({ registrySha256: ADDITIVE_OLD_SHA }).papers[0].analysis);
    // 显式重新生成后，缓存仅使用新的标签校验字段。
    const refreshed = plan.analysis.papers[0].parsed.tagValidation;
    assert.equal(refreshed.registrySha256, runtime().registrySha256);
    assert.equal(refreshed.valid, true);
    assert.deepEqual(refreshed.conceptIds,
        analysisRecord({ registrySha256: ADDITIVE_OLD_SHA }).papers[0].parsed.taxonomyValidation.conceptIds);
    assert.deepEqual(plan.analysis.papers[0].parsed.tags,
        analysisRecord({ registrySha256: ADDITIVE_OLD_SHA }).papers[0].parsed.tags);
    assert.strictEqual(contract.validateTagStageProof(plan.analysis.papers[0], {
        parsed: parseAnalysis(plan.analysis.papers[0].analysis, { tagRules: runtime() }),
        tagRules: runtime()
    }), null);
});

test('annotate 模式保留原标签阶段字段，并记录已确认的词表升级说明', () => {
    const plan = reproject({ registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64),
        mode: 'annotate', acknowledgeDestructive: true });
    assert.equal(plan.ok, true, plan.item.errors.join('; '));
    assert.equal(plan.item.outcome, 'annotated');
    const nextStage = plan.analysis.papers[0].analysisManifest.stages.taxonomySeal;
    assert.equal(nextStage.registrySha256, ADDITIVE_OLD_SHA);
    assert.equal(nextStage.projectionSha256, 'e'.repeat(64));
    assert.equal(nextStage.projectionContract, LEGACY_TAG_PROMPT_TEXT_CONTRACT);
    assert.equal(nextStage.registryUpgradeFrom.changeLevel, 'destructive');
    assert.equal(nextStage.registryUpgradeFrom.destructiveAcknowledgement.acknowledged, true);
    assert.strictEqual(contract.validateTagStageProof(plan.analysis.papers[0], {
        parsed: parseAnalysis(plan.analysis.papers[0].analysis, { tagRules: runtime() }),
        tagRules: runtime()
    }), null);
});

test('白名单外的破坏性词表变更会停止更新，留待人工或模型重新选择标签', () => {
    const plan = reproject({ registrySha256: DESTRUCTIVE_OLD_SHA, projectionSha256: 'e'.repeat(64) });
    assert.equal(plan.ok, false);
    assert.equal(plan.analysis, null);
    assert.equal(plan.item.status, 'blocked');
    assert.equal(plan.item.outcome, 'destructive-change');
    assert.equal(plan.item.needsHuman, true);
    assert.ok(plan.item.reasons.length > 0);
    assert.match(plan.item.errors.join(' '), /破坏性变更/);
});

test('无法取得更新前的词表快照时，工具拒绝更新标签记录', () => {
    const plan = reproject({
        registrySha256: '0'.repeat(64),
        projectionSha256: 'e'.repeat(64),
        snapshotOptions: { historyDir: path.join(os.tmpdir(), 'does-not-exist-taxonomy') }
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.item.outcome, 'missing-registry-snapshot');
    assert.equal(plan.item.needsHuman, true);
    assert.match(plan.item.errors.join(' '), /快照/);
});

test('正文标签无法按当前词表解析时，报告需要人工或模型重新选择标签', () => {
    const text = validAnalysisText().replace('#鲁棒性', '#不存在的标签');
    const plan = reproject({ analysis: analysisRecord({ analysis: text,
        registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64) }),
        acknowledgeDestructive: true, snapshotOptions: {} });
    assert.equal(plan.ok, false);
    assert.equal(plan.item.outcome, 'selection-invalid');
    assert.equal(plan.item.needsHuman, true);
    assert.ok(Array.isArray(plan.item.errorsDetail) && plan.item.errorsDetail.length > 0);
});

test('预览报告包含逐篇差异，以及已分配、受阻和跳过的结果', () => {
    const assigned = reproject({ registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64),
        acknowledgeDestructive: true });
    const blocked = reproject({ registrySha256: DESTRUCTIVE_OLD_SHA, projectionSha256: 'e'.repeat(64) });
    const summary = resealApi.summarizeTagRecordUpdates({ items: [
        { ...assigned.item }, { ...blocked.item },
        { paperId: PAPER_ID, status: 'skipped', outcome: 'not-complete', needsHuman: false }
    ] });
    assert.equal(summary.total, 3);
    assert.equal(summary.assigned, 1);
    assert.equal(summary.blocked, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.needsHuman, 1);
    assert.equal(summary.outcomes.resealed, 1);
    assert.equal(summary.outcomes['destructive-change'], 1);
    assert.equal(summary.outcomes['not-complete'], 1);
    for (const item of [assigned.item, blocked.item]) {
        assert.match(item.paperId, /^conference:/);
        assert.equal(item.analysisRunId, EXECUTION_ID);
        assert.ok(item.registry.from && item.registry.to);
        assert.ok(Array.isArray(item.oldConceptIds) && Array.isArray(item.newConceptIds));
        assert.deepEqual(Object.keys(item.conceptIdsDiff).sort(), ['added', 'removed']);
        assert.ok(['assigned', 'blocked', 'skipped'].includes(item.status));
        assert.equal(typeof item.needsHuman, 'boolean');
    }
});

test('不支持的更新模式和格式不符的分析记录会被拒绝', () => {
    assert.throws(() => reproject({ mode: 'llm' }), /不支持的标签记录更新模式/);
    const broken = resealApi.reprojectAnalysis({ analysis: { papers: [] }, runtime: runtime() });
    assert.equal(broken.item.status, 'blocked');
    assert.equal(broken.item.outcome, 'unreadable-analysis');
});

test('mark-stale 只报告旧标签分配文件，不改写原文件', () => {
    const current = runtime().registrySha256;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-stale-'));
    try {
        fs.mkdirSync(path.join(root, 'run-a'));
        fs.mkdirSync(path.join(root, 'run-b'));
        const staleName = `arxiv-2401.00001.taxonomy.${'a'.repeat(64)}.json`;
        fs.writeFileSync(path.join(root, 'run-a', staleName), JSON.stringify({ paperId: 'arxiv:2401.00001' }));
        fs.writeFileSync(path.join(root, 'run-b', 'arxiv-2401.00002.taxonomy.json'),
            JSON.stringify({ paperId: 'arxiv:2401.00002', registrySha256: current }));
        fs.writeFileSync(path.join(root, 'run-b', 'arxiv-2401.00003.taxonomy.json'), '{不是JSON');

        const before = fs.readdirSync(path.join(root, 'run-a'));
        const scan = resealApi.scanStaleAssignments({ root, currentRegistrySha256: current });
        assert.equal(scan.directories.length, 2);
        assert.equal(scan.stale, 1);
        assert.equal(scan.current, 1);
        assert.equal(scan.unreadable, 1);
        const stale = scan.entries.find(entry => entry.file === staleName);
        assert.equal(stale.stale, true);
        assert.equal(stale.registrySha256, 'a'.repeat(64));
        assert.deepEqual(fs.readdirSync(path.join(root, 'run-a')), before,
            'mark-stale 是只读的');
        const missing = resealApi.scanStaleAssignments({
            root: path.join(root, 'nope'), currentRegistrySha256: current
        });
        assert.equal(missing.entries.length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('命令参数支持更新记录、标记旧文件、比较词表和归档快照', () => {
    const uuid = '9dce2993-0000-4000-8000-000000000000';
    assert.deepEqual(cli.parseArgs(['--from', uuid]),
        { command: 'reseal', processId: uuid, apply: false, mode: 'reproject', reportName: null,
            acknowledgeDestructive: false, acknowledgeNote: null });
    assert.deepEqual(cli.parseArgs(['--from', uuid, '--apply', '--mode', 'annotate']),
        { command: 'reseal', processId: uuid, apply: true, mode: 'annotate', reportName: null,
            acknowledgeDestructive: false, acknowledgeNote: null });
    assert.deepEqual(cli.parseArgs(['--from', uuid, '--acknowledge-destructive']),
        { command: 'reseal', processId: uuid, apply: false, mode: 'reproject', reportName: null,
            acknowledgeDestructive: true, acknowledgeNote: null });
    assert.deepEqual(cli.parseArgs(
        ['--from', uuid, '--apply', '--acknowledge-destructive', '--acknowledge-note', '人工确认']),
        { command: 'reseal', processId: uuid, apply: true, mode: 'reproject', reportName: null,
            acknowledgeDestructive: true, acknowledgeNote: '人工确认' });
    assert.deepEqual(cli.parseArgs(['--mark-stale']), { command: 'mark-stale', reportName: null });
    assert.deepEqual(cli.parseArgs(['--classify', '--old', 'a.json', '--new', 'b.json']),
        { command: 'classify', oldPath: 'a.json', newPath: 'b.json' });
    assert.deepEqual(cli.parseArgs(['--archive-snapshot']), { command: 'archive-snapshot' });
    assert.deepEqual(cli.parseArgs(['--help']), { help: true });
    assert.throws(() => cli.parseArgs([]), /用法：/);
    assert.throws(() => cli.parseArgs(['--from', 'not-a-uuid']), /用法：/);
    assert.throws(() => cli.parseArgs(['--from', uuid, '--mode', 'llm']), /用法：/);
    assert.throws(() => cli.parseArgs(['--mark-stale', '--apply']), /用法：/);
    assert.throws(() => cli.parseArgs(['--classify', '--old', 'a.json']), /用法：/);
    assert.throws(() => cli.parseArgs(['--archive-snapshot', '--apply']), /用法：/);
    assert.throws(() => cli.parseArgs(['--archive-snapshot', '--report', 'a.json']), /用法：/);
    assert.throws(() => cli.parseArgs(['--archive-snapshot', '--from', uuid]), /用法：/);
    assert.throws(() => cli.parseArgs(['--from', uuid, '--report', '../escape.json']), /report/);
    // --acknowledge-destructive 只用于更新标签记录，不能与归档快照、标记旧文件或比较词表同时使用。
    // 指定 --acknowledge-note 时，必须同时指定 --acknowledge-destructive。
    assert.throws(() => cli.parseArgs(['--archive-snapshot', '--acknowledge-destructive']), /用法：/);
    assert.throws(() => cli.parseArgs(['--mark-stale', '--acknowledge-destructive']), /用法：/);
    assert.throws(() => cli.parseArgs(['--classify', '--old', 'a.json', '--new', 'b.json',
        '--acknowledge-destructive']), /用法：/);
    assert.throws(() => cli.parseArgs(['--classify', '--old', 'a.json', '--new', 'b.json',
        '--acknowledge-note', 'x']), /用法：/);
    assert.throws(() => cli.parseArgs(['--from', uuid, '--acknowledge-note', 'x']), /用法：/);
    assert.throws(() => cli.parseArgs(
        ['--from', uuid, '--acknowledge-destructive', '--acknowledge-note', '   ']),
    /acknowledge-note/);
    assert.throws(() => cli.parseArgs(
        ['--from', uuid, '--acknowledge-destructive', '--acknowledge-note', 'x'.repeat(501)]),
    /acknowledge-note/);
    assert.match(cli.USAGE, /不调用模型/);
    assert.match(cli.USAGE, /needsHuman|人工/);
    assert.match(cli.USAGE, /archive-snapshot/);
    assert.match(cli.USAGE, /更新词表前，必须先用 --archive-snapshot 归档当前词表/);
    assert.match(cli.USAGE, /--acknowledge-destructive/);
    assert.match(cli.USAGE, /concept-removed/);
    assert.match(cli.USAGE, /acknowledgementEligible/);
});

// ——— destructive 显式确认通道：--acknowledge-destructive 的规划语义 ———
const REGISTRY_FILE = path.resolve(__dirname, '../config/tag-catalog.json');
const REGISTRY_HISTORY = path.resolve(__dirname, '../config/tag-catalog-history');
const OLD_ALIAS_REMOVAL = path.join(REGISTRY_HISTORY,
    '3f9a14c9d753716b428b8ca27a9d93b92b3ae93cfbffc1a24f60573ff8ef234a.json');
const OLD_SEED = path.join(REGISTRY_HISTORY,
    'dcf83f84857d45d6a36ee20d9235d7566d9a3a53644ab442d8eb64b5e81a9adf.json');

// 为旧词表增加一个当前词表不存在的概念，使更新包含删除概念这一不可确认的破坏性变更。
// loadTagCatalog 只接受 version、facets 和 concepts 字段，因此构造时不加入 registrySha256；
// 注入旧快照时，再提供核验所需的文件字节 SHA。
function registryWithExtraConcept() {
    const next = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    next.concepts.push({
        id: 'task.legacy-only', facet: 'task',
        preferredLabel: { zh: '旧表独有概念', en: 'Legacy Only Concept' },
        aliases: ['LegacyOnly'], broaderId: null,
        definition: '旧表独有、新表已删除的概念。', scopeNote: '仅用于不可确认集合测试。',
        status: 'active', replacedBy: null
    });
    return next;
}
const extraConceptSnapshot = sha => ({ ...registryWithExtraConcept(), registrySha256: sha });

test('明确确认允许的破坏性变更后，可以更新标签阶段记录', () => {
    const plan = reproject({ registrySha256: DESTRUCTIVE_OLD_SHA, projectionSha256: 'e'.repeat(64),
        acknowledgeDestructive: true, acknowledgementNote: '人工确认：仅别名语义，conceptId 影响 none' });
    assert.equal(plan.ok, true, plan.item.errors.join('; '));
    assert.equal(plan.item.status, 'assigned');
    assert.equal(plan.item.outcome, 'resealed');
    assert.equal(plan.item.changeLevel, 'destructive');
    assert.equal(plan.item.needsHuman, false);
    assert.equal(plan.item.pageRestageRequired, true);
    assert.equal(plan.item.destructiveAcknowledgement.acknowledged, true);
    assert.equal(plan.item.destructiveAcknowledgement.conceptIdImpact, 'none');
    assert.match(plan.item.destructiveAcknowledgement.reasonsHash, /^[a-f0-9]{64}$/);
    assert.equal(plan.item.destructiveAcknowledgement.note,
        '人工确认：仅别名语义，conceptId 影响 none');

    const stage = plan.analysis.papers[0].analysisManifest.stages.tagSelection;
    assert.equal(stage.registrySha256, runtime().registrySha256);
    assert.equal(stage.registryUpgradeFrom.changeLevel, 'destructive');
    assert.equal(stage.registryUpgradeFrom.destructiveAcknowledgement.reasonsHash,
        plan.item.destructiveAcknowledgement.reasonsHash);
    // 正文保持不变；更新后的阶段记录仍须通过标签阶段内容及对应关系核验。
    assert.equal(plan.analysis.papers[0].analysis,
        analysisRecord({ registrySha256: DESTRUCTIVE_OLD_SHA }).papers[0].analysis);
    assert.strictEqual(contract.validateTagStageProof(plan.analysis.papers[0], {
        parsed: parseAnalysis(plan.analysis.papers[0].analysis, { tagRules: runtime() }),
        tagRules: runtime()
    }), null);
    // 不给 note → 默认模板必须自带 from/to 字节 SHA。
    const defaulted = reproject({ registrySha256: DESTRUCTIVE_OLD_SHA,
        projectionSha256: 'e'.repeat(64), acknowledgeDestructive: true });
    const ack = defaulted.analysis.papers[0].analysisManifest.stages.tagSelection
        .registryUpgradeFrom.destructiveAcknowledgement;
    assert.ok(ack.note.includes(DESTRUCTIVE_OLD_SHA));
    assert.ok(ack.note.includes(runtime().registrySha256));
});

test('确认参数不能放行白名单外的破坏性变更', () => {
    const sha = 'a'.repeat(64);
    const snapshotOptions = { registryHistory: { [sha]: extraConceptSnapshot(sha) } };
    const plan = reproject({ registrySha256: sha, projectionSha256: 'e'.repeat(64),
        acknowledgeDestructive: true, snapshotOptions });
    assert.equal(plan.ok, false);
    assert.equal(plan.analysis, null);
    assert.equal(plan.item.status, 'blocked');
    assert.equal(plan.item.outcome, 'destructive-change');
    assert.equal(plan.item.needsHuman, true);
    assert.match(plan.item.errors.join(''), /不属于可人工确认的范围/);
    assert.match(plan.item.errors.join(''), /concept-removed/);
    assert.equal(plan.item.destructiveAcknowledgement, undefined);
});

test('未提供确认参数时，允许确认的破坏性变更仍会阻止更新', () => {
    const sha = 'a'.repeat(64);
    const snapshotOptions = { registryHistory: { [sha]: extraConceptSnapshot(sha) } };
    for (const acknowledgeDestructive of [false, undefined]) {
        const plan = reproject({ registrySha256: sha, projectionSha256: 'e'.repeat(64),
            snapshotOptions, acknowledgeDestructive });
        assert.equal(plan.ok, false);
        assert.equal(plan.item.outcome, 'destructive-change');
        assert.equal(plan.item.needsHuman, true);
        // 可确认但没带 flag 时，报告必须提示 flag 的存在与用法。
        const eligible = reproject({ registrySha256: DESTRUCTIVE_OLD_SHA,
            projectionSha256: 'e'.repeat(64), acknowledgeDestructive });
        assert.equal(eligible.item.outcome, 'destructive-change');
        assert.match(eligible.item.errors.join(''), /--acknowledge-destructive/);
    }
});

// 变更等级由新旧词表内容决定，确认参数不会把破坏性变更改为非破坏性变更。
// dcf83f84 到当前词表的更新只有提供有效确认后才可继续。
// 非破坏性变更不能携带确认字段，相关构建器用例见 tag-catalog-change.test.js。
test('确认参数只记录用户确认，不改变词表变更的分类', () => {
    const without = reproject({ registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64) });
    assert.equal(without.item.changeLevel, 'destructive');
    assert.equal(without.item.outcome, 'destructive-change');
    assert.equal(without.item.needsHuman, true);

    const plan = reproject({ registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64),
        acknowledgeDestructive: true, acknowledgementNote: '白名单确认：改名/改边/删别名，conceptId 零影响' });
    assert.equal(plan.ok, true, plan.item.errors.join('; '));
    assert.equal(plan.item.outcome, 'resealed');
    assert.equal(plan.item.changeLevel, 'destructive');
    const stage = plan.analysis.papers[0].analysisManifest.stages.tagSelection;
    assert.equal(stage.registryUpgradeFrom.changeLevel, 'destructive');
    assert.equal(stage.registryUpgradeFrom.destructiveAcknowledgement.acknowledged, true);
});

test('classify 在实际更新前报告本次变更是否允许明确确认', () => {
    const eligible = cli.classifyReport({ oldPath: OLD_ALIAS_REMOVAL, newPath: REGISTRY_FILE });
    assert.equal(eligible.command, 'classify');
    assert.equal(eligible.changeLevel, 'destructive');
    assert.equal(eligible.acknowledgementEligible, true);
    assert.deepEqual(eligible.eligibleReasons,
        ['alias-removed', 'broader-id-changed', 'preferred-label-changed']);
    assert.deepEqual(eligible.ineligibleReasons, []);

    // 换表（v1.1）后 seed→当前 同样为可确认 destructive（旧断言 additive 系换表前口径）。
    const seed = cli.classifyReport({ oldPath: OLD_SEED, newPath: REGISTRY_FILE });
    assert.equal(seed.changeLevel, 'destructive');
    assert.equal(seed.acknowledgementEligible, true);
    assert.deepEqual(seed.eligibleReasons,
        ['alias-removed', 'broader-id-changed', 'preferred-label-changed']);
    assert.deepEqual(seed.ineligibleReasons, []);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-classify-'));
    try {
        const syntheticFile = path.join(root, 'legacy-registry.json');
        fs.writeFileSync(syntheticFile,
            `${JSON.stringify(registryWithExtraConcept(), null, 2)}\n`);
        const ineligible = cli.classifyReport({ oldPath: syntheticFile, newPath: REGISTRY_FILE });
        assert.equal(ineligible.changeLevel, 'destructive');
        assert.equal(ineligible.acknowledgementEligible, false);
        assert.deepEqual(ineligible.ineligibleReasons, ['concept-removed']);
        assert.deepEqual(ineligible.eligibleReasons, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});


test('当前词表的旧 v1 标签记录只读核验，不转换版本或补签', () => {
    const current = runtime();
    const projectionSha256 = crypto.createHash('sha256').update(
        buildTagPromptText(current.tagCatalog, LEGACY_TAG_PROMPT_TEXT_CONTRACT)
    ).digest('hex');
    const analysis = analysisRecord({ projectionContract: LEGACY_TAG_PROMPT_TEXT_CONTRACT,
        projectionSha256 });
    const before = JSON.stringify(analysis);
    const result = reproject({ analysis });
    assert.equal(result.ok, false);
    assert.equal(result.item.outcome, 'already-current');
    assert.equal(result.analysis, null);
    assert.equal(JSON.stringify(analysis), before);
});


test('旧、新标签缓存的注记与重新生成保留各自写入范围', () => {
    for (const inputKey of ['taxonomyValidation', 'tagValidation']) {
        for (const mode of ['annotate', 'reproject']) {
            const original = analysisRecord({ registrySha256: ADDITIVE_OLD_SHA,
                projectionSha256: 'e'.repeat(64) });
            const paper = original.papers[0];
            if (inputKey === 'tagValidation') paper.parsed = Object.fromEntries(
                Object.entries(paper.parsed).map(([key, value]) =>
                    [key === 'taxonomyValidation' ? 'tagValidation' : key, value]));
            // 旧缓存的附加信息和人工评分不能因改名被重新解析结果覆盖。
            paper.parsed.score = '9.1';
            paper.parsed.scoreOverride = { actor: 'reviewer', value: 9.1 };
            paper.parsed[inputKey].errors = ['保留旧缓存说明'];
            paper.parsed[inputKey].valid = false;
            paper.parsed[inputKey].extra = { preserved: true };
            const before = JSON.stringify(original);
            const plan = resealApi.reprojectAnalysis({ analysis: original, runtime: runtime(), mode,
                acknowledgeDestructive: true });
            assert.equal(plan.ok, true, plan.item.errors.join('; '));
            const output = plan.analysis.papers[0];
            const outputKey = mode === 'annotate' ? inputKey : 'tagValidation';
            const expectedParsed = Object.fromEntries(Object.entries(paper.parsed).map(([key, value]) =>
                key === inputKey ? [outputKey, { ...value, registryVersion: runtime().registryVersion,
                    registrySha256: runtime().registrySha256 }] : [key, value]));
            assert.deepEqual(output.parsed, expectedParsed);
            assert.deepEqual(Object.keys(output.parsed), Object.keys(expectedParsed));
            assert.equal(Object.hasOwn(output.parsed, outputKey === 'tagValidation'
                ? 'taxonomyValidation' : 'tagValidation'), false);
            assert.equal(output.analysis, paper.analysis);
            assert.deepEqual(output.analysisStageCheckpoints, mode === 'reproject'
                ? Object.fromEntries(Object.entries(paper.analysisStageCheckpoints).map(([key, value]) =>
                    [key === 'taxonomySeal' ? 'tagSelection' : key, value]))
                : paper.analysisStageCheckpoints);
            assert.equal(JSON.stringify(original), before);
        }
    }
});

test('标签更新只读旧缓存且拒绝混用，不补造缺少的校验结果', () => {
    const current = analysisRecord();
    const before = JSON.stringify(current);
    const already = resealApi.reprojectAnalysis({ analysis: current, runtime: runtime() });
    assert.equal(already.item.outcome, 'already-current');
    assert.equal(already.analysis, null);
    assert.equal(JSON.stringify(current), before);
    for (const value of [current.papers[0].parsed.taxonomyValidation, null, {}]) {
        const mixed = structuredClone(current);
        mixed.papers[0].parsed.tagValidation = value;
        const plan = resealApi.reprojectAnalysis({ analysis: mixed, runtime: runtime() });
        assert.equal(plan.item.status, 'blocked');
        assert.equal(plan.analysis, null);
        assert.match(plan.item.errors.join(';'), /解析结果不能同时包含/);
    }
    for (const cache of [null, {}, { taxonomyValidation: null }, { tagValidation: [] }]) {
        const original = analysisRecord({ registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64) });
        original.papers[0].parsed = cache;
        const plan = resealApi.reprojectAnalysis({ analysis: original, runtime: runtime(),
            acknowledgeDestructive: true });
        assert.equal(plan.ok, true, plan.item.errors.join(';'));
        assert.deepEqual(plan.analysis.papers[0].parsed, cache);
    }
});

test('显式重新生成采用新标签阶段格式，只读和注记保留旧字段及原内容哈希', () => {
    const records = require('../scripts/lib/tag-stage-record.js');
    const old = analysisRecord();
    const bytes = JSON.stringify(old);
    const readOnly = reproject({ analysis: old });
    assert.equal(readOnly.item.outcome, 'already-current');
    assert.equal(JSON.stringify(old), bytes);
    const from = analysisRecord({ registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64) });
    from.papers[0].parsed.manualScoreOverride = { score: 9.1 };
    const original = JSON.stringify(from);
    const annotated = reproject({ analysis: from, mode: 'annotate', acknowledgeDestructive: true });
    assert.equal(annotated.ok, true, annotated.item.errors.join('; '));
    assert.equal(annotated.stage.bindingSha256, from.papers[0].analysisManifest.stages.taxonomySeal.bindingSha256);
    assert.equal(records.readTagStageRecord(annotated.analysis.papers[0].analysisManifest,
        annotated.analysis.papers[0].analysisStageCheckpoints).format, 'legacy');
    const rebuilt = reproject({ analysis: from, acknowledgeDestructive: true });
    assert.equal(rebuilt.ok, true, rebuilt.item.errors.join('; '));
    const paper = rebuilt.analysis.papers[0];
    const record = records.readTagStageRecord(paper.analysisManifest, paper.analysisStageCheckpoints);
    assert.equal(record.format, 'current');
    assert.equal(paper.analysisManifest.contracts.tagSelectionRecord, records.TAG_STAGE_RECORD_CONTRACT);
    assert.equal(Object.hasOwn(paper.analysisManifest.stages, 'taxonomySeal'), false);
    assert.equal(Object.hasOwn(paper.analysisManifest.contracts, 'taxonomy'), false);
    assert.equal(Object.hasOwn(paper.analysisStageCheckpoints, 'taxonomySeal'), false);
    assert.equal(Object.hasOwn(record.stage, 'taxonomySurfaceSha256'), false);
    assert.equal(record.checkpoint, from.papers[0].analysisStageCheckpoints.taxonomySeal);
    assert.equal(paper.analysis, from.papers[0].analysis);
    assert.deepEqual(paper.parsed.manualScoreOverride, { score: 9.1 });
    assert.equal(JSON.stringify(from), original);
    const mixed = structuredClone(from);
    mixed.papers[0].analysisManifest.stages.tagSelection = null;
    const blocked = reproject({ analysis: mixed, acknowledgeDestructive: true });
    assert.equal(blocked.item.status, 'blocked');
    assert.match(blocked.item.errors.join(''), /不能混用新旧格式/);
});

test('重新生成前须拒绝原绑定哈希无效或格式声明错误的标签记录', () => {
    for (const mutate of [
        paper => { paper.analysisManifest.stages.taxonomySeal.bindingSha256 = '0'.repeat(64); },
        paper => { paper.analysisManifest.contracts.taxonomy = 'wrong-selection-contract'; }
    ]) {
        const analysis = analysisRecord({ registrySha256: ADDITIVE_OLD_SHA, projectionSha256: 'e'.repeat(64) });
        mutate(analysis.papers[0]);
        const before = JSON.stringify(analysis);
        const result = reproject({ analysis, acknowledgeDestructive: true });
        assert.equal(result.ok, false);
        assert.equal(result.analysis, null);
        assert.equal(result.item.status, 'blocked');
        assert.equal(result.item.outcome, 'binding-refused');
        assert.match(result.item.errors.join(''), /原标签阶段的绑定签名或合同声明无效/);
        assert.equal(JSON.stringify(analysis), before);
    }
});

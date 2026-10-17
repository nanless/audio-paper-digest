'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const registry = require('../scripts/lib/prompt-text-versions');
const evidence = require('../scripts/lib/prompt-evidence');
const history = require('../scripts/lib/prompt-history');
const deep = require('../scripts/deep-analyzer');
const { validAnalysisText } = require('./valid-analysis-fixture');
const fixture = require('./fixtures/core-table-comparison-prompt.json');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const block = text => text.match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m)[2];
const oldPath = 'prompts/core-summary-repair-v6.md';
const oldSha = '7ec79cf1d922655503ba2cd04564afcc1cd3bb14ad8603a8c9db0afed8c22fb6';
const oldBlob = 'bf06c408a2cb52848690121d73d08405421889e1';

test('核心v7只纠正表格比较的取证说明，保留原首围栏其余字节及输出权限', () => {
    const old = evidence.readPromptEvidenceBytes(oldPath, { expectedSha256: oldSha });
    assert.equal(sha(old), oldSha);
    assert.deepEqual(old, execFileSync('git', ['cat-file', 'blob', oldBlob], { cwd: root }));
    assert.equal(fs.existsSync(path.join(root, oldPath)), false);
    assert.equal(registry.currentPromptTextContract('coreSummaryRepair'), 'analysis-prompt-text-v7');
    assert.equal(registry.promptFilePathForContract('coreSummaryRepair', 'analysis-prompt-text-v6'), oldPath);
    const currentPath = registry.currentTextStagePromptPath('coreSummaryRepair');
    const before = block(old.toString()), after = block(evidence.readPromptEvidenceBytes(currentPath).toString());
    const oldParagraph = before.split('\n\n').find(p => p.startsWith('两个数值及各自单位'));
    const newParagraph = after.split('\n\n').find(p => p.startsWith('两个数值及各自单位'));
    assert.ok(oldParagraph && newParagraph);
    assert.equal(before.replace(oldParagraph, newParagraph), after);
    assert.match(newParagraph, /同一原表中明确可比的记录/);
    assert.match(newParagraph, /不同方法行/);
    assert.match(newParagraph, /除被比较因素外其余评测条件一致/);
    assert.match(newParagraph, /同一指标列/);
    assert.match(newParagraph, /真实行列角色/);
    assert.match(newParagraph, /禁止把不同数据集、评测协议、指标或不连续证据片段拼成同条件比较/);
    assert.match(newParagraph, /无法唯一对应.*不猜测单元格归属/);
    assert.match(after, /320–600/); assert.match(after, /6–9/);
    assert.match(after, /不要修改评分、标签、作者、方法、实验等其他章节/);
    assert.match(after, /不要增删末尾的零、舍入/);
    assert.throws(() => registry.promptFilePathForContract('coreSummaryRepair', 'analysis-prompt-text-v99'), /没有登记/);
    assert.deepEqual(history.promptBytesForSha256('coreSummaryRepair', oldSha), old);
    const templates = fs.readdirSync(path.join(root, 'prompts')).filter(f => f.endsWith('.md') && f !== 'README.md');
    assert.equal(templates.length, 18); assert.equal(registry.CURRENT_PROMPT_FILES.length, 18);
});

test('真实封存同表不同方法行的同指标比较不应被Prompt错误限制为同行', () => {
    assert.equal(sha(fixture.sourceExcerpt), fixture.sourceExcerptSha256);
    const table = fixture.table;
    const teacher = table.matrix.findIndex(row => row[0] === 'MixIT teacher');
    const method = table.matrix.findIndex(row => row[0].startsWith('SNOAR(MixIT)'));
    const column = table.matrix[0].indexOf('SI-SDR');
    assert.notEqual(teacher, method);
    assert.deepEqual([table.matrix[teacher][column], table.matrix[method][column]], ['8.32', '13.25']);
    for (const row of [teacher, method]) {
        const cell = table.cells.find(c => c.row === row && c.column === column);
        assert.equal(cell.text, table.matrix[row][column]);
        assert.match(cell.sourceDomSha256, /^[a-f0-9]{64}$/);
    }
    assert.match(table.caption, /WHAM! tt set/);
    assert.ok(fixture.sourceExcerpt.includes('MixIT teacher\n8.32'));
    assert.ok(fixture.sourceExcerpt.includes('SNOAR(MixIT)'));
    // The fixture preserves the original raw duplicated TeX/visible cells;
    // this Prompt change neither repairs them nor issues source qualification.
    assert.equal(table.matrix[teacher][4], '15.315.3');
});

test('已完成core6按原Prompt冷复算，原阶段与检查点逐字不变，新任务才选core7', () => {
    const analysis = validAnalysisText(), source = 'Original source evidence for core stage binding.';
    const stage = 'coreSummaryRepair';
    const context = deep.buildStageEvidenceContext(stage, analysis, source);
    const fingerprint = deep.buildTextStageFingerprint(stage, analysis, context, 'analysis-prompt-text-v6');
    const paper = { analysisCheckpoint: analysis, analysisStageCheckpoints: { [stage]: analysis } };
    const manifest = { version: 1, stages: { [stage]: { status: 'complete', fingerprint,
        promptTextContract: 'analysis-prompt-text-v6' } } };
    const original = JSON.stringify({ paper, manifest });
    const recovered = deep.prepareTextRecoveryStage(paper, manifest, stage, analysis, source);
    assert.equal(recovered.fingerprint, fingerprint);
    assert.equal(recovered.promptTextContract, 'analysis-prompt-text-v6');
    assert.equal(JSON.stringify({ paper, manifest }), original);
    const current = deep.prepareTextRecoveryStage({ analysisCheckpoint: analysis }, { version: 1, stages: {} }, stage, analysis, source);
    assert.equal(current.promptTextContract, 'analysis-prompt-text-v7');
    assert.notEqual(current.fingerprint, fingerprint);
});

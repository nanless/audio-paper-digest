'use strict';

// 换表前封口盘点（scripts/taxonomy-seal-inventory.js）的只读分组测试：
// 用 tmp fixture 跑真实 CLI，断言按 registrySha256 分组、状态计数、
// 与当前 config SHA 的差集、示例 paperId，以及运行前后 fixture 字节不变。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'taxonomy-seal-inventory.js');
const SHA_RE = /^[a-f0-9]{64}$/;

const CURRENT = crypto.createHash('sha256').update('current-registry-bytes').digest('hex');
const STALE_ONE = crypto.createHash('sha256').update('stale-registry-one').digest('hex');
const STALE_TWO = crypto.createHash('sha256').update('stale-registry-two').digest('hex');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

function seal(status, registrySha256) {
    return { status, registrySha256, projectionContract: 'paper-taxonomy-prompt-projection-v1' };
}

function fixture(root) {
    const executions = path.join(root, 'executions');
    writeJson(path.join(executions, 'aaaaaaaa-0000-4000-8000-000000000001', 'analysis.json'), {
        paperId: 'conference:demo:2026:conference-paper-id:one',
        papers: [{ id: 'one', analysisManifest: { stages: { taxonomySeal: seal('complete', CURRENT) } } }]
    });
    writeJson(path.join(executions, 'aaaaaaaa-0000-4000-8000-000000000002', 'analysis.json'), {
        paperId: 'conference:demo:2026:conference-paper-id:two',
        papers: [
            { id: 'two', analysisManifest: { stages: { taxonomySeal: seal('complete', STALE_ONE) } } },
            { id: 'three', analysisManifest: { stages: { taxonomySeal: seal('not_needed', CURRENT) } } }
        ]
    });
    // 有执行目录但没有可解析的 seal
    writeJson(path.join(executions, 'aaaaaaaa-0000-4000-8000-000000000003', 'analysis.json'), {
        paperId: 'conference:demo:2026:conference-paper-id:three',
        papers: [{ id: 'four', analysisManifest: { stages: {} } }]
    });
    // 只有顶层 stages.taxonomySeal（逐篇缺失时的回落路径）
    writeJson(path.join(executions, 'aaaaaaaa-0000-4000-8000-000000000004', 'analysis.json'), {
        paperId: 'conference:demo:2026:conference-paper-id:four',
        stages: { taxonomySeal: seal('complete', CURRENT) }
    });
    fs.mkdirSync(path.join(executions, 'aaaaaaaa-0000-4000-8000-000000000005'), { recursive: true });

    const deepFile = path.join(root, 'deep-analysis-result.json');
    writeJson(deepFile, {
        papers: [{ id: '2609.00001',
            analysisManifest: { stages: { taxonomySeal: seal('complete', STALE_ONE) } } }]
    });

    const assignments = path.join(root, 'historical-taxonomy-assignments');
    // SHA 只在文件名里（正文也带，正文优先）
    writeJson(path.join(assignments, 'bbbbbbbb-0000-4000-8000-000000000001',
        `arxiv-2609.00001.taxonomy.${STALE_TWO}.json`),
    { registrySha256: STALE_TWO, paperId: 'arxiv:2609.00001', status: 'assigned' });
    // 文件名不带 SHA，正文带
    writeJson(path.join(assignments, 'bbbbbbbb-0000-4000-8000-000000000002',
        'arxiv-2512.00002.taxonomy.json'),
    { registrySha256: CURRENT, paperId: 'arxiv:2512.00002', status: 'blocked' });

    const registryFile = path.join(root, 'paper-taxonomy.json');
    fs.writeFileSync(registryFile, 'current-registry-bytes');
    return { executions, deepFile, assignments, registryFile };
}

function snapshot(root) {
    const entries = [];
    const walk = directory => {
        for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(directory, item.name);
            if (item.isDirectory()) walk(full);
            else entries.push(`${path.relative(root, full)}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
        }
    };
    walk(root);
    return entries.join('\n');
}

function runCli(args) {
    const env = { ...process.env };
    delete env.CODEX_SANDBOX;
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, cwd: ROOT });
}

test('盘点脚本按 registrySha256 分组并给出与当前 SHA 的差集', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-inventory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = fixture(root);
    const before = snapshot(root);

    const result = runCli(['--json', '--executions', paths.executions, '--deep', paths.deepFile,
        '--assignments', paths.assignments, '--registry', paths.registryFile]);
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(result.stdout);
    assert.equal(result.stderr.includes('CODEX_SANDBOX'), false);

    assert.equal(inventory.contract, 'paper-taxonomy-seal-inventory-v1');
    assert.equal(inventory.readOnly, true);
    assert.equal(inventory.currentRegistrySha256, CURRENT);
    assert.match(inventory.currentRegistrySha256, SHA_RE);

    // 来源计数：4 个有 seal 的执行 + 1 个无 seal 执行 + 1 个空目录
    const executions = inventory.sources['conference-analysis-executions'];
    assert.equal(executions.directories, 5);
    assert.equal(executions.files, 4);
    assert.equal(executions.seals, 4);
    assert.equal(executions.withoutSeal, 2);
    assert.equal(executions.unreadable, 0);
    assert.equal(inventory.sources['deep-analysis-result'].seals, 1);
    assert.equal(inventory.sources['historical-taxonomy-assignments'].seals, 2);
    assert.equal(inventory.totals.seals, 7);
    assert.equal(inventory.totals.sealsWithoutSha, 0);
    assert.equal(inventory.totals.unreadable, 0);

    const bySha = Object.fromEntries(inventory.groups.map(group => [group.registrySha256, group]));
    assert.equal(inventory.groups.length, 3);
    // 当前 SHA：2 次会议执行 seal + 1 顶层 seal + 1 条历史指派 = 4
    assert.equal(bySha[CURRENT].seals, 4);
    assert.equal(bySha[CURRENT].matchesCurrent, true);
    assert.deepEqual(bySha[CURRENT].statuses, { complete: 2, not_needed: 1, blocked: 1 });
    assert.deepEqual(bySha[CURRENT].bySource,
        { 'conference-analysis-executions': 3, 'historical-taxonomy-assignments': 1 });
    assert.ok(bySha[CURRENT].samplePaperIds.includes('conference:demo:2026:conference-paper-id:one'));
    assert.ok(bySha[CURRENT].samplePaperIds.length <= 3);
    // 非当前 SHA：会议执行 + 深度分析共 2 条，历史指派 1 条
    assert.equal(bySha[STALE_ONE].seals, 2);
    assert.equal(bySha[STALE_ONE].matchesCurrent, false);
    assert.deepEqual(bySha[STALE_ONE].bySource,
        { 'conference-analysis-executions': 1, 'deep-analysis-result': 1 });
    assert.equal(bySha[STALE_ONE].samplePaperIds[0], 'conference:demo:2026:conference-paper-id:two');
    assert.equal(bySha[STALE_TWO].seals, 1);
    assert.deepEqual(bySha[STALE_TWO].samplePaperIds, ['arxiv:2609.00001']);

    assert.deepEqual(inventory.diff, {
        currentRegistrySha256: CURRENT,
        currentSeals: 4,
        currentPresent: true,
        staleSeals: 3,
        staleRegistrySha256: [
            { registrySha256: STALE_ONE, seals: 2, matchesCurrent: false,
                bySource: { 'conference-analysis-executions': 1, 'deep-analysis-result': 1 } },
            { registrySha256: STALE_TWO, seals: 1, matchesCurrent: false,
                bySource: { 'historical-taxonomy-assignments': 1 } }
        ],
        sealsWithoutSha: 0,
        inSyncRatio: 0.5714
    });

    // 只读：fixture 的每一字节都没变
    assert.equal(snapshot(root), before);
});

test('人类可读输出、退出码与参数校验', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-inventory-human-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = fixture(root);
    const result = runCli(['--executions', paths.executions, '--deep', paths.deepFile,
        '--assignments', paths.assignments, '--registry', paths.registryFile]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /分类法封口盘点（只读） paper-taxonomy-seal-inventory-v1/);
    assert.match(result.stdout, new RegExp(`当前 config SHA: ${CURRENT}`));
    assert.match(result.stdout, /\[当前\] 封口 4/);
    assert.match(result.stdout, new RegExp(`\\[非当前\\] 封口 2`));
    assert.match(result.stdout, /示例 paperId: arxiv:2609\.00001/);
    assert.match(result.stdout, /换表前须按非当前封口逐组决定 reseal \/ 重分析/);

    const unknown = runCli(['--nope']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /taxonomy:seal-inventory/);

    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /只读/);
});

test('缺失扫描路径按空集合处理而不是崩溃', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-inventory-empty-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const registryFile = path.join(root, 'paper-taxonomy.json');
    fs.writeFileSync(registryFile, 'current-registry-bytes');
    const result = runCli(['--json', '--executions', path.join(root, 'none-executions'),
        '--deep', path.join(root, 'none-deep.json'),
        '--assignments', path.join(root, 'none-assignments'), '--registry', registryFile]);
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(result.stdout);
    assert.equal(inventory.totals.seals, 0);
    assert.equal(inventory.groups.length, 0);
    assert.equal(inventory.diff.currentPresent, false);
    assert.equal(inventory.sources['conference-analysis-executions'].missing, true);
    assert.equal(inventory.sources['deep-analysis-result'].missing, true);
});

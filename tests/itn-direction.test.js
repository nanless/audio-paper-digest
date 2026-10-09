
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const catalog = require('../scripts/lib/tag-catalog.js');
const rules = require('../scripts/lib/tag-rules.js');
const change = require('../scripts/lib/tag-catalog-change.js');
const root = path.resolve(__dirname, '..');
const oldPath = path.join(root, 'config/tag-catalog-history/85ed9e5a7cde6f58c3cb97b10d61401641dd2e39592680d2c343137bc7669d3a.json');
const currentPath = path.join(root, 'config/tag-catalog.json');
const old = catalog.loadTagCatalog(oldPath);
const current = catalog.loadTagCatalog(currentPath);
const id = 'task.inverse-text-normalization';

test('ITN 正式分析输入说明口语识别输出到书面形式，并排除反向 TN', () => {
    const utils = require('../scripts/utils.js');
    const versions = require('../scripts/lib/prompt-text-versions.js');
    const prompt = utils.loadPrompt(versions.currentTextStagePromptPath('primaryAnalysis'), {
        hasFullText: '本地来源', title: 'Inverse text normalization', authors: 'Local Author',
        categories: 'cs.CL', arxivId: '2610.12345',
        textForAnalysis: 'ASR output twenty three becomes written 23.',
        tagPromptText: rules.buildTagPromptText(current)
    });
    const line = prompt.split('\n').find(line => line.startsWith(id + '|'));
    assert.ok(line, '真实模板必须包含标签概念定义');
    assert.match(line, /口语形式转换为.*书面形式/);
    assert.match(line, /书面文本转为可朗读形式属于文本规范化（TN），不归入/);
    assert.doesNotMatch(line, /把数字、日期与符号转写为可朗读形式/);
});

test('原词表档案 SHA 精确对应原字节；本次只修改 ITN 两个语义字段', () => {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(oldPath)).digest('hex'), old.registrySha256);
    const before = JSON.parse(fs.readFileSync(oldPath));
    const after = JSON.parse(fs.readFileSync(currentPath));
    const term = after.concepts.find(concept => concept.id === id);
    const prior = before.concepts.find(concept => concept.id === id);
    assert.notEqual(term.definition, prior.definition);
    assert.notEqual(term.scopeNote, prior.scopeNote);
    term.definition = prior.definition;
    term.scopeNote = prior.scopeNote;
    assert.deepEqual(after, before, '版本、顺序、所有标签及其 URL 标识保持不变');
});

function fingerprint(registryPath) {
    // 每个独立进程只替换词表来源，不绕过阶段指纹计算或发起模型请求。
    const script = `const rules=require('./scripts/lib/tag-rules.js');
      rules.getDefaultTagRules=()=>rules.createTagRules({registryPath:process.argv[1]});
      const deep=require('./scripts/deep-analyzer.js');
      const out={primaryAnalysis:deep.buildRecoveryFingerprints({title:'ITN',authors:['Local'],categories:['cs.CL']},'spoken twenty three','2610.12345').primaryAnalysis};
      for(const stage of ['revision','structureRepair','tagSelection','methodRepair']) out[stage]=deep.buildTextStageFingerprint(stage,'same analysis','same evidence');
      console.log('FINGERPRINT_RESULT='+JSON.stringify(out));`;
    const output = execFileSync(process.execPath, ['-e', script, registryPath], { cwd: root, encoding: 'utf8' });
    return JSON.parse(output.split('FINGERPRINT_RESULT=')[1].split('\n')[0]);
}

test('使用词表的实际分析阶段，会因词表变化更新主分析、修订、结构修复与标签选择的指纹', () => {
    const before = fingerprint(oldPath);
    const after = fingerprint(currentPath);
    for (const stage of ['primaryAnalysis','revision','structureRepair','tagSelection']) assert.notEqual(before[stage], after[stage], stage);
    assert.equal(before.methodRepair, after.methodRepair, '无标签依赖的相同方法修复输入不主动失效');
});

test('旧标签概念兼容需原快照与合法注记，缺一仍拒绝', () => {
    const { changeLevel, detail } = change.classifyRegistryChange(old, current);
    assert.equal(changeLevel, 'additive');
    const annotation = change.buildRegistryUpgradeAnnotation({ from: old, to: current, changeLevel, detail, note: '仅纠正 ITN 方向，保留既有概念选择' });
    const args = { fromRegistrySha256: old.registrySha256, fromRegistryVersion: old.version,
        currentRegistry: current, currentRegistrySha256: current.registrySha256,
        conceptIds: [id, 'method.transformer'], snapshotOptions: { registryHistory: new Map([[old.registrySha256, old]]) } };
    assert.equal(change.validateTagCatalogUpgrade({ ...args, annotation }).ok, true);
    assert.equal(change.validateTagCatalogUpgrade(args).ok, false);
    assert.equal(change.validateTagCatalogUpgrade({ ...args, annotation, snapshotOptions: { registryHistory: new Map(), historyDir: path.join(root, 'tests/no-such-history') } }).ok, false);
    const wrong = { ...annotation, fromRegistrySha256: '0'.repeat(64) };
    assert.equal(change.validateTagCatalogUpgrade({ ...args, annotation: wrong }).ok, false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadTaxonomy, validateTaxonomy, resolveLabel, ancestors, pruneAncestors } = require('../scripts/lib/paper-taxonomy.js');
const registryPath = path.join(__dirname, '../config/paper-taxonomy.json');
const raw = () => JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const concept = (r, id) => r.concepts.find(c => c.id === id);

test('v1 registry is a complete nine-facet, bounded, defined vocabulary', () => {
    const r = loadTaxonomy(registryPath);
    assert.equal(r.version, 'paper-taxonomy-v1');
    assert.equal(r.facets.length, 9);
    assert.ok(r.concepts.length >= 150 && r.concepts.length <= 220);
    assert.equal(r.registrySha256, crypto.createHash('sha256').update(fs.readFileSync(registryPath)).digest('hex'));
    assert.equal(validateTaxonomy(raw()).version, r.version);
});

test('normalization is NFKC + one hash + trim + ASCII lower, no fuzzy guessing', () => {
    const r = raw();
    assert.equal(resolveLabel(r, '  ＃ ＡＳＲ  ').id, 'task.asr');
    assert.equal(resolveLabel(r, 'automatic speech recognition').id, 'task.asr');
    assert.equal(resolveLabel(r, 'ASR', null).id, 'task.asr');
    assert.equal(resolveLabel(r, '##ASR'), null);
    assert.equal(resolveLabel(r, 'ASR-like'), null);
    assert.equal(resolveLabel(r, '__proto__'), null);
    assert.equal(resolveLabel(r, null), null);
    assert.equal(resolveLabel(r, ''), null);
});

test('nearby concepts must not be silently interchanged', () => {
    const r = raw();
    for (const [label, id] of [
        ['参数高效微调', 'method.peft'], ['LoRA', 'method.lora'], ['Adapter', 'method.adapter'],
        ['数据增强', 'method.augmentation'], ['预训练', 'setting.pretraining'],
        ['speaker identification', 'task.speaker-identification'], ['speaker verification', 'task.speaker-verification'],
        ['说话人日志', 'task.diarization'], ['语音合成', 'task.speech-synthesis'], ['TTS', 'task.tts'],
        ['流式处理', 'setting.streaming'], ['实时处理', 'setting.real-time'],
    ]) assert.equal(resolveLabel(r, label).id, id);
    for (const label of ['说话人分离', '在线', '离线', '未说明', '蛋白质工程', '医学图像重建']) assert.equal(resolveLabel(r, label), null);
});

test('scientific topics and neural input do not get coerced into engineering ASR', () => {
    const r = raw();
    for (const label of ['发声与构音', '言语感知', '韵律', '听觉与音乐认知', '语言习得', '言语障碍', '社会语音学']) {
        assert.equal(resolveLabel(r, label).facet, 'scientific_topic');
        assert.equal(resolveLabel(r, label, 'task'), null);
    }
    assert.equal(resolveLabel(r, '言语神经解码').id, 'task.neural-speech-decoding');
    assert.equal(resolveLabel(r, '脑信号').facet, 'signal');
});

test('ancestry and pruning preserve leaf order and unrelated branches', () => {
    const r = raw();
    assert.deepEqual(ancestors(r, 'task.av-asr'), ['task.asr']);
    // Music tasks may operate on symbols/scores, not only audio waveforms.
    assert.deepEqual(ancestors(r, 'task.music-generation'), []);
    assert.deepEqual(ancestors(r, 'task.music-retrieval'), []);
    assert.deepEqual(ancestors(r, 'task.av-speech-separation'), ['task.av-source-separation', 'task.audio-separation']);
    assert.deepEqual(pruneAncestors(r, ['method.peft', 'method.lora', 'setting.streaming', 'method.adapter', 'method.lora']),
        ['method.lora', 'setting.streaming', 'method.adapter', 'method.lora']);
    assert.deepEqual(pruneAncestors(r, []), []);
    assert.throws(() => ancestors(r, 'task.missing'), /Unknown/);
    assert.throws(() => pruneAncestors(r, ['task.missing']), /Unknown/);
    assert.throws(() => pruneAncestors(r, 'task.asr'), /array/);
});

test('cross-facet ambiguity returns null until the facet is supplied', () => {
    const r = raw();
    concept(r, 'method.transformer').aliases.push('shared-test-label');
    concept(r, 'task.asr').aliases.push('shared-test-label');
    validateTaxonomy(r);
    assert.equal(resolveLabel(r, 'shared-test-label'), null);
    assert.equal(resolveLabel(r, 'shared-test-label', 'task').id, 'task.asr');
    assert.throws(() => resolveLabel(r, 'ASR', 'unknown'), /Unknown facet/);
});

test('no Unicode-wide casefold is applied', () => {
    const r = raw();
    concept(r, 'method.transformer').aliases.push('Straße');
    assert.equal(resolveLabel(r, 'straße').id, 'method.transformer');
    assert.equal(resolveLabel(r, 'STRASSE'), null);
});

for (const [name, mutate] of [
    ['unknown version', r => { r.version = 'latest'; }],
    ['missing facet', r => { r.facets.pop(); }],
    ['duplicate facet', r => { r.facets[1] = r.facets[0]; }],
    ['duplicate concept ID', r => { r.concepts.push(structuredClone(r.concepts[0])); }],
    ['ID prefix mismatch', r => { r.concepts[0].id = 'method.asr'; }],
    ['unexpected schema field', r => { r.surprise = true; }],
    ['unexpected concept field', r => { r.concepts[0].extra = true; }],
    ['empty definition', r => { r.concepts[0].definition = ''; }],
    ['control in label', r => { r.concepts[0].preferredLabel.zh = 'ASR\n'; }],
    ['bad aliases type', r => { r.concepts[0].aliases = 'ASR'; }],
    ['empty normalized alias', r => { r.concepts[0].aliases.push('#'); }],
    ['duplicate normalized alias', r => { r.concepts[0].aliases.push('ａｓｒ'); }],
    ['same-facet label collision', r => { r.concepts[1].aliases.push('ASR'); }],
    ['missing parent', r => { r.concepts[0].broaderId = 'task.missing'; }],
    ['cross-facet parent', r => { r.concepts[0].broaderId = 'method.peft'; }],
    ['self cycle', r => { r.concepts[0].broaderId = r.concepts[0].id; }],
    ['long cycle', r => { concept(r, 'task.asr').broaderId = 'task.av-asr'; }],
    ['active replacement', r => { r.concepts[0].replacedBy = 'task.tts'; }],
    ['deprecated missing replacement', r => { r.concepts[0].status = 'deprecated'; }],
    ['deprecated self replacement', r => { Object.assign(r.concepts[0], { status: 'deprecated', replacedBy: r.concepts[0].id }); }],
    ['deprecated cross-facet replacement', r => { Object.assign(r.concepts[0], { status: 'deprecated', replacedBy: 'method.peft' }); }],
]) test(`reject ${name}`, () => { const r = raw(); mutate(r); assert.throws(() => validateTaxonomy(r)); });

test('deprecated entries stay explicit and require an active same-facet replacement', () => {
    const r = raw();
    const old = structuredClone(concept(r, 'method.peft'));
    Object.assign(old, { id: 'method.old-peft', preferredLabel: { zh: '旧适配名称', en: 'Old adaptation label' }, aliases: [], status: 'deprecated', replacedBy: 'method.peft' });
    r.concepts.push(old);
    assert.equal(resolveLabel(r, '旧适配名称').status, 'deprecated');
    concept(r, 'method.lora').broaderId = old.id;
    assert.throws(() => validateTaxonomy(r), /active/);
});

test('raw JSON duplicate keys, malformed JSON, and invalid loaded metadata fail closed', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-invalid-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const p = path.join(dir, 'registry.json');
    fs.writeFileSync(p, '{"version":"bad","version":"paper-taxonomy-v1","facets":[],"concepts":[]}');
    assert.throws(() => loadTaxonomy(p), /Duplicate JSON key/);
    fs.writeFileSync(p, '{"version":"bad","\\u0076ersion":"paper-taxonomy-v1","facets":[],"concepts":[]}');
    assert.throws(() => loadTaxonomy(p), /Duplicate JSON key/);
    fs.writeFileSync(p, '{');
    assert.throws(() => loadTaxonomy(p));
    const r = loadTaxonomy(registryPath);
    r.registrySha256 = 'false';
    assert.throws(() => resolveLabel(r, 'ASR'), /registrySha256/);
    assert.throws(() => validateTaxonomy(Object.assign(Object.create({ polluted: true }), raw())), /plain object/);
});

test('load reads each file revision without stale global cache', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-cache-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const p = path.join(dir, 'registry.json');
    const r = raw();
    fs.writeFileSync(p, JSON.stringify(r));
    const first = loadTaxonomy(p);
    r.concepts[0].scopeNote += ' 测试修订。';
    fs.writeFileSync(p, JSON.stringify(r));
    const second = loadTaxonomy(p);
    assert.notEqual(first.registrySha256, second.registrySha256);
    assert.notEqual(first.concepts[0].scopeNote, second.concepts[0].scopeNote);
    assert.equal(resolveLabel(first, 'ASR').id, 'task.asr');
});

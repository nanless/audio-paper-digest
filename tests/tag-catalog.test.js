'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadTagCatalog, validateTagCatalog, resolveLabel, ancestors, pruneAncestors } = require('../scripts/lib/tag-catalog.js');
const registryPath = path.join(__dirname, '../config/tag-catalog.json');
const raw = () => JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const concept = (r, id) => r.concepts.find(c => c.id === id);

test('当前词表包含全部九个 facet 和已定义的概念', () => {
    const r = loadTagCatalog(registryPath);
    assert.equal(r.version, 'paper-tag-catalog-v2');
    assert.equal(r.facets.length, 9);
    // v1.1 换表（2026-09-30）：262 概念（+34 缺口词），上界随词表增长放宽至 280。
    assert.ok(r.concepts.length >= 150 && r.concepts.length <= 280);
    assert.equal(r.registrySha256, crypto.createHash('sha256').update(fs.readFileSync(registryPath)).digest('hex'));
    assert.equal(validateTagCatalog(raw()).version, r.version);
});

test('归一化只做 NFKC、去掉一个 #、去首尾空白和 ASCII 小写，不做模糊匹配', () => {
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

test('相邻概念不能被悄悄互换', () => {
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

test('科学主题和神经输入不会被硬塞进工程 ASR', () => {
    const r = raw();
    for (const label of ['发声与构音', '言语感知', '韵律', '听觉与音乐认知', '语言习得', '言语障碍', '社会语音学']) {
        assert.equal(resolveLabel(r, label).facet, 'scientific_topic');
        assert.equal(resolveLabel(r, label, 'task'), null);
    }
    assert.equal(resolveLabel(r, '言语神经解码').id, 'task.neural-speech-decoding');
    assert.equal(resolveLabel(r, '脑信号').facet, 'signal');
});

test('祖先链和剪枝保留叶节点顺序与不相干分支', () => {
    const r = raw();
    assert.deepEqual(ancestors(r, 'task.av-asr'), ['task.asr']);
    // 音乐类任务处理的可能是符号或乐谱，不只是音频波形。
    assert.deepEqual(ancestors(r, 'task.music-generation'), []);
    assert.deepEqual(ancestors(r, 'task.music-retrieval'), []);
    assert.deepEqual(ancestors(r, 'task.av-speech-separation'), ['task.av-source-separation', 'task.audio-separation']);
    assert.deepEqual(pruneAncestors(r, ['method.peft', 'method.lora', 'setting.streaming', 'method.adapter', 'method.lora']),
        ['method.lora', 'setting.streaming', 'method.adapter', 'method.lora']);
    assert.deepEqual(pruneAncestors(r, []), []);
    assert.throws(() => ancestors(r, 'task.missing'), /未知的概念 ID/);
    assert.throws(() => pruneAncestors(r, ['task.missing']), /未知的概念 ID/);
    assert.throws(() => pruneAncestors(r, 'task.asr'), /字符串数组/);
});

test('裸的端到端只归 setting，显式带学习字样的标签才解析到 method', () => {
    const r = raw();
    assert.equal(resolveLabel(r, '#端到端').id, 'setting.end-to-end');
    assert.equal(resolveLabel(r, '#端到端', 'method'), null);
    assert.equal(resolveLabel(r, '#端到端', 'setting').id, 'setting.end-to-end');
    assert.equal(resolveLabel(r, '#端到端训练', 'method').id, 'method.end-to-end-learning');
    concept(r, 'method.transformer').aliases.push('shared-test-label');
    concept(r, 'task.asr').aliases.push('shared-test-label');
    validateTagCatalog(r);
    assert.equal(resolveLabel(r, 'shared-test-label'), null);
    assert.equal(resolveLabel(r, 'shared-test-label', 'task').id, 'task.asr');
    assert.throws(() => resolveLabel(r, 'ASR', 'unknown'), /未知的分类维度/);
});

test('不做 Unicode 全量大小写折叠', () => {
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
]) test(`拒绝 ${name}`, () => { const r = raw(); mutate(r); assert.throws(() => validateTagCatalog(r)); });

test('已弃用条目必须显式标注，并要求同一 facet 内有启用中的替代项', () => {
    const r = raw();
    const old = structuredClone(concept(r, 'method.peft'));
    Object.assign(old, { id: 'method.old-peft', preferredLabel: { zh: '旧适配名称', en: 'Old adaptation label' }, aliases: [], status: 'deprecated', replacedBy: 'method.peft' });
    r.concepts.push(old);
    assert.equal(resolveLabel(r, '旧适配名称').status, 'deprecated');
    concept(r, 'method.lora').broaderId = old.id;
    assert.throws(() => validateTagCatalog(r), /概念 method\.lora 的上级概念必须存在、已启用，并属于同一分类维度。/);
});

test('原始 JSON 重复键、JSON 格式错误和加载的元数据不合法都直接失败', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-invalid-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const p = path.join(dir, 'registry.json');
    fs.writeFileSync(p, '{"version":"bad","version":"paper-taxonomy-v1","facets":[],"concepts":[]}');
    assert.throws(() => loadTagCatalog(p), /JSON 中出现重复字段/);
    fs.writeFileSync(p, '{"version":"bad","\\u0076ersion":"paper-taxonomy-v1","facets":[],"concepts":[]}');
    assert.throws(() => loadTagCatalog(p), /JSON 中出现重复字段/);
    fs.writeFileSync(p, '{');
    assert.throws(() => loadTagCatalog(p));
    const r = loadTagCatalog(registryPath);
    r.registrySha256 = 'false';
    assert.throws(() => resolveLabel(r, 'ASR'), /registrySha256/);
    assert.throws(() => validateTagCatalog(Object.assign(Object.create({ polluted: true }), raw())), /标签词表 必须是普通对象。/);
});

test('加载每次都读文件的最新版本，不缓存旧结果', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-cache-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const p = path.join(dir, 'registry.json');
    const r = raw();
    fs.writeFileSync(p, JSON.stringify(r));
    const first = loadTagCatalog(p);
    r.concepts[0].scopeNote += ' 测试修订。';
    fs.writeFileSync(p, JSON.stringify(r));
    const second = loadTagCatalog(p);
    assert.notEqual(first.registrySha256, second.registrySha256);
    assert.notEqual(first.concepts[0].scopeNote, second.concepts[0].scopeNote);
    assert.equal(resolveLabel(first, 'ASR').id, 'task.asr');
});


test('默认加载要求当前词表，显式加载旧版词表时保留它的字节 SHA', () => {
    const config = require('../scripts/config.js');
    const previousPath = config.FILES.tagCatalogFile;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-catalog-version-'));
    const target = path.join(directory, 'legacy.json');
    const legacy = { ...raw(), version: 'paper-taxonomy-v1' };
    const bytes = Buffer.from(JSON.stringify(legacy));
    fs.writeFileSync(target, bytes);
    try {
        const loaded = loadTagCatalog(target);
        assert.equal(loaded.version, 'paper-taxonomy-v1');
        assert.equal(loaded.registrySha256, crypto.createHash('sha256').update(bytes).digest('hex'));
        config.FILES.tagCatalogFile = target;
        assert.throws(() => loadTagCatalog(), /当前标签词表必须使用 paper-tag-catalog-v2/);
        assert.throws(() => require('../scripts/lib/tag-rules.js').createTagRules(),
            /当前标签词表必须使用 paper-tag-catalog-v2/);
        for (const version of [null, '', 'paper-tag-catalog-v3', 2, [], {}]) {
            assert.throws(() => validateTagCatalog({ ...legacy, version }), /版本不受支持/);
        }
    } finally {
        config.FILES.tagCatalogFile = previousPath;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { createCodec, canonical, readCatalogs } = require('../scripts/lib/protocol-codec');

const catalogs = [{ protocols: [{ name: 'example-record', currentVariant: 'source-bound',
    currentSchema: { fields: ['paperId', 'sourceSha256'], count: 12, text: '论文来源' },
    historical: [{ tag: 'example-record-v1', variant: 'unbound', header: { contract: 'example-record-v1', version: 1 } },
        { tag: 'example-record-v2', variant: 'source-bound', header: { contract: 'example-record-v2', version: 2 } }] }] }];

test('新记录使用稳定名称，历史格式只按完整登记识别，不更改原对象', () => {
    const codec = createCodec(catalogs);
    const old = { contract: 'example-record-v1', version: 1, paperId: 'old' };
    const before = JSON.stringify(old);
    assert.equal(codec.format(old.contract, 'example-record'), 'unbound');
    assert.equal(codec.isContract(old.contract, 'example-record', 'source-bound'), false);
    assert.equal(codec.identityDomain(old.contract, 'example-record'), old.contract);
    assert.deepEqual(codec.recordHeader(old.contract, 'example-record'), { contract: old.contract, version: 1 });
    assert.equal(JSON.stringify(old), before);
    const current = codec.record('example-record', { paperId: 'new' });
    assert.equal(current.contract, 'example-record');
    assert.match(current.schemaFingerprint, /^[a-f0-9]{64}$/);
    assert.equal('version' in current, false);
    assert.equal(codec.format(current.contract, 'example-record'), 'source-bound');
    assert.deepEqual(codec.recordHeader(current.contract, 'example-record'), { contract: current.contract, schemaFingerprint: current.schemaFingerprint });
});

test('未知、近似和跨族标签拒绝；调用方不能改写登记或覆盖新头字段', () => {
    const codec = createCodec(catalogs);
    for (const raw of ['example-record-v3', 'example-record-v02', ' example-record', null, { contract: 'example-record' }]) {
        assert.equal(codec.isContract(raw, 'example-record'), false);
        assert.throws(() => codec.format(raw, 'example-record'));
    }
    assert.throws(() => codec.isContract('example-record', 'unknown'));
    for (const field of ['contract', 'schemaFingerprint', 'version', 'schemaVersion', 'policyVersion']) assert.throws(() => codec.record('example-record', { [field]: 'forged' }));
    const header = codec.recordHeader('example-record-v2', 'example-record');
    header.version = 99;
    assert.equal(codec.recordHeader('example-record-v2', 'example-record').version, 2);
    assert.throws(() => createCodec([...catalogs, ...catalogs]));
    const changed = JSON.parse(JSON.stringify(catalogs));
    changed[0].protocols[0].currentSchema.fields.push('authors');
    assert.notEqual(codec.schemaFingerprint('example-record'), createCodec(changed).schemaFingerprint('example-record'));
    changed[0].protocols[0].currentSchema.fields.pop();
    changed[0].protocols[0].historical.push({ tag: 'another-old-tag', variant: 'unbound' });
    assert.equal(codec.schemaFingerprint('example-record'), createCodec(changed).schemaFingerprint('example-record'));
    assert.throws(() => createCodec(changed).historicalContract('example-record', 'unbound'));
});

test('Node 与 Python 对同一声明、历史头和结构指纹给出相同结果', () => {
    const codec = createCodec(catalogs);
    const code = 'import json,sys;sys.path.insert(0,"scripts");from protocol_codec import Codec;c=Codec(json.load(sys.stdin));print(json.dumps({"record":c.record("example-record",{"paperId":"new"}),"header":c.record_header("example-record-v1","example-record"),"format":c.format("example-record-v1","example-record")},ensure_ascii=False))';
    const result = JSON.parse(execFileSync('bash', ['scripts/python-runtime.sh', '-c', code], {
        cwd: path.resolve(__dirname, '..'), input: JSON.stringify(catalogs), encoding: 'utf8' }));
    assert.deepEqual(result, { record: codec.record('example-record', { paperId: 'new' }), header: codec.recordHeader('example-record-v1', 'example-record'), format: 'unbound' });
    assert.throws(() => canonical({ amount: 1.5 }));
    assert.throws(() => canonical({ text: '\ud800' }));
});

test('旧标签可用于不同对象，必须由调用者明确选择协议族和原头', () => {
    const codec = createCodec([{ protocols: [
        { name: 'source-manifest', currentVariant: 'source-files', currentSchema: { fields: ['files'] },
            historical: [{ tag: 'shared-source-v1', variant: 'source-files', header: { contract: 'shared-source-v1', version: 2 } }] },
        { name: 'source-reference', currentVariant: 'source-binding', currentSchema: { fields: ['manifestSha256'] },
            historical: [{ tag: 'shared-source-v1', variant: 'source-binding' }] }
    ] }]);
    assert.deepEqual(codec.recordHeader('shared-source-v1', 'source-manifest'), { contract: 'shared-source-v1', version: 2 });
    assert.deepEqual(codec.recordHeader('shared-source-v1', 'source-reference'), { contract: 'shared-source-v1' });
    assert.equal(codec.isContract('source-manifest', 'source-reference'), false);
    assert.throws(() => codec.format('shared-source-v1', 'unregistered-source'));
});

test('两种语言都拒绝重复 JSON 字段、坏 UTF-8 和编码前缀', t => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'protocol-catalog-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'example.json');
    const code = 'import sys;sys.path.insert(0,"scripts");from protocol_codec import read_catalogs;read_catalogs(sys.argv[1])';
    for (const bytes of [Buffer.from('{"protocols":[],"protocols":[]}'),
        Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d]),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"protocols":[]}')])]) {
        fs.writeFileSync(filename, bytes);
        assert.throws(() => readCatalogs(directory));
        assert.throws(() => execFileSync('bash', ['scripts/python-runtime.sh', '-c', code, directory], {
            cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] }));
    }
});

test('稳定名称的旧结构按已登记原指纹读取，不能猜结构或冒认当前结构', () => {
    const previous = JSON.parse(JSON.stringify(catalogs));
    const original = createCodec(previous);
    const oldHeader = original.recordHeader('example-record', 'example-record');
    const next = JSON.parse(JSON.stringify(previous));
    const definition = next[0].protocols[0];
    definition.historical.push({ tag: definition.name, variant: definition.currentVariant,
        header: oldHeader, schema: structuredClone(definition.currentSchema) });
    definition.currentVariant = 'source-and-authors';
    definition.currentSchema.fields.push('authors');
    const codec = createCodec(next);
    const current = codec.record('example-record');
    assert.equal(codec.hasValidHeader(oldHeader, 'example-record'), true);
    assert.equal(codec.isCurrentHeader(oldHeader, 'example-record'), false);
    assert.equal(codec.isCurrentHeader(current, 'example-record'), true);
    assert.notEqual(current.schemaFingerprint, oldHeader.schemaFingerprint);
    assert.deepEqual(codec.recordHeader(oldHeader.contract, 'example-record', oldHeader.schemaFingerprint), oldHeader);
    assert.deepEqual(codec.declaredSchema(oldHeader.contract, 'example-record', oldHeader.schemaFingerprint), previous[0].protocols[0].currentSchema);
    const oldSchema = codec.declaredSchema(oldHeader.contract, 'example-record', oldHeader.schemaFingerprint);
    oldSchema.fields.push('cannot-change-registry');
    assert.deepEqual(codec.declaredSchema(oldHeader.contract, 'example-record', oldHeader.schemaFingerprint), previous[0].protocols[0].currentSchema);
    assert.throws(() => codec.declaredSchema('example-record-v1', 'example-record'), /没有登记完整/);
    assert.deepEqual(codec.historicalHeader('example-record', 'source-bound', oldHeader.schemaFingerprint), oldHeader);
    assert.equal(codec.format(oldHeader.contract, 'example-record', oldHeader.schemaFingerprint), 'source-bound');
    assert.equal(codec.format(current.contract, 'example-record', current.schemaFingerprint), 'source-and-authors');
    assert.throws(() => codec.format(current.contract, 'example-record'), /必须提供/);
    assert.equal(codec.hasValidHeader({ ...oldHeader, schemaFingerprint: '0'.repeat(64) }, 'example-record'), false);
    assert.equal(codec.hasValidHeader({ contract: current.contract }, 'example-record'), false);
    assert.equal(codec.hasValidHeader(Object.create(oldHeader), 'example-record'), false);
    const wrong = JSON.parse(JSON.stringify(next));
    wrong[0].protocols[0].historical.at(-1).schema.fields.push('forged');
    assert.throws(() => createCodec(wrong), /原结构声明/);
    const code = 'import json,sys;sys.path.insert(0,"scripts");from protocol_codec import Codec;v=json.load(sys.stdin);c=Codec(v["catalogs"]);h=v["header"];print(json.dumps({"old":c.has_valid_header(h,"example-record"),"current":c.is_current_header(h,"example-record"),"header":c.record_header(h["contract"],"example-record",h["schemaFingerprint"]),"format":c.format(h["contract"],"example-record",h["schemaFingerprint"])}))';
    const result = JSON.parse(execFileSync('bash', ['scripts/python-runtime.sh', '-c', code], {
        cwd: path.resolve(__dirname, '..'), input: JSON.stringify({ catalogs: next, header: oldHeader }), encoding: 'utf8' }));
    assert.deepEqual(result, { old: true, current: false, header: oldHeader, format: 'source-bound' });
});

test('无字符串标签的历史整数头仍精确识别，布尔值与字符串不能代替整数', () => {
    const codec = createCodec([{ protocols: [{ name: 'numeric-evidence', currentVariant: 'source-bound',
        currentSchema: { fields: ['source'] }, historical: [{ tag: 2, variant: 'bounded', header: { version: 2 } }] }] }]);
    assert.equal(codec.hasValidHeader({ version: 2 }, 'numeric-evidence', 'version'), true);
    assert.equal(codec.isCurrentHeader({ version: 2 }, 'numeric-evidence', 'version'), false);
    assert.deepEqual(codec.recordHeader(2, 'numeric-evidence'), { version: 2 });
    for (const version of [true, false, '2', 3, -1, null]) {
        assert.equal(codec.hasValidHeader({ version }, 'numeric-evidence', 'version'), false);
    }
    assert.equal(codec.hasValidHeader({ version: 2, schemaFingerprint: '0'.repeat(64) }, 'numeric-evidence', 'version'), false);
});


test('名称和语义标识不接受结尾换行，两种语言都不能构造带旧头的新记录', () => {
    const code = 'import json,sys;sys.path.insert(0,"scripts");from protocol_codec import Codec;c=Codec(json.load(sys.stdin));c.record("example-record",{"policyVersion":1})';
    assert.throws(() => execFileSync('bash', ['scripts/python-runtime.sh', '-c', code], {
        cwd: path.resolve(__dirname, '..'), input: JSON.stringify(catalogs), stdio: ['pipe', 'pipe', 'pipe'] }));
    for (const field of ['name', 'currentVariant']) {
        for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
            const malformed = structuredClone(catalogs);
            malformed[0].protocols[0][field] += suffix;
            assert.throws(() => createCodec(malformed));
            assert.throws(() => execFileSync('bash', ['scripts/python-runtime.sh', '-c',
                'import json,sys;sys.path.insert(0,"scripts");from protocol_codec import Codec;Codec(json.load(sys.stdin))'], {
                cwd: path.resolve(__dirname, '..'), input: JSON.stringify(malformed), stdio: ['pipe', 'pipe', 'pipe'] }));
        }
    }
});

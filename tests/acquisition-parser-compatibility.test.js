'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readGitBlob } = require('../scripts/lib/git-file-bytes');
const root = path.resolve(__dirname, '..');

test('旧解析声明只用于明确登记的新实现，三份实际依赖任一改字节即拒绝', t => {
    const mirror = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'acquisition-codec-'));
    t.after(() => fs.rmSync(mirror, { recursive: true, force: true }));
    const records = JSON.parse(fs.readFileSync(path.join(root, 'config/workflow-historical-records.json')));
    const names = ['scripts/lib/workflow-legacy-codec.js', 'scripts/lib/strict-json.js',
        'scripts/lib/protocol-codec.js', 'scripts/lib/git-file-bytes.js', 'config/workflow-historical-records.json',
        ...Object.keys(records.acquisitionParserReplay.files)];
    for (const name of names) {
        const target = path.join(mirror, name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, fs.readFileSync(path.join(root, name)), { mode: 0o600, flag: 'wx' });
    }
    fs.cpSync(path.join(root, 'config/protocols'), path.join(mirror, 'config/protocols'), { recursive: true });
    execFileSync('git', ['init', '--object-format=sha1', '-q', mirror], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const name of ['scripts/lib/conference-filter.js', 'scripts/lib/official-conference-acquisition.js']) {
        const pin = records.filterPolicies.sourcePins[name], original = readGitBlob(root, pin.oid, pin.sha256);
        const oid = execFileSync('git', ['-C', mirror, 'hash-object', '-w', '--stdin'], { input: original, encoding: 'utf8' }).trim();
        assert.equal(oid, pin.oid);
    }
    const codec = require(path.join(mirror, 'scripts/lib/workflow-legacy-codec.js'));
    assert.doesNotThrow(() => codec.assertHistoricalAcquisitionParserCompatible());
    for (const name of Object.keys(records.acquisitionParserReplay.files)) {
        const filename = path.join(mirror, name), original = fs.readFileSync(filename);
        fs.appendFileSync(filename, '\nchanged implementation or dependency\n');
        assert.throws(() => codec.assertHistoricalAcquisitionParserCompatible(), /inconsistent/);
        fs.writeFileSync(filename, original);
        assert.doesNotThrow(() => codec.assertHistoricalAcquisitionParserCompatible());
    }
});

test('ICMC原算法只改变格式头与PDF制作工具标记，原页码和内容提取逐字保留', () => {
    const records = JSON.parse(fs.readFileSync(path.join(root, 'config/workflow-historical-records.json')));
    const pin = records.filterPolicies.sourcePins['scripts/icmc-proceedings.py'];
    const original = readGitBlob(root, pin.oid, pin.sha256).toString('utf8');
    const current = fs.readFileSync(path.join(root, 'scripts/icmc-proceedings.py'), 'utf8');
    const restored = current.replace('import protocol_codec as protocols\n', '')
        .replace('                **protocols.record_header(protocols.contract("icmc-combined-proceedings-page-map"), "icmc-combined-proceedings-page-map"),',
            '                "contract": "icmc-combined-proceedings-page-map-v1",\n                "version": 1,')
        .replace('"/Producer": "audio-paper-digest-icmc-split",', '"/Producer": "audio-paper-digest-icmc-split-v1",');
    assert.equal(restored, original);
});

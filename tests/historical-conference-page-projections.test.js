'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const api = require('../scripts/lib/historical-conference-page-projections.js');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-projection-storage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const body = { contract: api.CONTRACT, version: api.VERSION, catalogFileSha256: 'a'.repeat(64),
        inventory: { ledgerSha256: 'b'.repeat(64), pageSetSha256: 'c'.repeat(64) },
        projections: [], projectionSetSha256: api.stableHash([]), unmatchedPages: [] };
    return { root, outputName: 'projections.json', artifact: { ...body, artifactSha256: api.stableHash(body) } };
}
test('会议页面映射短写不留下坏正式文件，同一输出可以重试并保持原字节', t => {
    const options = fixture(t), originalWrite = fs.writeFileSync;
    fs.writeFileSync = (fd, bytes) => { fs.writeSync(fd, Buffer.from(bytes).subarray(0, 10)); throw Object.assign(new Error('模拟写入失败'), { code: 'EIO' }); };
    try { assert.throws(() => api.writeConferencePageMappingRecord(options), /模拟写入失败/); }
    finally { fs.writeFileSync = originalWrite; }
    assert.equal(fs.existsSync(path.join(options.root, options.outputName)), false);
    const first = api.writeConferencePageMappingRecord(options);
    assert.equal(first.status, 'created');
    assert.deepEqual(fs.readFileSync(first.filename), api.prettyBytes(options.artifact));
    assert.equal(api.writeConferencePageMappingRecord(options).status, 'recovered');
});
test('会议页面映射写入竞争保留另一写者字节，不清理其正式文件', t => {
    const options = fixture(t), originalLink = fs.linkSync, competitor = Buffer.from('竞争者的记录');
    fs.linkSync = (from, to) => { fs.writeFileSync(to, competitor, { flag: 'wx', mode: 0o600 }); return originalLink(from, to); };
    try { assert.throws(() => api.writeConferencePageMappingRecord(options), /拒绝覆盖/); }
    finally { fs.linkSync = originalLink; }
    assert.deepEqual(fs.readFileSync(path.join(options.root, options.outputName)), competitor);
    assert.deepEqual(fs.readdirSync(options.root), [options.outputName]);
});
test('会议页面映射写者链接后被杀，再写同一记录恢复且不改内容', t => {
    const options = fixture(t), filename = path.join(options.root, options.outputName);
    const script = `const fs=require('node:fs'),api=require(${JSON.stringify(require.resolve('../scripts/lib/historical-conference-page-projections.js'))});
const link=fs.linkSync;fs.linkSync=(a,b)=>{link(a,b);process.kill(process.pid,'SIGKILL');};
api.writeConferencePageMappingRecord(${JSON.stringify(options)});`;
    const child = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr); assert.equal(fs.statSync(filename).nlink, 2);
    assert.equal(api.writeConferencePageMappingRecord(options).status, 'recovered');
    assert.equal(fs.statSync(filename).nlink, 1);
    assert.deepEqual(fs.readFileSync(filename), api.prettyBytes(options.artifact));
});

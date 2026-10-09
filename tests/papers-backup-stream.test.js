const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { verifyPapersBackup } = require('../scripts/digest-status.js');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t, compressedOverride) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-stream-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'papers-2026-10-09.json.gz');
    const raw = Buffer.from(JSON.stringify({ papers: {}, generation: 0 }));
    const compressed = compressedOverride || zlib.gzipSync(raw);
    fs.writeFileSync(file, compressed);
    fs.writeFileSync(file + '.manifest.json', JSON.stringify({ contract: 'papers-backup-v1',
        backupFile: path.basename(file), sourceSha256: sha(raw), sourceBytes: raw.length,
        compressedSha256: sha(compressed), compressedBytes: compressed.length }));
    return { file, raw };
}
test('解压阶段磁盘读取失败经Promise返回原错误，不使进程发生未处理异常', t => {
    const f = fixture(t);
    const script = `const fs=require('node:fs'),{Readable}=require('node:stream');
const {verifyPapersBackup}=require(${JSON.stringify(require.resolve('../scripts/digest-status.js'))});
const original=fs.createReadStream;fs.createReadStream=function(file,...args){
 if(file===${JSON.stringify(f.file)})return new Readable({read(){this.destroy(Object.assign(new Error('模拟备份读取失败'),{code:'EIO'}));}});
 return original.call(this,file,...args);
};
verifyPapersBackup(${JSON.stringify(f.file)}).then(()=>{process.exitCode=2;},error=>{
 if(error.code!=='EIO')throw error; console.log('caught:EIO');
});`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /caught:EIO/);
    assert.doesNotMatch(child.stderr, /Unhandled/);
});
test('压缩字节哈希正确但格式损坏时，解压仍明确拒绝', async t => {
    const f = fixture(t, Buffer.from('not a gzip stream'));
    await assert.rejects(verifyPapersBackup(f.file), { code: 'Z_DATA_ERROR' });
});
test('有界解压保留字节上限，并接受相同字节的合法备份', async t => {
    const f = fixture(t);
    await assert.rejects(verifyPapersBackup(f.file, { maxRawBytes: f.raw.length - 1 }), { code: 'PAPERS_BACKUP_TOO_LARGE' });
    const verified = await verifyPapersBackup(f.file, { maxRawBytes: f.raw.length });
    assert.deepEqual(verified.data, { papers: {}, generation: 0 });
});

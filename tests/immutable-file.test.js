"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeImmutableFile } = require('../scripts/lib/immutable-file.js');
const reject = message => { throw new Error(message); };
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'identity-write-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function inject(method, replacement, callback) {
    const original = fs[method]; fs[method] = replacement(original);
    try { return callback(); } finally { fs[method] = original; }
}
function publicPrepare(t, kind) {
    const root = fixture(t), dataRoot = path.join(root, 'data'), identityRoot = path.join(root, 'identities');
    const id = '2610.00001'; fs.mkdirSync(path.join(dataRoot, 'current'), { recursive: true });
    if (kind === 'conference') {
        const api = require('../scripts/lib/historical-conference-crawl-authority.js');
        const forum = 'Forum_123'; const pdf = path.join(dataRoot, 'pdfs/icml2026', `${forum}.pdf`);
        fs.mkdirSync(path.dirname(pdf), { recursive: true }); fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
        fs.writeFileSync(path.join(dataRoot, 'current/icml_2026_deep_analysis.json'), JSON.stringify({ papers: [{ id: forum, title: '论文' }] }));
        const match = api.scanRetainedConferenceCrawlers({ dataRoot }).matches.get(`openreview-forum-id:${forum}`)[0];
        return { identityRoot, prepare: () => api.prepareConferenceCrawlAuthority({ dataRoot, identityRoot, match, apply: true }) };
    }
    const day = path.join(dataRoot, 'archive/2026-10-01'); fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'filtered-papers.json'), JSON.stringify({ papers: [{ arxivId: id, paper_id: id }] }));
    const api = require(`../scripts/lib/historical-${kind}-crawl-authority.js`);
    const match = (kind === 'archive' ? api.scanRetainedFilteredPapers : api.scanLocalCrawlPapers)({ dataRoot }).matches.get(id)[0];
    const prepare = kind === 'archive' ? api.prepareArchiveCrawlAuthority : api.prepareLocalCrawlAuthority;
    return { identityRoot, prepare: () => prepare({ dataRoot, identityRoot, snapshotRoot: null, arxivId: id, match, apply: true }) };
}
for (const kind of ['archive', 'local', 'conference']) {
    test(`${kind} 身份公开入口写入中断后不遗留半截正式文件，正常重试恢复`, t => {
        const f = publicPrepare(t, kind); let injected = false;
        inject('writeFileSync', original => (target, bytes, ...args) => {
            if (typeof target === 'number' && !injected) {
                injected = true; fs.writeSync(target, Buffer.from(bytes).subarray(0, 10));
                throw Object.assign(new Error('测试磁盘写入失败'), { code: 'EIO' });
            }
            return original(target, bytes, ...args);
        }, () => assert.throws(f.prepare, { code: 'EIO' }));
        assert.equal(injected, true);
        assert.deepEqual(fs.readdirSync(f.identityRoot), []);
        assert.equal(f.prepare().status, 'created');
        assert.equal(f.prepare().status, 'recovered');
    });
}
test('当前身份快照在写入失败后也可正常重试', t => {
    const root = fixture(t); const api = require('../scripts/lib/historical-local-crawl-authority.js');
    const loaded = { sourceKind: 'current', relativePath: 'current/papers.json', fileSha256: 'a'.repeat(64),
        records: [{ pointer: { kind: 'map-key', value: '2610.00001' }, identity: { arxivId: '2610.00001', paperId: '2610.00001' } }] };
    const prepare = () => api.prepareCurrentIdentitySnapshot({ snapshotRoot: root, loaded });
    inject('writeFileSync', () => () => { throw new Error('快照磁盘写入失败'); }, () => assert.throws(prepare, /快照磁盘/));
    assert.deepEqual(fs.readdirSync(root), []); assert.ok(prepare().snapshotSha256);
});
for (const same of [true, false]) {
    test(`发布前出现竞争文件时${same ? '复用相同字节' : '拒绝覆盖不同字节'}`, t => {
        const root = fixture(t), target = path.join(root, 'record.json');
        const bytes = Buffer.from('本次完整记录'), competitor = same ? bytes : Buffer.from('竞争者记录');
        inject('linkSync', original => (source, destination) => {
            fs.writeFileSync(destination, competitor); return original(source, destination);
        }, () => {
            if (same) writeImmutableFile(target, bytes, reject);
            else assert.throws(() => writeImmutableFile(target, bytes, reject), /拒绝覆盖/);
        });
        assert.ok(fs.readFileSync(target).equals(competitor));
        assert.deepEqual(fs.readdirSync(root), ['record.json']);
    });
}
test('临时文件被替换时不能发布或清理竞争者文件', t => {
    const root = fixture(t), target = path.join(root, 'record.json'); let replaced;
    inject('writeFileSync', original => (fd, bytes, ...args) => {
        const result = original(fd, bytes, ...args);
        if (typeof fd === 'number') {
            replaced = path.join(root, fs.readdirSync(root)[0]);
            fs.renameSync(replaced, path.join(root, 'original-owned.tmp'));
            original(replaced, '竞争者临时文件');
        }
        return result;
    }, () => assert.throws(() => writeImmutableFile(target, '本次记录', reject), AggregateError));
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(replaced, 'utf8'), '竞争者临时文件');
});
test('fsync失败只清理本次临时文件，重试可以完成', t => {
    const root = fixture(t), target = path.join(root, 'record.json');
    inject('fsyncSync', () => () => { throw new Error('磁盘同步失败'); },
        () => assert.throws(() => writeImmutableFile(target, '完整记录', reject), /磁盘同步失败/));
    assert.deepEqual(fs.readdirSync(root), []);
    writeImmutableFile(target, '完整记录', reject);
    assert.equal(fs.readFileSync(target, 'utf8'), '完整记录');
});

test('严格 umask 下仍保存为 0600 并可再次读取', t => {
    const root = fixture(t), target = path.join(root, 'record.json');
    const previous = process.umask(0o777);
    try { writeImmutableFile(target, '完整记录', reject); }
    finally { process.umask(previous); }
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    writeImmutableFile(target, '完整记录', reject);
    assert.equal(fs.readFileSync(target, 'utf8'), '完整记录');
});

test('子进程在发布硬链接后被杀，下一次写入安全回收残留并恢复', t => {
    const root = fixture(t), target = path.join(root, 'record.json');
    const helper = require.resolve('../scripts/lib/immutable-file.js');
    const child = require('node:child_process').spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs');
        const link = fs.linkSync;
        fs.linkSync = (...args) => { link(...args); process.kill(process.pid, 'SIGKILL'); };
        require(${JSON.stringify(helper)}).writeImmutableFile(${JSON.stringify(target)}, '完整记录', message => { throw new Error(message); });
    `], { timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(fs.statSync(target).nlink, 2);
    writeImmutableFile(target, '完整记录', reject);
    assert.equal(fs.statSync(target).nlink, 1);
    assert.deepEqual(fs.readdirSync(root), ['record.json']);
    assert.equal(fs.readFileSync(target, 'utf8'), '完整记录');
});
test('活写者和未知来源硬链接都不会被恢复清理', t => {
    const root = fixture(t), target = path.join(root, 'record.json');
    const host = require('node:crypto').createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
    const temporary = path.join(root, `.record.json.${host}.${process.pid}.${require('node:crypto').randomUUID()}.tmp`);
    fs.writeFileSync(temporary, '完整记录'); fs.linkSync(temporary, target);
    assert.throws(() => writeImmutableFile(target, '完整记录', reject), /拒绝覆盖/);
    assert.equal(fs.statSync(target).nlink, 2); assert.equal(fs.existsSync(temporary), true);
    fs.renameSync(temporary, path.join(root, 'unknown.tmp'));
    assert.throws(() => writeImmutableFile(target, '完整记录', reject), /拒绝覆盖/);
    assert.equal(fs.statSync(target).nlink, 2); assert.equal(fs.existsSync(path.join(root, 'unknown.tmp')), true);
});


test('不可变文件写入准确返回新建或恢复状态', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'immutable-file-status-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'record.json');
    assert.equal(writeImmutableFile(target, '完整记录', reject), 'created');
    assert.equal(writeImmutableFile(target, '完整记录', reject), 'recovered');
});

test('只有内容冲突提供稳定冲突码，读取期间换主仍属完整性错误', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'immutable-conflict-kind-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'record.json');
    const rejectWithCode = (message, details) => { throw Object.assign(new Error(message), details); };
    writeImmutableFile(target, 'abc', reject);
    for (const payload of ['xyz', 'different length']) {
        assert.throws(() => writeImmutableFile(target, payload, rejectWithCode), error => error.code === 'IMMUTABLE_FILE_CONTENT_CONFLICT');
    }
    const read = fs.readFileSync; let changed = false;
    fs.readFileSync = (fd, ...args) => {
        const bytes = read(fd, ...args);
        if (typeof fd === 'number' && !changed) {
            changed = true; fs.renameSync(target, `${target}.old`); fs.writeFileSync(target, 'xyz', { mode: 0o600 });
        }
        return bytes;
    };
    try { assert.throws(() => writeImmutableFile(target, 'xyz', rejectWithCode), error => error.code !== 'IMMUTABLE_FILE_CONTENT_CONFLICT' && /读取时变化/.test(error.message)); }
    finally { fs.readFileSync = read; }
    assert.equal(changed, true); assert.equal(fs.readFileSync(target, 'utf8'), 'xyz');
});

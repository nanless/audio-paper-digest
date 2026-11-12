'use strict';

// 共享语料的两类环境漂移守卫：
// 1. 路径漂移：fixture 里写入开发机绝对路径后，换一台机器/换一个用户目录就会
//    让断言红；2026-11-11 就有一批 fixture 带 `/Users/<真实用户>`，脱敏时还得
//    重算父稿哈希。这里禁止真实 home、临时目录和仓库绝对路径进入 fixture。
// 2. 时间戳漂移：本地时间（无时区）会被不同时区解释成不同瞬间，破坏稳定哈希。
//    fixture 里的 ISO 时间必须带 Z 或显式偏移。
// 另外校验 JSON/gzip 语料本身没有损坏，避免“测试失败其实是 fixture 被截断”。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const EXEMPT_NAMES = new Set(['README.md', '.DS_Store']);
const TEXT_SUFFIXES = ['.json', '.txt', '.md', '.html', '.py', '.cjs', '.js'];
const REAL_HOME = path.resolve(os.homedir());

// 这 8 个真实付费/封存片段是在路径脱敏规范之前登记的，内部仍带开发机绝对路径。
// 它们的消费测试把 gzip 文件 SHA 或内部稳定哈希写死（reader-* 测试，由发布侧维护），
// 单改 fixture 会让那些测试红，因此这里只登记债务、不允许新增：
// 清理时必须同步消费测试的哈希常量，然后从本清单删除对应行（测试会要求删除）。
const LEGACY_LOCAL_PATH_SNAPSHOTS = new Set([
    'reader-compiled-fact-2610.41381-real.json.gz',
    'reader-current-signed-mscr-paid-render.json.gz',
    'reader-fact-table-claim-location-real.json.gz',
    'reader-ordinal-cold-source-20261028-real.json.gz',
    'reader-scientific-glyph-35042-real.json.gz',
    'reader-target-ordinal-paid-20261027-real.json.gz',
    'reader-version4-2610-34220.real.json.gz',
    'structure-final-replay-32310-latest.real.json.gz',
]);

function walk(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (entry.name === '__pycache__' || entry.name === '.DS_Store') return [];
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return walk(path.join(dir, entry.name), relative);
        return entry.isFile() ? [relative] : [];
    }).sort();
}

function readText(relative) {
    const absolute = path.join(FIXTURES, relative);
    if (relative.endsWith('.gz')) {
        const bytes = zlib.gunzipSync(fs.readFileSync(absolute));
        // 只有 JSON 压缩语料按 UTF-8 读；PDF 页资产做单独校验。
        if (!relative.endsWith('.pdf.gz')) return bytes.toString('utf8');
        return null;
    }
    if (!TEXT_SUFFIXES.some(suffix => relative.endsWith(suffix))) return null;
    return fs.readFileSync(absolute, 'utf8');
}

test('fixture 不包含真实用户目录、临时目录或本仓库绝对路径', () => {
    const offenders = [];
    const fixedSnapshots = [];
    const forbidden = [
        [REAL_HOME, '本机真实 home 目录'],
        // CI 的 home 不是开发机 home；历史泄露字面量必须在任何机器上都拦住。
        ['/Users/francis7999/', '历史开发机绝对路径'],
        ['/private/var/folders', 'macOS 临时目录'],
        ['/var/folders', 'macOS 临时目录'],
        [ROOT, '本仓库绝对路径'],
    ];
    // `/Users/fixture/...` 是明确登记的合成路径，不是真实用户目录。
    const syntheticHome = /\/Users\/fixture(?:\/|$)/g;
    for (const relative of walk(FIXTURES)) {
        const text = readText(relative);
        if (!text) continue;
        const sanitized = text.replace(syntheticHome, '/Users/<synthetic>');
        const hits = forbidden.filter(([needle]) => needle && sanitized.includes(needle));
        if (hits.length === 0) {
            if (LEGACY_LOCAL_PATH_SNAPSHOTS.has(relative)) fixedSnapshots.push(relative);
            continue;
        }
        if (LEGACY_LOCAL_PATH_SNAPSHOTS.has(relative)) continue;
        offenders.push(`${relative} 含${hits.map(([, label]) => label).join('、')}`);
    }
    assert.deepEqual(offenders, [],
        'fixture 不得写入本机路径；请改成相对路径或合成路径：\n' + offenders.join('\n'));
    assert.deepEqual(fixedSnapshots, [],
        '以下真实片段已不再包含本机路径，请从 LEGACY_LOCAL_PATH_SNAPSHOTS 删除对应行：\n'
        + fixedSnapshots.join('\n'));
});

test('fixture 中的 ISO 时间戳都带显式时区', () => {
    const offenders = [];
    const timestamp = /"(\d{4}-\d{2}-\d{2}T[^"]*)"/g;
    for (const relative of walk(FIXTURES)) {
        const text = readText(relative);
        if (!text) continue;
        for (const match of text.matchAll(timestamp)) {
            // 真实响应片段里可能嵌着转义 JSON（`\"...Z\"`），捕获到的尾部会带
            // 一个反斜杠；它不是时间戳的一部分。
            const value = match[1].replace(/\\+$/, '');
            if (/[zZ]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) continue;
            offenders.push(`${relative}: ${value}`);
        }
    }
    assert.deepEqual(offenders, [],
        'ISO 时间戳必须带 Z 或显式偏移，避免本地时区漂移：\n' + offenders.join('\n'));
});

test('历史核心来源 provenance 记录的 PDF 字节与磁盘一致', () => {
    // provenance 是唯一说明历史 PDF 来源身份的样本；它以前没有任何消费方，
    // 文件被替换或截断时没人会发现。这里让它至少对真实 PDF 字节负责。
    const provenance = JSON.parse(fs.readFileSync(path.join(
        FIXTURES, 'historical-core-source-2610.30385-provenance.json'), 'utf8'));
    const pdf = fs.readFileSync(path.join(FIXTURES, 'historical-core-source-2610.30385.pdf'));
    assert.equal(pdf.length, provenance.sourcePdfBytes, '历史来源 PDF 字节数漂移');
    assert.equal(require('node:crypto').createHash('sha256').update(pdf).digest('hex'),
        provenance.sourcePdfSha256, '历史来源 PDF 内容哈希漂移');
    assert.ok(fs.existsSync(path.join(FIXTURES, provenance.sourceTextFixture)),
        `provenance 登记的 sourceTextFixture 不存在：${provenance.sourceTextFixture}`);
});

test('JSON 与 gzip 语料可以完整解析，截断会直接点名', () => {
    const broken = [];
    for (const relative of walk(FIXTURES)) {
        const absolute = path.join(FIXTURES, relative);
        if (relative.endsWith('.json')) {
            try {
                JSON.parse(fs.readFileSync(absolute, 'utf8'));
            } catch (error) {
                broken.push(`${relative}: ${error.message}`);
            }
        } else if (relative.endsWith('.json.gz')) {
            try {
                JSON.parse(zlib.gunzipSync(fs.readFileSync(absolute)).toString('utf8'));
            } catch (error) {
                broken.push(`${relative}: ${error.message}`);
            }
        } else if (relative.endsWith('.pdf.gz')) {
            const bytes = zlib.gunzipSync(fs.readFileSync(absolute));
            if (bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
                broken.push(`${relative}: 解压后不是 PDF`);
            }
        }
    }
    assert.deepEqual(broken, [], '语料损坏或截断：\n' + broken.join('\n'));
});

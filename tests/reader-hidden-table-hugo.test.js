'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cheerio = require('cheerio');
const { extractMarkdownTables } = require('../scripts/analysis-contract');

const availability = spawnSync('hugo', ['version'], { encoding: 'utf8', timeout: 10000 });
const required = process.env.REQUIRE_HUGO_INTEGRATION_TESTS === '1'
    || process.env.PD_REQUIRE_HUGO_TESTS === '1';
const missing = availability.error?.code === 'ENOENT';

// 只构建本测试的本地最小 Hugo 项目；没有主题、远程模块或正式博客文件。
test('Hugo 实际 HTML DOM 与 Reader 表格展示判断对应', {
    skip: missing && !required ? '未安装 Hugo；完整集成检查必须安装后运行' : false
}, t => {
    assert.equal(availability.status, 0,
        `必须能运行 Hugo：${availability.error?.message || availability.stderr || ''}`);
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-hidden-hugo-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'content'));
    fs.mkdirSync(path.join(root, 'layouts', '_default'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hugo.toml'),
        'baseURL = "https://offline.invalid/"\n[markup.goldmark.renderer]\nunsafe = true\n');
    fs.writeFileSync(path.join(root, 'layouts', '_default', 'single.html'), '{{ .Content }}');
    const { cases } = JSON.parse(fs.readFileSync(
        path.join(__dirname, 'fixtures', 'reader-table-visibility.json'), 'utf8'));
    for (const item of cases) {
        fs.writeFileSync(path.join(root, 'content', item.name + '.md'),
            '---\ntitle: "' + item.name + '"\n---\n\n' + item.body + '\n');
    }
    const built = spawnSync('hugo', ['--source', root, '--destination', path.join(root, 'public'), '--quiet'], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, HUGO_MODULE_PROXY: 'off' }
    });
    assert.equal(built.status, 0, built.error?.message || built.stderr);
    for (const item of cases) {
        const html = fs.readFileSync(path.join(root, 'public', item.name, 'index.html'), 'utf8');
        const dom = cheerio.load(html);
        assert.equal(dom('table').length, item.dom, `${item.name} 的实际 HTML DOM 表格数`);
        const tables = extractMarkdownTables(item.body);
        assert.equal(tables.length, item.reader, `${item.name} 的 Reader 正文表格数`);
        if (item.name === 'inline-tokens') {
            assert.equal(tables[0].markdown, item.body);
            assert.deepEqual(dom('td code').map((_, node) => dom(node).text()).get(), ['<!--', '-->']);
        }
        if (item.name === 'html-comment') assert.match(html, /<table[\s>]/);
    }
});

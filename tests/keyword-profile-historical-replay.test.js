'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const keyword = require('../scripts/lib/keyword-prefilter');
const legacy = require('../scripts/lib/workflow-legacy-codec');
const { readGitBlob } = require('../scripts/lib/git-file-bytes');
const root = path.resolve(__dirname, '..');

test('关键词迁移只改变元数据、导出及对应说明，原完整分类逻辑逐字保留', () => {
    const records = JSON.parse(fs.readFileSync(path.join(root, 'config/workflow-historical-records.json')));
    const pin = records.filterPolicies.sourcePins['scripts/lib/keyword-prefilter.js'];
    const original = readGitBlob(root, pin.oid, pin.sha256).toString('utf8');
    const current = fs.readFileSync(path.join(root, 'scripts/lib/keyword-prefilter.js'), 'utf8');
    const metadataImports = current.slice(current.indexOf("const crypto = require('node:crypto');"),
        current.indexOf('const MIN_ABSTRACT_CHARS_FOR_REJECTION'));
    const restored = current
        .replace('分类规则的格式与实际实现 SHA 参与筛选配置指纹；规则变化会使旧筛选决定需要重新检查，',
            '关键词版本号参与筛选配置指纹；更新版本号会使旧筛选决定需要重新检查，')
        .replace(metadataImports, `const KEYWORD_PREFILTER_VERSION = '${legacy.originalKeywordMetadata().keywordPrefilterVersion}';\n`)
        .replace('profile: { ...KEYWORD_PREFILTER_PROFILE }', 'version: KEYWORD_PREFILTER_VERSION')
        .replace('    KEYWORD_PREFILTER_PROFILE,', '    KEYWORD_PREFILTER_VERSION,');
    assert.equal(restored, original, 'Every expression/list/constant/control-flow byte outside metadata must remain original');
});

test('真实原Git分类器回放与现用元数据视图一致，错profile与旧策略不得延续', () => {
    const records = JSON.parse(fs.readFileSync(path.join(root, 'config/workflow-historical-records.json')));
    const pin = records.filterPolicies.sourcePins['scripts/lib/keyword-prefilter.js'];
    const filename = path.join(root, 'scripts/lib/keyword-prefilter.js');
    const old = new Module(filename, module); old.filename = filename;
    old.paths = Module._nodeModulePaths(path.dirname(filename));
    old._compile(readGitBlob(root, pin.oid, pin.sha256).toString('utf8'), filename);
    const gold = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/keyword-prefilter-gold.json')));
    const papers = [...gold.cases.map(item => item.paper || item), null, {},
        { title: 'ASR and asr; VC versus vc', abstract: 'x'.repeat(79) },
        { title: 'Generic optimization', abstract: 'x'.repeat(80) },
        { title: 'Speech sampling framework', abstract: 'x'.repeat(200), categories: ['cs.LG'] },
        { title: 'Unrelated', abstract: 'x'.repeat(200), categories: ['eess.AS'] }];
    const identity = legacy.originalKeywordMetadata();
    for (const paper of papers) {
        assert.deepEqual(legacy.keywordResultForHistoricalPolicy(keyword.evaluateKeywordPrefilter(paper), identity.policySha256),
            old.exports.evaluateKeywordPrefilter(paper));
    }
    for (const hash of legacy.previousKeywordPolicyHashes()) {
        assert.throws(() => legacy.keywordResultForHistoricalPolicy(keyword.evaluateKeywordPrefilter({}), hash), /inconsistent/);
    }
    for (const profile of [{ ...keyword.KEYWORD_PREFILTER_PROFILE, implementationSha256: '0'.repeat(64) },
        { ...keyword.KEYWORD_PREFILTER_PROFILE, schemaFingerprint: '0'.repeat(64) }, null]) {
        assert.throws(() => legacy.keywordResultForHistoricalPolicy({ ...keyword.evaluateKeywordPrefilter({}), profile },
            identity.policySha256), /inconsistent/);
    }
});

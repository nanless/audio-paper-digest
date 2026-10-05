'use strict';

// 五份源码来自 c8c578d1 的完整原字节。只用于离线测试，不能作为当前生产模块部署。
// 原实现指纹在生产编辑前从实际磁盘取得；状态与计划由原实现生成，不能换头伪造。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ORIGINAL_IMPLEMENTATION_SHA256 = '493fd34b7c55908bbaa500b1927ff5d107ab380c8d5a3bf449552b54a4e66bed';
const SOURCES = [
    ['scripts/lib/conference-process.js', 'conference-process-v1-source.txt', '9db6bb8ab26911bff893d2fd04dda4dcf5f07efbd73a41dc30c9470f77af67ba'],
    ['scripts/lib/conference-process-recovery.js', 'conference-process-recovery-v1-source.txt', 'e3adcebae4be48137fc0e4c258a8b1ba1913b79d7e81c8623c5aa782dd434a3f'],
    ['scripts/lib/conference-source-upgrade.js', 'conference-source-upgrade-v1-source.txt', 'a7ad3ba00f00da9554f843e0cb41d9993f45cc450ce61fe9e0cc22efe35dab15'],
    ['scripts/migrate-conference-process.js', 'migrate-conference-process-v1-source.txt', '414e85cf74f5eaca96ba2d1643d34ba0abe7dd36fba660e504be7c24eabb1782'],
    ['scripts/conference-workspace.js', 'conference-workspace-v1-source.txt', 'de035ec54d8c4519a9099669a1acec14c0444f2222767bc3958f127bd8e1316c'],
];

function loadOriginalConferenceProcessApis() {
    const root = path.join(__dirname, '..', '..');
    const sources = new Map(SOURCES.map(([original, archive, sha256]) => {
        const raw = fs.readFileSync(path.join(__dirname, '..', 'fixtures', archive));
        assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), sha256);
        return [path.join(root, original), raw];
    }));
    const instances = new Map();
    const load = filename => {
        if (instances.has(filename)) return instances.get(filename).exports;
        const instance = new Module(filename, module);
        instance.filename = filename;
        instance.paths = Module._nodeModulePaths(path.dirname(filename));
        instances.set(filename, instance);
        const nativeRequire = instance.require.bind(instance);
        instance.require = name => {
            const resolved = Module._resolveFilename(name, instance);
            return sources.has(resolved) ? load(resolved) : nativeRequire(name);
        };
        instance._compile(sources.get(filename).toString('utf8'), filename);
        return instance.exports;
    };
    return {
        processApi: load(path.join(root, SOURCES[0][0])),
        recovery: load(path.join(root, SOURCES[1][0])),
        upgrade: load(path.join(root, SOURCES[2][0])),
        migration: load(path.join(root, SOURCES[3][0])),
        workspace: load(path.join(root, SOURCES[4][0])),
        implementationSha256: ORIGINAL_IMPLEMENTATION_SHA256
    };
}

module.exports = { loadOriginalConferenceProcessApis, ORIGINAL_IMPLEMENTATION_SHA256 };

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const Config = require('../scripts/config');
function snapshot(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).sort().flatMap(name => {
        const file = path.join(root, name);
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) return snapshot(file);
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), '记录树必须由真实文件组成');
        return [[file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
    });
}
module.exports = function registerCoreDiagnosticsIsolation() {
    let original, bytes, folder;
    before(() => {
        original = Config.FILES.analysisRepairAttemptsDir;
        bytes = snapshot(original);
        folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'core-diagnostic-fixture-'));
        Config.FILES.analysisRepairAttemptsDir = folder;
    });
    after(() => {
        Config.FILES.analysisRepairAttemptsDir = original;
        try { assert.deepEqual(snapshot(original), bytes, '默认摘要记录树原字节必须保持'); }
        finally { fs.rmSync(folder, { recursive: true, force: true }); }
    });
};

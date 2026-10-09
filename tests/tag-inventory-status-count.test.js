"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inventory = require('../scripts/tag-check-inventory.js');

test('标签清单按实际状态计数，不把对象继承属性当成已有计数', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-status-count-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const assignments = path.join(root, 'assignments');
    const directory = path.join(assignments, 'batch');
    fs.mkdirSync(directory, { recursive: true });
    const registryFile = path.join(root, 'registry.json');
    fs.writeFileSync(registryFile, '{}');
    const statuses = ['complete', '__proto__', 'constructor', 'toString', '__proto__'];
    statuses.forEach((status, index) => fs.writeFileSync(path.join(directory, `${index}.json`), JSON.stringify({
        paperId: `2601.1000${index}`, registrySha256: 'a'.repeat(64), status
    })));
    const result = inventory.collect({
        assignmentsDir: assignments, registryFile,
        executionsDir: path.join(root, 'missing-executions'), deepFile: path.join(root, 'missing-deep')
    });
    const saved = JSON.parse(JSON.stringify(result));
    assert.equal(saved.totals.seals, 5);
    assert.equal(saved.groups.length, 1);
    const counts = saved.groups[0].statuses;
    assert.equal(Object.hasOwn(counts, '__proto__'), true);
    assert.equal(counts.__proto__, 2);
    assert.equal(counts.constructor, 1);
    assert.equal(counts.toString, 1);
    assert.equal(counts.complete, 1);
    assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), saved.groups[0].seals);
    const report = inventory.formatHuman(result);
    assert.match(report, /__proto__ 2/);
    assert.match(report, /constructor 1/);
    assert.match(report, /toString 1/);
    assert.doesNotMatch(report, /native code/);
    assert.equal(Object.getPrototypeOf(result.groups[0].statuses), Object.prototype);
    assert.equal(Object.hasOwn(Object.prototype, 'complete'), false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFixture, calculate, loadAuthority } = require('./generate-workbench-website-query-golden.cjs');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/workbench-website-query-golden.json')));

test('website query golden is generated reproducibly from the unchanged official resolver', () => {
  assert.deepEqual(buildFixture(), fixture);
  assert.match(fixture.scope, /^TEST ONLY/);
  assert.ok(fixture.cases.length >= 40);
});

const { core } = loadAuthority();
const graph = core.createRegistry(fixture.display.snapshot, fixture.display.versions);
for (const item of fixture.cases) test('official query: ' + item.name, () => {
  assert.deepEqual(calculate(core, graph, fixture.records, item), item.expected);
});

test('opposite cases distinguish same-guide AND, primary roles, valid zero nodes and invalid IDs', () => {
  const output = name => fixture.cases.find(item => item.name === name).expected;
  assert.equal(output('parent-subtree-includes-three-level-leaf').paperIDs.length, 1);
  assert.equal(output('parent-direct-does-not-match-leaf').paperIDs.length, 0);
  assert.equal(output('secondary-method-matches-any').paperIDs.length, 1);
  assert.equal(output('secondary-method-does-not-match-primary').paperIDs.length, 0);
  assert.equal(output('multiguide-AND-cannot-borrow-other-guide').paperIDs.length, 0);
  assert.equal(output('multiguide-one-guide-satisfies-AND').paperIDs.length, 1);
  assert.equal(output('known-zero-node-is-valid-empty-result').error, undefined);
  assert.equal(output('invalid-query-unknown-node').error, true);
  assert.equal(output('duplicate-guide-permalink-not-counted-twice').filteredCounts.total, 1);
  assert.equal(output('unverified-identities-remain-separate-pages').filteredCounts.total, 2);
});

for (const item of fixture.appIntegrationCases) test('app search-extension vector: ' + item.name, () => {
  assert.match(item.scope, /^APP INTEGRATION ONLY/);
  assert.deepEqual(calculate(core, graph, fixture.records, { recordKeys: item.eligibleRecordKeys, filters: item.filters }), item.expected);
  const positive = ['typed-cached-text-is-explicit-paper-level-extension', 'private-note-is-explicit-paper-level-extension'].includes(item.name);
  assert.equal(item.expected.paperIDs.length, positive ? 1 : 0);
});

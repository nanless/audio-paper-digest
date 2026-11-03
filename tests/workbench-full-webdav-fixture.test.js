const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/workbench/full-webdav-sync-v1.json')));
const offlineFixture = JSON.parse(readFileSync(join(__dirname, '../apps/android/app/src/test/resources/offline-swift-vectors.json')));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function entriesFor(source) {
  const entries = new Map();
  for (const row of source.files) {
    assert.match(row.path, /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/);
    assert.ok(row.path.split('/').every(part => part !== '.' && part !== '..'));
    assert.ok(!entries.has(row.path.toLowerCase()), `duplicate path: ${row.path}`);
    const bytes = Buffer.from(row.data, 'base64');
    assert.equal(bytes.toString('base64'), row.data, row.path);
    assert.equal(digest(bytes), row.sha256, row.path);
    entries.set(row.path.toLowerCase(), { ...row, bytes });
  }
  return entries;
}

test('full sync fixture binds shared PDF and both complete offline packages to original bytes', () => {
  const packageIDs = [];
  const pdfs = new Set();
  for (const source of fixture.sources) {
    const entries = entriesFor(source);
    const pdf = entries.get(fixture.expected.pdf.path.toLowerCase());
    assert.match(pdf.bytes.subarray(0, 8).toString(), /^%PDF-/);
    assert.equal(pdf.sha256, fixture.expected.pdf.sha256);
    pdfs.add(pdf.sha256);

    const manifests = [...entries.values()].filter(file => /^Offline\/[a-f0-9]{64}\/manifest\.json$/.test(file.path));
    assert.equal(manifests.length, 1);
    const manifest = JSON.parse(manifests[0].bytes);
    packageIDs.push(manifest.id);
    const packet = offlineFixture.packets.find(item => item.id === manifest.id);
    assert.ok(packet?.actualMacVerificationPassed, manifest.id);
    const prefix = `Offline/${manifest.id}/`;
    const packed = [...entries.values()].filter(file => file.path.startsWith(prefix));
    assert.deepEqual(packed.map(file => file.path.slice(prefix.length)).sort(), packet.files.map(file => file.path).sort());
    for (const file of packet.files) {
      assert.equal(entries.get((prefix + file.path).toLowerCase()).data, file.data, file.path);
    }
    assert.equal(manifests[0].path, prefix + 'manifest.json');
    for (const file of manifest.files) {
      const actual = entries.get((prefix + file.path).toLowerCase());
      assert.equal(actual.sha256, file.sha256, file.path);
      assert.equal(actual.bytes.length, file.bytes, file.path);
    }
  }
  assert.equal(pdfs.size, fixture.expected.pdf.copies);
  assert.deepEqual(packageIDs.sort(), fixture.expected.offlinePackageIDs);
});

test('full sync fixture distinguishes same-ID originals from excluded device controls', () => {
  const studyInputs = [], studyResponses = [], archiveReceipts = [], exclusions = new Set();
  assert.deepEqual(fixture.sources.map(source => source.platform).sort(), ['android', 'mac']);
  for (const source of fixture.sources) {
    const entries = entriesFor(source);
    const person = JSON.parse(entries.get('personal.json').bytes);
    const session = person.sessions.find(row => row.id === fixture.expected.studyID);
    assert.ok(session);
    const input = entries.get(`modelusage/${session.id}-input.json`);
    const response = entries.get(`modelusage/${session.id}-response.${source.platform === 'android' ? 'bin' : 'json'}`);
    if (source.platform === 'android') {
      const receipt = JSON.parse(entries.get(`modelusage/${session.id}-response.json`).bytes);
      assert.equal(receipt.sessionID, session.id);
      assert.equal(receipt.sha256, response.sha256);
    }
    assert.equal(session.inputSHA256, input.sha256);
    assert.equal(session.responseSHA256, response.sha256);
    studyInputs.push(input.sha256);
    studyResponses.push(response.sha256);
    const receipt = [...entries.values()].find(row => /^(zoteroarchives|zotero-archives)\//i.test(row.path));
    assert.equal(JSON.parse(receipt.bytes).id, fixture.expected.archiveID);
    archiveReceipts.push(receipt.sha256);

    const controls = [...entries.values()].filter(row =>
      /^(ZoteroConnection|ZoteroMigrationIntents)\//.test(row.path) ||
      /^ModelUsage\/response-integrity(?:\.android)?\.key$/.test(row.path));
    assert.equal(controls.length, 3);
    controls.forEach(file => exclusions.add(file.sha256));
  }
  for (const [name, hashes] of Object.entries({ studyInputs, studyResponses, archiveReceipts })) {
    assert.equal(new Set(hashes).size, fixture.sources.length, name);
    assert.deepEqual(hashes.sort(), fixture.expected.preservedSHA256[name], name);
    assert.ok(hashes.every(hash => !exclusions.has(hash)), name);
  }
  assert.deepEqual([...exclusions].sort(), fixture.expected.excludedSHA256);
});

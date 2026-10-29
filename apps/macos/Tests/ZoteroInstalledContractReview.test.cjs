// Read-only contract review against the installed Zotero source. No local API,
// profile, database, credential, or attachment file is accessed by this test.
// Run with: node --test apps/macos/Tests/ZoteroInstalledContractReview.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

const installedArchive = '/Applications/Zotero.app/Contents/Resources/app/omni.ja';
const itemSource = execFileSync('/usr/bin/python3', ['-c',
  'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.buffer.write(z.read("chrome/content/zotero/xpcom/data/item.js"))',
  installedArchive], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });

function extract(start, end) {
  const first = itemSource.indexOf(start);
  assert.notEqual(first, -1, `Installed source lacks ${start}`);
  const last = itemSource.indexOf(end, first);
  assert.notEqual(last, -1, `Installed source lacks terminator for ${start}`);
  return itemSource.slice(first, last + end.length);
}

function context() {
  // Only unrelated database/schema infrastructure is replaced. The actual
  // fromJSON, attachment setters, note setter, and file-URL logic run unchanged.
  const Zotero = {
    Item: function () {
      this._attachmentLinkMode = null;
      this._attachmentPath = null;
      this._collections = [];
      this._changed = {};
      this._fields = {};
      this._noteText = '';
      this._identified = true;
    },
    defineProperty: Object.defineProperty,
    ItemTypes: { getID: value => value ? 1 : null, getName: () => 'attachment' },
    ItemFields: { getID: value => value === 'title' ? 1 : 0,
      getFieldIDFromTypeAndBase: () => null, isValidForType: () => true },
    Attachments: { LINK_MODE_IMPORTED_FILE: 0, LINK_MODE_IMPORTED_URL: 1,
      LINK_MODE_LINKED_FILE: 2, LINK_MODE_LINKED_URL: 3, LINK_MODE_EMBEDDED_IMAGE: 4,
      getStorageDirectory: () => ({ path: '/synthetic-zotero-review-storage' }) },
    Libraries: { userLibraryID: 1 },
    Utilities: { Internal: { extractExtraFields: () => ({ itemType: null,
      fields: new Map(), creators: [], extra: '' }) }, Item: { noteToTitle: value => value } },
    File: { pathToFileURI: value => pathToFileURL(value).href },
    debug() {}, logError() {}, warn() {}
  };
  Object.assign(Zotero.Item.prototype, {
    setType() {}, isAttachment() { return true; }, isNote() { return false; },
    isAnnotation() { return false; }, isEmbeddedImageAttachment() { return false; },
    isStoredFileAttachment() { return [0, 1].includes(this.attachmentLinkMode); },
    setField(key, value) { this._fields[key] = value; },
    getField(key) { return this._fields[key] || ''; }, getUsedFields() { return []; },
    setTags(value) { this.tags = value; }, getNote() { return this._noteText; },
    _markFieldChange() {}, _updateAttachmentStates() {}
  });
  const sandbox = vm.createContext({ Zotero, OS: { Path: path.posix } });
  const declarations = ['attachmentLinkMode', 'attachmentFilename', 'attachmentPath']
    .map(name => extract(`Zotero.defineProperty(Zotero.Item.prototype, '${name}', {`, '\n});'));
  for (const name of ['fromJSON', 'setNote', 'getFilePath', 'getLocalFileURL']) {
    declarations.push(extract(`Zotero.Item.prototype.${name} = function`, '\n};'));
  }
  declarations.push(extract('function filenameContainsPath(filename)', '\n}'));
  vm.runInContext(declarations.join('\n'), sandbox, { timeout: 1000 });
  return Zotero;
}

function payload(filename = 'paper.pdf', contentType = 'application/pdf') {
  return { itemType: 'attachment', parentItem: 'EXAMPLE1', linkMode: 'imported_file',
    title: '论文速递工作台 · 原始附件', contentType, filename,
    note: 'PaperDigest-Asset: pdf:example', tags: [{ tag: '论文速递' }] };
}

test('installed constructor really starts with an unset linkMode', () => {
  assert.match(itemSource, /this\._attachmentLinkMode = null;/);
  console.log('Installed item.js SHA256:', createHash('sha256').update(itemSource).digest('hex'));
});

test('installed fromJSON rejects the old alphabetically sorted wire for all material kinds', () => {
  for (const [filename, type] of [['paper.pdf', 'application/pdf'],
    ['source-metadata.json', 'application/json'], ['guide.html', 'text/html']]) {
    const object = payload(filename, type);
    const wire = JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b))));
    assert(wire.indexOf('"filename":') < wire.indexOf('"linkMode":'));
    const Zotero = context();
    assert.throws(() => new Zotero.Item().fromJSON(JSON.parse(wire), { strict: false }),
      /Link mode must be set before setting attachment path/);
  }
});

test('linkMode-first wire keeps the full filename, parent, note and tags', () => {
  for (const filename of ['paper.pdf', 'source-metadata.json', '图文“导读”.html']) {
    const original = payload(filename);
    const { linkMode, ...remaining } = original;
    const parsed = JSON.parse(JSON.stringify({ linkMode, ...remaining }));
    const Zotero = context();
    const item = new Zotero.Item();
    item.fromJSON(parsed, { strict: false });
    assert.equal(item.attachmentLinkMode, 0);
    assert.equal(item.attachmentPath, `storage:${filename}`);
    assert.equal(item.parentKey, original.parentItem);
    assert.equal(item.getNote(), original.note);
    assert.deepEqual(item.tags, original.tags);
  }
});

test('installed file/view URL logic has no existence check for a named empty slot', () => {
  const Zotero = context();
  const original = payload();
  const { linkMode, ...remaining } = original;
  const item = new Zotero.Item();
  item.fromJSON({ linkMode, ...remaining }, { strict: false });
  assert.equal(item.getLocalFileURL(), 'file:///synthetic-zotero-review-storage/paper.pdf');
});

test('omitting filename creates a slot whose installed file URL is false, not HTTP404', () => {
  const Zotero = context();
  const { filename, ...object } = payload();
  const item = new Zotero.Item();
  item.fromJSON(object, { strict: false });
  assert.equal(item.attachmentPath, null);
  assert.equal(item.getLocalFileURL(), false);
});

test('ordering workaround does not bypass installed filename path validation', () => {
  for (const filename of ['../paper.pdf', '/tmp/paper.pdf']) {
    const Zotero = context();
    const { linkMode, ...remaining } = payload(filename);
    assert.throws(() => new Zotero.Item().fromJSON({ linkMode, ...remaining }, { strict: false }),
      /Stored-file filename cannot contain a directory path/);
  }
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-core-rendering-')));
require('./helpers/isolated-tmp-write-guard.cjs').installTmpOnlyWriteGuard(tmp);
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const deny = () => { throw Error('Rendering regression forbids network/model requests'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const name of ['node:http', 'node:https']) { require(name).request = deny; require(name).get = deny; }
globalThis.fetch = deny;
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/reader-core-parent-rendering-real.json')));
const filename = path.resolve(__dirname, '../scripts/lib/daily-fact-review.js');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports.renderRealReaderFeedback = renderReaderFactReviewText;', filename);
const facts = compiled.exports;

test('actual core-parent and monotonic Reader packages reproduce both observed exact renderings', () => {
    const ordinary = facts.renderRealReaderFeedback(fixture.monotonicReaderChild, fixture.coreParent, false, null);
    const guided = facts.renderRealReaderFeedback(fixture.monotonicReaderChild, fixture.coreParent, false, 'coreSummaryRepair');
    assert.equal(ordinary.length, fixture.observed.ordinaryChars);
    assert.equal(facts.sha(ordinary), fixture.observed.ordinarySha256);
    assert.equal(guided.length, fixture.observed.coreGuidedChars);
    assert.equal(facts.sha(guided), fixture.observed.coreGuidedSha256);
    assert.ok(guided.length <= 4000);
    assert.notEqual(ordinary, guided);
    assert.equal(facts.sha(fixture.monotonicReaderChild.readerFeedback), fixture.observed.rawChildSha256);
    assert.ok(fixture.monotonicReaderChild.readerFeedback.includes(fixture.firstReaderChild.readerFeedback));
    for (const claim of fixture.firstReaderChild.rejectedReaderClaims)
        assert.ok(fixture.monotonicReaderChild.rejectedReaderClaims.includes(claim));
    for (const quote of fixture.firstReaderChild.sourceQuotes)
        assert.ok(fixture.monotonicReaderChild.sourceQuotes.includes(quote));
});

test('actual first Reader child keeps its original no-core-guidance rendering and raw path', () => {
    const first = facts.renderRealReaderFeedback(fixture.firstReaderChild, fixture.coreParent, false, null);
    assert.equal(facts.sha(first), fixture.observed.firstReaderReviewSha256);
    assert.notEqual(facts.sha(first), facts.sha(facts.renderRealReaderFeedback(
        fixture.firstReaderChild, fixture.coreParent, false, 'coreSummaryRepair')));
    assert.notEqual(facts.sha(first), facts.sha(fixture.firstReaderChild.readerFeedback));
});

test('real exact rendering changes when a core directive, quote, order or child byte changes', () => {
    for (const mutate of [
        x => { x.coreParent.coreFeedback += '字'; },
        x => { x.coreParent.sourceQuotes[0] = x.coreParent.sourceQuotes[0].slice(1); },
        x => { x.monotonicReaderChild.sourceQuotes.reverse(); },
        x => { x.monotonicReaderChild.readerFeedback += '字'; },
        x => { x.monotonicReaderChild.sourceQuotes.pop(); }
    ]) {
        const changed = structuredClone(fixture); mutate(changed);
        assert.notEqual(facts.sha(facts.renderRealReaderFeedback(changed.monotonicReaderChild,
            changed.coreParent, false, 'coreSummaryRepair')), fixture.observed.coreGuidedSha256);
    }
});

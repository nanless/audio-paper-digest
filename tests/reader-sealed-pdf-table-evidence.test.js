'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const pdf = require('../scripts/lib/reader-sealed-pdf-table-evidence');
const actualRoot = process.env.PD_GENERIC_PDF_REAL_SOURCE_ROOT;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('新PDF证据在真实来源作用域外不可伪造或泄漏', () => {
    assert.equal(pdf.evidence({ ordinal: 1, sourceDomSha256: 'a'.repeat(64) }), null);
    assert.equal(pdf.displayCell({}, 0, 0), null);
    assert.throws(() => pdf.assertProof({}, { contract: pdf.CONTRACT }), /verified source scope/);
    assert.throws(() => pdf.deriveBundle({ rootDir: '/tmp/untrusted/sources' }), /current daily/);
});

test('真实四封存来源的四个完整表精确重放，错SHA/删数/变格/跨作用域拒绝', { skip: !actualRoot }, async () => {
    const daily = require('../scripts/lib/daily-fresh-source-plan');
    const fresh = require('../scripts/lib/fresh-analysis-context');
    const runDir = path.dirname(path.resolve(actualRoot));
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json')));
    const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
    const oldFiles = ['scripts/lib/reader-pdf-cell-evidence.js', 'scripts/reader_pdf_cell_evidence.py'];
    const rules = oldFiles.map(file => sha(fs.readFileSync(path.join(__dirname, '..', file))));
    for (const id of ['2610.09334', '2610.09655']) {
        const paper = { arxivId: id }, source = daily.readDailyFreshSource(plan, paper), d = source.freshSourceDescriptor;
        const directory = path.join(actualRoot, id, 'generation-000001');
        const before = Object.fromEntries(fs.readdirSync(directory).map(name => [name, sha(fs.readFileSync(path.join(directory, name)))]));
        const expectation = { rootDir: actualRoot, arxivId: id, generation: 1,
            sourceManifestSha256: d.sourceManifestSha256, sourceSnapshotSha256: d.sourceSnapshotSha256 };
        const results = pdf.deriveBundle(expectation), eligible = results.filter(x => x.eligible);
        assert.equal(eligible.length, 2);
        assert.throws(() => pdf.deriveBundle({ ...expectation, sourceManifestSha256: 'a'.repeat(64) }), /不匹配/);
        const proof = eligible[0].evidence;
        assert.deepEqual(pdf.verifyEvidence(expectation, proof), proof);
        for (const mutate of [p => p.cells.pop(), p => p.displayMatrix[1][1] = 'fake', p => p.pdfSha256 = 'a'.repeat(64)]) {
            const changed = structuredClone(proof); mutate(changed);
            assert.throws(() => pdf.verifyEvidence(expectation, changed), /cannot be replayed/);
        }
        await daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, () => pdf.withArtifacts(source.structuredArtifacts, id, () => {
            const table = source.structuredArtifacts.tables.find(t => t.ordinal === proof.sourceTableOrdinal);
            assert.deepEqual(pdf.evidence(table), proof);
            assert.equal(pdf.displayCell(table, 1, 1), proof.displayMatrix[1][1]);
            assert.equal(pdf.assertProof(table, proof), true);
            assert.equal(pdf.evidence(structuredClone(table)), null);
            const changed = structuredClone(source.structuredArtifacts); changed.tables[0].caption += ' modified';
            assert.throws(() => pdf.withArtifacts(changed, id, () => {}), /current sealed source/);
        })));
        assert.equal(pdf.evidence(source.structuredArtifacts.tables[0]), null);
        assert.deepEqual(before, Object.fromEntries(fs.readdirSync(directory).map(name => [name, sha(fs.readFileSync(path.join(directory, name)))])));
    }
    assert.deepEqual(rules, oldFiles.map(file => sha(fs.readFileSync(path.join(__dirname, '..', file)))));
});

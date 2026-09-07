'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const api = require('../scripts/lib/historical-conference-local-sources.js');

function pdf() { return Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'); }
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-local-sources-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataRoot = path.join(root, 'data'); const current = path.join(dataRoot, 'current'); const icmlPdfs = path.join(dataRoot, 'pdfs', 'icml2026');
    const acceptedRoot = path.join(root, 'accepted'); const acceptedPdfs = path.join(acceptedRoot, 'data', 'pdfs');
    fs.mkdirSync(current, { recursive: true, mode: 0o700 }); fs.mkdirSync(icmlPdfs, { recursive: true, mode: 0o700 }); fs.mkdirSync(acceptedPdfs, { recursive: true, mode: 0o700 });
    const icasspPdf = path.join(root, 'icassp.pdf'); const iclrPdf = path.join(root, 'iclr.pdf'); const icmlId = 'AbCdef_12'; const acceptedId = 'q05hC1Pzkr';
    for (const item of [icasspPdf, iclrPdf, path.join(icmlPdfs, `${icmlId}.pdf`), path.join(acceptedPdfs, `${acceptedId}.pdf`)]) fs.writeFileSync(item, pdf(), { mode: 0o600 });
    fs.writeFileSync(path.join(current, 'icassp_2026_deep_analyzers.json'), JSON.stringify({ papers: [{ arnumber: '100', paper_id: '100', pdfPath: icasspPdf, analysis: 'old analysis must not be copied' }] }));
    fs.writeFileSync(path.join(current, 'iclr_2026_deep_analyzers.json'), JSON.stringify({ papers: [{ forum_id: 'Qwerty_1', paper_id: 'Qwerty_1', pdfPath: iclrPdf, fullText: 'old full text must not be copied' }] }));
    fs.writeFileSync(path.join(current, 'icml_2026_deep_analysis.json'), JSON.stringify({ papers: [{ id: icmlId, title: 'source title is not output' }] }));
    fs.writeFileSync(path.join(acceptedRoot, 'data', 'iclr2026_accepted.json'), JSON.stringify([{ forum_id: acceptedId, title: 'accepted title is not output' }]));
    return { root, dataRoot, acceptedRoot };
}
test('buildLocalSourcesManifest keeps only stable source coordinates and local PDF descriptors', t => {
    const f = fixture(t); const manifest = api.buildLocalSourcesManifest({ dataRoot: f.dataRoot, iclrAcceptedRoot: f.acceptedRoot });
    assert.equal(manifest.summary.canonicalPapers, 4); assert.equal(manifest.summary.directRewriteEligible, 4);
    assert.deepEqual(manifest.records.map(item => item.paperId), [
        'conference:icassp:2026:icassp-arnumber:100',
        'conference:iclr:2026:openreview-forum-id:q05hC1Pzkr',
        'conference:iclr:2026:openreview-forum-id:Qwerty_1',
        'conference:icml:2026:openreview-forum-id:AbCdef_12'
    ].sort((left, right) => left.localeCompare(right)));
    const encoded = JSON.stringify(manifest);
    assert.equal(encoded.includes('old analysis must not be copied'), false);
    assert.equal(encoded.includes('old full text must not be copied'), false);
    assert.equal(encoded.includes('source title is not output'), false);
    assert.equal(encoded.includes('accepted title is not output'), false);
    assert.equal(api.assertManifest(manifest), manifest);
});
test('collector records a missing PDF as unavailable without dropping its local metadata identity', t => {
    const f = fixture(t); fs.unlinkSync(path.join(f.root, 'icassp.pdf'));
    const manifest = api.buildLocalSourcesManifest({ dataRoot: f.dataRoot, iclrAcceptedRoot: f.acceptedRoot });
    const item = manifest.records.find(record => record.paperId === 'conference:icassp:2026:icassp-arnumber:100');
    assert.equal(item.sources[0].pdf.availability, 'missing'); assert.equal(manifest.summary.directRewriteEligible, 3);
});
test('writeManifest is immutable and recovers only byte-identical output', t => {
    const f = fixture(t); const manifest = api.buildLocalSourcesManifest({ dataRoot: f.dataRoot, iclrAcceptedRoot: f.acceptedRoot });
    const outputRoot = path.join(f.root, 'runtime'); const first = api.writeManifest({ root: outputRoot, outputName: 'sources.json', manifest });
    const second = api.writeManifest({ root: outputRoot, outputName: 'sources.json', manifest });
    assert.equal(first.status, 'created'); assert.equal(second.status, 'recovered');
});

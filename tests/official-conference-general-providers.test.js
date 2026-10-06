'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../scripts/lib/official-conference-general-providers.js');

function page({ title, authors, abstract = '', pdfUrl = null, doi = null, volume = null }) {
    return `<!doctype html><html><head>
${title === null ? '' : `<meta name="citation_title" content="${title}">`}
${authors.map(author => `<meta name="citation_author" content="${author}">`).join('\n')}
${abstract === null ? '' : `<meta name="citation_abstract" content="${abstract}">`}
${pdfUrl === null ? '' : `<meta name="citation_pdf_url" content="${pdfUrl}">`}
${doi === null ? '' : `<meta name="citation_doi" content="${doi}">`}
${volume === null ? '' : `<meta name="citation_volume" content="${volume}">`}
</head><body></body></html>`;
}

test('固定注册表列出请求的全部 2026 授权来源，且不可改动', () => {
    assert.deepEqual(Object.keys(providers.REGISTRY), [
        'aaai-2026', 'aistats-2026', 'uai-2026', 'cvpr-2026',
        'acl-2026', 'eacl-2026'
    ]);
    assert.equal(providers.REGISTRY['aistats-2026'].collections[0], 'v300');
    assert.equal(providers.REGISTRY['uai-2026'].collections[0], 'v337');
    assert.throws(() => { providers.REGISTRY['aistats-2026'].collections[0] = 'v999'; }, TypeError);
});

test('AAAI OJS 从官方文章路径推导身份，并绑定卷号、主机和 PDF 路径', () => {
    const records = providers.parseAaaiOjs({ collection: 'AAAI-volume-40', records: [{
        recordUrl: 'https://ojs.aaai.org/index.php/AAAI/article/view/41001',
        html: page({ title: 'A Title That Is Not An Identity', authors: ['Ada A.', 'Bo B.'], abstract: '  Audio   work. ',
            pdfUrl: 'https://ojs.aaai.org/index.php/AAAI/article/download/41001/43001',
            doi: '10.1609/aaai.v40i1.41001', volume: '40' })
    }] });
    assert.deepEqual(records, [{ id: '41001', title: 'A Title That Is Not An Identity', authors: ['Ada A.', 'Bo B.'],
        abstract: 'Audio work.', pdfFile: 'pdfs/41001.pdf',
        recordUrl: 'https://ojs.aaai.org/index.php/AAAI/article/view/41001',
        pdfUrl: 'https://ojs.aaai.org/index.php/AAAI/article/download/41001/43001',
        doi: '10.1609/aaai.v40i1.41001', track: 'Main' }]);
    const wrongVolume = { collection: 'AAAI-volume-40', records: [{
        recordUrl: 'https://ojs.aaai.org/index.php/AAAI/article/view/41001',
        html: page({ title: 'Paper', authors: ['Author'], volume: '39' })
    }] };
    assert.throws(() => providers.parseAaaiOjs(wrongVolume), /volume 40/);
});

test('PMLR 解析器对 AISTATS 强制 v300、对 UAI 强制 v337，并绑定记录与 PDF ID', () => {
    const aistats = providers.parsePmlr('aistats-2026', { collection: 'v300', records: [{
        recordUrl: 'https://proceedings.mlr.press/v300/smith26a.html',
        html: page({ title: 'AISTATS Paper', authors: ['Smith'], abstract: '',
            pdfUrl: 'https://proceedings.mlr.press/v300/smith26a/smith26a.pdf' })
    }] });
    assert.equal(aistats[0].id, 'smith26a');
    assert.equal(aistats[0].pdfFile, 'pdfs/smith26a.pdf');
    const uai = providers.parsePmlr('uai-2026', { collection: 'v337', records: [{
        recordUrl: 'https://proceedings.mlr.press/v337/lee26a.html',
        html: page({ title: 'UAI Paper', authors: ['Lee'],
            pdfUrl: 'https://proceedings.mlr.press/v337/lee26a/lee26a.pdf' })
    }] });
    assert.equal(uai[0].id, 'lee26a');
    assert.throws(() => providers.parsePmlr('aistats-2026', { collection: 'v337', records: [{
        recordUrl: 'https://proceedings.mlr.press/v337/lee26a.html', html: uai[0].title
    }] }), /collection/);
    const mismatchedPdf = page({ title: 'Paper', authors: ['Author'],
        pdfUrl: 'https://proceedings.mlr.press/v300/other26a/other26a.pdf' });
    assert.throws(() => providers.parsePmlr('aistats-2026', { collection: 'v300', records: [{
        recordUrl: 'https://proceedings.mlr.press/v300/smith26a.html', html: mismatchedPdf
    }] }), /identifiers differ/);
});

test('CVF 解析器只接受 CVPR 2026 主记录和 PDF 路径', () => {
    const payload = { collection: 'CVPR2026-main', records: [{
        recordUrl: 'https://openaccess.thecvf.com/content/CVPR2026/html/Smith_Audio_Model_CVPR_2026_paper.html',
        html: page({ title: 'Audio Model', authors: ['Smith'], abstract: 'Evidence.',
            pdfUrl: 'https://openaccess.thecvf.com/content/CVPR2026/papers/Smith_Audio_Model_CVPR_2026_paper.pdf',
            doi: '10.1109/CVPR.2026.12345' })
    }] };
    const records = providers.parseCvfOpenAccess(payload);
    assert.equal(records[0].id, 'Smith_Audio_Model_CVPR_2026_paper');
    const wrongHost = structuredClone(payload);
    wrongHost.records[0].recordUrl = 'https://example.org/content/CVPR2026/html/Smith_Audio_Model_CVPR_2026_paper.html';
    assert.throws(() => providers.parseCvfOpenAccess(wrongHost), /host\/path/);
    const workshop = structuredClone(payload);
    workshop.records[0].recordUrl = 'https://openaccess.thecvf.com/content/CVPR2026W/html/Smith_Audio_Model_CVPR_2026_paper.html';
    assert.throws(() => providers.parseCvfOpenAccess(workshop), /host\/path/);
});

test('ACL Anthology 绑定精确的 ACL/EACL 会议 ID、确定性 PDF 和 DOI', () => {
    const acl = providers.parseAclAnthology('acl-2026', { collection: '2026.acl-long', records: [{
        recordUrl: 'https://aclanthology.org/2026.acl-long.7/',
        html: page({ title: 'ACL Paper', authors: ['A. Linguist'], abstract: 'NLP.',
            pdfUrl: 'https://aclanthology.org/2026.acl-long.7.pdf' })
    }] });
    assert.deepEqual({ id: acl[0].id, doi: acl[0].doi, track: acl[0].track },
        { id: '2026.acl-long.7', doi: '10.18653/v1/2026.acl-long.7', track: 'Long Papers' });
    const eacl = providers.parseAclAnthology('eacl-2026', { collection: '2026.eacl-long', records: [{
        recordUrl: 'https://aclanthology.org/2026.eacl-long.2/',
        html: page({ title: 'EACL Paper', authors: ['E. Linguist'], pdfUrl: null })
    }] });
    assert.equal(eacl[0].pdfUrl, 'https://aclanthology.org/2026.eacl-long.2.pdf');
    const findings = providers.parseAclAnthology('acl-2026', { collection: '2026.findings-acl', records: [{
        recordUrl: 'https://aclanthology.org/2026.findings-acl.3/',
        html: page({ title: 'ACL Findings Paper', authors: ['F. Linguist'], pdfUrl: null })
    }] });
    assert.equal(findings[0].track, 'Findings');
    assert.throws(() => providers.parseAclAnthology('acl-2026', { collection: '2026.acl-long', records: [{
        recordUrl: 'https://aclanthology.org/2026.acl-short.7/', html: page({ title: 'Wrong volume', authors: ['A'] })
    }] }), /exact venue collection/);
});

test('PMLR 接受线上卷册所用的固定 mlresearch 原始 GitHub 发布路径', () => {
    const records = providers.parsePmlr('aistats-2026', { collection: 'v300', records: [{
        recordUrl: 'https://proceedings.mlr.press/v300/smith26a.html',
        html: page({ title: 'AISTATS Paper', authors: ['Smith'],
            pdfUrl: 'https://raw.githubusercontent.com/mlresearch/v300/main/assets/smith26a/smith26a.pdf' })
    }] });
    assert.equal(records[0].pdfUrl,
        'https://raw.githubusercontent.com/mlresearch/v300/main/assets/smith26a/smith26a.pdf');
});

test('重复 ID 只对字节等价的记录去重，冲突则拒绝；标题绝不用于合并身份', () => {
    const record = { recordUrl: 'https://proceedings.mlr.press/v300/smith26a.html',
        html: page({ title: 'AISTATS Paper', authors: ['Smith'],
            pdfUrl: 'https://proceedings.mlr.press/v300/smith26a/smith26a.pdf' }) };
    const deduped = providers.parsePmlr('aistats-2026', { collection: 'v300',
        records: [structuredClone(record), structuredClone(record)] });
    assert.equal(deduped.length, 1);
    const conflicting = structuredClone(record); conflicting.html = page({ title: 'Changed title', authors: ['Smith'],
        pdfUrl: 'https://proceedings.mlr.press/v300/smith26a/smith26a.pdf' });
    assert.throws(() => providers.parsePmlr('aistats-2026', { collection: 'v300',
        records: [record, conflicting] }), /duplicate official paper ID.*conflicting/);
});

test('快照输出可被官方论文集发现结构直接消费', () => {
    const snapshot = providers.parseConferenceSnapshot('aistats-2026', { collection: 'v300', records: [{
        recordUrl: 'https://proceedings.mlr.press/v300/smith26a.html',
        html: page({ title: 'AISTATS Paper', authors: ['Smith'],
            pdfUrl: 'https://proceedings.mlr.press/v300/smith26a/smith26a.pdf' })
    }] });
    assert.deepEqual(snapshot.conference, { id: 'aistats-2026', year: 2026 });
    assert.deepEqual(Object.keys(snapshot).sort(), ['conference', 'papers']);
    assert.deepEqual(Object.keys(snapshot.papers[0]).sort(), [...providers.PAPER_FIELDS].sort());
});

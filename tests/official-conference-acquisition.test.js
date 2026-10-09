'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const acquisition = require('../scripts/lib/official-conference-acquisition.js');
const cli = require('../scripts/official-conference-acquire.js');

const ODYSSEY_ENTRY = `<div class="w3-container" data-track="speaker recognition">
<a class="w3-text" href="alpha26_odyssey.html"><p>Robust Speaker Verification<br>
<span class="w3-text w3-text-theme">Alice Example, Bob Example</span></p></a>
<a href="https://doi.org/10.21437/Odyssey.2026-1">DOI</a></div>`;
const ODYSSEY_FIXTURE = `<!doctype html><main>${ODYSSEY_ENTRY}</main>`;
const ODYSSEY_TWO_FIXTURE = `<!doctype html><main>${ODYSSEY_ENTRY}
<div class="w3-container"><a class="w3-text" href="beta26_odyssey.html"><p>Second Paper<br>
<span class="w3-text w3-text-theme">Carol Example</span></p></a></div></main>`;
const ISCA_ENTRY = `<div class="w3-card"><h4>Oral Session</h4>
<a class="w3-text" href="alpha26_SUFFIX.html"><p>Robust Speech Processing<br>
<span class="w3-text w3-text-theme">Alice Example, Bob Example</span></p></a>
<a href="https://doi.org/10.21437/CONFERENCE.2026-1">DOI</a></div>`;

const FIXTURES = Object.freeze({
    'odyssey-2026': ODYSSEY_FIXTURE,
    'chime-2026': `<!doctype html>${ISCA_ENTRY.replaceAll('SUFFIX', 'chime')}`,
    'jep-2026': `<!doctype html>${ISCA_ENTRY.replaceAll('SUFFIX', 'jep')}`,
    'speechprosody-2026': `<!doctype html>${ISCA_ENTRY.replaceAll('SUFFIX', 'speechprosody')}`,
    'interspeech-2026': `<!doctype html>${ISCA_ENTRY.replaceAll('SUFFIX', 'interspeech')}`,
    'iwslt-2026': `<!doctype html><article class="acl-paper" data-track="shared task">
<a class="title" href="/2026.iwslt-1.1/">Simultaneous Translation</a>
<div class="acl-paper-authors"><a>Alice Example</a><a>Bob Example</a></div>
<div class="abstract">Translation evidence.</div></article>`,
    'eusipco-2026': `<!doctype html><div class="card-body"><p class="my-1"><strong>
<a href="../../pdfs/0000001.pdf">ASMSP-L1.2: Audio Signal Analysis</a></strong></p><p class="my-0">
<a href="../author-index/index.html#1">Alice Example</a></p></div>`,
    'nime-2026': `<!doctype html><h3>2026</h3><ul><li>Alice Example, and Bob Example. 2026.
<a class="title" href="/proc/nime2026_1/index.html">Embodied Music Interface.</a>
<a href="https://doi.org/10.5281/zenodo.1234567">DOI</a>
<a href="http://nime.org/proceedings/2026/nime2026_1.pdf">PDF</a></li></ul>`,
    'dafx-2026': `<!doctype html><table><tr><td><div class="s-name">Paper Session 1: Reverb</div>
<div class="paper-list"><div class="paper-item"><div class="p-title">Differentiable Audio Effect</div>
<div class="p-authors">Alice Example, Bob Example and Carol Example</div>
<div class="p-pdf"><a href="/assets/papers/DAFx26_paper_15.pdf">PDF</a></div>
<div class="p-abstract">Audio evidence.</div></div></div></td></tr></table>`,
    'aistats-2026': `<!doctype html><main>
<a href="/v300/v300.pdf">Download the complete volume</a><a href="/v300/frontmatter.pdf">Front matter</a>
<div class="paper"><p class="title">Reliable Learning</p><p class="authors">
<a>Alice Example</a>, <a>Bob Example</a></p><p class="links">
<a href="/v300/smith26a.html">abs</a>
<a href="https://raw.githubusercontent.com/mlresearch/v300/main/assets/smith26a/smith26a.pdf">Download PDF</a>
</p></div></main>`,
    'uai-2026': `<!doctype html><main><div class="paper"><p class="title">Uncertain Inference</p>
<p class="authors"><a>Uma Example</a></p><p class="links"><a href="/v337/uma26a.html">abs</a>
<a href="/v337/uma26a/uma26a.pdf">Download PDF</a></p></div></main>`,
    'cvpr-2026': `<!doctype html><dl><dt class="ptitle"><a href="/content/CVPR2026/html/Smith_Vision_Model_CVPR_2026_paper.html">
Vision Model</a></dt><dd>Alice Vision, Bob Vision<br>
<a href="/content/CVPR2026/papers/Smith_Vision_Model_CVPR_2026_paper.pdf">pdf</a></dd></dl>`,
    'acl-2026': `<!doctype html><main>
<article class="d-sm-flex"><a class="title" href="/2026.acl-long.1/">Long Paper</a>
<div class="acl-paper-authors"><a href="/people/a/author/">Alice NLP</a></div></article>
<article class="d-sm-flex"><a class="title" href="/2026.acl-short.2/">Short Paper</a>
<div class="acl-paper-authors"><a href="/people/b/author/">Bob NLP</a></div></article>
<article class="d-sm-flex"><a class="title" href="/2026.findings-acl.3/">Findings Paper</a>
<div class="acl-paper-authors"><a href="/people/c/author/">Carol NLP</a></div></article>
<article class="d-sm-flex"><a class="title" href="/2026.acl-demo.4/">Excluded Demo</a>
<div class="acl-paper-authors"><a href="/people/d/author/">Demo Author</a></div></article></main>`,
    'eacl-2026': `<!doctype html><main><article class="d-sm-flex">
<a class="title" href="/2026.eacl-long.1/">EACL Long Paper</a>
<div class="acl-paper-authors"><a href="/people/e/author/">Eve NLP</a></div></article>
<article class="d-sm-flex"><a class="title" href="/2026.findings-eacl.2/">EACL Findings</a>
<div class="acl-paper-authors"><a href="/people/f/author/">Frank NLP</a></div></article></main>`
});

function aaaiIssueFixture(issue, { paperId = String(40000 + issue.number), galleyId = String(50000 + issue.number) } = {}) {
    return `<!doctype html><main><h1>Vol. 40 No. ${issue.number}: ${issue.title}</h1>
<div class="sections"><div class="section"><h2>Fixed Track ${issue.number}</h2><ul><li>
<div class="obj_article_summary"><h3 class="title">
<a id="article-${paperId}" href="https://ojs.aaai.org/index.php/AAAI/article/view/${paperId}">Paper ${issue.number}</a>
</h3><div class="meta"><div class="authors">Alice ${issue.number}, Bob ${issue.number}</div></div>
<ul class="galleys_links"><li><a class="obj_galley_link pdf"
href="https://ojs.aaai.org/index.php/AAAI/article/view/${paperId}/${galleyId}">PDF</a></li></ul>
</div></li></ul></div></div></main>`;
}

function assertCoreSchema(metadata, providerId) {
    assert.deepEqual(Object.keys(metadata).sort(), ['conference', 'papers']);
    assert.deepEqual(Object.keys(metadata.conference).sort(), ['id', 'year']);
    assert.equal(metadata.conference.id, providerId);
    assert.equal(metadata.conference.year, 2026);
    assert.ok(metadata.papers.length > 0);
    for (const paper of metadata.papers) {
        assert.deepEqual(Object.keys(paper).sort(), [
            'abstract', 'authors', 'doi', 'id', 'pdfFile', 'pdfUrl', 'recordUrl', 'title', 'track'
        ]);
        assert.match(paper.id, /^[A-Za-z0-9._-]{1,200}$/u);
        assert.equal(paper.pdfFile, `pdfs/${paper.id}.pdf`);
        assert.match(paper.recordUrl, /^https:\/\//u);
        assert.match(paper.pdfUrl, /^https:\/\//u);
        assert.ok(paper.title);
        assert.ok(paper.authors.length > 0);
        assert.equal(new Set(paper.authors).size, paper.authors.length);
    }
}

function httpResponse(body, contentType, status = 200, extraHeaders = {}) {
    return new Response(body, { status, headers: { 'content-type': contentType, ...extraHeaders } });
}

function dependencies(fetchImpl) {
    return {
        detectProxy: () => 'http://127.0.0.1:7890',
        createDispatcher: proxy => ({ proxy }),
        fetchImpl,
        now: () => '2026-09-09T00:00:00.000Z'
    };
}

function temporaryRoot(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'official-conference-acquisition-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    return { base, outputRoot: path.join(base, 'run') };
}

test('所有固定来源适配器都能从单个索引页面的测试样例数据产出严格的核心元数据结构', () => {
    for (const [providerId, fixture] of Object.entries(FIXTURES)) {
        const metadata = acquisition.parseCatalog(providerId, fixture);
        assertCoreSchema(metadata, providerId);
    }
    const odyssey = acquisition.parseCatalog('odyssey-2026', FIXTURES['odyssey-2026']).papers[0];
    assert.deepEqual(odyssey.authors, ['Alice Example', 'Bob Example']);
    assert.equal(odyssey.doi, '10.21437/Odyssey.2026-1');
    assert.equal(odyssey.track, 'speaker recognition');
    for (const providerId of ['chime-2026', 'jep-2026', 'speechprosody-2026', 'interspeech-2026']) {
        const paper = acquisition.parseCatalog(providerId, FIXTURES[providerId]).papers[0];
        assert.equal(paper.title, 'Robust Speech Processing');
        assert.deepEqual(paper.authors, ['Alice Example', 'Bob Example']);
        assert.equal(paper.track, 'Oral Session');
    }
    const iwslt = acquisition.parseCatalog('iwslt-2026', FIXTURES['iwslt-2026']).papers[0];
    assert.equal(iwslt.id, '2026.iwslt-1.1');
    assert.equal(iwslt.doi, '10.18653/v1/2026.iwslt-1.1');
    const eusipco = acquisition.parseCatalog('eusipco-2026', FIXTURES['eusipco-2026']).papers[0];
    assert.equal(eusipco.title, 'Audio Signal Analysis');
    assert.equal(eusipco.recordUrl, acquisition.PROVIDERS['eusipco-2026'].indexUrl);
    const nime = acquisition.parseCatalog('nime-2026', FIXTURES['nime-2026']).papers[0];
    assert.equal(nime.doi, '10.5281/zenodo.1234567');
    const dafx = acquisition.parseCatalog('dafx-2026', FIXTURES['dafx-2026']).papers[0];
    assert.deepEqual(dafx.authors, ['Alice Example', 'Bob Example', 'Carol Example']);
    assert.equal(dafx.track, 'Paper Session 1: Reverb');
    assert.equal(dafx.recordUrl, 'https://dafx26.mit.edu/program/');
    const aistats = acquisition.parseCatalog('aistats-2026', FIXTURES['aistats-2026']);
    assert.deepEqual(aistats.papers.map(paper => paper.id), ['smith26a']);
    assert.equal(aistats.papers[0].recordUrl, 'https://proceedings.mlr.press/v300/smith26a.html');
    assert.equal(aistats.papers[0].pdfUrl,
        'https://raw.githubusercontent.com/mlresearch/v300/main/assets/smith26a/smith26a.pdf');
    assert.deepEqual(acquisition.parseCatalog('uai-2026', FIXTURES['uai-2026']).papers.map(paper => paper.id), ['uma26a']);
    assert.deepEqual(acquisition.parseCatalog('cvpr-2026', FIXTURES['cvpr-2026']).papers[0].authors,
        ['Alice Vision', 'Bob Vision']);
    assert.deepEqual(acquisition.parseCatalog('acl-2026', FIXTURES['acl-2026']).papers.map(paper => paper.track),
        ['Long Papers', 'Short Papers', 'Findings']);
    assert.deepEqual(acquisition.parseCatalog('eacl-2026', FIXTURES['eacl-2026']).papers.map(paper => paper.track),
        ['Long Papers', 'Findings']);
});

test('AAAI 固定卷 40 的 48 个不连续期号，拒绝把单个期号当作论文集目录', () => {
    const provider = acquisition.PROVIDERS['aaai-2026'];
    assert.equal(provider.archiveUrl, 'https://ojs.aaai.org/index.php/AAAI/issue/archive');
    assert.equal(provider.issues.length, 48);
    assert.deepEqual(provider.issues.map(issue => issue.issueId), [
        683, 684, 685, 686, 687, 733, 688, 689, 690, 691, 692, 693,
        694, 695, 696, 697, 698, 699, 700, 701, 702, 703, 704, 705,
        707, 708, 709, 710, 711, 712, 713, 714, 715, 716, 717, 718,
        719, 720, 721, 722, 723, 724, 725, 726, 727, 728, 729, 732
    ]);
    assert.equal(acquisition.validateFetchUrl(provider, provider.issues[5].url, 'index'), provider.issues[5].url);
    assert.throws(() => acquisition.validateFetchUrl(provider,
        'https://ojs.aaai.org/index.php/AAAI/issue/current', 'index'), /fixed official URL/u);
    assert.throws(() => acquisition.validateFetchUrl(provider,
        'https://ojs.aaai.org/index.php/AAAI/issue/view/706', 'index'), /fixed official URL/u);
    const first = acquisition.parseAaaiIssue('aaai-2026', 1, aaaiIssueFixture(provider.issues[0]));
    assert.deepEqual(first[0], {
        id: '40001', title: 'Paper 1', authors: ['Alice 1', 'Bob 1'], abstract: '',
        pdfFile: 'pdfs/40001.pdf',
        recordUrl: 'https://ojs.aaai.org/index.php/AAAI/article/view/40001',
        pdfUrl: 'https://ojs.aaai.org/index.php/AAAI/article/view/40001/50001',
        doi: null, track: 'Fixed Track 1'
    });
    const repeatedDisplayName = acquisition.parseAaaiIssue('aaai-2026', 1,
        aaaiIssueFixture(provider.issues[0]).replace('Alice 1, Bob 1', 'Alice 1, Bob 1, Alice 1'));
    assert.deepEqual(repeatedDisplayName[0].authors, ['Alice 1', 'Bob 1']);
    assert.throws(() => acquisition.parseCatalog('aaai-2026', aaaiIssueFixture(provider.issues[0])),
        /all 48 fixed issue snapshots/u);
    assert.throws(() => acquisition.parseAaaiIssue('aaai-2026', 1,
        aaaiIssueFixture(provider.issues[0]).replace('Vol. 40 No. 1', 'Vol. 40 No. 2')), /identity differs/u);
    assert.throws(() => acquisition.parseAaaiIssue('aaai-2026', 1,
        aaaiIssueFixture(provider.issues[0]).replace('/40001/50001', '/40002/50001')), /PDF identity differs/u);
    const view = 'https://ojs.aaai.org/index.php/AAAI/article/view/40001/50001';
    const download = 'https://ojs.aaai.org/index.php/AAAI/article/download/40001/50001';
    assert.equal(acquisition.validateRedirectTarget(provider, view, download, 'pdf'), download);
    assert.throws(() => acquisition.validateFetchUrl(provider, download, 'pdf'), /official proceedings path/u);
    assert.throws(() => acquisition.validateRedirectTarget(provider, view,
        'https://ojs.aaai.org/index.php/AAAI/article/download/40002/50001', 'pdf'), /article or galley identity/u);
    assert.throws(() => acquisition.validateRedirectTarget(provider, view,
        'https://ojs.aaai.org/index.php/AAAI/article/download/40001/50002', 'pdf'), /article or galley identity/u);
    assert.throws(() => acquisition.validateRedirectTarget(provider, view,
        'https://mirror.example/index.php/AAAI/article/download/40001/50001', 'pdf'), /same-host view-to-download/u);
    assert.throws(() => acquisition.validateRedirectTarget(provider, download, view, 'pdf'), /view-to-download/u);
});

test('CVF 在没有可见链接时按同名文件推出精确的官方 PDF', () => {
    const html = `<!doctype html><dl><dt class="ptitle"><a href="/content/CVPR2026/html/Xiao_Audio_CVPR_2026_paper.html">Audio</a></dt>
<dd>Ada Example<br></dd></dl>`;
    const paper = acquisition.parseCatalog('cvpr-2026', html).papers[0];
    assert.equal(paper.pdfUrl,
        'https://openaccess.thecvf.com/content/CVPR2026/papers/Xiao_Audio_CVPR_2026_paper.pdf');
});

test('新增来源的索引、记录和 PDF 白名单都是精确的，排除卷目录和前置页产物', () => {
    assert.deepEqual({ aistats: acquisition.PROVIDERS['aistats-2026'].indexUrl,
        uai: acquisition.PROVIDERS['uai-2026'].indexUrl,
        cvpr: acquisition.PROVIDERS['cvpr-2026'].indexUrl,
        acl: acquisition.PROVIDERS['acl-2026'].indexUrl,
        eacl: acquisition.PROVIDERS['eacl-2026'].indexUrl }, {
        aistats: 'https://proceedings.mlr.press/v300/',
        uai: 'https://proceedings.mlr.press/v337/',
        cvpr: 'https://openaccess.thecvf.com/CVPR2026?day=all',
        acl: 'https://aclanthology.org/events/acl-2026/',
        eacl: 'https://aclanthology.org/events/eacl-2026/'
    });
    const pmlr = acquisition.PROVIDERS['aistats-2026'];
    assert.equal(acquisition.validateFetchUrl(pmlr,
        'https://raw.githubusercontent.com/mlresearch/v300/main/assets/smith26a/smith26a.pdf', 'pdf'),
    'https://raw.githubusercontent.com/mlresearch/v300/main/assets/smith26a/smith26a.pdf');
    for (const value of [
        'https://raw.githubusercontent.com/mlresearch/v337/main/assets/smith26a/smith26a.pdf',
        'https://raw.githubusercontent.com/mlresearch/v300/other/assets/smith26a/smith26a.pdf',
        'https://proceedings.mlr.press/v300/v300.pdf',
        'https://proceedings.mlr.press/v300/frontmatter.pdf'
    ]) assert.throws(() => acquisition.validateFetchUrl(pmlr, value, 'pdf'), /allowlist|path/u);
    assert.throws(() => acquisition.validateFetchUrl(pmlr,
        'https://raw.githubusercontent.com/mlresearch/v300/main/assets/smith26a/smith26a.html', 'record'), /allowlist|path/u);
    assert.deepEqual(acquisition.parseCatalog('aistats-2026', FIXTURES['aistats-2026']).papers.map(paper => paper.id),
        ['smith26a']);
    assert.throws(() => acquisition.parseCatalog('aistats-2026', FIXTURES['uai-2026']), /non-empty|metadata|papers/u);
});

test('Odyssey 排除没有论文集 PDF 的主旨报告摘要页', () => {
    const html = `${ODYSSEY_FIXTURE}<div class="w3-card"><div class="w3-container">
<h4>Keynote: Invited Speech</h4><a href="speaker26_odyssey.html">Invited Speech</a>
</div></div>`;
    const metadata = acquisition.parseCatalog('odyssey-2026', html);
    assert.deepEqual(metadata.papers.map(paper => paper.id), ['alpha26_odyssey']);
});

test('Interspeech 解析 ISCA 索引结构，排除主旨报告摘要页', () => {
    const html = `<!doctype html><main>${ISCA_ENTRY.replaceAll('SUFFIX', 'interspeech')}
<div class="w3-card"><h4>Keynote1 - Invited Talk</h4>
<a class="w3-text" href="speaker26_interspeech.html"><p>Invited Talk<br>
<span class="w3-text w3-text-theme">Carol Example</span></p></a></div></main>`;
    const metadata = acquisition.parseCatalog('interspeech-2026', html);
    assert.deepEqual(metadata.papers.map(paper => paper.id), ['alpha26_interspeech']);
    assert.equal(metadata.papers[0].pdfUrl,
        'https://www.isca-archive.org/interspeech_2026/alpha26_interspeech.pdf');
    assert.equal(metadata.conference.id, 'interspeech-2026');
});

test('Interspeech 白名单只接受固定的 ISCA 索引、记录和 PDF 路径', () => {
    const provider = acquisition.PROVIDERS['interspeech-2026'];
    assert.equal(acquisition.validateFetchUrl(provider,
        'https://www.isca-archive.org/interspeech_2026/chen26q_interspeech.pdf', 'pdf'),
    'https://www.isca-archive.org/interspeech_2026/chen26q_interspeech.pdf');
    assert.equal(acquisition.validateFetchUrl(provider, provider.indexUrl, 'index'), provider.indexUrl);
    for (const value of [
        'http://www.isca-archive.org/interspeech_2026/chen26q_interspeech.pdf',
        'https://mirror.example/interspeech_2026/chen26q_interspeech.pdf',
        'https://www.isca-archive.org/interspeech_2026/chen26q_interspeech.pdf?download=1',
        'https://www.isca-archive.org/odyssey_2026/chen26q_interspeech.pdf',
        'https://www.isca-archive.org/interspeech_2026/chen26q_odyssey.pdf'
    ]) assert.throws(() => acquisition.validateFetchUrl(provider, value, 'pdf'), /rejected/u);
    assert.throws(() => acquisition.validateFetchUrl(provider,
        'https://www.isca-archive.org/odyssey_2026/index.html', 'index'), /rejected/u);
});

test('DAFx 只在官方 PDF 身份和元数据一致时才合并重复的日程条目', () => {
    const item = `<div class="paper-item"><div class="p-title">Differentiable Audio Effect</div>
<div class="p-authors">Alice Example, Bob Example and Carol Example</div>
<div class="p-pdf"><a href="/assets/papers/DAFx26_paper_15.pdf">PDF</a></div>
<div class="p-abstract">Audio evidence.</div></div>`;
    const duplicate = `<!doctype html><table><tr><td><div class="s-name">Paper Session</div>${item}${item}</td></tr></table>`;
    assert.equal(acquisition.parseCatalog('dafx-2026', duplicate).papers.length, 1);
    const conflicting = duplicate.replace(item, item.replace('Differentiable Audio Effect', 'Changed Title'));
    assert.throws(() => acquisition.parseCatalog('dafx-2026', conflicting), /conflicting title/u);
    const provider = acquisition.PROVIDERS['dafx-2026'];
    assert.equal(acquisition.validateFetchUrl(provider,
        'https://dafx26.mit.edu/assets/papers/DAFx26_demo_57.pdf', 'pdf'),
    'https://dafx26.mit.edu/assets/papers/DAFx26_demo_57.pdf');
});

test('HTTPS 来源白名单拒绝镜像站、HTTP、带查询串和不相干的官方路径', () => {
    const provider = acquisition.PROVIDERS['iwslt-2026'];
    assert.equal(acquisition.validateFetchUrl(provider, 'https://aclanthology.org/2026.iwslt-1.1.pdf', 'pdf'),
        'https://aclanthology.org/2026.iwslt-1.1.pdf');
    for (const value of [
        'http://aclanthology.org/2026.iwslt-1.1.pdf',
        'https://mirror.example/2026.iwslt-1.1.pdf',
        'https://aclanthology.org/2026.iwslt-1.1.pdf?download=1',
        'https://aclanthology.org/2026.acl-long.1.pdf'
    ]) assert.throws(() => acquisition.validateFetchUrl(provider, value, 'pdf'), /rejected/u);
});

test('目录预演只列出计划保存的文件，不创建输出目录', async t => {
    const { outputRoot } = temporaryRoot(t);
    const result = await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: false });
    assert.equal(result.mode, 'dry-run');
    assert.equal(fs.existsSync(outputRoot), false);
    assert.deepEqual(result.writes, ['responses/index.html', 'responses/index.receipt.json',
        'metadata.json', 'catalog.receipt.json']);
});

test('AAAI 目录先把每个期号独立保存并核验、再复核，然后才给出完整论文集合', async t => {
    const { outputRoot } = temporaryRoot(t); const provider = acquisition.PROVIDERS['aaai-2026'];
    const dryRun = await acquisition.acquireCatalog({ providerId: 'aaai-2026', outputRoot, apply: false });
    assert.equal(dryRun.issueCount, 48);
    assert.equal(dryRun.indexUrls.length, 48);
    assert.deepEqual(dryRun.writes, { issueResponses: 48, issueReceipts: 48,
        metadata: 'metadata.json', catalogReceipt: 'catalog.receipt.json' });
    assert.equal(fs.existsSync(outputRoot), false);
    const calls = [];
    const result = await acquisition.acquireCatalog({ providerId: 'aaai-2026', outputRoot, apply: true },
        dependencies(async url => {
            calls.push(url);
            const issue = provider.issues.find(candidate => candidate.url === url);
            assert.ok(issue);
            return httpResponse(aaaiIssueFixture(issue), 'text/html; charset=utf-8');
        }));
    assert.equal(result.issues, 48); assert.equal(result.papers, 48); assert.deepEqual(calls, provider.issues.map(issue => issue.url));
    assert.equal(result.writes.issueResponsesCreated, 48); assert.equal(result.writes.issueReceiptsCreated, 48);
    const metadata = JSON.parse(fs.readFileSync(path.join(outputRoot, 'metadata.json'), 'utf8'));
    assertCoreSchema(metadata, 'aaai-2026'); assert.equal(metadata.papers.length, 48);
    const receipt = JSON.parse(fs.readFileSync(path.join(outputRoot, 'catalog.receipt.json'), 'utf8'));
    assert.equal(receipt.issues.length, 48); assert.match(receipt.issueManifestSha256, /^[a-f0-9]{64}$/u);
    for (const issue of provider.issues) {
        const stem = `issue-${String(issue.number).padStart(2, '0')}-${issue.issueId}`;
        for (const suffix of ['.html', '.receipt.json']) {
            const filename = path.join(outputRoot, 'responses', 'issues', `${stem}${suffix}`);
            assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
        }
    }
    assert.deepEqual(acquisition.acquisitionStatus({ providerId: 'aaai-2026', outputRoot }), {
        command: 'status', providerId: 'aaai-2026', outputRoot, catalog: 'complete', total: 48,
        downloadable: 48, downloaded: 0, missing: 48, partial: 0, complete: false,
        issuesExpected: 48, issuesSealed: 48
    });
    assert.equal(acquisition.verifyAcquisition({ providerId: 'aaai-2026', outputRoot }).papers, 48);
    const resumed = await acquisition.acquireCatalog({ providerId: 'aaai-2026', outputRoot, apply: true },
        dependencies(async () => { throw new Error('resume must not use network'); }));
    assert.equal(resumed.writes.issueResponsesRecovered, 48);
    assert.equal(resumed.writes.issueReceiptsRecovered, 48);
    const firstIssueFile = path.join(outputRoot, 'responses', 'issues', 'issue-01-683.html');
    fs.writeFileSync(firstIssueFile, `${fs.readFileSync(firstIssueFile, 'utf8')} `);
    assert.throws(() => acquisition.replayCatalog('aaai-2026', outputRoot), /differs from receipt/u);
});

test('AAAI 目录中断时保留已保存并核验的期号配对，但在 48 个期号全部收齐前仍是部分完成', async t => {
    const { outputRoot } = temporaryRoot(t); const provider = acquisition.PROVIDERS['aaai-2026']; let calls = 0;
    await assert.rejects(acquisition.acquireCatalog({ providerId: 'aaai-2026', outputRoot, apply: true },
        dependencies(async url => {
            calls += 1;
            if (calls === 2) throw new Error('simulated archive interruption');
            const issue = provider.issues.find(candidate => candidate.url === url);
            return httpResponse(aaaiIssueFixture(issue), 'text/html');
        })), /simulated archive interruption/u);
    assert.equal(fs.existsSync(path.join(outputRoot, 'metadata.json')), false);
    const status = acquisition.acquisitionStatus({ providerId: 'aaai-2026', outputRoot });
    assert.equal(status.catalog, 'partial'); assert.equal(status.issuesSealed, 1); assert.equal(status.issuesExpected, 48);
    let resumedCalls = 0;
    const completed = await acquisition.acquireCatalog({ providerId: 'aaai-2026', outputRoot, apply: true },
        dependencies(async url => {
            resumedCalls += 1;
            const issue = provider.issues.find(candidate => candidate.url === url);
            return httpResponse(aaaiIssueFixture(issue), 'text/html');
        }));
    assert.equal(resumedCalls, 47); assert.equal(completed.writes.issueResponsesRecovered, 1);
});

test('同一个稳定论文 ID 跨期号重复时，AAAI 目录直接失败', async t => {
    const { outputRoot } = temporaryRoot(t); const provider = acquisition.PROVIDERS['aaai-2026'];
    await assert.rejects(acquisition.acquireCatalog({ providerId: 'aaai-2026', outputRoot, apply: true },
        dependencies(async url => {
            const issue = provider.issues.find(candidate => candidate.url === url);
            return httpResponse(aaaiIssueFixture(issue, { paperId: '49999', galleyId: String(50000 + issue.number) }),
                'text/html');
        })), /duplicate official paper ID across AAAI issues 1 and 2: 49999/u);
    assert.equal(fs.existsSync(path.join(outputRoot, 'metadata.json')), false);
});

test('AAAI 的 PDF 下载只跟随一次保持身份的 OJS 查看转下载重定向', async t => {
    const { outputRoot } = temporaryRoot(t); const provider = acquisition.PROVIDERS['aaai-2026'];
    await acquisition.acquireCatalog({ providerId: 'aaai-2026', outputRoot, apply: true },
        dependencies(async url => {
            const issue = provider.issues.find(candidate => candidate.url === url);
            return httpResponse(aaaiIssueFixture(issue), 'text/html');
        }));
    const requested = [];
    const result = await acquisition.downloadPapers({ providerId: 'aaai-2026', outputRoot,
        apply: true, limit: 1 }, dependencies(async url => {
        requested.push(url);
        if (url === 'https://ojs.aaai.org/index.php/AAAI/article/view/40001/50001') {
            return httpResponse('', 'text/plain', 302,
                { location: '/index.php/AAAI/article/download/40001/50001' });
        }
        assert.equal(url, 'https://ojs.aaai.org/index.php/AAAI/article/download/40001/50001');
        return httpResponse('%PDF-aaai', 'application/pdf');
    }));
    assert.deepEqual(requested, [
        'https://ojs.aaai.org/index.php/AAAI/article/view/40001/50001',
        'https://ojs.aaai.org/index.php/AAAI/article/download/40001/50001'
    ]);
    assert.equal(result.downloaded, 1); assert.equal(result.missing, 47);
    const verified = acquisition.verifyAcquisition({ providerId: 'aaai-2026', outputRoot });
    assert.equal(verified.verified, 1); assert.equal(verified.missing.length, 47);
});

test('目录实际执行把响应和元数据以 0600 保存并核验，之后不联网也能续跑', async t => {
    const { outputRoot } = temporaryRoot(t); let calls = 0;
    const deps = dependencies(async url => {
        calls += 1;
        assert.equal(url, acquisition.PROVIDERS['odyssey-2026'].indexUrl);
        return httpResponse(ODYSSEY_FIXTURE, 'text/html; charset=utf-8');
    });
    const first = await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true }, deps);
    assert.equal(first.papers, 1);
    assert.equal(calls, 1);
    for (const relative of ['responses/index.html', 'responses/index.receipt.json', 'metadata.json', 'catalog.receipt.json']) {
        assert.equal(fs.statSync(path.join(outputRoot, relative)).mode & 0o777, 0o600);
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(outputRoot, 'metadata.json'), 'utf8'));
    assertCoreSchema(metadata, 'odyssey-2026');
    const second = await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true }, deps);
    assert.equal(second.writes.metadata, 'recovered');
    assert.equal(calls, 1);
});

test('PMLR 的 GitHub 原始 PDF 会走完目录、下载、状态、凭证复核和校验', async t => {
    const { outputRoot } = temporaryRoot(t); const requested = [];
    const deps = dependencies(async url => {
        requested.push(url);
        if (url === acquisition.PROVIDERS['aistats-2026'].indexUrl) {
            return httpResponse(FIXTURES['aistats-2026'], 'text/html; charset=utf-8');
        }
        assert.equal(url, 'https://raw.githubusercontent.com/mlresearch/v300/main/assets/smith26a/smith26a.pdf');
        return httpResponse('%PDF-aistats', 'application/octet-stream');
    });
    const catalog = await acquisition.acquireCatalog({ providerId: 'aistats-2026', outputRoot, apply: true }, deps);
    assert.equal(catalog.papers, 1);
    assert.deepEqual(acquisition.acquisitionStatus({ providerId: 'aistats-2026', outputRoot }), {
        command: 'status', providerId: 'aistats-2026', outputRoot, catalog: 'complete', total: 1,
        downloadable: 1, downloaded: 0, missing: 1, partial: 0, complete: false
    });
    const download = await acquisition.downloadPapers({ providerId: 'aistats-2026', outputRoot, apply: true }, deps);
    assert.equal(download.complete, true);
    assert.equal(acquisition.acquisitionStatus({ providerId: 'aistats-2026', outputRoot }).downloaded, 1);
    const verified = acquisition.verifyAcquisition({ providerId: 'aistats-2026', outputRoot });
    assert.equal(verified.complete, true); assert.equal(verified.verified, 1);
    assert.deepEqual(requested, [acquisition.PROVIDERS['aistats-2026'].indexUrl,
        'https://raw.githubusercontent.com/mlresearch/v300/main/assets/smith26a/smith26a.pdf']);
});

test('PDF 下载在失败后保留已保存并核验的进度，手动跟随白名单重定向，并校验 SHA 凭证', async t => {
    const { outputRoot } = temporaryRoot(t);
    await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true },
        dependencies(async () => httpResponse(ODYSSEY_TWO_FIXTURE, 'text/html')));
    let firstAttemptCalls = 0;
    await assert.rejects(acquisition.downloadPapers({ providerId: 'odyssey-2026', outputRoot, apply: true },
        dependencies(async url => {
            firstAttemptCalls += 1;
            if (url.endsWith('/alpha26_odyssey.pdf')) return httpResponse('%PDF-alpha', 'application/pdf');
            throw new Error('simulated interruption');
        })), /simulated interruption/u);
    assert.equal(firstAttemptCalls, 2);
    assert.equal(acquisition.acquisitionStatus({ providerId: 'odyssey-2026', outputRoot }).downloaded, 1);
    let resumedCalls = 0;
    const result = await acquisition.downloadPapers({ providerId: 'odyssey-2026', outputRoot, apply: true },
        dependencies(async url => {
            resumedCalls += 1;
            if (url.endsWith('/beta26_odyssey.pdf')) {
                return httpResponse('', 'text/plain', 302, { location: '/odyssey_2026/beta26_redirect_odyssey.pdf' });
            }
            assert.ok(url.endsWith('/beta26_redirect_odyssey.pdf'));
            return httpResponse('%PDF-beta', 'application/pdf');
        }));
    assert.equal(resumedCalls, 2);
    assert.equal(result.complete, true);
    assert.equal(result.downloaded, 2);
    for (const relative of ['pdfs/alpha26_odyssey.pdf', 'pdfs/beta26_odyssey.pdf',
        'receipts/alpha26_odyssey.json', 'receipts/beta26_odyssey.json']) {
        assert.equal(fs.statSync(path.join(outputRoot, relative)).mode & 0o777, 0o600);
    }
    const verified = acquisition.verifyAcquisition({ providerId: 'odyssey-2026', outputRoot });
    assert.equal(verified.complete, true);
    assert.equal(verified.verified, 2);
    fs.writeFileSync(path.join(outputRoot, 'pdfs/beta26_odyssey.pdf'), '%PDF-tampered');
    assert.throws(() => acquisition.verifyAcquisition({ providerId: 'odyssey-2026', outputRoot }), /differs from receipt/u);
});

test('下载预演和校验报告目录不完整，但不写 PDF', async t => {
    const { outputRoot } = temporaryRoot(t);
    await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true },
        dependencies(async () => httpResponse(ODYSSEY_FIXTURE, 'text/html')));
    const dryRun = await acquisition.downloadPapers({ providerId: 'odyssey-2026', outputRoot, apply: false });
    assert.equal(dryRun.pending, 1);
    assert.equal(fs.readdirSync(path.join(outputRoot, 'pdfs')).length, 0);
    const verified = acquisition.verifyAcquisition({ providerId: 'odyssey-2026', outputRoot });
    assert.deepEqual(verified.missing, ['alpha26_odyssey']);
    assert.equal(verified.complete, false);
});

test('按指定数量并发下载不同论文，并等待全部下载任务结束', async t => {
    const { outputRoot } = temporaryRoot(t);
    await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true },
        dependencies(async () => httpResponse(ODYSSEY_TWO_FIXTURE, 'text/html')));
    let active = 0; let maximum = 0;
    const result = await acquisition.downloadPapers({ providerId: 'odyssey-2026', outputRoot,
        apply: true, concurrency: 2 }, dependencies(async url => {
        active += 1; maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 15));
        active -= 1;
        return httpResponse(`%PDF-${path.basename(url)}`, 'application/pdf');
    }));
    assert.equal(maximum, 2);
    assert.equal(result.concurrency, 2);
    assert.equal(result.complete, true);
    assert.equal(acquisition.verifyAcquisition({ providerId: 'odyssey-2026', outputRoot }).verified, 2);
    await assert.rejects(acquisition.downloadPapers({ providerId: 'odyssey-2026', outputRoot,
        apply: true, concurrency: 6 }), /concurrency/u);
});

test('显式的重试预算只重试同一 URL 的暂时性失败', async t => {
    const { outputRoot } = temporaryRoot(t);
    await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true },
        dependencies(async () => httpResponse(ODYSSEY_FIXTURE, 'text/html')));
    let calls = 0; const delays = [];
    const deps = dependencies(async () => {
        calls += 1;
        if (calls === 1) { const error = new Error('socket closed'); error.code = 'UND_ERR_SOCKET'; throw error; }
        return httpResponse('%PDF-retried', 'application/pdf');
    });
    deps.sleep = async delay => { delays.push(delay); };
    const result = await acquisition.downloadPapers({ providerId: 'odyssey-2026', outputRoot,
        apply: true, retries: 1 }, deps);
    assert.equal(result.complete, true);
    assert.equal(result.retries, 1);
    assert.equal(calls, 2);
    assert.deepEqual(delays, [500]);
});

test('命令行要求显式的来源身份和年份，只用配置的运行时根目录，并检查各模式允许使用的参数', () => {
    const root = path.join(os.tmpdir(), 'conference-runs');
    const parsed = cli.parseArgs(['catalog', '--provider', 'odyssey-2026', '--conference-id', 'odyssey-2026',
        '--year', '2026', '--dry-run'], { acquisitionRoot: root });
    assert.equal(parsed.apply, false);
    assert.equal(parsed.conferenceId, 'odyssey-2026');
    assert.equal(parsed.outputRoot, path.join(root, 'odyssey-2026'));
    const aaai = cli.parseArgs(['catalog', '--provider', 'aaai-2026', '--conference-id', 'aaai-2026',
        '--year', '2026', '--dry-run'], { acquisitionRoot: root });
    assert.equal(aaai.outputRoot, path.join(root, 'aaai-2026'));
    const parallel = cli.parseArgs(['download', '--provider', 'odyssey-2026', '--conference-id', 'odyssey-2026',
        '--year', '2026', '--apply', '--concurrency', '5', '--retries', '3'], { acquisitionRoot: root });
    assert.equal(parallel.concurrency, 5);
    assert.equal(parallel.retries, 3);
    assert.throws(() => cli.parseArgs(['catalog', '--provider', 'odyssey-2026', '--conference-id', 'iwslt-2026',
        '--year', '2026', '--apply'], { acquisitionRoot: root }), /must exactly match/u);
    assert.throws(() => cli.parseArgs(['status', '--provider', 'odyssey-2026', '--conference-id', 'odyssey-2026',
        '--year', '2026', '--dry-run'], { acquisitionRoot: root }), /does not accept/u);
    assert.throws(() => cli.parseArgs(['download', '--provider', 'odyssey-2026', '--conference-id', 'odyssey-2026',
        '--year', '2026', '--output-root', root, '--apply'], { acquisitionRoot: root }), /Use:/u);
    assert.throws(() => cli.parseArgs(['download', '--provider', 'odyssey-2026', '--conference-id', 'odyssey-2026',
        '--year', '2026', '--apply'], { acquisitionRoot: 'relative' }), /configured acquisition root/u);
    assert.throws(() => cli.parseArgs(['download', '--provider', 'odyssey-2026', '--conference-id', 'odyssey-2026',
        '--year', '2026', '--apply', '--concurrency', '6'], { acquisitionRoot: root }), /concurrency/u);
    assert.throws(() => cli.parseArgs(['download', '--provider', 'odyssey-2026', '--conference-id', 'odyssey-2026',
        '--year', '2026', '--apply', '--retries', '6'], { acquisitionRoot: root }), /retries/u);
});


test('官方目录四种不可变文件短写后均可重新抓取或重放恢复', async t => {
    for (let failAt = 1; failAt <= 4; failAt += 1) {
        const { outputRoot } = temporaryRoot(t);
        const deps = dependencies(async () => httpResponse(ODYSSEY_FIXTURE, 'text/html'));
        const originalWrite = fs.writeFileSync; let writes = 0;
        const injected = t.mock.method(fs, 'writeFileSync', (fd, bytes, ...args) => {
            if (typeof fd === 'number' && ++writes === failAt) {
                originalWrite(fd, Buffer.from(bytes).subarray(0, 10), ...args);
                const error = new Error('模拟短写 EIO'); error.code = 'EIO'; throw error;
            }
            return originalWrite(fd, bytes, ...args);
        });
        try {
            await assert.rejects(acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true }, deps), /EIO/);
        } finally { injected.mock.restore(); }
        const retry = await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true }, deps);
        assert.equal(retry.papers, 1);
        assert.equal(acquisition.replayCatalog('odyssey-2026', outputRoot).metadata.papers.length, 1);
    }
});

test('PDF及其凭证短写后续跑可恢复且完成状态重新验证字节', async t => {
    for (let failAt = 1; failAt <= 2; failAt += 1) {
        const { outputRoot } = temporaryRoot(t);
        const deps = dependencies(async url => url.endsWith('.pdf')
            ? httpResponse('%PDF-1.4\ncomplete-paper\n%%EOF', 'application/pdf')
            : httpResponse(ODYSSEY_FIXTURE, 'text/html'));
        await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true }, deps);
        const originalWrite = fs.writeFileSync; let writes = 0;
        const injected = t.mock.method(fs, 'writeFileSync', (fd, bytes, ...args) => {
            if (typeof fd === 'number' && ++writes === failAt) {
                originalWrite(fd, Buffer.from(bytes).subarray(0, 10), ...args);
                const error = new Error('模拟 PDF 短写 EIO'); error.code = 'EIO'; throw error;
            }
            return originalWrite(fd, bytes, ...args);
        });
        try {
            await assert.rejects(acquisition.downloadPapers({ providerId: 'odyssey-2026', outputRoot, apply: true }, deps), /EIO/);
        } finally { injected.mock.restore(); }
        assert.equal((await acquisition.downloadPapers({ providerId: 'odyssey-2026', outputRoot, apply: true }, deps)).complete, true);
        assert.equal(acquisition.verifyAcquisition({ providerId: 'odyssey-2026', outputRoot }).complete, true);
    }
});

test('官方XHTML目录可封存及离线重放，仍拒绝非HTML内容', async t => {
    const { outputRoot } = temporaryRoot(t);
    const result = await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true },
        dependencies(async () => httpResponse(ODYSSEY_FIXTURE, 'application/xhtml+xml; charset=utf-8')));
    assert.equal(result.papers, 1);
    const replay = await acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot, apply: true },
        dependencies(async () => { throw new Error('已有封存不应再次请求'); }));
    assert.equal(replay.papers, 1);
    const other = temporaryRoot(t);
    await assert.rejects(acquisition.acquireCatalog({ providerId: 'odyssey-2026', outputRoot: other.outputRoot, apply: true },
        dependencies(async () => httpResponse(ODYSSEY_FIXTURE, 'application/json'))), /Content-Type/);
});

test('普通会议状态不把损坏PDF或损坏凭证计为完成', async t => {
    const { outputRoot } = temporaryRoot(t);
    const args = { providerId: 'odyssey-2026', outputRoot, apply: true };
    const deps = dependencies(async url => url.endsWith('.pdf')
        ? httpResponse('%PDF-1.4\ncomplete-paper\n%%EOF', 'application/pdf')
        : httpResponse(ODYSSEY_FIXTURE, 'text/html'));
    await acquisition.acquireCatalog(args, deps); await acquisition.downloadPapers(args, deps);
    assert.equal(acquisition.acquisitionStatus(args).complete, true);
    const target = path.join(outputRoot, 'pdfs/alpha26_odyssey.pdf');
    const original = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.from(original.toString().replace('complete', 'modified')));
    assert.throws(() => acquisition.acquisitionStatus(args), /differs from receipt/);
    fs.writeFileSync(target, original);
    const receipt = path.join(outputRoot, 'receipts/alpha26_odyssey.json');
    fs.writeFileSync(receipt, '{}\n');
    assert.throws(() => acquisition.acquisitionStatus(args), /schema/);
});


test('真实子进程在正式硬链接后中断，apply可恢复目录和PDF而只读状态不清理', async t => {
    const { spawnSync } = require('node:child_process');
    for (const relative of ['responses/index.html', 'responses/index.receipt.json', 'metadata.json',
        'catalog.receipt.json', 'pdfs/alpha26_odyssey.pdf', 'receipts/alpha26_odyssey.json']) {
        const { outputRoot } = temporaryRoot(t);
        const args = { providerId: 'odyssey-2026', outputRoot, apply: true };
        const deps = dependencies(async url => url.endsWith('.pdf')
            ? httpResponse('%PDF-1.4\ncomplete-paper\n%%EOF', 'application/pdf')
            : httpResponse(ODYSSEY_FIXTURE, 'text/html'));
        const download = relative.startsWith('pdfs/') || relative.startsWith('receipts/');
        if (download) await acquisition.acquireCatalog(args, deps);
        const target = path.join(outputRoot, relative);
        const script = `const fs=require('node:fs'); const api=require(${JSON.stringify(require.resolve('../scripts/lib/official-conference-acquisition.js'))});
const original=fs.linkSync; fs.linkSync=(source,destination)=>{ const result=original(source,destination); if(destination===${JSON.stringify(target)})process.kill(process.pid,'SIGKILL'); return result; };
const deps={detectProxy:()=> 'http://127.0.0.1:9',createDispatcher:()=>({}),now:()=> '2026-09-09T00:00:00.000Z',fetchImpl:async url=> new Response(url.endsWith('.pdf')?'%PDF-1.4\\ncomplete-paper\\n%%EOF':${JSON.stringify(ODYSSEY_FIXTURE)},{status:200,headers:{'content-type':url.endsWith('.pdf')?'application/pdf':'text/html'}})};
api.${download ? 'downloadPapers' : 'acquireCatalog'}(${JSON.stringify(args)},deps).catch(error=>{console.error(error);process.exitCode=1;});`;
        const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
        assert.equal(child.signal, 'SIGKILL', child.stderr);
        assert.equal(fs.statSync(target).nlink, 2);
        try { acquisition.acquisitionStatus(args); } catch (error) { assert.equal(error.code, 'OFFICIAL_CONFERENCE_ACQUISITION_INTEGRITY'); }
        assert.equal(fs.statSync(target).nlink, 2);
        if (download) await acquisition.downloadPapers(args, deps);
        else await acquisition.acquireCatalog(args, deps);
        assert.equal(fs.statSync(target).nlink, 1);
        if (download) assert.equal(acquisition.verifyAcquisition(args).complete, true);
        else assert.equal(acquisition.replayCatalog(args.providerId, outputRoot).metadata.papers.length, 1);
    }
});

test('正式链接前中断留下的临时文件明确报告路径，不能自动删除或宣称完成', async t => {
    const { spawnSync } = require('node:child_process');
    const { outputRoot } = temporaryRoot(t);
    const args = { providerId: 'odyssey-2026', outputRoot, apply: true };
    const script = `const fs=require('node:fs'); const api=require(${JSON.stringify(require.resolve('../scripts/lib/official-conference-acquisition.js'))});
fs.linkSync=()=>process.kill(process.pid,'SIGKILL');
api.acquireCatalog(${JSON.stringify(args)}, {detectProxy:()=> 'http://127.0.0.1:9',createDispatcher:()=>({}),now:()=> '2026-09-09T00:00:00.000Z',fetchImpl:async()=>new Response(${JSON.stringify(ODYSSEY_FIXTURE)},{status:200,headers:{'content-type':'text/html'}})});`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const responses = path.join(outputRoot, 'responses');
    const [name] = fs.readdirSync(responses); const temporary = path.join(responses, name);
    assert.match(name, /\.tmp$/);
    await assert.rejects(acquisition.acquireCatalog(args, dependencies(async()=>{throw new Error('诊断前不得发请求');})),
        error => error.message.includes(temporary) && /请先核验.*再单独清理/.test(error.message));
    assert.equal(fs.existsSync(temporary), true);
    assert.equal(fs.existsSync(path.join(responses, 'index.html')), false);
});

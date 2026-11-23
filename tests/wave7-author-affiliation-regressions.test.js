'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cheerio = require('cheerio');

const Config = require('../scripts/config.js');
const deep = require('../scripts/deep-analyzer.js');
const parser = require('../scripts/lib/reader-author-parser.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const capturer = require('../scripts/lib/fresh-arxiv-rewrite-source.js');

const ROOT = path.resolve(__dirname, '..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function generateSyntheticPdfBytes(pyCode) {
    const res = spawnSync('bash', [path.join(ROOT, 'scripts/python-runtime.sh'), '-c', pyCode], {
        cwd: ROOT,
        encoding: 'buffer',
        timeout: 20000
    });
    assert.equal(res.status, 0, `PyMuPDF synthetic PDF generator failed: ${res.stderr.toString('utf8')}`);
    return res.stdout;
}

test('RC-10: 含导航栏 <svg> 的真实 arXiv HTML 保留脱敏 header-only HTML 并支持严格 SHA 重放', () => {
    const realLikeHtml = '<html><head>'
        + '<meta name="citation_author" content="Alice Brown">'
        + '<meta name="citation_author_institution" content="Institute Alpha">'
        + '</head><body>'
        + '<header><nav><svg width="16" height="16"><path d="M0 0h16v16H0z"/></svg>arXiv</nav></header>'
        + '<h1 class="ltx_title_document">Test Paper</h1>'
        + '<div class="ltx_authors"><span class="ltx_creator ltx_role_author">'
        + '<span class="ltx_personname">Alice Brown</span>'
        + '<span class="ltx_contact ltx_role_affiliation">Institute Alpha</span></span></div>'
        + '<section><p>Methods and controlled observations.</p></section></body></html>';

    // Existing full-HTML security invariant remains intact
    assert.equal(parser.canRetainAuthorSourceHtml(realLikeHtml), false);
    assert.equal(parser.retainAuthorSourceHtml({ authors: [] }, realLikeHtml).sourceHtml, undefined);

    // Header-only sanitized HTML slice is retained and cryptographically bound in structuredArtifacts
    const text = cheerio.load(realLikeHtml).text();
    const artifacts = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(realLikeHtml, '2611.99999v1', '2611.99999'),
        text
    );
    assert.match(artifacts.authorHeaderHtmlSha256 || '', /^[a-f0-9]{64}$/);
    const readerAuthors = parser.retainAuthorSourceHeaderHtml(
        parser.parseArxivReaderAuthors(cheerio.load(realLikeHtml)),
        realLikeHtml
    );
    assert.equal(readerAuthors.sourceHtml, undefined);
    assert.ok(readerAuthors.sourceHeaderHtml && !/<svg\b/i.test(readerAuthors.sourceHeaderHtml));
    assert.equal(sha256(readerAuthors.sourceHeaderHtml), artifacts.authorHeaderHtmlSha256);

    const details = { source: 'html', text, structuredArtifacts: artifacts, readerAuthors };
    const replayed = parser.replayHtmlReaderAuthors(details);
    assert.deepEqual(replayed.authors, [{ name: 'Alice Brown', affiliations: ['Institute Alpha'] }]);

    // Tampered header HTML or SHA is rejected
    const tampered = structuredClone(details);
    tampered.readerAuthors.sourceHeaderHtml = tampered.readerAuthors.sourceHeaderHtml.replace('Institute Alpha', 'Institute Beta');
    assert.equal(parser.replayHtmlReaderAuthors(tampered), null);
});

test('RC-1..RC-4 & RC-9: HTML 上标/MathML/post-Abstract 地址/多句 thanks 与机构清洗', () => {
    // 1. MathML + <sup> markers + post-Abstract .ltx_role_address (spconf/bmvc2k)
    const markedHtml = '<html><body>'
        + '<div class="ltx_authors"><span class="ltx_creator ltx_role_author">'
        + '<span class="ltx_personname">Wen-Li Wei<math><annotation encoding="application/x-tex">^{\\star}</annotation></math>, '
        + 'Kenneth Yang<sup>⋆,†</sup> and Jen-Chun Lin<sup>⋆</sup></span>'
        + '</span></div>'
        + '<div class="ltx_abstract">Abstract text.</div>'
        + '<div class="ltx_role_address"><sup>⋆</sup>Institute of Information Science, Academia Sinica<br>'
        + '<sup>†</sup>Graduate Institute of Communication Engineering, National Taiwan University</div>'
        + '</body></html>';
    const parsedMarked = parser.parseArxivReaderAuthors(cheerio.load(markedHtml));
    assert.deepEqual(parsedMarked.authors, [
        { name: 'Wen-Li Wei', affiliations: ['Institute of Information Science, Academia Sinica'] },
        {
            name: 'Kenneth Yang',
            affiliations: [
                'Institute of Information Science, Academia Sinica',
                'Graduate Institute of Communication Engineering, National Taiwan University'
            ]
        },
        { name: 'Jen-Chun Lin', affiliations: ['Institute of Information Science, Academia Sinica'] }
    ]);

    // 2. Multi-sentence .ltx_authors .ltx_note.ltx_role_thanks with email in middle + "was with"
    const thanksHtml = '<html><body>'
        + '<div class="ltx_authors">'
        + '<span class="ltx_creator ltx_role_author"><span class="ltx_personname">Hui-Peng Du, Member, IEEE</span></span>'
        + '<span class="ltx_creator ltx_role_author"><span class="ltx_personname">Yang Ai, Senior Member, IEEE</span></span>'
        + '<span class="ltx_note ltx_role_thanks">'
        + 'This work was supported by Grant 123. (Corresponding author: Yang Ai) '
        + 'Hui-Peng Du was with University of Science and Technology of China (e-mail: a@ustc.edu.cn). '
        + 'Yang Ai is now with National Engineering Research Center, USTC, e-mail: b@ustc.edu.cn.'
        + '</span></div></body></html>';
    const parsedThanks = parser.parseArxivReaderAuthors(cheerio.load(thanksHtml));
    assert.deepEqual(parsedThanks.authors, [
        { name: 'Hui-Peng Du', affiliations: ['University of Science and Technology of China'] },
        { name: 'Yang Ai', affiliations: ['National Engineering Research Center, USTC'] }
    ]);

    // 3. Affiliation sanitization strips unclosed email braces, Equal contribution, raw LaTeX macros
    assert.equal(
        parser.sanitizeReaderAffiliationValue('Shanghai Jiao Tong University{chenchiyu, ma_yuezhao,'),
        'Shanghai Jiao Tong University'
    );
    assert.equal(
        parser.sanitizeReaderAffiliationValue('KAIST *Equal contribution. Corresponding author: Joon Son Chung'),
        'KAIST'
    );
    assert.equal(parser.sanitizeReaderAffiliationValue('Equal contribution.'), '');
    assert.equal(
        parser.sanitizeReaderAffiliationValue('\\institution organization={Tsinghua University}'),
        'Tsinghua University'
    );
});

test('RC-5: 规范化 1-to-1 作者姓名对齐支持变音/连字符/倒序/中间名首字母/昵称/分隔符，并拒绝污染与重名', () => {
    const parsedAuthors = [
        { name: 'Amelie Royer', affiliations: ['Kyutai'] },
        { name: 'Ahmet Tugrul Bayrak', affiliations: ['Ata Technology Platforms'] },
        { name: 'Hui Peng Du', affiliations: ['USTC'] },
        { name: 'Jacqueline Pang', affiliations: ['Cornell University'] },
        { name: 'Smith, John', affiliations: ['MIT'] },
        { name: "Liam O'Connor", affiliations: ['Trinity College Dublin'] },
        { name: 'Jing LYU', affiliations: ['WeChat Vision, Tencent Inc.'] }
    ];
    const sourceDomSha256 = sha256('synthetic-dom');
    const paper = {
        arxivId: '2611.90001',
        authors: [
            'Amélie Royer',
            ':',
            'Ahmet Tuğrul Bayrak',
            'Hui-Peng Du',
            'Jacqueline J. Pang',
            'John (Toby) Smith',
            'Liam O’Connor',
            'Jing Lyu'
        ]
    };
    const resolved = parser.resolveApiReaderAuthors(paper, {
        source: 'html',
        text: 'Synthetic source text',
        readerAuthors: { authors: parsedAuthors, sourceDomSha256 }
    });
    assert.deepEqual(resolved.authors.map(a => [a.name, a.affiliations[0]]), [
        ['Amélie Royer', 'Kyutai'],
        [':', '机构信息未能在本次解析中与作者逐人可靠绑定'],
        ['Ahmet Tuğrul Bayrak', 'Ata Technology Platforms'],
        ['Hui-Peng Du', 'USTC'],
        ['Jacqueline J. Pang', 'Cornell University'],
        ['John (Toby) Smith', 'MIT'],
        ['Liam O’Connor', 'Trinity College Dublin'],
        ['Jing Lyu', 'WeChat Vision, Tencent Inc.']
    ]);
    assert.equal(resolved.identity.authors[1].nameBinding.sourceKind, 'paper_metadata');
    assert.equal(resolved.identity.authors[1].affiliationBindings[0].sourceKind, 'explicit_unavailable');
    assert.equal(resolved.identity.authors[0].nameBinding.sourceKind, 'html_dom');

    // Negative security checks: extra full given name, duplicate names, and polluted extra entry must ALL be rejected
    const suffixMismatch = parser.resolveApiReaderAuthors(
        { authors: ['John Alice Brown'] },
        { source: 'html', text: 't', readerAuthors: { authors: [{ name: 'Alice Brown', affiliations: ['Univ A'] }], sourceDomSha256 } }
    );
    assert.match(suffixMismatch.authors[0].affiliations[0], /^机构信息未/);

    const polluted = parser.resolveApiReaderAuthors(
        { authors: ['Alice Brown'] },
        {
            source: 'html',
            text: 't',
            readerAuthors: {
                authors: [
                    { name: 'Alice Brown', affiliations: ['Univ A'] },
                    { name: 'Aalto University', affiliations: ['Univ B'] }
                ],
                sourceDomSha256
            }
        }
    );
    assert.match(polluted.authors[0].affiliations[0], /^机构信息未/);
});

test('RC-6 & RC-7: PyMuPDF PDF 第 1 页几何提取覆盖 Mode A/B/C/D、拒绝多机构猜测，并闭合四文件封存核验', async (t) => {
    // Mode A: superscript markers + 2 institutions
    const pdfModeA = generateSyntheticPdfBytes(`
import fitz, sys
doc = fitz.open()
p = doc.new_page(width=595, height=842)
p.insert_text((80, 90), "Neural Speech Modeling Benchmark", fontsize=17)
p.insert_text((80, 130), "Alice Brown", fontsize=11)
p.insert_text((140, 126), "1,2,*", fontsize=7.5)
p.insert_text((160, 130), ", Bob White", fontsize=11)
p.insert_text((220, 126), "2", fontsize=7.5)
p.insert_text((80, 152), "1", fontsize=7.5)
p.insert_text((88, 155), "Fudan University", fontsize=11)
p.insert_text((220, 152), "2", fontsize=7.5)
p.insert_text((228, 155), "Tsinghua University", fontsize=11)
p.insert_text((80, 195), "Abstract", fontsize=12)
p.insert_text((80, 215), "We study neural speech modeling.", fontsize=10)
sys.stdout.buffer.write(doc.tobytes())
`);
    const extractedA = parser.extractPdfPage1AuthorsSync(pdfModeA);
    assert.ok(extractedA, 'Mode A PDF should parse cleanly');
    assert.equal(extractedA.mode, 'markers');
    assert.equal(extractedA.pdfSha256, sha256(pdfModeA));
    assert.deepEqual(extractedA.authors, [
        { name: 'Alice Brown', affiliations: ['Fudan University', 'Tsinghua University'] },
        { name: 'Bob White', affiliations: ['Tsinghua University'] }
    ]);

    // Negative Mode C: unmarked multi-institution line separated by wide horizontal gap must return null
    const pdfAmbiguous = generateSyntheticPdfBytes(`
import fitz, sys
doc = fitz.open()
p = doc.new_page(width=595, height=842)
p.insert_text((80, 90), "Multi Institution Unmarked Paper", fontsize=17)
p.insert_text((80, 130), "Alice Brown, Bob White", fontsize=11)
p.insert_text((80, 155), "University Alpha", fontsize=11)
p.insert_text((260, 155), "University Beta", fontsize=11)
p.insert_text((80, 195), "Abstract", fontsize=12)
p.insert_text((80, 215), "Unmarked multi institution test.", fontsize=10)
sys.stdout.buffer.write(doc.tobytes())
`);
    assert.equal(parser.extractPdfPage1AuthorsSync(pdfAmbiguous), null);

    // Full 4-file sealed bundle round-trip for source === 'pdf'
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wave7-pdf-bundle-'));
    const prevDir = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(folder, 'daily-runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = prevDir;
        fs.rmSync(folder, { recursive: true, force: true });
    });
    const id = '2611.90002';
    const pdfText = 'Neural Speech Modeling Benchmark\nAlice Brown, Bob White\nAbstract\n' + 'Experimental methods and results. '.repeat(120);
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-11-20', batchId: 'wave7-pdf-test', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => capturer.captureFreshArxivRewriteSource(options, {
            fetchText: async () => ({ source: 'unavailable', htmlAvailability: 'permanent_miss', htmlAttempts: 1, warnings: [] }),
            fetchPdf: async () => ({ bytes: pdfModeA, url: `https://arxiv.org/pdf/${id}.pdf`, sourceId: id }),
            extractPdfText: async () => ({ title: 'Neural Speech Modeling Benchmark', text: pdfText })
        })
    });
    const source = daily.readDailyFreshSource(plan, { arxivId: id });
    assert.equal(source.source, 'pdf');
    const paper = {
        arxivId: id,
        authors: ['Alice Brown', 'Bob White'],
        sourceSha256: source.freshSourceDescriptor.sourceSha256,
        analysisManifest: {
            contracts: { apiReaderArticle: 'beginner-researcher-v4' },
            sourceAcquisition: { sourceSha256: source.freshSourceDescriptor.sourceSha256 },
            stages: { apiReaderArticle: { status: 'complete', structuredArtifactsSha256: source.structuredArtifacts.payloadSha256 } }
        }
    };
    const resolved = parser.resolveVerifiedReaderAuthors(paper, source);
    assert.deepEqual(resolved.authors, [
        { name: 'Alice Brown', affiliations: ['Fudan University', 'Tsinghua University'] },
        { name: 'Bob White', affiliations: ['Tsinghua University'] }
    ]);
    assert.equal(resolved.identity.authors[0].nameBinding.sourceKind, 'pdf_text');
    assert.equal(resolved.identity.authors[0].affiliationBindings[0].sourceKind, 'pdf_text');
    paper.apiReaderAuthors = resolved;
    paper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = resolved.identitySha256;
    paper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = daily.stableHash(resolved);
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, source), true);

    // Tampered clone without bundle capability fails closed
    assert.equal(parser.verifiedReaderAuthorDetails(structuredClone(source)).readerAuthors, null);
});

test('RC-8: parseConferencePdfAuthors 支持 Interspeech ORCID ID、PUA \\uf02a、空格标记、无空格数字机构与单机构导言', () => {
    const interspeech = [
        'Speech Enhancement via Flow Matching',
        'Takuhiro Kaneko ID 1, Hirokazu Kameoka ID 1, 2, and Kou Tanaka ID 2',
        '1NTT Communication Science Laboratories, Japan',
        '2University of Tokyo, Japan',
        '',
        'Abstract',
        'Body text.'
    ].join('\n');
    const parsedIS = parser.parseConferencePdfAuthors(interspeech);
    assert.ok(parsedIS);
    assert.deepEqual(parsedIS.authors, [
        { name: 'Takuhiro Kaneko', affiliations: ['NTT Communication Science Laboratories, Japan'] },
        { name: 'Hirokazu Kameoka', affiliations: ['NTT Communication Science Laboratories, Japan', 'University of Tokyo, Japan'] },
        { name: 'Kou Tanaka', affiliations: ['University of Tokyo, Japan'] }
    ]);

    const puaAndSymbols = [
        'Audio Codec Study',
        'Alice Brown\uf02a, Bob White§',
        '\uf02aKAIST, South Korea',
        '§Kyutai, France',
        '',
        'Abstract',
        'Body text.'
    ].join('\n');
    const parsedSym = parser.parseConferencePdfAuthors(puaAndSymbols);
    assert.ok(parsedSym);
    assert.deepEqual(parsedSym.authors, [
        { name: 'Alice Brown', affiliations: ['KAIST, South Korea'] },
        { name: 'Bob White', affiliations: ['Kyutai, France'] }
    ]);

    const singleInst = [
        'Unified Speech Recognition',
        'Jane Doe, John Roe, and Mary Poe',
        'University of Michigan',
        '',
        'Abstract',
        'Body text.'
    ].join('\n');
    const parsedSingle = parser.parseConferencePdfAuthors(singleInst);
    assert.ok(parsedSingle);
    assert.deepEqual(parsedSingle.authors, [
        { name: 'Jane Doe', affiliations: ['University of Michigan'] },
        { name: 'John Roe', affiliations: ['University of Michigan'] },
        { name: 'Mary Poe', affiliations: ['University of Michigan'] }
    ]);
});

test('RC-11: parse-arxiv-atom.py 可选解析 <arxiv:affiliation> 且在缺失时保持原字段集合不变', () => {
    const withAff = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2611.12345v1</id>
    <published>2026-11-20T00:00:00Z</published>
    <title>Test Paper</title>
    <summary>Abstract body.</summary>
    <author><name>Alice Brown</name><arxiv:affiliation>MIT</arxiv:affiliation></author>
    <author><name>Bob White</name></author>
    <category term="cs.SD"/>
  </entry>
</feed>`;
    const res1 = spawnSync('bash', [path.join(ROOT, 'scripts/python-runtime.sh'), path.join(ROOT, 'scripts/parse-arxiv-atom.py')], {
        cwd: ROOT, input: withAff, encoding: 'utf8', timeout: 15000
    });
    assert.equal(res1.status, 0, res1.stderr);
    const parsed1 = JSON.parse(res1.stdout);
    assert.deepEqual(parsed1[0].authors, ['Alice Brown', 'Bob White']);
    assert.deepEqual(parsed1[0].authorAffiliations, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: [] }
    ]);

    const withoutAff = withAff.replace('<arxiv:affiliation>MIT</arxiv:affiliation>', '');
    const res2 = spawnSync('bash', [path.join(ROOT, 'scripts/python-runtime.sh'), path.join(ROOT, 'scripts/parse-arxiv-atom.py')], {
        cwd: ROOT, input: withoutAff, encoding: 'utf8', timeout: 15000
    });
    assert.equal(res2.status, 0, res2.stderr);
    const parsed2 = JSON.parse(res2.stdout);
    assert.equal(Object.hasOwn(parsed2[0], 'authorAffiliations'), false);
});

test('2026-11-20 真实封存 16 篇论文 PDF 首页提取与 1-to-1 对齐达到 16/16（跳过条件：本机无该批次封存文件）', (t) => {
    const analysisPath = path.join(ROOT, 'data/current/deep-analysis-result.json');
    if (!fs.existsSync(analysisPath)) { t.skip('no local analysis file'); return; }
    const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
    if (analysis.batchDate !== '2026-11-20' || !analysis.dailyFreshSourceRun?.runId) {
        t.skip('current batch is not 2026-11-20');
        return;
    }
    const runId = analysis.dailyFreshSourceRun.runId;
    const sourcesDir = path.join(ROOT, 'data/runtime/daily-fresh-source-runs', runId, 'sources');
    if (!fs.existsSync(sourcesDir)) { t.skip('sealed source dir missing'); return; }

    let boundPapers = 0;
    let boundAuthors = 0;
    let totalAuthors = 0;
    for (const paper of analysis.papers) {
        const id = String(paper.arxivId).replace(/v\d+$/, '');
        const pdfPath = path.join(sourcesDir, id, 'generation-000001', 'source.pdf');
        const txtPath = path.join(sourcesDir, id, 'generation-000001', 'source.txt');
        if (!fs.existsSync(pdfPath) || !fs.existsSync(txtPath)) { t.skip(`missing sealed source for ${id}`); return; }
        const pdfEvidence = parser.extractPdfPage1AuthorsSync(fs.readFileSync(pdfPath));
        assert.ok(pdfEvidence, `${id} should extract PDF Page-1 authors`);
        const resolved = parser.resolveApiReaderAuthors(paper, {
            source: 'pdf',
            text: fs.readFileSync(txtPath, 'utf8'),
            readerAuthors: pdfEvidence
        });
        totalAuthors += resolved.authors.length;
        const okCount = resolved.authors.filter(a => a.affiliations.every(v => v && !/^机构信息未/.test(v))).length;
        boundAuthors += okCount;
        assert.equal(okCount, paper.authors.length, `${id} must bind all ${paper.authors.length} authors cleanly`);
        for (const author of resolved.authors) {
            for (const aff of author.affiliations) {
                assert.doesNotMatch(aff, /Equal contribution|Corresponding author|\{[a-z0-9_,]+$/i, `${id} affiliation contaminated: ${aff}`);
            }
        }
        boundPapers++;
    }
    assert.equal(boundPapers, analysis.papers.length);
    assert.equal(boundAuthors, totalAuthors);
});

test('Wave 7 R1 回归：CRITICAL-1/2、HIGH-2、MEDIUM-1 与 LOW-1 全覆盖', () => {
    const crypto = require('node:crypto');
    const os = require('node:os');
    const dailyXml = require('../scripts/lib/daily-xml-file-stdin.js');
    const freshCtx = require('../scripts/lib/fresh-analysis-context.js');
    const freshStore = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
    const sha = v => crypto.createHash('sha256').update(v).digest('hex');

    // CRITICAL-1: validatePdfPage1AuthorEvidence 拒绝伪造 mode、额外键、非法 authors 形状
    const fakePdfSha = 'a'.repeat(64);
    const fakeEv = 'COMPLETELY FABRICATED TEXT';
    const fakeEvSha = sha(Buffer.from(fakeEv, 'utf8'));
    const fakeDomSha = sha(Buffer.from(`${fakePdfSha}:${fakeEvSha}`, 'utf8'));
    assert.equal(parser.validatePdfPage1AuthorEvidence({
        contract: parser.PDF_PAGE1_AUTHOR_CONTRACT,
        mode: 'totally_bogus_mode',
        pdfSha256: fakePdfSha,
        sourceEvidence: fakeEv,
        sourceEvidenceSha256: fakeEvSha,
        sourceDomSha256: fakeDomSha,
        authors: [{ name: 'Alice Brown', affiliations: ['Forged University of Mars'] }]
    }, fakePdfSha), false);
    assert.equal(parser.validatePdfPage1AuthorEvidence({
        contract: parser.PDF_PAGE1_AUTHOR_CONTRACT,
        mode: 'single_institution',
        pdfSha256: fakePdfSha,
        sourceEvidence: fakeEv,
        sourceEvidenceSha256: fakeEvSha,
        sourceDomSha256: fakeDomSha,
        authors: [{ name: 'Alice Brown', affiliations: ['Forged University of Mars'] }],
        extra: 1
    }, fakePdfSha), false);

    // CRITICAL-1: 真实四文件封存包中篡改/伪造 pdf-page1-author-evidence-v1 必须在 readVerifiedBundleReaderAuthors 重放时被拒绝
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wave7-forged-pdf-')));
    try {
        // Build a minimal valid >256B PDF with PyMuPDF containing Alice Brown / Stanford University
        const pdfGen = spawnSync('bash', [path.join(ROOT, 'scripts/python-runtime.sh'), '-c', `
import fitz, sys
doc = fitz.open()
page = doc.new_page(width=595, height=842)
page.insert_text((72, 80), "A Genuine Test Paper Title", fontsize=16)
page.insert_text((72, 120), "Alice Brown, Bob White", fontsize=11)
page.insert_text((72, 140), "Stanford University", fontsize=10)
page.insert_text((72, 220), "Abstract", fontsize=12)
page.insert_text((72, 240), "Body text here.", fontsize=10)
sys.stdout.buffer.write(doc.tobytes())
doc.close()
`], { cwd: ROOT, timeout: 15000 });
        assert.equal(pdfGen.status, 0);
        const realPdfBytes = pdfGen.stdout;
        const realPdfSha = sha(realPdfBytes);
        const forgedEv = 'Forged Page 1';
        const forgedEvSha = sha(Buffer.from(forgedEv, 'utf8'));
        const forgedAuthors = {
            contract: parser.PDF_PAGE1_AUTHOR_CONTRACT,
            mode: 'single_institution',
            pdfSha256: realPdfSha,
            sourceEvidence: forgedEv,
            sourceEvidenceSha256: forgedEvSha,
            sourceDomSha256: sha(Buffer.from(`${realPdfSha}:${forgedEvSha}`, 'utf8')),
            authors: [{ name: 'Alice Brown', affiliations: ['Forged University of Mars'] }]
        };
        assert.equal(parser.validatePdfPage1AuthorEvidence(forgedAuthors, realPdfSha), true);
        const bundleDir = path.join(tmpRoot, '2611.99999', 'generation-000001');
        fs.mkdirSync(bundleDir, { recursive: true });
        const textBytes = Buffer.from('A Genuine Test Paper Title\nAbstract\nBody text here.', 'utf8');
        const textSha = sha(textBytes);
        const artifactsBody = { version: 1, source: 'fresh_arxiv_text_without_layout', flattenedTextSha256: textSha, tables: [], formulas: [], figures: [] };
        const sortDeep = val => Array.isArray(val) ? val.map(sortDeep)
            : (val && typeof val === 'object' ? Object.fromEntries(Object.keys(val).sort().map(k => [k, sortDeep(val[k])])) : val);
        const canonicalBytes = obj => Buffer.from(`${JSON.stringify(sortDeep(obj), null, 2)}\n`, 'utf8');
        const artifacts = { ...artifactsBody, payloadSha256: sha(JSON.stringify(sortDeep(artifactsBody))) };
        const protocolCodec = require('../scripts/lib/protocol-codec.js');
        const runtimeObj = {
            ...protocolCodec.recordHeader('fresh-arxiv-rewrite-runtime-metadata', 'fresh-arxiv-rewrite-runtime-metadata'),
            paperId: 'arxiv:2611.99999',
            textSha256: textSha,
            title: 'A Genuine Test Paper Title',
            structuredArtifacts: artifacts,
            imageInfos: [],
            warnings: [],
            htmlAttempts: 0,
            htmlAvailability: 'unavailable',
            readerAuthors: forgedAuthors
        };
        const runtimeBytes = canonicalBytes(runtimeObj);
        const manifestObj = {
            ...protocolCodec.recordHeader('fresh-arxiv-source-manifest', 'fresh-arxiv-source-manifest'),
            arxivId: '2611.99999',
            paperId: 'arxiv:2611.99999',
            generation: 1,
            capturedAt: '2026-11-20T00:00:00.000Z',
            text: {
                extractor: {
                    ...protocolCodec.recordHeader('official-arxiv-fulltext-extraction', 'official-arxiv-fulltext-extraction'),
                    implementation: 'pymupdf'
                },
                fetchedAt: '2026-11-20T00:00:00.000Z',
                filename: 'source.txt', source: 'pdf', sourceId: '2611.99999',
                url: 'https://arxiv.org/pdf/2611.99999.pdf',
                responseBytes: textBytes.length, responseSha256: textSha
            },
            pdf: {
                fetchedAt: '2026-11-20T00:00:00.000Z',
                filename: 'source.pdf',
                url: 'https://arxiv.org/pdf/2611.99999.pdf',
                responseBytes: realPdfBytes.length, responseSha256: realPdfSha
            },
            runtimeMetadata: {
                filename: 'source-runtime.json',
                responseBytes: runtimeBytes.length, responseSha256: sha(runtimeBytes)
            }
        };
        const manifestBytes = canonicalBytes(manifestObj);
        fs.writeFileSync(path.join(bundleDir, 'source.txt'), textBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(bundleDir, 'source.pdf'), realPdfBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(bundleDir, 'source-runtime.json'), runtimeBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(bundleDir, 'source-manifest.json'), manifestBytes, { mode: 0o600 });
        fs.chmodSync(path.join(tmpRoot, '2611.99999'), 0o700);
        fs.chmodSync(bundleDir, 0o700);
        const stored = freshStore.readFreshArxivRewriteSource({ rootDir: tmpRoot, arxivId: '2611.99999', generation: 1 });
        const snapshotDetails = {
            text: stored.text,
            source: stored.manifest.text.source,
            sourceId: stored.manifest.text.sourceId,
            imageInfos: stored.runtimeDetails.imageInfos,
            structuredArtifacts: stored.runtimeDetails.structuredArtifacts,
            readerAuthors: stored.runtimeDetails.readerAuthors,
            htmlAvailability: stored.runtimeDetails.htmlAvailability,
            htmlAttempts: stored.runtimeDetails.htmlAttempts,
            warnings: stored.runtimeDetails.warnings
        };
        const sourceSnapshotSha256 = sha(JSON.stringify({
            sourceManifestSha256: stored.sourceManifestSha256,
            sourceGeneration: 1,
            details: snapshotDetails
        }));
        assert.throws(() => freshCtx.withVerifiedBundleReaderAuthorFiles({
            rootDir: tmpRoot,
            arxivId: '2611.99999',
            generation: 1,
            sourceManifestSha256: stored.sourceManifestSha256,
            sourceSnapshotSha256
        }, () => {}), /source\.pdf 重放结果不一致/);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    // CRITICAL-2: runDailyXmlPython 接受带 <arxiv:affiliation> 的 atom 与 atom-feed 输出
    const atomSource = fs.readFileSync(path.join(ROOT, 'scripts/parse-arxiv-atom.py'), 'utf8');
    const xmlWithAff = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/2611.12345v1</id>
    <published>2026-11-20T00:00:00Z</published>
    <title>Test Paper</title>
    <summary>Abstract body.</summary>
    <author><name>Alice Brown</name><arxiv:affiliation>MIT</arxiv:affiliation></author>
    <author><name>Bob White</name></author>
    <category term="cs.SD"/>
  </entry>
</feed>`, 'utf8');
    const atomRes = dailyXml.runDailyXmlPython(atomSource, xmlWithAff, { cwd: ROOT, outputKind: 'atom' });
    assert.equal(atomRes.status, 0);
    const atomOut = JSON.parse(atomRes.stdout);
    assert.equal(atomOut.length, 1);
    assert.deepEqual(atomOut[0].authorAffiliations, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: [] }
    ]);
    const feedRes = dailyXml.runDailyXmlPython(atomSource, xmlWithAff, { cwd: ROOT, argv: ['--feed-page'], outputKind: 'atom-feed' });
    assert.equal(feedRes.status, 0);
    const feedOut = JSON.parse(feedRes.stdout);
    assert.equal(feedOut.entries.length, 1);
    assert.deepEqual(feedOut.entries[0].authorAffiliations, atomOut[0].authorAffiliations);

    // HIGH-2 #1: 会议 PDF 宽空格并列多机构在压缩空白前被拒绝
    const multiWideConf = [
        'Speech Synthesis Title',
        'Alice Brown, Bob White, Carol Davis',
        'Stanford University   Massachusetts Institute of Technology',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.equal(parser.parseConferencePdfAuthors(multiWideConf), null);

    // HIGH-2 #2: 会议 PDF 机构内嵌数字 "Building 1 Engineering" 不覆盖标记 1
    const embeddedNumConf = [
        'Speech Synthesis Title',
        'Alice Brown 1, Bob White 2',
        '1 Massachusetts Institute of Technology',
        '2 Department of CS, Building 1 Engineering, Stanford University',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    const parsedEmb = parser.parseConferencePdfAuthors(embeddedNumConf);
    assert.ok(parsedEmb);
    assert.deepEqual(parsedEmb.authors, [
        { name: 'Alice Brown', affiliations: ['Massachusetts Institute of Technology'] },
        { name: 'Bob White', affiliations: ['Department of CS, Building 1 Engineering, Stanford University'] }
    ]);

    // HIGH-2 #3 & #4: <sup><math>...</math></sup> 保留标记，且 <sup>*</sup>Denotes equal contribution 不被当成机构
    const htmlMathSup = `<html><body>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author">
          <span class="ltx_personname">Alice Brown<sup><math><mi>†</mi><annotation encoding="application/x-tex">\\dagger</annotation></math></sup><sup>*</sup>, Bob White<sup><math><mi>‡</mi><annotation encoding="application/x-tex">\\ddagger</annotation></math></sup><sup>*</sup></span>
          <span class="ltx_role_affiliation"><sup><math><mi>†</mi><annotation encoding="application/x-tex">\\dagger</annotation></math></sup>MIT<br/><sup><math><mi>‡</mi><annotation encoding="application/x-tex">\\ddagger</annotation></math></sup>Stanford University<br/><sup>*</sup>Denotes equal contribution</span>
        </div>
      </div>
    </body></html>`;
    const parsedMathSup = parser.parseArxivReaderAuthors(cheerio.load(htmlMathSup));
    assert.ok(parsedMathSup);
    assert.deepEqual(parsedMathSup.authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    // HIGH-2 #5: HTML thanks 多子句拆解且过滤非人名主语，同时保持多人共享主语不误拆
    const htmlThanks = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with MIT, and Bob White is with Stanford University. This dataset is from the Open Audio Corpus.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
      </div>
    </body></html>`;
    const parsedThanks = parser.parseArxivReaderAuthors(cheerio.load(htmlThanks));
    assert.ok(parsedThanks);
    assert.deepEqual(parsedThanks.authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    const htmlMultiThanks = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown, Bob White, and Carol Davis are with MIT.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Carol Davis</span></div>
      </div>
    </body></html>`;
    const parsedMultiThanks = parser.parseArxivReaderAuthors(cheerio.load(htmlMultiThanks));
    assert.deepEqual(parsedMultiThanks.authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['MIT'] },
        { name: 'Carol Davis', affiliations: ['MIT'] }
    ]);

    // HIGH-2 #6: alignAuthorNames1to1 Tier 3 拒绝冲突中间名首字母与冲突昵称，同时允许单侧省略
    assert.equal(parser.alignAuthorNames1to1(['John A. Smith'], [{ name: 'John B. Smith', affiliations: ['MIT'] }]), null);
    assert.equal(parser.alignAuthorNames1to1(['John (Alice) Smith'], [{ name: 'John (Bob) Smith', affiliations: ['MIT'] }]), null);
    assert.ok(parser.alignAuthorNames1to1(['John A. Smith'], [{ name: 'John Smith', affiliations: ['MIT'] }]));
    assert.ok(parser.alignAuthorNames1to1(['John (Toby) Smith'], [{ name: 'John Smith', affiliations: ['MIT'] }]));

    // MEDIUM-1: JS 与 Python 元数据分隔符集合完全一致
    const pySepsRes = spawnSync('bash', [path.join(ROOT, 'scripts/python-runtime.sh'), '-c', `
import importlib.util, json, pathlib, sys
sys.path.insert(0, 'scripts')
spec = importlib.util.spec_from_file_location('ptb', pathlib.Path('scripts/publish-to-blog.py'))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
print(json.dumps(sorted(mod._API_READER_AUTHOR_METADATA_SEPARATORS), ensure_ascii=False))
`], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
    assert.equal(pySepsRes.status, 0, pySepsRes.stderr);
    assert.deepEqual([...parser.METADATA_AUTHOR_SEPARATORS].sort(), JSON.parse(pySepsRes.stdout));

    // LOW-1: citation_title 含 <svg> 不破坏 extractAuthorHeaderHtml
    const htmlSvgTitle = `<html><head>
      <meta name="citation_title" content="Neural <svg> Generation">
      <meta name="citation_author" content="Alice Brown">
      <meta name="citation_author_institution" content="MIT">
    </head><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div></div></body></html>`;
    const headerSlice = parser.extractAuthorHeaderHtml(htmlSvgTitle);
    assert.ok(headerSlice.length > 0);
    assert.doesNotMatch(headerSlice, /<svg/i);
});

test('Wave 7 R2 回归：封存 PDF 无 contract 伪造拦截、无标记多机构/内联邮箱、多作者 thanks 二句拆分与 3D 标记保护', () => {
    const os = require('node:os');
    const crypto = require('node:crypto');
    const freshCtx = require('../scripts/lib/fresh-analysis-context.js');
    const freshStore = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
    const protocolCodec = require('../scripts/lib/protocol-codec.js');
    const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

    // R2 #1 (CRITICAL): sealed source:'pdf' bundle with contract-less readerAuthors MUST fail closed
    const realPdfPath = path.join(ROOT, 'data/runtime/daily-fresh-source-runs/7c002250-94e3-4988-9018-f38ee7733a27/sources/2611.25489/generation-000001/source.pdf');
    const realPdfBytes = fs.readFileSync(realPdfPath);
    const realPdfSha = sha(realPdfBytes);
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wave7-r2-pdf-nocontract-')));
    try {
        const bundleDir = path.join(tmpRoot, '2611.99998', 'generation-000001');
        fs.mkdirSync(bundleDir, { recursive: true });
        const textBytes = Buffer.from('A Test Paper Title\nAbstract\nBody.', 'utf8');
        const textSha = sha(textBytes);
        const sortDeep = val => Array.isArray(val) ? val.map(sortDeep)
            : (val && typeof val === 'object' ? Object.fromEntries(Object.keys(val).sort().map(k => [k, sortDeep(val[k])])) : val);
        const canonicalBytes = obj => Buffer.from(`${JSON.stringify(sortDeep(obj), null, 2)}\n`, 'utf8');
        const artifactsBody = { version: 1, source: 'fresh_arxiv_text_without_layout', flattenedTextSha256: textSha, tables: [], formulas: [], figures: [] };
        const artifacts = { ...artifactsBody, payloadSha256: sha(JSON.stringify(sortDeep(artifactsBody))) };
        const runtimeObj = {
            ...protocolCodec.recordHeader('fresh-arxiv-rewrite-runtime-metadata', 'fresh-arxiv-rewrite-runtime-metadata'),
            paperId: 'arxiv:2611.99998',
            textSha256: textSha,
            title: 'A Test Paper Title',
            structuredArtifacts: artifacts,
            imageInfos: [],
            warnings: [],
            htmlAttempts: 0,
            htmlAvailability: 'unavailable',
            readerAuthors: {
                authors: [{ name: 'Alice Brown', affiliations: ['Forged University of Mars'] }],
                sourceDomSha256: 'a'.repeat(64)
            }
        };
        const runtimeBytes = canonicalBytes(runtimeObj);
        const manifestObj = {
            ...protocolCodec.recordHeader('fresh-arxiv-source-manifest', 'fresh-arxiv-source-manifest'),
            arxivId: '2611.99998',
            paperId: 'arxiv:2611.99998',
            generation: 1,
            capturedAt: '2026-11-20T00:00:00.000Z',
            text: {
                extractor: {
                    ...protocolCodec.recordHeader('official-arxiv-fulltext-extraction', 'official-arxiv-fulltext-extraction'),
                    implementation: 'pymupdf'
                },
                fetchedAt: '2026-11-20T00:00:00.000Z',
                filename: 'source.txt', source: 'pdf', sourceId: '2611.99998',
                url: 'https://arxiv.org/pdf/2611.99998.pdf',
                responseBytes: textBytes.length, responseSha256: textSha
            },
            pdf: {
                fetchedAt: '2026-11-20T00:00:00.000Z',
                filename: 'source.pdf',
                url: 'https://arxiv.org/pdf/2611.99998.pdf',
                responseBytes: realPdfBytes.length, responseSha256: realPdfSha
            },
            runtimeMetadata: {
                filename: 'source-runtime.json',
                responseBytes: runtimeBytes.length, responseSha256: sha(runtimeBytes)
            }
        };
        const manifestBytes = canonicalBytes(manifestObj);
        fs.writeFileSync(path.join(bundleDir, 'source.txt'), textBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(bundleDir, 'source.pdf'), realPdfBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(bundleDir, 'source-runtime.json'), runtimeBytes, { mode: 0o600 });
        fs.writeFileSync(path.join(bundleDir, 'source-manifest.json'), manifestBytes, { mode: 0o600 });
        fs.chmodSync(path.join(tmpRoot, '2611.99998'), 0o700);
        fs.chmodSync(bundleDir, 0o700);
        const stored = freshStore.readFreshArxivRewriteSource({ rootDir: tmpRoot, arxivId: '2611.99998', generation: 1 });
        const snapshotDetails = {
            text: stored.text,
            source: stored.manifest.text.source,
            sourceId: stored.manifest.text.sourceId,
            imageInfos: stored.runtimeDetails.imageInfos,
            structuredArtifacts: stored.runtimeDetails.structuredArtifacts,
            readerAuthors: stored.runtimeDetails.readerAuthors,
            htmlAvailability: stored.runtimeDetails.htmlAvailability,
            htmlAttempts: stored.runtimeDetails.htmlAttempts,
            warnings: stored.runtimeDetails.warnings
        };
        const sourceSnapshotSha256 = sha(JSON.stringify({
            sourceManifestSha256: stored.sourceManifestSha256,
            sourceGeneration: 1,
            details: snapshotDetails
        }));
        assert.throws(() => freshCtx.withVerifiedBundleReaderAuthorFiles({
            rootDir: tmpRoot,
            arxivId: '2611.99998',
            generation: 1,
            sourceManifestSha256: stored.sourceManifestSha256,
            sourceSnapshotSha256
        }, () => {}), /pdf-page1-author-evidence-v1/);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    // R2 #2 (HIGH): Conference PDF unmarked fallback rejects 2nd inst with inline email, non-keyword 2nd org, and 2-space side-by-side
    const confInlineEmailInst2 = [
        'Audio Paper Title',
        'Alice Brown, Bob White',
        'University of Michigan',
        'Stanford University, bob@stanford.edu',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.equal(parser.parseConferencePdfAuthors(confInlineEmailInst2), null);

    const confNonKeywordOrg2 = [
        'Audio Paper Title',
        'Alice Brown, Bob White',
        'University of Michigan',
        'Anthropic PBC',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.equal(parser.parseConferencePdfAuthors(confNonKeywordOrg2), null);

    const confUnlistedOrg2 = [
        'Audio Paper Title',
        'Alice Brown, Bob White',
        'University of Michigan',
        'Mistral',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.equal(parser.parseConferencePdfAuthors(confUnlistedOrg2), null);

    const confTwoSpaceMulti = [
        'Audio Paper Title',
        'Alice Brown, Bob White',
        'Stanford University  Massachusetts Institute of Technology',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.equal(parser.parseConferencePdfAuthors(confTwoSpaceMulti), null);

    // R2 #3 (HIGH): HTML thanks multi-author 2nd clause splits cleanly without gluing authors into Inst 1
    const htmlThanksWhile = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with MIT, while Bob White, Carol Davis, and David Lee are with Stanford University.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Carol Davis</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">David Lee</span></div>
      </div>
    </body></html>`;
    const parsedWhile = parser.parseArxivReaderAuthors(cheerio.load(htmlThanksWhile));
    assert.deepEqual(parsedWhile.authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] },
        { name: 'Carol Davis', affiliations: ['Stanford University'] },
        { name: 'David Lee', affiliations: ['Stanford University'] }
    ]);

    const htmlThanksLoc = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with Columbia University, New York, United States, and Bob White, Carol Davis are with Stanford University.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Carol Davis</span></div>
      </div>
    </body></html>`;
    const parsedLoc = parser.parseArxivReaderAuthors(cheerio.load(htmlThanksLoc));
    assert.deepEqual(parsedLoc.authors, [
        { name: 'Alice Brown', affiliations: ['Columbia University, New York, United States'] },
        { name: 'Bob White', affiliations: ['Stanford University'] },
        { name: 'Carol Davis', affiliations: ['Stanford University'] }
    ]);

    // R2 #5 (MEDIUM): HTML marked parser does NOT let "3D Vision Lab" steal numeric marker 3
    const html3D = `<html><body>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author">
          <span class="ltx_personname">Alice Brown<sup>1</sup>, Bob White<sup>3</sup></span>
          <span class="ltx_role_affiliation">3D Vision Lab<br/><sup>1</sup>MIT<br/><sup>3</sup>Stanford University</span>
        </div>
      </div>
    </body></html>`;
    const parsed3D = parser.parseArxivReaderAuthors(cheerio.load(html3D));
    assert.deepEqual(parsed3D.authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);
});

test('Wave 7 R3 回归：thanks 机构/城市/无逗号拆分、无标记旁置/品牌/Unicode 多机构、author-prefixed role、3DGS/街道与标题含关键词', () => {
    // R3 #1: JS thanks 不被机构名/未枚举城市截断，且支持无逗号连词拆分
    const htmlThanksUniv = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with Department of Computer Science, Stanford University, and Bob White is with MIT.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlThanksUniv)).authors, [
        { name: 'Alice Brown', affiliations: ['Department of Computer Science, Stanford University'] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ]);

    const htmlThanksCity = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with University of California, Santa Cruz, and Bob White is with MIT.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlThanksCity)).authors, [
        { name: 'Alice Brown', affiliations: ['University of California, Santa Cruz'] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ]);

    const htmlThanksNoComma = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with MIT and Bob White is with Stanford University.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlThanksNoComma)).authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    // R3 #2: JS conference PDF 无标记回退拒绝旁置非关键词机构、Org+State、小写品牌、括号与 Unicode 机构
    for (const badConf of [
        'Title\nAlice Brown, Bob White\nStanford University  Anthropic\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University, alice@stanford.edu  Anthropic, bob@anthropic.com\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University\nAnthropic, CA\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University\nxAI\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University\niFLYTEK\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University\nElevenLabs (London)\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University\nTélécom Paris\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, badConf);
    }

    // R3 #4: HTML author-prefixed equal-contribution footnote 不泄漏为机构
    const htmlAuthorRole = `<html><body>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author">
          <span class="ltx_personname">Anastasia Geleta<sup>1,*</sup>, Margarita Geleta<sup>1,*</sup></span>
          <span class="ltx_role_affiliation"><sup>1</sup>UC Berkeley<br/><sup>*</sup>A. Geleta and M. Geleta contributed equally to this work.</span>
        </div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlAuthorRole)).authors, [
        { name: 'Anastasia Geleta', affiliations: ['UC Berkeley'] },
        { name: 'Margarita Geleta', affiliations: ['UC Berkeley'] }
    ]);

    // R3 #5: 两遍标记解析使显式 <sup> 优先于原始行首数字，并阻止街道地址与 3DGS 抢占
    const htmlStreet = `<html><body>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author">
          <span class="ltx_personname">Alice Brown<sup>1</sup>, Bob White<sup>2</sup></span>
          <div class="ltx_role_address">1 Microsoft Way, Redmond, WA<br/><sup>1</sup>Stanford University<br/><sup>2</sup>MIT</div>
        </div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlStreet)).authors, [
        { name: 'Alice Brown', affiliations: ['Stanford University'] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ]);

    const html3DGS = `<html><body>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author">
          <span class="ltx_personname">Alice Brown<sup>1</sup>, Bob White<sup>3</sup></span>
          <span class="ltx_role_affiliation">3DGS Research Group<br/><sup>1</sup>MIT<br/><sup>3</sup>Stanford University</span>
        </div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html3DGS)).authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    // R3 #6: 会议 PDF 标题含 Systems/Research/Vision 时仍正常解析单一机构
    const confTitleSystems = [
        'End-to-End Speech Recognition Systems',
        'Alice Brown, Bob White',
        'University of Michigan',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    const parsedSystems = parser.parseConferencePdfAuthors(confTitleSystems);
    assert.ok(parsedSystems);
    assert.deepEqual(parsedSystems.authors, [
        { name: 'Alice Brown', affiliations: ['University of Michigan'] },
        { name: 'Bob White', affiliations: ['University of Michigan'] }
    ]);
});

test('Wave 7 R4 回归：thanks 多子句/缩写句点/倒序姓名、无标记前置非关键词机构与位置尾多机构、尾部通信作者剥离', () => {
    // R4 #1: Tier 3 leftmost split + Org. period separator + Last, First author key + U.S.A. non-person
    const htmlThanksMulti = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with Tencent Inc. Bob White is with University of California, Santa Cruz, and Carol Davis and David Lee are with MIT, U.S.A.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Brown, Alice</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White, Carol Davis, and David Lee</span></div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlThanksMulti)).authors, [
        { name: 'Brown, Alice', affiliations: ['Tencent Inc.'] },
        { name: 'Bob White', affiliations: ['University of California, Santa Cruz'] },
        { name: 'Carol Davis', affiliations: ['MIT, U.S.A.'] },
        { name: 'David Lee', affiliations: ['MIT, U.S.A.'] }
    ]);

    const htmlThanksThree = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with Stanford University, Bob White is with MIT, and Carol Davis is with CMU.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Carol Davis</span></div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlThanksThree)).authors, [
        { name: 'Alice Brown', affiliations: ['Stanford University'] },
        { name: 'Bob White', affiliations: ['MIT'] },
        { name: 'Carol Davis', affiliations: ['CMU'] }
    ]);

    // R4 #2: JS conference PDF unmarked fallback rejects pre-extra non-keyword org & Org+Loc followed by Org2+Loc
    for (const badConf of [
        'Title\nAlice Brown, Bob White\nAnthropic\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nAnthropic, alice@anthropic.com\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University, USA\nCartesia, USA\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, badConf);
    }

    // R4 #4: Trailing corresponding author / contact clause stripped from affiliations
    assert.equal(
        parser.sanitizeReaderAffiliationValue('Tsinghua University — Corresponding author: Alice Brown'),
        'Tsinghua University'
    );
    assert.equal(
        parser.sanitizeReaderAffiliationValue('MIT; contact: bob@mit.edu'),
        'MIT'
    );
    assert.equal(
        parser.sanitizeReaderAffiliationValue('Work done at Google Research'),
        ''
    );

    // R4 #5: Glued numeric marker "1Department" and "2DeepMind" not blocked by [1-4]D pattern
    const confGlued = [
        'Speech Synthesis Study',
        'Alice Brown 1, Bob White 2',
        '1Department of Computer Science, Stanford University',
        '2DeepMind',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    const parsedGlued = parser.parseConferencePdfAuthors(confGlued);
    assert.ok(parsedGlued);
    assert.deepEqual(parsedGlued.authors, [
        { name: 'Alice Brown', affiliations: ['Department of Computer Science, Stanford University'] },
        { name: 'Bob White', affiliations: ['DeepMind'] }
    ]);
});

test('Wave 7 R5 回归：ReDoS 线性时间、thanks 城市与缩写续句、中间名冲突与去重、无标记多机构与 3D/地址防护', () => {
    // R5 #1: sanitizeReaderAffiliationValue 消除嵌套量词 ReDoS，n=40 在 <50ms 内返回，并支持多段链式剥离
    const redosInput = 'MIT' + '; Email: '.repeat(40);
    const t0 = Date.now();
    const redosOut = parser.sanitizeReaderAffiliationValue(redosInput);
    const elapsed = Date.now() - t0;
    assert.equal(redosOut, 'MIT');
    assert.ok(elapsed < 50, `sanitizeReaderAffiliationValue ReDoS guard failed (${elapsed}ms)`);
    assert.equal(
        parser.sanitizeReaderAffiliationValue('KAIST; Corresponding author: Alice Brown; contact: a@kaist.ac.kr'),
        'KAIST'
    );
    assert.equal(
        parser.sanitizeReaderAffiliationValue('KAIST *Equal contribution. Corresponding author: Alice Brown'),
        'KAIST'
    );
    assert.equal(
        parser.sanitizeReaderAffiliationValue('Huawei Technologies Co., Ltd. 1An earlier version of this paper was presented at ICASSP 2025.'),
        'Huawei Technologies Co., Ltd.'
    );

    // R5 #2: earlierT1 不截断 Santa Cruz，abbrRe 后新句不粘连，U.S./D.C. 正确保留，中间名首字母匹配 knownAuthorKeys
    const htmlSantaCruz = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with University of California, Santa Cruz, and Bob White and Carol Davis are with MIT.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Carol Davis</span></div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlSantaCruz)).authors, [
        { name: 'Alice Brown', affiliations: ['University of California, Santa Cruz'] },
        { name: 'Bob White', affiliations: ['MIT'] },
        { name: 'Carol Davis', affiliations: ['MIT'] }
    ]);

    const htmlDcUs = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with Dept. of Speech, Washington, D.C., U.S. Bob White is with Huawei Technologies Co., Ltd. An earlier version of this work appeared at ICASSP.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice A. Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlDcUs)).authors, [
        { name: 'Alice A. Brown', affiliations: ['Dept. of Speech, Washington, D.C., U.S.'] },
        { name: 'Bob White', affiliations: ['Huawei Technologies Co., Ltd.'] }
    ]);

    // R5 #3: lookupThanksForName 拒绝中间名冲突、防双射抢占，且 markedHtml 与 metaAuthors 不重复追加已消费 thanks
    const htmlMidConflict = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">John A. Smith is with MIT.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">John B. Smith</span></div>
      </div>
    </body></html>`;
    const parsedConflict = parser.parseArxivReaderAuthors(cheerio.load(htmlMidConflict));
    assert.ok(parsedConflict);
    const conflictEntry = parsedConflict.authors.find(a => a.name === 'John B. Smith');
    assert.ok(conflictEntry);
    assert.ok(!conflictEntry.affiliations.includes('MIT'), 'John B. Smith must not bind John A. Smith thanks');

    const htmlNoSteal = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">John A. Smith is with MIT.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">John Smith</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">John A. Smith</span></div>
      </div>
    </body></html>`;
    const parsedNoSteal = parser.parseArxivReaderAuthors(cheerio.load(htmlNoSteal));
    assert.ok(parsedNoSteal);
    assert.equal(parsedNoSteal.authors.length, 2);
    const byNameMid = Object.fromEntries(parsedNoSteal.authors.map(a => [a.name, a.affiliations]));
    assert.deepEqual(byNameMid['John A. Smith'], ['MIT']);
    assert.ok(!byNameMid['John Smith'].includes('MIT'), 'John Smith must not steal John A. Smith thanks');

    const htmlMarkedWithThanks = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with MIT. Bob White is with Stanford University.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author">
          <span class="ltx_personname">Alice A. Brown<sup>1</sup>, Bob White<sup>2</sup></span>
          <span class="ltx_role_affiliation"><sup>1</sup>MIT<br/><sup>2</sup>Stanford University</span>
        </div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlMarkedWithThanks)).authors, [
        { name: 'Alice A. Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    const htmlMetaOnlyThanks = `<html><head>
      <meta name="citation_author" content="Alice A. Brown">
      <meta name="citation_author" content="Bob White">
    </head><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with MIT. Bob White is with Stanford University.</span>
      </h1>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlMetaOnlyThanks)).authors, [
        { name: 'Alice A. Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    // R5 #4: 无标记单机构拒绝 pre-extra Org+State、邮编尾 Org2、post-email Org2，Scale AI/Meta FAIR 不误当作者，但保留 Yang Ai
    for (const badConf of [
        'Title\nAlice Brown, Bob White\nAnthropic, CA\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University\nAnthropic, CA 94305\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University\nalice@stanford.edu\nAnthropic, USA\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nScale AI\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nMeta FAIR\nStanford University\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, badConf);
    }
    const yangAiConf = [
        'Speech Synthesis Study',
        'Yang Ai, Bob White',
        'University of Science and Technology of China',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.deepEqual(parser.parseConferencePdfAuthors(yangAiConf)?.authors, [
        { name: 'Yang Ai', affiliations: ['University of Science and Technology of China'] },
        { name: 'Bob White', affiliations: ['University of Science and Technology of China'] }
    ]);

    // R5 #5: 会议 PDF 标记解析阻止 3DGS 与 1 Microsoft Way 抢占数字标记
    const conf3dStreet = [
        'Neural Rendering Audio',
        'Alice Brown 1, Bob White 3',
        '1 Microsoft Way, Redmond, WA',
        '3DGS Vision Lab',
        '1 Stanford University',
        '3 Massachusetts Institute of Technology',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    const parsed3dStreet = parser.parseConferencePdfAuthors(conf3dStreet);
    assert.ok(parsed3dStreet);
    assert.deepEqual(parsed3dStreet.authors, [
        { name: 'Alice Brown', affiliations: ['Stanford University'] },
        { name: 'Bob White', affiliations: ['Massachusetts Institute of Technology'] }
    ]);

    // R5 #6: 残留泄漏过滤（首字母姓名、Work done as an intern、correspondence should be addressed、Life Senior Member IEEE、CRediT）
    assert.equal(parser.sanitizeReaderAffiliationValue('Work done as an intern at Google'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('Author to whom correspondence should be addressed: alice@mit.edu'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('Life Senior Member, IEEE'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('Senior Member, IEEE, Fellow, IEEE'), '');
    const htmlCreditAndInit = `<html><body>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author">
          <span class="ltx_personname">Alice Brown<sup>1,*</sup>, Bob White<sup>2,†</sup></span>
          <span class="ltx_role_affiliation"><sup>1</sup>MIT<br/><sup>2</sup>Stanford University<br/><sup>*</sup>A. Brown: conceptualization, methodology, and<br/><sup>†</sup>Work done as an intern at Meta</span>
        </div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlCreditAndInit)).authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);
});

test('Wave 7 R6 回归：尾分号预裁剪、meta 不污染 DOM、2-to-1 防抢占、CRediT 精准保留实验室、未标记多机构与街道边界、真实姓氏保留', () => {
    // R6 #1: Trailing semicolon short-circuit before tail-windowed loop
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown; {a,b}@mit.edu'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown;'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Equal contribution;'), 'MIT');

    // R6 #2: <meta> citation_author must NOT pollute DOM exactCandidateRawKeys, AND 2-to-1 non-exact steal must be blocked
    const htmlMetaAsciiDomAccent = `<html><head>
      <meta name="citation_author" content="Alice Brown">
      <meta name="citation_author" content="Amelie Royer">
    </head><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">Alice Brown is with MIT. Amelie Royer is with Kyutai.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice A. Brown</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Amélie Royer</span></div>
      </div>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlMetaAsciiDomAccent)).authors, [
        { name: 'Alice A. Brown', affiliations: ['MIT'] },
        { name: 'Amélie Royer', affiliations: ['Kyutai'] }
    ]);

    const htmlTwoToOneSteal = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">John Smith is with MIT.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">John A. Smith</span></div>
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">John B. Smith</span></div>
      </div>
    </body></html>`;
    const twoToOneAuthors = parser.parseArxivReaderAuthors(cheerio.load(htmlTwoToOneSteal)).authors;
    const johnA = twoToOneAuthors.find(a => a.name === 'John A. Smith');
    const johnB = twoToOneAuthors.find(a => a.name === 'John B. Smith');
    assert.ok(johnA && johnA.affiliations.every(a => /^机构信息未/.test(a)), `John A. Smith must not steal MIT: ${JSON.stringify(johnA)}`);
    assert.ok(johnB && johnB.affiliations.every(a => /^机构信息未/.test(a)), `John B. Smith must remain unbound: ${JSON.stringify(johnB)}`);

    // R6 #3: Narrowed CRediT preserves legitimate departments/labs while rejecting meta headings & bare domains
    for (const legitDept of [
        'Institute of Computer Graphics and Visualization',
        'Department of Statistical Methodology',
        'Verification and Validation Lab',
        'Center for Scientific Investigation',
        'Division of Supervision and Control'
    ]) {
        assert.equal(parser.sanitizeReaderAffiliationValue(legitDept), legitDept);
    }
    assert.equal(parser.sanitizeReaderAffiliationValue('Paper Author Roles and Affiliations'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('inc.com'), '');

    // R6 #4: JS sawResourceAfterInst + inline-email <Org>, <State> bypasses blocked
    for (const badConf of [
        'Title\nAlice Brown, Bob White\nStanford University\nalice@stanford.edu\nSesame, CA\nbob@sesame.com\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nSesame, CA, alice@sesame.com\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University, CA\nSesame, CA, bob@sesame.com\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, badConf);
    }

    // R6 #5: Oxford-comma 3+-author thanks clauses with middle-initial mismatch parse all 4 authors cleanly
    for (const conj of ['while', 'and']) {
        const htmlOxford = `<html><body>
          <h1 class="ltx_title_document">Title
            <span class="ltx_note ltx_role_thanks">Alice Brown is with Stanford University, ${conj} Bob White, Carol Davis, and David M. Lee are with MIT.</span>
          </h1>
          <div class="ltx_authors">
            <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
            <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></div>
            <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Carol Davis</span></div>
            <div class="ltx_creator ltx_role_author"><span class="ltx_personname">David Lee</span></div>
          </div>
        </body></html>`;
        assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlOxford)).authors, [
            { name: 'Alice Brown', affiliations: ['Stanford University'] },
            { name: 'Bob White', affiliations: ['MIT'] },
            { name: 'Carol Davis', affiliations: ['MIT'] },
            { name: 'David Lee', affiliations: ['MIT'] }
        ], `Failed Oxford-comma thanks with ${conj}`);
    }

    // R6 #6: Bare street address St. rejected, legitimate numbered affiliations with street addresses KEPT, symbol loop guards
    const confBareSt = [
        'Title',
        'Alice Brown 1, Bob White 2',
        '1 Main St., Cambridge, MA, USA',
        '1 Stanford University',
        '2 MIT',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.deepEqual(parser.parseConferencePdfAuthors(confBareSt)?.authors, [
        { name: 'Alice Brown', affiliations: ['Stanford University'] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ]);

    const confLegitStreet1 = [
        'Title',
        'Alice Brown 1, Bob White 2',
        '1 University of Toronto, 40 St. George Street, Toronto, Canada',
        '2 MIT',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.deepEqual(parser.parseConferencePdfAuthors(confLegitStreet1)?.authors, [
        { name: 'Alice Brown', affiliations: ['University of Toronto, 40 St. George Street, Toronto, Canada'] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ]);

    const confLegitStreet2 = [
        'Title',
        'Alice Brown 1, Bob White 2',
        '1 Microsoft Research, One Microsoft Way, Redmond, WA',
        '2 Stanford University',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.deepEqual(parser.parseConferencePdfAuthors(confLegitStreet2)?.authors, [
        { name: 'Alice Brown', affiliations: ['Microsoft Research, One Microsoft Way, Redmond, WA'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    const confSymRole = [
        'Title',
        'Alice Brown†,*, Bob White‡,*',
        '†MIT',
        '‡Stanford University',
        '*Alice Brown is the corresponding author at Stanford University',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.deepEqual(parser.parseConferencePdfAuthors(confSymRole)?.authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    // R6 #7: Real surnames Masaaki Honda, Yang AI / YANG AI, David Cloud, John Fair, Louis ten Bosch preserved
    for (const pair of [
        ['Masaaki Honda', 'Bob White'],
        ['Yang AI', 'Bob White'],
        ['YANG AI', 'BOB WHITE'],
        ['David Cloud', 'John Fair'],
        ['Louis ten Bosch', 'Bob White']
    ]) {
        const confText = `Speech Research Paper\n${pair[0]}, ${pair[1]}\nUniversity of Tokyo\n\nAbstract\nBody.`;
        const parsed = parser.parseConferencePdfAuthors(confText);
        assert.ok(parsed, `Expected valid authors for ${pair.join(', ')}`);
        assert.deepEqual(parsed.authors.map(a => a.name), pair);
    }
});

test('Wave 7 R7 回归：未列名 AI 机构防误绑、内联邮箱首机构 sawResourceAfterInst、ORCID/残余点号剥离、thanks 混合连词/牛津逗号与 Grant/Athena 真实姓名保留', () => {
    // R7 #2: Unlisted "<Org> AI" (e.g. Pine AI) rejected on unmarked multi-inst & pre-extra-org rows, while Yang AI / YANG AI preserved
    for (const badConf of [
        'Title\nAlice Brown, Bob White\nPine AI\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nPine AI  University of Washington\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, `R7 #2 expected null: ${badConf}`);
    }

    // R7 #3: Inline-email Inst 1 sets sawResourceAfterInst so following <Org2>, <State> marks ambiguous
    for (const badConf of [
        'Title\nAlice Brown, Bob White\nStanford University, alice@stanford.edu\nSesame, CA\nbob@sesame.com\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University, alice@stanford.edu\nSesame, CA, bob@s-ai.com\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, `R7 #3 expected null: ${badConf}`);
    }

    // R7 #4: ORCID / dangling "; ." stripped BEFORE tail-windowed role loop
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown; ORCID: 0000-0002-1825-0097'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown; .'), 'MIT');

    // R7 #5: Thanks splitter handles non-comma " and " and comma-splice before 3+-author Oxford-comma lists
    const htmlThanksNonComma = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">A. Brown is with Stanford University and B. White, C. Davis, and D. Lee are with MIT.</span>
      </h1>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlThanksNonComma)).authors, [
        { name: 'A. Brown', affiliations: ['Stanford University'] },
        { name: 'B. White', affiliations: ['MIT'] },
        { name: 'C. Davis', affiliations: ['MIT'] },
        { name: 'D. Lee', affiliations: ['MIT'] }
    ]);

    const htmlThanksCommaSplice = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks">A. Brown is with Stanford University, B. White, C. Davis, and D. Lee are with MIT.</span>
      </h1>
    </body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlThanksCommaSplice)).authors, [
        { name: 'A. Brown', affiliations: ['Stanford University'] },
        { name: 'B. White', affiliations: ['MIT'] },
        { name: 'C. Davis', affiliations: ['MIT'] },
        { name: 'D. Lee', affiliations: ['MIT'] }
    ]);

    // R7 #8: Real authors Christan Grant, Athena Dai preserved; Grant Support still blocked
    for (const pair of [
        ['Christan Grant', 'Zoey Liu'],
        ['Athena Dai', 'Bob White']
    ]) {
        const parsed = parser.parseConferencePdfAuthors(`Audio Research Paper\n${pair[0]}, ${pair[1]}\nUniversity of Florida\n\nAbstract\nBody.`);
        assert.ok(parsed, `Expected valid authors for ${pair.join(', ')}`);
        assert.deepEqual(parsed.authors.map(a => a.name), pair);
    }
    assert.equal(parser.parseConferencePdfAuthors('Audio Research Paper\nGrant Support, Grant Agreement\nUniversity of Florida\n\nAbstract\nBody.'), null);
});

test('Wave 7 R8 回归：ReDoS 线性时间、Pine AI/URL/双非关键词多机构、二行 Athena Dai 作者保留、ORCID/DOI/e-mail 对齐与多词州/省份防伪作者', () => {
    // R8 #1 (CRITICAL): Linear-time O(n) dangling tail stripping — n=50000 completes in <100ms
    const redosPayload = 'MIT; ' + ' . '.repeat(50000) + 'x';
    const t0 = Date.now();
    const out = parser.sanitizeReaderAffiliationValue(redosPayload);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `R8 #1 ReDoS guard failed (${elapsed}ms)`);
    assert.ok(out.startsWith('MIT'));
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; . , ; .'), 'MIT');

    // R8 #2: Unlisted AI / URL / two non-keyword orgs on unmarked lines rejected (no misbinding)
    for (const badConf of [
        'Title\nAlice Brown, Bob White\nPine AI, alice@pine.ai\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nAnthropic, https://anthropic.com\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University, www.stanford.edu\nSesame, CA\nbob@sesame.com\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University\nPine AI, CA\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nStanford University\nBoston Dynamics, MA\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nOpenAI  Anthropic\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nPine AI  OpenAI\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, `R8 #2 expected null: ${badConf}`);
    }

    // R8 #3: 2nd-line authors starting with Athena Dai not hijacked into affiliation
    const confAthenaLine2 = [
        'Speech Synthesis Study',
        'Alice Brown, Bob White',
        'Athena Dai, Carol Davis',
        'Stanford University',
        '',
        'Abstract',
        'Body.'
    ].join('\n');
    assert.deepEqual(parser.parseConferencePdfAuthors(confAthenaLine2)?.authors, [
        { name: 'Alice Brown', affiliations: ['Stanford University'] },
        { name: 'Bob White', affiliations: ['Stanford University'] },
        { name: 'Athena Dai', affiliations: ['Stanford University'] },
        { name: 'Carol Davis', affiliations: ['Stanford University'] }
    ]);

    // R8 #5: Trailing DOI / ORCID (lowercase / trailing dot / bare whitespace) / parenthetical e-mail parity
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown; | DOI: 10.1109/ICASSP.2026.12345.'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown doi: 10.1109/ICASSP.2026.12345'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown; orcid: 0000-0002-1825-0097.'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown; (e-mail: a@mit.edu).'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown; e-mail: a@mit.edu'), 'MIT');

    // R8 #6: Multi-word US states / Canadian provinces / meta headings rejected as phantom authors
    for (const badConf of [
        'Title\nAlice Brown, Bob White\nNew York, New York\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nSalt Lake City, Utah\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nVancouver, British Columbia\nStanford University\n\nAbstract\nBody.',
        'Title\nAlice Brown, Bob White\nChapel Hill, North Carolina\nStanford University\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, `R8 #6 expected null: ${badConf}`);
    }
    assert.equal(parser.parseConferencePdfAuthors('Title\nAlice Brown, Bob White\nPaper Authors\nMIT\n\nAbstract\nBody.')?.authors.some(a => /Paper Authors/i.test(a.name)), false);
});

test('Wave 7 R9 回归：热路径全部 O(n²) ReDoS 消除、城市不伪造机构且不破坏单机构论文、链式 ORCID+DOI、点号/括号邮箱与 Pine AI/Athena 单行防护', () => {
    // R9 #1: All hot-path ReDoS payloads complete in <150ms
    const cases = [
        () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">${'a'.repeat(30000)}</span></div></div></body></html>`)),
        () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">${'\\inst{'.repeat(10000)}</span></div></div></body></html>`)),
        () => parser.parseConferencePdfAuthors(`Title\n${'a* '.repeat(10000)}x\nABSTRACT\nBody`),
        () => parser.sanitizeReaderAffiliationValue('{a, '.repeat(20000) + '!'),
        () => parser.sanitizeReaderAffiliationValue('MIT ' + '(email '.repeat(10000)),
        () => parser.sanitizeReaderAffiliationValue('\\inst{'.repeat(10000)),
        () => parser.parseConferencePdfAuthors(`Title\nAlice Brown, Bob White\n${'A'.repeat(30000)}  Stanford University\nABSTRACT\nBody`)
    ];
    for (let i = 0; i < cases.length; i++) {
        const t0 = Date.now();
        cases[i]();
        const dt = Date.now() - t0;
        assert.ok(dt < 150, `R9 #1 JS ReDoS case ${i} took ${dt}ms`);
    }

    // R9 #2: Bare city/country lines do not fabricate affiliations and do not break valid single-institution papers
    for (const locOnly of ['Beijing, China', 'Paris, France', 'San Francisco, CA']) {
        assert.equal(
            parser.parseConferencePdfAuthors(`Speech Recognition Study\nAlice Brown, Bob White\n${locOnly}\n\nAbstract\nBody.`),
            null,
            `R9 #2 city-only must return null: ${locOnly}`
        );
    }
    for (const [inst, loc] of [
        ['Tsinghua University', 'Beijing, China'],
        ['Stanford University', 'Stanford, USA'],
        ['University of California', 'San Francisco, CA']
    ]) {
        const parsed = parser.parseConferencePdfAuthors(`Speech Recognition Study\nAlice Brown, Bob White\n${inst}\n${loc}\n\nAbstract\nBody.`);
        assert.deepEqual(parsed?.authors, [
            { name: 'Alice Brown', affiliations: [inst] },
            { name: 'Bob White', affiliations: [inst] }
        ], `R9 #2 valid single-inst + location: ${inst} / ${loc}`);
    }

    // R9 #4: Chained trailing ORCID + DOI and multiple ORCIDs strip cleanly without leaking Corresponding author
    assert.equal(
        parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown; ORCID: 0000-0002-1825-0097; DOI: 10.1109/ICASSP.2026.12345'),
        'MIT'
    );
    assert.equal(
        parser.sanitizeReaderAffiliationValue('MIT; Corresponding author: Alice Brown; ORCID: 0000-0002-1825-0097; ORCID: 0000-0001-5109-3700'),
        'MIT'
    );

    // R9 #5: Whitespace-preceded dots ("MIT .", "MIT . . .") & parenthesized brace-email ("MIT ({a,b}@mit.edu)")
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT (e-mail: a@mit.edu) .'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT . . .'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT ({a,b}@mit.edu)'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('Huawei Technologies Inc.'), 'Huawei Technologies Inc.');

    // R9 #6: Multi-org unlisted AI ("Pine AI, Nova AI") rejected as authors; single-author 2nd-line "Athena Dai" not hijacked as affiliation
    assert.equal(
        parser.parseConferencePdfAuthors('Speech Recognition Study\nAlice Brown, Bob White\nPine AI, Nova AI\nStanford University\n\nAbstract\nBody.'),
        null
    );
    assert.equal(
        parser.parseConferencePdfAuthors('Speech Recognition Study\nAlice Brown, Bob White\nAthena Dai\n\nAbstract\nBody.'),
        null
    );
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Recognition Study\nAlice Brown, Bob White\nAthena Dai\nStanford University\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Alice Brown', affiliations: ['Stanford University'] },
            { name: 'Bob White', affiliations: ['Stanford University'] },
            { name: 'Athena Dai', affiliations: ['Stanford University'] }
        ]
    );
});

test('Wave 7 R10 回归：全热路径 O(n) 尾游标消 ReDoS、分号/宽空格多机构、单行作者与 Athena Health/Mila、括号邮箱/逗号粘连、1*/†* 粘连标记与三段/非ASCII地名', () => {
    // R10 #1: All newly audited ReDoS & quadratic loop rescans complete in <150ms
    const redosCases = [
        () => parser.sanitizeReaderAffiliationValue('10.1234/'.repeat(8000) + '!'),
        () => parser.sanitizeReaderAffiliationValue('MIT' + '; 0000-0002-1825-0097'.repeat(4000)),
        () => parser.sanitizeReaderAffiliationValue('A-'.repeat(4000) + '; Corresponding author: x'.repeat(2000)),
        () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">${'1'.repeat(20000)}</span></div></div></body></html>`)),
        () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><h1 class="ltx_title_document">T<span class="ltx_note ltx_role_thanks">${'(email '.repeat(8000)}</span></h1></body></html>`)),
        () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><table><tr><td>${'a'.repeat(20000)}</td></tr><tr><td>MIT</td></tr></table></body></html>`)),
        () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span><span class="ltx_role_affiliation"><math>${'\\text{'.repeat(8000)}</math></span></div></div></body></html>`)),
        () => parser.parseConferencePdfAuthors(`Title\nAlice1, Bob2\n1 MIT${'\u2002'.repeat(8000)}University\nABSTRACT\nBody`),
        () => parser.parseConferencePdfAuthors(`Title\nAlice1, Bob2\n1 MIT${' '.repeat(8000)}1a University\nABSTRACT\nBody`),
        () => parser.parseConferencePdfAuthors(`Title\nAlice1, Bob2\n1 ${'10.1234/'.repeat(8000)}!\nABSTRACT\nBody`),
        () => parser.parseConferencePdfAuthors(`Title\na1${'*'.repeat(8000)}!\nABSTRACT\nBody`)
    ];
    for (let i = 0; i < redosCases.length; i++) {
        const t0 = Date.now();
        redosCases[i]();
        const dt = Date.now() - t0;
        assert.ok(dt < 150, `R10 #1 JS ReDoS case ${i} took ${dt}ms`);
    }

    // R10 #4: Semicolon & wide-space multi-org bypasses rejected; 2nd-line Carol Davis kept; Athena Health rejected; Mila Novak kept
    for (const badConf of [
        'Speech Study\nAlice Brown, Bob White\nAnthropic; Mistral\nStanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nStanford University\nAnthropic; Mistral\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nPine AI; Nova AI\nStanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nPine AI   Nova AI\nStanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nAthena Health\nStanford University\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, `R10 #4 expected null: ${badConf}`);
    }
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Study\nAlice Brown, Bob White\nCarol Davis\nStanford University\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Alice Brown', affiliations: ['Stanford University'] },
            { name: 'Bob White', affiliations: ['Stanford University'] },
            { name: 'Carol Davis', affiliations: ['Stanford University'] }
        ]
    );
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Study\nMila Novak, Bob White\nUniversity of Toronto\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Mila Novak', affiliations: ['University of Toronto'] },
            { name: 'Bob White', affiliations: ['University of Toronto'] }
        ]
    );

    // R10 #5: Parenthesized brace-email with trailing punctuation/role & comma-glued emails
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT ({a,b}@mit.edu).'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT ({a,b}@mit.edu); Equal contribution'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University,alice@stanford.edu'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT,alice@mit.edu'), 'MIT');
    const htmlCommaEmail = `<html><body><div class="ltx_authors">
      <div class="ltx_creator ltx_role_author">
        <span class="ltx_personname">Alice Brown,alice@mit.edu</span>
        <span class="ltx_contact ltx_role_affiliation">MIT</span>
      </div>
    </div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlCommaEmail)).authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] }
    ]);
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Title\nAlice Brown, Bob White\nStanford University,alice@stanford.edu\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Alice Brown', affiliations: ['Stanford University'] },
            { name: 'Bob White', affiliations: ['Stanford University'] }
        ]
    );

    // R10 #6: Glued symbol markers (1*, †*) do NOT drop authors
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Study\nAlice Brown1*, Bob White2\n1 MIT\n2 Stanford University\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Alice Brown', affiliations: ['MIT'] },
            { name: 'Bob White', affiliations: ['Stanford University'] }
        ]
    );
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Study\nAlice Brown†*, Bob White‡\n† MIT\n‡ Stanford University\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Alice Brown', affiliations: ['MIT'] },
            { name: 'Bob White', affiliations: ['Stanford University'] }
        ]
    );

    // R10 #7: 3-part locations (Stanford, CA, USA; Beijing, 100084, China) & non-ASCII cities (Zürich, Switzerland)
    for (const [inst, loc] of [
        ['Stanford University', 'Stanford, CA, USA'],
        ['Tsinghua University', 'Beijing, 100084, China'],
        ['ETH Zurich', 'Zürich, Switzerland']
    ]) {
        assert.deepEqual(
            parser.parseConferencePdfAuthors(`Speech Study\nAlice Brown, Bob White\n${inst}\n${loc}\n\nAbstract\nBody.`)?.authors,
            [
                { name: 'Alice Brown', affiliations: [inst] },
                { name: 'Bob White', affiliations: [inst] }
            ],
            `R10 #7 expected valid single-inst for ${inst} / ${loc}`
        );
    }
});

test('Wave 7 R11 回归：全量 O(n) ReDoS 消除、内联邮箱分栏/分号拆解、单作者续行/姓氏、括号与尖括号邮箱及 Republic of Korea', () => {
    // R11 #1: All JS ReDoS / O(n^2) payloads complete strictly linearly (<150ms each)
    const redosCases = [
        ['sanitize :', () => parser.sanitizeReaderAffiliationValue(':'.repeat(50000) + 'x')],
        ['personname *', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">${'*'.repeat(50000)}x</span></div></div></body></html>`))],
        ['personname ,@', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">x${','.repeat(50000)}@</span></div></div></body></html>`))],
        ['markedHtml *', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">${'*'.repeat(50000)}x<sup>1</sup></span><span class="ltx_role_affiliation"><sup>1</sup>MIT</span></div></div></body></html>`))],
        ['conf aff .', () => parser.parseConferencePdfAuthors(`Title\nAlice Brown1, Bob White2\n1 University ${'.'.repeat(50000)}x\nABSTRACT\nBody`)],
        ['markedHtml spaces 15k', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice${' '.repeat(15000)}Brown<sup>1</sup></span><span class="ltx_role_affiliation"><sup>1</sup>MIT</span></div></div></body></html>`))],
        ['conf tabs 15k', () => parser.parseConferencePdfAuthors(`Title\nAlice Brown${'\t'.repeat(15000)}Bob White\nMIT\nABSTRACT\nBody`)],
        ['inlineEmail loop 30k', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">${'a@b,'.repeat(30000)}</span></div></div></body></html>`))],
        ['thanks commas 600', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><h1 class="ltx_title_document">T<span class="ltx_note ltx_role_thanks">Alice Brown is with MIT, ${'Bob White, '.repeat(600)}Carol Davis is with CMU.</span></h1><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div></div></body></html>`))]
    ];
    for (const [label, fn] of redosCases) {
        const t0 = Date.now();
        fn();
        const dt = Date.now() - t0;
        assert.ok(dt < 250, `R11 #1 JS ReDoS (${label}) took ${dt}ms`);
    }

    // R11 #4: Inline email/URL + second org on same line (wide-space or semicolon) rejected
    for (const badConf of [
        'Speech Study\nAlice Brown, Bob White\nStanford University\nalice@stanford.edu   MIT\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nStanford University\nalice@stanford.edu; MIT\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nalice@stanford.edu   MIT\nStanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nStanford University\nhttps://example.com   MIT\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, `R11 #4 expected null: ${badConf}`);
    }

    // R11 #5: Single-author 2nd lines (McDonald, Honda, ALL-CAPS CAROL DAVIS, Mila Novak) preserved & never hijacked as aff
    for (const [label, txt, expectedNames, expectedAff] of [
        ['McDonald', 'Speech Study\nAlice Brown, Bob White\nJohn McDonald\nStanford University\n\nAbstract\nBody.', ['Alice Brown', 'Bob White', 'John McDonald'], ['Stanford University']],
        ['Honda', 'Speech Study\nAlice Brown, Bob White\nMasaaki Honda\nUniversity of Tokyo\n\nAbstract\nBody.', ['Alice Brown', 'Bob White', 'Masaaki Honda'], ['University of Tokyo']],
        ['ALL-CAPS', 'Speech Study\nALICE BROWN, BOB WHITE\nCAROL DAVIS\nStanford University\n\nAbstract\nBody.', ['ALICE BROWN', 'BOB WHITE', 'CAROL DAVIS'], ['Stanford University']],
        ['Mila+Toronto', 'Speech Study\nAlice Brown, Bob White\nMila Novak\nUniversity of Toronto\n\nAbstract\nBody.', ['Alice Brown', 'Bob White', 'Mila Novak'], ['University of Toronto']]
    ]) {
        const res = parser.parseConferencePdfAuthors(txt);
        assert.ok(res, `R11 #5 ${label} must parse`);
        assert.deepEqual(res.authors.map(a => a.name), expectedNames, label);
        assert.deepEqual(res.authors[0].affiliations, expectedAff, label);
    }
    assert.equal(
        parser.parseConferencePdfAuthors('Speech Study\nAlice Brown, Bob White\nMila Novak\n\nAbstract\nBody.'),
        null,
        'R11 #5 Mila Novak without org line must not be hijacked as affiliation'
    );

    // R11 #6: Parenthesized/angle-bracket emails & URLs leave zero dangling '(' / '<' / '<>'
    for (const affLine of [
        'Stanford University ({alice,bob}@stanford.edu)',
        'Stanford University (e-mail: alice@stanford.edu)',
        'Stanford University (https://stanford.edu)'
    ]) {
        assert.deepEqual(
            parser.parseConferencePdfAuthors(`Speech Study\nAlice Brown, Bob White\n${affLine}\n\nAbstract\nBody.`)?.authors[0].affiliations,
            ['Stanford University'],
            affLine
        );
    }
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University <alice@stanford.edu>'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University (https://stanford.edu)'), 'Stanford University');
    const htmlAngleEmail = `<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author">
      <span class="ltx_personname">Alice Brown &lt;alice@mit.edu&gt;</span>
      <span class="ltx_contact ltx_role_affiliation">MIT</span>
    </div></div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlAngleEmail)).authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] }
    ]);

    // R11 #7: Symbol-before-digit (*1), space-before-symbol (1 *), and lowercase 'of' locations (Republic of Korea / USA / DC)
    for (const txt of [
        'Speech Study\nAlice Brown*1, Bob White2\n1 MIT\n2 Stanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown 1 *, Bob White 2\n1 MIT\n2 Stanford University\n\nAbstract\nBody.'
    ]) {
        assert.deepEqual(parser.parseConferencePdfAuthors(txt)?.authors, [
            { name: 'Alice Brown', affiliations: ['MIT'] },
            { name: 'Bob White', affiliations: ['Stanford University'] }
        ], txt);
    }
    for (const [inst, loc] of [
        ['KAIST', 'Daejeon, Republic of Korea'],
        ['MIT', 'Cambridge, United States of America'],
        ['Georgetown University', 'Washington, District of Columbia']
    ]) {
        assert.deepEqual(
            parser.parseConferencePdfAuthors(`Speech Study\nAlice Brown, Bob White\n${inst}\n${loc}\n\nAbstract\nBody.`)?.authors,
            [
                { name: 'Alice Brown', affiliations: [inst] },
                { name: 'Bob White', affiliations: [inst] }
            ],
            `R11 #7 expected valid single-inst for ${inst} / ${loc}`
        );
    }
});

test('Wave 7 R12 回归：剩余 ReDoS/O(n²) 全清、3-space/tab/URL/括号逗号多机构与城市大学护栏、2nd-line 伪作者阻断、括号邮箱与 thanks 多作者、*, 1 标记', () => {
    // R12 #1: Linear-time O(n) guards on <html >, exotic whitespace (\u00a0/\r), and thanks non-comma "and" runs
    for (const [label, fn] of [
        ['html_open_repeat', () => parser.canRetainAuthorSourceHtml('<html >'.repeat(15000))],
        ['nbsp_marked', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice${'\u00a0'.repeat(15000)}Brown<sup>1</sup></span></div></div><p><sup>1</sup>MIT</p></body></html>`))],
        ['cr_conf_pdf', () => parser.parseConferencePdfAuthors(`Title\nAlice Brown${'\r'.repeat(15000)}Bob White\nMIT\n\nAbstract\nBody.`)],
        ['thanks_and_run', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><h1 class="ltx_title_document">T<span class="ltx_note ltx_role_thanks">Alice Brown is with MIT ${'and Bob White '.repeat(4000)}is with CMU.</span></h1></body></html>`))]
    ]) {
        const t0 = performance.now();
        fn();
        const dt = performance.now() - t0;
        assert.ok(dt < 250, `R12 #1 JS ReDoS (${label}) took ${dt.toFixed(1)}ms`);
    }

    // R12 #3: 3+ spaces / tab / URL-hostname / mid-line parenthesized email multi-institution rejected; valid city-university accepted
    for (const badConf of [
        'Speech Paper\nAlice Brown, Bob White\nStanford University     Sesame, CA\n\nAbstract\nBody.',
        'Speech Paper\nAlice Brown, Bob White\nStanford University\tSesame, CA\n\nAbstract\nBody.',
        'Speech Paper\nAlice Brown, Bob White\nStanford University\nSesame, CA   https://sesame.ai\n\nAbstract\nBody.',
        'Speech Paper\nAlice Brown, Bob White\nMIT (alice@mit.edu), Stanford University (bob@stanford.edu)\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(badConf), null, `R12 #3 expected null: ${badConf}`);
    }
    for (const [inst, locLine] of [
        ['Stanford University', 'Stanford, CA, alice@stanford.edu'],
        ['University of Tokyo', 'Tokyo, Japan, alice@u-tokyo.ac.jp'],
        ['University of Sydney', 'Sydney, Australia, alice@sydney.edu.au'],
        ['UC Berkeley', 'Berkeley, CA, alice@berkeley.edu']
    ]) {
        const res = parser.parseConferencePdfAuthors(`Speech Paper\nAlice Brown, Bob White\n${inst}\n${locLine}\n\nAbstract\nBody.`);
        assert.deepEqual(res?.authors, [
            { name: 'Alice Brown', affiliations: [inst] },
            { name: 'Bob White', affiliations: [inst] }
        ], `R12 #3 city-university must stay accepted: ${inst} / ${locLine}`);
    }

    // R12 #5: Lowercase prose, unanchored role sentences, and U.S.A. rejected as phantom 2nd-line authors
    for (const badLine2 of [
        'submitted to Interspeech',
        'for peer review',
        'an empirical study',
        'Alice Brown is the corresponding author',
        'Cambridge U.S.A.'
    ]) {
        const res = parser.parseConferencePdfAuthors(`Speech Synthesis\nAlice Brown, Bob White\n${badLine2}\nStanford University\n\nAbstract\nBody.`);
        if (res) {
            assert.deepEqual(res.authors.map(a => a.name), ['Alice Brown', 'Bob White'], `R12 #5 phantom author leaked: ${badLine2}`);
        }
    }

    // R12 #6: Sanitizer brackets/bare URLs/space-padded email wrappers, thanks multi-author with e-mail:, and personname email cleanup
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University <e-mail: alice@stanford.edu>'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University [email: alice@stanford.edu]'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University <{alice,bob}@stanford.edu>'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University ({alice, bob,'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University, https://stanford.edu'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University <https://stanford.edu>'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University, www.stanford.edu'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University ( alice@stanford.edu )'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University < alice@stanford.edu >'), 'Stanford University');

    for (const note of [
        'Alice Brown is with MIT, e-mail: alice@mit.edu; Bob White is with Stanford University, e-mail: bob@stanford.edu.',
        'Alice Brown is with MIT, email: a@mit.edu, and Bob White is with Stanford University.'
    ]) {
        const html = `<html><body><h1 class="ltx_title_document">T<span class="ltx_note ltx_role_thanks">${note}</span></h1></body></html>`;
        assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html)).authors, [
            { name: 'Alice Brown', affiliations: ['MIT'] },
            { name: 'Bob White', affiliations: ['Stanford University'] }
        ], `R12 #6 thanks must bind both authors: ${note}`);
    }
    for (const rawPerson of [
        'Alice Brown (e-mail: alice@mit.edu)',
        'Alice Brown &lt;a@mit.edu,b@mit.edu&gt;',
        'Alice Brown &lt; alice@mit.edu &gt;'
    ]) {
        const html = `<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">${rawPerson}</span><span class="ltx_contact ltx_role_affiliation">MIT</span></div></div></body></html>`;
        assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html)).authors, [
            { name: 'Alice Brown', affiliations: ['MIT'] }
        ], `R12 #6 personname email cleanup: ${rawPerson}`);
    }

    // R12 #7: Symbol-comma-digit ("Alice Brown*, 1") parsed cleanly in single-line & multi-line numeric headers
    for (const txt of [
        'Speech Study\nAlice Brown*, 1, Bob White 2\n1 MIT\n2 Stanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown*, 1 and Bob White 2\n1 MIT\n2 Stanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown*, 1\nBob White 2\n1 MIT\n2 Stanford University\n\nAbstract\nBody.'
    ]) {
        assert.deepEqual(parser.parseConferencePdfAuthors(txt)?.authors, [
            { name: 'Alice Brown', affiliations: ['MIT'] },
            { name: 'Bob White', affiliations: ['Stanford University'] }
        ], `R12 #7 symbol-comma-digit: ${txt}`);
    }
});

test('Wave 7 R13 回归：5 项 JS O(n²) ReDoS 归零、裸/方括号邮箱多机构 fail-closed、3端姓名校验与 H.-P. Du、Correspondence/thanks/Clinic/UC Berkeley、带空格括号清洗与 brace/and 邮箱', () => {
    // R13 #1, #2, #3, #4, #5: Strictly O(n) runtime on adversarial inputs
    for (const [label, fn] of [
        ['unclosed_html', () => parser.canRetainAuthorSourceHtml('<html '.repeat(20000))],
        ['unclosed_paren_at', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">)(${'@'.repeat(20000)}</span></div></div></body></html>`))],
        ['unclosed_angle_at', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">&gt;&lt;${'@'.repeat(20000)}</span></div></div></body></html>`))],
        ['unclosed_sq_at', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">][${'@'.repeat(20000)}</span></div></div></body></html>`))],
        ['nl_abstract_v1', () => parser.parseConferencePdfAuthors('\n'.repeat(50000) + 'x')],
        ['nl_abstract_v2', () => parser.parseConferencePdfAuthorsV2('\n'.repeat(50000) + 'x')],
        ['br_repeat', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice ${'<br> '.repeat(20000)}Brown<sup>1</sup></span></div></div><p><sup>1</sup>MIT</p></body></html>`))],
        ['mixed_wide_space', () => parser.parseConferencePdfAuthors(`Title\nAlice Brown, Bob White\na${' \u2002'.repeat(20000)}b\nABSTRACT\nBody`)]
    ]) {
        const t0 = performance.now();
        fn();
        const dt = performance.now() - t0;
        assert.ok(dt < 250, `R13 ReDoS (${label}) took ${dt.toFixed(1)}ms`);
    }

    // R13 #7: Bare / [...] inline email & URL followed by comma + 2nd institution fail closed
    for (const multiLine of [
        'MIT, alice@mit.edu, Stanford University, bob@stanford.edu',
        'MIT [alice@mit.edu], Stanford University [bob@stanford.edu]',
        'MIT, https://mit.edu, Stanford University, https://stanford.edu',
        'MIT, e-mail: alice@mit.edu, Stanford University, e-mail: bob@stanford.edu',
        'Stanford University, alice@stanford.edu, MIT'
    ]) {
        assert.equal(
            parser.parseConferencePdfAuthors(`Title\nAlice Brown, Bob White\n${multiLine}\n\nAbstract\nBody.`),
            null,
            `R13 #7 expected null: ${multiLine}`
        );
    }
    // Single institution with multiple comma-separated emails stays accepted
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Title\nAlice Brown, Bob White\nMIT, alice@mit.edu, bob@mit.edu\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Alice Brown', affiliations: ['MIT'] },
            { name: 'Bob White', affiliations: ['MIT'] }
        ]
    );

    // R13 #12: Hyphenated initials accepted & CRediT phrases rejected in HTML thanks
    const hpHtml = cheerio.load('<html><body><h1 class="ltx_title_document">T<span class="ltx_note ltx_role_thanks">H.-P. Du and J.-C. Lin are with University of Science and Technology of China.</span></h1></body></html>');
    assert.deepEqual(parser.parseArxivReaderAuthors(hpHtml).authors, [
        { name: 'H.-P. Du', affiliations: ['University of Science and Technology of China'] },
        { name: 'J.-C. Lin', affiliations: ['University of Science and Technology of China'] }
    ]);
    const creditHtml = cheerio.load('<html><body><h1 class="ltx_title_document">T<span class="ltx_note ltx_role_thanks">Formal Analysis is from MIT. Alice Brown is with Stanford University.</span></h1></body></html>');
    assert.deepEqual(parser.parseArxivReaderAuthors(creditHtml).authors, [
        { name: 'Alice Brown', affiliations: ['Stanford University'] }
    ]);

    // R13 #13: Correspondence: / thanks: rejected & Mayo Clinic / UC Berkeley recognized
    const corrRes = parser.parseConferencePdfAuthors('Speech Study\nAlice Brown†, Bob White‡\n† Correspondence: ‡ MIT\n\nAbstract\nBody.');
    assert.deepEqual(corrRes?.authors, [
        { name: 'Alice Brown', affiliations: [] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ]);
    const clinicRes = parser.parseConferencePdfAuthors('Title\nAlice Brown 1, Bob White 2\n1 Mayo Clinic\n2 UC Berkeley\n\nAbstract\nBody.');
    assert.deepEqual(clinicRes?.authors, [
        { name: 'Alice Brown', affiliations: ['Mayo Clinic'] },
        { name: 'Bob White', affiliations: ['UC Berkeley'] }
    ]);

    // R13 #15 & #16: Space-padded email/URL/brace wrappers leave zero dangling brackets, brace/and personname emails clean, Institution of ... preserved
    for (const rawAff of [
        'Stanford University ( e-mail: alice@stanford.edu )',
        'Stanford University < e-mail: alice@stanford.edu >',
        'Stanford University [ e-mail: alice@stanford.edu ]',
        'Stanford University ( https://stanford.edu )',
        'Stanford University < https://stanford.edu >',
        'Stanford University ( {alice,bob}@stanford.edu )',
        'Stanford University ( {alice, bob,'
    ]) {
        assert.equal(parser.sanitizeReaderAffiliationValue(rawAff), 'Stanford University', `R13 #15: ${rawAff}`);
    }
    assert.equal(
        parser.sanitizeReaderAffiliationValue('Institution of Engineering and Technology'),
        'Institution of Engineering and Technology'
    );
    for (const personRaw of [
        'Alice Brown ({alice,bob}@mit.edu)',
        'Alice Brown (alice@mit.edu and bob@mit.edu)'
    ]) {
        const html = `<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">${personRaw}</span><span class="ltx_contact ltx_role_affiliation">MIT</span></div></div></body></html>`;
        assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html)).authors, [
            { name: 'Alice Brown', affiliations: ['MIT'] }
        ], `R13 #16 personname: ${personRaw}`);
    }
});

test('Wave 7 R14 回归：3 项 ReDoS/O(n²) 全清、企业后缀/Team/地名组合防穿透、ltx_note/mailto/5+上标、Xian/France 保留、清洗对齐、昵称与双字中文名', () => {
    // R14 #1-#3: Linear-time O(n) guards
    for (const [label, fn] of [
        ['stripInlineAtEmailsLinear', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">@(${'\\inst '.repeat(15000)})</span></div></div></body></html>`))],
        ['conf_ws_norm', () => parser.parseConferencePdfAuthors('Title\nAlice Brown, Bob White\n' + ' '.repeat(40000) + 'x\n\nAbstract\nBody.')],
        ['conf_email_split', () => parser.parseConferencePdfAuthors('Title\nAlice Brown, Bob White\n' + 'a'.repeat(40000) + ' x@y.com\n\nAbstract\nBody.')],
        ['marked_ws_nl', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">A${' '.repeat(40000)}B<br>C<sup>1</sup></span><span class="ltx_contact ltx_role_affiliation"><sup>1</sup>MIT</span></div></div></body></html>`))],
        ['marked_ieee_nl', () => parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">A${' Member, IEEE'.repeat(20000)}B<br>C<sup>1</sup></span><span class="ltx_contact ltx_role_affiliation"><sup>1</sup>MIT</span></div></div></body></html>`))]
    ]) {
        const t0 = performance.now();
        fn();
        const dt = performance.now() - t0;
        assert.ok(dt < 250, `R14 ReDoS (${label}) took ${dt.toFixed(1)}ms`);
    }

    // R14 #4 & #5: Corporate suffixes, Team, and <SurnameCollidingOrgHead> <Location> rejected; real persons preserved
    for (const doc of [
        'Speech Study\nAlice Brown, Bob White\nStanford University\nNokia Oy, Finland\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nStanford University\nPhilips B.V., Netherlands\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nStanford University\nSociete S.A., France\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nStanford University\nInfineon AG, Germany\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nKimi Team\nStanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nBosch Germany\nStanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nSony Japan\nStanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nApple USA\nStanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nHonda Japan\nStanford University\n\nAbstract\nBody.',
        'Speech Study\nAlice Brown, Bob White\nAthena France\nStanford University\n\nAbstract\nBody.'
    ]) {
        assert.equal(parser.parseConferencePdfAuthors(doc), null, `R14 #4/#5 expected null: ${doc}`);
    }
    for (const okName of ['Louis ten Bosch', 'Athena Dai', 'Masaaki Honda', 'John Apple', 'Mila Novak']) {
        const res = parser.parseConferencePdfAuthors(`Speech Study\n${okName}, Bob White\nStanford University\n\nAbstract\nBody.`);
        assert.deepEqual(res?.authors, [
            { name: okName, affiliations: ['Stanford University'] },
            { name: 'Bob White', affiliations: ['Stanford University'] }
        ], `R14 #5 real person preserved: ${okName}`);
    }

    // R14 #9: .ltx_note/.ltx_tag skipped cleanly, mailto: skipped in aff, 5+ markers merged
    const htmlNoteTag = '<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<span class="ltx_note ltx_role_thanks"><span class="ltx_note_mark">†</span>Equal contribution.</span><sup>1</sup></span><span class="ltx_note ltx_role_affiliation"><span class="ltx_tag ltx_tag_note">1</span><sup>1</sup>MIT</span></div></div></body></html>';
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlNoteTag)).authors, [{ name: 'Alice Brown', affiliations: ['MIT'] }]);
    const htmlMailto = '<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span><span class="ltx_contact ltx_role_affiliation"><a href="mailto:alice@mit.edu">alice@mit.edu</a>, Stanford University</span></div></div></body></html>';
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlMailto)).authors, [{ name: 'Alice Brown', affiliations: ['Stanford University'] }]);
    const html5Sup = '<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<sup>1</sup>,<sup>2</sup>,<sup>3</sup>,<sup>4</sup>,<sup>5</sup></span><span class="ltx_contact ltx_role_affiliation"><sup>1</sup>MIT<br><sup>2</sup>CMU<br><sup>3</sup>EPFL<br><sup>4</sup>ETH<br><sup>5</sup>NUS</span></div></div></body></html>';
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html5Sup)).authors[0].affiliations, ['MIT', 'CMU', 'EPFL', 'ETH', 'NUS']);

    // R14 #10: Marked conference authors named Xian / France preserved
    for (const nm of ['Xian Shi', 'France Legare']) {
        const res = parser.parseConferencePdfAuthors(`Speech Study\n${nm} 1, Bob White 2\n1 Stanford University\n2 MIT\n\nAbstract\nBody.`);
        assert.deepEqual(res?.authors, [
            { name: nm, affiliations: ['Stanford University'] },
            { name: 'Bob White', affiliations: ['MIT'] }
        ], `R14 #10: ${nm}`);
    }

    // R14 #11: Sanitizer parity & marked conference aff stores sanitized value
    assert.equal(parser.sanitizeReaderAffiliationValue('Auditory Lab, SJTU ({lichenda1996, herobrine}sjtu.edu.cn)'), 'Auditory Lab, SJTU');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT ({alice+1, bob'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('Contactless Sensing Laboratory'), 'Contactless Sensing Laboratory');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University (work was done while at Meta)'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University (equal contribution)'), 'Stanford University');
    for (const bad of ['November 20, 2026', 'ICASSP 2026', 'Proceedings of Interspeech 2026', 'arXiv:2611.12345', 'GitHub', 'HuggingFace', 'Keywords: ASR, TTS']) {
        assert.equal(parser.sanitizeReaderAffiliationValue(bad), '', `R14 #11 reject: ${bad}`);
    }
    assert.equal(
        parser.parseConferencePdfAuthors('Speech Study\nAlice Brown 1, Bob White 2\n1 Stanford University; Equal contribution\n2 MIT\n\nAbstract\nBody.')?.authors[0].affiliations[0],
        'Stanford University'
    );

    // R14 #12: Mid-name parenthesized nickname & 2-char CJK author names in thanks
    assert.deepEqual(
        parser.parseArxivReaderAuthors(cheerio.load('<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">John (Toby) Van Der Berg</span><span class="ltx_note ltx_role_thanks">John (Toby) Van Der Berg is with MIT.</span></div></div></body></html>')).authors,
        [{ name: 'John (Toby) Van Der Berg', affiliations: ['MIT'] }]
    );
    assert.deepEqual(
        parser.parseArxivReaderAuthors(cheerio.load('<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">张三</span><span class="ltx_note ltx_role_thanks">张三 is with Tsinghua University.</span></div></div></body></html>')).authors,
        [{ name: '张三', affiliations: ['Tsinghua University'] }]
    );
});

test('Wave 7 R15 回归：Sanitizer ReDoS归零、HTML标记多机构优选与嵌套ltx_note_mark、企业句点、多词地名与亚裔姓氏、K.K.首字母、符号ID与引号昵称', () => {
    // R15 #1: O(n) ReDoS guards after macro/parenthetical replacements
    for (const [label, fn] of [
        ['email-www', () => parser.sanitizeReaderAffiliationValue('MIT' + '(email)'.repeat(30000) + ' www.')],
        ['inst-www', () => parser.sanitizeReaderAffiliationValue('MIT' + '\\inst '.repeat(30000) + ' www.')],
        ['email-colon', () => parser.sanitizeReaderAffiliationValue('MIT' + '(email)'.repeat(30000) + ' :')],
        ['conf-pdf', () => parser.parseConferencePdfAuthors('Title\nAlice Brown, Bob White\nMIT' + '(email)'.repeat(30000) + ' www.\n\nAbstract\nBody.')]
    ]) {
        const t0 = Date.now();
        fn();
        assert.ok(Date.now() - t0 < 200, `R15 #1 ReDoS ${label}`);
    }

    // R15 #2: Prefer markedHtml over concatenated single-string plain binding
    const htmlConcat = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<sup>1</sup></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White<sup>2</sup></span></span>
      <span class="ltx_role_affiliation"><sup>1</sup>MIT<br><sup>2</sup>Stanford University</span>
    </div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlConcat)).authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    // R15 #3: Preserve corporate dots (B.V., S.r.l., K.K.) & fail-closed on two-space multi-inst
    assert.equal(parser.parseConferencePdfAuthors('Speech Study\nAlice Brown, Bob White\nPhilips B.V.  Azienda S.r.l.\n\nAbstract\nBody.'), null);
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Study\nAlice Brown1, Bob White2\n1 Philips B.V.\n2 Sony K.K.\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Alice Brown', affiliations: ['Philips B.V.'] },
            { name: 'Bob White', affiliations: ['Sony K.K.'] }
        ]
    );

    // R15 #4 & #5 & #13e: Multi-word location rejected; Athena Ma, Mila Oh, K.K. Paliwal, John Oppo preserved
    assert.equal(parser.parseConferencePdfAuthors('Speech Study\nAlice Brown, Bob White\nBosch United Kingdom\nStanford University\n\nAbstract\nBody.'), null);
    assert.equal(parser.parseConferencePdfAuthors('Speech Study\nAlice Brown, Bob White\nApple United States\nStanford University\n\nAbstract\nBody.'), null);
    for (const pair of ['Athena Ma, Mila Oh', 'K.K. Paliwal, Bob White', 'John Oppo, Bob White']) {
        const res = parser.parseConferencePdfAuthors(`Speech Study\n${pair}\nStanford University\n\nAbstract\nBody.`);
        assert.equal(res?.authors?.length, 2, `R15 #4/#5/#13e preserve ${pair}`);
    }

    // R15 #6: Preserve .ltx_note_mark inside nested .ltx_note.ltx_role_affiliation
    const htmlNestedNote = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<span class="ltx_note ltx_role_affiliation"><span class="ltx_note_mark">1</span><span class="ltx_note_outer"><span class="ltx_note_content"><span class="ltx_tag ltx_tag_note">1</span>MIT</span></span></span></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White<span class="ltx_note ltx_role_affiliation"><span class="ltx_note_mark">2</span><span class="ltx_note_outer"><span class="ltx_note_content"><span class="ltx_tag ltx_tag_note">2</span>Stanford University</span></span></span></span></span>
    </div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlNestedNote)).authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['Stanford University'] }
    ]);

    // R15 #7c, #8, #9, #10, #11, #13b
    assert.equal(parser.parseConferencePdfAuthors('Speech Study\nAlice Brown, Bob White and\nCarol Davis\nStanford University\n\nAbstract\nBody.')?.authors?.length, 3);
    assert.equal(parser.sanitizeReaderAffiliationValue('Work carried out while at MIT'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford University (work carried out while at Meta)'), 'Stanford University');
    assert.equal(parser.sanitizeReaderAffiliationValue('Index Terms: ASR, TTS'), '');
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Study\nGeorgios Syllas ID 1, Efthymios Georgiou* ID 2\n1 MIT\n2 Stanford University\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Georgios Syllas', affiliations: ['MIT'] },
            { name: 'Efthymios Georgiou', affiliations: ['Stanford University'] }
        ]
    );
    const htmlNickDot = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Jan "Honza" Silovsky</span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Carol Davis</span></span>
      <span class="ltx_note ltx_role_thanks"><span class="ltx_note_content">Jan "Honza" Silovsky is with Apple. Alice Brown is with Huawei Technologies Co., Ltd. Bob White is with Imperial College London, U.K. Carol Davis is with Azienda S.r.l.</span></span>
    </div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlNickDot)).authors, [
        { name: 'Jan "Honza" Silovsky', affiliations: ['Apple'] },
        { name: 'Alice Brown', affiliations: ['Huawei Technologies Co., Ltd.'] },
        { name: 'Bob White', affiliations: ['Imperial College London, U.K.'] },
        { name: 'Carol Davis', affiliations: ['Azienda S.r.l.'] }
    ]);
});

test('Wave 7 R16 回归：ltx_note_mark 仅限机构注、URL/thanks 双重 O(n) ReDoS、B.V./A.G./S.A. 首字母作者、US/U.S. 地名与角色注、牛津逗号换行、thanks while 与 C0/C1/Index Terms— 对齐', () => {
    // R16 #1: Do NOT leak .ltx_note_mark from .ltx_note.ltx_role_thanks into affiliation markers
    const htmlThanksMark = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<span class="ltx_note ltx_role_thanks"><span class="ltx_note_mark">1</span><span class="ltx_note_outer"><span class="ltx_note_content"><span class="ltx_tag">1</span>Equal contribution.</span></span></span><sup>2</sup></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White<sup>1</sup></span></span>
      <span class="ltx_role_affiliation"><sup>1</sup>MIT<br><sup>2</sup>Stanford University</span>
    </div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlThanksMark)).authors, [
        { name: 'Alice Brown', affiliations: ['Stanford University'] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ]);

    // R16 #2 & #3: Strictly O(n) ReDoS guards on bare URL comma splitter & thanks sentence merger
    for (const [label, fn] of [
        ['bare-http-16k', () => parser.parseConferencePdfAuthors('Title\nAlice Brown, Bob White\n' + 'http://'.repeat(16000) + '\n\nAbstract\nBody.')],
        ['bare-www-16k', () => parser.parseConferencePdfAuthors('Title\nAlice Brown, Bob White\n' + 'www.'.repeat(16000) + '\n\nAbstract\nBody.')],
        ['thanks-inc-32k', () => parser.parseArxivReaderAuthors(cheerio.load('<html><body><div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></span><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></span><div class="ltx_note ltx_role_thanks">Alice Brown is with ' + 'Inc. '.repeat(32000) + 'Bob White is with MIT.</div></div></body></html>'))]
    ]) {
        const t0 = Date.now();
        fn();
        assert.ok(Date.now() - t0 < 200, `R16 #2/#3 ReDoS ${label}`);
    }

    // R16 #4: Initialed authors B.V. Kumar / A.G. Howard / S.A. King accepted while Philips B.V. rejected as author
    for (const nm of ['B.V. Kumar', 'A.G. Howard', 'S.A. King']) {
        const conf = parser.parseConferencePdfAuthors(`Speech Study\n${nm}, Bob White\nStanford University\n\nAbstract\nBody.`);
        assert.deepEqual(conf?.authors.map(a => a.name), [nm, 'Bob White'], `R16 #4 conf ${nm}`);
        const thanks = parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">${nm}</span></span><span class="ltx_note ltx_role_thanks">${nm} is with MIT.</span></div></body></html>`));
        assert.deepEqual(thanks.authors, [{ name: nm, affiliations: ['MIT'] }], `R16 #4 thanks ${nm}`);
    }
    assert.equal(parser.parseConferencePdfAuthors('Speech Study\nPhilips B.V., Bob White\nStanford University\n\nAbstract\nBody.'), null);

    // R16 #5: US / U.S. location code rejects Apple US / Bosch US phantom authors and accepts Cambridge, U.S. / US
    for (const badOrg of ['Apple US', 'Bosch US']) {
        assert.equal(
            parser.parseConferencePdfAuthors(`Speech Study\nAlice Brown, Bob White\n${badOrg}\nStanford University\n\nAbstract\nBody.`),
            null,
            `R16 #5 reject ${badOrg}`
        );
    }
    for (const loc of ['Cambridge, U.S.', 'Cambridge, US']) {
        assert.deepEqual(
            parser.parseConferencePdfAuthors(`Speech Study\nAlice Brown, Bob White\nMIT\n${loc}\n\nAbstract\nBody.`)?.authors,
            [
                { name: 'Alice Brown', affiliations: ['MIT'] },
                { name: 'Bob White', affiliations: ['MIT'] }
            ],
            `R16 #5 accept ${loc}`
        );
    }

    // R16 #6: Role footnote with optional "the" (e.g. "represents the corresponding author")
    assert.equal(parser.sanitizeReaderAffiliationValue('represents the corresponding author. This work was supported by NSFC.'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT, * represents the corresponding author.'), 'MIT');

    // R16 #8c: Oxford-comma trailing "and" wrap & whitespace before "and"
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Study\nAlice Brown, Bob White, and\nCarol Davis\nStanford University\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Alice Brown', affiliations: ['Stanford University'] },
            { name: 'Bob White', affiliations: ['Stanford University'] },
            { name: 'Carol Davis', affiliations: ['Stanford University'] }
        ]
    );

    // R16 #11: Thanks "<Abbr>. while <Author2> is with ...", Philips B.V. glued sentence, case-insensitive preserved dot
    for (const [sent, expected] of [
        [
            'Alice Brown is with Huawei Technologies Co., Ltd. while Bob White is with MIT.',
            [{ name: 'Alice Brown', affiliations: ['Huawei Technologies Co., Ltd.'] }, { name: 'Bob White', affiliations: ['MIT'] }]
        ],
        [
            'Alice Brown is with Philips B.V. while Bob White is with MIT.',
            [{ name: 'Alice Brown', affiliations: ['Philips B.V.'] }, { name: 'Bob White', affiliations: ['MIT'] }]
        ]
    ]) {
        const html = `<html><body><div class="ltx_authors">
          <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></span>
          <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></span>
          <span class="ltx_note ltx_role_thanks">${sent}</span>
        </div></body></html>`;
        assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html)).authors, expected);
    }
    assert.equal(parser.sanitizeReaderAffiliationValue('Philips B.V. This work was supported by NSF.'), 'Philips B.V.');
    assert.equal(parser.sanitizeReaderAffiliationValue('Azienda s.r.l.'), 'Azienda s.r.l.');
    assert.equal(parser.sanitizeReaderAffiliationValue('Tencent Co., LTD.'), 'Tencent Co., LTD.');

    // R16 #12: Index Terms— em-dash, U+2225 ∥ symbol, C0/C1 control char parity
    assert.equal(parser.sanitizeReaderAffiliationValue('Index Terms—ASR, TTS'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('\x9b University Libraries, Carnegie Mellon University'), 'University Libraries, Carnegie Mellon University');
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Study\nJohanna Wilroth∗∥, Martin Enqvist∗\n∗ Linköping University\n∥ Eriksholm Research Centre\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Johanna Wilroth', affiliations: ['Linköping University', 'Eriksholm Research Centre'] },
            { name: 'Martin Enqvist', affiliations: ['Linköping University'] }
        ]
    );
});

test('Wave 7 R17 回归：2nd-line K.K. 作者续行、thanks note_mark 不绕过未绑定拦截、HTML/清理器 ∥ 与 the 角色注、Corp/S.r.l/LTD thanks、O(K) thanks、Van hamme 粒子姓', () => {
    // R17 #4: 2nd-line author continuation uses READER_AUTHOR_UPPERCASE_CORP_SUFFIX_RE (never misbinds John K.K. Paliwal as affiliation)
    assert.equal(
        parser.parseConferencePdfAuthors('Speech Study\nAlice Brown, Bob White\nJohn K.K. Paliwal\n\nAbstract\nBody.'),
        null
    );
    assert.deepEqual(
        parser.parseConferencePdfAuthors('Speech Study\nAlice Brown, Bob White\nJohn K.K. Paliwal, Carol Davis\nStanford University\n\nAbstract\nBody.')?.authors,
        [
            { name: 'Alice Brown', affiliations: ['Stanford University'] },
            { name: 'Bob White', affiliations: ['Stanford University'] },
            { name: 'John K.K. Paliwal', affiliations: ['Stanford University'] },
            { name: 'Carol Davis', affiliations: ['Stanford University'] }
        ]
    );

    // R17 #5a: .ltx_role_thanks .ltx_note_mark must NOT bypass rejectUnboundTrailingAffiliationGroup
    const htmlThanksMarkTrailing = `<html><body><div class="ltx_authors">
      <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<span class="ltx_note ltx_role_thanks"><span class="ltx_note_mark">*</span>Equal contribution.</span></span></div>
      <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span><span class="ltx_contact ltx_role_affiliation">Affiliation: Stanford University   MIT</span></div>
    </div></body></html>`;
    const parsedTrailing = parser.parseArxivReaderAuthors(cheerio.load(htmlThanksMarkTrailing));
    assert.equal(parsedTrailing.authors.length, 2);
    assert.match(parsedTrailing.authors[1].affiliations[0], /^机构信息未/);

    // R17 #5b: U+2225 ∥ supported across HTML markers, MathML (\parallel / \|), raw name trimming, and trailing role sanitizer
    const htmlParallel = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Johanna Wilroth<sup>∗,∥</sup></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Martin Enqvist<math><annotation encoding="application/x-tex">\\ast</annotation></math></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Carol Davis<math><annotation encoding="application/x-tex">\\parallel</annotation></math></span></span>
      <span class="ltx_role_affiliation"><sup>∗</sup>Linköping University<br><sup>∥</sup>Eriksholm Research Centre</span>
    </div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(htmlParallel)).authors, [
        { name: 'Johanna Wilroth', affiliations: ['Linköping University', 'Eriksholm Research Centre'] },
        { name: 'Martin Enqvist', affiliations: ['Linköping University'] },
        { name: 'Carol Davis', affiliations: ['Eriksholm Research Centre'] }
    ]);
    assert.equal(
        parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Johanna Wilroth∗∥</span><span class="ltx_contact ltx_role_affiliation">MIT</span></span></div></body></html>`)).authors[0].name,
        'Johanna Wilroth'
    );
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT, ∥ represents the corresponding author.'), 'MIT');
    // R17 #5c: independent (?:the\s+)? in READER_TRAILING_ROLE_CLAUSE_RE
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT, * the corresponding author.'), 'MIT');

    // R17 #6a: abbrRe supports Corp., S.r.l., uppercase LTD. before `while`
    for (const [sent, aff0] of [
        ['Alice Brown is with Sony Corp. while Bob White is with MIT.', 'Sony Corp.'],
        ['Alice Brown is with Azienda S.r.l. while Bob White is with MIT.', 'Azienda S.r.l.'],
        ['Alice Brown is with Tencent Co., LTD. while Bob White is with MIT.', 'Tencent Co., LTD.']
    ]) {
        const html = `<html><body><div class="ltx_authors">
          <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></span>
          <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></span>
          <span class="ltx_note ltx_role_thanks">${sent}</span>
        </div></body></html>`;
        assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html)).authors, [
            { name: 'Alice Brown', affiliations: [aff0] },
            { name: 'Bob White', affiliations: ['MIT'] }
        ], `R17 #6a ${aff0}`);
    }

    // R17 #6b: O(K) thanks sanitization scaling (K=800 distinct authors completes well under 200ms)
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const makeAlphaTag = idx => {
        const a = letters[Math.floor(idx / 676) % 26];
        const b = letters[Math.floor(idx / 26) % 26];
        const c = letters[idx % 26];
        return `A${a}${b}${c}`;
    };
    const bigClauses = [];
    const bigCreators = [];
    for (let k = 0; k < 800; k++) {
        const nm = `${makeAlphaTag(k)} Smith${makeAlphaTag(k)}`;
        bigCreators.push(`<span class="ltx_creator ltx_role_author"><span class="ltx_personname">${nm}</span></span>`);
        bigClauses.push(`${nm} is with Institute ${makeAlphaTag(k)}.`);
    }
    const bigThanksHtml = `<html><body><div class="ltx_authors">${bigCreators.join('')}<span class="ltx_note ltx_role_thanks">${bigClauses.join(' ')}</span></div></body></html>`;
    const bigDoc = cheerio.load(bigThanksHtml);
    const t0 = Date.now();
    const bigRes = parser.parseArxivReaderAuthors(bigDoc);
    const dt = Date.now() - t0;
    assert.equal(bigRes.authors.length, 800);
    assert.ok(dt < 300, `R17 #6b O(K) thanks K=800 took ${dt}ms`);

    // R17 #9: Capitalized-particle lowercase surname (Hugo Van hamme, Luc Van gool)
    for (const nm of ['Hugo Van hamme', 'Luc Van gool']) {
        const conf = parser.parseConferencePdfAuthors(`Speech Study\n${nm}, Bob White\nKU Leuven, Department of Electrical Engineering\n\nAbstract\nBody.`);
        assert.deepEqual(conf?.authors.map(a => a.name), [nm, 'Bob White'], `R17 #9 conf ${nm}`);
        const thanks = parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">${nm}</span></span><span class="ltx_note ltx_role_thanks">${nm} is with KU Leuven.</span></div></body></html>`));
        assert.deepEqual(thanks.authors, [{ name: nm, affiliations: ['KU Leuven'] }], `R17 #9 thanks ${nm}`);
    }
});

test('Wave 7 R18 回归：Lab/Labs/Tech/Inst/St thanks与粘连句、全局标记fail-closed与∥/‖归一化、hasMarkers过滤、O(K)线性扩展、+清理器、Unicode多字母首字母与Van de守卫', () => {
    // R18 #1: Lab./Labs./Tech./Inst./St. thanks sentence splitting + glued funding sentences
    for (const [sent, aff0] of [
        ['Alice Brown is with Bell Labs. Bob White is with Stanford University.', 'Bell Labs.'],
        ['Alice Brown is with MIT AI Lab. Bob White is with Stanford University.', 'MIT AI Lab.'],
        ['Alice Brown is with Georgia Tech. Bob White is with Stanford University.', 'Georgia Tech.'],
        ['Alice Brown is with Fraunhofer Inst. Bob White is with Stanford University.', 'Fraunhofer Inst.'],
        ['Alice Brown is with MIT, 10 Main St. Bob White is with Stanford University.', 'MIT, 10 Main St.'],
        ['Alice Brown is with Sun. Bob White is with Stanford University.', 'Sun']
    ]) {
        const html = `<html><body><div class="ltx_authors">
          <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></span>
          <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></span>
          <span class="ltx_note ltx_role_thanks">${sent}</span>
        </div></body></html>`;
        assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html)).authors, [
            { name: 'Alice Brown', affiliations: [aff0] },
            { name: 'Bob White', affiliations: ['Stanford University'] }
        ], `R18 #1 thanks ${aff0}`);
    }
    for (const [raw, expected] of [
        ['MIT AI Lab. This work was supported by NSF.', 'MIT AI Lab.'],
        ['Bell Labs. Funded by DARPA.', 'Bell Labs.'],
        ['Georgia Tech. This paper is accepted.', 'Georgia Tech.'],
        ['Fraunhofer Inst. Supported by EU.', 'Fraunhofer Inst.'],
        ['Stanford Univ. This work was supported by NIH.', 'Stanford Univ.']
    ]) {
        assert.equal(parser.sanitizeReaderAffiliationValue(raw), expected, `R18 #1 glued ${raw}`);
    }

    // R18 #2: Fail-closed dedupedGlobalAffiliations when global node carries markers + ‖ (U+2016) vs ∥ (U+2225) normalization
    const unmatchedMarkedHtml = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<sup>1</sup></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White<sup>2</sup></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Carol Davis<sup>3</sup></span></span>
      <span class="ltx_role_affiliation"><sup>1</sup>Stanford University<br><sup>2</sup>MIT</span>
    </div></body></html>`;
    const unmatchedRes = parser.parseArxivReaderAuthors(cheerio.load(unmatchedMarkedHtml));
    assert.ok(unmatchedRes.authors.every(a => a.affiliations.length === 0 || a.affiliations.every(v => /^机构信息未/.test(v))), 'R18 #2 unmatched marked global aff must fail closed');

    const parallelNormHtml = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<math><annotation encoding="application/x-tex">\\|</annotation></math></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White<math><annotation encoding="application/x-tex">\\ast</annotation></math></span></span>
      <span class="ltx_role_affiliation"><sup>‖</sup>Stanford University<br><sup>∗</sup>MIT</span>
    </div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(parallelNormHtml)).authors, [
        { name: 'Alice Brown', affiliations: ['Stanford University'] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ], 'R18 #2 MathML \\| matches U+2016 ‖');

    // R18 #3: sup inside .ltx_contact.ltx_role_affiliation .ltx_note.ltx_role_thanks must not disable rejectUnboundTrailingAffiliationGroup
    const scopedSupHtml = `<html><body><div class="ltx_authors">
      <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
      <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span>
        <span class="ltx_contact ltx_role_affiliation">Affiliation: Stanford University   MIT<span class="ltx_note ltx_role_thanks"><sup>*</sup>Equal contribution.</span></span>
      </div>
    </div></body></html>`;
    const scopedRes = parser.parseArxivReaderAuthors(cheerio.load(scopedSupHtml));
    assert.ok(scopedRes.authors.every(a => a.affiliations.length === 0 || /^机构信息未/.test(a.affiliations[0])), 'R18 #3 thanks sup inside affiliation must not bypass trailing group rejection');

    // R18 #4: Eliminated O(W^3) blowup on combined multi-author .ltx_personname & O(K^2) on K=1200 creators
    const combinedNames = Array.from({ length: 1200 }, (_, i) => `Aaa${i} Bbb${i}`).join(', ');
    const longWords = Array.from({ length: 1200 }, (_, i) => `Word${i}`).join(' ');
    const cubicHtml = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">${combinedNames}</span></span>
      <span class="ltx_note ltx_role_thanks">Alice Brown is with ${longWords}.</span>
    </div></body></html>`;
    const tCubic0 = Date.now();
    parser.parseArxivReaderAuthors(cheerio.load(cubicHtml));
    const dtCubic = Date.now() - tCubic0;
    assert.ok(dtCubic < 400, `R18 #4a combined personname took ${dtCubic}ms (must be linear, not O(W^3))`);

    const k1200Creators = Array.from({ length: 1200 }, (_, i) => (
        `<span class="ltx_creator ltx_role_author"><span class="ltx_personname">Name${i} Last${i}</span><span class="ltx_contact ltx_role_affiliation">Stanford University</span></span>`
    )).join('');
    const k1200Html = `<html><body><div class="ltx_authors">${k1200Creators}</div></body></html>`;
    const k1200Doc = cheerio.load(k1200Html);
    const tQuad0 = Date.now();
    const k1200Res = parser.parseArxivReaderAuthors(k1200Doc);
    const dtQuad = Date.now() - tQuad0;
    assert.equal(k1200Res.authors.length, 1200);
    assert.ok(dtQuad < 500, `R18 #4b K=1200 creators took ${dtQuad}ms (must be linear, not O(K^2))`);

    // R18 #6: JS '+' role sanitizer parity & HTML '+' markers
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT, + equal contribution.'), 'MIT');
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT, + corresponding author.'), 'MIT');
    const plusHtml = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<sup>+</sup></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White<sup>∗</sup></span></span>
      <span class="ltx_role_affiliation"><sup>+</sup>Stanford University<br><sup>∗</sup>MIT</span>
    </div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(plusHtml)).authors, [
        { name: 'Alice Brown', affiliations: ['Stanford University'] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ], 'R18 #6 HTML + marker parity');

    // R18 #7: Unicode/multi-letter initials in thanks splitter + Van de / 1-char lowercase tail rejection
    for (const [nm, aff] of [
        ['Š. Horváth', 'Stanford University'],
        ['Ł. Kowalski', 'MIT'],
        ['Ch. Müller', 'ETH Zurich']
    ]) {
        const html = `<html><body><div class="ltx_authors">
          <span class="ltx_creator ltx_role_author"><span class="ltx_personname">${nm}</span></span>
          <span class="ltx_note ltx_role_thanks">${nm} is with ${aff}.</span>
        </div></body></html>`;
        assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html)).authors, [
            { name: nm, affiliations: [aff] }
        ], `R18 #7 thanks initial ${nm}`);
    }
    const vandeRes = parser.parseArxivReaderAuthors(cheerio.load(`<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Hugo Van de</span></span>
      <span class="ltx_note ltx_role_thanks">Hugo Van de is with KU Leuven.</span>
    </div></body></html>`));
    assert.ok(
        vandeRes.authors[0].affiliations.length === 0 || vandeRes.authors[0].affiliations.every(v => /^机构信息未/.test(v)),
        'R18 #7 particle-only tail Hugo Van de rejected as complete author'
    );
});

test('Wave 7 R19 回归：&作者切分、2609.27021行中sup/序数/1./a全局列表与会议‖归一化、trailing-group三绕过、+邮编/1+2、surname/多词姓/Studio X、Bell Labs粘连与全链O(K)线性扩展', () => {
    // R19 #1: '&'-joined authors split properly in buildKnownAuthorIndex
    const ampHtml = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author">
        <span class="ltx_personname">Alice Brown &amp; Bob White</span>
        <span class="ltx_contact ltx_role_affiliation">Alice Brown</span>
      </span>
    </div></body></html>`;
    const ampRes = parser.parseArxivReaderAuthors(cheerio.load(ampHtml));
    assert.ok(ampRes.authors.every(a => a.affiliations.every(v => /^机构信息未/.test(v))), 'R19 #1 & author name must not leak as affiliation');

    // R19 #2a: mid-line <sup> (2609.27021 pattern) and 3<sup>rd</sup> ordinal must NOT drop valid global affiliation
    const midSupHtml = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></span>
      <span class="ltx_role_affiliation">International Audio Laboratories Erlangen<sup>∗</sup>, Am Wolfsmantel 33, 91058 Erlangen, Germany</span>
    </div></body></html>`;
    const midSupRes = parser.parseArxivReaderAuthors(cheerio.load(midSupHtml));
    assert.equal(midSupRes.authors[0].affiliations[0], 'International Audio Laboratories Erlangen, Am Wolfsmantel 33, 91058 Erlangen, Germany');
    assert.equal(midSupRes.authors[1].affiliations[0], 'International Audio Laboratories Erlangen, Am Wolfsmantel 33, 91058 Erlangen, Germany');

    const ordinalHtml = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span></span>
      <span class="ltx_role_affiliation">3<sup>rd</sup> Research Lab, MIT</span>
    </div></body></html>`;
    const ordinalRes = parser.parseArxivReaderAuthors(cheerio.load(ordinalHtml));
    assert.equal(ordinalRes.authors[0].affiliations[0], '3rd Research Lab, MIT');

    // R19 #2b: punctuated numeric & lowercase global marker lists must fail closed (never flatten into single affiliation)
    for (const [label, affBody] of [
        ['1./2.', '1. Stanford University<br>2. MIT'],
        ['(1)/(2)', '(1) Stanford University<br>(2) MIT'],
        ['a/b', 'a Stanford University<br>b MIT']
    ]) {
        const html = `<html><body><div class="ltx_authors">
          <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<sup>1</sup></span></span>
          <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White<sup>2</sup></span></span>
          <span class="ltx_role_affiliation">${affBody}</span>
        </div></body></html>`;
        const res = parser.parseArxivReaderAuthors(cheerio.load(html));
        assert.ok(res.authors.every(a => a.affiliations.every(v => /^机构信息未/.test(v))), `R19 #2b ${label} must fail closed`);
    }

    // R19 #2c: conference PDF ‖ (U+2016) vs ∥ (U+2225) and * vs ∗ normalization
    const confNorm = parser.parseConferencePdfAuthors('Speech Study\nJohanna Wilroth‖, Martin Enqvist*\n∥ Eriksholm Research Centre\n∗ Linköping University\n\nAbstract\nBody.');
    assert.deepEqual(confNorm?.authors, [
        { name: 'Johanna Wilroth', affiliations: ['Eriksholm Research Centre'] },
        { name: 'Martin Enqvist', affiliations: ['Linköping University'] }
    ], 'R19 #2c conference PDF ‖/∥ and */∗ normalization');

    // R19 #3: 3 fail-open bypasses in trailing affiliation group rejection
    for (const [label, html] of [
        ['ltx_contact_email', `<html><body><div class="ltx_authors">
          <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
          <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span>
            <span class="ltx_contact ltx_role_affiliation">Affiliation: Stanford University   MIT<span class="ltx_contact_email">bob@mit.edu</span></span>
          </div></div></body></html>`],
        ['Affiliations:', `<html><body><div class="ltx_authors">
          <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
          <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span>
            <span class="ltx_contact ltx_role_affiliation">Affiliations: Stanford University   MIT</span>
          </div></div></body></html>`],
        ['trailing dot', `<html><body><div class="ltx_authors">
          <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
          <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span>
            <span class="ltx_contact ltx_role_affiliation">Affiliation: Stanford University   MIT.</span>
          </div></div></body></html>`],
        ['bare role sup*', `<html><body><div class="ltx_authors">
          <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<sup>*</sup></span></div>
          <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White</span>
            <span class="ltx_contact ltx_role_affiliation">Affiliation: Stanford University   MIT</span>
          </div></div></body></html>`]
    ]) {
        const res = parser.parseArxivReaderAuthors(cheerio.load(html));
        assert.ok(res.authors.every(a => a.affiliations.every(v => /^机构信息未/.test(v))), `R19 #3 ${label} must reject unbound trailing group`);
    }

    // R19 #4: '+' phone guard must preserve Japanese/US ZIP+4 affiliations and reject mid-string '1+2' markers
    const plusZipHtml = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<sup>+</sup></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White<sup>∗</sup></span></span>
      <span class="ltx_role_affiliation"><sup>+</sup>University of Tokyo, Tokyo 113-8656, Japan<br><sup>∗</sup>MIT</span>
    </div></body></html>`;
    assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(plusZipHtml)).authors, [
        { name: 'Alice Brown', affiliations: ['University of Tokyo, Tokyo 113-8656, Japan'] },
        { name: 'Bob White', affiliations: ['MIT'] }
    ], 'R19 #4a + marker with Japanese postal code preserved');

    const plusRawFailClosed = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<sup>+</sup></span></span>
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Bob White<sup>∗</sup></span></span>
      <span class="ltx_role_affiliation">+ University of Tokyo, Tokyo 113-8656, Japan<br>∗ Equal contribution.</span>
    </div></body></html>`;
    const plusRawRes = parser.parseArxivReaderAuthors(cheerio.load(plusRawFailClosed));
    assert.ok(plusRawRes.authors[1].affiliations.every(v => /^机构信息未/.test(v)), 'R19 #4a Bob White must NOT be misbound to + University of Tokyo');

    const midPlusMarker = `<html><body><div class="ltx_authors">
      <span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown<sup>1+2</sup></span></span>
      <span class="ltx_role_affiliation"><sup>1</sup>Stanford University<br><sup>2</sup>MIT</span>
    </div></body></html>`;
    const midPlusRes = parser.parseArxivReaderAuthors(cheerio.load(midPlusMarker));
    assert.ok(midPlusRes.authors[0].affiliations.every(v => /^机构信息未/.test(v)), 'R19 #4b 1+2 must not parse as markers');

    // R19 #5 & #6: lowercase 'they' after 'Sun.', multi-token surnames 'Ch. Van hamme' / 'Ch. A. Müller', 'Studio X.', Bell Labs. Accepted/†Supported
    const thanksParityCases = [
        [
            ['Alice Brown'],
            'Alice Brown is with Sun. they and others helped review.',
            [{ name: 'Alice Brown', affiliations: ['Sun'] }]
        ],
        [
            ['Alice Brown', 'Ch. Van hamme'],
            'Alice Brown is with MIT, and Ch. Van hamme is with KU Leuven.',
            [{ name: 'Alice Brown', affiliations: ['MIT'] }, { name: 'Ch. Van hamme', affiliations: ['KU Leuven'] }]
        ],
        [
            ['Alice Brown', 'Ch. A. Müller'],
            'Alice Brown is with MIT, and Ch. A. Müller is with Technical University of Munich.',
            [{ name: 'Alice Brown', affiliations: ['MIT'] }, { name: 'Ch. A. Müller', affiliations: ['Technical University of Munich'] }]
        ],
        [
            ['Alice Brown', 'Bob White'],
            'Alice Brown is with Studio X. Bob White is with Stanford University.',
            [{ name: 'Alice Brown', affiliations: ['Studio X'] }, { name: 'Bob White', affiliations: ['Stanford University'] }]
        ],
        [
            ['Alice Brown'],
            'Alice Brown is with Bell Labs. Accepted at ICASSP 2026.',
            [{ name: 'Alice Brown', affiliations: ['Bell Labs.'] }]
        ],
        [
            ['Alice Brown'],
            'Alice Brown is with Bell Labs. †Supported by NSFC 12345.',
            [{ name: 'Alice Brown', affiliations: ['Bell Labs.'] }]
        ]
    ];
    for (const [names, sent, expected] of thanksParityCases) {
        const creators = names.map(nm => `<span class="ltx_creator ltx_role_author"><span class="ltx_personname">${nm}</span></span>`).join('');
        const html = `<html><body><div class="ltx_authors">${creators}<span class="ltx_note ltx_role_thanks">${sent}</span></div></body></html>`;
        assert.deepEqual(parser.parseArxivReaderAuthors(cheerio.load(html)).authors, expected, `R19 #5/#6 ${sent}`);
    }

    // R19 #8: O(K) scaling for alignAuthorNames1to1 (Tier 3 K=900), resolveApiReaderAuthors (K=900), and metadataAffiliationsForName (K=2400)
    const k900Meta = Array.from({ length: 900 }, (_, i) => `First${i} A. Last${i}`);
    const k900Parsed = Array.from({ length: 900 }, (_, i) => ({ name: `First${i} Last${i}`, affiliations: [`Institute ${i}`] }));
    const tAlign0 = Date.now();
    const aligned900 = parser.alignAuthorNames1to1(k900Meta, k900Parsed);
    const dtAlign = Date.now() - tAlign0;
    assert.equal(aligned900?.size, 900);
    assert.ok(dtAlign < 300, `R19 #8a alignAuthorNames1to1 Tier 3 K=900 took ${dtAlign}ms (must be O(K))`);

    const fakeDomSha = 'a'.repeat(64);
    const tResolve0 = Date.now();
    const resolved900 = parser.resolveApiReaderAuthors(
        { arxivId: '2611.99999', authors: k900Meta },
        { text: 'paper text', readerAuthors: { authors: k900Parsed, sourceDomSha256: fakeDomSha } }
    );
    const dtResolve = Date.now() - tResolve0;
    assert.equal(resolved900.authors.length, 900);
    assert.ok(dtResolve < 400, `R19 #8b resolveApiReaderAuthors K=900 took ${dtResolve}ms (must be O(K))`);

    const k2400Metas = Array.from({ length: 2400 }, (_, i) => (
        `<meta name="citation_author" content="Meta${i} Author${i}"><meta name="citation_author_institution" content="Uni ${i}">`
    )).join('');
    const k2400Doc = cheerio.load(`<html><head>${k2400Metas}</head><body></body></html>`);
    const tMeta0 = Date.now();
    const metaRes2400 = parser.parseArxivReaderAuthors(k2400Doc);
    const dtMeta = Date.now() - tMeta0;
    assert.equal(metaRes2400.authors.length, 2400);
    assert.ok(dtMeta < 500, `R19 #8c metadataAffiliationsForName K=2400 took ${dtMeta}ms (must be O(K))`);
});

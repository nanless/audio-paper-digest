'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cheerio = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const parser = require('../scripts/lib/reader-author-parser.js');

function buildSyntheticPdf(pythonBuildBody) {
    const script = `
import base64, fitz
doc = fitz.open()
page = doc.new_page(width=612, height=792)
${pythonBuildBody}
print(base64.b64encode(doc.tobytes()).decode("ascii"))
`;
    const res = spawnSync('bash', [path.join(ROOT, 'scripts/python-runtime.sh'), '-c', script], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 20000
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return Buffer.from(res.stdout.trim(), 'base64');
}

test('Track A1 / Pillar 1 v2: 双版本协议隔离、Mode E inline_author_aff 与 v1/v2 缓存分桶', () => {
    assert.equal(parser.PDF_PAGE1_AUTHOR_CONTRACT_V1, 'pdf-page1-author-evidence-v1');
    assert.equal(parser.PDF_PAGE1_AUTHOR_CONTRACT_V2, 'pdf-page1-author-evidence-v2');
    assert.equal(parser.PDF_PAGE1_AUTHOR_CONTRACT, parser.PDF_PAGE1_AUTHOR_CONTRACT_V2);

    // Dual v1/v2 single_institution city-tail behavior + independent cache buckets
    const singleInstPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Neural Acoustic Modeling for Robust Speech Recognition", fontsize=16, fontname="helv")
page.insert_text((72, 130), "Alice Brown, Bob White", fontsize=11, fontname="helv")
page.insert_text((72, 148), "Stanford University", fontsize=10, fontname="helv")
page.insert_text((72, 162), "Stanford, CA", fontsize=10, fontname="helv")
page.insert_text((72, 210), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 230), "We study robust neural acoustic modeling.", fontsize=10, fontname="helv")
`);
    const evV1 = parser.extractPdfPage1AuthorsSync(singleInstPdf, { contract: parser.PDF_PAGE1_AUTHOR_CONTRACT_V1 });
    const evV2 = parser.extractPdfPage1AuthorsSync(singleInstPdf, { contract: parser.PDF_PAGE1_AUTHOR_CONTRACT_V2 });
    assert.ok(evV1 && evV2);
    assert.equal(evV1.contract, 'pdf-page1-author-evidence-v1');
    assert.equal(evV2.contract, 'pdf-page1-author-evidence-v2');
    assert.deepEqual(evV1.authors[0].affiliations, ['Stanford University', 'Stanford, CA']);
    assert.deepEqual(evV2.authors[0].affiliations, ['Stanford University, Stanford, CA']);
    assert.equal(parser.validatePdfPage1AuthorEvidence(evV1, evV1.pdfSha256), true);
    assert.equal(parser.validatePdfPage1AuthorEvidence(evV2, evV2.pdfSha256), true);
    assert.throws(() => parser.extractPdfPage1AuthorsSync(singleInstPdf, { contract: 'pdf-page1-author-evidence-v99' }));

    // Mode E: ACM acmart inline "AUTHOR, Institution, Country"
    const acmPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Efficient Audio Coding for Real-Time Communication", fontsize=16, fontname="helv")
page.insert_text((72, 130), "ALICE BROWN, Massachusetts Institute of Technology, USA", fontsize=10, fontname="helv")
page.insert_text((72, 145), "BOB WHITE, ETH Zurich, Switzerland", fontsize=10, fontname="helv")
page.insert_text((72, 195), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 215), "We present an efficient audio coding framework.", fontsize=10, fontname="helv")
`);
    const acmEv = parser.extractPdfPage1AuthorsSync(acmPdf, { contract: parser.PDF_PAGE1_AUTHOR_CONTRACT_V2 });
    assert.ok(acmEv, 'Mode E should extract ACM inline author/affiliation lines');
    assert.equal(acmEv.mode, 'inline_author_aff');
    assert.equal(acmEv.authors.length, 2);
    assert.deepEqual(acmEv.authors[0].affiliations, ['Massachusetts Institute of Technology, USA']);
    assert.deepEqual(acmEv.authors[1].affiliations, ['ETH Zurich, Switzerland']);
});

test('Track A1 / Pillar 1 v2: 纯标记间隔保护、尊称剥离、UNSW/Stanford 保护与纯地名拦截', () => {
    // 1. Pure location vs real org protection in JS sanitizer
    assert.equal(parser.sanitizeReaderAffiliationValue('Hangzhou, China'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('Tashkent, Uzbekistan'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford, CA, USA'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('UNSW Sydney, Australia'), 'UNSW Sydney, Australia');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford, USA'), 'Stanford, USA');
    assert.equal(parser.sanitizeReaderAffiliationValue('Earth Species Project, France'), 'Earth Species Project, France');
    assert.equal(parser.sanitizeReaderAffiliationValue('Cartesia, USA'), 'Cartesia, USA');
    assert.equal(parser.sanitizeReaderAffiliationValue('Meta, USA'), 'Meta, USA');

    // 2. Mode A: leading marker with ~9pt gap must stay glued to affiliation + Prof. honorific + UNSW/Stanford
    const markerPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Cross-Lingual Prosody Transfer for Expressive Synthesis", fontsize=16, fontname="helv")
page.insert_text((72, 130), "Alice Brown", fontsize=11, fontname="helv")
page.insert_text((130, 126), "1", fontsize=7, fontname="helv")
page.insert_text((136, 130), ", Prof. Bob White", fontsize=11, fontname="helv")
page.insert_text((224, 126), "2", fontsize=7, fontname="helv")
page.insert_text((72, 152), "1", fontsize=6.4, fontname="helv")
page.insert_text((85, 154), "UNSW Sydney, Australia", fontsize=9.2, fontname="helv")
page.insert_text((72, 170), "2", fontsize=6.4, fontname="helv")
page.insert_text((85, 172), "Stanford, USA", fontsize=9.2, fontname="helv")
page.insert_text((72, 220), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 240), "We investigate prosody transfer.", fontsize=10, fontname="helv")
`);
    const ev = parser.extractPdfPage1AuthorsSync(markerPdf);
    assert.ok(ev, 'Mode A should bind UNSW Sydney, Stanford USA, and strip Prof.');
    assert.equal(ev.mode, 'markers');
    assert.deepEqual(ev.authors, [
        { name: 'Alice Brown', affiliations: ['UNSW Sydney, Australia'] },
        { name: 'Bob White', affiliations: ['Stanford, USA'] }
    ]);
});

test('Track A1 / Pillar 1 v2: Mode C 严邻层级合并与同级高校隔离 + Mode D 域名品牌与 UC/ETH/MIT 卡片', () => {
    // 1. Hierarchical strictly-consecutive subunit + parent (Technische Universität + Institute for) merges
    const hierPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Multi-Channel Speech Enhancement Under Reverberation", fontsize=16, fontname="helv")
page.insert_text((72, 130), "Alice Brown, Bob White", fontsize=11, fontname="helv")
page.insert_text((72, 150), "Technische Universitat Braunschweig", fontsize=10, fontname="helv")
page.insert_text((72, 164), "Institute for Communications Technology", fontsize=10, fontname="helv")
page.insert_text((72, 215), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 235), "We study multi-channel enhancement.", fontsize=10, fontname="helv")
`);
    const hierEv = parser.extractPdfPage1AuthorsSync(hierPdf);
    assert.ok(hierEv);
    assert.equal(hierEv.mode, 'single_institution');
    assert.deepEqual(hierEv.authors[0].affiliations, [
        'Technische Universitat Braunschweig, Institute for Communications Technology'
    ]);

    // 2. Peer top institutions (Stanford University + MIT) MUST fail-closed (never merged)
    const peerPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Multi-Institution Joint Speech Benchmark", fontsize=16, fontname="helv")
page.insert_text((72, 130), "Alice Brown, Bob White", fontsize=11, fontname="helv")
page.insert_text((72, 150), "Stanford University", fontsize=10, fontname="helv")
page.insert_text((72, 164), "Massachusetts Institute of Technology", fontsize=10, fontname="helv")
page.insert_text((72, 215), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 235), "We propose a benchmark.", fontsize=10, fontname="helv")
`);
    assert.equal(parser.extractPdfPage1AuthorsSync(peerPdf), null);

    // 3. Mode D multi-column cards with UC San Diego + email-domain brand Kinaxis
    const cardsPdf = buildSyntheticPdf(`
page.insert_text((72, 85), "Evaluating Multimodal Audio Grounding", fontsize=16, fontname="helv")
page.insert_text((90, 130), "Alice Brown", fontsize=11, fontname="helv")
page.insert_text((90, 144), "UC San Diego", fontsize=10, fontname="helv")
page.insert_text((90, 158), "abrown@ucsd.edu", fontsize=9.5, fontname="helv")
page.insert_text((310, 130), "Bob White", fontsize=11, fontname="helv")
page.insert_text((310, 144), "Kinaxis", fontsize=10, fontname="helv")
page.insert_text((310, 158), "bwhite@kinaxis.com", fontsize=9.5, fontname="helv")
page.insert_text((72, 220), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 240), "We evaluate audio grounding.", fontsize=10, fontname="helv")
`);
    const cardsEv = parser.extractPdfPage1AuthorsSync(cardsPdf);
    assert.ok(cardsEv, 'Mode D should extract UC San Diego and email-matched Kinaxis');
    assert.equal(cardsEv.mode, 'column_blocks');
    assert.deepEqual(cardsEv.authors, [
        { name: 'Alice Brown', affiliations: ['UC San Diego'] },
        { name: 'Bob White', affiliations: ['Kinaxis'] }
    ]);
});

test('Track A1 / Pillar 1 v2: 姓名对齐 Tier 3 德语双字符/多给定名重排 + HTML 清洗与质量决胜', () => {
    // 1. German umlaut digraph + reordered multi-given-name token set
    const aligned = parser.alignAuthorNames1to1(
        ['Hans Müller', 'Michael Barasa Murunga'],
        [
            { name: 'Hans Mueller', affiliations: ['ETH Zurich'] },
            { name: 'Barasa Michael Murunga', affiliations: ['Strathmore University'] }
        ]
    );
    assert.ok(aligned, 'Should align umlaut digraph and reordered multi-given names 1-to-1');
    assert.deepEqual(aligned.get(0).affiliations, ['ETH Zurich']);
    assert.deepEqual(aligned.get(1).affiliations, ['Strathmore University']);

    // Duplicate author names must still fail closed
    assert.equal(
        parser.alignAuthorNames1to1(
            ['John Smith', 'John Smith'],
            [
                { name: 'John Smith', affiliations: ['MIT'] },
                { name: 'John Smith', affiliations: ['Stanford University'] }
            ]
        ),
        null
    );

    // 2. HTML .ltx_note_type stripping & Elsevier key=value cleanup
    const html = `<html><body>
      <h1 class="ltx_title_document">Title
        <span class="ltx_note ltx_role_thanks"><span class="ltx_note_type">Note: </span>Alice Brown is with MIT.</span>
      </h1>
      <div class="ltx_authors">
        <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span></div>
      </div>
    </body></html>`;
    const parsed = parser.parseArxivReaderAuthors(cheerio.load(html));
    assert.ok(parsed);
    assert.deepEqual(parsed.authors, [{ name: 'Alice Brown', affiliations: ['MIT'] }]);
    assert.equal(parser.sanitizeReaderAffiliationValue('address:'), '');
});

test('Track A1 / Pillar 1 v2 Round 5 独立审查回归：3段公司地名、单作者双栏防粘连、Mode E/C 防误绑、Tier 4 冲突守卫、LaTeX 边界与历史回放', () => {
    // HIGH-2: 3-part "<Company>, <City>, <Country>" must NOT be wiped as pure location
    assert.equal(parser.sanitizeReaderAffiliationValue('Arm, Cambridge, United Kingdom'), 'Arm, Cambridge, United Kingdom');
    assert.equal(parser.sanitizeReaderAffiliationValue('Kinaxis, Ottawa, Canada'), 'Kinaxis, Ottawa, Canada');
    assert.equal(parser.sanitizeReaderAffiliationValue('Stanford, CA, USA'), '');
    assert.equal(parser.sanitizeReaderAffiliationValue('Taiwan, ROC'), '');

    // MEDIUM-9: LaTeX macro stripper must preserve \institute and \correspondence without truncating prefixes
    assert.equal(parser.sanitizeReaderAffiliationValue('\\institute{MIT} Stanford University'), '\\institute{MIT} Stanford University');
    assert.ok(!parser.sanitizeReaderAffiliationValue('\\correspondence{a@b.com} MIT').includes('espondence'));
    assert.equal(parser.sanitizeReaderAffiliationValue('MIT \\correspondence'), 'MIT \\correspondence');

    // MEDIUM-10: CamelCase element-boundary gluing without hardcoded org names
    const htmlGlued = `<html><body><div class="ltx_authors">
      <div class="ltx_creator ltx_role_author">
        <span class="ltx_personname">Alice Brown</span>
        <span class="ltx_contact ltx_role_affiliation">School of Computer Sciences<span>Corresponding author</span></span>
      </div>
    </div></body></html>`;
    const parsedGlued = parser.parseArxivReaderAuthors(cheerio.load(htmlGlued));
    assert.ok(parsedGlued);
    assert.deepEqual(parsedGlued.authors, [{ name: 'Alice Brown', affiliations: ['School of Computer Sciences'] }]);

    // HIGH-7: Tier 4 must NOT bypass Tier 3 middle-initial or nickname conflict guards
    assert.equal(
        parser.alignAuthorNames1to1(
            ['Alice Brown', 'John A. Smith'],
            [
                { name: 'Alice Brown', affiliations: ['MIT'] },
                { name: 'John B. Smith', affiliations: ['Stanford University'] }
            ]
        ),
        null
    );
    assert.equal(
        parser.alignAuthorNames1to1(
            ['Alice Brown', 'John (Jack) Smith'],
            [
                { name: 'Alice Brown', affiliations: ['MIT'] },
                { name: 'John (Bob) Smith', affiliations: ['Stanford University'] }
            ]
        ),
        null
    );

    // LOW-14: v1 contract must reject v2-only mode 'inline_author_aff'
    const acmPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Efficient Audio Coding for Real-Time Communication", fontsize=16, fontname="helv")
page.insert_text((72, 130), "ALICE BROWN, Massachusetts Institute of Technology, USA", fontsize=10, fontname="helv")
page.insert_text((72, 145), "BOB WHITE, ETH Zurich, Switzerland", fontsize=10, fontname="helv")
page.insert_text((72, 195), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 215), "We present an efficient audio coding framework.", fontsize=10, fontname="helv")
`);
    const acmEv = parser.extractPdfPage1AuthorsSync(acmPdf);
    assert.ok(acmEv && acmEv.mode === 'inline_author_aff');
    assert.equal(parser.validatePdfPage1AuthorEvidence({ ...acmEv, contract: parser.PDF_PAGE1_AUTHOR_CONTRACT_V1 }), false);

    // HIGH-4: Mode E must NOT false-bind multi-author ALL-CAPS headers ("ALICE SMITH, BOB JONES" / "MIT")
    const allCapsAuthorsPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Multi-Author Speech Modeling", fontsize=16, fontname="helv")
page.insert_text((72, 130), "ALICE SMITH, BOB JONES", fontsize=10, fontname="helv")
page.insert_text((72, 144), "Massachusetts Institute of Technology", fontsize=10, fontname="helv")
page.insert_text((72, 160), "CHARLIE CHEN, DAVID LEE", fontsize=10, fontname="helv")
page.insert_text((72, 174), "Stanford University", fontsize=10, fontname="helv")
page.insert_text((72, 215), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 235), "We study multi-author speech modeling.", fontsize=10, fontname="helv")
`);
    assert.equal(parser.extractPdfPage1AuthorsSync(allCapsAuthorsPdf), null);

    // HIGH-5: Mode C is_hier_pair must NOT merge independent peer orgs (Tencent AI Lab + Tsinghua / Stanford + HKUST / Fudan + Shanghai AI Lab)
    for (const [org1, org2] of [
        ['Tencent AI Lab', 'Tsinghua University'],
        ['Stanford University', 'HKUST'],
        ['School of Computer Science, Fudan University', 'Shanghai AI Laboratory']
    ]) {
        const peerPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Joint Multimodal Speech Framework", fontsize=16, fontname="helv")
page.insert_text((72, 130), "Alice Brown, Bob White", fontsize=11, fontname="helv")
page.insert_text((72, 150), ${JSON.stringify(org1)}, fontsize=10, fontname="helv")
page.insert_text((72, 163), ${JSON.stringify(org2)}, fontsize=10, fontname="helv")
page.insert_text((72, 215), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 235), "We study joint speech frameworks.", fontsize=10, fontname="helv")
`);
        assert.equal(parser.extractPdfPage1AuthorsSync(peerPdf), null, `Must not merge peer orgs: ${org1} + ${org2}`);
    }

    // HIGH-6: Mode C must reject multi-author paper with unresolved '#' marker or footnote affiliation symbol
    const hashMarkerPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Audio Understanding via Self-Supervision", fontsize=16, fontname="helv")
page.insert_text((72, 130), "Alice Brown*, Bob White#", fontsize=11, fontname="helv")
page.insert_text((72, 150), "Stanford University", fontsize=10, fontname="helv")
page.insert_text((72, 200), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 220), "We study audio understanding.", fontsize=10, fontname="helv")
page.insert_text((72, 720), "#Work performed at Massachusetts Institute of Technology.", fontsize=8, fontname="helv")
`);
    assert.equal(parser.extractPdfPage1AuthorsSync(hashMarkerPdf), null);

    // HIGH-3: Single-author 2-column side-by-side affiliations must split cleanly by column gap (no row gluing / no bare domain / no dup city)
    const singleAuthorTwoColPdf = buildSyntheticPdf(`
page.insert_text((72, 85), "Low-Resource Speech Recognition", fontsize=16, fontname="helv")
page.insert_text((240, 120), "Tiani Pekins Ebika", fontsize=11, fontname="helv")
page.insert_text((72, 145), "Department of Computer Engineering", fontsize=10, fontname="helv")
page.insert_text((360, 145), "LAB 237", fontsize=10, fontname="helv")
page.insert_text((72, 159), "University of Buea", fontsize=10, fontname="helv")
page.insert_text((360, 159), "Cameroon Open Research Community", fontsize=10, fontname="helv")
page.insert_text((72, 173), "Buea, Cameroon", fontsize=10, fontname="helv")
page.insert_text((360, 173), "lab237.org", fontsize=10, fontname="helv")
page.insert_text((360, 187), "Buea, Cameroon", fontsize=10, fontname="helv")
page.insert_text((72, 235), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 255), "We study low-resource speech recognition.", fontsize=10, fontname="helv")
`);
    const twoColEv = parser.extractPdfPage1AuthorsSync(singleAuthorTwoColPdf);
    assert.ok(twoColEv, 'Single-author 2-column affiliations should split cleanly');
    assert.deepEqual(twoColEv.authors, [{
        name: 'Tiani Pekins Ebika',
        affiliations: [
            'Department of Computer Engineering, University of Buea, Buea, Cameroon',
            'LAB 237, Cameroon Open Research Community, Buea, Cameroon'
        ]
    }]);

    // MEDIUM-8 + MEDIUM-11: Taiwan, ROC joins onto Independent Researcher; Italian Dipartimento recognized as org (not person name)
    const taiwanRocPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Neural Guitar Amplifier Modeling", fontsize=16, fontname="helv")
page.insert_text((72, 130), "Jia-Chang Yang", fontsize=11, fontname="helv")
page.insert_text((72, 148), "Independent Researcher", fontsize=10, fontname="helv")
page.insert_text((72, 162), "Taiwan, ROC", fontsize=10, fontname="helv")
page.insert_text((72, 210), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 230), "We model nonlinear guitar amplifiers.", fontsize=10, fontname="helv")
`);
    const rocEv = parser.extractPdfPage1AuthorsSync(taiwanRocPdf);
    assert.ok(rocEv);
    assert.deepEqual(rocEv.authors, [{ name: 'Jia-Chang Yang', affiliations: ['Independent Researcher, Taiwan, ROC'] }]);

    const italianPdf = buildSyntheticPdf(`
page.insert_text((72, 90), "Acoustic Field Reconstruction in Reverberant Rooms", fontsize=16, fontname="helv")
page.insert_text((72, 130), "Alice Rossi, Marco Bianchi", fontsize=11, fontname="helv")
page.insert_text((72, 148), "Dipartimento di Elettronica, Informazione e Bioingegneria", fontsize=10, fontname="helv")
page.insert_text((72, 162), "Politecnico di Milano", fontsize=10, fontname="helv")
page.insert_text((72, 210), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 230), "We reconstruct acoustic fields.", fontsize=10, fontname="helv")
`);
    const itEv = parser.extractPdfPage1AuthorsSync(italianPdf);
    assert.ok(itEv, 'Italian Dipartimento should be parsed as affiliation, not author names');
    assert.equal(itEv.authors.length, 2);
});

test('Track A1 / Pillar 1 v2 Round 6 回归：Mode B elided-with 防跨机构复制、脚注邮箱域名防误杀、单作者宽间隔邮箱/URL 保护', () => {
    // R6 #1: Mode B elided-with must NOT copy Author 2 university onto Google Research / MIT, while keeping tight shared-univ subunit inheritance
    const googleStanfordPdf = buildSyntheticPdf(`
page.insert_text((72, 85), "Joint Audio Understanding", fontsize=16, fontname="helv")
page.insert_text((72, 125), "Alice Brown and Bob White", fontsize=11, fontname="helv")
page.insert_text((72, 165), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 185), "We study joint audio understanding.", fontsize=10, fontname="helv")
page.insert_text((72, 710), "Alice Brown is with Google Research, and Bob White with the Department of Computer Science, Stanford University, USA.", fontsize=8, fontname="helv")
`);
    const gsEv = parser.extractPdfPage1AuthorsSync(googleStanfordPdf);
    assert.ok(gsEv && gsEv.mode === 'thanks');
    assert.deepEqual(gsEv.authors, [
        { name: 'Alice Brown', affiliations: ['Google Research'] },
        { name: 'Bob White', affiliations: ['Department of Computer Science, Stanford University, USA'] }
    ]);

    const mitPkuPdf = buildSyntheticPdf(`
page.insert_text((72, 85), "Cross-Modal Speech Generation", fontsize=16, fontname="helv")
page.insert_text((72, 125), "Alice Brown and Bob White", fontsize=11, fontname="helv")
page.insert_text((72, 165), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 185), "We study cross-modal generation.", fontsize=10, fontname="helv")
page.insert_text((72, 710), "Alice Brown is with MIT, and Bob White with the School of AI, Peking University, China.", fontsize=8, fontname="helv")
`);
    const mpEv = parser.extractPdfPage1AuthorsSync(mitPkuPdf);
    assert.ok(mpEv && mpEv.mode === 'thanks');
    assert.deepEqual(mpEv.authors, [
        { name: 'Alice Brown', affiliations: ['MIT'] },
        { name: 'Bob White', affiliations: ['School of AI, Peking University, China'] }
    ]);

    // R6 #3: Mode C footnote guard must strip email domains (@tencent.com) before checking org hints
    const tencentEmailFootnotePdf = buildSyntheticPdf(`
page.insert_text((72, 85), "Unified Audio Codec Evaluation", fontsize=16, fontname="helv")
page.insert_text((72, 125), "Alice Brown, Bob White*", fontsize=11, fontname="helv")
page.insert_text((72, 145), "Tsinghua University", fontsize=10, fontname="helv")
page.insert_text((72, 190), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 210), "We evaluate audio codecs.", fontsize=10, fontname="helv")
page.insert_text((72, 720), "*Corresponding author. Email: bobwhite@tencent.com.", fontsize=8, fontname="helv")
`);
    const teEv = parser.extractPdfPage1AuthorsSync(tencentEmailFootnotePdf);
    assert.ok(teEv && teEv.mode === 'single_institution');
    assert.deepEqual(teEv.authors, [
        { name: 'Alice Brown', affiliations: ['Tsinghua University'] },
        { name: 'Bob White', affiliations: ['Tsinghua University'] }
    ]);

    // R6 #4: Single-author paper with wide horizontal gap on email/URL row must NOT trigger 2-column fail-closed
    const singleAuthorWideEmailPdf = buildSyntheticPdf(`
page.insert_text((72, 85), "Efficient Neural Vocoding", fontsize=16, fontname="helv")
page.insert_text((72, 125), "Alice Brown", fontsize=11, fontname="helv")
page.insert_text((72, 145), "Stanford University", fontsize=10, fontname="helv")
page.insert_text((72, 160), "alice@stanford.edu", fontsize=9.5, fontname="helv")
page.insert_text((320, 160), "https://github.com/alice/speech", fontsize=9.5, fontname="helv")
page.insert_text((72, 210), "Abstract", fontsize=12, fontname="helv")
page.insert_text((72, 230), "We study neural vocoding.", fontsize=10, fontname="helv")
`);
    const saEv = parser.extractPdfPage1AuthorsSync(singleAuthorWideEmailPdf);
    assert.ok(saEv && saEv.mode === 'single_institution');
    assert.deepEqual(saEv.authors, [{ name: 'Alice Brown', affiliations: ['Stanford University'] }]);
});



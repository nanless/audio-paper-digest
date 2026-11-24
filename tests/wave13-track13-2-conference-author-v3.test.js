'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const parser = require('../scripts/lib/reader-author-parser.js');
const { canReuseReaderAuthorInputs } = require('../scripts/lib/reader-author-source.js');

const ROOT = path.resolve(__dirname, '..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function stableHash(value) {
    const canon = item => Array.isArray(item)
        ? item.map(canon)
        : (item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(k => [k, canon(item[k])]))
            : item);
    return sha256(JSON.stringify(canon(value)));
}

function buildSuperscriptConferencePdfBytes() {
    const py = [
        'import base64, fitz',
        'doc = fitz.open()',
        'p = doc.new_page(width=612, height=792)',
        'p.insert_text((72, 54), "Streaming Acoustic Tokenizer", fontsize=14, fontname="helv")',
        'p.insert_text((150, 82), "Alice Zhang", fontsize=10, fontname="helv")',
        'p.insert_text((204, 78), "1", fontsize=6.5, fontname="helv")',
        'p.insert_text((210, 82), ", Bob Li", fontsize=10, fontname="helv")',
        'p.insert_text((246, 78), "2", fontsize=6.5, fontname="helv")',
        'p.insert_text((130, 102), "1", fontsize=6.5, fontname="helv")',
        'p.insert_text((137, 106), "Tsinghua University, Beijing, China", fontsize=9, fontname="helv")',
        'p.insert_text((130, 118), "2", fontsize=6.5, fontname="helv")',
        'p.insert_text((137, 122), "Carnegie Mellon University, Pittsburgh, USA", fontsize=9, fontname="helv")',
        'p.insert_text((72, 160), "Abstract", fontsize=10, fontname="helv")',
        'p.insert_text((72, 176), "We propose a low-latency streaming neural speech codec.", fontsize=9, fontname="helv")',
        'print(base64.b64encode(doc.tobytes()).decode("ascii"))',
    ].join('\n');
    const b64 = execFileSync('bash', [path.join(ROOT, 'scripts/python-runtime.sh'), '-c', py], {
        cwd: ROOT, encoding: 'utf8'
    }).trim();
    return Buffer.from(b64, 'base64');
}

function makeConferenceDetails(pdfBytes, textOverride = null) {
    const pdfSha = sha256(pdfBytes);
    // Plain text that deliberately lacks reliable superscript markers (simulating Interspeech plain-text failure)
    const text = textOverride || [
        'Streaming Acoustic Tokenizer',
        'Alice Zhang, Bob Li',
        'Tsinghua University, Beijing, China',
        'Carnegie Mellon University, Pittsburgh, USA',
        'Abstract',
        'We propose a low-latency streaming neural speech codec.'
    ].join('\n');
    const artifactsBody = {
        contract: 'conference-reader-pdf-artifacts-v2',
        sourceKind: 'conference_pdf',
        sourceId: 'conference:interspeech:2026:isca-paper-id:zhang26',
        paperId: 'conference:interspeech:2026:isca-paper-id:zhang26',
        sourceHtmlSha256: pdfSha,
        tables: [],
        formulas: [],
        figures: [],
        references: [],
        health: { status: 'ready' },
        flattenedTextSha256: sha256(text)
    };
    const structuredArtifacts = { ...artifactsBody, payloadSha256: stableHash(artifactsBody) };
    return {
        text,
        source: 'conference_pdf_text',
        sourceId: 'conference:interspeech:2026:isca-paper-id:zhang26',
        imageInfos: [],
        htmlAvailability: 'not_applicable',
        htmlAttempts: 0,
        warnings: [],
        structuredArtifacts
    };
}

function makeConferencePaper(details) {
    const sourceSha = sha256(details.text);
    return {
        id: 'conference:interspeech:2026:isca-paper-id:zhang26',
        conferencePaperId: 'conference:interspeech:2026:isca-paper-id:zhang26',
        title: 'Streaming Acoustic Tokenizer',
        authors: ['Alice Zhang', 'Bob Li'],
        sourceSha256: sourceSha,
        analysisManifest: {
            contracts: { apiReaderArticle: 'beginner-researcher' },
            sourceAcquisition: {
                sourceSha256: sourceSha,
                structuredArtifactsSha256: details.structuredArtifacts.payloadSha256
            },
            stages: {
                apiReaderArticle: {
                    structuredArtifactsSha256: details.structuredArtifacts.payloadSha256
                }
            }
        }
    };
}

function saveAuthorsOnPaper(paper, resolved) {
    paper.apiReaderAuthors = resolved;
    paper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256 = resolved.identitySha256;
    paper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256 = stableHash(resolved);
    return paper;
}

test('Track 13.2: conference v3 binds superscript PDF Page-1 authors where plain-text v2 leaves them unbound', () => {
    parser.clearReaderAuthorVerificationCaches();
    const pdfBytes = buildSuperscriptConferencePdfBytes();
    const details = makeConferenceDetails(pdfBytes);
    const paper = makeConferencePaper(details);

    // Baseline v2 plain-text parser fails to disambiguate 2 unmarked institutions -> unbound
    const v2 = parser.resolveVerifiedReaderAuthors(paper, details, { conferencePdfAuthorParserVersion: 2 });
    assert.equal(v2.identity.conferencePdfAuthorParser, parser.CONFERENCE_PDF_AUTHOR_LINES_V2);
    assert.match(v2.authors[0].affiliations[0], /^机构信息未能从会议 PDF 纯文本可靠映射/);

    // Upgraded v3 with verified PDF bytes uses pdf_author_extract.py v2 -> binds BOTH authors!
    assert.equal(parser.preferredConferenceAuthorParserVersion(paper, details, { pdfBytes }), 3);
    const v3 = parser.resolveVerifiedReaderAuthors(paper, details, {
        conferencePdfAuthorParserVersion: 3,
        pdfBytes
    });
    assert.equal(v3.identity.conferencePdfAuthorParser, parser.CONFERENCE_PDF_AUTHOR_PDF_PAGE1_V3);
    assert.equal(v3.authors[0].name, 'Alice Zhang');
    assert.match(v3.authors[0].affiliations[0], /Tsinghua University/);
    assert.equal(v3.authors[1].name, 'Bob Li');
    assert.match(v3.authors[1].affiliations[0], /Carnegie Mellon University/);
    assert.equal(v3.identity.authors[0].affiliationBindings[0].sourceKind, 'pdf_text');
    assert.equal(v3.identity.authors[1].affiliationBindings[0].sourceKind, 'pdf_text');

    saveAuthorsOnPaper(paper, v3);
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details, { pdfBytes }), true);
    assert.equal(canReuseReaderAuthorInputs(paper, details, { pdfBytes }), true);

    // Tampered PDF bytes (SHA mismatch against structuredArtifacts.sourceHtmlSha256) must NOT match!
    const tamperedPdf = Buffer.concat([pdfBytes, Buffer.from('\n% tampered\n')]);
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details, { pdfBytes: tamperedPdf }), false);
});

test('Track 13.2: official venue metadata affiliations preserve OpenReview/IEEE/ISCA affiliations with SHA binding', () => {
    parser.clearReaderAuthorVerificationCaches();
    const dummyPdf = Buffer.from('%PDF-1.4\n' + '0'.repeat(300) + '\n%%EOF\n');
    const details = makeConferenceDetails(dummyPdf);
    const paper = makeConferencePaper(details);
    const metadataSha = 'a'.repeat(64);
    const officialMeta = parser.extractOfficialConferenceMetadataAuthors({
        authors: [
            { name: 'Alice Zhang', affiliations: ['Tsinghua University', 'N/A'] },
            { name: 'Bob Li', institution: 'Carnegie Mellon University' }
        ]
    }, metadataSha);
    assert.ok(officialMeta);
    assert.equal(officialMeta.contract, parser.CONFERENCE_OFFICIAL_METADATA_AUTHOR_CONTRACT);
    assert.equal(parser.validateOfficialConferenceMetadataAuthorEvidence(officialMeta, metadataSha), true);
    assert.equal(parser.validateOfficialConferenceMetadataAuthorEvidence(officialMeta, 'b'.repeat(64)), false);
    assert.equal(
        parser.validateOfficialConferenceMetadataAuthorEvidence({ ...officialMeta, authors: [{ name: 'Tampered', affiliations: ['Fake'] }] }),
        false
    );

    // Self-attested paper.officialMetadataAuthors / details.officialMetadataAuthors MUST NEVER grant v3 or bypass replay!
    paper.officialMetadataAuthors = officialMeta;
    details.officialMetadataAuthors = officialMeta;
    assert.equal(parser.preferredConferenceAuthorParserVersion(paper, details), 2);
    assert.equal(
        parser.preferredConferenceAuthorParserVersion(paper, details, {
            officialMetadataAuthors: officialMeta,
            expectedMetadataSha256: metadataSha
        }),
        3
    );
    const resolved = parser.resolveVerifiedReaderAuthors(paper, details, {
        conferencePdfAuthorParserVersion: 3,
        officialMetadataAuthors: officialMeta,
        expectedMetadataSha256: metadataSha
    });
    assert.equal(resolved.identity.conferencePdfAuthorParser, parser.CONFERENCE_PDF_AUTHOR_PDF_PAGE1_V3);
    assert.deepEqual(resolved.authors, [
        { name: 'Alice Zhang', affiliations: ['Tsinghua University'] },
        { name: 'Bob Li', affiliations: ['Carnegie Mellon University'] }
    ]);
    assert.equal(resolved.identity.authors[0].nameBinding.sourceKind, 'official_metadata');
    assert.equal(resolved.identity.authors[0].affiliationBindings[0].sourceKind, 'official_metadata');

    saveAuthorsOnPaper(paper, resolved);
    // Authenticated replay succeeds with exact officialMetadataAuthors + expectedMetadataSha256
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details, {
        officialMetadataAuthors: officialMeta,
        expectedMetadataSha256: metadataSha
    }), true);
    // Explicit null (official metadata has NO affiliations) MUST fail closed even when paper.officialMetadataAuthors is forged!
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details, {
        officialMetadataAuthors: null,
        expectedMetadataSha256: metadataSha
    }), false);
    // Omitted officialMetadataAuthors outside authenticated conference context MUST also fail closed!
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details, {
        expectedMetadataSha256: metadataSha
    }), false);
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details, {
        officialMetadataAuthors: officialMeta,
        expectedMetadataSha256: 'c'.repeat(64)
    }), false);
});

test('Track 13.2 R1 security & parity: rejects spoofed pdfPage1Authors, handles partial affiliations, and matches Python SHA', () => {
    parser.clearReaderAuthorVerificationCaches();
    const pdfBytes = buildSuperscriptConferencePdfBytes();
    const details = makeConferenceDetails(pdfBytes);
    const paper = makeConferencePaper(details);

    // P0-2: Unauthenticated details.pdfPage1Authors MUST be ignored and real PDF bytes must be pinned to expectedPdfSha
    const pdfSha = sha256(pdfBytes);
    const fakeEvidence = {
        contract: parser.PDF_PAGE1_AUTHOR_CONTRACT_V2,
        pdfSha256: pdfSha,
        sourceEvidence: 'FORGED',
        sourceEvidenceSha256: sha256('FORGED'),
        sourceDomSha256: sha256(`${pdfSha}:${sha256('FORGED')}`),
        authors: [
            { name: 'Alice Zhang', affiliations: ['FORGED INSTITUTE A'] },
            { name: 'Bob Li', affiliations: ['FORGED INSTITUTE B'] }
        ]
    };
    const spoofDetails = { ...details, pdfPage1Authors: fakeEvidence };
    assert.equal(parser.preferredConferenceAuthorParserVersion(paper, spoofDetails), 2);
    const resolvedFromRealPdf = parser.resolveVerifiedReaderAuthors(paper, spoofDetails, {
        conferencePdfAuthorParserVersion: 3,
        pdfBytes
    });
    assert.match(resolvedFromRealPdf.authors[0].affiliations[0], /Tsinghua University/);
    assert.doesNotMatch(resolvedFromRealPdf.authors[0].affiliations[0], /FORGED/);

    // Unpinned pdfBytes with missing expectedPdfSha (weak-layout conference paper) MUST fail closed
    const weakDetails = {
        ...details,
        structuredArtifacts: { ...details.structuredArtifacts, sourceHtmlSha256: null }
    };
    assert.equal(parser.resolveAuthenticatedConferencePdfBytes(weakDetails, pdfBytes).pdfBytes, null);

    // R2 P1-1: Weak-layout v3 conference paper replays cleanly with caller-verified expectedPdfSha256,
    // fails closed without it or with conflicting expectedPdfSha256!
    assert.equal(parser.preferredConferenceAuthorParserVersion(paper, weakDetails, { pdfBytes }), 2);
    assert.equal(
        parser.preferredConferenceAuthorParserVersion(paper, weakDetails, { pdfBytes, expectedPdfSha256: pdfSha }),
        3
    );
    const weakV3 = parser.resolveVerifiedReaderAuthors(paper, weakDetails, {
        conferencePdfAuthorParserVersion: 3,
        pdfBytes,
        expectedPdfSha256: pdfSha
    });
    assert.match(weakV3.authors[0].affiliations[0], /Tsinghua University/);
    const weakPaper = saveAuthorsOnPaper(makeConferencePaper(weakDetails), weakV3);
    assert.equal(
        canReuseReaderAuthorInputs(weakPaper, weakDetails, { pdfBytes, expectedPdfSha256: pdfSha }),
        true
    );
    assert.equal(canReuseReaderAuthorInputs(weakPaper, weakDetails, { pdfBytes }), false);
    assert.equal(
        canReuseReaderAuthorInputs(weakPaper, weakDetails, { pdfBytes, expectedPdfSha256: '1'.repeat(64) }),
        false
    );
    // Conflicting caller expectedPdfSha256 MUST NEVER override details.structuredArtifacts.sourceHtmlSha256!
    assert.equal(
        parser.resolveAuthenticatedConferencePdfBytes(details, pdfBytes, '2'.repeat(64)).pdfBytes,
        null
    );

    // P1-1: Partial official metadata affiliations keep Alice & Carol bound while marking only Bob unavailable
    const metaSha = 'd'.repeat(64);
    const partialMeta = parser.extractOfficialConferenceMetadataAuthors({
        authors: [
            { name: 'Alice Zhang', affiliations: ['Tsinghua University'] },
            { name: 'Bob Li', affiliations: ['N/A'] },
            { name: 'Carol Wu', affiliation: '', institution: 'MIT' }
        ]
    }, metaSha);
    assert.ok(partialMeta);
    assert.equal(partialMeta.authors.length, 3);
    assert.deepEqual(partialMeta.authors[1].affiliations, []);
    assert.deepEqual(partialMeta.authors[2].affiliations, ['MIT']);
    const partialPaper = { ...paper, authors: ['Alice Zhang', 'Bob Li', 'Carol Wu'] };
    const partialResolved = parser.resolveVerifiedReaderAuthors(partialPaper, details, {
        conferencePdfAuthorParserVersion: 3,
        officialMetadataAuthors: partialMeta,
        expectedMetadataSha256: metaSha
    });
    assert.deepEqual(partialResolved.authors[0].affiliations, ['Tsinghua University']);
    assert.match(partialResolved.authors[1].affiliations[0], /^机构信息未/);
    assert.deepEqual(partialResolved.authors[2].affiliations, ['MIT']);

    // P1-3: Cross-language parity with Python (NFD accents + whitespace-padded keys + empty fallback)
    const parityMeta = {
        authors: ['Jose\u0301 Garc\u0301ia', '  Alice  Zhang  '],
        authorAffiliations: {
            '  Jose\u0301   Garc\u0301ia ': ['Universitat Pompeu Fabra'],
            'Alice Zhang': ['Tsinghua University', 'tsinghua university']
        }
    };
    const jsEvidence = parser.extractOfficialConferenceMetadataAuthors(parityMeta, metaSha);
    assert.ok(jsEvidence);
    const pyOut = execFileSync('bash', [
        path.join(ROOT, 'scripts/python-runtime.sh'), '-c',
        `import json, sys; sys.path.insert(0, "scripts"); import conference_extractor_v2 as v2; `
        + `print(json.dumps(v2.extract_official_metadata_authors(json.loads(sys.argv[1]), sys.argv[2]), ensure_ascii=False))`,
        JSON.stringify(parityMeta),
        metaSha
    ], { cwd: ROOT, encoding: 'utf8' }).trim();
    const pyEvidence = JSON.parse(pyOut);
    assert.deepEqual(jsEvidence, pyEvidence);
});

test('Track 13.2: v1 and v2 saved conference records replay identically and preferred version stays 2 without PDF/metadata', () => {
    parser.clearReaderAuthorVerificationCaches();
    const dummyPdf = Buffer.from('%PDF-1.4\n' + '0'.repeat(300) + '\n%%EOF\n');
    const text = [
        'Alice Zhang1, Bob Li2',
        '1 Tsinghua University, China',
        '2 Carnegie Mellon University, USA',
        '',
        'Abstract',
        'Body text.'
    ].join('\n');
    const details = makeConferenceDetails(dummyPdf, text);
    const paper = makeConferencePaper(details);

    // Without pdfBytes / active conference handle / officialMetadataAuthors, preferred stays 2
    assert.equal(parser.preferredConferenceAuthorParserVersion(paper, details), 2);

    const v1 = parser.resolveVerifiedReaderAuthors(paper, details);
    assert.equal(v1.identity.conferencePdfAuthorParser, undefined);
    saveAuthorsOnPaper(paper, v1);
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details), true);

    const v2 = parser.resolveVerifiedReaderAuthors(paper, details, { conferencePdfAuthorParserVersion: 2 });
    assert.equal(v2.identity.conferencePdfAuthorParser, parser.CONFERENCE_PDF_AUTHOR_LINES_V2);
    saveAuthorsOnPaper(paper, v2);
    assert.equal(parser.readerAuthorIdentityMatchesSource(paper, details), true);
});

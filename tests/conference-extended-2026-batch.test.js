'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const acqExt = require('../scripts/lib/official-conference-acquisition-extended.js');
const acqCli = require('../scripts/official-conference-acquire.js');
const discovery = require('../scripts/lib/conference-discovery.js');
const evidenceApi = require('../scripts/lib/conference-filter-evidence.js');
const filter = require('../scripts/lib/conference-filter.js');
const codec = require('../scripts/lib/protocol-codec.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const SAMPLE_PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii');

function makeTmpDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function makeResponse(status, payload, contentType = 'text/html; charset=utf-8', extraHeaders = {}) {
    const buf = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    const headersMap = new Map([
        ['content-type', contentType],
        ['content-length', String(buf.length)],
        ...Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])
    ]);
    return {
        status,
        headers: {
            get(name) {
                return headersMap.get(String(name).toLowerCase()) ?? null;
            }
        },
        body: { async cancel() {} },
        async arrayBuffer() {
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
    };
}

function assertAllPapersMeetIdentityContract(papers) {
    assert.ok(papers.length > 0);
    for (const paper of papers) {
        assert.match(paper.id, /^[A-Za-z0-9._-]{1,200}$/, `invalid id: ${paper.id}`);
        assert.equal(paperIdentity.validateOfficialUrl(paper.recordUrl, paper.id), paper.recordUrl);
        assert.ok(Array.isArray(paper.authors) && paper.authors.length >= 1 && paper.authors.length <= 1000);
        assert.equal(new Set(paper.authors).size, paper.authors.length);
        if (paper.pdfUrl !== null) {
            assert.notEqual(paper.pdfUrl, paper.recordUrl);
        }
    }
}

test('2026 extended providers registry exposes all 27 conferences and CLI parses every one', t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-registry-');
    const expectedProviders = [
        // 15 active vertical 2026 + 3 existing vertical
        'dcase-2026', 'smc-2026', 'avsp-2026', 'mlcslm-2026', 'wochat-2026', 'dc-2026',
        'sigdial-2026', 'iwsds-2026', 'sigul-2026', 'speakable-2026', 'salma-2026',
        'impactspeech-2026', 'nlp4musa-2026', 'trustaudio-2026', 'audio-aaai-2026',
        'ismir-2026', 'waspaa-2025', 'asru-2025',
        // 8 active general 2026 + 1 existing general
        'emnlp-2026', 'eccv-2026', 'lrec-2026', 'wacv-2026', 'ijcai-2026',
        'aacl-2026', 'conll-2026', 'starsem-2026', 'neurips-2026'
    ];
    const listed = acqExt.listProviderIds();
    assert.equal(listed.length, expectedProviders.length);
    for (const id of expectedProviders) {
        assert.equal(acqExt.hasProvider(id), true, `missing provider ${id}`);
        const provider = acqExt.providerFor(id);
        const parsed = acqCli.parseArgs(
            ['catalog', '--provider', id, '--conference-id', id, '--year', String(provider.conference.year), '--dry-run'],
            { acquisitionRoot: tmpRoot }
        );
        assert.equal(parsed.providerId, id);
        assert.equal(parsed.year, provider.conference.year);
    }
});

test('dcase-proceedings-html parses DCASE 2026 HTML including non-ASCII percent-encoded PDF URL, nested affiliations, and end-to-end discovery', async t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-dcase-');
    const dcaseHtml = `
      <div class="tab-pane">
        <div class="row paper-card">
          <div class="col-md-1"><span class="item-tag">P3-1</span></div>
          <div class="col-md-11">
            <h4><strong>Acoustic Scene Classification with Domain Generalization</strong></h4>
            <p><em>Ayşe Argın (Istanbul Technical University (ITU); Dept. of ECE); Jan-Erik Lindqvist (Aalto University)</em></p>
            <p>
              <a href="#collapse-62" data-toggle="collapse">Abstract</a>
              <a href="/documents/workshop2026/proceedings/DCASE2026Workshop_Argın_62.pdf">PDF</a>
            </p>
            <div id="collapse-62" class="panel-collapse collapse">
              <div class="panel-body"><p class="text-justify">We investigate acoustic scene classification across mismatched recording devices.</p></div>
            </div>
          </div>
        </div>
        <div class="row paper-card">
          <div class="col-md-1"><span class="item-tag">O1-2</span></div>
          <div class="col-md-11">
            <h4>Sound Event Localization in Reverberant Rooms</h4>
            <p><em>Wei Chen (Acoustic Lab); Maria Gomez (Audio Research)</em></p>
            <p>
              <button data-target="#collapse-7">Abstract</button>
              <a href="/documents/workshop2026/proceedings/DCASE2026Workshop_Chen_7.pdf">PDF</a>
            </p>
            <div id="collapse-7" class="collapse">
              <div class="panel-body"><p class="text-justify">Joint DOA estimation and sound event detection.</p></div>
            </div>
          </div>
        </div>
      </div>
    `;
    const provider = acqExt.providerFor('dcase-2026');
    const parsed = acqExt.parseDcaseProceedingsHtml(dcaseHtml, provider);
    assert.equal(parsed.papers.length, 2);
    assertAllPapersMeetIdentityContract(parsed.papers);

    const p62 = parsed.papers.find(p => p.id === 'dcase2026-62');
    assert.ok(p62);
    assert.equal(p62.title, 'Acoustic Scene Classification with Domain Generalization');
    assert.deepEqual(p62.authors, ['Ayşe Argın', 'Jan-Erik Lindqvist']);
    assert.equal(p62.track, 'P3-1');
    assert.equal(p62.abstract, 'We investigate acoustic scene classification across mismatched recording devices.');
    assert.equal(p62.recordUrl, 'https://dcase.community/workshop2026/proceedings');
    assert.equal(p62.pdfUrl, 'https://dcase.community/documents/workshop2026/proceedings/DCASE2026Workshop_Arg%C4%B1n_62.pdf');
    assert.equal(acqExt.validateUrlForProvider(provider, p62.pdfUrl, 'pdf'), p62.pdfUrl);

    // End-to-end acquireCatalog -> downloadPapers -> verifyAcquisition -> conference-discovery
    const dcaseDir = path.join(tmpRoot, 'dcase-2026');
    const deps = {
        fetch: async url => {
            if (url === provider.indexUrl) return makeResponse(200, dcaseHtml, 'text/html; charset=utf-8');
            if (url.endsWith('.pdf')) return makeResponse(200, SAMPLE_PDF, 'application/pdf');
            return makeResponse(404, 'not found', 'text/plain');
        }
    };
    const catRes = await acqExt.acquireCatalog({ providerId: 'dcase-2026', outputRoot: dcaseDir, apply: true }, deps);
    assert.equal(catRes.papers, 2);
    const dlRes = await acqExt.downloadPapers({ providerId: 'dcase-2026', outputRoot: dcaseDir, apply: true }, deps);
    assert.equal(dlRes.downloaded, 2);
    assert.equal(dlRes.complete, true);
    const verRes = acqExt.verifyAcquisition({ providerId: 'dcase-2026', outputRoot: dcaseDir });
    assert.equal(verRes.complete, true);
    const disc = discovery.discoverConference({
        adapter: 'official-proceedings',
        year: 2026,
        conferenceId: 'dcase-2026',
        metadataFile: path.join(dcaseDir, 'metadata.json'),
        pdfRoot: dcaseDir,
        acquisitionRoot: dcaseDir
    });
    assert.equal(disc.manifest.members.length, 2);
    assert.ok(disc.manifest.members.every(m => m.match.kind === 'exact'));
});

test('zenodo-json stopBeforeYear stops safely on smc-2026, encodes PDF URLs, and rejects truncated or extra-page replay tampering', async t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-smc-');
    const provider = acqExt.providerFor('smc-2026');
    assert.equal(provider.stopBeforeYear, true);
    assert.match(provider.indexUrl, /communities=smc&size=25&sort=mostrecent/);
    assert.match(acqExt.providerFor('ismir-2026').indexUrl, /communities=ismir&size=25&sort=mostrecent/);

    const page2Url = 'https://zenodo.org/api/records?communities=smc&page=2&size=25&sort=mostrecent';
    const page3Url = 'https://zenodo.org/api/records?communities=smc&page=3&size=25&sort=mostrecent';
    const page1 = {
        hits: {
            hits: [
                {
                    id: 19900001,
                    doi: '10.5281/zenodo.19900001',
                    metadata: {
                        title: 'Differentiable Physical Modeling for String Synthesis',
                        publication_date: '2026-07-04',
                        creators: [{ name: 'Elena Rossi' }, { name: 'Marco Bianchi' }],
                        description: '<p>Physical modeling audio synthesis.</p>',
                        conference: { title: 'SMC 2026' }
                    },
                    files: [{
                        key: 'SMC 2026 Paper 01.pdf',
                        links: { self: 'https://zenodo.org/api/records/19900001/files/SMC 2026 Paper 01.pdf/content' }
                    }]
                },
                {
                    id: 19800002,
                    metadata: {
                        title: 'Older 2025 SMC Paper on Same Page',
                        publication_date: '2025-07-10',
                        creators: [{ name: 'Old Author' }],
                        description: 'From 2025.'
                    },
                    files: [{
                        key: 'old.pdf',
                        links: { self: 'https://zenodo.org/api/records/19800002/files/old.pdf/content' }
                    }]
                }
            ]
        },
        links: { next: page2Url }
    };
    const page2AllOld = {
        hits: {
            hits: [{
                id: 19700003,
                metadata: {
                    title: 'Another 2025 SMC Paper',
                    publication_date: '2025-07-09',
                    creators: [{ name: 'Old Author 2' }],
                    description: 'From 2025.'
                },
                files: []
            }]
        },
        links: { next: page3Url }
    };

    assert.equal(acqExt.shouldStopZenodoPagination(page1, provider), false);
    assert.equal(acqExt.shouldStopZenodoPagination(page2AllOld, provider), true);

    const fetchedUrls = [];
    const smcDir = path.join(tmpRoot, 'smc-2026');
    const deps = {
        fetch: async url => {
            fetchedUrls.push(url);
            if (url === provider.indexUrl) return makeResponse(200, page1, 'application/json');
            if (url === page2Url) return makeResponse(200, page2AllOld, 'application/json');
            if (url === page3Url) throw new Error('Should NOT fetch page 3 after stopBeforeYear triggered on page 2');
            return makeResponse(404, {}, 'application/json');
        }
    };

    const catRes = await acqExt.acquireCatalog({ providerId: 'smc-2026', outputRoot: smcDir, apply: true }, deps);
    assert.equal(catRes.papers, 1);
    assert.deepEqual(fetchedUrls, [provider.indexUrl, page2Url]);
    const replayed = acqExt.replayCatalog('smc-2026', smcDir);
    assertAllPapersMeetIdentityContract(replayed.metadata.papers);
    assert.equal(
        replayed.metadata.papers[0].pdfUrl,
        'https://zenodo.org/api/records/19900001/files/SMC%202026%20Paper%2001.pdf/content'
    );

    // Tamper #1: Truncating receipt to only page 1 (which still has a 2026 hit + links.next) MUST fail replay!
    const receiptPath = path.join(smcDir, 'catalog.receipt.json');
    const origReceiptBytes = fs.readFileSync(receiptPath);
    const truncatedReceipt = JSON.parse(origReceiptBytes.toString('utf8'));
    truncatedReceipt.responses = [truncatedReceipt.responses[0]];
    const { receiptSha256: _s1, ...truncCore } = truncatedReceipt;
    truncatedReceipt.receiptSha256 = acqExt.stableHash(truncCore);
    fs.writeFileSync(receiptPath, Buffer.from(`${JSON.stringify(truncatedReceipt, null, 2)}\n`), { mode: 0o600 });
    assert.throws(() => acqExt.replayCatalog('smc-2026', smcDir), /links\.next|目录不完整/);

    // Tamper #2: Page 2 missing publication_date + links.next MUST NOT satisfy stopBeforeYear!
    fs.writeFileSync(receiptPath, origReceiptBytes, { mode: 0o600 });
    const page2NoDate = structuredClone(page2AllOld);
    delete page2NoDate.hits.hits[0].metadata.publication_date;
    assert.equal(acqExt.shouldStopZenodoPagination(page2NoDate, provider), false);

    // Tamper #3: Appending a 3rd page AFTER stopBeforeYear already triggered on page 2 MUST fail replay!
    const page3Path = path.join(smcDir, 'responses', 'page-003.json');
    const page3Bytes = Buffer.from(JSON.stringify({ hits: { hits: [] }, links: {} }), 'utf8');
    fs.writeFileSync(page3Path, page3Bytes, { mode: 0o600 });
    const extraReceipt = JSON.parse(origReceiptBytes.toString('utf8'));
    extraReceipt.responses.push({
        file: 'responses/page-003.json',
        sha256: sha(page3Bytes),
        bytes: page3Bytes.length,
        requestedUrl: page3Url,
        finalUrl: page3Url,
        redirects: [],
        responseStatus: 200,
        observedAt: '2026-11-28T00:00:00.000Z'
    });
    const { receiptSha256: _s2, ...extraCore } = extraReceipt;
    extraReceipt.receiptSha256 = acqExt.stableHash(extraCore);
    fs.writeFileSync(receiptPath, Buffer.from(`${JSON.stringify(extraReceipt, null, 2)}\n`), { mode: 0o600 });
    assert.throws(() => acqExt.replayCatalog('smc-2026', smcDir), /早停|多余分页/);
});

test('acl-anthology-html supports live div.d-sm-flex, multi-volume emnlp-2026 & aacl-2026, and single-volume 2026 workshops', async t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-acl-');
    const makeAclDivEntry = (paperId, title, authors, abstract) => `
      <div class="d-sm-flex align-items-stretch mb-3">
        <div class="d-block mr-2 text-nowrap list-button-row">
          <a class="badge badge-primary align-middle mr-1" href="https://aclanthology.org/${paperId}.pdf">pdf</a>
        </div>
        <span class="d-block">
          <strong><a class="align-middle" href="/${paperId}/">${title}</a></strong><br>
          ${authors.map(a => `<a href="/people/${a[0].toLowerCase()}/${a.toLowerCase().replace(/\s+/g, '-')}/">${a}</a>`).join(', ')}
        </span>
      </div>
      <div class="card bg-light mb-2 collapse abstract-collapse" id="abstract-${paperId.replace(/\./g, '--')}">
        <div class="card-body p-3 small">${abstract}</div>
      </div>
    `;

    // 1. Multi-volume EMNLP 2026 (vol-001.html + vol-002.html)
    const emnlpMainHtml = makeAclDivEntry('2026.emnlp-main.0', 'Frontmatter', ['Chair'], '')
        + makeAclDivEntry('2026.emnlp-main.1', 'Streaming Speech Translation with Codec Tokens', ['Alice Lin', 'Bob Wu'], 'Main track abstract.');
    const emnlpFindingsHtml = makeAclDivEntry('2026.findings-emnlp.42', 'Prosody-Aware Spoken QA', ['Carol Sun'], 'Findings track abstract.');

    const emnlpDir = path.join(tmpRoot, 'emnlp-2026');
    const emnlpProvider = acqExt.providerFor('emnlp-2026');
    const emnlpCat = await acqExt.acquireCatalog({ providerId: 'emnlp-2026', outputRoot: emnlpDir, apply: true }, {
        fetch: async url => {
            if (url === 'https://aclanthology.org/volumes/2026.emnlp-main/') return makeResponse(200, emnlpMainHtml);
            if (url === 'https://aclanthology.org/volumes/2026.findings-emnlp/') return makeResponse(200, emnlpFindingsHtml);
            return makeResponse(404, 'missing');
        }
    });
    assert.equal(emnlpCat.papers, 2);
    assert.ok(fs.existsSync(path.join(emnlpDir, 'responses/vol-001.html')));
    assert.ok(fs.existsSync(path.join(emnlpDir, 'responses/vol-002.html')));
    const emnlpReplayed = acqExt.replayCatalog('emnlp-2026', emnlpDir);
    assertAllPapersMeetIdentityContract(emnlpReplayed.metadata.papers);
    assert.deepEqual(emnlpReplayed.metadata.papers.map(p => [p.id, p.track, p.abstract]), [
        ['2026.emnlp-main.1', 'EMNLP 2026 Main', 'Main track abstract.'],
        ['2026.findings-emnlp.42', 'Findings of EMNLP 2026', 'Findings track abstract.']
    ]);
    assert.equal(acqExt.validateUrlForProvider(emnlpProvider, emnlpProvider.indexUrl, 'index'), emnlpProvider.indexUrl);

    // Multi-volume tamper: dropping vol-002 MUST fail replay
    const emnlpReceiptFile = path.join(emnlpDir, 'catalog.receipt.json');
    const badEmnlpReceipt = JSON.parse(fs.readFileSync(emnlpReceiptFile, 'utf8'));
    badEmnlpReceipt.responses = [badEmnlpReceipt.responses[0]];
    const { receiptSha256: _eSha, ...badEmnlpCore } = badEmnlpReceipt;
    badEmnlpReceipt.receiptSha256 = acqExt.stableHash(badEmnlpCore);
    fs.writeFileSync(emnlpReceiptFile, Buffer.from(`${JSON.stringify(badEmnlpReceipt, null, 2)}\n`), { mode: 0o600 });
    assert.throws(() => acqExt.replayCatalog('emnlp-2026', emnlpDir), /多卷 HTML 目录必须绑定全部/);

    // 2. Multi-volume AACL 2026 (3 volumes)
    const aaclDir = path.join(tmpRoot, 'aacl-2026');
    const aaclCat = await acqExt.acquireCatalog({ providerId: 'aacl-2026', outputRoot: aaclDir, apply: true }, {
        fetch: async url => {
            if (url === 'https://aclanthology.org/volumes/2026.aacl-long/') {
                return makeResponse(200, makeAclDivEntry('2026.aacl-long.5', 'Spoken Long Paper', ['Dan Kim'], 'Long abs.'));
            }
            if (url === 'https://aclanthology.org/volumes/2026.aacl-short/') {
                return makeResponse(200, makeAclDivEntry('2026.aacl-short.3', 'Spoken Short Paper', ['Eva Park'], 'Short abs.'));
            }
            if (url === 'https://aclanthology.org/volumes/2026.findings-aacl/') {
                return makeResponse(200, makeAclDivEntry('2026.findings-aacl.9', 'Audio Findings Paper', ['Fay Zhou'], 'Findings abs.'));
            }
            return makeResponse(404, 'missing');
        }
    });
    assert.equal(aaclCat.papers, 3);
    const aaclReplayed = acqExt.replayCatalog('aacl-2026', aaclDir);
    assertAllPapersMeetIdentityContract(aaclReplayed.metadata.papers);
    assert.deepEqual(aaclReplayed.metadata.papers.map(p => p.track), [
        'AACL 2026 Long', 'AACL 2026 Short', 'Findings of AACL 2026'
    ]);

    // 3. Single-volume ACL 2026 conferences/workshops
    for (const [providerId, paperId, expectedTrack] of [
        ['sigdial-2026', '2026.sigdial-1.4', 'SIGDIAL 2026'],
        ['iwsds-2026', '2026.iwsds-1.2', 'IWSDS 2026'],
        ['sigul-2026', '2026.sigul-1.7', 'SIGUL 2026'],
        ['speakable-2026', '2026.speakable-1.1', 'SPEAKABLE 2026'],
        ['salma-2026', '2026.salma-1.8', 'SALMA 2026'],
        ['impactspeech-2026', '2026.impactspeech-1.3', 'ImpactSpeech 2026'],
        ['nlp4musa-2026', '2026.nlp4musa-1.6', 'NLP4MusA 2026'],
        ['trustaudio-2026', '2026.trustaudio-1.9', 'TrustAudio 2026'],
        ['lrec-2026', '2026.lrec-1.11', 'LREC 2026 Main'],
        ['conll-2026', '2026.conll-main.2', 'CoNLL 2026'],
        ['starsem-2026', '2026.starsem-conference.5', '*SEM 2026']
    ]) {
        const prov = acqExt.providerFor(providerId);
        const parsed = acqExt.parseEmnlpCatalogHtml(
            makeAclDivEntry(paperId, `${providerId} Audio Study`, ['Test Author'], 'Abstract.'),
            prov
        );
        assert.equal(parsed.papers.length, 1, providerId);
        assert.equal(parsed.papers[0].track, expectedTrack);
        assertAllPapersMeetIdentityContract(parsed.papers);
    }
});

test('isca-html parses avsp/mlcslm/wochat/dc 2026 and skips Keynote w3-card (traum26_wochat.html)', async t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-isca-');
    const wochatHtml = `
      <nav><a href="../index.html">Archive Home</a><a href="index.html">TOC</a></nav>
      <div class="w3-card">
        <h4>Keynote: Embodied Conversational Agents</h4>
        <a class="w3-text" href="traum26_wochat.html">
          <p>Dialogue Agents in the Wild<br><span class="w3-text-theme">David Traum</span></p>
        </a>
      </div>
      <div class="w3-card">
        <h4>Session 1: Multimodal Chatbots</h4>
        <a class="w3-text" href="smith26_wochat.html">
          <p>Turn-Taking Prediction in Spoken Dialogue<br><span class="w3-text-theme">Alice Smith, Bob Jones and Carol Lee</span></p>
        </a>
        <a class="w3-text" href="tanaka26_wochat.html">
          <p>Expressive Backchannel Generation<br><span class="w3-text-theme">Kenji Tanaka; Yuki Mori</span></p>
        </a>
      </div>
    `;
    const provider = acqExt.providerFor('wochat-2026');
    const parsed = acqExt.parseIscaCatalogHtml(wochatHtml, provider);
    assert.equal(parsed.papers.length, 2);
    assertAllPapersMeetIdentityContract(parsed.papers);
    assert.equal(parsed.papers.some(p => p.id === 'traum26_wochat'), false);
    assert.deepEqual(parsed.papers[0].authors, ['Alice Smith', 'Bob Jones', 'Carol Lee']);
    assert.equal(parsed.papers[0].pdfUrl, 'https://www.isca-archive.org/wochat_2026/smith26_wochat.pdf');
    assert.equal(parsed.papers[0].track, 'Session 1: Multimodal Chatbots');
    assert.deepEqual(parsed.papers[1].authors, ['Kenji Tanaka', 'Yuki Mori']);

    const wochatDir = path.join(tmpRoot, 'wochat-2026');
    const catRes = await acqExt.acquireCatalog({ providerId: 'wochat-2026', outputRoot: wochatDir, apply: true }, {
        fetch: async () => makeResponse(200, wochatHtml)
    });
    assert.equal(catRes.papers, 2);
    assert.equal(acqExt.replayCatalog('wochat-2026', wochatDir).metadata.papers.length, 2);
});

test('pmlr-html parses Audio-AAAI 2026 (PMLR v312) with raw.githubusercontent.com PDFs and enforces strict PDF identity', async t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-pmlr-');
    const pmlrHtml = `
      <div class="paper">
        <p class="title">Neural Acoustic Fields for Spatial Audio Reasoning</p>
        <p class="details">
          <span class="authors">Wei&nbsp;Zhang,&nbsp;Priya&nbsp;Patel</span>
        </p>
        <p class="links">
          [<a href="https://proceedings.mlr.press/v312/zhang26a.html">abs</a>]
          [<a href="https://raw.githubusercontent.com/mlresearch/v312/main/assets/zhang26a/zhang26a.pdf">Download PDF</a>]
        </p>
      </div>
      <div class="paper">
        <p class="title">Self-Supervised Audio Codec Distillation</p>
        <p class="details"><span class="authors">Hannah&nbsp;Kim</span></p>
        <p class="links">
          [<a href="/v312/kim26b.html">abs</a>]
          [<a href="/v312/kim26b/kim26b.pdf">Download PDF</a>]
        </p>
      </div>
    `;
    const provider = acqExt.providerFor('audio-aaai-2026');
    const parsed = acqExt.parsePmlrCatalogHtml(pmlrHtml, provider);
    assert.equal(parsed.papers.length, 2);
    assertAllPapersMeetIdentityContract(parsed.papers);
    const zhang = parsed.papers.find(p => p.id === 'zhang26a');
    assert.deepEqual(zhang.authors, ['Wei Zhang', 'Priya Patel']);
    assert.equal(zhang.recordUrl, 'https://proceedings.mlr.press/v312/zhang26a.html');
    assert.equal(zhang.pdfUrl, 'https://raw.githubusercontent.com/mlresearch/v312/main/assets/zhang26a/zhang26a.pdf');

    // Host/path security checks
    assert.throws(
        () => acqExt.validateUrlForProvider(provider, 'https://raw.githubusercontent.com/v312/zhang26a.html', 'record'),
        /主机不在白名单中/
    );
    assert.throws(
        () => acqExt.validateUrlForProvider(provider, 'https://raw.githubusercontent.com/otherorg/v312/main/assets/zhang26a/zhang26a.pdf', 'pdf'),
        /路径不符合白名单/
    );
    assert.throws(
        () => acqExt.parsePmlrCatalogHtml(`
          <div class="paper">
            <p class="title">Mismatched PDF</p>
            <span class="authors">A. Author</span>
            <a href="https://proceedings.mlr.press/v312/foo26a.html">abs</a>
            <a href="https://raw.githubusercontent.com/mlresearch/v312/main/assets/bar26b/bar26b.pdf">pdf</a>
          </div>
        `, provider),
        /缺少绑定身份的官方 PDF/
    );

    const pmlrDir = path.join(tmpRoot, 'audio-aaai-2026');
    const deps = {
        fetch: async url => {
            if (url === provider.indexUrl) return makeResponse(200, pmlrHtml);
            if (url.endsWith('.pdf')) return makeResponse(200, SAMPLE_PDF, 'application/pdf');
            return makeResponse(404, 'missing');
        }
    };
    const catRes = await acqExt.acquireCatalog({ providerId: 'audio-aaai-2026', outputRoot: pmlrDir, apply: true }, deps);
    assert.equal(catRes.papers, 2);
    const dlRes = await acqExt.downloadPapers({ providerId: 'audio-aaai-2026', outputRoot: pmlrDir, apply: true }, deps);
    assert.equal(dlRes.complete, true);
    assert.equal(acqExt.verifyAcquisition({ providerId: 'audio-aaai-2026', outputRoot: pmlrDir }).complete, true);
});

test('eccv-virtual-json acquires responses/index.json, validates dual-host URLs, and integrates with discovery', async t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-eccv-');
    const provider = acqExt.providerFor('eccv-2026');
    const eccvPayload = {
        count: 2,
        results: [
            {
                id: 4102,
                name: 'Audio-Visual 4D Scene Reconstruction',
                authors: [{ fullname: 'Liam Chen' }, { fullname: 'Sofia Rossi' }],
                virtualsite_url: '/virtual/2026/oral/4102',
                paper_pdf_url: 'https://media.eventhosts.cc/Conferences/ECCV2026/pdfs/4102.pdf',
                abstract: 'We fuse binaural audio &amp; multi-view video.',
                decision: 'Oral',
                eventtype: 'Oral'
            },
            {
                id: 5890,
                name: 'Lip-Synced Video Synthesis from Whisper Features',
                authors: ['Nora Patel'],
                virtualsite_url: 'https://eccv.ecva.net/virtual/2026/poster/5890',
                paper_pdf_url: 'https://media.eventhosts.cc/Conferences/ECCV2026/pdfs/5890.pdf',
                abstract: 'High-fidelity audio-driven talking heads.',
                decision: '',
                eventtype: 'Poster'
            }
        ]
    };

    const eccvDir = path.join(tmpRoot, 'eccv-2026');
    let capturedAccept = null;
    const deps = {
        fetch: async (url, init) => {
            if (url === provider.indexUrl) {
                capturedAccept = init?.headers?.Accept;
                return makeResponse(200, eccvPayload, 'application/json; charset=utf-8');
            }
            if (url.startsWith('https://media.eventhosts.cc/Conferences/ECCV2026/pdfs/')) {
                return makeResponse(200, SAMPLE_PDF, 'application/pdf');
            }
            return makeResponse(404, {}, 'application/json');
        }
    };

    const catRes = await acqExt.acquireCatalog({ providerId: 'eccv-2026', outputRoot: eccvDir, apply: true }, deps);
    assert.equal(catRes.papers, 2);
    assert.equal(capturedAccept, 'application/json');
    assert.ok(fs.existsSync(path.join(eccvDir, 'responses/index.json')));
    const replayed = acqExt.replayCatalog('eccv-2026', eccvDir);
    assertAllPapersMeetIdentityContract(replayed.metadata.papers);
    assert.equal(replayed.metadata.papers[0].id, 'eccv2026-4102');
    assert.equal(replayed.metadata.papers[0].abstract, 'We fuse binaural audio & multi-view video.');
    assert.equal(replayed.metadata.papers[0].track, 'Oral');
    assert.equal(replayed.metadata.papers[1].track, 'Poster');

    const dlRes = await acqExt.downloadPapers({ providerId: 'eccv-2026', outputRoot: eccvDir, apply: true }, deps);
    assert.equal(dlRes.complete, true);
    const disc = discovery.discoverConference({
        adapter: 'official-proceedings',
        year: 2026,
        conferenceId: 'eccv-2026',
        metadataFile: path.join(eccvDir, 'metadata.json'),
        pdfRoot: eccvDir,
        acquisitionRoot: eccvDir
    });
    assert.equal(disc.manifest.members.length, 2);

    // Security: wrong PDF host MUST fail closed
    assert.throws(
        () => acqExt.parseEccvVirtualJson({
            results: [{
                id: 99,
                name: 'Evil Host',
                authors: ['A'],
                virtualsite_url: '/virtual/2026/poster/99',
                paper_pdf_url: 'https://eccv.ecva.net/Conferences/ECCV2026/pdfs/99.pdf'
            }]
        }, provider),
        /主机不在白名单中/
    );
});

test('cvf-html parses WACV 2026 authsearch forms, fallback PDF URL, and strict ?day=all query equality', async t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-wacv-');
    const provider = acqExt.providerFor('wacv-2026');
    assert.equal(
        acqExt.validateUrlForProvider(provider, 'https://openaccess.thecvf.com/WACV2026?day=all', 'index'),
        'https://openaccess.thecvf.com/WACV2026?day=all'
    );
    assert.throws(
        () => acqExt.validateUrlForProvider(provider, 'https://openaccess.thecvf.com/WACV2026?day=2026-03-01', 'index'),
        /严格等于固定入口/
    );

    const wacvHtml = `
      <dl>
        <dt class="ptitle"><br><a href="/content/WACV2026/html/Han_AudioVisual_Tracking_WACV_2026_paper.html">Audio-Visual Object Tracking in Crowded Scenes</a></dt>
        <dd>
          <form action="/WACV2026" method="post" class="authsearch"><input type="hidden" name="query_author" value="Ke Han"><a href="#">Ke Han</a>,</form>
          <form action="/WACV2026" method="post" class="authsearch"><input type="hidden" name="query_author" value="Mei Lin"><a href="#">Mei Lin</a></form>
        </dd>
        <dd>
          [<a href="/content/WACV2026/papers/Han_AudioVisual_Tracking_WACV_2026_paper.pdf">pdf</a>]
        </dd>
        <dt class="ptitle"><br><a href="/content/WACV2026/html/Zhou_Foley_2.5D_WACV_2026_paper.html">2.5D Foley Synthesis from Video</a></dt>
        <dd>Hao Zhou, Sara Ali<br>[<a href="/content/WACV2026/supplemental/Zhou_supp.zip">supp</a>]</dd>
      </dl>
    `;
    const parsed = acqExt.parseCvfCatalogHtml(wacvHtml, provider);
    assert.equal(parsed.papers.length, 2);
    assertAllPapersMeetIdentityContract(parsed.papers);
    const han = parsed.papers.find(p => p.id === 'Han_AudioVisual_Tracking_WACV_2026_paper');
    assert.deepEqual(han.authors, ['Ke Han', 'Mei Lin']);
    assert.equal(han.pdfUrl, 'https://openaccess.thecvf.com/content/WACV2026/papers/Han_AudioVisual_Tracking_WACV_2026_paper.pdf');
    const zhou = parsed.papers.find(p => p.id === 'Zhou_Foley_2.5D_WACV_2026_paper');
    assert.deepEqual(zhou.authors, ['Hao Zhou', 'Sara Ali']);
    assert.equal(zhou.pdfUrl, 'https://openaccess.thecvf.com/content/WACV2026/papers/Zhou_Foley_2.5D_WACV_2026_paper.pdf');

    const wacvDir = path.join(tmpRoot, 'wacv-2026');
    const catRes = await acqExt.acquireCatalog({ providerId: 'wacv-2026', outputRoot: wacvDir, apply: true }, {
        fetch: async () => makeResponse(200, wacvHtml)
    });
    assert.equal(catRes.papers, 2);
    assert.equal(acqExt.replayCatalog('wacv-2026', wacvDir).metadata.papers.length, 2);
});

test('ijcai-html parses IJCAI 2026 rows, tracks, DOIs, and skips frontmatter rows without PDFs', async t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-ijcai-');
    const provider = acqExt.providerFor('ijcai-2026');
    const ijcaiHtml = `
      <div class="section">
        <h2>Main Track</h2>
        <div class="subsection">
          <h3>Speech and Audio</h3>
          <div class="paper_wrapper paper-row">
            <a class="title" href="/proceedings/2026/0">Preface</a>
            <div class="authors">Program Chairs</div>
          </div>
          <div class="paper_wrapper paper-row">
            <a class="title" href="/proceedings/2026/42">Zero-Shot Voice Conversion with Flow Matching</a>
            <div class="authors"><a href="#">Lin Wei</a>, <a href="#">Omar Hassan</a></div>
            <div class="paper-row__actions">
              <a href="/proceedings/2026/0042.pdf">PDF</a>
              <a href="https://doi.org/10.24963/ijcai.2026/42">DOI</a>
            </div>
          </div>
        </div>
      </div>
    `;
    const parsed = acqExt.parseIjcaiCatalogHtml(ijcaiHtml, provider);
    assert.equal(parsed.papers.length, 1);
    assertAllPapersMeetIdentityContract(parsed.papers);
    assert.equal(parsed.papers[0].id, 'ijcai2026-0042');
    assert.equal(parsed.papers[0].recordUrl, 'https://ijcai.org/proceedings/2026/42');
    assert.equal(parsed.papers[0].pdfUrl, 'https://ijcai.org/proceedings/2026/0042.pdf');
    assert.equal(parsed.papers[0].doi, '10.24963/ijcai.2026/42');
    assert.equal(parsed.papers[0].track, 'Speech and Audio');
    assert.deepEqual(parsed.papers[0].authors, ['Lin Wei', 'Omar Hassan']);

    const ijcaiDir = path.join(tmpRoot, 'ijcai-2026');
    const catRes = await acqExt.acquireCatalog({ providerId: 'ijcai-2026', outputRoot: ijcaiDir, apply: true }, {
        fetch: async () => makeResponse(200, ijcaiHtml)
    });
    assert.equal(catRes.papers, 1);
    assert.equal(acqExt.replayCatalog('ijcai-2026', ijcaiDir).metadata.papers.length, 1);
});

test('conference-filter resolves all 14 new vertical 2026 families, preserves prior policy SHAs (CI + local + dynamic), and validates request envelopes for smc-2026 & audio-aaai-2026', t => {
    const PRIOR_CI_POLICY_SHA = 'd5dc1c860ac7ca5d94ab187153f0cf1259da546662e6b5476c6f0c494b075f1b';
    const PRIOR_LOCAL_POLICY_SHA = 'bf7194bce90917fb2df5e04f8c4b4fa7de35814c1be539304f7cf4267c9049fb';
    for (const priorSha of [
        PRIOR_CI_POLICY_SHA,
        PRIOR_LOCAL_POLICY_SHA,
        filter.PRIOR_2026_VERTICAL_FAMILY_FILTER_POLICY_SHA256
    ]) {
        assert.match(priorSha, /^[a-f0-9]{64}$/);
        assert.ok(filter.LEGACY_FILTER_POLICY_SHA256_LIST.includes(priorSha), `missing from LEGACY_FILTER_POLICY_SHA256_LIST: ${priorSha}`);
        assert.equal(filter.ACCEPTED_FILTER_POLICY_SHA256.has(priorSha), true, `missing from ACCEPTED_FILTER_POLICY_SHA256: ${priorSha}`);
        assert.notEqual(filter.LLM_FILTER_POLICY_SHA256, priorSha);
    }

    // Existing CORE_AUDIO_CONFERENCE_IDS remains byte-for-byte unchanged
    assert.deepEqual(filter.CORE_AUDIO_CONFERENCE_IDS, [
        'asru-2025', 'chime-2026', 'dafx-2026', 'dcase-2026', 'icmc-2026', 'interspeech-2026',
        'ismir-2026', 'iwslt-2026', 'jep-2026', 'nime-2026', 'odyssey-2026', 'speechprosody-2026',
        'waspaa-2025'
    ]);

    const expectedNewFamilies = [
        ['smc-2026', 'Sound and Music Computing'],
        ['avsp-2026', 'Auditory-Visual Speech Processing'],
        ['mlcslm-2026', 'Multilingual Conversational Speech Language Model'],
        ['wochat-2026', 'Workshop on Chatbots and Agentic Technologies (ISCA)'],
        ['dc-2026', 'ISCA Doctoral Consortium'],
        ['sigdial-2026', 'SIGDIAL Discourse and Dialogue'],
        ['iwsds-2026', 'Spoken Dialogue Systems Technology'],
        ['sigul-2026', 'Under-resourced Languages and Speech'],
        ['speakable-2026', 'Speech Language Models in Low-Resource Settings'],
        ['salma-2026', 'Speech and Audio Language Models'],
        ['impactspeech-2026', 'Impact of Speech Technology'],
        ['nlp4musa-2026', 'NLP for Music and Audio'],
        ['trustaudio-2026', 'Trustworthy Speech and Audio AI'],
        ['audio-aaai-2026', 'Audio-Centric AI (Audio-AAAI)'],
        ['audio-aaai-2027', 'Audio-Centric AI (Audio-AAAI)']
    ];
    for (const [conferenceId, expectedLabel] of expectedNewFamilies) {
        assert.equal(filter.resolveCoreAudioConferenceLabel(conferenceId), expectedLabel, conferenceId);
        assert.equal(filter.isCoreAudioConference(conferenceId), true, conferenceId);
        const evalRes = filter.evaluateConferenceKeywordPrefilter(
            { title: 'Generic Optimization Study', abstract: 'We study general optimization with convergence bounds and ablation studies across benchmarks.' },
            conferenceId
        );
        assert.equal(evalRes.pass, true, conferenceId);
        assert.equal(evalRes.conferenceCategoryFallback, true, conferenceId);
        assert.equal(evalRes.conferenceCategoryLabel, expectedLabel, conferenceId);
    }
    // Pre-2025 or general AI conferences do NOT get core audio fallback
    assert.equal(filter.resolveCoreAudioConferenceLabel('smc-2024'), null);
    assert.equal(filter.resolveCoreAudioConferenceLabel('audio-aaai-2024'), null);
    assert.equal(filter.resolveCoreAudioConferenceLabel('eccv-2026'), null);
    assert.equal(filter.resolveCoreAudioConferenceLabel('wacv-2026'), null);
    assert.equal(filter.resolveCoreAudioConferenceLabel('ijcai-2026'), null);

    // Full prepareFilter -> requestEnvelope -> normalizeRequestEnvelope roundtrip for smc-2026 and audio-aaai-2026
    for (const [conferenceId, expectedLabel, paperSpec] of [
        [
            'smc-2026',
            'Sound and Music Computing',
            {
                id: 'zenodo-19900001',
                title: 'Generic Mathematical Model of Vibrating Plates',
                authors: ['Elena Rossi'],
                abstract: 'We study a general finite difference scheme with stability bounds across numerical benchmarks and mathematical settings.',
                pdfFile: 'pdfs/zenodo-19900001.pdf',
                recordUrl: 'https://zenodo.org/records/19900001',
                pdfUrl: 'https://zenodo.org/api/records/19900001/files/paper.pdf/content',
                doi: '10.5281/zenodo.19900001',
                track: 'SMC 2026'
            }
        ],
        [
            'audio-aaai-2026',
            'Audio-Centric AI (Audio-AAAI)',
            {
                id: 'zhang26a',
                title: 'Generic Benchmark Evaluation Protocol',
                authors: ['Wei Zhang'],
                abstract: 'We present a general benchmark design with controlled experiments, quantitative comparisons, and ablation studies.',
                pdfFile: 'pdfs/zhang26a.pdf',
                recordUrl: 'https://proceedings.mlr.press/v312/zhang26a.html',
                pdfUrl: 'https://raw.githubusercontent.com/mlresearch/v312/main/assets/zhang26a/zhang26a.pdf',
                doi: null,
                track: 'Audio-AAAI 2026'
            }
        ]
    ]) {
        const root = makeTmpDir(t, `conf-filter-${conferenceId}-`);
        for (const name of ['filters', 'catalogs', 'reports', 'pdf', 'evidence']) {
            fs.mkdirSync(path.join(root, name), { mode: 0o700 });
        }
        const metadataFile = path.join(root, 'metadata.json');
        fs.writeFileSync(metadataFile, JSON.stringify({ conference: { id: conferenceId, year: 2026 }, papers: [paperSpec] }), { mode: 0o600 });
        const pdfPath = path.join(root, 'pdf', ...paperSpec.pdfFile.split('/'));
        fs.mkdirSync(path.dirname(pdfPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(pdfPath, SAMPLE_PDF, { mode: 0o600 });

        const found = discovery.discoverConference({
            adapter: 'official-proceedings',
            conferenceId,
            year: 2026,
            metadataFile,
            pdfRoot: path.join(root, 'pdf')
        });
        const catalogFile = path.join(root, 'catalogs', 'conference.json');
        const reportFile = path.join(root, 'reports', 'conference.json');
        fs.writeFileSync(catalogFile, discovery.canonicalBytes(found.manifest), { mode: 0o600 });
        fs.writeFileSync(reportFile, discovery.canonicalBytes(found.report), { mode: 0o600 });
        const discoveryHandle = discovery.loadDiscoveryHandle(catalogFile, reportFile);

        const evidenceRunId = '55555555-5555-4555-8555-555555555555';
        const stamp = '2026-11-28T00:00:00.000Z';
        evidenceApi.prepareEvidence({
            evidenceRunsRoot: path.join(root, 'evidence'),
            runId: evidenceRunId,
            discoveryHandle,
            apply: true,
            limit: 1,
            now: stamp,
            extract: (itemRoot, { request, replay }) => {
                const text = Buffer.from(`Abstract\n${replay.metadataRecord.abstract}\n1 Introduction\nBody.`);
                const artifacts = Buffer.from(`${JSON.stringify({ pages: [{ page: 1, textStart: 0, textEnd: text.length }] }, null, 2)}\n`);
                const receipt = Buffer.from('{"fixture":true}\n');
                fs.writeFileSync(path.join(itemRoot, 'text.txt'), text);
                fs.writeFileSync(path.join(itemRoot, 'artifacts.json'), artifacts);
                fs.writeFileSync(path.join(itemRoot, 'extraction-receipt.json'), receipt);
                return {
                    paperId: request.paperId,
                    sourceIdentity: request.sourceIdentity,
                    pdf: { sha256: request.source.pdf.sha256 },
                    text: { file: 'text.txt', sha256: sha(text) },
                    artifacts: { file: 'artifacts.json', sha256: sha(artifacts) },
                    receipt: { file: 'extraction-receipt.json', fileSha256: sha(receipt), receiptSha256: 'a'.repeat(64) },
                    verification: { verificationSha256: 'b'.repeat(64) }
                };
            }
        });
        const evidenceHandle = evidenceApi.loadEvidenceHandle({
            evidenceRunsRoot: path.join(root, 'evidence'),
            runId: evidenceRunId,
            discoveryHandle
        });
        const boundSpec = filter.buildProductionSpec({
            endpoint: 'https://example.test/v1',
            model: 'muse-spark-1.3-contributor',
            tagCatalogSha256: sha('tag-catalog'),
            discoveryHandle,
            evidenceHandle
        });
        const filterId = '11111111-1111-4111-8111-111111111111';
        const state = filter.prepareFilter({
            filterRoot: path.join(root, 'filters'),
            discoveryHandle,
            evidenceHandle,
            spec: boundSpec,
            filterId,
            now: stamp
        });
        const paperId = Object.keys(state.decisions)[0];
        // Core audio fallback keeps the paper pending for LLM instead of keyword-excluding it!
        assert.equal(state.decisions[paperId].status, 'pending', conferenceId);

        const envelope = filter.requestEnvelope({ state, paperId, discoveryHandle, evidenceHandle });
        assert.equal(envelope.filter.conferenceCategoryLabel, expectedLabel);
        const normalized = filter.normalizeRequestEnvelope(envelope);
        assert.equal(normalized.filter.conferenceCategoryLabel, expectedLabel);

        // Tampering conferenceCategoryLabel to null MUST fail normalizeRequestEnvelope!
        const tampered = structuredClone(envelope);
        tampered.filter.conferenceCategoryLabel = null;
        delete tampered.requestSha256;
        tampered.requestSha256 = filter.stableHash(tampered);
        assert.throws(() => filter.normalizeRequestEnvelope(tampered), /会议类别回退映射已变化/);
    }
});

test('adversarial hardening: cross-volume redirects, Zenodo query/backfill/0-author, ISCA nav links, IJCAI external/PDF-title, ACL nested wrappers, encoded traversal', async t => {
    const tmpRoot = makeTmpDir(t, 'conf-2026-hardening-');

    // [HIGH-2] Forged cross-volume redirect (vol-001 -> vol-002) MUST fail in BOTH fetchOfficialExtended and replayCatalog
    const emnlp = acqExt.providerFor('emnlp-2026');
    const vol1Url = emnlp.indexUrls[0];
    const vol2Url = emnlp.indexUrls[1];
    await assert.rejects(
        () => acqExt.fetchOfficialExtended({
            provider: emnlp,
            url: vol1Url,
            kind: 'index',
            maxBytes: acqExt.MAX_INDEX_BYTES
        }, {
            fetch: async () => ({
                status: 302,
                headers: { get: k => k.toLowerCase() === 'location' ? vol2Url : null },
                body: { async cancel() {} }
            })
        }),
        /重定向偏离固定入口/
    );

    const emnlpTamperDir = path.join(tmpRoot, 'emnlp-cross-vol');
    const vol1Html = `<div class="d-sm-flex"><span class="d-block"><strong><a class="align-middle" href="/2026.emnlp-main.1/">Main Paper</a></strong><br><a href="/people/a/">Alice</a></span></div>`;
    const vol2Html = `<div class="d-sm-flex"><span class="d-block"><strong><a class="align-middle" href="/2026.findings-emnlp.1/">Findings Paper</a></strong><br><a href="/people/b/">Bob</a></span></div>`;
    await acqExt.acquireCatalog({ providerId: 'emnlp-2026', outputRoot: emnlpTamperDir, apply: true }, {
        fetch: async url => makeResponse(200, url === vol1Url ? vol1Html : vol2Html)
    });
    const receiptFile = path.join(emnlpTamperDir, 'catalog.receipt.json');
    const tamperedReceipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    tamperedReceipt.responses[0].redirects = [{ status: 302, from: vol1Url, to: vol2Url }];
    tamperedReceipt.responses[0].finalUrl = vol2Url;
    const { receiptSha256: _old, ...tamperedCore } = tamperedReceipt;
    tamperedReceipt.receiptSha256 = acqExt.stableHash(tamperedCore);
    fs.writeFileSync(receiptFile, Buffer.from(`${JSON.stringify(tamperedReceipt, null, 2)}\n`), { mode: 0o600 });
    assert.throws(() => acqExt.replayCatalog('emnlp-2026', emnlpTamperDir), /重定向偏离固定入口/);

    // [MEDIUM-1 & LOW-1] Zenodo api query param whitelist + recordPath
    const smc = acqExt.providerFor('smc-2026');
    assert.equal(acqExt.validateUrlForProvider(smc, 'https://zenodo.org/records/19900001', 'record'), 'https://zenodo.org/records/19900001');
    assert.throws(() => acqExt.validateUrlForProvider(smc, 'https://zenodo.org/other/19900001', 'record'), /record 路径不符合白名单/);
    for (const badApiUrl of [
        'https://zenodo.org/api/records?communities=smc&sort=bestmatch',
        'https://zenodo.org/api/records?communities=smc&communities=ismir&sort=mostrecent',
        'https://zenodo.org/api/records?communities=smc&q=audio&sort=mostrecent',
        'https://zenodo.org/api/records?communities=smc&type=poster&sort=mostrecent',
        'https://zenodo.org/api/records?communities=smc&all_versions=1&sort=mostrecent'
    ]) {
        assert.throws(() => acqExt.validateUrlForProvider(smc, badApiUrl, 'api'), /查询参数|排序参数|社区参数/, badApiUrl);
    }

    // [MEDIUM-2] Zenodo stopBeforeYear does NOT prematurely stop on 2026-uploaded backfill of older papers
    const backfilledPage = {
        hits: {
            hits: [{
                id: 20001,
                created: '2026-08-15T10:00:00+00:00',
                metadata: { publication_date: '2024-07-04', title: 'Backfilled 2024 SMC Paper', creators: [{ name: 'A' }] }
            }]
        },
        links: { next: 'https://zenodo.org/api/records?communities=smc&page=2&size=25&sort=mostrecent' }
    };
    assert.equal(acqExt.shouldStopZenodoPagination(backfilledPage, smc), false);
    const genuinelyOlderPage = {
        hits: {
            hits: [{
                id: 20002,
                created: '2025-07-10T10:00:00+00:00',
                metadata: { publication_date: '2025-07-04', title: 'Real 2025 SMC Paper', creators: [{ name: 'B' }] }
            }]
        },
        links: { next: 'https://zenodo.org/api/records?communities=smc&page=3&size=25&sort=mostrecent' }
    };
    assert.equal(acqExt.shouldStopZenodoPagination(genuinelyOlderPage, smc), true);
    // Mixed created presence (one hit missing created) MUST NOT trigger early stop
    const mixedCreatedPage = {
        hits: {
            hits: [
                { id: 20003, created: '2025-07-10T10:00:00+00:00', metadata: { publication_date: '2025-07-04' } },
                { id: 20004, metadata: { publication_date: '2025-07-03' } }
            ]
        }
    };
    assert.equal(acqExt.shouldStopZenodoPagination(mixedCreatedPage, smc), false);

    // [LOW-2 & LOW-3] Encoded path traversal rejection, DCASE apostrophe surname, Zenodo 0-creator skip & bad PDF fallback
    const dcase = acqExt.providerFor('dcase-2026');
    assert.throws(
        () => acqExt.validateUrlForProvider(dcase, 'https://dcase.community/documents/workshop2026/proceedings/DCASE2026Workshop_%2e%2e_12.pdf', 'pdf'),
        /目录穿越/
    );
    assert.throws(
        () => acqExt.validateUrlForProvider(dcase, 'https://dcase.community/documents/workshop2026/proceedings/DCASE2026Workshop_a%2fb_12.pdf', 'pdf'),
        /目录穿越/
    );
    const dcaseApostropheHtml = `
      <div class="row">
        <h4><strong>Spatial Audio Tagging</strong></h4>
        <p><em>Conor O'Brien (Trinity College)</em></p>
        <a href="/documents/workshop2026/proceedings/DCASE2026Workshop_O'Brien_12.pdf">PDF</a>
      </div>
    `;
    const dcaseParsed = acqExt.parseDcaseProceedingsHtml(dcaseApostropheHtml, dcase);
    assert.equal(dcaseParsed.papers[0].id, 'dcase2026-12');
    assert.equal(dcaseParsed.papers[0].pdfUrl, "https://dcase.community/documents/workshop2026/proceedings/DCASE2026Workshop_O'Brien_12.pdf");

    const zenodoHardened = acqExt.parseZenodoRecordsPages([{
        hits: {
            hits: [
                {
                    id: 30001,
                    metadata: { title: 'SMC 2026 Cover Metadata Only', publication_date: '2026-07-01', creators: [] },
                    files: []
                },
                {
                    id: 30002,
                    metadata: { title: 'Valid Paper With Traversal PDF', publication_date: '2026-07-01', creators: [{ name: 'Real Author' }] },
                    files: [{ key: '..bad.pdf', links: { self: 'https://zenodo.org/api/records/30002/files/%2e%2ebad.pdf/content' } }]
                }
            ]
        }
    }], smc);
    assert.equal(zenodoHardened.papers.length, 1);
    assert.equal(zenodoHardened.papers[0].id, 'zenodo-30002');
    assert.equal(zenodoHardened.papers[0].pdfUrl, null);
    assert.equal(zenodoHardened.papers[0].pdfFile, null);

    // [MEDIUM-3] ISCA skips nav/header/footer auxiliary links and authorless card links
    const avsp = acqExt.providerFor('avsp-2026');
    const iscaNavHtml = `
      <header><a href="author_index.html">Authors</a></header>
      <nav><a href="committees.html">Committees</a><a href="about_avsp.html">About</a></nav>
      <div class="w3-card">
        <h4>Committee & Links</h4>
        <a href="program_overview.html">Program Overview</a>
      </div>
      <div class="w3-card">
        <h4>Session 1</h4>
        <a class="w3-text" href="lee26_avsp.html"><p>Audio-Visual Lip Reading<br><span class="w3-text-theme">Min Lee, Alex Cho</span></p></a>
      </div>
    `;
    const iscaParsed = acqExt.parseIscaCatalogHtml(iscaNavHtml, avsp);
    assert.equal(iscaParsed.papers.length, 1);
    assert.equal(iscaParsed.papers[0].id, 'lee26_avsp');

    // [MEDIUM-4] IJCAI ignores external .pdf links before official PDF and handles PDF-linked title
    const ijcai = acqExt.providerFor('ijcai-2026');
    const ijcaiHardenedHtml = `
      <div class="section">
        <h2>Audio Track</h2>
        <div class="paper_wrapper paper-row">
          <a class="title" href="/proceedings/2026/0077.pdf">Neural Vocoder Acceleration</a>
          <div class="authors">Chen Li, Dana Kim</div>
          <div class="paper-row__actions">
            <a href="https://arxiv.org/pdf/2601.00077.pdf">arXiv PDF</a>
            <a href="/proceedings/2026/77">Details</a>
            <a href="/proceedings/2026/0077.pdf">Official PDF</a>
          </div>
        </div>
      </div>
    `;
    const ijcaiHardened = acqExt.parseIjcaiCatalogHtml(ijcaiHardenedHtml, ijcai);
    assert.equal(ijcaiHardened.papers.length, 1);
    assert.equal(ijcaiHardened.papers[0].id, 'ijcai2026-0077');
    assert.equal(ijcaiHardened.papers[0].title, 'Neural Vocoder Acceleration');
    assert.equal(ijcaiHardened.papers[0].recordUrl, 'https://ijcai.org/proceedings/2026/77');
    assert.equal(ijcaiHardened.papers[0].pdfUrl, 'https://ijcai.org/proceedings/2026/0077.pdf');

    // [LOW-4] ACL skips outer wrapper .d-sm-flex and off-host/query/hash links
    const aclNestedHtml = `
      <div class="d-sm-flex outer-wrapper">
        <div class="d-sm-flex">
          <span class="d-block">
            <strong><a class="align-middle" href="https://evil.example/2026.emnlp-main.99/">Off-Host Paper</a></strong>
            <a href="/people/evil/">Evil Author</a>
          </span>
        </div>
        <div class="d-sm-flex">
          <span class="d-block">
            <strong><a class="align-middle" href="/2026.emnlp-main.10/?foo=1">Query Paper</a></strong>
            <a href="/people/q/">Query Author</a>
          </span>
        </div>
        <div class="d-sm-flex">
          <span class="d-block">
            <strong><a class="align-middle" href="/2026.emnlp-main.11/">Clean Paper One</a></strong><br>
            <a href="/people/a/">Alice One</a>
          </span>
        </div>
        <div class="d-sm-flex">
          <span class="d-block">
            <strong><a class="align-middle" href="/2026.emnlp-main.12/">Clean Paper Two</a></strong><br>
            <a href="/people/b/">Bob Two</a>
          </span>
        </div>
      </div>
    `;
    const aclNested = acqExt.parseEmnlpCatalogHtml(aclNestedHtml, emnlp);
    assert.equal(aclNested.papers.length, 2);
    assert.deepEqual(aclNested.papers[0].authors, ['Alice One']);
    assert.deepEqual(aclNested.papers[1].authors, ['Bob Two']);
});

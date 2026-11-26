'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const { createHostTaskScheduler } = require('../scripts/lib/fetch-scheduler.js');
const fetchPapers = require('../scripts/fetch-papers.js');
const hfPapers = require('../scripts/fetch-huggingface-papers.js');
const { KEYWORD_PREFILTER_PROFILE } = require('../scripts/lib/keyword-prefilter.js');
const dailyPrefilter = require('../scripts/lib/daily-filter-prefilter.js');
const dailyBoundary = require('../scripts/lib/daily-fetch-boundary.js');
const digestRunReport = require('../scripts/digest-run-report.js');
const analysisEngine = require('../scripts/analysis-engine.js');
const publicProbe = require('../scripts/lib/public-resource-probe.js');
const acqV2 = require('../scripts/lib/official-conference-acquisition-extended.js');
const acqCli = require('../scripts/official-conference-acquire.js');
const discovery = require('../scripts/lib/conference-discovery.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');

function makeJsonResponse(status, payload, contentType = 'application/json') {
    const buf = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    return {
        status,
        headers: {
            get(name) {
                const key = String(name).toLowerCase();
                if (key === 'content-type') return contentType;
                if (key === 'content-length') return String(buf.length);
                return null;
            }
        },
        body: { async cancel() {} },
        async arrayBuffer() {
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
    };
}

test('Track 13.1A: arXiv Atom parses comment/journalRef/doi/updated (CRLF-safe), clause-scoped venueBadge, withdrawn guards, and fetchArxivMetadataBatchByIds proxy contract', async () => {
    const richXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2611.12345v1</id>
    <published>2026-11-20T01:00:00Z</published>
    <updated>2026-11-21T02:30:00Z</updated>
    <title>StreamCodec: Low-Latency Speech Coding</title>
    <summary>We introduce a 24 kHz streaming speech codec.</summary>
    <author><name>Alice Zhang</name><arxiv:affiliation>Acoustic Lab</arxiv:affiliation></author>
    <arxiv:comment>Accepted to ICASSP 2026.\r\nCode: https://github.com/audiolab/streamcodec Demo: https://audiolab.github.io/streamcodec/</arxiv:comment>
    <arxiv:journal_ref>Proc. ICASSP 2026, pp. 1-5</arxiv:journal_ref>
    <arxiv:doi>10.1109/ICASSP.2026.123456</arxiv:doi>
    <category term="eess.AS" />
    <category term="cs.SD" />
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2611.12346v2</id>
    <published>2026-11-20T02:00:00Z</published>
    <updated>not-a-valid-date</updated>
    <title>Retracted Audio Model</title>
    <summary>This paper was withdrawn by the authors due to a benchmark leak.</summary>
    <author><name>Bob Li</name></author>
    <arxiv:comment>Withdrawn by authors.</arxiv:comment>
    <category term="eess.AS" />
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2611.12347v1</id>
    <published>2026-11-20T03:00:00Z</published>
    <title>Minimal Entry Without Optional Tags</title>
    <summary>Standard abstract text.</summary>
    <author><name>Carol Wu</name></author>
    <category term="cs.SD" />
  </entry>
</feed>`;

    const papers = fetchPapers.parseArxivXML(richXml, 'eess.AS', null, { stopAtConsecutiveExisting: false });
    assert.equal(papers.length, 3);

    const [p1, p2, p3] = papers;
    assert.equal(p1.arxivId, '2611.12345v1');
    assert.match(p1.comment, /Accepted to ICASSP 2026/);
    assert.equal(p1.comment.includes('\r'), false);
    assert.equal(p1.journalRef, 'Proc. ICASSP 2026, pp. 1-5');
    assert.equal(p1.doi, '10.1109/ICASSP.2026.123456');
    assert.equal(p1.venueBadge, 'ICASSP 2026');
    assert.equal(p1.isWithdrawn, undefined);
    assert.ok(p1.updated);
    assert.deepEqual(p1.authorAffiliations, [{ name: 'Alice Zhang', affiliations: ['Acoustic Lab'] }]);

    assert.equal(p2.isWithdrawn, true);
    assert.equal(p2.venueBadge, undefined);
    // Malformed updated timestamp is dropped rather than written verbatim
    assert.equal(p2.updated, undefined);

    // Minimal entry omits optional keys cleanly
    assert.equal(Object.prototype.hasOwnProperty.call(p3, 'comment'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(p3, 'journalRef'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(p3, 'doi'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(p3, 'venueBadge'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(p3, 'isWithdrawn'), false);

    // Venue badge positive & adversarial negative guards
    assert.equal(fetchPapers.extractVenueBadgeFromArxivMetadata({ comment: 'Submitted to NeurIPS 2026' }), '');
    assert.equal(fetchPapers.extractVenueBadgeFromArxivMetadata({ comment: 'Under review at ICLR 2026' }), '');
    assert.equal(fetchPapers.extractVenueBadgeFromArxivMetadata({ comment: 'Accepted at Interspeech 2026 (Oral)' }), 'Interspeech 2026');
    assert.equal(fetchPapers.extractVenueBadgeFromArxivMetadata({ comment: "Accepted to ICASSP'26" }), 'ICASSP 2026');
    assert.equal(fetchPapers.extractVenueBadgeFromArxivMetadata({ comment: 'To appear in ICASSP-2026' }), 'ICASSP 2026');
    assert.equal(fetchPapers.extractVenueBadgeFromArxivMetadata({ comment: 'Accepted to ICASSP 12 pages' }), 'ICASSP');
    assert.equal(fetchPapers.extractVenueBadgeFromArxivMetadata({ comment: 'Published in TASLP 34(2), pp. 100-110' }), 'TASLP');
    assert.equal(fetchPapers.extractVenueBadgeFromArxivMetadata({ comment: 'Published in MedIA. Automatic ACL tear segmentation' }), '');
    assert.equal(fetchPapers.extractVenueBadgeFromArxivMetadata({ comment: 'Oral at XYZ Workshop; extends our ICML 2024 paper' }), '');

    // Withdrawn positive & false-positive guards
    assert.equal(fetchPapers.detectWithdrawnArxivPaper({ comment: 'Note: this work was not withdrawn' }), false);
    assert.equal(fetchPapers.detectWithdrawnArxivPaper({ comment: 'Supersedes withdrawn draft arXiv:2501.00001' }), false);
    assert.equal(fetchPapers.detectWithdrawnArxivPaper({ comment: 'This paper has been withdrawn from ICML workshop; accepted at Interspeech 2026' }), false);
    assert.equal(fetchPapers.detectWithdrawnArxivPaper({ comment: 'Withdrawn from arXiv due to data leak.' }), true);
    assert.equal(fetchPapers.detectWithdrawnArxivPaper({ abstract: 'The authors have withdrawn this paper due to data overlap.' }), true);

    // fetchArxivMetadataBatchByIds positional signature + real createHostTaskScheduler() (.run!) & { status, data } unwrap
    let capturedCall = null;
    const scheduler = createHostTaskScheduler({ sleepFn: async () => {} });
    const byId = await fetchPapers.fetchArxivMetadataBatchByIds(['2611.12345v1'], {
        proxyUrl: 'http://127.0.0.1:7890',
        timeoutMs: 12000,
        maxBytes: 4 * 1024 * 1024,
        requestScheduler: scheduler,
        requestFn: async (url, headers, proxyUrl, timeoutMs, maxBytes) => {
            capturedCall = { url, headers, proxyUrl, timeoutMs, maxBytes };
            return { status: 200, headers: {}, data: richXml };
        }
    });
    assert.ok(capturedCall);
    assert.match(capturedCall.url, /id_list=2611\.12345/);
    assert.equal(capturedCall.proxyUrl, 'http://127.0.0.1:7890');
    assert.equal(capturedCall.timeoutMs, 12000);
    assert.equal(capturedCall.maxBytes, 4 * 1024 * 1024);
    assert.ok(capturedCall.headers['User-Agent']);
    assert.equal(byId.get('2611.12345')?.venueBadge, 'ICASSP 2026');

    // Missing proxy fails closed with PROXY_CONFIG_ERROR and propagates through enrichHfOnlyPapersWithArxivMetadata
    const savedHttpsProxy = process.env.HTTPS_PROXY;
    const savedHttpProxy = process.env.HTTP_PROXY;
    const savedLowerHttps = process.env.https_proxy;
    const savedLowerHttp = process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
    try {
        await assert.rejects(
            () => hfPapers.enrichHfOnlyPapersWithArxivMetadata([{ arxivId: '2611.55555', categories: [] }], new Set()),
            err => err?.code === 'PROXY_CONFIG_ERROR'
        );
    } finally {
        if (savedHttpsProxy !== undefined) process.env.HTTPS_PROXY = savedHttpsProxy;
        if (savedHttpProxy !== undefined) process.env.HTTP_PROXY = savedHttpProxy;
        if (savedLowerHttps !== undefined) process.env.https_proxy = savedLowerHttps;
        if (savedLowerHttp !== undefined) process.env.http_proxy = savedLowerHttp;
    }
});

test('Track 13.1A: daily-filter-prefilter seals KEYWORD_PREFILTER_PROFILE on withdrawn papers, blocks cs.CV multimodal+ViTs flood, and preserves real audio acronyms/AAC', () => {
    // 1. Withdrawn paper even in core eess.AS with strong audio terms MUST be quarantined WITH valid KEYWORD_PREFILTER_PROFILE
    const withdrawn = dailyPrefilter.evaluateDailyFilterPrefilter({
        arxivId: '2611.90001',
        title: 'CosyVoice3: Zero-Shot Speech Synthesis',
        abstract: 'This paper has been withdrawn by the authors.',
        comment: 'Withdrawn by authors',
        categories: ['eess.AS', 'cs.SD']
    });
    assert.equal(withdrawn.pass, false);
    assert.equal(withdrawn.dailyFilterPrefilterRule, 'withdrawn_paper');
    assert.deepEqual(withdrawn.profile, KEYWORD_PREFILTER_PROFILE);

    // 2. Non-audio cs.CV / cs.HC papers (including multimodal + ViTs combo!) reject at $0
    for (const nonAudio of [
        {
            title: 'Multimodal Video Understanding with Spatial Memory',
            abstract: 'We improve multimodal video reasoning across egocentric benchmarks using cross-modal tokens and visual planners.',
            categories: ['cs.CV']
        },
        {
            title: 'Facial Emotion Recognition for Interactive AR Interfaces',
            abstract: 'We study facial emotion classification and affective UX widgets in augmented reality headsets.',
            categories: ['cs.HC', 'cs.CV']
        },
        {
            title: 'Accelerating SD Inference via Pruning',
            abstract: 'We prune Stable Diffusion (SD) UNet blocks across text-to-image sampling steps for 2x faster high-resolution image generation on GPUs.',
            categories: ['cs.CV']
        },
        {
            title: 'Multimodal ViTs for 3D Object Detection',
            abstract: 'We combine multimodal point clouds with pruned Vision Transformers (ViTs) for autonomous driving perception across urban road scenes.',
            categories: ['cs.CV']
        }
    ]) {
        const res = dailyPrefilter.evaluateDailyFilterPrefilter(nonAudio);
        assert.equal(res.pass, false, `Expected rejection for: ${nonAudio.title}`);
        assert.ok(res.dailyFilterPrefilterRule, `Expected explicit prefilter rule for: ${nonAudio.title}`);
    }

    // 2b. Short (< 80 char) non-withdrawn abstracts still fail-open safely
    const shortStub = dailyPrefilter.evaluateDailyFilterPrefilter({
        title: 'Accelerating SD Inference',
        abstract: 'Short stub abstract under 80 chars.',
        categories: ['cs.CV']
    });
    assert.equal(shortStub.pass, true);
    assert.equal(shortStub.failOpen, true);

    // 3. Real audio/audiovisual/AAC/acronym cs.CV & cs.HC papers MUST PASS
    for (const realAudio of [
        {
            title: 'LiveAvatar: Real-Time Talking Head Lip-Sync Generation',
            abstract: 'We synthesize expressive talking head videos with accurate lip-sync driven by speech frames.',
            categories: ['cs.CV']
        },
        {
            title: 'SyncFoley: Video-to-Audio Foley Generation with Multimodal Alignment',
            abstract: 'Generating synchronized foley soundscapes for silent video clips with temporal diffusion.',
            categories: ['cs.CV']
        },
        {
            title: 'Designing Voice User Interfaces for Accessible Screen Reader Navigation',
            abstract: 'An empirical HCI study of multimodal voice interface and auditory feedback cues for blind users.',
            categories: ['cs.HC']
        },
        {
            title: '3D Spatial HRTF Estimation from Ear Photogrammetry',
            abstract: 'We reconstruct individualized HRTF profiles directly from monocular ear meshes captured on commodity smartphones.',
            categories: ['cs.CV']
        },
        {
            title: 'Co-Designing Augmentative and Alternative Communication Interfaces',
            abstract: 'A longitudinal field study of augmentative and alternative communication devices with motor-impaired participants.',
            categories: ['cs.HC']
        }
    ]) {
        const res = dailyPrefilter.evaluateDailyFilterPrefilter(realAudio);
        assert.equal(res.pass, true, `Expected PASS for real audio cs.CV/cs.HC paper: ${realAudio.title}`);
    }
});

test('Track 13.1A: ARXIV_CATEGORIES includes cs.CV/cs.HC, daily-fetch-boundary rejects partial onboarding & 8-cat tampering, and digest-run-report supports 7-and-9 batches', () => {
    const ids = Config.ARXIV_CATEGORIES.map(c => c.id);
    assert.equal(ids.length, 9);
    assert.ok(ids.includes('cs.CV'));
    assert.ok(ids.includes('cs.HC'));
    assert.equal(Config.BASE_ARXIV_CATEGORIES.length, 7);

    const codec = require('../scripts/lib/protocol-codec');
    const prior7Cp = {
        batchDate: '2026-11-20',
        arxiv: Object.fromEntries(Config.BASE_ARXIV_CATEGORIES.map(c => [c.id, {
            papers: [{ arxivId: '2611.20001', published: '2026-11-20T01:00:00.000Z' }]
        }])),
        huggingface: { papers: [] }
    };
    const prior = {
        until: '2026-11-20T04:00:00.000Z',
        checkpoint: prior7Cp,
        archiveProofs: [
            { file: 'fetch-checkpoint.json', sha256: 'a'.repeat(64) },
            { file: 'raw-candidates.json', sha256: 'b'.repeat(64) },
            { file: 'filtered-papers.json', sha256: 'c'.repeat(64) },
            { file: 'deep-analysis-result.json', sha256: 'd'.repeat(64) },
            { file: 'blog-generation-manifest-2026-11-20.json', sha256: 'e'.repeat(64) }
        ]
    };
    const continuity = dailyBoundary.deriveContinuity(prior, '2026-11-20');
    assert.equal(continuity.witnesses.arxiv.length, 9);
    assert.deepEqual(
        continuity.witnesses.arxiv.filter(w => w.reason === 'category-newly-onboarded').map(w => w.categoryId),
        ['cs.CV', 'cs.HC']
    );

    const boundaryBody = {
        ...codec.recordHeader('daily-fetch-boundary', 'daily-fetch-boundary'),
        lastDigestDate: '2026-11-20',
        since: '2026-11-20T01:00:00.000Z',
        until: '2026-11-21T04:00:00.000Z',
        provenance: { archiveProofs: prior.archiveProofs },
        continuity
    };
    const valid9 = { ...boundaryBody, identitySha256: dailyBoundary.stableSha(boundaryBody) };
    assert.equal(dailyBoundary.validateDailyFetchBoundary(valid9), true);

    // Tampering: 8 categories MUST fail closed
    const bad8Body = structuredClone(boundaryBody);
    bad8Body.continuity.witnesses.arxiv.pop();
    const bad8 = { ...bad8Body, identitySha256: dailyBoundary.stableSha(bad8Body) };
    assert.throws(() => dailyBoundary.validateDailyFetchBoundary(bad8), /重叠/);

    // Tampering: category-newly-onboarded on base category eess.AS MUST fail closed
    const badBaseBody = structuredClone(boundaryBody);
    badBaseBody.continuity.witnesses.arxiv[0] = {
        categoryId: 'eess.AS',
        status: 'not-applicable',
        reason: 'category-newly-onboarded'
    };
    const badBase = { ...badBaseBody, identitySha256: dailyBoundary.stableSha(badBaseBody) };
    assert.throws(() => dailyBoundary.validateDailyFetchBoundary(badBase), /重叠/);

    // Tampering: mixing expected on cs.CV with category-newly-onboarded on cs.HC MUST fail closed
    const mixedBody = structuredClone(boundaryBody);
    const cvIdx = mixedBody.continuity.witnesses.arxiv.findIndex(w => w.categoryId === 'cs.CV');
    mixedBody.continuity.witnesses.arxiv[cvIdx] = {
        categoryId: 'cs.CV',
        status: 'expected',
        arxivId: '2611.20001',
        published: '2026-11-20T01:00:00.000Z'
    };
    const mixed = { ...mixedBody, identitySha256: dailyBoundary.stableSha(mixedBody) };
    assert.throws(() => dailyBoundary.validateDailyFetchBoundary(mixed), /重叠/);

    // digest-run-report.sourceHealthComplete accepts both 7-cat historical and 9-cat batches, rejects 9-cat boundary with 7-cat categories
    const raw7 = {
        batchDate: '2026-11-20',
        papers: [{ arxivId: '2611.20001' }],
        sourceHealth: {
            arxiv: { ok: true, categories: Config.BASE_ARXIV_CATEGORIES.map(c => ({ id: c.id, ok: true })) },
            huggingface: { ok: true }
        }
    };
    assert.equal(digestRunReport.sourceHealthComplete(raw7, '2026-11-20'), true);
    const rawMismatch = structuredClone(raw7);
    rawMismatch.sourceHealth.fetchBoundary = valid9;
    assert.equal(digestRunReport.sourceHealthComplete(rawMismatch, '2026-11-20'), false);
});

test('Track 13.1A: comment resource extraction (SSRF/host-safe), multi-link metadata discovery, real fetchWithCurl HF detail wiring, and resume merge preservation', async () => {
    const extracted = publicProbe.extractCommentResourceUrls(
        'Accepted to ICASSP 2026. Code: https://github.com/AudioLab/StreamCodec/tree/main, Collection: https://huggingface.co/collections/AudioLab/speech-suite, Paper: https://huggingface.co/papers/2611.12345, Space: https://huggingface.co/spaces/AudioLab/StreamDemo, Project: https://audiolab.github.io/streamcodec/, BadLocal: https://127.0.0.1/demo, BadFqdnLocal: https://localhost./demo, BadFqdnInternal: https://metadata.google.internal./demo, BadMeta: https://169.254.169.254/latest, BadArxiv: https://export.arxiv.org/abs/2611.12345, DOI: https://doi.org/10.1109/1234'
    );
    assert.deepEqual(extracted.repoUrls, [
        'https://github.com/AudioLab/StreamCodec',
        'https://huggingface.co/collections/AudioLab/speech-suite'
    ]);
    assert.deepEqual(extracted.demoUrls, [
        'https://huggingface.co/spaces/AudioLab/StreamDemo',
        'https://audiolab.github.io/streamcodec/'
    ]);

    // Unverified hf_github_repo without sources:['huggingface'] or hfDetailEnriched stays rejected
    assert.deepEqual(publicProbe.resolveMetadataResourceLinks({
        sources: ['arxiv'],
        hf_github_repo: 'https://github.com/spoof/repo'
    }), []);

    // Multi-link metadata discovery works beyond index [0]
    const multiPaper = {
        sources: ['arxiv'],
        hfDetailEnriched: true,
        hf_github_repo: 'https://github.com/AudioLab/FromHF',
        comment: 'Mirror repo at https://github.com/AudioLab/FromComment'
    };
    const resolvedLinks = publicProbe.resolveMetadataResourceLinks(multiPaper);
    assert.deepEqual(resolvedLinks, [
        'https://github.com/AudioLab/FromHF',
        'https://github.com/AudioLab/FromComment'
    ]);
    assert.equal(publicProbe.isMetadataResourceDiscoveryLink(multiPaper, 'https://github.com/AudioLab/FromComment'), true);

    // Real fetchWithCurl path exercised with mocked execFileFn (numeric --max-time, NO -L, { ok, data } parsing, SSRF URL stripping)
    let capturedCurlArgs = null;
    const curlDetail = await hfPapers.fetchHuggingFacePaperDetail('2611.12345v2', {
        proxyUrl: 'http://127.0.0.1:7890',
        timeoutMs: 15000,
        execFileFn: (bin, args, _opts, cb) => {
            capturedCurlArgs = { bin, args };
            cb(null, JSON.stringify({
                paper: {
                    upvotes: 42,
                    githubRepo: 'https://github.com/AudioLab/FastTTS',
                    projectPage: 'https://localhost./internal-demo',
                    githubStars: 310,
                    organization: { name: '  AudioLab  ' }
                },
                models: [{ id: 'AudioLab/FastTTS' }],
                spaces: [{ id: 'AudioLab/FastTTS-Demo' }]
            }), '');
        }
    });
    assert.equal(capturedCurlArgs.bin, 'curl');
    assert.equal(capturedCurlArgs.args.includes('-L'), false);
    assert.equal(capturedCurlArgs.args[capturedCurlArgs.args.indexOf('--max-time') + 1], '15');
    assert.equal(curlDetail.hf_upvotes, 42);
    assert.equal(curlDetail.hf_github_repo, 'https://github.com/AudioLab/FastTTS');
    assert.equal(curlDetail.hf_project_page, ''); // private IP rejected!
    assert.equal(curlDetail.hf_organization, 'AudioLab');

    // Whitespace-only organization.name does not emit empty hf_organization
    const converted = hfPapers.convertPaper({
        id: '2611.12348',
        title: 'Test Paper Title',
        summary: 'Test Paper Summary',
        authors: [{ name: 'Alice' }],
        publishedAt: '2026-11-20T01:00:00Z',
        organization: { name: '   ' }
    });
    assert.equal(Object.prototype.hasOwnProperty.call(converted, 'hf_organization'), false);

    // mergeStoredAnalysisState preserves enriched HF metadata across resume when filtered-papers has empty defaults
    const resumed = analysisEngine.mergeStoredAnalysisState(
        { arxivId: '2611.12345', hf_upvotes: 0, hf_github_repo: '', hf_project_page: '', hf_github_stars: 0 },
        { arxivId: '2611.12345', hfDetailEnriched: true, hf_upvotes: 42, hf_github_repo: 'https://github.com/AudioLab/FastTTS', hf_github_stars: 310 }
    );
    assert.equal(resumed.hfDetailEnriched, true);
    assert.equal(resumed.hf_upvotes, 42);
    assert.equal(resumed.hf_github_repo, 'https://github.com/AudioLab/FastTTS');
    assert.equal(resumed.hf_github_stars, 310);

    // mergeAndDeduplicate merges updated, authorAffiliations (even when existing is []), and unions categories
    const mergedList = hfPapers.mergeAndDeduplicate(
        [{ arxivId: '2611.77777', title: 'A', categories: ['eess.AS'], authorAffiliations: [] }],
        [{ arxivId: '2611.77777', title: 'A', categories: ['cs.CV'], updated: '2026-11-21T00:00:00+08:00', authorAffiliations: [{ name: 'A', affiliations: ['Lab'] }], hf_upvotes: 5 }]
    );
    assert.equal(mergedList.length, 1);
    assert.deepEqual(mergedList[0].categories, ['eess.AS', 'cs.CV']);
    assert.equal(mergedList[0].updated, '2026-11-21T00:00:00+08:00');
    assert.equal(mergedList[0].authorAffiliations.length, 1);
});

test('Track 13.1A: official-conference-acquisition-extended handles >8 MiB PDFs, retries/limit, NeurIPS queryless URLs, IEEE local PDF sealing, and rejects receipt tampering', async t => {
    const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wave13-conf-v2-'));
    t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    // 1. EMNLP 2026 ACL Anthology HTML parser
    const emnlpHtml = `
      <p class="d-sm-flex align-items-stretch">
        <span class="d-block">
          <strong><a class="align-middle" href="/2026.emnlp-main.12/">Spoken Dialogue Grounding</a></strong><br>
          <a href="/people/alice-zhang/">Alice Zhang</a>, <a href="/people/bob-li/">Bob Li</a>
        </span>
      </p>
      <div id="abstract-2026--emnlp-main--12"><div class="card-body">Speech dialogue abstract.</div></div>
      <p class="d-sm-flex"><span class="d-block"><strong><a class="align-middle" href="/2026.emnlp-main.0/">Proceedings Volume Frontmatter</a></strong></span></p>
    `;
    const emnlp = acqV2.parseEmnlpCatalogHtml(emnlpHtml);
    assert.equal(emnlp.papers.length, 1);
    assert.equal(emnlp.papers[0].id, '2026.emnlp-main.12');
    assert.equal(paperIdentity.validateOfficialUrl(emnlp.papers[0].recordUrl, 'emnlp'), emnlp.papers[0].recordUrl);

    // 2. NeurIPS 2026 proceedings.neurips.cc HTML parser (queryless canonical URL passes paper-identity!)
    const neuripsHtml = `
      <ul>
        <li class="conference">
          <a title="paper title" href="/paper_files/paper/2026/hash/abc123def456-Abstract-Conference.html">Neural Audio World Models</a>
          <i>Lin Chen, Mei Wang</i>
        </li>
      </ul>
    `;
    const neurips = acqV2.parseNeuripsProceedingsHtml(neuripsHtml, acqV2.providerFor('neurips-2026'));
    assert.equal(neurips.papers.length, 1);
    assert.equal(neurips.papers[0].id, 'abc123def456');
    assert.equal(neurips.papers[0].recordUrl, 'https://proceedings.neurips.cc/paper_files/paper/2026/hash/abc123def456-Abstract-Conference.html');
    assert.equal(neurips.papers[0].pdfUrl, 'https://proceedings.neurips.cc/paper_files/paper/2026/file/abc123def456-Paper-Conference.pdf');
    assert.equal(paperIdentity.validateOfficialUrl(neurips.papers[0].recordUrl, 'neurips'), neurips.papers[0].recordUrl);

    // 3. CLI parseArgs recognizes v2 providers cleanly
    const parsedCli = acqCli.parseArgs(
        ['catalog', '--provider', 'ismir-2026', '--conference-id', 'ismir-2026', '--year', '2026', '--dry-run'],
        { acquisitionRoot: tmpRoot }
    );
    assert.equal(parsedCli.providerId, 'ismir-2026');

    // 4. End-to-end Zenodo JSON (/api/files/<uuid> URL + >8 MiB PDF + retry recovery) -> verify -> conference-discovery!
    const ismirDir = path.join(tmpRoot, 'ismir-2026');
    const zenodoPage1 = {
        hits: {
            hits: [{
                id: 14800001,
                doi: '10.5281/zenodo.14800001',
                metadata: {
                    title: 'Symbolic Music Transformer with Beat Tracking',
                    publication_date: '2026-10-15',
                    creators: [{ name: 'Yuki Sato' }],
                    description: '<p>A &amp; B symbolic music model (a < b and c > d).</p>',
                    conference: { title: 'ISMIR 2026' }
                },
                files: [{
                    key: 'paper_001.pdf',
                    links: { self: 'https://zenodo.org/api/files/11112222-3333-4444-5555-666677778888/paper_001.pdf' }
                }]
            }]
        },
        links: {}
    };
    // 9 MiB PDF (exceeds git-file-bytes 8 MiB cap to verify P0-4 is fixed!)
    const bigPdf = Buffer.concat([
        Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'ascii'),
        Buffer.alloc(9 * 1024 * 1024, 0x20),
        Buffer.from('\n%%EOF\n', 'ascii')
    ]);
    let pdfAttempts = 0;
    const mockFetch = async url => {
        if (url.includes('/api/records?')) return makeJsonResponse(200, zenodoPage1, 'application/json');
        if (url.endsWith('/paper_001.pdf')) {
            pdfAttempts += 1;
            if (pdfAttempts === 1) return makeJsonResponse(503, {}, 'application/json');
            return makeJsonResponse(200, bigPdf, 'application/pdf');
        }
        return makeJsonResponse(404, {}, 'application/json');
    };

    let dispatcherClosed = false;
    const sharedDispatcher = {
        close() { dispatcherClosed = true; }
    };
    const depsWithCachedDispatcher = {
        fetch: mockFetch,
        detectProxy: () => 'http://127.0.0.1:7890',
        createDispatcher: () => sharedDispatcher,
        sleep: async () => {}
    };

    const catRes = await acqV2.acquireCatalog({ providerId: 'ismir-2026', outputRoot: ismirDir, apply: true }, depsWithCachedDispatcher);
    assert.equal(catRes.papers, 1);
    assert.equal(dispatcherClosed, false);

    const dlRes = await acqV2.downloadPapers(
        { providerId: 'ismir-2026', outputRoot: ismirDir, apply: true, retries: 1 },
        depsWithCachedDispatcher
    );
    assert.equal(dlRes.downloaded, 1);
    assert.equal(pdfAttempts, 2);
    assert.equal(dispatcherClosed, false);

    const verifyRes = acqV2.verifyAcquisition({ providerId: 'ismir-2026', outputRoot: ismirDir });
    assert.equal(verifyRes.complete, true);

    const discovered = discovery.discoverConference({
        adapter: 'official-proceedings',
        year: 2026,
        conferenceId: 'ismir-2026',
        metadataFile: path.join(ismirDir, 'metadata.json'),
        pdfRoot: ismirDir,
        acquisitionRoot: ismirDir
    });
    assert.equal(discovered.manifest.acquisitionReceipt.providerId, 'ismir-2026');
    assert.equal(discovered.manifest.members[0].match.kind, 'exact');

    const catalogFile = path.join(ismirDir, 'candidate.json');
    const reportFile = path.join(ismirDir, 'report.json');
    fs.writeFileSync(catalogFile, discovery.canonicalBytes(discovered.manifest), { mode: 0o600 });
    fs.writeFileSync(reportFile, discovery.canonicalBytes(discovered.report), { mode: 0o600 });
    assert.doesNotThrow(() => discovery.loadDiscoveryHandle(catalogFile, reportFile));

    // Tampering #1: stray unexpected file in pdfs/ MUST fail closed
    const rogueFile = path.join(ismirDir, 'pdfs', 'rogue.pdf');
    fs.writeFileSync(rogueFile, Buffer.from('%PDF-1.7\n'), { mode: 0o600 });
    assert.throws(() => acqV2.verifyAcquisition({ providerId: 'ismir-2026', outputRoot: ismirDir }), /不允许/);
    fs.unlinkSync(rogueFile);

    // Tampering #2: cross-provider PDF receipt swap MUST fail closed
    const pdfReceiptPath = path.join(ismirDir, 'receipts', 'zenodo-14800001.json');
    const origPdfReceipt = fs.readFileSync(pdfReceiptPath);
    const swapped = JSON.parse(origPdfReceipt.toString('utf8'));
    swapped.providerId = 'dcase-2026';
    const { receiptSha256: _oldSha, ...swappedCore } = swapped;
    swapped.receiptSha256 = acqV2.stableHash(swappedCore);
    fs.writeFileSync(pdfReceiptPath, Buffer.from(`${JSON.stringify(swapped, null, 2)}\n`), { mode: 0o600 });
    assert.throws(() => acqV2.verifyAcquisition({ providerId: 'ismir-2026', outputRoot: ismirDir }), /不匹配/);

    // Tampering #3: broken redirect chain (redirects: [] but finalUrl !== requestedUrl) MUST fail closed
    const brokenChain = JSON.parse(origPdfReceipt.toString('utf8'));
    brokenChain.finalUrl = 'https://zenodo.org/api/files/11112222-3333-4444-5555-666677778888/other_paper.pdf';
    const { receiptSha256: _oldSha2, ...brokenCore } = brokenChain;
    brokenChain.receiptSha256 = acqV2.stableHash(brokenCore);
    fs.writeFileSync(pdfReceiptPath, Buffer.from(`${JSON.stringify(brokenChain, null, 2)}\n`), { mode: 0o600 });
    assert.throws(() => acqV2.verifyAcquisition({ providerId: 'ismir-2026', outputRoot: ismirDir }), /重定向链|finalUrl/);
    fs.writeFileSync(pdfReceiptPath, origPdfReceipt, { mode: 0o600 });

    // 4b. NeurIPS 2026 301 trailing-slash redirect passes cleanly
    const neuripsDir = path.join(tmpRoot, 'neurips-2026');
    const neuripsRes = await acqV2.acquireCatalog({ providerId: 'neurips-2026', outputRoot: neuripsDir, apply: true }, {
        fetch: async url => {
            if (url === 'https://proceedings.neurips.cc/paper_files/paper/2026') {
                return {
                    status: 301,
                    headers: { get: k => k.toLowerCase() === 'location' ? '/paper_files/paper/2026/' : null },
                    body: { async cancel() {} }
                };
            }
            return makeJsonResponse(200, neuripsHtml, 'text/html');
        }
    });
    assert.equal(neuripsRes.papers, 1);

    // 5. IEEE local manifest (waspaa-2025): rejects off-host URLs & duplicate pdfFile; seals local PDF & binds discovery
    assert.throws(() => acqV2.parseIeeeLocalManifest({
        papers: [{
            id: 'bad-host',
            title: 'Off-host paper',
            authors: ['A'],
            recordUrl: 'https://evil.example/document/1',
            pdfUrl: 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1',
            pdfFile: 'bad-host.pdf'
        }]
    }, acqV2.providerFor('waspaa-2025')), /白名单/);
    assert.throws(() => acqV2.parseIeeeLocalManifest({
        papers: [
            { id: 'p1', arnumber: '1001', title: 'P1', authors: ['A'], pdfFile: 'shared.pdf' },
            { id: 'p2', arnumber: '1002', title: 'P2', authors: ['B'], pdfFile: 'shared.pdf' }
        ]
    }, acqV2.providerFor('waspaa-2025')), /重复的 pdfFile/);
    const waspaaDir = path.join(tmpRoot, 'waspaa-2025');
    fs.mkdirSync(path.join(waspaaDir, 'responses'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(waspaaDir, 'pdfs'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(waspaaDir, 'responses/proceedings.json'), JSON.stringify({
        papers: [{
            id: 'waspaa25-001',
            arnumber: '10890001',
            title: 'Binaural Dereverberation in Reverberant Rooms',
            authors: ['Hao Zhou'],
            abstract: 'Real-time binaural dereverberation.',
            doi: '10.1109/WASPAA.2025.001',
            pdfFile: 'waspaa25-001.pdf'
        }]
    }), { mode: 0o600 });
    const waspaaCat = await acqV2.acquireCatalog({ providerId: 'waspaa-2025', outputRoot: waspaaDir, apply: true });
    assert.equal(waspaaCat.papers, 1);
    // Before local PDF is placed, verify reports incomplete (missing = ['waspaa25-001'])!
    const waspaaBefore = acqV2.verifyAcquisition({ providerId: 'waspaa-2025', outputRoot: waspaaDir });
    assert.equal(waspaaBefore.complete, false);
    assert.deepEqual(waspaaBefore.missing, ['waspaa25-001']);
    // Place local PDF -> seal via downloadPapers -> passes verify & conference-discovery!
    fs.writeFileSync(path.join(waspaaDir, 'pdfs/waspaa25-001.pdf'), Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'), { mode: 0o600 });
    const waspaaSeal = await acqV2.downloadPapers({ providerId: 'waspaa-2025', outputRoot: waspaaDir, apply: true });
    assert.equal(waspaaSeal.complete, true);
    const waspaaDisc = discovery.discoverConference({
        adapter: 'official-proceedings',
        year: 2025,
        conferenceId: 'waspaa-2025',
        metadataFile: path.join(waspaaDir, 'metadata.json'),
        pdfRoot: waspaaDir,
        acquisitionRoot: waspaaDir
    });
    assert.equal(waspaaDisc.manifest.members[0].match.kind, 'exact');

    // 6. Security: off-host redirect & Zenodo truncated pagination MUST fail closed
    await assert.rejects(
        () => acqV2.acquireCatalog({ providerId: 'dcase-2026', outputRoot: path.join(tmpRoot, 'dcase-2026'), apply: true }, {
            fetch: async () => ({
                status: 302,
                headers: { get: k => k.toLowerCase() === 'location' ? 'https://evil.example/records' : null },
                body: { async cancel() {} }
            })
        }),
        /主机不在白名单中/
    );
});

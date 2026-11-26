'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    IMPLEMENTATION_SPEC_KEYS,
    OPTIONAL_IMPLEMENTATION_SPEC_KEYS,
    STRUCTURED_EDITORIAL
} = require('../scripts/lib/reader-record-format');
const publicResourceProbe = require('../scripts/lib/public-resource-probe');
const deepAnalyzer = require('../scripts/deep-analyzer');

function makeResponse(status, body = '', headers = {}) {
    const normalizedHeaders = new Map(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
    const buf = Buffer.from(body, 'utf8');
    return {
        status,
        headers: {
            get(name) {
                return normalizedHeaders.get(String(name).toLowerCase()) || null;
            }
        },
        body: {
            async cancel() {}
        },
        async arrayBuffer() {
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
    };
}

test('Track 12.4: OPTIONAL_IMPLEMENTATION_SPEC_KEYS adds audioSignalSpecs without breaking the 6 required v5 keys', () => {
    assert.deepEqual(IMPLEMENTATION_SPEC_KEYS, [
        'trainingData',
        'computeHardware',
        'keyHyperparams',
        'inferenceCost',
        'openSourceArtifacts',
        'appendixHighlights'
    ]);
    assert.deepEqual(OPTIONAL_IMPLEMENTATION_SPEC_KEYS, ['audioSignalSpecs']);
    assert.equal(STRUCTURED_EDITORIAL, 'structured-pipeline');
    assert.equal(require('../scripts/lib/reader-record-format.js').isStructuredEditorial('structured-pipeline'), true);
    assert.equal(require('../scripts/lib/reader-record-format.js').isStructuredEditorial('structured-pipeline-v5'), true);
});

test('Track 12.4: analyzeDemoPageAudioCapabilities extracts audio samples, comparison systems, and HF Spaces while stripping scripts/comments', () => {
    const html = `
<!doctype html>
<html>
<head>
  <script>
    const fake = '<audio src="https://evil.example/from-script.wav"></audio>';
    const fakeSpace = 'https://huggingface.co/spaces/fake/from-script';
  </script>
  <style>.audio { content: "https://evil.example/from-style.mp3"; }</style>
</head>
<body>
  <!-- <audio src="https://evil.example/from-comment.flac"></audio> -->
  <!-- https://huggingface.co/spaces/fake/from-comment -->
  <template><audio src="https://evil.example/from-template.wav"></audio></template>
  <p>Try interactive demo at <a href="https://huggingface.co/spaces/AudioLab/StreamTTS-Demo">HF Space</a></p>
  <table>
    <thead>
      <tr>
        <th>Sample ID</th>
        <th>Transcript</th>
        <th>Ground Truth</th>
        <th>VITS</th>
        <th>Proposed (Ours)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>01</td>
        <td>Hello world</td>
        <td><audio controls src="samples/gt_01.wav"></audio></td>
        <td><audio controls><source src="/assets/vits_01.mp3" type="audio/mpeg"></audio></td>
        <td><a href="https://cdn.demo.org/audio/ours_01.flac?v=2">Download FLAC</a></td>
      </tr>
    </tbody>
  </table>
  <a href="javascript:alert(1)">bad</a>
  <a href="http://insecure.example/a.wav">insecure</a>
</body>
</html>`;

    const result = publicResourceProbe.analyzeDemoPageAudioCapabilities(html, 'https://demo.example.org/project/index.html');
    assert.equal(result.audioTagCount, 2);
    assert.equal(result.audioSampleCount, 3);
    assert.deepEqual(result.sampleUrls, [
        'https://demo.example.org/project/samples/gt_01.wav',
        'https://demo.example.org/assets/vits_01.mp3',
        'https://cdn.demo.org/audio/ours_01.flac?v=2'
    ]);
    assert.deepEqual(result.audioFormats, ['flac', 'mp3', 'wav']);
    assert.equal(result.hasBaselineComparison, true);
    assert.deepEqual(result.comparisonSystems, ['Ground Truth', 'VITS', 'Proposed (Ours)']);
    assert.deepEqual(result.spaceUrls, ['https://huggingface.co/spaces/AudioLab/StreamTTS-Demo']);
});

test('Track 12.4: analyzeDemoPageAudioCapabilities ignores metadata-only tables and caps sampleUrls at 12', () => {
    const rows = Array.from({ length: 16 }, (_, idx) =>
        `<tr><td>${idx + 1}</td><td><audio src="clip_${idx + 1}.wav"></audio></td></tr>`
    ).join('\n');
    const html = `<table><thead><tr><th>ID</th><th>Text</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>`;
    const result = publicResourceProbe.analyzeDemoPageAudioCapabilities(html, 'https://demo.example.org/');
    assert.equal(result.audioTagCount, 16);
    assert.equal(result.audioSampleCount, 12);
    assert.equal(result.sampleUrls.length, 12);
    assert.equal(result.hasBaselineComparison, false);
    assert.deepEqual(result.comparisonSystems, []);
});

test('Track 12.4: probeAudioSampleUrls verifies HEAD 200, falls back on 405 to Range GET 206, rejects soft-404 text/html and SSRF private IPs', async () => {
    const calls = [];
    const mockValidate = async url => {
        const parsed = new URL(url);
        if (parsed.hostname === '127.0.0.1' || parsed.protocol !== 'https:') {
            throw new Error('Blocked non-public URL');
        }
        return parsed;
    };
    const mockRequest = async (url, reqOpts) => {
        calls.push({ url, method: reqOpts.method, range: reqOpts.headers?.Range || null });
        if (url.endsWith('ok.wav')) {
            return makeResponse(200, '', { 'content-type': 'audio/wav' });
        }
        if (url.endsWith('range.mp3')) {
            if (reqOpts.method === 'HEAD') return makeResponse(405, '', { 'content-type': 'text/plain' });
            return makeResponse(206, 'ID3', { 'content-type': 'audio/mpeg' });
        }
        if (url.endsWith('soft404.wav')) {
            return makeResponse(200, '<html>Not Found</html>', { 'content-type': 'text/html; charset=utf-8' });
        }
        return makeResponse(404, '', { 'content-type': 'text/plain' });
    };

    const okProbe = await publicResourceProbe.probeAudioSampleUrls(
        ['https://demo.example.org/ok.wav', 'https://demo.example.org/range.mp3'],
        {
            maxSamples: 2,
            validateUrlImpl: mockValidate,
            requestImpl: mockRequest,
            detectProxyImpl: () => ''
        }
    );
    assert.equal(okProbe.probedCount, 2);
    assert.equal(okProbe.reachableCount, 2);
    assert.equal(okProbe.audioSamplesReachable, true);
    assert.equal(calls.some(c => c.url.endsWith('range.mp3') && c.method === 'GET' && c.range === 'bytes=0-63'), true);

    const badProbe = await publicResourceProbe.probeAudioSampleUrls(
        ['https://demo.example.org/soft404.wav', 'https://127.0.0.1/internal.wav'],
        {
            maxSamples: 2,
            validateUrlImpl: mockValidate,
            requestImpl: mockRequest,
            detectProxyImpl: () => ''
        }
    );
    assert.equal(badProbe.probedCount, 2);
    assert.equal(badProbe.reachableCount, 0);
    assert.equal(badProbe.audioSamplesReachable, false);
    assert.equal(badProbe.results[0].ok, false);
    assert.equal(badProbe.results[0].contentType, 'text/html');
    assert.equal(badProbe.results[1].ok, false);
    assert.match(badProbe.results[1].error, /Blocked/);
});

test('Track 12.4: probeHuggingFaceSpaceStatus parses RUNNING/SLEEPING stages and blocks host spoofing & off-host redirects', async () => {
    const mockValidate = async url => new URL(url);

    const running = await publicResourceProbe.probeHuggingFaceSpaceStatus(
        'https://huggingface.co/spaces/FunAudio/CosyVoice2',
        {
            validateUrlImpl: mockValidate,
            detectProxyImpl: () => '',
            requestImpl: async url => {
                assert.equal(url, 'https://huggingface.co/api/spaces/FunAudio/CosyVoice2');
                return makeResponse(200, JSON.stringify({
                    runtime: { stage: 'RUNNING', hardware: { current: 't4-small' } }
                }), { 'content-type': 'application/json' });
            }
        }
    );
    assert.equal(running.ok, true);
    assert.equal(running.stage, 'RUNNING');
    assert.equal(running.hardware, 't4-small');
    assert.equal(running.isRunning, true);

    const sleeping = await publicResourceProbe.probeHuggingFaceSpaceStatus(
        'https://huggingface.co/spaces/FunAudio/IdleDemo',
        {
            validateUrlImpl: mockValidate,
            detectProxyImpl: () => '',
            requestImpl: async () => makeResponse(200, JSON.stringify({
                runtime: { stage: 'SLEEPING', hardware: { requested: 'cpu-basic' } }
            }), { 'content-type': 'application/json' })
        }
    );
    assert.equal(sleeping.ok, true);
    assert.equal(sleeping.stage, 'SLEEPING');
    assert.equal(sleeping.isRunning, false);

    const spoofedHost = await publicResourceProbe.probeHuggingFaceSpaceStatus(
        'https://evil-huggingface.co/spaces/a/b',
        { validateUrlImpl: mockValidate, detectProxyImpl: () => '' }
    );
    assert.equal(spoofedHost.ok, false);
    assert.equal(spoofedHost.error, 'invalid_space_url');

    const offHostRedirect = await publicResourceProbe.probeHuggingFaceSpaceStatus(
        'https://huggingface.co/spaces/FunAudio/Redirected',
        {
            validateUrlImpl: mockValidate,
            detectProxyImpl: () => '',
            requestImpl: async () => makeResponse(302, '', { location: 'https://evil.example/api' })
        }
    );
    assert.equal(offHostRedirect.ok, false);
    assert.equal(offHostRedirect.error, 'unexpected_redirect_host');
});

test('Track 12.4: inspectDemoPageDetailed reuses single HTML fetch for both links and audioDemo, preserving checkDemoPageForOpensource parity', async () => {
    let fetchCount = 0;
    const html = `
      <html><body>
        <a href="https://github.com/AudioLab/FastCodec">Code</a>
        <table><thead><tr><th>Reference</th><th>FastCodec</th></tr></thead>
          <tbody><tr><td><audio src="ref.wav"></audio></td><td><audio src="fast.wav"></audio></td></tr></tbody>
        </table>
      </body></html>`;
    const opts = {
        validateUrlImpl: async url => new URL(url),
        detectProxyImpl: () => '',
        requestImpl: async () => {
            fetchCount += 1;
            return makeResponse(200, html, { 'content-type': 'text/html' });
        }
    };

    const detailed = await publicResourceProbe.inspectDemoPageDetailed('https://audiolab.github.io/fastcodec/', opts);
    assert.equal(fetchCount, 1);
    assert.equal(detailed.reachable, true);
    assert.deepEqual(detailed.links, ['https://github.com/AudioLab/FastCodec']);
    assert.equal(detailed.audioDemo.audioSampleCount, 2);
    assert.equal(detailed.audioDemo.hasBaselineComparison, true);

    const legacyLinks = await publicResourceProbe.checkDemoPageForOpensource('https://audiolab.github.io/fastcodec/', opts);
    assert.deepEqual(legacyLinks, ['https://github.com/AudioLab/FastCodec']);
});

test('Track 12.4: buildRecoveryFingerprints preserves saved demo-link-scan-v4 parents and assigns v5 to fresh runs', () => {
    const basePaper = {
        arxivId: '2611.88888',
        title: 'Fresh Audio Paper',
        authors: ['Alice'],
        categories: ['cs.SD'],
        abstract: 'Audio coding abstract.'
    };
    const freshFp = deepAnalyzer.buildRecoveryFingerprints(basePaper, 'Source text');
    const v4Fingerprint = deepAnalyzer.stableFingerprint({
        implementation: 'demo-link-scan-v4-huggingface-project-metadata-modelscope',
        projectPages: [],
        metadataResourceLinks: []
    });
    const savedV4Paper = {
        ...basePaper,
        analysisManifest: {
            stages: {
                demoLinkScan: {
                    fingerprint: v4Fingerprint
                }
            }
        }
    };
    const legacyFp = deepAnalyzer.buildRecoveryFingerprints(savedV4Paper, 'Source text', '2611.88888');
    assert.notEqual(freshFp.demoLinkScan, legacyFp.demoLinkScan);
    assert.equal(
        legacyFp.demoLinkScan,
        v4Fingerprint,
        'Saved demo-link-scan-v4 parent must retain its exact v4 fingerprint on replay'
    );
});

test('Track 12.4 R1 regressions: reader-repair accepts audioSignalSpecs, O(N) HTML tokenizer defeats ReDoS & bypasses, HF Space & audio probe hardening', async () => {
    const readerRepair = require('../scripts/lib/reader-repair');
    const readerFormat = require('../scripts/lib/reader-record-format');

    // P0-1: collectDraftIssues must accept optional audioSignalSpecs on v5 and still flag truly unknown keys
    const codec = require('../scripts/lib/protocol-codec');
    const draftHeader = codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
    const v5DraftBase = {
        ...draftHeader,
        readerTitle: '流式语音编码如何压低延迟',
        oneSentenceThesis: '本文把梅尔帧率压缩至 50 Hz 并在 40 ms 前瞻内保持高保真听感。',
        implementationSpecs: {
            trainingData: 'LibriTTS-R 585 小时。',
            computeHardware: '8 卡 A100 训练 36 小时。',
            keyHyperparams: 'AdamW，学习率 1e-4。',
            inferenceCost: 'A100 推理 RTF 0.11。',
            openSourceArtifacts: '代码与权重公开。',
            appendixHighlights: '原文未披露。',
            audioSignalSpecs: '采样率 24 kHz，帧率 50 Hz，前瞻 40 ms。'
        },
        sections: []
    };
    assert.equal(typeof readerRepair.collectDraftIssues, 'function');
    const diagOk = readerRepair.collectDraftIssues(null, new Error('parse failed'), {
        rawDraft: JSON.stringify(v5DraftBase)
    });
    assert.ok(
        !JSON.stringify(diagOk).includes('audioSignalSpecs'),
        `collectDraftIssues must not flag optional audioSignalSpecs as unknown: ${JSON.stringify(diagOk)}`
    );
    const diagBad = readerRepair.collectDraftIssues(null, new Error('parse failed'), {
        rawDraft: JSON.stringify({
            ...v5DraftBase,
            implementationSpecs: { ...v5DraftBase.implementationSpecs, bogusKey: 'bad' }
        })
    });
    assert.ok(
        JSON.stringify(diagBad).includes('bogusKey'),
        `collectDraftIssues must still flag truly unknown implementationSpecs keys: ${JSON.stringify(diagBad)}`
    );

    // P0-3: O(N) immunity against quadratic ReDoS payloads + HTML5 comment / RAWTEXT / foreign-tag bypasses
    const t0 = Date.now();
    for (const payload of [
        '<a '.repeat(30000),
        '<table>'.repeat(14000),
        '<audio>'.repeat(14000),
        '<script>'.repeat(12500)
    ]) {
        publicResourceProbe.analyzeDemoPageAudioCapabilities(payload, 'https://demo.example.org/');
    }
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 500, `Expected O(N) parsing < 500ms across all 4 adversarial payloads, got ${elapsedMs}ms`);

    const bypassHtml = `
      <!--> <audio src="https://demo.example.org/after-abrupt-comment.wav"></audio>
      <svg data-x=a / data-y=b><audio src="https://evil.example/in-svg-slash.wav"></audio></svg>
      <template><template></template><audio src="https://evil.example/in-nested-template.wav"></audio></template>
      <math><audio src="https://evil.example/in-math.wav"></audio></math>
      <xmp><audio src="https://evil.example/in-xmp.wav"></audio></xmp>
      <p>Space link at sentence end: https://huggingface.co/spaces/Lab/VoiceDemo.</p>
      <img poster-src="https://evil.example/poster.wav" data-href="https://evil.example/data.wav">
      <!-- unclosed comment <audio src="https://evil.example/unclosed-comment.wav"></audio>
    `;
    const bypassRes = publicResourceProbe.analyzeDemoPageAudioCapabilities(bypassHtml, 'https://demo.example.org/');
    assert.deepEqual(bypassRes.sampleUrls, ['https://demo.example.org/after-abrupt-comment.wav']);
    assert.deepEqual(bypassRes.spaceUrls, ['https://huggingface.co/spaces/Lab/VoiceDemo']);

    const unclosedScriptRes = publicResourceProbe.analyzeDemoPageAudioCapabilities(
        '<script><audio src="https://evil.example/unclosed-script.wav"></audio>',
        'https://demo.example.org/'
    );
    assert.equal(unclosedScriptRes.audioSampleCount, 0);

    // P1-4: Per-table baseline comparison scoping & ignoring row-header th+td tables
    const twoSingleTablesHtml = `
      <table><thead><tr><th>Clean Speech</th></tr></thead><tbody><tr><td><audio src="a.wav"></audio></td></tr></tbody></table>
      <table><thead><tr><th>Noisy Speech</th></tr></thead><tbody><tr><td><audio src="b.wav"></audio></td></tr></tbody></table>
      <table><tbody><tr><th>Speaker A</th><td><audio src="c.wav"></audio></td></tr><tr><th>Speaker B</th><td><audio src="d.wav"></audio></td></tr></tbody></table>
    `;
    const scopedRes = publicResourceProbe.analyzeDemoPageAudioCapabilities(twoSingleTablesHtml, 'https://demo.example.org/');
    assert.equal(scopedRes.hasBaselineComparison, false);
    assert.deepEqual(scopedRes.comparisonSystems, []);

    // P1-2: probeAudioSampleUrls passes responseBodyMode: 'headers_only' and rejects http:
    const seenModes = [];
    const probeRes = await publicResourceProbe.probeAudioSampleUrls(
        ['https://demo.example.org/clip.wav', 'http://demo.example.org/insecure.wav'],
        {
            validateUrlImpl: async url => new URL(url),
            detectProxyImpl: () => '',
            requestImpl: async (url, reqOpts) => {
                seenModes.push(reqOpts.responseBodyMode);
                return makeResponse(200, '', { 'content-type': 'audio/wav' });
            }
        }
    );
    assert.deepEqual(seenModes, ['headers_only']);
    assert.equal(probeRes.results[0].ok, true);
    assert.equal(probeRes.results[1].ok, false);

    // P0-2 & P1-3: HF Space hostile stage/hardware sanitized, traversal / m.host / port / non-API redirect rejected
    const hostileSpace = await publicResourceProbe.probeHuggingFaceSpaceStatus(
        'https://huggingface.co/spaces/Lab/TestSpace',
        {
            validateUrlImpl: async url => new URL(url),
            detectProxyImpl: () => '',
            requestImpl: async () => makeResponse(200, JSON.stringify({
                runtime: { stage: 'RUNNING<script>x</script>', hardware: { current: 't4\n## injected' } }
            }), { 'content-type': 'application/json' })
        }
    );
    assert.equal(hostileSpace.ok, false);
    assert.equal(hostileSpace.stage, '');
    assert.equal(hostileSpace.hardware, '');

    for (const badUrl of [
        'https://huggingface.co/spaces/a/../b/c',
        'https://m.huggingface.co/spaces/Lab/Demo'
    ]) {
        const res = await publicResourceProbe.probeHuggingFaceSpaceStatus(badUrl, {
            validateUrlImpl: async url => new URL(url),
            detectProxyImpl: () => ''
        });
        assert.equal(res.ok, false, `Must reject ${badUrl}`);
    }
    for (const badRedirect of [
        'https://huggingface.co:8443/api/spaces/Lab/Demo',
        'https://huggingface.co/arbitrary/path',
        'https://m.huggingface.co/api/spaces/Lab/Demo'
    ]) {
        const res = await publicResourceProbe.probeHuggingFaceSpaceStatus(
            'https://huggingface.co/spaces/Lab/Demo',
            {
                validateUrlImpl: async url => new URL(url),
                detectProxyImpl: () => '',
                requestImpl: async () => makeResponse(302, '', { location: badRedirect })
            }
        );
        assert.equal(res.ok, false, `Must reject redirect to ${badRedirect}`);
        assert.equal(res.error, 'unexpected_redirect_host');
    }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scriptLib = require('../scripts/lib/daily-podcast-script.js');
const releaseLib = require('../scripts/lib/podcast-github-release.js');
const publisher = require('../scripts/publish-daily-podcast.js');

const ROOT = path.resolve(__dirname, '..');

function makeSampleAnalysisData(date = '2026-11-24') {
    return {
        batchDate: date,
        papers: [
            {
                arxivId: '2611.10001v1',
                title: 'StreamCodec-Pro: Ultra-Low-Latency 24kHz Neural Audio Codec',
                parsed: {
                    score: '8.8',
                    primaryTaskTag: '#音频编解码',
                    tags: ['#音频编解码', '#流式语音'],
                    summary: [
                        '问题与瓶颈： 现有神经音频编解码器在低码率下存在高频失真与较长前瞻延迟，难以满足实时语音交互需求。',
                        '核心思路与方法架构： 提出因果多尺度残差量化架构，把帧率压到 50 Hz 并结合轻量状态空间解码器。',
                        '关键实验与核心代价： 在 LibriSpeech 测试集上，1.5 kbps 码率下 MOS 达到 4.32，WER < 2.1%，代价是极复杂音乐场景仍有轻微伪影。',
                        '适用边界与深读导览： 结论主要在 24 kHz 语音评测集上验证，多声道混音场景尚未覆盖。'
                    ].join('\n\n'),
                    limitations: '极复杂交响乐场景仍有伪影，尚未测试多声道混音。',
                    hasCode: '是',
                    hasModel: '是'
                },
                apiReaderPlan: {
                    readerTitle: '超低延迟神经音频编解码：StreamCodec-Pro 解析',
                    oneSentenceThesis: '通过因果多尺度量化在 1.5 kbps 码率与 40 ms 延迟下实现高保真 24 kHz 语音重建。',
                    implementationSpecs: {
                        audioSignalSpecs: '采样率 24 kHz，帧率 50 Hz（步长 20 ms），码率 1.5 kbps，因果前瞻延迟 40 ms，A100 推理 RTF 0.07。'
                    }
                },
                apiReaderResources: {
                    resources: [
                        { type: 'code', availability: 'available', finalUrl: 'https://github.com/example/streamcodec' },
                        { type: 'demo', availability: 'available', finalUrl: 'https://example.github.io/streamcodec/' }
                    ]
                }
            },
            {
                arxivId: '2611.10002v1',
                title: 'OmniListen: Unified Speech and Sound Reasoning',
                parsed: {
                    score: '8.2',
                    primaryTaskTag: '#语音识别',
                    tags: ['#语音识别', '#音频理解'],
                    summary: [
                        '问题与瓶颈： 现有多模态语音模型在强噪声环境下的词错率居高不下。',
                        '核心思路与方法架构： 引入双路径时频注意力和噪声自适应门控模块。',
                        '关键实验与核心代价： 在 CHiME-6 噪声基准上把 WER 降低到 14.8%，但推理显存占用提高约 18%。',
                        '适用边界与深读导览： 仅覆盖英语远场对话数据，未在中文会议场景验证。'
                    ].join('\n\n'),
                    hasCode: '是',
                    hasModel: '否'
                },
                apiReaderPlan: {
                    readerTitle: '抗噪统一语音理解：OmniListen 方法拆解',
                    oneSentenceThesis: '用双路径时频注意力显著降低远场强噪声场景下的识别错误率。',
                    implementationSpecs: {
                        audioSignalSpecs: '原文未披露具体音频信号与流式规格。'
                    }
                },
                apiReaderResources: {
                    resources: [
                        { type: 'code', availability: 'unavailable', finalUrl: 'https://github.com/example/dead' }
                    ]
                }
            },
            {
                arxivId: '2611.10003v1',
                title: 'ExpressiveTTS: Disentangled Prosody Control',
                parsed: {
                    score: '7.6',
                    primaryTaskTag: '#语音合成',
                    tags: ['#语音合成', '#可控生成'],
                    summary: [
                        '问题与瓶颈： 零样本语音合成在跨情感迁移时容易丢失目标说话人音色。',
                        '核心思路与方法架构： 利用对抗瓶颈与八维情感向量解耦音色与韵律。',
                        '关键实验与核心代价： 主观音质分 MOS 达 4.18，情感准确率 89.2%。',
                        '适用边界与深读导览： 长段落稳定性仍受参考音频信噪比影响。'
                    ].join('\n\n'),
                    hasCode: '否',
                    hasModel: '是'
                },
                apiReaderPlan: {
                    readerTitle: '解耦韵律控制的零样本语音合成：ExpressiveTTS',
                    oneSentenceThesis: '通过八维情感向量实现说话人音色与情感韵律解耦控制。'
                }
            },
            {
                arxivId: '2611.10004v1',
                title: 'SpatialSep: Binaural Speech Separation in Reverberant Rooms',
                parsed: {
                    score: '7.1',
                    primaryTaskTag: '#音频编解码',
                    tags: ['#音频编解码', '#语音分离'],
                    summary: '问题与瓶颈： 双耳强混响下的多说话人分离存在相位失真。',
                    hasCode: '否',
                    hasModel: '否'
                },
                apiReaderPlan: {
                    readerTitle: '强混响双耳语音分离：SpatialSep 速览',
                    oneSentenceThesis: '结合空间线索滤波在混响环境下提升双耳语音分离的 SI-SDR。'
                }
            },
            {
                arxivId: '2611.10005v1',
                title: 'Failed Paper With Partial Parsed Fields',
                error: 'Reader validation failed',
                parsed: { score: '9.9', summary: 'Should NEVER appear even though parsed exists!' }
            },
            {
                arxivId: '2611.10006v1',
                title: 'Status Failed Paper',
                status: 'failed',
                parsed: { score: '9.8', summary: 'Must also be excluded.' }
            },
            {
                arxivId: '2611.10007v1',
                title: 'Flag Failed Paper',
                failed: true,
                parsed: { score: '9.7', summary: 'Must also be excluded.' }
            }
        ]
    };
}

function hasLoneSurrogate(str) {
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
            if (next < 0xDC00 || next > 0xDFFF) return true;
            i += 1;
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
            return true;
        }
    }
    return false;
}

test('daily-podcast-script: deterministic source-grounded script, excludes errored/failed papers & placeholder specs', () => {
    const data = makeSampleAnalysisData('2026-11-24');
    const script1 = scriptLib.buildDailyPodcastScript(data, { maxHighlights: 3 });
    const reversed = { ...data, papers: [...data.papers].reverse() };
    const script2 = scriptLib.buildDailyPodcastScript(reversed, { maxHighlights: 3 });

    assert.equal(script1.contract, 'daily-podcast-script-v1');
    assert.equal(script1.date, '2026-11-24');
    assert.equal(script1.paperCount, 4); // excluded all 3 errored/failed papers despite partial parsed fields!
    assert.deepEqual(script1.highlightPaperIds, ['2611.10001v1', '2611.10002v1', '2611.10003v1']);
    assert.equal(script1.scriptSha256, script2.scriptSha256);
    assert.match(script1.scriptSha256, /^[a-f0-9]{64}$/);
    assert.ok(script1.estimatedDurationSeconds > 20);

    // Highlight 1: real audioSignalSpecs + inequality WER < 2.1% preserved as 小于
    const h1 = script1.segments[1];
    assert.equal(h1.paperId, '2611.10001v1');
    assert.match(h1.text, /24千赫兹/);
    assert.match(h1.text, /50赫兹/);
    assert.match(h1.text, /20毫秒/);
    assert.match(h1.text, /1\.5千比特每秒/);
    assert.match(h1.text, /实时率 R T F 0\.07/);
    assert.match(h1.text, /词错率 W E R 小于百分之2\.1/);
    assert.match(h1.text, /开源代码与在线试听演示/);

    // Highlight 2: placeholder "原文未披露..." audioSignalSpecs MUST be omitted; unavailable code not claimed
    const h2 = script1.segments[2];
    assert.equal(h2.paperId, '2611.10002v1');
    assert.doesNotMatch(h2.text, /音频信号与流式规格/);
    assert.doesNotMatch(h2.text, /原文未披露/);
    assert.match(h2.text, /暂未核实到可直接访问的代码或试听链接/);

    // Outro adapted cleanly for empty batches when allowEmpty === true
    const emptyScript = scriptLib.buildDailyPodcastScript({ batchDate: '2026-11-24', papers: [] }, { allowEmpty: true });
    assert.equal(emptyScript.paperCount, 0);
    assert.match(emptyScript.segments[emptyScript.segments.length - 1].text, /暂无新增通过核验的论文/);
    assert.doesNotMatch(emptyScript.segments[emptyScript.segments.length - 1].text, /每篇论文的完整中文精读/);

    // Plaintext http:// digestUrl/blogBaseUrl rejected upfront
    assert.throws(
        () => scriptLib.buildDailyPodcastScript(data, { blogBaseUrl: 'http://insecure.example/posts' }),
        /must use https/
    );
    assert.throws(
        () => scriptLib.buildDailyPodcastScript(data, { roundup: { digestUrl: 'http://insecure.example/posts/2026-11-24/' } }),
        /must use https/
    );
});

test('normalizeForChineseTts & splitIntoTtsChunks: anchors, inequalities, LaTeX envs/braced exponents/Greek, UTF-16 surrogates', () => {
    const raw = [
        '[A_METHOD] [SCORING_SOURCE_1] [FIG_2] [TAB_3] [EQ_1] [EVIDENCE_5]',
        '### **重点** [AudioLab](https://audiolab.example/demo) `code_v2`',
        '采样率 16 kHz，延迟 <= 20 ms，RTF < 0.07，词错率 WER < 3.2%，SNR > 4.5 dB。',
        '$$\\begin{aligned}\\Delta &= \\frac{\\mathrm{1}}{\\text{2}} \\times {10}^{-4} + \\Sigma + \\Omega + \\eta + \\rho + \\psi\\end{aligned}$$',
        '未闭合公式 $x + y 与真实美元成本 $100。',
        '<script>alert("xss")</script><div class="note">保留正文</div> 🔥'
    ].join(' ');

    const normalized = scriptLib.normalizeForChineseTts(raw);
    // Internal anchors strictly stripped
    assert.doesNotMatch(normalized, /A_METHOD|SCORING_SOURCE|FIG_2|TAB_3|EQ_1|EVIDENCE_5/);
    // Inequalities strictly preserved (NOT eaten by HTML tag stripping!)
    assert.match(normalized, /小于等于20毫秒/);
    assert.match(normalized, /实时率 R T F 小于 0\.07/);
    assert.match(normalized, /词错率 W E R 小于百分之3\.2/);
    assert.match(normalized, /信噪比 S N R 大于4\.5分贝/);
    // LaTeX environments, unwrapped \frac, braced base {10}^{-4}, uppercase & new Greek letters
    assert.doesNotMatch(normalized, /begin|aligned|end/);
    assert.match(normalized, /德尔塔/);
    assert.match(normalized, /2分之1/);
    assert.match(normalized, /10的负4次方/);
    assert.match(normalized, /西格玛/);
    assert.match(normalized, /欧米伽/);
    assert.match(normalized, /艾塔/);
    assert.match(normalized, /罗/);
    assert.match(normalized, /普赛/);
    // Stray non-currency '$' stripped while genuine HTML tags removed & inner text kept
    assert.doesNotMatch(normalized, /\$x/);
    assert.match(normalized, /100/);
    assert.match(normalized, /保留正文/);
    assert.doesNotMatch(normalized, /<script|alert|<div|🔥/);

    // Tight-spaced inequalities across Chinese prose must NOT be eaten as HTML tags
    const tightIneq = scriptLib.normalizeForChineseTts('当 x<y 且 z>w 时模型收敛。');
    assert.match(tightIneq, /x小于y 且 z大于w/);

    // Subscripted Greek letters (\Delta_{i,j}, \alpha_t, \lambda_1) & model special tokens (<<SYS>>, `<eos>`, `<audio>`)
    const greekAndTokens = scriptLib.normalizeForChineseTts(
        '损失包含 $\\Delta_{i,j} + \\alpha_t + \\lambda_1$，模型使用 <<SYS>>、`<eos>` 与 `<audio>` 词元，同时移除 <audio src="a.mp3"></audio> 标签。'
    );
    assert.match(greekAndTokens, /德尔塔/);
    assert.match(greekAndTokens, /阿尔法/);
    assert.match(greekAndTokens, /拉姆达/);
    assert.match(greekAndTokens, /SYS/);
    assert.match(greekAndTokens, /eos/);
    assert.match(greekAndTokens, /audio/);
    assert.doesNotMatch(greekAndTokens, /src=|a\.mp3|小于eos|大于/);

    // UTF-16 surrogate pair safety: CJK Extension B char '𠀀' (2 UTF-16 code units) placed across limit=180
    const extB = '\uD840\uDC00'; // 𠀀
    const tricky = '甲'.repeat(179) + extB + '乙'.repeat(20); // code unit 179 is high surrogate, 180 is low surrogate!
    const chunks = scriptLib.splitIntoTtsChunks(tricky, 180);
    assert.equal(chunks.length, 2);
    assert.equal(chunks.join(''), tricky);
    for (const ch of chunks) {
        assert.ok(ch.length <= 180);
        assert.equal(hasLoneSurrogate(ch), false, 'Chunk must never contain a lone UTF-16 surrogate');
    }
});

test('podcast-github-release: 40 MiB cap, URL hardening, O_NOFOLLOW + immutable 0400 staging, --title=/--, isReleaseNotFoundError', () => {
    assert.equal(releaseLib.DEFAULT_MAX_AUDIO_BYTES, 40 * 1024 * 1024);
    assert.equal(releaseLib.resolvePodcastGitHubRepo({ env: {} }), 'nanless/audio-research-portal');
    assert.equal(releaseLib.buildReleaseTag('2026-11-24'), 'podcast-2026-11');
    assert.equal(releaseLib.buildReleaseTag('2026-11-24', { tagGrouping: 'daily' }), 'podcast-2026-11-24');

    // Tightened verifyReleaseDownloadUrl rejects port, query, hash, percent-encoding, and non-audio extensions
    const goodUrl = 'https://github.com/nanless/audio-paper-digest-blog/releases/download/podcast-2026-11/podcast-2026-11-24.mp3';
    assert.equal(releaseLib.verifyReleaseDownloadUrl(goodUrl), goodUrl);
    for (const badUrl of [
        'https://github.com:443/nanless/audio-paper-digest-blog/releases/download/podcast-2026-11/podcast-2026-11-24.mp3',
        'https://github.com:8443/nanless/audio-paper-digest-blog/releases/download/podcast-2026-11/podcast-2026-11-24.mp3',
        `${goodUrl}?token=leak`,
        `${goodUrl}#frag`,
        'https://github.com/nanless/audio-paper-digest-blog/releases/download/podcast-2026-11/podcast%2f2026-11-24.mp3',
        'https://github.com/nanless/audio-paper-digest-blog/releases/download/podcast-2026-11/malware.exe',
        'https://github.com/nanless/audio-paper-digest-blog/releases/download/podcast-2026-11/podcast-2026-11-24.mp3\n'
    ]) {
        assert.throws(() => releaseLib.verifyReleaseDownloadUrl(badUrl), /GitHub Release/);
    }

    // isReleaseNotFoundError must NOT treat ENOENT / missing repo / auth errors as missing release!
    assert.equal(releaseLib.isReleaseNotFoundError(Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' })), false);
    assert.equal(releaseLib.isReleaseNotFoundError(new Error('gh: command not found')), false);
    assert.equal(releaseLib.isReleaseNotFoundError(new Error('GraphQL: Could not resolve to a Repository')), false);
    assert.equal(releaseLib.isReleaseNotFoundError(new Error('HTTP 404: Repository not found')), false);
    assert.equal(releaseLib.isReleaseNotFoundError(new Error('HTTP 401: Unauthorized')), false);
    assert.equal(releaseLib.isReleaseNotFoundError(new Error('HTTP 403: Forbidden')), false);
    assert.equal(releaseLib.isReleaseNotFoundError(new Error('release not found')), true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave14-3-gh-'));
    try {
        const assetPath = path.join(tmpDir, 'podcast-2026-11-24.mp3');
        const payload = Buffer.from('ID3-mock-mp3-bytes-for-unit-test-2026-11-24');
        fs.writeFileSync(assetPath, payload);
        const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');

        // Symlink asset must be rejected by O_NOFOLLOW
        const symPath = path.join(tmpDir, 'symlink-dir');
        fs.mkdirSync(symPath);
        const symAsset = path.join(symPath, 'podcast-2026-11-24.mp3');
        fs.symlinkSync(assetPath, symAsset);
        assert.throws(
            () => releaseLib.verifyAudioAsset(symAsset, { date: '2026-11-24' }),
            /safely open audio asset|symlink/
        );

        // Path containing '#' must be rejected (gh release upload parses path#label)
        const hashDir = path.join(tmpDir, 'dir#label');
        fs.mkdirSync(hashDir);
        const hashAsset = path.join(hashDir, 'podcast-2026-11-24.mp3');
        fs.writeFileSync(hashAsset, payload);
        assert.throws(
            () => releaseLib.verifyAudioAsset(hashAsset, { date: '2026-11-24' }),
            /forbidden characters/
        );

        // Real mocked create: verify immutable 0400 staged copy inside 0700 temp dir + --title=/--notes=/--
        let observedStagedPath = null;
        const createCalls = [];
        const createMock = (bin, args, opts) => {
            createCalls.push({ bin, args, opts });
            assert.equal(bin, 'gh');
            assert.equal(opts.shell, false);
            assert.ok(opts.timeout > 0);
            if (args[1] === 'view') {
                const err = new Error('release not found');
                err.stderr = 'release not found';
                throw err;
            }
            if (args[1] === 'create') {
                const sepIdx = args.indexOf('--');
                assert.ok(sepIdx > 0);
                observedStagedPath = args[sepIdx + 2];
                assert.notEqual(observedStagedPath, assetPath, 'gh must receive immutable staged copy');
                const st = fs.statSync(observedStagedPath);
                assert.equal(st.mode & 0o777, 0o400);
                const dirSt = fs.statSync(path.dirname(observedStagedPath));
                assert.equal(dirSt.mode & 0o777, 0o700);
            }
            return 'ok';
        };
        const created = releaseLib.publishPodcastToGitHubRelease({
            date: '2026-11-24',
            assetPath,
            expectedSha256: expectedSha,
            releaseTitle: '--draft-injection-test',
            releaseNotes: '--prerelease-injection-test',
            env: {},
            execFileSyncFn: createMock
        });
        assert.equal(created.published, true);
        assert.equal(created.action, 'created');
        assert.ok(createCalls[1].args.includes('--title=--draft-injection-test'));
        assert.ok(createCalls[1].args.includes('--notes=--prerelease-injection-test'));
        // Staged temp dir must be cleaned up after upload completes
        assert.ok(observedStagedPath);
        assert.equal(fs.existsSync(path.dirname(observedStagedPath)), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('podcast-github-release: XML 1.0 hardening (U+FFFE/surrogates/dates/stable GUID/explicit) & Wave 14.5 client feed schema', () => {
    const ep = releaseLib.buildPodcastEpisodeMetadata({
        date: '2026-11-24',
        title: '测试播客 <script>alert(1)</script> & ]]> "quote"\uFFFE\uFFFF\uD800\uDC00\uD840\uDC00',
        description: '包含恶意标签 <![CDATA[boom]]> 与控制符\x00\x07 和孤立代理\uD800',
        audioUrl: 'https://github.com/nanless/audio-paper-digest-blog/releases/download/podcast-2026-11/podcast-2026-11-24.mp3',
        audioBytes: 5242880,
        audioSha256: 'a'.repeat(64),
        durationSeconds: 332.4,
        mimeType: 'audio/mpeg',
        ttsEngine: 'indextts-2.5',
        chaptersUrl: 'https://nanless.github.io/audio-paper-digest-blog/podcast/podcast-2026-11-24.chapters.json',
        chapters: [
            { index: 0, title: '开场 & <intro>', startSec: 0, endSec: 32.5, paperId: null },
            { index: 1, title: '精选 1 ]]> StreamCodec', startSec: 32.5, endSec: 185.0, paperId: '2611.10001v1' }
        ],
        episodePageUrl: 'https://nanless.github.io/audio-paper-digest-blog/posts/2026-11-24/'
    });

    const xml = releaseLib.buildPodcastRssXml([ep], {
        title: '语音与音频论文速递 <Channel>',
        feedUrl: 'https://nanless.github.io/audio-paper-digest-blog/podcast.xml',
        explicit: true
    });

    // Date-stable GUID (no SHA suffix), propagated explicit=true, stripped U+FFFE/U+FFFF/lone surrogates
    assert.match(xml, /<guid isPermaLink="false">audio-paper-digest:podcast:2026-11-24<\/guid>/);
    assert.equal((xml.match(/<itunes:explicit>true<\/itunes:explicit>/g) || []).length, 2);
    assert.doesNotMatch(xml, /[\uFFFE\uFFFF\x00\x07]/);
    assert.equal(hasLoneSurrogate(xml), false);
    assert.match(xml, /\uD840\uDC00/); // valid surrogate pair preserved!

    // Strict XML parsing via Python ElementTree
    const parsedTitle = execFileSync(
        'bash',
        [
            path.join(ROOT, 'scripts/python-runtime.sh'),
            '-c',
            'import sys, xml.etree.ElementTree as ET; root = ET.fromstring(sys.stdin.read()); print(root.find("./channel/item/title").text)'
        ],
        { cwd: ROOT, input: xml, encoding: 'utf8' }
    ).trim();
    assert.ok(parsedTitle.includes('<script>alert(1)</script>'));
    assert.ok(parsedTitle.includes('\uD840\uDC00'));

    // Reject impossible calendar date & out-of-range year in formatRfc2822Date and control chars in URL
    assert.throws(() => releaseLib.formatRfc2822Date('2026-02-30T08:00:00Z'), /Calendar date is invalid/);
    assert.throws(() => releaseLib.formatRfc2822Date('+010000-01-01T00:00:00Z'), /Out-of-range year|Invalid/);
    assert.throws(
        () => releaseLib.buildPodcastRssXml([ep], { feedUrl: 'https://example.com/podcast\n.xml' }),
        /control characters/
    );

    // Wave 14.5 client feed schema (`paper-daily-podcast-feed`) + 120-episode cap + 2 MiB cap
    const feed = releaseLib.buildClientPodcastFeedJson([ep], { generatedAt: '2026-11-24T08:00:00+08:00' });
    assert.equal(feed.contract, 'paper-daily-podcast-feed');
    assert.equal(feed.schemaFingerprint, releaseLib.CLIENT_PODCAST_FEED_SCHEMA_FINGERPRINT);
    assert.match(feed.schemaFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(feed.generatedAt, '2026-11-24T08:00:00+08:00');
    assert.equal(feed.episodes.length, 1);
    assert.equal(feed.episodes[0].id, 'podcast-2026-11-24');
    assert.equal(feed.episodes[0].bytes, 5242880);
    assert.equal(feed.episodes[0].sha256, 'a'.repeat(64));
    assert.deepEqual(feed.episodes[0].paperIds, ['2611.10001v1']);
    assert.deepEqual(feed.episodes[0].chapters[1], {
        title: '精选 1 ]]> StreamCodec',
        startSeconds: 32.5,
        endSeconds: 185,
        paperId: '2611.10001v1'
    });

    // Verify 120-episode cap
    const manyEpisodes = [];
    for (let i = 0; i < 135; i++) {
        const dt = new Date(Date.UTC(2026, 0, 1 + i));
        const dStr = dt.toISOString().slice(0, 10);
        manyEpisodes.push({
            ...ep,
            date: dStr,
            publishedAt: `${dStr}T08:00:00+08:00`,
            audioUrl: `https://github.com/nanless/audio-paper-digest-blog/releases/download/podcast-${dStr.slice(0, 7)}/podcast-${dStr}.mp3`,
            episodePageUrl: `https://nanless.github.io/audio-paper-digest-blog/posts/${dStr}/`
        });
    }
    const cappedFeed = releaseLib.buildClientPodcastFeedJson(manyEpisodes);
    assert.equal(cappedFeed.episodes.length, 120);
    assert.ok(cappedFeed.episodes[0].date > cappedFeed.episodes[119].date);

    // Whitespace-only title/description/chapter title fall back cleanly (never empty string)
    const wsEp = releaseLib.buildPodcastEpisodeMetadata({
        ...ep,
        title: '   \t  ',
        description: '  \n ',
        chapters: [{ title: '  \n\t ', startSec: 0, endSec: 10 }]
    });
    assert.equal(wsEp.title, '音频研究日报播客 2026-11-24');
    assert.ok(wsEp.description.length > 0);
    assert.equal(wsEp.chapters[0].title, '章节 1');

    // Wave 14.5 client feed strict fail-closed invariants (default throws; skipIncompatible skips WAV cleanly)
    const wavEp = {
        ...ep,
        date: '2026-11-25',
        mimeType: 'audio/wav',
        audioUrl: 'https://github.com/nanless/audio-paper-digest-blog/releases/download/podcast-2026-11/podcast-2026-11-25.wav'
    };
    assert.throws(() => releaseLib.buildClientPodcastFeedJson([wavEp]), /audio\/mpeg/);
    assert.throws(
        () => releaseLib.buildClientPodcastFeedJson([{ ...ep, audioBytes: releaseLib.DEFAULT_MAX_AUDIO_BYTES + 1 }]),
        /audioBytes/
    );
    assert.throws(
        () => releaseLib.buildClientPodcastFeedJson([{ ...ep, durationSeconds: 86401 }]),
        /durationSeconds/
    );
    const filteredFeed = releaseLib.buildClientPodcastFeedJson([wavEp, ep], { skipIncompatible: true });
    assert.equal(filteredFeed.episodes.length, 1);
    assert.equal(filteredFeed.episodes[0].date, '2026-11-24');
});

test('publish-daily-podcast: env secret isolation, CLI validation, prior episode dedupe, --client-feed-out, and sandbox guard', () => {
    // 1. Env secret isolation check (Finding 4)
    const dirtyEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PAPER_ANALYZER_API_KEY: 'sk-super-secret-llm-key',
        KIMI_API_KEY: 'sk-kimi-secret',
        GH_TOKEN: 'ghp_super_secret_token',
        GITHUB_TOKEN: 'ghs_other_token',
        HTTP_PROXY: 'http://127.0.0.1:7890',
        PD_INDEXTTS_API_KEY: 'tts-key-123',
        PD_INDEXTTS_ENDPOINT: 'https://tts.example.com/v1/audio/speech'
    };
    const synthEnv = publisher.pickAllowedChildEnv(dirtyEnv, publisher.SYNTH_ALLOWED_ENV_KEYS);
    assert.equal(synthEnv.PAPER_ANALYZER_API_KEY, undefined);
    assert.equal(synthEnv.KIMI_API_KEY, undefined);
    assert.equal(synthEnv.GH_TOKEN, undefined);
    assert.equal(synthEnv.GITHUB_TOKEN, undefined);
    assert.equal(synthEnv.HTTP_PROXY, undefined);
    assert.equal(synthEnv.PD_INDEXTTS_API_KEY, 'tts-key-123');
    assert.equal(synthEnv.PD_INDEXTTS_ENDPOINT, 'https://tts.example.com/v1/audio/speech');

    const ghEnv = publisher.pickAllowedChildEnv(dirtyEnv, publisher.GH_ALLOWED_ENV_KEYS);
    assert.equal(ghEnv.PAPER_ANALYZER_API_KEY, undefined);
    assert.equal(ghEnv.PD_INDEXTTS_API_KEY, undefined);
    assert.equal(ghEnv.GH_TOKEN, 'ghp_super_secret_token');

    // 2. CLI validation (Finding 13)
    assert.throws(() => publisher.parseCliArgs(['--emo-alpha', 'NaN']), /Invalid --emo-alpha/);
    assert.throws(() => publisher.parseCliArgs(['--emo-alpha', '2.5']), /Invalid --emo-alpha/);
    assert.throws(() => publisher.parseCliArgs(['--max-highlights', 'abc']), /Invalid --max-highlights/);

    // 3. End-to-end --dry-run with duplicate prior episode dates + --client-feed-out + secret isolation on child process
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave14-3-e2e-'));
    try {
        const inputPath = path.join(tmpDir, 'deep-analysis-result.json');
        fs.writeFileSync(inputPath, JSON.stringify(makeSampleAnalysisData('2026-11-24'), null, 2));

        const priorDir = path.join(tmpDir, 'prior-episodes');
        fs.mkdirSync(priorDir, { recursive: true });
        const priorEp = releaseLib.buildPodcastEpisodeMetadata({
            date: '2026-11-23',
            title: '语音/音频论文速递播客 2026-11-23',
            description: '前一期测试播客。',
            audioUrl: 'https://github.com/nanless/audio-paper-digest-blog/releases/download/podcast-2026-11/podcast-2026-11-23.mp3',
            audioBytes: 123456,
            audioSha256: 'b'.repeat(64),
            durationSeconds: 180,
            mimeType: 'audio/mpeg',
            ttsEngine: 'indextts-2.5',
            chapters: []
        });
        // Write TWO files for the same prior date to verify dedupe
        fs.writeFileSync(path.join(priorDir, '01-podcast-2026-11-23.json'), JSON.stringify(priorEp));
        fs.writeFileSync(path.join(priorDir, '02-podcast-2026-11-23.json'), JSON.stringify({ ...priorEp, title: '2026-11-23 更新版' }));

        const outDir = path.join(tmpDir, 'out');
        const clientFeedOut = path.join(tmpDir, 'custom', 'podcast-feed.json');
        let capturedSynthEnv = null;
        let ghInvoked = false;

        const result = publisher.runDailyPodcastPipeline(
            {
                date: '2026-11-24',
                input: inputPath,
                outDir,
                clientFeedOut,
                episodesDir: priorDir,
                backend: 'silent-mock',
                mockSecondsPerChunk: 0.2,
                dryRun: true
            },
            {
                env: dirtyEnv,
                execFileSyncFn: (bin, args, opts) => {
                    capturedSynthEnv = opts.env;
                    assert.equal(opts.shell, false);
                    assert.ok(opts.timeout > 0);
                    return execFileSync(bin, args, opts);
                },
                ghExecFileSyncFn: () => {
                    ghInvoked = true;
                    throw new Error('gh must NOT be invoked during --dry-run');
                }
            }
        );

        assert.equal(ghInvoked, false);
        assert.ok(capturedSynthEnv);
        assert.equal(capturedSynthEnv.PAPER_ANALYZER_API_KEY, undefined);
        assert.equal(capturedSynthEnv.GH_TOKEN, undefined);
        assert.equal(result.episodeCountInFeed, 2); // 2026-11-24 + deduped 2026-11-23
        assert.equal(result.clientFeedPath, clientFeedOut);
        assert.ok(fs.existsSync(clientFeedOut));
        const savedClientFeed = JSON.parse(fs.readFileSync(clientFeedOut, 'utf8'));
        assert.equal(savedClientFeed.contract, 'paper-daily-podcast-feed');
        assert.equal(savedClientFeed.schemaFingerprint, releaseLib.CLIENT_PODCAST_FEED_SCHEMA_FINGERPRINT);
        assert.equal(savedClientFeed.episodes.length, 2);

        // Direct CLI execution with --client-feed-out
        const cliOutDir = path.join(tmpDir, 'cli-out');
        const cliClientFeed = path.join(tmpDir, 'cli-client-feed.json');
        const cliStdout = execFileSync(
            process.execPath,
            [
                path.join(ROOT, 'scripts/publish-daily-podcast.js'),
                '--date', '2026-11-24',
                '--input', inputPath,
                '--out-dir', cliOutDir,
                '--client-feed-out', cliClientFeed,
                '--backend', 'silent-mock',
                '--mock-seconds-per-chunk', '0.2',
                '--dry-run'
            ],
            { cwd: ROOT, encoding: 'utf8' }
        );
        const cliSummary = JSON.parse(cliStdout);
        assert.equal(cliSummary.clientFeedPath, cliClientFeed);
        assert.ok(fs.existsSync(cliClientFeed));

        // WAV fallback dry-run succeeds cleanly without writing non-MP3 entry into podcast-feed.json
        const wavOutDir = path.join(tmpDir, 'wav-out');
        const wavRes = publisher.runDailyPodcastPipeline({
            date: '2026-11-24',
            input: inputPath,
            outDir: wavOutDir,
            episodesDir: priorDir,
            backend: 'silent-mock',
            format: 'wav',
            mockSecondsPerChunk: 0.2,
            dryRun: true
        });
        assert.equal(wavRes.audioManifest.format, 'wav');
        assert.equal(wavRes.clientFeed.episodes.length, 1); // only prior valid MP3 kept; WAV excluded!
        assert.equal(wavRes.clientFeed.episodes[0].date, '2026-11-23');

        // Direct CLI invocation must fail closed when CODEX_SANDBOX is set
        assert.throws(() => {
            execFileSync(process.execPath, [path.join(ROOT, 'scripts/publish-daily-podcast.js'), '--help'], {
                cwd: ROOT,
                env: { ...process.env, CODEX_SANDBOX: 'seatbelt' },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            });
        }, /CODEX_SANDBOX|沙箱外/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('daily-podcast-script: handles diverse single-paper themes and never slices decimal metrics', () => {
    const diverseData = {
        batchDate: '2026-11-25',
        papers: [
            {
                arxivId: '2611.20001v1',
                title: 'Paper A',
                parsed: {
                    score: '8.5',
                    primaryTaskTag: '#音频时间定位',
                    summary: [
                        '问题与瓶颈： 给定30 s录音定位事件。',
                        '关键实验与核心代价： 在大型评测集上三台主力模型的原始得分为 0.210、0.069、0.092，改进后提升到 0.346、0.235、0.350，同时在第二组测试集上也保持稳定领先，没有出现退化。'
                    ].join('\n\n')
                },
                apiReaderPlan: { readerTitle: '音频时间定位方法 A' }
            },
            {
                arxivId: '2611.20002v1',
                title: 'Paper B',
                parsed: {
                    score: '7.9',
                    primaryTaskTag: '#音乐生成',
                    summary: '问题与瓶颈： 音乐结构建模困难。'
                },
                apiReaderPlan: { readerTitle: '音乐结构生成 B' }
            }
        ]
    };
    const script = scriptLib.buildDailyPodcastScript(diverseData, { maxHighlights: 2 });
    assert.match(script.segments[0].text, /分布比较多元/);
    assert.match(script.segments[0].text, /音频时间定位/);
    assert.doesNotMatch(script.segments[0].text, /占1篇/);
    assert.match(script.segments[1].text, /0\.210、0\.069、0\.092/);
    assert.match(script.segments[1].text, /30秒录音/);
});

test('podcast pipeline F3 fixes: RSS dedupe, Workbench branding, env blogBaseUrl->feedUrl, and TTS arrows/&lt;=', () => {
    // 1) normalizeForChineseTts handles &lt;=, &gt;=, and ASCII arrows BEFORE standalone < / >
    const arrowText = scriptLib.normalizeForChineseTts(
        '流程为 text -> speech、A => B、voice <-> text、target <- source，指标 WER &lt;= 2.5%，MOS &gt;= 4.1，且 SNR<-5 dB。'
    );
    assert.match(arrowText, /text 到 speech/);
    assert.match(arrowText, /A 到 B/);
    assert.match(arrowText, /voice 双向 text/);
    assert.match(arrowText, /target 来自 source/);
    assert.match(arrowText, /词错率 W E R 小于等于百分之2\.5/);
    assert.match(arrowText, /主观音质分 M O S 大于等于 4\.1/);
    assert.match(arrowText, /小于-5分贝/);
    assert.doesNotMatch(arrowText, /-大于|=大于|小于-(?!\d)|小于=|大于=/);

    // 2) buildGhReleaseCommands & publishPodcastToGitHubRelease use "Audio Research Workbench" (not legacy "Audio Paper Digest")
    const cmds = releaseLib.buildGhReleaseCommands({
        repo: 'nanless/audio-research-portal',
        tag: 'podcast-2026-11',
        assetPath: '/tmp/podcast-2026-11-24.mp3'
    });
    assert.ok(cmds.createArgs.some(arg => arg.includes('Audio Research Workbench')));
    assert.ok(!cmds.createArgs.some(arg => arg.includes('Audio Paper Digest')));

    // 3) buildPodcastRssXml deduplicates episodes by date (matching buildClientPodcastFeedJson) & preserves stable GUID
    const epA = releaseLib.buildPodcastEpisodeMetadata({
        date: '2026-11-24',
        title: '第一版 2026-11-24',
        description: '新版说明',
        audioUrl: 'https://github.com/nanless/audio-research-portal/releases/download/podcast-2026-11/podcast-2026-11-24.mp3',
        audioBytes: 1024,
        audioSha256: 'a'.repeat(64),
        durationSeconds: 120
    });
    const epADup = { ...epA, title: '重复旧版 2026-11-24' };
    const rss = releaseLib.buildPodcastRssXml([epA, epADup]);
    assert.equal((rss.match(/<item>/g) || []).length, 1);
    assert.match(rss, /第一版 2026-11-24/);
    assert.doesNotMatch(rss, /重复旧版 2026-11-24/);
    assert.match(rss, /<guid isPermaLink="false">audio-paper-digest:podcast:2026-11-24<\/guid>/);

    // 4) runDailyPodcastPipeline derives siteRoot and default feedUrl from env.PAPER_DIGEST_BLOG_URL
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave14-3-feedurl-'));
    try {
        const inputPath = path.join(tmpDir, 'deep-analysis-result.json');
        fs.writeFileSync(inputPath, JSON.stringify(makeSampleAnalysisData('2026-11-24'), null, 2));
        const res = publisher.runDailyPodcastPipeline(
            {
                date: '2026-11-24',
                input: inputPath,
                outDir: path.join(tmpDir, 'out'),
                backend: 'silent-mock',
                mockSecondsPerChunk: 0.2,
                dryRun: true
            },
            {
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    PAPER_DIGEST_BLOG_URL: 'https://custom.example.org/portal/posts'
                }
            }
        );
        const xml = fs.readFileSync(res.rssPath, 'utf8');
        assert.match(xml, /<link>https:\/\/custom\.example\.org\/portal\/<\/link>/);
        assert.match(xml, /href="https:\/\/custom\.example\.org\/portal\/podcast\.xml"/);
        assert.ok(
            res.releaseResult.plannedCommands.createArgs.some(arg => arg.includes('Audio Research Workbench'))
        );
        assert.ok(
            !res.releaseResult.plannedCommands.createArgs.some(arg => arg.includes('Audio Paper Digest'))
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

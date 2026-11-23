'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const probe = require('../scripts/lib/public-resource-probe.js');
const figureCrop = require('../scripts/lib/reader-pdf-figure-crop.js');
const authorParser = require('../scripts/lib/reader-author-parser.js');

const ROOT = path.resolve(__dirname, '..');

test('Track 11B Bug 1: hasOpenSourceLinks inspects first-party lines only and ignores third-party baseline repos', () => {
    const thirdPartyOnly = [
        '## 开源详情',
        '- 代码：论文中未提及代码链接',
        '- 模型权重：论文中未提及',
        '- 数据集：论文中未提及',
        '- Demo：https://my-audio-demo.github.io',
        '- 复现材料：论文中未提及',
        '- 其他资源链接：https://github.com/baseline-org/baseline-tts（不代表作者资源已开放）'
    ].join('\n');
    assert.equal(probe.hasOpenSourceLinks(thirdPartyOnly), false);

    const firstPartyCode = thirdPartyOnly.replace(
        '- 代码：论文中未提及代码链接',
        '- 代码：https://github.com/author-lab/speech-codec'
    );
    assert.equal(probe.hasOpenSourceLinks(firstPartyCode), true);

    const firstPartyGitlab = thirdPartyOnly.replace(
        '- 代码：论文中未提及代码链接',
        '- 代码：https://gitlab.com/author-lab/speech-codec'
    );
    assert.equal(probe.hasOpenSourceLinks(firstPartyGitlab), true);

    // Markdown bold/backtick labels and reserved HF/GitHub paths must be handled cleanly.
    const boldCode = thirdPartyOnly.replace(
        '- 代码：论文中未提及代码链接',
        '- **代码**：https://github.com/author-lab/speech-codec'
    );
    assert.equal(probe.hasOpenSourceLinks(boldCode), true);

    const reservedHfPaperOnly = thirdPartyOnly.replace(
        '- 代码：论文中未提及代码链接',
        '- 代码：https://huggingface.co/papers/2611.12345'
    );
    assert.equal(probe.hasOpenSourceLinks(reservedHfPaperOnly), false);
});

test('Track 11B Bug 2: isMetadataResourceDiscoveryLink unlocks verified project-page GitHub/GitLab repos while blocking templates and system routes', () => {
    const arxivOnlyPaper = { sources: ['arxiv'], arxivId: '2611.99999v1' };

    // Default strict mode remains unchanged (requires hf_github_repo match).
    assert.equal(
        probe.isMetadataResourceDiscoveryLink(arxivOnlyPaper, 'https://github.com/author-lab/my-audio-model'),
        false
    );

    // Verified project-page mode accepts real first-party GitHub & GitLab repos.
    assert.equal(
        probe.isMetadataResourceDiscoveryLink(
            arxivOnlyPaper, 'https://github.com/author-lab/my-audio-model', { allowProjectPageRepos: true }
        ),
        true
    );
    assert.equal(
        probe.isMetadataResourceDiscoveryLink(
            arxivOnlyPaper, 'https://gitlab.com/author-lab/my-audio-model', { allowProjectPageRepos: true }
        ),
        true
    );

    // Templates, *.github.io / *.gitlab.io pages, and reserved system routes stay strictly blocked.
    for (const blocked of [
        'https://github.com/nerfies/nerfies.github.io',
        'https://github.com/nerfies/nerfies.github.io.git',
        'https://github.com/eliahuhorwitz/Academic-project-page-template',
        'https://github.com/eliahuhorwitz/Academic-project-page-template.git',
        'https://github.com/some-lab/some-lab.github.io',
        'https://github.com/some-lab/some-lab.github.io.git',
        'https://gitlab.com/some-lab/some-lab.gitlab.io',
        'https://gitlab.com/some-lab/some-lab.gitlab.io.git',
        'https://github.com/user-attachments/assets',
        'https://github.com/sponsors/someone',
        'https://gitlab.com/help/user',
        'https://github.com/author-lab/my-audio-model?tab=readme',
        'https://github.com/author-lab/my-audio-model.'
    ]) {
        assert.equal(
            probe.isMetadataResourceDiscoveryLink(arxivOnlyPaper, blocked, { allowProjectPageRepos: true }),
            false,
            `Expected template/system URL to be blocked: ${blocked}`
        );
    }
});

test('Track 11B: generic commercial media root homepages are blocked and media hosts are demoted from code/dataset/model', async () => {
    assert.equal(probe.isGenericMediaRootHomepage('https://www.ximalaya.com/'), true);
    assert.equal(probe.isGenericMediaRootHomepage('https://www.xiaoyuzhoufm.com'), true);
    assert.equal(probe.isGenericMediaRootHomepage('https://www.youtube.com/'), true);
    assert.equal(probe.isGenericMediaRootHomepage('https://www.bilibili.com/'), true);
    assert.equal(probe.isGenericMediaRootHomepage('https://www.youtube.com/watch?v=abc123'), false);
    assert.equal(probe.isGenericMediaPlatformHost('https://www.youtube.com/watch?v=abc123'), true);

    const analysis = [
        '## 开源详情',
        '- 数据集：https://www.ximalaya.com/；https://www.xiaoyuzhoufm.com',
        '- 代码：https://www.youtube.com/watch?v=abc123',
        '- Demo：https://www.bilibili.com/video/BV1xx411c7mD'
    ].join('\n');
    const cands = probe.extractApiReaderResourceCandidates(analysis);
    assert.equal(cands.some(c => c.url.includes('ximalaya.com')), false, 'Bare ximalaya root must be dropped');
    assert.equal(cands.some(c => c.url.includes('xiaoyuzhoufm.com')), false, 'Bare xiaoyuzhoufm root must be dropped');
    const yt = cands.find(c => c.url.includes('youtube.com'));
    assert.ok(yt && yt.type === 'third_party', 'YouTube watch URL must be demoted from code to third_party');
    const bili = cands.find(c => c.url.includes('bilibili.com'));
    assert.ok(bili && bili.type === 'demo', 'Bilibili demo link may remain demo');

    // applyApiReaderResourceAvailability must also scrub dropped generic media root URLs from analysis text.
    const emptyIdentity = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 数据集：https://www.ximalaya.com/',
        'Podcast audio was crawled from https://www.ximalaya.com/ in this study.',
        {},
        { paper: { arxivId: '2611.77777v1', source: 'arxiv' }, proxyEnabled: false }
    );
    const synced = probe.applyApiReaderResourceAvailability(
        '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 是\n\n## 开源详情\n- 数据集：https://www.ximalaya.com/',
        emptyIdentity
    );
    assert.ok(!synced.includes('https://www.ximalaya.com/'), 'Dropped generic media root must be scrubbed from synced analysis');
});

test('Track 11B: inspectGitHubRepositoryDocumentation probes master/readme fallback and blocks coming-soon placeholders', async () => {
    const repo = 'https://github.com/org/audio-repo';
    const urls = probe.githubRepositoryReadmeCandidateUrls(repo);
    assert.equal(urls[0], 'https://raw.githubusercontent.com/org/audio-repo/main/README.md');
    assert.equal(urls[1], 'https://raw.githubusercontent.com/org/audio-repo/master/README.md');

    const requested = [];
    const masterDoc = await probe.inspectGitHubRepositoryDocumentation(repo, {
        proxyEnabled: false,
        requestImpl: async (url) => {
            requested.push(url);
            if (url.endsWith('/master/README.md')) {
                const body = '# Audio Repo\n## Installation\npip install -r requirements.txt\n## Inference\npython infer.py\n## Fine-tuning\npython train.py\n';
                return {
                    status: 200,
                    headers: new Map([['content-type', 'text/plain; charset=utf-8']]),
                    arrayBuffer: async () => Buffer.from(body)
                };
            }
            return { status: 404, headers: new Map(), arrayBuffer: async () => Buffer.alloc(0) };
        }
    });
    assert.deepEqual(requested, urls.slice(0, 2));
    assert.ok(masterDoc);
    assert.equal(masterDoc.completeness, 'complete');
    assert.equal(masterDoc.sourceUrl, urls[1]);
    assert.equal(probe.validRepositoryDocumentationEvidence(masterDoc, repo), true);

    // Coming-soon placeholder README (including longer ~1200-char abstract+BibTeX boilerplate) must never achieve complete documentation.
    assert.equal(probe.isPlaceholderComingSoonReadme('# My Audio Model\n## Installation\nCode coming soon! Stay tuned.'), true);
    const longPlaceholder = [
        '# AudioModel: Scalable Speech Modeling',
        'Abstract: ' + 'This paper introduces a novel framework for acoustic modeling across benchmarks. '.repeat(14),
        '## Installation\nCode will be released soon.',
        '## Inference\nComing soon.',
        '## Training\nStay tuned.'
    ].join('\n\n');
    assert.ok(longPlaceholder.length > 1000 && longPlaceholder.length < 2500);
    assert.equal(probe.isPlaceholderComingSoonReadme(longPlaceholder), true);
    const placeholderDoc = await probe.inspectGitHubRepositoryDocumentation(repo, {
        proxyEnabled: false,
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/plain']]),
            arrayBuffer: async () => Buffer.from('# My Audio Model\n## Installation\n## Inference\n## Training\nCode will be released soon! Stay tuned.')
        })
    });
    assert.ok(placeholderDoc);
    assert.equal(placeholderDoc.completeness, 'partial');
    assert.deepEqual(placeholderDoc.capabilities, { installation: false, inference: false, fineTuning: false });
});

test('Track 11B: daily buildApiReaderResourceIdentity recovers verbatim source repository URLs missed by LLM', async () => {
    const sourceText = 'Our code and checkpoints are publicly released at https://github.com/audio-team/wave11-codec for reproducibility.';
    const analysis = '## 开源详情\n- 代码：论文中未提及代码链接\n- 模型权重：论文中未提及\n- 数据集：论文中未提及\n- Demo：论文中未提及\n- 复现材料：论文中未提及\n- 其他资源链接：未提及';
    const identity = await probe.buildApiReaderResourceIdentity(analysis, sourceText, {}, {
        paper: { arxivId: '2611.88888v1', source: 'arxiv' },
        proxyEnabled: false,
        verifyUrlImpl: async (url) => ({
            originalUrl: url,
            finalUrl: url,
            redirects: [],
            status: 200,
            availability: 'available',
            retryable: false
        }),
        documentationInspector: async () => null
    });
    assert.ok(identity.resources.length >= 1);
    assert.ok(identity.resources.some(r => r.type === 'code' && r.originalUrl === 'https://github.com/audio-team/wave11-codec'));
    assert.ok(identity.resources.some(r => r.type === 'model' && r.originalUrl === 'https://github.com/audio-team/wave11-codec'));
    assert.ok(identity.resources.every(r => r.originalUrl === 'https://github.com/audio-team/wave11-codec'));
});

test('Track 11B: conference-postprocess aggregateUrl includes /audio-paper-digest-blog base path', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/conference-postprocess.js'), 'utf8');
    assert.match(src, /aggregateUrl:\s*`\/audio-paper-digest-blog\/posts\/conference-\$\{conferenceId\}\/`/);
});

test('Track 11B: reader-pdf-figure-crop surfaces extractError instead of silently swallowing failures', () => {
    const corrupt = Buffer.from('%PDF-1.4\nthis is definitely not a valid xref table');
    const out = figureCrop.extractPdfStructuredArtifactsSync(corrupt, '2611.99999v1');
    assert.equal(typeof out.pdfSha256, 'string');
    assert.deepEqual(out.figures, []);
    assert.deepEqual(out.tables, []);
    assert.equal(typeof out.extractError, 'string');
    assert.ok(out.extractError.length > 0, 'Corrupt PDF must surface non-empty extractError');
});

test('Track 11B: reader-author-parser KNOWN_LOCATION_TAIL_FULL_RE covers newly synced countries/states', () => {
    const jsSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/reader-author-parser.js'), 'utf8');
    for (const token of ['United\\s+Arab\\s+Emirates', 'Gujarat', 'Maharashtra', 'El\\s+Salvador', 'Saudi\\s+Arabia']) {
        assert.ok(jsSrc.includes(token), `Expected synced location tail token: ${token}`);
    }
    assert.equal(typeof authorParser.sanitizeReaderAffiliationValue, 'function');
});

test('Track 11B R2: applyApiReaderResourceAvailability scrubs bare media root without corrupting full URLs on same host, and hasOpenSourceLinks handles backtick/www/http URLs', async () => {
    // 1. hasOpenSourceLinks handles backtick-wrapped, www., and http:// first-party repo URLs
    assert.equal(probe.hasOpenSourceLinks('## 开源详情\n- 代码：`https://github.com/org/audio-repo`'), true);
    assert.equal(probe.hasOpenSourceLinks('## 开源详情\n- 代码：https://www.github.com/org/audio-repo'), true);
    assert.equal(probe.hasOpenSourceLinks('## 开源详情\n- 代码：http://github.com/org/audio-repo'), true);

    // 2. Scrubbing a bare YouTube root in 开源详情 MUST NOT shred https://www.youtube.com/watch?v=abc123 anywhere
    const sourceText = 'Demo video is available at https://www.youtube.com/watch?v=abc123 and podcasts from https://www.youtube.com/.';
    const analysis = [
        '## 细节详述',
        '演示视频位于 https://www.youtube.com/watch?v=abc123。',
        '',
        '## 开源详情',
        '- 代码：未提及',
        '- 数据集：https://www.youtube.com/',
        '- Demo：https://www.youtube.com/watch?v=abc123',
        '',
        '## 机器摘要',
        '- has_code: 否',
        '- has_model: 否',
        '- has_dataset: 否'
    ].join('\n');
    const identity = await probe.buildApiReaderResourceIdentity(analysis, sourceText, {}, {
        paper: { arxivId: '2611.77777v1', source: 'arxiv' },
        proxyEnabled: false,
        verifyUrlImpl: async (url) => ({
            originalUrl: url,
            finalUrl: url,
            redirects: [],
            status: 200,
            availability: 'available',
            retryable: false
        }),
        documentationInspector: async () => null
    });
    const updated = probe.applyApiReaderResourceAvailability(analysis, identity);
    assert.ok(updated.includes('演示视频位于 https://www.youtube.com/watch?v=abc123。'),
        'Full YouTube watch URL in 细节详述 must stay completely intact');
    assert.ok(updated.includes('https://www.youtube.com/watch?v=abc123'),
        'Full YouTube watch URL in 开源详情 must stay completely intact');
    assert.ok(!/数据集：https:\/\/www\.youtube\.com\/(?=\s|$)/.test(updated),
        'Bare YouTube root in 数据集 line must be scrubbed');
    assert.ok(!updated.includes('精确链接watch?v=abc123'),
        'Bare root scrub must never corrupt full URLs sharing the same host prefix');
});

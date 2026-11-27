'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function mkTempDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function initGitRepo(dir, remoteUrl = 'https://github.com/nanless/audio-research-portal.git') {
    const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test User']);
    git(['config', 'user.email', 'test@example.com']);
    git(['remote', 'add', 'origin', remoteUrl]);
    return git;
}

// =========================================================================
// 1. Official Conference Acquisition Extended: Zenodo ?download=1 & Retry
// =========================================================================
test('R1-W3: official-conference-acquisition-extended 允许 Zenodo ?download=1 PDF 且对 429/503/网络错误有界重试', async () => {
    const ext = require('../scripts/lib/official-conference-acquisition-extended.js');
    const ismir = ext.providerFor('ismir-2026');

    const zenodoDownloadUrl = 'https://zenodo.org/records/1234567/files/paper-01.pdf?download=1';
    assert.equal(ext.validateUrlForProvider(ismir, zenodoDownloadUrl, 'pdf'), zenodoDownloadUrl);
    assert.throws(
        () => ext.validateUrlForProvider(ismir, 'https://zenodo.org/records/1234567/files/paper-01.pdf?download=1&extra=1', 'pdf'),
        /仅允许空查询或 \?download=1/
    );

    const catalog = ext.parseZenodoRecordsPages([{
        hits: {
            hits: [{
                id: 1234567,
                metadata: { title: 'Audio Diffusion on Zenodo', creators: [{ name: 'Alice' }], description: 'Abstract' },
                files: [{ key: 'paper-01.pdf', links: { download: zenodoDownloadUrl } }]
            }]
        }
    }], ismir);
    assert.equal(catalog.papers.length, 1);
    assert.equal(catalog.papers[0].pdfUrl, zenodoDownloadUrl);

    // Transient 429 + 503 + ECONNRESET recover cleanly with jittered backoff
    const sleeps = [];
    let calls = 0;
    const okJson = Buffer.from(JSON.stringify({ hits: { hits: [] } }));
    const fetched = await ext.fetchOfficialExtended({
        provider: ismir,
        url: ismir.indexUrl,
        kind: 'api',
        maxBytes: 1024 * 1024,
        maxRetries: 3
    }, {
        sleep: async ms => { sleeps.push(ms); },
        random: () => 0.5,
        retryBaseDelayMs: 10,
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return { status: 429, headers: { get: k => k === 'retry-after' ? '1' : null }, body: { cancel: async () => {} } };
            if (calls === 2) return { status: 503, headers: { get: () => null }, body: { cancel: async () => {} } };
            if (calls === 3) throw Object.assign(new Error('TLS handshake reset'), { code: 'ECONNRESET' });
            return {
                status: 200,
                headers: { get: k => k === 'content-type' ? 'application/json' : null },
                arrayBuffer: async () => okJson
            };
        }
    });
    assert.equal(calls, 4);
    assert.equal(sleeps.length, 3);
    assert.equal(fetched.responseStatus, 200);

    // Permanent 404 MUST NOT retry
    let permanentCalls = 0;
    await assert.rejects(ext.fetchOfficialExtended({
        provider: ismir,
        url: ismir.indexUrl,
        kind: 'api',
        maxBytes: 1024 * 1024,
        maxRetries: 3
    }, {
        sleep: async () => {},
        fetchImpl: async () => {
            permanentCalls += 1;
            return { status: 404, headers: { get: () => null }, body: { cancel: async () => {} } };
        }
    }), /HTTP 404/);
    assert.equal(permanentCalls, 1);
});

// =========================================================================
// 2. Historical Rewrite: OpenReview Retry, CLI Regex, Outdated Audit, Review Order & Status Ancestry
// =========================================================================
test('R1-W3: historical-openreview-pdf-source 对瞬时 503 与网络错误有界重试', async () => {
    const orApi = require('../scripts/lib/historical-openreview-pdf-source.js');
    const forumId = 'AbCdEf1234';
    const url = orApi.pdfUrlForForum(forumId);
    const sleeps = [];
    let calls = 0;
    const pdfBytes = Buffer.from('%PDF-1.7\nopenreview-recovered');
    const res = await orApi.defaultFetchPdf({ url, forumId, maxRetries: 3 }, {
        detectProxy: () => 'http://127.0.0.1:7890',
        createDispatcher: () => ({}),
        sleep: async ms => { sleeps.push(ms); },
        random: () => 0.5,
        retryBaseDelayMs: 10,
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return { status: 503, headers: { get: () => null }, body: { cancel: async () => {} } };
            if (calls === 2) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
            return {
                status: 200,
                headers: { get: k => k === 'content-type' ? 'application/pdf' : null },
                arrayBuffer: async () => pdfBytes
            };
        }
    });
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2);
    assert.equal(res.bytes.toString(), pdfBytes.toString());
});

test('R1-W3: historical-direct-rewrite-run 泛化会议 paperId 正则支持任意官方来源类型', () => {
    const runCli = require('../scripts/historical-direct-rewrite-run.js');
    const parsed = runCli.parseArgs([
        '--dry-run', '--plan', '/tmp/plan.json', '--queue', 'conference',
        '--paper-ids', 'conference:emnlp:2026:acl-id:2026.emnlp-main.1,conference:ismir:2026:zenodo-id:123456'
    ]);
    assert.deepEqual(parsed.paperIds, [
        'conference:emnlp:2026:acl-id:2026.emnlp-main.1',
        'conference:ismir:2026:zenodo-id:123456'
    ]);
});

test('R1-W3: historical-outdated-audit 不误报 0 篇空日汇总且会议推荐命令包含完整链路', t => {
    const audit = require('../scripts/historical-outdated-audit.js');
    const blogRepo = mkTempDir(t, 'audit-empty-day-');
    const postsDir = path.join(blogRepo, 'content', 'posts');
    fs.mkdirSync(postsDir, { recursive: true });
    const standards = audit.currentStandards();

    // Valid 0-paper empty daily summary matching publish-to-blog.py:_render_empty_digest_index
    fs.writeFileSync(path.join(postsDir, '2026-11-26.md'), [
        '---',
        'title: "音频研究日报 2026-11-26"',
        'date: 2026-11-26',
        'draft: false',
        'tags: []',
        'categories: ["论文速递"]',
        'description: "今日没有新论文"',
        'layout: "posts"',
        'paper_digest_pipeline_owned: true',
        'paper_digest_page_type: index',
        `paper_digest_reader_quality: "${standards.readerQualityContract}"`,
        '---',
        '',
        '# 音频研究日报 2026-11-26',
        '',
        '共分析 **0** 篇论文',
        '',
        '今日没有新论文。',
        ''
    ].join('\n'));

    // One outdated conference summary to trigger conference recommended commands
    fs.writeFileSync(path.join(postsDir, 'conference-icassp-2026.md'), [
        '---',
        'title: "ICASSP 2026"',
        'date: 2026-05-01',
        'draft: false',
        'categories: ["icassp-2026"]',
        'paper_digest_page_type: index',
        '---',
        '',
        'Old conference summary.',
        ''
    ].join('\n'));

    const report = audit.auditBlogPosts({ blogRepo, standards });
    const emptyPage = report.outdatedPages.find(p => p.path === 'content/posts/2026-11-26.md');
    assert.equal(emptyPage, undefined, 'valid 0-paper empty daily summary must not be flagged as outdated');

    const confCmd = report.recommendedCommands.find(c => c.label.includes('会议'));
    assert.ok(confCmd, 'conference recommended command block should exist');
    const joined = confCmd.steps.join('\n');
    for (const expected of [
        'history:sources -- --apply --plan <PLAN_JSON> --queue conference',
        'history:run -- --apply --plan <PLAN_JSON> --queue conference',
        'history:aggregate -- aggregate --apply',
        'history:publication -- plan --apply',
        'history:publication -- generate --apply',
        'history:publication -- review --apply',
        'history:publication -- publish --apply',
        'verify:web -- --historical-publication-id <UUID> --wait'
    ]) {
        assert.ok(joined.includes(expected), `conference CLI sequence missing: ${expected}`);
    }
});

test('R1-W3: historical-direct-review.py 单篇先于汇总审查且将零警告图片通过 verified_paper_images 复用', t => {
    const tmp = mkTempDir(t, 'hist-review-order-');
    const script = `
import hashlib, json, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path('scripts').resolve()))
import importlib.util
spec = importlib.util.spec_from_file_location('hdr', Path('scripts/historical-direct-review.py').resolve())
hdr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hdr)

root = Path(sys.argv[1])
staged = root / 'staged'
ckpt = root / 'ckpt'
(staged / 'content' / 'posts').mkdir(parents=True)
ckpt.mkdir(parents=True)
img_url = 'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/demo/fig1.png'

paper_md = f'---\\ntitle: "Paper A"\\npaper_digest_page_type: paper\\n---\\n\\nBody.\\n\\n![Fig1]({img_url})\\n'
sum_md = f'---\\ntitle: "Summary 2026-11-27"\\npaper_digest_page_type: index\\n---\\n\\nSummary.\\n\\n![Fig1]({img_url})\\n'
(staged / 'content/posts/2026-11-27-paper-a.md').write_text(paper_md, encoding='utf-8')
(staged / 'content/posts/2026-11-27.md').write_text(sum_md, encoding='utf-8')

order = []
seen_verified = {}
seen_notes = {}

class FakeMod:
    @staticmethod
    def get_blog_review_chunk_chars(): return 20000
    @staticmethod
    def split_review_content(content, _chars): return [content]
    @staticmethod
    def _llm_review_post_chunk(chunk, title='', required=False, chunk_label='1/1', *, source_figure_note=''):
        order.append(('text', title))
        seen_notes[title] = source_figure_note
        return True, [], chunk
    @staticmethod
    def parse_markdown_images(content):
        return [{'alt': 'Fig1', 'url': img_url}] if img_url in content else []
    @staticmethod
    def multimodal_review_images(content, title='', required=False, image_concurrency=2,
                                 paper=None, publication_figure_contexts=None,
                                 verified_paper_images=None, passed_image_registry=None):
        order.append(('image', title))
        seen_verified[title] = dict(verified_paper_images or {})
        if passed_image_registry is not None:
            passed_image_registry[img_url] = 'a' * 64
        return True, []

# Deliberately put summary FIRST in input list to prove paper-before-summary scheduling!
pages = [
    {'path': 'content/posts/2026-11-27.md', 'sha256': hashlib.sha256(sum_md.encode()).hexdigest(), 'paperId': 'index:2026-11-27'},
    {'path': 'content/posts/2026-11-27-paper-a.md', 'sha256': hashlib.sha256(paper_md.encode()).hexdigest(),
     'paperId': 'arxiv:2611.00001', 'sourceFigureNote': '来源图注说明测试'},
]
protocol = {'budgets': {'chunkChars': 20000}}
res = hdr.review_pages_bounded(FakeMod, pages, staged, ckpt, protocol, concurrency=4)
print(json.dumps({'order': order, 'seen_verified': seen_verified, 'seen_notes': seen_notes, 'count': len(res)}, ensure_ascii=False))
`;
    const run = spawnSync('bash', [
        path.resolve(__dirname, '../scripts/python-runtime.sh'),
        '-c', script, tmp
    ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout.trim());
    assert.equal(out.count, 2);
    // Paper text+image MUST complete before Summary text+image
    const paperImgIdx = out.order.findIndex(([k, title]) => k === 'image' && title === 'Paper A');
    const sumTextIdx = out.order.findIndex(([k, title]) => k === 'text' && title === 'Summary 2026-11-27');
    assert.ok(paperImgIdx >= 0 && sumTextIdx > paperImgIdx, `expected Paper A before Summary, got ${JSON.stringify(out.order)}`);
    assert.equal(out.seen_notes['Paper A'], '来源图注说明测试');
    assert.deepEqual(out.seen_verified['Summary 2026-11-27'], {
        'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/demo/fig1.png': 'a'.repeat(64)
    });
});

test('R1-W3: historical-direct-publication status 在 origin/main 前进且保留目标文件字节与仓库改名时仍通过，篡改时阻断', t => {
    const pubApi = require('../scripts/lib/historical-direct-publication.js');
    const root = mkTempDir(t, 'hist-pub-ancestry-');
    const outputRoot = path.join(root, 'pub-root');
    const blogRepo = path.join(root, 'blog');
    const oldUrl = 'https://github.com/nanless/audio-paper-digest-blog.git';
    const newUrl = 'https://github.com/nanless/audio-research-portal.git';
    const git = initGitRepo(blogRepo, oldUrl);

    const pagePath = 'content/posts/2026-08-08-paper.md';
    fs.mkdirSync(path.dirname(path.join(blogRepo, pagePath)), { recursive: true });
    const oldBytes = Buffer.from('---\ntitle: "Old"\n---\nOld\n');
    fs.writeFileSync(path.join(blogRepo, pagePath), oldBytes);
    fs.writeFileSync(path.join(blogRepo, 'hugo.yaml'), 'title: test\n');
    git(['add', '.']);
    git(['commit', '--no-gpg-sign', '-m', 'base']);
    const baseHead = git(['rev-parse', 'HEAD']);

    const nextBytes = Buffer.from(
        '---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\n'
        + `paper_digest_tags_contract: "paper-tag-flat-tags"\npaper_digest_tags_registry_sha256: "${'b'.repeat(64)}"\n`
        + 'paper_digest_tags_registry_version: "v1"\ndraft: false\n---\n\n# Body\n\n![图1](https://example.com/a.png)\n'
    );
    const now = '2026-11-27T08:00:00.000Z';
    const pubId = '33333333-3333-4333-8333-333333333333';
    const planSha = 'a'.repeat(64);
    const visualDisposition = pubApi.buildVisualDisposition({
        plan: { planSha256: planSha },
        mode: 'waived',
        scope: 'full-history-publication',
        reason: 'standing no visuals',
        createdAt: now
    });
    const authority = {
        plan: { planSha256: planSha },
        retainedPages: [],
        projection: {
            retainedPageSetSha256: pubApi.stableHash([]),
            pageCoverageSha256: pubApi.stableHash({ inventoryPageCount: 1, coveredPageCount: 1, retainedUnchangedPageCount: 0 }),
            pageCoverage: { inventoryPageCount: 1, coveredPageCount: 1, retainedUnchangedPageCount: 0 }
        },
        visualDisposition,
        publicationScope: 'full-history',
        selectedPaperIds: [],
        artifacts: [{
            path: pagePath,
            sha256: sha256(nextBytes),
            baselineSha256: sha256(oldBytes),
            producers: [{ kind: 'direct-page-staging', paperId: 'arxiv:2608.00001' }],
            source: { kind: 'direct-page-staging', directory: 'x', stagedPath: 'y' }
        }],
        proof: {
            plan: { planSha256: planSha },
            retainedDisposition: {
                retainedPageSetSha256: pubApi.stableHash([]),
                pageCoverageSha256: pubApi.stableHash({ inventoryPageCount: 1, coveredPageCount: 1, retainedUnchangedPageCount: 0 }),
                pageCoverage: { inventoryPageCount: 1, coveredPageCount: 1, retainedUnchangedPageCount: 0 },
                rewrittenPageCount: 1
            },
            proofSha256: 'c'.repeat(64)
        },
        roots: { stagingRoot: root, aggregateRoot: root }
    };
    const oldIdentity = pubApi.stableHash({ remote: 'origin', pushUrl: oldUrl });
    const blogState = () => ({
        head: baseHead, treeOid: baseHead, contentTreeOid: baseHead,
        branch: 'main', clean: true, remoteName: 'origin',
        remoteIdentitySha256: oldIdentity, remoteOid: baseHead,
        hugoConfig: { path: 'hugo.yaml', sha256: sha256(fs.readFileSync(path.join(blogRepo, 'hugo.yaml'))) }
    });
    let pubCommit = null;
    const deps = {
        loadAuthority: () => authority,
        blogState,
        gitBlob: (_repo, _head, p) => (p === pagePath ? oldBytes : null),
        sourceBytes: () => nextBytes,
        validatePublishedTagCatalog: () => ({ valid: true }),
        hugoVersion: 'hugo v0.fixture',
        hugoGate: () => ({ status: 'passed', engine: 'hugo', version: 'hugo v0.fixture' }),
        semanticReview: ({ loadedPlan, generation, protocol }) => {
            // Confirm generate() populated paperId + sourceFigureNote on manifest!
            assert.equal(generation.manifest.files[0].paperId, 'arxiv:2608.00001');
            assert.match(generation.manifest.files[0].sourceFigureNote, /来源图注说明/);
            const page = { path: pagePath, sha256: sha256(nextBytes), textChunks: 1, imageCount: 1, imageReviewMode: 'multimodal', passed: true, issues: [] };
            page.resultSha256 = pubApi.stableHash(page);
            const body = {
                ...require('../scripts/lib/protocol-codec').recordHeader('historical-direct-semantic-review', 'historical-direct-semantic-review'),
                publicationId: loadedPlan.plan.publicationId,
                generationSha256: generation.manifest.generationSha256,
                reviewProtocolFingerprint: protocol,
                semanticProtocol: pubApi.semanticReviewProtocol(),
                results: [page],
                resultSetSha256: pubApi.stableHash([page]),
                passed: true
            };
            return { receipt: { ...body, semanticReviewSha256: pubApi.stableHash(body) }, fileSha256: '7'.repeat(64) };
        },
        validateActivatedWorktree: () => true,
        now: () => now,
        prePublishRemote: () => ({ branch: 'main', localHead: baseHead, remoteIdentitySha256: oldIdentity, remoteOid: baseHead }),
        publishGit: () => {
            git(['add', pagePath]);
            git(['commit', '--no-gpg-sign', '-m', 'publish page']);
            pubCommit = git(['rev-parse', 'HEAD']);
            return pubCommit;
        },
        pushAndVerify: () => ({ remoteName: 'origin', remoteIdentitySha256: oldIdentity, remoteVerifiedOid: pubCommit })
    };
    const plan = pubApi.buildPlan({ publicationId: pubId, authorityOptions: {}, blogRepo, createdAt: now }, deps);
    pubApi.writePlan({ outputRoot, plan });
    pubApi.generate({ outputRoot, publicationId: pubId, authorityOptions: {}, blogRepo, apply: true }, deps);
    pubApi.review({ outputRoot, publicationId: pubId, blogRepo, apply: true }, deps);
    pubApi.activate({ outputRoot, publicationId: pubId, blogRepo, apply: true }, deps);
    pubApi.publish({ outputRoot, publicationId: pubId, blogRepo, apply: true }, deps);

    // Advance main with an unrelated file AND rename remote from audio-paper-digest-blog -> audio-research-portal
    git(['remote', 'set-url', 'origin', newUrl]);
    fs.writeFileSync(path.join(blogRepo, 'README.md'), 'later daily commit\n');
    git(['add', 'README.md']);
    git(['commit', '--no-gpg-sign', '-m', 'later unrelated commit']);
    const advancedOid = git(['rev-parse', 'HEAD']);

    // Write matching online-verification.json
    fs.writeFileSync(path.join(outputRoot, pubId, 'online-verification.json'), JSON.stringify({
        publicationId: pubId, planSha256: plan.planSha256, remoteVerifiedOid: pubCommit,
        pagesDeployVerified: true, webVerified: true, checked: 1, ok: 1, failed: 0, verifiedAt: now
    }, null, 2));

    const newIdentity = pubApi.stableHash({ remote: 'origin', pushUrl: newUrl });
    const statusOk = pubApi.status({ outputRoot, publicationId: pubId, blogRepo, liveRemote: true }, {
        liveRemote: () => ({ remoteName: 'origin', pushUrl: newUrl, remoteIdentitySha256: newIdentity, remoteOid: advancedOid })
    });
    assert.equal(statusOk.complete, true, JSON.stringify(statusOk));
    assert.equal(statusOk.stages.publication.complete, true);

    // Now tamper with the published page in a further commit -> status MUST fail closed!
    fs.writeFileSync(path.join(blogRepo, pagePath), 'tampered content\n');
    git(['add', pagePath]);
    git(['commit', '--no-gpg-sign', '-m', 'tamper target']);
    const tamperedOid = git(['rev-parse', 'HEAD']);
    const statusTampered = pubApi.status({ outputRoot, publicationId: pubId, blogRepo, liveRemote: true }, {
        liveRemote: () => ({ remoteName: 'origin', pushUrl: newUrl, remoteIdentitySha256: newIdentity, remoteOid: tamperedOid })
    });
    assert.equal(statusTampered.complete, false);
    assert.equal(statusTampered.stages.publication.complete, false);
    assert.match(statusTampered.stages.publication.error, /已修改已发布目标文件/);
});

// =========================================================================
// 3. Daily Podcast Hardening: eligibility, recursive episodes, chapters release upload & portal sync
// =========================================================================
test('R1-W3: daily-podcast-script 排除 abstract_only、待核验事实义务及空/不完整 Reader 记录', () => {
    const podcastScript = require('../scripts/lib/daily-podcast-script.js');
    const base = {
        arxivId: '2611.00001',
        title: 'Speech Model',
        parsed: { score: 8.5, tags: ['语音合成'] },
        apiReaderPlan: { readerTitle: '语音模型', oneSentenceThesis: '提出新模型' }
    };
    assert.equal(podcastScript.isEligibleAnalyzedPaper(base), true);
    assert.equal(podcastScript.isEligibleAnalyzedPaper({ ...base, analysisMode: 'abstract_only' }), false);
    assert.equal(podcastScript.isEligibleAnalyzedPaper({ ...base, analysisFactReviewObligation: { status: 'pending' } }), false);
    assert.equal(podcastScript.isEligibleAnalyzedPaper({ ...base, apiReaderArticle: '   ' }), false);
    assert.equal(podcastScript.isEligibleAnalyzedPaper({ ...base, apiReaderArticle: 'valid', apiReaderArticleSha256: '0'.repeat(64) }), false);
    assert.equal(podcastScript.isEligibleAnalyzedPaper({ ...base, analysisManifest: { status: 'incomplete' } }), false);
});

test('R1-W3: publish-daily-podcast 递归扫描子目录剧集、上传 chapters.json 到 Release 并同步 --portal-repo', t => {
    const pub = require('../scripts/publish-daily-podcast.js');
    const tmp = mkTempDir(t, 'podcast-r1w3-');
    const episodesRoot = path.join(tmp, 'episodes-root');
    const priorSubDir = path.join(episodesRoot, '2026-11-26');
    fs.mkdirSync(priorSubDir, { recursive: true });
    fs.writeFileSync(path.join(priorSubDir, 'podcast-2026-11-26.episode.json'), JSON.stringify({
        contract: 'daily-podcast-episode',
        version: 1,
        date: '2026-11-26',
        title: '每日音频论文播客 · 2026-11-26',
        description: '前一日播客',
        audioUrl: 'https://github.com/nanless/audio-research-portal/releases/download/podcast-2026-11/podcast-2026-11-26.mp3',
        audioBytes: 12345,
        audioSha256: '1'.repeat(64),
        durationSeconds: 120,
        mimeType: 'audio/mpeg',
        ttsEngine: 'mock',
        chapters: [{ title: '开场', startSeconds: 0, endSeconds: 30 }],
        episodePageUrl: 'https://nanless.github.io/audio-research-portal/posts/2026-11-26/',
        publishedAt: '2026-11-26T08:00:00+08:00',
        releaseTag: 'podcast-2026-11',
        githubRepo: 'nanless/audio-research-portal',
        scriptSha256: '2'.repeat(64),
        publishStatus: 'published'
    }));

    // Verify recursive loadExistingEpisodes finds nested <dateStr>/*.episode.json
    const loaded = pub.loadExistingEpisodes(episodesRoot, '2026-11-27');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].date, '2026-11-26');

    const inputPath = path.join(tmp, 'deep.json');
    fs.writeFileSync(inputPath, JSON.stringify({
        batchDate: '2026-11-27',
        papers: [{
            arxivId: '2611.12345',
            title: 'Neural Audio Codec 2.0',
            parsed: { score: 8.8, tags: ['音频编解码'], primaryTask: '音频编解码' },
            apiReaderPlan: { readerTitle: '神经音频编解码 2.0', oneSentenceThesis: '大幅降低码率并保持音质' }
        }]
    }));
    const outDir = path.join(episodesRoot, '2026-11-27');
    const portalRepo = path.join(tmp, 'portal-repo');
    fs.mkdirSync(portalRepo, { recursive: true });
    const mp3Bytes = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00mock-mp3-data');
    const ghCalls = [];
    const res = pub.runDailyPodcastPipeline({
        date: '2026-11-27',
        input: inputPath,
        outDir,
        episodesDir: episodesRoot,
        portalRepo,
        repo: 'nanless/audio-research-portal',
        backend: 'silent-mock'
    }, {
        execFileSyncFn: (_bin, args) => {
            const outIdx = args.indexOf('--output');
            const manIdx = args.indexOf('--manifest-out');
            fs.writeFileSync(args[outIdx + 1], mp3Bytes);
            fs.writeFileSync(args[manIdx + 1], JSON.stringify({
                audioPath: args[outIdx + 1],
                audioBytes: mp3Bytes.length,
                audioSha256: sha256(mp3Bytes),
                durationSeconds: 95,
                format: 'mp3',
                mimeType: 'audio/mpeg',
                ttsEngine: 'silent-mock',
                chapters: [{ title: '开场导览', startSeconds: 0, endSeconds: 95 }]
            }));
            return '';
        },
        ghExecFileSyncFn: (bin, args) => {
            ghCalls.push({ bin, args });
            return '';
        }
    });

    assert.equal(res.episodeCountInFeed, 2);
    assert.equal(res.chaptersUploaded, true);
    assert.equal(
        res.episodeMetadata.chaptersUrl,
        'https://github.com/nanless/audio-research-portal/releases/download/podcast-2026-11/podcast-2026-11-27.chapters.json'
    );
    assert.ok(ghCalls.some(c => c.args.includes('upload') && c.args.some(a => String(a).endsWith('.chapters.json'))));
    assert.ok(fs.existsSync(path.join(portalRepo, 'static', 'feeds', 'podcast.xml')));
    assert.ok(fs.existsSync(path.join(portalRepo, 'data', 'podcast-episodes.json')));
    assert.ok(fs.existsSync(path.join(portalRepo, 'static', 'client', 'podcast', 'feed.json')));
    const portalData = JSON.parse(fs.readFileSync(path.join(portalRepo, 'data', 'podcast-episodes.json'), 'utf8'));
    assert.equal(portalData.episodes.length, 2);
    assert.equal(portalData.episodes[0].date, '2026-11-27');
    const portalRss = fs.readFileSync(path.join(portalRepo, 'static', 'feeds', 'podcast.xml'), 'utf8');
    assert.ok(portalRss.includes(res.episodeMetadata.chaptersUrl));
});

// =========================================================================
// 4. verify-web.js + publish-finish.js + digest-run-report.js Unified Closure
// =========================================================================
test('R1-W3: verify-web 日更前置凭证绑定、自动解析 deployOid、后续提交祖先核验、瞬时 503 重试与 digest-run-report 闭环', async t => {
    const verifyWeb = require('../scripts/verify-web.js');
    const finish = require('../scripts/publish-finish.js');
    const reportMod = require('../scripts/digest-run-report.js');
    const protocols = require('../scripts/lib/protocol-codec.js');

    // (a) fetchPage retries 502/503/504 & network resets and succeeds
    let fetchAttempts = 0;
    const sleeps = [];
    const fetched = await verifyWeb.fetchPage('https://nanless.github.io/audio-research-portal/posts/2026-11-27/', {
        maxRetries: 3,
        retryBaseDelayMs: 5,
        sleep: async ms => { sleeps.push(ms); },
        random: () => 0.5,
        fetchImpl: async () => {
            fetchAttempts += 1;
            if (fetchAttempts === 1) return { status: 503, body: { cancel: async () => {} } };
            if (fetchAttempts === 2) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
            return {
                status: 200,
                url: 'https://nanless.github.io/audio-research-portal/posts/2026-11-27/',
                text: async () => '<html><head><title>音频研究日报 2026-11-27 | 音频研究门户</title></head><body>ok</body></html>'
            };
        }
    });
    assert.equal(fetchAttempts, 3);
    assert.equal(sleeps.length, 2);
    assert.equal(fetched.status, 200);

    // (b) Daily mode: upfront receipt validation, auto-resolved deployOid, AND descendant commit binding
    const tmp = mkTempDir(t, 'verify-web-r1w3-');
    const currentDir = path.join(tmp, 'current');
    const blogRepo = path.join(tmp, 'blog');
    fs.mkdirSync(currentDir, { recursive: true });
    const git = initGitRepo(blogRepo);

    const date = '2026-11-27';
    const indexRel = `content/posts/${date}.md`;
    const indexBytes = Buffer.from(`---\ntitle: "音频研究日报 ${date}"\n---\nBody\n`);
    fs.mkdirSync(path.dirname(path.join(blogRepo, indexRel)), { recursive: true });
    fs.writeFileSync(path.join(blogRepo, indexRel), indexBytes);
    git(['add', indexRel]);
    git(['commit', '--no-gpg-sign', '-m', 'daily publish']);
    const pubOid = git(['rev-parse', 'HEAD']);

    // Descendant commit keeping index page unchanged
    fs.writeFileSync(path.join(blogRepo, 'OTHER.md'), 'later commit\n');
    git(['add', 'OTHER.md']);
    git(['commit', '--no-gpg-sign', '-m', 'unrelated descendant']);
    const descendantOid = git(['rev-parse', 'HEAD']);

    const manifestPath = path.join(currentDir, `blog-generation-manifest-${date}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
        date,
        files: [{ path: indexRel, sha256: sha256(indexBytes) }]
    }));
    const manifestSha = sha256(fs.readFileSync(manifestPath));
    fs.writeFileSync(path.join(currentDir, `blog-review-receipt-${date}.json`), JSON.stringify({
        generationManifestSha256: manifestSha,
        publicationCommit: pubOid,
        remoteVerifiedOid: pubOid
    }));

    const ghMockForOid = targetOid => (bin, args) => {
        if (bin === 'gh' && args[0] === 'run' && args[1] === 'list') {
            return {
                status: 0,
                stdout: JSON.stringify([{
                    headSha: targetOid,
                    status: 'completed',
                    conclusion: 'success',
                    url: 'https://github.com/nanless/audio-research-portal/actions/runs/99',
                    workflowName: 'Deploy Hugo to Pages',
                    event: 'push',
                    databaseId: 99
                }])
            };
        }
        if (bin === 'gh' && args[0] === 'run' && args[1] === 'view') {
            return { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'deploy', conclusion: 'success' }] }) };
        }
        return spawnSync(bin, args, { encoding: 'utf8' });
    };
    const okFetch = async url => ({
        status: 200,
        url,
        text: async () => `<html><head><title>音频研究日报 ${date} | 音频研究门户</title></head><body>ok</body></html>`
    });

    // (b1) Auto-resolve deployOid from receipt when --deploy is omitted!
    const codeAuto = await verifyWeb.runVerifyWebCli(['--date', date], {
        currentDir,
        blogRepo,
        env: { PAPER_DIGEST_BLOG_URL: 'https://nanless.github.io/audio-research-portal/posts' },
        spawnSync: ghMockForOid(pubOid),
        fetchImpl: okFetch,
        print: () => {},
        printError: () => {}
    });
    assert.equal(codeAuto, 0);
    const autoArtifact = JSON.parse(fs.readFileSync(path.join(currentDir, `web-verification-${date}.json`), 'utf8'));
    assert.equal(autoArtifact.partial, false);
    assert.equal(autoArtifact.publicationOid, pubOid);
    assert.equal(autoArtifact.deployOid, pubOid);

    // (b2) Descendant --deploy commit writes publicationOid=pubOid AND deployOid=descendantOid
    const codeDesc = await verifyWeb.runVerifyWebCli(['--date', date, '--deploy', descendantOid], {
        currentDir,
        blogRepo,
        env: { PAPER_DIGEST_BLOG_URL: 'https://nanless.github.io/audio-research-portal/posts' },
        spawnSync: (bin, args, opts) => {
            if (bin === 'gh') return ghMockForOid(descendantOid)(bin, args);
            return spawnSync(bin, args, opts);
        },
        fetchImpl: okFetch,
        print: () => {},
        printError: () => {}
    });
    assert.equal(codeDesc, 0);
    const descArtifact = JSON.parse(fs.readFileSync(path.join(currentDir, `web-verification-${date}.json`), 'utf8'));
    assert.equal(descArtifact.partial, false);
    assert.equal(descArtifact.publicationOid, pubOid);
    assert.equal(descArtifact.deployOid, descendantOid);

    // (c) Shared validator in publish-finish.js + summary display in digest-run-report.js
    const webCheck = finish.readVerifiedDailyWebArtifact({
        date,
        currentDir,
        manifestSha,
        receiptCommit: pubOid
    });
    assert.equal(webCheck.verified, true);
    assert.equal(webCheck.deployOid, descendantOid);
    assert.equal(webCheck.ok, 1);
    assert.equal(webCheck.checked, 1);

    const baseReport = {
        batchDate: date,
        overallStatus: 'complete',
        errors: [],
        fetch: { complete: true, rawCandidateCount: 1 },
        filter: { complete: true, selectedCount: 1, totalCandidates: 1, pendingDecisions: 0 },
        analysis: { complete: true, successful: 1, total: 1, expected: 1, missing: 0, skipped: 0, waived: 0, failed: 0 },
        blog: { complete: true, strictReview: true, remoteOidVerified: true, publicationVerified: true },
        visuals: { waived: true, gateComplete: true, status: 'waived', complete: null, total: null, pending: null, failed: null },
        cover: { waived: true, complete: true, status: 'waived' }
    };
    const verifiedSummary = reportMod.formatDigestRunSummary({ ...baseReport, webVerification: webCheck });
    assert.match(verifiedSummary, /网站上线已核验：1\/1 页 HTTP 200/);
    assert.doesNotMatch(verifiedSummary, /本报告未核验网站上线/);

    const unverifiedSummary = reportMod.formatDigestRunSummary(baseReport);
    assert.match(unverifiedSummary, /本报告未核验网站上线/);
    assert.doesNotMatch(unverifiedSummary, /网站上线已核验/);
});

// =========================================================================
// 5. R1-Rev-Workbench Findings #4 (verify-web Fail-Closed & TOCTOU) & #8 (digest-run-report)
// =========================================================================
test('R1-Fix #4: verifyDeployOidBinding 空文件清单拒绝后续提交，且核验期间生成清单变更中止写盘', async t => {
    const verifyWeb = require('../scripts/verify-web.js');
    const tmp = mkTempDir(t, 'verify-web-fix4-');
    const currentDir = path.join(tmp, 'current');
    const blogRepo = path.join(tmp, 'blog');
    fs.mkdirSync(currentDir, { recursive: true });
    const git = initGitRepo(blogRepo);

    const date = '2026-11-27';
    const indexRel = `content/posts/${date}.md`;
    const indexBytes = Buffer.from(`---\ntitle: "音频研究日报 ${date}"\n---\nBody\n`);
    fs.mkdirSync(path.dirname(path.join(blogRepo, indexRel)), { recursive: true });
    fs.writeFileSync(path.join(blogRepo, indexRel), indexBytes);
    git(['add', indexRel]);
    git(['commit', '--no-gpg-sign', '-m', 'daily publish']);
    const pubOid = git(['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(blogRepo, 'NEXT.md'), 'descendant\n');
    git(['add', 'NEXT.md']);
    git(['commit', '--no-gpg-sign', '-m', 'descendant']);
    const descendantOid = git(['rev-parse', 'HEAD']);

    // 4a. Empty validFiles when candidate !== recorded MUST throw (fail closed)
    assert.throws(
        () => verifyWeb.verifyDeployOidBinding({
            deployOid: descendantOid,
            recordedOid: pubOid,
            files: [],
            blogRepo,
            label: '日更发布'
        }),
        /日更发布清单缺少可核验文件，拒绝接受后续提交/
    );

    // 4b. Manifest mutated mid-flight during verify() MUST abort before writing web-verification artifact
    const manifestPath = path.join(currentDir, `blog-generation-manifest-${date}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
        date,
        files: [{ path: indexRel, sha256: sha256(indexBytes) }]
    }));
    const manifestSha = sha256(fs.readFileSync(manifestPath));
    fs.writeFileSync(path.join(currentDir, `blog-review-receipt-${date}.json`), JSON.stringify({
        generationManifestSha256: manifestSha,
        publicationCommit: pubOid,
        remoteVerifiedOid: pubOid
    }));

    const errors = [];
    const code = await verifyWeb.runVerifyWebCli(['--date', date], {
        currentDir,
        blogRepo,
        env: { PAPER_DIGEST_BLOG_URL: 'https://nanless.github.io/audio-research-portal/posts' },
        spawnSync: (bin, args) => {
            if (bin === 'gh' && args[0] === 'run' && args[1] === 'list') {
                return {
                    status: 0,
                    stdout: JSON.stringify([{
                        headSha: pubOid, status: 'completed', conclusion: 'success',
                        url: 'https://github.com/nanless/audio-research-portal/actions/runs/77',
                        workflowName: 'Deploy Hugo to Pages', event: 'push', databaseId: 77
                    }])
                };
            }
            if (bin === 'gh' && args[0] === 'run' && args[1] === 'view') {
                return { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'deploy', conclusion: 'success' }] }) };
            }
            return spawnSync(bin, args, { encoding: 'utf8' });
        },
        fetchImpl: async url => {
            // Mutate manifest BEFORE verify() finishes? Actually verify() reads manifest before fetchImpl,
            // so mutate manifest AFTER wait/deploy check by mutating during deployStatus (gh run view)
            return {
                status: 200,
                url,
                text: async () => `<html><head><title>音频研究日报 ${date} | 音频研究门户</title></head><body>ok</body></html>`
            };
        },
        print: () => {},
        printError: msg => errors.push(String(msg))
    });
    assert.equal(code, 0, 'baseline unchanged manifest should succeed');
    fs.unlinkSync(path.join(currentDir, `web-verification-${date}.json`));

    // Now mutate manifest between upfront check and verify() (during gh run view)!
    errors.length = 0;
    const codeMutated = await verifyWeb.runVerifyWebCli(['--date', date], {
        currentDir,
        blogRepo,
        env: { PAPER_DIGEST_BLOG_URL: 'https://nanless.github.io/audio-research-portal/posts' },
        spawnSync: (bin, args) => {
            if (bin === 'gh' && args[0] === 'run' && args[1] === 'list') {
                return {
                    status: 0,
                    stdout: JSON.stringify([{
                        headSha: pubOid, status: 'completed', conclusion: 'success',
                        url: 'https://github.com/nanless/audio-research-portal/actions/runs/77',
                        workflowName: 'Deploy Hugo to Pages', event: 'push', databaseId: 77
                    }])
                };
            }
            if (bin === 'gh' && args[0] === 'run' && args[1] === 'view') {
                // Simulate concurrent regeneration changing the manifest before verify() reads it!
                fs.writeFileSync(manifestPath, JSON.stringify({
                    date,
                    files: [{ path: indexRel, sha256: sha256(indexBytes) }],
                    mutatedDuringDeployWait: true
                }));
                return { status: 0, stdout: JSON.stringify({ jobs: [{ name: 'deploy', conclusion: 'success' }] }) };
            }
            return spawnSync(bin, args, { encoding: 'utf8' });
        },
        fetchImpl: async url => ({
            status: 200,
            url,
            text: async () => `<html><head><title>音频研究日报 ${date} | 音频研究门户</title></head><body>ok</body></html>`
        }),
        print: () => {},
        printError: msg => errors.push(String(msg))
    });
    assert.equal(codeMutated, 2);
    assert.ok(errors.some(e => e.includes('核验期间生成清单发生变化，请重新核验')), `actual errors: ${errors.join('; ')}`);
    assert.equal(fs.existsSync(path.join(currentDir, `web-verification-${date}.json`)), false, '清单变更时不得写出 web-verification 证据');
});

test('R1-Fix #8: digest-run-report 使用 Config.CURRENT_DIR 且要求 reviewComplete && remoteOidVerified 才采信 webVerification', t => {
    const Config = require('../scripts/config.js');
    const reportMod = require('../scripts/digest-run-report.js');
    const finish = require('../scripts/publish-finish.js');
    const verifyWeb = require('../scripts/verify-web.js');

    const tmp = mkTempDir(t, 'digest-report-fix8-');
    const currentDir = path.join(tmp, 'current');
    const otherDeepDir = path.join(tmp, 'other-deep-dir');
    fs.mkdirSync(currentDir, { recursive: true });
    fs.mkdirSync(otherDeepDir, { recursive: true });

    const prevCurrent = Config.CURRENT_DIR;
    const prevDeep = Config.FILES.deepAnalysisResult;
    const prevRaw = Config.FILES.rawCandidates;
    const prevFiltered = Config.FILES.filteredPapers;
    const prevDecisions = Config.FILES.filterDecisions;
    const prevVisualDir = Config.FILES.visualSummaryManifestDir;
    const prevCoverDir = Config.FILES.digestCoverManifestDir;
    const prevWaiverDir = Config.FILES.postPublishVisualWaiverDir;
    t.after(() => {
        Config.CURRENT_DIR = prevCurrent;
        Config.FILES.deepAnalysisResult = prevDeep;
        Config.FILES.rawCandidates = prevRaw;
        Config.FILES.filteredPapers = prevFiltered;
        Config.FILES.filterDecisions = prevDecisions;
        Config.FILES.visualSummaryManifestDir = prevVisualDir;
        Config.FILES.digestCoverManifestDir = prevCoverDir;
        Config.FILES.postPublishVisualWaiverDir = prevWaiverDir;
    });

    Config.CURRENT_DIR = currentDir;
    Config.FILES.deepAnalysisResult = path.join(otherDeepDir, 'deep-analysis-result.json');
    Config.FILES.rawCandidates = path.join(currentDir, 'raw-candidates.json');
    Config.FILES.filteredPapers = path.join(currentDir, 'filtered-papers.json');
    Config.FILES.filterDecisions = path.join(currentDir, 'filter-decisions.json');
    Config.FILES.visualSummaryManifestDir = path.join(currentDir, 'visual-summary-manifests');
    Config.FILES.digestCoverManifestDir = path.join(currentDir, 'digest-cover-manifests');
    Config.FILES.postPublishVisualWaiverDir = path.join(currentDir, 'post-publish-visual-waivers');

    const date = '2026-11-27';
    const pubOid = 'a'.repeat(40);
    const manifestPath = path.join(currentDir, `blog-generation-manifest-${date}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({ date, files: [{ path: `content/posts/${date}.md` }] }));
    const manifestSha = sha256(fs.readFileSync(manifestPath));

    // Write a syntactically valid web-verification artifact in Config.CURRENT_DIR
    fs.writeFileSync(path.join(currentDir, `web-verification-${date}.json`), JSON.stringify({
        contract: verifyWeb.ARTIFACT_FORMAT.contract,
        schemaFingerprint: verifyWeb.ARTIFACT_FORMAT.schemaFingerprint,
        date,
        partial: false,
        publicationOid: pubOid,
        deployOid: pubOid,
        generationManifestSha256: manifestSha,
        expected: 1,
        checked: 1,
        ok: 1,
        failed: 0,
        deploy: { status: 'completed', conclusion: 'success', jobVerified: true }
    }));

    // Case A: reviewComplete is false (unverified receipt) -> webVerification MUST stay null and reader NOT invoked
    fs.writeFileSync(path.join(currentDir, `blog-review-receipt-${date}.json`), JSON.stringify({
        strictReview: true,
        publicationCommit: pubOid,
        remoteVerifiedOid: pubOid,
        generationManifestSha256: manifestSha
    }));
    let readCalls = 0;
    const origRead = finish.readVerifiedDailyWebArtifact;
    t.mock.method(finish, 'readVerifiedDailyWebArtifact', (...args) => {
        readCalls += 1;
        return origRead(...args);
    });
    const reportUnverified = reportMod.buildDigestRunReport(date, { today: date, archiveDir: path.join(tmp, 'archive') });
    assert.equal(reportUnverified.blog.complete, false);
    assert.equal(reportUnverified.webVerification, undefined, 'reviewComplete 为 false 时不得采信 webVerification');
    assert.equal(readCalls, 0);

    // Case B: remoteOidVerified is false (mismatch) -> webVerification MUST be omitted
    fs.writeFileSync(path.join(currentDir, `blog-review-receipt-${date}.json`), JSON.stringify({
        strictReview: true,
        publicationCommit: pubOid,
        remoteVerifiedOid: 'b'.repeat(40),
        generationManifestSha256: manifestSha
    }));
    const reportMismatchOid = reportMod.buildDigestRunReport(date, { today: date, archiveDir: path.join(tmp, 'archive') });
    assert.equal(reportMismatchOid.blog.remoteOidVerified, false);
    assert.equal(reportMismatchOid.webVerification, undefined, 'remoteOidVerified 为 false 时不得采信 webVerification');
    assert.equal(readCalls, 0);

    // Verify source uses Config.CURRENT_DIR and gates on reviewComplete && remoteOidVerified
    const src = fs.readFileSync(path.resolve(__dirname, '../scripts/digest-run-report.js'), 'utf8');
    assert.match(src, /const currentDir = Config\.CURRENT_DIR;/);
    assert.match(src, /const receiptCommit = remoteOidVerified \? review\.publicationCommit : null;/);
    assert.match(src, /reviewComplete && remoteOidVerified/);
});

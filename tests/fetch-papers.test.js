const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    parseFilterDecision,
    parseFilterDecisionDetails,
    repairMalformedFilterDecision,
    filterPapersByKeywords,
    filterPapersWithLLM,
    fetchCategoryPapers,
    fetchAbstracts,
    redactProxyUrl,
    parseRecentPageHTML,
    parseSearchPageHTML,
    parseArxivXML
} = require('../scripts/fetch-papers.js');

describe('parseFilterDecision', () => {
    it('正确解析是否相关格式，不被“是否”的“否”误伤', () => {
        assert.strictEqual(parseFilterDecision('理由：涉及语音理解。\n是否相关：相关'), true);
        assert.strictEqual(parseFilterDecision('理由：纯文本分类。\n是否相关：不相关'), false);
    });

    it('优先解析明确结论', () => {
        assert.strictEqual(parseFilterDecision('理由：摘要没有音频任务。\n结论：不相关'), false);
        assert.strictEqual(parseFilterDecision('理由：包含语音识别评测。\n结论：相关'), true);
    });

    it('支持 JSON 和英文结构化结论', () => {
        assert.strictEqual(parseFilterDecision('{"decision":"related","reason":"speech task"}'), true);
        assert.strictEqual(parseFilterDecision('{"decision":"not_related","reason":"text only"}'), false);
        assert.strictEqual(parseFilterDecision('Reason: speech benchmark\nConclusion: related'), true);
        assert.strictEqual(parseFilterDecision('Reason: text-only benchmark\nConclusion: not related'), false);
    });

    it('无法解析明确结论时标记为待重试，不再默认缓存为相关', () => {
        assert.strictEqual(parseFilterDecision('理由：是否属于音频任务无法从摘要判断。'), null);
        const decision = parseFilterDecisionDetails('理由：是否属于音频任务无法从摘要判断。');
        assert.strictEqual(decision.retryable, true);
        assert.strictEqual(decision.fallback, true);
        assert.strictEqual(decision.parseSource, 'fallback_retryable');

        const keywordOnly = parseFilterDecisionDetails('This work appears related to audio, but no conclusion was provided.');
        assert.strictEqual(keywordOnly.related, null);
        assert.strictEqual(keywordOnly.retryable, true);
        assert.strictEqual(keywordOnly.suggestedRelated, true);
    });

    it('保留筛选理由、原始响应和解析来源', () => {
        const decision = parseFilterDecisionDetails('{"decision":"not_related","reason":"纯文本检索，没有音频任务"}', '2604.1');
        assert.strictEqual(decision.related, false);
        assert.strictEqual(decision.reason, '纯文本检索，没有音频任务');
        assert.match(decision.rawResponse, /not_related/);
        assert.strictEqual(decision.parseSource, 'json');
    });

    it('正确解析 JSON 布尔 related=false，不会因为假值回退为保留', () => {
        const decision = parseFilterDecisionDetails('{"related":false,"reason":"仅讨论文本检索"}', '2604.2');
        assert.strictEqual(decision.related, false);
        assert.strictEqual(decision.parseSource, 'json');
    });

    it('格式异常但语义明确时，通过受控格式修复获得正式决定', async () => {
        const initial = parseFilterDecisionDetails('这篇论文核心是手语视频翻译，语音输出只是辅助，因此不相关。');
        assert.strictEqual(initial.retryable, true);
        const repaired = await repairMalformedFilterDecision(initial, '2607.09611', async () => '结论：不相关');
        assert.strictEqual(repaired.related, false);
        assert.strictEqual(repaired.retryable, undefined);
        assert.strictEqual(repaired.parseSource, 'format_repair:conclusion_line');
        assert.match(repaired.rawResponse, /\[format-repair\]/);
    });
});

describe('filterPapersByKeywords', () => {
    it('缺少 categories 时不会抛错', () => {
        const result = filterPapersByKeywords([
            { title: 'A Speech Recognition Model', abstract: 'speech recognition benchmark' },
            { title: 'A Text Classifier', abstract: 'text only' }
        ]);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].title, 'A Speech Recognition Model');
    });
});

describe('filterPapersWithLLM resume decisions', () => {
    it('复用已有筛选决策时不调用模型，并按原论文顺序返回相关论文', async () => {
        const papers = [
            { arxivId: '2604.00001', title: 'Speech Paper', abstract: 'speech' },
            { arxivId: '2604.00002', title: 'Text Paper', abstract: 'text' },
            { arxivId: '2604.00003', title: 'Audio Paper', abstract: 'audio' }
        ];
        const filtered = await filterPapersWithLLM(papers, {
            batchSize: 1,
            initialDecisions: {
                '2604.00001': { related: true },
                '2604.00002': { related: false },
                '2604.00003': { related: true }
            }
        });

        assert.deepStrictEqual(filtered.map(p => p.arxivId), ['2604.00001', '2604.00003']);
    });

    it('不会把不属于当前候选集的旧筛选决策写回进度文件', async () => {
        const papers = [
            { arxivId: '2604.00001', title: 'Speech Paper', abstract: 'speech' },
            { arxivId: '2604.00002', title: 'New Audio Paper', abstract: 'audio' }
        ];
        let savedDecisionIds = [];

        const filtered = await filterPapersWithLLM(papers, {
            batchSize: 1,
            initialDecisions: {
                '2604.00001': { related: true },
                '2604.99999': { related: true }
            },
            decisionFn: async () => ({
                related: false,
                reason: 'not audio',
                rawResponse: 'Conclusion: not related',
                parseSource: 'test'
            }),
            onBatchComplete: async ({ decisions }) => {
                savedDecisionIds = Object.keys(decisions).sort();
            }
        });

        assert.deepStrictEqual(filtered.map(p => p.arxivId), ['2604.00001']);
        assert.deepStrictEqual(savedDecisionIds, ['2604.00001', '2604.00002']);
    });

    it('不缓存 retryable fallback，并把筛选批次标记为未完成', async () => {
        const paper = { arxivId: '2604.00001', title: 'Uncertain Paper', abstract: 'unknown' };
        let checkpoint = null;
        const filtered = await filterPapersWithLLM([paper], {
            batchSize: 1,
            delayBetweenBatches: 0,
            decisionFn: async () => ({
                related: null,
                retryable: true,
                fallback: true,
                parseSource: 'api_error_retryable',
                error: 'temporary failure'
            }),
            onBatchComplete: async data => { checkpoint = data; }
        });

        assert.deepStrictEqual(filtered, []);
        assert.strictEqual(filtered._filterStats.complete, false);
        assert.deepStrictEqual(filtered._filterStats.retryableIds, ['2604.00001']);
        assert.deepStrictEqual(checkpoint.decisions, {});
        assert.strictEqual(checkpoint.retryableDecisions['2604.00001'].retryable, true);
        assert.strictEqual(checkpoint.stats.complete, false);
    });
});

describe('抓取健康状态', () => {
    it('默认 arXiv 抓取缺少项目代理时拒绝直连', async () => {
        const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
        const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        try {
            for (const key of keys) delete process.env[key];
            await assert.rejects(
                fetchCategoryPapers('cs.SD', 1, 1, new Set()),
                /必须通过当前项目.*代理|拒绝在无代理配置时直连/
            );
        } finally {
            for (const key of keys) {
                if (original[key] === undefined) delete process.env[key];
                else process.env[key] = original[key];
            }
        }
    });

    it('arXiv 所有请求失败时抛出结构化异常', async () => {
        const requestFn = async () => { throw new Error('network down'); };
        await assert.rejects(
            fetchCategoryPapers('cs.SD', 1, 1, new Set(), {
                requestFn,
                sleepFn: async () => {},
                maxRetries: 1,
                abstractMaxRetries: 1
            }),
            error => error.code === 'SOURCE_FETCH_FAILED'
                && error.sourceHealth.allFailed === true
                && error.sourceHealth.successfulRequests === 0
                && error.sourceHealth.attempts === 3
        );
    });

    it('arXiv 成功空响应与全失败严格区分', async () => {
        const requestFn = async url => ({
            status: 200,
            data: url.includes('/api/query') ? '<feed></feed>' : '<html></html>'
        });
        const papers = await fetchCategoryPapers('cs.SD', 1, 1, new Set(), {
            requestFn,
            sleepFn: async () => {},
            maxRetries: 1,
            abstractMaxRetries: 1
        });

        assert.deepStrictEqual(papers, []);
        assert.strictEqual(papers._sourceHealth.ok, true);
        assert.strictEqual(papers._sourceHealth.allFailed, false);
        assert.strictEqual(papers._sourceHealth.successfulRequests, 3);
    });

    it('摘要仅在解析到非空内容时计成功，并记录最终失败 ID', async () => {
        const papers = [
            { arxivId: '2604.00001', abstract: '' },
            { arxivId: '2604.00002', abstract: '' }
        ];
        const requestFn = async url => ({
            status: 200,
            data: url.endsWith('00001')
                ? '<html>no abstract</html>'
                : '<blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span> useful speech result </blockquote>'
        });
        const result = await fetchAbstracts(papers, 2, {
            requestFn,
            sleepFn: async () => {},
            maxRetries: 1
        });

        assert.strictEqual(result[0].abstract, '');
        assert.strictEqual(result[1].abstract, 'useful speech result');
        assert.strictEqual(result._abstractHealth.fetched, 1);
        assert.deepStrictEqual(result._abstractHealth.failedIds, ['2604.00001']);
    });

    it('代理日志地址会隐藏 userinfo', () => {
        const redacted = redactProxyUrl('http://alice:secret@proxy.example:8080');
        assert.doesNotMatch(redacted, /alice|secret/);
        assert.match(redacted, /proxy\.example:8080/);
    });
});

describe('arXiv parsers', () => {
    it('recent 页按 dt/dd 条目绑定 ID、标题和作者，避免跨数组错配', () => {
        const html = `
        <dl>
          <dt>
            <a href="/abs/2604.00001">abs</a>
            <a href="/pdf/2604.00001">pdf</a>
          </dt>
          <dd>
            <div class="list-title mathjax"><span class="descriptor">Title:</span> First Speech Paper</div>
            <div class="list-authors"><span class="descriptor">Authors:</span> <a>Alice</a></div>
          </dd>
          <dt>
            <a href="/abs/2604.00002">abs</a>
          </dt>
          <dd>
            <div class="list-title mathjax"><span class="descriptor">Title:</span> Second Audio Paper</div>
            <div class="list-authors"><span class="descriptor">Authors:</span> <a>Bob</a><a>Carol</a></div>
          </dd>
        </dl>`;
        const papers = parseRecentPageHTML(html, 'cs.SD', new Set(['2604.00001']));

        assert.strictEqual(papers.length, 1);
        assert.strictEqual(papers[0].arxivId, '2604.00002');
        assert.strictEqual(papers[0].title, 'Second Audio Paper');
        assert.deepStrictEqual(papers[0].authors, ['Bob', 'Carol']);
    });

    it('搜索页解析会暴露总数和已跳过数，便于全重复页继续翻页', () => {
        const html = `
        <li class="arxiv-result">
          <p>arXiv:2604.00001</p>
          <p class="title is-5 mathjax">Known Speech Paper</p>
          <span class="abstract-full has-text-grey-dark mathjax">speech abstract</span>
        </li>`;
        const existing = new Set(['2604.00001']);
        const papers = parseSearchPageHTML(html, 'cs.SD', existing);

        assert.strictEqual(papers.length, 0);
        assert.deepStrictEqual(papers._meta, { totalFound: 1, skippedExisting: 1 });
    });

    it('API 解析可关闭连续已知论文提前停止', () => {
        const entries = Array.from({ length: 21 }, (_, i) => `
          <entry>
            <id>http://arxiv.org/abs/2604.${String(i).padStart(5, '0')}v1</id>
            <title>Known ${i}</title>
            <summary>Known summary</summary>
            <published>2026-04-01T00:00:00Z</published>
            <category term="cs.SD"/>
          </entry>`).join('');
        const xml = `<feed>${entries}
          <entry>
            <id>http://arxiv.org/abs/2604.99999v1</id>
            <title>New Paper</title>
            <summary>New summary</summary>
            <published>2026-04-01T00:00:00Z</published>
            <category term="cs.SD"/>
          </entry>
        </feed>`;
        const existing = new Set(Array.from({ length: 21 }, (_, i) => `2604.${String(i).padStart(5, '0')}`));

        const stopped = parseArxivXML(xml, 'cs.SD', existing);
        const notStopped = parseArxivXML(xml, 'cs.SD', existing, { stopAtConsecutiveExisting: false });

        assert.strictEqual(stopped.length, 0);
        assert.strictEqual(stopped._meta.stoppedAtConsecutive, true);
        assert.strictEqual(notStopped.length, 1);
        assert.strictEqual(notStopped[0].arxivId, '2604.99999v1');
    });
});

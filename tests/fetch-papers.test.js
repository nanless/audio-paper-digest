const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    parseFilterDecision,
    filterPapersByKeywords,
    filterPapersWithLLM,
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

    it('不再用说明句里的单字是否作为兜底结论', () => {
        assert.strictEqual(parseFilterDecision('理由：是否属于音频任务无法从摘要判断。'), true);
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

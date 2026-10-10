const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fetchCategoryPapersSince, parseArxivXML } = require('../scripts/fetch-papers.js');

const identitySha256 = 'a'.repeat(64);
const boundary = { since: '2026-10-03T00:00:00Z', until: '2026-10-04T12:00:00Z', identitySha256 };
function entry(id, published, category = 'cs.SD') {
    return `<entry><id>http://arxiv.org/abs/${id}v1</id><title>论文 ${id}</title><summary>speech research</summary><published>${published}</published><author><name>作者</name></author><category term="${category}"/></entry>`;
}
function feed(entries, total = entries.length, start = 0, pageSize = 100) {
    return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults><opensearch:startIndex>${start}</opensearch:startIndex><opensearch:itemsPerPage>${pageSize}</opensearch:itemsPerPage>${entries.join('')}</feed>`;
}
function requestOptions(requestFn, extra = {}) {
    return { requestFn, sleepFn: async () => {}, requestScheduler: { run: async (host, fn) => {
        assert.equal(host, 'export.arxiv.org');
        return fn();
    } }, maxRetries: 1, ...extra };
}
describe('按已发布日更时间范围分页补抓', () => {
    it('跨多日取得超过100篇；同一时间戳跨页仍读取完整，已有身份仅在最终去重', async () => {
        const urls = [];
        const firstDay = Array.from({ length: 205 }, (_, index) => entry(`2610.${String(index + 1).padStart(5, '0')}`, '2026-10-03T00:00:00Z'));
        const secondDay = [entry('2610.00300', '2026-10-04T11:00:00Z')];
        const papers = await fetchCategoryPapersSince('cs.SD', boundary, new Set(['2610.00001']), requestOptions(async url => {
            urls.push(url);
            const params = new URL(url).searchParams;
            const start = Number(params.get('start'));
            const entries = params.get('search_query').includes('202610030000') ? firstDay : secondDay;
            assert.equal(params.get('sortBy'), 'submittedDate');
            assert.equal(params.get('sortOrder'), 'descending');
            assert.equal(params.get('max_results'), '100');
            return { status: 200, data: feed(entries.slice(start, start + 100), entries.length, start) };
        }));
        assert.equal(papers.length, 205);
        assert.equal(urls.length, 4);
        assert.deepEqual(urls.slice(0, 3).map(url => new URL(url).searchParams.get('start')), ['0', '100', '200']);
        assert.equal(papers._sourceHealth.coverageComplete, true);
        assert.equal(papers._sourceHealth.windows[0].entries, 205);
        assert.equal(papers._sourceHealth.boundary.identitySha256, identitySha256);
    });
    it('查询纳入边界分钟，但最终保留精确下界和上界以内条目', async () => {
        const fixed = { ...boundary, since: '2026-10-03T00:00:30Z', until: '2026-10-03T00:01:30Z' };
        const values = ['00:01:50', '00:01:30', '00:00:30', '00:00:10'].map((time, index) => entry(`2610.0000${index + 1}`, `2026-10-03T${time}Z`));
        const papers = await fetchCategoryPapersSince('cs.SD', fixed, null, requestOptions(async () => ({ status: 200, data: feed(values) })));
        assert.deepEqual(papers.map(paper => paper.arxivId), ['2610.00002v1', '2610.00003v1']);
    });
    for (const [label, makePage] of [
        ['中间短页', start => feed([entry('2610.00001', '2026-10-03T01:00:00Z')], 3, start, 2)],
        ['总数变化', start => feed([entry(`2610.0000${start + 1}`, '2026-10-03T01:00:00Z')], start ? 3 : 2, start, 1)],
        ['重复身份', start => feed([entry('2610.00001', '2026-10-03T01:00:00Z')], 2, start, 1)],
        ['错误起点', () => feed([entry('2610.00001', '2026-10-03T01:00:00Z')], 1, 1, 1)],
        ['分类错误', () => feed([entry('2610.00001', '2026-10-03T01:00:00Z', 'cs.LG')], 1, 0, 1)],
        ['日期倒序错误', start => feed([entry(`2610.0000${start + 1}`, `2026-10-03T0${start + 1}:00:00Z`)], 2, start, 1)],
        ['最小分钟服务上限', () => feed([entry('2610.00001', '2026-10-03T00:00:00Z')], 30001, 0, 1)],
        ['缺少分页字段', () => '<feed xmlns="http://www.w3.org/2005/Atom"/>'],
        ['无效日期', () => feed([entry('2610.00001', '2026-10-03T99:00:00Z')], 1, 0, 1)],
    ]) {
        it(`${label}不能被当作完整覆盖`, async () => {
            let caught;
            try {
                await fetchCategoryPapersSince('cs.SD', { ...boundary, until: label === '最小分钟服务上限' ? '2026-10-03T00:00:30Z' : '2026-10-03T12:00:00Z' }, null,
                    requestOptions(async url => ({ status: 200, data: makePage(Number(new URL(url).searchParams.get('start'))) }), { pageSize: label === '中间短页' ? 2 : 1 }));
            } catch (error) { caught = error; }
            assert.ok(caught);
            assert.equal(caught.code, 'SOURCE_FETCH_FAILED');
            assert.equal(caught.sourceHealth.coverageComplete, false);
        });
    }
    it('后页网络失败保留未完成状态，而不是交出第一页部分结果', async () => {
        let calls = 0;
        await assert.rejects(fetchCategoryPapersSince('cs.SD', { ...boundary, until: '2026-10-03T12:00:00Z' }, null,
            requestOptions(async () => {
                if (++calls === 2) throw new Error('本地模拟连接失败');
                return { status: 200, data: feed([entry('2610.00001', '2026-10-03T01:00:00Z')], 2, 0, 1) };
            }, { pageSize: 1 })), error => error.sourceHealth.coverageComplete === false && error.sourceHealth.windows[0].complete === false);
    });
    it('合法空窗口有完整分页证明；默认Atom数组接口仍保持兼容', async () => {
        const papers = await fetchCategoryPapersSince('cs.SD', { ...boundary, until: '2026-10-03T12:00:00Z' }, null,
            requestOptions(async () => ({ status: 200, data: feed([]) })));
        assert.equal(papers.length, 0);
        assert.equal(papers._sourceHealth.coverageComplete, true);
        const legacy = parseArxivXML(feed([entry('2610.00001', '2026-10-03T01:00:00Z')] ), 'cs.SD');
        assert.ok(Array.isArray(legacy));
        assert.equal(legacy.length, 1);
    });
    it('明确429沿用共享主机调度和等待预算；成功页不请求摘要页面', async () => {
        let calls = 0;
        const waits = [];
        const scheduledHosts = [];
        const papers = await fetchCategoryPapersSince('cs.SD', { ...boundary, until: '2026-10-03T12:00:00Z' }, null, {
            requestFn: async url => {
                assert.equal(new URL(url).hostname, 'export.arxiv.org');
                return ++calls === 1 ? { status: 429, data: '' }
                    : { status: 200, data: feed([entry('2610.00001', '2026-10-03T01:00:00Z')]) };
            },
            sleepFn: async delay => { waits.push(delay); },
            requestScheduler: { run: async (host, task) => { scheduledHosts.push(host); return task(); } },
            maxRetries: 2, rateLimitMaxWaitMs: 1000, maxWaitMs: 1000
        });
        assert.deepEqual(waits, [1000]);
        assert.deepEqual(scheduledHosts, ['export.arxiv.org', 'export.arxiv.org']);
        assert.equal(papers[0].abstract, 'speech research');
        assert.equal(papers._sourceHealth.rateLimitRetryCount, 1);
        assert.equal(papers._sourceHealth.rateLimitWaitMs, 1000);
        assert.equal(papers._sourceHealth.provider.window.covered, true);
    });

    it('连续20篇历史已知论文不能阻止后页新论文补抓', async () => {
        const known = Array.from({ length: 20 }, (_, index) => `2610.${String(index + 1).padStart(5, '0')}`);
        const records = [...known, '2610.00021'].map(id => entry(id, '2026-10-03T01:00:00Z'));
        const starts = [];
        const papers = await fetchCategoryPapersSince('cs.SD', { ...boundary, until: '2026-10-03T12:00:00Z' }, new Set(known),
            requestOptions(async url => {
                const start = Number(new URL(url).searchParams.get('start'));
                starts.push(start);
                return { status: 200, data: feed(records.slice(start, start + 10), records.length, start, 10) };
            }, { pageSize: 10 }));
        assert.deepEqual(starts, [0, 10, 20]);
        assert.deepEqual(papers.map(paper => paper.arxivId), ['2610.00021v1']);
    });
    it('共享真实调度器至少等待三秒且保留已有更长等待，不额外独立睡眠', async () => {
        const { createHostTaskScheduler } = require('../scripts/lib/fetch-scheduler.js');
        let clock = 0;
        const waits = [];
        const scheduler = createHostTaskScheduler({ nowFn: () => clock,
            sleepFn: async delay => { waits.push(delay); clock += delay; },
            cooldownAfter: () => 1000 });
        await fetchCategoryPapersSince('cs.SD', { ...boundary, until: '2026-10-03T12:00:00Z' }, null, {
            pageSize: 1, maxRetries: 1, requestScheduler: scheduler,
            requestFn: async url => {
                const start = Number(new URL(url).searchParams.get('start'));
                return { status: 200, data: feed([entry(`2610.0000${start + 1}`, '2026-10-03T01:00:00Z')], 2, start, 1) };
            }
        });
        assert.deepEqual(waits, [3000]);
        scheduler.defer('export.arxiv.org', 60000);
        assert.equal(scheduler.getNextEligibleAt('export.arxiv.org'), clock + 60000);
        scheduler.defer('export.arxiv.org', 3000);
        assert.equal(scheduler.getNextEligibleAt('export.arxiv.org'), clock + 60000);
    });

    it('API请求后已排队的同主机任务也遵守三秒间隔，原更长等待不缩短', async () => {
        const { createHostTaskScheduler } = require('../scripts/lib/fetch-scheduler.js');
        for (const originalCooldown of [1000, 60000]) {
            let clock = 0;
            let releaseRequest;
            let enteredRequest;
            const entered = new Promise(resolve => { enteredRequest = resolve; });
            const pending = new Promise(resolve => { releaseRequest = resolve; });
            const waits = [];
            const scheduler = createHostTaskScheduler({ nowFn: () => clock,
                sleepFn: async delay => { waits.push(delay); clock += delay; },
                cooldownAfter: () => originalCooldown });
            const fetching = fetchCategoryPapersSince('cs.SD', { ...boundary, until: '2026-10-03T12:00:00Z' }, null, {
                requestScheduler: scheduler, maxRetries: 1,
                requestFn: async () => {
                    enteredRequest();
                    await pending;
                    return { status: 200, data: feed([]) };
                }
            });
            await entered;
            const queued = scheduler.run('export.arxiv.org', async () => clock);
            releaseRequest();
            const [, dispatchedAt] = await Promise.all([fetching, queued]);
            assert.equal(dispatchedAt, Math.max(3000, originalCooldown));
            assert.deepEqual(waits, [Math.max(3000, originalCooldown)]);
        }
    });

    it('30001篇单日论文拆分后全部真实解析，总数与父窗一致', async () => {
        const queries = [];
        const records = Array.from({ length: 30001 }, (_, index) => entry(`2610.${String(index + 1).padStart(5, '0')}`,
            index < 15000 ? '2026-10-03T11:00:00Z' : '2026-10-03T12:00:00Z'));
        const papers = await fetchCategoryPapersSince('cs.SD', { ...boundary, until: '2026-10-03T23:59:59Z' }, null,
            requestOptions(async url => {
                const params = new URL(url).searchParams;
                const query = params.get('search_query');
                queries.push(query);
                const start = Number(params.get('start'));
                const selected = query.includes('202610030000 TO 202610032359') ? records.slice(15000)
                    : query.includes('202610030000 TO 202610031159') ? records.slice(0, 15000) : records.slice(15000);
                const total = query.includes('202610030000 TO 202610032359') ? records.length : selected.length;
                return { status: 200, data: feed(selected.slice(start, start + 2000), total, start, 2000) };
            }, { pageSize: 2000 }));
        assert.equal(queries.length, 17);
        assert.equal(papers.length, 30001);
        assert.equal(new Set(papers.map(paper => paper.arxivId)).size, 30001);
        assert.deepEqual(new Set(papers.map(paper => paper.arxivId)), new Set(records.map((_, index) => `2610.${String(index + 1).padStart(5, '0')}v1`)));
        assert.equal(papers._sourceHealth.windows[0].complete, false);
        assert.equal(papers._sourceHealth.windows[0].childWindowIndices.length, 2);
        assert.ok(papers._sourceHealth.windows.slice(1).every(window => window.complete));
        assert.equal(papers._sourceHealth.coverageComplete, true);
    });
    it('父窗30001但两个子窗只有2和1时必须拒绝完整覆盖', async () => {
        let caught;
        try {
            await fetchCategoryPapersSince('cs.SD', { ...boundary, until: '2026-10-03T23:59:59Z' }, null,
                requestOptions(async url => {
                    const query = new URL(url).searchParams.get('search_query');
                    const parent = query.includes('202610030000 TO 202610032359');
                    const left = query.includes('202610030000 TO 202610031159');
                    const records = parent || left ? [entry('2610.00002', '2026-10-03T11:00:00Z'), entry('2610.00001', '2026-10-03T00:00:00Z')]
                        : [entry('2610.00003', '2026-10-03T12:00:00Z')];
                    return { status: 200, data: feed(records, parent ? 30001 : records.length, 0, 2) };
                }, { pageSize: 2 }));
        } catch (error) { caught = error; }
        assert.ok(caught);
        assert.match(caught.message, /拆分前后的论文总数不一致/);
        assert.equal(caught.sourceHealth.provider.window.covered, false);
    });
    it('拆分子窗后页失败不能使父窗或整个范围变成完整', async () => {
        let caught;
        try {
            await fetchCategoryPapersSince('cs.SD', { ...boundary, until: '2026-10-03T23:59:59Z' }, null,
                requestOptions(async url => {
                    const params = new URL(url).searchParams;
                    const parent = params.get('search_query').includes('202610030000 TO 202610032359');
                    if (params.get('start') === '2') throw new Error('本地子窗后页网络失败');
                    return { status: 200, data: feed([entry('2610.00002', '2026-10-03T11:00:00Z'), entry('2610.00001', '2026-10-03T00:00:00Z')], parent ? 30001 : 3, 0, 2) };
                }, { pageSize: 2 }));
        } catch (error) { caught = error; }
        assert.ok(caught);
        assert.equal(caught.sourceHealth.windows[0].complete, false);
        assert.equal(caught.sourceHealth.coverageComplete, false);
        assert.equal(caught.sourceHealth.provider.window.covered, false);
    });

});

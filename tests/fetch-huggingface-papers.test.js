const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    fetchHuggingFacePapers,
    mergeAndDeduplicate,
    convertDailyPaper,
    convertPaper,
    buildCurlArgs,
    fetchWithCurl
} = require('../scripts/fetch-huggingface-papers.js');

describe('HuggingFace curl proxy isolation', () => {
    it('显式指定项目代理并清空 curl noproxy 绕过列表', () => {
        assert.deepStrictEqual(
            buildCurlArgs('socks5h://127.0.0.1:7897', 'https://huggingface.co/api/papers', 60),
            [
                '-q', '-s', '-f', '-L',
                '--proxy', 'socks5h://127.0.0.1:7897',
                '--noproxy', '',
                '--max-time', '60',
                'https://huggingface.co/api/papers'
            ]
        );
    });

    it('悬挂 curl 使用异步子进程接口，不阻塞 Node 事件循环', async () => {
        let curlCallback;
        let childOptions;
        let settled = false;
        const pending = fetchWithCurl('https://huggingface.co/api/papers', 60, {
            proxyUrl: 'http://127.0.0.1:7897',
            execFileFn: (_file, _args, options, callback) => {
                curlCallback = callback;
                childOptions = options;
                return { pid: 123 };
            }
        }).then(value => {
            settled = true;
            return value;
        });

        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(typeof curlCallback, 'function');
        assert.strictEqual(settled, false);
        assert.strictEqual(childOptions.timeout, 65000);
        assert.strictEqual(childOptions.killSignal, 'SIGKILL');
        curlCallback(null, '[]');
        const result = await pending;
        assert.deepStrictEqual(result, { ok: true, data: [], error: null });
    });

    it('含 userinfo 的代理凭据只写入 0600 临时 config，不进 argv 并在成功后清理', async () => {
        const proxyUrl = 'http://alice:s3cret@proxy.example:8080';
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-curl-test-'));
        let configPath;
        try {
            const result = await fetchWithCurl('https://huggingface.co/api/papers', 60, {
                proxyUrl,
                tempRoot,
                execFileFn: (_file, args, options, callback) => {
                    const argv = args.join(' ');
                    assert.doesNotMatch(argv, /alice|s3cret|alice:s3cret@/);
                    assert.ok(args.includes('--config'));
                    configPath = args[args.indexOf('--config') + 1];
                    assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o600);
                    const config = fs.readFileSync(configPath, 'utf8');
                    assert.match(config, /proxy\.example:8080/);
                    assert.match(config, /alice:s3cret/);
                    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
                        assert.strictEqual(options.env[key], '');
                    }
                    callback(null, '[]', '');
                }
            });
            assert.deepStrictEqual(result, { ok: true, data: [], error: null });
            assert.strictEqual(fs.existsSync(configPath), false);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('代理凭据不会进入 curl 错误、checkpoint 可见返回值，失败后也清理 config', async () => {
        const proxyUrl = 'http://alice:s3cret@proxy.example:8080';
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-curl-error-test-'));
        let configPath;
        try {
            const result = await fetchWithCurl('https://huggingface.co/api/papers', 60, {
                proxyUrl,
                tempRoot,
                execFileFn: (_file, args, _options, callback) => {
                    configPath = args[args.indexOf('--config') + 1];
                    const error = new Error(`curl failed via ${proxyUrl}`);
                    error.code = 7;
                    callback(error, '', `could not connect to ${proxyUrl}`);
                }
            });
            assert.strictEqual(result.ok, false);
            assert.doesNotMatch(result.error, /alice|s3cret|alice:s3cret@/);
            assert.match(result.error, /could not connect/);
            assert.strictEqual(fs.existsSync(configPath), false);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

describe('mergeAndDeduplicate', () => {
    it('按 normalizedId 合并 arXiv 与 HuggingFace 版本号差异', () => {
        const merged = mergeAndDeduplicate([
            {
                paper_id: '2604.12345v1',
                arxivId: '2604.12345v1',
                title: 'arxiv version',
                summary: ''
            }
        ], [
            {
                paper_id: '2604.12345v2',
                arxivId: '2604.12345v2',
                title: 'hf version',
                summary: 'HF summary',
                hf_upvotes: 12,
                hf_ai_summary: 'AI',
                hf_ai_keywords: ['audio'],
                hf_github_repo: 'repo',
                hf_project_page: 'page',
                hf_github_stars: 3,
                hf_discussion_id: 'disc'
            }
        ]);

        assert.strictEqual(merged.length, 1);
        assert.deepStrictEqual(merged[0].sources, ['arxiv', 'huggingface']);
        assert.strictEqual(merged[0].paper_id, '2604.12345v1');
        assert.strictEqual(merged[0].summary, 'HF summary');
        assert.strictEqual(merged[0].hf_upvotes, 12);
    });
});

describe('HuggingFace date guards', () => {
    it('缺少 publishedAt 的 daily paper 会被跳过', () => {
        const paper = convertDailyPaper({
            paper: {
                id: '2604.10000',
                title: 'No date',
                authors: []
            }
        });
        assert.strictEqual(paper, null);
    });

    it('缺少 publishedAt 的 papers API 记录会被跳过', () => {
        const paper = convertPaper({
            id: '2604.10001',
            title: 'No date',
            authors: []
        });
        assert.strictEqual(paper, null);
    });
});

describe('HuggingFace 抓取健康状态', () => {
    it('默认 HuggingFace 抓取缺少项目代理时拒绝直连', async () => {
        const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
        const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        try {
            for (const key of keys) delete process.env[key];
            await assert.rejects(
                fetchHuggingFacePapers(),
                /必须通过当前项目.*代理|拒绝直连/
            );
        } finally {
            for (const key of keys) {
                if (original[key] === undefined) delete process.env[key];
                else process.env[key] = original[key];
            }
        }
    });

    it('所有 API 请求失败时抛出带健康状态的异常', async () => {
        await assert.rejects(
            fetchHuggingFacePapers(new Set(), {
                days: 7,
                minUpvotes: 0,
                fetchFn: () => ({ ok: false, data: null, error: 'network down' }),
                sleepFn: async () => {}
            }),
            error => error.code === 'SOURCE_FETCH_FAILED'
                && error.sourceHealth.allFailed === true
                && error.sourceHealth.attempts === 2
                && error.sourceHealth.successfulRequests === 0
        );
    });

    it('异步 fetch rejection 进入来源健康状态而不是逸出追踪器', async () => {
        await assert.rejects(
            fetchHuggingFacePapers(new Set(), {
                fetchFn: async () => { throw new Error('async transport down'); },
                sleepFn: async () => {}
            }),
            error => error.code === 'SOURCE_FETCH_FAILED'
                && error.sourceHealth.attempts === 2
                && error.sourceHealth.failures.every(item => item.error === 'async transport down')
        );
    });

    it('两个 API 均成功返回空数组时是合法空结果', async () => {
        const papers = await fetchHuggingFacePapers(new Set(), {
            days: 7,
            minUpvotes: 0,
            fetchFn: () => ({ ok: true, data: [], error: null }),
            sleepFn: async () => {}
        });

        assert.deepStrictEqual(papers, []);
        assert.strictEqual(papers._sourceHealth.ok, true);
        assert.strictEqual(papers._sourceHealth.allFailed, false);
        assert.strictEqual(papers._sourceHealth.attempts, 2);
        assert.strictEqual(papers._sourceHealth.successfulRequests, 2);
    });

    it('一个必需 API 失败时按部分来源失败阻断，不能把不完整候选标成健康', async () => {
        await assert.rejects(() => fetchHuggingFacePapers(new Set(), {
            days: 7,
            minUpvotes: 0,
            fetchFn: url => url.includes('daily_papers')
                ? { ok: false, data: null, error: 'daily unavailable' }
                : { ok: true, data: [], error: null },
            sleepFn: async () => {}
        }), error => error.code === 'SOURCE_FETCH_FAILED'
            && error.sourceHealth.ok === false
            && error.sourceHealth.allFailed === false
            && error.sourceHealth.failures.length === 1);
    });

    it('非空数组却没有任何合法论文条目时拒绝假阳性成功', async () => {
        await assert.rejects(() => fetchHuggingFacePapers(new Set(), {
            days: 7,
            minUpvotes: 0,
            fetchFn: () => ({ ok: true, data: [{ id: 'missing-date' }], error: null }),
            sleepFn: async () => {}
        }), error => error.code === 'SOURCE_FETCH_FAILED'
            && error.sourceHealth.ok === false
            && error.sourceHealth.failures.some(item => /invalid paper items/.test(item.error)));
    });

    it('daily_papers 使用 HF 入选日期分页，不被旧 arXiv 日期提前截断', async () => {
        const selectedAt = new Date().toISOString();
        const firstPage = Array.from({ length: 100 }, (_, index) => ({
            publishedAt: selectedAt,
            paper: { id: `2607.${String(index).padStart(5, '0')}`, title: 'old but selected today', authors: [], publishedAt: '2020-01-01T00:00:00Z' }
        }));
        const urls = [];
        await fetchHuggingFacePapers(new Set(), {
            days: 7,
            minUpvotes: 0,
            fetchFn: url => {
                urls.push(url);
                if (url.includes('daily_papers') && url.includes('offset=0')) return { ok: true, data: firstPage };
                return { ok: true, data: [] };
            },
            sleepFn: async () => {}
        });
        assert.ok(urls.some(url => url.includes('daily_papers') && url.includes('offset=100')));
    });

    it('papers API 满页时继续分页，直到短页或日期截止线', async () => {
        const publishedAt = new Date().toISOString();
        const firstPage = Array.from({ length: 100 }, (_, index) => ({
            id: `2607.${String(index).padStart(5, '0')}`, title: 'new', authors: [], publishedAt
        }));
        const urls = [];
        await fetchHuggingFacePapers(new Set(), {
            days: 7,
            minUpvotes: 0,
            fetchFn: url => {
                urls.push(url);
                if (url.includes('daily_papers')) return { ok: true, data: [] };
                if (url.includes('offset=0')) return { ok: true, data: firstPage };
                return { ok: true, data: [] };
            },
            sleepFn: async () => {}
        });
        assert.ok(urls.some(url => url.includes('/api/papers') && url.includes('offset=100')));
    });

    it('papers API 忽略 offset 并重复同一满页时视为分页穷尽', async () => {
        const publishedAt = new Date().toISOString();
        const repeatedPage = Array.from({ length: 100 }, (_, index) => ({
            id: `2607.${String(index).padStart(5, '0')}`,
            title: 'new', authors: [], publishedAt
        }));
        const urls = [];
        const result = await fetchHuggingFacePapers(new Set(), {
            days: 7,
            fetchFn: url => {
                urls.push(url);
                if (url.includes('daily_papers')) return { ok: true, data: [] };
                return { ok: true, data: repeatedPage };
            },
            sleepFn: async () => {}
        });
        assert.strictEqual(result._sourceHealth.coverage.papersComplete, true);
        assert.strictEqual(urls.filter(url => url.includes('/api/papers')).length, 2);
    });
});

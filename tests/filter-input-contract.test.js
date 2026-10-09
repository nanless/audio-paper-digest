const { describe, it } = require('node:test');
const assert = require('node:assert');

const { buildFilterInputSha256: buildFromContract } = require('../scripts/lib/filter-input-contract.js');
const { buildFilterInputSha256: buildFromFetcher } = require('../scripts/fetch-papers.js');

// 期望值全部冻结。这些常量按约定独立算好后写死，没有调用 buildFilterInputSha256：
// 输入是 title、abstract、categories 三个键，categories 数组先 map(String) 再排序，
// 序列化用 JSON.stringify。测试样例数据若调用被测函数，就会跟着实现一起改变——把实现改成
// 「只计算 title 的 SHA-256」时测试仍然全部通过，筛选决策缓存就可能在只对上标题的情况下复用。
const FROZEN = Object.freeze({
    // { title:'  Audio Paper  ', abstract:'  Abstract  ', categories:['cs.SD','eess.AS'] }
    // 序列化后为 {"title":"Audio Paper","abstract":"Abstract","categories":["cs.SD","eess.AS"]}
    trimmedSorted: '2fbccae5f9ba6212effa6f5176f5ff90db32c62a36807f5ea7cbc723822abdc8',
    // { title:'Retryable speech paper', abstract:'speech recognition benchmark', categories:['cs.SD'] }
    retryablePaper: 'b7eca888c3985539c04239a18e5c96f5c96f18924d69b1d4bfbfb8118c7ce8be',
    // { title:'Same title', abstract:'first abstract', categories:['cs.SD'] }
    sameTitleFirstAbstract: 'b701375a9f6477491bbf48831f73b87da406a66e5267bc4f622c5ed794e5149b',
    // { title:'Same title', abstract:'second abstract', categories:['cs.SD'] }
    sameTitleSecondAbstract: '1567628db11e57610f8322e604654735381091d5f23fbb8ce5084f87ef4dec44',
    // { title:'Same title', abstract:'first abstract', categories:['eess.AS'] }
    sameTitleOtherCategory: '025b1277d49d0ce34c5cadf66c7fff2a5dec635984e4a9f1fc660dd72699b0e8',
    // { title:'T', summary:'  from summary  ' }
    summaryFallback: '9958c91a7b2b6667dc9aafc35703f5c1d7bf93de41746421690a02f876a301f2',
    // { title:'T', abstract:'A', categories:'cs.SD' }
    categoryString: '313ed28ae05ff40475820761899bb8684ddc54e2b6d7ffa608f673fa5e34bca9',
    // {}
    emptyInput: '6d1dd72f35f609e7ac3be4f1c845dc4b3a3ec6650394bf1fc63123ee52a1e2af',
    // { title:'语音识别', abstract:'中文摘要', categories:['cs.SD'] }
    chineseText: '862715aa7bbe2791d763f34dddee8362c4230610485c88f206113209599b4887'
});

const SAMPLES = Object.freeze({
    trimmedSorted: { title: '  Audio Paper  ', abstract: '  Abstract  ', categories: ['cs.SD', 'eess.AS'] },
    retryablePaper: { title: 'Retryable speech paper', abstract: 'speech recognition benchmark', categories: ['cs.SD'] },
    sameTitleFirstAbstract: { title: 'Same title', abstract: 'first abstract', categories: ['cs.SD'] },
    sameTitleSecondAbstract: { title: 'Same title', abstract: 'second abstract', categories: ['cs.SD'] },
    sameTitleOtherCategory: { title: 'Same title', abstract: 'first abstract', categories: ['eess.AS'] },
    summaryFallback: { title: 'T', summary: '  from summary  ' },
    categoryString: { title: 'T', abstract: 'A', categories: 'cs.SD' },
    emptyInput: {},
    chineseText: { title: '语音识别', abstract: '中文摘要', categories: ['cs.SD'] }
});

describe('filter-input-contract 筛选输入约定', () => {
    it('每类输入的 SHA-256 都等于冻结值，改动覆盖范围会失败', () => {
        for (const [name, paper] of Object.entries(SAMPLES)) {
            assert.strictEqual(buildFromContract(paper), FROZEN[name], `${name} 的 SHA-256 已偏离固定预期值`);
        }
    });

    it('筛选生成端与共享约定给出同一结果', () => {
        for (const [name, paper] of Object.entries(SAMPLES)) {
            assert.strictEqual(buildFromFetcher(paper), FROZEN[name], `${name} 经 fetch-papers 导出后哈希不一致`);
        }
    });

    it('分类顺序不影响哈希', () => {
        const reordered = {
            ...SAMPLES.trimmedSorted,
            categories: [...SAMPLES.trimmedSorted.categories].reverse()
        };
        assert.strictEqual(buildFromContract(reordered), FROZEN.trimmedSorted);
    });

    it('标题相同但摘要或分类不同，哈希必须不同', () => {
        const first = buildFromContract(SAMPLES.sameTitleFirstAbstract);
        const second = buildFromContract(SAMPLES.sameTitleSecondAbstract);
        const otherCategory = buildFromContract(SAMPLES.sameTitleOtherCategory);
        assert.notStrictEqual(first, second, '只比较标题就会把不同摘要的论文当成同一输入');
        assert.notStrictEqual(first, otherCategory, '只比较标题和摘要就会把不同分类的论文当成同一输入');
        assert.notStrictEqual(second, otherCategory);
    });

    it('哈希只由 title/abstract/categories 决定，其它字段不参与', () => {
        const withExtras = {
            ...SAMPLES.retryablePaper,
            arxivId: '2607.00999',
            sources: ['arxiv'],
            publishedAt: '2026-07-13T10:00:00.000+08:00'
        };
        assert.strictEqual(buildFromContract(withExtras), FROZEN.retryablePaper);
    });

    it('标题与摘要会先去掉首尾空白', () => {
        assert.strictEqual(
            buildFromContract({ title: 'Audio Paper', abstract: 'Abstract', categories: ['eess.AS', 'cs.SD'] }),
            FROZEN.trimmedSorted
        );
    });

    it('输出是 64 位十六进制字符串', () => {
        assert.match(buildFromContract(SAMPLES.retryablePaper), /^[a-f0-9]{64}$/);
    });
});

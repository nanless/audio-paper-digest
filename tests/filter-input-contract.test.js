const { describe, it } = require('node:test');
const assert = require('node:assert');

const { buildFilterInputSha256: buildFromContract } = require('../scripts/lib/filter-input-contract.js');
const { buildFilterInputSha256: buildFromFetcher } = require('../scripts/fetch-papers.js');

describe('filter-input-contract', () => {
    it('筛选生成端复用共享哈希契约，且不受分类原始顺序影响', () => {
        const paper = {
            title: '  Audio Paper  ',
            abstract: '  Abstract  ',
            categories: ['cs.SD', 'eess.AS']
        };
        const reordered = { ...paper, categories: ['eess.AS', 'cs.SD'] };

        assert.strictEqual(buildFromFetcher(paper), buildFromContract(paper));
        assert.strictEqual(buildFromContract(paper), buildFromContract(reordered));
        assert.match(buildFromContract(paper), /^[a-f0-9]{64}$/);
    });
});

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'unpublished-hf-'));
const config = require('../../scripts/config');
config.CURRENT_DIR = path.join(folder, 'current');
config.ARCHIVE_DIR = path.join(folder, 'archive');
fs.mkdirSync(config.CURRENT_DIR);
fs.mkdirSync(path.join(config.ARCHIVE_DIR, '2026-10-03'), { recursive: true });
for (const key of ['rawCandidates', 'filteredPapers', 'filterDecisions']) {
    config.FILES[key] = path.join(config.CURRENT_DIR, `${key}.json`);
}
config.FILTER_CONFIG.keywordPrefilterEnabled = false;
const api = require('../../scripts/full-fetch');
const engine = require('../../scripts/analysis-engine');
const { validAnalysisPaper } = require('../valid-analysis-fixture');
const { buildFilterInputSha256 } = require('../../scripts/fetch-papers');
const paper = { arxivId: '2610.00026', title: 'Speech recognition', abstract: 'Audio study', sources: ['huggingface'] };
const analyzed = validAnalysisPaper(paper.arxivId);
assert.equal(engine.isSuccessfulAnalysisRecord(analyzed), true);
fs.writeFileSync(path.join(config.ARCHIVE_DIR, '2026-10-03', 'deep-analysis-result.json'), JSON.stringify({ papers: [analyzed] }));
const provider = { boundaryIdentity: 'a'.repeat(64), window: { covered: true } };
const sourceHealth = { arxiv: { categories: config.ARXIV_CATEGORIES.map(category => ({ id: category.id, ok: true, provider })) }, huggingface: { ok: true, provider } };
async function main() {
    try {
        const result = await api.resumeFilterStage({
            allPapers: [paper], allPapersFiltered: [paper], sourceHealth,
            baseFilterStats: { sourceContractVersion: 7, batchDate: '2026-10-10', batchStartedAt: '2026-10-10T22:00:00+08:00' },
            initialDecisions: { [paper.arxivId]: { related: true, inputSha256: buildFilterInputSha256(paper),
                filterModel: 'local-test-only', filterPromptHash: 'b'.repeat(64), batchDate: '2026-10-10' } },
            filterModel: 'local-test-only', filterPromptHash: 'b'.repeat(64), today: '2026-10-10'
        });
        assert.equal(result.filteredNew.length, 1);
        assert.equal(result.skippedCount, 0);
        const saved = JSON.parse(fs.readFileSync(config.FILES.filteredPapers));
        assert.deepEqual(saved.excludedRelatedIds, []);
        assert.equal(saved.papers[0].arxivId, paper.arxivId);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

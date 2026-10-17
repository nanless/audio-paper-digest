'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('完整报告每篇仅分类核验一次，成功不落入豁免且下一报告重验最新失败', () => {
    const output = execFileSync(process.execPath, ['-e', `
        process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
        const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-once-'));
        try {
            const Config = require('./scripts/config');
            Config.CURRENT_DIR = root;
            for (const key of ['rawCandidates', 'filterDecisions', 'filteredPapers', 'deepAnalysisResult', 'analyzed'])
                Config.FILES[key] = path.join(root, key + '.json');
            for (const key of ['visualSummaryManifestDir', 'digestCoverManifestDir', 'analysisWaiverDir', 'postPublishVisualWaiverDir'])
                Config.FILES[key] = path.join(root, key);
            const engine = require('./scripts/analysis-engine'), counts = new Map(), actual = engine.isSuccessfulAnalysisRecord;
            engine.isSuccessfulAnalysisRecord = paper => {
                counts.set(paper.arxivId, (counts.get(paper.arxivId) || 0) + 1);
                return actual(paper);
            };
            // Only waiver classification is stubbed; this does not construct a valid
            // waiver, source or publication proof. Existing waiver tests check those.
            const waivers = require('./scripts/analysis-waiver');
            waivers.loadAnalysisWaiver = () => null;
            waivers.validateAnalysisWaiver = () => ({ valid: true, issues: [], paperIds: new Set(['2607.00001', '2607.00003']) });
            const { validAnalysisPaper } = require('./tests/valid-analysis-fixture');
            const papers = [validAnalysisPaper('2607.00001'),
                { ...validAnalysisPaper('2607.00002'), latestAnalysisAttemptError: 'latest attempt failed' },
                { arxivId: '2607.00003', error: 'waived failed fixture' },
                { arxivId: '2607.00004', error: 'failed fixture' }];
            papers.forEach(paper => { paper.batchDate = '2026-07-08'; });
            const save = () => fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ batchDate: '2026-07-08', papers }));
            save();
            const { buildDigestRunReport } = require('./scripts/digest-run-report');
            const first = buildDigestRunReport('2026-07-08', { today: '2026-07-08', archiveDir: path.join(root, 'archive') });
            assert.equal(first.analysis.successful, 1);
            assert.deepEqual(first.analysis.failedIds, ['2607.00002', '2607.00004']);
            assert.deepEqual(first.analysis.waivedIds, ['2607.00003']);
            assert.equal(first.overallStatus, 'incomplete');
            assert.deepEqual([...counts.values()], [1, 1, 1, 1]);
            papers[0].latestAnalysisAttemptError = 'new failure after the first report';
            save();
            const second = buildDigestRunReport('2026-07-08', { today: '2026-07-08', archiveDir: path.join(root, 'archive'), alreadyValid: true });
            assert.equal(second.analysis.successful, 0);
            assert.deepEqual(second.analysis.waivedIds, ['2607.00001', '2607.00003']);
            assert.deepEqual([...counts.values()], [2, 2, 2, 2]);
            assert.equal(second.overallStatus, 'incomplete');
            console.log(JSON.stringify({ checkedOncePerReport: true, latestFailureRetained: true }));
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    assert.match(output, /"checkedOncePerReport":true/);
});

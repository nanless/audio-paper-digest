'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../scripts/analysis-engine');
const tagRulesApi = require('../scripts/lib/tag-rules');
const { completedConferenceOriginalTaxonomyFixture: fixture }
    = require('./helpers/conference-readonly-qualification-fixture');

test('已完成会议按原词表只读重放，默认当前分析资格仍拒绝旧升级链', () => {
    const { paper, tagRules } = fixture();
    const before = JSON.stringify(paper);
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), false);
    assert.equal(engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules }), true);
    assert.equal(JSON.stringify(paper), before, '不重签或改写分析、Reader、评分、费用及历史');
    assert.equal(engine.isSuccessfulAnalysisRecord(paper), false);
    assert.equal(engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper), false);
    assert.equal(engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper,
        { tagRules: tagRulesApi.getDefaultTagRules() }), false);
});

test('原词表只读回放仍阻断正文、核心、Reader、评分、来源与最新失败', () => {
    const { paper, tagRules } = fixture();
    for (const mutate of [
        p => { p.source = 'arxiv'; },
        p => { p.sourceId += '-other'; },
        p => { p.analysis = '缺少正式章节的正文'; },
        p => { p.analysisManifest.stages.coreSummaryRepair.summarySha256 = '0'.repeat(64); },
        p => { p.apiReaderArticle += '未签名内容'; },
        p => { p.apiReaderAuthors.authors[0].name = 'Wrong Author'; },
        p => { p.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = '0'.repeat(64); },
        p => { p.analysisManifest.sourceAcquisition.sourceSha256 = '0'.repeat(64); },
        p => { p.analysisManifest.stages.apiReaderArticle.status = 'running'; },
        p => { p.latestAnalysisAttemptError = '本轮失败'; },
        p => { p.digestStatus = { latestAttemptStatus: 'analysis_failed' }; },
        p => { p.analysisManifest.manualTakeover = {}; },
        p => { p.analysisStageCheckpoints.taxonomySeal += '\n变更'; },
        p => { p.analysisManifest.stages.taxonomySeal.registryUpgradeFrom.toRegistrySha256 = '0'.repeat(64); },
        p => { p.analysisManifest.stages.taxonomySeal.registryUpgradeFrom.fromRegistrySha256 = '0'.repeat(64); },
        p => { p.analysisManifest.stages.taxonomySeal.registryUpgradeFrom.changeLevel = 'none'; }
    ]) {
        const changed = structuredClone(paper);
        mutate(changed);
        assert.equal(engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(changed, { tagRules }),
            false, mutate.toString());
    }
});

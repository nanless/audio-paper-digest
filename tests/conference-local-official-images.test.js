'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), Module = require('node:module');
const deep = require('../scripts/deep-analyzer');
const { fixture } = require('./reader-signed-draft-fixture');
const sha = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
const appliedAt = '2026-10-18T10:00:00.000+08:00';

// This is stage-derivation coverage, not conference admission or whole-paper
// qualification. The Reader surface comes from the existing real parser fixture.
function sample() {
    const f = fixture(), paper = f.paper;
    paper.id = 'conference:interspeech:2026:conference-paper-id:fixture26_interspeech';
    paper.source = 'conference';
    const source = { ...f.sourceDetails, source: 'conference_pdf_text', sourceId: paper.id, imageInfos: [] };
    delete source.freshSourceDescriptor;
    paper.analysis = paper.analysisCheckpoint = 'Exact existing scoring checkpoint; no scientific qualification claimed.';
    paper.analysisStageCheckpoints = { scoringAudit: paper.analysis };
    paper.imageManifest = { totalFound: 0, candidates: [], downloaded: [], selected: [], downloadOutcomes: [] };
    Object.assign(paper.analysisManifest.stages, {
        imageDownload: { status: 'no_candidates', attempted: 0, downloaded: 0, outcomes: [], fingerprint: 'a'.repeat(64) },
        scoringAudit: { status: 'complete', scoringContract: 'api-scoring-audit-v2', outputAnalysisSha256: sha(paper.analysis) }
    });
    Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
        executionKind: 'operator', model: 'operator-local', protocol: 'local_operator',
        newReaderApiRequests: 0, operatorProvenance: { appliedAt }
    });
    return { paper, source };
}

test('会议本地图收尾与实际正常official标记相同，固定时间可冷重放且不改输入', () => {
    const filename = require.resolve('../scripts/deep-analyzer');
    const compiled = new Module(filename, module);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(require('node:path').dirname(filename));
    compiled._compile(fs.readFileSync(filename, 'utf8')
        + '\nmodule.exports.testOfficial={markOfficialReaderImageSupplement,buildImageSupplementBaseFingerprint};\n', filename);
    const { paper, source } = sample(), before = structuredClone({ paper, source });
    const contract = deep.currentPromptTextContract('imageSupplement');
    const fingerprint = deep.buildImageSupplementFingerprint(
        compiled.exports.testOfficial.buildImageSupplementBaseFingerprint(contract), [], [], paper.analysis);
    const normal = { stages: {} };
    compiled.exports.testOfficial.markOfficialReaderImageSupplement(normal, paper.apiReaderFigures, fingerprint, contract, appliedAt);
    const actual = deep.deriveConferenceLocalOfficialImageSupplement(paper, source, { appliedAt });
    assert.deepStrictEqual(actual, normal.stages.imageSupplement);
    assert.equal(actual.reason, 'api_reader_v3_official_figures_bound');
    assert.equal(actual.officialFigureCount, paper.apiReaderFigures.length);
    assert.equal(actual.updatedAt, appliedAt);
    assert.deepStrictEqual(deep.deriveConferenceLocalOfficialImageSupplement(paper, source, { appliedAt }), actual);
    assert.deepStrictEqual({ paper, source }, before);
});

test('原候选/下载/来源/新Reader或评分不满足时不能派生缺失阶段', () => {
    const changes = [
        x => { x.paper.source = 'arxiv'; },
        x => { x.source.sourceId += '-other'; },
        x => { x.source.text += 'changed'; },
        x => { x.paper.analysisManifest.sourceAcquisition.sourceSha256 = 'b'.repeat(64); },
        x => { x.paper.analysisManifest.stages.imageDownload.status = 'pending'; },
        x => { x.paper.analysisManifest.stages.imageDownload.attempted = 1; },
        x => { x.paper.analysisManifest.stages.imageDownload.downloaded = 1; },
        x => { x.paper.analysisManifest.stages.imageDownload.outcomes.push({}); },
        x => { x.paper.imageManifest.totalFound = 1; },
        ...['candidates','downloaded','selected','downloadOutcomes'].map(key => x => { x.paper.imageManifest[key].push({}); }),
        x => { x.source.imageInfos.push({}); },
        x => { x.paper.analysisManifest.stages.apiReaderArticle.status = 'invalid_output'; },
        x => { x.paper.apiReaderFigures[0].caption += 'changed'; },
        x => { x.paper.apiReaderArticle += 'changed'; },
        x => { x.paper.apiReaderPlan.readerTitle += 'changed'; },
        x => { x.paper.analysisManifest.stages.apiReaderArticle.newReaderApiRequests = 1; },
        x => { x.paper.analysisManifest.stages.scoringAudit.status = 'invalid_output'; },
        x => { x.paper.analysisStageCheckpoints.scoringAudit += 'changed'; },
        x => { x.paper.analysisCheckpoint += 'changed'; },
        x => { x.paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = 'b'.repeat(64); },
        x => { x.paper.analysisManifest.stages.apiReaderArticle.operatorProvenance.appliedAt = 'different'; }
    ];
    for (const [index, change] of changes.entries()) {
        const value = sample(); change(value);
        assert.throws(() => deep.deriveConferenceLocalOfficialImageSupplement(value.paper, value.source, { appliedAt }),
            /会议本地Reader官方图收尾/, `negative ${index + 1}`);
    }
    const value = sample();
    assert.throws(() => deep.deriveConferenceLocalOfficialImageSupplement(value.paper, value.source, { appliedAt: 'invalid' }));
});

test('原已有插图阶段不重写，零张已绑定Reader图也可走同一正常零候选派生', () => {
    const { paper, source } = sample();
    const original = { status: 'complete', marker: 'retain original exact' };
    paper.analysisManifest.stages.imageSupplement = original;
    assert.equal(deep.deriveConferenceLocalOfficialImageSupplement(paper, source, { appliedAt }), null);
    assert.strictEqual(paper.analysisManifest.stages.imageSupplement, original);
    delete paper.analysisManifest.stages.imageSupplement;
    paper.apiReaderFigures = [];
    Object.assign(paper.analysisManifest.stages.apiReaderArticle,
        { figureCount: 0, figuresSha256: deep.stableFingerprint([]) });
    assert.equal(deep.deriveConferenceLocalOfficialImageSupplement(paper, source, { appliedAt }).officialFigureCount, 0);
});

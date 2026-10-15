'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const contract = require('../../scripts/analysis-contract');
const tagRulesApi = require('../../scripts/lib/tag-rules');
const catalogApi = require('../../scripts/lib/tag-catalog');
const change = require('../../scripts/lib/tag-catalog-change');
const { LEGACY_TAG_STAGE_BINDING_FIELDS } = require('../../scripts/lib/tag-stage-record');
const { validAnalysisPaper, validLegacyApiAnalysisPaper } = require('../valid-analysis-fixture');

const originalSha = 'a3b75a149852076933ec2895de77c09c73667c8334bff046dde3b20b69ded03d';
const predecessorSha = '15c82a567ce5a55dc1175684ed08b64c158558639d9c8fb822c9587ec32a8778';
function archived(sha) {
    const catalog = catalogApi.loadTagCatalog(path.join(__dirname, '../../config/tag-catalog-history', sha + '.json'));
    assert.equal(catalog.registrySha256, sha);
    return catalog;
}

function completedConferenceOriginalTaxonomyFixture() {
    const paper = validLegacyApiAnalysisPaper('fixture');
    const base = validAnalysisPaper('fixture');
    paper.analysisManifest.contracts = { ...paper.analysisManifest.contracts, ...base.analysisManifest.contracts };
    paper.analysisManifest.stages = { ...base.analysisManifest.stages, ...paper.analysisManifest.stages,
        coreSummaryRepair: base.analysisManifest.stages.coreSummaryRepair,
        taxonomySeal: base.analysisManifest.stages.taxonomySeal };
    Object.assign(paper.analysisManifest.stages.scoringAudit, base.analysisManifest.stages.scoringAudit);
    paper.analysisStageCheckpoints = { ...base.analysisStageCheckpoints, coreSummaryRepair: paper.analysis };
    paper.id = 'conference:interspeech:2026:conference-paper-id:fixture';
    paper.conferencePaperId = paper.sourceId = paper.id;
    paper.arxivId = null;
    paper.source = 'conference';
    paper.analysisSource = 'conference_pdf_text';
    const original = archived(originalSha), predecessor = archived(predecessorSha);
    const tagRules = tagRulesApi.createTagRules({ tagCatalog: original });
    const stage = paper.analysisManifest.stages.taxonomySeal;
    Object.assign(stage, {
        registryVersion: tagRules.registryVersion, registrySha256: tagRules.registrySha256,
        projectionContract: tagRules.projectionContract, projectionSha256: tagRules.projectionSha256
    });
    const { detail, changeLevel } = change.classifyRegistryChange(predecessor, original);
    stage.registryUpgradeFrom = change.buildRegistryUpgradeAnnotation({ from: predecessor, to: original,
        changeLevel, detail, note: '离线测试重放原词表升级链', acknowledgeDestructive: true });
    stage.bindingSha256 = contract.manualSha256(Object.fromEntries(
        LEGACY_TAG_STAGE_BINDING_FIELDS.map(key => [key, stage[key]])
    ));
    return { paper, tagRules };
}

module.exports = { completedConferenceOriginalTaxonomyFixture };

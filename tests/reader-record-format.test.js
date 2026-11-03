'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const codec = require('../scripts/lib/protocol-codec');
const format = require('../scripts/lib/reader-record-format');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const header = () => codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
const modern = draft => { const { version, ...body } = draft; return { ...header(), ...body }; };

function sample() {
    const fixture = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const options = { arxivId: fixture.paper.arxivId, sourceText: fixture.sourceDetails.text,
        structuredArtifacts: fixture.sourceDetails.structuredArtifacts, availableFigureOrdinals: [],
        requireSourceBindings: true, requireIntegratedTables: true, minimumIntegratedTables: 2 };
    return { ...fixture, options };
}

test('unversioned current draft compiles the same article; original draft remains byte-exact under original compilation', () => {
    const value = sample(), oldBefore = JSON.stringify(value.draft);
    const original = deep.parseApiReaderArticleResult(oldBefore, value.options);
    const currentDraft = modern(value.draft);
    const current = deep.parseApiReaderArticleResult(JSON.stringify(currentDraft), value.options);
    assert.equal(current.article, original.article);
    assert.equal(original.plan.version, 3);
    assert.equal(original.plan.contract, codec.historicalContract('beginner-researcher', format.INTEGRATED));
    assert.equal(current.plan.version, undefined);
    assert.equal(codec.isCurrentHeader(current.plan, 'beginner-researcher'), true);
    assert.deepEqual(repair.parseRecoveryDraft(currentDraft), currentDraft);
    assert.deepEqual(repair.parseRecoveryDraft(value.draft), value.draft);
    assert.equal(JSON.stringify(value.draft), oldBefore);
    const observedLegacyResponse = deep.parseApiReaderArticleResult(oldBefore, { ...value.options, compileCurrent: true });
    assert.equal(codec.isCurrentHeader(observedLegacyResponse.plan, 'beginner-researcher'), true);
    assert.equal(observedLegacyResponse.article, original.article);
});

test('compact old draft cannot be promoted, mixed and unknown headers cannot fall back to a numeric version', () => {
    const value = sample();
    for (const bad of [{ ...modern(value.draft), version: 3 },
        { ...modern(value.draft), schemaFingerprint: 'f'.repeat(64) },
        { ...modern(value.draft), contract: 'unregistered-reader' },
        { ...value.draft, version: '3' }, { ...value.draft, version: true }, { ...value.draft, version: 4 }]) {
        assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(bad), value.options));
        assert.equal(repair.parseRecoveryDraft(bad), null);
    }
    const compact = { ...value.draft, version: 2 };
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(compact), { ...value.options,
        compileCurrent: true, requiredProfile: format.INTEGRATED }), /禁止|不能/);
    assert.throws(() => format.assertRequiredProfile(format.draftFormat(compact), { compileCurrent: true }), /不能/);
});

test('current article template declares exactly the actual current schema header', () => {
    const file = require('../scripts/lib/prompt-contracts').currentTextStagePromptPath('apiReaderArticle');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('"contract": "reader-draft"'));
    assert.ok(raw.includes(JSON.stringify(header().schemaFingerprint)));
    assert.equal(format.profileForOptions({ version: 2 }), format.COMPACT);
    assert.equal(format.profileForOptions({ version: 3 }), format.INTEGRATED);
    assert.equal(format.profileForOptions(), format.INTEGRATED);
});

test('current compiled Reader passes normal engine qualification and cannot borrow original flat metadata', () => {
    const value = sample(), paper = structuredClone(value.paper);
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(modern(value.draft)), value.options);
    const rendered = deep.injectApiReaderFigures(parsed, value.sourceDetails.structuredArtifacts, paper.arxivId);
    const protocols = require('../scripts/lib/reader-stage-protocols');
    const identities = require('../scripts/lib/reader-identity-format');
    const hash = require('../scripts/lib/fresh-rewrite-run').stableHash;
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    paper.apiReaderArticle = rendered.article;
    paper.apiReaderPlan = rendered.plan;
    paper.analysisManifest.contracts.apiReaderArticle = rendered.plan.contract;
    paper.analysisManifest.contracts.apiReaderSourceBindings = rendered.plan.sourceBindingsContract;
    for (const key of protocols.flatFields) delete stage[key];
    stage.qualityMetrics = parsed.qualityMetrics;
    Object.assign(stage, protocols.stageFields(rendered.plan, parsed.qualityMetrics));
    const { contract: oldAuthor, ...authorBody } = paper.apiReaderAuthors.identity;
    paper.apiReaderAuthors.identity = { ...identities.header('authors'), ...authorBody };
    paper.apiReaderAuthors.identitySha256 = hash(paper.apiReaderAuthors.identity);
    const { contract: oldResource, identitySha256, ...resourceBody } = paper.apiReaderResources;
    paper.apiReaderResources = { ...identities.header('resources'), ...resourceBody };
    paper.apiReaderResources.identitySha256 = hash(paper.apiReaderResources);
    paper.analysisManifest.contracts.apiReaderAuthorIdentity = paper.apiReaderAuthors.identity.contract;
    paper.analysisManifest.contracts.apiReaderResourceIdentity = paper.apiReaderResources.contract;
    delete stage.readerAuthorIdentityContractVersion; delete stage.resourceIdentityContractVersion;
    stage.readerAuthorIdentitySha256 = paper.apiReaderAuthors.identitySha256;
    stage.readerAuthorsSha256 = hash(paper.apiReaderAuthors);
    stage.resourceIdentitySha256 = paper.apiReaderResources.identitySha256;
    Object.assign(stage, identities.stageFields(paper.apiReaderAuthors, paper.apiReaderResources));
    const scan = paper.analysisManifest.stages.openSourceScan;
    delete scan.resourceEvidenceContract;
    Object.assign(scan, identities.openSourceFields(paper.apiReaderResources));
    scan.resourceEvidenceSha256 = paper.apiReaderResources.identitySha256;
    require('./reader-signed-draft-fixture').sign(paper);
    const engine = require('../scripts/analysis-engine');
    assert.equal(engine.hasValidIntegratedApiReaderRecords(paper), true);
    for (const mutate of [
        p => { p.analysisManifest.stages.apiReaderArticle.parserVersion = 'api-reader-parser-v3'; },
        p => { delete p.analysisManifest.stages.apiReaderArticle.readerProtocols; },
        p => { p.apiReaderPlan.schemaFingerprint = 'f'.repeat(64); },
        p => { delete p.apiReaderPlan.sourceBindingsSchemaFingerprint; },
        p => { p.analysisManifest.stages.apiReaderArticle.readerProtocols.qualityMetrics.schemaFingerprint = 'f'.repeat(64); },
        p => { delete p.apiReaderAuthors.identity.schemaFingerprint; },
        p => { p.apiReaderResources.schemaFingerprint = 'f'.repeat(64); },
        p => { p.analysisManifest.stages.apiReaderArticle.readerAuthorIdentityContractVersion = oldAuthor; },
        p => { p.analysisManifest.stages.openSourceScan.resourceEvidenceContract = oldResource; },
        p => { p.apiReaderPlan.formulaBindings[0].sourceDomSha256 = 'f'.repeat(64); }
    ]) {
        const changed = structuredClone(paper); mutate(changed);
        assert.equal(engine.hasValidIntegratedApiReaderRecords(changed), false);
    }
});

test('unchanged completed source scans retain original bytes during Reader-only format migration', () => {
    const value = sample(), identities = require('../scripts/lib/reader-identity-format');
    const stage = structuredClone(value.paper.analysisManifest.stages.openSourceScan);
    const before = JSON.stringify(stage);
    identities.assignOpenSourceBinding(stage, value.paper.apiReaderResources);
    assert.equal(JSON.stringify(stage), before);
    assert.equal(identities.openSourceBinding(stage, value.paper.apiReaderResources), true);
    const { contract, identitySha256, ...body } = value.paper.apiReaderResources;
    const current = { ...identities.header('resources'), ...body };
    const fresh = { status: 'complete' };
    identities.assignOpenSourceBinding(fresh, current);
    assert.deepEqual(fresh.resourceEvidenceProtocol, identities.header('resources'));
    assert.equal(fresh.resourceEvidenceContract, undefined);
    assert.equal(identities.openSourceBinding(fresh, current), true);
    const mixed = { ...fresh, resourceEvidenceContract: contract };
    assert.equal(identities.openSourceBinding(mixed, current), false);
});

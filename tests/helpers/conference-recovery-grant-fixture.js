'use strict';
// Synthetic grant bookkeeping around caller-created real plan/PDF fixtures.
// This fixture never grants production work or proves a paper's completion.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const processApi = require('../../scripts/lib/conference-process');
const adapter = require('../../scripts/lib/conference-analysis-adapter');
const grants = require('../../scripts/lib/conference-recovery-grant');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function recoveryFixtureIdentity(paperId) {
    const authority = { conferenceId: 'odyssey-2026', implementationSha256: 'b'.repeat(64),
        tagCatalogVersion: 'fixture-current', tagCatalogSha256: 'a'.repeat(64),
        deepExecutionConfig: processApi.currentDeepExecutionConfigIdentity(processApi.defaultDependencies()) };
    const processId = processApi.deterministicUuid(processApi.stableHash(authority), processApi.CONTRACT);
    return { authority, processId, parentExecutionId: processApi.deterministicUuid(processId, paperId, 'analysis') };
}
function registerRecoveryFixture({ analysisRoot, parentExecutionId, failedExecutionId, paperId,
    grantId = '11111111-2222-4333-8444-555555555555', install = true }) {
    const identity = recoveryFixtureIdentity(paperId);
    if (parentExecutionId !== identity.parentExecutionId) throw Error('fixture parent must use recoveryFixtureIdentity');
    const repositoryRoot = path.resolve(analysisRoot, '../../..');
    const parent = adapter.loadConferenceAnalysis({ analysisRoot, executionId: parentExecutionId });
    const failed = adapter.loadConferenceReaderRevision({ analysisRoot, executionId: failedExecutionId });
    const recordCAS = {};
    for (const executionId of [parentExecutionId, failedExecutionId]) {
        const folder = path.join(analysisRoot, executionId);
        for (const name of ['analysis.json', 'run.json', 'source.json', 'reader-revision.json', 'reader-resource-preflight.json']) {
            const filename = path.join(folder, name);
            if (fs.existsSync(filename)) recordCAS[path.relative(repositoryRoot, filename).split(path.sep).join('/')] = sha(fs.readFileSync(filename));
        }
        const candidates = path.join(folder, 'reader-attempts');
        if (fs.existsSync(candidates)) for (const name of fs.readdirSync(candidates).filter(value => /^[a-f0-9]{64}\.json$/u.test(value))) {
            const filename = path.join(candidates, name);
            recordCAS[path.relative(repositoryRoot, filename).split(path.sep).join('/')] = sha(fs.readFileSync(filename));
        }
    }
    const member = { paperId, parentExecutionId, childExecutionId: failedExecutionId,
        sourceTextSha256: sha(failed.source.sourceDetails.text),
        sourceSnapshotSha256: failed.run.sourceSnapshotSha256, recordCAS };
    const state = { contract: processApi.CONTRACT, version: processApi.PROCESS_VERSION, generation: 1,
        processId: identity.processId, createdAt: '2026-10-17T12:00:00.000Z', updatedAt: '2026-10-17T12:00:00.000Z',
        authority: identity.authority, status: 'partial', aggregate: null, completionReceiptSha256: null,
        items: { [paperId]: { paperId, sourceIdentity: {}, analysisRunId: parentExecutionId,
            status: 'analysis_partial', attempts: 3, pageProof: null, updatedAt: '2026-10-17T12:00:00.000Z' } } };
    const item = state.items[paperId];
    Object.assign(item, { status: 'analysis_partial', attempts: 3,
        sourceProof: { textSha256: member.sourceTextSha256 },
        analysisProof: { analysisSha256: parent.analysisFileSha256, sourceSnapshotSha256: member.sourceSnapshotSha256 },
        lastError: 'original exhausted fixture', lastFailure: { retryable: false } });
    state.status = 'partial'; state.stateSha256 = processApi.stateDigest(state); processApi.assertState(state);
    const processDirectory = path.join(path.dirname(analysisRoot), 'conference-processes', identity.processId);
    fs.mkdirSync(processDirectory, { recursive: true, mode: 0o700 });
    const baseline = Buffer.from(JSON.stringify(state, null, 2) + '\n');
    fs.writeFileSync(path.join(processDirectory, 'state.json'), baseline, { mode: 0o600 });
    const body = { contract: grants.CONTRACT, version: 1, grantId, processId: identity.processId,
        baselineStateFileSha256: sha(baseline), baselineGeneration: state.generation,
        inventorySha256: processApi.stableHash([member]),
        approval: { kind: 'explicit-human', reference: 'synthetic-offline-fixture-only', answer: 'fixture approval', approvedAt: '2026-10-17T12:00:00Z' },
        limits: { maxRounds: 3, readerContentResponses: 6, readerFullResponses: 2, readerTransportAttempts: 2 }, members: [member] };
    const manifest = { ...body, manifestSha256: processApi.stableHash(body) };
    const manifestPath = path.join(repositoryRoot, 'fixture-grant.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const handle = install ? grants.openRecoveryGrant({ analysisRoot, processDirectory, manifestPath, install: true }) : null;
    return { manifest, manifestPath, processDirectory, state, handle, member, failed, parent,
        options: { manifestPath, processDirectory, analysisRoot }, repositoryRoot };
}
module.exports = { recoveryFixtureIdentity, registerRecoveryFixture };

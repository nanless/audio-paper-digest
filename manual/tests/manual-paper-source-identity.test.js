const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
    MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT,
    buildManualPaperSourceIdentity,
    validateManualPaperSourceIdentity
} = require('../scripts/manual-paper-source-identity.js');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);
const F = 'f'.repeat(64);

function fixture(id = '2608.12345') {
    const fullTextEntry = {
        status: 'complete', requestedArxivId: id,
        path: `/controlled/${id}.txt`, sourceSha256: A,
        sourceIdentitySha256: B, paperMetadataSha256: C,
        paperInputSha256: D, bytes: 1234,
        imageInfos: [{ url: 'https://arxiv.org/figure.png', caption: 'method' }],
        structuredArtifactsSnapshot: {
            healthStatus: 'complete', payloadSha256: E
        }
    };
    const artifactEntry = {
        status: 'complete', inventoryStatus: 'complete', paperId: id,
        parserVersion: 'manual-artifact-parser-v2-structured',
        path: `/controlled/artifacts/${id}.json`, sourceSha256: A,
        sourceIdentitySha256: B, paperInputSha256: D,
        structuredArtifactsSha256: E, artifactIndexSha256: F,
        outputSha256: C, bytes: 5678
    };
    return { date: '2026-08-27', paperId: id, fullTextEntry, artifactEntry };
}

describe('manual per-paper source identity', () => {
    it('does not depend on another paper or a date-level manifest byte hash', () => {
        const own = fixture();
        const before = buildManualPaperSourceIdentity(own);
        const unrelatedManifestState = {
            papers: {
                [own.paperId]: { ...own.artifactEntry },
                '2608.99999': { outputSha256: A, bytes: 1 }
            }
        };
        unrelatedManifestState.papers['2608.99999'].outputSha256 = B;
        unrelatedManifestState.papers['2608.99999'].bytes = 2;
        const after = buildManualPaperSourceIdentity(own);
        assert.equal(before.contract, MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT);
        assert.equal(after.sha256, before.sha256);
    });

    it('fails closed when this paper full text, images, structured evidence, or ArtifactIndex changes', () => {
        const own = fixture();
        const declared = buildManualPaperSourceIdentity(own);
        assert.doesNotThrow(() => validateManualPaperSourceIdentity(declared, own));
        const mutations = [
            value => { value.fullTextEntry.sourceSha256 = F; value.artifactEntry.sourceSha256 = F; },
            value => { value.fullTextEntry.imageInfos[0].caption = 'changed'; },
            value => {
                value.fullTextEntry.structuredArtifactsSnapshot.payloadSha256 = F;
                value.artifactEntry.structuredArtifactsSha256 = F;
            },
            value => { value.artifactEntry.outputSha256 = B; }
        ];
        for (const mutate of mutations) {
            const changed = JSON.parse(JSON.stringify(own));
            mutate(changed);
            assert.throws(
                () => validateManualPaperSourceIdentity(declared, changed),
                /paperSourceIdentity 与当前单篇全文\/ArtifactIndex 不一致/
            );
        }
    });
});

const crypto = require('node:crypto');
const { normalizedId } = require('../scripts/utils.js');

function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
    }
    return value;
}

function stableSha256(value) {
    return crypto.createHash('sha256')
        .update(Buffer.from(JSON.stringify(stableJson(value)), 'utf8')).digest('hex');
}

function stableApiBindingsSha256(value) {
    const encoded = JSON.stringify(stableJson(value)).replace(
        /("finalScore":)(-?\d+)(?=[,}])/g,
        '$1$2.0'
    );
    return crypto.createHash('sha256').update(Buffer.from(encoded, 'utf8')).digest('hex');
}

function productionV6GenerationFields(papers) {
    const root = '1'.repeat(64);
    const bindings = papers.map((paper, index) => {
        const marker = ((index + 2) % 10).toString().repeat(64);
        return {
            paperId: normalizedId(paper),
            manualDepth: 'full-text-evidence-v6', runtimeMode: 'production',
            specVersion: 6, specRootSha256: root, paperSpecSha256: marker,
            recordSemanticSha256: marker, recordFileSha256: marker,
            artifactIndexSha256: marker, artifactIndexFileSha256: marker,
            recordsEnvelopeFileSha256: marker, taskEvidenceSha256: marker,
            readerLongformContract: 'reader-longform-v2',
            readerLongformSha256: marker, readerArticleSha256: marker
        };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    const bindingsFingerprint = stableSha256(bindings);
    const proof = {
        contract: 'manual-v6-production-publication-v1',
        manualDepth: 'full-text-evidence-v6', runtimeMode: 'production',
        specVersion: 6, recordsVersion: 4,
        readerLongformContract: 'reader-longform-v2',
        specMerkleRootSha256: root, paperCount: bindings.length,
        paperIds: bindings.map(item => item.paperId), bindingsFingerprint
    };
    return {
        publicationMode: 'manual_v6_production',
        manualV6Bindings: bindings,
        manualV6BindingsFingerprint: bindingsFingerprint,
        manualV6Production: proof,
        manualV6ProductionFingerprint: stableSha256(proof)
    };
}

function productionV6ReceiptFields(generation) {
    return {
        publicationMode: 'manual_v6_production',
        manualV6ProductionFingerprint: generation.manualV6ProductionFingerprint,
        postPublishVisuals: 'required'
    };
}

function llmApiProductionGenerationFields(papers) {
    const bindings = papers.map((paper, index) => {
        const marker = ((index + 2) % 10).toString().repeat(64);
        return {
            paperId: normalizedId(paper),
            readerContract: 'beginner-researcher-v2',
            readerArticleSha256: marker, readerPlanSha256: marker,
            readerFiguresSha256: marker, readerAuthorsSha256: marker,
            analysisSha256: marker, sourceSha256: marker,
            scoringContract: 'api-scoring-audit-v2',
            scoringAuditSha256: marker, scoringEvidenceSha256: marker,
            finalScore: Number(paper?.parsed?.score ?? 5),
            model: 'muse-spark-1.2-contributor', protocol: 'openai_responses'
        };
    }).sort((left, right) => left.paperId.localeCompare(right.paperId));
    const bindingsFingerprint = stableApiBindingsSha256(bindings);
    const proof = {
        contract: 'llm-api-production-publication-v1',
        readerContract: 'beginner-researcher-v2',
        scoringContract: 'api-scoring-audit-v2',
        paperCount: bindings.length,
        paperIds: bindings.map(item => item.paperId),
        bindingsFingerprint
    };
    return {
        publicationMode: 'llm_api_production',
        llmApiBindings: bindings,
        llmApiBindingsFingerprint: bindingsFingerprint,
        llmApiProduction: proof,
        llmApiProductionFingerprint: stableSha256(proof)
    };
}

function llmApiProductionReceiptFields(generation) {
    return {
        publicationMode: 'llm_api_production',
        llmApiProductionFingerprint: generation.llmApiProductionFingerprint,
        manualV6ProductionFingerprint: null,
        postPublishVisuals: 'required'
    };
}

module.exports = {
    productionV6GenerationFields,
    productionV6ReceiptFields,
    llmApiProductionGenerationFields,
    llmApiProductionReceiptFields
};

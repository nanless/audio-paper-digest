'use strict';
// Valid synthetic record metadata for tests of protected upstream hashing. This
// does not create a selected-run scope, hold a paper lock, or grant a reset.
module.exports = function selectedRecord({ originalPaper, runId, sourceRunId, historical = false,
    inheritedFeedbacks = [], currentFeedbackProof = null }) {
    const crypto = require('node:crypto');
    const registry = require('../../scripts/lib/prompt-contracts');
    const legacy = require('../../scripts/lib/prompt-legacy-codec');
    const evidence = require('../../scripts/lib/prompt-evidence');
    const codec = require('../../scripts/lib/protocol-codec');
    const name = 'selected-muse-full-stage-reanalysis';
    const tag = historical ? codec.historicalContract(name, 'original-selection') : codec.contract(name);
    const promptBindings = Object.fromEntries(['primaryAnalysis', 'apiReaderArticle', 'apiReaderRepair',
        'revision', 'methodRepair', 'coreSummaryRepair', 'structureRepair'].map(stage => {
        const row = historical ? legacy.originalCurrent[stage] : registry.PROMPT_FILE_VERSIONS[stage];
        return [stage, { ...row, fileSha256: crypto.createHash('sha256')
            .update(evidence.readPromptEvidenceBytes(row.path)).digest('hex') }];
    }));
    return { ...codec.recordHeader(tag, name), runId, sourceRunId,
        model: 'muse-spark-1.3-contributor', promptBindings,
        originalPaperSha256: crypto.createHash('sha256').update(JSON.stringify(originalPaper)).digest('hex'),
        inheritedFeedbacks, currentFeedbackProof, startedAt: '2026-11-03T00:00:00.000Z' };
};

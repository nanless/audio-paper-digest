'use strict';

// Single-source Reader parser implementation fingerprint registry.
// Splits shared core parser/extraction/protocol files from per-workflow
// adapters so editing a conference or historical adapter never invalidates
// daily Reader fingerprints (while daily/conference/historical each remain
// strictly sensitive to their own actual code).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const shaText = value => crypto.createHash('sha256').update(String(value)).digest('hex');

const PARSER_CORE_FILES = Object.freeze([
    'deep-analyzer.js',
    'lib/scoring-audit-contract.js',
    'lib/scoring-rubric-v2.js',
    '../config/scoring-rubric-v2.json',
    'lib/public-resource-probe.js',
    'lib/reader-repair-evidence-slice.js',
    'lib/reader-resource-claims.js',
    'lib/arxiv-html-structured-artifacts.js',
    'lib/reader-source-evidence-binding.js',
    'lib/reader-prose-normalization.js',
    'analysis-contract.js',
    'lib/experiment-source-setting-axes.js',
    'utils.js',
    'lib/llm-usage.js',
    'lib/llm-pending-request.js',
    'lib/llm-response-recovery.js',
    'lib/active-time-budget.js',
    'lib/analysis-section-titles.js',
    'lib/reader-inline-svg.js',
    'lib/reader-sealed-figure-alias.js',
    'lib/reader-resource-binding.js',
    'lib/signed-reader-recovery-draft.js',
    'lib/reader-paid-response-replay.js',
    'lib/reader-recovery-revision.js',
    'lib/reader-target-ordinal-patch.js',
    'lib/reader-record-format.js',
    'lib/reader-stage-protocols.js',
    'lib/reader-candidate-format.js',
    'lib/reader-diagnostic-format.js',
    'lib/reader-ordinal-format.js',
    'lib/reader-section-format.js',
    'lib/reader-identity-format.js',
    'lib/reader-resource-claims-format.js',
    'lib/reader-proof-format.js',
    'lib/reader-content-mode.js',
    'lib/protocol-codec.js',
    'lib/reader-legacy-records.json',
    '../config/protocols/reader.json',
    '../config/protocols/reader-retry.json',
    'lib/reader-compatible-candidate-replay.js',
    'lib/explicit-reader-retry-round.js',
    'lib/reader-transport-continuation.js',
    'lib/reader-parent-recovery.js',
    'lib/reader-fact-pre-request-recovery.js',
    'lib/reader-proof-read-scope.js',
    'lib/reader-pre-image-check.js',
    'lib/reader-unsent-empty-candidate.js',
    'lib/reader-malformed-previous-draft-view.js',
    'lib/reader-fact-table-claim-location.js',
    'lib/reader-table-narrative-labels.js',
    'lib/reader-source-display.js',
    'lib/source-cell-math-display.js',
    'lib/reader-scientific-quote-coverage.js',
    'lib/reader-source-metric-units.js',
    'lib/reader-sealed-pdf-quote-evidence.js',
    'lib/reader-sealed-pdf-column-units.js',
    'lib/reader-source-table-column-units.js',
    'lib/reader-authenticated-pdf-table-evidence.js',
    'lib/reader-authenticated-pdf-footnote-evidence.js',
    'lib/reader-pdf-extraction-scope.js',
    'lib/pdf-layout.js',
    'pdf-layout-extract.py',
    'reader_sealed_pdf_column_units.py',
    'reader_pdf_column_unit_projection.py',
    'reader_sealed_pdf_literal_column_units.py',
    'reader_sealed_pdf_quote_evidence.py',
    'reader_pdf_quote_projection.py',
    'reader_authenticated_pdf_hierarchical_table.py',
    'reader_authenticated_pdf_footnote_evidence.py',
    'lib/reader-source-blocked-normalization.js',
    'lib/reader-dom-span-projection.js',
    'lib/reader-parent-upstream-preflight.js',
    'lib/reader-resource-input-admission.js',
    'lib/reader-next-request-plan.js',
    'lib/reader-saved-feedback-input-continuity.js',
    'lib/reader-patch-paths.js',
    'lib/reader-pdf-cell-evidence.js',
    'lib/reader-table-pdf-evidence.js',
    'lib/reader-sealed-pdf-table-evidence.js',
    'reader_sealed_pdf_table_evidence.py',
    'reader_proof_format.py',
    'protocol_codec.py',
    'reader_pdf_cell_evidence.py',
    'python-runtime.sh',
    'reader_inline_svg.py',
    'lib/reader-implementation-fingerprint.js'
]);

const PARSER_WORKFLOW_ADAPTER_FILES = Object.freeze({
    daily: Object.freeze([
        'lib/daily-reader-operator-correction.js'
    ]),
    conference: Object.freeze([
        'lib/conference-source-context.js',
        'lib/conference-pdf-source.js',
        'lib/conference-reader-publication-evidence.js',
        'lib/conference-analysis-context.js',
        'lib/conference-reader-recovery-window.js',
        'lib/conference-recovery-grant.js',
        'lib/conference-reader-operator-correction.js',
        'conference_extractor.py'
    ]),
    historical: Object.freeze([
        'lib/direct-rewrite-analysis-context.js',
        'lib/historical-direct-rewrite-runner.js'
    ])
});

function filesForWorkflow(workflow = 'daily') {
    if (workflow === 'all') {
        return [
            ...PARSER_CORE_FILES,
            ...PARSER_WORKFLOW_ADAPTER_FILES.daily,
            ...PARSER_WORKFLOW_ADAPTER_FILES.conference,
            ...PARSER_WORKFLOW_ADAPTER_FILES.historical
        ];
    }
    const adapter = PARSER_WORKFLOW_ADAPTER_FILES[workflow];
    if (!adapter) {
        throw new Error(`未知 Reader 工作流指纹作用域：${workflow}`);
    }
    return [...PARSER_CORE_FILES, ...adapter];
}

function hashFileList(files, { fsImpl = fs, scriptsDir = path.resolve(__dirname, '..') } = {}) {
    return shaText(files.map(rel => fsImpl.readFileSync(path.join(scriptsDir, rel), 'utf8')).join('\0'));
}

function computeParserCoreImplementationSha256(options = {}) {
    return hashFileList(PARSER_CORE_FILES, options);
}

function computeWorkflowAdapterImplementationSha256(workflow = 'daily', options = {}) {
    const adapter = PARSER_WORKFLOW_ADAPTER_FILES[workflow];
    if (!adapter) throw new Error(`未知 Reader 工作流指纹作用域：${workflow}`);
    return hashFileList(adapter, options);
}

function currentReaderParserImplementationSha256(options = {}) {
    const workflow = options.workflow || 'daily';
    return hashFileList(filesForWorkflow(workflow), options);
}

module.exports = {
    PARSER_CORE_FILES,
    PARSER_WORKFLOW_ADAPTER_FILES,
    filesForWorkflow,
    computeParserCoreImplementationSha256,
    computeWorkflowAdapterImplementationSha256,
    currentReaderParserImplementationSha256
};

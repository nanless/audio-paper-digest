'use strict';
// Replay the shared analysis contract against source bytes already authenticated
// by the publisher. The only input channel is an inherited private descriptor.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const fs = require('node:fs');
const crypto = require('node:crypto');
// Importing the analysis module installs human log timestamps. Keep the private
// replay response on its original machine-readable stream.
const writeOutput = process.stdout.write.bind(process.stdout);
const deny = () => { throw new Error('Resource claim replay forbids network access'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const name of ['node:http', 'node:https']) {
    require(name).request = deny; require(name).get = deny;
}
require('node:http2').connect = deny;
globalThis.fetch = deny;
(async () => { try {
    require('../env-loader').requireExternalRuntime('reader-resource-claims-replay-cli.js');
    const raw = process.argv[2];
    const fd = Number(raw);
    if (process.argv.length !== 3 || !/^\d+$/.test(raw || '') || !Number.isSafeInteger(fd) || fd < 3) {
        throw new Error('Private input descriptor is required');
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || ![0, 1].includes(stat.nlink) || (stat.mode & 0o777) !== 0o600
        || stat.size < 2 || stat.size > 128 * 1024 * 1024) throw new Error('Unsafe replay input');
    const input = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const keys = input && Object.keys(input).sort().join(',');
    const pdfOnly = keys === 'authenticatedPdfTables,paper' && input.authenticatedPdfTables === true;
    if (!input || !['authenticatedPdfTables,paper', 'paper,sourceText', 'paper,resourcePresentation,sourceText',
        'paper,publicationEvidence,resourcePresentation,sourceText'].includes(keys)
        || (Object.hasOwn(input, 'resourcePresentation') && input.resourcePresentation !== true)
        || !input.paper || (!pdfOnly && (typeof input.sourceText !== 'string'
        || crypto.createHash('sha256').update(input.sourceText).digest('hex') !== input.paper.sourceSha256))) {
        throw new Error('Resource claims are not bound to authenticated source bytes');
    }
    const authenticated = (input.paper.apiReaderPlan?.tableBindings || [])
        .filter(binding => binding.authenticatedPdfTableEvidence !== undefined);
    let authenticatedHandle = null;
    if (authenticated.length) {
        const identity = authenticated[0].authenticatedPdfTableEvidence?.sourceIdentity;
        if (authenticated.some(binding => !require('node:util').isDeepStrictEqual(
            binding.authenticatedPdfTableEvidence?.sourceIdentity, identity))) throw new Error('PDF table proofs mix original source identities');
        authenticatedHandle = identity?.contract === 'historical-direct-reader-pdf-source-v1'
            ? await require('./historical-direct-rewrite-runner').replayHistoricalReaderPdfSource(input.paper, identity)
            : require('./conference-reader-publication-evidence').replayCanonicalReaderPdfSource(input.paper, identity);
    }
    if (pdfOnly && !authenticatedHandle) throw new Error('Authenticated PDF table replay requires saved source-bound evidence');
    const sourceText = pdfOnly
        ? require('./conference-source-context').readerPdfSourceForContext(authenticatedHandle).sourceText : input.sourceText;
    if (crypto.createHash('sha256').update(sourceText).digest('hex') !== input.paper.sourceSha256) throw new Error('Authenticated PDF source text SHA differs');
    const deep = require('../deep-analyzer');
    const draft = deep.readerResourceClaimDraftFromArticle(input.paper.apiReaderPlan, input.paper.apiReaderArticle);
    deep.enforceReaderResourceClaims(draft, input.paper.apiReaderResources, sourceText, { paper: input.paper });
    const response = { verified: true };
    if (input.resourcePresentation === true) response.resources = deep.readerResourcePublicationResources(input.paper, sourceText);
    const withAuthenticated = callback => authenticatedHandle
        ? require('./reader-authenticated-pdf-table-evidence').withVerifiedSource(authenticatedHandle,
            () => require('./reader-authenticated-pdf-table-evidence').withSavedPaper(input.paper, callback))
        : callback();
    if (Object.hasOwn(input, 'publicationEvidence')) {
        const evidence = require('./conference-reader-publication-evidence');
        const handle = evidence.replayDescriptor(input.paper, input.publicationEvidence);
        response.tableEvidence = evidence.withPublicationEvidence(handle, () => withAuthenticated(() => ({
            paperId: input.paper.id, readerArticleSha256: crypto.createHash('sha256').update(input.paper.apiReaderArticle).digest('hex'),
            readerPlanSha256: input.paper.apiReaderPlanSha256,
            tables: require('../analysis-contract').extractMarkdownTables(input.paper.apiReaderArticle).map((table, index) => ({
                tableIndex: index + 1, tableSha256: crypto.createHash('sha256').update(table.markdown).digest('hex'),
                headerUnits: evidence.headerUnitCoverage(input.paper, table, index + 1),
                numericTokens: deep.readerNumericTokens(table.markdown).filter(token => evidence.numericCoverage(input.paper, table, index + 1, token))
            }))
        })));
    }
    if (authenticatedHandle) withAuthenticated(() => {
        const tables = require('../analysis-contract').extractMarkdownTables(input.paper.apiReaderArticle);
        const existing = response.tableEvidence;
        response.tableEvidence = { ...existing, contract: 'reader-authenticated-pdf-table-evidence-v1',
            paperId: input.paper.directPaperId || input.paper.id,
            sourceTextSha256: input.paper.sourceSha256,
            readerArticleSha256: crypto.createHash('sha256').update(input.paper.apiReaderArticle).digest('hex'),
            readerPlanSha256: input.paper.apiReaderPlanSha256,
            tables: tables.map((table, index) => {
                const binding = input.paper.apiReaderPlan.tableBindings[index];
                return { ...(existing?.tables?.[index] || {}), tableIndex: index + 1,
                    tableSha256: crypto.createHash('sha256').update(table.markdown).digest('hex'),
                    headerUnits: [...(existing?.tables?.[index]?.headerUnits || []),
                        ...require('./reader-authenticated-pdf-table-evidence').coverage(table, binding.sourceQuotes)],
                    numericTokens: existing?.tables?.[index]?.numericTokens || [],
                    ...(binding.authenticatedPdfTableEvidence ? {
                        authenticatedPdfEvidenceSha256: binding.authenticatedPdfTableEvidence.evidenceSha256,
                        authenticatedPdfProofVerified: true } : {}) };
            }) };
    });
    writeOutput(JSON.stringify(response));
} catch (error) {
    writeOutput(JSON.stringify({ verified: false, code: error.code || 'READER_RESOURCE_REPLAY_FAILED',
        issues: Array.isArray(error.readerIssues) ? error.readerIssues : [], message: error.message }));
    process.exitCode = 1;
} })();

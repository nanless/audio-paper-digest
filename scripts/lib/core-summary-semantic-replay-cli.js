'use strict';
// Local publisher replay of the same semantic contract used during analysis.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const fs = require('node:fs'), path = require('node:path');
// Imported production modules may install timestamping stdout wrappers even
// with file logging disabled. Reserve fd 1 for this protocol before importing
// them; ordinary diagnostic writes go to stderr, JSON bypasses those wrappers.
process.stdout.write = process.stderr.write.bind(process.stderr);
const writeResult = issue => fs.writeSync(1, JSON.stringify({ issue }));
function denyNetwork() {
    const deny = () => { throw new Error('Core summary semantic replay forbids network access'); };
    require('node:net').Socket.prototype.connect = deny;
    require('node:tls').connect = deny;
    for (const name of ['node:http', 'node:https']) {
        require(name).request = deny; require(name).get = deny;
    }
    require('node:http2').connect = deny;
    globalThis.fetch = deny;
}
try {
    require('../env-loader').requireExternalRuntime('core-summary-semantic-replay-cli.js');
    require('../workspace-role').requireWorkspaceRole('daily', path.resolve(__dirname, '../..'));
    denyNetwork();
    const descriptor = process.argv[2], fd = Number(descriptor);
    if (process.argv.length !== 3 || !/^\d+$/.test(descriptor || '') || !Number.isSafeInteger(fd) || fd < 3) {
        throw new Error('A private input descriptor is required');
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
        || stat.size < 2 || stat.size > 16 * 1024 * 1024) {
        throw new Error('Input must be a bounded private regular file');
    }
    const input = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!input || Array.isArray(input) || typeof input !== 'object' || typeof input.sourceText !== 'string')
        throw new Error('Invalid private core replay input');
    const contract = require('../analysis-contract');
    let issue;
    if (Object.keys(input).sort().join(',') === 'sourceText,summary' && typeof input.summary === 'string') {
        issue = contract.validateCoreSummarySemanticContract('## 核心摘要\n' + input.summary, { sourceText: input.sourceText });
    } else if (Object.keys(input).sort().join(',') === 'mode,paper,sourceText'
        && input.mode === 'stage-binding' && input.paper && typeof input.paper === 'object' && !Array.isArray(input.paper)) {
        const local = require('./conference-source-resource-correction');
        if (local.isSourceCorrectionRecord(input.paper)) {
            issue = local.withSavedPublicationPaper(input.paper, canonical => {
                const context = require('./conference-analysis-context').getConferenceAnalysisContext();
                const provider = context?.readerPdfSourceHandle
                    && require('./conference-source-context').readerPdfSourceForContext(context.readerPdfSourceHandle);
                if (!provider || provider.paperId !== canonical.id || provider.sourceText !== input.sourceText
                    || require('node:crypto').createHash('sha256').update(input.sourceText).digest('hex') !== canonical.sourceSha256) {
                    throw new Error('Local core replay source differs from actual configured canonical PDF/text');
                }
                provider.assertUnchanged();
                return contract.validateCoreSummaryStageBinding(canonical, { sourceText: input.sourceText });
            });
        } else issue = contract.validateCoreSummaryStageBinding(input.paper, { sourceText: input.sourceText });
    } else throw new Error('Input must be exact semantic or stage-binding replay data');
    if (issue !== null && typeof issue !== 'string') throw new Error('Semantic contract returned an invalid result');
    writeResult(issue);
} catch (error) {
    writeResult('Core summary semantic replay failed: ' + error.message);
    process.exitCode = 1;
}

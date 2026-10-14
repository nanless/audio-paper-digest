'use strict';
// This proves provenance of a paid failed draft; it never grants publishability or attempts.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const child = require('node:child_process'), Module = require('node:module');
const CONTRACT = 'reader-historical-draft-normalizer-replay-v1';
const repository = path.resolve(__dirname, '../..');
const normalizerPath = 'scripts/lib/reader-draft-order.js';
const dependencies = ['scripts/analysis-contract.js', 'scripts/lib/reader-pdf-cell-evidence.js',
    'scripts/reader_pdf_cell_evidence.py'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
class UnsupportedHistoricalDependencyError extends Error {}
function git(args) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    return child.execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', ...args], {
        cwd: repository, env, timeout: 10000, maxBuffer: 8 * 1024 * 1024
    });
}
function object(commit, file) {
    const blob = git(['rev-parse', `${commit}:${file}`]).toString().trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob)) throw new Error('Historical normalizer Git blob is invalid');
    const bytes = git(['cat-file', 'blob', blob]);
    return { path: file, blobOid: blob, sha256: hash(bytes), bytes };
}
function resolveHistoricalNormalizer(expectedSha256) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) return null;
    const head = git(['rev-parse', 'HEAD^{commit}']).toString().trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) return null;
    const changes = [...new Set([head, ...git(['rev-list', '--max-count=128', head, '--', normalizerPath])
        .toString().trim().split('\n')])].filter(commit => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit));
    // A later normalizer commit may retire bytes that were used at its real
    // parent without changing the normalizer at that parent. Path-only history
    // omits that snapshot, including its final matching dependency versions.
    // No path simplification here: these are the actual parents of the bounded
    // named commits; every candidate still passes all original byte guards.
    const commits = [...new Set(git(['rev-list', '--parents', '--no-walk', ...changes])
        .toString().trim().split(/\s+/))];
    for (const commit of commits) {
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) continue;
        const entry = git(['ls-tree', commit, '--', normalizerPath]).toString().trim();
        // The parent of the introduction commit legitimately has no program.
        // Only a proven absent tree entry is skipped; Git/object errors surface.
        if (!entry) continue;
        if (!/^100(?:644|755) blob [a-f0-9]{40}(?:[a-f0-9]{24})?\tscripts\/lib\/reader-draft-order\.js$/.test(entry)) {
            throw new Error('Historical normalizer tree entry is not a regular Git blob');
        }
        const program = object(commit, normalizerPath);
        if (program.sha256 !== expectedSha256) continue;
        const runtime = dependencies.map(file => object(commit, file));
        // These shared routines are reused only when their complete trusted Git bytes are unchanged.
        if (runtime.some(record => hash(fs.readFileSync(path.join(repository, record.path))) !== record.sha256)) continue;
        const tableProgram = object(commit, 'scripts/lib/reader-tables.js');
        return { commit, program, runtime, tableProgram };
    }
    return null;
}
function replayHistoricalDraftNormalizer(draft, requestIdentity, source, expectedSavedDraftSha256) {
    const repair = require('./reader-repair');
    if (!source?.text || repair.shaText(source.text) !== requestIdentity?.sourceSha256
        || !/^[a-f0-9]{64}$/.test(expectedSavedDraftSha256 || '')
        || !source.structuredArtifacts || (draft.tableBindings || []).some(binding => Object.hasOwn(binding || {}, 'selection'))) return null;
    const selected = resolveHistoricalNormalizer(requestIdentity.draftOrderImplementationSha256);
    if (!selected || requestIdentity.tableCompilerSha256 !== selected.tableProgram.sha256) return null;
    const pdf = require('./reader-pdf-cell-evidence');
    // Historical PDF extraction/runtime evidence needs its own protocol; this replay is pure DOM only.
    if ((source.structuredArtifacts.tables || []).some(table => pdf.supported(table))) return null;
    const filename = path.join(repository, normalizerPath), compiled = new Module(filename, module);
    compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    const tablesFilename = path.join(repository, selected.tableProgram.path), tables = new Module(tablesFilename, module);
    tables.filename = tablesFilename; tables.paths = Module._nodeModulePaths(path.dirname(tablesFilename));
    tables.require = spec => {
        if (spec === '../analysis-contract.js') return require('../analysis-contract');
        if (spec === './reader-pdf-cell-evidence') return pdf;
        throw new UnsupportedHistoricalDependencyError('Historical table replay requires an unverified dependency');
    };
    compiled.require = spec => {
        if (spec === 'node:crypto') return crypto;
        if (spec === '../analysis-contract.js') return require('../analysis-contract');
        if (spec === './reader-pdf-cell-evidence') return pdf;
        if (spec === './reader-tables') return tables.exports;
        throw new UnsupportedHistoricalDependencyError('Historical normalizer replay requires an unverified dependency');
    };
    let result;
    try {
        tables._compile(selected.tableProgram.bytes.toString('utf8'), tablesFilename);
        compiled._compile(selected.program.bytes.toString('utf8'), filename);
        result = compiled.exports.normalizeReaderDraftOrder(structuredClone(draft), { structuredArtifacts: source.structuredArtifacts });
    } catch (error) {
        // An unsupported program supplies no provenance proof. Only our own
        // controlled-loader rejection becomes null; Git, syntax, source and
        // integrity errors must retain their original failure behavior.
        if (error instanceof UnsupportedHistoricalDependencyError) return null;
        throw error;
    }
    if (repair.hashDraft(result?.draft || result) !== expectedSavedDraftSha256) return null;
    const proof = { contract: CONTRACT, purpose: 'paid-failed-draft-provenance-only', gitCommitOid: selected.commit,
        normalizerBlobOid: selected.program.blobOid, normalizerSha256: selected.program.sha256,
        sourceSha256: requestIdentity.sourceSha256, inputDraftSha256: repair.hashDraft(draft),
        outputDraftSha256: expectedSavedDraftSha256,
        dependencies: [...selected.runtime, selected.tableProgram].map(({ path, blobOid, sha256 }) => ({ path, blobOid, sha256 })) };
    return { proof, assertUnchanged() {
        for (const record of selected.runtime) if (hash(fs.readFileSync(path.join(repository, record.path))) !== record.sha256)
            throw new Error('Historical normalizer dependency changed before migration');
        for (const record of [selected.program, selected.tableProgram]) if (object(selected.commit, record.path).sha256 !== record.sha256)
            throw new Error('Historical normalizer Git object changed before migration');
    } };
}
function assertHistoricalNormalizerProof(proof) {
    if (!proof || proof.contract !== CONTRACT || proof.purpose !== 'paid-failed-draft-provenance-only'
        || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(proof.gitCommitOid || '')
        || !Array.isArray(proof.dependencies) || proof.dependencies.length !== dependencies.length + 1)
        throw new Error('Historical normalizer replay proof is invalid');
    const program = object(proof.gitCommitOid, normalizerPath);
    if (program.sha256 !== proof.normalizerSha256 || program.blobOid !== proof.normalizerBlobOid)
        throw new Error('Historical normalizer proof no longer names the original Git bytes');
    const allowed = [...dependencies, 'scripts/lib/reader-tables.js'];
    if (new Set(proof.dependencies.map(item => item.path)).size !== allowed.length) throw new Error('Historical dependency proof is ambiguous');
    for (const record of proof.dependencies) {
        if (!allowed.includes(record.path)) throw new Error('Historical dependency path is not trusted');
        const actual = object(proof.gitCommitOid, record.path);
        if (actual.blobOid !== record.blobOid || actual.sha256 !== record.sha256
            || dependencies.includes(record.path) && hash(fs.readFileSync(path.join(repository, record.path))) !== record.sha256)
            throw new Error('Historical dependency bytes changed before migration');
    }
}
module.exports = { CONTRACT, replayHistoricalDraftNormalizer, assertHistoricalNormalizerProof };

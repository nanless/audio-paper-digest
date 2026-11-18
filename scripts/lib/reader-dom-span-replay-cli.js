'use strict';
// Publisher replay: local sealed source and actual article only, no model/network.
const { isFreshSourceProvenance } = require('./daily-source-format');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function denyNetwork() {
    const deny = () => { throw new Error('DOM span replay only reads local files'); };
    const net = require('node:net');
    net.Socket.prototype.connect = deny;
    net.connect = deny;
    net.createConnection = deny;
    require('node:tls').connect = deny;
    for (const name of ['node:http', 'node:https']) {
        require(name).request = deny;
        require(name).get = deny;
    }
    require('node:http2').connect = deny;
    globalThis.fetch = deny;
}

function formatReplayError() {
    return { exitCode: 1, stdout: '{"keys":[]}' };
}

function runReplayFd(fd) {
    try {
        require('../env-loader').requireExternalRuntime('reader-dom-span-replay-cli.js');
        require('../workspace-role').requireWorkspaceRole('daily', path.resolve(__dirname, '../..'));
        const stat = Number.isSafeInteger(fd) && fd >= 3 && fs.fstatSync(fd);
        const uidOk = stat && (typeof process.getuid === 'function' ? stat.uid === process.getuid() : true);
        if (!stat || !stat.isFile() || (stat.mode & 0o077) || !uidOk || stat.size < 2 || stat.size > 128 * 1024 * 1024) {
            throw new Error('Private bounded input required');
        }
        const input = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (!input || Object.keys(input).sort().join(',') !== 'article,paper,sealedBundleRoot' || typeof input.article !== 'string') {
            throw new Error('Invalid replay input');
        }
        const paper = input.paper, proof = paper?.freshRewriteProvenance, root = input.sealedBundleRoot;
        const stable = value => {
            const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
                ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
            return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
        };
        const sha = value => crypto.createHash('sha256').update(value).digest('hex');
        const id = String(paper?.arxivId || '').replace(/v\d+$/, '');
        if (typeof root !== 'string' || !path.isAbsolute(root) || path.basename(root) !== 'sources'
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(proof?.runId || '')
            || path.basename(path.dirname(root)) !== proof.runId || !/^\d{4}\.\d{4,5}$/.test(id)
            || !isFreshSourceProvenance(proof) || proof.sourceGeneration !== 1
            || proof.sourceOnly !== true || proof.oldGeneratedTextIncluded !== false
            || stable(proof) !== stable(paper.analysisManifest?.freshRewriteProvenance)) {
            throw new Error('Sealed provenance mismatch');
        }
        const keys = require('./fresh-analysis-context').withVerifiedBundleReaderAuthorFiles({
            rootDir: root, arxivId: id, generation: 1,
            sourceManifestSha256: proof.sourceManifestSha256,
            sourceSnapshotSha256: proof.sourceSnapshotSha256
        }, source => {
            const descriptor = source.freshSourceDescriptor, acquisition = paper.analysisManifest?.sourceAcquisition;
            if (source.source !== 'html' || !source.structuredArtifacts || paper.sourceSha256 !== descriptor.sourceSha256
                || acquisition?.sourceSha256 !== descriptor.sourceSha256 || acquisition.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
                || source.structuredArtifacts.flattenedTextSha256 !== descriptor.sourceSha256
                || ['sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256', 'sourceGeneration', 'sourceManifestSha256']
                    .some(k => proof[k] !== descriptor[k])) {
                throw new Error('Sealed source identity mismatch');
            }
            const parse = require('../analysis-contract').extractMarkdownTables;
            const rendered = parse(input.article), saved = parse(paper.apiReaderArticle || '');
            const bindings = paper.apiReaderPlan?.tableBindings;
            if (!Array.isArray(bindings) || bindings.length !== rendered.length || saved.length !== rendered.length) {
                throw new Error('Article table mismatch');
            }
            const span = require('./reader-dom-span-projection'), accepted = [];
            bindings.forEach((binding, index) => {
                if (binding.tableIndex !== index + 1 || sha(saved[index].markdown) !== binding.renderedTableSha256) {
                    throw new Error('Saved article identity mismatch');
                }
                if (binding.sourceType !== 'artifact_table' || binding.pdfCellConfirmation) return;
                const tables = source.structuredArtifacts.tables.filter(t => t.ordinal === binding.sourceTableOrdinal && t.sourceDomSha256 === binding.sourceTableDomSha256);
                if (tables.length !== 1) return;
                const rows = [rendered[index].header, ...rendered[index].rows];
                for (const cell of binding.cellBindings || []) {
                    const text = rows[cell.renderedRow]?.[cell.renderedColumn];
                    if (span.fullWidthLabelBlankMatches(tables[0], binding, cell, text, rendered[index])) {
                        accepted.push([index + 1, cell.renderedRow, cell.renderedColumn]);
                    }
                }
            });
            return accepted;
        });
        return { exitCode: 0, stdout: JSON.stringify({ keys }) };
    } catch (_) {
        return formatReplayError();
    }
}

module.exports = { runReplayFd, formatReplayError };

if (require.main === module || path.basename(process.argv[1] || '') === 'reader-dom-span-replay-cli.js') {
    process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
    const writeRaw = text => fs.writeSync(1, text);
    process.stdout.write = process.stderr.write.bind(process.stderr);
    try {
        require('../env-loader').requireExternalRuntime('reader-dom-span-replay-cli.js');
        require('../workspace-role').requireWorkspaceRole('daily', path.resolve(__dirname, '../..'));
        denyNetwork();
        const raw = process.argv[2], fd = Number(raw);
        if (process.argv.length !== 3 || !/^\d+$/.test(raw || '') || !Number.isSafeInteger(fd) || fd < 3) {
            throw new Error('Private bounded input required');
        }
        const outcome = runReplayFd(fd);
        writeRaw(outcome.stdout);
        if (outcome.exitCode) process.exitCode = outcome.exitCode;
    } catch (_) {
        const outcome = formatReplayError();
        writeRaw(outcome.stdout);
        process.exitCode = outcome.exitCode;
    }
}

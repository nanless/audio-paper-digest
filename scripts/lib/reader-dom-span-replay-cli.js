'use strict';
// Publisher replay: local sealed source and actual article only, no model/network.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
try {
    require('../env-loader').requireExternalRuntime('reader-dom-span-replay-cli.js');
    require('../workspace-role').requireWorkspaceRole('daily', path.resolve(__dirname, '../..'));
    const deny = () => { throw new Error('DOM span replay only reads local files'); };
    require('node:net').Socket.prototype.connect = deny; require('node:tls').connect = deny;
    for (const module of ['node:http', 'node:https']) { require(module).request = deny; require(module).get = deny; }
    globalThis.fetch = deny;
    const raw = process.argv[2], fd = Number(raw), stat = /^\d+$/.test(raw || '') && fd >= 3 && fs.fstatSync(fd);
    if (!stat || !stat.isFile() || (stat.mode & 0o077) || stat.size < 2 || stat.size > 128 * 1024 * 1024) throw new Error('Private bounded input required');
    const input = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (Object.keys(input).sort().join(',') !== 'article,paper,sealedBundleRoot' || typeof input.article !== 'string') throw new Error('Invalid replay input');
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
        || proof.contract !== 'fresh-source-analysis-v1' || proof.sourceGeneration !== 1
        || proof.sourceOnly !== true || proof.oldGeneratedTextIncluded !== false
        || stable(proof) !== stable(paper.analysisManifest?.freshRewriteProvenance)) throw new Error('Sealed provenance mismatch');
    const keys = require('./fresh-analysis-context').withVerifiedBundleReaderAuthorFiles({ rootDir: root, arxivId: id,
        generation: 1, sourceManifestSha256: proof.sourceManifestSha256, sourceSnapshotSha256: proof.sourceSnapshotSha256 }, source => {
        const descriptor = source.freshSourceDescriptor, acquisition = paper.analysisManifest?.sourceAcquisition;
        if (source.source !== 'html' || !source.structuredArtifacts || paper.sourceSha256 !== descriptor.sourceSha256
            || acquisition?.sourceSha256 !== descriptor.sourceSha256 || acquisition.structuredArtifactsSha256 !== descriptor.structuredArtifactsSha256
            || source.structuredArtifacts.flattenedTextSha256 !== descriptor.sourceSha256
            || ['sourceSha256','structuredArtifactsSha256','sourceSnapshotSha256','sourceGeneration','sourceManifestSha256']
                .some(k => proof[k] !== descriptor[k])) throw new Error('Sealed source identity mismatch');
        const parse = require('../analysis-contract').extractMarkdownTables;
        const rendered = parse(input.article), saved = parse(paper.apiReaderArticle || '');
        const bindings = paper.apiReaderPlan?.tableBindings;
        if (!Array.isArray(bindings) || bindings.length !== rendered.length || saved.length !== rendered.length) throw new Error('Article table mismatch');
        const span = require('./reader-dom-span-projection'), accepted = [];
        bindings.forEach((binding, index) => {
            if (binding.tableIndex !== index + 1 || sha(saved[index].markdown) !== binding.renderedTableSha256) throw new Error('Saved article identity mismatch');
            if (binding.sourceType !== 'artifact_table' || binding.pdfCellConfirmation) return;
            const tables = source.structuredArtifacts.tables.filter(t => t.ordinal === binding.sourceTableOrdinal && t.sourceDomSha256 === binding.sourceTableDomSha256);
            if (tables.length !== 1) return;
            const rows = [rendered[index].header, ...rendered[index].rows];
            for (const cell of binding.cellBindings || []) {
                const text = rows[cell.renderedRow]?.[cell.renderedColumn];
                if (span.fullWidthLabelBlankMatches(tables[0], binding, cell, text, rendered[index]))
                    accepted.push([index + 1, cell.renderedRow, cell.renderedColumn]);
            }
        });
        return accepted;
    });
    process.stdout.write(JSON.stringify({ keys }));
} catch (_) { process.stdout.write('{"keys":[]}'); process.exitCode = 1; }

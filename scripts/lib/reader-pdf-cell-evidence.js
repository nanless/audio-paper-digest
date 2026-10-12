'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const child = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const scope = new AsyncLocalStorage();
const verifiedCache = new Map();
const CONTRACT = 'sealed-pdf-cell-confirmation-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => require('./reader-repair').hashDraft(value);
const projectRoot = path.resolve(__dirname, '../..');
const pythonFile = path.join(projectRoot, 'scripts/reader_pdf_cell_evidence.py');

function supported(table) {
    return Array.isArray(table?.matrix) && table.matrix[0]?.length >= 3
        && table.matrix[0][0] === 'Dataset SNR Setting' && table.matrix[0][1] === 'Test set'
        && (table.cells || []).some(cell => /^([+-]?\d+\.\d+)\1$/.test(String(cell.text || '')));
}

function provenanceFor(paperId) {
    const fresh = require('./fresh-analysis-context');
    const context = fresh.getFreshAnalysisContext();
    if (!context || !fresh.isDailyFreshSourceScope()) return null;
    const id = String(paperId || '').replace(/^arxiv:/, '').replace(/v\d+$/, '');
    const source = fresh.readFreshSource(context.runDir, id, context);
    const d = source?.freshSourceDescriptor;
    return d && { contract: 'fresh-source-analysis-v1', runId: d.runId,
        sourceSha256: d.sourceSha256, structuredArtifactsSha256: d.structuredArtifactsSha256,
        sourceManifestSha256: d.sourceManifestSha256, sourceGeneration: d.sourceGeneration };
}

function verifiedBytes(filename) {
    const before = fs.lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 512n * 1024n * 1024n) {
        throw new Error('PDF来源或程序文件不是独立普通文件');
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('PDF核验文件读取身份变化');
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd, { bigint: true });
        const named = fs.lstatSync(filename, { bigint: true });
        for (const field of ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink']) {
            if (before[field] !== after[field] || before[field] !== named[field]) throw new Error('PDF核验文件读取期间变化');
        }
        return bytes;
    } finally { fs.closeSync(fd); }
}

function runtimeSelection() {
    const search = name => {
        for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
            const filename = path.resolve(directory || projectRoot, name);
            try { fs.accessSync(filename, fs.constants.X_OK); if (fs.statSync(filename).isFile()) return filename; } catch {}
        }
        return null;
    };
    const venvPython = path.join(projectRoot, '.venv/bin/python');
    let python = null;
    try { fs.accessSync(venvPython, fs.constants.X_OK); if (fs.statSync(venvPython).isFile()) python = venvPython; } catch {}
    python = python || search('python3.11') || search('python3');
    const bash = search('bash');
    if (!python || !bash) throw new Error('PDF核验缺少实际Python或shell运行时');
    const executable = filename => ({ requested: filename, real: fs.realpathSync(filename),
        sha256: sha(verifiedBytes(fs.realpathSync(filename))) });
    const cfg = path.join(projectRoot, '.venv/pyvenv.cfg');
    return { path: process.env.PATH || '', launcher: sha(verifiedBytes(path.join(projectRoot, 'scripts/python-runtime.sh'))),
        python: executable(python), bash: executable(bash),
        venv: fs.existsSync(path.join(projectRoot, '.venv')) ? fs.realpathSync(path.join(projectRoot, '.venv')) : null,
        pyvenvConfig: fs.existsSync(cfg) ? sha(verifiedBytes(fs.realpathSync(cfg))) : null };
}

function sealedSnapshot(directory, provenance) {
    let current = path.resolve(directory);
    while (current !== path.dirname(current)) {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('封存PDF来源父目录不能是符号链接');
        current = path.dirname(current);
    }
    const manifestBytes = verifiedBytes(path.join(directory, 'source-manifest.json'));
    if (sha(manifestBytes) !== provenance.sourceManifestSha256) throw new Error('PDF来源清单SHA变化');
    const manifest = JSON.parse(manifestBytes);
    const files = { 'source.txt': manifest.text.responseSha256, 'source.pdf': manifest.pdf.responseSha256,
        'source-runtime.json': manifest.runtimeMetadata.responseSha256 };
    for (const [filename, expected] of Object.entries(files)) {
        if (sha(verifiedBytes(path.join(directory, filename))) !== expected) throw new Error('封存PDF核验四文件SHA变化');
    }
    return sha(JSON.stringify({ files, manifestSha256: provenance.sourceManifestSha256,
        runtimeSelection: runtimeSelection(), rule: sha(verifiedBytes(pythonFile)), extractor: sha(verifiedBytes(path.join(projectRoot, 'scripts/conference_extractor.py'))) }));
}

function backendInventory(directories) {
    const files = [];
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error('PDF提取后端不能增加符号链接');
            if (entry.isDirectory()) visit(filename);
            else if (entry.isFile()) files.push(filename);
            else throw new Error('PDF提取后端不能包含特殊文件');
        }
    };
    for (const directory of directories) visit(directory);
    return files.sort();
}

function derive(artifacts, paperId, provenance) {
    const id = String(paperId || '').replace(/^arxiv:/, '').replace(/v\d+$/, '');
    if (!/^\d{4}\.\d{4,5}$/.test(id) || provenance?.contract !== 'fresh-source-analysis-v1'
        || !/^[a-f0-9-]{36}$/i.test(provenance.runId || '') || provenance.sourceGeneration !== 1
        || !/^[a-f0-9]{64}$/.test(provenance.sourceManifestSha256 || '')) {
        throw new Error('PDF逐格确认缺少正常日更封存来源身份');
    }
    const sourceDirectory = path.join(require('../config').FILES.dailyFreshSourceRunsDir,
        provenance.runId, 'sources', id, 'generation-000001');
    const snapshot = sealedSnapshot(sourceDirectory, provenance);
    const cacheKey = stable({ id, sourceDirectory, provenance, artifacts, snapshot });
    const cached = verifiedCache.get(cacheKey);
    if (cached && isDeepStrictEqual(backendInventory(cached.backendDirectories), cached.backendInventory)
        && cached.backendFiles.every(file => sha(verifiedBytes(file.path)) === file.sha256)) {
        return structuredClone(cached.proofs);
    }
    const input = { paperId: id, sourceDirectory, provenance, artifacts };
    const raw = child.execFileSync('bash', [path.join(projectRoot, 'scripts/python-runtime.sh'), pythonFile], {
        cwd: projectRoot, input: JSON.stringify(input), encoding: 'utf8', timeout: 180000,
        maxBuffer: 32 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: process.env.HOME,
            CODEX_SANDBOX: process.env.CODEX_SANDBOX || '' }
    });
    const response = JSON.parse(raw);
    const result = response.proofs;
    if (!Array.isArray(result) || !result.length || result.some(item => item.contract !== CONTRACT
        || item.ruleSha256 !== sha(fs.readFileSync(pythonFile)))) {
        throw new Error('PDF逐格确认未返回完整当前提取规则证明');
    }
    if (!Array.isArray(response.backendFiles) || !response.backendFiles.length
        || !Array.isArray(response.backendDirectories) || !response.backendDirectories.length
        || response.backendDirectories.some(directory => !path.isAbsolute(directory))
        || result.some(proof => proof.backendImplementationSha256 !== stable(response.backendFiles
            .map(file => ({ name: path.basename(file.path), sha256: file.sha256 }))))
        || response.backendFiles.some(file => !path.isAbsolute(file.path)
            || sha(verifiedBytes(file.path)) !== file.sha256)
        || sealedSnapshot(sourceDirectory, provenance) !== snapshot) {
        throw new Error('PDF来源或提取后端在重放期间变化');
    }
    if (verifiedCache.size >= 8) verifiedCache.delete(verifiedCache.keys().next().value);
    const inventory = backendInventory(response.backendDirectories);
    if (!inventory.every(filename => response.backendFiles.some(file => file.path === filename))) {
        throw new Error('PDF提取后端存在未核验的新文件');
    }
    verifiedCache.set(cacheKey, { proofs: structuredClone(result), backendFiles: response.backendFiles,
        backendDirectories: response.backendDirectories, backendInventory: inventory });
    return result;
}

function withArtifacts(artifacts, paperId, fn, provenance = null) {
    if (!(artifacts?.tables || []).some(supported)) return fn();
    const current = scope.getStore();
    if (current?.artifacts === artifacts) return fn();
    const source = provenance || provenanceFor(paperId);
    if (!source) return fn();
    const proofs = derive(artifacts, paperId, source);
    const tables = new Map(proofs.map(proof => [proof.sourceTableOrdinal, proof]));
    return scope.run({ artifacts, tables }, fn);
}

function evidence(table) {
    const proof = scope.getStore()?.tables.get(table?.ordinal);
    if (!proof) return null;
    if (proof.originalTableDomSha256 !== table.sourceDomSha256
        || proof.originalTablePayloadSha256 !== stable(table)) {
        throw new Error('PDF逐格确认范围内的原DOM表已改变');
    }
    return proof;
}

function displayCell(table, row, column) {
    const original = table?.matrix?.[row]?.[column];
    const proof = evidence(table);
    const cell = proof?.confirmedCells.find(cell => cell.row === row && cell.column === column);
    if (!cell) return original;
    if (cell.originalText !== original) throw new Error('PDF逐格确认的原cell文本发生变化');
    return cell.visibleText;
}

function displayMatrix(table) {
    return (table?.matrix || []).map((row, ri) => row.map((_, ci) => displayCell(table, ri, ci)));
}

function withSavedPaper(paper, fn) {
    const bindings = paper?.apiReaderPlan?.tableBindings || [];
    if (!bindings.some(binding => binding?.pdfCellConfirmation !== undefined)) return fn();
    const payload = paper.apiReaderPlan.structuredSourcePayload;
    if (typeof payload !== 'string') throw new Error('PDF逐格来源记录缺少原DOM payload');
    const artifacts = JSON.parse(payload);
    const provenance = paper.freshRewriteProvenance;
    if (!isDeepStrictEqual(provenance, paper.analysisManifest?.freshRewriteProvenance)) {
        throw new Error('PDF逐格来源的论文与阶段封存证明不同');
    }
    return withArtifacts(artifacts, paper.arxivId, () => {
        const current = scope.getStore();
        if (!current) throw new Error('PDF逐格来源记录不属于准确支持的纯小数双写结构');
        for (const binding of bindings.filter(item => item?.pdfCellConfirmation !== undefined)) {
            const proof = current.tables.get(binding.sourceTableOrdinal);
            const table = artifacts.tables.find(table => table.ordinal === binding.sourceTableOrdinal);
            if (!proof || !table || binding.sourceTableDomSha256 !== table.sourceDomSha256
                || !Array.isArray(binding.cellBindings)
                || binding.cellBindings.length !== table.matrix.length * table.matrix[0].length
                || binding.cellBindings.some(cell => cell.renderedRow !== cell.sourceRow
                    || cell.renderedColumn !== cell.sourceColumn)
                || !isDeepStrictEqual(proof, binding.pdfCellConfirmation)) {
                throw new Error('PDF逐格来源记录不能由当前真实封存PDF重放');
            }
        }
        return fn();
    }, provenance);
}

function savedCellMatches(binding, cell, displayed) {
    const current = scope.getStore();
    const proof = current?.tables.get(binding?.sourceTableOrdinal);
    if (!binding?.pdfCellConfirmation || !proof || !isDeepStrictEqual(proof, binding.pdfCellConfirmation)) return false;
    const table = current.artifacts.tables.find(table => table.ordinal === binding.sourceTableOrdinal);
    const originals = (table?.cells || []).filter(item => cell.sourceRow >= item.row
        && cell.sourceRow < item.row + item.rowspan && cell.sourceColumn >= item.column
        && cell.sourceColumn < item.column + item.colspan);
    return originals.length === 1 && originals[0].sourceDomSha256 === cell.sourceDomSha256
        && originals[0].text === cell.sourceText
        && displayCell(table, cell.sourceRow, cell.sourceColumn) === displayed;
}

module.exports = { CONTRACT, supported, withArtifacts, withSavedPaper, evidence,
    displayCell, displayMatrix, savedCellMatches };

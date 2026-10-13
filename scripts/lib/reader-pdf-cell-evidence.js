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

const PLATONIC_TABLE_SPECS = {"1":{"caption":"Table 1: Addition in percent, each block read against its own zero-shot row. Task A and Task B are the two composed tasks, the closed form acts at \\alpha=0.5, the adapter at full strength and the weight-space routes at 0.5 on the mean of the two updates. Random-UTD, Oracle and the last two rows cover 168 cells.","width":5,"headers":["Method","Task A ↑\\uparrow","Task B ↑\\uparrow","CIFAR-100","ImageNet"],"labels":[["Method"],["Source and target are the same model (112112 cells)"],["Zero-shot"],["Weight-space arithmetic"],["Ours, closed form"],["Ours, adapter"],["Different models within one architecture (168168 cells)"],["Zero-shot"],["Weight-space transport"],["GradFix"],["Theseus"],["Ours, closed form"],["Ours, adapter"],["Different models, any pair of families (3,3603{,}360 cells)"],["Zero-shot"],["Random-UTD"],["Single-A"],["Single-B"],["Ours, closed form"],["Oracle"],["On the adapter’s 168168 cells"],["Ours, closed form"],["Ours, adapter"]],"groups":{"1":["Source and target are the same model (112112 cells)","Source and target are the same model (112 cells)"],"6":["Different models within one architecture (168168 cells)","Different models within one architecture (168 cells)"],"13":["Different models, any pair of families (3,3603{,}360 cells)","Different models, any pair of families (3,360 cells)"],"20":["On the adapter’s 168168 cells","On the adapter’s 168 cells"]}},"2":{"caption":"Table 2: Negation at \\lambda=1 in percent, grouped as in Table 1. Theseus and GradFix read ImageNet on one image per class, where zero-shot is 70.70.","width":4,"headers":["Method","Removed task ↓\\downarrow","CIFAR-100","ImageNet"],"labels":[["Method"],["Source and target are the same model (3232 cells)"],["Zero-shot"],["Weight-space negation"],["Ours, closed form"],["Ours, adapter"],["Different models within one architecture (4848 cells)"],["Zero-shot"],["Theseus"],["GradFix"],["Ours, closed form"],["Ours, adapter"],["Different models, any pair of families (240240 cells)"],["Zero-shot"],["Ours, closed form"],["On the adapter’s 4848 cells"],["Ours, closed form"],["Ours, adapter"],["Each target as its own source, same tasks"],["Closed form"],["Adapter"]],"groups":{"1":["Source and target are the same model (3232 cells)","Source and target are the same model (32 cells)"],"6":["Different models within one architecture (4848 cells)","Different models within one architecture (48 cells)"],"12":["Different models, any pair of families (240240 cells)","Different models, any pair of families (240 cells)"],"15":["On the adapter’s 4848 cells","On the adapter’s 48 cells"],"18":["Each target as its own source, same tasks","Each target as its own source, same tasks"]}},"3":{"caption":"Table 3: Composition evaluated on a dataset that enters no fit, in percent, over three targets and by the models k_{1} and k_{2} supplying the two summed terms, with the closed form at \\alpha=0.5 and the adapter at full strength. Both terms come from one other family when k_{1}=k_{2}, from the two other families when k_{1}\\neq k_{2} and from the target itself in the within-model rows.","width":6,"headers":["Assignment","Route","RESISC45","UCMerced","AID","Mean"],"labels":[["Assignment","Route"],["None","Zero-shot"],["k1=k2k_{1}=k_{2}","Closed form"],["","Adapter"],["k1≠k2k_{1}\\neq k_{2}","Closed form"],["","Adapter"],["k1k_{1} alone","Closed form"],["","Adapter"],["Within model","Closed form"],["","Adapter"]],"groups":{}}};

function supported(table) {
    const matrix = table?.matrix;
    if (!Array.isArray(matrix) || !Array.isArray(matrix[0])
        || matrix[0].length < 3 || !matrix.every(Array.isArray)) return false;
    if (table.ordinal === 1 && table.caption === 'Table 1: The performance comparison across 200 time frames against different SDNR levels: (a) the proposed algorithm, (b) the existing SASE algorithm, and (c) the modified SASE algorithm.'
        && matrix.length === 5 && matrix.every(row => row.length === 10)
        && isDeepStrictEqual(matrix.slice(0, 2), [['', ...Array(3).fill('SDNR = 1010 dB'), ...Array(3).fill('SDNR = 2020 dB'), ...Array(3).fill('SDNR = 3030 dB')], ['', '(a)', '(b)', '(c)', '(a)', '(b)', '(c)', '(a)', '(b)', '(c)']])
        && isDeepStrictEqual(matrix.slice(2).map(row => row[0]), ['Error', 'SDR', 'NR'])) return true;
    const platonic = PLATONIC_TABLE_SPECS[table.ordinal];
    if (platonic && table.caption === platonic.caption
        && matrix.length === platonic.labels.length && matrix.every(row => row.length === platonic.width)
        && isDeepStrictEqual(matrix[0], platonic.headers)
        && isDeepStrictEqual(matrix.map((row, index) => row.slice(0, platonic.labels[index].length)), platonic.labels)) return true;
    if (matrix[0][0] === 'Dataset SNR Setting' && matrix[0][1] === 'Test set'
        && (table.cells || []).some(cell => /^([+-]?\d+\.\d+)\1$/.test(String(cell.text || '')))) return true;
    if (table.ordinal === 3 && table.caption === 'Table 3: Subjective Evaluation: Effect of steering strength. SteerSpeech better preserves speaker identity at high intensity (\\alpha).' && matrix.length === 7 && matrix.every(row => row.length === 7)) return true;
    if (table.ordinal === 1 && table.caption === 'Table 1: DNSMOS and WER results on CHiME-4.' && matrix.length === 26 && matrix.every(row => row.length === 9)) return true;
    if (table.ordinal === 2 && table.caption === 'Table 2: Evaluation of MC loss on CHiME-4 REAL sets with UltraM2M-Whis variants. Rows 2 and 6 are respectively the 6- and 1-channel UltraM2M-Whis systems of Table 1.' && matrix.length === 10 && matrix.every(row => row.length === 8)) return true;
    const same = expected => isDeepStrictEqual(matrix.slice(0, 2), expected);
    const labels = matrix.slice(2).map(row => row[0]);
    if (table.ordinal === 2 && String(table.caption || '').startsWith('Table 2: Boundary error against manual annotation (ms) over the full 125-utterance test set.')
        && same([['', 'Raw', 'Raw', 'Bias', 'Bias', 'Calibrated', 'Calibrated'],
            ['System', 'mean', 'med.', 'onset', 'offset', 'mean', 'med.']])
        && isDeepStrictEqual(labels, ['Inter annotator', 'wav2vec2.0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'NFA'])) return true;
    return table.ordinal === 3 && String(table.caption || '').startsWith('Table 3: ASR and word-boundary estimation performance on the IndicVoices-R test set.')
        && same([['', 'ASR (%)', 'ASR (%)', '', 'vs. wav2vec2.0', 'vs. wav2vec2.0', 'vs. wav2vec2.0', 'vs. wav2vec2.0', 'Manual'],
            ['Conf.', 'WER', 'CER', 'NwN_{w}', 'Mean', 'Med.', 'p90p_{90}', '≤50{\\leq}50', 'Mean']])
        && isDeepStrictEqual(labels, ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'CW']);
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

function fullWidthLabelRow(table, row) {
    const matrix = table?.matrix;
    const values = matrix?.[row];
    if (table?.recoveryStatus !== 'complete' || !/^[a-f0-9]{64}$/.test(table.sourceDomSha256 || '')
        || !Array.isArray(values) || values.length < 2 || !Array.isArray(table.cells)
        || matrix.some(value => !Array.isArray(value) || value.length !== values.length)) return false;
    const cells = table.cells.filter(cell => Number.isInteger(cell?.row)
        && row >= cell.row && row < cell.row + Number(cell.rowspan || 1));
    const cell = cells[0];
    return cells.length === 1 && cell.row === row && cell.column === 0
        && cell.colspan === values.length && (cell.rowspan === undefined || cell.rowspan === 1)
        && /^[a-f0-9]{64}$/.test(cell.sourceDomSha256 || '')
        && typeof cell.text === 'string' && /[\p{L}]/u.test(cell.text)
        && values.every(value => value === cell.text);
}

function displayCell(table, row, column) {
    if (column > 0 && fullWidthLabelRow(table, row)) return '';
    const sourceCell = (table?.cells || []).find(cell => Number.isInteger(cell?.row)
        && Number.isInteger(cell?.column) && row >= cell.row
        && row < cell.row + Number(cell.rowspan || 1)
        && column >= cell.column && column < cell.column + Number(cell.colspan || 1));
    const proof = evidence(table);
    // 普通表沿用原单元格字节；旧合法记录可能没有matrix，不能变成空白。
    if (!proof) return sourceCell ? sourceCell.text : table?.matrix?.[row]?.[column];
    const original = table?.matrix?.[row]?.[column];
    const cell = proof.confirmedCells.find(cell => cell.row === sourceCell?.row && cell.column === sourceCell?.column);
    if (!cell) return original;
    if (cell.originalText !== original || cell.originalText !== sourceCell.text
        || cell.originalCellDomSha256 !== sourceCell.sourceDomSha256) throw new Error('PDF逐格确认的原cell文本发生变化');
    return cell.visibleText;
}

function displayMatrix(table) {
    return (table?.matrix || []).map((row, ri) => row.map((_, ci) => displayCell(table, ri, ci)));
}

// 旧完整表的重复展示仍可只读核验；新展示仅折叠DOM证明的全幅文字行。
function displayCellMatches(table, row, column, text, normalize = value => value) {
    const current = normalize(displayCell(table, row, column));
    return normalize(text) === current || column > 0 && fullWidthLabelRow(table, row)
        && normalize(text) === normalize(table.matrix[row][column]);
}

function savedMergedCellMatches(paper, binding, cell, displayed) {
    if (displayed !== '' || cell?.renderedText !== ''
        || !Number.isInteger(cell?.sourceRow) || cell.sourceRow < 0
        || !Number.isInteger(cell?.sourceColumn) || cell.sourceColumn <= 0) return false;
    const payload = paper?.apiReaderPlan?.structuredSourcePayload;
    const source = paper?.analysisManifest?.sourceAcquisition;
    if (typeof payload !== 'string' || sha(payload) !== source?.structuredArtifactsSha256
        || paper.sourceSha256 !== source?.sourceSha256) return false;
    let artifacts;
    try { artifacts = JSON.parse(payload); } catch (_) { return false; }
    if (artifacts.flattenedTextSha256 !== source.sourceSha256) return false;
    const tables = (artifacts.tables || []).filter(table => table.ordinal === binding.sourceTableOrdinal
        && table.sourceDomSha256 === binding.sourceTableDomSha256);
    if (tables.length !== 1 || !fullWidthLabelRow(tables[0], cell.sourceRow)) return false;
    const original = tables[0].cells.find(value => value.row === cell.sourceRow);
    return original.text === cell.sourceText && original.sourceDomSha256 === cell.sourceDomSha256
        && cell.sourceColumn < tables[0].matrix[cell.sourceRow].length;
}

// 既有表格逐格重新核验完全相同、仅规则文件SHA变化时，更新程序检查元数据。
function replaySavedProofMetadata(paper, manifest = paper?.analysisManifest) {
    const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
    const recordHash = value => sha(JSON.stringify(normalize(value)));
    const plan = paper?.apiReaderPlan, stage = manifest?.stages?.apiReaderArticle;
    const bindings = plan?.tableBindings;
    if (!Array.isArray(bindings) || !bindings.some(binding => binding.pdfCellConfirmation)) return false;
    if (stage?.status !== 'complete' || paper.apiReaderPlanSha256 !== recordHash(plan)
        || stage.planSha256 !== recordHash(plan) || paper.apiReaderArticleSha256 !== sha(paper.apiReaderArticle)
        || stage.articleSha256 !== paper.apiReaderArticleSha256
        || plan.sourceBindingsSha256 !== recordHash({tableBindings:bindings,formulaBindings:plan.formulaBindings})
        || stage.sourceBindingsSha256 !== plan.sourceBindingsSha256) {
        throw new Error('PDF检查记录更新缺少原长文和来源记录的完整身份');
    }
    if (!isDeepStrictEqual(paper.freshRewriteProvenance, manifest.freshRewriteProvenance)) {
        throw new Error('PDF检查记录更新的封存来源证明不同');
    }
    const artifacts = JSON.parse(plan.structuredSourcePayload);
    const proofs = derive(artifacts, paper.arxivId, paper.freshRewriteProvenance);
    const nextPlan = structuredClone(plan), changes = [];
    for (const binding of nextPlan.tableBindings.filter(binding => binding.pdfCellConfirmation)) {
        const previous = binding.pdfCellConfirmation;
        const matches = proofs.filter(proof => proof.sourceTableOrdinal === binding.sourceTableOrdinal);
        if (matches.length !== 1) throw new Error('PDF检查记录更新的原表位置不唯一');
        const current = matches[0];
        if (isDeepStrictEqual(previous, current)) continue;
        const {ruleSha256:oldRule,...oldContent}=previous;
        const {ruleSha256:newRule,...newContent}=current;
        if (!/^[a-f0-9]{64}$/.test(oldRule || '') || newRule !== sha(fs.readFileSync(pythonFile))
            || !isDeepStrictEqual(oldContent,newContent)) {
            throw new Error('PDF重新核验的字形、表头、数值或来源已改变，不能只更新检查记录');
        }
        changes.push({sourceTableOrdinal:binding.sourceTableOrdinal,oldRuleSha256:oldRule,
            newRuleSha256:newRule,oldProofSha256:recordHash(previous),newProofSha256:recordHash(current)});
        binding.pdfCellConfirmation = current;
    }
    if (!changes.length) return false;
    nextPlan.sourceBindingsSha256=recordHash({tableBindings:nextPlan.tableBindings,formulaBindings:nextPlan.formulaBindings});
    const candidate=structuredClone(paper),nextManifest=structuredClone(manifest);
    candidate.apiReaderPlan=nextPlan;candidate.apiReaderPlanSha256=recordHash(nextPlan);
    nextManifest.stages.apiReaderArticle={...stage,planSha256:candidate.apiReaderPlanSha256,
        sourceBindingsSha256:nextPlan.sourceBindingsSha256,
        pdfCellConfirmationReplays:[...(stage.pdfCellConfirmationReplays || []),{
            note:'重新核验原封存PDF得到相同显示内容，仅更新程序检查记录；没有新模型请求或重新签署旧请求。',
            articleSha256:paper.apiReaderArticleSha256,oldPlanSha256:paper.apiReaderPlanSha256,
            newPlanSha256:candidate.apiReaderPlanSha256,changes}]};
    candidate.analysisManifest=nextManifest;
    if (!require('../analysis-engine').hasValidApiReaderV3Records(candidate)) {
        throw new Error('PDF检查记录更新后，长文的完整来源资格仍未通过');
    }
    paper.apiReaderPlan=nextPlan;paper.apiReaderPlanSha256=candidate.apiReaderPlanSha256;
    manifest.stages.apiReaderArticle=nextManifest.stages.apiReaderArticle;
    return true;
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
        && displayCellMatches(table, cell.sourceRow, cell.sourceColumn, displayed);
}

module.exports = { CONTRACT, replaySavedProofMetadata, supported, withArtifacts, withSavedPaper, evidence,
    displayCell, displayMatrix, displayCellMatches, fullWidthLabelRow, savedMergedCellMatches, savedCellMatches };

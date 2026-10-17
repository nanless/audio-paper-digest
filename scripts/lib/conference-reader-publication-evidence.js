'use strict';

// 只为当前出版补充原 PDF 的逐字引文；不改旧 Reader、绑定、模型输入或来源身份。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), child = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const scope = new AsyncLocalStorage(), registered = new WeakMap();
const canonicalReaderPdfSources = new WeakMap();
const root = path.resolve(__dirname, '../..');
const program = path.join(root, 'scripts/reader_sealed_pdf_quote_evidence.py');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const normal = value => String(value || '').replace(/\s+/gu, ' ').trim();
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const occurrences = (text, needle) => { const result = []; let index = -1;
    while ((index = text.indexOf(needle, index + 1)) !== -1) result.push(index);
    return result; };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function sourceReference(directory, wanted, prefix, deps) {
    const candidates = fs.readdirSync(directory).filter(name => name.startsWith(prefix)
        && /^[a-z0-9][a-z0-9._-]{0,159}\.json$/u.test(name)).sort();
    for (const name of candidates) {
        const loaded = deps.ledger.readRegularJson(path.join(directory, name));
        if (loaded.sha256 === wanted) return name;
    }
    throw new Error('会议出版证据缺少原发现文件的精确 SHA 引用。');
}

function pdfQuotes(pdf, quotes) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conference-reader-quotes-'));
    fs.chmodSync(directory, 0o700); let fd;
    try {
        const filename = path.join(directory, 'input.json');
        fs.writeFileSync(filename, JSON.stringify({ pdfBase64: pdf.toString('base64'), pdfSha256: sha(pdf), quotes }),
            { mode: 0o600, flag: 'wx' });
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        return JSON.parse(child.execFileSync('bash', [path.join(root, 'scripts/python-runtime.sh'), program, '3'], {
            cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe', fd]
        }));
    } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(directory, { recursive: true, force: true }); }
}

function unitColumns(table) {
    const result = [];
    (table.header || []).forEach((value, column) => {
        const header = normal(value).normalize('NFKC').replace(/[`*_↑↓]/g, '').trim();
        const match = /^(.*?)(?:\(\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\)|\[\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\]|\s+(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp))$/iu.exec(header);
        if (!match || !match[1].trim()) return;
        if (/(?:^|\s)[-+−－]?\d+(?:\.\d+)?\s*$/u.test(match[1])
            && (match[4] || /(?:^|\s)[-+−－]\d+(?:\.\d+)?\s*$/u.test(match[1]))) return;
        const metric = match[1].trim(), unit = match[2] || match[3] || match[4];
        const declaration = new RegExp(`(?<![A-Za-z0-9_])${escape(metric).replace(/\s+/g, '\\s+')}(?:\\s*\\(\\s*${escape(unit)}\\s*\\)|\\s*\\[\\s*${escape(unit)}\\s*\\]|\\s+${escape(unit)})(?![A-Za-z0-9_])`, 'iu');
        result.push({ column, metric, unit: unit.toLowerCase(), declaration });
    });
    return result;
}

function tableWindow(table, binding, document) {
    const deep = require('../deep-analyzer'), text = document.normalizedFullText;
    const columns = unitColumns(table);
    if (!columns.length || !table.rows.length) return null;
    const old = (binding.sourceQuotes || []).filter(item => item && typeof item.quote === 'string'
        && item.sourceQuoteSha256 === sha(item.quote)).map(item => ({ ...item, normalized: normal(item.quote) }));
    const containsSequence = (tokens, wanted) => tokens.some((_value, index) =>
        wanted.every((token, offset) => tokens[index + offset] === token));
    const anchors = table.rows.map(row => {
        const wanted = columns.flatMap(item => deep.readerNumericTokens(row[item.column] || ''));
        if (!wanted.length) return [];
        return old.filter(item => containsSequence(deep.readerNumericTokens(item.quote), wanted))
            .flatMap(item => occurrences(text, item.normalized).length === 1
                ? [{ ...item, start: text.indexOf(item.normalized), end: text.indexOf(item.normalized) + item.normalized.length }] : []);
    });
    if (anchors.some(values => !values.length)) return null;
    const captions = [...text.matchAll(/(?<![A-Za-z])Table\s+\d+\s*[:.]/gu)];
    const candidates = [];
    for (const caption of captions) {
        const start = caption.index, next = captions.find(value => value.index > start)?.index ?? text.length;
        const endLimit = Math.min(next, start + 4000);
        const rows = anchors.map(values => values.filter(value => value.start > start && value.end <= endLimit)
            .sort((a, b) => a.normalized.length - b.normalized.length));
        if (rows.some(values => !values.length)) continue;
        const chosen = rows.map(values => values[0]);
        const header = text.slice(start, Math.min(...chosen.map(value => value.start)));
        if (header.length > 1500 || columns.some(column => !column.declaration.test(header))) continue;
        const end = Math.max(...chosen.map(value => value.end));
        const quote = text.slice(start, end);
        if (quote.length < 12 || quote.length > 4000 || occurrences(text, quote).length !== 1) continue;
        candidates.push({ kind: 'table', quote, columns: columns.map(({ column, metric, unit }) => ({ column, metric, unit })),
            rowQuoteSha256: chosen.map(value => value.sourceQuoteSha256) });
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function proseWindows(table, binding, document) {
    const deep = require('../deep-analyzer'), text = document.normalizedFullText;
    const old = (binding.sourceQuotes || []).map(item => item.quote).join('\n');
    const missing = [...new Set(deep.readerNumericTokens(table.markdown))]
        .filter(token => !deep.readerSourceQuoteCoversNumericToken(token, old, true));
    const result = [];
    if (/窗口|步长|时长|训练|window|hop|utterance/iu.test(table.markdown)) {
        for (const token of missing) {
            const match = /^([-+]?\d+(?:\.\d+)?)s$/u.exec(token);
            if (!match) continue;
            const pattern = new RegExp(`(?:window length|hop length|training utterance)[^.?!]{0,120}?\\b${escape(match[1])} seconds?\\b`, 'giu');
            const matches = [...text.matchAll(pattern)];
            if (matches.length !== 1) continue;
            const matchAt = matches[0].index, lower = text.lastIndexOf('. ', matchAt) + 2;
            const upper = text.indexOf('. ', matchAt + matches[0][0].length);
            if (lower < 0 || upper < 0 || upper + 1 - lower > 1200) continue;
            const quote = text.slice(lower, upper + 1);
            if (!/\b(?:not|never|no|without|if|would|could|might|may|will|future|propos(?:e|ed)|hypothetical)\b/iu.test(quote)
                && /\b(?:are|were|is|was)\s+(?:extracted|used|set|trained)\b/iu.test(quote)
                && occurrences(text, quote).length === 1 && deep.readerSourceQuoteCoversNumericToken(token, quote, false))
                result.push({ kind: 'experiment-setting', quote, numericTokens: [token] });
        }
    }
    // 只认可同一0–100评分量表、隐藏参考平均分以及明确低于阈值剔除的完整原段。
    if (/0\s*(?:到|至|[-–—~～])\s*100\s*分?/u.test(table.markdown)
        && /隐藏参考/u.test(table.markdown)) {
        for (const token of missing.filter(value => /^\d+(?:\.\d+)?$/u.test(value))) {
            if (!new RegExp(`低于\\s*${escape(token)}\\s*分\\s*剔除`, 'u').test(table.markdown)) continue;
            const threshold = new RegExp(`partici(?:-\\s*)?pants whose average rating of the hidden reference was below ${escape(token)}% were excluded from further analysis\\.`, 'giu');
            const matches = [...text.matchAll(threshold)];
            if (matches.length !== 1) continue;
            const end = matches[0].index + matches[0][0].length;
            const start = text.lastIndexOf('Perceptual Evaluation.', matches[0].index);
            if (start < 0 || end - start > 4000) continue;
            const quote = text.slice(start, end);
            if (/rate, from 0 to 100,[\s\S]*a hidden reference[\s\S]*average rating of the hidden reference was below/iu.test(quote)
                && occurrences(text, quote).length === 1) result.push({ kind: 'rating-scale', quote, numericTokens: [token] });
        }
    }
    return result;
}

function derivePublicationEvidence({ loaded, planHandle, sourceRoot }) {
    require('../env-loader').requireExternalRuntime(path.basename(__filename));
    const deps = require('./conference-process').defaultDependencies();
    const current = deps.adapter.loadConferenceAnalysis({ analysisRoot: path.dirname(loaded.directory), executionId: loaded.run.executionId });
    if (current.analysisFileSha256 !== loaded.analysisFileSha256 || current.sourceFileSha256 !== loaded.sourceFileSha256
        || current.runFileSha256 !== loaded.runFileSha256 || current.run.status !== 'complete'
        || !isDeepStrictEqual(current.analysis, loaded.analysis) || !isDeepStrictEqual(current.source, loaded.source)) throw new Error('会议出版补充证据的原分析或来源已变化。');
    deps.adapter.verifyPlanAuthority(current, planHandle, sourceRoot);
    const authority = deps.plan.planHandleReadOnlyAuthority(planHandle);
    const imported = deps.importer.importHandleSnapshot(authority.importHandle);
    const bound = imported.staging.receipt.members.find(item => item.paperId === current.run.paperId);
    if (!bound) throw new Error('会议出版证据缺少本篇原抽取凭证。');
    return deriveVerifiedSourceEvidence({ current, sourceRoot, bound, deps,
        reference: { planReceiptSha256: authority.snapshot.receipt.receiptSha256,
            filterId: authority.snapshot.receipt.filter.filterId,
            catalogName: sourceReference(deps.files.conferenceDiscoveryCatalogDir, imported.staging.receipt.discovery.catalogSha256,
                current.source.sourceSnapshotBinding.conference.id, deps),
            reportName: sourceReference(deps.files.conferenceDiscoveryReportDir, imported.staging.receipt.discovery.reportSha256,
                current.source.sourceSnapshotBinding.conference.id, deps) } });
}

function deriveVerifiedSourceEvidence({ current, sourceRoot, bound, deps, reference }) {
    const receipt = deps.ledger.readRegularJson(path.join(deps.files.conferenceStagingSourceDir, bound.extractionReceiptName)).value;
    require('./conference-retained-source-replay').verifyRetainedExtraction({ paperId: bound.paperId,
        sourceIdentity: bound.sourceIdentity, sourceProof: { requestSha256: receipt.request?.sha256,
            receiptSha256: bound.extractionReceiptSha256, verificationSha256: bound.extractionVerificationSha256,
            textSha256: bound.textSha256, artifactsSha256: bound.artifactsSha256, pdfSha256: bound.pdfSha256 } }, bound, deps);
    const pdfDescriptor = current.source.sourceSnapshotBinding.pdfDescriptor;
    const pdf = deps.discovery.safeAbsoluteFile(path.join(sourceRoot, pdfDescriptor.pdfRelativePath), '原会议出版 PDF', deps.discovery.MAX_PDF_BYTES).bytes;
    if (sha(pdf) !== bound.pdfSha256 || sha(pdf) !== pdfDescriptor.pdfSha256) throw new Error('会议出版补充证据的原 PDF SHA 不一致。');
    const implementationSha256 = sha(fs.readFileSync(program));
    const first = pdfQuotes(pdf, []), document = first.document;
    if (first.contract !== 'reader-sealed-pdf-quotes-v1' || document.pdfSha256 !== sha(pdf)
        || sha(document.rawFullText) !== document.rawFullTextSha256
        || sha(document.normalizedFullText) !== document.normalizedFullTextSha256) throw new Error('会议 PDF 逐字投影身份不一致。');
    const paper = current.analysis.papers[0], tables = require('../analysis-contract').extractMarkdownTables(paper.apiReaderArticle);
    const requests = [];
    for (const [index, table] of tables.entries()) {
        const binding = paper.apiReaderPlan?.tableBindings?.[index];
        if (binding?.sourceType !== 'source_quotes' || binding.tableIndex !== index + 1
            || binding.renderedTableSha256 !== sha(table.markdown)
            || !Array.isArray(binding.sourceQuotes) || binding.sourceQuotes.some(item =>
                typeof item?.quote !== 'string' || item.sourceQuoteSha256 !== sha(item.quote)
                || !current.source.sourceDetails.text.includes(item.quote))) continue;
        const window = tableWindow(table, binding, document);
        if (window) requests.push({ tableIndex: index + 1, tableSha256: sha(table.markdown), ...window });
        for (const prose of proseWindows(table, binding, document)) requests.push({ tableIndex: index + 1,
            tableSha256: sha(table.markdown), ...prose, columns: [] });
    }
    if (requests.length > 64) throw new Error('会议出版补充引文超过现有64条上限。');
    const second = pdfQuotes(pdf, requests.map(item => item.quote));
    const after = deps.adapter.loadConferenceAnalysis({ analysisRoot: path.dirname(current.directory), executionId: current.run.executionId });
    if (!isDeepStrictEqual(second.document, document) || implementationSha256 !== sha(fs.readFileSync(program))
        || after.analysisFileSha256 !== current.analysisFileSha256 || after.sourceFileSha256 !== current.sourceFileSha256
        || after.runFileSha256 !== current.runFileSha256 || after.run.status !== 'complete'
        || sha(deps.discovery.safeAbsoluteFile(path.join(sourceRoot, pdfDescriptor.pdfRelativePath), '原会议出版 PDF', deps.discovery.MAX_PDF_BYTES).bytes) !== sha(pdf)) throw new Error('会议出版证据派生期间原来源或实现发生变化。');
    if (!Array.isArray(second.results) || second.results.length !== requests.length) throw new Error('会议出版引文结果集合不完整。');
    const entries = requests.flatMap((item, index) => {
        const result = second.results[index];
        if (!result?.eligible) return [];
        const proof = result.evidence;
        if (proof?.contract !== 'reader-sealed-pdf-quotes-v1' || proof.valueOrigin !== 'sealed_pdf'
            || proof.pdfSha256 !== sha(pdf) || proof.quote !== item.quote
            || proof.quoteSha256 !== sha(proof.quote) || proof.rawFragmentSha256 !== sha(proof.rawFragment)
            || proof.rawFullTextSha256 !== document.rawFullTextSha256
            || proof.normalizedFullTextSha256 !== document.normalizedFullTextSha256
            || !isDeepStrictEqual(proof.extraction, document.extraction)
            || !Array.isArray(proof.pages) || !proof.pages.length) throw new Error('会议出版引文未绑定同一原 PDF 的逐字片段。');
        return [{ ...item, pdfQuoteEvidence: proof }];
    });
    const generation = path.basename(sourceRoot);
    if (!/^generation-[a-f0-9]{64}$/u.test(generation)
        || fs.realpathSync(path.dirname(sourceRoot)) !== fs.realpathSync(deps.files.conferenceSourceCacheDir)) {
        throw new Error('会议出版补充引文只接受当前配置的原来源缓存目录。');
    }
    const descriptor = { executionId: current.run.executionId, sourceGeneration: generation,
        ...reference,
        analysisSha256: current.analysisFileSha256, sourceRecordSha256: current.source.recordSha256,
        sourceSnapshotSha256: current.run.sourceSnapshotSha256, readerArticleSha256: sha(paper.apiReaderArticle),
        readerPlanSha256: paper.apiReaderPlanSha256 };
    const result = freeze({ paperId: current.run.paperId, executionId: current.run.executionId,
        analysisSha256: current.analysisFileSha256, sourceRecordSha256: current.source.recordSha256,
        sourceSnapshotSha256: current.run.sourceSnapshotSha256, pdfSha256: sha(pdf),
        readerArticleSha256: sha(paper.apiReaderArticle), readerPlanSha256: paper.apiReaderPlanSha256,
        extractionReceiptSha256: receipt.receiptSha256, implementationSha256, descriptor, tables: entries });
    registered.set(result, { paper, tables });
    return result;
}

function exportPublicationEvidence(evidence) {
    if (!registered.has(evidence)) throw new Error('会议出版补充证据未由原来源派生。');
    return structuredClone(evidence);
}

function replayDescriptor(paper, descriptor) {
    const expectedKeys = ['executionId', 'sourceGeneration', 'planReceiptSha256', 'catalogName', 'reportName',
        'filterId', 'analysisSha256', 'sourceRecordSha256', 'sourceSnapshotSha256', 'readerArticleSha256', 'readerPlanSha256'];
    if (!descriptor || Object.keys(descriptor).sort().join(',') !== expectedKeys.sort().join(',')
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(descriptor.executionId)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(descriptor.filterId)
        || !/^generation-[a-f0-9]{64}$/u.test(descriptor.sourceGeneration)
        || ['catalogName', 'reportName'].some(key => !/^[a-z0-9][a-z0-9._-]{0,159}\.json$/u.test(descriptor[key]))
        || expectedKeys.filter(key => key.endsWith('Sha256')).some(key => !/^[a-f0-9]{64}$/u.test(descriptor[key]))) {
        throw new Error('会议出版补充证据的原来源引用无效。');
    }
    const deps = require('./conference-process').defaultDependencies();
    const loaded = deps.adapter.loadConferenceAnalysis({ analysisRoot: deps.files.conferenceAnalysisDir,
        executionId: descriptor.executionId });
    const original = loaded.analysis.papers[0];
    if ((paper?.id || paper?.paper_id || paper?.conferencePaperId) !== loaded.run.paperId
        || loaded.analysisFileSha256 !== descriptor.analysisSha256
        || loaded.source.recordSha256 !== descriptor.sourceRecordSha256
        || loaded.run.sourceSnapshotSha256 !== descriptor.sourceSnapshotSha256
        || sha(paper.apiReaderArticle || '') !== descriptor.readerArticleSha256
        || paper.apiReaderPlanSha256 !== descriptor.readerPlanSha256
        || paper.sourceSha256 !== original.sourceSha256
        || !isDeepStrictEqual(paper.apiReaderPlan, original.apiReaderPlan)) throw new Error('会议出版证据引用未绑定原论文与完整 Reader。');
    const verified = verifyColdSourceChain(loaded, descriptor, deps);
    const evidence = deriveVerifiedSourceEvidence({ current: loaded, ...verified, deps,
        reference: { planReceiptSha256: descriptor.planReceiptSha256, filterId: descriptor.filterId,
            catalogName: descriptor.catalogName, reportName: descriptor.reportName } });
    if (!isDeepStrictEqual(evidence.descriptor, descriptor)) throw new Error('会议出版补充证据无法按原来源完整冷重放。');
    return evidence;
}

// 此冷核路径只读原SHA绑定文件和本篇来源；不重跑整批模型筛选解析，也不制造生产句柄。
function verifyColdSourceChain(loaded, descriptor, deps, pinnedFiles = []) {
    const api = require('./conference-process'), retained = require('./conference-retained-source-replay');
    const equal = (a, b, label) => { if (!isDeepStrictEqual(a, b)) throw new Error(`会议出版冷核${label}不一致。`); };
    const read = (directory, name, expected, label) => {
        if (!/^[a-z0-9][a-z0-9._-]{0,159}\.json$/u.test(name || '')) throw new Error(`会议出版冷核${label}文件名无效。`);
        deps.staging.safeDirectory(directory);
        const result = deps.ledger.readRegularJson(deps.staging.safeDirectJson(directory, name));
        pinnedFiles.push({ filename: path.join(directory, name), sha256: result.sha256 });
        if (expected) equal(result.sha256, expected, label + '文件SHA');
        return result;
    };
    const binding = loaded.source.planAuthorityBinding, snapshot = loaded.source.sourceSnapshotBinding;
    equal(descriptor.planReceiptSha256, binding.planReceiptSha256, '原计划引用');
    if (loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete') throw new Error('会议出版冷核仅接受原完整分析。');
    const prefix = `${snapshot.conference.id}-${binding.selectionReceiptSha256.slice(0, 16)}-`;
    const matches = fs.readdirSync(deps.files.conferenceRunsDir).filter(name => name.startsWith(prefix)
        && name.endsWith('-run.plan-receipt.json')).map(name => ({ name,
            ...read(deps.files.conferenceRunsDir, name, null, '计划凭证') }))
        .filter(item => item.sha256 === binding.planReceiptFileSha256);
    if (matches.length !== 1) throw new Error('会议出版冷核缺少唯一的原计划凭证。');
    const found = matches[0], receipt = deps.plan.normalizeSecureReceipt(found.value);
    equal(receipt.receiptSha256, binding.planReceiptSha256, '原计划SHA');
    equal(receipt.filter.filterId, descriptor.filterId, '原筛选身份');
    equal(found.name, receipt.run.name.replace(/\.json$/u, '.plan-receipt.json'), '运行文件名');
    const runFile = read(deps.files.conferenceRunsDir, receipt.run.name, receipt.run.sha256, '原运行');
    equal(runFile.sha256, binding.runFileSha256, '已分析原运行SHA');
    const stem = receipt.run.name.slice(0, -'-run.json'.length);
    if (!new RegExp(`^${escape(prefix)}[a-f0-9]{12}$`, 'u').test(stem)
        || !descriptor.sourceGeneration.startsWith('generation-' + stem.slice(prefix.length))) throw new Error('会议出版冷核来源命名空间不一致。');
    const ledgerFile = read(deps.files.conferenceSourceLedgerDir, receipt.ledger.name, receipt.ledger.sha256, '来源台账');
    const ledgerHandle = deps.ledger.loadLedgerHandle(path.join(deps.files.conferenceSourceLedgerDir, receipt.ledger.name));
    const ledger = deps.ledger.ledgerHandleReadOnlyView(ledgerHandle).ledger;
    equal(ledgerFile.sha256, snapshot.sourceBinding.ledgerSha256, '原来源台账SHA');
    equal(ledger.memberSetSha256, receipt.ledger.memberSetSha256, '台账集合');
    const run = require('./conference-run').assertConferenceRunFromVerifiedLedger(runFile.value, ledgerHandle);
    equal(run.members, receipt.members, '运行论文集合'); equal(run.shards, receipt.shards, '运行分片');
    equal(run.identitySha256, receipt.run.identitySha256, '运行身份'); equal(run.stateSha256, receipt.run.stateSha256, '运行状态');
    equal(run.identitySha256, snapshot.runIdentitySha256, '来源运行身份');
    for (const key of ['filterPolicySha256', 'selectionReceiptSha256', 'selectedMemberSetSha256']) {
        equal(run[key], receipt.filter[key], '运行筛选' + key); equal(binding[key], receipt.filter[key], '来源筛选' + key);
    }
    const originalPlanFile = path.join(deps.files.conferenceSourceLedgerDir, receipt.planName);
    pinnedFiles.push({ filename: originalPlanFile, sha256: deps.ledger.readRegularJson(originalPlanFile).sha256 });
    retained.withOriginalPlanFile(originalPlanFile, receipt, deps, filename => {
        const plan = deps.plan.normalizePlan(deps.ledger.readRegularJson(filename).value);
        equal(plan.version, receipt.version, '计划版本'); equal(plan.ledgerName, receipt.ledger.name, '计划台账');
        equal(deps.plan.tagMetadataForPlan(plan), deps.plan.tagMetadataForReceipt(receipt), '原词表声明');
        deps.plan.readProofTagCatalogFile(deps.plan.tagMetadataForReceipt(receipt), deps.files.tagCatalogFile);
        equal(plan.selectionPolicy.identities, receipt.members, '计划论文集合'); equal(plan.shards, receipt.shards, '计划分片');
    });
    const importedFile = read(deps.files.conferenceSourceLedgerDir, stem + '-ledger.import-receipt.json', receipt.import.receiptFileSha256, '导入凭证');
    const imported = deps.importer.normalizeImportReceipt(importedFile.value);
    equal(imported.receiptSha256, receipt.import.receiptSha256, '导入SHA'); equal(imported.receiptSha256, binding.importReceiptSha256, '来源导入SHA');
    equal(imported.ledger, receipt.ledger, '导入台账');
    const stagedFile = read(deps.files.conferenceStagingDir, stem + '-staging-receipt.json', receipt.staging.receiptFileSha256, '暂存凭证');
    const staged = deps.staging.normalizeReceipt(stagedFile.value);
    equal(staged.receiptSha256, receipt.staging.receiptSha256, '暂存SHA');
    equal(stagedFile.sha256, imported.stagingReceiptFileSha256, '导入暂存文件SHA'); equal(staged.receiptSha256, imported.stagingReceiptSha256, '导入暂存SHA');
    const expectedFilter = Object.fromEntries(Object.keys(receipt.filter).map(key => [key, staged.selection[key]]));
    equal(expectedFilter, receipt.filter, '暂存筛选绑定'); equal(staged.selection.conferenceId, snapshot.conference.id, '暂存会议');
    for (const key of ['filterPolicySha256', 'selectionReceiptSha256', 'selectedMemberSetSha256']) equal(imported[key], receipt.filter[key], '导入筛选' + key);
    const manifestFile = read(deps.files.conferenceStagingDir, staged.importManifest.name, receipt.staging.importManifestFileSha256, '导入清单');
    equal(manifestFile.sha256, staged.importManifest.sha256, '暂存导入清单SHA'); equal(manifestFile.sha256, imported.importManifestFileSha256, '原导入清单SHA');
    const manifest = deps.importer.validateManifest(manifestFile.value);
    equal(api.stableHash(manifest), imported.importManifestSha256, '规范导入清单SHA'); equal(imported.importManifestSha256, receipt.import.importManifestSha256, '计划导入清单SHA');
    equal(manifest.memberSetSha256, ledger.memberSetSha256, '导入成员集合'); equal(manifest.conference, snapshot.conference, '来源会议');
    const filterDirectory = deps.filter.filterDirectory(deps.files.conferenceFiltersDir, receipt.filter.filterId);
    const state = read(filterDirectory, 'state.json', null, '筛选状态').value;
    equal(state.filterId, receipt.filter.filterId, '筛选状态身份'); equal(deps.filter.stateDigest(state), receipt.filter.stateSha256, '原筛选状态SHA');
    equal(state.stateSha256, receipt.filter.stateSha256, '保存筛选状态SHA'); equal(state.input.inputSha256, receipt.filter.inputSha256, '筛选输入SHA');
    equal(state.input.catalogSha256, receipt.filter.catalogSha256, '筛选目录SHA'); equal(state.input.filterPolicySha256, receipt.filter.filterPolicySha256, '筛选策略SHA');
    equal(state.input.conferenceId, snapshot.conference.id, '筛选会议');
    equal(deps.filter.completionFor(state.decisions), state.completion, '完整筛选结果');
    if (state.completion.status !== 'complete') throw new Error('会议出版冷核筛选尚未完成。');
    const selection = read(filterDirectory, 'selection-receipt.json', null, '筛选完成凭证').value;
    equal(deps.filter.selectionReceiptFromCheckedState(state), selection, '筛选完成原状态与全部决策');
    equal(selection.selectionReceiptSha256, receipt.filter.selectionReceiptSha256, '筛选完成SHA');
    equal(selection.selectedMemberSetSha256, receipt.filter.selectedMemberSetSha256, '入选集合SHA');
    equal(selection.included.map(item => item.paperId).sort(), receipt.members.map(item => item.paperId).sort(), '完整入选集合');
    const bound = staged.members.find(item => item.paperId === loaded.run.paperId);
    const selected = selection.included.filter(item => item.paperId === loaded.run.paperId);
    if (!bound || selected.length !== 1) throw new Error('会议出版冷核缺少本篇入选与暂存记录。');
    equal(selected[0], { paperId: bound.paperId, sourceSha256: bound.sourceSha256, decisionArtifactSha256: bound.decisionArtifactSha256 }, '本篇入选证据');
    const attempt = state.attempts.filter(item => item.paperId === loaded.run.paperId).at(-1);
    const artifact = read(path.join(filterDirectory, 'decisions'), attempt?.decisionArtifactName, attempt?.decisionArtifactFileSha256, '原筛选决策');
    equal(artifact.value.artifactSha256, selected[0].decisionArtifactSha256, '原决策SHA');
    const normalizedArtifact = deps.filter.normalizeDecisionArtifact(artifact.value);
    equal(normalizedArtifact.artifactSha256, attempt.decisionArtifactSha256, '规范原决策SHA');
    read(deps.files.conferenceDiscoveryCatalogDir, descriptor.catalogName, staged.discovery.catalogSha256, '原发现目录');
    read(deps.files.conferenceDiscoveryReportDir, descriptor.reportName, staged.discovery.reportSha256, '原发现报告');
    equal(staged.discovery.catalogSha256, receipt.filter.catalogSha256, '原发现筛选目录');
    const sourceRoot = path.join(deps.files.conferenceSourceCacheDir, descriptor.sourceGeneration);
    deps.staging.safeDirectory(sourceRoot);
    const member = ledger.members.filter(item => deps.ledger.identityKey(item.identity) === bound.sourceIdentity);
    if (member.length !== 1 || member[0].status.state !== 'verified') throw new Error('会议出版冷核本篇来源台账未验证。');
    const cached = {};
    for (const [kind, expected] of [['metadata', bound.metadataSha256], ['pdf', bound.pdfSha256], ['text', bound.textSha256], ['artifacts', bound.artifactsSha256]]) {
        equal(member[0][kind + 'Sha256'], expected, '本篇台账' + kind + 'SHA');
        const file = deps.ledger.safeArtifactPath(sourceRoot, member[0][kind + 'File']);
        cached[kind] = deps.discovery.safeAbsoluteFile(file, '原来源' + kind, deps.discovery.MAX_PDF_BYTES).bytes;
        pinnedFiles.push({ filename: file, sha256: sha(cached[kind]) });
        equal(sha(cached[kind]), expected, '本篇真实' + kind + 'SHA');
        equal(snapshot.sourceBinding[kind === 'artifacts' ? 'artifactsFileSha256' : kind + 'Sha256'], expected, '原来源快照' + kind + 'SHA');
    }
    equal(snapshot.identity.key, bound.sourceIdentity, '本篇原身份'); equal(sha(cached.text), loaded.analysis.papers[0].sourceSha256, '分析来源全文SHA');
    const details = deps.adapter.sourceDetails({ paperId: loaded.run.paperId, text: new TextDecoder('utf-8', { fatal: true }).decode(cached.text),
        structuredArtifacts: deps.ledger.readRegularJson(deps.ledger.safeArtifactPath(sourceRoot, member[0].artifactsFile)).value,
        sourceBinding: snapshot.sourceBinding, tableAvailability: { available: false }, formulaAvailability: { available: false }, figureAvailability: { available: false } });
    equal(details, loaded.source.sourceDetails, '原来源全文与结构投影');
    return { sourceRoot, bound, cached };
}

function replayCanonicalReaderPdfSource(paper, sourceIdentity) {
    const deps = require('./conference-process').defaultDependencies();
    if (sourceIdentity?.contract !== 'conference-reader-pdf-source-v1'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(sourceIdentity.executionId || '')) {
        throw new Error('会议 PDF 表格冷核缺少原规范完成运行');
    }
    let loaded = deps.adapter.loadConferenceAnalysis({ analysisRoot: deps.files.conferenceAnalysisDir,
        executionId: sourceIdentity.executionId });
    if (loaded.analysis.readerRevisionProgress !== undefined) {
        const revision = deps.adapter.readJsonRecord(path.join(loaded.directory, 'reader-revision.json')).value;
        if (revision.contract === 'conference-reader-recovery-window-v1') {
            // A current source proof is not authority for an additional budget.
            // Cold table replay retains the registered grant and original CAS chain.
            loaded = deps.adapter.loadGrantedConferenceRecovery({ analysisRoot: deps.files.conferenceAnalysisDir,
                executionId: sourceIdentity.executionId });
        }
    }
    const original = loaded.analysis.papers[0];
    const expected = { contract: 'conference-reader-pdf-source-v1', paperId: loaded.run.paperId,
        sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
        rawStructuredArtifactsSha256: loaded.source.sourceSnapshotBinding.sourceBinding.artifactsPayloadSha256,
        effectiveStructuredArtifactsSha256: loaded.source.sourceDetails.structuredArtifacts.payloadSha256,
        sourceSnapshotBinding: loaded.source.sourceSnapshotBinding,
        planAuthorityBinding: loaded.source.planAuthorityBinding, executionId: loaded.run.executionId };
    if (!isDeepStrictEqual(sourceIdentity, expected) || !isDeepStrictEqual(paper.apiReaderPlan, original.apiReaderPlan)
        || paper.apiReaderArticle !== original.apiReaderArticle || paper.sourceSha256 !== original.sourceSha256
        || (paper.directPaperId || paper.id) !== loaded.run.paperId) throw new Error('会议 PDF 表格冷核与原完整 Reader 或来源不同');
    const binding = loaded.source.planAuthorityBinding, conferenceId = loaded.run.conference.id;
    const prefix = `${conferenceId}-${binding.selectionReceiptSha256.slice(0, 16)}-`;
    const matches = fs.readdirSync(deps.files.conferenceRunsDir).filter(name => name.startsWith(prefix)
        && name.endsWith('-run.plan-receipt.json')).map(name => ({ name,
            ...deps.ledger.readRegularJson(path.join(deps.files.conferenceRunsDir, name)) }))
        .filter(record => record.sha256 === binding.planReceiptFileSha256);
    if (matches.length !== 1) throw new Error('会议 PDF 表格冷核缺少唯一原计划凭证');
    const receipt = deps.plan.normalizeSecureReceipt(matches[0].value), stem = receipt.run.name.slice(0, -'-run.json'.length);
    const roots = fs.readdirSync(deps.files.conferenceSourceCacheDir).filter(name => /^generation-[a-f0-9]{64}$/u.test(name)
        && name.startsWith('generation-' + stem.slice(prefix.length)));
    if (roots.length !== 1) throw new Error('会议 PDF 表格冷核缺少唯一原缓存 generation');
    const staged = deps.ledger.readRegularJson(path.join(deps.files.conferenceStagingDir, stem + '-staging-receipt.json'));
    const descriptor = { executionId: loaded.run.executionId, sourceGeneration: roots[0],
        planReceiptSha256: receipt.receiptSha256, filterId: receipt.filter.filterId,
        catalogName: sourceReference(deps.files.conferenceDiscoveryCatalogDir, staged.value.discovery.catalogSha256, conferenceId, deps),
        reportName: sourceReference(deps.files.conferenceDiscoveryReportDir, staged.value.discovery.reportSha256, conferenceId, deps) };
    const pinnedFiles = [];
    const verified = verifyColdSourceChain(loaded, descriptor, deps, pinnedFiles);
    const extractionFile = path.join(deps.files.conferenceStagingSourceDir, verified.bound.extractionReceiptName);
    const extraction = deps.ledger.readRegularJson(extractionFile);
    require('./conference-retained-source-replay').verifyRetainedExtraction({ paperId: loaded.run.paperId,
        sourceIdentity: verified.bound.sourceIdentity, sourceProof: {
            requestSha256: extraction.value.request?.sha256, receiptSha256: verified.bound.extractionReceiptSha256,
            verificationSha256: verified.bound.extractionVerificationSha256, textSha256: verified.bound.textSha256,
            artifactsSha256: verified.bound.artifactsSha256, pdfSha256: verified.bound.pdfSha256 } }, verified.bound, deps);
    pinnedFiles.push({ filename: extractionFile, sha256: extraction.sha256 });
    for (const [name, hash] of [['analysis.json', loaded.analysisFileSha256], ['run.json', loaded.runFileSha256], ['source.json', loaded.sourceFileSha256]]) {
        pinnedFiles.push({ filename: path.join(loaded.directory, name), sha256: hash });
    }
    const assertUnchanged = () => {
        for (const record of pinnedFiles) {
            const bytes = deps.discovery.safeAbsoluteFile(record.filename, '会议 PDF 表格原来源', deps.discovery.MAX_PDF_BYTES).bytes;
            if (sha(bytes) !== record.sha256) throw new Error('会议 PDF 表格冷核期间原凭证或来源字节改变');
        }
    };
    assertUnchanged();
    const handle = Object.freeze({});
    canonicalReaderPdfSources.set(handle, { paperId: loaded.run.paperId, sourceText: loaded.source.sourceDetails.text,
        sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
        structuredArtifactsSha256: loaded.source.sourceDetails.structuredArtifacts.payloadSha256,
        rawStructuredArtifactsSha256: expected.rawStructuredArtifactsSha256,
        pdfSha256: verified.bound.pdfSha256, pdf: Buffer.from(verified.cached.pdf), sourceIdentity: structuredClone(expected), assertUnchanged });
    return handle;
}

function readVerifiedPublicationReaderPdfSource(handle) {
    const value = handle && canonicalReaderPdfSources.get(handle);
    if (!value) return null;
    value.assertUnchanged();
    return { ...value, pdf: Buffer.from(value.pdf), sourceIdentity: structuredClone(value.sourceIdentity) };
}

function withPublicationEvidence(evidence, callback) {
    if (!registered.has(evidence)) throw new Error('会议出版补充证据必须由真实原来源派生或重新核验。');
    return scope.run(evidence, callback);
}
function entriesFor(paper, table, tableIndex) {
    const evidence = scope.getStore();
    if (!evidence || !registered.has(evidence) || !Number.isSafeInteger(tableIndex) || tableIndex < 1
        || evidence.paperId !== paper?.id || evidence.readerArticleSha256 !== sha(paper.apiReaderArticle || '')
        || evidence.readerPlanSha256 !== paper.apiReaderPlanSha256
        || paper.sourceSha256 !== registered.get(evidence).paper.sourceSha256
        || paper.analysis !== registered.get(evidence).paper.analysis
        || !isDeepStrictEqual(paper.apiReaderPlan, registered.get(evidence).paper.apiReaderPlan)
        || registered.get(evidence).tables[tableIndex - 1]?.markdown !== table?.markdown
        || !isDeepStrictEqual(registered.get(evidence).tables[tableIndex - 1]?.header, table?.header)
        || !isDeepStrictEqual(registered.get(evidence).tables[tableIndex - 1]?.rows, table?.rows)) return [];
    return evidence.tables.filter(item => item.tableIndex === tableIndex && item.tableSha256 === sha(table.markdown));
}
function headerUnitCoverage(paper, table, tableIndex) {
    return entriesFor(paper, table, tableIndex).flatMap(entry => (entry.columns || []).flatMap(column =>
        table.rows.flatMap((row, index) => require('../deep-analyzer').readerNumericTokens(row[column.column] || '')
            .map(value => ({ row: index + 1, column: column.column, value, unit: column.unit })))));
}
function numericCoverage(paper, table, tableIndex, token) {
    return entriesFor(paper, table, tableIndex).some(entry => entry.numericTokens?.includes(token));
}
function supplementalQuotes(paper, table, tableIndex) {
    return entriesFor(paper, table, tableIndex).map(entry => structuredClone(entry.pdfQuoteEvidence));
}
module.exports = { derivePublicationEvidence, withPublicationEvidence, headerUnitCoverage, numericCoverage,
    replayCanonicalReaderPdfSource, readVerifiedPublicationReaderPdfSource,
    supplementalQuotes, exportPublicationEvidence, replayDescriptor, tableWindow, proseWindows };

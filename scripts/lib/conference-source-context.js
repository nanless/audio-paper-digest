'use strict';

// 从当前进程核验过的会议计划及来源清单指定的本地文件，构建只包含来源资料的分析上下文。
// 生产入口先检查计划，再由内部辅助函数核验来源清单和运行记录。
// 本模块不获取 arXiv 来源、不联网、不生成博客，也不调用模型补充缺失来源。

const crypto = require('node:crypto');
const fs = require('node:fs');
const ledgerApi = require('./conference-source-ledger.js');
const pdfApi = require('./conference-pdf-source.js');
const runApi = require('./conference-run.js');
const executionApi = require('./conference-execution.js');
const planApi = require('./conference-plan.js');
const { validatePdfFormulaRecord } = require('./conference-extraction-receipt.js');

const CONTRACT = 'conference-source-context-v2';
const VERSION = 2;
const ARTIFACT_CONTRACT = 'conference-structured-artifacts-v2';
const ARTIFACT_VERSION = 2;
const REPLAYABLE_PROFILE = 'replayable-pdf-layout-v1';
const WEAK_PROFILE = 'weak-pdf-layout-v1';
const UNAVAILABLE_PROFILE = 'unavailable-pdf-layout-v1';
const OFFSET_UNIT = 'utf8-byte';
const SOURCE_SNAPSHOT_BINDING_CONTRACT = 'conference-source-snapshot-binding-v2';
const OBSERVATION_BINDING_CONTRACT = 'conference-source-observation-binding-v2';
const PLAN_AUTHORITY_BINDING_CONTRACT = 'conference-source-plan-authority-binding-v2';
// 此格式为能重新提取并核验结果的 PDF 提取凭证预留；来源清单中的说明文字，
// 或结构化提取结果自行声明的格式，都不能代替这份凭证。
const PDF_EXTRACTION_RECEIPT_CONTRACT = 'conference-pdf-extraction-receipt-v2';
const NO_REPLAYABLE_RECEIPT = 'replayable-pdf-extraction-receipt-unavailable';
const MIN_TEXT_CHARS = 1000;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const SHA_RE = /^[a-f0-9]{64}$/;

class ConferenceSourceContextError extends Error {
    constructor(message, { code = 'CONFERENCE_SOURCE_CONTEXT_INTEGRITY', reasonCode = 'integrity_failure' } = {}) {
        super(message);
        this.name = 'ConferenceSourceContextError';
        this.code = code;
        this.reasonCode = reasonCode;
        this.retryable = false;
    }
}

function integrity(message, reasonCode = 'integrity_failure') {
    throw new ConferenceSourceContextError(`会议来源上下文被拒绝：${message}`, { reasonCode });
}

function blocked(message, reasonCode) {
    throw new ConferenceSourceContextError(`会议来源上下文无法用于分析：${message}`, {
        code: 'CONFERENCE_SOURCE_CONTEXT_BLOCKED', reasonCode
    });
}

function plain(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(value, fields, label) {
    if (!plain(value)) integrity(`${label} 必须是普通对象`);
    const actual = Object.keys(value).sort();
    const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        integrity(`${label} 包含未允许的字段，或缺少必填字段`);
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    integrity('来源快照包含 JSON 不支持的值');
}

function stableHash(value) { return sha256(JSON.stringify(canonical(value))); }
const clone = value => JSON.parse(JSON.stringify(value));

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

function rejectDuplicateJsonKeys(source, label) {
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            let key;
            try { key = JSON.parse(token); }
            catch { integrity(`${label} 包含格式无效的 JSON 字符串`, 'invalid_json'); }
            if (top.keys.has(key)) integrity(`${label} 包含重复的 JSON 键： ${key}`, 'duplicate_json_key');
            top.keys.add(key); top.expectKey = false;
        }
    }
}

function readBoundBytes(sourceRoot, relativePath, expectedSha256, limit, label) {
    let filename;
    try { filename = ledgerApi.safeArtifactPath(sourceRoot, relativePath); }
    catch (error) { integrity(`${label} 路径未通过安全检查： ${error.message}`, 'unsafe_source_path'); }
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > limit) {
            integrity(`${label} 必须是只有一个硬链接、且大小不超过限制的普通文件，打开的文件还须与路径检查的文件相同`, 'unsafe_source_file');
        }
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) integrity(`${label} 读取时文件字节数发生变化`, 'source_changed_during_read');
        if (!SHA_RE.test(String(expectedSha256 || '')) || sha256(bytes) !== expectedSha256) {
            integrity(`${label} SHA-256 格式无效，或与已核验来源清单记录的值不一致`, 'source_sha_drift');
        }
        return bytes;
    } catch (error) {
        if (error instanceof ConferenceSourceContextError) throw error;
        integrity(`${label} 无法安全读取： ${error.message}`, 'source_read_failed');
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function strictUtf8(bytes, label) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { integrity(`${label} 不是有效的 UTF-8 文本`, 'invalid_utf8'); }
}

function strictJson(bytes, label) {
    const source = strictUtf8(bytes, label);
    rejectDuplicateJsonKeys(source, label);
    try { return JSON.parse(source); }
    catch { integrity(`${label} 不是有效的 JSON`, 'invalid_json'); }
}

function positiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) integrity(`${label} 必须是大于零的安全整数`, 'invalid_artifact_schema');
}

function string(value, label, { empty = false } = {}) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || /\u0000/u.test(value)) {
        integrity(`${label} 必须是${empty ? '不含空字符的' : '非空且不含空字符的'}字符串`, 'invalid_artifact_schema');
    }
}

function validatePage(item, index, previousEnd, textBytes) {
    exact(item, ['page', 'textStart', 'textEnd'], `structuredArtifacts.pages[${index}]`);
    positiveInteger(item.page, `structuredArtifacts.pages[${index}].page`);
    if (item.page !== index + 1 || !Number.isSafeInteger(item.textStart) || !Number.isSafeInteger(item.textEnd)
        || item.textStart !== previousEnd || item.textEnd <= item.textStart || item.textEnd > textBytes.length) {
        integrity('structuredArtifacts 页码必须连续，字节区间必须连续、非空且不得超出来源全文', 'invalid_artifact_schema');
    }
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(textBytes.subarray(item.textStart, item.textEnd));
    } catch {
        integrity('structuredArtifacts 每页文本的字节区间必须能单独解码为有效 UTF-8', 'invalid_artifact_schema');
    }
    return item.textEnd;
}

function validateLocatedRecord(item, index, kind) {
    const fields = kind === 'table'
        ? ['ordinal', 'page', 'caption', 'cells', 'sourceRef', 'recoveryStatus']
        : kind === 'formula'
            ? ['ordinal', 'page', 'tex', 'sourceRef', 'recoveryStatus']
            : ['ordinal', 'page', 'caption', 'sourceRef', 'recoveryStatus'];
    exact(item, fields, `structuredArtifacts.${kind}s[${index}]`);
    positiveInteger(item.ordinal, `structuredArtifacts.${kind}s[${index}].ordinal`);
    positiveInteger(item.page, `structuredArtifacts.${kind}s[${index}].page`);
    if (item.ordinal !== index + 1 || item.recoveryStatus !== 'complete') {
        integrity(`structuredArtifacts 的 ${kind} 记录序号必须连续，且 recoveryStatus 必须为 complete`, 'invalid_artifact_schema');
    }
    string(item.sourceRef, `structuredArtifacts.${kind}s[${index}].sourceRef`);
    if (kind === 'formula') string(item.tex, `structuredArtifacts.formulas[${index}].tex`);
    else string(item.caption, `structuredArtifacts.${kind}s[${index}].caption`, { empty: true });
    if (kind === 'table') {
        if (!Array.isArray(item.cells) || !item.cells.length || item.cells.some(row => (
            !Array.isArray(row) || !row.length || row.some(cell => typeof cell !== 'string')
        ))) integrity('structuredArtifacts 表格必须包含非空的行，每个单元格必须是字符串', 'invalid_artifact_schema');
        const width = item.cells[0].length;
        if (item.cells.some(row => row.length !== width)) {
            integrity('structuredArtifacts 表格的每行单元格数量必须相同', 'invalid_artifact_schema');
        }
    }
}

function validateReplayableFigureRecord(item, index) {
    exact(item, ['ordinal', 'page', 'caption', 'sourceRef', 'recoveryStatus', 'asset'],
        `structuredArtifacts.figures[${index}]`);
    positiveInteger(item.ordinal, `structuredArtifacts.figures[${index}].ordinal`);
    positiveInteger(item.page, `structuredArtifacts.figures[${index}].page`);
    if (item.ordinal !== index + 1 || item.recoveryStatus !== 'complete') {
        integrity('structuredArtifacts 图片记录序号必须连续，且 recoveryStatus 必须为 complete', 'invalid_artifact_schema');
    }
    string(item.sourceRef, `structuredArtifacts.figures[${index}].sourceRef`);
    string(item.caption, `structuredArtifacts.figures[${index}].caption`, { empty: true });
    if (item.asset !== null) {
        exact(item.asset, ['base64', 'mediaType', 'sha256'], `structuredArtifacts.figures[${index}].asset`);
        string(item.asset.mediaType, `structuredArtifacts.figures[${index}].asset.mediaType`);
        string(item.asset.base64, `structuredArtifacts.figures[${index}].asset.base64`);
        if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(item.asset.mediaType)
            || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.asset.base64)
            || !SHA_RE.test(String(item.asset.sha256 || ''))) {
            integrity('structuredArtifacts 图片文件的媒体类型、Base64 内容或 SHA 格式无效', 'invalid_artifact_schema');
        }
        const bytes = Buffer.from(item.asset.base64, 'base64');
        if (!bytes.length || sha256(bytes) !== item.asset.sha256) {
            integrity('structuredArtifacts 图片文件内容为空，或 SHA 与解码后的字节不一致', 'invalid_artifact_schema');
        }
    }
}

function validateVisualAudit(value) {
    exact(value, ['contract', 'version', 'backend', 'renderDpi', 'pages', 'embeddedImages',
        'tableCandidates', 'formulaCandidates', 'figureCandidates', 'visualBytes', 'limitations', 'auditSha256'], 'structuredArtifacts.visualAudit');
    if (value.contract !== 'conference-pdf-visual-audit-v1' || value.version !== 1
        || !plain(value.backend) || value.backend.name !== 'pymupdf'
        || value.backend.version !== '1.27.2.3' || value.renderDpi !== 72
        || !Array.isArray(value.pages) || !Array.isArray(value.embeddedImages)
        || !Array.isArray(value.tableCandidates) || !Array.isArray(value.formulaCandidates)
        || !Array.isArray(value.figureCandidates) || !Array.isArray(value.limitations)
        || !Number.isSafeInteger(value.visualBytes) || value.visualBytes < 1
        || value.visualBytes > 48 * 1024 * 1024 || !value.limitations.every(item => typeof item === 'string' && item.trim())) {
        integrity('structuredArtifacts.visualAudit 的格式、提取程序版本、渲染设置、数组或字节限制无效', 'invalid_visual_audit');
    }
    let total = 0;
    value.pages.forEach((page, index) => {
        exact(page, ['page', 'mediaType', 'dpi', 'width', 'height', 'sha256', 'bytes', 'pngBase64'], `structuredArtifacts.visualAudit.pages[${index}]`);
        const png = Buffer.from(page.pngBase64, 'base64');
        if (page.page !== index + 1 || page.mediaType !== 'image/png' || page.dpi !== 72
            || !Number.isSafeInteger(page.width) || page.width < 1 || !Number.isSafeInteger(page.height) || page.height < 1
            || !Number.isSafeInteger(page.bytes) || page.bytes < 1 || !SHA_RE.test(page.sha256)
            || png.length !== page.bytes || sha256(png) !== page.sha256) {
            integrity(`structuredArtifacts.visualAudit.pages[${index}] 页码、PNG 格式、渲染尺寸、字节数或 SHA 不符合记录`, 'invalid_visual_audit');
        }
        total += page.bytes;
    });
    const body = clone(value); delete body.auditSha256;
    if (total !== value.visualBytes || !SHA_RE.test(value.auditSha256) || value.auditSha256 !== stableHash(body)) {
        integrity('structuredArtifacts.visualAudit 总字节数或记录自身的 SHA 格式无效或不符', 'visual_audit_sha_drift');
    }
}

function validateStructuredArtifacts(value, sourceText) {
    const fields = ['contract', 'version', 'profile', 'offsetUnit', 'flattenedTextSha256', 'pages', 'tables', 'formulas', 'figures', 'payloadSha256'];
    const actual = Object.keys(value).sort();
    const expected = [...fields, ...(Object.hasOwn(value, 'visualAudit') ? ['visualAudit'] : [])].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        integrity('structuredArtifacts 包含未允许的字段，或缺少必填字段', 'invalid_artifact_schema');
    }
    if (value.contract !== ARTIFACT_CONTRACT || value.version !== ARTIFACT_VERSION
        || ![REPLAYABLE_PROFILE, WEAK_PROFILE, UNAVAILABLE_PROFILE].includes(value.profile)) {
        integrity('structuredArtifacts 的 contract、version 或 profile 不受支持', 'unsupported_artifact_profile');
    }
    if (value.offsetUnit !== OFFSET_UNIT) {
        integrity(`structuredArtifacts.offsetUnit 必须为 ${OFFSET_UNIT}`, 'invalid_artifact_schema');
    }
    if (!SHA_RE.test(String(value.flattenedTextSha256 || '')) || value.flattenedTextSha256 !== sha256(sourceText)) {
        integrity('structuredArtifacts.flattenedTextSha256 格式无效，或与来源全文的 SHA 不一致', 'flattened_text_sha_drift');
    }
    if (Object.hasOwn(value, 'visualAudit')) validateVisualAudit(value.visualAudit);
    const { payloadSha256, ...body } = value;
    if (!SHA_RE.test(String(payloadSha256 || '')) || payloadSha256 !== sha256(JSON.stringify(body))) {
        integrity('structuredArtifacts.payloadSha256 格式无效，或与该记录其余字段的 SHA 不一致', 'artifact_payload_sha_drift');
    }
    for (const field of ['pages', 'tables', 'formulas', 'figures']) {
        if (!Array.isArray(value[field])) integrity(`structuredArtifacts.${field} 必须是数组`, 'invalid_artifact_schema');
    }
    if (value.profile === UNAVAILABLE_PROFILE) {
        if ([value.pages, value.tables, value.formulas, value.figures].some(items => items.length)) {
            integrity('结构化内容标为 unavailable 时，不得保存已提取的页面、表格、公式或图片记录', 'invalid_artifact_schema');
        }
        return value;
    }
    if (value.profile === REPLAYABLE_PROFILE && !value.pages.length) {
        integrity('可重新核验的结构化记录缺少页面文本区间', 'invalid_artifact_schema');
    }
    if (!value.pages.length) {
        if ([value.tables, value.formulas, value.figures].some(items => items.length)) {
            integrity('structuredArtifacts 的表格、公式或图片记录必须同时提供页面文本区间', 'invalid_artifact_schema');
        }
        return value;
    }
    const sourceBytes = Buffer.from(sourceText, 'utf8');
    let end = 0;
    value.pages.forEach((page, index) => { end = validatePage(page, index, end, sourceBytes); });
    if (end !== sourceBytes.length) {
        integrity('structuredArtifacts 页面文本区间未覆盖完整来源全文', 'invalid_artifact_schema');
    }
    for (const kind of ['table', 'formula', 'figure']) {
        const values = value[`${kind}s`];
        values.forEach((item, index) => {
            if (kind === 'formula') {
                try { validatePdfFormulaRecord(item, index, value.visualAudit, value.pages.length); }
                catch (error) { integrity(error.message, 'invalid_formula_source_expression'); }
            } else if (value.profile === REPLAYABLE_PROFILE && kind === 'figure') {
                validateReplayableFigureRecord(item, index);
            } else validateLocatedRecord(item, index, kind);
        });
        if (new Set(values.map(item => item.sourceRef)).size !== values.length) {
            integrity(`structuredArtifacts 的 ${kind} 记录不能使用重复的 sourceRef`, 'invalid_artifact_schema');
        }
        if (values.some(item => item.page > value.pages.length)) {
            integrity(`structuredArtifacts 的 ${kind} 记录页码超出页面文本区间的页数`, 'invalid_artifact_schema');
        }
    }
    if (value.formulas.length > 32 || value.formulas.reduce((sum, formula) => (
        sum + Buffer.from(formula.sourceExpression.crop.base64, 'base64').length
    ), 0) > 8 * 1024 * 1024) integrity('PDF 公式图片数量超过 32，或裁剪图片总字节数超过 8 MiB', 'invalid_formula_source_expression');
    return value;
}

function unavailableCapability(reason) {
    return { available: false, reliability: 'unavailable', reason };
}

function structuredCapabilityReason(profile) {
    if (profile === WEAK_PROFILE) return 'structured-artifacts-profile-weak';
    if (profile === UNAVAILABLE_PROFILE) return 'structured-artifacts-profile-unavailable';
    if (profile === REPLAYABLE_PROFILE) return 'replayable-pdf-extraction-receipt-v2';
    return NO_REPLAYABLE_RECEIPT;
}

function availableCapability(reason) {
    return { available: true, reliability: 'replayable', reason };
}

function resolveRun(input) {
    if ((input.run === undefined) === (input.execution === undefined)) {
        integrity('run 和 execution 必须且只能提供其中一项', 'ambiguous_run_source');
    }
    if (input.run !== undefined) {
        let run;
        try { run = runApi.assertConferenceRunFromVerifiedLedger(input.run, input.ledgerHandle); }
        catch (error) { integrity(`运行记录与已核验来源清单不匹配： ${error.message}`, 'run_binding_invalid'); }
        return { run, binding: { kind: 'run', runIdentitySha256: run.identitySha256, runStateSha256: run.stateSha256 } };
    }
    let execution;
    try { execution = executionApi.assertConferenceExecution(input.execution); }
    catch (error) { integrity(`执行记录未通过核验： ${error.message}`, 'execution_binding_invalid'); }
    const run = { ...execution.runTemplate, paperStates: execution.paperStates };
    run.stateSha256 = runApi.stableHash({ identitySha256: run.identitySha256, paperStates: run.paperStates });
    let verified;
    try { verified = runApi.assertConferenceRunFromVerifiedLedger(run, input.ledgerHandle); }
    catch (error) { integrity(`执行记录还原的运行记录与已核验来源清单不匹配： ${error.message}`, 'execution_binding_invalid'); }
    if (execution.source.runIdentitySha256 !== verified.identitySha256
        || execution.source.ledgerSha256 !== verified.ledgerSha256) {
        integrity('执行记录中的来源身份或来源清单 SHA 与还原的运行记录不一致', 'execution_binding_invalid');
    }
    return { run: verified, binding: { kind: 'execution', executionId: execution.executionId,
        executionStateSha256: execution.stateSha256, runIdentitySha256: verified.identitySha256,
        runStateSha256: verified.stateSha256 } };
}

function buildConferenceSourceContextFromLedger(input = {}, productionBinding = null) {
    if (productionBinding === null) integrity('必须提供已核验计划的授权信息', 'plan_handle_invalid');
    if (!plain(input)) integrity('会议来源上下文输入必须是普通对象');
    const hasRun = Object.prototype.hasOwnProperty.call(input, 'run');
    const hasExecution = Object.prototype.hasOwnProperty.call(input, 'execution');
    if (hasRun === hasExecution) integrity('run 和 execution 必须且只能提供其中一项', 'ambiguous_run_source');
    exact(input, ['ledgerHandle', hasExecution ? 'execution' : 'run', 'paperId', 'sourceRoot'], '会议来源上下文输入');
    if (typeof input.paperId !== 'string' || !input.paperId) integrity('paperId 必须是非空字符串', 'paper_not_found');
    const resolved = resolveRun(input);
    const matches = resolved.run.members.filter(member => member.paperId === input.paperId);
    if (matches.length !== 1) integrity('paperId 必须对应运行记录中唯一的一篇论文', 'paper_not_found');
    const runMember = matches[0];
    let loaded;
    try { loaded = ledgerApi.ledgerHandleSnapshot(input.ledgerHandle); }
    catch (error) { integrity(`ledgerHandle 不是已核验并登记的来源清单对象： ${error.message}`, 'ledger_handle_invalid'); }
    const ledgerMatches = loaded.ledger.members.filter(member => ledgerApi.identityKey(member.identity) === runMember.sourceIdentity);
    if (ledgerMatches.length !== 1 || ledgerMatches[0].status.state !== 'verified') {
        integrity('运行记录的来源身份必须对应来源清单中唯一的已核验成员', 'source_identity_invalid');
    }
    const member = ledgerMatches[0];
    let pdfSource;
    try {
        pdfSource = pdfApi.buildConferencePdfSourceFromLedger({ sourceRoot: input.sourceRoot,
            ledgerHandle: input.ledgerHandle, identityKey: runMember.sourceIdentity });
    } catch (error) {
        integrity(`按来源清单重新读取并核验 PDF 失败： ${error.message}`, 'pdf_source_invalid');
    }
    const metadataBytes = readBoundBytes(input.sourceRoot, member.metadataFile, member.metadataSha256, MAX_METADATA_BYTES, '元数据文件');
    const textBytes = readBoundBytes(input.sourceRoot, member.textFile, member.textSha256, MAX_TEXT_BYTES, '全文文件');
    const artifactBytes = readBoundBytes(input.sourceRoot, member.artifactsFile, member.artifactsSha256, MAX_ARTIFACT_BYTES, '结构化提取记录文件');
    const metadata = strictJson(metadataBytes, '元数据文件');
    if (!plain(metadata) || !Object.keys(metadata).length) integrity('元数据文件必须包含非空 JSON 对象', 'invalid_metadata');
    const text = strictUtf8(textBytes, '全文文件');
    let nonWhitespaceCharacters = 0;
    for (const character of text) if (!/\s/u.test(character)) nonWhitespaceCharacters += 1;
    if (nonWhitespaceCharacters < MIN_TEXT_CHARS) {
        blocked(`来源全文少于 ${MIN_TEXT_CHARS} 个非空白字符`, 'text_too_short');
    }
    const structuredArtifacts = validateStructuredArtifacts(strictJson(artifactBytes, '结构化提取记录文件'), text);
    const structuredReason = structuredCapabilityReason(structuredArtifacts.profile);
    const capability = structuredArtifacts.profile === REPLAYABLE_PROFILE
        ? availableCapability(structuredReason) : unavailableCapability(structuredReason);
    const formulaAvailability = { ...unavailableCapability('pdf-has-no-original-tex'),
        layoutEvidenceAvailable: Boolean(structuredArtifacts.visualAudit?.formulaCandidates?.length) };
    const tableAvailability = capability;
    const figureAvailability = capability;
    const sourceBinding = {
        ledgerSha256: loaded.ledgerSha256,
        metadataSha256: member.metadataSha256, pdfSha256: member.pdfSha256,
        textSha256: member.textSha256, artifactsFileSha256: member.artifactsSha256,
        artifactsPayloadSha256: structuredArtifacts.payloadSha256,
        pdfDescriptorSha256: pdfSource.descriptor.descriptorSha256,
        textExtractor: { ...member.provenance.text }, artifactsExtractor: { ...member.provenance.artifacts }
    };
    const conference = { id: loaded.ledger.conference.id, year: loaded.ledger.conference.year };
    const identity = { ...member.identity, key: runMember.sourceIdentity };
    const sourceSnapshotBinding = {
        contract: SOURCE_SNAPSHOT_BINDING_CONTRACT, version: VERSION, paperId: input.paperId,
        conference, identity, runIdentitySha256: resolved.binding.runIdentitySha256,
        sourceBinding, pdfDescriptor: pdfSource.descriptor
    };
    sourceSnapshotBinding.planAuthority = productionBinding;
    const sourceSnapshotSha256 = stableHash(sourceSnapshotBinding);
    const observationBinding = {
        contract: OBSERVATION_BINDING_CONTRACT, version: VERSION,
        sourceSnapshotSha256, runBinding: resolved.binding
    };
    const body = {
        contract: CONTRACT, version: VERSION, paperId: input.paperId,
        conference, identity,
        runBinding: resolved.binding,
        sourceBinding, sourceSnapshotBinding, sourceSnapshotSha256,
        observationBinding, observationBindingSha256: stableHash(observationBinding),
        pdfDescriptor: pdfSource.descriptor,
        metadata, text, structuredArtifacts,
        analysisReady: true, textOffsetUnit: OFFSET_UNIT,
        extractionReceipt: { contract: PDF_EXTRACTION_RECEIPT_CONTRACT,
            available: structuredArtifacts.profile === REPLAYABLE_PROFILE,
            reason: structuredArtifacts.profile === REPLAYABLE_PROFILE ? 'replayable-pdf-extraction-receipt-v2' : NO_REPLAYABLE_RECEIPT },
        formulaAvailability, tableAvailability, figureAvailability,
        figurePolicy: 'no_external_fetch', sourceOnly: true,
        productionAuthorization: { authorized: true, binding: productionBinding }
    };
    return deepFreeze(body);
}

function buildConferenceSourceContext(input = {}) {
    if (!plain(input)) integrity('正式会议来源上下文输入必须是普通对象');
    exact(input, ['planHandle', 'paperId', 'sourceRoot'], '正式会议来源上下文输入');
    let authority;
    try { authority = planApi.planHandleAuthority(input.planHandle); }
    catch (error) { integrity(`planHandle 不是已核验并登记的计划对象： ${error.message}`, 'plan_handle_invalid'); }
    const snapshot = authority.snapshot;
    const receipt = snapshot.receipt;
    const bindingBody = {
        contract: PLAN_AUTHORITY_BINDING_CONTRACT,
        version: VERSION,
        planReceiptSha256: receipt.receiptSha256,
        planReceiptFileSha256: snapshot.receiptFileSha256,
        runFileSha256: snapshot.runFileSha256,
        importReceiptSha256: receipt.import.receiptSha256,
        filterPolicySha256: receipt.filter.filterPolicySha256,
        selectionReceiptSha256: receipt.filter.selectionReceiptSha256,
        selectedMemberSetSha256: receipt.filter.selectedMemberSetSha256
    };
    const productionBinding = { ...bindingBody, bindingSha256: stableHash(bindingBody) };
    return buildConferenceSourceContextFromLedger({ ledgerHandle: authority.ledgerHandle,
        run: snapshot.run, paperId: input.paperId, sourceRoot: input.sourceRoot }, productionBinding);
}

module.exports = {
    CONTRACT, VERSION, ARTIFACT_CONTRACT, ARTIFACT_VERSION, REPLAYABLE_PROFILE, WEAK_PROFILE,
    UNAVAILABLE_PROFILE, OFFSET_UNIT, SOURCE_SNAPSHOT_BINDING_CONTRACT, OBSERVATION_BINDING_CONTRACT,
    PLAN_AUTHORITY_BINDING_CONTRACT, PDF_EXTRACTION_RECEIPT_CONTRACT, MIN_TEXT_CHARS,
    ConferenceSourceContextError, buildConferenceSourceContext,
    stableHash
};

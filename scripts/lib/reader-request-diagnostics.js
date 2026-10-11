'use strict';

// 只保存真实修复请求与响应，不授予正文或发布资格。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function syncDirectory(directoryPath) {
    const fd = fs.openSync(directoryPath, 'r');
    let failure;
    try { fs.fsyncSync(fd); }
    catch (error) { failure = error; throw error; }
    finally { try { fs.closeSync(fd); } catch (error) { if (!failure) throw error; } }
}
function directory(root) {
    const absolute = path.resolve(root, 'request-diagnostics');
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let created = false;
        try { fs.mkdirSync(cursor, { mode: 0o700 }); created = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (created) syncDirectory(path.dirname(cursor));
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('长文修复记录目录必须是真实目录');
    }
    return absolute;
}
function write(directoryPath, filename, payload) {
    const bytes = JSON.stringify(payload, null, 2) + '\n';
    const file = path.join(directoryPath, filename);
    const fd = fs.openSync(file, 'wx', 0o600);
    let failure;
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    catch (error) { failure = error; throw error; }
    finally {
        try { fs.closeSync(fd); } catch (error) { if (!failure) throw error; }
    }
    syncDirectory(directoryPath);
    return { path: file, sha256: sha(bytes) };
}
function begin(root, context) {
    const metadataOperation = require('./reader-repair').buildTopLevelMetadataRepairContext(context?.rawDraft);
    const metadataRepairValid = metadataOperation
        && JSON.stringify(metadataOperation) === JSON.stringify(context.atomicOperation)
        && context.draft === null && Array.isArray(context.repairTargets) && context.repairTargets.length === 0
        && context.draftSha256 === metadataOperation.rawSha256;
    if (typeof context?.prompt !== 'string' || !Array.isArray(context.repairTargets)
        || (!metadataRepairValid && context.draftSha256 !== sha(JSON.stringify(context.draft)))) {
        throw new Error('长文修复记录必须对应当前真实草稿和修复上下文');
    }
    const id = crypto.randomUUID();
    const dir = directory(root);
    const request = { ...context, contract: 'reader-repair-request-diagnostics-v1', id,
        at: new Date().toISOString(), promptSha256: sha(context.prompt) };
    const receipt = write(dir, `${id}.request.json`, request);
    return { id, directory: dir, requestSha256: receipt.sha256 };
}
function response(diagnostic, rawResponse) {
    if (typeof rawResponse !== 'string') throw new Error('长文修复记录只保存真实响应文本');
    return write(diagnostic.directory, `${diagnostic.id}.response.json`, {
        contract: 'reader-repair-request-diagnostics-v1', id: diagnostic.id,
        at: new Date().toISOString(), requestSha256: diagnostic.requestSha256,
        outputTextSha256: sha(rawResponse), rawResponse
    });
}
function guarded(action) {
    try { return action(); }
    catch (cause) {
        const error = new Error(`长文修复记录无法保存：${cause.message}`, { cause });
        error.code = 'READER_DIAGNOSTIC_FAILED';
        error.retryable = false;
        error.scope = 'run';
        throw error;
    }
}
const beginReaderRepairDiagnostic = (root, context) => guarded(() => begin(root, context));
const saveReaderRepairResponse = (diagnostic, raw) => guarded(() => response(diagnostic, raw));
const CORE_CONTRACT = 'core-summary-request-diagnostics-v1';
function beginCoreSummaryDiagnostic(root, context) {
    return guarded(() => {
        if (!context || typeof context.prompt !== 'string'
            || typeof context.inputAnalysis !== 'string' || typeof context.sourceText !== 'string'
            || typeof context.evidenceText !== 'string' || !context.identity
            || context.identity.inputAnalysisSha256 !== sha(context.inputAnalysis)
            || context.identity.sourceTextSha256 !== sha(context.sourceText)
            || context.identity.evidenceSha256 !== sha(context.evidenceText)) {
            throw new Error('摘要修复记录必须绑定真实来源、输入和证据');
        }
        const id = crypto.randomUUID();
        const dir = directory(root);
        const receipt = write(dir, `${id}.request.json`, { ...context,
            contract: CORE_CONTRACT, id, at: new Date().toISOString(),
            promptSha256: sha(context.prompt) });
        return { id, directory: dir, requestSha256: receipt.sha256, contract: CORE_CONTRACT };
    });
}
function saveCoreSummaryResponse(record, rawResponse) {
    return guarded(() => {
        if (typeof rawResponse !== 'string') throw new Error('摘要修复记录只保存真实响应');
        return write(record.directory, `${record.id}.response.json`, {
            contract: CORE_CONTRACT, id: record.id, requestSha256: record.requestSha256,
            at: new Date().toISOString(), outputTextSha256: sha(rawResponse), rawResponse
        });
    });
}
function saveCoreSummaryDisposition(record, disposition) {
    return guarded(() => {
        if (!['request_failed', 'rejected', 'validated'].includes(disposition?.status)
            || (disposition.status !== 'request_failed'
                && !/^[a-f0-9]{64}$/.test(String(disposition.outputTextSha256))))
            throw new Error('摘要修复结果记录格式无效');
        return write(record.directory, `${record.id}.disposition.json`, {
            ...disposition, contract: CORE_CONTRACT, id: record.id,
            requestSha256: record.requestSha256, at: new Date().toISOString()
        });
    });
}
function readCoreSummaryDiagnostic(root, id, expectedIdentity) {
    return guarded(() => {
        if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('摘要修复记录身份无效');
        const dir = path.resolve(root, 'request-diagnostics');
        let cursor = path.parse(dir).root;
        for (const part of dir.slice(cursor.length).split(path.sep).filter(Boolean)) {
            cursor = path.join(cursor, part);
            const stat = fs.lstatSync(cursor);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('摘要修复记录目录必须为真实目录');
        }
        const read = suffix => {
            const filename = path.join(dir, `${id}.${suffix}.json`);
            const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            let failure;
            try {
                const stat = fs.fstatSync(fd);
                if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024)
                    throw new Error('摘要修复记录必须为普通独立文件且不超过 64 MiB');
                const bytes = fs.readFileSync(fd);
                return { value: JSON.parse(bytes), sha256: sha(bytes) };
            } catch (error) { failure = error; throw error; }
            finally { try { fs.closeSync(fd); } catch (error) { if (!failure) throw error; } }
        };
        const request = read('request'); const response = read('response');
        const disposition = read('disposition');
        if (!['rejected', 'validated'].includes(disposition.value.status)
            || [request, response, disposition].some(item => item.value.contract !== CORE_CONTRACT || item.value.id !== id)
            || JSON.stringify(request.value.identity) !== JSON.stringify(expectedIdentity)
            || request.value.promptSha256 !== sha(request.value.prompt)
            || request.value.identity.inputAnalysisSha256 !== sha(request.value.inputAnalysis)
            || request.value.identity.sourceTextSha256 !== sha(request.value.sourceText)
            || request.value.identity.evidenceSha256 !== sha(request.value.evidenceText)
            || response.value.requestSha256 !== request.sha256
            || disposition.value.requestSha256 !== request.sha256
            || response.value.outputTextSha256 !== sha(response.value.rawResponse)
            || disposition.value.outputTextSha256 !== response.value.outputTextSha256)
            throw new Error('摘要修复记录与当前来源或输入不一致');
        return { request: request.value, response: response.value, disposition: disposition.value };
    });
}
module.exports = { beginReaderRepairDiagnostic, saveReaderRepairResponse,
    beginCoreSummaryDiagnostic, saveCoreSummaryResponse, saveCoreSummaryDisposition,
    readCoreSummaryDiagnostic };

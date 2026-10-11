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
    if (typeof context?.prompt !== 'string' || !Array.isArray(context.repairTargets)
        || context.draftSha256 !== sha(JSON.stringify(context.draft))) {
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
module.exports = { beginReaderRepairDiagnostic, saveReaderRepairResponse };

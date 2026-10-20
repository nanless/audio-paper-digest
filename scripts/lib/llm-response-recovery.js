'use strict';
// Only failures in the metadata ledger use this private response archive. It is
// evidence for controlled recovery, never a completion or model-call permit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function preserveResponse(event, response, options = {}) {
    const directory = path.resolve(options.recoveryDirectory || (options.directory
        ? path.join(options.directory, 'response-recovery')
        : require('../config').FILES.llmResponseRecoveryDir));
    let current = path.parse(directory).root;
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('响应恢复目录必须为真实目录');
    }
    fs.chmodSync(directory, 0o700);
    const savedResponse = response == null ? null : { statusCode: response.statusCode ?? null, body: response.body ?? null,
        ...(typeof response.raw === 'string' ? { raw: response.raw } : {}) };
    const body = { contract: 'llm-response-recovery-v1', event,
        eventSha256: sha(JSON.stringify(event)), response: savedResponse,
        responseSha256: sha(JSON.stringify(savedResponse)) };
    const bytes = Buffer.from(JSON.stringify(body) + '\n');
    const filename = path.join(directory, `${crypto.randomUUID()}.json`);
    const temporary = filename + '.tmp';
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
        throw new Error('响应恢复文件回读身份不一致');
    }
    const readFd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const before = fs.fstatSync(readFd), actual = fs.readFileSync(readFd), after = fs.fstatSync(readFd);
        const named = fs.lstatSync(filename);
        if (!actual.equals(bytes) || [before, after, named].some(value => !value.isFile()
            || value.dev !== stat.dev || value.ino !== stat.ino || value.size !== bytes.length
            || value.nlink !== 1 || (value.mode & 0o777) !== 0o600 || value.mtimeMs !== stat.mtimeMs)) {
            throw new Error('响应恢复文件回读字节或身份不一致');
        }
    } finally { fs.closeSync(readFd); }
    return { filename, sha256: sha(bytes), responseSha256: body.responseSha256, eventId: event?.eventId || null };
}

function persistenceError(cause, event, response, options = {}) {
    const error = Object.assign(new Error('模型费用记录保存失败，已停止新请求；保留原费用和实际响应后受控恢复', { cause }), {
        code: 'LLM_USAGE_NOT_PERSISTED', scope: 'run', category: 'storage', retryable: false,
        modelRequestClassified: true, eventId: event?.eventId || null
    });
    // An entirely unavailable disk cannot durably preserve a response. Keep the
    // real object in memory without accidentally printing it in error reports.
    Object.defineProperty(error, 'llmResponse', { value: response, enumerable: false });
    Object.defineProperty(error, 'usageEvent', { value: event, enumerable: false });
    try { error.responseRecovery = preserveResponse(event, response, options); }
    catch (recoveryError) {
        error.responseRecoveryFailed = true;
        Object.defineProperty(error, 'responseRecoveryError', { value: recoveryError, enumerable: false });
    }
    return error;
}
module.exports = { preserveResponse, persistenceError };

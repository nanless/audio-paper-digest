"use strict";

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

// 先写临时文件，再用不可覆盖的硬链接发布；崩溃不会留下半截正式不可变文件。
function writeImmutableFile(filename, bytes, reject) {
    const payload = Buffer.from(bytes);
    const directory = path.dirname(filename);
    const originalDirectory = fs.lstatSync(directory);
    const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
    const assertDirectory = () => {
        const current = fs.lstatSync(directory);
        if (!current.isDirectory() || current.isSymbolicLink()
            || !sameIdentity(current, originalDirectory) || fs.realpathSync(directory) !== directory) {
            reject('不可变文件目录在写入期间发生变化');
        }
    };
    assertDirectory();
    const hostId = crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
    const temporaryPrefix = `.${path.basename(filename)}.${hostId}.`;
    const temporary = path.join(directory, `${temporaryPrefix}${process.pid}.${crypto.randomUUID()}.tmp`);
    const ownerExited = pid => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; if (error.code === 'EPERM') return false; throw error; }
    };
    const recoverExitedWriterLink = named => {
        for (const entry of fs.readdirSync(directory)) {
            if (!entry.startsWith(temporaryPrefix)) continue;
            const owner = entry.slice(temporaryPrefix.length).match(/^([1-9]\d*)\.[a-f0-9-]{36}\.tmp$/);
            const pid = owner ? Number(owner[1]) : NaN;
            if (!Number.isSafeInteger(pid) || pid > 2147483647 || !ownerExited(pid)) continue;
            const candidate = path.join(directory, entry);
            let candidateStat;
            try { candidateStat = fs.lstatSync(candidate); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!candidateStat.isFile() || candidateStat.nlink !== 2 || !sameIdentity(candidateStat, named)) continue;
            const recoveryFd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            try {
                const opened = fs.fstatSync(recoveryFd);
                if (!opened.isFile() || opened.nlink !== 2 || opened.size !== payload.length
                    || !sameIdentity(opened, named) || !fs.readFileSync(recoveryFd).equals(payload)) {
                    reject('已退出写者的不可变文件与当前预期不同，拒绝清理');
                }
                assertDirectory();
                const currentCandidate = fs.lstatSync(candidate), currentFinal = fs.lstatSync(filename);
                if (!sameIdentity(currentCandidate, opened) || !sameIdentity(currentFinal, opened)
                    || currentCandidate.isSymbolicLink() || currentFinal.isSymbolicLink()
                    || currentCandidate.nlink !== 2 || currentFinal.nlink !== 2 || !ownerExited(pid)) {
                    reject('已退出写者的不可变文件在恢复时发生变化');
                }
                fs.unlinkSync(candidate);
                return true;
            } finally { fs.closeSync(recoveryFd); }
        }
        return false;
    };
    let fd; let created; let linked = false;
    const errors = [];
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        created = fs.fstatSync(fd);
        fs.writeFileSync(fd, payload);
        fs.fchmodSync(fd, 0o600);
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        assertDirectory();
        const named = fs.lstatSync(temporary);
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !sameIdentity(named, created)) {
            reject('不可变文件临时文件在发布前被替换');
        }
        try { fs.linkSync(temporary, filename); linked = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    } catch (error) { errors.push(error); }
    finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (error) { errors.push(error); }
        }
        if (created) {
            try {
                assertDirectory();
                const named = fs.lstatSync(temporary);
                if (!named.isFile() || named.isSymbolicLink() || !sameIdentity(named, created)
                    || named.nlink !== (linked ? 2 : 1)) reject('不可变文件临时文件已换主，拒绝清理');
                fs.unlinkSync(temporary);
            } catch (error) { errors.push(error); }
        }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '不可变文件写入失败，清理也未完成');
    assertDirectory();
    // 同字节并发写入可能正处于临时硬链接尚未移除的短窗口，等待它完成清理。
    for (let attempt = 0; ; attempt++) {
        const named = fs.lstatSync(filename);
        if (named.isFile() && !named.isSymbolicLink() && named.nlink === 2 && attempt < 49) {
            if (recoverExitedWriterLink(named)) continue;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
            continue;
        }
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size !== payload.length) {
            reject('已有不可变文件不是相同长度的普通单链接文件，拒绝覆盖');
        }
        const readFd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const opened = fs.fstatSync(readFd);
            if (!sameIdentity(opened, named) || opened.nlink !== 1 || opened.size !== payload.length) {
                reject('不可变文件在核验时被替换');
            }
            const actual = fs.readFileSync(readFd);
            const after = fs.fstatSync(readFd); const namedAfter = fs.lstatSync(filename);
            if (!actual.equals(payload) || !sameIdentity(after, opened) || !sameIdentity(namedAfter, opened)
                || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
                || namedAfter.nlink !== 1 || namedAfter.isSymbolicLink()) reject('拒绝覆盖内容不同或读取时变化的不可变文件');
        } finally { fs.closeSync(readFd); }
        break;
    }
    assertDirectory();
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return linked ? 'created' : 'recovered';
}

// 仅供显式恢复入口调用；不把读取到的字节认作可信来源，调用方仍须核验凭证。
function recoverImmutableFileLink(filename, reject, maxBytes) {
    let named;
    try { named = fs.lstatSync(filename); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 2) return false;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || named.size < 1 || named.size > maxBytes) {
        reject('待恢复文件超过允许的字节范围');
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes;
    try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 2 || opened.size !== named.size) {
            reject('待恢复文件在打开时发生变化');
        }
        bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd); const current = fs.lstatSync(filename);
        if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
            || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino
            || current.isSymbolicLink() || current.nlink !== 2) reject('待恢复文件在读取时发生变化');
    } finally { fs.closeSync(fd); }
    // 正式路径已经存在，公共写入器只能比较字节并回收已退出写者的临时硬链接。
    writeImmutableFile(filename, bytes, reject);
    return true;
}

module.exports = { writeImmutableFile, recoverImmutableFileLink };

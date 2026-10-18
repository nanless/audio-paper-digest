'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
// Normal-publisher private FD bridge, never a model / network entry.
const fs = require('node:fs');
const denyNetwork = () => { throw new Error('出版图片派生仅允许原本地来源'); };
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:net').connect = denyNetwork; require('node:net').createConnection = denyNetwork;
require('node:tls').connect = denyNetwork;
for (const name of ['node:http', 'node:https']) {
    require(name).request = denyNetwork; require(name).get = denyNetwork;
}
globalThis.fetch = denyNetwork;
async function main() {
    require('../env-loader.js').requireExternalRuntime('conference-publication-figure-crop-replay-cli.js');
    const raw = process.argv[2];
    if (!/^\d+$/.test(raw || '') || Number(raw) < 3) throw new Error('必须提供私有文件描述符');
    const descriptor = Number(raw), info = fs.fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size < 2 || info.size > 8 * 1024 * 1024)
        throw new Error('私有输入不是大小受限的普通文件');
    const input = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    const api = require('./conference-publication-figure-crop.js');
    const method = input.expectedDerivation ? api.replayPublicationFigureCrops : api.derivePublicationFigureCrops;
    fs.writeSync(1, JSON.stringify(await method(input)));
}
main().catch(error => { process.stderr.write(String(error.message).slice(0, 4000)); process.exitCode = 1; });

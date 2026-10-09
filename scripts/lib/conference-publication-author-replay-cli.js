'use strict';

// 仅接收调用者继承的私有文件描述符，不读取 env/config，不加载网络或模型模块。
const fs = require('node:fs');
const denyNetwork = () => { throw new Error('作者来源重放只允许本地读取'); };
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:net').connect = denyNetwork;
require('node:net').createConnection = denyNetwork;
require('node:tls').connect = denyNetwork;
for (const module of ['node:http', 'node:https']) {
    require(module).request = denyNetwork; require(module).get = denyNetwork;
}
globalThis.fetch = denyNetwork;
const { verifyPublicationAuthorSources } = require('./conference-publication-author-source.js');
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
try {
    const raw = process.argv[2];
    if (!/^\d+$/.test(raw || '') || Number(raw) < 3) throw new Error('必须提供私有文件描述符');
    const descriptor = Number(raw);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > MAX_INPUT_BYTES) throw new Error('必须提供大小受限的私有普通文件');
    const input = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    process.stdout.write(JSON.stringify({ verified: true, papers: verifyPublicationAuthorSources(input) }));
} catch (error) {
    process.stderr.write(String(error.message).slice(0, 2000));
    process.stdout.write('{"verified":false}');
    process.exitCode = 1;
}

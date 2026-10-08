#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { requireExternalRuntime } = require('./env-loader');
const Config = require('./config');

const PREVIEW_FORMAT = Object.freeze({
    bundle: 'paper-tag-preview-bundle-v2', index: 'paper-tag-preview-v2',
    report: 'paper-tag-migration-report-v2', disposition: 'paper-tag-seven-state-disposition-v2',
    catalogField: 'tagCatalogVersion', otherCatalogField: 'taxonomyVersion'
});
const LEGACY_PREVIEW_FORMAT = Object.freeze({
    bundle: 'paper-taxonomy-preview-bundle-v1', index: 'paper-taxonomy-preview-v1',
    report: 'paper-taxonomy-migration-report-v1', disposition: 'paper-taxonomy-seven-state-disposition-v1',
    catalogField: 'taxonomyVersion', otherCatalogField: 'tagCatalogVersion'
});

function previewCatalogVersion(value, format) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.hasOwn(value, format.otherCatalogField)
        || !Object.hasOwn(value, format.catalogField)
        || typeof value[format.catalogField] !== 'string' || !value[format.catalogField].trim()) {
        throw new Error('预览的词表版本字段缺失、混用或与格式版本不一致。');
    }
    return value[format.catalogField];
}

function parseArgs(args) {
    const [command, ...rest] = args;
    if (!['validate', 'serve'].includes(command)) throw new Error('用法：tags:validate，或 tags:serve [--port 8766]');
    let port = 8766;
    if (rest.length) {
        if (command !== 'serve' || rest.length !== 2 || rest[0] !== '--port'
            || !/^[1-9]\d*$/.test(rest[1])) throw new Error('serve 只接受 --port 加一个正整数');
        port = Number(rest[1]);
    }
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('端口要在 1024 到 65535 之间');
    return { command, port };
}

function readSafeFile(filename, limit = 32 * 1024 * 1024) {
    const absolute = path.resolve(filename);
    if (fs.realpathSync(absolute) !== absolute) throw new Error(`预览文件不能经过符号链接：${absolute} 不是它的真实路径`);
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('预览文件不合法：只接受单链接的普通文件，且不超过大小上限');
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}

function readPreviewBundle(indexPath, tagCatalog) {
    const directory = path.dirname(indexPath);
    const manifestPath = path.join(directory, 'bundle-manifest.json');
    const manifestBytes = readSafeFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    const names = ['index.json', 'migration-report.json', 'tag-disposition.csv'];
    if (!manifest.files || Object.keys(manifest.files).sort().join(',') !== names.slice().sort().join(',')) {
        throw new Error('预览文件清单不完整，请重新运行 npm run tags:preview。');
    }
    const files = new Map();
    for (const name of names) {
        const bytes = readSafeFile(path.join(directory, name));
        const actual = crypto.createHash('sha256').update(bytes).digest('hex');
        if (actual !== manifest.files[name]) throw new Error(`Preview bundle drift: ${name}; rebuild preview`);
        files.set(name, bytes);
    }
    if (!readSafeFile(manifestPath).equals(manifestBytes)) throw new Error('预览文件在读取过程中被改写');
    const format = manifest.version === PREVIEW_FORMAT.bundle ? PREVIEW_FORMAT
        : manifest.version === LEGACY_PREVIEW_FORMAT.bundle ? LEGACY_PREVIEW_FORMAT : null;
    if (!format) throw new Error('预览文件清单的格式版本不受支持。');
    const snapshot = JSON.parse(files.get('index.json'));
    const report = JSON.parse(files.get('migration-report.json'));
    const dispositionRecords = [snapshot.summary, report.summary, report];
    const hasDisposition = dispositionRecords.map(value => value != null && Object.hasOwn(value, 'dispositionSchema'));
    const summaryObjects = snapshot.summary !== null && typeof snapshot.summary === 'object' && !Array.isArray(snapshot.summary)
        && report.summary !== null && typeof report.summary === 'object' && !Array.isArray(report.summary);
    const earlyLegacyBundle = format === LEGACY_PREVIEW_FORMAT && summaryObjects
        && hasDisposition.every(present => !present);
    if (snapshot.version !== format.index || report.version !== format.report
        || !summaryObjects
        || (!earlyLegacyBundle && (!hasDisposition.every(Boolean)
            || dispositionRecords.some(value => value.dispositionSchema !== format.disposition)))) {
        throw new Error('预览索引、报告和标签处理方式的格式版本不一致。');
    }
    for (const value of [manifest, snapshot, report]) {
        if (previewCatalogVersion(value, format) !== tagCatalog.version
            || value.registrySha256 !== tagCatalog.registrySha256) {
            throw new Error('预览绑定的词表版本或 SHA 已变化，请重新运行 npm run tags:preview。');
        }
        if (value.source?.commit !== manifest.source?.commit
            || value.source?.pagesSha256 !== manifest.source?.pagesSha256
            || !/^[a-f0-9]{40,64}$/.test(String(manifest.source?.commit || ''))
            || !/^[a-f0-9]{64}$/.test(String(manifest.source?.pagesSha256 || ''))) {
            throw new Error('预览绑定的博客提交或页面 SHA 不一致。');
        }
    }
    return files.get('index.json');
}

function loadAssets({ indexPath, assetDir, tagCatalog }) {
    const data = readPreviewBundle(indexPath, tagCatalog);
    const snapshot = JSON.parse(data.toString('utf8'));
    require('../web/tag-explorer/app.js').validateSnapshot(snapshot);
    return new Map([
        ['/', { type: 'text/html; charset=utf-8', bytes: readSafeFile(path.join(assetDir, 'index.html')) }],
        ['/style.css', { type: 'text/css; charset=utf-8', bytes: readSafeFile(path.join(assetDir, 'style.css')) }],
        ['/app.js', { type: 'text/javascript; charset=utf-8', bytes: readSafeFile(path.join(assetDir, 'app.js')) }],
        ['/index.json', { type: 'application/json; charset=utf-8', bytes: data }]
    ]);
}

function createPreviewServer(assets) {
    return http.createServer((req, res) => {
        const port = res.socket.localPort;
        const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        const origins = hosts.map(host => `http://${host}`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        if (!hosts.includes(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin))) {
            res.writeHead(403); res.end('Forbidden'); return;
        }
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.setHeader('Allow', 'GET, HEAD'); res.writeHead(405); res.end('Method not allowed'); return;
        }
        let route;
        try { route = new URL(req.url, `http://${req.headers.host}`).pathname; }
        catch { res.writeHead(400); res.end('Bad request'); return; }
        const asset = assets.get(route);
        if (!asset) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.bytes.length });
        res.end(req.method === 'HEAD' ? undefined : asset.bytes);
    });
}

function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('tag-tools.js');
    const options = parseArgs(argv);
    const { loadTagCatalog } = require('./lib/tag-catalog');
    const tagCatalog = loadTagCatalog(Config.FILES.tagCatalogFile);
    if (options.command === 'validate') {
        console.log(JSON.stringify({ status: 'valid', version: tagCatalog.version,
            concepts: tagCatalog.concepts.length, facets: tagCatalog.facets.length, registrySha256: tagCatalog.registrySha256 }));
        return;
    }
    const assets = loadAssets({ indexPath: path.join(Config.FILES.tagPreviewDir, 'index.json'),
        assetDir: Config.FILES.tagExplorerAssets, tagCatalog });
    const server = createPreviewServer(assets);
    server.on('error', error => { console.error(`预览服务启动失败：${error.message}`); process.exitCode = 1; });
    server.listen(options.port, '127.0.0.1', () => {
        console.log(`标签预览：http://127.0.0.1:${options.port}/`);
        console.log('此预览只核对已有标签，不会重新给论文分类。按 Ctrl+C 停止。');
    });
    const stop = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return server;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parseArgs, readSafeFile, readPreviewBundle, loadAssets, createPreviewServer, main };

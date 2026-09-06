#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { requireExternalRuntime } = require('./env-loader');
const Config = require('./config');

function parseArgs(args) {
    const [command, ...rest] = args;
    if (!['validate', 'serve'].includes(command)) throw new Error('Use taxonomy:validate or taxonomy:serve [--port 8766]');
    let port = 8766;
    if (rest.length) {
        if (command !== 'serve' || rest.length !== 2 || rest[0] !== '--port'
            || !/^[1-9]\d*$/.test(rest[1])) throw new Error('Only serve --port INTEGER is supported');
        port = Number(rest[1]);
    }
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
    return { command, port };
}

function readSafeFile(filename, limit = 32 * 1024 * 1024) {
    const absolute = path.resolve(filename);
    if (fs.realpathSync(absolute) !== absolute) throw new Error('Preview files must not traverse symlinks');
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Invalid preview asset');
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}

function readPreviewBundle(indexPath, taxonomy) {
    const directory = path.dirname(indexPath);
    const manifestPath = path.join(directory, 'bundle-manifest.json');
    const manifestBytes = readSafeFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    const names = ['index.json', 'migration-report.json', 'tag-disposition.csv'];
    if (manifest.version !== 'paper-taxonomy-preview-bundle-v1'
        || manifest.taxonomyVersion !== taxonomy.version || manifest.registrySha256 !== taxonomy.registrySha256
        || !manifest.files || Object.keys(manifest.files).sort().join(',') !== names.slice().sort().join(',')) {
        throw new Error('Incomplete preview bundle; rerun npm run taxonomy:preview');
    }
    const files = new Map();
    for (const name of names) {
        const bytes = readSafeFile(path.join(directory, name));
        const actual = crypto.createHash('sha256').update(bytes).digest('hex');
        if (actual !== manifest.files[name]) throw new Error(`Preview bundle drift: ${name}; rebuild preview`);
        files.set(name, bytes);
    }
    if (!readSafeFile(manifestPath).equals(manifestBytes)) throw new Error('Preview bundle changed while reading');
    const snapshot = JSON.parse(files.get('index.json'));
    if (snapshot.source?.commit !== manifest.source?.commit
        || snapshot.source?.pagesSha256 !== manifest.source?.pagesSha256
        || !/^[a-f0-9]{40,64}$/.test(String(manifest.source?.commit || ''))
        || !/^[a-f0-9]{64}$/.test(String(manifest.source?.pagesSha256 || ''))) throw new Error('Preview source binding differs');
    return files.get('index.json');
}

function loadAssets({ indexPath, assetDir, taxonomy }) {
    const data = readPreviewBundle(indexPath, taxonomy);
    const snapshot = JSON.parse(data.toString('utf8'));
    if (snapshot.version !== 'paper-taxonomy-preview-v1'
        || snapshot.taxonomyVersion !== taxonomy.version
        || snapshot.registrySha256 !== taxonomy.registrySha256) {
        throw new Error('Preview registry changed; rerun npm run taxonomy:preview');
    }
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
    requireExternalRuntime('taxonomy-tools.js');
    const options = parseArgs(argv);
    const { loadTaxonomy } = require('./lib/paper-taxonomy');
    const taxonomy = loadTaxonomy(Config.FILES.taxonomyRegistry);
    if (options.command === 'validate') {
        console.log(JSON.stringify({ status: 'valid', version: taxonomy.version,
            concepts: taxonomy.concepts.length, facets: taxonomy.facets.length, registrySha256: taxonomy.registrySha256 }));
        return;
    }
    const assets = loadAssets({ indexPath: path.join(Config.FILES.taxonomyPreviewDir, 'index.json'),
        assetDir: Config.FILES.taxonomyExplorerAssets, taxonomy });
    const server = createPreviewServer(assets);
    server.on('error', error => { console.error(`Preview failed: ${error.message}`); process.exitCode = 1; });
    server.listen(options.port, '127.0.0.1', () => {
        console.log(`标签映射预览（不是正式语义重标）: http://127.0.0.1:${options.port}/`);
        console.log('只读快照；按 Ctrl+C 停止。不提供本机AI、下载代办或其他本机助手服务。');
    });
    const stop = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return server;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parseArgs, readSafeFile, readPreviewBundle, loadAssets, createPreviewServer, main };

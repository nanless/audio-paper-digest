'use strict';

// Tests reconstruct saved evidence with the exact retired Git producers.
// Production code imports only the current read-only decoders.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { readGitBlob } = require('../../scripts/lib/git-file-bytes');
const root = path.resolve(__dirname, '../..');
const pins = Object.freeze({
    identity: ['paper-identity', '4d04553ee413fdd367a5f1a58cefe62d41a39c6b', '9b3112b248c0e7f572564e004ef2b994cb44dfafdbf14e58242caa706a1ca080'],
    archive: ['historical-archive-crawl-authority', '787677f1d864b4e0d6eae43ef5e53cb155b93fff', '1a8132b7ee903582315bdf245c1c0aea99b8b0d256c1a8d7b3a61d6c35e8b4b3'],
    local: ['historical-local-crawl-authority', 'dfb3935845f54752c7a914606b663fe906dc2d56', 'c1ecff4143754b8945a583b8491c3765c011cfd9c29241ffbc09fe97b1928c58'],
    conference: ['historical-conference-crawl-authority', '24ebc3f56ea2104259e6fcc3cf9f60807d072cf2', '01a9e47a86a7116279f0c4672192756cdc9c360c90f23e4abeca2f20c9292ac0']
});
const cache = new Map();
function originalCrawlApi(kind) {
    if (cache.has(kind)) return cache.get(kind);
    if (!Object.hasOwn(pins, kind)) throw new Error('unknown original crawler fixture');
    const [name, oid, sha256] = pins[kind];
    const filename = path.join(root, 'scripts/lib', `${name}.js`);
    const instance = new Module(filename, module); instance.filename = filename;
    instance.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = instance.require.bind(instance);
    instance.require = request => {
        if (request === './paper-identity.js') return originalCrawlApi('identity');
        if (request === './historical-archive-crawl-authority.js') return originalCrawlApi('archive');
        return originalRequire(request);
    };
    instance._compile(new TextDecoder('utf-8', { fatal: true }).decode(readGitBlob(root, oid, sha256)), filename);
    cache.set(kind, instance.exports);
    return instance.exports;
}

function savedCrawlFixture(kind, options) {
    const temp = fs.realpathSync(os.tmpdir());
    for (const field of ['identityRoot', 'dataRoot', 'snapshotRoot', 'blogRoot', 'iclrAcceptedRoot']) {
        if (options[field] == null) continue;
        const relative = path.relative(temp, options[field]);
        if (!path.isAbsolute(options[field]) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('original crawler fixture must stay in the system temporary directory');
        }
    }
    const names = { archive: 'Archive', local: 'Local', conference: 'Conference' };
    const writer = originalCrawlApi(kind);
    const result = writer[`prepare${names[kind]}CrawlAuthority`]({ ...options, apply: true });
    const reader = require(path.join(root, 'scripts/lib', `${pins[kind][0]}.js`));
    const authorityHandle = reader[`load${names[kind]}CrawlAuthorityHandle`]({
        ...options, authorityName: result.authorityName
    });
    return { ...result, authorityHandle };
}
module.exports = { originalCrawlApi, savedCrawlFixture };

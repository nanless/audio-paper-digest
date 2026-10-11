'use strict';

// 仅接收调用者继承的私有文件描述符，不读取 env/config，不加载网络或模型模块。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const denyNetwork = () => { throw new Error('作者来源重放只允许本地读取'); };
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:net').connect = denyNetwork;
require('node:net').createConnection = denyNetwork;
require('node:tls').connect = denyNetwork;
for (const module of ['node:http', 'node:https']) {
    require(module).request = denyNetwork; require(module).get = denyNetwork;
}
globalThis.fetch = denyNetwork;
const { readerAuthorIdentityMatchesSource } = require('./reader-author-parser.js');
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
try {
    const raw = process.argv[2];
    if (!/^\d+$/.test(raw || '') || Number(raw) < 3) throw new Error('必须提供私有文件描述符');
    const descriptor = Number(raw);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > MAX_INPUT_BYTES) throw new Error('必须提供大小受限的私有普通文件');
    const input = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    let verified;
    if (input.sealedBundleRoot === undefined) {
        verified = readerAuthorIdentityMatchesSource(input.paper, input.sourceDetails);
    } else {
        const proof = input.paper?.freshRewriteProvenance;
        const sourceRoot = input.sealedBundleRoot;
        const arxivId = String(input.paper?.arxivId || input.paper?.id || '').replace(/v\d+$/, '');
        const stable = value => {
            const canonical = item => Array.isArray(item) ? item.map(canonical)
                : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort()
                    .map(key => [key, canonical(item[key])])) : item;
            return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
        };
        if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)
            || path.basename(sourceRoot) !== 'sources'
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(proof?.runId || ''))
            || path.basename(path.dirname(sourceRoot)) !== proof.runId
            || !/^\d{4}\.\d{4,5}$/.test(arxivId)
            || proof.contract !== 'fresh-source-analysis-v1' || proof.sourceGeneration !== 1
            || proof.sourceOnly !== true || proof.oldGeneratedTextIncluded !== false
            || stable(proof) !== stable(input.paper?.analysisManifest?.freshRewriteProvenance)) {
            throw new Error('作者发布重放的论文、运行目录或来源证明不一致');
        }
        verified = require('./fresh-analysis-context.js').withVerifiedBundleReaderAuthorFiles({
            rootDir: sourceRoot, arxivId, generation: 1,
            sourceManifestSha256: proof.sourceManifestSha256,
            sourceSnapshotSha256: proof.sourceSnapshotSha256
        }, details => {
            const fields = ['text', 'source', 'sourceId', 'imageInfos', 'structuredArtifacts',
                'readerAuthors', 'htmlAvailability', 'htmlAttempts', 'warnings'];
            if (proof.sourceSha256 !== details.freshSourceDescriptor.sourceSha256
                || input.paper.sourceSha256 !== proof.sourceSha256
                || input.paper.analysisManifest?.sourceAcquisition?.sourceSha256 !== proof.sourceSha256
                || fields.some(key => stable(details[key]) !== stable(input.sourceDetails?.[key]))
                || (input.sourceDetails?.title !== undefined && input.sourceDetails.title !== details.title)
                || stable(input.sourceDetails?.sourceVersion || null) !== stable(details.sourceVersion || null)) {
                throw new Error('发布输入与实际封存的作者来源内容不同');
            }
            return readerAuthorIdentityMatchesSource(input.paper, details);
        });
    }
    process.stdout.write(JSON.stringify({ verified }));
} catch (_) {
    process.stdout.write('{"verified":false}');
    process.exitCode = 1;
}

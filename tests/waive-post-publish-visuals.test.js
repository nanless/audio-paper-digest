'use strict';

// digest:waive-visuals 的写入侧。读侧校验（postPublishVisualWaiverIsValid）已有测试，
// 这里只补 run()：它必须先把博客发布凭证核到位，再确认两张清单确实绑定这次远端发布，
// 最后才写豁免。任何一步对不上都不能留下「已豁免」的记录。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const { run, parseArgs, sha256File } = require('../scripts/waive-post-publish-visuals.js');
const { publishedPapersFingerprint } = require('../scripts/lib/published-blog-receipt');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');
const { productionV6GenerationFields, productionV6ReceiptFields } =
    require('./formal-publication-fixture.js');

const DATE = '2026-07-13';
const REASON = '用户确认本批不再补发布后生图，评审记录已留档';

// 独立算一遍，别用被测模块自己的 sha256File 当期望值。
function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function publishedPaper(id) {
    return validAnalysisPaper(id, {
        title: `Published ${id}`,
        fetchedAt: '2026-07-13T10:00:00.000+08:00'
    });
}

function writePublication(directory, papers, commit = 'a'.repeat(40)) {
    const snapshotFingerprint = publishedPapersFingerprint(papers);
    const generation = {
        schemaVersion: 3,
        date: DATE,
        category: '论文速递',
        inputFingerprint: 'c'.repeat(64),
        publishAll: false,
        publishedPapersFingerprintContract: 'typed-json-f64-utf16-v1',
        publishedPapersFingerprint: snapshotFingerprint,
        visualSummaryRequired: false,
        digestCoverRequired: false,
        publishedPapers: papers,
        postPublicationPolicy: require('../scripts/lib/protocol-codec').record('daily-publication-policy', {
            generatedImages: false, sourceFigures: 'retained-and-source-verified'
        }),
        ...productionV6GenerationFields(papers)
    };
    const raw = Buffer.from(JSON.stringify(generation));
    fs.writeFileSync(path.join(directory, `blog-generation-manifest-${DATE}.json`), raw);
    const receipt = {
        schemaVersion: 3,
        date: DATE,
        strictReview: true,
        hugoGate: 'hugo',
        reviewProtocolFingerprint: 'b'.repeat(64),
        generationManifestSha256: crypto.createHash('sha256').update(raw).digest('hex'),
        generationInputIntegrity: 'typed-json-f64-utf16-v1',
        generationInputFingerprint: generation.inputFingerprint,
        publishedPapersFingerprint: snapshotFingerprint,
        publicationCommit: commit,
        remoteVerifiedOid: commit,
        remoteVerifiedAt: '2026-07-14T03:00:00+08:00',
        ...productionV6ReceiptFields(generation),
        postPublishVisuals: 'not_requested'
    };
    fs.writeFileSync(path.join(directory, `blog-review-receipt-${DATE}.json`),
        JSON.stringify(receipt));
    return { receipt, generation, publicationCommit: commit,
        generationManifestSha256: receipt.generationManifestSha256 };
}

function writeManifests(files, publication) {
    fs.mkdirSync(files.visualSummaryManifestDir, { recursive: true });
    fs.mkdirSync(files.digestCoverManifestDir, { recursive: true });
    const binding = {
        publicationCommit: publication.publicationCommit,
        generationManifestSha256: publication.generationManifestSha256
    };
    const visualPath = path.join(files.visualSummaryManifestDir, `${DATE}.json`);
    const coverPath = path.join(files.digestCoverManifestDir, `${DATE}.json`);
    fs.writeFileSync(visualPath, JSON.stringify({ batchDate: DATE, publication: binding }));
    fs.writeFileSync(coverPath, JSON.stringify({ batchDate: DATE, publication: binding }));
    return { visualPath, coverPath };
}

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-waiver-writer-'));
    const files = {
        visualSummaryManifestDir: path.join(directory, 'visual-summary-manifests'),
        digestCoverManifestDir: path.join(directory, 'digest-cover-manifests'),
        postPublishVisualWaiverDir: path.join(directory, 'post-publish-visual-waivers')
    };
    const publication = writePublication(directory, [publishedPaper('2607.00001')]);
    const manifests = writeManifests(files, publication);
    const originals = { currentDir: Config.CURRENT_DIR };
    for (const key of Object.keys(files)) originals[key] = Config.FILES[key];
    Config.CURRENT_DIR = directory;
    for (const key of Object.keys(files)) Config.FILES[key] = files[key];
    const restore = () => {
        Config.CURRENT_DIR = originals.currentDir;
        for (const key of Object.keys(files)) Config.FILES[key] = originals[key];
        fs.rmSync(directory, { recursive: true, force: true });
    };
    return { directory, files, publication, manifests, restore };
}

describe('digest:waive-visuals 写入侧', () => {
    it('凭证绑定当前发布时直接登记不生图，不要求创建图片任务', () => {
        const f = fixture();
        try {
            const payload = run(['--date', DATE, '--reason', REASON]);

            assert.equal('version' in payload, false);
            assert.equal(payload.contract, 'post-publish-visual-waiver');
            assert.match(payload.schemaFingerprint, /^[a-f0-9]{64}$/);
            assert.equal(payload.batchDate, DATE);
            assert.equal(payload.status, 'waived');
            assert.equal(payload.requestedBy, 'user');
            assert.equal(payload.reason, REASON);
            assert.equal(payload.publicationCommit, f.publication.publicationCommit);
            assert.equal(payload.remoteVerifiedOid, f.publication.publicationCommit);
            assert.equal(payload.generationManifestSha256, f.publication.generationManifestSha256);
            assert.equal(payload.reviewReceiptSha256, hashFile(path.join(f.directory, `blog-review-receipt-${DATE}.json`)));
            assert.equal(payload.generatedImages, false);
            assert.equal(payload.sourceFigures, 'retained-and-source-verified');
            assert.equal('visualManifestSha256' in payload, false);
            assert.equal('coverManifestSha256' in payload, false);
            assert.match(payload.waivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);

            const output = path.join(f.files.postPublishVisualWaiverDir, `${DATE}.json`);
            assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), payload);
        } finally {
            f.restore();
        }
    });

    it('旧发布的 required 状态不能由新记录替代原图片清单', () => {
        const f = fixture();
        try {
            const file = path.join(f.directory, `blog-generation-manifest-${DATE}.json`);
            const generation = JSON.parse(fs.readFileSync(file));
            delete generation.postPublicationPolicy;
            fs.writeFileSync(file, JSON.stringify(generation));
            const receiptFile = path.join(f.directory, `blog-review-receipt-${DATE}.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptFile));
            receipt.generationManifestSha256 = hashFile(file);
            receipt.postPublishVisuals = 'required';
            fs.writeFileSync(receiptFile, JSON.stringify(receipt));
            assert.throws(() => run(['--date', DATE, '--reason', REASON]), /不能用新记录替代原图片清单/);
            assert.equal(fs.existsSync(path.join(f.files.postPublishVisualWaiverDir, `${DATE}.json`)), false);
        } finally { f.restore(); }
    });

    it('reason 恰好 10 个字符通过，9 个字符被挡下', () => {
        assert.deepEqual(parseArgs(['--date', DATE, '--reason', '1234567890']),
            { date: DATE, reason: '1234567890' });
        assert.throws(() => parseArgs(['--date', DATE, '--reason', '123456789']),
            /--reason 至少 10 个字符/);
    });

    it('参数未知、重复、缺值和日期非法都拒绝', () => {
        assert.throws(() => parseArgs(['--unknown', 'x']), /未知或重复参数: --unknown/);
        assert.throws(() => parseArgs(['--date', DATE, '--date', DATE]), /未知或重复参数: --date/);
        assert.throws(() => parseArgs(['--date']), /--date 缺少值/);
        assert.throws(() => parseArgs(['--date', DATE, '--reason']), /--reason 缺少值/);
        assert.throws(() => parseArgs(['--date', DATE, '--reason', '--verbose']),
            /--reason 缺少值/);
        assert.throws(() => parseArgs(['--date', '2026-7-13', '--reason', REASON]),
            /--date 非法/);
    });

    it('缺少博客发布凭证时连豁免记录都不写', () => {
        const f = fixture();
        try {
            fs.rmSync(path.join(f.directory, `blog-review-receipt-${DATE}.json`));
            assert.throws(() => run(['--date', DATE, '--reason', REASON]),
                /缺少可验证的博客发布凭证/);
            assert.equal(fs.existsSync(path.join(
                f.files.postPublishVisualWaiverDir, `${DATE}.json`)), false);
        } finally {
            f.restore();
        }
    });

    it('凭证在检查读取后被改写时，视为未与发布记录绑定', () => {
        const f = fixture();
        const receiptPath = path.join(f.directory, `blog-review-receipt-${DATE}.json`);
        const originalRead = fs.readFileSync;
        let reads = 0;
        fs.readFileSync = function (file, ...rest) {
            if (String(file) === receiptPath) {
                reads += 1;
                if (reads >= 2) {
                    const tampered = JSON.parse(originalRead.call(fs, file, ...rest));
                    tampered.publicationCommit = 'f'.repeat(40);
                    return JSON.stringify(tampered);
                }
            }
            return originalRead.call(fs, file, ...rest);
        };
        try {
            assert.throws(() => run(['--date', DATE, '--reason', REASON]),
                /未保留可核验的远端 OID 绑定/);
            assert.equal(fs.existsSync(path.join(
                f.files.postPublishVisualWaiverDir, `${DATE}.json`)), false);
        } finally {
            fs.readFileSync = originalRead;
            f.restore();
        }
    });

    it('没有长图和封面任务也能登记，原有历史任务不参与新记录', () => {
        const f = fixture();
        try {
            fs.rmSync(f.manifests.visualPath);
            fs.rmSync(f.manifests.coverPath);
            const payload = run(['--date', DATE, '--reason', REASON]);
            assert.equal(payload.generatedImages, false);
            assert.equal(fs.existsSync(f.manifests.visualPath), false);
            assert.equal(fs.existsSync(f.manifests.coverPath), false);
        } finally { f.restore(); }
    });
    it('生成快照发生变化后不能沿用旧发布凭证登记', () => {
        const f = fixture();
        try {
            const file = path.join(f.directory, `blog-generation-manifest-${DATE}.json`);
            fs.appendFileSync(file, '\n');
            assert.throws(() => run(['--date', DATE, '--reason', REASON]), /凭证与 generation manifest/);
            assert.equal(fs.existsSync(path.join(f.files.postPublishVisualWaiverDir, `${DATE}.json`)), false);
        } finally { f.restore(); }
    });
});

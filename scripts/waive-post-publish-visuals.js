#!/usr/bin/env node
/** 按用户持续要求，登记本次发布不生成图片。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const { getBeijingISOString, writeFileAtomic } = require('./utils.js');
const { assertPublishedBlogReceipt } = require('./lib/published-blog-receipt');
const formats = require('./lib/protocol-codec');

function parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
        if (flag === '--date' && result.date === undefined) result.date = value;
        else if (flag === '--reason' && result.reason === undefined) result.reason = value;
        else throw new Error(`未知或重复参数: ${flag}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result.date || '')) throw new Error('--date 非法');
    if (String(result.reason || '').trim().length < 10) throw new Error('--reason 至少 10 个字符');
    return result;
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function run(argv = process.argv.slice(2)) {
    const { date, reason } = parseArgs(argv);
    const publication = assertPublishedBlogReceipt(date);
    if (!require('./lib/post-publication-policy').validPublicationPolicy(publication.postPublicationPolicy)
        || publication.postPublishVisuals !== 'not_requested') {
        throw new Error('原发布未声明新的不生图设置，不能用新记录替代原图片清单凭证；须保留原记录或通过正常生成和审查更新发布设置');
    }
    const receiptPath = path.join(Config.CURRENT_DIR, `blog-review-receipt-${date}.json`);
    const receiptRaw = fs.readFileSync(receiptPath);
    const receipt = JSON.parse(receiptRaw.toString('utf8'));
    if (crypto.createHash('sha256').update(receiptRaw).digest('hex') !== publication.reviewReceiptSha256
        || receipt.publicationCommit !== publication.publicationCommit
        || receipt.generationManifestSha256 !== publication.generationManifestSha256
        || receipt.remoteVerifiedOid !== receipt.publicationCommit
        || !receipt.remoteVerifiedAt) {
        throw new Error('博客发布 receipt 未保留可核验的远端 OID 绑定');
    }
    const payload = {
        ...formats.recordHeader('post-publish-visual-waiver', 'post-publish-visual-waiver'),
        batchDate: date,
        status: 'waived',
        requestedBy: 'user',
        reason: reason.trim(),
        waivedAt: getBeijingISOString(),
        publicationCommit: publication.publicationCommit,
        remoteVerifiedOid: receipt.remoteVerifiedOid,
        generationManifestSha256: publication.generationManifestSha256,
        reviewReceiptSha256: publication.reviewReceiptSha256,
        generatedImages: false,
        sourceFigures: 'retained-and-source-verified'
    };
    const output = path.join(Config.FILES.postPublishVisualWaiverDir, `${date}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    writeFileAtomic(output, JSON.stringify(payload, null, 2));
    console.log(`已记录本次发布不生图: ${output}`);
    return payload;
}

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('waive-post-publish-visuals.js');
    try { run(); } catch (error) { console.error(`不生图登记失败: ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, sha256File, run };

#!/usr/bin/env node
/** Record an explicit user waiver for post-publish image generation. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const { getBeijingISOString, writeFileAtomic } = require('./utils.js');
const { assertPublishedBlogReceipt } = require('./visual-summary-state.js');

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
    const receiptPath = path.join(Config.CURRENT_DIR, `blog-review-receipt-${date}.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.publicationCommit !== publication.publicationCommit
        || receipt.generationManifestSha256 !== publication.generationManifestSha256
        || receipt.remoteVerifiedOid !== receipt.publicationCommit
        || !receipt.remoteVerifiedAt) {
        throw new Error('博客发布 receipt 未保留可核验的远端 OID 绑定');
    }
    const visualPath = path.join(Config.FILES.visualSummaryManifestDir, `${date}.json`);
    const coverPath = path.join(Config.FILES.digestCoverManifestDir, `${date}.json`);
    const visual = JSON.parse(fs.readFileSync(visualPath, 'utf8'));
    const cover = JSON.parse(fs.readFileSync(coverPath, 'utf8'));
    for (const [label, manifest] of [['论文长图', visual], ['汇总封面', cover]]) {
        if (manifest?.batchDate !== date
            || manifest?.publication?.publicationCommit !== publication.publicationCommit
            || manifest?.publication?.generationManifestSha256 !== publication.generationManifestSha256) {
            throw new Error(`${label} manifest 未绑定当前远端发布版本`);
        }
    }
    const payload = {
        version: 1,
        batchDate: date,
        status: 'waived',
        requestedBy: 'user',
        reason: reason.trim(),
        waivedAt: getBeijingISOString(),
        publicationCommit: publication.publicationCommit,
        remoteVerifiedOid: receipt.remoteVerifiedOid,
        generationManifestSha256: publication.generationManifestSha256,
        visualManifestSha256: sha256File(visualPath),
        coverManifestSha256: sha256File(coverPath)
    };
    const output = path.join(Config.FILES.postPublishVisualWaiverDir, `${date}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    writeFileAtomic(output, JSON.stringify(payload, null, 2));
    console.log(`已记录发布后视觉豁免: ${output}`);
    return payload;
}

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('waive-post-publish-visuals.js');
    try { run(); } catch (error) { console.error(`视觉豁免失败: ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, sha256File, run };

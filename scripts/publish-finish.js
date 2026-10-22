#!/usr/bin/env node
'use strict';
// push 成功后的收尾清单：提示视觉准备/QA/豁免检查与 digest:status；不调用图像 API、不自动登记豁免。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'data', 'current');

function shaOf(file) { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return null; } }

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('publish-finish.js'); } catch (error) { console.error(`[publish-finish] ${error.message}`); return 1; }

    const date = argv.includes('--date') ? argv[argv.indexOf('--date') + 1] : null;
    if (!date) { console.log('用法: node scripts/publish-finish.js --date YYYY-MM-DD'); return 2; }
    const waiver = path.join(CURRENT, 'post-publish-visual-waivers', `${date}.json`);
    const visualManifest = path.join(CURRENT, 'visual-summary-manifests', `${date}.json`);
    console.log(`发布收尾清单（${date}）：`);
    console.log('1) digest:status：npm run digest:status -- --date ' + date);
    console.log('2) 网页核验：npm run verify:web -- --date ' + date + ' --deploy <OID>');
    if (fs.existsSync(waiver)) {
        try {
            const data = JSON.parse(fs.readFileSync(waiver, 'utf8'));
            const manifestFile = path.join(CURRENT, 'blog-generation-manifest-' + date + '.json');
            const manifestExists = fs.existsSync(manifestFile);
            const manifestSha = manifestExists ? require('node:crypto').createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex') : null;
            const receiptFile = path.join(CURRENT, `blog-review-receipt-${date}.json`);
            const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
            const receiptCommit = receipt && (receipt.publicationCommit || receipt.remoteVerifiedOid || receipt.reviewedCommit) || null;
            const oidPattern = /^[0-9a-f]{40}$/i;
            const oid = data.publicationCommit || data.remoteVerifiedOid || null;
            const webArtifact = path.join(CURRENT, `web-verification-${date}.json`);
            let webOk = false;
            if (fs.existsSync(webArtifact)) {
                try {
                    const web = JSON.parse(fs.readFileSync(webArtifact, 'utf8'));
                    webOk = web.partial !== true && web.deploy && web.deploy.status === 'completed' && web.deploy.conclusion === 'success';
                } catch (_) { webOk = false; }
            }
            const valid = data.status === 'waived' && data.batchDate === date
                && Boolean(manifestSha) && data.generationManifestSha256 === manifestSha
                && oidPattern.test(String(oid || ''))
                && Boolean(receiptCommit) && oid === receiptCommit
                && (!data.visualManifestSha256 || data.visualManifestSha256 === shaOf(path.join(CURRENT, 'visual-summary-manifest-' + date + '.json')))
                && (!data.coverManifestSha256 || data.coverManifestSha256 === shaOf(path.join(CURRENT, 'digest-cover-manifest-' + date + '.json')));
            if (valid) {
                console.log(`3) 视觉：豁免有效且已绑定当前批次（${waiver}）；不要执行视觉:prepare 或生图。`);
                if (!webOk) console.log('   注意：web-verification artifact 缺失或未证明部署成功，最终验收仍需 verify:web --deploy。');
            } else {
                console.log(`3) 视觉：豁免文件存在但与当前批次不匹配（${waiver}）；请核对 status/batchDate/清单 SHA/发布 OID/审查凭证，不要直接跳过。`);
                process.exitCode = 1;
            }
        } catch (error) {
            console.log(`3) 视觉：豁免文件无法读取（${error.message}）；按未豁免处理。`);
        }
    } else {
        console.log('3) 视觉：若上次 push 提示规划失败，先 npm run visual:post-publish -- --date ' + date + ' 重规划；成功后 npm run visual:prepare -- --date ' + date + '，把绝对 referencedImagePaths 交给生图工具；逐图 QA 后 record --qa-attested true。');
        if (fs.existsSync(visualManifest)) console.log(`   已有视觉清单：${visualManifest}`);
    }
    console.log('4) 完成后重新运行 digest:status，并以部署/网页核验结果作为最终验收。');
    return 0;
}

module.exports = { main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[publish-finish] ${error.message}`); process.exitCode = 1; }
}

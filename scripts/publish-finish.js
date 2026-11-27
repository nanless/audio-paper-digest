#!/usr/bin/env node
'use strict';
// push 成功后的收尾清单：提示日更不生图登记与最终核验；不调用图像 API、不自动登记豁免。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'data', 'current');

const { validNoGenerationRecord: validateWaiver } = require('./lib/post-publication-policy');


function visualManifestPath(date, currentDir = CURRENT) { return path.join(currentDir, 'visual-summary-manifests', `${date}.json`); }
function coverManifestPath(date, currentDir = CURRENT) { return path.join(currentDir, 'digest-cover-manifests', `${date}.json`); }

function shaOf(file) { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return null; } }

function isValidCalendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(part => Number.parseInt(part, 10));
    const dt = new Date(Date.UTC(year, month - 1, day));
    return dt.getUTCFullYear() === year
        && dt.getUTCMonth() === month - 1
        && dt.getUTCDate() === day;
}

function parseDateArg(argv = []) {
    if (!Array.isArray(argv)) return null;
    let date = null;
    const idx = argv.indexOf('--date');
    if (idx !== -1) {
        date = argv[idx + 1] ?? null;
    } else {
        const inline = argv.find(arg => typeof arg === 'string' && arg.startsWith('--date='));
        if (inline) date = inline.slice('--date='.length);
    }
    if (typeof date !== 'string' || !date || date.startsWith('-') || !isValidCalendarDate(date)) {
        return null;
    }
    return date;
}

const OID_RE = /^[0-9a-f]{40}$/i;

function normalizeOid(value) {
    return typeof value === 'string' && OID_RE.test(value) ? value.toLowerCase() : null;
}

function readVerifiedDailyWebArtifact({ date, currentDir = CURRENT, manifestSha, receiptCommit } = {}) {
    const artifactFile = path.join(currentDir, `web-verification-${date}.json`);
    if (!date || !fs.existsSync(artifactFile)) {
        return { verified: false, artifactPath: artifactFile, reason: 'missing' };
    }
    try {
        const web = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
        const normalizedReceiptCommit = normalizeOid(receiptCommit);
        const normalizedWebOid = normalizeOid(web.publicationOid);
        const deploy = web.deploy && typeof web.deploy === 'object' ? web.deploy : null;
        const countsValid = (web.failed === undefined || web.failed === 0)
            && (web.checked === undefined || (Number.isInteger(web.checked) && web.checked > 0))
            && (web.ok === undefined || web.checked === undefined || web.ok === web.checked);
        const verified = require('./verify-web').hasVerificationArtifactFormat(web)
            && web.date === date
            && Boolean(normalizedReceiptCommit)
            && normalizedWebOid === normalizedReceiptCommit
            && Boolean(manifestSha)
            && web.generationManifestSha256 === manifestSha
            && web.partial === false
            && deploy?.status === 'completed'
            && deploy?.conclusion === 'success'
            && deploy?.jobVerified !== false
            && countsValid;
        if (!verified) {
            return { verified: false, artifactPath: artifactFile, reason: 'mismatch' };
        }
        return {
            verified: true,
            artifactPath: artifactFile,
            date,
            publicationOid: normalizedWebOid,
            deployOid: normalizeOid(web.deployOid) || normalizeOid(deploy?.oid) || normalizedWebOid,
            deployStatus: deploy.status,
            deployConclusion: deploy.conclusion,
            expected: Number.isInteger(web.expected) ? web.expected : null,
            checked: Number.isInteger(web.checked) ? web.checked : null,
            ok: Number.isInteger(web.ok) ? web.ok : null,
            failed: Number.isInteger(web.failed) ? web.failed : 0,
            verifiedAt: web.verifiedAt || web.createdAt || null
        };
    } catch (_) {
        return { verified: false, artifactPath: artifactFile, reason: 'invalid' };
    }
}

function main(argv = process.argv.slice(2), options = {}) {
    try { require('./env-loader').requireExternalRuntime('publish-finish.js'); } catch (error) { console.error(`[publish-finish] ${error.message}`); return 1; }

    const date = parseDateArg(argv);
    if (!date) { console.log('用法: node scripts/publish-finish.js --date YYYY-MM-DD'); return 2; }
    const currentDir = options.currentDir || CURRENT;
    const waiver = path.join(currentDir, 'post-publish-visual-waivers', `${date}.json`);
    const visualManifest = path.join(currentDir, 'visual-summary-manifests', `${date}.json`);
    console.log(`发布收尾清单（${date}）：`);
    console.log('1) digest:status：npm run digest:status -- --date ' + date);
    console.log('2) 网页核验：npm run verify:web -- --date ' + date + ' --deploy <OID>');
    if (fs.existsSync(waiver)) {
        try {
            const data = JSON.parse(fs.readFileSync(waiver, 'utf8'));
            const manifestFile = path.join(currentDir, 'blog-generation-manifest-' + date + '.json');
            const manifestExists = fs.existsSync(manifestFile);
            const manifestSha = manifestExists ? require('node:crypto').createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex') : null;
            const receiptFile = path.join(currentDir, `blog-review-receipt-${date}.json`);
            const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
            const receiptCommit = receipt && (receipt.publicationCommit || receipt.remoteVerifiedOid) || null;
            const webCheck = readVerifiedDailyWebArtifact({ date, currentDir, manifestSha, receiptCommit });
            const webOk = webCheck.verified;
            const visualSha = shaOf(visualManifestPath(date, currentDir));
            const coverSha = shaOf(coverManifestPath(date, currentDir));
            const valid = validateWaiver(data, { date, manifestSha, receiptCommit, receiptSha: shaOf(receiptFile),
                publicationPolicy: manifestExists ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')).postPublicationPolicy : null,
                postPublishVisuals: receipt?.postPublishVisuals, remoteVerifiedOid: receipt?.remoteVerifiedOid, visualSha, coverSha });
            if (valid) {
                console.log(`3) 视觉：豁免有效且已绑定当前批次（${waiver}）；无需再创建长图或封面任务。`);
                if (!webOk) console.log('   注意：web-verification artifact 缺失或未证明部署成功，最终验收仍需 verify:web --deploy。');
            } else {
                console.log(`3) 视觉：豁免文件存在但与当前批次不匹配（${waiver}）；请核对 status/batchDate/清单 SHA/发布 OID/审查凭证，不要直接跳过。`);
                return 1;
            }
        } catch (error) {
            console.log(`3) 视觉：豁免文件无法读取（${error.message}）；按未豁免处理。`);
            return 1;
        }
    } else {
        console.log('3) 日更默认不生图：运行 npm run digest:waive-visuals -- --date ' + date + ' --reason "用户已明确要求以后日更不再生图，本次发布沿用该持续设置。"。');
        if (fs.existsSync(visualManifest)) console.log(`   已有视觉清单：${visualManifest}`);
    }
    console.log('4) 完成后重新运行 digest:status，并以部署/网页核验结果作为最终验收。');
    return 0;
}

module.exports = { validateWaiver, visualManifestPath, coverManifestPath, readVerifiedDailyWebArtifact, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[publish-finish] ${error.message}`); process.exitCode = 1; }
}

#!/usr/bin/env node
'use strict';

/**
 * Promote one independently reviewed fresh-paper revision into the only path
 * accepted by the v5 tutorial assembler.  This is a byte-for-byte promotion,
 * never a prose rewrite.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (require.main === module) {
    require('../../scripts/env-loader.js').requireExternalRuntime('manual-v5-promote-draft.js');
}

const Config = require('../../scripts/config.js');
const { normalizedId, writeFileAtomic } = require('../../scripts/utils.js');
const { validateAuthorPacket } = require('./manual-v5-author-packet.js');

const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(filePath, label) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`${label} 不是可读 JSON: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 顶层必须是对象`);
    }
    return value;
}

function ordinaryFile(filePath, label) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()
        || fs.lstatSync(resolved).isSymbolicLink()) {
        throw new Error(`${label} 必须是存在的普通文件且不能是符号链接`);
    }
    return resolved;
}

function confinedPath(root, candidate, label) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${label} 必须位于 ${resolvedRoot} 内`);
    }
    return resolved;
}

function reviewPaperId(review) {
    return normalizedId(review.paperId || review.paper?.arxivId);
}

function validateReview(reviewPath, paperId, articleSha256, label) {
    const resolved = ordinaryFile(reviewPath, label);
    const bytes = fs.readFileSync(resolved);
    const review = readJson(resolved, label);
    if (reviewPaperId(review) !== paperId || review.passed !== true
        || !Array.isArray(review.blockers) || review.blockers.length !== 0) {
        throw new Error(`${label} 必须明确通过、属于 ${paperId} 且没有 blocker`);
    }
    const serialized = JSON.stringify(review);
    if (!serialized.includes(articleSha256)) {
        throw new Error(`${label} 没有绑定当前 revision article SHA-256`);
    }
    const provenance = review.provenance || review.reviewProvenance || {};
    const model = provenance.model || provenance.reviewerModel || '';
    const effort = provenance.reasoningEffort || provenance.reasoning_effort || '';
    if (model !== 'gpt-5.6-terra' || effort !== 'high') {
        throw new Error(`${label} 必须由 gpt-5.6-terra/high 独立 leaf 完成`);
    }
    return { path: resolved, sha256: sha256(bytes), taskName: provenance.taskName || null };
}

function validateAuthorAuthority(
    authorRecord, packetPath, date, paperId, validator = validateAuthorPacket,
    currentDir = Config.CURRENT_DIR
) {
    const resolvedPacketPath = ordinaryFile(packetPath, 'author packet');
    const packet = readJson(resolvedPacketPath, 'author packet');
    validator(packet, { currentDir, requireMaterialized: true });
    if (packet.date !== date || normalizedId(packet.paperId) !== paperId
        || packet.mode !== 'fresh_from_evidence' || packet.singlePaperOnly !== true
        || packet.isolatedContext !== true || packet.requiredModel !== 'gpt-5.6-terra'
        || packet.requiredReasoningEffort !== 'high') {
        throw new Error('author packet 日期、论文、隔离或 Terra/high 约束非法');
    }
    const source = authorRecord.sourceIdentity || {};
    if (source.authorPacketSha256 !== packet.packetSha256
        || source.fullTextSha256 !== packet.sourceEntry?.sourceSha256
        || source.artifactIndexSha256 !== packet.artifactEntry?.outputSha256
        || source.paperSourceIdentitySha256 !== packet.sourceIdentitySha256) {
        throw new Error('revision author record 未绑定当前 author packet/全文/ArtifactIndex 身份');
    }
    const inputs = authorRecord.freshAuthoring?.inputs;
    if (!Array.isArray(inputs)) throw new Error('revision freshAuthoring.inputs 必须是数组');
    const actual = new Map();
    for (const [index, item] of inputs.entries()) {
        if (!item || typeof item !== 'object' || !item.kind || actual.has(item.kind)) {
            throw new Error(`revision freshAuthoring.inputs[${index}] 非法或重复`);
        }
        actual.set(item.kind, item);
    }
    const allowed = new Map(packet.allowedInputs.map(item => [item.kind, item]));
    for (const [kind, expected] of allowed) {
        const item = actual.get(kind);
        if (!item || typeof item.path !== 'string' || !item.path
            || ordinaryFile(item.path, `revision authority ${kind}`) !== path.resolve(expected.path)
            || item.sha256 !== expected.sha256) {
            throw new Error(`revision authority ${kind} 未精确绑定 author packet allowlist`);
        }
    }
    const feedbackKinds = new Set(['technical_review_findings', 'pedagogy_review_findings']);
    for (const [kind, item] of actual) {
        if (allowed.has(kind)) continue;
        if (!feedbackKinds.has(kind)) {
            throw new Error(`revision freshAuthoring.inputs 含未授权 kind=${kind}`);
        }
        const feedbackPath = confinedPath(
            path.join(currentDir, 'manual-tutorial-previews', date, paperId, 'reviews'),
            item.path, `revision feedback ${kind}`
        );
        const resolved = ordinaryFile(feedbackPath, `revision feedback ${kind}`);
        if (!SHA256_RE.test(String(item.sha256 || ''))
            || item.sha256 !== sha256(fs.readFileSync(resolved))) {
            throw new Error(`revision feedback ${kind} 缺少真实文件 SHA`);
        }
    }
    if (actual.size !== allowed.size + feedbackKinds.size
        || [...feedbackKinds].some(kind => !actual.has(kind))) {
        throw new Error('revision inputs 必须精确包含权威输入与两类独立 review findings');
    }
    return { path: resolvedPacketPath, sha256: sha256(fs.readFileSync(resolvedPacketPath)) };
}

function promoteManualV5Draft(options) {
    const date = String(options.date || '');
    const paperId = normalizedId(options.paperId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !paperId) {
        throw new Error('date/paperId 非法');
    }
    const previewRoot = path.resolve(options.previewRoot
        || path.join(Config.CURRENT_DIR, 'manual-tutorial-previews'));
    const paperRoot = path.join(previewRoot, date, paperId);
    const sourceRoot = confinedPath(paperRoot, options.sourceDir, 'sourceDir');
    const articlePath = ordinaryFile(path.join(sourceRoot, 'article.md'), 'revision article');
    const authorRecordPath = ordinaryFile(path.join(sourceRoot, 'author-record.json'), 'revision author record');
    const selfCheckPath = ordinaryFile(path.join(sourceRoot, 'author-self-check.json'), 'revision self check');
    const researchBriefPath = ordinaryFile(path.join(sourceRoot, 'research-brief.json'), 'revision research brief');
    const articleBytes = fs.readFileSync(articlePath);
    const articleSha256 = sha256(articleBytes);
    const authorRecord = readJson(authorRecordPath, 'revision author record');
    const selfCheck = readJson(selfCheckPath, 'revision self check');
    if (normalizedId(authorRecord.paperId) !== paperId || normalizedId(selfCheck.paperId) !== paperId
        || authorRecord.article?.sha256 !== articleSha256 || selfCheck.articleSha256 !== articleSha256) {
        throw new Error('revision 四件套没有绑定同一论文和 article SHA-256');
    }
    if (authorRecord.mode !== 'fresh_from_evidence'
        || authorRecord.freshAuthoring?.contract !== 'fresh-authoring-v1'
        || !Array.isArray(authorRecord.freshAuthoring?.prohibitedProseInputs)
        || authorRecord.freshAuthoring.prohibitedProseInputs.length !== 0) {
        throw new Error('revision author record 不是隔离的 fresh-authoring-v1');
    }
    const packetPath = options.authorPacketPath || path.join(
        Config.CURRENT_DIR, 'manual-v5-author-inputs', date, paperId, 'packet.json'
    );
    const authorPacket = validateAuthorAuthority(
        authorRecord, packetPath, date, paperId, options.authorPacketValidator,
        options.currentDir || Config.CURRENT_DIR
    );

    const reviews = {
        technical: validateReview(options.technicalReview, paperId, articleSha256, 'technical review'),
        readability: validateReview(options.readabilityReview, paperId, articleSha256, 'readability review'),
        figures: validateReview(options.figureReview, paperId, articleSha256, 'figure review')
    };
    if (reviews.technical.taskName && reviews.technical.taskName === reviews.readability.taskName) {
        throw new Error('technical/readability review 必须由不同 task 完成');
    }

    const draftDir = path.join(paperRoot, 'draft');
    fs.mkdirSync(draftDir, { recursive: true });
    const destination = path.join(draftDir, 'article.md');
    writeFileAtomic(destination, articleBytes);
    const receipt = {
        version: 1,
        contract: 'manual-v5-reviewed-draft-promotion-v1',
        date,
        paperId,
        source: {
            articlePath,
            articleSha256,
            authorRecord: { path: authorRecordPath, sha256: sha256(fs.readFileSync(authorRecordPath)) },
            selfCheck: { path: selfCheckPath, sha256: sha256(fs.readFileSync(selfCheckPath)) },
            researchBrief: { path: researchBriefPath, sha256: sha256(fs.readFileSync(researchBriefPath)) }
        },
        authorPacket,
        reviews,
        output: { path: destination, sha256: sha256(fs.readFileSync(destination)) },
        byteForByte: fs.readFileSync(destination).equals(articleBytes),
        oldPublishedProseRead: false
    };
    if (!receipt.byteForByte || receipt.output.sha256 !== articleSha256) {
        throw new Error('draft promotion 不是 byte-for-byte，已拒绝');
    }
    receipt.receiptSha256 = sha256(Buffer.from(JSON.stringify(receipt)));
    const receiptPath = path.join(paperRoot, 'draft-promotion.json');
    writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return { destination, receiptPath, receipt };
}

function parseArgs(argv) {
    const options = {};
    const flags = new Map([
        ['--date', 'date'], ['--paper-id', 'paperId'], ['--source-dir', 'sourceDir'],
        ['--technical-review', 'technicalReview'], ['--readability-review', 'readabilityReview'],
        ['--figure-review', 'figureReview'], ['--author-packet', 'authorPacketPath']
    ]);
    for (let index = 0; index < argv.length; index++) {
        const key = flags.get(argv[index]);
        if (!key || options[key]) throw new Error(`未知或重复参数: ${argv[index]}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${argv[index - 1]} 缺少值`);
        options[key] = value;
    }
    for (const [flag, key] of flags) {
        if (key !== 'authorPacketPath' && !options[key]) throw new Error(`缺少 ${flag}`);
    }
    return options;
}

if (require.main === module) {
    try {
        const result = promoteManualV5Draft(parseArgs(process.argv.slice(2)));
        console.log(`✅ fresh draft 已按审查 SHA 提升：${result.destination}`);
        console.log(`   receipt: ${result.receiptPath}`);
    } catch (error) {
        console.error(`❌ ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { promoteManualV5Draft, validateReview, validateAuthorAuthority, parseArgs };

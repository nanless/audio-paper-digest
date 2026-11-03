'use strict';
// 退役成图的只读核验；不创建任务、不取图、不写资产。原数值仅用于重放旧记录。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../config');
const originalFormat = require('../../config/historical-visual-formats.json');
const { normalizedId } = require('../utils');

const { sha256Buffer, stableJson, stableSha256, validateDate, paperBatchDate, validatePublishImageExclusions } = require('./published-blog-receipt');
const { promptFilePathForContract } = require('./prompt-contracts');
const { historicalPromptEvidenceBytesForSha256 } = require('./prompt-evidence');
const { validatePngBuffer, assertSafeAssetTarget, bindPublishedPapersToDate, RENDERING_CONTRACT, DEFAULT_SELECTION_LIMIT } = require('./historical-visual-records');
const COVER_MANIFEST_FORMAT = originalFormat.coverManifestVersion;
const COVER_QA_CHECKLIST = originalFormat.coverQaChecklist;
const COVER_RANKING_LIMIT = DEFAULT_SELECTION_LIMIT;
const DIGEST_COVER_PROMPT_STAGE = 'digestCover';

function resolvedPromptSha256(declaredSha256, promptPath = null, declaration = null) {
    const declared = String(declaredSha256 || '');
    if (promptPath) return sha256Buffer(fs.readFileSync(promptPath));
    const relativePath = promptFilePathForContract(DIGEST_COVER_PROMPT_STAGE, declaration);
    const raw = historicalPromptEvidenceBytesForSha256(declared, { relativePath });
    if (!raw) throw new Error('退役成图提示词没有匹配的原始 Git 字节');
    return sha256Buffer(raw);
}

function digestTitle(targetDate, category = '论文速递') {
    return category === 'icml-2026'
        ? 'ICML 2026 论文速递'
        : `语音/音乐/音频论文速递 ${targetDate}`;
}

function buildCoverContext(papers, targetDate, category = '论文速递') {
    const tagCounts = new Map();
    const scored = [];
    for (const paper of papers) {
        const parsed = paper.parsed || {};
        const tag = String(parsed.primaryTaskTag || parsed.tags?.[0] || '').trim();
        if (tag) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        const score = Number(parsed.score);
        if (Number.isFinite(score)) {
            scored.push({
                arxivId: normalizedId(paper),
                title: String(paper.title || ''),
                score: String(parsed.score),
                primaryTask: tag || '-'
            });
        }
    }
    const hotDirections = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)))
        .slice(0, 8)
        .map(([tag, count]) => ({ tag, count }));
    const ranking = scored
        .sort((a, b) => b.score - a.score
            || (a.arxivId < b.arxivId ? -1 : a.arxivId > b.arxivId ? 1 : 0))
        .slice(0, COVER_RANKING_LIMIT)
        .map((item, index) => ({ rank: index + 1, ...item }));
    return {
        title: digestTitle(targetDate, category),
        batchDate: targetDate,
        paperCount: papers.length,
        hotDirections,
        rankingCount: ranking.length,
        rankingLimit: COVER_RANKING_LIMIT,
        ranking,
        rendering: RENDERING_CONTRACT
    };
}

function coverDataSha256(context) {
    return stableSha256(context);
}

function coverTaskToken(dataSha256, expectedPromptSha, publication = null) {
    return stableSha256({
        manifestVersion: COVER_MANIFEST_FORMAT,
        kind: 'digest-cover',
        dataSha256,
        promptSha256: expectedPromptSha,
        publicationCommit: publication?.publicationCommit || null,
        generationManifestSha256: publication?.generationManifestSha256 || null
    });
}

function validateCompletedCover(cover, dataSha256, expectedPromptSha, expectedToken) {
    if (!cover || cover.status !== 'complete') return false;
    if (cover.qaAttestation?.attested !== true
        || cover.qaAttestation?.checklistVersion !== COVER_QA_CHECKLIST
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00$/.test(
            String(cover.qaAttestation?.attestedAt || '')
        )) return false;
    if (cover.dataSha256 !== dataSha256 || cover.promptSha256 !== expectedPromptSha || cover.taskToken !== expectedToken) return false;
    const expected = digestCoverAssetPath(cover.batchDate || '');
    const actual = path.resolve(Config.PROJECT_ROOT, String(cover.assetPath || ''));
    if (actual !== expected) return false;
    let descriptor;
    try {
        assertSafeAssetTarget(actual, Config.FILES.digestCoverAssetDir);
        descriptor = fs.openSync(actual, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const before = fs.fstatSync(descriptor);
        if (!before.isFile() || before.size > RENDERING_CONTRACT.maxPngBytes) return false;
        const raw = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < raw.length) {
            const read = fs.readSync(descriptor, raw, length, raw.length - length, length);
            if (read === 0) break;
            length += read;
        }
        const after = fs.fstatSync(descriptor);
        assertSafeAssetTarget(actual, Config.FILES.digestCoverAssetDir);
        const named = fs.lstatSync(actual);
        if (!named.isFile() || length !== before.size
            || [after, named].some(stat => stat.dev !== before.dev || stat.ino !== before.ino
                || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs
                || stat.ctimeMs !== before.ctimeMs)) return false;
        const bytes = raw.subarray(0, length);
        validatePngBuffer(bytes);
        return sha256Buffer(bytes) === cover.assetSha256;
    } catch (_error) {
        return false;
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function digestCoverAssetPath(targetDate) {
    const date = validateDate(targetDate);
    return path.resolve(
        Config.FILES.digestCoverAssetDir,
        date,
        'visual-summaries',
        `00-digest-cover-${date}.png`
    );
}

function assertDigestCoverManifestCurrent(manifest, publication, targetDate, promptPath = null) {
    targetDate = validateDate(targetDate);
    if (!manifest || manifest.version !== COVER_MANIFEST_FORMAT || manifest.batchDate !== targetDate
        || manifest.publication?.publicationCommit !== publication.publicationCommit
        || manifest.publication?.generationManifestSha256 !== publication.generationManifestSha256) {
        throw new Error('汇总图 manifest 与当前已发布博客版本不一致，请重新执行发布后规划');
    }
    const papers = bindPublishedPapersToDate(publication, targetDate);
    const context = buildCoverContext(papers, targetDate, publication.category);
    const expectedPromptSha = resolvedPromptSha256(
        manifest.promptSha256, promptPath, manifest.promptTextContract);
    const expectedDataSha = coverDataSha256(context);
    const expectedToken = coverTaskToken(expectedDataSha, expectedPromptSha, publication);
    if (manifest.promptSha256 !== expectedPromptSha || manifest.dataSha256 !== expectedDataSha
        || stableSha256(manifest.generationContext) !== stableSha256(context)
        || !manifest.cover || manifest.cover.taskToken !== expectedToken
        || manifest.cover.promptSha256 !== expectedPromptSha
        || manifest.cover.dataSha256 !== expectedDataSha) {
        throw new Error('汇总图论文集合、上下文或 prompt 已失效，请重新执行发布后规划');
    }
    return { context, expectedPromptSha, expectedDataSha, expectedToken };
}

module.exports = { assertDigestCoverManifestCurrent, coverTaskToken, validateCompletedCover };

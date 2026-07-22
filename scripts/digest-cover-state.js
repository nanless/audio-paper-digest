#!/usr/bin/env node
'use strict';

/**
 * 全部博客发布后的每日论文速递汇总图状态管理。
 *
 * 本脚本只根据已审计分析建立可恢复任务、验证并登记 Codex 内置
 * image_gen 产出的 PNG；绝不调用图片 API。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const { getBeijingISOString, normalizedId } = require('./utils.js');
const { updateJsonFileLocked, readJsonFileStrict, isSuccessfulAnalysisRecord } = require('./analysis-engine.js');
const {
    validatePngBuffer, extractGeneratedImagePathFromHint, paperBatchDate, validateDate,
    assertPublishedBlogReceipt, bindPublishedPapersToDate, assertSafeAssetTarget,
    RENDERING_CONTRACT, DEFAULT_SELECTION_LIMIT
} = require('./visual-summary-state.js');

const COVER_MANIFEST_VERSION = 1;
const COVER_RANKING_LIMIT = DEFAULT_SELECTION_LIMIT;

function sha256Buffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
    }
    return value;
}

function stableSha256(value) {
    return sha256Buffer(Buffer.from(JSON.stringify(stableJson(value)), 'utf8'));
}

function digestCoverManifestPath(targetDate) {
    return path.join(Config.FILES.digestCoverManifestDir, `${validateDate(targetDate)}.json`);
}

function digestCoverPromptPath() {
    return path.join(Config.PROJECT_ROOT, 'prompts', 'digest-cover.md');
}

function promptSha256(promptPath = digestCoverPromptPath()) {
    return sha256Buffer(fs.readFileSync(promptPath));
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
        manifestVersion: COVER_MANIFEST_VERSION,
        kind: 'digest-cover',
        dataSha256,
        promptSha256: expectedPromptSha,
        publicationCommit: publication?.publicationCommit || null,
        generationManifestSha256: publication?.generationManifestSha256 || null
    });
}

function validateCompletedCover(cover, dataSha256, expectedPromptSha, expectedToken) {
    if (!cover || cover.status !== 'complete') return false;
    if (cover.dataSha256 !== dataSha256 || cover.promptSha256 !== expectedPromptSha || cover.taskToken !== expectedToken) return false;
    const expected = digestCoverAssetPath(cover.batchDate || '');
    const actual = path.resolve(Config.PROJECT_ROOT, String(cover.assetPath || ''));
    if (actual !== expected) return false;
    try {
        const raw = fs.readFileSync(actual);
        validatePngBuffer(raw);
        return sha256Buffer(raw) === cover.assetSha256;
    } catch (_error) {
        return false;
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

function removeEmptyDirectory(directory) {
    if (!fs.existsSync(directory)) return;
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function migrateLegacyCompletedCover(cover, dataSha256, expectedPromptSha, expectedToken, legacyToken, targetDate) {
    if (!cover || cover.status !== 'complete'
        || cover.dataSha256 !== dataSha256
        || cover.promptSha256 !== expectedPromptSha
        || ![expectedToken, legacyToken].includes(cover.taskToken)
        || !/^[0-9a-f]{64}$/.test(String(cover.assetSha256 || ''))) {
        return cover;
    }
    const target = digestCoverAssetPath(targetDate);
    const legacy = path.resolve(Config.CURRENT_DIR, 'digest-covers', targetDate, 'cover.png');
    const oldArchive = path.resolve(
        Config.FILES.digestCoverAssetDir, targetDate, 'digest-cover', 'cover.png'
    );
    removeEmptyDirectory(path.dirname(legacy));
    removeEmptyDirectory(path.dirname(oldArchive));
    if (validateCompletedCover(cover, dataSha256, expectedPromptSha, expectedToken)) return cover;
    const recorded = path.resolve(Config.PROJECT_ROOT, String(cover.assetPath || ''));
    if (![legacy, oldArchive, target].includes(recorded)) return cover;
    const source = [legacy, oldArchive, target].find(candidate => fs.existsSync(candidate)) || null;
    if (!source) return cover;
    const raw = fs.readFileSync(source);
    validatePngBuffer(raw);
    if (sha256Buffer(raw) !== cover.assetSha256) return cover;

    assertSafeAssetTarget(target, Config.FILES.digestCoverAssetDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (source !== target) {
        const oldParent = path.dirname(source);
        if (fs.existsSync(target)) {
            const existing = fs.readFileSync(target);
            validatePngBuffer(existing);
            if (sha256Buffer(existing) !== cover.assetSha256) {
                throw new Error(`汇总封面归档目标已存在但内容不一致: ${target}`);
            }
            fs.unlinkSync(source);
        } else {
            fs.renameSync(source, target);
        }
        removeEmptyDirectory(oldParent);
    }
    return {
        ...cover,
        taskToken: expectedToken,
        assetPath: path.relative(Config.PROJECT_ROOT, target).split(path.sep).join('/'),
        archivedAt: cover.archivedAt || getBeijingISOString()
    };
}

function archiveLegacyDigestCover({ targetDate, manifestPath } = {}) {
    targetDate = validateDate(targetDate);
    manifestPath = manifestPath || digestCoverManifestPath(targetDate);
    return updateJsonFileLocked(manifestPath, current => {
        const cover = current?.cover;
        if (!current || current.batchDate !== targetDate || cover?.status !== 'complete'
            || !/^[0-9a-f]{64}$/.test(String(cover.assetSha256 || ''))) {
            throw new Error(`汇总封面 manifest 未完成或日期不匹配: ${manifestPath}`);
        }
        const legacy = path.resolve(Config.CURRENT_DIR, 'digest-covers', targetDate, 'cover.png');
        const oldArchive = path.resolve(
            Config.FILES.digestCoverAssetDir, targetDate, 'digest-cover', 'cover.png'
        );
        const target = digestCoverAssetPath(targetDate);
        const recorded = path.resolve(Config.PROJECT_ROOT, String(cover.assetPath || ''));
        if (![legacy, oldArchive, target].includes(recorded)) throw new Error(`历史汇总封面路径不受控: ${cover.assetPath}`);
        const source = [legacy, oldArchive, target].find(candidate => fs.existsSync(candidate)) || null;
        if (!source || !fs.statSync(source).isFile()) throw new Error(`历史汇总封面缺失: ${targetDate}`);
        const raw = fs.readFileSync(source);
        validatePngBuffer(raw);
        if (sha256Buffer(raw) !== cover.assetSha256) throw new Error(`历史汇总封面 SHA 不匹配: ${targetDate}`);
        assertSafeAssetTarget(target, Config.FILES.digestCoverAssetDir);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (source !== target) {
            if (fs.existsSync(target)) {
                const existing = fs.readFileSync(target);
                validatePngBuffer(existing);
                if (sha256Buffer(existing) !== cover.assetSha256) throw new Error(`历史汇总封面归档目标冲突: ${target}`);
                fs.unlinkSync(source);
            } else {
                fs.renameSync(source, target);
            }
        }
        const now = getBeijingISOString();
        return {
            ...current,
            updatedAt: now,
            cover: {
                ...cover,
                assetPath: path.relative(Config.PROJECT_ROOT, target).split(path.sep).join('/'),
                archivedAt: cover.archivedAt || now
            }
        };
    }, { allowMissing: false });
}

function assertDigestCoverManifestCurrent(manifest, publication, targetDate, promptPath = null) {
    targetDate = validateDate(targetDate);
    if (!manifest || manifest.version !== COVER_MANIFEST_VERSION || manifest.batchDate !== targetDate
        || manifest.publication?.publicationCommit !== publication.publicationCommit
        || manifest.publication?.generationManifestSha256 !== publication.generationManifestSha256) {
        throw new Error('汇总图 manifest 与当前已发布博客版本不一致，请重新执行发布后规划');
    }
    const papers = bindPublishedPapersToDate(publication, targetDate);
    const context = buildCoverContext(papers, targetDate, publication.category);
    const expectedPromptSha = promptSha256(promptPath || undefined);
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

function planDigestCover({ targetDate, papers, manifestPath, promptPath, category = '论文速递', publication = null } = {}) {
    targetDate = validateDate(targetDate);
    if (!publication
        || !/^[0-9a-f]{40,64}$/i.test(String(publication.publicationCommit || ''))
        || !/^[0-9a-f]{64}$/i.test(String(publication.generationManifestSha256 || ''))) {
        throw new Error('汇总图只能绑定远端已验证的博客发布版本后规划');
    }
    manifestPath = manifestPath || digestCoverManifestPath(targetDate);
    const selected = papers.filter(paper => paperBatchDate(paper) === targetDate);
    const eligible = selected.filter(paper => isSuccessfulAnalysisRecord(paper) && !paper.latestAnalysisAttemptError);
    if (eligible.length === 0) throw new Error(`批次 ${targetDate} 没有可用的已审计论文，无法生成汇总封面`);
    if (eligible.length !== selected.length) {
        throw new Error(`批次 ${targetDate} 尚有未完成或最新尝试失败的深度分析，禁止建立发布后汇总图`);
    }
    const ids = eligible.map(normalizedId);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
        throw new Error('汇总封面论文集合包含空或重复的规范化 arXiv ID');
    }
    const context = buildCoverContext(eligible, targetDate, category);
    const currentPromptSha = promptSha256(promptPath);
    const dataSha = coverDataSha256(context);
    const token = coverTaskToken(dataSha, currentPromptSha, publication);
    return updateJsonFileLocked(manifestPath, current => {
        if (current && current.version !== COVER_MANIFEST_VERSION) {
            throw new Error(`不支持的汇总封面 manifest 版本: ${current.version}`);
        }
        let cover;
        const archivedCover = migrateLegacyCompletedCover(
            current?.cover, dataSha, currentPromptSha, token,
            coverTaskToken(dataSha, currentPromptSha, null), targetDate
        );
        if (validateCompletedCover(archivedCover, dataSha, currentPromptSha, token)) {
            cover = archivedCover;
        } else if (
            current?.cover
            && ['pending', 'failed'].includes(current.cover.status)
            && current.cover.taskToken === token
        ) {
            cover = current.cover;
        } else {
            cover = {
                status: 'pending',
                label: '汇总页封面',
                batchDate: targetDate,
                dataSha256: dataSha,
                promptSha256: currentPromptSha,
                taskToken: token
            };
        }
        const complete = cover.status === 'complete';
        return {
            version: COVER_MANIFEST_VERSION,
            batchDate: targetDate,
            dataSha256: dataSha,
            promptSha256: currentPromptSha,
            generationContext: context,
            publication: publication ? {
                publicationCommit: publication.publicationCommit,
                generationManifestSha256: publication.generationManifestSha256
            } : null,
            cover,
            overallStatus: complete ? 'complete' : (cover.status === 'failed' ? 'failed' : 'pending'),
            updatedAt: getBeijingISOString(),
            completedAt: complete ? (current?.completedAt || getBeijingISOString()) : null
        };
    });
}

function recordDigestCover({ sourcePath, taskToken, targetDate, manifestPath }) {
    manifestPath = manifestPath || digestCoverManifestPath(targetDate);
    const raw = fs.readFileSync(path.resolve(sourcePath));
    validatePngBuffer(raw);
    const assetSha256 = sha256Buffer(raw);
    return updateJsonFileLocked(manifestPath, current => {
        if (!current?.cover) throw new Error('请先执行汇总封面 plan');
        if (!taskToken || current.cover.taskToken !== taskToken) throw new Error('汇总封面任务令牌已失效');
        if (current.cover.status === 'complete') throw new Error('汇总封面已完成，拒绝旧任务覆盖');
        const target = assertSafeAssetTarget(
            digestCoverAssetPath(current.batchDate),
            Config.FILES.digestCoverAssetDir
        );
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.writeFileSync(temp, raw, { mode: 0o600 });
            fs.renameSync(temp, target);
        } finally {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
        const now = getBeijingISOString();
        return {
            ...current,
            overallStatus: 'complete',
            updatedAt: now,
            completedAt: now,
            cover: {
                ...current.cover,
                status: 'complete',
                assetPath: path.relative(Config.PROJECT_ROOT, target).split(path.sep).join('/'),
                assetSha256,
                completedAt: now
            }
        };
    }, { allowMissing: false });
}

function markDigestCoverFailed({ error, taskToken, targetDate, manifestPath }) {
    manifestPath = manifestPath || digestCoverManifestPath(targetDate);
    return updateJsonFileLocked(manifestPath, current => {
        if (!current?.cover) throw new Error('请先执行汇总封面 plan');
        if (!taskToken || current.cover.taskToken !== taskToken) throw new Error('汇总封面任务令牌已失效');
        if (current.cover.status === 'complete') throw new Error('汇总封面已完成，拒绝旧失败回写');
        const now = getBeijingISOString();
        return {
            ...current,
            overallStatus: 'failed',
            updatedAt: now,
            completedAt: null,
            cover: {
                ...current.cover,
                status: 'failed',
                error: String(error || '生成失败').slice(0, 1000),
                failedAt: now
            }
        };
    }, { allowMissing: false });
}

function loadPapers(filePath = Config.FILES.deepAnalysisResult) {
    const data = readJsonFileStrict(filePath);
    const papers = Array.isArray(data) ? data : data.papers;
    if (!Array.isArray(papers)) throw new Error(`深度分析文件 papers 必须是数组: ${filePath}`);
    return papers;
}

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = {};
    for (let i = 0; i < rest.length; i += 1) {
        if (!rest[i].startsWith('--') || i + 1 >= rest.length) throw new Error(`无效参数: ${rest[i]}`);
        options[rest[i].slice(2)] = rest[++i];
    }
    return { command, options };
}

function main(argv = process.argv.slice(2)) {
    const { command, options } = parseArgs(argv);
    if (command === 'plan') {
        const publication = assertPublishedBlogReceipt(options.date, options.receipt);
        if (options.category && options.category !== publication.category) {
            throw new Error(`汇总图 category 与已发布博客不一致: ${options.category} != ${publication.category}`);
        }
        const manifest = planDigestCover({
            targetDate: options.date,
            papers: bindPublishedPapersToDate(publication, options.date),
            manifestPath: options.manifest,
            category: publication.category,
            publication
        });
        console.log(`汇总封面: ${manifest.cover.status}`);
        if (manifest.cover.status !== 'complete') console.log(JSON.stringify({
            kind: 'digest-cover',
            label: manifest.cover.label,
            taskToken: manifest.cover.taskToken,
            dataSha256: manifest.dataSha256,
            promptSha256: manifest.promptSha256,
            generationContext: manifest.generationContext
        }));
        return;
    }
    if (command === 'archive-legacy') {
        archiveLegacyDigestCover({ targetDate: options.date, manifestPath: options.manifest });
        console.log('历史汇总封面已按日期归档');
        return;
    }
    if (command === 'status') {
        const publication = assertPublishedBlogReceipt(options.date, options.receipt);
        const manifest = readJsonFileStrict(options.manifest || digestCoverManifestPath(options.date));
        const expected = assertDigestCoverManifestCurrent(manifest, publication, options.date);
        const complete = validateCompletedCover(
            manifest.cover, expected.expectedDataSha, expected.expectedPromptSha, expected.expectedToken
        );
        console.log(`汇总图: ${complete ? 'complete' : (manifest.cover?.status || 'pending')}`);
        if (!complete) process.exitCode = 1;
        return;
    }
    if (command === 'record') {
        const publication = assertPublishedBlogReceipt(options.date, options.receipt);
        const current = readJsonFileStrict(options.manifest || digestCoverManifestPath(options.date));
        assertDigestCoverManifestCurrent(current, publication, options.date);
        recordDigestCover({
            sourcePath: options.file || extractGeneratedImagePathFromHint(options['output-hint']),
            taskToken: options.token,
            targetDate: options.date,
            manifestPath: options.manifest
        });
        console.log('已登记汇总页封面');
        return;
    }
    if (command === 'fail') {
        const publication = assertPublishedBlogReceipt(options.date, options.receipt);
        const current = readJsonFileStrict(options.manifest || digestCoverManifestPath(options.date));
        assertDigestCoverManifestCurrent(current, publication, options.date);
        markDigestCoverFailed({ error: options.error, taskToken: options.token, targetDate: options.date, manifestPath: options.manifest });
        console.log('已记录汇总页封面失败');
        return;
    }
    throw new Error('用法: digest-cover-state.js plan|status|archive-legacy --date YYYY-MM-DD | record --date YYYY-MM-DD (--file PNG|--output-hint HINT) --token TOKEN | fail --date YYYY-MM-DD --error MESSAGE --token TOKEN');
}

if (require.main === module) main();

module.exports = {
    COVER_MANIFEST_VERSION,
    COVER_RANKING_LIMIT,
    digestTitle,
    buildCoverContext,
    coverDataSha256,
    coverTaskToken,
    digestCoverManifestPath,
    planDigestCover,
    recordDigestCover,
    markDigestCoverFailed,
    validateCompletedCover,
    digestCoverAssetPath,
    migrateLegacyCompletedCover,
    archiveLegacyDigestCover,
    assertDigestCoverManifestCurrent,
    main
};

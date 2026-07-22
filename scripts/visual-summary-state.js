#!/usr/bin/env node
/**
 * Codex 视觉摘要状态管理。
 *
 * 本脚本绝不调用图像 API；它只负责根据已审计的深度分析建立任务清单，
 * 并将 Codex 内置 image_gen 生成的 PNG 资产验证、复制后原子登记。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Config = require('./config.js');
const {
    getBeijingISOString,
    normalizedId,
    writeFileAtomic
} = require('./utils.js');
const {
    isSuccessfulAnalysisRecord,
    updateJsonFileLocked,
    readJsonFileStrict
} = require('./analysis-engine.js');

const MANIFEST_VERSION = 3;
const DEFAULT_SELECTION_LIMIT = 10;
const CARD_KINDS = Object.freeze(['infographic']);
const CARD_LABELS = Object.freeze({
    infographic: '论文长图摘要'
});
const CARD_DIRECTIONS = Object.freeze({
    infographic: '生成一张纵向长图，从上到下完整串联研究问题与核心贡献、方法模块与信号流、关键实验发现、结论与局限；不编造数字或论文未提供的事实。'
});
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Keep this aligned with publish-to-blog.py's multimodal review payload ceiling.
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MIN_ASSET_WIDTH = 768;
const MIN_ASSET_HEIGHT = 1024;
const MIN_PORTRAIT_RATIO = 1.25;
const MAX_REFERENCE_IMAGES = 2;
const REFERENCE_MIME_EXTENSIONS = Object.freeze({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp'
});
const RENDERING_CONTRACT = Object.freeze({
    mode: 'full_image_generation_v2',
    renderer: 'built-in image_gen',
    resolutionPolicy: 'highest_available_portrait',
    orientation: 'portrait',
    preferredAspectRatio: '1:2',
    minimumWidth: MIN_ASSET_WIDTH,
    minimumHeight: MIN_ASSET_HEIGHT,
    maxPngBytes: MAX_ASSET_BYTES
});
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function sha256Buffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function crc32(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function validatePngBuffer(raw, { requirePortrait = true } = {}) {
    if (!Buffer.isBuffer(raw) || raw.length <= PNG_SIGNATURE.length || raw.length > MAX_ASSET_BYTES) {
        throw new Error(`视觉摘要 PNG 大小非法: ${raw?.length || 0} bytes`);
    }
    if (!raw.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error('视觉摘要资产必须是真实 PNG，扩展名不能代替文件头验证');
    }
    let offset = PNG_SIGNATURE.length;
    let first = true;
    let sawIdat = false;
    let sawIend = false;
    while (offset < raw.length) {
        if (offset + 12 > raw.length) throw new Error('视觉摘要 PNG chunk 被截断');
        const length = raw.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > raw.length) throw new Error('视觉摘要 PNG chunk 长度越界');
        const type = raw.subarray(offset + 4, offset + 8);
        const payload = raw.subarray(offset + 8, offset + 8 + length);
        const expectedCrc = raw.readUInt32BE(offset + 8 + length);
        if (crc32(Buffer.concat([type, payload])) !== expectedCrc) throw new Error('视觉摘要 PNG chunk CRC 错误');
        const typeName = type.toString('ascii');
        if (first) {
            if (typeName !== 'IHDR' || length !== 13) throw new Error('视觉摘要 PNG 缺少合法 IHDR');
            const width = payload.readUInt32BE(0);
            const height = payload.readUInt32BE(4);
            if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error(`视觉摘要 PNG 尺寸非法: ${width}x${height}`);
            if (requirePortrait && (width < MIN_ASSET_WIDTH || height < MIN_ASSET_HEIGHT || height / width < MIN_PORTRAIT_RATIO)) {
                throw new Error(`视觉摘要必须是至少 ${MIN_ASSET_WIDTH}x${MIN_ASSET_HEIGHT} 且高宽比不低于 ${MIN_PORTRAIT_RATIO} 的纵向长图: ${width}x${height}`);
            }
            first = false;
        }
        if (typeName === 'IDAT') sawIdat = true;
        if (typeName === 'IEND') {
            if (length !== 0 || end !== raw.length) throw new Error('视觉摘要 PNG IEND 非法或尾部有多余数据');
            sawIend = true;
            break;
        }
        offset = end;
    }
    if (!sawIdat || !sawIend) throw new Error('视觉摘要 PNG 缺少 IDAT/IEND 必需 chunk');
    return true;
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

function validateDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
        throw new Error(`日期必须为 YYYY-MM-DD: ${JSON.stringify(value)}`);
    }
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
        throw new Error(`日期非法: ${JSON.stringify(value)}`);
    }
    return value;
}

function visualAssetTitleSlug(title, maxLength = 64) {
    const slug = String(title || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxLength)
        .replace(/-+$/g, '');
    return slug || 'paper';
}

function visualSummaryManifestPath(targetDate) {
    return path.join(Config.FILES.visualSummaryManifestDir, `${validateDate(targetDate)}.json`);
}

function assertPublishedBlogReceipt(targetDate, receiptPath = null) {
    targetDate = validateDate(targetDate);
    const resolved = receiptPath || path.join(Config.CURRENT_DIR, `blog-review-receipt-${targetDate}.json`);
    let receipt;
    try {
        receipt = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (_error) {
        throw new Error(`缺少可验证的博客发布凭证，视觉任务只能在全部博客发布后建立: ${resolved}`);
    }
    const verifiedAt = String(receipt.remoteVerifiedAt || '');
    if (receipt.schemaVersion !== 3 || receipt.date !== targetDate
        || receipt.strictReview !== true || receipt.hugoGate !== 'hugo'
        || !/^[0-9a-f]{64}$/i.test(String(receipt.reviewProtocolFingerprint || ''))
        || !/^[0-9a-f]{64}$/i.test(String(receipt.generationManifestSha256 || ''))
        || !/^[0-9a-f]{40,64}$/i.test(String(receipt.publicationCommit || ''))
        || receipt.remoteVerifiedOid !== receipt.publicationCommit
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00$/.test(verifiedAt)) {
        throw new Error(`博客发布凭证尚未记录远端 OID 验证结果: ${resolved}`);
    }
    const generationPath = path.join(Config.CURRENT_DIR, `blog-generation-manifest-${targetDate}.json`);
    let generationRaw;
    let generation;
    try {
        generationRaw = fs.readFileSync(generationPath);
        generation = JSON.parse(generationRaw.toString('utf8'));
    } catch (_error) {
        throw new Error(`缺少发布凭证绑定的 generation manifest: ${generationPath}`);
    }
    const generationManifestSha256 = sha256Buffer(generationRaw);
    const publishedPapers = generation.publishedPapers;
    if (generationManifestSha256 !== receipt.generationManifestSha256
        || generation.schemaVersion !== 3 || generation.date !== targetDate
        || generation.visualSummaryRequired !== false || generation.digestCoverRequired !== false
        || !/^[0-9a-f]{64}$/i.test(String(generation.inputFingerprint || ''))
        || typeof generation.category !== 'string' || !generation.category
        || !Array.isArray(publishedPapers) || publishedPapers.length === 0) {
        throw new Error('博客发布凭证与 generation manifest 或已发布论文快照不一致');
    }
    const ids = publishedPapers.map(normalizedId);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
        throw new Error('generation manifest 的已发布论文快照包含空或重复 ID');
    }
    return {
        path: resolved,
        generationPath,
        publicationCommit: receipt.publicationCommit.toLowerCase(),
        generationManifestSha256,
        category: generation.category,
        publishedPapers
    };
}

function paperBatchDate(paper) {
    const direct = paper.fetchBatchDate || paper.batchDate;
    if (direct) return validateDate(direct);
    const match = typeof paper.fetchedAt === 'string'
        ? paper.fetchedAt.match(/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/)
        : null;
    if (!match) {
        throw new Error(`fetchedAt 必须是严格北京时间戳: ${JSON.stringify(paper.fetchedAt)}`);
    }
    return validateDate(match[1]);
}

function promptSha256(promptPath = path.join(Config.PROJECT_ROOT, 'prompts', 'visual-summary.md')) {
    return sha256Buffer(fs.readFileSync(promptPath));
}

function referenceFigureRole(caption) {
    const text = String(caption || '').toLowerCase();
    // Result captions such as "per-method EER" also contain the word "method".
    // Classify explicit evaluation language first so they cannot outrank a real architecture figure.
    if (/result|experiment|comparison|ablation|benchmark|\beer\b|\bwer\b|\bf1\b|accuracy|score|结果|实验|对比|消融|基准|准确率|错误率/.test(text)) {
        return { role: 'result_reference', priority: 1 };
    }
    if (/overview|architecture|framework|pipeline|method|model|system|架构|结构|流程|框架|方法/.test(text)) {
        return { role: 'method_reference', priority: 0 };
    }
    return { role: 'paper_figure', priority: 2 };
}

function visualReferenceCachePaths(url) {
    const key = sha256Buffer(Buffer.from(String(url), 'utf8'));
    const root = path.join(Config.CURRENT_DIR, 'image-cache');
    return { data: path.join(root, `${key}.bin`), meta: path.join(root, `${key}.json`) };
}

function selectVisualReferenceImages(paper, limit = MAX_REFERENCE_IMAGES) {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_REFERENCE_IMAGES) {
        throw new Error(`论文视觉参考图数量非法: ${limit}`);
    }
    const manifest = paper?.imageManifest || {};
    const selected = [...new Set([
        ...(Array.isArray(paper?.selectedImageUrls) ? paper.selectedImageUrls : []),
        ...(Array.isArray(manifest.selected) ? manifest.selected : [])
    ].map(value => String(value || '').trim()).filter(Boolean))];
    const candidates = new Map((Array.isArray(manifest.candidates) ? manifest.candidates : [])
        .filter(item => item && typeof item.url === 'string')
        .map(item => [item.url, item]));
    const downloads = new Map((Array.isArray(manifest.downloaded) ? manifest.downloaded : [])
        .filter(item => item && typeof item.url === 'string')
        .map(item => [item.url, item]));

    return selected.map((url, sourceOrder) => {
        const candidate = candidates.get(url) || {};
        const downloaded = downloads.get(url) || {};
        const caption = String(candidate.caption || '');
        const role = referenceFigureRole(caption);
        return { url, sourceOrder, caption, ...role, downloaded };
    }).sort((a, b) => a.priority - b.priority || a.sourceOrder - b.sourceOrder)
        .flatMap(item => {
            const cache = visualReferenceCachePaths(item.url);
            try {
                const raw = fs.readFileSync(cache.data);
                const meta = JSON.parse(fs.readFileSync(cache.meta, 'utf8'));
                const actualSha = sha256Buffer(raw);
                if (
                    meta.url !== item.url
                    || meta.sha256 !== actualSha
                    || item.downloaded.sha256 !== actualSha
                    || meta.mime !== item.downloaded.mime
                    || meta.bytes !== raw.length
                ) return [];
                return [{
                    role: item.role,
                    url: item.url,
                    caption: item.caption,
                    mime: meta.mime,
                    bytes: raw.length,
                    sha256: actualSha,
                    cachePath: path.relative(Config.PROJECT_ROOT, cache.data).split(path.sep).join('/')
                }];
            } catch (error) {
                return [];
            }
        }).slice(0, limit);
}

function validateReferenceImageBytes(raw, mime) {
    const extension = REFERENCE_MIME_EXTENSIONS[String(mime || '').toLowerCase()];
    if (!extension) throw new Error(`视觉参考图 MIME 不受支持: ${JSON.stringify(mime)}`);
    const isPng = raw.length >= PNG_SIGNATURE.length
        && raw.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    const isJpeg = raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff;
    const isWebp = raw.length >= 12
        && raw.subarray(0, 4).toString('ascii') === 'RIFF'
        && raw.subarray(8, 12).toString('ascii') === 'WEBP';
    if ((extension === '.png' && !isPng)
        || (extension === '.jpg' && !isJpeg)
        || (extension === '.webp' && !isWebp)) {
        throw new Error(`视觉参考图文件头与 MIME 不匹配: ${mime}`);
    }
    return extension;
}

function prepareVisualReferenceInputs(manifest, {
    targetDate,
    paperId = null,
    outputRoot = path.join(Config.CURRENT_DIR, 'visual-reference-inputs')
} = {}) {
    targetDate = validateDate(targetDate || manifest?.batchDate);
    if (manifest?.batchDate !== targetDate || typeof manifest?.papers !== 'object') {
        throw new Error('视觉摘要 manifest 与参考图准备日期不一致');
    }
    const requestedId = paperId ? normalizedId(paperId) : null;
    if (paperId && !requestedId) throw new Error(`论文 ID 非法: ${JSON.stringify(paperId)}`);
    if (requestedId && !manifest.papers[requestedId]) {
        throw new Error(`manifest 中不存在论文: ${requestedId}`);
    }

    return Object.values(manifest.papers)
        .filter(paper => !requestedId || normalizedId(paper.normalizedArxivId || paper.arxivId) === requestedId)
        .sort((a, b) => a.rank - b.rank)
        .map(paper => {
            const id = normalizedId(paper.normalizedArxivId || paper.arxivId);
            const safeRoot = path.resolve(outputRoot);
            const directory = path.resolve(safeRoot, targetDate, `${String(paper.rank).padStart(2, '0')}-${id}`);
            if (directory !== safeRoot && !directory.startsWith(`${safeRoot}${path.sep}`)) {
                throw new Error(`视觉参考图准备路径逃逸: ${directory}`);
            }
            const references = (paper.generationContext?.referenceImages || []).map((reference, index) => {
                const expectedCache = path.resolve(visualReferenceCachePaths(reference.url).data);
                const recordedCache = path.resolve(Config.PROJECT_ROOT, String(reference.cachePath || ''));
                if (recordedCache !== expectedCache) {
                    throw new Error(`${id} 视觉参考图缓存路径不受控: ${reference.cachePath}`);
                }
                const raw = fs.readFileSync(recordedCache);
                const actualSha = sha256Buffer(raw);
                if (actualSha !== reference.sha256 || raw.length !== reference.bytes) {
                    throw new Error(`${id} 视觉参考图缓存 SHA/字节数不匹配: ${reference.cachePath}`);
                }
                const extension = validateReferenceImageBytes(raw, reference.mime);
                const role = String(reference.role || 'paper_figure').replace(/[^a-z0-9_-]/gi, '_');
                const target = path.join(directory, `${String(index + 1).padStart(2, '0')}-${role}${extension}`);
                fs.mkdirSync(directory, { recursive: true });
                const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
                if (!existing || sha256Buffer(existing) !== actualSha) writeFileAtomic(target, raw);
                return {
                    role: reference.role,
                    caption: reference.caption,
                    mime: reference.mime,
                    sha256: actualSha,
                    preparedPath: path.relative(Config.PROJECT_ROOT, target).split(path.sep).join('/')
                };
            });
            return {
                rank: paper.rank,
                arxivId: id,
                title: paper.title,
                taskToken: paper.cards?.infographic?.taskToken,
                referencedImagePaths: references.map(reference => reference.preparedPath),
                referenceImages: references
            };
        });
}

function analysisSha256(paper) {
    return stableSha256({
        arxivId: normalizedId(paper),
        analysis: paper.analysis,
        parsed: paper.parsed || null,
        analysisSource: paper.analysisSource || null,
        analysisSourceSha256: paper.analysisSourceSha256 || paper.sourceSha256 || null,
        scoringAudit: paper.analysisManifest?.stages?.scoringAudit || null,
        renderingContract: RENDERING_CONTRACT,
        visualReferenceImages: selectVisualReferenceImages(paper).map(item => ({
            role: item.role,
            url: item.url,
            caption: item.caption,
            mime: item.mime,
            bytes: item.bytes,
            sha256: item.sha256
        }))
    });
}

function cardTaskToken(id, kind, expectedAnalysisSha, expectedPromptSha, rank, publication = null) {
    return stableSha256({
        manifestVersion: MANIFEST_VERSION,
        arxivId: id,
        kind,
        rank,
        analysisSha256: expectedAnalysisSha,
        promptSha256: expectedPromptSha,
        publicationCommit: publication?.publicationCommit || null,
        generationManifestSha256: publication?.generationManifestSha256 || null
    });
}

function legacyCardTaskToken(id, kind, expectedAnalysisSha, expectedPromptSha, publication = null, manifestVersion = MANIFEST_VERSION) {
    return stableSha256({
        manifestVersion,
        arxivId: id,
        kind,
        analysisSha256: expectedAnalysisSha,
        promptSha256: expectedPromptSha,
        publicationCommit: publication?.publicationCommit || null,
        generationManifestSha256: publication?.generationManifestSha256 || null
    });
}

function pendingCard(id, kind, expectedAnalysisSha, expectedPromptSha, rank, publication = null) {
    return {
        status: 'pending',
        label: CARD_LABELS[kind],
        taskToken: cardTaskToken(id, kind, expectedAnalysisSha, expectedPromptSha, rank, publication),
        analysisSha256: expectedAnalysisSha,
        promptSha256: expectedPromptSha
    };
}

function validateCompletedCard(card, expectedAnalysisSha, expectedPromptSha, expectedTaskToken = null, expectedPath = null) {
    if (!card || card.status !== 'complete') return false;
    if (card.analysisSha256 !== expectedAnalysisSha || card.promptSha256 !== expectedPromptSha) return false;
    if (expectedTaskToken && card.taskToken !== expectedTaskToken) return false;
    if (typeof card.assetPath !== 'string' || !card.assetPath) return false;
    const absolute = path.resolve(Config.PROJECT_ROOT, card.assetPath);
    const allowedRoot = path.resolve(Config.FILES.visualSummaryAssetDir);
    if (absolute !== allowedRoot && !absolute.startsWith(`${allowedRoot}${path.sep}`)) return false;
    if (expectedPath && absolute !== path.resolve(expectedPath)) return false;
    try {
        const raw = fs.readFileSync(absolute);
        validatePngBuffer(raw);
        return sha256Buffer(raw) === card.assetSha256;
    } catch (_error) {
        return false;
    }
}

function visualSummaryAssetPath(targetDate, arxivId, kind, rank, title = '') {
    const date = validateDate(targetDate);
    const id = normalizedId(arxivId);
    if (!id || !CARD_KINDS.includes(kind) || !Number.isInteger(rank) || rank < 1 || rank > DEFAULT_SELECTION_LIMIT) {
        throw new Error('视觉摘要归档路径参数非法');
    }
    return path.resolve(
        Config.FILES.visualSummaryAssetDir,
        date,
        'visual-summaries',
        `${String(rank).padStart(2, '0')}-${id}-${visualAssetTitleSlug(title)}.png`
    );
}

function removeEmptyDirectory(directory) {
    if (!fs.existsSync(directory)) return;
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function cleanupEmptyLegacyVisualDirectories(targetDate) {
    const root = path.resolve(
        Config.FILES.visualSummaryAssetDir, validateDate(targetDate), 'visual-summaries'
    );
    if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
            removeEmptyDirectory(path.join(root, entry.name));
        }
    }
}

function migrateLegacyCompletedCard(
    card, expectedAnalysisSha, expectedPromptSha, expectedTaskToken, legacyTaskTokens,
    targetDate, id, kind, rank, title = ''
) {
    if (!card || card.status !== 'complete'
        || card.analysisSha256 !== expectedAnalysisSha
        || card.promptSha256 !== expectedPromptSha
        || ![expectedTaskToken, ...legacyTaskTokens].includes(card.taskToken)
        || !/^[0-9a-f]{64}$/.test(String(card.assetSha256 || ''))) {
        return card;
    }
    const target = visualSummaryAssetPath(targetDate, id, kind, rank, title);
    if (validateCompletedCard(card, expectedAnalysisSha, expectedPromptSha, expectedTaskToken, target)) return card;

    const legacy = path.resolve(Config.CURRENT_DIR, 'visual-summaries', targetDate, id, `${kind}.png`);
    const unnumberedArchive = path.resolve(
        Config.FILES.visualSummaryAssetDir, targetDate, 'visual-summaries', id, `${kind}.png`
    );
    const rankedArchive = path.resolve(
        Config.FILES.visualSummaryAssetDir, targetDate, 'visual-summaries',
        `${String(rank).padStart(2, '0')}-${id}`, `${kind}.png`
    );
    removeEmptyDirectory(path.dirname(legacy));
    removeEmptyDirectory(path.dirname(unnumberedArchive));
    removeEmptyDirectory(path.dirname(rankedArchive));
    const recorded = path.resolve(Config.PROJECT_ROOT, String(card.assetPath || ''));
    if (![legacy, unnumberedArchive, rankedArchive, target].includes(recorded)) return card;
    const source = [legacy, unnumberedArchive, rankedArchive, target]
        .find(candidate => fs.existsSync(candidate)) || null;
    if (!source) return card;
    const raw = fs.readFileSync(source);
    validatePngBuffer(raw);
    if (sha256Buffer(raw) !== card.assetSha256) return card;

    assertSafeAssetTarget(target, Config.FILES.visualSummaryAssetDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (source !== target) {
        const oldParent = path.dirname(source);
        if (fs.existsSync(target)) {
            const existing = fs.readFileSync(target);
            validatePngBuffer(existing);
            if (sha256Buffer(existing) !== card.assetSha256) {
                throw new Error(`视觉摘要归档目标已存在但内容不一致: ${target}`);
            }
            fs.unlinkSync(source);
        } else {
            fs.renameSync(source, target);
        }
        removeEmptyDirectory(oldParent);
    }
    return {
        ...card,
        taskToken: expectedTaskToken,
        assetPath: path.relative(Config.PROJECT_ROOT, target).split(path.sep).join('/'),
        archivedAt: card.archivedAt || getBeijingISOString()
    };
}

function archiveRemainingLegacyVisualAssets(targetDate, manifest) {
    const legacyRoot = path.resolve(Config.CURRENT_DIR, 'visual-summaries', validateDate(targetDate));
    if (!fs.existsSync(legacyRoot)) return 0;
    if (fs.lstatSync(legacyRoot).isSymbolicLink()) throw new Error(`旧视觉资产目录不得是符号链接: ${legacyRoot}`);
    let moved = 0;
    for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const id = normalizedId(entry.name);
        if (!id) continue;
        const rank = manifest?.papers?.[id]?.rank;
        const sourceDir = path.join(legacyRoot, entry.name);
        for (const file of fs.readdirSync(sourceDir, { withFileTypes: true })) {
            if (!file.isFile() || file.isSymbolicLink() || !/^[A-Za-z0-9_-]+\.png$/.test(file.name)) continue;
            const source = path.join(sourceDir, file.name);
            const kind = path.basename(file.name, '.png');
            const paper = manifest?.papers?.[id];
            const target = Number.isInteger(rank) && CARD_KINDS.includes(kind)
                ? visualSummaryAssetPath(targetDate, id, kind, rank, paper?.title || '')
                : path.resolve(
                    Config.FILES.visualSummaryAssetDir, targetDate, 'visual-summaries',
                    `unranked-${id}-${kind}.png`
                );
            assertSafeAssetTarget(target, Config.FILES.visualSummaryAssetDir);
            const raw = fs.readFileSync(source);
            validatePngBuffer(raw, { requirePortrait: false });
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (fs.existsSync(target)) {
                const existing = fs.readFileSync(target);
                validatePngBuffer(existing, { requirePortrait: false });
                if (sha256Buffer(existing) !== sha256Buffer(raw)) {
                    throw new Error(`旧视觉资产归档目标已存在但内容不一致: ${target}`);
                }
                fs.unlinkSync(source);
            } else {
                fs.renameSync(source, target);
            }
            moved += 1;
        }
        if (fs.readdirSync(sourceDir).length === 0) fs.rmdirSync(sourceDir);
    }
    if (fs.existsSync(legacyRoot) && fs.readdirSync(legacyRoot).length === 0) fs.rmdirSync(legacyRoot);
    return moved;
}

function archiveLegacyVisualManifestAssets({ targetDate, manifestPath, generationManifestPath } = {}) {
    targetDate = validateDate(targetDate);
    manifestPath = manifestPath || visualSummaryManifestPath(targetDate);
    generationManifestPath = generationManifestPath || path.join(
        Config.CURRENT_DIR, `blog-generation-manifest-${targetDate}.json`
    );
    const generation = readJsonFileStrict(generationManifestPath);
    if (generation.date !== targetDate) {
        throw new Error(`博客 generation manifest 与归档日期不匹配: ${generationManifestPath}`);
    }
    let publishedPapers = generation.publishedPapers;
    if (!Array.isArray(publishedPapers)) {
        const publishedIds = new Set((generation.files || []).flatMap(record => {
            const match = String(record?.path || '').match(/(\d{4})-(\d{4,5})(?=\.md$)/);
            return match ? [`${match[1]}.${match[2]}`] : [];
        }));
        const archivedAnalysisPath = path.join(Config.ARCHIVE_DIR, targetDate, 'deep-analysis-result.json');
        const archivedAnalysis = readJsonFileStrict(archivedAnalysisPath);
        const papers = Array.isArray(archivedAnalysis) ? archivedAnalysis : archivedAnalysis.papers;
        if (publishedIds.size === 0 || !Array.isArray(papers)) {
            throw new Error(`旧版 generation manifest 缺少论文快照且无法绑定归档分析: ${generationManifestPath}`);
        }
        publishedPapers = papers.filter(paper => publishedIds.has(normalizedId(paper)));
        if (publishedPapers.length !== publishedIds.size) {
            throw new Error(`旧版 generation manifest 与归档分析论文集合不一致: ${targetDate}`);
        }
    }
    const ranked = selectTopRankedPapers(publishedPapers, targetDate, DEFAULT_SELECTION_LIMIT);
    const rankById = new Map(ranked.map((paper, index) => [normalizedId(paper), index + 1]));
    const publishedById = new Map(publishedPapers.map(paper => [normalizedId(paper), paper]));
    const migrated = updateJsonFileLocked(manifestPath, current => {
        if (!current || current.batchDate !== targetDate || !current.papers || typeof current.papers !== 'object') {
            throw new Error(`视觉摘要 manifest 与归档日期不匹配: ${manifestPath}`);
        }
        const next = structuredClone(current);
        for (const [id, paper] of Object.entries(next.papers)) {
            const rank = rankById.get(id) || null;
            const authoritativePaper = publishedById.get(id) || {};
            paper.rank = rank;
            paper.title = paper.title || authoritativePaper.title || '';
            for (const [kind, card] of Object.entries(paper.cards || {})) {
                if (card?.status !== 'complete' || !/^[A-Za-z0-9_-]+$/.test(kind)
                    || !/^[0-9a-f]{64}$/.test(String(card.assetSha256 || ''))) continue;
                const legacy = path.resolve(Config.CURRENT_DIR, 'visual-summaries', targetDate, id, `${kind}.png`);
                const oldRanked = rank ? path.resolve(
                    Config.FILES.visualSummaryAssetDir, targetDate, 'visual-summaries',
                    `${String(rank).padStart(2, '0')}-${id}`, `${kind}.png`
                ) : null;
                const target = rank
                    ? visualSummaryAssetPath(targetDate, id, kind, rank, paper.title || '')
                    : path.resolve(
                        Config.FILES.visualSummaryAssetDir, targetDate, 'visual-summaries',
                        `unranked-${id}-${kind}.png`
                    );
                assertSafeAssetTarget(target, Config.FILES.visualSummaryAssetDir);
                const recorded = path.resolve(Config.PROJECT_ROOT, String(card.assetPath || ''));
                if (![legacy, oldRanked, target].filter(Boolean).includes(recorded)) {
                    throw new Error(`历史视觉资产路径不受控: ${card.assetPath}`);
                }
                let source = fs.existsSync(legacy) ? legacy : (fs.existsSync(target) ? target : null);
                if (!source) {
                    const archiveRoot = path.resolve(
                        Config.FILES.visualSummaryAssetDir, targetDate, 'visual-summaries'
                    );
                    const recovered = fs.existsSync(archiveRoot)
                        ? fs.readdirSync(archiveRoot, { withFileTypes: true })
                            .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
                                && entry.name.endsWith(`-${id}`))
                            .map(entry => path.join(archiveRoot, entry.name, `${kind}.png`))
                            .filter(candidate => fs.existsSync(candidate))
                        : [];
                    if (recovered.length > 1) throw new Error(`历史视觉资产存在多个归档候选: ${id}/${kind}`);
                    source = recovered[0] || null;
                }
                if (!source || !fs.statSync(source).isFile()) throw new Error(`历史视觉资产缺失: ${id}/${kind}`);
                const raw = fs.readFileSync(source);
                validatePngBuffer(raw, { requirePortrait: kind === 'infographic' });
                if (sha256Buffer(raw) !== card.assetSha256) throw new Error(`历史视觉资产 SHA 不匹配: ${id}/${kind}`);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                if (source !== target) {
                    const oldParent = path.dirname(source);
                    if (fs.existsSync(target)) {
                        const existing = fs.readFileSync(target);
                        validatePngBuffer(existing, { requirePortrait: kind === 'infographic' });
                        if (sha256Buffer(existing) !== card.assetSha256) {
                            throw new Error(`历史视觉资产归档目标冲突: ${target}`);
                        }
                        fs.unlinkSync(source);
                    } else {
                        fs.renameSync(source, target);
                    }
                    if (oldParent !== path.dirname(target) && fs.existsSync(oldParent)
                        && fs.readdirSync(oldParent).length === 0) {
                        fs.rmdirSync(oldParent);
                    }
                }
                card.assetPath = path.relative(Config.PROJECT_ROOT, target).split(path.sep).join('/');
                card.archivedAt = card.archivedAt || getBeijingISOString();
            }
        }
        next.updatedAt = getBeijingISOString();
        return next;
    }, { allowMissing: false });
    const extraCount = archiveRemainingLegacyVisualAssets(targetDate, migrated);
    return { manifest: migrated, rankedCount: ranked.length, extraCount };
}

function buildGenerationContext(paper) {
    const parsed = paper.parsed || {};
    return {
        title: String(paper.title || ''),
        documentType: String(parsed.documentType || ''),
        primaryTask: String(parsed.primaryTaskTag || ''),
        primaryMethod: String(parsed.primaryMethodTag || ''),
        summary: String(parsed.summary || ''),
        method: String(parsed.architecture || parsed.details || ''),
        experiments: String(parsed.results || ''),
        limitations: String(parsed.limitations || ''),
        referenceImages: selectVisualReferenceImages(paper),
        rendering: RENDERING_CONTRACT
    };
}

function selectTopRankedPapers(papers, targetDate, limit = DEFAULT_SELECTION_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`视觉摘要排名数量非法: ${limit}`);
    const batchPapers = papers.filter(paper => paperBatchDate(paper) === targetDate);
    if (batchPapers.length === 0) throw new Error(`批次 ${targetDate} 没有可用的深度分析`);
    const ids = batchPapers.map(normalizedId);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
        throw new Error('视觉摘要论文集合包含空或重复的规范化 arXiv ID');
    }
    const eligible = batchPapers.filter(paper => isSuccessfulAnalysisRecord(paper) && !paper.latestAnalysisAttemptError);
    if (eligible.length !== batchPapers.length) {
        throw new Error(`批次 ${targetDate} 尚有未完成或最新尝试失败的深度分析，禁止建立发布后视觉任务`);
    }
    for (const paper of eligible) {
        const score = Number(paper.parsed?.score);
        if (!Number.isFinite(score)) throw new Error(`${normalizedId(paper)} 缺少可用于 TOP 10 排名的最终评分`);
    }
    return eligible
        .sort((a, b) => Number(b.parsed.score) - Number(a.parsed.score)
            || (normalizedId(a) < normalizedId(b) ? -1 : normalizedId(a) > normalizedId(b) ? 1 : 0))
        .slice(0, limit);
}

function bindPublishedPapersToDate(publication, targetDate) {
    targetDate = validateDate(targetDate);
    if (!publication || !Array.isArray(publication.publishedPapers) || publication.publishedPapers.length === 0) {
        throw new Error('缺少已发布论文权威快照');
    }
    return publication.publishedPapers.map(paper => ({
        ...paper,
        fetchBatchDate: targetDate,
        batchDate: targetDate
    }));
}

function assertVisualManifestCurrent(manifest, publication, targetDate, promptPath = null) {
    targetDate = validateDate(targetDate);
    if (!manifest || manifest.version !== MANIFEST_VERSION || manifest.batchDate !== targetDate
        || manifest.publication?.publicationCommit !== publication.publicationCommit
        || manifest.publication?.generationManifestSha256 !== publication.generationManifestSha256) {
        throw new Error('视觉摘要 manifest 与当前已发布博客版本不一致，请重新执行发布后规划');
    }
    const papers = bindPublishedPapersToDate(publication, targetDate);
    const limit = Number(manifest.selection?.limit);
    if (!Number.isInteger(limit) || limit !== DEFAULT_SELECTION_LIMIT) {
        throw new Error('视觉摘要 TOP 10 选择契约已失效，请重新执行发布后规划');
    }
    const selected = selectTopRankedPapers(papers, targetDate, limit);
    const currentPromptSha = promptSha256(promptPath || undefined);
    const expectedIds = selected.map(normalizedId);
    if (manifest.promptSha256 !== currentPromptSha
        || manifest.selection?.type !== 'top_score'
        || manifest.selection?.sourcePaperCount !== papers.length
        || !manifest.papers || Object.keys(manifest.papers).length !== expectedIds.length
        || Object.keys(manifest.papers).some((id, index) => id !== expectedIds[index])
        || (manifest.skippedPapers || []).length !== 0) {
        throw new Error('视觉摘要排名、论文集合或 prompt 已失效，请重新执行发布后规划');
    }
    selected.forEach((paper, index) => {
        const id = expectedIds[index];
        const record = manifest.papers[id];
        const expectedAnalysisSha = analysisSha256(paper);
        const expectedToken = cardTaskToken(
            id, 'infographic', expectedAnalysisSha, currentPromptSha, index + 1, publication
        );
        const card = record?.cards?.infographic;
        if (!record || record.rank !== index + 1 || record.score !== Number(paper.parsed.score)
            || record.title !== String(paper.title || '')
            || record.analysisSha256 !== expectedAnalysisSha || record.promptSha256 !== currentPromptSha
            || stableSha256(record.generationContext) !== stableSha256(buildGenerationContext(paper))
            || !card || card.taskToken !== expectedToken
            || card.analysisSha256 !== expectedAnalysisSha || card.promptSha256 !== currentPromptSha) {
            throw new Error(`视觉摘要任务已失效: ${id}，请重新执行发布后规划`);
        }
    });
    return manifest;
}

function withManifestSummary(manifest) {
    const papers = Object.values(manifest?.papers || {});
    let completeCards = 0;
    let failedCards = 0;
    let pendingCards = 0;
    for (const paper of papers) {
        for (const kind of CARD_KINDS) {
            const status = paper.cards?.[kind]?.status;
            if (status === 'complete') completeCards += 1;
            else if (status === 'failed') failedCards += 1;
            else pendingCards += 1;
        }
    }
    const totalCards = papers.length * CARD_KINDS.length;
    const skippedPapers = Array.isArray(manifest?.skippedPapers) ? manifest.skippedPapers.length : 0;
    let overallStatus = 'pending';
    if (totalCards > 0 && completeCards === totalCards && skippedPapers === 0) overallStatus = 'complete';
    else if (failedCards > 0) overallStatus = 'partial_failed';
    return {
        ...manifest,
        overallStatus,
        counts: {
            eligiblePapers: papers.length,
            skippedPapers,
            totalCards,
            completeCards,
            pendingCards,
            failedCards
        },
        ...(overallStatus === 'complete' ? { completedAt: manifest.completedAt || getBeijingISOString() } : { completedAt: null })
    };
}

function buildPaperPlan(paper, existing, targetDate, currentPromptSha, publication = null, rank = null) {
    const id = normalizedId(paper);
    if (!id) throw new Error('视觉摘要论文缺少可规范化的 arXiv ID');
    if (!isSuccessfulAnalysisRecord(paper)) {
        throw new Error(`${id} 深度分析未通过完整契约，禁止生成视觉摘要`);
    }
    if (paper.latestAnalysisAttemptError) {
        throw new Error(`${id} 最新一次分析失败，禁止用陈旧正文生成视觉摘要`);
    }
    if (paperBatchDate(paper) !== targetDate) {
        throw new Error(`${id} 不属于批次 ${targetDate}`);
    }

    const currentAnalysisSha = analysisSha256(paper);
    const generationContext = buildGenerationContext(paper);
    const previousCards = existing?.cards || {};
    const cards = {};
    for (const kind of CARD_KINDS) {
        const previous = previousCards[kind];
        const expectedTaskToken = cardTaskToken(
            id, kind, currentAnalysisSha, currentPromptSha, rank, publication
        );
        const previousTaskTokens = [MANIFEST_VERSION, 2].flatMap(version => [
            legacyCardTaskToken(id, kind, currentAnalysisSha, currentPromptSha, publication, version),
            legacyCardTaskToken(id, kind, currentAnalysisSha, currentPromptSha, null, version)
        ]);
        const expectedAssetPath = visualSummaryAssetPath(targetDate, id, kind, rank, paper.title || '');
        const archivedPrevious = migrateLegacyCompletedCard(
            previous, currentAnalysisSha, currentPromptSha, expectedTaskToken, previousTaskTokens,
            targetDate, id, kind, rank, paper.title || ''
        );
        if (validateCompletedCard(archivedPrevious, currentAnalysisSha, currentPromptSha, expectedTaskToken, expectedAssetPath)) {
            cards[kind] = archivedPrevious;
        } else if (
            previous
            && ['pending', 'failed'].includes(previous.status)
            && previous.taskToken === expectedTaskToken
            && previous.analysisSha256 === currentAnalysisSha
            && previous.promptSha256 === currentPromptSha
        ) {
            cards[kind] = previous;
        } else {
            cards[kind] = pendingCard(id, kind, currentAnalysisSha, currentPromptSha, rank, publication);
        }
    }
    return {
        arxivId: paper.arxivId || paper.paper_id || id,
        normalizedArxivId: id,
        title: paper.title || '',
        batchDate: targetDate,
        analysisSha256: currentAnalysisSha,
        promptSha256: currentPromptSha,
        generationContext,
        cards
    };
}

function loadAnalysisPapers(filePath = Config.FILES.deepAnalysisResult) {
    const data = readJsonFileStrict(filePath);
    const papers = Array.isArray(data) ? data : data.papers;
    if (!Array.isArray(papers)) throw new Error(`深度分析文件 papers 必须是数组: ${filePath}`);
    return papers;
}

function planVisualSummaries({
    targetDate,
    papers,
    manifestPath,
    promptPath,
    selectionLimit = DEFAULT_SELECTION_LIMIT,
    publication = null
}) {
    targetDate = validateDate(targetDate);
    if (!publication
        || !/^[0-9a-f]{40,64}$/i.test(String(publication.publicationCommit || ''))
        || !/^[0-9a-f]{64}$/i.test(String(publication.generationManifestSha256 || ''))) {
        throw new Error('视觉摘要只能绑定远端已验证的博客发布版本后规划');
    }
    const defaultManifestPath = visualSummaryManifestPath(targetDate);
    manifestPath = manifestPath || defaultManifestPath;
    const legacyPath = Config.FILES.visualSummaryManifest;
    if (manifestPath === defaultManifestPath && !fs.existsSync(manifestPath)
        && legacyPath && fs.existsSync(legacyPath)) {
        const legacy = readJsonFileStrict(legacyPath);
        if (legacy?.batchDate === targetDate) {
            updateJsonFileLocked(manifestPath, current => current || legacy);
        }
    }
    const currentPromptSha = promptSha256(promptPath);
    const batchPapers = papers.filter(paper => paperBatchDate(paper) === targetDate);
    const selected = selectTopRankedPapers(papers, targetDate, selectionLimit);

    const plannedManifest = updateJsonFileLocked(manifestPath, current => {
        if (current && ![1, 2, MANIFEST_VERSION].includes(current.version)) {
            throw new Error(`不支持的视觉摘要 manifest 版本: ${current.version}`);
        }
        // v1 represented three cards and v2 represented every-paper long images.
        // Both migrate to the v3 TOP 10 contract; reusable v2 assets keep only
        // when their analysis, prompt, publication binding, token, and path match.
        const previousPapers = [2, MANIFEST_VERSION].includes(current?.version) && current?.batchDate === targetDate
            ? (current.papers || {})
            : {};
        const planned = {};
        const skippedPapers = batchPapers
            .filter(paper => !isSuccessfulAnalysisRecord(paper) || paper.latestAnalysisAttemptError)
            .map(paper => ({
                arxivId: normalizedId(paper) || paper.arxivId || paper.paper_id || '',
                title: paper.title || '',
                reason: paper.latestAnalysisAttemptError
                    ? `最新一次分析失败: ${paper.latestAnalysisAttemptError}`
                    : '深度分析未通过完整契约'
            }));
        for (const [index, paper] of selected.entries()) {
            const id = normalizedId(paper);
            const rank = index + 1;
            planned[id] = {
                ...buildPaperPlan(paper, previousPapers[id], targetDate, currentPromptSha, publication, rank),
                rank,
                score: Number(paper.parsed.score)
            };
        }
        return withManifestSummary({
            version: MANIFEST_VERSION,
            batchDate: targetDate,
            selection: { type: 'top_score', limit: selectionLimit, sourcePaperCount: batchPapers.length },
            publication: publication ? {
                publicationCommit: publication.publicationCommit,
                generationManifestSha256: publication.generationManifestSha256
            } : null,
            promptSha256: currentPromptSha,
            updatedAt: getBeijingISOString(),
            papers: planned,
            skippedPapers
        });
    });
    if (path.resolve(manifestPath) === path.resolve(defaultManifestPath)) {
        archiveRemainingLegacyVisualAssets(targetDate, plannedManifest);
        cleanupEmptyLegacyVisualDirectories(targetDate);
    }
    return plannedManifest;
}

function validatePngAsset(sourcePath) {
    const source = path.resolve(sourcePath);
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error(`视觉摘要资产不是普通文件: ${source}`);
    const raw = fs.readFileSync(source);
    validatePngBuffer(raw);
    return { raw, sha256: sha256Buffer(raw) };
}

function assertSafeAssetTarget(targetPath, allowedRootPath) {
    const root = path.resolve(allowedRootPath);
    const target = path.resolve(targetPath);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`视觉资产目标逃逸受控目录: ${target}`);
    }
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
        throw new Error(`视觉资产根目录不得是符号链接: ${root}`);
    }
    const relativeParts = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of relativeParts) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
            throw new Error(`视觉资产目标父目录不得是符号链接: ${current}`);
        }
    }
    return target;
}

function extractGeneratedImagePathFromHint(outputHint) {
    const hint = String(outputHint || '').trim();
    if (!hint) throw new Error('内置图像生成结果缺少 output_hint');
    // Built-in image_gen currently reports: "saved to <directory> as <actual.png> by default".
    // The directory is not an asset. Always prefer the path after the final ` as ` marker.
    const asMatches = [...hint.matchAll(/\bas\s+(\/[^\r\n]+?\.png)(?=\s+by\s+default(?:\.|$)|[\r\n]|$)/gi)];
    const candidates = asMatches.map(match => match[1].trim());
    if (candidates.length === 0) {
        for (const match of hint.matchAll(/(\/[^\r\n]+?\.png)(?=[\r\n]|$)/g)) {
            candidates.push(match[1].trim());
        }
    }
    if (candidates.length === 0) throw new Error('无法从 output_hint 解析实际 PNG 路径');
    const selected = path.resolve(candidates[candidates.length - 1]);
    if (!path.isAbsolute(selected) || path.extname(selected).toLowerCase() !== '.png') {
        throw new Error(`output_hint 中的图像路径非法: ${selected}`);
    }
    return selected;
}

function recordVisualSummaryCard({
    arxivId,
    kind,
    sourcePath,
    taskToken,
    targetDate,
    manifestPath
}) {
    manifestPath = manifestPath || visualSummaryManifestPath(targetDate);
    const id = normalizedId(arxivId);
    if (!CARD_KINDS.includes(kind)) throw new Error(`未知视觉摘要类型: ${kind}`);
    const asset = validatePngAsset(sourcePath);

    return updateJsonFileLocked(manifestPath, current => {
        if (!current || current.version !== MANIFEST_VERSION) throw new Error('请先执行视觉摘要 plan');
        const paper = current.papers?.[id];
        if (!paper) throw new Error(`manifest 中不存在论文: ${id}`);
        const currentCard = paper.cards?.[kind];
        if (!taskToken || currentCard?.taskToken !== taskToken) {
            throw new Error(`视觉摘要任务令牌已失效: ${id}/${kind}`);
        }
        if (currentCard.status === 'complete') {
            throw new Error(`视觉摘要已经完成，拒绝旧任务覆盖: ${id}/${kind}`);
        }

        const target = assertSafeAssetTarget(
            visualSummaryAssetPath(current.batchDate, id, kind, paper.rank, paper.title || ''),
            Config.FILES.visualSummaryAssetDir
        );
        const relative = path.relative(Config.PROJECT_ROOT, target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
        try {
            fs.writeFileSync(temp, asset.raw, { mode: 0o600 });
            fs.renameSync(temp, target);
        } finally {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }

        const next = structuredClone(current);
        next.updatedAt = getBeijingISOString();
        next.papers[id].cards[kind] = {
            status: 'complete',
            label: CARD_LABELS[kind],
            assetPath: relative.split(path.sep).join('/'),
            assetSha256: asset.sha256,
            analysisSha256: paper.analysisSha256,
            promptSha256: paper.promptSha256,
            taskToken,
            completedAt: getBeijingISOString()
        };
        return withManifestSummary(next);
    }, { allowMissing: false });
}

function markVisualSummaryCardFailed({ arxivId, kind, error, taskToken, targetDate, manifestPath }) {
    manifestPath = manifestPath || visualSummaryManifestPath(targetDate);
    const id = normalizedId(arxivId);
    if (!CARD_KINDS.includes(kind)) throw new Error(`未知视觉摘要类型: ${kind}`);
    return updateJsonFileLocked(manifestPath, current => {
        if (!current?.papers?.[id]) throw new Error(`manifest 中不存在论文: ${id}`);
        const currentCard = current.papers[id].cards?.[kind];
        if (!taskToken || currentCard?.taskToken !== taskToken) {
            throw new Error(`视觉摘要任务令牌已失效: ${id}/${kind}`);
        }
        if (currentCard.status === 'complete') {
            throw new Error(`视觉摘要已经完成，拒绝旧失败回写: ${id}/${kind}`);
        }
        const next = structuredClone(current);
        next.updatedAt = getBeijingISOString();
        next.papers[id].cards[kind] = {
            status: 'failed',
            label: CARD_LABELS[kind],
            taskToken,
            analysisSha256: currentCard.analysisSha256,
            promptSha256: currentCard.promptSha256,
            error: String(error || '生成失败').slice(0, 1000),
            failedAt: getBeijingISOString()
        };
        return withManifestSummary(next);
    }, { allowMissing: false });
}

function pendingVisualSummaryCards(manifest) {
    const pending = [];
    for (const [id, paper] of Object.entries(manifest?.papers || {})) {
        for (const kind of CARD_KINDS) {
            const expectedPath = visualSummaryAssetPath(
                manifest.batchDate, id, kind, paper.rank, paper.title || ''
            );
            if (!validateCompletedCard(
                paper.cards?.[kind], paper.analysisSha256, paper.promptSha256,
                paper.cards?.[kind]?.taskToken, expectedPath
            )) {
                const card = paper.cards?.[kind] || {};
                pending.push({
                    arxivId: id,
                    kind,
                    label: CARD_LABELS[kind],
                    title: paper.title,
                    taskToken: card.taskToken,
                    analysisSha256: paper.analysisSha256,
                    promptSha256: paper.promptSha256,
                    generationContext: {
                        ...(paper.generationContext || {}),
                        focus: CARD_LABELS[kind],
                        direction: CARD_DIRECTIONS[kind]
                    }
                });
            }
        }
    }
    return pending;
}

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = {};
    for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (!arg.startsWith('--') || i + 1 >= rest.length) throw new Error(`无效参数: ${arg}`);
        options[arg.slice(2)] = rest[++i];
    }
    return { command, options };
}

function main(argv = process.argv.slice(2)) {
    const { command, options } = parseArgs(argv);
    if (command === 'plan') {
        const publication = assertPublishedBlogReceipt(options.date, options.receipt);
        const manifest = planVisualSummaries({ targetDate: options.date, papers: bindPublishedPapersToDate(publication, options.date), manifestPath: options.manifest, publication });
        const pending = pendingVisualSummaryCards(manifest);
        console.log(`视觉摘要计划已更新：TOP ${manifest.selection.limit} 中选出 ${Object.keys(manifest.papers).length} 篇，待生成 ${pending.length} 张`);
        for (const item of pending) console.log(JSON.stringify(item));
        return;
    }
    if (command === 'archive-legacy') {
        const result = archiveLegacyVisualManifestAssets({
            targetDate: options.date,
            manifestPath: options.manifest,
            generationManifestPath: options.generation
        });
        console.log(`历史视觉资产已按日期归档：排行榜 ${result.rankedCount} 篇，额外图片 ${result.extraCount} 张`);
        return;
    }
    if (command === 'prepare') {
        const targetDate = options.date;
        if (!targetDate) throw new Error('prepare 必须传 --date YYYY-MM-DD');
        const publication = assertPublishedBlogReceipt(targetDate, options.receipt);
        const manifest = readJsonFileStrict(options.manifest || visualSummaryManifestPath(targetDate));
        assertVisualManifestCurrent(manifest, publication, targetDate);
        const prepared = prepareVisualReferenceInputs(manifest, {
            targetDate,
            paperId: options.paper
        });
        console.log(`已准备视觉参考图输入：${prepared.length} 篇`);
        for (const item of prepared) console.log(JSON.stringify(item));
        return;
    }
    if (command === 'record') {
        const publication = assertPublishedBlogReceipt(options.date, options.receipt);
        const current = readJsonFileStrict(options.manifest || visualSummaryManifestPath(options.date));
        assertVisualManifestCurrent(current, publication, options.date);
        recordVisualSummaryCard({
            arxivId: options.paper,
            kind: options.kind,
            sourcePath: options.file || extractGeneratedImagePathFromHint(options['output-hint']),
            taskToken: options.token,
            targetDate: options.date,
            manifestPath: options.manifest
        });
        console.log(`已登记视觉摘要: ${options.paper} ${options.kind}`);
        return;
    }
    if (command === 'fail') {
        const publication = assertPublishedBlogReceipt(options.date, options.receipt);
        const current = readJsonFileStrict(options.manifest || visualSummaryManifestPath(options.date));
        assertVisualManifestCurrent(current, publication, options.date);
        markVisualSummaryCardFailed({ arxivId: options.paper, kind: options.kind, error: options.error, taskToken: options.token, targetDate: options.date, manifestPath: options.manifest });
        console.log(`已记录视觉摘要失败: ${options.paper} ${options.kind}`);
        return;
    }
    if (command === 'status') {
        const targetDate = options.date;
        if (!targetDate) throw new Error('status 必须传 --date YYYY-MM-DD');
        const publication = assertPublishedBlogReceipt(targetDate, options.receipt);
        const manifest = readJsonFileStrict(options.manifest || visualSummaryManifestPath(targetDate));
        assertVisualManifestCurrent(manifest, publication, targetDate);
        const pending = pendingVisualSummaryCards(manifest);
        const total = Object.keys(manifest.papers || {}).length * CARD_KINDS.length;
        console.log(`视觉摘要：TOP ${manifest.selection.limit} 中选出 ${Object.keys(manifest.papers || {}).length} 篇，完成 ${total - pending.length}/${total} 张，待生成 ${pending.length} 张`);
        for (const item of pending) console.log(JSON.stringify(item));
        if (pending.length !== 0) process.exitCode = 1;
        return;
    }
    throw new Error('用法: visual-summary-state.js plan --date YYYY-MM-DD | prepare --date YYYY-MM-DD [--paper ID] | archive-legacy --date YYYY-MM-DD | record --date YYYY-MM-DD --paper ID --kind infographic (--file PNG | --output-hint HINT) --token TOKEN | fail --date YYYY-MM-DD --paper ID --kind infographic --error MESSAGE --token TOKEN | status --date YYYY-MM-DD');
}

if (require.main === module) main();

module.exports = {
    MANIFEST_VERSION,
    DEFAULT_SELECTION_LIMIT,
    CARD_KINDS,
    CARD_LABELS,
    CARD_DIRECTIONS,
    RENDERING_CONTRACT,
    analysisSha256,
    selectTopRankedPapers,
    bindPublishedPapersToDate,
    assertVisualManifestCurrent,
    cardTaskToken,
    legacyCardTaskToken,
    promptSha256,
    planVisualSummaries,
    recordVisualSummaryCard,
    markVisualSummaryCardFailed,
    pendingVisualSummaryCards,
    validateCompletedCard,
    validatePngAsset,
    visualSummaryAssetPath,
    visualAssetTitleSlug,
    migrateLegacyCompletedCard,
    archiveRemainingLegacyVisualAssets,
    archiveLegacyVisualManifestAssets,
    assertSafeAssetTarget,
    validatePngBuffer,
    extractGeneratedImagePathFromHint,
    selectVisualReferenceImages,
    validateReferenceImageBytes,
    prepareVisualReferenceInputs,
    validateDate,
    visualSummaryManifestPath,
    assertPublishedBlogReceipt,
    paperBatchDate,
    withManifestSummary,
    main
};

'use strict';
// 退役成图的只读核验；不创建任务、不取图、不写资产。原数值仅用于重放旧记录。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../config');
const originalFormat = require('../../config/historical-visual-formats.json');
const { normalizedId } = require('../utils');
const { isSuccessfulAnalysisRecord, hasValidIntegratedApiReaderRecords, readJsonFileStrict } = require('../analysis-engine');
const { sha256Buffer, stableJson, stableSha256, validateDate, paperBatchDate, validatePublishImageExclusions } = require('./published-blog-receipt');
const { promptFilePathForContract } = require('./prompt-contracts');
const { historicalPromptEvidenceBytesForSha256 } = require('./prompt-evidence');
const MANIFEST_FORMAT = originalFormat.paperManifestVersion;
const VISUAL_QA_CHECKLIST = originalFormat.paperQaChecklist;
const DEFAULT_SELECTION_LIMIT = 10;
const MAX_REFERENCE_IMAGES = 2;
const CARD_KINDS = Object.freeze(['infographic']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MIN_ASSET_WIDTH = 768;
const MIN_ASSET_HEIGHT = 1024;
const MIN_PORTRAIT_RATIO = 1.25;
const READER_VISUAL_SOURCE_CONTRACT = originalFormat.readerSourceContract;
const EPHEMERAL_READER_FIGURE_PERSISTENCE_CONTRACT = originalFormat.ephemeralFigurePersistenceContract;
const RENDERING_CONTRACT = Object.freeze({ ...originalFormat.rendering });
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();
const LLM_API_READER_CONTRACT = require('./protocol-codec').historicalContract('beginner-researcher', 'integrated-article');
const VISUAL_SUMMARY_PROMPT_STAGE = 'visualSummary';

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

function resolvedPromptSha256(declaredSha256, promptPath = null, declaration = null) {
    const declared = String(declaredSha256 || '');
    if (promptPath) return sha256Buffer(fs.readFileSync(promptPath));
    const relativePath = promptFilePathForContract(VISUAL_SUMMARY_PROMPT_STAGE, declaration);
    const raw = historicalPromptEvidenceBytesForSha256(declared, { relativePath });
    if (!raw) throw new Error('退役成图提示词没有匹配的原始 Git 字节');
    return sha256Buffer(raw);
}

function referenceFigureRole(caption) {
    const text = String(caption || '').toLowerCase();
    // “per-method EER”这类结果图注也含 method 一词。先认出明确的评测措辞，
    // 免得它压过真正的架构图。
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

function isModernReaderVisualPaper(paper) {
    return paper?.analysisManifest?.contracts?.apiReaderArticle === LLM_API_READER_CONTRACT
        || paper?.apiReaderPlan?.contract === LLM_API_READER_CONTRACT
        || paper?.apiReaderPlan?.version === 3;
}

function signedReaderVisualSource(paper) {
    if (paper?.latestAnalysisAttemptError || !hasValidIntegratedApiReaderRecords(paper)) {
        throw new Error(`${normalizedId(paper)} 视觉文案缺少有效已签 Reader，禁止回退 canonical 摘要`);
    }
    const plan = paper.apiReaderPlan, article = paper.apiReaderArticle;
    const headings = [...article.matchAll(/^### ([^\n]+)\n\n/gm)];
    if (!Array.isArray(plan.sections) || headings[0]?.index !== 0
        || headings.length !== plan.sections.length
        || new Set(plan.sections.map(section => section.heading)).size !== headings.length
        || typeof plan.oneSentenceThesis !== 'string' || !plan.oneSentenceThesis.trim()) {
        throw new Error('已核验的 Reader 正文标题、章节数或核心论点不符合配图文案的读取要求');
    }
    const sections = plan.sections.map((section, index) => {
        if (headings[index][1] !== section.heading) throw new Error('Reader 配图所用正文的章节标题或顺序与已保存计划不一致');
        const start = headings[index].index + headings[index][0].length;
        const end = index + 1 < headings.length ? headings[index + 1].index - 2 : article.length;
        const body = article.slice(start, end);
        if (!body.trim() || body !== body.trim()) throw new Error('Reader 配图所用章节正文为空，或首尾含多余空白');
        return { sectionIndex: index, kind: section.kind, heading: section.heading, body };
    });
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    if (!Number.isInteger(stage.imageEvidenceCount) || stage.imageEvidenceCount < paper.apiReaderFigures.length
        || !/^[a-f0-9]{64}$/.test(String(stage.imageEvidenceSha256 || ''))) {
        throw new Error('Reader 视觉来源缺少已签像素证据身份');
    }
    return { sections, sourceIdentity: {
        contract: READER_VISUAL_SOURCE_CONTRACT,
        articleSha256: paper.apiReaderArticleSha256,
        planSha256: paper.apiReaderPlanSha256,
        figuresSha256: stage.figuresSha256,
        sourceSha256: paper.sourceSha256,
        structuredArtifactsSha256: stage.structuredArtifactsSha256,
        imageEvidenceCount: stage.imageEvidenceCount,
        imageEvidenceSha256: stage.imageEvidenceSha256
    } };
}

function readSignedReaderVisualReference(reference, paperId) {
    const id = normalizedId(paperId);
    const url = new URL(String(reference.url || ''));
    const sourceId = url.pathname.match(/^\/html\/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?\//)?.[1];
    if (url.protocol !== 'https:' || !['arxiv.org', 'www.arxiv.org'].includes(url.hostname)
        || url.username || url.password || url.port || url.hash || url.search || sourceId !== id
        || !Number.isInteger(reference.ordinal) || reference.ordinal < 1
        || !/^[a-f0-9]{64}$/.test(String(reference.sourceDomSha256 || ''))
        || !/^[a-f0-9]{64}$/.test(String(reference.sha256 || ''))
        || reference.mime !== 'image/png') throw new Error('Reader 视觉原图 URL/ordinal/DOM/SHA 身份非法');
    const expected = path.resolve(Config.CURRENT_DIR, 'api-reader-assets', id,
        `figure-${reference.ordinal}-${reference.sha256.slice(0, 16)}.png`);
    const recorded = path.resolve(Config.PROJECT_ROOT, String(reference.cachePath || ''));
    if (recorded !== expected) throw new Error('Reader 视觉原图缓存路径不受控');
    // 从文件系统根目录开始逐级检查父目录，包括配置中的 current 目录。
    // 本函数只读取已有图片；图片记录和文件内容仍须通过下方的身份、大小和 SHA 检查。
    let cursor = path.parse(recorded).root;
    for (const part of path.dirname(recorded).slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Reader 视觉缓存父目录不安全');
    }
    const fd = fs.openSync(recorded, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ASSET_BYTES
            || stat.size !== reference.bytes) throw new Error('Reader 视觉缓存文件/大小非法');
        const raw = fs.readFileSync(fd);
        if (sha256Buffer(raw) !== reference.sha256) throw new Error('Reader 配图缓存文件的字节 SHA 与已保存记录不一致');
        validatePngBuffer(raw, { requirePortrait: false });
        return raw;
    } finally { fs.closeSync(fd); }
}

function selectVisualReferenceImages(paper, limit = MAX_REFERENCE_IMAGES) {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_REFERENCE_IMAGES) {
        throw new Error(`论文视觉参考图数量非法: ${limit}`);
    }
    const excludedUrls = new Set(
        validatePublishImageExclusions(paper).map(entry => entry.url)
    );
    if (isModernReaderVisualPaper(paper)) {
        signedReaderVisualSource(paper);
        if (paper?.analysisManifest?.contracts?.apiReaderFigurePersistence
            === EPHEMERAL_READER_FIGURE_PERSISTENCE_CONTRACT) {
            // 日更的封存来源解读在模型调用后会主动丢掉所有缓存路径和像素字节。
            // 发布后的视觉规划不能反过来要求这些已不存在的文件，也不能退回旧图片
            // 缓存。先核对长期保存的来源与像素身份，再只凭已核验文本生成信息图，
            // 不带任何图片引用。
            let sealedSource;
            const matchesSealedInlineSvg = figure => {
                const svg = require('./reader-inline-svg');
                if (figure.inlineSvgRenderContract !== svg.CONTRACT
                    || !/^[a-f0-9]{64}$/.test(String(figure.inlineSvgSourceSha256 || ''))) return false;
                if (!sealedSource) {
                    const daily = require('./daily-fresh-source-plan');
                    const runId = paper.freshRewriteProvenance?.runId;
                    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(runId || '')) return false;
                    const runDir = path.join(Config.FILES.dailyFreshSourceRunsDir, runId);
                    const run = readJsonFileStrict(path.join(runDir, 'run.json'));
                    const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
                    if (!daily.isPaperBoundToPlan(paper, plan)) return false;
                    sealedSource = daily.readDailyFreshSource(plan, paper);
                }
                const matches = (sealedSource.structuredArtifacts?.figures || []).filter(item =>
                    item.ordinal === figure.ordinal && item.recoveryStatus === 'complete'
                    && item.sourceDomSha256 === figure.sourceDomSha256 && item.images?.length === 1);
                if (matches.length !== 1) return false;
                const descriptor = svg.inlineSvgSourceDescriptor(matches[0].images[0], normalizedId(paper));
                return descriptor !== null && Object.entries(descriptor).every(([key, value]) => figure[key] === value);
            };
            for (const figure of paper.apiReaderFigures) {
                const url = new URL(String(figure?.url || ''));
                const sourceId = url.pathname.match(/^\/html\/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?\//)?.[1];
                const inline = Boolean(url.hash || figure?.inlineSvgSourceSha256 || figure?.inlineSvgRenderContract);
                if (url.protocol !== 'https:' || !['arxiv.org', 'www.arxiv.org'].includes(url.hostname)
                    || url.username || url.password || url.port || url.search
                    || (inline ? !matchesSealedInlineSvg(figure) : sourceId !== normalizedId(paper))
                    || !Number.isInteger(figure?.ordinal) || figure.ordinal < 1
                    || !/^[a-f0-9]{64}$/.test(String(figure?.sourceDomSha256 || ''))
                    || !/^[a-f0-9]{64}$/.test(String(figure?.assetSha256 || ''))
                    || !/^image\/(?:png|jpeg|webp|svg\+xml)$/
                        .test(String(figure?.mediaType || '').toLowerCase())) {
                    throw new Error('Reader ephemeral 视觉原图 URL/ordinal/DOM/SHA 身份非法');
                }
            }
            return [];
        }
        const references = paper.apiReaderFigures.map((figure, sourceOrder) => {
            const expectedFilename = `figure-${figure.ordinal}-${String(figure.assetSha256).slice(0, 16)}.png`;
            if (figure.assetFilename !== expectedFilename) throw new Error('Reader 配图原图文件名与图号及文件 SHA 对应的名称不一致');
            const role = ['method_overview', 'component', 'training'].includes(figure.targetKind)
                ? { role: 'method_reference', priority: 0 }
                : ['result', 'ablation', 'experiment_setup'].includes(figure.targetKind)
                    ? { role: 'result_reference', priority: 1 } : referenceFigureRole(figure.caption);
            const reference = { ...role, sourceOrder, sourceContract: READER_VISUAL_SOURCE_CONTRACT,
                ordinal: figure.ordinal, url: figure.url, caption: figure.caption,
                sourceDomSha256: figure.sourceDomSha256, targetKind: figure.targetKind,
                focusPoints: figure.focusPoints, explanationQuote: figure.explanationQuote,
                mime: figure.assetMediaType, bytes: figure.assetBytes, sha256: figure.assetSha256,
                cachePath: path.relative(Config.PROJECT_ROOT, figure.cachePath).split(path.sep).join('/') };
            readSignedReaderVisualReference(reference, normalizedId(paper));
            return reference;
        });
        return references.filter(reference => !excludedUrls.has(reference.url))
            .sort((a, b) => a.priority - b.priority || a.sourceOrder - b.sourceOrder).slice(0, limit);
    }
    const manifest = paper?.imageManifest || {};
    const selected = [...new Set([
        ...(Array.isArray(paper?.selectedImageUrls) ? paper.selectedImageUrls : []),
        ...(Array.isArray(manifest.selected) ? manifest.selected : [])
    ].map(value => String(value || '').trim()).filter(Boolean))]
        .filter(url => !excludedUrls.has(url));
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

function analysisSha256(paper) {
    if (isModernReaderVisualPaper(paper)) {
        const context = buildGenerationContext(paper);
        return stableSha256({ sourceIdentity: context.sourceIdentity, title: context.title,
            generationContextSha256: stableSha256(context),
            documentType: context.documentType, primaryTask: context.primaryTask, primaryMethod: context.primaryMethod,
            score: paper.parsed?.score, publishImageExclusions: validatePublishImageExclusions(paper),
            referenceImages: context.referenceImages, rendering: RENDERING_CONTRACT });
    }
    return stableSha256({
        arxivId: normalizedId(paper),
        analysis: paper.analysis,
        parsed: paper.parsed || null,
        analysisSource: paper.analysisSource || null,
        analysisSourceSha256: paper.analysisSourceSha256 || paper.sourceSha256 || null,
        scoringAudit: paper.analysisManifest?.stages?.scoringAudit || null,
        publishImageExclusions: validatePublishImageExclusions(paper),
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
        manifestVersion: MANIFEST_FORMAT,
        arxivId: id,
        kind,
        rank,
        analysisSha256: expectedAnalysisSha,
        promptSha256: expectedPromptSha,
        publicationCommit: publication?.publicationCommit || null,
        generationManifestSha256: publication?.generationManifestSha256 || null
    });
}

function readControlledVisualPng(filename, root) {
    assertSafeAssetTarget(filename, root);
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.size > RENDERING_CONTRACT.maxPngBytes) {
            throw new Error(`视觉摘要PNG不是普通文件或超过大小限制：${filename}`);
        }
        const raw = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < raw.length) {
            const read = fs.readSync(fd, raw, length, raw.length - length, length);
            if (read === 0) break;
            length += read;
        }
        const after = fs.fstatSync(fd);
        assertSafeAssetTarget(filename, root);
        const named = fs.lstatSync(filename);
        if (!named.isFile() || length !== before.size
            || [after, named].some(stat => stat.dev !== before.dev || stat.ino !== before.ino
                || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs
                || stat.ctimeMs !== before.ctimeMs)) {
            throw new Error(`视觉摘要PNG在读取期间发生变化：${filename}`);
        }
        const bytes = raw.subarray(0, length);
        validatePngBuffer(bytes);
        return bytes;
    } finally {
        fs.closeSync(fd);
    }
}

function validateCompletedCard(card, expectedAnalysisSha, expectedPromptSha, expectedTaskToken = null, expectedPath = null) {
    if (!card || card.status !== 'complete') return false;
    if (card.qaAttestation?.attested !== true
        || card.qaAttestation?.checklistVersion !== VISUAL_QA_CHECKLIST
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00$/.test(
            String(card.qaAttestation?.attestedAt || '')
        )) return false;
    if (card.analysisSha256 !== expectedAnalysisSha || card.promptSha256 !== expectedPromptSha) return false;
    if (expectedTaskToken && card.taskToken !== expectedTaskToken) return false;
    if (typeof card.assetPath !== 'string' || !card.assetPath) return false;
    const absolute = path.resolve(Config.PROJECT_ROOT, card.assetPath);
    const allowedRoot = path.resolve(Config.FILES.visualSummaryAssetDir);
    if (absolute !== allowedRoot && !absolute.startsWith(`${allowedRoot}${path.sep}`)) return false;
    if (expectedPath && absolute !== path.resolve(expectedPath)) return false;
    try {
        const raw = readControlledVisualPng(absolute, Config.FILES.visualSummaryAssetDir);
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

function visualSummaryArchiveRoot(targetDate) {
    return path.resolve(
        Config.FILES.visualSummaryAssetDir, validateDate(targetDate), 'visual-summaries'
    );
}

function assertVisualArchiveUniqueness(manifest) {
    const targetDate = validateDate(manifest?.batchDate);
    const root = visualSummaryArchiveRoot(targetDate);
    const expected = new Set();
    for (const [id, paper] of Object.entries(manifest?.papers || {})) {
        for (const [kind, card] of Object.entries(paper.cards || {})) {
            if (card?.status !== 'complete') continue;
            expected.add(path.resolve(
                visualSummaryAssetPath(targetDate, id, kind, paper.rank, paper.title || '')
            ));
        }
    }
    if (!fs.existsSync(root)) {
        if (expected.size > 0) throw new Error(`视觉摘要归档目录缺失: ${root}`);
        return true;
    }
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`视觉摘要归档目录不得是符号链接: ${root}`);
    for (const item of manifest?.legacyUnrankedAssets || []) {
        const relative = typeof item === 'string' ? item : item?.assetPath;
        const resolved = path.resolve(Config.PROJECT_ROOT, String(relative || ''));
        const relativeToRoot = path.relative(root, resolved);
        if (!String(relativeToRoot).startsWith('unranked-')
            || path.extname(relativeToRoot).toLowerCase() !== '.png'
            || path.dirname(resolved) !== path.resolve(root)
            || !fs.existsSync(resolved)) {
            throw new Error(`视觉摘要 legacy unranked 资产路径无效或缺失: ${relative}`);
        }
        if (typeof item === 'object' && item.assetSha256
            && sha256Buffer(fs.readFileSync(resolved)) !== item.assetSha256) {
            throw new Error(`视觉摘要 legacy unranked 资产 SHA 不匹配: ${relative}`);
        }
        expected.add(resolved);
    }
    const extras = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || path.extname(entry.name).toLowerCase() !== '.png') continue;
        if (entry.name === `00-digest-cover-${targetDate}.png`) continue;
        if (!expected.has(path.resolve(root, entry.name))) {
            extras.push(entry.name);
        }
    }
    if (extras.length) {
        throw new Error(`视觉摘要归档存在未登记或重复的排行榜 PNG: ${extras.sort().join(', ')}`);
    }
    return true;
}

function buildGenerationContext(paper) {
    const parsed = paper.parsed || {};
    if (isModernReaderVisualPaper(paper)) {
        const { sections, sourceIdentity } = signedReaderVisualSource(paper);
        const select = kinds => sections.filter(section => kinds.includes(section.kind));
        const methods = select(['method_overview', 'component', 'training', 'reproduction']);
        const results = select(['experiment_setup', 'result', 'ablation']);
        const limits = select(['limitation', 'synthesis']);
        if (!methods.length || !results.length || !limits.length) throw new Error('Reader 视觉来源缺少方法/实验/边界章节');
        const blocks = items => items.map(section => `### ${section.heading}\n\n${section.body}`).join('\n\n');
        const claims = items => items.map(section => ({ sectionIndex: section.sectionIndex,
            kind: section.kind, heading: section.heading, bodySha256: sha256Buffer(Buffer.from(section.body)) }));
        const referenceImages = selectVisualReferenceImages(paper);
        return {
            title: String(paper.title || ''), documentType: String(parsed.documentType || ''),
            primaryTask: String(parsed.primaryTaskTag || ''), primaryMethod: String(parsed.primaryMethodTag || ''),
            summary: paper.apiReaderPlan.oneSentenceThesis,
            method: blocks(methods), experiments: blocks(results), limitations: blocks(limits),
            readerBackground: blocks(select(['background', 'related_work', 'problem'])),
            sourceIdentity, referenceImages,
            qaClaims: { exactEnglishTitle: String(paper.title || ''), bodyLanguage: '简体中文',
                requiredSections: ['研究问题与核心贡献', '方法模块与信号流', '关键实验发现', '结论与局限'],
                sourceContract: READER_VISUAL_SOURCE_CONTRACT,
                // 引用完整的已核验小节，可以避免截掉表格的列与单位，也能避免
                // 按前 N 行截断时丢掉反例。
                methodClaims: claims(methods), metricClaims: claims(results), limitationClaims: claims(limits),
                referenceCaptions: referenceImages.map(item => item.caption) },
            rendering: RENDERING_CONTRACT
        };
    }
    const cleanLines = value => String(value || '')
        .split(/\n+/)
        .map(line => line.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
            .replace(/^[\s>*#-]+/, '')
            .replace(/[*_`|]/g, '')
            .replace(/\s+/g, ' ')
            .trim())
        .filter(line => line.length >= 16);
    const methodClaims = cleanLines(parsed.architecture || parsed.details).slice(0, 4);
    const metricClaims = cleanLines(parsed.results)
        .filter(line => /\d/.test(line))
        .slice(0, 8);
    const limitationClaims = cleanLines(parsed.limitations).slice(0, 4);
    const referenceImages = selectVisualReferenceImages(paper);
    return {
        title: String(paper.title || ''),
        documentType: String(parsed.documentType || ''),
        primaryTask: String(parsed.primaryTaskTag || ''),
        primaryMethod: String(parsed.primaryMethodTag || ''),
        summary: String(parsed.summary || ''),
        method: String(parsed.architecture || parsed.details || ''),
        experiments: String(parsed.results || ''),
        limitations: String(parsed.limitations || ''),
        referenceImages,
        qaClaims: {
            exactEnglishTitle: String(paper.title || ''),
            bodyLanguage: '简体中文',
            requiredSections: ['研究问题与核心贡献', '方法模块与信号流', '关键实验发现', '结论与局限'],
            methodClaims,
            metricClaims,
            limitationClaims,
            referenceCaptions: referenceImages.map(item => item.caption)
        },
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
    if (!manifest || manifest.version !== MANIFEST_FORMAT || manifest.batchDate !== targetDate
        || manifest.publication?.publicationCommit !== publication.publicationCommit
        || manifest.publication?.generationManifestSha256 !== publication.generationManifestSha256) {
        throw new Error('视觉摘要 manifest 与当前已发布博客版本不一致，请重新执行发布后规划');
    }
    const papers = bindPublishedPapersToDate(publication, targetDate);
    const limit = Number(manifest.selection?.limit);
    if (!Number.isInteger(limit) || limit !== DEFAULT_SELECTION_LIMIT) {
        throw new Error('视觉摘要清单中的论文选择上限不是规定的 TOP 10，请重新执行发布后规划');
    }
    const selected = selectTopRankedPapers(papers, targetDate, limit);
    const currentPromptSha = resolvedPromptSha256(
        manifest.promptSha256, promptPath, manifest.promptTextContract);
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
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
        throw new Error(`视觉资产目标不得是符号链接: ${target}`);
    }
    return target;
}

module.exports = { selectVisualReferenceImages, DEFAULT_SELECTION_LIMIT, RENDERING_CONTRACT, assertSafeAssetTarget, assertVisualArchiveUniqueness, assertVisualManifestCurrent, bindPublishedPapersToDate, cardTaskToken, validateCompletedCard, validatePngBuffer, visualSummaryAssetPath };

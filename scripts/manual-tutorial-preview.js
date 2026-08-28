#!/usr/bin/env node
'use strict';

/**
 * Isolated, single-paper Manual tutorial preview.
 *
 * This is deliberately not a publisher: it reads one filtered entry, one
 * canonical entry and one ArtifactIndex, then writes only an ephemeral preview
 * under data/current/manual-tutorial-previews.  It never opens the Hugo blog
 * repository, changes canonical data, creates images, or schedules other
 * papers.
 *
 * The default path is the formal tutorial quality and artifact-plan contracts.
 * The `qualityAdapter` and `artifactPlanAdapter` options are injection seams
 * for isolated tests only.  A custom quality adapter must implement
 *   validate({ article, articleSha256, quality, paper, artifactIndex, artifactPlan })
 * and return the same normalized presentation object.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('manual-tutorial-preview.js');
}

const Config = require('./config.js');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('./utils.js');
const {
    buildTutorialArtifactPlan,
    validateTutorialArtifactPlan
} = require('./manual-tutorial-artifacts.js');
const {
    MANUAL_TUTORIAL_QUALITY_CONTRACT,
    validateTutorialPayloadBundle
} = require('./manual-tutorial-contract-orchestrator.js');
const { stableSha256 } = require('./manual-fresh-authoring-contract.js');
const {
    MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
    validateTutorialPayloadReceipt
} = require('./manual-v5-tutorial-payload.js');

const PREVIEW_VERSION = 5;
const PREVIEW_MODE = 'manual_tutorial_preview';
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const EDITORIAL_CONTRACT_PATH = path.resolve(__dirname, '..', 'prompts', 'manual-tutorial-article.md');
const REFERENCE_CONTRACT_PATH = path.resolve(__dirname, '..', 'docs', 'manual-editorial-reference-contract.md');
const QUALITY_SCHEMA_PATH = path.resolve(__dirname, 'manual-tutorial-quality-contract.js');
const SCORE_DIMENSIONS = Object.freeze([
    ['innovationScore', '创新', 2],
    ['technicalRigorScore', '技术严谨', 1.5],
    ['experimentalSufficiencyScore', '实验充分', 1.5],
    ['clarityScore', '清晰度', 1],
    ['impactScore', '影响力', 1.5],
    ['openSourceScore', '开源', 1.5],
    ['reproducibilityScore', '可复现', 0.5],
    ['engineeringScore', '工程/实践', 1.5]
]);

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
    return sha256(fs.readFileSync(filePath));
}

function readJson(filePath, label) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`${label} 无法读取为 JSON: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 顶层必须是对象`);
    }
    return value;
}

function assertDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
        throw new Error('--date 必须是 YYYY-MM-DD');
    }
    return String(value);
}

function assertPaperId(value) {
    const id = normalizedId(value);
    if (!id) throw new Error('--paper-id 必须是合法 arXiv ID');
    return id;
}

function assertNonEmptyText(value, label, minimum = 1) {
    if (typeof value !== 'string' || value.trim().length < minimum) {
        throw new Error(`${label} 必须是至少 ${minimum} 字符的非空文本`);
    }
    return value.trim();
}

function textFrom(value, aliases, label, minimum = 1) {
    for (const key of aliases) {
        if (typeof value?.[key] === 'string' && value[key].trim().length >= minimum) {
            return value[key].trim();
        }
    }
    throw new Error(`${label} 缺少 ${aliases.join('/')}`);
}

function normalizeTags(value, fallback) {
    const raw = value ?? fallback;
    const tags = Array.isArray(raw)
        ? raw
        : (typeof raw === 'string' ? raw.split(/[\s,，]+/) : []);
    const normalized = [...new Set(tags.map(item => String(item || '').trim()).filter(Boolean))];
    if (normalized.length === 0) throw new Error('quality.tags 或 canonical tags 不能为空');
    return normalized;
}

function normalizePeople(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean).join('；');
    return typeof value === 'string' ? value.trim() : '';
}

function findPaper(payload, id, label) {
    const papers = Array.isArray(payload?.papers) ? payload.papers : [];
    const paper = papers.find(item => normalizedId(item) === id);
    if (!paper) throw new Error(`${label} 不包含论文 ${id}`);
    return paper;
}

function safeArtifactPath(artifactManifestPath, entryPath) {
    if (typeof entryPath !== 'string' || !entryPath) throw new Error('ArtifactIndex manifest 缺少单篇路径');
    const manifestDir = path.dirname(path.resolve(artifactManifestPath));
    const candidate = path.resolve(manifestDir, entryPath);
    // Existing manifests generally store absolute paths; relative paths must
    // still be confined to the artifact directory.
    const resolved = path.isAbsolute(entryPath) ? path.resolve(entryPath) : candidate;
    const relative = path.relative(manifestDir, resolved);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('ArtifactIndex 单篇路径逃逸 artifact 目录');
    }
    return resolved;
}

function artifactInventorySummary(index) {
    const count = key => Array.isArray(index?.[key]) ? index[key].length : 0;
    const numericCells = (index?.tables || []).reduce((total, table) => (
        total + (Array.isArray(table?.cells)
            ? table.cells.filter(cell => /(?:^|_)\d+$/.test(String(cell?.id || ''))
                && /^[-+]?\d/.test(String(cell?.text || cell?.value || '').trim())).length
            : 0)
    ), 0);
    return {
        status: index?.inventoryHealth?.status || 'unknown',
        tables: count('tables'), figures: count('figures'), formulas: count('formulas'),
        terms: count('acronyms'), citations: count('citations'), references: count('references'),
        numericCells
    };
}

function loadArtifact(artifactManifestPath, id) {
    const manifestBytes = fs.readFileSync(artifactManifestPath);
    const manifest = readJson(artifactManifestPath, 'ArtifactIndex manifest');
    const entry = manifest?.papers?.[id];
    if (!entry || !['complete', 'incomplete'].includes(entry.status)) {
        throw new Error(`ArtifactIndex manifest 没有 ${id} 的可读 checkpoint`);
    }
    const artifactPath = safeArtifactPath(artifactManifestPath, entry.path);
    if (!fs.existsSync(artifactPath) || fs.lstatSync(artifactPath).isSymbolicLink()) {
        throw new Error(`${id} ArtifactIndex 文件不存在或为符号链接`);
    }
    const artifactBytes = fs.readFileSync(artifactPath);
    const artifactSha256 = sha256(artifactBytes);
    if (entry.outputSha256 && entry.outputSha256 !== artifactSha256) {
        throw new Error(`${id} ArtifactIndex 文件 SHA 与 manifest 不一致`);
    }
    const index = readJson(artifactPath, `${id} ArtifactIndex`);
    if (normalizedId(index.paperId) !== id) throw new Error(`${id} ArtifactIndex paperId 不一致`);
    return {
        manifest, manifestSha256: sha256(manifestBytes), entry, path: artifactPath,
        index, artifactSha256, inventory: artifactInventorySummary(index)
    };
}

const defaultArtifactAdapter = Object.freeze({
    name: 'artifact-index-file-v1',
    load({ artifactManifestPath, id }) {
        return loadArtifact(artifactManifestPath, id);
    }
});

const defaultArtifactPlanAdapter = Object.freeze({
    name: 'manual-tutorial-artifacts-v1',
    build({ artifactIndex }) {
        const plan = buildTutorialArtifactPlan(artifactIndex);
        validateTutorialArtifactPlan(artifactIndex, plan);
        return plan;
    }
});

function scoreText(value, fallback) {
    const score = value ?? fallback;
    if (typeof score === 'number' && Number.isFinite(score)) return `${score}/10`;
    if (typeof score === 'string' && score.trim()) return score.trim();
    if (score && typeof score === 'object') {
        if (typeof score.text === 'string' && score.text.trim()) return score.text.trim();
        if (Number.isFinite(score.total)) return `${score.total}/10`;
    }
    throw new Error('quality.score 或 canonical score 不能为空');
}

function normalizeScoreBreakdown(value, parsed) {
    const supplied = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return SCORE_DIMENSIONS.map(([key, label, maximum]) => {
        const raw = supplied[key] ?? parsed?.[key];
        const score = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
        if (!Number.isFinite(score) || score < 0 || score > maximum) {
            throw new Error(`八维评分缺少或越界: ${key}=${raw ?? 'missing'}，允许 0-${maximum}`);
        }
        return { key, label, score, maximum };
    });
}

function defaultQualityAdapter({
    article, articleSha256, quality, paper, filteredPaper, artifactIndex,
    artifactPlan, paperId, formalValidation
}) {
    if (quality.articleSha256 !== undefined && quality.articleSha256 !== articleSha256) {
        throw new Error('quality.articleSha256 与 ARTICLE.md 不一致');
    }
    if (normalizedId(quality.paperId) !== paperId) throw new Error('quality.paperId 必须与 --paper-id 一致');
    const formal = formalValidation || validateTutorialPayloadBundle({
        paperId,
        article,
        qualityPacket: quality,
        artifactPlan,
        artifactIndex,
        articleFileSha256: articleSha256,
        requireScorePresentation: true
    });
    const qualityValidation = formal.quality;
    if (qualityValidation.paperId !== paperId) throw new Error('tutorial quality contract 返回了其他论文 ID');
    const parsed = paper?.parsed && typeof paper.parsed === 'object' ? paper.parsed : {};
    const authorFallback = paper?.authors || parsed.authors || filteredPaper?.authors;
    const institutionsFallback = paper?.institutions || paper?.authorInfo?.institutions || '';
    const presentation = quality.presentation && typeof quality.presentation === 'object'
        ? { ...quality, ...quality.presentation } : quality;
    const authors = normalizePeople(presentation.authors ?? authorFallback);
    const institutions = normalizePeople(presentation.institutions ?? institutionsFallback);
    if (!authors) throw new Error('quality.authors 或 canonical authors 不能为空');
    if (!institutions) throw new Error('quality.institutions 或 canonical institutions 不能为空');
    const titleZh = textFrom(presentation, ['titleZh', 'chineseTitle', 'readerTitle'], 'quality', 4);
    const score = scoreText(presentation.score, parsed.score || paper?.score);
    const scoreBreakdown = normalizeScoreBreakdown(presentation.scoreBreakdown, parsed);
    const dimensionTotal = scoreBreakdown.reduce((sum, item) => sum + item.score, 0);
    const displayedTotal = Number.parseFloat(score);
    if (!Number.isFinite(displayedTotal) || Math.abs(Math.min(10, dimensionTotal) - displayedTotal) > 0.05) {
        throw new Error(`总分与八维分项不一致: displayed=${score}, dimensions=${dimensionTotal.toFixed(1)}`);
    }
    return {
        adapter: MANUAL_TUTORIAL_QUALITY_CONTRACT,
        qualityValidation,
        titleZh,
        oneSentence: textFrom(presentation, ['oneSentence', 'oneSentenceThesis'], 'quality', 12),
        roast: textFrom(presentation, ['roast', 'roastComment'], 'quality', 24),
        coreSummary: textFrom(presentation, ['coreSummary', 'summary'], 'quality', 24),
        openSource: textFrom(presentation, ['openSource', 'openSourceResources', 'opensource'], 'quality', 2),
        scoringEvidence: textFrom(presentation, ['scoringEvidence', 'scoreEvidence'], 'quality', 24),
        tags: normalizeTags(presentation.tags, parsed.tags || paper?.tags || filteredPaper?.tags),
        score,
        scoreBreakdown,
        authors,
        institutions,
        freshAuthoringContract: quality.freshAuthoring?.contract || null,
        article
    };
}

function validateWithAdapter(options) {
    // The formal contract is unconditional.  Adapters may only override
    // presentation fields after the exact article has passed the production
    // quality/fresh-authoring gates; they can never replace those gates.
    const formal = defaultQualityAdapter(options);
    const adapter = options.qualityAdapter;
    if (!adapter) return formal;
    if (!adapter || typeof adapter.validate !== 'function') {
        throw new Error('qualityAdapter 必须提供 validate(context)；接口见 manual-tutorial-preview.js 注释');
    }
    const normalized = adapter.validate({ ...options, formalPresentation: formal });
    if (!normalized || typeof normalized !== 'object') throw new Error('qualityAdapter 必须返回 presentation 对象');
    for (const key of ['titleZh', 'oneSentence', 'roast', 'coreSummary', 'openSource', 'scoringEvidence', 'authors', 'institutions', 'score']) {
        assertNonEmptyText(normalized[key], `qualityAdapter.${key}`, key === 'openSource' ? 2 : 4);
    }
    if (!Array.isArray(normalized.tags) || normalized.tags.length === 0) {
        throw new Error('qualityAdapter.tags 必须是非空数组');
    }
    if (!Array.isArray(normalized.scoreBreakdown) || normalized.scoreBreakdown.length !== SCORE_DIMENSIONS.length) {
        throw new Error('qualityAdapter.scoreBreakdown 必须完整覆盖八维评分');
    }
    // The preview must render the exact ARTICLE.md bytes that were quality
    // checked.  A custom adapter may enrich presentation fields but cannot
    // silently substitute another draft.
    return { ...normalized, article: options.article };
}

function renderPreview(paper, presentation, id, date, tutorialPayload) {
    const englishTitle = assertNonEmptyText(paper?.title, 'canonical title', 3);
    if (!tutorialPayload || tutorialPayload.contract !== MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT) {
        throw new Error('renderPreview 必须绑定 sealed Manual v5 tutorial payload');
    }
    for (const field of [
        'freshAuthoringReceiptSha256', 'articleSha256', 'receiptSha256',
        'qualityPacketSha256', 'artifactPlanSha256'
    ]) {
        if (!SHA256_RE.test(String(tutorialPayload[field] || ''))) {
            throw new Error(`tutorial payload 缺少合法 SHA: ${field}`);
        }
    }
    const tags = presentation.tags.map(tag => `#${String(tag).replace(/^#/, '')}`).join(' ');
    const yamlTags = JSON.stringify(presentation.tags.map(tag => String(tag).replace(/^#/, '')));
    const scoreBreakdown = presentation.scoreBreakdown
        .map(item => `${item.label} ${item.score}/${item.maximum}`)
        .join(' ｜ ');
    return [
        '---',
        `title: ${JSON.stringify(presentation.titleZh)}`,
        `date: ${assertDate(date)}`,
        'draft: false',
        `tags: ${yamlTags}`,
        'categories: ["论文速递"]',
        `description: ${JSON.stringify(presentation.oneSentence)}`,
        'hiddenInHomeList: true',
        'paper_digest_pipeline_owned: true',
        'paper_digest_page_type: paper',
        `paper_digest_arxiv_id: ${JSON.stringify(id)}`,
        'paper_digest_manual_depth: "graduate-researcher-tutorial-v1"',
        `paper_digest_tutorial_contract: ${JSON.stringify(MANUAL_TUTORIAL_QUALITY_CONTRACT)}`,
        ...(presentation.freshAuthoringContract
            ? [`paper_digest_fresh_authoring_contract: ${JSON.stringify(presentation.freshAuthoringContract)}`]
            : []),
        `paper_digest_tutorial_payload_contract: ${JSON.stringify(tutorialPayload.contract)}`,
        `paper_digest_fresh_authoring_sha256: ${JSON.stringify(tutorialPayload.freshAuthoringReceiptSha256)}`,
        `paper_digest_reader_article_sha256: ${JSON.stringify(tutorialPayload.articleSha256)}`,
        `paper_digest_tutorial_payload_sha256: ${JSON.stringify(tutorialPayload.receiptSha256)}`,
        `paper_digest_tutorial_quality_sha256: ${JSON.stringify(tutorialPayload.qualityPacketSha256)}`,
        `paper_digest_tutorial_artifact_plan_sha256: ${JSON.stringify(tutorialPayload.artifactPlanSha256)}`,
        '---',
        '',
        `# ${presentation.titleZh}`,
        '',
        `> 英文题目：*${englishTitle}*`,
        `> arXiv：[${id}](https://arxiv.org/abs/${id})`,
        '',
        `**标签：** ${tags}`,
        '',
        `**评分：** **${presentation.score}**`,
        '',
        `**八维分项：** ${scoreBreakdown}`,
        '',
        `**作者与机构：** ${presentation.authors}`,
        '',
        `**机构：** ${presentation.institutions}`,
        '',
        `**一句话概括：** ${presentation.oneSentence}`,
        '',
        '## 💬 毒舌点评',
        '',
        presentation.roast,
        '',
        '## 📌 核心摘要',
        '',
        presentation.coreSummary,
        '',
        '## 🔗 开源与复现资源',
        '',
        presentation.openSource,
        '',
        '## 🧭 深度解读',
        '',
        // Do not nest/rewrite author text: this preview is specifically for
        // assessing the exact long article that will later be approved.
        presentation.article.trim(),
        '',
        '## ⚖️ 评分依据与证据',
        '',
        presentation.scoringEvidence,
        ''
    ].join('\n');
}

function outputPaths(previewRoot, date, id) {
    const root = path.resolve(previewRoot);
    const outputDir = path.resolve(root, date, id);
    const relative = path.relative(root, outputDir);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('preview 输出路径逃逸受控目录');
    }
    return { outputDir, postPath: path.join(outputDir, 'post.md'), manifestPath: path.join(outputDir, 'manifest.json') };
}

function previewInputFingerprint(value) {
    return sha256(Buffer.from(JSON.stringify(value)));
}

function authoringInputPath(value, label) {
    const text = assertNonEmptyText(value, label, 1);
    return path.resolve(PROJECT_ROOT, text);
}

function assertFreshAuthoringInputBindings(quality, expectedInputs) {
    const fresh = quality?.freshAuthoring;
    if (!fresh || fresh.contract !== 'fresh-authoring-v1') {
        throw new Error('教程预览必须提供 fresh-authoring-v1 权威输入凭证');
    }
    if (!Array.isArray(fresh.inputs)) throw new Error('freshAuthoring.inputs 必须是数组');
    const byKind = new Map();
    for (const [index, input] of fresh.inputs.entries()) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error(`freshAuthoring.inputs[${index}] 必须是对象`);
        }
        if (byKind.has(input.kind)) throw new Error(`freshAuthoring.inputs 不得重复 kind=${input.kind}`);
        byKind.set(input.kind, input);
    }
    for (const [kind, expected] of Object.entries(expectedInputs)) {
        const actual = byKind.get(kind);
        if (!actual) throw new Error(`freshAuthoring.inputs 缺少权威输入 kind=${kind}`);
        const actualPath = authoringInputPath(actual.path, `freshAuthoring.inputs.${kind}.path`);
        if (actualPath !== path.resolve(expected.path)) {
            throw new Error(`freshAuthoring.inputs.${kind}.path 未绑定当前权威文件`);
        }
        if (actual.sha256 !== expected.sha256) {
            throw new Error(`freshAuthoring.inputs.${kind}.sha256 未绑定当前权威文件`);
        }
    }
    if (fresh.inputs.length !== Object.keys(expectedInputs).length) {
        throw new Error('freshAuthoring.inputs 只能包含当前权威 metadata、全文、ArtifactIndex、prompt、编辑契约和空白 schema');
    }
}

function buildTutorialPreview(options) {
    const date = assertDate(options.date);
    const id = assertPaperId(options.paperId);
    const filteredPath = path.resolve(options.filteredPath || Config.FILES.filteredPapers);
    const canonicalPath = path.resolve(options.canonicalPath || Config.FILES.deepAnalysisResult);
    const artifactManifestPath = path.resolve(options.artifactManifestPath
        || path.join(Config.CURRENT_DIR, 'manual-full-text', date, 'artifacts', 'manifest.json'));
    const articlePath = path.resolve(options.articlePath);
    const qualityPath = path.resolve(options.qualityPath);
    const previewRoot = path.resolve(options.previewRoot || path.join(Config.CURRENT_DIR, 'manual-tutorial-previews'));
    const paths = outputPaths(previewRoot, date, id);
    const expectedArticlePath = path.join(paths.outputDir, 'draft', 'article.md');
    const expectedQualityPath = path.join(paths.outputDir, 'quality.json');
    const artifactPlanPath = path.join(paths.outputDir, 'artifact-plan.json');
    if (articlePath !== expectedArticlePath || qualityPath !== expectedQualityPath) {
        throw new Error(`教程预览只接受受控 fresh draft：${expectedArticlePath} 与 ${expectedQualityPath}`);
    }
    if (!fs.existsSync(articlePath) || !fs.existsSync(qualityPath)) throw new Error('--article 与 --quality 必须是存在的文件');
    if (fs.lstatSync(articlePath).isSymbolicLink() || fs.lstatSync(qualityPath).isSymbolicLink()) {
        throw new Error('fresh article/quality 不得使用符号链接');
    }

    const filteredBytes = fs.readFileSync(filteredPath);
    const filtered = readJson(filteredPath, 'filtered-papers');
    if (filtered.status !== 'complete' || filtered.batchDate !== date) {
        throw new Error(`filtered-papers 必须是 ${date} complete 批次`);
    }
    const filteredPaper = findPaper(filtered, id, 'filtered-papers');
    const canonicalBytes = fs.readFileSync(canonicalPath);
    const canonical = readJson(canonicalPath, 'canonical');
    const paper = findPaper(canonical, id, 'canonical');
    const artifactAdapter = options.artifactAdapter || defaultArtifactAdapter;
    if (!artifactAdapter || typeof artifactAdapter.load !== 'function') {
        throw new Error('artifactAdapter 必须提供 load({ artifactManifestPath, id })；接口见 manual-tutorial-preview.js 注释');
    }
    const artifact = artifactAdapter.load({ artifactManifestPath, id });
    if (!artifact || !artifact.index || !SHA256_RE.test(String(artifact.artifactSha256 || ''))
        || !SHA256_RE.test(String(artifact.manifestSha256 || ''))) {
        throw new Error('artifactAdapter 返回缺少绑定 SHA 的 ArtifactIndex');
    }
    const artifactPlanAdapter = options.artifactPlanAdapter || defaultArtifactPlanAdapter;
    if (!artifactPlanAdapter || typeof artifactPlanAdapter.build !== 'function') {
        throw new Error('artifactPlanAdapter 必须提供 build({ artifactIndex })；接口见 manual-tutorial-preview.js 注释');
    }
    const artifactPlan = artifactPlanAdapter.build({ artifactIndex: artifact.index, paperId: id });
    validateTutorialArtifactPlan(artifact.index, artifactPlan);
    if (normalizedId(artifactPlan.paperId) !== id) throw new Error('artifact plan paperId 必须与 --paper-id 一致');
    const artifactPlanSha256 = sha256(JSON.stringify(artifactPlan));
    writeFileAtomic(artifactPlanPath, `${JSON.stringify(artifactPlan, null, 2)}\n`);
    const articleBytes = fs.readFileSync(articlePath);
    const article = assertNonEmptyText(articleBytes.toString('utf8'), 'ARTICLE.md', 120);
    const qualityBytes = fs.readFileSync(qualityPath);
    const quality = readJson(qualityPath, 'quality');
    const articleSha256 = sha256(articleBytes);
    const editorialContractBytes = fs.readFileSync(EDITORIAL_CONTRACT_PATH);
    const referenceContractBytes = fs.readFileSync(REFERENCE_CONTRACT_PATH);
    const qualitySchemaBytes = fs.readFileSync(QUALITY_SCHEMA_PATH);
    const fulltextManifestPath = path.resolve(path.dirname(artifactManifestPath), '..', 'manifest.json');
    const fulltextManifest = readJson(fulltextManifestPath, 'manual fulltext manifest');
    const fulltextEntry = fulltextManifest?.papers?.[id];
    if (!fulltextEntry || fulltextEntry.status !== 'complete') {
        throw new Error(`manual fulltext manifest 没有 ${id} 的 complete 权威来源`);
    }
    const sourceSnapshotPath = path.resolve(assertNonEmptyText(fulltextEntry.path, 'manual fulltext path', 1));
    if (!fs.existsSync(sourceSnapshotPath) || fs.lstatSync(sourceSnapshotPath).isSymbolicLink()) {
        throw new Error(`${id} 权威全文不存在或为符号链接`);
    }
    const sourceSnapshotSha256 = sha256File(sourceSnapshotPath);
    if (fulltextEntry.sourceSha256 !== sourceSnapshotSha256) {
        throw new Error(`${id} 权威全文 SHA 与 fulltext manifest 不一致`);
    }
    const authorityInputs = {
        paper_metadata: { path: filteredPath, sha256: sha256(filteredBytes) },
        source_snapshot: { path: sourceSnapshotPath, sha256: sourceSnapshotSha256 },
        artifact_index: { path: artifact.path, sha256: artifact.artifactSha256 },
        authoring_prompt: { path: EDITORIAL_CONTRACT_PATH, sha256: sha256(editorialContractBytes) },
        editorial_contract: { path: REFERENCE_CONTRACT_PATH, sha256: sha256(referenceContractBytes) },
        blank_schema: { path: QUALITY_SCHEMA_PATH, sha256: sha256(qualitySchemaBytes) }
    };
    const externalEvidencePath = path.join(
        path.dirname(fulltextManifestPath), 'external-evidence', `${id}-official-project.json`
    );
    let externalEvidenceSha256 = null;
    if (fs.existsSync(externalEvidencePath)) {
        if (!fs.statSync(externalEvidencePath).isFile()
            || fs.lstatSync(externalEvidencePath).isSymbolicLink()) {
            throw new Error(`${id} 官方项目证据必须是真实普通文件且不得为符号链接`);
        }
        const externalEvidence = readJson(externalEvidencePath, 'official project evidence');
        if (normalizedId(externalEvidence.paperId) !== id
            || externalEvidence.kind !== 'official_project_evidence'
            || !String(externalEvidence.url || '').startsWith('https://')) {
            throw new Error(`${id} 官方项目证据身份、kind 或 HTTPS URL 非法`);
        }
        externalEvidenceSha256 = sha256File(externalEvidencePath);
        authorityInputs.official_project_evidence = {
            path: externalEvidencePath,
            sha256: externalEvidenceSha256
        };
    }
    assertFreshAuthoringInputBindings(quality, authorityInputs);
    const freshAuthoring = {
        ...quality.freshAuthoring,
        articlePath
    };
    freshAuthoring.receiptSha256 = stableSha256(freshAuthoring);
    const tutorialPayload = validateTutorialPayloadReceipt({
        contract: MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
        qualityPath,
        artifactPlanPath
    }, {
        date,
        paperId: id,
        currentRoot: path.resolve(previewRoot, '..'),
        qualityPath,
        artifactPlanPath,
        article,
        articleFileSha256: articleSha256,
        freshAuthoring,
        artifactIndex: artifact.index
    });
    const presentation = validateWithAdapter({
        article, articleSha256, quality, paper, filteredPaper, artifactIndex: artifact.index,
        artifactPlan, paperId: id, qualityAdapter: options.qualityAdapter,
        formalValidation: {
            contract: tutorialPayload.orchestratorContract,
            fingerprint: tutorialPayload.orchestratorFingerprint,
            quality: tutorialPayload.validation
        }
    });
    const inputs = {
        filteredSha256: sha256(filteredBytes), canonicalSha256: sha256(canonicalBytes),
        filteredPaperSha256: sha256(Buffer.from(JSON.stringify(filteredPaper))),
        canonicalPaperSha256: sha256(Buffer.from(JSON.stringify(paper))),
        artifactManifestSha256: artifact.manifestSha256, artifactSha256: artifact.artifactSha256,
        articleSha256, qualitySha256: sha256(qualityBytes), qualityAdapter: presentation.adapter || 'custom',
        artifactAdapter: artifactAdapter.name || 'custom',
        artifactPlanAdapter: artifactPlanAdapter.name || 'custom', artifactPlanSha256,
        tutorialPayloadSha256: tutorialPayload.receiptSha256,
        tutorialOrchestratorFingerprint: tutorialPayload.orchestratorFingerprint,
        qualityContract: presentation.qualityValidation?.contract || 'custom',
        editorialContractSha256: sha256(editorialContractBytes),
        referenceContractSha256: sha256(referenceContractBytes),
        qualitySchemaSha256: sha256(qualitySchemaBytes),
        sourceSnapshotSha256,
        externalEvidenceSha256
    };
    // Cache identity is deliberately paper-local. Batch container SHA changes
    // from unrelated papers remain provenance in the manifest but no longer
    // rebuild this page.
    const inputFingerprint = previewInputFingerprint({
        version: PREVIEW_VERSION, date, id,
        inputs: {
            filteredPaperSha256: inputs.filteredPaperSha256,
            canonicalPaperSha256: inputs.canonicalPaperSha256,
            artifactSha256: inputs.artifactSha256,
            articleSha256: inputs.articleSha256,
            qualitySha256: inputs.qualitySha256,
            qualityAdapter: inputs.qualityAdapter,
            artifactAdapter: inputs.artifactAdapter,
            artifactPlanAdapter: inputs.artifactPlanAdapter,
            artifactPlanSha256: inputs.artifactPlanSha256,
            tutorialOrchestratorFingerprint: inputs.tutorialOrchestratorFingerprint,
            qualityContract: inputs.qualityContract,
            editorialContractSha256: inputs.editorialContractSha256,
            referenceContractSha256: inputs.referenceContractSha256,
            qualitySchemaSha256: inputs.qualitySchemaSha256,
            sourceSnapshotSha256: inputs.sourceSnapshotSha256
        }
    });
    if (fs.existsSync(paths.manifestPath) && fs.existsSync(paths.postPath)) {
        try {
            const previous = readJson(paths.manifestPath, 'existing tutorial preview manifest');
            if (previous.mode === PREVIEW_MODE && previous.inputFingerprint === inputFingerprint
                && previous.output?.postSha256 === sha256File(paths.postPath)) {
                return { reused: true, ...paths, manifest: previous };
            }
        } catch (_error) {
            // A malformed preview is overwritten atomically below; it can never
            // be reported as a cache hit.
        }
    }
    const markdown = renderPreview(paper, presentation, id, date, tutorialPayload);
    const postSha256 = sha256(Buffer.from(markdown));
    const manifest = {
        version: PREVIEW_VERSION,
        mode: PREVIEW_MODE,
        date,
        paperId: id,
        status: 'complete',
        generatedAt: options.generatedAt || getBeijingISOString(),
        inputFingerprint,
        inputs: {
            filtered: {
                path: filteredPath, sha256: inputs.filteredSha256,
                paperSha256: inputs.filteredPaperSha256
            },
            canonical: {
                path: canonicalPath, sha256: inputs.canonicalSha256,
                paperSha256: inputs.canonicalPaperSha256
            },
            artifactManifest: { path: artifactManifestPath, sha256: inputs.artifactManifestSha256 },
            artifactIndex: { path: artifact.path, sha256: artifact.artifactSha256, inventory: artifact.inventory },
            artifactPlan: {
                version: artifactPlan.version, sha256: artifactPlanSha256,
                adapter: inputs.artifactPlanAdapter,
                coverage: {
                    tables: artifactPlan.coverageMatrix.tables.length,
                    figures: artifactPlan.coverageMatrix.figures.length,
                    formulas: artifactPlan.coverageMatrix.formulas.length,
                    numericCells: artifactPlan.coverageMatrix.tables.reduce((sum, table) => sum + table.coveredNumericCellIds.length, 0)
                }
            },
            tutorialPayload: tutorialPayload,
            article: { path: articlePath, sha256: articleSha256 },
            quality: {
                path: qualityPath, sha256: inputs.qualitySha256, adapter: inputs.qualityAdapter,
                contract: inputs.qualityContract,
                validation: presentation.qualityValidation || { status: 'custom_adapter' }
            },
            editorialContract: {
                path: EDITORIAL_CONTRACT_PATH,
                sha256: inputs.editorialContractSha256
            },
            referenceContract: {
                path: REFERENCE_CONTRACT_PATH,
                sha256: inputs.referenceContractSha256
            },
            qualitySchema: {
                path: QUALITY_SCHEMA_PATH,
                sha256: inputs.qualitySchemaSha256
            },
            sourceSnapshot: {
                path: sourceSnapshotPath,
                sha256: inputs.sourceSnapshotSha256,
                manifestPath: fulltextManifestPath
            },
            artifactAdapter: inputs.artifactAdapter
        },
        output: { path: paths.postPath, postSha256, bytes: Buffer.byteLength(markdown) },
        isolation: {
            singlePaperOnly: true,
            blogRepositoryTouched: false,
            canonicalMutated: false,
            imagesGenerated: false,
            otherPapersGenerated: false
        }
    };
    writeFileAtomic(paths.postPath, markdown);
    writeFileAtomic(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { reused: false, ...paths, manifest };
}

function parseArgs(argv) {
    const options = {};
    const known = new Map([
        ['--date', 'date'], ['--paper-id', 'paperId'], ['--article', 'articlePath'], ['--quality', 'qualityPath']
    ]);
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const key = known.get(arg);
        if (!key || options[key] !== undefined) throw new Error(`未知或重复参数: ${arg}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        options[key] = value;
    }
    for (const [flag, key] of known) if (!options[key]) throw new Error(`缺少必填参数 ${flag}`);
    options.date = assertDate(options.date);
    options.paperId = assertPaperId(options.paperId);
    return options;
}

function main(argv = process.argv.slice(2)) {
    const result = buildTutorialPreview(parseArgs(argv));
    console.log(`${result.reused ? '♻️ 复用' : '✅ 生成'} 单篇 tutorial preview：${result.postPath}`);
    console.log(`🧾 manifest：${result.manifestPath}`);
    return result;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`❌ tutorial preview 失败: ${error.message}`); process.exitCode = 1; }
}

module.exports = {
    PREVIEW_VERSION,
    PREVIEW_MODE,
    SCORE_DIMENSIONS,
    assertDate,
    assertPaperId,
    artifactInventorySummary,
    defaultArtifactAdapter,
    defaultArtifactPlanAdapter,
    defaultQualityAdapter,
    renderPreview,
    outputPaths,
    buildTutorialPreview,
    assertFreshAuthoringInputBindings,
    parseArgs
};

'use strict';

/**
 * Shared, file-backed provenance contract for default Manual v5 authoring.
 *
 * This module proves that the reader article was emitted as a new controlled
 * article.md from the current paper's evidence packet.  A matching hash stored
 * beside an old readerArticle is deliberately insufficient: every authority
 * file is reopened, path-checked and hashed at each pipeline boundary.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizedId } = require('./utils.js');

const FRESH_AUTHORING_CONTRACT = 'fresh-authoring-v1';
const FRESH_AUTHORING_MODE = 'fresh_from_evidence';
const FRESH_INPUT_KINDS = Object.freeze([
    'paper_metadata',
    'source_snapshot',
    'artifact_index',
    'authoring_prompt',
    'editorial_contract',
    'blank_schema'
]);
const OPTIONAL_FRESH_INPUT_KINDS = Object.freeze(['official_project_evidence']);
const SHA256_RE = /^[a-f0-9]{64}$/;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const AUTHORING_PROMPT_PATH = path.join(PROJECT_ROOT, 'prompts', 'manual-tutorial-article.md');
const EDITORIAL_CONTRACT_PATH = path.join(PROJECT_ROOT, 'docs', 'manual-editorial-reference-contract.md');
const BLANK_SCHEMA_PATH = path.join(PROJECT_ROOT, 'scripts', 'manual-tutorial-quality-contract.js');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeArticle(value) {
    return String(value || '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

function articleSha256(value) {
    return sha256(Buffer.from(normalizeArticle(value), 'utf8'));
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableSha256(value) {
    return sha256(Buffer.from(JSON.stringify(stableValue(value)), 'utf8'));
}

function assertPlainFile(filePath, label) {
    const resolved = path.resolve(String(filePath || ''));
    let stat;
    try {
        stat = fs.lstatSync(resolved);
    } catch (error) {
        throw new Error(`${label} 不存在或不可读: ${resolved}: ${error.message}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${label} 必须是真实普通文件且不得使用符号链接: ${resolved}`);
    }
    return resolved;
}

function assertExactPath(actual, expected, label) {
    const actualPath = path.resolve(String(actual || ''));
    const expectedPath = path.resolve(String(expected || ''));
    if (actualPath !== expectedPath) {
        throw new Error(`${label} 未绑定当前受控路径: expected=${expectedPath} actual=${actualPath}`);
    }
    return assertPlainFile(actualPath, label);
}

function rawFileSha256(filePath, label = 'file') {
    return sha256(fs.readFileSync(assertPlainFile(filePath, label)));
}

function defaultArticlePath(currentRoot, date, paperId) {
    const id = normalizedId(paperId);
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
        throw new Error('fresh article path 缺少合法日期或 arXiv ID');
    }
    return path.join(
        path.resolve(currentRoot), 'manual-tutorial-previews', String(date), id, 'draft', 'article.md'
    );
}

function resolveArtifactAuthority(artifactManifestPath, expected) {
    const manifestPath = assertPlainFile(artifactManifestPath, 'ArtifactIndex manifest');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error(`ArtifactIndex manifest JSON 损坏: ${error.message}`);
    }
    const id = normalizedId(expected.paperId);
    if (!manifest || manifest.mode !== 'manual_artifact_index'
        || manifest.parserVersion !== 'manual-artifact-parser-v2-structured'
        || manifest.date !== expected.date
        || manifest.filteredBatchSha256 !== expected.filteredBatchSha256) {
        throw new Error(`${id} ArtifactIndex manifest 未绑定当前日期/parser/filtered 批次`);
    }
    const entry = manifest.papers?.[id];
    if (!entry || entry.status !== 'complete'
        || entry.paperId !== id
        || entry.sourceSha256 !== expected.sourceSha256
        || entry.sourceIdentitySha256 !== expected.sourceIdentitySha256
        || entry.paperInputSha256 !== expected.paperInputSha256) {
        throw new Error(`${id} ArtifactIndex checkpoint 未与当前全文和单篇输入身份闭环`);
    }
    const artifactPath = assertPlainFile(entry.path, `${id} ArtifactIndex`);
    const relative = path.relative(path.dirname(manifestPath), artifactPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${id} ArtifactIndex 路径逃逸受控 artifacts 目录`);
    }
    const bytes = fs.readFileSync(artifactPath);
    if (entry.bytes !== bytes.length || entry.outputSha256 !== sha256(bytes)) {
        throw new Error(`${id} ArtifactIndex 文件 bytes/SHA 与 manifest 不一致`);
    }
    let index;
    try {
        index = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new Error(`${id} ArtifactIndex JSON 损坏: ${error.message}`);
    }
    if (normalizedId(index.paperId) !== id
        || index.inventoryHealth?.status !== 'complete'
        || index.inputIdentity?.sourceSha256 !== expected.sourceSha256
        || index.inputIdentity?.sourceIdentitySha256 !== expected.sourceIdentitySha256
        || index.inputIdentity?.paperInputSha256 !== expected.paperInputSha256
        || index.artifactIndexSha256 !== entry.artifactIndexSha256) {
        throw new Error(`${id} ArtifactIndex 内容身份与 manifest/全文不一致`);
    }
    return {
        manifestPath,
        manifestSha256: rawFileSha256(manifestPath, 'ArtifactIndex manifest'),
        path: artifactPath,
        sha256: entry.outputSha256,
        entry,
        index
    };
}

function buildAuthorityInputs(paths) {
    const expected = {
        paper_metadata: paths.filteredPath,
        source_snapshot: paths.sourcePath,
        artifact_index: paths.artifactPath,
        authoring_prompt: paths.authoringPromptPath || AUTHORING_PROMPT_PATH,
        editorial_contract: paths.editorialContractPath || EDITORIAL_CONTRACT_PATH,
        blank_schema: paths.blankSchemaPath || BLANK_SCHEMA_PATH
    };
    const kinds = [...FRESH_INPUT_KINDS];
    if (paths.officialProjectEvidencePath) {
        const evidencePath = assertPlainFile(
            paths.officialProjectEvidencePath, 'fresh authority official_project_evidence'
        );
        let evidence;
        try {
            evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        } catch (error) {
            throw new Error(`official_project_evidence JSON 损坏: ${error.message}`);
        }
        if (normalizedId(evidence.paperId) !== normalizedId(paths.paperId)
            || evidence.kind !== 'official_project_evidence'
            || !/^https:\/\//i.test(String(evidence.url || ''))) {
            throw new Error('official_project_evidence paperId/kind/HTTPS URL 非法');
        }
        expected.official_project_evidence = evidencePath;
        kinds.push('official_project_evidence');
    }
    return Object.fromEntries(kinds.map(kind => {
        const filePath = assertPlainFile(expected[kind], `fresh authority ${kind}`);
        return [kind, { kind, path: filePath, sha256: rawFileSha256(filePath, `fresh authority ${kind}`) }];
    }));
}

function validateFreshAuthoringReceipt(receipt, options) {
    const id = normalizedId(options.paperId);
    const label = `${id || options.paperId}.freshAuthoring`;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
        || receipt.contract !== FRESH_AUTHORING_CONTRACT
        || receipt.mode !== FRESH_AUTHORING_MODE) {
        throw new Error(`${label} 必须声明 ${FRESH_AUTHORING_CONTRACT}/${FRESH_AUTHORING_MODE}`);
    }
    if (typeof receipt.authoringSessionId !== 'string' || receipt.authoringSessionId.trim().length < 12) {
        throw new Error(`${label}.authoringSessionId 必须至少 12 字符`);
    }
    if (!Array.isArray(receipt.prohibitedProseInputs) || receipt.prohibitedProseInputs.length !== 0) {
        throw new Error(`${label}.prohibitedProseInputs 必须为空，禁止历史 analysis/readerArticle/article/post/review prose`);
    }
    const expectedArticlePath = path.resolve(options.articlePath);
    const articlePath = assertExactPath(receipt.articlePath, expectedArticlePath, `${label}.articlePath`);
    const articleBytes = fs.readFileSync(articlePath);
    const rawSha = sha256(articleBytes);
    const articleText = articleBytes.toString('utf8');
    const normalizedSha = articleSha256(articleText);
    if (receipt.articleFileSha256 !== rawSha || receipt.articleSha256 !== normalizedSha) {
        throw new Error(`${label} article.md 的 raw/NFKC SHA 与真实文件不一致`);
    }
    if (normalizeArticle(options.readerArticle) !== normalizeArticle(articleText)) {
        throw new Error(`${label} 受控 article.md 与 editorial.readerArticle 不是同一篇完整新稿`);
    }
    const expectedInputs = buildAuthorityInputs({ ...options.authorityPaths, paperId: id });
    const expectedKinds = Object.keys(expectedInputs);
    if (!Array.isArray(receipt.inputs) || receipt.inputs.length !== expectedKinds.length) {
        throw new Error(`${label}.inputs 必须精确覆盖当前冷启动权威输入`);
    }
    const actualByKind = new Map();
    for (const [index, input] of receipt.inputs.entries()) {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || ![...FRESH_INPUT_KINDS, ...OPTIONAL_FRESH_INPUT_KINDS].includes(input.kind)
            || actualByKind.has(input.kind)) {
            throw new Error(`${label}.inputs[${index}] kind 非法、重复或属于旧 prose`);
        }
        actualByKind.set(input.kind, input);
    }
    for (const kind of expectedKinds) {
        const actual = actualByKind.get(kind);
        const expected = expectedInputs[kind];
        assertExactPath(actual?.path, expected.path, `${label}.inputs.${kind}.path`);
        if (actual.sha256 !== expected.sha256) {
            throw new Error(`${label}.inputs.${kind}.sha256 与当前权威文件不一致`);
        }
    }
    const normalizedReceipt = {
        contract: FRESH_AUTHORING_CONTRACT,
        mode: FRESH_AUTHORING_MODE,
        authoringSessionId: receipt.authoringSessionId.trim(),
        articlePath,
        articleSha256: normalizedSha,
        articleFileSha256: rawSha,
        prohibitedProseInputs: [],
        inputs: expectedKinds.map(kind => expectedInputs[kind])
    };
    normalizedReceipt.receiptSha256 = stableSha256(normalizedReceipt);
    if (receipt.receiptSha256 !== undefined && receipt.receiptSha256 !== normalizedReceipt.receiptSha256) {
        throw new Error(`${label}.receiptSha256 与规范化 fresh receipt 不一致`);
    }
    return normalizedReceipt;
}

module.exports = {
    FRESH_AUTHORING_CONTRACT,
    FRESH_AUTHORING_MODE,
    FRESH_INPUT_KINDS,
    OPTIONAL_FRESH_INPUT_KINDS,
    AUTHORING_PROMPT_PATH,
    EDITORIAL_CONTRACT_PATH,
    BLANK_SCHEMA_PATH,
    SHA256_RE,
    normalizeArticle,
    articleSha256,
    stableSha256,
    rawFileSha256,
    defaultArticlePath,
    resolveArtifactAuthority,
    buildAuthorityInputs,
    validateFreshAuthoringReceipt
};

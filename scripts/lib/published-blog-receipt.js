'use strict';
// 只核验已保存的正式出版凭证；线上部署和网页仍由发布流程另行核验。
const { strictReceipt, sourceBoundGeneration, snapshotHeader, matchesSnapshotReceipt } = require('./blog-record-format');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../config');
const { normalizedId } = require('../utils');
const formats = require('./protocol-codec');
const readerFormats = require('./reader-record-format');
const { historicalContract: historicalManualContract } = formats;
const SIGNED_MANUAL_PRODUCTION_MODE = 'manual_v6_production';
const SIGNED_MANUAL_PUBLICATION_CONTRACT = 'manual-v6-production-publication-v1';
const LLM_API_PRODUCTION_MODE = 'llm_api_production';
const LLM_API_PRODUCTION_CONTRACT = formats.contract('llm-api-production-publication');
const scoringFormats = require('./scoring-record-format');
const LLM_API_READER_CONTRACT = formats.historicalContract('beginner-researcher', readerFormats.INTEGRATED);
const LLM_API_SCORING_CONTRACT = formats.historicalContract('api-scoring-audit', 'evidence-bound-final-analysis');

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

function pythonFloatText(value) {
    if (Object.is(value, -0)) return '-0.0';
    const [mantissa, exponentText] = value.toExponential().split('e');
    const exponent = Number(exponentText);
    if (exponent < -4 || exponent >= 16) {
        return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
    }
    const negative = mantissa.startsWith('-');
    const digits = mantissa.replace('-', '').replace('.', '');
    const point = exponent + 1;
    const body = point <= 0
        ? `0.${'0'.repeat(-point)}${digits}`
        : point >= digits.length
            ? `${digits}${'0'.repeat(point - digits.length)}.0`
            : `${digits.slice(0, point)}.${digits.slice(point)}`;
    return negative ? `-${body}` : body;
}

function stableApiBindingsSha256(bindings) {
    // Python 的 json.dumps 会把整数浮点写成 `5.0`，JSON.stringify 却把解析后的值
    // 写成 `5`。这份跨语言绑定里只有 finalScore 是有意保留的浮点字段，Python 用
    // float(...) 存它，所以每个值都要走 repr。
    const scores = (Array.isArray(bindings) ? bindings : []).map(item => item?.finalScore);
    let index = 0;
    const encoded = JSON.stringify(stableJson(bindings)).replace(
        /("finalScore":)(-?[0-9][0-9.eE+-]*)(?=[,}])/g,
        (match, prefix) => (
            typeof scores[index] === 'number' && Number.isFinite(scores[index])
                ? `${prefix}${pythonFloatText(scores[index++])}`
                : match
        )
    );
    return sha256Buffer(Buffer.from(encoded, 'utf8'));
}

function assertSignedManualProductionGeneration(generation, publishedPapers) {
    const proof = generation?.manualV6Production;
    const bindings = generation?.manualV6Bindings;
    if (generation?.publicationMode !== SIGNED_MANUAL_PRODUCTION_MODE
        || proof?.contract !== SIGNED_MANUAL_PUBLICATION_CONTRACT
        || proof?.manualDepth !== historicalManualContract('manual-analysis-depth', 'signed-longform')
        || proof?.runtimeMode !== 'production'
        || proof?.specVersion !== 6 || proof?.recordsVersion !== 4
        || proof?.readerLongformContract !== historicalManualContract('manual-reader-longform', 'signed-blocks')
        || !/^[a-f0-9]{64}$/.test(String(proof?.specMerkleRootSha256 || ''))
        || !Array.isArray(bindings) || bindings.length !== publishedPapers.length
        || proof?.paperCount !== bindings.length
        || !Array.isArray(proof?.paperIds)) {
        throw new Error('正式发布只接受绑定原规格、记录、Merkle 校验和长文的 的 production generation');
    }
    const ids = bindings.map(item => String(item?.paperId || ''));
    const publishedIds = publishedPapers.map(normalizedId).sort();
    if (ids.some(id => !id) || new Set(ids).size !== ids.length
        || JSON.stringify(ids) !== JSON.stringify([...ids].sort())
        || JSON.stringify(ids) !== JSON.stringify(publishedIds)
        || JSON.stringify(proof.paperIds) !== JSON.stringify(ids)
        || bindings.some(item => (
            item?.manualDepth !== historicalManualContract('manual-analysis-depth', 'signed-longform')
            || item?.runtimeMode !== 'production'
            || item?.specVersion !== 6
            || item?.specRootSha256 !== proof.specMerkleRootSha256
            || item?.readerLongformContract !== historicalManualContract('manual-reader-longform', 'signed-blocks')
            || !/^[a-f0-9]{64}$/.test(String(item?.paperSpecSha256 || ''))
            || !/^[a-f0-9]{64}$/.test(String(item?.recordSemanticSha256 || ''))
            || !/^[a-f0-9]{64}$/.test(String(item?.recordFileSha256 || ''))
            || !/^[a-f0-9]{64}$/.test(String(item?.recordsEnvelopeFileSha256 || ''))
            || !/^[a-f0-9]{64}$/.test(String(item?.taskEvidenceSha256 || ''))
            || !/^[a-f0-9]{64}$/.test(String(item?.readerLongformSha256 || ''))
            || !/^[a-f0-9]{64}$/.test(String(item?.readerArticleSha256 || ''))
        ))) {
        throw new Error('签名人工历史生成记录 的逐论文 provenance 不完整或集合不一致');
    }
    const bindingsFingerprint = stableSha256(bindings);
    const proofFingerprint = stableSha256(proof);
    if (generation.manualV6BindingsFingerprint !== bindingsFingerprint
        || proof.bindingsFingerprint !== bindingsFingerprint
        || generation.manualV6ProductionFingerprint !== proofFingerprint) {
        throw new Error('签名人工历史生成记录 的 provenance 指纹不匹配');
    }
    return { proof, proofFingerprint };
}

function assertLlmApiProductionGeneration(generation, publishedPapers) {
    const proof = generation?.llmApiProduction;
    const bindings = generation?.llmApiBindings;
    const isSha256 = value => /^[a-f0-9]{64}$/.test(String(value || ''));
    if (generation?.publicationMode !== LLM_API_PRODUCTION_MODE
        || !formats.hasValidHeader(proof, LLM_API_PRODUCTION_CONTRACT)
        || !Array.isArray(bindings) || bindings.length !== publishedPapers.length
        || proof?.paperCount !== bindings.length
        || !Array.isArray(proof?.paperIds)) {
        throw new Error('正式发布只接受 reader/scoring/source 完整一致的 LLM API production generation');
    }
    const ids = bindings.map(item => String(item?.paperId || ''));
    const publishedIds = publishedPapers.map(normalizedId).sort();
    const bindingInvalid = bindings.some(item => (
        !hasReaderPublicationBindingHeader(item)
        || !scoringFormats.hasScoringAuditFormat(item)
        || !isSha256(item?.readerArticleSha256)
        || !isSha256(item?.readerPlanSha256)
        || !isSha256(item?.readerFiguresSha256)
        || !isSha256(item?.readerAuthorsSha256)
        || !isSha256(item?.analysisSha256)
        || !isSha256(item?.sourceSha256)
        || !isSha256(item?.scoringAuditSha256)
        || !isSha256(item?.scoringEvidenceSha256)
        || typeof item?.finalScore !== 'number' || !Number.isFinite(item.finalScore)
        || typeof item?.model !== 'string' || !item.model.trim()
        || typeof item?.protocol !== 'string' || !item.protocol.trim()
    ));
    if (ids.some(id => !id) || new Set(ids).size !== ids.length
        || JSON.stringify(ids) !== JSON.stringify([...ids].sort())
        || JSON.stringify(ids) !== JSON.stringify(publishedIds)
        || JSON.stringify(proof.paperIds) !== JSON.stringify(ids)
        || bindingInvalid) {
        throw new Error('LLM API production generation 的逐论文 provenance 不完整或集合不一致');
    }
    const profile = formats.format(proof.contract, LLM_API_PRODUCTION_CONTRACT, proof.schemaFingerprint);
    if (profile === 'uniform-original-declarations') {
        const original = {
            readerContract: LLM_API_READER_CONTRACT,
            readerSourceBindingsContract: formats.historicalContract('api-reader-source-bindings', 'integrated-source-bound'),
            readerAuthorIdentityContract: formats.historicalContract('api-reader-author-identity', 'source-bound-identity'),
            readerResourceIdentityContract: formats.historicalContract('api-reader-resource-identity', 'source-bound-identity'),
            scoringContract: LLM_API_SCORING_CONTRACT
        };
        const expectedKeys = [...Object.keys(formats.recordHeader(proof.contract, LLM_API_PRODUCTION_CONTRACT, proof.schemaFingerprint)),
            'paperCount', 'paperIds', 'bindingsFingerprint', ...Object.keys(original)].sort();
        if (JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(expectedKeys)
            || Object.entries(original).some(([field, value]) => proof[field] !== value)
            || bindings.some(item => Object.entries(original).some(([field, value]) => item[field] !== value)
                || Object.keys(item).some(field => field.endsWith('SchemaFingerprint')))) {
            throw new Error('原单一格式的发布证明不能覆盖新的或混合的成员格式');
        }
    } else if (profile === 'per-member-complete-format-sets') {
        const expectedKeys = [...Object.keys(formats.recordHeader(proof.contract, LLM_API_PRODUCTION_CONTRACT, proof.schemaFingerprint)),
            'paperCount', 'paperIds', 'bindingsFingerprint',
            ...API_PUBLICATION_FORMAT_SETS.map(([, field]) => field)].sort();
        if (JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(expectedKeys)) {
            throw new Error('API 发布证明包含缺失或未登记的字段');
        }
        for (const [prefix, field] of API_PUBLICATION_FORMAT_SETS) {
            if (JSON.stringify(stableJson(proof[field])) !== JSON.stringify(stableJson(memberFormatSet(bindings, prefix)))) {
                throw new Error('API 发布证明中的格式集合与逐篇实际格式不一致');
            }
        }
    } else throw new Error('API 发布证明的结构没有可用的读取规则');
    const bindingsFingerprint = stableApiBindingsSha256(bindings);
    const proofFingerprint = stableSha256(proof);
    if (generation.llmApiBindingsFingerprint !== bindingsFingerprint
        || proof.bindingsFingerprint !== bindingsFingerprint
        || generation.llmApiProductionFingerprint !== proofFingerprint) {
        throw new Error('LLM API production generation 的 provenance 指纹不匹配');
    }
    return { proof, proofFingerprint };
}

const API_PUBLICATION_FORMAT_SETS = Object.freeze([
    ['reader', 'readerFormats'], ['readerSourceBindings', 'sourceBindingFormats'],
    ['readerAuthorIdentity', 'authorIdentityFormats'], ['readerResourceIdentity', 'resourceIdentityFormats'],
    ['scoring', 'scoringFormats'], ['coreSummary', 'coreSummaryFormats']
]);
function memberFormatSet(bindings, prefix) {
    const values = new Map();
    for (const member of bindings) {
        const tag = member[prefix + 'Contract'];
        if (typeof tag !== 'string' || !tag) throw new Error('API 发布成员缺少完整的格式声明');
        const header = { contract: tag }, field = prefix + 'SchemaFingerprint';
        if (Object.hasOwn(member, field)) {
            if (typeof member[field] !== 'string' || !/^[a-f0-9]{64}$/.test(member[field])) throw new Error('API 发布成员的格式指纹不合法');
            header.schemaFingerprint = member[field];
        }
        values.set(JSON.stringify(stableJson(header)), header);
    }
    return [...values.keys()].sort().map(key => values.get(key));
}

function hasReaderPublicationBindingHeader(binding) {
    if (!binding || typeof binding !== 'object') return false;
    const header = { contract: binding.readerContract,
        ...(Object.hasOwn(binding, 'readerSchemaFingerprint')
            ? { schemaFingerprint: binding.readerSchemaFingerprint } : {}) };
    try {
        return formats.hasValidHeader(header, 'beginner-researcher')
            && formats.format(header.contract, 'beginner-researcher', header.schemaFingerprint) === readerFormats.INTEGRATED;
    } catch { return false; }
}

function assertProductionGeneration(generation, publishedPapers) {
    if (generation?.publicationMode === SIGNED_MANUAL_PRODUCTION_MODE) {
        return {
            ...assertSignedManualProductionGeneration(generation, publishedPapers),
            publicationMode: SIGNED_MANUAL_PRODUCTION_MODE,
            fingerprintField: 'manualV6ProductionFingerprint'
        };
    }
    if (generation?.publicationMode === LLM_API_PRODUCTION_MODE) {
        return {
            ...assertLlmApiProductionGeneration(generation, publishedPapers),
            publicationMode: LLM_API_PRODUCTION_MODE,
            fingerprintField: 'llmApiProductionFingerprint'
        };
    }
    throw new Error(`正式发布不接受该 publicationMode: ${generation?.publicationMode || 'missing'}`);
}

function portableFingerprintValue(value, label = 'publishedPapers') {
    if (value === null) return ['null'];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value === 'string') return ['string', value];
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`${label} 包含非有限数值`);
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
            throw new Error(`${label} 包含超出 JSON 安全范围的整数`);
        }
        const raw = Buffer.allocUnsafe(8);
        raw.writeDoubleBE(value, 0);
        return ['number-f64', raw.toString('hex')];
    }
    if (Array.isArray(value)) {
        return ['array', value.map((item, index) => (
            portableFingerprintValue(item, `${label}[${index}]`)
        ))];
    }
    if (value && typeof value === 'object') {
        return ['object', Object.keys(value).sort().map(key => [
            key, portableFingerprintValue(value[key], `${label}.${key}`)
        ])];
    }
    throw new Error(`${label} 包含不可序列化类型: ${typeof value}`);
}

function publishedPapersFingerprint(publishedPapers) {
    if (!Array.isArray(publishedPapers) || publishedPapers.length === 0) {
        throw new Error('generation manifest 缺少已发布论文权威快照');
    }
    return stableSha256(portableFingerprintValue(publishedPapers));
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

function assertPublishedBlogReceipt(targetDate, receiptPath = null) {
    targetDate = validateDate(targetDate);
    const resolved = receiptPath || path.join(Config.CURRENT_DIR, `blog-review-receipt-${targetDate}.json`);
    let receipt;
    let receiptRaw;
    try {
        receiptRaw = fs.readFileSync(resolved);
        receipt = JSON.parse(receiptRaw.toString('utf8'));
    } catch (_error) {
        throw new Error(`缺少可验证的博客发布凭证，必须先完成博客发布: ${resolved}`);
    }
    const verifiedAt = String(receipt.remoteVerifiedAt || '');
    if (!strictReceipt(receipt) || receipt.date !== targetDate
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
        || !sourceBoundGeneration(generation) || generation.date !== targetDate
        || generation.visualSummaryRequired !== false || generation.digestCoverRequired !== false
        || !/^[0-9a-f]{64}$/i.test(String(generation.inputFingerprint || ''))
        || typeof generation.publishAll !== 'boolean'
        || !snapshotHeader(generation)
        || !/^[0-9a-f]{64}$/i.test(String(generation.publishedPapersFingerprint || ''))
        || typeof generation.category !== 'string' || !generation.category
        || !Array.isArray(publishedPapers) || publishedPapers.length === 0) {
        throw new Error('博客发布凭证与 generation manifest 或已发布论文快照不一致');
    }
    const ids = publishedPapers.map(normalizedId);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) {
        throw new Error('generation manifest 的已发布论文快照包含空或重复 ID');
    }
    publishedPapers.forEach(validatePublishImageExclusions);
    const snapshotFingerprint = publishedPapersFingerprint(publishedPapers);
    if (snapshotFingerprint !== generation.publishedPapersFingerprint
        || !matchesSnapshotReceipt(generation, receipt)
        || receipt.generationInputFingerprint !== generation.inputFingerprint
        || receipt.publishedPapersFingerprint !== snapshotFingerprint) {
        throw new Error('博客发布凭证未绑定可反向验证的已发布论文权威快照');
    }
    const production = assertProductionGeneration(generation, publishedPapers);
    const policy = generation.postPublicationPolicy;
    if ((policy !== undefined || Object.hasOwn(generation, 'contract'))
        && !require('./post-publication-policy').validPublicationPolicy(policy)) {
        throw new Error('正式生成清单的不生图设置不完整或格式未知');
    }
    const expectedVisualState = policy === undefined ? 'required' : 'not_requested';
    if (receipt.publicationMode !== production.publicationMode
        || receipt[production.fingerprintField] !== production.proofFingerprint
        || receipt.postPublishVisuals !== expectedVisualState) {
        throw new Error('博客发布凭证未绑定当前 production generation，禁止登记发布完成');
    }
    return {
        path: resolved,
        generationPath,
        publicationCommit: receipt.publicationCommit.toLowerCase(),
        generationManifestSha256,
        reviewReceiptSha256: sha256Buffer(receiptRaw),
        postPublicationPolicy: policy,
        postPublishVisuals: receipt.postPublishVisuals,
        remoteVerifiedOid: receipt.remoteVerifiedOid.toLowerCase(),
        category: generation.category,
        publishedPapers,
        publicationMode: receipt.publicationMode,
        manualV6ProductionFingerprint: receipt.manualV6ProductionFingerprint || null,
        llmApiProductionFingerprint: receipt.llmApiProductionFingerprint || null
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

function validatePublishImageExclusions(paper) {
    const paperId = normalizedId(paper);
    const rawEntries = paper?.publishImageExclusions;
    if (rawEntries === undefined) return [];
    if (!Array.isArray(rawEntries)) {
        throw new Error(`${paperId}.publishImageExclusions 必须是数组`);
    }
    const seen = new Set();
    return rawEntries.map((entry, index) => {
        const label = `${paperId}.publishImageExclusions[${index}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || Object.keys(entry).sort().join(',') !== 'normalizedArxivId,reason,url') {
            throw new Error(`${label} 必须且只能包含 normalizedArxivId/url/reason`);
        }
        const entryId = entry.normalizedArxivId;
        if (typeof entryId !== 'string' || entryId !== normalizedId(entryId) || entryId !== paperId) {
            throw new Error(`${label}.normalizedArxivId 必须是当前论文的规范化 arXiv ID`);
        }
        const url = entry.url;
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            throw new Error(`${label}.url 非法`);
        }
        if (typeof url !== 'string' || url !== url.trim() || /[\u0000-\u0020]/.test(url)
            || !url.startsWith('https://') || parsed.protocol !== 'https:'
            || !parsed.hostname || parsed.username || parsed.password) {
            throw new Error(`${label}.url 必须是无 userinfo 的精确 HTTPS URL`);
        }
        if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
            throw new Error(`${label}.reason 必须是非空字符串`);
        }
        if (seen.has(url)) throw new Error(`${paperId}.publishImageExclusions URL 重复`);
        seen.add(url);
        return {
            normalizedArxivId: entryId,
            url,
            reason: entry.reason.trim()
        };
    });
}

module.exports = { sha256Buffer, stableJson, stableSha256, pythonFloatText, stableApiBindingsSha256, assertSignedManualProductionGeneration, assertLlmApiProductionGeneration, hasReaderPublicationBindingHeader, assertProductionGeneration, portableFingerprintValue, publishedPapersFingerprint, validateDate, assertPublishedBlogReceipt, paperBatchDate, validatePublishImageExclusions };

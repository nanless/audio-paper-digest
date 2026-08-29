'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizedId } = require('./utils.js');
const {
    validateManualTutorialLongformBundle
} = require('./manual-tutorial-contract-orchestrator.js');
const { validateRecord, RECORDS_VERSION } = require('./create-manual-analysis-spec.js');
const {
    computeArtifactIndexSha256,
    validateStructuredArtifacts
} = require('./manual-artifact-index.js');
const {
    MANUAL_SIGNATURE_CONTRACT,
    stableSignatureSha256
} = require('./manual-signature-contract.js');
const { validateReadabilityRubric } = require('./editorial-quality.js');
const {
    needsMetadataCorrection,
    applyMetadataCorrection,
    buildCorrectionProof
} = require('./manual-v6-metadata-correction.js');

const MANUAL_RECORD_VERSION_V4 = 4;
const MANUAL_SPEC_VERSION_V6 = 6;
const MANUAL_DEPTH_V6 = 'full-text-evidence-v6';
const MANUAL_TAKEOVER_VERSION_V3 = 3;
const MANUAL_V6_RUNTIME_MODE_PRODUCTION = 'production';
const MANUAL_V6_RUNTIME_MODE_SHADOW = 'shadow';
const MANUAL_V6_AUTHOR_LINEAGE_CONTRACT = 'original-author-final-revision-v1';
const MANUAL_V6_REVISION_OUTPUT_CONTRACT = 'manual-v6-author-revision-output-v2';
const TASK_PACKET_VERSION = 3;
const WORKFLOW_STATE_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;
const BEIJING_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/;
const TASK_ROLES = new Set([
    'author', 'technical_scoring', 'pedagogy_readability', 'author_revision', 'final_page'
]);
const FRESH_EVIDENCE_RULES = Object.freeze([
    { kind: 'paper_metadata', authority: 'filtered_batch', pattern: /^evidence\/paper-metadata\.json$/u },
    { kind: 'source_snapshot', authority: 'source_identity', pattern: /^evidence\/source-snapshot\.json$/u },
    { kind: 'fulltext', authority: 'source_snapshot', pattern: /^evidence\/fulltext\.txt$/u },
    { kind: 'structured_fulltext', authority: 'artifact_index', pattern: /^evidence\/structured-source\.json$/u },
    { kind: 'artifact_index', authority: 'deterministic_parser', pattern: /^evidence\/artifact-index\.json$/u },
    { kind: 'paper_figure', authority: 'artifact_index', pattern: /^evidence\/figures\/IMG\d{4}\.(?:png|jpe?g|webp|gif|svg)$/u },
    { kind: 'authoring_prompt', authority: 'repository_file', pattern: /^instructions\/manual-tutorial-article\.md$/u },
    { kind: 'editorial_contract', authority: 'repository_file', pattern: /^instructions\/manual-editorial-reference-contract\.md$/u },
    { kind: 'record_template', authority: 'blank_schema', pattern: /^schema\/blank-record\.json$/u }
]);
const REVIEW_FINDING_RULES = Object.freeze([
    { kind: 'technical_review', authority: 'runner_validated_output', pattern: /^reviews\/technical-scoring\.json$/u },
    { kind: 'readability_review', authority: 'runner_validated_output', pattern: /^reviews\/pedagogy-readability\.json$/u }
]);
const TECHNICAL_SCORING_DIMENSIONS = Object.freeze([
    'innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity',
    'impact', 'openSource', 'reproducibility', 'engineering'
]);
const TECHNICAL_SCORING_MAXIMA = Object.freeze([2, 1.5, 1.5, 1, 1.5, 1.5, 0.5, 1.5]);
const OPEN_SOURCE_SCORE_ANCHORS = Object.freeze([0, 0.2, 0.5, 1, 1.2, 1.5]);
const REQUIRED_FRESH_EVIDENCE_KINDS = Object.freeze([
    'paper_metadata', 'source_snapshot', 'fulltext', 'artifact_index',
    'authoring_prompt', 'editorial_contract', 'record_template'
]);
const REPOSITORY_AUTHORITY_FILES = Object.freeze({
    authoring_prompt: path.resolve(__dirname, '..', 'prompts', 'manual-tutorial-article.md'),
    editorial_contract: path.resolve(__dirname, '..', 'docs', 'manual-editorial-reference-contract.md')
});
const FORBIDDEN_PROSE_KEY_RE = /^(?:analysis|readerArticle|article|post|draft|publishedPage|blogPage)$/iu;
const WORKFLOW_STAGES = Object.freeze([
    'source_snapshot', 'artifact_index', 'author', 'deterministic_validation',
    'technical_scoring', 'pedagogy_readability', 'author_revision', 'sealed_record', 'spec_shard',
    'canonical', 'page', 'final_page_review'
]);
const WORKFLOW_DEPENDENCIES = Object.freeze({
    source_snapshot: [],
    artifact_index: ['source_snapshot'],
    author: ['artifact_index'],
    deterministic_validation: ['author'],
    technical_scoring: ['deterministic_validation'],
    pedagogy_readability: ['deterministic_validation'],
    author_revision: ['technical_scoring', 'pedagogy_readability'],
    sealed_record: ['author_revision'],
    spec_shard: ['sealed_record'],
    canonical: ['spec_shard'],
    page: ['canonical'],
    final_page_review: ['page']
});

function stableSha256(value) {
    return stableSignatureSha256(value, 'manual-v6-signature');
}

function taskOutputContract(role) {
    if (!TASK_ROLES.has(role)) throw new Error('task output contract role 非法');
    const commonReceipt = {
        version: 1,
        requiredFields: [
            'role', 'paperId', 'taskName', 'singlePaperOnly', 'isolatedContext',
            'model', 'reasoningEffort', 'queuedAt', 'startedAt', 'completedAt',
            'revision', 'outputSha256'
        ],
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        semanticShaAlgorithm: MANUAL_SIGNATURE_CONTRACT
    };
    if (role === 'technical_scoring') return {
        version: 1,
        fixedOutputPath: 'reviews/technical-scoring.json',
        fixedReceiptPath: 'receipts/technical-scoring.json',
        requiredOutputFields: [
            'version', 'role', 'paperId', 'taskName', 'passed', 'issues',
            'findings', 'evidenceChecks', 'dims', 'confidence',
            'scoringReasons', 'scoringCalibration'
        ],
        dims: {
            order: [...TECHNICAL_SCORING_DIMENSIONS],
            maxima: [...TECHNICAL_SCORING_MAXIMA],
            totalMaximum: 10,
            decimalPlacesMaximum: 1,
            openSourceAnchors: [...OPEN_SOURCE_SCORE_ANCHORS]
        },
        scoringCalibration: {
            requiredDimensionKeys: [...TECHNICAL_SCORING_DIMENSIONS],
            independentTerraHigh: true,
            crossDimensionChecked: true,
            batchScaleChecked: true
        },
        receipt: commonReceipt
    };
    if (role === 'pedagogy_readability') return {
        version: 1,
        fixedOutputPath: 'reviews/pedagogy-readability.json',
        fixedReceiptPath: 'receipts/pedagogy-readability.json',
        requiredOutputFields: [
            'version', 'role', 'paperId', 'taskName', 'passed', 'issues',
            'findings', 'evidenceChecks', 'readabilityRubric'
        ],
        readabilityRubric: {
            independentTerraHigh: true,
            dimensions: [
                'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
                'factLocality', 'terminologyAndPerspective', 'sentenceRhythm',
                'antiTemplateOriginality'
            ],
            scoreRange: [0, 2],
            minimumTotal: 12
        },
        receipt: commonReceipt
    };
    if (role === 'author') return {
        version: 1,
        fixedOutputPath: 'outputs/author.json',
        fixedReceiptPath: 'receipts/author.json',
        descriptorContract: 'manual-v6-author-output-v2',
        receipt: commonReceipt
    };
    if (role === 'author_revision') return {
        version: 1,
        fixedOutputPath: 'outputs/author-revision.json',
        fixedReceiptPath: 'receipts/author-revision.json',
        descriptorContract: MANUAL_V6_REVISION_OUTPUT_CONTRACT,
        receipt: commonReceipt
    };
    return {
        version: 1,
        fixedOutputPath: 'reviews/final-page.json',
        fixedReceiptPath: 'receipts/final-page.json',
        receipt: commonReceipt
    };
}

function resolveManualV6RuntimePaths(currentDir, date, runtimeMode) {
    const root = path.resolve(String(currentDir || ''));
    if (!root || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
        throw new Error('Manual v6 runtime path 需要 currentDir 与合法日期');
    }
    if (![MANUAL_V6_RUNTIME_MODE_PRODUCTION, MANUAL_V6_RUNTIME_MODE_SHADOW].includes(runtimeMode)) {
        throw new Error('Manual v6 runtime mode 必须显式为 production 或 shadow');
    }
    const directoryName = runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
        ? 'manual-v6'
        : 'manual-v6-shadow';
    const batchDir = path.join(root, directoryName, date);
    return {
        runtimeMode,
        batchDir,
        specPath: path.join(batchDir, 'spec.json'),
        recordsEnvelopePath: path.join(batchDir, 'records-v4.json'),
        canonicalPath: runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
            ? path.join(root, 'deep-analysis-result.json')
            : path.join(batchDir, 'deep-analysis-result.json')
    };
}

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
    return value;
}

function assertSha(value, label) {
    if (!SHA256_RE.test(String(value || ''))) throw new Error(`${label} 必须是 SHA-256`);
    return value;
}

function assertText(value, label, minimum = 1) {
    const text = String(value || '').trim();
    if (text.length < minimum) throw new Error(`${label} 必须至少包含 ${minimum} 个字符`);
    return text;
}

function assertPaperId(value, expected, label) {
    const paperId = normalizedId(value);
    if (!paperId || (expected && paperId !== normalizedId(expected))) throw new Error(`${label} 论文 ID 不一致`);
    return paperId;
}

function normalizedRelativeArtifactPath(value, label) {
    const raw = assertText(value, label, 1).replace(/\\/g, '/');
    const normalized = path.posix.normalize(raw);
    if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')
        || normalized.includes('/../') || normalized === '.') {
        throw new Error(`${label} 必须是单篇工件根下的安全相对路径`);
    }
    return normalized;
}

function fileSha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function artifactRuleForPath(role, artifactPath) {
    const rules = role === 'author_revision'
        ? [...FRESH_EVIDENCE_RULES, ...REVIEW_FINDING_RULES]
        : FRESH_EVIDENCE_RULES;
    const matches = rules.filter(rule => rule.pattern.test(artifactPath));
    if (matches.length !== 1) {
        throw new Error(`${role} task packet 工件路径不属于确定性权威白名单: ${artifactPath}`);
    }
    return matches[0];
}

function validateFreshAuthoringArtifacts(role, artifacts) {
    if (role !== 'author' && role !== 'author_revision') return;
    for (const [index, artifact] of artifacts.entries()) {
        const rule = artifactRuleForPath(role, artifact.path);
        if (artifact.kind !== rule.kind || artifact.authority !== rule.authority) {
            throw new Error(`${role} task packet allowedArtifacts[${index}] 的 kind/authority 必须由路径确定，禁止自报伪装`);
        }
    }
    const evidence = artifacts.filter(item => item.authority !== 'runner_validated_output');
    for (const kind of REQUIRED_FRESH_EVIDENCE_KINDS) {
        if (evidence.filter(item => item.kind === kind).length !== 1) {
            throw new Error(`${role} task packet 必须且只能绑定一份权威 ${kind}`);
        }
    }
    if (role === 'author' && artifacts.length !== evidence.length) {
        throw new Error('author task packet 禁止读取 review 或历史正文工件');
    }
    if (role === 'author_revision') {
        for (const kind of ['technical_review', 'readability_review']) {
            if (artifacts.filter(item => item.kind === kind).length !== 1) {
                throw new Error(`author_revision task packet 必须且只能绑定一份当前 runner 验证的 ${kind}`);
            }
        }
    }
}

function parseJsonFile(filePath, label) {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return assertObject(value, label);
    } catch (error) {
        throw new Error(`${label} 必须是合法 JSON 对象: ${error.message}`);
    }
}

function isBlankValue(value) {
    if (value === null || value === undefined || value === '') return true;
    if (Array.isArray(value)) return value.length === 0;
    return typeof value === 'object' && Object.keys(value).length === 0;
}

function isExactBlankSchemaDescriptor(key, value) {
    if (key !== 'article' || !value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    return keys.length === 2 && keys[0] === 'fileSha256' && keys[1] === 'path'
        && value.path === 'draft/author-article.md'
        && value.fileSha256 === 'SHA256_OF_RAW_FILE_BYTES';
}

function containsFilledProseField(value) {
    if (Array.isArray(value)) return value.some(containsFilledProseField);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) => (
        (FORBIDDEN_PROSE_KEY_RE.test(key) && !isBlankValue(child)
            && !isExactBlankSchemaDescriptor(key, child)) || containsFilledProseField(child)
    ));
}

function validateFreshAuthorityFiles(packet, files, options = {}) {
    if (packet.role !== 'author' && packet.role !== 'author_revision') return;
    const byKind = new Map(files.map(item => [item.artifact.kind, item]));
    const metadata = parseJsonFile(byKind.get('paper_metadata').resolved, 'paper_metadata');
    if (normalizedId(metadata.arxivId || metadata.id || metadata.paperId) !== packet.paperId) {
        throw new Error('paper_metadata 未绑定当前论文 ID');
    }
    if (options.expectedPaperMetadata
        && stableSha256(metadata) !== stableSha256(options.expectedPaperMetadata)) {
        throw new Error('paper_metadata 不是 runner 绑定 filtered 批次中的当前论文元数据');
    }
    if (options.expectedPaperInputSha256
        && packet.paperInputSha256 !== options.expectedPaperInputSha256) {
        throw new Error('task packet.paperInputSha256 不是 runner 绑定 filtered 批次的确定性输入身份');
    }
    const snapshot = parseJsonFile(byKind.get('source_snapshot').resolved, 'source_snapshot');
    if (normalizedId(snapshot.paperId) !== packet.paperId
        || snapshot.paperInputSha256 !== packet.paperInputSha256
        || snapshot.sourceIdentitySha256 !== packet.sourceIdentitySha256) {
        throw new Error('source_snapshot 未绑定当前论文 input/source identity');
    }
    for (const field of ['source', 'sourceId', 'sourceSha256']) assertText(snapshot[field], `source_snapshot.${field}`, 1);
    assertSha(snapshot.sourceSha256, 'source_snapshot.sourceSha256');
    const expectedSourceIdentity = stableSha256({
        source: snapshot.source, sourceId: snapshot.sourceId, sourceSha256: snapshot.sourceSha256
    });
    if (expectedSourceIdentity !== packet.sourceIdentitySha256) {
        throw new Error('source_snapshot source identity 不是来源字段的确定性签名');
    }
    if (byKind.get('fulltext').artifact.sha256 !== snapshot.sourceSha256) {
        throw new Error('fulltext 文件字节未绑定 source_snapshot.sourceSha256，禁止用改名旧稿冒充全文');
    }
    const artifactIndex = parseJsonFile(byKind.get('artifact_index').resolved, 'artifact_index');
    if (artifactIndex.paperId !== packet.paperId
        || artifactIndex.inputIdentity?.paperInputSha256 !== packet.paperInputSha256
        || artifactIndex.inputIdentity?.sourceIdentitySha256 !== packet.sourceIdentitySha256
        || artifactIndex.inputIdentity?.sourceSha256 !== snapshot.sourceSha256
        || artifactIndex.artifactIndexSha256 !== computeArtifactIndexSha256(artifactIndex)
        || artifactIndex.outputSha256 !== artifactIndex.artifactIndexSha256) {
        throw new Error('artifact_index 不是当前 source snapshot 的确定性索引');
    }
    const structured = byKind.get('structured_fulltext');
    const expectedStructuredSha = String(artifactIndex.inputIdentity?.structuredArtifactsSha256 || '');
    if (expectedStructuredSha) {
        if (!structured) throw new Error('artifact_index 声明结构化全文时必须绑定 structured_fulltext');
        const envelope = parseJsonFile(structured.resolved, 'structured_fulltext');
        if (envelope.paperId !== packet.paperId || envelope.paperInputSha256 !== packet.paperInputSha256
            || envelope.sourceIdentitySha256 !== packet.sourceIdentitySha256
            || envelope.sourceSha256 !== snapshot.sourceSha256
            || envelope.payloadSha256 !== expectedStructuredSha) {
            throw new Error('structured_fulltext envelope 未绑定当前 ArtifactIndex/source snapshot');
        }
        validateStructuredArtifacts(envelope.structuredArtifacts, {
            paperId: packet.paperId, sourceId: snapshot.sourceId, sourceSha256: snapshot.sourceSha256
        });
        if (envelope.structuredArtifacts.payloadSha256 !== expectedStructuredSha) {
            throw new Error('structured_fulltext payload SHA 与 ArtifactIndex 不一致');
        }
    } else if (structured) {
        throw new Error('ArtifactIndex 未声明结构化输入，不得额外塞入 structured_fulltext');
    }
    for (const [kind, repositoryPath] of Object.entries(REPOSITORY_AUTHORITY_FILES)) {
        if (byKind.get(kind).artifact.sha256 !== fileSha256(repositoryPath)) {
            throw new Error(`${kind} 不是仓库当前固定权威文件`);
        }
    }
    const blankTemplate = parseJsonFile(byKind.get('record_template').resolved, 'record_template');
    if (blankTemplate.version !== 1 || blankTemplate.mode !== 'manual_v6_blank_record_schema'
        || blankTemplate.paperId !== packet.paperId || blankTemplate.populated !== false
        || containsFilledProseField(blankTemplate)) {
        throw new Error('record_template 必须是绑定当前论文且不含历史正文/analysis 的空白 schema');
    }
    const figures = files.filter(item => item.artifact.kind === 'paper_figure');
    const figureIndex = new Map((artifactIndex.figures || artifactIndex.images || [])
        .map(item => [item.id, item]));
    for (const figure of figures) {
        const id = path.basename(figure.artifact.path).match(/^(IMG\d{4})\./u)?.[1];
        const authority = figureIndex.get(id);
        const authoritativeFileSha = String(
            authority?.cacheSha256 || authority?.fileSha256 || authority?.sha256 || ''
        );
        if (!id || !authority || authoritativeFileSha !== figure.artifact.sha256) {
            throw new Error(`paper_figure ${figure.artifact.path} 未由当前 ArtifactIndex 的缓存字节 SHA 授权`);
        }
    }
}

function validateTaskReceipt(value, role, paperId, label) {
    const receipt = assertObject(value, label);
    if (receipt.role !== role || !TASK_ROLES.has(role)) throw new Error(`${label}.role 非法`);
    assertPaperId(receipt.paperId, paperId, `${label}.paperId`);
    if (receipt.singlePaperOnly !== true || receipt.isolatedContext !== true
        || receipt.model !== 'gpt-5.6-terra' || receipt.reasoningEffort !== 'high') {
        throw new Error(`${label} 必须绑定单篇隔离的 gpt-5.6-terra/high task`);
    }
    assertText(receipt.taskName, `${label}.taskName`, 4);
    // Early production-runner receipts used inputPacketSha256 for the same
    // content-addressed packet identity.  Keep the original signed bytes and
    // normalize only the validated view, matching task-runner verification.
    const consumedPacketSha256 = receipt.consumedPacketSha256 || receipt.inputPacketSha256;
    assertSha(consumedPacketSha256, `${label}.consumedPacketSha256`);
    assertSha(receipt.outputSha256, `${label}.outputSha256`);
    if (!BEIJING_TIMESTAMP_RE.test(String(receipt.completedAt || ''))) {
        throw new Error(`${label}.completedAt 必须是北京时间 ISO 时间戳`);
    }
    return { ...receipt, consumedPacketSha256 };
}

function buildTaskPacket(options = {}) {
    const role = options.role;
    if (!TASK_ROLES.has(role)) throw new Error('task packet role 非法');
    const paperId = assertPaperId(options.paperId, null, 'task packet');
    const allowedArtifacts = Array.isArray(options.allowedArtifacts) ? options.allowedArtifacts.map((raw, index) => {
        const item = assertObject(raw, `allowedArtifacts[${index}]`);
        const normalizedPath = normalizedRelativeArtifactPath(item.path, `allowedArtifacts[${index}].path`);
        const rule = (role === 'author' || role === 'author_revision')
            ? artifactRuleForPath(role, normalizedPath)
            : null;
        if (rule && item.kind !== rule.kind) {
            throw new Error(`${role} task packet 禁止把 ${normalizedPath} 自报为 ${item.kind || '(missing)'}；kind 必须由路径确定`);
        }
        return {
            path: normalizedPath,
            sha256: assertSha(item.sha256, `allowedArtifacts[${index}].sha256`),
            kind: rule ? rule.kind : assertText(item.kind, `allowedArtifacts[${index}].kind`, 2),
            ...(rule ? { authority: rule.authority } : {})
        };
    }) : [];
    if (allowedArtifacts.length < 1) throw new Error('task packet 至少绑定一个单篇工件');
    if (new Set(allowedArtifacts.map(item => item.path)).size !== allowedArtifacts.length) {
        throw new Error('task packet allowedArtifacts.path 不得重复');
    }
    validateFreshAuthoringArtifacts(role, allowedArtifacts);
    const packet = {
        version: TASK_PACKET_VERSION,
        role,
        ...(role === 'author' ? { authoringMode: 'fresh_from_evidence' } : {}),
        ...(role === 'author_revision' ? {
            authoringMode: 'fresh_replacement_from_evidence_and_findings'
        } : {}),
        paperId,
        paperInputSha256: assertSha(options.paperInputSha256, 'task packet.paperInputSha256'),
        sourceIdentitySha256: assertSha(options.sourceIdentitySha256, 'task packet.sourceIdentitySha256'),
        allowedArtifacts,
        contractSha256: assertSha(options.contractSha256, 'task packet.contractSha256')
    };
    // Legacy production-v6 packets remain verifiable when this optional field is
    // absent.  Every newly materialized packet includes the canonical role
    // contract, so a leaf does not need an out-of-band schema or hashing recipe.
    if (options.outputContract !== undefined) {
        const expectedOutputContract = taskOutputContract(role);
        if (stableSha256(options.outputContract) !== stableSha256(expectedOutputContract)) {
            throw new Error('task packet.outputContract 与当前角色正式契约不一致');
        }
        packet.outputContract = expectedOutputContract;
    }
    packet.packetSha256 = stableSha256(packet);
    return packet;
}

function validateTaskPacket(packet, options = {}) {
    const rebuilt = buildTaskPacket(packet);
    if (packet.version !== TASK_PACKET_VERSION || packet.packetSha256 !== rebuilt.packetSha256) {
        throw new Error('task packet SHA 或版本不匹配');
    }
    if (options.paperId) assertPaperId(packet.paperId, options.paperId, 'task packet.paperId');
    if (options.requireFiles === true) {
        const declaredRoot = path.resolve(assertText(options.artifactRoot, 'task packet artifactRoot', 1));
        if (!fs.statSync(declaredRoot, { throwIfNoEntry: false })?.isDirectory()
            || fs.lstatSync(declaredRoot).isSymbolicLink()) {
            throw new Error('task packet artifactRoot 必须是存在的真实目录且不得是符号链接');
        }
        const artifactRoot = fs.realpathSync(declaredRoot);
        const verifiedFiles = [];
        for (const [index, artifact] of packet.allowedArtifacts.entries()) {
            const declared = path.resolve(artifactRoot, artifact.path);
            if (!fs.statSync(declared, { throwIfNoEntry: false })?.isFile()
                || fs.lstatSync(declared).isSymbolicLink()) {
                throw new Error(`task packet allowedArtifacts[${index}] 文件不存在或使用符号链接`);
            }
            const resolved = fs.realpathSync(declared);
            const relative = path.relative(artifactRoot, resolved);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new Error(`task packet allowedArtifacts[${index}] 逃逸单篇工件根`);
            }
            const embeddedPaperIds = artifact.path.match(/\b\d{4}\.\d{4,5}\b/g) || [];
            if (embeddedPaperIds.some(id => normalizedId(id) !== rebuilt.paperId)) {
                throw new Error(`task packet allowedArtifacts[${index}] 引用了其他论文目录`);
            }
            if (fileSha256(resolved) !== artifact.sha256) {
                throw new Error(`task packet allowedArtifacts[${index}] 文件 SHA 不匹配`);
            }
            verifiedFiles.push({ artifact, resolved });
        }
        validateFreshAuthorityFiles(rebuilt, verifiedFiles, options);
    }
    return packet;
}

function artifactIdentity(item) {
    return {
        path: item.path,
        sha256: item.sha256,
        kind: item.kind,
        authority: item.authority
    };
}

function validateAuthorRevisionArtifactLineage(authorPacket, revisionPacket, reviewArtifacts = {}) {
    const author = validateTaskPacket(authorPacket);
    const revision = validateTaskPacket(revisionPacket);
    if (author.role !== 'author' || revision.role !== 'author_revision'
        || author.paperId !== revision.paperId
        || author.paperInputSha256 !== revision.paperInputSha256
        || author.sourceIdentitySha256 !== revision.sourceIdentitySha256) {
        throw new Error('author_revision 与 author packet 不是同一篇权威证据输入');
    }
    const revisionEvidence = revision.allowedArtifacts
        .filter(item => item.authority !== 'runner_validated_output')
        .map(artifactIdentity);
    const authorEvidence = author.allowedArtifacts.map(artifactIdentity);
    if (stableSha256(revisionEvidence) !== stableSha256(authorEvidence)) {
        throw new Error('author_revision 必须逐项复用 author 的同序权威 evidence allowlist，禁止增删或替换');
    }
    const expectedReviews = [
        ['technical_review', reviewArtifacts.technical],
        ['readability_review', reviewArtifacts.readability]
    ];
    for (const [kind, expected] of expectedReviews) {
        if (!expected || !SHA256_RE.test(String(expected.sha256 || ''))
            || typeof expected.path !== 'string') {
            throw new Error(`author_revision 缺少 runner/assembler 验证的 ${kind} 工件身份`);
        }
        const artifact = revision.allowedArtifacts.find(item => item.kind === kind);
        if (!artifact || artifact.path !== normalizedRelativeArtifactPath(expected.path, `${kind}.path`)
            || artifact.sha256 !== expected.sha256
            || artifact.authority !== 'runner_validated_output') {
            throw new Error(`author_revision 的 ${kind} 不是当前已验证 review 输出`);
        }
    }
    return revision;
}

function validateReviewOutput(output, role, paperId, receipt, label) {
    const value = assertObject(output, label);
    if (value.version !== 1 || value.role !== role) throw new Error(`${label} 版本或 role 非法`);
    assertPaperId(value.paperId, paperId, `${label}.paperId`);
    if (value.taskName !== receipt.taskName) throw new Error(`${label}.taskName 与 receipt 不一致`);
    if (value.passed !== true) throw new Error(`${label}.passed 必须明确为 true`);
    if (!Array.isArray(value.issues)) throw new Error(`${label}.issues 必须是数组`);
    if (!Array.isArray(value.findings) || value.findings.length < 2) {
        throw new Error(`${label}.findings 必须包含至少 2 条实质审查结论`);
    }
    value.findings.forEach((finding, index) => {
        if (typeof finding === 'string') {
            assertText(finding, `${label}.findings[${index}]`, 20);
            return;
        }
        const item = assertObject(finding, `${label}.findings[${index}]`);
        assertText(item.text, `${label}.findings[${index}].text`, 20);
        assertText(item.severity, `${label}.findings[${index}].severity`, 2);
        assertText(item.category, `${label}.findings[${index}].category`, 2);
        if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
            throw new Error(`${label}.findings[${index}].evidence 必须包含至少一条可定位证据`);
        }
        item.evidence.forEach((evidence, evidenceIndex) => {
            const evidenceLabel = `${label}.findings[${index}].evidence[${evidenceIndex}]`;
            if (typeof evidence === 'string') {
                assertText(evidence, evidenceLabel, 3);
                return;
            }
            const evidenceItem = assertObject(evidence, evidenceLabel);
            assertText(evidenceItem.artifact, `${evidenceLabel}.artifact`, 3);
            assertText(evidenceItem.locator, `${evidenceLabel}.locator`, 3);
        });
    });
    if (!Array.isArray(value.evidenceChecks) || value.evidenceChecks.length < 2) {
        throw new Error(`${label}.evidenceChecks 必须包含至少 2 条局部证据核验`);
    }
    value.evidenceChecks.forEach((check, index) => {
        const item = assertObject(check, `${label}.evidenceChecks[${index}]`);
        if (Object.hasOwn(item, 'claim') || Object.hasOwn(item, 'evidenceId')) {
            assertText(item.claim, `${label}.evidenceChecks[${index}].claim`, 12);
            assertText(item.evidenceId, `${label}.evidenceChecks[${index}].evidenceId`, 2);
            if (item.verified !== true) throw new Error(`${label}.evidenceChecks[${index}] 必须 verified=true`);
            return;
        }
        assertText(item.check, `${label}.evidenceChecks[${index}].check`, 4);
        assertText(item.detail, `${label}.evidenceChecks[${index}].detail`, 12);
        if (item.passed !== true) throw new Error(`${label}.evidenceChecks[${index}] 必须 passed=true`);
    });
    if (role === 'technical_scoring') {
        if (!Array.isArray(value.dims) || value.dims.length !== TECHNICAL_SCORING_DIMENSIONS.length) {
            throw new Error(`${label}.dims 必须按正式 V6 顺序包含恰好 8 项评分`);
        }
        let total = 0;
        value.dims.forEach((score, index) => {
            if (!Number.isFinite(score) || score < 0 || score > TECHNICAL_SCORING_MAXIMA[index]
                || Math.abs(score * 10 - Math.round(score * 10)) > Number.EPSILON * 10) {
                throw new Error(`${label}.dims[${index}] 超出正式 V6 上限或不是至多一位小数`);
            }
            total += score;
        });
        if (total > 10 + Number.EPSILON * 10) {
            throw new Error(`${label}.dims 总分不得超过 10`);
        }
        if (!OPEN_SOURCE_SCORE_ANCHORS.some(anchor => Math.abs(anchor - value.dims[5]) < 1e-9)) {
            throw new Error(`${label}.dims[5] 必须使用正式 V6 开源评分锚点`);
        }
        if (!['高', '中', '低'].includes(value.confidence)) {
            throw new Error(`${label}.confidence 必须是高/中/低`);
        }
        if (!Array.isArray(value.scoringReasons) || value.scoringReasons.length !== 8) {
            throw new Error(`${label}.scoringReasons 必须恰好包含 8 条论文特定理由`);
        }
        value.scoringReasons.forEach((reason, index) => {
            assertText(reason, `${label}.scoringReasons[${index}]`, 20);
        });
        const calibration = assertObject(value.scoringCalibration, `${label}.scoringCalibration`);
        if (calibration.version !== 1 || calibration.independentReview !== true
            || calibration.reviewerTaskName !== value.taskName
            || calibration.model !== 'gpt-5.6-terra'
            || calibration.reasoningEffort !== 'high'
            || calibration.crossDimensionChecked !== true
            || calibration.batchScaleChecked !== true) {
            throw new Error(`${label}.scoringCalibration 必须绑定当前独立 Terra-high reviewer 与完整校准动作`);
        }
        assertText(calibration.calibrationNotes, `${label}.scoringCalibration.calibrationNotes`, 40);
        const byDimension = assertObject(
            calibration.evidenceIdsByDimension,
            `${label}.scoringCalibration.evidenceIdsByDimension`
        );
        const keys = Object.keys(byDimension);
        if (keys.length !== TECHNICAL_SCORING_DIMENSIONS.length
            || TECHNICAL_SCORING_DIMENSIONS.some(key => !Object.hasOwn(byDimension, key))) {
            throw new Error(`${label}.scoringCalibration.evidenceIdsByDimension 必须精确覆盖正式 V6 八维`);
        }
        TECHNICAL_SCORING_DIMENSIONS.forEach(dimension => {
            const ids = byDimension[dimension];
            if (!Array.isArray(ids) || ids.length < 1 || ids.length > 6) {
                throw new Error(`${label}.scoringCalibration.evidenceIdsByDimension.${dimension} 必须包含 1-6 个证据 ID`);
            }
            const normalized = ids.map((id, index) => assertText(
                id,
                `${label}.scoringCalibration.evidenceIdsByDimension.${dimension}[${index}]`,
                2
            ));
            if (new Set(normalized).size !== normalized.length) {
                throw new Error(`${label}.scoringCalibration.evidenceIdsByDimension.${dimension} 不得重复`);
            }
        });
    }
    if (role === 'pedagogy_readability') {
        const rubric = assertObject(value.readabilityRubric, `${label}.readabilityRubric`);
        assertPaperId(rubric.paperId, paperId, `${label}.readabilityRubric.paperId`);
        if (rubric.independentReview !== true
            || rubric.reviewerTaskName !== value.taskName
            || rubric.model !== 'gpt-5.6-terra'
            || rubric.reasoningEffort !== 'high') {
            throw new Error(`${label}.readabilityRubric 必须绑定当前独立 Terra-high reviewer`);
        }
        const validation = validateReadabilityRubric(rubric, { minimumTotal: 12 });
        if (!validation.valid || !validation.passing) {
            throw new Error(`${label}.readabilityRubric 未通过 7 维门禁: ${validation.errors.join('; ') || `total=${validation.total}`}`);
        }
        const scores = Object.values(rubric.dimensions).map(item => item.score);
        if (scores.every(score => score === 2)) {
            if (!Array.isArray(rubric.counterEvidence) || rubric.counterEvidence.length < 3) {
                throw new Error(`${label}.readabilityRubric 全满分时必须包含至少 3 条反证审计`);
            }
            rubric.counterEvidence.forEach((item, index) => {
                assertText(item, `${label}.readabilityRubric.counterEvidence[${index}]`, 20);
            });
        }
    }
    if (stableSha256(value) !== receipt.outputSha256) {
        throw new Error(`${label} 的真实输出 SHA 与 receipt 不一致`);
    }
    return value;
}

function validateRevisionOutput(output, paperId, receipt, options = {}) {
    const label = options.label || 'manual record reviewOutputs.authorRevision';
    const value = assertObject(output, label);
    const runtimeMode = options.runtimeMode || MANUAL_V6_RUNTIME_MODE_PRODUCTION;
    const isProduction = runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION;
    if ((isProduction && (value.version !== 2
            || value.contract !== MANUAL_V6_REVISION_OUTPUT_CONTRACT))
        || (!isProduction && value.version !== 1)
        || value.role !== 'author_revision') {
        throw new Error(`${label} 版本或 role 非法`);
    }
    assertPaperId(value.paperId, paperId, `${label}.paperId`);
    if (value.taskName !== receipt.taskName || value.passed !== true) {
        throw new Error(`${label} 必须由 receipt 对应任务明确完成`);
    }
    for (const [field, expected] of Object.entries({
        technicalOutputSha256: options.technicalOutputSha256,
        readabilityOutputSha256: options.readabilityOutputSha256,
        finalArticleSha256: options.finalArticleSha256
    })) {
        assertSha(value[field], `${label}.${field}`);
        if (expected && value[field] !== expected) throw new Error(`${label}.${field} 未绑定真实输入/最终正文`);
    }
    if (!Array.isArray(value.resolvedFindingSha256s)) {
        throw new Error(`${label}.resolvedFindingSha256s 必须是数组`);
    }
    value.resolvedFindingSha256s.forEach((sha, index) => assertSha(sha, `${label}.resolvedFindingSha256s[${index}]`));
    if (!Array.isArray(value.notes) || value.notes.length < 2) {
        throw new Error(`${label}.notes 必须记录至少 2 条具体修订`);
    }
    value.notes.forEach((note, index) => assertText(note, `${label}.notes[${index}]`, 20));
    if (stableSha256(value) !== receipt.outputSha256) {
        throw new Error(`${label} 的真实输出 SHA 与 receipt 不一致`);
    }
    if (isProduction) {
        const root = path.resolve(assertText(options.artifactRoot, `${label}.artifactRoot`, 1));
        if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()
            || fs.lstatSync(root).isSymbolicLink()) {
            throw new Error(`${label}.artifactRoot 必须是真实目录且不得使用符号链接`);
        }
        const realRoot = fs.realpathSync(root);
        const refs = [
            ['finalArticle', value.finalArticle, 'draft/final-article.md'],
            ['recordPayload', value.recordPayload, 'draft/revision-record-payload.json']
        ];
        for (const [field, ref, expectedPath] of refs) {
            if (!ref || ref.path !== expectedPath || !SHA256_RE.test(String(ref.fileSha256 || ''))) {
                throw new Error(`${label}.${field} 必须绑定固定路径与真实文件 SHA`);
            }
            const declared = path.resolve(realRoot, expectedPath);
            if (!fs.statSync(declared, { throwIfNoEntry: false })?.isFile()
                || fs.lstatSync(declared).isSymbolicLink()) {
                throw new Error(`${label}.${field} 文件不存在或使用符号链接`);
            }
            const resolved = fs.realpathSync(declared);
            const relative = path.relative(realRoot, resolved);
            if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                throw new Error(`${label}.${field} 经 realpath 逃逸单篇工件根`);
            }
            const bytes = fs.readFileSync(resolved);
            if (crypto.createHash('sha256').update(bytes).digest('hex') !== ref.fileSha256) {
                throw new Error(`${label}.${field} 文件 SHA 不匹配`);
            }
            if (field === 'finalArticle') {
                const normalized = bytes.toString('utf8').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
                const articleSha256 = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
                if (articleSha256 !== value.finalArticleSha256) {
                    throw new Error(`${label}.finalArticleSha256 未绑定真实 NFKC/trim 最终正文`);
                }
            } else {
                if (!SHA256_RE.test(String(ref.semanticSha256 || ''))) {
                    throw new Error(`${label}.recordPayload.semanticSha256 缺失`);
                }
                let payload;
                try { payload = JSON.parse(bytes.toString('utf8')); } catch (error) {
                    throw new Error(`${label}.recordPayload JSON 损坏: ${error.message}`);
                }
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)
                    || normalizedId(payload.paperId || payload.arxivId) !== paperId
                    || payload.reviewReceipts || payload.reviewResolution || payload.sealedRecordSha256
                    || payload.editorial?.longformBundle?.authorReceipt
                    || payload.editorial?.longformBundle?.finalRevisionAuthorReceipt
                    || stableSha256(payload) !== ref.semanticSha256) {
                    throw new Error(`${label}.recordPayload 身份、语义 SHA 或未封印状态非法`);
                }
                options.onVerifiedRecordPayload?.(payload);
            }
        }
    }
    return value;
}

function semanticRecordPayload(record) {
    const { sealedRecordSha256: _sealedRecordSha256, ...payload } = record;
    return payload;
}

function normalizeLegacyArtifactIndexBinding(record, artifactIndex, artifactIndexFileSha256) {
    if (!artifactIndex) return record;
    const source = record?.sourceSnapshot;
    const semanticSha256 = String(artifactIndex.outputSha256 || '');
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || artifactIndex.paperId !== record.paperId
        || !SHA256_RE.test(semanticSha256)
        || !SHA256_RE.test(String(artifactIndexFileSha256 || ''))) {
        throw new Error('sealed record 无法确定性绑定当前 ArtifactIndex 文件与语义身份');
    }
    if (source.artifactIndexFileSha256 === undefined
        && source.artifactIndexSha256 === artifactIndexFileSha256) {
        source.artifactIndexFileSha256 = artifactIndexFileSha256;
    }
    if (source.artifactIndexFileSha256 !== artifactIndexFileSha256) {
        throw new Error('sealed record 无法确定性绑定当前 ArtifactIndex 文件与语义身份');
    }
    if (source.artifactIndexSha256 !== semanticSha256) {
        const legacyObjectSha256 = stableSha256(artifactIndex);
        const inputIdentity = artifactIndex.inputIdentity;
        const structuredAliasMatches = source.artifactIndexSha256 === inputIdentity?.structuredArtifactsSha256
            && source.paperInputSha256 === inputIdentity?.paperInputSha256
            && source.sourceIdentitySha256 === inputIdentity?.sourceIdentitySha256
            && source.sourceSha256 === inputIdentity?.sourceSha256;
        if (source.artifactIndexSha256 !== artifactIndexFileSha256
            && source.artifactIndexSha256 !== legacyObjectSha256
            && !structuredAliasMatches) {
            throw new Error('sealed record ArtifactIndex 语义身份不是当前 SHA 或可重放 legacy 别名');
        }
        source.artifactIndexSha256 = semanticSha256;
    }
    return record;
}

function validateManualRecordV4(record, artifactIndex, verificationContext = {}) {
    const value = assertObject(record, 'manual record v4');
    if (value.version !== MANUAL_RECORD_VERSION_V4 || value.manualDepth !== MANUAL_DEPTH_V6) {
        throw new Error('manual record 必须是 records v4 / full-text-evidence-v6');
    }
    const paperId = assertPaperId(value.paperId, null, 'manual record.paperId');
    const correctionContext = verificationContext.metadataCorrection || null;
    if (Boolean(value.metadataCorrectionProof) !== Boolean(correctionContext)) {
        throw new Error('manual record metadataCorrectionProof 与 records manifest context 不一致');
    }
    if (correctionContext) {
        if (stableSha256(value.metadataCorrectionProof) !== stableSha256(buildCorrectionProof(correctionContext))) {
            throw new Error('manual record metadataCorrectionProof 未绑定当前 manifest/correction/receipt');
        }
        if (!needsMetadataCorrection(correctionContext.originalPayload)) {
            throw new Error('manual record metadata correction 是已合法 payload 的 orphan correction');
        }
    }
    // records v4/spec v6 正式契约复用 records v3 validator 作为基础子校验，
    // 不能绕开其标题、作者、八维评分、证据账本、结果 claims、开源资源、图片和可读性门禁。
    validateRecord(value, paperId, `manual record ${paperId}`, { recordsVersion: RECORDS_VERSION });
    const source = assertObject(value.sourceSnapshot, 'manual record.sourceSnapshot');
    assertSha(source.paperInputSha256, 'manual record.sourceSnapshot.paperInputSha256');
    assertSha(source.sourceIdentitySha256, 'manual record.sourceSnapshot.sourceIdentitySha256');
    assertSha(source.artifactIndexSha256, 'manual record.sourceSnapshot.artifactIndexSha256');
    assertSha(source.artifactIndexFileSha256, 'manual record.sourceSnapshot.artifactIndexFileSha256');
    if (artifactIndex?.outputSha256 !== source.artifactIndexSha256
        || artifactIndex?.paperId !== paperId) {
        throw new Error('manual record 绑定的 ArtifactIndex 身份不一致');
    }
    const editorial = assertObject(value.editorial, 'manual record.editorial');
    const runtimeMode = verificationContext.runtimeMode || MANUAL_V6_RUNTIME_MODE_PRODUCTION;
    const editorialPlanVersion = value.researchBrief?.editorialPlan?.version;
    const signedLegacyEditorialPlan = verificationContext.allowSignedLegacyEditorialPlan === true
        && runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION
        && [undefined, 1, 3].includes(editorialPlanVersion)
        && editorial.longformBundle?.version === 2
        && editorial.longformBundle?.contract === 'reader-longform-v2';
    if (editorialPlanVersion !== 2 && !signedLegacyEditorialPlan) {
        throw new Error('manual record v4 必须使用 researchBrief.editorialPlan v2');
    }
    const article = assertText(editorial.readerArticle, 'manual record.editorial.readerArticle', 2400);
    validateManualTutorialLongformBundle(editorial.longformBundle, article, artifactIndex, {
        paperId, runtimeMode,
        // Production V6 records may carry a table fragment signed by the
        // revision receipt before a deterministic renderer refactor. Numeric
        // cell coverage, source matrix SHA, block inclusion and fragment SHA
        // remain mandatory; only byte equality with today's renderer is
        // relaxed for that already-signed fragment.
        allowSignedLegacyTableRender: verificationContext.allowSignedLegacyTableRender === true
    });
    const receipts = assertObject(value.reviewReceipts, 'manual record.reviewReceipts');
    const technical = validateTaskReceipt(
        receipts.technicalScoring, 'technical_scoring', paperId,
        'manual record.reviewReceipts.technicalScoring'
    );
    const readability = validateTaskReceipt(
        receipts.pedagogyReadability, 'pedagogy_readability', paperId,
        'manual record.reviewReceipts.pedagogyReadability'
    );
    const revision = validateTaskReceipt(
        receipts.authorRevision, 'author_revision', paperId,
        'manual record.reviewReceipts.authorRevision'
    );
    if (runtimeMode === MANUAL_V6_RUNTIME_MODE_PRODUCTION) {
        if (!editorial.longformBundle.finalRevisionAuthorReceipt
            || stableSha256(editorial.longformBundle.finalRevisionAuthorReceipt) !== stableSha256(revision)) {
            throw new Error('production record 的 finalRevisionAuthorReceipt 必须等于真实 author_revision receipt');
        }
        if (revision.articleSha256 !== editorial.longformBundle.articleSha256) {
            throw new Error('author_revision receipt.articleSha256 未绑定最终 readerArticle');
        }
    }
    const authorTaskName = editorial.longformBundle.authorReceipt?.taskName;
    if (new Set([authorTaskName, technical.taskName, readability.taskName, revision.taskName]).size !== 4) {
        throw new Error('manual record 的 author、technical/scoring、readability、revision 必须是不同 task');
    }
    const packets = assertObject(verificationContext.taskPackets, 'manual record verificationContext.taskPackets');
    const outputs = assertObject(verificationContext.reviewOutputs, 'manual record verificationContext.reviewOutputs');
    const packetOptions = { paperId, artifactRoot: verificationContext.artifactRoot, requireFiles: true };
    const authorPacket = validateTaskPacket(packets.author, packetOptions);
    const technicalPacket = validateTaskPacket(packets.technicalScoring, packetOptions);
    const readabilityPacket = validateTaskPacket(packets.pedagogyReadability, packetOptions);
    const revisionPacket = validateTaskPacket(packets.authorRevision, packetOptions);
    if (authorPacket.role !== 'author'
        || technicalPacket.role !== 'technical_scoring'
        || readabilityPacket.role !== 'pedagogy_readability'
        || revisionPacket.role !== 'author_revision') {
        throw new Error('manual record task packet role 与工作流节点不一致');
    }
    for (const packet of [authorPacket, technicalPacket, readabilityPacket, revisionPacket]) {
        if (packet.paperInputSha256 !== source.paperInputSha256
            || packet.sourceIdentitySha256 !== source.sourceIdentitySha256) {
            throw new Error('manual record task packet 未绑定同篇 sourceSnapshot input/source identity');
        }
    }
    if (editorial.longformBundle.authorReceipt.inputPacketSha256 !== authorPacket.packetSha256
        || technical.consumedPacketSha256 !== technicalPacket.packetSha256
        || readability.consumedPacketSha256 !== readabilityPacket.packetSha256
        || revision.consumedPacketSha256 !== revisionPacket.packetSha256) {
        throw new Error('manual record receipt 未绑定真实 task packet');
    }
    const technicalOutput = validateReviewOutput(
        outputs.technicalScoring, 'technical_scoring', paperId, technical,
        'manual record reviewOutputs.technicalScoring'
    );
    const readabilityOutput = validateReviewOutput(
        outputs.pedagogyReadability, 'pedagogy_readability', paperId, readability,
        'manual record reviewOutputs.pedagogyReadability'
    );
    const resolution = assertObject(value.reviewResolution, 'manual record.reviewResolution');
    const revisionTaskName = assertText(
        resolution.revisionTaskName, 'manual record.reviewResolution.revisionTaskName', 4
    );
    if (revisionTaskName !== revision.taskName) {
        throw new Error('manual record.reviewResolution.revisionTaskName 与 author_revision receipt 不一致');
    }
    if (resolution.technicalOutputSha256 !== technical.outputSha256
        || resolution.readabilityOutputSha256 !== readability.outputSha256
        || resolution.readerArticleSha256 !== editorial.longformBundle.articleSha256
        || resolution.revisionOutputSha256 !== revision.outputSha256) {
        throw new Error('manual record.reviewResolution 未绑定两份真实 review 输出和最终正文');
    }
    const revisionOutput = validateRevisionOutput(outputs.authorRevision, paperId, revision, {
        runtimeMode,
        artifactRoot: verificationContext.artifactRoot,
        technicalOutputSha256: technical.outputSha256,
        readabilityOutputSha256: readability.outputSha256,
        finalArticleSha256: editorial.longformBundle.articleSha256,
        onVerifiedRecordPayload: payload => {
            const reconstructed = structuredClone(value);
            delete reconstructed.sealedRecordSha256;
            delete reconstructed.reviewReceipts;
            delete reconstructed.reviewResolution;
            delete reconstructed.metadataCorrectionProof;
            if (reconstructed.editorial?.longformBundle) {
                delete reconstructed.editorial.longformBundle.authorReceipt;
                delete reconstructed.editorial.longformBundle.finalRevisionAuthorReceipt;
            }
            const expectedPayload = correctionContext
                ? applyMetadataCorrection(payload, correctionContext.correction)
                : payload;
            const artifactIndexFileSha256 = verificationContext.artifactIndexBytes
                ? crypto.createHash('sha256').update(verificationContext.artifactIndexBytes).digest('hex')
                : source.artifactIndexFileSha256;
            normalizeLegacyArtifactIndexBinding(
                expectedPayload, artifactIndex, artifactIndexFileSha256
            );
            if (stableSha256(reconstructed) !== stableSha256(expectedPayload)) {
                throw new Error('最终 sealed record 不是 revision-record-payload 的确定性注入结果');
            }
        }
    });
    const expectedFindingIds = [...technicalOutput.findings, ...readabilityOutput.findings]
        .map(finding => stableSha256(finding)).sort();
    const resolvedFindingIds = Array.isArray(resolution.resolvedFindingSha256s)
        ? resolution.resolvedFindingSha256s.map((sha, index) => (
            assertSha(sha, `manual record.reviewResolution.resolvedFindingSha256s[${index}]`)
        )).sort()
        : [];
    if (stableSha256(resolvedFindingIds) !== stableSha256(expectedFindingIds)) {
        throw new Error('manual record.reviewResolution 未逐项处置 reviewer findings');
    }
    if (stableSha256([...revisionOutput.resolvedFindingSha256s].sort()) !== stableSha256(expectedFindingIds)) {
        throw new Error('author_revision 真实输出未逐项处置 reviewer findings');
    }
    if (!Array.isArray(resolution.notes) || resolution.notes.length < 2) {
        throw new Error('manual record.reviewResolution.notes 必须记录至少 2 条具体修订');
    }
    resolution.notes.forEach((note, index) => (
        assertText(note, `manual record.reviewResolution.notes[${index}]`, 20)
    ));
    if (!verificationContext.artifactIndexBytes) {
        throw new Error('manual record 必须提供实际 ArtifactIndex 文件字节');
    }
    const artifactBytes = Buffer.isBuffer(verificationContext.artifactIndexBytes)
        ? verificationContext.artifactIndexBytes
        : Buffer.from(String(verificationContext.artifactIndexBytes), 'utf8');
    if (crypto.createHash('sha256').update(artifactBytes).digest('hex') !== source.artifactIndexFileSha256) {
        throw new Error('manual record ArtifactIndex 文件字节 SHA 不匹配');
    }
    assertSha(value.sealedRecordSha256, 'manual record.sealedRecordSha256');
    if (value.sealedRecordSha256 !== stableSha256(semanticRecordPayload(value))) {
        throw new Error('manual record.sealedRecordSha256 与语义内容不一致');
    }
    return value;
}

function buildPaperSpecShard(options = {}) {
    const shard = {
        version: MANUAL_SPEC_VERSION_V6,
        kind: 'manual_paper_spec_shard',
        paperId: assertPaperId(options.paperId, null, 'paper spec shard.paperId'),
        sealedRecordSha256: assertSha(options.sealedRecordSha256, 'paper spec shard.sealedRecordSha256'),
        recordFileSha256: assertSha(options.recordFileSha256, 'paper spec shard.recordFileSha256'),
        recordsEnvelopeFileSha256: assertSha(options.recordsEnvelopeFileSha256, 'paper spec shard.recordsEnvelopeFileSha256'),
        paperInputSha256: assertSha(options.paperInputSha256, 'paper spec shard.paperInputSha256'),
        sourceIdentitySha256: assertSha(options.sourceIdentitySha256, 'paper spec shard.sourceIdentitySha256'),
        artifactIndexSha256: assertSha(options.artifactIndexSha256, 'paper spec shard.artifactIndexSha256'),
        artifactIndexFileSha256: assertSha(options.artifactIndexFileSha256, 'paper spec shard.artifactIndexFileSha256'),
        readerLongformSha256: assertSha(options.readerLongformSha256, 'paper spec shard.readerLongformSha256'),
        taskEvidenceSha256: assertSha(options.taskEvidenceSha256, 'paper spec shard.taskEvidenceSha256'),
        paperPayloadSha256: assertSha(options.paperPayloadSha256, 'paper spec shard.paperPayloadSha256'),
        assemblerProtocolSha256: assertSha(options.assemblerProtocolSha256, 'paper spec shard.assemblerProtocolSha256'),
        takeoverVersion: MANUAL_TAKEOVER_VERSION_V3,
        manualDepth: MANUAL_DEPTH_V6
    };
    shard.paperSpecSha256 = stableSha256(shard);
    return shard;
}

function buildBatchSpecV6(options = {}) {
    const date = String(options.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('batch spec date 非法');
    const runtimeMode = options.runtimeMode;
    if (![MANUAL_V6_RUNTIME_MODE_PRODUCTION, MANUAL_V6_RUNTIME_MODE_SHADOW].includes(runtimeMode)) {
        throw new Error('batch spec.runtimeMode 必须显式为 production 或 shadow');
    }
    assertSha(options.filteredBatchSha256, 'batch spec.filteredBatchSha256');
    const expectedPaperIds = (options.expectedPaperIds || []).map(id => assertPaperId(id, null, 'batch spec.expectedPaperIds'));
    if (!expectedPaperIds.length || new Set(expectedPaperIds).size !== expectedPaperIds.length) {
        throw new Error('batch spec.expectedPaperIds 必须是非空且不重复的完整集合');
    }
    const shardList = options.paperShards || [];
    const normalizedShardIds = shardList.map(shard => assertPaperId(shard?.paperId, null, 'paper spec shard.paperId'));
    if (new Set(normalizedShardIds).size !== normalizedShardIds.length) {
        throw new Error('batch spec.paperShards 含重复论文，禁止后写覆盖');
    }
    const shards = new Map(shardList.map(shard => {
        const rebuilt = buildPaperSpecShard(shard);
        if (shard.paperSpecSha256 !== rebuilt.paperSpecSha256) throw new Error(`paper spec shard SHA 不匹配: ${shard.paperId}`);
        return [rebuilt.paperId, rebuilt];
    }));
    const paperIndex = {};
    for (const paperId of [...expectedPaperIds].sort()) {
        const shard = shards.get(paperId);
        paperIndex[paperId] = shard ? {
            status: 'complete', paperSpecSha256: shard.paperSpecSha256
        } : { status: 'pending', paperSpecSha256: null };
    }
    const unknown = [...shards.keys()].filter(id => !expectedPaperIds.includes(id));
    if (unknown.length) throw new Error(`batch spec 含批次外 shard: ${unknown.join(', ')}`);
    const complete = Object.values(paperIndex).every(item => item.status === 'complete');
    const rootPayload = {
        version: MANUAL_SPEC_VERSION_V6,
        mode: 'manual_complete',
        signatureContract: MANUAL_SIGNATURE_CONTRACT,
        runtimeMode,
        date,
        filteredBatchSha256: options.filteredBatchSha256,
        expectedPaperIds: [...expectedPaperIds].sort(),
        paperIndex,
        orderedLeaves: [...expectedPaperIds].sort().map(id => paperIndex[id].paperSpecSha256)
    };
    return {
        ...rootPayload,
        status: complete ? 'complete' : 'running',
        rootSha256: complete ? merkleRootSha256([
            stableSha256({
                version: MANUAL_SPEC_VERSION_V6,
                signatureContract: MANUAL_SIGNATURE_CONTRACT,
                runtimeMode,
                date,
                filteredBatchSha256: options.filteredBatchSha256,
                expectedPaperIds: [...expectedPaperIds].sort()
            }),
            ...rootPayload.orderedLeaves
        ]) : null
    };
}

function merkleRootSha256(leaves) {
    if (!Array.isArray(leaves) || leaves.length < 1 || leaves.some(leaf => !SHA256_RE.test(String(leaf || '')))) {
        throw new Error('Merkle leaves 必须是非空 SHA-256 数组');
    }
    let level = leaves.map(value => String(value));
    while (level.length > 1) {
        const next = [];
        for (let index = 0; index < level.length; index += 2) {
            const left = level[index];
            const right = level[index + 1] || left;
            next.push(crypto.createHash('sha256').update(Buffer.concat([
                Buffer.from(left, 'hex'), Buffer.from(right, 'hex')
            ])).digest('hex'));
        }
        level = next;
    }
    return level[0];
}

function validateWorkflowState(state) {
    const value = assertObject(state, 'workflow state');
    if (value.version !== WORKFLOW_STATE_VERSION) throw new Error('workflow state 版本非法');
    const paperId = assertPaperId(value.paperId, null, 'workflow state.paperId');
    const nodes = assertObject(value.nodes, 'workflow state.nodes');
    for (const stage of WORKFLOW_STAGES) {
        const node = assertObject(nodes[stage], `workflow state.nodes.${stage}`);
        if (!['pending', 'running', 'complete', 'failed_transient', 'failed_contract', 'stale'].includes(node.status)) {
            throw new Error(`workflow node status 非法: ${stage}`);
        }
        if (node.status === 'complete') {
            assertSha(node.inputKey, `workflow state.nodes.${stage}.inputKey`);
            assertSha(node.outputSha256, `workflow state.nodes.${stage}.outputSha256`);
        }
    }
    return { paperId, nodes };
}

function planWorkflowReuse(state, currentInputKeys) {
    const { nodes } = validateWorkflowState(state);
    const stale = new Set();
    const reusable = new Set();
    for (const stage of WORKFLOW_STAGES) {
        const dependenciesStale = WORKFLOW_DEPENDENCIES[stage].some(dependency => stale.has(dependency));
        const node = nodes[stage];
        const expectedInputKey = currentInputKeys?.[stage];
        if (!dependenciesStale && node.status === 'complete' && SHA256_RE.test(String(expectedInputKey || ''))
            && node.inputKey === expectedInputKey && SHA256_RE.test(String(node.outputSha256 || ''))) {
            reusable.add(stage);
        } else {
            stale.add(stage);
        }
    }
    return { reusable: [...reusable], stale: [...stale] };
}

module.exports = {
    MANUAL_SIGNATURE_CONTRACT,
    MANUAL_RECORD_VERSION_V4,
    MANUAL_SPEC_VERSION_V6,
    MANUAL_DEPTH_V6,
    MANUAL_TAKEOVER_VERSION_V3,
    MANUAL_V6_RUNTIME_MODE_PRODUCTION,
    MANUAL_V6_RUNTIME_MODE_SHADOW,
    MANUAL_V6_AUTHOR_LINEAGE_CONTRACT,
    MANUAL_V6_REVISION_OUTPUT_CONTRACT,
    TASK_PACKET_VERSION,
    WORKFLOW_STATE_VERSION,
    WORKFLOW_STAGES,
    WORKFLOW_DEPENDENCIES,
    stableSha256,
    resolveManualV6RuntimePaths,
    merkleRootSha256,
    buildTaskPacket, taskOutputContract,
    validateTaskPacket,
    validateAuthorRevisionArtifactLineage,
    validateReviewOutput,
    validateRevisionOutput,
    validateManualRecordV4,
    normalizeLegacyArtifactIndexBinding,
    buildPaperSpecShard,
    buildBatchSpecV6,
    validateWorkflowState,
    planWorkflowReuse
};

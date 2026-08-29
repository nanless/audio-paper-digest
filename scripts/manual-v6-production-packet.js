#!/usr/bin/env node
'use strict';

/** Materialize one production Manual v6 task packet without calling an LLM/API. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('manual-v6-production-packet.js');
}
const Config = require('./config.js');
const { DOCUMENT_TYPES, normalizedId, writeFileAtomic } = require('./utils.js');
const {
    AUTHOR_OWNED_REQUIRED_FIELDS,
    normalizeAuthorOwnedBaseFields,
    validateAuthorOwnedRecordDraft
} = require('./manual-v6-author-base-fields.js');
const { REQUIRED_RECOVERY_STAGES } = require('./analysis-contract.js');
const {
    buildFilteredBatchFingerprint,
    buildManifestContext,
    buildPaperInputIdentity,
    isReusableFullTextCheckpoint
} = require('./manual-fetch-fulltext.js');
const {
    buildArtifactManifestContext,
    computeArtifactIndexSha256,
    isReusableArtifactCheckpoint
} = require('./manual-artifact-index.js');
const {
    buildTaskPacket, taskOutputContract,
    stableSha256,
    validateAuthorRevisionArtifactLineage,
    validateTaskPacket
} = require('./manual-v6-workflow.js');
const {
    ROLES,
    runnerPaths,
    verifyBoundInputs
} = require('./manual-v6-task-runner.js');

const PACKET_MATERIALIZER_CONTRACT = 'manual-v6-production-packet-materializer-v1';
const AUTHOR_OUTPUT_CONTRACT = 'manual-v6-author-output-v2';
const SHA_RE = /^[a-f0-9]{64}$/;
const ROLE_PACKET_NAMES = Object.freeze({
    author: 'author.json',
    technical_scoring: 'technical-scoring.json',
    pedagogy_readability: 'pedagogy-readability.json',
    author_revision: 'author-revision.json'
});

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizedArticleSha256(bytes) {
    const text = bytes.toString('utf8').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readJsonBytes(bytes, label) {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch (error) {
        throw new Error(`${label} JSON 损坏: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 顶层必须是对象`);
    }
    return value;
}

function readOrdinaryFile(filePath, label) {
    const declared = path.resolve(filePath);
    const stat = fs.lstatSync(declared, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${label} 必须是存在的普通文件且不得为 symlink`);
    }
    return { path: fs.realpathSync(declared), bytes: fs.readFileSync(declared) };
}

function assertInsideRoot(rootPath, filePath, label) {
    const root = fs.realpathSync(rootPath);
    const file = readOrdinaryFile(filePath, label);
    const relative = path.relative(root, file.path);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
        throw new Error(`${label} 逃逸单篇 production artifact root`);
    }
    return { ...file, relativePath: relative.replace(/\\/g, '/') };
}

function writeExact(destination, bytes, label) {
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new Error(`${label} 目标类型非法或使用 symlink`);
    }
    if (existing && fs.readFileSync(destination).equals(bytes)) return;
    writeFileAtomic(destination, bytes);
}

function jsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildBlankRecordSkeleton(paperId) {
    const stage = () => ({
        decision: '', attempts: null, evidenceIds: [], sourceQuotes: [], issues: [], conclusion: ''
    });
    const readabilityDimensions = [
        'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
        'factLocality', 'terminologyAndPerspective', 'sentenceRhythm',
        'antiTemplateOriginality'
    ];
    return {
        version: 4,
        manualDepth: 'full-text-evidence-v6',
        paperId,
        arxivId: paperId,
        type: '', task: '', tags: '', dims: Array(8).fill(null), confidence: '',
        authorInfo: {
            firstAuthorAffiliation: '', correspondingAuthors: '', affiliations: '', sourceQuote: ''
        },
        question: '', method: '', method2: '', method3: '', innovations: '', results: '',
        details: '', limits: '', open: '', review: '', scoringReasons: Array(8).fill(''),
        evidenceLedger: [{ id: '', claim: '', sourceQuote: '', sourceLocation: '', readerBinding: '' }],
        resultClaims: [{
            datasetOrSetting: '', splitOrCondition: '', method: '', baseline: '', metric: '',
            value: '', unit: '', direction: '', sourceBindings: [], readerBindings: [],
            readerNarrative: ''
        }],
        researchBrief: {
            version: 1,
            contract: 'audio-researcher-v1',
            audience: 'audio_researcher',
            paperSubagent: {
                version: 1, taskName: '', paperId, singlePaperOnly: true,
                isolatedContext: true, model: 'gpt-5.6-terra', reasoningEffort: 'high', completedAt: ''
            },
            editorialPlan: {
                version: 2,
                readerFormatContract: 'graduate-researcher-tutorial-quality-v2',
                readerTitle: '', oneSentenceThesis: '',
                governingTension: { conflict: '', sideA: '', sideB: '', paperChoice: '' },
                readerQuestions: [], evidencePillars: [], sectionPlan: []
            },
            centralQuestion: { question: '', whyItMatters: '', sourceQuote: '', readerQuote: '' },
            mustExplain: [], compress: [], omit: [], takeaways: [], derivedFacts: [],
            evidenceProfile: {
                version: 1, ablationStatus: '', targetEvaluation: '',
                sampleScaleReported: null, deploymentMeasured: null,
                publicGeneralizationEvaluated: null, evidenceBoundary: ''
            }
        },
        manualAudit: { version: 1, attempts: null, passes: [], checks: {} },
        stageReviewAttemptsByStage: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(name => [name, null])),
        stageReviews: {
            version: 2,
            stages: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(name => [name, stage()]))
        },
        scoringCalibration: {
            version: 1, independentReview: true, reviewerTaskName: '',
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            crossDimensionChecked: true, batchScaleChecked: true,
            calibrationNotes: '', evidenceIdsByDimension: {}
        },
        openSourceEvidence: { version: 1, state: '', urls: [], sourceQuotes: [] },
        readabilityRubric: {
            paperId, independentReview: true, reviewerTaskName: '',
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            dimensions: Object.fromEntries(readabilityDimensions.map(name => [name, {
                score: null, reason: '', evidence: []
            }]))
        },
        selectedImageUrls: [], imageInsertions: [],
        figureReview: { version: 1, decisions: [] },
        sourceSnapshot: {
            paperInputSha256: '', sourceIdentitySha256: '', artifactIndexSha256: '',
            artifactIndexFileSha256: '', source: '', sourceId: '', sourceSha256: ''
        },
        editorial: {
            summary: '', method: '', innovations: '', results: '', details: '', limits: '',
            open: '', review: '', readerArticle: '',
            longformBundle: {
                version: 2, contract: 'reader-longform-v2', articleSha256: '',
                paperId, artifactIndexSha256: '', blocks: [], tables: [],
                figures: [], formulas: [], terms: [], relatedWorks: []
            }
        }
    };
}

function buildBlankRecordSchema(paperId) {
    return {
        version: 1,
        mode: 'manual_v6_blank_record_schema',
        paperId,
        populated: false,
        recordContract: 'manual_analysis_record_v4',
        manualDepth: 'full-text-evidence-v6',
        allowedDocumentTypes: [...DOCUMENT_TYPES],
        authorOwnedRequiredFields: [...AUTHOR_OWNED_REQUIRED_FIELDS],
        outputContract: {
            author: AUTHOR_OUTPUT_CONTRACT,
            authorReceiptRequiredFields: [
                'inputPacketSha256', 'outputSha256', 'articleSha256', 'queuedAt',
                'startedAt', 'completedAt', 'revision'
            ],
            revisionPayload: 'manual-v6-revision-record-payload-v1',
            sealedRecordPath: 'sealed/record-v4.json',
            figureEvidencePolicy: 'pixel facts require an allowlisted evidence/figures file; caption-only entries must be marked unavailable and cannot support pixel claims'
        },
        requiredTopLevelFields: [
            'version', 'manualDepth', 'paperId', 'sourceSnapshot', 'researchBrief',
            'editorial', 'reviewReceipts', 'reviewResolution', 'sealedRecordSha256'
        ],
        roleOwnership: {
            author: [
                'sourceSnapshot', 'type', 'task', 'tags', 'authorInfo', 'question',
                'method', 'method2', 'method3', 'innovations', 'results', 'details',
                'limits', 'open', 'review', 'evidenceLedger', 'resultClaims',
                'researchBrief', 'manualAudit', 'stageReviewAttemptsByStage',
                'stageReviews', 'openSourceEvidence', 'figureReview', 'editorial'
            ],
            technical_scoring: [
                'dims', 'confidence', 'scoringReasons', 'scoringCalibration',
                'technical findings only; do not rewrite the article'
            ],
            pedagogy_readability: [
                'readabilityRubric',
                'pedagogy/readability findings only; do not rewrite the article'
            ],
            author_revision: [
                'complete replacement readerArticle', 'complete unsealed records-v4 payload',
                'resolvedFindingSha256s', 'revision notes',
                'normalize evidenceLedger ids to E\\d{2,3} and rewrite every dependent binding atomically'
            ],
            deterministic_sealer: [
                'reviewReceipts', 'reviewResolution', 'sealedRecordSha256',
                'editorial.longformBundle.authorReceipt',
                'editorial.longformBundle.finalRevisionAuthorReceipt'
            ]
        },
        fixedPaths: {
            authorArticle: 'draft/author-article.md',
            authorRecordDraft: 'draft/author-record.json',
            authorOutput: 'outputs/author.json',
            authorReceipt: 'receipts/author.json',
            technicalReview: 'reviews/technical-scoring.json',
            readabilityReview: 'reviews/pedagogy-readability.json',
            finalArticle: 'draft/final-article.md',
            revisionRecordPayload: 'draft/revision-record-payload.json',
            revisionOutput: 'outputs/author-revision.json',
            revisionReceipt: 'receipts/author-revision.json',
            sealedRecord: 'sealed/record-v4.json'
        },
        authorOutputDescriptor: {
            version: 2,
            contract: AUTHOR_OUTPUT_CONTRACT,
            role: 'author',
            paperId,
            taskName: 'RUNNER_BOUND_TASK_NAME',
            passed: true,
            articleSha256: 'SHA256_OF_TRIM_NFKC_LF_ARTICLE_UTF8',
            requiredFields: [
                'version', 'contract', 'role', 'paperId', 'taskName', 'passed',
                'articleSha256', 'article', 'recordDraft'
            ],
            article: {
                path: 'draft/author-article.md',
                fileSha256: 'SHA256_OF_RAW_FILE_BYTES'
            },
            recordDraft: {
                path: 'draft/author-record.json',
                fileSha256: 'SHA256_OF_RAW_FILE_BYTES',
                semanticSha256: 'STABLE_JSON_SEMANTIC_SHA256'
            }
        },
        authorReceipt: {
            requiredIdentity: {
                role: 'author', paperId, taskName: 'RUNNER_BOUND_TASK_NAME',
                singlePaperOnly: true, isolatedContext: true,
                model: 'gpt-5.6-terra', reasoningEffort: 'high'
            },
            requiredBindings: [
                'inputPacketSha256', 'outputSha256', 'articleSha256',
                'queuedAt', 'startedAt', 'completedAt', 'revision'
            ],
            timeContract: 'all timestamps are real Asia/Shanghai +08:00 observations; queuedAt and startedAt must equal runner state'
        },
        reviewOutputDescriptors: {
            common: {
                version: 1,
                issues: [],
                requiredFields: [
                    'version', 'role', 'paperId', 'taskName', 'passed',
                    'issues', 'findings', 'evidenceChecks'
                ],
                findings: 'at least 2 strings of >=20 characters, or structured {severity,category,text,evidence[]} findings',
                findingEvidencePolicy: 'each evidence string must contain at least 3 characters; short ledger IDs such as E1 must use {artifact:"draft/author-record.json",locator:"evidenceLedger:E1"}',
                evidenceChecks: 'at least 2 verified {claim,evidenceId,verified:true} or {check,detail,passed:true} entries'
            },
            technical_scoring: {
                fixedOutputPath: 'reviews/technical-scoring.json',
                ownership: ['dims', 'confidence', 'scoringReasons', 'scoringCalibration'],
                exactOwnedShape: {
                    dims: {
                        order: [
                            'innovation', 'technicalRigor', 'experimentalSufficiency',
                            'clarity', 'impact', 'openSource', 'reproducibility', 'engineering'
                        ],
                        maxima: [2, 1.5, 1.5, 1, 1.5, 1.5, 0.5, 1.5],
                        totalMaximum: 10,
                        decimalPlacesMaximum: 1,
                        openSourceAnchors: [0, 0.2, 0.5, 1, 1.2, 1.5]
                    },
                    confidence: ['高', '中', '低'],
                    scoringReasons: 'exactly 8 paper-specific strings in dims order',
                    scoringCalibration: {
                        version: 1, independentReview: true,
                        reviewerTaskName: 'RUNNER_BOUND_TASK_NAME',
                        model: 'gpt-5.6-terra', reasoningEffort: 'high',
                        crossDimensionChecked: true, batchScaleChecked: true,
                        calibrationNotes: 'at least 40 characters',
                        evidenceIdsByDimension: 'exactly the 8 dims-order keys, each referencing real evidenceLedger IDs'
                    }
                },
                articleMutationAllowed: false
            },
            pedagogy_readability: {
                fixedOutputPath: 'reviews/pedagogy-readability.json',
                articleMutationAllowed: false,
                readabilityRubric: {
                    paperId,
                    independentReview: true,
                    reviewerTaskName: 'RUNNER_BOUND_TASK_NAME',
                    model: 'gpt-5.6-terra',
                    reasoningEffort: 'high',
                    scoreRange: [0, 2],
                    minimumTotal: 12,
                    zeroScoreAllowedToPass: false,
                    dimensions: [
                        'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
                        'factLocality', 'terminologyAndPerspective', 'sentenceRhythm',
                        'antiTemplateOriginality'
                    ],
                    dimensionFields: ['score', 'reason (>=12 characters)', 'evidence (non-empty)'],
                    fullScoreRule: 'all seven scores are 2 => counterEvidence requires at least 3 entries of >=20 characters'
                }
            }
        },
        reviewReceipt: {
            requiredIdentity: {
                paperId, role: 'RUNNER_BOUND_REVIEW_ROLE', taskName: 'RUNNER_BOUND_TASK_NAME',
                singlePaperOnly: true, isolatedContext: true,
                model: 'gpt-5.6-terra', reasoningEffort: 'high'
            },
            requiredBindings: [
                'consumedPacketSha256', 'outputSha256', 'queuedAt', 'startedAt',
                'completedAt', 'revision'
            ],
            timeContract: 'queuedAt and startedAt must equal runner state; revision is a positive integer',
            outputShaContract: 'outputSha256 is manual-v6-workflow.stableSha256(parsed output JSON)'
        },
        revisionOutputDescriptor: {
            version: 2,
            contract: 'manual-v6-author-revision-output-v2',
            role: 'author_revision',
            paperId,
            taskName: 'RUNNER_BOUND_TASK_NAME',
            passed: true,
            requiredFields: [
                'technicalOutputSha256', 'readabilityOutputSha256', 'finalArticleSha256',
                'finalArticle', 'recordPayload', 'resolvedFindingSha256s', 'notes'
            ],
            finalArticle: {
                path: 'draft/final-article.md', fileSha256: 'SHA256_OF_RAW_FILE_BYTES'
            },
            recordPayload: {
                path: 'draft/revision-record-payload.json',
                fileSha256: 'SHA256_OF_RAW_FILE_BYTES',
                semanticSha256: 'STABLE_JSON_SEMANTIC_SHA256'
            },
            payloadContract: 'complete unsealed manual_analysis_record_v4; no sealedRecordSha256/reviewReceipts/reviewResolution and no longform author receipts'
        },
        fields: {
            authorOwnedBase: {
                type: `exactly one of ${DOCUMENT_TYPES.join(' / ')}; only utils.normalizeDocumentType one-to-one aliases are accepted at submit and canonicalized by the revision binder`,
                task: 'one whitespace-free #tag from the repository ALLOWED_TAGS whitelist',
                tags: 'one string containing 3-5 unique whitespace-separated ALLOWED_TAGS entries and including task; arrays are forbidden',
                title: 'the authoritative title is bound through evidence/paper-metadata.json; titleOverride remains optional and may only repair whitespace'
            },
            sourceSnapshot: {
                required: [
                    'paperInputSha256', 'sourceIdentitySha256',
                    'artifactIndexSha256', 'artifactIndexFileSha256'
                ],
                source: 'copy identities from allowlisted source snapshot and ArtifactIndex; never invent a SHA'
            },
            researchBrief: {
                required: [
                    'contract=audio-researcher-v1', 'paperSubagent',
                    'editorialPlan.version=2',
                    'editorialPlan.readerFormatContract=graduate-researcher-tutorial-quality-v2',
                    'centralQuestion', 'mustExplain', 'takeaways', 'derivedFacts',
                    'evidenceProfile'
                ],
                editorialPlanRequired: [
                    'readerTitle', 'oneSentenceThesis', 'governingTension',
                    'readerQuestions', 'evidencePillars', 'sectionPlan'
                ]
            },
            evidenceLedger: {
                requirement: 'every precise fact in readerArticle must bind a local full-text/ArtifactIndex/external-evidence quote or an explicit derivedFact',
                idContract: 'every ledger id must match E\\d{2,3} (E01..E999); author drafts using E1-style ids must be normalized in revision together with every dependent reference'
            },
            resultClaims: {
                requirement: 'system/method papers need at least 4 claims; other empirical papers need at least 3; span at least 2 tables or experiment groups',
                requiredPerClaim: [
                    'setting', 'method', 'strongBaseline', 'metric', 'value',
                    'unit', 'direction', 'sourceBindings', 'readerBindings',
                    'readerNarrative (40-360 Chinese characters and actually present in article)'
                ]
            },
            editorial: {
                required: [
                    'summary', 'method', 'innovations', 'results', 'details',
                    'limits', 'open', 'review', 'readerArticle', 'longformBundle'
                ],
                readerArticleContract: {
                    outputField: 'readerArticle',
                    normalizedCharacterRange: [2400, 24000],
                    headingSource: 'only the paper-specific sectionPlan headings, in order',
                    equations: 'use only \\(...\\) or \\[...\\]',
                    exactBinding: 'must equal the normalized bytes of the role output article file'
                },
                longformBundle: {
                    version: 2,
                    contract: 'reader-longform-v2',
                    required: [
                        'paperId', 'articleSha256', 'artifactIndexSha256', 'blocks',
                        'tables', 'figures', 'formulas', 'terms', 'relatedWorks'
                    ],
                    exactShapes: {
                        blocks: '{id,kind,heading,learningObjective,markdown,evidenceSpanIds,tableIds,figureIds,formulaIds}; 6-32 entries; render as `### heading\\n\\nmarkdown` and reproduce readerArticle byte-for-byte after NFKC/trim',
                        tables: '{sourceTableId,kind,disposition,sourceMatrixSha256,numericCellCount,coveredNumericCellIds,blockId,renderedMarkdown,renderedFragmentSha256}; every ArtifactIndex table disposed, result tables cannot be omitted, and inline/appendix numeric coverage is 100%',
                        figures: '{id,disposition,blockId,visibleFacts} for inline/appendix or {id,disposition:"omit",omissionReason}; dispose every ArtifactIndex figure exactly once',
                        formulas: '{id,disposition,blockId,explanation} for inline/appendix or {id,disposition:"omit",omissionReason}; dispose every ArtifactIndex formula exactly once',
                        terms: '{id,term,definition,firstUseBlockId}; define every ArtifactIndex acronym actually used in the final article and place the definition in its first-use block',
                        relatedWorks: '{citationId,relationship,difference,blockId}; at least 2 real bibliography IDs, with both sentences present in the related-work block'
                    },
                    forbiddenInAuthorDraft: [
                        'authorReceipt', 'finalRevisionAuthorReceipt'
                    ]
                }
            },
        authorDraftForbidden: [
                'reviewReceipts', 'reviewResolution', 'sealedRecordSha256',
                'editorial.longformBundle.authorReceipt',
                'editorial.longformBundle.finalRevisionAuthorReceipt'
            ]
        },
        recordSkeleton: buildBlankRecordSkeleton(paperId)
    };
}

function sniffImageMime(bytes) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
        && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    const prefix = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('utf8').trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?<svg\b/iu.test(prefix) && !/<(?:script|foreignObject)\b/iu.test(prefix)) {
        return 'image/svg+xml';
    }
    return null;
}

function imageExtension(mime) {
    return ({
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/svg+xml': 'svg'
    })[mime] || null;
}

function materializeAuthorizedFigures(artifactIndex, artifactRoot, currentDir) {
    const cacheRoot = path.join(path.resolve(currentDir), 'image-cache');
    const rootStat = fs.lstatSync(cacheRoot, { throwIfNoEntry: false });
    const figures = [...(Array.isArray(artifactIndex.figures) && artifactIndex.figures.length > 0
        ? artifactIndex.figures
        : (artifactIndex.images || []))];
    if (!rootStat) return { artifacts: [], unavailableFigureIds: figures.map(item => item.id).filter(Boolean) };
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error('受控 image-cache 根类型非法或使用 symlink');
    }
    const realCacheRoot = fs.realpathSync(cacheRoot);
    const artifacts = [];
    const unavailableFigureIds = [];
    const seen = new Set();
    for (const figure of figures) {
        const id = String(figure?.id || '');
        if (!/^IMG\d{4}$/.test(id) || seen.has(id)) {
            if (id) unavailableFigureIds.push(id);
            continue;
        }
        seen.add(id);
        const cachePath = String(figure.cachePath || '');
        const expectedSha = String(figure.cacheSha256 || figure.fileSha256 || figure.sha256 || '');
        const declaredMime = String(figure.mime || figure.mimeType || '').toLowerCase();
        if (!cachePath || !SHA_RE.test(expectedSha) || !imageExtension(declaredMime)) {
            unavailableFigureIds.push(id);
            continue;
        }
        const file = readOrdinaryFile(cachePath, `ArtifactIndex ${id} image cache`);
        const relative = path.relative(realCacheRoot, file.path);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
            || path.isAbsolute(relative)) {
            throw new Error(`ArtifactIndex ${id} image cache 逃逸受控 image-cache 根`);
        }
        const actualMime = sniffImageMime(file.bytes);
        if (actualMime !== declaredMime || sha256Bytes(file.bytes) !== expectedSha) {
            throw new Error(`ArtifactIndex ${id} image cache MIME 或 SHA 与真实字节不一致`);
        }
        const relativeOutput = `evidence/figures/${id}.${imageExtension(actualMime)}`;
        writeExact(path.join(artifactRoot, relativeOutput), file.bytes, `${id} paper figure`);
        artifacts.push({ path: relativeOutput, sha256: expectedSha, kind: 'paper_figure' });
    }
    return { artifacts, unavailableFigureIds };
}

function packetProtocolSha256(role) {
    const protocolFiles = [
        __filename,
        require.resolve('./manual-v6-author-base-fields.js'),
        require.resolve('./manual-v6-workflow.js'),
        require.resolve('./manual-v6-task-runner.js')
    ];
    return stableSha256({
        contract: PACKET_MATERIALIZER_CONTRACT,
        role,
        protocolFiles: Object.fromEntries(protocolFiles.map(filePath => [
            path.basename(filePath), sha256Bytes(fs.readFileSync(filePath))
        ]))
    });
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!['--date', '--paper', '--role'].includes(arg)) throw new Error(`未知参数: ${arg}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        const key = arg.slice(2);
        if (options[key] !== undefined) throw new Error(`参数重复: ${arg}`);
        options[key] = value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(options.date || ''))) {
        throw new Error('--date 必须是 YYYY-MM-DD');
    }
    options.paper = normalizedId(options.paper);
    if (!options.paper) throw new Error('--paper 必须是合法 arXiv ID');
    if (!ROLES.includes(options.role)) throw new Error(`--role 必须是 ${ROLES.join('/')}`);
    return options;
}

function loadRunnerState(currentDir, date) {
    const paths = runnerPaths(date, path.join(currentDir, 'manual-v6'));
    const stateFile = readOrdinaryFile(paths.statePath, 'production runner state');
    const state = readJsonBytes(stateFile.bytes, 'production runner state');
    verifyBoundInputs(state);
    return { paths, state };
}

function loadProductionSourceContext(options) {
    const currentDir = path.resolve(options.currentDir || Config.CURRENT_DIR);
    const filteredPath = path.resolve(options.filteredPath || path.join(currentDir, 'filtered-papers.json'));
    const filteredFile = readOrdinaryFile(filteredPath, 'filtered-papers');
    const filtered = readJsonBytes(filteredFile.bytes, 'filtered-papers');
    if (filtered.status !== 'complete' || filtered.batchDate !== options.date
        || !Array.isArray(filtered.papers)) {
        throw new Error('packet 只接受同日 complete filtered 批次');
    }
    const paper = filtered.papers.find(item => normalizedId(item) === options.paperId);
    if (!paper) throw new Error(`${options.paperId} 不在 filtered 批次`);
    const fullRoot = path.join(currentDir, 'manual-full-text', options.date);
    const manifestFile = readOrdinaryFile(path.join(fullRoot, 'manifest.json'), 'full-text manifest');
    const manifest = readJsonBytes(manifestFile.bytes, 'full-text manifest');
    const artifactManifestFile = readOrdinaryFile(
        path.join(fullRoot, 'artifacts', 'manifest.json'), 'ArtifactIndex manifest'
    );
    const artifactManifest = readJsonBytes(artifactManifestFile.bytes, 'ArtifactIndex manifest');
    if (manifest.status !== 'complete' || manifest.failed !== 0 || manifest.date !== options.date
        || artifactManifest.status !== 'complete' || artifactManifest.failed !== 0
        || Number(artifactManifest.incomplete || 0) !== 0 || artifactManifest.date !== options.date) {
        throw new Error('production packet 要求同日 complete 全文与 ArtifactIndex manifest');
    }
    const fullContext = buildManifestContext(filtered, options.date, fullRoot);
    const input = fullContext.byId.get(options.paperId);
    const sourceEntry = manifest.papers?.[options.paperId];
    const artifactEntry = artifactManifest.papers?.[options.paperId];
    const sourceText = fs.readFileSync(sourceEntry?.path || '', 'utf8');
    const artifactContext = buildArtifactManifestContext(fullContext, fullRoot);
    if (!isReusableFullTextCheckpoint(sourceEntry, input.filePath, input)
        || !isReusableArtifactCheckpoint(artifactEntry, {
            context: artifactContext, input, sourceEntry, sourceText
        }) || artifactEntry.status !== 'complete') {
        throw new Error(`${options.paperId} 全文或 complete ArtifactIndex checkpoint 不可复用`);
    }
    const artifactFile = readOrdinaryFile(artifactEntry.path, 'ArtifactIndex file');
    if (sha256Bytes(artifactFile.bytes) !== artifactEntry.outputSha256) {
        throw new Error('ArtifactIndex manifest 未绑定当前真实文件字节');
    }
    const artifactIndex = readJsonBytes(artifactFile.bytes, 'ArtifactIndex file');
    if (artifactIndex.inventoryHealth?.status !== 'complete'
        || artifactIndex.outputSha256 !== artifactIndex.artifactIndexSha256
        || artifactIndex.artifactIndexSha256 !== computeArtifactIndexSha256(artifactIndex)) {
        throw new Error(`${options.paperId} ArtifactIndex 语义身份或 inventoryHealth 非 complete`);
    }
    return {
        currentDir, filtered, paper, input, sourceEntry, artifactEntry, artifactFile, artifactIndex
    };
}

function materializeAuthorEvidence(context, artifactRoot) {
    const evidenceDir = path.join(artifactRoot, 'evidence');
    const instructionDir = path.join(artifactRoot, 'instructions');
    const schemaDir = path.join(artifactRoot, 'schema');
    for (const dir of [evidenceDir, path.join(evidenceDir, 'figures'), instructionDir,
        schemaDir, path.join(artifactRoot, 'packets')]) {
        const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
        if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
            throw new Error(`受控目录类型非法或使用 symlink: ${dir}`);
        }
        fs.mkdirSync(dir, { recursive: true });
    }
    const sources = [
        ['evidence/paper-metadata.json', jsonBytes(context.paper), 'paper_metadata'],
        ['evidence/source-snapshot.json', jsonBytes({
            paperId: context.input.id,
            paperInputSha256: context.input.paperInputSha256,
            sourceIdentitySha256: context.sourceEntry.sourceIdentitySha256,
            source: context.sourceEntry.source,
            sourceId: context.sourceEntry.sourceId,
            sourceSha256: context.sourceEntry.sourceSha256
        }), 'source_snapshot'],
        ['evidence/fulltext.txt', readOrdinaryFile(context.sourceEntry.path, 'fulltext').bytes, 'fulltext'],
        ['evidence/artifact-index.json', context.artifactFile.bytes, 'artifact_index'],
        ['instructions/manual-tutorial-article.md', readOrdinaryFile(
            path.resolve(__dirname, '..', 'prompts', 'manual-tutorial-article.md'), 'authoring prompt'
        ).bytes, 'authoring_prompt'],
        ['instructions/manual-editorial-reference-contract.md', readOrdinaryFile(
            path.resolve(__dirname, '..', 'docs', 'manual-editorial-reference-contract.md'), 'editorial contract'
        ).bytes, 'editorial_contract'],
        ['schema/blank-record.json', jsonBytes(buildBlankRecordSchema(context.input.id)), 'record_template']
    ];
    const structured = context.sourceEntry.structuredArtifactsSnapshot;
    if (context.artifactIndex.inputIdentity?.structuredArtifactsSha256) {
        const structuredFile = readOrdinaryFile(structured?.path, 'structured source snapshot');
        if (sha256Bytes(structuredFile.bytes) !== structured.outputSha256) {
            throw new Error('structured source snapshot 字节 SHA 不匹配');
        }
        sources.splice(3, 0, [
            'evidence/structured-source.json', structuredFile.bytes, 'structured_fulltext'
        ]);
    }
    for (const [relative, bytes] of sources) {
        writeExact(path.join(artifactRoot, relative), bytes, relative);
    }
    const figureEvidence = materializeAuthorizedFigures(
        context.artifactIndex, artifactRoot, context.currentDir
    );
    return {
        artifacts: [...sources.map(([relative, bytes, kind]) => ({
        path: relative, sha256: sha256Bytes(bytes), kind
        })), ...figureEvidence.artifacts],
        figureEvidence
    };
}

function validateAuthorOutputDescriptor(output, artifactRoot, expected = {}) {
    if (output?.version !== 2 || output.contract !== AUTHOR_OUTPUT_CONTRACT
        || output.role !== 'author' || normalizedId(output.paperId) !== expected.paperId
        || output.passed !== true || output.taskName !== expected.taskName
        || !SHA_RE.test(String(output.articleSha256 || ''))) {
        throw new Error('author output 必须是当前 runner task 的 manual-v6-author-output-v2');
    }
    const refs = [
        ['article', output.article, 'draft/author-article.md'],
        ['recordDraft', output.recordDraft, 'draft/author-record.json']
    ];
    const result = {};
    for (const [key, ref, fixedPath] of refs) {
        if (!ref || ref.path !== fixedPath || !SHA_RE.test(String(ref.fileSha256 || ''))) {
            throw new Error(`author output.${key} 必须绑定受控固定路径与文件 SHA`);
        }
        const file = assertInsideRoot(artifactRoot, path.join(artifactRoot, fixedPath), `author output.${key}`);
        if (sha256Bytes(file.bytes) !== ref.fileSha256) throw new Error(`author output.${key} 文件 SHA 不匹配`);
        result[key] = file;
    }
    if (normalizedArticleSha256(result.article.bytes) !== output.articleSha256) {
        throw new Error('author output.articleSha256 未绑定真实 NFKC/trim 正文');
    }
    const draft = readJsonBytes(result.recordDraft.bytes, 'author record draft');
    if (normalizedId(draft.paperId || draft.arxivId) !== expected.paperId
        || draft.sealedRecordSha256 || draft.reviewReceipts || draft.reviewResolution) {
        throw new Error('author record draft 必须属于当前论文且不得伪装 sealed/review closure');
    }
    if (refSemanticSha(output.recordDraft) !== stableSha256(draft)) {
        throw new Error('author output.recordDraft.semanticSha256 与真实 JSON 不一致');
    }
    const draftForValidation = expected.metadataCorrection
        ? {
            ...draft,
            type: expected.metadataCorrection.type,
            task: expected.metadataCorrection.task,
            tags: expected.metadataCorrection.tags
        }
        : draft;
    return { ...result, draft, normalizedDraft: validateAuthorOwnedRecordDraft(
        draftForValidation,
        expected.metadataCorrection
            ? 'author record draft（显式 metadata correction 后）'
            : 'author record draft'
    ) };
}

function refSemanticSha(ref) {
    const value = String(ref?.semanticSha256 || '');
    if (!SHA_RE.test(value)) throw new Error('JSON descriptor 缺少 semanticSha256');
    return value;
}

function buildReviewPacket(role, paperId, sourceIdentity, artifactRoot, state) {
    const authorTask = state.papers[paperId].tasks.author;
    if (authorTask.status !== 'validated') throw new Error(`${role} packet 只能绑定 runner validated author`);
    const outputFile = assertInsideRoot(artifactRoot, authorTask.outputPath, 'validated author output');
    const receiptFile = assertInsideRoot(artifactRoot, authorTask.receiptPath, 'validated author receipt');
    if (sha256Bytes(outputFile.bytes) !== authorTask.outputFileSha256
        || sha256Bytes(receiptFile.bytes) !== authorTask.receiptFileSha256) {
        throw new Error('runner validated author output/receipt 已漂移');
    }
    const output = readJsonBytes(outputFile.bytes, 'validated author output');
    const authorArtifacts = validateAuthorOutputDescriptor(output, artifactRoot, {
        paperId, taskName: authorTask.taskName
    });
    const artifacts = [
        { path: 'evidence/artifact-index.json', kind: 'artifact_index' },
        { path: 'schema/blank-record.json', kind: 'record_template' },
        { path: outputFile.relativePath, kind: 'runner_validated_author_output' },
        { path: receiptFile.relativePath, kind: 'runner_validated_author_receipt' },
        { path: authorArtifacts.article.relativePath, kind: 'author_article' },
        { path: authorArtifacts.recordDraft.relativePath, kind: 'author_record_draft' }
    ].map(item => ({
        ...item,
        sha256: sha256Bytes(fs.readFileSync(path.join(artifactRoot, item.path)))
    }));
    return buildTaskPacket({
        role, paperId,
        paperInputSha256: sourceIdentity.paperInputSha256,
        sourceIdentitySha256: sourceIdentity.sourceIdentitySha256,
        contractSha256: packetProtocolSha256(role),
        allowedArtifacts: artifacts,
        outputContract: taskOutputContract(role)
    });
}

function buildRevisionPacket(paperId, sourceIdentity, artifactRoot, state) {
    const tasks = state.papers[paperId].tasks;
    for (const role of ['author', 'technical_scoring', 'pedagogy_readability']) {
        if (tasks[role].status !== 'validated') {
            throw new Error('author_revision packet 只接受 runner validated author 与两份 review');
        }
    }
    const authorPacketFile = assertInsideRoot(artifactRoot, tasks.author.packetPath, 'author packet');
    const authorPacket = readJsonBytes(authorPacketFile.bytes, 'author packet');
    const reviewArtifacts = [
        ['technical_review', tasks.technical_scoring, 'reviews/technical-scoring.json'],
        ['readability_review', tasks.pedagogy_readability, 'reviews/pedagogy-readability.json']
    ].map(([kind, task, expectedPath]) => {
        const output = assertInsideRoot(artifactRoot, task.outputPath, kind);
        if (output.relativePath !== expectedPath || sha256Bytes(output.bytes) !== task.outputFileSha256) {
            throw new Error(`${kind} 不是 runner validated 固定输出`);
        }
        return { path: output.relativePath, sha256: task.outputFileSha256, kind };
    });
    const packet = buildTaskPacket({
        role: 'author_revision', paperId,
        paperInputSha256: sourceIdentity.paperInputSha256,
        sourceIdentitySha256: sourceIdentity.sourceIdentitySha256,
        contractSha256: packetProtocolSha256('author_revision'),
        allowedArtifacts: [
            ...authorPacket.allowedArtifacts.map(item => ({
                path: item.path, sha256: item.sha256, kind: item.kind
            })),
            ...reviewArtifacts
        ],
        outputContract: taskOutputContract('author_revision')
    });
    validateAuthorRevisionArtifactLineage(authorPacket, packet, {
        technical: reviewArtifacts[0], readability: reviewArtifacts[1]
    });
    return packet;
}

function materializePacket(options = {}) {
    const date = options.date;
    const paperId = normalizedId(options.paperId);
    const role = options.role;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !paperId || !ROLES.includes(role)) {
        throw new Error('materializePacket 需要合法 date/paperId/role');
    }
    const currentDir = path.resolve(options.currentDir || Config.CURRENT_DIR);
    const { paths, state } = loadRunnerState(currentDir, date);
    if (!state.papers[paperId]) throw new Error(`${paperId} 不在 production runner 批次`);
    const artifactRoot = path.join(paths.taskRoot, paperId);
    const rootStat = fs.lstatSync(artifactRoot, { throwIfNoEntry: false });
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error('单篇 production artifact root 缺失或使用 symlink；先运行 runner init');
    }
    const context = loadProductionSourceContext({ currentDir, date, paperId });
    const sourceIdentity = {
        paperInputSha256: context.input.paperInputSha256,
        sourceIdentitySha256: context.sourceEntry.sourceIdentitySha256
    };
    let packet;
    let authorFigureEvidence = null;
    if (role === 'author') {
        const evidence = materializeAuthorEvidence(context, artifactRoot);
        authorFigureEvidence = evidence.figureEvidence;
        packet = buildTaskPacket({
            role, paperId, ...sourceIdentity,
            contractSha256: packetProtocolSha256(role), allowedArtifacts: evidence.artifacts,
            outputContract: taskOutputContract(role)
        });
    } else if (role === 'technical_scoring' || role === 'pedagogy_readability') {
        packet = buildReviewPacket(role, paperId, sourceIdentity, artifactRoot, state);
    } else {
        packet = buildRevisionPacket(paperId, sourceIdentity, artifactRoot, state);
    }
    const packetPath = path.join(artifactRoot, 'packets', ROLE_PACKET_NAMES[role]);
    writeExact(packetPath, jsonBytes(packet), `${role} packet`);
    validateTaskPacket(packet, {
        paperId, artifactRoot, requireFiles: true,
        expectedPaperMetadata: context.paper,
        expectedPaperInputSha256: context.input.paperInputSha256
    });
    return {
        contract: PACKET_MATERIALIZER_CONTRACT,
        date, paperId, role, artifactRoot, packetPath,
        packetSha256: packet.packetSha256,
        packetFileSha256: sha256Bytes(fs.readFileSync(packetPath)),
        figureEvidence: role === 'author' ? {
            pixelAvailable: packet.allowedArtifacts.filter(item => item.kind === 'paper_figure').length,
            unavailableFigureIds: authorFigureEvidence.unavailableFigureIds,
            policy: 'Only allowlisted evidence/figures bytes may support pixel facts; unavailable figures remain caption/structure evidence and require a later separately attested image review.'
        } : undefined,
        register: {
            command: 'manual:tasks register',
            args: ['--date', date, '--paper', paperId, '--role', role,
                '--artifact-root', artifactRoot, '--packet', packetPath]
        }
    };
}

function run(argv = process.argv.slice(2), overrides = {}) {
    const args = parseArgs(argv);
    const result = materializePacket({
        date: args.date, paperId: args.paper, role: args.role,
        currentDir: overrides.currentDir || Config.CURRENT_DIR
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
}

if (require.main === module) {
    try { run(); } catch (error) {
        console.error(`Manual v6 production packet 失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    PACKET_MATERIALIZER_CONTRACT,
    AUTHOR_OUTPUT_CONTRACT,
    ROLE_PACKET_NAMES,
    buildBlankRecordSkeleton,
    buildBlankRecordSchema,
    packetProtocolSha256,
    parseArgs,
    loadProductionSourceContext,
    materializeAuthorEvidence,
    materializeAuthorizedFigures,
    sniffImageMime,
    validateAuthorOutputDescriptor,
    normalizeAuthorOwnedBaseFields,
    validateAuthorOwnedRecordDraft,
    buildReviewPacket,
    buildRevisionPacket,
    materializePacket,
    run
};

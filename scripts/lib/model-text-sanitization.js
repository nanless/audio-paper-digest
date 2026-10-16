'use strict';

const MODEL_TEXT_SANITIZATION_CONTRACT = 'model-text-unicode-scalars-v1';

function containsSupplementaryCharacter(value) {
    if (typeof value === 'string') return /[\u{10000}-\u{10ffff}]/u.test(value);
    if (Array.isArray(value)) return value.some(containsSupplementaryCharacter);
    return Boolean(value && typeof value === 'object'
        && Object.values(value).some(containsSupplementaryCharacter));
}

function modelTextFingerprintFields(...inputs) {
    return containsSupplementaryCharacter(inputs)
        ? { modelTextSanitizationContract: MODEL_TEXT_SANITIZATION_CONTRACT } : {};
}

function legacyModelTextNeedsReplay(paper, sourceDetails) {
    if (paper?.analysisManifest?.sourceAcquisition?.modelTextSanitizationContract
        === MODEL_TEXT_SANITIZATION_CONTRACT) return false;
    return containsSupplementaryCharacter([
        paper?.title, paper?.authors, paper?.categories, paper?.abstract, paper?.summary,
        paper?.analysis, paper?.analysisCheckpoint, paper?.analysisStageCheckpoints,
        paper?.apiReaderArticle, paper?.apiReaderPlan, sourceDetails
    ]);
}

function currentModelInputSource(paper) {
    const fresh = require('./fresh-analysis-context.js');
    const active = fresh.getFreshAnalysisContext();
    if (active) return fresh.readFreshSource(active.runDir, paper, active);
    const conference = require('./conference-analysis-context.js');
    if (conference.getConferenceAnalysisContext()) return conference.getConferenceAnalysisSource(paper);
    const direct = require('./direct-rewrite-analysis-context.js');
    if (direct.getDirectRewriteAnalysisContext()) return direct.getDirectRewriteSource(paper);
    return null;
}

// Recovery identities store one canonical paperId for every workflow. Preserve
// that namespace when adapting to a source reader; a conference ID is never an
// arXiv alias and the prefix alone cannot authorize a conference source.
function currentModelInputSourceForPaperId(paperId) {
    const conference = require('./conference-analysis-context.js');
    const active = conference.getConferenceAnalysisContext();
    const direct = require('./direct-rewrite-analysis-context.js');
    const historical = direct.getDirectRewriteAnalysisContext();
    const freshApi = require('./fresh-analysis-context.js');
    const fresh = freshApi.getFreshAnalysisContext();
    // Daily paper handling deliberately installs the direct adapter for private
    // figure materialization. It is the same source scope only after reading
    // the real daily bundle and comparing every source/provenance field.
    if (!active && historical && fresh && freshApi.isDailyFreshSourceScope()) {
        const match = /^(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/.exec(String(paperId || ''));
        const id = match?.[1];
        if (id && historical.paperId === `arxiv:${id}` && historical.route === 'arxiv-fresh-fetch'
            && historical.runId === fresh.runId
            && (!fresh.paperId || fresh.paperId === id)
            && require('node:path').resolve(historical.readerAttemptsDir)
                === require('node:path').join(fresh.runDir, 'reader-attempts')) {
            const details = freshApi.readFreshSource(fresh.runDir, { arxivId: id }, fresh);
            const descriptor = details?.freshSourceDescriptor;
            if (descriptor?.paperId === id && descriptor.runId === fresh.runId
                && ['sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256',
                    'sourceGeneration', 'sourceManifestSha256', 'sourceVersionIdentitySha256']
                    .every(key => historical[key] === descriptor[key])
                && require('node:util').isDeepStrictEqual(details,
                    direct.getDirectRewriteSource({ id: `arxiv:${id}` }))) return details;
        }
        throw new Error('Reader recovery refuses ambiguous mixed active source workflows');
    }
    if ([active, historical, fresh].filter(Boolean).length > 1) {
        throw new Error('Reader recovery refuses ambiguous mixed active source workflows');
    }
    if (active) {
        if (typeof paperId !== 'string' || paperId !== active.paperId
            || paperId !== active.sourceDetails?.sourceId) {
            throw new Error('Reader recovery canonical paperId differs from the authenticated conference source');
        }
        return conference.getConferenceAnalysisSource({ id: paperId });
    }
    if (historical) {
        const canonicalId = direct.paperId(typeof paperId === 'string'
            && /^(?:conference:|arxiv:)/.test(paperId) ? paperId : { arxivId: paperId });
        const route = canonicalId.startsWith('conference:') ? 'conference-local-pdf' : 'arxiv-fresh-fetch';
        if (canonicalId !== historical.paperId || historical.route !== route) {
            throw new Error('Reader recovery canonical paperId or route differs from the authenticated historical source');
        }
        // The direct reader retains its own run/provenance checks. A context
        // without a real run still returns no usable source.
        return direct.getDirectRewriteSource({ id: canonicalId });
    }
    if (typeof paperId === 'string' && paperId.startsWith('conference:')) {
        throw new Error('Conference Reader recovery requires its authenticated conference source scope');
    }
    return currentModelInputSource({ arxivId: paperId });
}

// 这是生产复用资格，不改变旧记录的结构完整性或只读历史状态。
// 旧记录缺少清洗版本时，必须取得已核验来源，不能从元数据里没见到特殊字符推定安全。
function canReuseModelTextInputs(paper, sourceDetails = null) {
    if (paper?.analysisManifest?.sourceAcquisition?.modelTextSanitizationContract
        === MODEL_TEXT_SANITIZATION_CONTRACT) return true;
    const details = sourceDetails || currentModelInputSource(paper);
    return Boolean(details && typeof details.text === 'string'
        && !legacyModelTextNeedsReplay(paper, details));
}

module.exports = { MODEL_TEXT_SANITIZATION_CONTRACT, containsSupplementaryCharacter,
    modelTextFingerprintFields, legacyModelTextNeedsReplay, canReuseModelTextInputs,
    currentModelInputSource, currentModelInputSourceForPaperId };

'use strict';
// Recognize the original wire format without rewriting its bytes. A current
// stored plan is compiled only after all integrated-article/source checks pass;
// a compact historical response can never be promoted by changing its header.
const codec = require('./protocol-codec');
const INTEGRATED = 'integrated-article';
const COMPACT = 'compact-article';
const STRUCTURED_EDITORIAL = 'structured-pipeline';
const STRUCTURED_V5_EDITORIAL = 'structured-pipeline-v5';
const HISTORICAL_STRUCTURED_EDITORIALS = Object.freeze([STRUCTURED_V5_EDITORIAL]);
const COHESIVE_EDITORIAL = 'cohesive-functional-v4';
const LEGACY_INTEGRATED = 'legacy-integrated';
const OLD_DRAFT_FP = 'beea25256472a7b9cb4550dafd753db7d1231632a85d6dbb7f9c2e620a0628f9';
const OLD_PLAN_FP = 'cd8baf5b8bda3a49eec64f6005931af63de4e9a13148cba5f354c661ca6e9df2';
const V4_DRAFT_FP = '70509d972ac881cc32bdc6cd182ec830ac3676b01fb0c81375849cd3ff429733';
const V4_PLAN_FP = '7c0300b9342334b864b6a304dcf02a96fb8dbbe8f4061b6dbc0ddfdd249ceceb';
const V5_DRAFT_FP = 'c885be94603c4da688140a9b370c93a71ce5674acb2b0ded5011d3a4053ac5c4';
const V5_PLAN_FP = '502f149770c20bc8f28660fa7f98bbeaaaecaff2b5f8c6236663e323d34a595c';
const DRAFT_FIELDS = Object.freeze(['readerTitle', 'oneSentenceThesis', 'sections',
    'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']);
const STRUCTURED_OPTIONAL_DRAFT_FIELDS = Object.freeze(['implementationSpecs']);
const IMPLEMENTATION_SPEC_KEYS = Object.freeze([
    'trainingData', 'computeHardware', 'keyHyperparams',
    'inferenceCost', 'openSourceArtifacts', 'appendixHighlights'
]);
const OPTIONAL_IMPLEMENTATION_SPEC_KEYS = Object.freeze([
    'audioSignalSpecs'
]);
function isStructuredEditorial(profile) {
    return profile === STRUCTURED_EDITORIAL || HISTORICAL_STRUCTURED_EDITORIALS.includes(profile);
}
function isCohesiveEditorial(profile) { return profile === COHESIVE_EDITORIAL; }
function isModernEditorialProfile(profile) { return profile === COHESIVE_EDITORIAL || isStructuredEditorial(profile); }
function resolveSchemaEditorialProfile(schema) {
    if (schema?.editorialProfile === STRUCTURED_EDITORIAL) return STRUCTURED_EDITORIAL;
    if (schema?.editorialProfile === STRUCTURED_V5_EDITORIAL) return STRUCTURED_V5_EDITORIAL;
    if (schema?.editorialProfile === COHESIVE_EDITORIAL) return COHESIVE_EDITORIAL;
    return LEGACY_INTEGRATED;
}
const LOWER_HEX_64 = /^[a-f0-9]{64}$/;
const LOWER_HEX_63_65 = /^[a-f0-9]{63,65}$/;
const RESERVED_NON_MODERN_HEADER_FIELDS = Object.freeze(['version', 'schemaVersion', 'policyVersion']);
const DRAFT_ARRAY_FIELDS = Object.freeze(['sections', 'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']);

function hexEditDistanceIsOne(candidate, expected) {
    if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
    if (!LOWER_HEX_63_65.test(candidate) || !LOWER_HEX_64.test(expected)) return false;
    if (candidate === expected) return false;
    const lenDiff = candidate.length - expected.length;
    if (lenDiff === 0) {
        let diffs = 0;
        for (let i = 0; i < expected.length; i += 1) {
            if (candidate[i] !== expected[i]) {
                diffs += 1;
                if (diffs > 1) return false;
            }
        }
        return diffs === 1;
    }
    if (Math.abs(lenDiff) === 1) {
        const shorter = lenDiff < 0 ? candidate : expected;
        const longer = lenDiff < 0 ? expected : candidate;
        let i = 0;
        let j = 0;
        let skipped = false;
        while (i < shorter.length && j < longer.length) {
            if (shorter[i] === longer[j]) {
                i += 1;
                j += 1;
            } else {
                if (skipped) return false;
                skipped = true;
                j += 1;
            }
        }
        return true;
    }
    return false;
}

function hasValidCurrentDraftTopLevelShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const allowed = new Set(['contract', 'schemaFingerprint', ...DRAFT_FIELDS, ...STRUCTURED_OPTIONAL_DRAFT_FIELDS]);
    if (Object.keys(value).some(key => !allowed.has(key))) return false;
    if (!DRAFT_FIELDS.every(key => Object.hasOwn(value, key))) return false;
    if (typeof value.readerTitle !== 'string' || typeof value.oneSentenceThesis !== 'string') return false;
    if (DRAFT_ARRAY_FIELDS.some(field => !Array.isArray(value[field]))) return false;
    if (Object.hasOwn(value, 'implementationSpecs')) {
        const specs = value.implementationSpecs;
        if (!specs || typeof specs !== 'object' || Array.isArray(specs)
            || Object.getPrototypeOf(specs) !== Object.prototype) return false;
    }
    return true;
}

// Strictly opt-in live-response normalization for 1-char lowercase-hex copy
// typos on the CURRENT reader-draft schemaFingerprint. Never mutates the input,
// never promotes historical/unknown/mixed headers, and never weakens cold replay.
function normalizeCurrentDraftFingerprintTypo(value) {
    const current = codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
    const originalFingerprint = value && typeof value === 'object' && !Array.isArray(value)
        && Object.hasOwn(value, 'schemaFingerprint') ? value.schemaFingerprint : undefined;
    const unchanged = {
        normalized: value,
        typoFixed: false,
        originalFingerprint,
        canonicalFingerprint: null,
        editKind: null
    };
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) return unchanged;
    if (!Object.hasOwn(value, 'contract') || value.contract !== current.contract) return unchanged;
    if (RESERVED_NON_MODERN_HEADER_FIELDS.some(field => Object.hasOwn(value, field))) return unchanged;
    if (typeof originalFingerprint !== 'string') return unchanged;
    if (originalFingerprint === current.schemaFingerprint) {
        return {
            normalized: value,
            typoFixed: false,
            originalFingerprint,
            canonicalFingerprint: current.schemaFingerprint,
            editKind: null
        };
    }
    // Never rewrite any already-registered historical reader-draft header.
    if (codec.hasValidHeader(value, 'reader-draft', 'contract')) return unchanged;
    if (!hexEditDistanceIsOne(originalFingerprint, current.schemaFingerprint)) return unchanged;
    if (!hasValidCurrentDraftTopLevelShape(value)) return unchanged;
    const editKind = originalFingerprint.length < current.schemaFingerprint.length ? 'deletion'
        : originalFingerprint.length > current.schemaFingerprint.length ? 'insertion' : 'substitution';
    return {
        normalized: { ...value, schemaFingerprint: current.schemaFingerprint },
        typoFixed: true,
        originalFingerprint,
        canonicalFingerprint: current.schemaFingerprint,
        editKind
    };
}

function draftFormat(value, options = {}) {
    let target = value;
    let fingerprintTypoFixed = false;
    let originalFingerprint = null;
    if (options?.allowCurrentDraftFingerprintTypoNormalization === true) {
        const checked = normalizeCurrentDraftFingerprintTypo(value);
        if (checked.typoFixed) {
            target = checked.normalized;
            fingerprintTypoFixed = true;
            originalFingerprint = checked.originalFingerprint;
        }
    }
    const tagField = target && Object.hasOwn(target, 'contract') ? 'contract' : 'version';
    if (!codec.hasValidHeader(target, 'reader-draft', tagField)) throw new Error('读者文章格式头未登记或字段混用');
    const raw = target[tagField];
    const header = codec.recordHeader(raw, 'reader-draft', target.schemaFingerprint);
    const profile = codec.format(raw, 'reader-draft', target.schemaFingerprint);
    const current = codec.isCurrentHeader(target, 'reader-draft', tagField);
    const modern = Object.hasOwn(header, 'schemaFingerprint');
    const schema = modern ? codec.declaredSchema(raw, 'reader-draft', target.schemaFingerprint) : null;
    const editorialProfile = profile !== INTEGRATED ? profile : resolveSchemaEditorialProfile(schema);
    return {
        raw, header, profile, current, modern, editorialProfile,
        ...(fingerprintTypoFixed ? { fingerprintTypoFixed: true, originalFingerprint } : {})
    };
}
function isIntegratedDraft(value) {
    try { return draftFormat(value).profile === INTEGRATED; } catch { return false; }
}
function draftFields(value) {
    const fmt = draftFormat(value);
    return [...Object.keys(fmt.header), ...DRAFT_FIELDS,
        ...(isStructuredEditorial(fmt.editorialProfile) && value && Object.hasOwn(value, 'implementationSpecs')
            ? STRUCTURED_OPTIONAL_DRAFT_FIELDS : [])];
}
function profileForOptions(options = {}) {
    if (options.version !== undefined && options.version !== null) return codec.format(options.version, 'reader-draft');
    const profile = options.profile ?? INTEGRATED;
    if (![INTEGRATED, COMPACT].includes(profile)) throw new Error('读者文章要求未登记');
    return profile;
}
function assertRequiredProfile(format, options = {}) {
    const required = options.requiredVersion !== undefined && options.requiredVersion !== null
        ? codec.format(options.requiredVersion, 'reader-draft') : options.requiredProfile;
    if (required !== undefined && format.profile !== required) throw new Error('读者文章必须符合本次完整文章要求，禁止降低格式要求');
    if (options.compileCurrent === true && format.profile !== INTEGRATED) throw new Error('旧简版文章不能转换为当前完整文章');
}
function compiledPlanHeader(format, { compileCurrent = false, compiledPlanHeader: targetHeader = null } = {}) {
    if (targetHeader) {
        if (format.profile !== INTEGRATED) throw new Error('旧简版文章不能转换为当前完整文章');
        return storedPlanHeader(targetHeader);
    }
    if (format.current) {
        if (format.profile !== INTEGRATED) throw new Error('旧简版文章不能转换为当前完整文章');
        return codec.recordHeader(codec.contract('beginner-researcher'), 'beginner-researcher');
    }
    if (format.header?.contract === 'reader-draft' && format.header?.schemaFingerprint === V5_DRAFT_FP) {
        return codec.historicalHeader('beginner-researcher', INTEGRATED, V5_PLAN_FP);
    }
    if (format.header?.contract === 'reader-draft' && format.header?.schemaFingerprint === V4_DRAFT_FP) {
        return codec.historicalHeader('beginner-researcher', INTEGRATED, V4_PLAN_FP);
    }
    if (format.header?.contract === 'reader-draft' && format.header?.schemaFingerprint === OLD_DRAFT_FP) {
        return codec.historicalHeader('beginner-researcher', INTEGRATED, OLD_PLAN_FP);
    }
    if (compileCurrent) {
        if (format.profile !== INTEGRATED) throw new Error('旧简版文章不能转换为当前完整文章');
        return codec.historicalHeader('beginner-researcher', INTEGRATED, OLD_PLAN_FP);
    }
    if (typeof format.raw !== 'number') throw new Error('原读者格式缺少已登记的对应编译器，不能按当前格式猜测');
    const original = codec.historicalHeader('beginner-researcher', format.profile, null).contract;
    return { version: format.raw, ...codec.recordHeader(original, 'beginner-researcher') };
}
function storedPlanHeader(value) {
    if (value && Object.hasOwn(value, 'version')) {
        const allowed = require('./reader-legacy-records.json').planVersions[value.contract];
        if (!Array.isArray(allowed) || !allowed.includes(value.version)
            || ['schemaFingerprint', 'schemaVersion', 'policyVersion'].some(field => Object.hasOwn(value, field))
            || !codec.hasValidHeader({ contract: value.contract }, 'beginner-researcher')) throw new Error('原读者计划格式与其原声明不一致');
        return { version: value.version, ...codec.recordHeader(value.contract, 'beginner-researcher') };
    }
    if (!codec.hasValidHeader(value, 'beginner-researcher')) throw new Error('读者计划格式头未登记或字段混用');
    return codec.recordHeader(value.contract, 'beginner-researcher', value.schemaFingerprint);
}
function storedPlanFormat(value) { storedPlanHeader(value); return codec.format(value.contract, 'beginner-researcher', value.schemaFingerprint); }
function planEditorialProfile(value) {
    const header = storedPlanHeader(value);
    const profile = codec.format(header.contract, 'beginner-researcher', header.schemaFingerprint);
    if (profile !== INTEGRATED) return profile;
    if (Object.hasOwn(header, 'schemaFingerprint')) {
        const schema = codec.declaredSchema(header.contract, 'beginner-researcher', header.schemaFingerprint);
        return resolveSchemaEditorialProfile(schema);
    }
    return LEGACY_INTEGRATED;
}
function effectiveEditorialProfile(format, options = {}) {
    if (options?.editorialProfile) return options.editorialProfile;
    return format?.editorialProfile || STRUCTURED_EDITORIAL;
}
function isIntegratedPlan(value) { try { return storedPlanFormat(value) === INTEGRATED; } catch { return false; } }
function isStructuredContract(raw) {
    try {
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return codec.hasValidHeader(raw, 'beginner-researcher')
                && (codec.isContract(raw.contract, 'beginner-researcher', INTEGRATED, raw.schemaFingerprint)
                    || codec.isContract(raw.contract, 'beginner-researcher', COMPACT, raw.schemaFingerprint));
        }
        return codec.isContract(raw, 'beginner-researcher', INTEGRATED)
            || codec.isContract(raw, 'beginner-researcher', COMPACT);
    } catch { return false; }
}
function compilationOptionsForSavedPlan(plan) {
    if (!isIntegratedPlan(plan)) throw new Error('已保存文章不是受支持的完整来源绑定格式');
    const header = storedPlanHeader(plan);
    if (Object.hasOwn(header, 'version')) {
        return { requiredProfile: INTEGRATED, compileCurrent: false, editorialProfile: LEGACY_INTEGRATED, legacyNarrativeNumeralReplay: true };
    }
    if (codec.isCurrentHeader(header, 'beginner-researcher')) {
        return { requiredProfile: INTEGRATED, compileCurrent: true, editorialProfile: STRUCTURED_EDITORIAL, compiledPlanHeader: header };
    }
    if (header.contract === 'beginner-researcher' && header.schemaFingerprint === V5_PLAN_FP) {
        return { requiredProfile: INTEGRATED, compileCurrent: true, editorialProfile: STRUCTURED_V5_EDITORIAL, compiledPlanHeader: header, legacyNarrativeNumeralReplay: true };
    }
    if (header.contract === 'beginner-researcher' && header.schemaFingerprint === V4_PLAN_FP) {
        return { requiredProfile: INTEGRATED, compileCurrent: true, editorialProfile: COHESIVE_EDITORIAL, compiledPlanHeader: header, legacyNarrativeNumeralReplay: true };
    }
    if (header.contract === 'beginner-researcher' && header.schemaFingerprint === OLD_PLAN_FP) {
        return { requiredProfile: INTEGRATED, compileCurrent: true, editorialProfile: LEGACY_INTEGRATED, compiledPlanHeader: header, legacyNarrativeNumeralReplay: true };
    }
    throw new Error('原稳定格式尚无对应冷重放编译器');
}
function draftHeaderForSavedPlan(plan) {
    compilationOptionsForSavedPlan(plan);
    const header = storedPlanHeader(plan);
    if (Object.hasOwn(header, 'version')) return codec.historicalHeader('reader-draft', INTEGRATED, null);
    if (codec.isCurrentHeader(header, 'beginner-researcher')) {
        return codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
    }
    if (header.contract === 'beginner-researcher' && header.schemaFingerprint === V5_PLAN_FP) {
        return codec.historicalHeader('reader-draft', INTEGRATED, V5_DRAFT_FP);
    }
    if (header.contract === 'beginner-researcher' && header.schemaFingerprint === V4_PLAN_FP) {
        return codec.historicalHeader('reader-draft', INTEGRATED, V4_DRAFT_FP);
    }
    if (header.contract === 'beginner-researcher' && header.schemaFingerprint === OLD_PLAN_FP) {
        return codec.historicalHeader('reader-draft', INTEGRATED, OLD_DRAFT_FP);
    }
    throw new Error('原稳定格式尚无对应冷重放编译器');
}
module.exports = { INTEGRATED, COMPACT, STRUCTURED_EDITORIAL, STRUCTURED_V5_EDITORIAL, HISTORICAL_STRUCTURED_EDITORIALS, COHESIVE_EDITORIAL, LEGACY_INTEGRATED,
    OLD_DRAFT_FP, OLD_PLAN_FP, V4_DRAFT_FP, V4_PLAN_FP, V5_DRAFT_FP, V5_PLAN_FP, DRAFT_FIELDS, STRUCTURED_OPTIONAL_DRAFT_FIELDS,
    IMPLEMENTATION_SPEC_KEYS, OPTIONAL_IMPLEMENTATION_SPEC_KEYS, isStructuredEditorial, isCohesiveEditorial, isModernEditorialProfile,
    draftFormat, hexEditDistanceIsOne, normalizeCurrentDraftFingerprintTypo, isIntegratedDraft, draftFields, profileForOptions, assertRequiredProfile, compiledPlanHeader,
    storedPlanFormat, storedPlanHeader, planEditorialProfile, effectiveEditorialProfile, isIntegratedPlan,
    isStructuredContract, compilationOptionsForSavedPlan, draftHeaderForSavedPlan };

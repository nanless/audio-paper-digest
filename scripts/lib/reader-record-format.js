'use strict';
// Recognize the original wire format without rewriting its bytes. A current
// stored plan is compiled only after all integrated-article/source checks pass;
// a compact historical response can never be promoted by changing its header.
const codec = require('./protocol-codec');
const INTEGRATED = 'integrated-article';
const COMPACT = 'compact-article';
const COHESIVE_V4 = 'cohesive-functional-v4';
const LEGACY_INTEGRATED = 'legacy-integrated';
const OLD_DRAFT_FP = 'beea25256472a7b9cb4550dafd753db7d1231632a85d6dbb7f9c2e620a0628f9';
const OLD_PLAN_FP = 'cd8baf5b8bda3a49eec64f6005931af63de4e9a13148cba5f354c661ca6e9df2';
const DRAFT_FIELDS = Object.freeze(['readerTitle', 'oneSentenceThesis', 'sections',
    'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']);
function draftFormat(value) {
    const tagField = value && Object.hasOwn(value, 'contract') ? 'contract' : 'version';
    if (!codec.hasValidHeader(value, 'reader-draft', tagField)) throw new Error('读者文章格式头未登记或字段混用');
    const raw = value[tagField];
    const header = codec.recordHeader(raw, 'reader-draft', value.schemaFingerprint);
    const profile = codec.format(raw, 'reader-draft', value.schemaFingerprint);
    const current = codec.isCurrentHeader(value, 'reader-draft', tagField);
    const modern = Object.hasOwn(header, 'schemaFingerprint');
    const schema = modern ? codec.declaredSchema(raw, 'reader-draft', value.schemaFingerprint) : null;
    const editorialProfile = profile !== INTEGRATED ? profile
        : (schema?.editorialProfile === COHESIVE_V4 ? COHESIVE_V4 : LEGACY_INTEGRATED);
    return { raw, header, profile, current, modern, editorialProfile };
}
function isIntegratedDraft(value) {
    try { return draftFormat(value).profile === INTEGRATED; } catch { return false; }
}
function draftFields(value) { return [...Object.keys(draftFormat(value).header), ...DRAFT_FIELDS]; }
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
        if (schema?.editorialProfile === COHESIVE_V4) return COHESIVE_V4;
    }
    return LEGACY_INTEGRATED;
}
function effectiveEditorialProfile(format, options = {}) {
    if (options?.editorialProfile) return options.editorialProfile;
    return format?.editorialProfile || COHESIVE_V4;
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
        return { requiredProfile: INTEGRATED, compileCurrent: false, editorialProfile: LEGACY_INTEGRATED };
    }
    if (codec.isCurrentHeader(header, 'beginner-researcher')) {
        return { requiredProfile: INTEGRATED, compileCurrent: true, editorialProfile: COHESIVE_V4, compiledPlanHeader: header };
    }
    if (header.contract === 'beginner-researcher' && header.schemaFingerprint === OLD_PLAN_FP) {
        return { requiredProfile: INTEGRATED, compileCurrent: true, editorialProfile: LEGACY_INTEGRATED, compiledPlanHeader: header };
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
    if (header.contract === 'beginner-researcher' && header.schemaFingerprint === OLD_PLAN_FP) {
        return codec.historicalHeader('reader-draft', INTEGRATED, OLD_DRAFT_FP);
    }
    throw new Error('原稳定格式尚无对应冷重放编译器');
}
module.exports = { INTEGRATED, COMPACT, COHESIVE_V4, LEGACY_INTEGRATED, OLD_DRAFT_FP, OLD_PLAN_FP, DRAFT_FIELDS,
    draftFormat, isIntegratedDraft, draftFields, profileForOptions, assertRequiredProfile, compiledPlanHeader,
    storedPlanFormat, storedPlanHeader, planEditorialProfile, effectiveEditorialProfile, isIntegratedPlan,
    isStructuredContract, compilationOptionsForSavedPlan, draftHeaderForSavedPlan };

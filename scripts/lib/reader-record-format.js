'use strict';
// Recognize the original wire format without rewriting its bytes. A current
// stored plan is compiled only after all integrated-article/source checks pass;
// a compact historical response can never be promoted by changing its header.
const codec = require('./protocol-codec');
const INTEGRATED = 'integrated-article';
const COMPACT = 'compact-article';
const DRAFT_FIELDS = Object.freeze(['readerTitle', 'oneSentenceThesis', 'sections',
    'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']);
function draftFormat(value) {
    const tagField = value && Object.hasOwn(value, 'contract') ? 'contract' : 'version';
    if (!codec.hasValidHeader(value, 'reader-draft', tagField)) throw new Error('读者文章格式头未登记或字段混用');
    const raw = value[tagField];
    return { raw, header: codec.recordHeader(raw, 'reader-draft', value.schemaFingerprint),
        profile: codec.format(raw, 'reader-draft', value.schemaFingerprint),
        current: codec.isCurrentHeader(value, 'reader-draft', tagField) };
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
function compiledPlanHeader(format, { compileCurrent = false } = {}) {
    if (format.current || compileCurrent) {
        if (format.profile !== INTEGRATED) throw new Error('旧简版文章不能转换为当前完整文章');
        return codec.recordHeader(codec.contract('beginner-researcher'), 'beginner-researcher');
    }
    if (typeof format.raw !== 'number') throw new Error('原读者格式缺少已登记的对应编译器，不能按当前格式猜测');
    const original = codec.historicalContract('beginner-researcher', format.profile);
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
function isIntegratedPlan(value) { try { return storedPlanFormat(value) === INTEGRATED; } catch { return false; } }
function isStructuredContract(raw) {
    try { return [INTEGRATED, COMPACT].includes(codec.format(raw, 'beginner-researcher')); }
    catch { return false; }
}
function compilationOptionsForSavedPlan(plan) {
    if (!isIntegratedPlan(plan)) throw new Error('已保存文章不是受支持的完整来源绑定格式');
    const original = Object.hasOwn(plan, 'version');
    if (!original && !codec.isCurrentHeader(plan, 'beginner-researcher'))
        throw new Error('原稳定格式尚无对应冷重放编译器');
    return { requiredProfile: INTEGRATED, compileCurrent: !original };
}
function draftHeaderForSavedPlan(plan) {
    const options = compilationOptionsForSavedPlan(plan);
    return options.compileCurrent ? codec.recordHeader(codec.contract('reader-draft'), 'reader-draft')
        : codec.historicalHeader('reader-draft', INTEGRATED);
}
module.exports = { INTEGRATED, COMPACT, DRAFT_FIELDS, draftFormat, isIntegratedDraft,
    draftFields, profileForOptions, assertRequiredProfile, compiledPlanHeader, storedPlanFormat,
    storedPlanHeader, isIntegratedPlan, isStructuredContract, compilationOptionsForSavedPlan, draftHeaderForSavedPlan };

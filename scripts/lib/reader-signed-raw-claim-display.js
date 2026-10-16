'use strict';
// Display projection only. Range/CAS authorization remains in the signed patch
// validator; this helper neither compares numeric values nor edits a draft.
function normalizeSignedReaderClaim(rawClaim, rawNode) {
    if (typeof rawClaim !== 'string' || !rawClaim.trim() || typeof rawNode !== 'string'
        || !rawNode.includes(rawClaim)) throw new Error('签名Reader原句须逐字存在于同一真实原节点');
    const start = rawNode.indexOf(rawClaim);
    if (rawNode.lastIndexOf(rawClaim) !== start) throw new Error('签名Reader原句在原节点须唯一，不能借用另一处投影');
    const editorial = require('../editorial-quality');
    // The public finding supplies every actual surface. Adding its issue code is
    // the same adapter used by the normal Reader producer for these findings.
    const find = text => {
        const findings = editorial.findQuantitativeChineseNumerals(text);
        // The public detector masks/normalizes evidence internally. Its offsets
        // are usable only when the exact original UTF-16 span has that surface.
        if (findings.some(finding => !Number.isSafeInteger(finding.index) || finding.index < 0
            || typeof finding.match !== 'string' || !finding.match
            || text.slice(finding.index, finding.index + finding.match.length) !== finding.match))
            throw new Error('签名Reader数词诊断不能逐字绑定原始节点偏移');
        return findings;
    };
    const findings = find(rawNode);
    const issue = finding => ({ ...finding, code: 'quantitative_chinese_numeral' });
    const issues = findings.filter(finding => finding.index >= start
        && finding.index + finding.match.length <= start + rawClaim.length).map(issue);
    const project = (text, contextIssues) => require('../deep-analyzer').normalizeReaderProseFormatting(
        editorial.normalizeIssueBoundReaderQuantitativeNumerals(text, contextIssues), contextIssues
    );
    const displayed = project(rawClaim, issues);
    if (rawClaim === rawNode) return displayed;
    // Authenticate this exact occurrence through the public whole-node producer.
    // A quoted/code occurrence must not borrow an equivalent unquoted sentence.
    const sentinel = '\uE000\uE001\uE002\uE003';
    if (rawNode.includes(sentinel) || project(sentinel, find(sentinel).map(issue)) !== sentinel)
        throw new Error('签名Reader位置标记不唯一或不能逐字保持');
    const whole = project(rawNode, findings.map(issue));
    const markedNode = rawNode.slice(0, start) + sentinel + rawNode.slice(start + rawClaim.length);
    const marked = project(markedNode, find(markedNode).map(issue));
    if (marked.split(sentinel).length !== 2) throw new Error('签名Reader位置标记未唯一保留');
    const [prefix, suffix] = marked.split(sentinel);
    if (prefix.length + suffix.length > whole.length || !whole.startsWith(prefix) || !whole.endsWith(suffix))
        throw new Error('签名Reader原句边界排版不能按完整节点逐字定位');
    const actual = whole.slice(prefix.length, whole.length - suffix.length);
    if (actual !== displayed) throw new Error('签名Reader原句受完整节点上下文保护，不能借另一位置的局部投影');
    return displayed;
}
module.exports = { normalizeSignedReaderClaim };

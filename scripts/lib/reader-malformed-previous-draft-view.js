'use strict';
const crypto = require('node:crypto');
const CONTRACT = 'reader-malformed-previous-draft-diagnostic-v1';
const MAX_DIAGNOSTIC_CHARS = 8192;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
// A send-only diagnostic projection. The caller retains the complete raw and
// must already have selected an ordinary full request under its existing limits.
function malformedPreviousDraftDiagnostic({ raw, jsonText, candidate, repairContext,
    originalPromptChars, contextMaxChars }) {
    if (candidate !== null || repairContext !== null || typeof raw !== 'string' || !raw.length
        || typeof jsonText !== 'string' || !jsonText.length
        || !Number.isSafeInteger(originalPromptChars) || !Number.isSafeInteger(contextMaxChars)
        || contextMaxChars <= 0 || originalPromptChars <= contextMaxChars) return null;
    // A valid JSON value is never shortened, even when it lacks Reader fields.
    try { JSON.parse(raw); return null; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    let parseError;
    try { JSON.parse(jsonText); return null; } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        parseError = error.message;
    }
    // jsonText comes from the existing Reader JSON extraction, with no repair.
    // Ambiguous raw location stays blocked instead of guessing an error offset.
    const jsonStart = raw.indexOf(jsonText);
    if (jsonStart < 0 || raw.lastIndexOf(jsonText) !== jsonStart) return null;
    const located = /\bposition (\d+)\b/.exec(parseError);
    const parsePosition = located ? Number(located[1])
        : parseError === 'Unexpected end of JSON input' ? jsonText.length : null;
    const errorPosition = Number.isSafeInteger(parsePosition) && parsePosition >= 0
        && parsePosition <= jsonText.length ? jsonStart + parsePosition : null;
    if (errorPosition === null) return null;
    const boundaryStart = index => index > 0 && index < raw.length
        && /[\uDC00-\uDFFF]/.test(raw[index]) && /[\uD800-\uDBFF]/.test(raw[index - 1]) ? index - 1 : index;
    const boundaryEnd = index => index > 0 && index < raw.length
        && /[\uD800-\uDBFF]/.test(raw[index - 1]) && /[\uDC00-\uDFFF]/.test(raw[index]) ? index + 1 : index;
    const note = '以下仅是无法解析旧响应的有界逐字诊断材料，不是完整 JSON 草稿、合格正文或局部补丁目标。完整原响应仍按原字节保留，不能从摘录补造成功稿。请依据本次完整原文证据与原规则重新输出合法完整 JSON；摘录不是论文事实证据。';
    for (let budget = 4096; budget >= 64; budget = Math.floor(budget / 2)) {
        const ranges = [{ kind: 'head', start: 0, end: Math.min(raw.length, Math.floor(budget / 4)) },
            { kind: 'tail', start: Math.max(0, raw.length - Math.floor(budget / 4)), end: raw.length }];
        if (errorPosition !== null) ranges.push({ kind: 'parse_error',
            start: Math.max(0, errorPosition - Math.floor(budget / 4)),
            end: Math.min(raw.length, errorPosition + Math.floor(budget / 4)) });
        const excerpts = ranges.map(range => {
            const start = boundaryStart(range.start), end = boundaryEnd(range.end);
            return { kind: range.kind, startUtf16: start, endUtf16: end, text: raw.slice(start, end) };
        });
        const diagnostic = { contract: CONTRACT, diagnosticOnly: true, completeRawRetained: true,
            rawSha256: sha(raw), rawUtf16Length: raw.length, rawUtf8Bytes: Buffer.byteLength(raw),
            parsedSliceSha256: sha(jsonText), parsedSliceStartUtf16: jsonStart,
            nativeParseError: parseError, errorPositionUtf16: errorPosition,
            offsets: 'zero-based UTF-16; end-exclusive; text is an exact raw slice', excerpts };
        const text = note + '\n' + JSON.stringify(diagnostic);
        if (text.length <= MAX_DIAGNOSTIC_CHARS && text.length < raw.length) return text;
    }
    return null;
}
module.exports = { CONTRACT, MAX_DIAGNOSTIC_CHARS, malformedPreviousDraftDiagnostic };

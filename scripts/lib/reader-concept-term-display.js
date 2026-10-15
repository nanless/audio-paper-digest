'use strict';

// The prose formatter protects inline code with a token ending in "_". Its
// Chinese spacing pass can therefore add a space after a complete code span.
// Compare that outside boundary only; code bytes and word-internal spaces stay
// literal. This is not an article visibility check.
function inlineCodeRanges(text) {
    const ranges = [];
    // Mirror the publisher's existing inline-code paragraph boundaries, without
    // changing either backend's article visibility parser.
    const boundaryPattern = /\n(?:[ \t]*\n| {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]+(?=\S)|0{0,8}1[.)][ \t]+(?=\S)|(?:-+|\*{3,}|_{3,}|=+)[ \t]*(?=\n|$)))/;
    let cursor = 0;
    while (cursor < text.length) {
        const opening = /(?<!`)(`+)(?!`)/.exec(text.slice(cursor));
        if (!opening) break;
        const start = cursor + opening.index, end = start + opening[0].length;
        let escaped = 0;
        for (let before = start - 1; before >= 0 && text[before] === '\\'; before--) escaped++;
        if (escaped % 2) { cursor = end; continue; }
        const boundary = boundaryPattern.exec(text.slice(end));
        const limit = boundary ? end + boundary.index : text.length;
        const closing = new RegExp('(?<!`)`{' + opening[0].length + '}(?!`)').exec(text.slice(end, limit));
        if (!closing) { cursor = end; continue; }
        const closed = end + closing.index + closing[0].length;
        ranges.push({ start, end: closed });
        cursor = closed;
    }
    return ranges;
}

// 与 Reader bridge 排版共用确定的计数规则；只比较数字表层，不改写保存稿。
// 不解释多位中文数词、不换同义词、不删除英文内部空格，完整代码逐字保留。
function normalizeConceptTermNumericDisplay(value) {
    const text = String(value ?? '');
    const numerals = { 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5',
        六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
    const normalize = prose => prose
        .replace(/(?<![零〇一二两三四五六七八九十百千万亿\d])([一二两三四五六七八九十])(?=阶|路|次|维|步|层|个|段|类|组|轮|种|样本|倍|帧|模态|自由度|折|基准|对)/g,
            value => numerals[value])
        .replace(/(对)([一二两三四五六七八九十])(?![零〇一二两三四五六七八九十百千万亿\d])/g,
            (_surface, prefix, value) => prefix + numerals[value])
        .replace(/(?<=[\u3400-\u9fff]) +(?=\d)/g, '')
        .replace(/(?<=\d) +(?=[\u3400-\u9fff])/g, '');
    let result = '', cursor = 0;
    for (const range of inlineCodeRanges(text)) {
        result += normalize(text.slice(cursor, range.start)) + text.slice(range.start, range.end);
        cursor = range.end;
    }
    return result + normalize(text.slice(cursor));
}

function normalizeConceptTermDisplay(value) {
    const text = String(value ?? '').trim();
    const ends = new Set(inlineCodeRanges(text).map(range => range.end));
    return normalizeConceptTermNumericDisplay(text.replace(/ +(?=[\u3400-\u9fff0-9])/g,
        (space, offset) => ends.has(offset) ? '' : space));
}

function conceptTermPresent(explanation, term) {
    if (typeof explanation !== 'string' || typeof term !== 'string' || !term.trim()) return false;
    // Exact code/prose spelling is already sufficient. Numeric prose spacing
    // must not make a literal term disappear when it is wrapped in inline code.
    for (const [haystack, needle] of [[explanation, term.trim()],
        [normalizeConceptTermDisplay(explanation), normalizeConceptTermDisplay(term)]]) {
        let index = haystack.indexOf(needle);
        while (index >= 0) {
            if ((!/^[\d一二两三四五六七八九十]/.test(needle) || !/[\d.+\-零〇一二两三四五六七八九十百千万亿]/.test(haystack[index - 1] || ''))
                && (!/\d$/.test(needle) || !/[\d.]/.test(haystack[index + needle.length] || ''))) return true;
            index = haystack.indexOf(needle, index + 1);
        }
    }
    return false;
}

module.exports = { normalizeConceptTermDisplay, normalizeConceptTermNumericDisplay, conceptTermPresent };

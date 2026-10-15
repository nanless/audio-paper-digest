'use strict';

// The prose formatter protects inline code with a token ending in "_". Its
// Chinese spacing pass can therefore add a space after a complete code span.
// Compare that outside boundary only; code bytes and word-internal spaces stay
// literal. This is not an article visibility check.
function normalizeConceptTermDisplay(value) {
    const text = String(value ?? '').trim(), ends = new Set();
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
        ends.add(closed);
        cursor = closed;
    }
    return text.replace(/ +(?=[\u3400-\u9fff])/g, (space, offset) => ends.has(offset) ? '' : space);
}

function conceptTermPresent(explanation, term) {
    return typeof explanation === 'string' && typeof term === 'string' && Boolean(term.trim())
        && normalizeConceptTermDisplay(explanation).includes(normalizeConceptTermDisplay(term));
}

module.exports = { normalizeConceptTermDisplay, conceptTermPresent };

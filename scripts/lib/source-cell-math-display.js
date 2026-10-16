'use strict';

const crypto = require('node:crypto');
const CONTRACT = 'source-cell-math-display-v1';
const number = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const signedNumber = String.raw`[+−-]?${number}`;
const visibleNumeric = new RegExp(`^(${signedNumber})[ \\t]*±[ \\t]*(${number})$`);
const texNumeric = new RegExp(`^(${signedNumber})[ \\t]*\\\\pm[ \\t]*(${number})$`);

// A proof covers one complete original cell. It never strips an arbitrary TeX
// suffix, evaluates arithmetic, rounds numbers, or guesses the split of a bare
// doubled number. Source callers retain the original DOM text and its SHA.
function strictSourceCellMathDisplay(sourceText) {
    if (typeof sourceText !== 'string' || sourceText.length > 512 || /[\r\n]/.test(sourceText)) return null;
    const value = sourceText;
    let displayText, kind, style;
    const styled = /^([^\\{}]+?)(¯?)\\(underline|mathbf)\{([^{}]+)\}$/.exec(value);
    if (styled) {
        const visible = visibleNumeric.exec(styled[1].replace(/[ \t]+$/g, ''));
        const tex = texNumeric.exec(styled[4].replace(/^[ \t]+|[ \t]+$/g, ''));
        if (!visible || !tex || visible[1] !== tex[1] || visible[2] !== tex[2]
            || (styled[2] && styled[3] !== 'underline')) return null;
        displayText = `${visible[1]} ± ${visible[2]}`;
        kind = 'numeric-style-duplicate'; style = styled[3];
    } else {
        // The visible flattened power must be exactly the unique explicit TeX
        // expression with only ^, braces and horizontal whitespace removed.
        // Labels are a single bounded ASCII word, preserved without an ID rule.
        const nested = /^(?:([A-Za-z]{1,16}) )?(\[[1-9]\d{0,11}\][1-9]\d{0,5})(\[[1-9]\d{0,5}(?:\^\{[1-9]\d{0,5}\})?\]\^\{[1-9]\d{0,5}\})$/.exec(value);
        if (!nested || nested[2] !== nested[3].replace(/[\^{} \t]/g, '')) return null;
        displayText = (nested[1] ? `${nested[1]} ` : '') + `\\(${nested[3]}\\)`;
        kind = 'nested-power-duplicate';
    }
    return {
        contract: CONTRACT, kind, sourceText,
        sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        displayText, ...(style ? { style } : {})
    };
}

module.exports = { CONTRACT, strictSourceCellMathDisplay };

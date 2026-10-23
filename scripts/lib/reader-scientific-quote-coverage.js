'use strict';

// Ephemeral table coverage, never a source capability or a rewritten token
// protocol. Callers first authenticate each complete quotation normally.
function projectScientificQuoteCoverage(table, quotes, numericTokens) {
    const cells = [table.header, ...table.rows].flatMap((values, row) =>
        values.map((value, column) => ({ row, column, value: String(value), tokens: numericTokens(value) })));
    const tokens = [...new Set(numericTokens(table.markdown))];
    // NFKC is a reject-only candidate detector. Raw full-cell parsing and
    // source atoms below never normalize fullwidth/math digits into support.
    const marker = /(?:×|\\[A-Za-z]+|\{\\[A-Za-z]+\})\s*10/;
    const hasScientificMarker = value => marker.test(value.normalize('NFKC'));
    if (!cells.some(cell => hasScientificMarker(cell.value)))
        return { tokens, failures: [], cells, proofs: [] };
    const cellTokens = new Set(cells.flatMap(cell => cell.tokens));
    if (tokens.length !== cellTokens.size || tokens.some(token => !cellTokens.has(token)))
        return { tokens, failures: [{ reason: 'scientific_cell_lexical_boundaries_differ' }], cells, proofs: [] };

    const coefficient = '[+−-]?[0-9]+(?:\\.[0-9]+)?';
    const exponent = '[+−-]?[0-9]+';
    const superDigits = '⁰¹²³⁴⁵⁶⁷⁸⁹';
    const unit = '(?:kHz|MHz|Hz|dB|GB|MB|KB|ms|pp|s|h|%)';
    const atom = `(?<coefficient>${coefficient})\\s*(?:×10(?<sup>[⁺⁻]?[${superDigits}]+)`
        + `|(?:\\\\times|\\{\\\\times\\}|×)\\s*10\\^\\{(?<tex>${exponent})\\})`
        + `(?<unit>\\s*${unit})?`;
    const wholeAtom = new RegExp(`^\\s*${atom}\\s*$`);
    const dual = new RegExp(`^\\s*(?<coefficient>${coefficient})×10`
        + `(?<visibleSign>[+−-]?)(?<visibleExponent>[0-9]+)\\k<coefficient>`
        + `(?:\\\\times|\\{\\\\times\\})\\s*10\\^\\{`
        + `(?<texSign>[+−-]?)(?<texExponent>[0-9]+)\\}(?<unit>\\s*${unit})?\\s*$`);
    const exponentKey = value => {
        const normal = value.replaceAll('−', '-').replaceAll('⁻', '-').replaceAll('⁺', '+')
            .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, digit => String(superDigits.indexOf(digit)));
        return (normal.startsWith('-') ? '-' : '+') + normal.replace(/^[+-]/, '');
    };
    const key = (groups, power) => JSON.stringify([groups.coefficient.replaceAll('−', '-').replace(/^\+/, ''),
        exponentKey(power), (groups.unit || '').trim().toLowerCase()]);
    const sourceAtoms = new Map();
    for (const [quoteIndex, quote] of quotes.entries()) {
        if (typeof quote !== 'string') continue;
        for (const [lineIndex, line] of quote.split(/\r?\n/).entries()) {
            const duplicate = dual.exec(line);
            let quantity;
            if (duplicate) {
                const g = duplicate.groups;
                if (exponentKey((g.visibleSign || '+') + g.visibleExponent)
                    !== exponentKey((g.texSign || '+') + g.texExponent)) continue;
                quantity = key(g, (g.texSign || '+') + g.texExponent);
            } else {
                const single = wholeAtom.exec(line);
                if (!single) continue; // A malformed pair never falls back to its TeX suffix.
                quantity = key(single.groups, single.groups.sup || single.groups.tex);
            }
            if (!sourceAtoms.has(quantity)) sourceAtoms.set(quantity, { quoteIndex, lineIndex });
        }
    }
    const failures = [], proofs = [];
    for (const cell of cells) {
        if (!hasScientificMarker(cell.value)) continue;
        // The existing exact duplicate display normalizer emits \(...\).
        // Recognize only a complete matched pair around one supported atom;
        // no arbitrary TeX command or unmatched wrapper is decoded.
        const wrapper = /^(\s*)\\\(([\s\S]*)\\\)(\s*)$/.exec(cell.value);
        const match = wholeAtom.exec(wrapper ? wrapper[2] : cell.value);
        // Only a whole-cell quantity can grant coverage. Unknown/compound
        // units, prose, footnotes and additional scalars cannot fall back to a
        // dimensionless prefix. Other cells keep every legacy numeric token.
        if (!match) {
            failures.push({ row: cell.row, column: cell.column, value: cell.value,
                reason: 'scientific_quantity_not_complete_or_supported' });
            continue;
        }
        const g = match.groups, quantity = key(g, g.sup || g.tex);
        if (!sourceAtoms.has(quantity)) {
            failures.push({ row: cell.row, column: cell.column, value: cell.value,
                reason: 'scientific_quantity_missing_exact_bound_quote' });
            continue;
        }
        proofs.push({ row: cell.row, column: cell.column, ...sourceAtoms.get(quantity) });
        cell.tokens = [];
    }
    return { tokens: [...new Set(cells.flatMap(cell => cell.tokens))], failures, cells, proofs };
}

module.exports = { projectScientificQuoteCoverage };

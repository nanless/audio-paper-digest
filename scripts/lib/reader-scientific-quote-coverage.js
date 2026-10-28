'use strict';

// Ephemeral table coverage, never a source capability or a rewritten token
// protocol. Callers first authenticate each complete quotation normally.
function projectScientificQuoteCoverage(table, quotes, numericTokens, options = {}) {
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
    const pdfCells = new Map();
    if (options.pdfCapability !== undefined && options.pdfCapability !== null) {
        const schedules = require('./reader-sealed-pdf-quote-evidence').readScientificCoverage(options.pdfCapability, quotes);
        const headers = ['阶段','学习率','采样与复用','组与奖励'];
        const roles = ['SFT','RL-Stage I','RL-Stage II'];
        const layout = JSON.stringify(table.header) === JSON.stringify(headers) && table.rows.length === 3
            && table.rows.every((row,index)=>row.length===4 && row[0]===roles[index]);
        const plain = new RegExp(`^\\s*(?<coefficient>${coefficient})×10(?<plain>[+−-][0-9]+)(?<unit>\\s*${unit})?\\s*$`);
        if (layout) for (const schedule of schedules) {
            if (schedule.atoms.length !== 3) continue;
            const matches = table.rows.map((row,index)=>{
                const wrapper = /^(\s*)\\\(([\s\S]*)\\\)(\s*)$/.exec(row[1]);
                const match = wholeAtom.exec(wrapper ? wrapper[2] : row[1]) || plain.exec(row[1]);
                const atom = schedule.atoms[index];
                if (!match || atom.role !== roles[index] || atom.unit !== '') return null;
                const g = match.groups;
                if (g.coefficient.replaceAll('−','-') !== atom.coefficient.replaceAll('−','-')
                    || exponentKey(g.sup || g.tex || g.plain) !== exponentKey(atom.signedExponent)
                    || (g.unit || '').trim() !== atom.unit) return null;
                return { row:index+1,column:1,quoteIndex:schedule.quoteIndex,role:atom.role,
                    geometrySha256:atom.geometrySha256,rawStartCodePoint:atom.rawStartCodePoint,rawEndCodePoint:atom.rawEndCodePoint };
            });
            if (matches.every(Boolean)) {
                for (const entry of matches) pdfCells.set(`${entry.row}:${entry.column}`,entry);
                break;
            }
        }
    }
    const failures = [], proofs = [];
    for (const cell of cells) {
        if (!hasScientificMarker(cell.value)) continue;
        const pdf = pdfCells.get(`${cell.row}:${cell.column}`);
        if (pdf) { proofs.push(pdf); cell.tokens=[]; continue; }
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

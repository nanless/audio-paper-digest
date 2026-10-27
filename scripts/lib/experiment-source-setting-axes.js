'use strict';

// Categorical-axis recognition only. This never validates metric values,
// scientific conclusions, a saved checkpoint or publication eligibility.
function visible(value) {
    return String(value || '').replace(/\$/gu, '').replace(/\\(?:uparrow|downarrow)/gu, '')
        .replace(/[↑↓*_`]/gu, '').replace(/\s+/gu, ' ').trim();
}
function protectedSource(source) {
    return String(source || '')
        .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, '\n[quoted material]\n')
        .replace(/<(?:blockquote|pre|code)\b[^>]*>[\s\S]*?<\/(?:blockquote|pre|code)\s*>/giu, '\n[quoted material]\n')
        .replace(/^[ \t]*>.*$/gmu, '[quoted material]')
        .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/gu, '[quoted material]');
}
const FOREIGN = /^(?:(?:#{1,6}|\d+(?:\.\d+)*)[ .]+)?(?:(?:previous|prior|related|other|third[- ]party)\s+(?:work|research|study|experiment)|hypothetical(?: example| experiment)?|quotation|quoted statement|引述|第三方研究|假设实验)[.:：]?$/iu;
const DENIED = /\b(?:if|assuming|suppose|hypothetical|planned|proposed only|not|never|unperformed|unimplemented|withdrawn|revoked|false)\b|\b(?:other|previous|prior|related|third[- ]party|external)\s+(?:authors?|teams?|research|work)\b|第三方|假设|没有|未执行|未实施|撤回|\[quoted material\]/iu;
const REVOKED = /^(?:(?:This|That|The (?:preceding|above))\s+(?:(?:experiment|comparison|procedure|study|claim)\s+)?(?:(?:was|is)\s+)?(?:never|not|(?:only )?hypothetical|false|withdrawn)|We\s+(?:never|(?:did|do)\s+not)\s+(?:actually\s+)?(?:conduct|run|perform|implement|compare))/iu;
function ownStatement(source, pattern) {
    const match = pattern.exec(source);
    if (!match) return false;
    const opening = source.trim().split('\n')[0];
    if (FOREIGN.test(opening) || DENIED.test(opening)) return false;
    const before = source.slice(0, match.index);
    const boundary = /[.!?](?=\s+[A-Z]|\s*$)/gu;
    const boundaries = [...before.matchAll(boundary)];
    const prior = boundaries.at(-1);
    const start = prior ? prior.index + 1 : before.lastIndexOf('\n') + 1;
    const after = source.slice(match.index + match[0].length);
    const end = boundary.exec(after);
    const statement = source.slice(start, match.index + match[0].length + (end ? end.index : after.length));
    const following = end ? after.slice(end.index + 1).trimStart() : '';
    const preceding = prior ? before.slice((boundaries.at(-2)?.index ?? -1) + 1, prior.index + 1) : '';
    if (DENIED.test(statement) || DENIED.test(preceding) || REVOKED.test(following)) return false;
    const lines = before.split('\n');
    for (const line of lines.reverse().slice(0, 80)) {
        if (FOREIGN.test(line.trim())) return false;
        if (/^\s*(?:#{1,6}\s+|\d+(?:\.\d+)*[ .]+|Appendix\s+[A-Z])\S/iu.test(line)) break;
    }
    return true;
}
function sourceTables(source) {
    const captions = [...source.matchAll(/^Table\s+\d+[.:]\s*[^\n]+/gmu)];
    return captions.map((caption, index) => ({ caption: caption[0],
        body: source.slice(caption.index + caption[0].length, captions[index + 1]?.index ?? source.length),
        index: caption.index }));
}
function ownTableScope(source, block) {
    const before = source.slice(0, block.index);
    const lines = before.trimEnd().split('\n');
    const captionSentences = block.caption.split(/(?<=[.!?])\s+(?=[A-Z])/u);
    // A genuine observed table may say that particular baseline cells were
    // not run. That footnote is distinct from retracting the experiment itself.
    if (DENIED.test(lines.at(-1) || '') || DENIED.test(captionSentences[0])
        || captionSentences.slice(1).some(sentence => REVOKED.test(sentence))) return false;
    for (const line of lines.reverse().slice(0, 80)) {
        if (FOREIGN.test(line.trim())) return false;
        if (/^\s*(?:#{1,6}\s+|\d+(?:\.\d+)*[ .]+|Appendix\s+[A-Z])\S/iu.test(line)) break;
    }
    return true;
}
function rowsSafe(table, width) {
    return table && Array.isArray(table.header) && table.header.length === width
        && Array.isArray(table.rows) && table.rows.every(row => Array.isArray(row) && row.length === width);
}
const COUNT = /^(?:[–-]|\d+(?:[–-]\d+)?\/\d+(?:[–-]\d+\/\d+)?)$/u;
function perturbationTable(block, n) {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp('^Table \\d+: Rejections at n=' + escaped + '(?:n\\{=\\}' + escaped + ')? per side\\.').test(block.caption)
        || !/Music and audio cells give the range over CLaMP\s+2, VGGish and PANNs\./u.test(block.caption)) return false;
    const lines = block.body.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.slice(0, 7).join('|') !== 'Alternative|Spaces|median|cubic|window|MMDAgg|Fréchet') return false;
    let cursor = 7;
    const label = text => lines[cursor++] === text;
    const metrics = () => Array.from({ length: 5 }, () => lines[cursor++]).every(value => COUNT.test(value || ''));
    // Full original row groups, including carried alternative labels, stay in
    // source order. Omitting one source row cannot certify a view of this axis.
    for (const alternative of ['mean shift', 'contraction', 'rotation']) {
        if (!new RegExp('^' + alternative + ', s=0\\.1(?:s\\{=\\}0\\.1)?$').test(lines[cursor++] || '')
            || !label('music, audio') || !metrics() || !label('Inception') || !metrics()) return false;
    }
    for (const alternative of ['rank-2 rotation', 'rank-1 inflation']) {
        if (!label(alternative) || !/^CLaMP\s+2, PANNs$/u.test(lines[cursor++] || '')
            || !metrics() || !label('Inception') || !metrics()) return false;
    }
    if (!label('mode drop, mean-matched') || !label('music, audio') || !metrics()
        || !label('mode drop, least-displacing') || !label('all five')
        || !/^\d+[–-]\d+\/\d+ in every configuration$/u.test(lines[cursor++] || '')
        || !COUNT.test(lines[cursor++] || '') || !label('control') || !label('all five')
        || !/^at most \d+\/\d+ per cell$/u.test(lines[cursor++] || '')
        || !COUNT.test(lines[cursor++] || '')) return false;
    return /^\d+\.\d+\s+\S/u.test(lines[cursor] || '')
        && !REVOKED.test(lines[cursor + 1] || '');
}
function perturbationAxis(table, source) {
    if (!rowsSafe(table, 5) || table.rows.length !== 5) return false;
    const header = /^变化[，,]\s*每侧\s*(\d+)$/u.exec(visible(table.header[0]));
    if (!header || table.header.slice(1).map(visible).join('|') !== '中位数高斯|三次核|窄窗口高斯|MMDAgg') return false;
    const alternatives = new Set(['音乐音频均值平移 s=0.1', '音乐音频收缩 s=0.1',
        '音乐音频旋转 s=0.1', 'Inception 旋转 s=0.1', '最小位移模式删除']);
    const labels = table.rows.map(row => visible(row[0]));
    if (new Set(labels).size !== alternatives.size || labels.some(label => !alternatives.has(label))) return false;
    const n = header[1];
    if (!ownStatement(source, /We apply one known change to an independent sample, and test the two samples with each kernel configuration as a permutation test/u)
        || !new RegExp('Unless noted, n=' + n + '(?:n\\{=\\}' + n + ')?(?:,|\\.)').test(source)) return false;
    return sourceTables(source).some(block => ownTableScope(source, block) && perturbationTable(block, n));
}
function fusionAxis(table, source) {
    if (!rowsSafe(table, 4) || table.rows.length !== 4 || visible(table.header[0]) !== '调度'
        || table.header.slice(1).map(visible).join('|') !== 'R@1|R@5|R@10') return false;
    const labels = new Map([['ASV 查询为 S', 'ASV (Q=S)'], ['ASV 查询为 A', 'ASV (Q=A)'],
        ['VAS', 'VAS'], ['VSA', 'VSA']]);
    const viewLabels = table.rows.map(row => labels.get(visible(row[0])));
    if (viewLabels.some(value => !value) || new Set(viewLabels).size !== 4) return false;
    if (!ownStatement(source, /With matched encoders, components, and training settings, we compare stacked and one-by-one fusion, then vary the order within the latter/u)
        || !ownStatement(source, /We distinguish the variants by whether A or S supplies the first attention query/u)) return false;
    return sourceTables(source).some(block => {
        if (!ownTableScope(source, block)) return false;
        if (!/^Table \d+\. Fusion organization and order on MSR-VTT-9k\.$/u.test(block.caption)) return false;
        const lines = block.body.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.length !== 20 || lines.slice(0, 4).join('|') !== 'Schedule|R@1|R@5|R@10') return false;
        const sourceRows = new Map();
        for (const [i, label] of ['VAS', 'VSA', 'ASV (Q=S)', 'ASV (Q=A)'].entries()) {
            const row = lines.slice(4 + i * 4, 8 + i * 4);
            if (row[0] !== label || !row.slice(1).every(value => /^\d+(?:\.\d+)?$/u.test(value))) return false;
            sourceRows.set(label, row.slice(1));
        }
        // Presentation rows may be reordered; modality order and Q=A/S are
        // distinct identities and cannot be silently permuted or omitted.
        return table.rows.every((row, i) => row.slice(1).map(visible).join('|') === sourceRows.get(viewLabels[i]).join('|'));
    });
}
function sourceBackedSettingAxes(table, sourceText) {
    const source = protectedSource(sourceText);
    if (perturbationAxis(table, source) || fusionAxis(table, source)) return new Set([0]);
    return new Set();
}
module.exports = { sourceBackedSettingAxes };

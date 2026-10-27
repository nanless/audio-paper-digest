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
function ownTableScope(source, block, rejectPrior = line => DENIED.test(line)) {
    const before = source.slice(0, block.index);
    const lines = before.trimEnd().split('\n');
    const captionSentences = block.caption.split(/(?<=[.!?])\s+(?=[A-Z])/u);
    // A genuine observed table may say that particular baseline cells were
    // not run. That footnote is distinct from retracting the experiment itself.
    if (rejectPrior(lines.at(-1) || '') || DENIED.test(captionSentences[0])
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
function sampleSizeAxis(table, rawSource) {
    if (!rowsSafe(table, 5) || table.rows.length !== 4
        || !/^每侧样本量[，,]\s*CIFAR-10\s+旋转\s+s=0\.1$/u.test(visible(table.header[0]))
        || table.header.slice(1).map(visible).join('|') !== '中位数高斯|三次核|窄窗口高斯|MMDAgg') return false;
    const sizes = ['780', '2500', '10000', '20000'];
    const labels = table.rows.map(row => visible(row[0]));
    if (new Set(labels).size !== 4 || labels.some(label => !sizes.includes(label))) return false;
    // Quoted arm names are source terminology, not a quotation of the whole
    // experiment. All other quotation/fence protections stay in effect.
    const source = protectedSource(String(rawSource || '').replace(/“(rotation|real pair)”/gu, '$1'));
    if (!ownStatement(source, /We apply one known change to an independent sample, and test the two samples with each kernel configuration as a permutation test/u)) return false;
    const captions = [...source.matchAll(/^A\.\d+ Power against sample size in vision\.[^\n]*$/gmu)];
    return captions.some(caption => {
        const tail = source.slice(caption.index + caption[0].length);
        const boundary = /^A\.\d+\s+[^\n]+$/mu.exec(tail);
        const block = { caption: caption[0], index: caption.index, body: tail.slice(0, boundary ? boundary.index : tail.length) };
        // The real preceding paragraph says that VGGish KID values are not
        // comparable across spaces. That is not a denial of this next table.
        // Keep explicit conditional/foreign framing and experiment revocations.
        if (!ownTableScope(source, block, line => REVOKED.test(line.trim())
            || /^(?:If|Assuming|Suppose|Hypothetical|Not|Never|Other research|Previous (?:work|study)|Third[- ]party|第三方|假设|如果|\[quoted material\])/iu.test(line.trim()))
            || !/Inception embeddings of CIFAR-10 are tested against a pool of 100,000100\{,\}000 DDPM samples\./u.test(block.caption)
            || !/rotation is matched to the mean shift in 2-Wasserstein distance/u.test(block.caption)) return false;
        const lines = block.body.split('\n').map(line => line.trim()).filter(Boolean);
        const headers = ['Arm', 'Configuration', '780780', '2,5002{,}500', '5,0005{,}000', '10,00010{,}000', '20,00020{,}000'];
        if (headers.some((value, index) => lines[index] !== value)) return false;
        let cursor = headers.length;
        const rotation = new Map();
        for (const [arm, configurations] of [
            ['rotation', ['median', 'cubic', 'window 0.050.05', 'MMDAgg']],
            ['real pair', ['median', 'cubic', 'window 0.050.05', 'MMDAgg']],
            ['control', ['median', 'cubic', 'window 0.050.05']]
        ]) {
            if (lines[cursor++] !== arm) return false;
            for (const configuration of configurations) {
                if (lines[cursor++] !== configuration) return false;
                const values = lines.slice(cursor, cursor + 5); cursor += 5;
                if (values.length !== 5 || values.some((value, index) => {
                    if (value === 'n/a') return index === 0 || index === 1 || index === 2;
                    const match = /^(\d+)\/(\d+)$/u.exec(value);
                    return !match || Number(match[2]) !== [20, 20, 20, 10, 5][index] || Number(match[1]) > Number(match[2]);
                })) return false;
                if (arm === 'rotation') rotation.set(configuration, values);
            }
        }
        const footer = lines[cursor++];
        if (cursor !== lines.length || !/^Cells marked n\/a were not run\./u.test(footer || '')
            || !/A mean shift of s=0\.1s\{=\}0\.1 is detected in every configuration at every size\.$/u.test(footer)
            || footer.split(/(?<=[.!?])\s+(?=[A-Z])/u).some(sentence => REVOKED.test(sentence))) return false;
        // Keep the source's full five-size/three-arm matrix intact, then project
        // only the four existing rotation rows. Neither another grid nor a
        // same-valued result from another arm can certify this setting axis.
        const sourceIndex = new Map([['780', 0], ['2500', 1], ['10000', 3], ['20000', 4]]);
        return table.rows.every(row => ['median', 'cubic', 'window 0.050.05', 'MMDAgg'].every((configuration, index) => {
            const actual = rotation.get(configuration)[sourceIndex.get(visible(row[0]))];
            return visible(row[index + 1]) === (actual === 'n/a' ? '未运行' : actual);
        }));
    });
}
function sourceBackedSettingAxes(table, sourceText) {
    const source = protectedSource(sourceText);
    if (perturbationAxis(table, source) || fusionAxis(table, source) || sampleSizeAxis(table, sourceText)) return new Set([0]);
    return new Set();
}
function observedParagraphScope(paragraph, resultScope) {
    const position = String(resultScope).indexOf(paragraph);
    if (position < 0 || String(resultScope).lastIndexOf(paragraph) !== position) return false;
    const before = String(resultScope).slice(0, position);
    let foreign = false;
    for (const part of before.split(/[。！？!?\n]/u).map(part => part.trim()).filter(Boolean)) {
        if (FOREIGN.test(part)) foreign = true;
        if (/^(?:#{1,6}\s*)?(?:本研究|本文)(?:独立实验|实测结果|样本量扫描|实验结果|测量结果)[.:：]?$/u.test(part)) foreign = false;
    }
    if (foreign || (before.match(/```|~~~/gu) || []).length % 2
        || ['"', "'", '`'].some(quote => before.split(quote).length % 2 === 0)
        || ['blockquote', 'pre', 'code'].some(tag => (before.match(new RegExp('<' + tag + '\\b[^>]*>', 'gi')) || []).length
            > (before.match(new RegExp('</' + tag + '\\s*>', 'gi')) || []).length)
        || [['“', '”'], ['‘', '’'], ['「', '」'], ['<blockquote>', '</blockquote>'], ['<pre>', '</pre>'], ['<code>', '</code>']]
            .some(([open, close]) => before.lastIndexOf(open) > before.lastIndexOf(close))) return false;
    const following = String(resultScope).slice(position + paragraph.length).trimStart();
    return !/^(?:(?:上述|以上|前述|该|此|这个)(?:样本量)?(?:扫描|比较|实验|结果|结论)[^。\n]{0,30}(?:撤回|撤销|不成立|从未|未(?:实际)?执行|没有(?:实际)?进行)|(?:This|That)\s+(?:(?:result|experiment|comparison)\s+)?(?:was |is )?(?:not|never|(?:only )?hypothetical|withdrawn)|We\s+(?:did not|do not|never)\s+(?:actually\s+)?(?:perform this experiment|compare these models)\b)/iu.test(following);
}
function sourceBackedSampleSizeBoundary(paragraph, table, sourceText, resultScope = paragraph) {
    const text = String(paragraph || '');
    if (!sampleSizeAxis(table, sourceText)
        || !observedParagraphScope(text, resultScope)
        || /假设|假想|如果|若|可能|预计|计划|未来|第三方|他人|先前研究|相关工作|外部研究|引用|引述|转述|撤回|撤销|否认|未实测|未报告|没有进行|未(?:实际)?(?:进行|执行|实施)|从未|不是本研究|```|~~~|[“”「」"'`]|(?:^|\n)\s*>|<\/?(?:blockquote|pre|code)\b|\b(?:if|assuming|hypothetical|not|never|previous work|other study|quoted|withdrawn|retracted)\b/iu.test(text)
    ) return false;
    return /中位数带宽[^。]{0,30}780\s*时\s*3\/20[^。]{0,30}10000\s*起每次拒绝/u.test(text)
        && /窄窗口与聚合检验[^。]{0,20}2500\s*起每次检出旋转/u.test(text)
        && /三次核[^。]{0,20}10000\s*为\s*2\/10[、，,]\s*20000\s*为\s*2\/5/u.test(text)
        && /(?:不据此建立高功效趋势|不能推广为三次核的高功效区间)/u.test(text);
}
module.exports = { sourceBackedSettingAxes, sourceBackedSampleSizeBoundary };

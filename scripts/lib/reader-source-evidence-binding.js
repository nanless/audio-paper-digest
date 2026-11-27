'use strict';

const crypto = require('crypto');
const { extractMarkdownTables } = require('../analysis-contract.js');
const {
    bracketedNumericVectors,
    findReaderTablePasteDuplication
} = require('./reader-tables.js');
const {
    READER_SECTION_KINDS: API_READER_KINDS,
    locateReaderDraftTables
} = require('./reader-draft-order.js');
const { normalizeReaderSourceDisplayArtifacts } = require('./reader-source-display');

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function recoverySha256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function stableFingerprint(value) {
    const normalize = item => {
        if (Array.isArray(item)) return item.map(normalize);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function assertExactObjectKeys(value, expectedKeys, context) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${context} 必须是对象`);
    }
    const actual = Object.keys(value);
    const missing = expectedKeys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
    const extra = actual.filter(key => !expectedKeys.includes(key));
    if (missing.length > 0) throw new Error(`${context} 缺少字段: ${missing.join(', ')}`);
    if (extra.length > 0) throw new Error(`${context} 包含额外字段: ${extra.join(', ')}`);
}

// 来源检查前，按照 artifact_table 记录的原表坐标恢复所选表格，避免正文清理
// 把 0-12kHz 改成 0-12 kHz 等写法。这个步骤只恢复已对应原表单元格的内容；
// source_quotes 表格不在此处理，它们的文字内容仍需按引用证据另行核验。
function restoreReaderSelectedTableBytes(article, tableBindings, structuredArtifacts) {
    let output = String(article || '');
    const bindings = Array.isArray(tableBindings) ? tableBindings : [];
    const tableShape = rows => `${rows.length}行×${rows[0]?.length || 0}列`;
    const headerPreview = table => String((table?.header || [])
        .map(value => normalizeReaderSourceDisplayArtifacts(String(value).trim()))
        .filter(Boolean).slice(0, 4).join(' / ')).slice(0, 160);
    // 模型最常犯的定位错误是把 tableIndex 当成原表序号，或新增/删除正文表后没有重编号。
    // 只说「坐标无法重放」模型无法定位是哪张表错了；这里点名绑定、正文表、原表尺寸，
    // 并在正文里找出与所选原表同尺寸的表，给出可直接照抄的 tableIndex 修正。
    const describeTableIndexMismatch = (binding, bindingIndex, table, sourceTable, rows) => {
        const bindingLabel = `tableBindings[${bindingIndex}]`;
        const sourceMatrix = Array.isArray(sourceTable?.matrix) ? sourceTable.matrix : [];
        const sourceWidth = sourceMatrix[0]?.length || 0;
        const renderedWidth = table.header?.length || 0;
        // selection 只选原表的部分行列时，正文表本来就会比原矩阵小；只有逐格绑定
        // 覆盖完整原矩阵（completeTable 或整表 artifact_table）才可能用尺寸判断
        // tableIndex 指错了表。部分选择仍交给逐格坐标检查。
        const claimsWholeSourceTable = sourceMatrix.length * sourceWidth > 0
            && binding.cellBindings.length === sourceMatrix.length * sourceWidth;
        if (!claimsWholeSourceTable || !sourceWidth || !renderedWidth
            || (rows.length === sourceMatrix.length && renderedWidth === sourceWidth)) return '';
        const tables = extractMarkdownTables(output);
        const candidates = tables.flatMap((candidate, index) => {
            const candidateRows = [candidate.header, ...candidate.rows];
            return candidateRows.length === sourceMatrix.length
                && candidateRows[0]?.length === sourceWidth ? [index + 1] : [];
        });
        const actualHeader = headerPreview(table);
        const sourceHeader = headerPreview({ header: sourceMatrix[0] });
        return `：${bindingLabel}（sourceTableOrdinal=${binding.sourceTableOrdinal}）绑定的是 `
            + `${tableShape(sourceMatrix)} 的原表${sourceHeader ? `（首行：${sourceHeader}）` : ''}，`
            + `但正文第${binding.tableIndex}张 Markdown 表是 ${tableShape(rows)}`
            + `${actualHeader ? `（表头：${actualHeader}）` : ''}。tableIndex 是正文表序，不是原表序号。`
            + (candidates.length === 1
                ? `正文第${candidates[0]}张表是 ${tableShape(sourceMatrix)}，与原表尺寸一致；`
                    + `请把 ${bindingLabel}.tableIndex 改为 ${candidates[0]}，并让所有 tableBindings 按最终正文表序连续编号。`
                : candidates.length > 1
                    ? `正文第${candidates.join('、')}张表都是 ${tableShape(sourceMatrix)}；`
                        + '请按表头与原表逐列核对后选择正确的一张，并让所有 tableBindings 按最终正文表序连续编号。'
                    : `正文中没有 ${tableShape(sourceMatrix)} 的表；请确认该原表的 Markdown 表仍在正文中，`
                        + '或改用 selection/completeTable/逐字引文，不能把手写表绑到错误的表号。')
            + (tables.length === bindings.length ? ''
                : `正文当前有 ${tables.length} 张 Markdown 表但只有 ${bindings.length} 条 tableBindings；`
                    + '每张正文表都要有来源记录（无原表时用 source_quotes 的逐字引文，或删除该表），'
                    + '否则后续表号必然错位。')
            + '若这是完整原表被合并了两层表头，程序只接受能由原 DOM 跨行/跨列唯一证明的合并；'
            + '请保留原表全部行列，或改用 completeTable 由程序按原 DOM 生成整表。'
            + '不能只改正文或删表绕过：保留原比较条件、数字、单位与结果。';
    };
    for (const [bindingIndex, binding] of bindings.entries()) {
        if (binding?.sourceType !== 'artifact_table'
            || !Number.isSafeInteger(binding.tableIndex)
            || !Array.isArray(binding.cellBindings)
            || binding.cellBindings.length === 0) continue;
        const tables = extractMarkdownTables(output);
        const table = tables[binding.tableIndex - 1];
        const sourceTable = (structuredArtifacts?.tables || []).find(item => (
            item?.ordinal === binding.sourceTableOrdinal && item?.recoveryStatus === 'complete'
        ));
        if (!table || !sourceTable) {
            throw new Error(`读者文章表格绑定无法定位正文表或原表（cell 坐标无法重放）：`
                + `tableBindings[${bindingIndex}] 的 tableIndex=${binding.tableIndex} 在正文中找不到 Markdown 表，`
                + `或 sourceTableOrdinal=${binding.sourceTableOrdinal} 不是唯一且 recoveryStatus=complete 的原表。`
                + `正文现有 ${tables.length} 张 Markdown 表；tableIndex 必须按最终正文表序连续编号，`
                + '原表身份必须来自本次证据，不能发明序号或改绑另一张表。');
        }
        let rows = [table.header, ...table.rows];
        rows = restoreUniquelyMergedReaderHeaderRows(rows, binding, sourceTable) || rows;
        const mismatch = describeTableIndexMismatch(binding, bindingIndex, table, sourceTable, rows);
        if (mismatch) throw new Error(`读者文章表格绑定表号错位（cell 坐标无法重放）${mismatch}`);
        const mapped = new Map();
        for (const [cellIndex, cellBinding] of binding.cellBindings.entries()) {
            const key = `${cellBinding?.renderedRow}:${cellBinding?.renderedColumn}`;
            const sourceCell = findStructuredTableCell(
                sourceTable, cellBinding?.sourceRow, cellBinding?.sourceColumn
            );
            if (!sourceCell || mapped.has(key)
                || rows[cellBinding?.renderedRow]?.[cellBinding?.renderedColumn] === undefined) {
                const reason = !sourceCell
                    ? `sourceRow=${cellBinding?.sourceRow}、sourceColumn=${cellBinding?.sourceColumn} 不在原表 DOM 单元格内`
                    : mapped.has(key)
                        ? `renderedRow=${cellBinding?.renderedRow}、renderedColumn=${cellBinding?.renderedColumn} 与前面的坐标重复`
                        : `renderedRow=${cellBinding?.renderedRow}、renderedColumn=${cellBinding?.renderedColumn} 超出正文第${binding.tableIndex}张表的 ${tableShape(rows)} 范围`;
                throw new Error(`读者文章表格绑定的逐格坐标无法重放：`
                    + `tableBindings[${bindingIndex}].cellBindings[${cellIndex}] ${reason}。`
                    + `逐格坐标必须与正文 Markdown 表的行列一一对应，并落在原表 DOM 单元格内；`
                    + '不要复用坐标、猜坐标或把别的表/别的原表的坐标抄进来。');
            }
            mapped.set(key, require('./reader-tables').escapeMarkdownTableCell(
                normalizeReaderSourceDisplayArtifacts(require('./reader-table-pdf-evidence')
                    .displayCell(sourceTable, cellBinding.sourceRow, cellBinding.sourceColumn))
            ));
        }
        const rebuiltRows = rows.map((row, rowIndex) => row.map((_cell, columnIndex) => {
            const key = `${rowIndex}:${columnIndex}`;
            if (!mapped.has(key)) throw new Error(
                `读者文章表格绑定的 cellBindings 不完整：`
                + `正文第${binding.tableIndex}张表的 renderedRow=${rowIndex}、renderedColumn=${columnIndex} `
                + `（${tableShape(rows)}）没有对应的 cellBindings 项。artifact_table 必须逐格绑定完整原表，`
                + '不能只绑定部分行、漏掉表头或把合并单元格拆成少格。'
            );
            return mapped.get(key);
        }));
        const line = cells => `| ${cells.join(' | ')} |`;
        const rebuilt = [
            line(rebuiltRows[0]),
            line(rebuiltRows[0].map(() => '---')),
            ...rebuiltRows.slice(1).map(line)
        ].join('\n');
        if (rebuilt !== table.markdown) {
            // tableIndex 是带签名的结构定位符。两份完全相同的 Markdown 表格是合法的
            // （同一张协议表可以既出现在训练里也出现在结果里），所以按字符串出现位置替换
            // 会否掉一次本来安全、只认位置的复现。改成替换精确抽取到的行区间。
            const lines = output.split('\n');
            const current = lines.slice(table.startLine, table.endLine + 1).join('\n');
            if (current !== table.markdown) throw new Error(
                `Reader selection table ${binding.tableIndex} 的结构定位发生漂移`
            );
            lines.splice(table.startLine, table.endLine - table.startLine + 1, ...rebuilt.split('\n'));
            output = lines.join('\n');
        }
    }
    return output;
}

// 仅恢复已被模型合并的一对原表头。完整 identity 绑定表明请求的是整表，
// 但正文的一行复合列头会使原两行坐标全部错位。数据必须逐格保留，
// 且合并列头必须由唯一 DOM 跨行/跨列结构证明；不修复缺数据或错数字。
function restoreUniquelyMergedReaderHeaderRows(rows, binding, sourceTable) {
    const matrix = sourceTable?.matrix;
    if (!Array.isArray(matrix) || matrix.length < 3 || !Array.isArray(matrix[0])
        || matrix[0].length < 2 || matrix.some(row => !Array.isArray(row)
            || row.length !== matrix[0].length || row.some(cell => typeof cell !== 'string'))
        || rows.length !== matrix.length - 1
        || rows.some(row => row.length !== matrix[0].length)
        || !Array.isArray(binding?.cellBindings)
        || binding.cellBindings.length !== matrix.length * matrix[0].length) return null;
    const cells = Array.isArray(sourceTable.cells) ? sourceTable.cells : [];
    const width = matrix[0].length;
    const seen = new Set();
    for (const item of binding.cellBindings) {
        if (!Number.isInteger(item?.renderedRow) || !Number.isInteger(item?.renderedColumn)
            || item.renderedRow !== item.sourceRow || item.renderedColumn !== item.sourceColumn
            || item.sourceRow < 0 || item.sourceRow >= matrix.length
            || item.sourceColumn < 0 || item.sourceColumn >= width) return null;
        const key = `${item.sourceRow}:${item.sourceColumn}`;
        if (seen.has(key)) return null;
        seen.add(key);
        const dom = cells.filter(cell => item.sourceRow >= cell.row
            && item.sourceRow < cell.row + Number(cell.rowspan || 1)
            && item.sourceColumn >= cell.column
            && item.sourceColumn < cell.column + Number(cell.colspan || 1));
        if (dom.length !== 1 || !/^[a-f0-9]{64}$/.test(dom[0].sourceDomSha256 || '')
            || dom[0].text !== matrix[item.sourceRow][item.sourceColumn]) return null;
    }
    // 混合 th/td 的 LaTeXML 表头：第一列 th 跨两行，其他列至少有一个
    // 第一行分组头跨列；第二行每格来源仍必须唯一。
    const anchor = cells.filter(cell => cell.row === 0 && cell.column === 0
        && cell.header === true && Number(cell.rowspan) === 2 && Number(cell.colspan || 1) === 1);
    if (anchor.length !== 1 || !cells.some(cell => cell.row === 0
        && Number(cell.rowspan || 1) === 1 && Number(cell.colspan) > 1)
        || cells.some(cell => cell.row < 2 && cell.row + Number(cell.rowspan || 1) > 2)) return null;
    const canonical = value => normalizeReaderSourceCell(value);
    const dataCanonical = value => normalizeReaderSourceDisplayArtifacts(value)
        .normalize('NFKC').replace(/\s+/g, ' ').trim();
    for (let row = 2; row < matrix.length; row++) {
        for (let column = 0; column < width; column++) {
            if (dataCanonical(rows[row - 1][column]) !== dataCanonical(matrix[row][column])) return null;
        }
    }
    for (let column = 0; column < width; column++) {
        const top = canonical(matrix[0][column]), bottom = canonical(matrix[1][column]);
        const merged = top === bottom ? top : `${top} ${bottom}`;
        // 单位括号可在合并时移到复合列名末尾；文字与单位本身完全保留。
        const unit = /^(.*) (\([^()]+\))$/.exec(top);
        const alternate = unit && top !== bottom ? `${unit[1]} ${bottom} ${unit[2]}` : merged;
        if (canonical(rows[0][column]) !== merged && canonical(rows[0][column]) !== alternate) return null;
    }
    return matrix.map(row => [...row]);
}

// arXiv 的 LaTeXML 文本投影会把可见公式和它的 TeX 注解放进同一个表格单元。这一步
// 只合并带明确 TeX 语法、两侧数值完全一致的显示副本。裸数字或符号的重复不能
// 证明它们来自同一个值；来源绑定仍以原始 DOM 字节为准。

function normalizeReaderSourceCell(value) {
    return normalizeReaderSourceDisplayArtifacts(String(value ?? '')).normalize('NFKC')
        .replace(/\{=\}/g, '=')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/[*_`]/g, '')
        .replace(/[％]/g, '%')
        .replace(/\s+/g, ' ')
        .trim();
}

function findStructuredTableCell(table, row, column) {
    return (table?.cells || []).find(cell => (
        Number.isInteger(cell?.row) && Number.isInteger(cell?.column)
        && row >= cell.row && row < cell.row + Number(cell.rowspan || 1)
        && column >= cell.column && column < cell.column + Number(cell.colspan || 1)
    ));
}

function readerNumericTokenMatches(value) {
    // 只对全角数字、点和符号做等长映射，不做整篇 NFKC，保证 match.index 可用于原文切片；
    // 之前先 NFKC 再匹配，遇到 ﬁ/ﬂ 等合字会让索引整体漂移，导致按索引切出的
    // quote 落在错误位置、token 永远对不上。全角数字/小数点/百分号与数学减号
    // 纳入字符类；比较归一化仍由 normalizeReaderNumericToken 负责。
    // 注意：en/em dash 不算减号，避免把页码范围误读成负数。
    // NFKC 会把数学粗体、等宽与上下标数字映射成普通数字；这里按等长字符一并纳入，
    // 保证与 Python 侧「先 NFKC 再匹配」得到同一组词元（½ 这类会展开成多字符的分数
    // 不纳入，避免 match.index 与原文切片错位）。字符类含增补平面字符，正则必须带 u。
    // 上标 ¹²³ 在拉丁补充区（U+00B9/B2/B3），其余上标与全部下标在各自区段。
    // 只纳入逐字符等于一个数字的写法（数学粗体/等宽数字）。上下标数字不纳入：
    // 10⁻⁴ 的 ⁴ 会单独变成词元 4，让表格里随便一个 4 都算“被引文覆盖”，
    // 而这类判定在发布端另有自己的 NFKC 口径，不能靠扩大字符类来对齐。
    const digit = '[\\d\\uFF10-\\uFF19\\u{1D7CE}-\\u{1D7FF}]';
    const sign = '[-+\\uFF0D\\u2212]';
    const dot = '(?:[\\.\\uFF0E])';
    const percent = '(?:\\s*%|\\s*\\uFF05)';
    // 单位必须是一个完整的 token：下一行的 SE、BAK 或 Model 不是秒、十亿或百万。数值和
    // 独立单位之间的合法空格要保留，换行也算。
    const unit = '(?:seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp)'
        + '(?![A-Za-z0-9_\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF10-\\uFF19])';
    const lookbehind = '(?<![A-Za-z0-9\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF10-\\uFF19])';
    // 走千位分组的那个分支，必须把它最后一个逗号之后的数字全部吃掉。少了这条边界，
    // `10^-4,2000` 会被截成假 token `-4,200`（规范形式 `-4200`），而实际上是 `-4` 和
    // `2000` 两个真实数值。
    const groupedInteger = `(?:${digit}{1,3}(?:[,\\uFF0C]${digit}{3})+(?!${digit})|${digit}+)`;
    // 3.093.09 一类损坏表面整体保留，不能截出 3.093 或猜成 3.09。
    const decimal = `(?:${digit}*${dot}${digit}+)`;
    const doubledDecimal = `(?:\\+(${decimal})\\+\\1|[-\\uFF0D\\u2212](${decimal})[-\\uFF0D\\u2212]\\2|${sign}?(${decimal})\\3)(?!${digit}|${dot}${digit})`;
    const pattern = new RegExp(
        `${lookbehind}(?:${doubledDecimal}|${sign}?(?:${groupedInteger}(?:${dot}${digit}+)?|${dot}${digit}+))(?:${percent}|\\s*(?:${unit}))?`,
        'giu'
    );
    // LaTeXML 会把显式的 TeX 颜色命令压平成像 \\textcolorblue58.62 的样子。只屏蔽紧挨
    // 在数字前面的标准颜色名前缀；用等长空格替换，原文下标和引文字节都不变。标识符边界
    // 不要放宽，单位也不要改写。
    const originalSurface = String(value || '');
    const numericSurface = originalSurface.replace(
        /(\\textcolor(?:black|blue|brown|cyan|darkgray|gray|green|lightgray|lime|magenta|olive|orange|pink|purple|red|teal|violet|white|yellow))([-+\uFF0D\u2212]?[0-9\uFF10-\uFF19][0-9.\uFF10-\uFF19\uFF0E]*)/g,
        (surface, prefix, number, offset) => {
            // 屏蔽之后，外置的符号会和数值脱开。这种有歧义的形态一律按失败处理，包括它的
            // 小数尾巴；不要造一个正数 token，也不要让符号跨过原文的字节。
            if (/[-+\uFF0D\u2212]\s*$/.test(originalSurface.slice(0, offset))) {
                return ' '.repeat(surface.length);
            }
            return ' '.repeat(prefix.length) + number;
        }
    // LaTeXML may emit the visible ± immediately followed by its identical TeX
    // operator before an uncertainty, e.g. 75.7±\\pm1.1. Mask only that duplicate
    // operator, at the same length, so the full following scalar retains its
    // original index. Unknown commands, signed/partial numbers and units are
    // not decoded or inferred here.
    ).replace(/±\\pm(?=(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?![A-Za-z0-9_.]))/g,
        operator => ' '.repeat(operator.length))
        .replace(/[０-９．＋－]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xfee0));
    const matches = [...numericSurface.matchAll(pattern)];
    // LaTeXML 有时会把可见公式和它的 TeX 注解紧挨着压平在一起。为正文和表格文本里确实
    // 见到的两种形态各留一个范围很窄的别名，好让后面的单位仍挂在它真正描述的数值上。
    // 引文仍以原始字节和下标为准；数值、符号、精度或单位只要有一样不同，就不生成别名。
    const exactNumber = raw => {
        const surface = String(raw || '').normalize('NFKC')
            .replace(/[\u2212\uFF0D]/g, '-');
        return /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(surface)
            ? surface : '';
    };
    const appendAlias = (whole, leftRaw, rightRaw, unitRaw, sourceLength = whole[0].length) => {
        const left = exactNumber(leftRaw);
        const right = exactNumber(rightRaw);
        if (!left || left !== right) return;
        const alias = [`${leftRaw} ${unitRaw}`];
        alias.index = whole.index;
        alias.input = originalSurface;
        alias.sourceLength = sourceLength;
        alias.latexmlExactDuplicateAlias = true;
        matches.push(alias);
    };
    // TeX 的千位分隔符会被压平成 `{,}`，通常跟在字面统计量名后面，例如
    // 4,852\mu=4{,}852 ms。只认这个 \mu= 桥接形态，而且要求去掉 TeX 花括号之后两边的
    // 数字写法完全相同。
    const texStatistic = /(?<![A-Za-z0-9])([+\-\u2212\uFF0D]?(?:[0-9\uFF10-\uFF19]{1,3}(?:[,\uFF0C][0-9\uFF10-\uFF19]{3})+|[0-9\uFF10-\uFF19]+)(?:[.\uFF0E][0-9\uFF10-\uFF19]+)?)\\mu\s*=\s*([+\-\u2212\uFF0D]?[0-9\uFF10-\uFF19{}.,\uFF0C\uFF0E]+)\s*(seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp|[%\uFF05])(?![A-Za-z0-9_])/gi;
    for (const whole of originalSurface.matchAll(texStatistic)) {
        appendAlias(whole, whole[1], whole[2].replace(/[{}]/g, ''), whole[3]);
    }
    // LaTeXML 还会把一个完整的可见测量值紧接在它的 TeX 注解前面重复一遍，例如
    // 50 Hz50\\text{\\,}\\mathrm{H}\\mathrm{z}。Hz 后面那个数字正好挡住了普通的单位
    // 分词器。只有当两处数字写法和完全解码后的单位都一致时才加别名；引文仍以原始的那
    // 一段为准。
    const texMeasurement = /(?<![A-Za-z0-9])([+\-\u2212\uFF0D]?(?:[0-9\uFF10-\uFF19]{1,3}(?:[,\uFF0C][0-9\uFF10-\uFF19]{3})+|[0-9\uFF10-\uFF19]+)(?:[.\uFF0E][0-9\uFF10-\uFF19]+)?)\s*(seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp)([+\-\u2212\uFF0D]?(?:[0-9\uFF10-\uFF19]{1,3}(?:[,\uFF0C][0-9\uFF10-\uFF19]{3})+|[0-9\uFF10-\uFF19]+)(?:[.\uFF0E][0-9\uFF10-\uFF19]+)?)(?:\s|\\text\{\\[,;!]\}|\\[,;!])*((?:\\(?:mathrm|textrm|text)\{[A-Za-z]+\}){1,8})(?![A-Za-z0-9_]|\\(?:mathrm|textrm|text)\{[A-Za-z])/gi;
    for (const whole of originalSurface.matchAll(texMeasurement)) {
        const texUnit = [...whole[4].matchAll(/\\(?:mathrm|textrm|text)\{([A-Za-z]+)\}/g)]
            .map(match => match[1]).join('');
        if (texUnit.toLowerCase() !== whole[2].toLowerCase()) continue;
        appendAlias(whole, whole[1], whole[3], whole[2]);
    }
    return matches.sort((left, right) => left.index - right.index);
}

function normalizeReaderNumericToken(raw) {
    // 千分位逗号只在“恰好三位一组”时归一化（44,000 → 44000），避免把
    // 枚举“1,2”或小数逗号误合并；NFKC 与去空白后模型与原文走同一归一化。
    // 多组千分位（1,234,567）需循环到稳定。
    // NFKC 不映射数学减号 U+2212 与全角连字符 U+FF0D，必须显式归一为
    // ASCII 连字符，否则原文“−58 dB”与模型写的“-58 dB”永远对不上。
    const surface = String(raw || '').normalize('NFKC').replace(/[\u2212\uFF0D]/g, '-');
    let token = surface;
    let previous;
    do {
        previous = token;
        token = token.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
    } while (token !== previous);
    token = token.replace(/\s+/g, '').toLowerCase();
    const match = token.match(/^([-+]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$/);
    if (!match) return token;
    const numStr = match[1];
    let suffix = match[2] || '';
    const num = Number(numStr);
    if (!Number.isFinite(num)) return token;
    // 四位年份的英文复数（如 2025s）不是“秒”单位，去掉裸 s 以便与原文年份对齐；
    // 真正的秒数（5s、30s）不受影响。
    if (/^\d{4}s$/i.test(surface.trim()) && /^\d{4}$/.test(numStr) && Number(numStr) >= 1000
        && Number(numStr) <= 2999 && suffix === 's') {
        suffix = '';
    }
    if (suffix === 'second' || suffix === 'seconds') suffix = 's';
    // 去除无意义的尾零：2.00 -> 2, 2.50% -> 2.5%
    return `${String(num)}${suffix}`;
}

function readerNumericTokens(value) {
    return readerNumericTokenMatches(value).map(match => normalizeReaderNumericToken(match[0]));
}

// 表格方法名里的 [37]、[12, 37] 是参考文献编号，不是测量值，不能被当作
// “数值+单位”证据要求。只有同一数字在方括号之外也以数值形式出现时，才仍按
// 测量值要求引文；数字本身仍保留原单元格的 DOM 证据。
function readerCitationOnlyNumericTokens(rows) {
    const texts = (Array.isArray(rows) ? rows : [])
        .flat().map(value => String(value ?? ''));
    const citationGroup = /\[\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*\]/g;
    const outside = new Set(texts.flatMap(text => (
        readerNumericTokens(text.replace(citationGroup, ' '))
    )));
    const citations = new Set();
    for (const text of texts) {
        for (const group of text.match(citationGroup) || []) {
            for (const token of readerNumericTokens(group)) citations.add(token);
        }
    }
    return new Set([...citations].filter(token => !outside.has(token)));
}

function readerScientificQuoteProjection(table, quotes) {
    const values = quotes.map(item => typeof item === 'string' ? item : item?.quote);
    const scientificMarker = /(?:×|\\times)\s*10(?!\d)/;
    const hasScientific = [table.header, ...table.rows].some(row => row.some(value => scientificMarker.test(String(value))
        || scientificMarker.test(String(value).normalize('NFKC'))));
    const pdfCapability = hasScientific && quotes.some(item => item?.valueOrigin === 'sealed_pdf')
        ? require('./reader-sealed-pdf-quote-evidence').scientificCoverageForQuotes(quotes) : null;
    return require('./reader-scientific-quote-coverage').projectScientificQuoteCoverage(
        table, values, readerNumericTokens, { pdfCapability });
}

function readerScientificQuoteFailure(projection) {
    return projection.failures.map(item => `row=${item.row},column=${item.column}`
        + ` text=${JSON.stringify(String(item.value || '').slice(0, 120))} ${item.reason}`).join('；');
}

function exactSourceExcerpt(sourceText, index, length, maxChars = 800) {
    const source = String(sourceText || '');
    const lower = Math.max(0, index - Math.floor(maxChars / 2));
    const upper = Math.min(source.length, index + length + Math.floor(maxChars / 2));
    const before = source.slice(lower, index);
    const after = source.slice(index + length, upper);
    const beforeBoundary = Math.max(
        before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('. ')
    );
    const afterBoundaries = [after.indexOf('\n'), after.indexOf('。'), after.indexOf('. ')]
        .filter(value => value >= 0);
    const start = lower + (beforeBoundary >= 0 ? beforeBoundary + 1 : 0);
    const end = index + length + (afterBoundaries.length > 0
        ? Math.min(...afterBoundaries) + 1 : after.length);
    const candidate = source.slice(start, end);
    const target = source.slice(index, index + length);
    const relativeTarget = index - start;
    const windowStart = candidate.length > maxChars
        ? Math.max(0, Math.min(
            relativeTarget - Math.floor((maxChars - length) / 2),
            candidate.length - maxChars
        ))
        : 0;
    const quote = candidate.slice(windowStart, windowStart + maxChars).trim();
    if (quote.length >= 12 && quote.includes(target)) return quote;
    // 表格/列表中的数字常独占一行，按句子切分只剩几个字符，会被下游当作无效
    // 证据丢掉；此时按行向两侧扩展，保证证据可用且仍包含目标 token。
    const lineStarts = [0];
    for (const match of source.matchAll(/\n/g)) lineStarts.push(match.index + 1);
    let lineIdx = lineStarts.findIndex((start, cursor) => (
        index >= start && (cursor + 1 === lineStarts.length || index < lineStarts[cursor + 1])
    ));
    if (lineIdx < 0) lineIdx = lineStarts.length - 1;
    const expandedLower = lineStarts[Math.max(0, lineIdx - 4)];
    const expandedUpper = lineStarts[Math.min(lineStarts.length, lineIdx + 5)] ?? source.length;
    const expandedStart = expandedUpper - expandedLower > maxChars
        ? Math.max(expandedLower, Math.min(
            index - Math.floor((maxChars - length) / 2), expandedUpper - maxChars
        ))
        : expandedLower;
    // 缩进、空行和原始行尾都要原样保留。用 trim/join 拼出来的字符串对不上，没法当作
    // 精确引文复现。
    const expanded = source.slice(expandedStart, Math.min(expandedUpper, expandedStart + maxChars));
    if (expanded.length >= 12 && expanded.includes(source.slice(index, index + length))) {
        return expanded;
    }
    return quote;
}

function sourceNumericTokenExpansions(raw) {
    return new Set([normalizeReaderNumericToken(raw)]);
}

function readerSourceQuoteCoversNumericToken(token, quoteCorpus, allowSplitUnit = false) {
    const corpus = String(quoteCorpus || '');
    if (readerNumericTokens(corpus).includes(token)) return true;
    if (!allowSplitUnit) return false;
    // PDF 双栏抽取会把一栏的碎片塞进数值和它的单位之间（例如「-38.1 [右栏文字] dB」）。
    // 只有当它是精确的原文引文、数值部分还在、匹配的单位后面没有别的数字 token 时才
    // 接受。这是为质量很差的会议 PDF 文本做的证据恢复，不是把 Reader 闸门的单位要求
    // 普遍放宽。
    const match = String(token || '').match(/^([-+]?\d+(?:\.\d+)?)(db|ms|hz|khz|mhz|gb|mb|kb|pp|%|s|h)$/i);
    if (!match) return false;
    const numberToken = normalizeReaderNumericToken(match[1]);
    if (!readerNumericTokens(corpus).includes(numberToken)) return false;
    const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unit = match[2].toLowerCase() === 'db' ? 'dB' : match[2];
    const unitPattern = escapeRegExp(unit);
    // 双栏抽取之后，引用编号可能夹在数值与单位之间；它不是另一个测量值。
    const citationStrippedCorpus = corpus.replace(/\[\s*\d+(?:\s*[,;]\s*\d+)*\s*\]/g, ' ');
    const trailingUnit = new RegExp(
        `^(?:(?![-+\\u2212\\uFF0D]?[0-9\\uFF10-\\uFF19])(?:[\\s\\S])){0,160}?(?<![A-Za-z0-9_\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF10-\\uFF19])${unitPattern}(?![A-Za-z0-9_\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF10-\\uFF19])`,
        'i'
    );
    // 先定位同值且同符号的完整数值，再只检查它后面的单位；不能从另一个
    // 正数或更长数字的尾部借单位，也不能把相邻测量的单位移到这个标量上。
    return readerNumericTokenMatches(citationStrippedCorpus).some(value => (
        normalizeReaderNumericToken(value[0]) === numberToken
        && trailingUnit.test(citationStrippedCorpus.slice(value.index + (value.sourceLength || value[0].length)))
    ));
}

// 列头单位也是数值含义的一部分。只有单元格里出现数值、原文却没有对应单位时，
// 不能因数字相同就把比率显示成百分数，或把秒显示成毫秒。
function readerAdjacentMetricUnitEvidence(quote, metric, value, unit) {
    const surface = text => String(text || '').normalize('NFKC').toLowerCase()
        .replace(/[`*_↑↓]/g, '').replace(/\s+/g, ' ').trim();
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = surface(metric).split(/\s+/).map(escape).join('\\s+');
    if (!name) return false;
    const quantity = `${escape(value)}\\s*${escape(unit)}`;
    // Exact metric + same literal value/unit; no aliases, conversion, range
    // endpoint extraction, cross-clause borrowing or neighboring metric unit.
    const adjacent = new RegExp(`(?<![a-z0-9_.+−－–—/\\-])(?:${quantity}\\s+${name}|${name}(?![a-z0-9_])\\s*(?:(?:is|was|为|是|=|:)\\s*)?${quantity})(?![a-z0-9_%])`, 'i');
    return String(quote || '').normalize('NFKC')
        .split(/(?<!\d)[.!?;。！？；\n]|[.!?](?!\d)|[,，]/).some(clause => {
            const text = surface(clause);
            if (/\b(?:not|no|never|unavailable|unknown|missing)\b|未报告|未提供|不可得|未知|没有|并非|不是|未达到|不等于|不超过/.test(text)) return false;
            return adjacent.test(text);
        });
}

function readerTableHeaderUnitEvidenceFailures(table, sourceQuotes, options = {}) {
    const pdfColumns = [
        ...require('./reader-sealed-pdf-column-units').coverage(table, sourceQuotes),
        ...require('./reader-source-table-column-units').coverage(table, sourceQuotes)
    ];
    const quotes = sourceQuotes.map(item => typeof item === 'string' ? item : item?.quote)
        .filter(value => typeof value === 'string');
    const surface = value => String(value || '').normalize('NFKC').toLowerCase()
        .replace(/[`*_↑↓]/g, '').replace(/\s+/g, ' ').trim();
    const compact = value => surface(value).replace(/\s+/g, '');
    const zhSiUnitMap = {
        '毫秒': 'ms', '秒': 's', '小时': 'h', '赫兹': 'hz',
        '千赫兹': 'khz', '兆赫兹': 'mhz', '分贝': 'db', '百分比': '%'
    };
    const headerUnitPattern = '%|db|ms|khz|mhz|ghz|hz|gib|mib|kib|gb|mb|kb|tb|kbps|mbps|pp|s|h';
    const headerUnitRegex = new RegExp(
        `^(.*?)(?:\\(\\s*(${headerUnitPattern})\\s*\\)|\\[\\s*(${headerUnitPattern})\\s*\\]|\\s+(${headerUnitPattern}))$`,
        'i'
    );
    const findExplicitExtraUnitsForValue = (rawText, numericValueStr) => {
        const cleaned = surface(rawText).replace(/[\u2212\uFF0D]/g, '-');
        const units = new Set();
        const matcher = /(?<![a-z0-9_.])([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(gib|mib|kib|mb|kb|tb|ghz|kbps|mbps|h)(?![a-z0-9_])/gi;
        for (const m of cleaned.matchAll(matcher)) {
            if (normalizeReaderNumericToken(m[1]) === numericValueStr) {
                units.add(m[2].toLowerCase());
            }
        }
        return units;
    };
    const quoteCoversExplicitExtraUnit = (quote, numericValueStr, targetUnit) => {
        const target = String(targetUnit || '').toLowerCase();
        return String(quote || '').normalize('NFKC')
            .split(/(?<!\d)[.!?;。！？；\n]|[.!?](?!\d)|[,，]/).some(clause => {
                const text = surface(clause).replace(/[\u2212\uFF0D]/g, '-');
                if (/\b(?:not|no|never|unavailable|unknown|missing)\b|未报告|未提供|不可得|未知|没有|并非|不是|未达到|不等于|不超过/.test(text)) return false;
                return findExplicitExtraUnitsForValue(text, numericValueStr).has(target);
            });
    };
    const failures = [];
    for (let column = 0; column < (table?.header || []).length; column++) {
        const header = surface(table.header[column]);
        let match = header.match(headerUnitRegex);
        let mappedZhUnit = null;
        if (!match) {
            // 仅对含 ASCII 指标名的表头放行括号内中文 SI 单位（如 "Latency (毫秒)"），
            // 绝不把纯中文译名表头（如 "相对最强基线提升 (百分点)"）误判为未核验单位声明。
            const zhMatch = header.match(/^(.*?)(?:\(\s*(毫秒|秒|小时|赫兹|千赫兹|兆赫兹|分贝|百分比)\s*\)|\[\s*(毫秒|秒|小时|赫兹|千赫兹|兆赫兹|分贝|百分比)\s*\])$/u);
            if (zhMatch && /[a-z]/i.test(zhMatch[1])) {
                mappedZhUnit = zhSiUnitMap[zhMatch[2] || zhMatch[3]];
                match = zhMatch;
            }
        }
        if (!match) continue;
        // “多数模型 -10 dB”给的是列比较条件，不宣称该列的 WER 等数值都用 dB。
        // 必须是独立完整数量；C50、P95 等指标名中的数字不能成为此例外。
        const hasQuantityCondition = /(?:^|\s)[-+−－]?\d+(?:\.\d+)?\s*$/u.test(match[1]);
        if (hasQuantityCondition && (!mappedZhUnit && match[4]
            || /(?:^|\s)[-+−－]\d+(?:\.\d+)?\s*$/u.test(match[1]))) continue;
        const unit = (mappedZhUnit || match[2] || match[3] || match[4]).toLowerCase();
        const metric = compact(match[1]);
        const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const declaration = header.replace(/\s*([([])/g, ' $1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
        const declaredUnit = new RegExp(`(?<![a-z0-9_])${declaration}(?![a-z0-9_])`, 'g');
        const zhAsciiHeaderUnitRe = mappedZhUnit && surface(match[1])
            ? new RegExp(`(?<![a-z0-9_])${escapeRe(surface(match[1]))}\\s*[(\\[]\\s*${escapeRe(unit)}\\s*[)\\]]`, 'i')
            : null;
        for (let row = 0; row < (table.rows || []).length; row++) {
            const rawCell = table.rows[row]?.[column];
            const tokens = readerNumericTokens(rawCell);
            for (const token of tokens) {
                const number = token.match(/^([-+]?\d+(?:\.\d+)?)([a-z%]*)$/i);
                if (!number) continue;
                const explicitExtraCellUnits = !number[2]
                    ? findExplicitExtraUnitsForValue(rawCell, number[1])
                    : new Set();
                const unitConsistent = number[2]
                    ? number[2].toLowerCase() === unit
                    : (explicitExtraCellUnits.size === 0 || explicitExtraCellUnits.has(unit));
                // 单元格显式携带未纳入全局分词器的单位（如 MB/KB/h/GiB/MiB/KiB/TB/GHz/kbps/Mbps）时，
                // 不改全局 readerNumericTokens 集合，只在引文存在同值同单位正例证据时按显式单位放行。
                const coveredByExplicitCellUnit = !number[2]
                    && explicitExtraCellUnits.has(unit)
                    && quotes.some(quote => quoteCoversExplicitExtraUnit(quote, number[1], unit));
                // 已显式写单位的单元格继续由既有数字引文规则核验；这里不改变其 PDF 拆单位兼容。
                // 裸值只认可同句中指标单位声明后的第一个数值，不能跨句借另一方法或指标的单位；
                // 若表头为 ASCII 指标 + 括号中文 SI 单位（如 AvLS (毫秒)），则同时认可同一逐字原表引文中
                // 显式出现的同指标英文单位表头（如 AvLS (ms)）及其同引文内对应数值。
                const coveredByZhTableHeader = Boolean(zhAsciiHeaderUnitRe && quotes.some(quote => {
                    const qSurf = surface(quote);
                    return zhAsciiHeaderUnitRe.test(qSurf) && readerNumericTokens(qSurf).includes(token);
                }));
                const covered = unitConsistent && (Boolean(number[2]) || coveredByExplicitCellUnit || coveredByZhTableHeader || quotes.some(quote => readerAdjacentMetricUnitEvidence(quote, surface(match[1]), number[1], unit)) || (metric && quotes.some(quote => (
                    String(quote).normalize('NFKC').split(/(?<!\d)[.!?;。！？；\n]|[.!?](?!\d)/).some(sentence => {
                        const text = surface(sentence);
                        return [...text.matchAll(declaredUnit)].some(declared => {
                            const clause = text.slice(declared.index + declared[0].length)
                                .split(/\b(?:and|while|but|whereas)\b|[,，]/)[0];
                            if (/\b(?:not|no|never|unavailable|unknown|missing)\b|未报告|未提供|不可得|未知|没有/.test(clause)) return false;
                            return readerNumericTokens(clause)[0] === token;
                        });
                    })
                ))));
                if (!covered && !pdfColumns.some(item => item.row === row + 1 && item.column === column
                    && item.unit === unit && readerNumericTokens(item.value).includes(token)))
                    failures.push({ row: row + 1, column, token, unit });
            }
        }
    }
    if (!failures.length || options.authenticatedPdf === false) return failures;
    const authenticated = require('./reader-authenticated-pdf-table-evidence').coverage(table, sourceQuotes);
    return failures.filter(failure => !authenticated.some(item => item.row === failure.row
        && item.column === failure.column && item.unit === failure.unit && item.value === failure.token));
}

function deriveExactTableSourceQuotes(renderedMarkdown, sourceText, options = {}) {
    const allowSplitUnit = options.allowSplitUnit === true;
    // A bare integer in parentheses/brackets is ambiguous with a citation.
    // Do not automatically select it as evidence for a table count. Genuine
    // parenthetical measurements may still use explicitly declared exact
    // quotations or original DOM cells; neither channel is rewritten here.
    const text = String(sourceText);
    const sourceMatches = readerNumericTokenMatches(text).filter(match => {
        const token = String(match[0] || '').trim();
        const end = match.index + (match.sourceLength || match[0].length);
        // A numeric prefix of a commit/hash or other identifier is not a scalar.
        if (end < text.length && /^[A-Za-z0-9_]/u.test(text[end])) return false;
        // Walk back trailing whitespace in O(1) so `$`-anchored checks never scan 200KB prefixes.
        let bEnd = match.index;
        while (bEnd > 0 && /\s/u.test(text[bEnd - 1])) bEnd--;
        const beforeTail = text.slice(Math.max(0, bEnd - 32), bEnd);
        // Document locators and explicitly named protocol/version values are
        // not automatic evidence for measurements or counts in another table.
        if (/^\d+(?:\.\d+)*$/u.test(token)
            && /\b(?:Table|Figure|Fig\.|Section|Equation|Eq\.)$/iu.test(beforeTail)) return false;
        if (/^\d+(?:\.\d+)+$/u.test(token)) {
            let vEnd = bEnd;
            if (vEnd > 0 && (text[vEnd - 1] === 'v' || text[vEnd - 1] === 'V')) {
                vEnd--;
                while (vEnd > 0 && /\s/u.test(text[vEnd - 1])) vEnd--;
            }
            if (vEnd > 0 && (text[vEnd - 1] === ':' || text[vEnd - 1] === '=')) {
                vEnd--;
                while (vEnd > 0 && /\s/u.test(text[vEnd - 1])) vEnd--;
            }
            const versionTail = text.slice(Math.max(0, vEnd - 32), vEnd);
            if (/(?:\b(?:version|JSON[- ]RPC|protocol)|版本)$/iu.test(versionTail)) return false;
        }
        if (!/^\d+$/u.test(token)) return true;
        let aStart = end;
        while (aStart < text.length && /\s/u.test(text[aStart])) aStart++;
        const prevChar = bEnd > 0 ? text[bEnd - 1] : '';
        const nextChar = aStart < text.length ? text[aStart] : '';
        return !((prevChar === '(' && nextChar === ')') || (prevChar === '[' && nextChar === ']'));
    });
    const quotes = [];
    const addDirectUnitQuote = token => {
        const unitToken = String(token || '').match(
            /^([-+]?\d+(?:\.\d+)?)(db|ms|hz|khz|mhz|gb|mb|kb|pp|%|s|h)$/i
        );
        if (!unitToken) return;
        const units = {
            db: 'dB', ms: 'ms', hz: 'Hz', khz: 'kHz', mhz: 'MHz',
            gb: 'GB', mb: 'MB', kb: 'KB', pp: 'pp', s: 's', h: 'h'
        };
        const unit = units[unitToken[2].toLowerCase()] || unitToken[2];
        const pattern = new RegExp(
            `(?<![A-Za-z0-9.])${unitToken[1].replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`
            + `\\s*${unit}(?![A-Za-z0-9])`, 'i'
        );
        const match = pattern.exec(String(sourceText));
        if (!match || !Number.isInteger(match.index)) return;
        const quote = exactSourceExcerpt(sourceText, match.index, match[0].length);
        if (quote.length >= 12 && sourceText.includes(quote) && !quotes.includes(quote)
            && readerSourceQuoteCoversNumericToken(token, quote)) {
            quotes.push(quote);
        }
    };
    for (const token of [...new Set(readerNumericTokens(renderedMarkdown))]) {
        // 先查找同时包含数值和单位的原句，例如「1 kHz」；只查数字可能误中页眉日期。
        // 然后逐个查找数值；PDF 提取时拆开的单位是否可接受，仍由 allowSplitUnit 控制。
        addDirectUnitQuote(token);
        // 单个数值在原文找不到时，继续查找其他数值；不丢弃整张表已找到的引文。
        // 后续 missingNumbers 仍会报告缺少依据的数值，来源要求不变。
        const unitlessFallback = String(token).match(/^([-+]?\d+(?:\.\d+)?)(?:db|ms|hz|khz|mhz|gb|mb|kb|pp|%|s|h)$/i);
        for (const match of sourceMatches) {
            const exact = sourceNumericTokenExpansions(match[0]).has(token);
            const fallback = allowSplitUnit && unitlessFallback
                && normalizeReaderNumericToken(match[0])
                    === normalizeReaderNumericToken(unitlessFallback[1]);
            if (!exact && !fallback) continue;
            if (!Number.isInteger(match.index)) continue;
            const quote = exactSourceExcerpt(
                sourceText, match.index, match.sourceLength || match[0].length
            );
            if (quote.length < 12 || !sourceText.includes(quote)) continue;
            if (!quotes.includes(quote)) quotes.push(quote);
            break;
        }
    }
    // 数字复现通常取每个标量在原文里第一次出现的位置。对一段有意义的重复向量来说这不够：
    // 每个标量都可能更早出现过，而真正体现顺序和重数的证据在后面。这里只追加一段绑定
    // SHA 的精确摘录，其归一化后的完整向量序列与渲染出的向量相符，省略号和重复也算在内。
    const sourceVectorsBySequence = new Map();
    for (const vector of bracketedNumericVectors(sourceText)) {
        if (!sourceVectorsBySequence.has(vector.sequence)) {
            sourceVectorsBySequence.set(vector.sequence, vector);
        }
    }
    for (const renderedVector of bracketedNumericVectors(renderedMarkdown)) {
        const sourceVector = sourceVectorsBySequence.get(renderedVector.sequence);
        if (!sourceVector || !Number.isInteger(sourceVector.index)) continue;
        const quote = exactSourceExcerpt(
            sourceText, sourceVector.index, sourceVector.length
        );
        if (quote.length >= 12 && sourceText.includes(quote) && !quotes.includes(quote)) {
            quotes.push(quote);
        }
    }
    return quotes;
}

function rehydrateWhitespaceEquivalentSourceQuote(rawQuote, sourceText) {
    if (typeof rawQuote !== 'string' || rawQuote.length < 12 || rawQuote.length > 4000
        || typeof sourceText !== 'string') return null;
    if (sourceText.includes(rawQuote)) return rawQuote;
    const parts = rawQuote.trim().split(/\s+/u).filter(Boolean);
    if (parts.length < 2) return null;
    const pattern = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const match = new RegExp(pattern, 'u').exec(sourceText);
    if (!match || match[0].length < 12 || match[0].length > 4000) return null;
    return match[0];
}

// 仅把已经逐字存在的完整引文恢复为原文空白，先去除无须模型改写的格式诊断。
// 不补词、不改数字或单位，不缩短引文；原始付费响应与封存来源均不改动。
function normalizeReaderSourceQuoteWhitespace(candidate, sourceText) {
    if (!candidate || !Array.isArray(candidate.tableBindings) || typeof sourceText !== 'string') return null;
    const beforeDraftSha256 = stableFingerprint(candidate);
    const quotes = [];
    for (const [bindingIndex, binding] of candidate.tableBindings.entries()) {
        if (binding?.sourceType !== 'source_quotes' || !Array.isArray(binding.sourceQuotes)) continue;
        binding.sourceQuotes = binding.sourceQuotes.map((quote, quoteIndex) => {
            const exact = rehydrateWhitespaceEquivalentSourceQuote(quote, sourceText);
            if (exact === null || exact === quote) return quote;
            quotes.push({ bindingIndex, quoteIndex, beforeSha256: stableFingerprint(quote), afterSha256: stableFingerprint(exact) });
            return exact;
        });
    }
    if (quotes.length === 0) return null;
    return { contract: 'reader-source-quote-whitespace-v1', changed: true,
        sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        beforeDraftSha256, afterDraftSha256: stableFingerprint(candidate), quotes };
}

function resolvedDeclaredSourceQuotes(binding, sourceText, allowWhitespaceRepair) {
    if (!Array.isArray(binding?.sourceQuotes)) return [];
    return [...new Set(binding.sourceQuotes.flatMap(quote => {
        if (typeof quote !== 'string' || quote.length < 12 || quote.length > 4000) return [];
        if (sourceText.includes(quote)) return [quote];
        if (!allowWhitespaceRepair) return [];
        const repaired = rehydrateWhitespaceEquivalentSourceQuote(quote, sourceText);
        return repaired ? [repaired] : [];
    }))];
}

// 引文绑定失败时，下一轮修复需要知道原文到底怎么写。按词重合度在全文里找
// 最接近的整句，只作为反馈证据，不参与通过判定，也不改写引文。
function readerClosestSourcePassage(quote, sourceText, limit = 260) {
    const text = String(sourceText || '');
    const value = String(quote || '').trim();
    if (!text || value.length < 12) return '';
    const words = new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    if (words.size === 0) return '';
    // 小数点和缩写会骗过朴素的标点切句（9.29.2% 会在 9. 处断开），
    // 用 Intl.Segmenter 的整句切分；不可用时退回按句末标点切分。
    const sentences = [];
    try {
        const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
        for (const item of segmenter.segment(text)) sentences.push(item.segment);
    } catch (_error) {
        for (const match of text.matchAll(/[^.!?。！？\n]+[.!?。！？]?/g)) sentences.push(match[0]);
    }
    let best = null;
    for (const raw of sentences) {
        const sentence = raw.trim();
        if (!sentence) continue;
        const sentenceWords = new Set(sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
        let shared = 0;
        for (const word of words) if (sentenceWords.has(word)) shared += 1;
        const score = shared / words.size;
        if (!best || score > best.score) best = { score, sentence };
    }
    if (!best || best.score < 0.6) return '';
    return best.sentence.length <= limit ? best.sentence : `${best.sentence.slice(0, limit - 1)}…`;
}

function readerExactQuoteFailureDetail(binding, sourceText) {
    const invalid = (Array.isArray(binding?.sourceQuotes) ? binding.sourceQuotes : [])
        .map((quote, quoteIndex) => ({ quote, quoteIndex }))
        .filter(({ quote }) => !(typeof quote === 'string' && quote.length >= 12
            && quote.length <= 4000 && String(sourceText).includes(quote)));
    // 反馈历史上限 3000 字符；只点名前 8 项，避免一次坏稿把其他修复信息挤掉。
    const details = invalid.slice(0, 8).map(({ quote, quoteIndex }) => {
        const passage = readerClosestSourcePassage(quote, sourceText);
        return `sourceQuotes[${quoteIndex}]` + (passage
            ? ` 的原文原句是“${passage}”` : ' 在全文找不到接近的连续原句');
    });
    if (invalid.length > details.length) details.push(`另有 ${invalid.length - details.length} 项不是原文连续原句`);
    return details.length ? `：${details.join('；')}` : '';
}

// PDF quotations remain a separate input channel. Only the program may turn
// them into saved evidence, using the actual four-file source scope.
function resolvedDeclaredPdfSourceQuotes(binding) {
    if (!Object.prototype.hasOwnProperty.call(binding || {}, 'pdfSourceQuotes')) return [];
    if (binding.sourceType !== 'source_quotes' || !Array.isArray(binding.pdfSourceQuotes)
        || binding.pdfSourceQuotes.length > 64 || binding.pdfSourceQuotes.some(quote => (
            typeof quote !== 'string' || quote.length < 12 || quote.length > 4000
        ))) throw new Error('Reader pdfSourceQuotes 必须是独立 PDF 连续逐字引文数组');
    if (!binding.pdfSourceQuotes.length) return [];
    return require('./reader-sealed-pdf-quote-evidence').evidenceForQuotes(binding.pdfSourceQuotes);
}

function readerSourceQuotesCoverNumericToken(token, htmlQuotes, pdfQuotes, allowHtmlSplitUnit = false) {
    const text = item => typeof item === 'string' ? item : item?.quote;
    // Preserve the historical HTML/conference channel. PDF proof never joins
    // another quotation to invent a value-unit pair at a fragment boundary.
    return readerSourceQuoteCoversNumericToken(token, htmlQuotes.map(text).join('\n'), allowHtmlSplitUnit)
        || pdfQuotes.some(item => readerSourceQuoteCoversNumericToken(token, text(item), false));
}

function withReaderSourceQuoteEvidence(artifacts, paperId, callback) {
    const actualPaperId = paperId || artifacts?.paperId
        || require('./fresh-analysis-context').getFreshAnalysisContext()?.paperId;
    if (!/^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?$/i.test(actualPaperId || '')) {
        return callback();
    }
    return require('./reader-sealed-pdf-quote-evidence').withArtifacts(artifacts, actualPaperId, callback);
}

function pruneUnsupportedSourceQuoteTable(rendered, quoteCorpus, scientificQuotes) {
    const rows = [rendered?.header, ...(rendered?.rows || [])];
    if (!Array.isArray(rows[0]) || rows.length < 2) return null;
    // Scientific atoms retain each original quote boundary. Ordinary scalars
    // keep the existing HTML-joined/PDF-per-quote corpus and unit behavior.
    const projection = readerScientificQuoteProjection(rendered, scientificQuotes);
    // Bad scientific quantities must reach the normal source failure/repair
    // path intact. Deleting that row cannot turn an invalid draft into success.
    if (projection.failures.length) return null;
    const supported = new Set(Array.isArray(quoteCorpus)
        ? quoteCorpus.flatMap(quote => readerNumericTokens(quote)) : readerNumericTokens(quoteCorpus));
    const missingByCell = rows.map((row, r) => row.map((_cell, c) => (
        [...new Set(projection.cells.find(cell => cell.row === r && cell.column === c).tokens)]
            .filter(token => !supported.has(token))
    )));
    if (!missingByCell.some(row => row.some(tokens => tokens.length > 0))) return null;
    const width = rows[0].length;
    if (width < 2 || rows.some(row => row.length !== width)) return null;
    const line = cells => `| ${cells.join(' | ')} |`;
    const headerSupported = missingByCell[0].every(tokens => tokens.length === 0);
    const fullySupportedDataRows = rows.slice(1).filter((_row, index) => (
        missingByCell[index + 1].every(tokens => tokens.length === 0)
    ));
    // 只要还有至少一行完整、绑定证据的数据，就保住这张表的比较结构。否则按列先剪会把
    // 所有指标列和结果列都删掉——只因为另外几行含有无支撑的值，最后宽表只剩标签。这条
    // 路径仍要求严格核验：留下的表头和数据行里，每个数字 token 都能在原文引文里找到。
    if (headerSupported && fullySupportedDataRows.length > 0) {
        const markdown = [
            line(rows[0]),
            line(rows[0].map(() => '---')),
            ...fullySupportedDataRows.map(line)
        ].join('\n');
        if (markdown !== rendered.markdown) return markdown;
    }
    const badColumns = new Set();
    for (let column = 0; column < width; column += 1) {
        const affectedRows = missingByCell.reduce(
            (count, row) => count + (row[column]?.length ? 1 : 0), 0
        );
        if (missingByCell[0][column]?.length || affectedRows >= 2) badColumns.add(column);
    }
    if (width - badColumns.size < 2) badColumns.clear();
    const keptColumns = Array.from({ length: width }, (_, index) => index)
        .filter(index => !badColumns.has(index));
    const retained = rows.map((row, rowIndex) => ({
        cells: keptColumns.map(column => row[column]),
        missing: keptColumns.some(column => missingByCell[rowIndex][column]?.length)
    }));
    const header = retained[0];
    if (header.missing) return null;
    const dataRows = retained.slice(1).filter(row => !row.missing);
    if (dataRows.length < 1) return null;
    const markdown = [
        line(header.cells),
        line(header.cells.map(() => '---')),
        ...dataRows.map(row => line(row.cells))
    ].join('\n');
    return markdown !== rendered.markdown ? markdown : null;
}

function artifactCellDisplayMatches(sourceTable, sourceRow, sourceColumn, renderedText) {
    if (require('./reader-table-pdf-evidence').displayCellMatches(
        sourceTable, sourceRow, sourceColumn, renderedText, normalizeReaderSourceCell
    )) return true;
    const readerTables = require('./reader-tables');
    const projected = readerTables.readerTableCellDisplay(sourceTable, sourceRow, sourceColumn);
    const unescaped = readerTables.unescapeMarkdownTableCell(renderedText);
    return normalizeReaderSourceCell(renderedText) === normalizeReaderSourceCell(projected)
        || (unescaped !== renderedText
            && normalizeReaderSourceCell(unescaped) === normalizeReaderSourceCell(projected));
}

function artifactTableBindingCanReplay(binding, renderedRows, structuredArtifacts) {
    const sourceTable = (structuredArtifacts.tables || []).find(item => (
        item?.ordinal === binding?.sourceTableOrdinal && item?.recoveryStatus === 'complete'
    ));
    const expectedCount = renderedRows.reduce((sum, row) => sum + row.length, 0);
    if (!sourceTable || !recoverySha256(sourceTable.sourceDomSha256)
        || !Array.isArray(binding?.cellBindings)
        || binding.cellBindings.length !== expectedCount) return false;
    const seen = new Set();
    return binding.cellBindings.every(cellBinding => {
        const renderedText = renderedRows?.[cellBinding?.renderedRow]?.[cellBinding?.renderedColumn];
        const key = `${cellBinding?.renderedRow}:${cellBinding?.renderedColumn}`;
        const sourceCell = findStructuredTableCell(
            sourceTable, cellBinding?.sourceRow, cellBinding?.sourceColumn
        );
        if (renderedText === undefined || seen.has(key) || !sourceCell
            || !recoverySha256(sourceCell.sourceDomSha256)
            || !artifactCellDisplayMatches(
                sourceTable, cellBinding.sourceRow, cellBinding.sourceColumn, renderedText)) return false;
        seen.add(key);
        return true;
    }) && seen.size === expectedCount;
}

function exactObjectInOrder(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length
        || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return null;
    return Object.fromEntries(keys.map(key => [key, value[key]]));
}

/**
 * 早期历史 arXiv 来源包里的 payload SHA 是按解析器的 schema 顺序算的，而它们的
 * 持久化 JSON 写入器会递归排序对象键。JSON 成员顺序本身没有语义，但因此重新加载
 * 之后直接用 JSON.stringify() 复现就对不上。这里只重建公开 v4 schema 的顺序；出现
 * 未知字段、缺失字段，或者任何一个值变了，仍过不了声明的 SHA 闸门。
 */
function replayPersistedArxivHtmlDomV4PayloadSha(structuredArtifacts, returnPayload = false) {
    if (structuredArtifacts?.parserVersion !== 'arxiv-html-dom-v4') return '';
    const artifact = exactObjectInOrder(structuredArtifacts, [
        'version', 'parserVersion', 'sourceKind', 'sourceId', 'paperId',
        'sourceHtmlSha256', 'tables', 'formulas', 'figures', 'references',
        'health', 'flattenedTextSha256', 'payloadSha256'
    ]);
    if (!artifact || !Array.isArray(artifact.tables) || !Array.isArray(artifact.formulas)
        || !Array.isArray(artifact.figures) || !Array.isArray(artifact.references)) return '';
    const tables = artifact.tables.map(table => {
        const ordered = exactObjectInOrder(table, [
            'ordinal', 'label', 'caption', 'sourceDomSha256', 'headerRows',
            'bodyRows', 'cells', 'matrix', 'recoveryStatus'
        ]);
        if (!ordered || !Array.isArray(ordered.cells)) return null;
        const cells = ordered.cells.map(cell => exactObjectInOrder(cell, [
            'row', 'column', 'header', 'rowspan', 'colspan', 'text', 'sourceDomSha256'
        ]));
        return cells.some(cell => !cell) ? null : { ...ordered, cells };
    });
    const formulas = artifact.formulas.map(formula => exactObjectInOrder(formula, [
        'ordinal', 'label', 'latex', 'mathml', 'text', 'sourceDomSha256', 'recoveryStatus'
    ]));
    const figures = artifact.figures.map(figure => {
        const ordered = exactObjectInOrder(figure, [
            'ordinal', 'label', 'caption', 'images', 'sourceDomSha256', 'recoveryStatus'
        ]);
        if (!ordered || !Array.isArray(ordered.images)) return null;
        const images = ordered.images.map(image => {
            const optional = image?.kind === 'inline_svg'
                ? ['inlineSvg', 'inlineSvgBytes', 'inlineSvgSha256']
                : image?.kind === 'inline_html'
                    ? ['inlineHtml', 'inlineHtmlBytes', 'inlineHtmlSha256'] : [];
            return exactObjectInOrder(image, [
                'kind', 'url', 'alt', 'mediaType', 'rasterDownloadEligible', ...optional
            ]);
        });
        return images.some(image => !image) ? null : { ...ordered, images };
    });
    const references = artifact.references.map(reference => exactObjectInOrder(reference, [
        'ordinal', 'label', 'text', 'hrefs', 'sourceDomSha256'
    ]));
    const health = exactObjectInOrder(artifact.health, [
        'status', 'detected', 'recovered', 'truncated', 'issues'
    ]);
    if (tables.some(item => !item) || formulas.some(item => !item)
        || figures.some(item => !item) || references.some(item => !item) || !health) return '';
    const detected = exactObjectInOrder(health.detected, [
        'tables', 'formulas', 'figures', 'references', 'bibliographies'
    ]);
    const recovered = exactObjectInOrder(health.recovered, [
        'tables', 'formulas', 'figures', 'references'
    ]);
    if (!detected || !recovered) return '';
    const body = {
        version: artifact.version,
        parserVersion: artifact.parserVersion,
        sourceKind: artifact.sourceKind,
        sourceId: artifact.sourceId,
        paperId: artifact.paperId,
        sourceHtmlSha256: artifact.sourceHtmlSha256,
        tables,
        formulas,
        figures,
        references,
        health: { ...health, detected, recovered },
        flattenedTextSha256: artifact.flattenedTextSha256
    };
    const payload = JSON.stringify(body);
    return returnPayload ? payload : crypto.createHash('sha256').update(payload).digest('hex');
}

function replayPersistedUnstructuredArxivPayloadSha(structuredArtifacts, returnPayload = false) {
    const artifact = exactObjectInOrder(structuredArtifacts, [
        'version', 'source', 'tables', 'formulas', 'figures',
        'flattenedTextSha256', 'payloadSha256'
    ]);
    if (!artifact || artifact.source !== 'fresh_arxiv_text_without_layout'
        || !Array.isArray(artifact.tables) || artifact.tables.length !== 0
        || !Array.isArray(artifact.formulas) || artifact.formulas.length !== 0
        || !Array.isArray(artifact.figures) || artifact.figures.length !== 0) return '';
    const body = {
        version: artifact.version,
        source: artifact.source,
        tables: artifact.tables,
        formulas: artifact.formulas,
        figures: artifact.figures,
        flattenedTextSha256: artifact.flattenedTextSha256
    };
    const payload = JSON.stringify(body);
    return returnPayload ? payload : crypto.createHash('sha256').update(payload).digest('hex');
}

// 展示公式必须重核完整结构化来源，不能用输出自身的哈希代替原始 TeX。
function readerFormulaNeedsSourcePayload(latex) {
    return Boolean(String(latex || '').trim());
}
function readerStructuredSourcePayload(artifacts) {
    const { payloadSha256, ...body } = artifacts;
    const ordered = value => Array.isArray(value) ? value.map(ordered)
        : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    const candidates = [JSON.stringify(ordered(body)), JSON.stringify(body),
        replayPersistedArxivHtmlDomV4PayloadSha(artifacts, true),
        replayPersistedUnstructuredArxivPayloadSha(artifacts, true)];
    const payload = candidates.find(value => value && crypto.createHash('sha256').update(value).digest('hex') === payloadSha256);
    if (!payload) throw new Error('展示公式的完整结构化来源内容不能重放既有来源 SHA；请通过正常长文恢复入口重建');
    return payload;
}
function readerSourcePayloadArtifacts(payload, structuredSha, sourceSha) {
    if (typeof payload !== 'string' || !recoverySha256(structuredSha) || !recoverySha256(sourceSha)
        || crypto.createHash('sha256').update(payload).digest('hex') !== structuredSha) return null;
    let artifacts;
    try { artifacts = JSON.parse(payload); } catch { return null; }
    return artifacts && typeof artifacts === 'object' && !Array.isArray(artifacts)
        && artifacts.flattenedTextSha256 === sourceSha ? artifacts : null;
}
function readerFormulaSourcePayloadValid(binding, payload, structuredSha, sourceSha) {
    const artifacts = readerSourcePayloadArtifacts(payload, structuredSha, sourceSha);
    if (!Array.isArray(artifacts?.formulas)) return false;
    const formulas = artifacts.formulas.filter(formula => formula?.ordinal === binding.formulaOrdinal);
    return formulas.length === 1 && assessReaderFormulaEligibility(formulas[0]).eligible
        && formulas[0].sourceDomSha256 === binding.sourceDomSha256
        && typeof formulas[0].latex === 'string' && formulas[0].latex.trim() === binding.latex.trim();
}

// 旧窄表修复曾把未知 validation set 写成 TidyVoice。只重核这一个确切旧表形状，
// 并要求原引文直接说明数据集与验证集的关系，不能拿另一个句子的同名数据集补证据。
function readerLegacyDatasetQuoteSupportsClaim(quote) {
    // 汉字可以直接引出说明；其余字母、组合字符、数字与连字符仍属于名称。
    // 先屏蔽更长的数据集名，避免 JS 与 Python 的 \b 对 Unicode 字符解释不同。
    const extendsName = character => character && !/[\u3400-\u9fff]/u.test(character)
        && /[\p{L}\p{M}\p{N}_-]/u.test(character);
    const normalized = String(quote || '').normalize('NFKC').replace(/TidyVoice/gi, (name, offset, text) => {
        const before = [...text.slice(0, offset)].pop() || '';
        const after = [...text.slice(offset + name.length)][0] || '';
        return extendsName(before) || extendsName(after) ? '其他数据集' : name;
    });
    return normalized.split(/[。！？.!?;；\n]+/).some(sentence => {
        if (/\b(?:not|no|never|neither|without|except|rather than)\b|不是|并非|不属于|并不|未用|未使用/i.test(sentence)) return false;
        return /TidyVoice(?:['’]s)?\s+(?:validation|development)\s+(?:set|split|partition)\b/i.test(sentence)
            || /\b(?:validation|development)\s+(?:set|split|partition)\s+(?:(?:is|was)\s+)?(?:from|of|for)\s+TidyVoice/i.test(sentence)
            || /\b(?:validation|development)\s+(?:set|split|partition)\s+(?:is|was|=)\s+TidyVoice/i.test(sentence)
            || /TidyVoice\s*(?:的\s*)?验证(?:集|集合)/i.test(sentence)
            || /验证(?:集|集合)\s*(?:来自|取自|使用|采用|为|是)\s*TidyVoice/i.test(sentence);
    });
}
function readerLegacyDatasetClaimsValid(article, tableBindings) {
    const tables = extractMarkdownTables(article);
    return tables.every((table, index) => {
        const header = table.header.map(cell => String(cell).trim());
        const oldShape = JSON.stringify(header) === JSON.stringify(['策略', '数据集', '评测任务', 'EER (%)', '运行条件']);
        if (!oldShape || !table.rows.some(row => String(row[1]).trim() === 'TidyVoice'
            && String(row[2]).trim() === 'validation set')) return true;
        const binding = tableBindings?.[index];
        if (binding?.sourceType !== 'source_quotes') return true; // 原表单元仍由 DOM 绑定逐格核验。
        return Array.isArray(binding.sourceQuotes) && binding.sourceQuotes.some(item => (
            readerLegacyDatasetQuoteSupportsClaim(typeof item === 'string' ? item : item?.quote)
        ));
    });
}

function assessReaderFormulaEligibility(formula) {
    const latex = String(formula?.latex || '').trim();
    if (formula?.recoveryStatus !== 'complete' || !latex) return { eligible: false, reason: '原始公式缺少完整 TeX' };
    if (/=\s*[-+−]?\s*$/.test(latex)) return { eligible: false, reason: '原始 TeX 在等号后截断' };
    if (/\(\s*$/.test(latex)) return { eligible: false, reason: '原始 TeX 在左圆括号后截断，只有跨行公式的前半段' };
    const inlineMath = /<math\b[^>]*\bdisplay\s*=\s*["']inline["']/i.test(String(formula.mathml || ''));
    const textHasRelation = /[=≤≥≠≈∝↦→]/.test(String(formula.text || ''));
    const latexHasRelation = /[=<>≤≥≠≈∝↦→]|\\(?:leq?|geq?|neq?|approx|sim|propto|mapsto|to)(?![A-Za-z])/.test(latex);
    if (inlineMath && textHasRelation && !latexHasRelation) {
        return { eligible: false, reason: '原始 TeX 只恢复了行内片段，未包含原文完整等式关系' };
    }
    return { eligible: true };
}

function bindApiReaderSourceEvidence(article, declaredTableBindings, declaredFormulaBindings, options = {}) {
    let structuredArtifacts = options.structuredArtifacts;
    const sourceText = String(options.sourceText || '');
    const pdfQuoteEvidenceCache = new Map();
    const pdfQuotesFor = binding => {
        if (!pdfQuoteEvidenceCache.has(binding)) {
            pdfQuoteEvidenceCache.set(binding, resolvedDeclaredPdfSourceQuotes(binding));
        }
        return pdfQuoteEvidenceCache.get(binding);
    };
    if (!structuredArtifacts || typeof structuredArtifacts !== 'object') {
        throw new Error('Reader source-binding v4 需要 structuredArtifacts');
    }
    if (!sourceText || !recoverySha256(structuredArtifacts.payloadSha256)) {
        throw new Error('Reader source-binding v4 需要已绑定全文和 structuredArtifacts payload SHA');
    }
    const deriveReaderSourceQuotes = renderedMarkdown => deriveExactTableSourceQuotes(
        renderedMarkdown, sourceText,
        { allowSplitUnit: structuredArtifacts.sourceKind === 'conference_pdf' }
    );
    const tableQuoteSelections = new WeakMap();
    const quotesForTable = (binding, rendered) => {
        let byMarkdown = tableQuoteSelections.get(binding);
        if (!byMarkdown) tableQuoteSelections.set(binding, byMarkdown = new Map());
        if (byMarkdown.has(rendered.markdown)) return byMarkdown.get(rendered.markdown);
        const validDeclaredQuotes = resolvedDeclaredSourceQuotes(
            binding, sourceText, options.allowDeterministicQuoteRepair === true
        );
        const pdfQuotes = pdfQuotesFor(binding);
        const scientific = readerScientificQuoteProjection(rendered, [...validDeclaredQuotes, ...pdfQuotes]);
        // An extra exact substring can name another PDF table and make an
        // already complete column mapping ambiguous. Repair missing evidence
        // only after the original quotes pass the same numeric/unit gates.
        const completeDeclared = validDeclaredQuotes.length === binding.sourceQuotes.length
            && validDeclaredQuotes.length + pdfQuotes.length > 0
            && scientific.failures.length === 0
            && scientific.tokens.every(token =>
                readerSourceQuotesCoverNumericToken(token, validDeclaredQuotes, pdfQuotes,
                    structuredArtifacts.sourceKind === 'conference_pdf'))
            && readerTableHeaderUnitEvidenceFailures(rendered,
                [...validDeclaredQuotes, ...pdfQuotes]).length === 0;
        const repairedQuotes = options.allowDeterministicQuoteRepair === true && !completeDeclared
            ? deriveReaderSourceQuotes(rendered.markdown) : [];
        const result = { htmlQuotes: [...new Set([...validDeclaredQuotes, ...repairedQuotes])], pdfQuotes };
        byMarkdown.set(rendered.markdown, result);
        return result;
    };
    const { payloadSha256: declaredArtifactsSha256, ...artifactBody } = structuredArtifacts;
    const replayedArtifactsSha256 = stableFingerprint(artifactBody);
    const sourceTextSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    const persistedParserOrderSha256 = replayPersistedArxivHtmlDomV4PayloadSha(
        structuredArtifacts
    ) || replayPersistedUnstructuredArxivPayloadSha(structuredArtifacts);
    const sealedLayoutlessText = structuredArtifacts.version === 1
        && (structuredArtifacts.source === 'fresh_arxiv_text_without_layout'
            || structuredArtifacts.source === 'direct_conference_pdf_text'
            || (structuredArtifacts.source === 'conference_pdf_weak_text'
                && structuredArtifacts.capabilityProfile === 'weak-text-only-v1'))
        && ['tables', 'formulas', 'figures'].every(key => (
            Array.isArray(structuredArtifacts[key]) && structuredArtifacts[key].length === 0
        ));
    if ((declaredArtifactsSha256 !== replayedArtifactsSha256
            && declaredArtifactsSha256 !== persistedParserOrderSha256
            && !sealedLayoutlessText)
        || structuredArtifacts.flattenedTextSha256 !== sourceTextSha256) {
        throw new Error('Reader source-binding v4 的 structuredArtifacts/fulltext SHA 无法重放');
    }
    // v4 早期 sealed runtime 以 JSON.stringify() 签名，文件原子写入会重排
    // object keys，导致同一经 source-manifest 绑定的 artifact 无法重放。全文
    // SHA 已精确匹配时，仅在内存中重新签为稳定指纹；sealed 文件不被改写。
    if (declaredArtifactsSha256 !== replayedArtifactsSha256) {
        if (!recoverySha256(declaredArtifactsSha256)
            || (!String(structuredArtifacts.parserVersion || '').trim() && !sealedLayoutlessText)) {
            throw new Error('Reader source-binding v4 的 structuredArtifacts/fulltext SHA 无法重放');
        }
        // 已核验的 runtime 对象要保持字节一致。每日来源清单认证的是它旧格式的 payload
        // SHA，而这次调用只需要一个稳定的内存证明来做确定性复现。改动调用方传进来的
        // 对象，会让后面的 Reader 阶段记下稳定 SHA，sourceAcquisition 却仍记着核验过的
        // 旧 SHA。
        structuredArtifacts = {
            ...structuredArtifacts,
            payloadSha256: replayedArtifactsSha256
        };
    }
    if (!Array.isArray(declaredFormulaBindings) || !Array.isArray(declaredTableBindings)) {
        throw new Error('Reader source-binding v4 要求 tableBindings/formulaBindings 数组');
    }

    if (String(article || '').includes('原文中没有可逐字绑定的数值证据')) {
        throw new Error('Reader source-binding v4 正文含内部绑定失败占位；必须修复证据与表格，不得把绑定失败写成原文缺失');
    }
    let boundArticle = normalizeApiReaderTablePasteArtifacts(
        normalizeKnownReaderDuplicateRows(String(article || ''), options.arxivId),
        declaredTableBindings
    );
    const formulaOrdinals = new Set();
    const formulaBindings = declaredFormulaBindings.map((binding, index) => {
        assertExactObjectKeys(
            binding, ['formulaOrdinal', 'targetKind', 'marker'],
            `读者文章 formulaBindings[${index}]`
        );
        const formula = (structuredArtifacts.formulas || []).find(item => (
            item?.ordinal === binding.formulaOrdinal && item?.recoveryStatus === 'complete'
        ));
        const marker = String(binding.marker || '').trim();
        if (!formula || !Number.isInteger(binding.formulaOrdinal)
            || formulaOrdinals.has(binding.formulaOrdinal)
            || marker !== `[[FORMULA_${binding.formulaOrdinal}]]`
            || !API_READER_KINDS.includes(binding.targetKind)) {
            throw new Error(`读者文章 formulaBindings[${index}] 来源或 marker 非法`);
        }
        const markerMatches = boundArticle.split(marker).length - 1;
        const markerBlock = boundArticle.split(/\n\s*\n/).some(block => block.trim() === marker);
        const targetSection = (options.sections || []).find(section => (
            section?.kind === binding.targetKind
            && String(section.body || '').split(/\n\s*\n/).some(block => block.trim() === marker)
        ));
        if (markerMatches !== 1 || !markerBlock || !targetSection) {
            throw new Error(`读者文章 formulaBindings[${index}] marker 必须在正文独占且仅出现一次`);
        }
        const latex = String(formula.latex || '').trim();
        const eligibility = assessReaderFormulaEligibility(formula);
        if (!eligibility.eligible) {
            throw new Error(`读者文章 formulaBindings[${index}] ${eligibility.reason}；不能猜补公式，请删除该公式绑定及 marker，依据完整原文解释其含义`);
        }
        if (!latex || !recoverySha256(formula.sourceDomSha256)) {
            throw new Error(`读者文章 formulaBindings[${index}] 原始公式缺少 TeX/DOM SHA`);
        }
        const renderedBlock = `\\[${latex}\\]`;
        boundArticle = boundArticle.replace(marker, () => renderedBlock);
        formulaOrdinals.add(binding.formulaOrdinal);
        return {
            formulaOrdinal: binding.formulaOrdinal,
            targetKind: binding.targetKind,
            marker,
            latex,
            sourceDomSha256: formula.sourceDomSha256,
            renderedBlockSha256: crypto.createHash('sha256').update(renderedBlock).digest('hex')
        };
    });

    if (/\[\[FORMULA_\d+\]\]/.test(boundArticle)) {
        throw new Error('Reader source-binding v4 formulaBindings 未覆盖正文公式占位符');
    }

    // 绝不要用读者能看到的诊断文字替代无支撑的表格单元。下面那些精确的单元/引文闸门会
    // 抛错，交给现有的 Reader 修复循环。
    let renderedTables = extractMarkdownTables(boundArticle);
    const renderedFormulaBlocks = require('../analysis-engine.js').extractVisibleDisplayFormulaBlocks(boundArticle);
    if (renderedFormulaBlocks.length !== formulaBindings.length
        || formulaBindings.some(binding => (
            renderedFormulaBlocks.filter(block => (
                crypto.createHash('sha256').update(block).digest('hex')
                    === binding.renderedBlockSha256
            )).length !== 1
        ))) {
        throw new Error('Reader source-binding v4 检测到未绑定、重复或被改写的展示公式');
    }
    const tablePruningDiagnostics = [];
    if (options.allowDeterministicUnsupportedClaimPruning === true) {
        for (let index = 0; index < renderedTables.length; index += 1) {
            const declared = declaredTableBindings[index];
            const binding = declared || (options.allowDeterministicQuoteRepair === true ? {
                sourceType: 'source_quotes',
                sourceQuotes: deriveReaderSourceQuotes(renderedTables[index].markdown)
            } : null);
            if (binding?.sourceType !== 'source_quotes' || !Array.isArray(binding.sourceQuotes)) continue;
            const selected = quotesForTable(binding, renderedTables[index]);
            const pdfQuotes = selected.pdfQuotes.map(item => item.quote);
            const htmlQuotes = selected.htmlQuotes;
            const pruned = pruneUnsupportedSourceQuoteTable(
                renderedTables[index], pdfQuotes.length
                    ? [htmlQuotes.join('\n'), ...pdfQuotes] : htmlQuotes.join('\n'),
                [...htmlQuotes, ...selected.pdfQuotes]
            );
            if (!pruned || boundArticle.split(renderedTables[index].markdown).length !== 2) continue;
            const after = extractMarkdownTables(pruned)[0];
            if (after && after.header.length < renderedTables[index].header.length) {
                tablePruningDiagnostics.push({ bindingIndex: index,
                    originalColumnCount: renderedTables[index].header.length,
                    renderedColumnCount: after.header.length,
                    removedHeaders: renderedTables[index].header.filter(header => !after.header.includes(header)),
                    reason: 'source_quote_unsupported_columns' });
            }
            boundArticle = boundArticle.replace(renderedTables[index].markdown, () => pruned);
        }
        renderedTables = extractMarkdownTables(boundArticle);
    }
    const effectiveTableBindings = declaredTableBindings.slice(0, renderedTables.length);
    if (options.allowDeterministicQuoteRepair === true
        && effectiveTableBindings.length < renderedTables.length) {
        for (let index = effectiveTableBindings.length; index < renderedTables.length; index++) {
            const derived = deriveReaderSourceQuotes(renderedTables[index].markdown);
            if (derived.length === 0) break;
            effectiveTableBindings.push({
                tableIndex: index + 1,
                sourceType: 'source_quotes',
                sourceTableOrdinal: null,
                cellBindings: [],
                sourceQuotes: derived
            });
        }
    }
    if (effectiveTableBindings.length !== renderedTables.length) {
        throw new Error(
            `Reader source-binding v4 表格绑定数量 ${effectiveTableBindings.length}`
            + ` 与正文表格数量 ${renderedTables.length} 不一致`
        );
    }
    // 一次解析就把所有格式本来没问题、只是缺数字证据的 source-quote 表格都暴露出来。
    // 修复协议一次能补最多八个独立节点，而这里只返回第一张表，会让模型每张表花一次
    // 请求——哪怕第一次修复之前，这些缺口就已经确定地知道了。
    const numericEvidenceFailures = [];
    for (let index = 0; index < effectiveTableBindings.length; index += 1) {
        const declared = effectiveTableBindings[index];
        const rendered = renderedTables[index];
        const renderedRows = [rendered.header, ...rendered.rows];
        let binding = declared;
        if (options.allowDeterministicQuoteRepair === true
            && binding?.sourceType === 'artifact_table'
            && !(options.selectionTableIndexes || []).includes(binding.tableIndex)
            && !artifactTableBindingCanReplay(binding, renderedRows, structuredArtifacts)) {
            const derived = deriveReaderSourceQuotes(rendered.markdown);
            if (derived.length > 0) binding = { tableIndex: binding.tableIndex,
                sourceType: 'source_quotes', sourceTableOrdinal: null,
                cellBindings: [], sourceQuotes: derived };
        }
        if (!binding || binding.sourceType !== 'source_quotes'
            || binding.sourceTableOrdinal !== null || !Array.isArray(binding.cellBindings)
            || binding.cellBindings.length !== 0 || !Array.isArray(binding.sourceQuotes)) continue;
        const { htmlQuotes, pdfQuotes } = quotesForTable(binding, rendered);
        const exactQuotes = [...htmlQuotes, ...pdfQuotes];
        if (exactQuotes.length === 0) continue;
        const scientific = readerScientificQuoteProjection(rendered, exactQuotes);
        if (scientific.failures.length) numericEvidenceFailures.push(
            `tableBindings[${index}] 关键数字缺少 exact quote/cell 证据：科学量 `
            + readerScientificQuoteFailure(scientific));
        const citationOnly = readerCitationOnlyNumericTokens(renderedRows);
        const missingNumbers = scientific.tokens.filter(token => (
            !citationOnly.has(token)
            && !readerSourceQuotesCoverNumericToken(
                token, htmlQuotes, pdfQuotes, structuredArtifacts.sourceKind === 'conference_pdf'
            )
        ));
        const missingHeaderUnits = readerTableHeaderUnitEvidenceFailures(rendered, exactQuotes);
        if (missingHeaderUnits.length) numericEvidenceFailures.push(
            `tableBindings[${index}] 列头单位缺少对应原文证据：`
                + require('./reader-authenticated-pdf-table-evidence').diagnostics(rendered, exactQuotes)
                    .map(reason => `PDF映射未通过：${reason}；`).join('')
                + missingHeaderUnits.map(item => `row=${item.row},column=${item.column} value=${item.token} unit=${item.unit}`).join('；')
        );
        if (!missingNumbers.length) continue;
        const missingSet = new Set(missingNumbers);
        const affectedCells = renderedRows.flatMap((row, rowIndex) => row.map((cell, columnIndex) => {
            const missing = [...new Set(readerNumericTokens(cell))]
                .filter(token => missingSet.has(token));
            if (!missing.length) return null;
            return `row=${rowIndex},column=${columnIndex}`
                + ` text=${JSON.stringify(String(cell).slice(0, 120))}`
                + ` missing=${missing.join(',')}`;
        }).filter(Boolean)).slice(0, 6);
        numericEvidenceFailures.push(
            `tableBindings[${index}] 关键数字缺少 exact quote/cell 证据: `
            + `${[...new Set(missingNumbers)].join(', ')}；未绑定单元格（行列从 0 开始，表头为第 0 行）：`
            + affectedCells.join('；')
        );
    }
    if (numericEvidenceFailures.length > 0) {
        throw new Error(
            `读者文章 ${numericEvidenceFailures.join('；另有 ')}`
            + '。请一次核对并修复上述全部表格的数字、完整单位与对应来源句；时长应保留如“1 s”的单位写法，'
            + '不要只写“1”或改成“1 秒”；若原句仅在比较组末尾写单位，正文必须保留同组写法，不能逐值补单位；'
            + '也不要用其他语境中的同一数字补证据。'
        );
    }
    const tableIndexes = new Set();
    const tableBindings = effectiveTableBindings.map((declaredBinding, index) => {
        assertExactObjectKeys(
            declaredBinding,
            ['tableIndex', 'sourceType', 'sourceTableOrdinal', 'cellBindings', 'sourceQuotes',
                ...(declaredBinding?.sourceType === 'source_quotes'
                    && Object.prototype.hasOwnProperty.call(declaredBinding, 'pdfSourceQuotes')
                    ? ['pdfSourceQuotes'] : [])],
            `读者文章 tableBindings[${index}]`
        );
        const rendered = renderedTables[index];
        const renderedRows = [rendered.header, ...rendered.rows];
        let binding = declaredBinding;
        if (options.allowDeterministicQuoteRepair === true
            && binding.sourceType === 'artifact_table'
            && !(options.selectionTableIndexes || []).includes(binding.tableIndex)
            && !artifactTableBindingCanReplay(
                binding, renderedRows, structuredArtifacts
            )) {
                const derived = deriveReaderSourceQuotes(rendered.markdown);
            if (derived.length > 0) {
                binding = {
                    tableIndex: binding.tableIndex,
                    sourceType: 'source_quotes',
                    sourceTableOrdinal: null,
                    cellBindings: [],
                    sourceQuotes: derived
                };
            }
        }
        if (binding.tableIndex !== index + 1 || tableIndexes.has(binding.tableIndex)) {
            throw new Error(`读者文章 tableBindings[${index}].tableIndex 必须按正文顺序唯一递增`);
        }
        tableIndexes.add(binding.tableIndex);
        const renderedTableSha256 = crypto.createHash('sha256')
            .update(rendered.markdown).digest('hex');
        if (binding.sourceType === 'artifact_table') {
            const sourceTable = (structuredArtifacts.tables || []).find(item => (
                item?.ordinal === binding.sourceTableOrdinal && item?.recoveryStatus === 'complete'
            ));
            if (!sourceTable || !recoverySha256(sourceTable.sourceDomSha256)
                || !Array.isArray(binding.cellBindings) || binding.sourceQuotes?.length !== 0) {
                throw new Error(`读者文章 tableBindings[${index}] 原始表绑定不完整`);
            }
            const pdfEvidence = require('./reader-table-pdf-evidence').evidence(sourceTable);
            const compiledPdfSelection = pdfEvidence && require('./reader-table-pdf-evidence')
                .compiledSelectionDisplayMatches(sourceTable, binding, renderedRows, structuredArtifacts);
            if (pdfEvidence && !compiledPdfSelection && (renderedRows.length !== sourceTable.matrix.length
                || renderedRows.some(row => row.length !== sourceTable.matrix[0].length)
                || binding.cellBindings.length !== sourceTable.matrix.length * sourceTable.matrix[0].length
                || binding.cellBindings.some(cell => cell.renderedRow !== cell.sourceRow
                    || cell.renderedColumn !== cell.sourceColumn))) {
                throw new Error('PDF逐格确认只允许展示完整原表，不能删列、删行或重排行列');
            }
            const expectedCells = renderedRows.flatMap((row, renderedRow) => (
                row.map((_cell, renderedColumn) => ({ renderedRow, renderedColumn }))
            ));
            if (binding.cellBindings.length !== expectedCells.length) {
                throw new Error(`读者文章 tableBindings[${index}] 必须逐格绑定全部渲染单元格`);
            }
            const seenRenderedCells = new Set();
            const cellBindings = binding.cellBindings.map((cellBinding, cellIndex) => {
                assertExactObjectKeys(
                    cellBinding,
                    ['renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn'],
                    `读者文章 tableBindings[${index}].cellBindings[${cellIndex}]`
                );
                const renderedRow = cellBinding.renderedRow;
                const renderedColumn = cellBinding.renderedColumn;
                const renderedText = renderedRows?.[renderedRow]?.[renderedColumn];
                const key = `${renderedRow}:${renderedColumn}`;
                const sourceCell = findStructuredTableCell(
                    sourceTable, cellBinding.sourceRow, cellBinding.sourceColumn
                );
                if (renderedText === undefined || seenRenderedCells.has(key) || !sourceCell
                    || !recoverySha256(sourceCell.sourceDomSha256)) {
                    throw new Error(`读者文章 tableBindings[${index}] 单元格坐标或 DOM SHA 非法`);
                }
                if (!artifactCellDisplayMatches(
                    sourceTable, cellBinding.sourceRow, cellBinding.sourceColumn, renderedText)) {
                    throw new Error(
                        `读者文章 tableBindings[${index}] 渲染单元格与原始 cell 不一致: ${key}`
                    );
                }
                seenRenderedCells.add(key);
                return {
                    ...cellBinding,
                    renderedText: String(renderedText),
                    sourceText: String(sourceCell.text),
                    sourceDomSha256: sourceCell.sourceDomSha256
                };
            });
            if (seenRenderedCells.size !== expectedCells.length) {
                throw new Error(`读者文章 tableBindings[${index}] 渲染单元格覆盖不完整`);
            }
            return {
                tableIndex: binding.tableIndex,
                sourceType: binding.sourceType,
                sourceTableOrdinal: binding.sourceTableOrdinal,
                sourceTableDomSha256: sourceTable.sourceDomSha256,
                ...require('./reader-table-pdf-evidence').bindingEvidence(sourceTable, binding, structuredArtifacts),
                renderedTableSha256,
                cellBindings,
                sourceQuotes: []
            };
        }
        if (binding.sourceType !== 'source_quotes' || binding.sourceTableOrdinal !== null
            || !Array.isArray(binding.cellBindings) || binding.cellBindings.length !== 0
            || !Array.isArray(binding.sourceQuotes)) {
            // 结构错误必须点名具体字段，否则修复轮只能看到“结构非法”而无法定位。
            const detail = binding.sourceType !== 'source_quotes'
                ? `sourceType=${JSON.stringify(binding.sourceType)}，source_quotes 只允许该模式`
                : binding.sourceTableOrdinal !== null
                    ? `sourceTableOrdinal=${JSON.stringify(binding.sourceTableOrdinal)}，source_quotes 必须为 null`
                    : !Array.isArray(binding.cellBindings)
                        ? 'cellBindings 必须是数组'
                        : binding.cellBindings.length !== 0
                            ? `cellBindings 必须是空数组（收到 ${binding.cellBindings.length} 项）`
                            : 'sourceQuotes 必须是数组';
            throw new Error(`读者文章 tableBindings[${index}] 正文 quote 绑定结构非法（${detail}）`);
        }
        const validDeclaredQuotes = resolvedDeclaredSourceQuotes(
            binding, sourceText, options.allowDeterministicQuoteRepair === true
        );
        if (validDeclaredQuotes.length !== binding.sourceQuotes.length
            && options.allowDeterministicQuoteRepair !== true) {
            const quoteIndex = binding.sourceQuotes.findIndex(quote => (
                typeof quote !== 'string' || quote.length < 12 || quote.length > 4000
                || !sourceText.includes(quote)
            ));
            throw new Error(
                `读者文章 tableBindings[${index}].sourceQuotes[${quoteIndex}]` +
                ' 不是全文中的 exact sourceQuote'
            );
        }
        const { htmlQuotes: exactQuotes, pdfQuotes: sealedPdfQuoteEvidence } = quotesForTable(binding, rendered);
        if (exactQuotes.length === 0 && sealedPdfQuoteEvidence.length === 0) {
            throw new Error(`读者文章 tableBindings[${index}] 无法确定性绑定 exact sourceQuote`
                + readerExactQuoteFailureDetail(binding, sourceText)
                + '。引文必须逐字复制原文连续原句；原文双写数值（如 9.29.2%）必须原样保留，'
                + '不能同义改写、翻译或清理成单一数值');
        }
        const sourceQuotes = exactQuotes.map((quote, quoteIndex) => {
            if (quote.length < 12 || quote.length > 4000 || !sourceText.includes(quote)) {
                throw new Error(
                    `读者文章 tableBindings[${index}].sourceQuotes[${quoteIndex}]` +
                    ' 不是全文中的 exact sourceQuote'
                );
            }
            return {
                quote,
                sourceQuoteSha256: crypto.createHash('sha256').update(quote).digest('hex')
            };
        });
        const allQuotes = [...sourceQuotes, ...sealedPdfQuoteEvidence];
        const authenticatedPdfTable = require('./reader-authenticated-pdf-table-evidence');
        const authenticatedPdfTableEvidence = binding.authenticatedPdfTableEvidence !== undefined
            || readerTableHeaderUnitEvidenceFailures(rendered, allQuotes, { authenticatedPdf: false }).length
            ? authenticatedPdfTable.derive(rendered, sourceQuotes) : null;
        if (binding.authenticatedPdfTableEvidence !== undefined) {
            authenticatedPdfTable.assertEvidence(rendered, sourceQuotes, binding.authenticatedPdfTableEvidence);
        }
        const missingHeaderUnits = readerTableHeaderUnitEvidenceFailures(rendered, allQuotes);
        if (missingHeaderUnits.length) throw new Error(
            `tableBindings[${index}] 列头单位缺少对应原文证据：`
                + authenticatedPdfTable.diagnostics(rendered, allQuotes)
                    .map(reason => `PDF映射未通过：${reason}；`).join('')
                + missingHeaderUnits.map(item => `row=${item.row},column=${item.column} value=${item.token} unit=${item.unit}`).join('；')
        );
        const scientific = readerScientificQuoteProjection(rendered, allQuotes);
        if (scientific.failures.length) throw new Error(
            `读者文章 tableBindings[${index}] 关键数字缺少 exact quote/cell 证据：科学量 `
            + readerScientificQuoteFailure(scientific));
        const citationOnly = readerCitationOnlyNumericTokens(renderedRows);
        const missingNumbers = scientific.tokens.filter(token => (
            !citationOnly.has(token)
            && !readerSourceQuotesCoverNumericToken(
                token, sourceQuotes, sealedPdfQuoteEvidence, structuredArtifacts.sourceKind === 'conference_pdf'
            )
        ));
        if (missingNumbers.length > 0) {
            const missingSet = new Set(missingNumbers);
            const affectedCells = renderedRows.flatMap((row, rowIndex) => (
                row.map((cell, columnIndex) => {
                    const missing = [...new Set(readerNumericTokens(cell))]
                        .filter(token => missingSet.has(token));
                    if (missing.length === 0) return null;
                    return `row=${rowIndex},column=${columnIndex}`
                        + ` text=${JSON.stringify(String(cell).slice(0, 120))}`
                        + ` missing=${missing.join(',')}`;
                }).filter(Boolean)
            )).slice(0, 6);
            throw new Error(
                `读者文章 tableBindings[${index}] 关键数字缺少 exact quote/cell 证据: `
                + [...new Set(missingNumbers)].join(', ')
                + `；未绑定单元格（行列从 0 开始，表头为第 0 行）：${affectedCells.join('；')}`
                + '。请核对这些单元格的数字及完整单位与对应来源句；时长应保留如“1 s”的单位写法，'
                + '不要只写“1”或改成“1 秒”；若原句仅在比较组末尾写单位，正文必须保留同组写法，不能逐值补单位；'
                + '也不要用其他语境中的同一数字补证据。'
            );
        }
        return {
            tableIndex: binding.tableIndex,
            sourceType: binding.sourceType,
            sourceTableOrdinal: null,
            renderedTableSha256,
            cellBindings: [],
            sourceQuotes,
            ...(authenticatedPdfTableEvidence ? { authenticatedPdfTableEvidence } : {}),
            ...(sealedPdfQuoteEvidence.length ? { sealedPdfQuoteEvidence } : {})
        };
    });
    if (!readerLegacyDatasetClaimsValid(boundArticle, tableBindings)) {
        throw new Error('读者文章的 TidyVoice/validation set 对应关系缺少逐字原文依据；请按原文修复数据集及其表格来源记录');
    }
    if (!require('./reader-record-format').isModernEditorialProfile(options.editorialProfile)) {
        boundArticle = require('./reader-table-pdf-evidence').appendSourceOriginNotes(boundArticle, tableBindings);
    }
    return {
        article: boundArticle,
        ...(tablePruningDiagnostics.length ? { tablePruningDiagnostics } : {}),
        tableBindings,
        formulaBindings,
        ...((tableBindings.some(binding => binding.pdfCellConfirmation || binding.sealedPdfTableEvidence
            || binding.sealedPdfQuoteEvidence || (binding.cellBindings || []).some(cell =>
                require('./source-cell-math-display').strictSourceCellMathDisplay(cell.sourceText)?.kind
                    === 'scientific-notation-duplicate'))
            || tableBindings.some((binding,index) => binding.sourceType === 'source_quotes'
                && require('./reader-source-table-column-units').coverage(renderedTables[index], binding.sourceQuotes).length > 0)
            || formulaBindings.some(binding => readerFormulaNeedsSourcePayload(binding.latex)))
            ? { structuredSourcePayload: readerStructuredSourcePayload(options.structuredArtifacts) } : {}),
        sourceBindingsSha256: stableFingerprint({ tableBindings, formulaBindings })
    };
}

function findApiReaderTablePasteDuplication(cell) {
    return findReaderTablePasteDuplication(cell);
}

function normalizeApiReaderTablePasteArtifacts(article, tableBindings = []) {
    const rebuild = rows => [
        `| ${rows[0].join(' | ')} |`,
        `| ${rows[0].map(() => '---').join(' | ')} |`,
        ...rows.slice(1).map(row => `| ${row.join(' | ')} |`)
    ].join('\n');
    const canonicalLabel = value => String(value || '').normalize('NFKC')
        .replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    let output = String(article || '');
    for (const [tablePosition, table] of extractMarkdownTables(output).entries()) {
        // selection 编译出来的 artifact 表是原表 DOM 的逐格投影，字节已与
        // cellBindings 的原 cell 绑定。对这些格子做“粘贴残留”清理会改写原格，
        // 让随后的逐格校验必然失败；它们不是模型手写内容，跳过清理。
        const binding = (Array.isArray(tableBindings) ? tableBindings : [])
            .find(item => item?.tableIndex === tablePosition + 1);
        const compiledCells = new Set(binding?.sourceType === 'artifact_table'
            ? (binding.cellBindings || []).map(cell => `${cell?.renderedRow}:${cell?.renderedColumn}`)
            : []);
        const rows = [table.header, ...table.rows].map((row, rowIndex) => row.map((cell, columnIndex) => {
            const displayCleaned = normalizeReaderSourceDisplayArtifacts(cell);
            if (displayCleaned !== String(cell)) return displayCleaned;
            // 编译格已经由 displayCell 恢复成原 DOM 字节；未知 LaTeX 注解是原文
            // 本身，不是模型粘贴残留，不能再按“改写成纯文本”删除。
            if (compiledCells.has(`${rowIndex}:${columnIndex}`)) return cell;
            if (!findApiReaderTablePasteDuplication(cell)) return cell;
            let cleaned = String(cell)
                .replace(/±\s*\\pm\s*/g, ' ± ')
                .replace(/×\s*\\times\s*/g, ' × ')
                .replace(/%\s*\\%/g, '%')
                .replace(/\{=\}/g, '=')
                .replace(/\\bf\b\s*/g, '');
            cleaned = cleaned.replace(
                /\\(?:mathrm|text)\{([^}]*)\}(?:\^\{[^}]*\})?/g,
                (whole, inner, offset, input) => {
                    // 嵌套 TeX 组中的文字是公式的一部分，不能按前面可见别名删除。
                    const prefix = input.slice(0, offset);
                    const depth = (prefix.match(/\\.|[^\\{}]|[{}]/g) || []).reduce(
                        (value, token) => value + (token === '{' ? 1 : token === '}' ? -1 : 0), 0
                    );
                    if (depth > 0) return whole;
                    return canonicalLabel(prefix).includes(canonicalLabel(inner)) ? '' : inner;
                }
            );
            cleaned = cleaned
                .replace(/\s+/g, ' ')
                .trim();
            if (!cleaned) {
                throw new Error('Reader source-binding v4 表格清理后出现空单元格；请从原始 cell 重建内容');
            }
            return cleaned;
        }));
        const rebuilt = rebuild(rows);
        if (rebuilt !== table.markdown) output = output.replace(table.markdown, () => rebuilt);
    }
    return output;
}

function normalizeKnownReaderDuplicateRows(article, arxivId = '') {
    if (String(arxivId || '').trim().toLowerCase() !== '2609.14542') {
        return String(article || '');
    }
    const rebuild = rows => [
        `| ${rows[0].join(' | ')} |`,
        `| ${rows[0].map(() => '---').join(' | ')} |`,
        ...rows.slice(1).map(row => `| ${row.join(' | ')} |`)
    ].join('\n');
    let output = String(article || '');
    for (const table of extractMarkdownTables(output)) {
        const header = table.header.map(cell => String(cell || '').trim());
        if (header.length < 4 || !header.some(cell => cell.includes('条件'))
            || !header.some(cell => cell.includes('指标'))
            || !table.rows.some(row => row.some(cell => cell.includes('域内词错误率改进')))) {
            continue;
        }
        const rows = [table.header, ...table.rows];
        let changed = false;
        for (let index = rows.length - 1; index > 1; index -= 1) {
            const current = rows[index], previous = rows[index - 1];
            if (current.length === previous.length
                && current.join('\u001f') === previous.join('\u001f')
                && current.some(cell => String(cell || '').includes('域内词错误率改进'))) {
                rows.splice(index, 1);
                changed = true;
            }
        }
        if (changed) output = output.replace(table.markdown, () => rebuild(rows));
    }
    return output;
}

function validateApiReaderTablePasteDuplication(article, options = {}) {
    const tables = extractMarkdownTables(article);
    for (const [tableIndex, table] of tables.entries()) {
        const binding = options.tableBindings?.[tableIndex];
        const rows = [table.header, ...table.rows];
        for (const [rowIndex, row] of rows.entries()) {
            for (const [columnIndex, cell] of row.entries()) {
                const cellBindings = (binding?.cellBindings || []).filter(item => (
                    item?.renderedRow === rowIndex && item?.renderedColumn === columnIndex
                ));
                const sourceTexts = binding?.sourceType === 'source_quotes'
                    ? [...(binding.sourceQuotes || []), ...(binding.sealedPdfQuoteEvidence || [])].map(item => typeof item === 'string'
                        ? item : item?.quote).filter(Boolean)
                    : cellBindings.map(item => item?.sourceText).filter(Boolean);
                const verifiedSourceCell = binding?.sourceType === 'artifact_table' && cellBindings.length > 0;
                // 已逐格绑定原表的格子是 DOM 原文投影；只对它做同值双写投影后再查粘连，
                // 不修改正文/保存稿字节，避免破坏已付稿的冷重放确定性。
                const displayed = verifiedSourceCell
                    ? require('./reader-tables').projectReaderCellForValidation(cell)
                    : cell;
                const reason = findReaderTablePasteDuplication(displayed, {
                    header: table.header, row, rowIndex, columnIndex, sourceTexts,
                    verifiedSourceCell
                });
                if (reason) {
                    throw new Error(
                        `读者文章第 ${tableIndex + 1} 张表粘连复写`
                        + `（${rowIndex === 0 ? '表头' : `数据行 ${rowIndex}`}第 ${columnIndex + 1} 格`
                        + `“${String(displayed).slice(0, 60)}”）：${reason}`
                    );
                }
            }
        }
    }
}

function normalizeConferenceMixedTableBindings(draft) {
    if (!Array.isArray(draft?.sections) || !Array.isArray(draft?.tableBindings)
        || draft.tableBindings.length === 0) return null;
    const original = stableFingerprint({ tableBindings: draft.tableBindings, sections: draft.sections });
    const work = structuredClone(draft);
    const sectionEntries = work.sections.map((section, index) => ({ section, index,
        rank: API_READER_KINDS.indexOf(section?.kind) }));
    if (sectionEntries.some(item => item.rank < 0)) return null;
    sectionEntries.sort((left, right) => left.rank - right.rank || left.index - right.index);
    work.sections = sectionEntries.map(item => item.section);
    const nodes = locateReaderDraftTables(work);
    const bindings = work.tableBindings;
    if (nodes.length !== bindings.length) return null;
    const selectionByMarker = new Map();
    const proseBindings = [];
    for (const binding of bindings) {
        if (Object.prototype.hasOwnProperty.call(binding || {}, 'selection')) {
            if (!Number.isSafeInteger(binding.tableIndex)
                || selectionByMarker.has(binding.tableIndex)) return null;
            selectionByMarker.set(binding.tableIndex, binding);
        } else {
            proseBindings.push(binding);
        }
    }
    const markerNodes = nodes.filter(node => node.marker);
    const unmarkedNodes = nodes.filter(node => !node.marker);
    if (markerNodes.length !== selectionByMarker.size
        || unmarkedNodes.length !== proseBindings.length
        || markerNodes.some(node => !Number.isSafeInteger(node.markerIndex)
            || !selectionByMarker.has(node.markerIndex))) return null;
    for (const node of markerNodes) {
        const body = String(work.sections[node.sectionIndex]?.body || '');
        const occurrences = body.split(node.marker).length - 1;
        const standalone = body.split(/\n\s*\n/).filter(block => block.trim() === node.marker).length;
        if (occurrences !== 1 || standalone !== 1) return null;
    }
    let unmarkedIndex = 0;
    const tableMap = [];
    const orderedBindings = nodes.map((node, canonicalIndex) => {
        const binding = node.marker
            ? selectionByMarker.get(node.markerIndex)
            : proseBindings[unmarkedIndex++];
        tableMap.push({ rawTableIndex: binding.tableIndex, canonicalTableIndex: canonicalIndex + 1,
            marker: node.marker || null });
        return { ...binding, tableIndex: canonicalIndex + 1 };
    });
    const markerMap = new Map(markerNodes.map(node => [
        node.markerIndex, node.tableIndex
    ]));
    for (const section of work.sections) {
        if (typeof section?.body === 'string') {
            section.body = section.body.replace(/\[\[TABLE_(\d+)\]\]/g,
                (marker, ordinal) => markerMap.has(Number(ordinal))
                    ? `[[TABLE_${markerMap.get(Number(ordinal))}]]` : marker);
        }
    }
    const output = stableFingerprint({ tableBindings: orderedBindings, sections: work.sections });
    if (original === output) return null;
    draft.sections = work.sections;
    draft.tableBindings = orderedBindings;
    return {
        contract: 'conference-reader-table-order-v1',
        inputSha256: original,
        outputSha256: output,
        changed: true,
        tables: tableMap
    };
}

// 会议 Reader 草稿可能把 source_quotes 绑定错发成 TABLE 标记。和 selection 绑定不同，
// source_quotes 绑定没有对应的标记渲染器，所以这些标记只是对已有 Markdown 表格的多余
// 声明。只恢复那种封闭、可证明的形态：每个这样的标记都必须是唯一的独立块，剩下的标记
// 都必须对应一个 selection 绑定，剩下的 Markdown 表格必须按现有相对顺序与 source_quotes
// 绑定一致。这一步去掉多余的声明并重建绑定下标，绝不改动表格单元、引文或作者正文。
function normalizeReaderSourceQuoteTableMarkers(draft) {
    if (!Array.isArray(draft?.sections) || !Array.isArray(draft?.tableBindings)
        || draft.tableBindings.length === 0) return null;
    const original = stableFingerprint({ tableBindings: draft.tableBindings, sections: draft.sections });
    const work = structuredClone(draft);
    const sectionEntries = work.sections.map((section, index) => ({ section, index,
        rank: API_READER_KINDS.indexOf(section?.kind) }));
    if (sectionEntries.some(item => item.rank < 0)) return null;
    sectionEntries.sort((left, right) => left.rank - right.rank || left.index - right.index);
    work.sections = sectionEntries.map(item => item.section);

    const selectionBindings = work.tableBindings.filter(binding =>
        Object.prototype.hasOwnProperty.call(binding || {}, 'selection'));
    const sourceQuoteBindings = work.tableBindings.filter(binding =>
        !Object.prototype.hasOwnProperty.call(binding || {}, 'selection')
        && binding?.sourceType === 'source_quotes' && Array.isArray(binding.sourceQuotes));
    if (selectionBindings.length + sourceQuoteBindings.length !== work.tableBindings.length
        || sourceQuoteBindings.length === 0) return null;

    const selectionByOldIndex = new Map();
    for (const binding of selectionBindings) {
        if (!Number.isSafeInteger(binding.tableIndex) || selectionByOldIndex.has(binding.tableIndex)) return null;
        selectionByOldIndex.set(binding.tableIndex, binding);
    }
    const sourceQuoteIndexes = new Set(sourceQuoteBindings.map(binding => binding.tableIndex));
    const removableMarkers = [];
    for (const binding of sourceQuoteBindings) {
        if (!Number.isSafeInteger(binding.tableIndex)) return null;
        const marker = `[[TABLE_${binding.tableIndex}]]`;
        const occurrences = work.sections.reduce((total, section) =>
            total + String(section?.body || '').split(marker).length - 1, 0);
        const standalone = work.sections.reduce((total, section) => total
            + String(section?.body || '').split(/\n\s*\n/).filter(block => block.trim() === marker).length, 0);
        if (occurrences === 0) continue;
        if (occurrences !== 1 || standalone !== 1) return null;
        removableMarkers.push(marker);
    }
    if (removableMarkers.length === 0) return null;

    for (const marker of removableMarkers) {
        for (const section of work.sections) {
            if (typeof section?.body !== 'string' || !section.body.includes(marker)) continue;
            const blocks = section.body.split(/\n\s*\n/);
            if (blocks.filter(block => block.trim() === marker).length !== 1) return null;
            section.body = blocks.filter(block => block.trim() !== marker).join('\n\n');
        }
    }

    const nodes = locateReaderDraftTables(work);
    const markerNodes = nodes.filter(node => node.marker);
    const unmarkedNodes = nodes.filter(node => !node.marker);
    if (markerNodes.length !== selectionBindings.length
        || unmarkedNodes.length !== sourceQuoteBindings.length
        || markerNodes.some(node => !Number.isSafeInteger(node.markerIndex)
            || !selectionByOldIndex.has(node.markerIndex)
            || sourceQuoteIndexes.has(node.markerIndex))) return null;
    for (const node of markerNodes) {
        const body = String(work.sections[node.sectionIndex]?.body || '');
        if (body.split(node.marker).length - 1 !== 1
            || body.split(/\n\s*\n/).filter(block => block.trim() === node.marker).length !== 1) return null;
    }

    let sourceQuoteIndex = 0;
    const tableMap = [];
    const orderedBindings = nodes.map((node, canonicalIndex) => {
        const binding = node.marker
            ? selectionByOldIndex.get(node.markerIndex)
            : sourceQuoteBindings[sourceQuoteIndex++];
        if (!binding) return null;
        tableMap.push({ rawTableIndex: binding.tableIndex, canonicalTableIndex: canonicalIndex + 1,
            marker: node.marker || null });
        return { ...binding, tableIndex: canonicalIndex + 1 };
    });
    if (orderedBindings.some(binding => !binding)) return null;
    const markerMap = new Map(markerNodes.map(node => [node.markerIndex, node.tableIndex]));
    for (const section of work.sections) {
        if (typeof section?.body !== 'string') continue;
        section.body = section.body.replace(/\[\[TABLE_(\d+)\]\]/g,
            (marker, ordinal) => markerMap.has(Number(ordinal))
                ? `[[TABLE_${markerMap.get(Number(ordinal))}]]` : marker);
    }
    const output = stableFingerprint({ tableBindings: orderedBindings, sections: work.sections });
    if (original === output) return null;
    draft.sections = work.sections;
    draft.tableBindings = orderedBindings;
    return {
        contract: 'conference-reader-source-quote-marker-v1',
        inputSha256: original,
        outputSha256: output,
        changed: true,
        tables: tableMap,
        removedMarkers: removableMarkers
    };
}

// PDF 分栏抽取会在两个小句之间插进无关的一栏，把句子切断。当某个 source_quotes 绑定
// 不是原文里连续的一段时，从核验过的原文里恢复最长的精确连续短语。这一步只改证据元数据
// 和它的哈希，绝不编造或改写渲染出来的表格单元。
function normalizeReaderSourceQuotes(candidate, sourceText) {
    if (!candidate || !Array.isArray(candidate.tableBindings)
        || typeof sourceText !== 'string' || !sourceText) return false;
    const collapseWithOffsets = value => {
        let normalized = '';
        const offsets = [];
        let whitespace = false;
        for (let index = 0; index < value.length; index += 1) {
            const char = value[index];
            if (/\s/u.test(char)) {
                whitespace = true;
                continue;
            }
            if (whitespace && normalized) {
                normalized += ' ';
                offsets.push(index);
            }
            whitespace = false;
            normalized += char;
            offsets.push(index);
        }
        return { normalized, offsets };
    };
    const source = collapseWithOffsets(sourceText);
    const exactSpan = quote => {
        if (typeof quote !== 'string' || quote.length < 12) return null;
        if (sourceText.includes(quote)) return quote;
        const normalizedQuote = collapseWithOffsets(quote).normalized;
        const tokens = normalizedQuote.split(' ').filter(Boolean);
        if (tokens.length === 0) return null;

        // 优先选仍然带着声明引文中那个定量 token 的原文片段。旧的从前缀开始搜的做法会
        // 返回一段完全连续却在语义上空的片段（比如双栏 PDF 里数字前面的那几个词），把
        // 下游数字闸门需要的证据悄悄丢掉。
        const targetNumbers = new Set(readerNumericTokens(quote));
        const numericCandidates = [];
        if (targetNumbers.size > 0) {
            for (const match of readerNumericTokenMatches(sourceText)) {
                const expansions = sourceNumericTokenExpansions(match[0]);
                const matchesTarget = [...targetNumbers].some(token => {
                    if (expansions.has(token)) return true;
                    const unitless = String(token).match(
                        /^([-+]?\d+(?:\.\d+)?)(?:db|ms|hz|khz|mhz|gb|mb|kb|pp|%|s|h)$/i
                    );
                    return Boolean(unitless)
                        && normalizeReaderNumericToken(match[0])
                            === normalizeReaderNumericToken(unitless[1]);
                });
                if (!matchesTarget) continue;
                const unitTarget = [...targetNumbers].find(token => {
                    const unitless = String(token).match(
                        /^([-+]?\d+(?:\.\d+)?)(db|ms|hz|khz|mhz|gb|mb|kb|pp|%|s|h)$/i
                    );
                    return Boolean(unitless)
                        && normalizeReaderNumericToken(match[0])
                            === normalizeReaderNumericToken(unitless[1]);
                });
                if (unitTarget) {
                    const unit = unitTarget.match(
                        /^[-+]?\d+(?:\.\d+)?(db|ms|hz|khz|mhz|gb|mb|kb|pp|%|s|h)$/i
                    )?.[1];
                    const normalizedUnit = unit?.toLowerCase() === 'db' ? 'dB' : unit;
                    const afterStart = match.index + (match.sourceLength || match[0].length);
                    const tail = sourceText.slice(afterStart, afterStart + 240);
                    const unitMatch = normalizedUnit
                        ? new RegExp(`(?:\\s|^|[^A-Za-z])${normalizedUnit}(?![A-Za-z0-9_])`, 'i').exec(tail)
                        : null;
                    if (unitMatch) {
                        const lineStart = sourceText.lastIndexOf('\n', match.index) + 1;
                        const unitEnd = afterStart + unitMatch.index + unitMatch[0].length;
                        const spanStart = Math.max(lineStart, unitEnd - 4000);
                        const span = sourceText.slice(spanStart, unitEnd);
                        if (span.length >= 12 && span.length <= 4000 && sourceText.includes(span)) {
                            const covered = [...targetNumbers].filter(token => (
                                readerNumericTokens(span).includes(token)
                                || readerSourceQuoteCoversNumericToken(token, span, true)
                            )).length;
                            numericCandidates.push({ excerpt: span, covered });
                        }
                    }
                }
                const excerpt = exactSourceExcerpt(
                    sourceText, match.index, match.sourceLength || match[0].length
                );
                if (excerpt.length < 12 || !sourceText.includes(excerpt)) continue;
                const covered = [...targetNumbers].filter(token => (
                    readerNumericTokens(excerpt).includes(token)
                    || readerSourceQuoteCoversNumericToken(token, excerpt, true)
                )).length;
                numericCandidates.push({ excerpt, covered });
            }
        }
        if (numericCandidates.length > 0) {
            numericCandidates.sort((left, right) => right.covered - left.covered
                || right.excerpt.length - left.excerpt.length);
            return numericCandidates[0].excerpt;
        }
        let best = null;
        const maxStart = Math.min(tokens.length - 1, 4);
        for (let start = 0; start <= maxStart; start += 1) {
            for (let end = tokens.length; end > start; end -= 1) {
                const fragment = tokens.slice(start, end).join(' ');
                if (fragment.length < 24) continue;
                const index = source.normalized.indexOf(fragment);
                if (index < 0 || (best && fragment.length <= best.length)) continue;
                best = { index, length: fragment.length };
                break;
            }
        }
        if (!best) return null;
        const rawStart = source.offsets[best.index];
        const rawEndIndex = best.index + best.length - 1;
        const rawEnd = source.offsets[rawEndIndex];
        if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd) || rawEnd < rawStart) return null;
        return sourceText.slice(rawStart, rawEnd + 1);
    };
    let changed = false;
    for (const binding of candidate.tableBindings) {
        if (binding?.sourceType !== 'source_quotes' || !Array.isArray(binding.sourceQuotes)) continue;
        const quotes = binding.sourceQuotes.map(quote => exactSpan(quote) || quote);
        if (quotes.some((quote, index) => quote !== binding.sourceQuotes[index])) {
            binding.sourceQuotes = quotes;
            changed = true;
        }
    }
    return changed;
}

// Numeric citations are evidence, never a substitute for named experimental
// conditions and metrics. Reject only the retired generated-table signature;
// ordinary result tables and quotation/explanation tables remain valid.
function readerPlaceholderResultTableIssues(draft) {
    const issues = [];
    const tables = (Array.isArray(draft?.sections) ? draft.sections : [])
        .flatMap(section => typeof section?.body === 'string' ? extractMarkdownTables(section.body) : []);
    const directBindings = Array.isArray(draft?.tableBindings) && draft.tableBindings.length === tables.length
        && draft.tableBindings.every(binding => binding?.sourceType === 'source_quotes' && !binding.selection);
    let ordinal = 0;
    for (const [sectionIndex, section] of (Array.isArray(draft?.sections) ? draft.sections : []).entries()) {
        if (typeof section?.body !== 'string') continue;
        for (const [tableIndex, table] of extractMarkdownTables(section.body).entries()) {
            ordinal += 1;
            const clean = value => String(value || '').replace(/[\s*\x60]/gu, '');
            const generic = table.header.slice(1).filter(header => /^量化值(?:[一二三四五六七八九十]+|[0-9]+)$/u.test(clean(header)));
            const sourceRows = table.rows.some(row => /^来源句(?:[一二三四五六七八九十]+|[0-9]+)$/u.test(clean(row[0])));
            if (!generic.length || clean(table.header[0]) !== '来源证据' && !sourceRows) continue;
            issues.push({ path: '/sections/' + sectionIndex + '/body', code: 'reader_placeholder_result_table',
                tableIndex: tableIndex + 1,
                message: '读者文章包含缺少方法、条件和指标身份的占位结果表（来源证据/来源句/量化值序号）。'
                    + '引用中的数字不能直接组成实验结果；请按同一真实原表或完整连续结果句恢复有语义的行列，'
                    + '保留真实比较对象、指标、单位、完整数值和来源绑定，不凑列、不搬表或凭数值重叠选择原表。' });
            const bindingIndex = directBindings
                ? draft.tableBindings.findIndex(binding => binding.tableIndex === ordinal) : -1;
            if (bindingIndex >= 0) issues.push({ ...issues.at(-1), path: '/tableBindings/' + bindingIndex });
        }
    }
    return issues;
}
function assertReaderResultTableSemantics(draft) {
    const issues = readerPlaceholderResultTableIssues(draft);
    if (issues.length) throw Object.assign(new Error(issues.map(issue => issue.message).join('；')), {
        code: 'reader_placeholder_result_table', readerIssues: issues
    });
}

module.exports = {
    restoreReaderSelectedTableBytes,
    restoreUniquelyMergedReaderHeaderRows,
    normalizeReaderSourceCell,
    findStructuredTableCell,
    readerNumericTokenMatches,
    normalizeReaderNumericToken,
    readerNumericTokens,
    readerCitationOnlyNumericTokens,
    readerScientificQuoteProjection,
    readerScientificQuoteFailure,
    exactSourceExcerpt,
    sourceNumericTokenExpansions,
    readerSourceQuoteCoversNumericToken,
    readerAdjacentMetricUnitEvidence,
    readerTableHeaderUnitEvidenceFailures,
    deriveExactTableSourceQuotes,
    rehydrateWhitespaceEquivalentSourceQuote,
    normalizeReaderSourceQuoteWhitespace,
    resolvedDeclaredSourceQuotes,
    readerClosestSourcePassage,
    readerExactQuoteFailureDetail,
    resolvedDeclaredPdfSourceQuotes,
    readerSourceQuotesCoverNumericToken,
    withReaderSourceQuoteEvidence,
    pruneUnsupportedSourceQuoteTable,
    artifactTableBindingCanReplay,
    exactObjectInOrder,
    replayPersistedArxivHtmlDomV4PayloadSha,
    replayPersistedUnstructuredArxivPayloadSha,
    readerFormulaNeedsSourcePayload,
    readerStructuredSourcePayload,
    readerSourcePayloadArtifacts,
    readerFormulaSourcePayloadValid,
    readerLegacyDatasetQuoteSupportsClaim,
    readerLegacyDatasetClaimsValid,
    assessReaderFormulaEligibility,
    bindApiReaderSourceEvidence,
    findApiReaderTablePasteDuplication,
    normalizeApiReaderTablePasteArtifacts,
    normalizeKnownReaderDuplicateRows,
    validateApiReaderTablePasteDuplication,
    normalizeConferenceMixedTableBindings,
    normalizeReaderSourceQuoteTableMarkers,
    normalizeReaderSourceQuotes,
    readerPlaceholderResultTableIssues,
    assertReaderResultTableSemantics
};

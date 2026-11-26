#!/usr/bin/env node
'use strict';
// 离线表格预检：输入草稿 JSON（含 sections[].body）或 Markdown 文件，报告粘连复写、
// 缺单位指标列、无外框表列数不一致、Mean Δ 合并列指标/单位不一致等常见问题。
// 不写数据、不联网、不替代正式校验；只输出人话问题列表。
const fs = require('node:fs');
const path = require('node:path');

const VALIDATION_RULES = require('./lib/validation-rules.json');
const HEADER_UNITS = Object.freeze(VALIDATION_RULES.tableHeaderUnits.slice());
const METRIC_KEYWORDS = Object.freeze((VALIDATION_RULES.metricKeywords || []).slice());
const GLUED_PATTERN_EXAMPLES = Object.freeze((VALIDATION_RULES.gluedPatternExamples || []).slice());
const GLUED_CLEAN_EXAMPLES = Object.freeze((VALIDATION_RULES.gluedCleanExamples || []).slice());

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** NFKC 把全角括号/数字折成半角，双端（Python 的 unicodedata.normalize）保持一致。 */
const normalizeText = value => String(value === undefined || value === null ? '' : value).normalize('NFKC');

/** 用给定单位白名单构造 “(unit)” 检测器；测试可用变异后的列表验证检测确实依赖白名单。 */
function buildHeaderUnitPattern(units = HEADER_UNITS) {
    const list = (Array.isArray(units) ? units : [])
        .filter(unit => typeof unit === 'string' && unit)
        .map(escapeRegExp);
    return new RegExp(`\\(\\s*(${list.join('|')})\\s*\\)`, 'i');
}

/** 用给定指标关键词构造检测器；测试可用删掉某关键词的列表验证不是重言式。 */
function buildMetricMatcher(keywords = METRIC_KEYWORDS) {
    const lowered = (Array.isArray(keywords) ? keywords : [])
        .filter(keyword => typeof keyword === 'string' && keyword.trim())
        .map(keyword => keyword.trim().toLowerCase());
    return text => {
        const value = normalizeText(text).toLowerCase();
        return lowered.some(keyword => value.includes(keyword));
    };
}

const UNIT_DECL = buildHeaderUnitPattern();
const UNIT_DECL_GLOBAL = new RegExp(UNIT_DECL.source, 'gi');
const isMetricHeader = buildMetricMatcher();

// 粘连复写的保守形态：重复的括号块（(.25,.75)(.25,.75)）或重复的带小数点数值（7.37.3）。
// 不把纯整数重复（2020）当粘连，避免正常编号误报。
const GLUED_PATTERNS = [
    /(\([^()]{1,40}\))\1/g,
    /(\d+\.\d+)\1/g
];

function openingFence(line) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
    return { marker: match[1][0], length: match[1].length };
}

function closesFence(line, fence) {
    const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}
const CAPTION = /^\s*(?:Table|表)\s*\d+(?:[.:：]|\s|$)/i;
const SEPARATOR_CELL = /^:?-{1,}:?$/;
const MEAN_DELTA_LABEL = /^Mean\s*[Δ∆]$/i;

const VERSION_TOKEN_PATTERN = /(?:^|[^A-Za-z0-9])(v\d+(?:\.\d+)+)(?![A-Za-z0-9]|\.[A-Za-z0-9])/gi;

function findGluedDuplicates(text) {
    const value = normalizeText(text);
    const versionSpans = [];
    VERSION_TOKEN_PATTERN.lastIndex = 0;
    let verMatch;
    while ((verMatch = VERSION_TOKEN_PATTERN.exec(value)) !== null) {
        const token = verMatch[1];
        const start = verMatch.index + (verMatch[0].length - token.length);
        versionSpans.push([start, start + token.length]);
    }
    const matches = [];
    for (let patternIndex = 0; patternIndex < GLUED_PATTERNS.length; patternIndex += 1) {
        const pattern = GLUED_PATTERNS[patternIndex];
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(value)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            const inVersionToken = patternIndex === 1 && versionSpans.some(([vStart, vEnd]) => start > vStart && end <= vEnd);
            matches.push({ text: match[0], index: start, inVersionToken });
        }
    }
    return matches;
}

function findGluedDuplicate(text) {
    const matches = findGluedDuplicates(text);
    if (!matches.length) return null;
    const errorMatch = matches.find(item => !item.inVersionToken);
    return (errorMatch || matches[0]).text;
}

function countPrecedingBackslashes(text, index) {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
        count += 1;
    }
    return count;
}

function hasUnescapedPipe(line) {
    let inCode = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '`') { inCode = !inCode; continue; }
        if (char === '|' && !inCode && countPrecedingBackslashes(line, index) % 2 === 0) return true;
    }
    return false;
}

function splitRowCells(row) {
    let value = row.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && countPrecedingBackslashes(value, value.length - 1) % 2 === 0) {
        value = value.slice(0, -1);
    }
    const cells = [];
    let current = '';
    let inCode = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char === '`') {
            inCode = !inCode;
            current += char;
            continue;
        }
        if (char === '|') {
            const backslashes = countPrecedingBackslashes(value, index);
            if (backslashes % 2 === 1) {
                current = `${current.slice(0, -1)}|`;
                continue;
            }
            if (!inCode) {
                cells.push(current.trim());
                current = '';
                continue;
            }
        }
        current += char;
    }
    cells.push(current.trim());
    return cells;
}

const cellsOfRow = splitRowCells;

function isSeparatorRow(line) {
    if (!hasUnescapedPipe(line)) return false;
    const cells = splitRowCells(line);
    return cells.length >= 2 && cells.every(cell => SEPARATOR_CELL.test(cell));
}

function isCaptionLine(line) {
    return CAPTION.test(String(line || ''));
}

function stripUnitAndDirection(text) {
    return normalizeText(text)
        .replace(UNIT_DECL_GLOBAL, ' ')
        .replace(/[↑↓→←]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function unitOfCell(text) {
    const match = normalizeText(text).match(UNIT_DECL);
    return match ? match[1].toLowerCase() : null;
}

function isCoveredContinuation(cell) {
    const value = normalizeText(cell).trim();
    return value === '' || value === '—' || value === '–' || value === '-';
}

/**
 * 无外框 GFM 表格也支持：表头行含未转义竖线，且紧邻的下一行是分隔行，
 * 分隔行单元格数与表头一致（至少两列）。普通含竖线的正文因为下一行不是
 * 分隔行，不会被当成表格；`Table N`/`表 N` 标题行不参与表头，也不吞进数据行。
 */
function tablesOfText(text) {
    const lines = String(text || '').split(/\r?\n/);
    const tables = [];
    let index = 0;
    let fence = null;
    while (index < lines.length) {
        const line = lines[index];
        if (fence) {
            if (closesFence(line, fence)) fence = null;
            index += 1;
            continue;
        }
        const opening = openingFence(line);
        if (opening) { fence = opening; index += 1; continue; }
        if (!isCaptionLine(line) && hasUnescapedPipe(line) && index + 1 < lines.length) {
            const delimiter = lines[index + 1];
            const headerCells = splitRowCells(line);
            if (headerCells.length >= 1
                && headerCells.some(cell => cell !== '')
                && isSeparatorRow(delimiter)
                && splitRowCells(delimiter).length === headerCells.length) {
                const block = [line.trim()];
                let next = index + 2;
                while (next < lines.length
                    && !openingFence(lines[next])
                    && !isCaptionLine(lines[next])
                    && !isSeparatorRow(lines[next])
                    && hasUnescapedPipe(lines[next])) {
                    block.push(lines[next].trim());
                    next += 1;
                }
                tables.push(block);
                index = next;
                continue;
            }
        }
        index += 1;
    }
    return tables;
}

function checkMeanDeltaMergedColumns(headerCells, rows) {
    const issues = [];
    const deltaRows = rows.filter(cells => MEAN_DELTA_LABEL.test(normalizeText(cells[0] || '').trim()));
    if (deltaRows.length === 0) return issues;
    for (const cells of deltaRows) {
        for (let column = 1; column + 1 < cells.length; column += 1) {
            // 合并列在 Markdown 里体现为“真值 + —/空 续列”。
            if (!isCoveredContinuation(cells[column + 1])) continue;
            if (isCoveredContinuation(cells[column])) continue;
            const leftHeader = headerCells[column] || '';
            const rightHeader = headerCells[column + 1] || '';
            const sameMetric = stripUnitAndDirection(leftHeader) === stripUnitAndDirection(rightHeader);
            const sameUnit = unitOfCell(leftHeader) === unitOfCell(rightHeader);
            if (!sameMetric || !sameUnit) {
                const left = normalizeText(leftHeader).trim().slice(0, 40) || '(空)';
                const right = normalizeText(rightHeader).trim().slice(0, 40) || '(空)';
                issues.push({
                    severity: 'warn',
                    code: 'table-mean-delta-merged-unit',
                    message: `“Mean Δ” 合并列的第 ${column + 1}/${column + 2} 列不是同一指标同一单位（${left} vs ${right}），不能合并`
                });
            }
        }
    }
    return issues;
}

function checkTable(lines) {
    const issues = [];
    const header = splitRowCells(lines[0] || '');
    const rows = lines.slice(1).map(splitRowCells);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const cells = rows[rowIndex];
        if (cells.length !== header.length) {
            issues.push({
                severity: 'error',
                code: 'table-column-count',
                message: `第 ${rowIndex + 2} 行列数 ${cells.length} 与表头 ${header.length} 不一致`
            });
        }
        cells.forEach((cell, column) => {
            const gluedMatches = findGluedDuplicates(cell);
            if (gluedMatches.length) {
                const errorMatch = gluedMatches.find(item => !item.inVersionToken);
                const chosen = errorMatch || gluedMatches[0];
                issues.push({
                    severity: errorMatch ? 'error' : 'warn',
                    code: 'table-glued-duplicate',
                    message: `第 ${rowIndex + 2} 行第 ${column + 1} 格疑似粘连复写：${chosen.text}`,
                    howToFix: '核对封存原表的完整单元格值；不要只按重复形状删数字。'
                });
            }
        });
    }
    const hasUnitDeclaredPeer = column => header.some((peer, peerIndex) => (
        peerIndex !== column && UNIT_DECL.test(normalizeText(peer))
    ));
    header.forEach((cell, column) => {
        const normalizedCell = normalizeText(cell).trim();
        if (isMetricHeader(normalizedCell) && !UNIT_DECL.test(normalizedCell) && hasUnitDeclaredPeer(column)) {
            issues.push({
                severity: 'warn',
                code: 'table-unit-header',
                message: `第 ${column + 1} 列表头缺少单位声明（同表其它列有 (%)/(ms) 等），请确认与源表一致`
            });
        }
    });
    issues.push(...checkMeanDeltaMergedColumns(header, rows));
    return issues;
}

function checkText(text) {
    const issues = [];
    tablesOfText(text).forEach((lines, index) => {
        for (const issue of checkTable(lines)) issues.push({ table: index + 1, ...issue });
    });
    return issues;
}

function draftText(raw) {
    if (typeof raw === 'string') return raw;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('草稿 JSON 必须是正文字符串或含 sections/markdown/article 的对象');
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'sections')) {
        if (!Array.isArray(raw.sections)) throw new Error('sections 必须是数组');
        return raw.sections.map((section, index) => {
            if (!section || typeof section !== 'object' || Array.isArray(section)) {
                throw new Error(`sections[${index}] 必须是对象`);
            }
            // 兼容局部空段，只在合并后要求正文非空；不把错误类型强转成文本。
            if (section.body === undefined || section.body === null) return '';
            if (typeof section.body !== 'string') throw new Error(`sections[${index}].body 必须是字符串或空值`);
            return section.body;
        }).join('\n\n');
    }
    const value = raw.markdown === undefined || raw.markdown === null || raw.markdown === ''
        ? raw.article : raw.markdown;
    if (typeof value !== 'string') throw new Error('草稿 markdown/article 正文必须是字符串');
    return value;
}

function main(argv = process.argv.slice(2)) {
    try {
        require('./env-loader').requireExternalRuntime('table-check.js');
    } catch (error) {
        console.error(`[table-check] ${error.message}`);
        return 1;
    }

    const options = { file: null, json: false, format: null };
    try {
        for (let index = 0; index < argv.length; index += 1) {
            const value = argv[index];
            if (value === '--draft' || value === '--file' || value === '--format') {
                const next = argv[++index];
                if (typeof next !== 'string' || !next.trim() || next.startsWith('--')) {
                    throw new Error(`${value} 需要非空值${value === '--format' ? '' : '（文件路径）'}`);
                }
                if (value === '--format') {
                    if (!['json', 'markdown'].includes(next)) throw new Error('--format 仅支持 json 或 markdown');
                    options.format = next;
                } else options.file = path.resolve(next);
            }
            else if (value === '--json') options.json = true;
            else if (value === '--help') options.help = true;
            else throw new Error(`未知参数：${value}`);
        }
    } catch (error) {
        console.error(`[table-check] ${error.message}`);
        return 2;
    }
    if (options.help) {
        console.log('用法: node scripts/table-check.js --draft FILE [--format json|markdown] [--json]');
        console.log('未指定 --format 时，.md/.markdown 按 Markdown 读取，其余按 JSON 读取；解析失败不回退。');
        return 0;
    }
    if (!options.file) {
        console.error('[table-check] 需要 --draft FILE');
        return 2;
    }
    let text;
    try {
        const format = options.format || (/^\.(?:md|markdown)$/i.test(path.extname(options.file)) ? 'markdown' : 'json');
        const raw = fs.readFileSync(options.file, 'utf8');
        text = format === 'markdown' ? raw : draftText(JSON.parse(raw));
    } catch (error) {
        console.error(`[table-check] 读取草稿失败：${error.message}`);
        return 2;
    }
    if (!text.trim()) {
        console.error('[table-check] 草稿里没有可检查的正文');
        return 2;
    }
    const issues = checkText(text);
    if (options.json) {
        console.log(JSON.stringify({ file: options.file, issues }, null, 2));
    } else {
        if (!issues.length) console.log('表格预检通过：未发现粘连复写/列数/单位声明/Mean Δ 合并列问题。');
        for (const issue of issues) {
            const icon = issue.severity === 'error' ? '❌' : '⚠️';
            console.log(`${icon} 表 ${issue.table}：${issue.message}`);
            if (issue.howToFix) console.log(`   改法：${issue.howToFix}`);
        }
    }
    return issues.some(issue => issue.severity === 'error') ? 1 : 0;
}

module.exports = {
    HEADER_UNITS,
    METRIC_KEYWORDS,
    GLUED_PATTERN_EXAMPLES,
    GLUED_CLEAN_EXAMPLES,
    VALIDATION_RULES,
    buildHeaderUnitPattern,
    buildMetricMatcher,
    findGluedDuplicate,
    hasUnescapedPipe,
    splitRowCells,
    cellsOfRow,
    isSeparatorRow,
    isCaptionLine,
    tablesOfText,
    checkMeanDeltaMergedColumns,
    checkTable,
    checkText,
    main
};

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(`[table-check] ${error.message}`);
        process.exitCode = 2;
    }
}

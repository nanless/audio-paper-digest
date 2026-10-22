#!/usr/bin/env node
'use strict';
// 离线表格预检：输入草稿 JSON（含 sections[].body）或 Markdown 文件，报告粘连复写、
// 空表头单位、列数不一致等常见问题。不写数据、不联网、不替代正式校验。
const fs = require('node:fs');
const path = require('node:path');

const GLUED = /(\([^()]{1,40}\))\1/g;
const normalizeParens = value => String(value).replace(/（/g, '(').replace(/）/g, ')');
const VALIDATION_RULES = require('./lib/validation-rules.json');
const HEADER_UNITS = Object.freeze(VALIDATION_RULES.tableHeaderUnits.slice());
const UNIT_DECL = new RegExp(`\\(\\s*(${HEADER_UNITS.map(unit => unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\)`, 'i');

function tablesOfText(text) {
    const lines = String(text || '').split(/\r?\n/);
    const tables = [];
    let current = null;
    for (const line of lines) {
        if (/^\s*\|/.test(line)) {
            if (!current) current = [];
            current.push(line.trim());
        } else if (current) { tables.push(current); current = null; }
    }
    if (current) tables.push(current);
    return tables;
}

function cellsOfRow(row) {
    let value = row.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const cells = [];
    let current = '';
    let inCode = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char === '\\' && value[index + 1] === '|') { current += '|'; index += 1; continue; }
        if (char === '`') inCode = !inCode;
        if (char === '|' && !inCode) { cells.push(current.trim()); current = ''; continue; }
        current += char;
    }
    cells.push(current.trim());
    return cells;
}

function checkTable(lines, index) {
    const issues = [];
    const rows = lines.filter(line => !/^\|[\s:|-]+\|$/.test(line));
    if (rows.length < 2) return issues;
    const header = cellsOfRow(rows[0]);
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const cells = cellsOfRow(rows[rowIndex]);
        if (cells.length !== header.length) {
            issues.push({ severity: 'error', code: 'table-column-count', message: `第 ${rowIndex + 1} 行列数 ${cells.length} 与表头 ${header.length} 不一致` });
        }
        cells.forEach((cell, column) => {
            GLUED.lastIndex = 0;
            const match = GLUED.exec(normalizeParens(cell));
            if (match) issues.push({ severity: 'error', code: 'table-glued-duplicate', message: `第 ${rowIndex + 1} 行第 ${column + 1} 格疑似粘连复写：${match[0]}`, howToFix: '核对封存原表的完整单元格值；不要只按重复形状删数字。' });
        });
    }
    header.forEach((cell, column) => {
        const hasUnit = UNIT_DECL.test(cell);
        const looksMetric = /wer|aas|accuracy|bleu|f1|mcc|latency|offset|score|%|ms|db|hz/i.test(cell);
        const hasMetricPeer = header.some((peer, peerIndex) => peerIndex !== column && UNIT_DECL.test(peer));
        if (looksMetric && !hasUnit && hasMetricPeer) {
            issues.push({ severity: 'warn', code: 'table-unit-header', message: `第 ${column + 1} 列表头缺少单位声明（同表其它列有 (%)/(ms) 等），请确认与源表一致` });
        }
    });
    return issues;
}

function checkText(text) {
    const issues = [];
    tablesOfText(text).forEach((lines, index) => {
        for (const issue of checkTable(lines, index)) issues.push({ table: index + 1, ...issue });
    });
    return issues;
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('table-check.js'); } catch (error) { console.error(`[table-check] ${error.message}`); return 1; }

    const options = { file: null, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--draft' || value === '--file') options.file = path.resolve(argv[++index] || '');
        else if (value === '--json') options.json = true;
        else if (value === '--help') options.help = true;
        else throw new Error(`未知参数：${value}`);
    }
    if (options.help) { console.log('用法: node scripts/table-check.js --draft DRAFT.json [--json]'); return 0; }
    if (!options.file) throw new Error('需要 --draft DRAFT.json');
    const raw = JSON.parse(fs.readFileSync(options.file, 'utf8'));
    const text = typeof raw === 'string' ? raw : Array.isArray(raw.sections) ? raw.sections.map(section => section.body || '').join('\n\n') : String(raw.markdown || raw.article || '');
    if (!text) throw new Error('草稿里没有可检查的正文');
    const issues = checkText(text);
    if (options.json) console.log(JSON.stringify({ file: options.file, issues }, null, 2));
    else {
        if (!issues.length) console.log('表格预检通过：未发现粘连复写/列数/单位声明问题。');
        for (const issue of issues) console.log(`${issue.severity === 'error' ? '❌' : '⚠️'} 表 ${issue.table}：${issue.message}`);
    }
    return issues.some(issue => issue.severity === 'error') ? 1 : 0;
}

module.exports = { HEADER_UNITS, VALIDATION_RULES, tablesOfText, cellsOfRow, checkTable, checkText, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[table-check] ${error.message}`); process.exitCode = 2; }
}

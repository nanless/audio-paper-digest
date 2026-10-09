#!/usr/bin/env node
'use strict';
const { requireExternalRuntime } = require('./env-loader.js');
requireExternalRuntime('llm-usage-report');
const fs = require('node:fs');
const path = require('node:path');
const Config = require('./config.js');
const { summarizeLlmUsage, usagePaperKey, VERSION } = require('./lib/llm-usage.js');

function readUsageEvents(directory) {
    if (!fs.existsSync(directory)) return [];
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('用量事件目录必须是真实目录，不能是符号链接');
    const events = [];
    for (const name of fs.readdirSync(directory).sort()) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('用量事件必须是普通文件，不能是符号链接或超过 32 KiB');
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value?.version !== VERSION || !['request', 'disposition'].includes(value.kind)) throw new Error('用量事件格式不对：version 或 kind 不是这个版本认识的取值');
        events.push(value);
    }
    return events;
}

function main(args = process.argv.slice(2)) {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i];
        if (!['--dir', '--paper', '--stage', '--date', '--run'].includes(name) || !args[i + 1]
            || args[i + 1].startsWith('--') || options[name]) throw new Error('用法：usage:report [--paper ID] [--stage NAME] [--date YYYY-MM-DD] [--run UUID] [--dir DIR]');
        options[name] = args[i + 1];
    }
    if (options['--paper'] && !usagePaperKey(options['--paper'])) throw new Error('论文 ID 不合法：请使用 arXiv ID 或完整会议论文 ID');
    if (options['--run'] && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options['--run'])) throw new Error('运行 ID 必须是规范 UUID v4');
    if (options['--date']) {
        const date = options['--date'];
        const parsed = new Date(`${date}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime())
            || parsed.toISOString().slice(0, 10) !== date) throw new Error('日期必须是有效的 YYYY-MM-DD 日历日期');
    }
    const events = readUsageEvents(path.resolve(options['--dir'] || Config.FILES.llmUsageDir)).filter(event => {
        if (options['--run'] && event.runId !== options['--run']) return false;
        if (options['--paper'] && usagePaperKey(event.paperId) !== usagePaperKey(options['--paper'])) return false;
        if (options['--stage'] && event.stage !== options['--stage']) return false;
        if (options['--date']) {
            const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(event.at));
            const date = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
            if (date !== options['--date']) return false;
        }
        return true;
    });
    const result = summarizeLlmUsage(events);
    console.log(JSON.stringify(result, null, 2));
    return result;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main, readUsageEvents };

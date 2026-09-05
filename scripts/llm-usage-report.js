#!/usr/bin/env node
'use strict';
const { requireExternalRuntime } = require('./env-loader.js');
requireExternalRuntime('llm-usage-report');
const fs = require('node:fs');
const path = require('node:path');
const Config = require('./config.js');
const { summarizeLlmUsage, VERSION } = require('./lib/llm-usage.js');

function readUsageEvents(directory) {
    if (!fs.existsSync(directory)) return [];
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Usage directory must be a real directory');
    const events = [];
    for (const name of fs.readdirSync(directory).sort()) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error('Unsafe usage event');
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value?.version !== VERSION || !['request', 'disposition'].includes(value.kind)) throw new Error('Invalid usage event schema');
        events.push(value);
    }
    return events;
}

function main(args = process.argv.slice(2)) {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
        const name = args[i];
        if (!['--dir', '--paper', '--stage', '--date'].includes(name) || !args[i + 1]
            || args[i + 1].startsWith('--') || options[name]) throw new Error('Usage: usage:report [--paper ID] [--stage NAME] [--date YYYY-MM-DD] [--dir DIR]');
        options[name] = args[i + 1];
    }
    if (options['--paper'] && !/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(options['--paper'])) throw new Error('Invalid paper ID');
    if (options['--date']) {
        const date = options['--date'];
        const parsed = new Date(`${date}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime())
            || parsed.toISOString().slice(0, 10) !== date) throw new Error('Invalid date');
    }
    const events = readUsageEvents(path.resolve(options['--dir'] || Config.FILES.llmUsageDir)).filter(event => {
        if (options['--paper'] && String(event.paperId || '').replace(/v\d+$/, '') !== options['--paper'].replace(/v\d+$/, '')) return false;
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

'use strict';

// 入口参数白名单。batch/reanalyze 曾静默忽略未知 --flag：例如把
// --retry-failed-readers 少写一个 s，程序会照常跑普通批量分析，用户却以为
// 明确重试已经生效。这里统一拒绝未知参数、缺值参数、重复的单值参数和多余的
// 位置参数，并把用法写进错误信息。
function assertKnownCliArguments(argv, options = {}) {
    const {
        booleanFlags = [], valueFlags = [], repeatableValueFlags = [],
        allowPositional = 0, usage = ''
    } = options;
    const booleans = new Set(booleanFlags);
    const values = new Set(valueFlags);
    const repeatable = new Set(repeatableValueFlags);
    const positionals = [];
    const seenValues = new Set();
    const withUsage = message => new Error(`${message}${usage ? `\n用法: ${usage}` : ''}`);
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!String(argument).startsWith('--')) {
            positionals.push(argument);
            if (positionals.length > allowPositional) {
                throw withUsage(`多余的位置参数: ${argument}`);
            }
            continue;
        }
        if (booleans.has(argument)) continue;
        if (!values.has(argument)) throw withUsage(`未知参数: ${argument}`);
        if (!repeatable.has(argument)) {
            if (seenValues.has(argument)) throw withUsage(`参数不能重复: ${argument}`);
            seenValues.add(argument);
        }
        const value = argv[index + 1];
        if (value === undefined || String(value).startsWith('--')) {
            throw withUsage(`${argument} 缺少参数值`);
        }
        index += 1;
    }
    return positionals;
}

module.exports = { assertKnownCliArguments };

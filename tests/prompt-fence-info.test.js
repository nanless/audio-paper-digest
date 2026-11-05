'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const utils = require('../scripts/utils.js');

const projectRoot = path.join(__dirname, '..');

function withPromptFile(name, content, fn) {
    const relative = path.join('logs', name).split(path.sep).join('/');
    const absolute = path.join(projectRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
    try {
        return fn(relative, absolute);
    } finally {
        fs.rmSync(absolute, { force: true });
    }
}

test('首个围栏标记不是空或 text 时直接报错，不能把后文当模板', () => {
    withPromptFile('prompt-fence-info-json.md', [
        '说明文字',
        '',
        '```json',
        '{"a":1}',
        '```',
        '',
        'AFTER PROSE',
        ''
    ].join('\n'), (relative) => {
        assert.throws(
            () => utils.loadPrompt(relative),
            /首个围栏标记只允许为空或 text/
        );
    });
});

test('裸围栏仍按原规则读取第一个代码块', () => {
    withPromptFile('prompt-fence-plain.md', [
        '说明文字',
        '',
        '```',
        'TEMPLATE BODY',
        '```',
        '',
        'AFTER PROSE',
        ''
    ].join('\n'), (relative) => {
        assert.strictEqual(utils.loadPrompt(relative), 'TEMPLATE BODY');
    });
});

test('text 标记与波浪号围栏仍被接受', () => {
    withPromptFile('prompt-fence-text.md', [
        '说明文字',
        '',
        '```text',
        'TEXT BODY',
        '```',
        ''
    ].join('\n'), (relative) => {
        assert.strictEqual(utils.loadPrompt(relative), 'TEXT BODY');
    });

    withPromptFile('prompt-fence-tilde.md', [
        '说明文字',
        '',
        '~~~~',
        'TILDE BODY',
        '~~~~',
        ''
    ].join('\n'), (relative) => {
        assert.strictEqual(utils.loadPrompt(relative), 'TILDE BODY');
    });
});

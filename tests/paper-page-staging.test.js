'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/paper-page-staging.js');

test('渲染器实现身份绑定来源文件和输出根路径配置', () => {
    const real = api.rendererImplementationIdentity();
    assert.match(real.rendererImplementationSha256, /^[a-f0-9]{64}$/);
    const fileBytes = relative => Buffer.from(`implementation:${relative}`);
    const first = api.rendererImplementationIdentity({ blogBasePath: '/audio-paper-digest-blog',
        readImplementationFile: (_absolute, relative) => fileBytes(relative) });
    const changedFile = api.rendererImplementationIdentity({ blogBasePath: '/audio-paper-digest-blog',
        readImplementationFile: (_absolute, relative) => Buffer.concat([
            fileBytes(relative), Buffer.from(relative === 'scripts/publish-to-blog.py' ? ':changed' : '')
        ]) });
    const changedConfig = api.rendererImplementationIdentity({ blogBasePath: '/another-base',
        readImplementationFile: (_absolute, relative) => fileBytes(relative) });
    assert.notEqual(first.rendererImplementationSha256, changedFile.rendererImplementationSha256);
    assert.notEqual(first.rendererImplementationSha256, changedConfig.rendererImplementationSha256);
    assert.deepEqual(first.files.map(item => item.relativePath), api.rendererImplementationFiles());
});

test('默认渲染器使用私有临时输入文件和受约束的子进程', () => {
    let observedInputFile;
    const rendered = api.defaultRender({ paper: { title: '中文' } }, {
        execFileSync: (command, args, options) => {
            assert.equal(command, 'bash');
            assert.equal(options.input, undefined);
            assert.equal(options.timeout, 60_000);
            assert.equal(options.killSignal, 'SIGKILL');
            assert.equal(args.at(-2), '--input-file');
            observedInputFile = args.at(-1);
            assert.deepEqual(JSON.parse(fs.readFileSync(observedInputFile, 'utf8')),
                { paper: { title: '中文' } });
            assert.equal(fs.statSync(observedInputFile).mode & 0o777, 0o600);
            return Buffer.from('{"markdown":"rendered","assets":[]}');
        }
    });
    assert.deepEqual(rendered, { markdown: 'rendered', assets: [] });
    assert.equal(fs.existsSync(observedInputFile), false);
    assert.equal(fs.existsSync(path.dirname(observedInputFile)), false);
});

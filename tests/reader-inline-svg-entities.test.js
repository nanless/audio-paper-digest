'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const renderer = require('../scripts/lib/reader-inline-svg.js');

function resource(body) {
    const inlineSvg = '<svg xmlns="http://www.w3.org/2000/svg" id="figure" width="160" height="80" viewBox="0 0 160 80">' + body + '</svg>';
    const bytes = Buffer.from(inlineSvg);
    return { kind: 'inline_svg', mediaType: 'image/svg+xml', inlineSvg,
        inlineSvgBytes: bytes.length, inlineSvgSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function makeMinimalPng(width, height) {
    const buf = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    buf[24] = 8;
    buf[25] = 6;
    return buf;
}

function mockSpawn(handler) {
    return (cmd, args, opts) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => true;
        const chunks = [];
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.once('finish', () => queueMicrotask(() => {
            const res = handler(Buffer.concat(chunks), args, opts, cmd);
            child.stdout.end(res.stdout || '');
            child.stderr.end(res.stderr || '');
            child.emit('close', res.code ?? 0);
        }));
        return child;
    };
}

// 真实 Playwright Chromium 像素渲染断言位于 tests/python/test_reader_inline_svg.py；
// 本 JS 套件核验来源描述符绑定、参数透传、静态校验拒绝与渲染输出尺寸/错误边界（不启动浏览器）。
test('官方HTML命名实体及MathML排版描述符与受控渲染参数保持绑定原SVG字节', async () => {
    const source = resource('<foreignObject width="160" height="80"><div xmlns="http://www.w3.org/1999/xhtml"><a href="#figure" title="label">A&nbsp;&lambda;</a><math><mo minsize="1" maxsize="2" lspace="0" rspace="0">&rarr;</mo></math></div></foreignObject>');
    const descriptor = renderer.inlineSvgSourceDescriptor(source, '2610.90001v1');
    assert.equal(descriptor.inlineSvgSourceSha256, source.inlineSvgSha256);

    const seenArgs = [];
    const spawn = mockSpawn((stdinBytes, args) => {
        assert.equal(stdinBytes.toString('utf8'), source.inlineSvg);
        seenArgs.push(args);
        const isHiDpi = args.includes('--hidpi');
        return { code: 0, stdout: makeMinimalPng(isHiDpi ? 480 : 160, isHiDpi ? 240 : 80) };
    });

    const rendered = await renderer.renderOfficialInlineSvg(source, { spawn });
    assert.equal(rendered.inlineSvgSourceSha256, source.inlineSvgSha256);
    assert.equal(rendered.width, 480);
    assert.equal(rendered.height, 240);
    assert.equal(rendered.assetSha256, crypto.createHash('sha256').update(rendered.rawBytes).digest('hex'));
    assert.equal(seenArgs[0].includes('--hidpi'), true);
    assert.equal(seenArgs[0].includes('--deterministic-hidpi'), true);

    const native1x = await renderer.renderOfficialInlineSvg(source, { hidpi: false, spawn });
    assert.equal(native1x.width, 160);
    assert.equal(native1x.height, 80);
    assert.equal(seenArgs[1].includes('--hidpi'), false);
});

test('未知实体和声明实体不能通过标准HTML实体转换进入渲染', async () => {
    for (const body of ['<text>&unknownPaperEntity;</text>', '<!DOCTYPE svg [<!ENTITY custom "secret">]><text>&custom;</text>']) {
        await assert.rejects(renderer.renderOfficialInlineSvg(resource(body)), error => error.code === 'READER_INLINE_SVG_INTEGRITY');
    }
});

test('允许静态链接标签仍拒外链、事件与实体编码的动态样式', async () => {
    for (const body of ['<a href="https://example.com">link</a>', '<a href="#figure" onclick="alert(1)">link</a>',
        '<text style="background:url(&quot;https://example.com/image&quot;)">label</text>']) {
        await assert.rejects(renderer.renderOfficialInlineSvg(resource(body)), error => error.code === 'READER_INLINE_SVG_INTEGRITY');
    }
});

test('原图可见范围超出画布时保留原SVG字节绑定与渲染器尺寸解析', async () => {
    const source = resource('<rect x="-10" y="-5" width="190" height="100" fill="black"/>');
    source.inlineSvg = source.inlineSvg.replace('viewBox=', 'overflow="visible" viewBox=');
    const bytes = Buffer.from(source.inlineSvg);
    source.inlineSvgBytes = bytes.length;
    source.inlineSvgSha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    const spawn = mockSpawn((stdinBytes, args) => {
        assert.equal(stdinBytes.toString('utf8'), source.inlineSvg);
        const isHiDpi = args.includes('--hidpi');
        return { code: 0, stdout: makeMinimalPng(isHiDpi ? 570 : 190, isHiDpi ? 300 : 100) };
    });

    const rendered = await renderer.renderOfficialInlineSvg(source, { spawn });
    assert.equal(rendered.width, 570);
    assert.equal(rendered.height, 300);
    assert.equal(rendered.inlineSvgSourceSha256, source.inlineSvgSha256);
    const native1x = await renderer.renderOfficialInlineSvg(source, { hidpi: false, spawn });
    assert.equal(native1x.width, 190);
    assert.equal(native1x.height, 100);
});

test('超出受控尺寸的实际绘制范围错误与超限PNG尺寸均按完整性错误拒绝', async () => {
    const source = resource('<rect x="-10" y="0" width="5000" height="10"/>');
    await assert.rejects(
        renderer.renderOfficialInlineSvg(source, {
            spawn: mockSpawn(() => ({ code: 1, stderr: 'ValueError: 内联 SVG 实际绘制范围超过受控上限\n' }))
        }),
        error => error.code === 'READER_INLINE_SVG_INTEGRITY'
            && /实际绘制范围超过受控上限/.test(error.cause?.message || '')
    );
    await assert.rejects(
        renderer.renderOfficialInlineSvg(source, {
            spawn: mockSpawn(() => ({ code: 0, stdout: makeMinimalPng(5000, 10) }))
        }),
        error => error.code === 'READER_INLINE_SVG_INTEGRITY'
            && /渲染后的像素尺寸无效/.test(error.message)
    );
});

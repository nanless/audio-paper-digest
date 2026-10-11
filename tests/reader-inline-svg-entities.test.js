'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const renderer = require('../scripts/lib/reader-inline-svg.js');
function resource(body) {
    const inlineSvg = '<svg xmlns="http://www.w3.org/2000/svg" id="figure" width="160" height="80" viewBox="0 0 160 80">' + body + '</svg>';
    const bytes = Buffer.from(inlineSvg);
    return { kind: 'inline_svg', mediaType: 'image/svg+xml', inlineSvg,
        inlineSvgBytes: bytes.length, inlineSvgSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
test('官方HTML命名实体及MathML排版在真实公开渲染后仍绑定原SVG字节', async () => {
    const source = resource('<foreignObject width="160" height="80"><div xmlns="http://www.w3.org/1999/xhtml"><a href="#figure" title="label">A&nbsp;&lambda;</a><math><mo minsize="1" maxsize="2" lspace="0" rspace="0">&rarr;</mo></math></div></foreignObject>');
    const descriptor = renderer.inlineSvgSourceDescriptor(source, '2610.90001v1');
    assert.equal(descriptor.inlineSvgSourceSha256, source.inlineSvgSha256);
    const rendered = await renderer.renderOfficialInlineSvg(source);
    assert.equal(rendered.inlineSvgSourceSha256, source.inlineSvgSha256);
    assert.equal(rendered.width, 160);
    assert.equal(rendered.height, 80);
    assert.equal(rendered.assetSha256, crypto.createHash('sha256').update(rendered.rawBytes).digest('hex'));
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

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
test('原图可见范围超出画布时完整保留负坐标和边缘内容', async () => {
    const source = resource('<rect x="-10" y="-5" width="190" height="100" fill="black"/>');
    source.inlineSvg = source.inlineSvg.replace('viewBox=', 'overflow="visible" viewBox=');
    const bytes = Buffer.from(source.inlineSvg);
    source.inlineSvgBytes = bytes.length;
    source.inlineSvgSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const rendered = await renderer.renderOfficialInlineSvg(source);
    assert.equal(rendered.width, 190);
    assert.equal(rendered.height, 100);
    assert.equal(rendered.inlineSvgSourceSha256, source.inlineSvgSha256);
});
test('原始画布较小时仍拒绝超出受控尺寸的实际绘制范围', async () => {
    const source = resource('<rect x="-10" y="0" width="5000" height="10"/>');
    await assert.rejects(renderer.renderOfficialInlineSvg(source), error =>
        error.code === 'READER_INLINE_SVG_INTEGRITY'
        && /实际绘制范围超过受控上限/.test(error.cause?.message || ''));
});

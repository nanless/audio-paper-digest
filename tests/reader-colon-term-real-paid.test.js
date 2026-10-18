'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const fixture = require('./fixtures/reader-gonzalez-g2694-real-paid.json');
const bridge = fixture.draft.conceptBridges.find(item => item.terms.includes('持续元音/a:/'));
const render = (terms, explanation = bridge.explanation) => `**${terms.join(' × ')}：** ${explanation}`;
test('真实已付稿持续元音 /a:/ 完整术语前缀匹配，音标及来源保持原字节', () => {
    assert.equal(crypto.createHash('sha256').update(fixture.sourceText).digest('hex'), fixture.sourceTextSha256);
    assert(fixture.sourceText.includes('sustained /a:/'));
    assert(fixture.sourceText.includes('reading passage “North Wind and the Sun”'));
    const block = render(bridge.terms);
    assert.equal(deep.findReaderBridgeParagraph([block], bridge.terms), block);
    const normalized = deep.normalizeReaderProseFormatting(block);
    assert.equal(deep.findReaderBridgeParagraph([normalized], bridge.terms), normalized);
    const reverse = render([...bridge.terms].reverse());
    assert.equal(deep.findReaderBridgeParagraph([reverse], bridge.terms), reverse);
});
test('冒号支持仍拒缺术语、增项、错误分组、解释内伪标题和重复完整段落', () => {
    const good = render(bridge.terms);
    for (const block of [render(bridge.terms.slice(0, 2)), render([...bridge.terms, '看图描述']),
        render([bridge.terms[0], bridge.terms[2], bridge.terms[1]]),
        render(['持续元音/a/', ...bridge.terms.slice(1)]),
        '这里是在解释中引用 ' + good, '“' + good + '”']) {
        assert.equal(deep.findReaderBridgeParagraph([block], bridge.terms), null, block);
    }
    assert.equal(deep.findReaderBridgeParagraph([good, good], bridge.terms), null);
    assert.equal(deep.findReaderBridgeParagraph(['**持续元音/a:/：** 双音节重复 × 朗读：解释'], bridge.terms), null);
});

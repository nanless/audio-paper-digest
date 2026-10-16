'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeSignedReaderClaim: display } = require('../scripts/lib/reader-signed-raw-claim-display');
const deep = require('../scripts/deep-analyzer');
const real = require('./fixtures/reader-signed-raw-claim-vst-real.json');
const raw = '这张图实际可见的是七个框与实线箭头加一条虚线。';
const shown = '这张图实际可见的是 7 个框与实线箭头加 1 条虚线。';
test('实际VST完整paid节点中的受拒前缀逐字映射当前正式Reader', () => {
    assert(real.rawNode.includes(real.rawClaim));
    assert.equal(display(real.rawClaim, real.rawNode), real.renderedClaim);
    assert(display(real.rawNode, real.rawNode).includes(real.renderedClaim));
    assert(real.currentActualFullClause.startsWith(real.renderedClaim));
    // The historic producer retained this idiomatic tail. Do not claim that
    // the whole current sentence equals a newly recomputed numeral projection.
    assert(real.currentActualFullClause.includes('一条虚线'));
});
test('公共数词诊断后再排版的顺序投影覆盖两个真实数词', () => {
    const node = '读图说明。\n\n' + raw + '上排和下排的证据仍分别解释。';
    assert.equal(display(raw, node), shown);
    assert(display(node, node).includes(shown));
    assert.equal(node, '读图说明。\n\n' + raw + '上排和下排的证据仍分别解释。');
});
test('没有定量诊断的原句保持现行纯formatter兼容', () => {
    for (const claim of ['模型使用Transformer编码器。', '颜色表示保留权重，点的大小表示跨环境变异。',
        '自动转录和原标注仅作 مراج辅助，所有新增事件都经人工核验。',
        '数值为 0.169 dB，URL 为 https://example.org/a_b 。'])
        assert.equal(display(claim, claim), deep.normalizeReaderProseFormatting(claim));
});
test('八个和数字4不会被猜作七个或正常显示7', () => {
    const eight = raw.replace('七个', '八个'), four = raw.replace('七个', '4 个');
    assert.notEqual(display(eight, eight), shown);
    assert(display(eight, eight).includes('8 个框'));
    assert.notEqual(display(four, four), shown);
    assert(display(four, four).includes('4 个框'));
    assert.throws(() => display(raw, eight), /逐字存在/);
});
test('不删除词内空白，不用近似全文或另一个节点补原句', () => {
    const spaced = '模 型显示七个框。', compact = '模型显示七个框。';
    assert.notEqual(display(spaced, spaced), display(compact, compact));
    assert(display(spaced, spaced).includes('模 型'));
    for (const node of [raw.replace('七个', '七 个'), raw.slice(1), '同文的另一段包含七个框，但没有受拒原句。'])
        assert.throws(() => display(raw, node), /逐字存在/);
    assert.throws(() => display('', raw), /逐字存在/);
    assert.throws(() => display(raw, null), /逐字存在/);
});
test('非计数惯用语与引用/代码沿用公共诊断的原保护', () => {
    for (const claim of ['一对一映射保持一致，每一步统一处理。', '这是一位研究者的说明。',
        '原句：“图中有七个框。”', '代码 `七个框` 保持原样。'])
        assert.equal(display(claim, claim), deep.normalizeReaderProseFormatting(claim));
});
test('重复的裸句和引文不能借同一反馈投影编辑两处', () => {
    const claim = '图中实际有七个框';
    const node = '图中实际有七个框。原文例句：“图中实际有七个框。”';
    assert.throws(() => display(claim, node), /须唯一/);
    assert.equal(display(node, node), '图中实际有 7 个框。原文例句：“图中实际有七个框。”');
});
test('唯一引文也不能借同节点其它句的七个诊断投影为数字', () => {
    const claim = '图中实际有七个框';
    const node = '图中实际有 7 个框。另一图有七个框。原文例句：“图中实际有七个框。”';
    assert.equal(node.split(claim).length - 1, 1);
    assert.throws(() => display(claim, node), /完整节点上下文保护/);
});
test('公共NFKC改变原始偏移时拒绝借归一化偏移猜绑定', () => {
    const node = 'ﬀ之后图中实际有七个框。';
    assert.throws(() => display('图中实际有七个框', node), /原始节点偏移/);
});
test('引文或代码的不同空白不能借另句排版等价结果', () => {
    const claim = 'HE-NAC七个框';
    for (const node of ['HE-NAC 七个框。引文：“HE-NAC七个框。”',
        'HE-NAC 七个框。代码 `HE-NAC七个框` 保留原样。'])
        assert.throws(() => display(claim, node), /上下文保护|边界排版/);
});
test('旧HE正文与真实VST前缀均有唯一完整节点位置证明', () => {
    const claim = 'HE-NAC在语音路径中比较七个框。';
    const node = '前句。\n\n' + claim + '\n\n后句。';
    assert.equal(display(claim, node), 'HE-NAC 在语音路径中比较 7 个框。');
    assert.equal(display(real.rawClaim, real.rawNode), real.renderedClaim);
});
test('原节点含保留位置标记或标记引起边界排版变化时不猜范围', () => {
    assert.throws(() => display('七个框', '\uE000\uE001\uE002\uE003七个框'), /位置标记/);
    assert.throws(() => display('七个', '模型七个框。'), /边界排版|上下文保护/);
});

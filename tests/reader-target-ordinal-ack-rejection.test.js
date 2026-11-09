'use strict';
// 2026-11-09 日更 2611.09279/2611.06074/2611.06010 的普通序号 ACK 全部是裸 JSON，
// 没有围栏或前后说明；它们分别被「令牌被抄错」和「对象节点被写成 JSON 字符串」拒掉。
// 这里固定三件事：严格判定一条不放宽、拒绝原因必须指向真实缺陷、下一轮的格式反馈
// 必须带裸 JSON / 逐字令牌 / 同类型 value 三条要求。
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const repair = require('../scripts/lib/reader-repair');
const ordinal = require('../scripts/lib/reader-target-ordinal-patch');
const format = require('../scripts/lib/reader-ordinal-format');
const deep = require('../scripts/deep-analyzer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-target-ordinal-paid-20261027-real.json.gz'))));

function inputs(fixtureCase) {
    const source = JSON.parse(Buffer.from(fixtureCase.realOldRequest.rawBase64, 'base64'));
    const draft = structuredClone(source.draft), identity = structuredClone(source.identity);
    const targets = source.repairTargets.map((target, index) => ({ targetOrdinal: index + 1,
        path: target.path, oldSha256: target.oldSha256,
        valueType: Array.isArray(target.value) ? 'array' : target.value === null ? 'null' : typeof target.value }));
    const request = { ...ordinal.requestHeader(), templateSha256: ordinal.TEMPLATE_SHA,
        requestSalt: 'a'.repeat(32), identitySha256: repair.hashDraft(identity),
        candidateEnvelopeSha256: sha('SYNTHETIC rejection test parent; no source or dispatch permission'),
        draftSha256: repair.hashDraft(draft), targets };
    request.requestToken = sha(JSON.stringify({ domain: ordinal.requestHeader(), requestSalt: request.requestSalt,
        identitySha256: request.identitySha256, candidateEnvelopeSha256: request.candidateEnvelopeSha256,
        draftSha256: request.draftSha256, orderedTargetsSha256: repair.hashDraft(targets) })).slice(0, 16);
    return { draft, identity, targets, request, source };
}
function node(draft, pointer) {
    if (['/readerTitle', '/oneSentenceThesis'].includes(pointer)) return draft[pointer.slice(1)];
    const m = /^\/(sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(0|[1-9]\d*)(\/(body|explanation|explanationQuote|leadQuote))?$/.exec(pointer);
    const values = draft[m[1]], index = Number(m[2]);
    return m[3] ? values[index][m[4]] : values[index];
}
// 正例值：字符串节点加一句合成说明，对象节点给同类型对象的完整副本。
function values(input) {
    return input.targets.map(target => target.valueType === 'string'
        ? node(input.draft, target.path) + '（合成协议测试）'
        : structuredClone(node(input.draft, target.path)));
}
function ack(input, replacements) {
    return JSON.stringify({ ...ordinal.requestHeader(), requestToken: input.request.requestToken, replacements });
}
function goodReplacements(input) {
    const list = values(input);
    return input.targets.map((target, index) => ({ targetOrdinal: target.targetOrdinal, value: list[index] }));
}
const cases = bundle.fixture.cases;

for (const fixtureCase of cases) {
    test('object node accepts a JSON object and rejects the same object as a JSON string (' + fixtureCase.paperId + ')', () => {
        const input = inputs(fixtureCase), replacements = goodReplacements(input);
        const compiled = ordinal.compileReaderTargetOrdinalPatch(input.draft, input.request, ack(input, replacements));
        assert.equal(compiled.patch.replacements.length, input.targets.length);
        assert.equal(compiled.proof.mapping.length, input.targets.length);
        const objectIndex = input.targets.findIndex(target => target.valueType === 'object');
        assert.ok(objectIndex >= 0, 'fixture keeps at least one object target');
        const stringified = structuredClone(replacements);
        stringified[objectIndex].value = JSON.stringify(stringified[objectIndex].value);
        assert.throws(() => ordinal.compileReaderTargetOrdinalPatch(input.draft, input.request, ack(input, stringified)),
            new RegExp('replacement type mismatch: targetOrdinal ' + (objectIndex + 1)
                + ' \\(' + input.targets[objectIndex].path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\) is object, but the ACK value is string; '
                + 'send the JSON object itself, not a string containing JSON'));
        // 2026-11-09 的误报就是把这条拒绝写成「stale node or replacement type mismatch」。
        assert.throws(() => ordinal.compileReaderTargetOrdinalPatch(input.draft, input.request, ack(input, stringified)),
            error => error.code === 'READER_TARGET_ORDINAL_REJECTED' && !/stale/.test(error.message));
    });

    test('a genuinely replaced node is still stale, with the stale wording (' + fixtureCase.paperId + ')', () => {
        const input = inputs(fixtureCase), target = input.targets[0];
        // 草稿本身仍与 request.draftSha256 一致，只有目标描述里的 oldSha256 过时：
        // 这正是「节点已被前一次补丁替换」的形态，必须报 stale 而不是类型不符。
        const staleRequest = structuredClone(input.request);
        staleRequest.targets[0].oldSha256 = 'f'.repeat(64);
        staleRequest.requestToken = sha(JSON.stringify({ domain: ordinal.requestHeader(),
            requestSalt: staleRequest.requestSalt, identitySha256: staleRequest.identitySha256,
            candidateEnvelopeSha256: staleRequest.candidateEnvelopeSha256,
            draftSha256: staleRequest.draftSha256, orderedTargetsSha256: repair.hashDraft(staleRequest.targets) })).slice(0, 16);
        assert.notEqual(repair.hashDraft(node(input.draft, target.path)), staleRequest.targets[0].oldSha256);
        assert.throws(() => ordinal.compileReaderTargetOrdinalPatch(input.draft, staleRequest, ack(input, goodReplacements(input))),
            error => error.code === 'READER_TARGET_ORDINAL_REJECTED' && /stale target/.test(error.message)
                && !/replacement type mismatch/.test(error.message));
    });
}

test('a mis-copied requestToken names the real defect and stays rejected', () => {
    const input = inputs(cases[0]), replacements = goodReplacements(input);
    const short = input.request.requestToken.slice(0, -1);
    assert.equal(short.length, 15);
    assert.throws(() => ordinal.compileReaderTargetOrdinalPatch(input.draft, input.request,
        JSON.stringify({ ...ordinal.requestHeader(), requestToken: short, replacements })),
        /requestToken must be this request's 16-character lowercase hex value \(received 15 chars\)/);
    // 16 位但不是本次值的令牌仍由 nonce 比对拒绝，没有因为说明变细而放宽。
    const other = sha('another request').slice(0, 16);
    assert.notEqual(other, input.request.requestToken);
    assert.doesNotThrow(() => ordinal.parseAck(JSON.stringify({ ...ordinal.requestHeader(),
        requestToken: other, replacements }), input.request));
    assert.throws(() => ordinal.compileReaderTargetOrdinalPatch(input.draft, input.request,
        JSON.stringify({ ...ordinal.requestHeader(), requestToken: other, replacements })), /wrong request nonce/);
});

test('the bare-JSON rule rejects fences, prose and a second object; a bare object still parses', () => {
    const input = inputs(cases[0]), replacements = goodReplacements(input), bare = ack(input, replacements);
    assert.doesNotThrow(() => ordinal.parseAck(bare, input.request));
    assert.throws(() => ordinal.parseAck('```json\n' + bare + '\n```', input.request), /bare JSON without a wrapper/);
    assert.throws(() => ordinal.parseAck('以下是本次补丁：\n' + bare, input.request), /bare JSON without a wrapper/);
    // 前后都有花括号的两个对象仍不是「单个对象」，由严格 JSON 解析拒绝。
    assert.throws(() => ordinal.parseAck(bare + '\n{}', input.request), /不是有效的 JSON/);
    assert.throws(() => ordinal.parseAck(bare.replace(/"contract":"reader-target-ordinal-patch"/,
        '"contract":"reader-target-ordinal-patch","unexpected":1'), input.request), /不是有效的 JSON|unexpected object fields/);
});

test('replacement count out of range names the allowed 1..8 range', () => {
    const input = inputs(cases[0]);
    assert.throws(() => ordinal.parseAck(ack(input, []), input.request),
        /ACK must carry 1\.\.8 replacements \(received 0\)/);
    const tooMany = Array.from({ length: 9 }, (_, index) => ({ targetOrdinal: 1, value: 'x' + index }));
    assert.throws(() => ordinal.parseAck(ack(input, tooMany), input.request),
        /ACK must carry 1\.\.8 replacements \(received 9\)/);
});

test('the ordinal rejection feedback carries the three machine-format requirements', () => {
    const rejection = 'Reader patch rejected: Reader ordinal patch refused: replacement type mismatch: '
        + 'targetOrdinal 1 (/tableBindings/1) is object, but the ACK value is string; '
        + 'send the JSON object itself, not a string containing JSON';
    const legacy = '\n\n上一局部补丁拒绝诊断（仅用于修正响应格式）：\n' + rejection + '\n'
        + '旧诊断中的路径、received 与 expected-current 仅解释上次拒绝，不授予修改目标。'
        + '本次请求的当前目标清单及 draftSha256、oldSha256 才是唯一有效依据；不得照抄旧 SHA 或新增目标。';
    // 非序号路径的文案必须逐字不变，避免影响既有修复反馈。
    assert.equal(deep.readerPatchRejectionPromptTail(rejection, { ordinal: false }), legacy);
    const ordinalTail = deep.readerPatchRejectionPromptTail(rejection, { ordinal: true });
    assert.ok(ordinalTail.startsWith(legacy));
    assert.match(ordinalTail, /裸 JSON 对象：不要 Markdown 围栏、前后说明或第二个对象/);
    assert.match(ordinalTail, /requestToken 必须逐字复制本次请求给出的 16 位小写十六进制值/);
    assert.match(ordinalTail, /对象节点直接给 JSON 对象本身，不能给被字符串包裹的 JSON/);
    assert.match(ordinalTail, /不授予修改目标/);
    assert.equal(deep.readerPatchRejectionPromptTail('', { ordinal: true }), '');
    assert.equal(deep.readerPatchRejectionPromptTail('   ', { ordinal: true }), '');
    assert.equal(deep.readerPatchRejectionPromptTail(null, { ordinal: true }), '');
});

test('the ordinal prompt template and contract bytes are unchanged', () => {
    // 提示词模板参与 TEMPLATE_SHA 与既有付费记录的冷核重放，格式要求只能进反馈。
    assert.equal(ordinal.TEMPLATE_SHA, '686238be8444925c79d37f5808bc5a7cb1b56c5151eed9329213eb350720283e');
    assert.equal(ordinal.CONTRACT, format.wireHeader().contract);
    assert.ok(!format.template().includes('裸 JSON'));
});

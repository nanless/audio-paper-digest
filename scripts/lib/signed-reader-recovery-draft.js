'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
// 此输入只由已核验的 signed Reader seed 提供；不接受来源不明的普通草稿。
function convert(seed) {
    const { article, plan } = JSON.parse(seed.initialDraft);
    let view = article;
    for (const bridge of plan.conceptBridges || []) {
        assert.equal(view.split(bridge.explanation).length, 2, '术语解释必须对应唯一的已签原句');
        view = view.replace(bridge.explanation, bridge.marker);
    }
    const headings = [...view.matchAll(/^### (.+)\r?$/gm)];
    assert.equal(headings.length, plan.sections.length, '已签正文的章节数量与原写作计划不同');
    const sections = plan.sections.map((section, index) => {
        assert.equal(headings[index][1], section.heading, '已签正文的章节标题或顺序与原计划不同');
        return { kind: section.kind, heading: section.heading,
            body: view.slice(headings[index].index + headings[index][0].length,
                headings[index + 1]?.index ?? view.length).trim() };
    });
    return { version: 3, readerTitle: plan.readerTitle, oneSentenceThesis: plan.oneSentenceThesis,
        sections, conceptBridges: structuredClone(plan.conceptBridges),
        figurePlacements: plan.figurePlacements.map(placement => Object.fromEntries(
            ['figureOrdinal', 'targetKind', 'marker', 'focusPoints']
                .map(key => [key, structuredClone(placement[key])]))),
        tableBindings: plan.tableBindings.map(binding => ({ tableIndex: binding.tableIndex,
            sourceType: binding.sourceType, sourceTableOrdinal: binding.sourceTableOrdinal,
            sourceQuotes: structuredClone(binding.sourceQuotes),
            cellBindings: binding.cellBindings.map(cell => Object.fromEntries(
                ['renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn']
                    .map(key => [key, cell[key]]))) })),
        formulaBindings: (plan.formulaBindings || []).map(binding => ({
            formulaOrdinal: binding.formulaOrdinal, targetKind: binding.targetKind, marker: binding.marker })) };
}
const DISPLAY_CONTRACT = 'signed-reader-minimal-draft-display-v1';
function minimalDisplay(seed) {
    const draft = convert(seed);
    for (const binding of draft.tableBindings) {
        binding.sourceQuotes = (binding.sourceQuotes || []).map(value => {
            if (typeof value === 'string') return value;
            assert.ok(value && typeof value.quote === 'string', '原来源引文格式无效');
            assert.equal(crypto.createHash('sha256').update(value.quote).digest('hex'),
                value.sourceQuoteSha256, '原来源引文摘要不同');
            return value.quote;
        });
    }
    const text = JSON.stringify(draft);
    return { text, fields: { signedRevisionDisplayContract: DISPLAY_CONTRACT,
        signedRevisionDisplaySha256: crypto.createHash('sha256').update(text).digest('hex') } };
}
// 不依赖诊断迁移开关；只读核验旧实现的真实候选与已记请求，不迁移或重置任何账。
function assertNoPaidLegacyDisplayCandidate(directory, identity) {
    const proofReads = require('./reader-proof-read-scope');
    return proofReads.withReadOnlyReaderReceiptRetry(
        () => assertNoPaidLegacyDisplayCandidateInternal(directory, identity));
}
function assertNoPaidLegacyDisplayCandidateInternal(directory, identity) {
    const repair = require('./reader-repair');
    repair.readFailedCandidateEnvelope(directory, identity);
    let names;
    try { names = fs.readdirSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
        const record = repair.readFailedCandidateEnvelope(directory, null, path.join(directory, name));
        if (!record) throw new Error('旧修订候选在检查期间消失');
        const old = record.envelope.identity;
        if (!['paperId', 'contentMode', 'sourceSha256', 'inputFingerprint', 'freshAnalysis']
            .every(key => isDeepStrictEqual(old[key], identity[key]))) continue;
        const payload = record.envelope.payload;
        if (payload.attempts > 0 || payload.fullAttempts > 0 || payload.transportFailures > 0
            || payload.explicitReaderRetryRound || payload.draft || payload.rawDraft) {
            throw new Error('原定向修订已有请求或恢复草稿，必须沿原输入身份续跑，不能更换输入显示来重置请求次数');
        }
    }
}
module.exports = { convert, minimalDisplay, DISPLAY_CONTRACT, assertNoPaidLegacyDisplayCandidate };

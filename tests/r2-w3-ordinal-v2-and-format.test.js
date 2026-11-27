'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const codec = require('../scripts/lib/protocol-codec');
const ordinalFormat = require('../scripts/lib/reader-ordinal-format');
const ordinal = require('../scripts/lib/reader-target-ordinal-patch');
const recordFormat = require('../scripts/lib/reader-record-format');
const repair = require('../scripts/lib/reader-repair');
const legacyRecords = require('../scripts/lib/reader-legacy-records.json');
const resourceProse = require('../scripts/lib/reader-resource-prose');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

const PRIOR_FP = '334889bc92083a45f374ac667bbb4580aa703ae3a2ef7df1001e2df41e7cb84d';
const PRIOR_TPL_SHA = '686238be8444925c79d37f5808bc5a7cb1b56c5151eed9329213eb350720283e';
const LEGACY_TPL_SHA = 'b8eaceefa73682f94c351e348f390ad4e89e04363de760473f10a892bc78f122';
const EXPECTED_V2_FP = 'f39577085c3ad9331ecebc443a33b1ab4aa6c1cdc3c8a1252b22b3c82ebe8b47';

function buildMinimalCurrentDraft(overrides = {}) {
    const header = codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
    return {
        ...header,
        readerTitle: '音频表示学习的稀疏编码与实验验证',
        oneSentenceThesis: '本文通过来源可核对的结构化编码框架提升音频表征效率。',
        sections: [{ kind: 'problem', heading: '音频表征的稀疏瓶颈', body: '示例正文。' }],
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: [],
        ...overrides
    };
}

function buildSyntheticOrdinalRequest(header, draft) {
    const targetPath = '/sections/0/body';
    const targetValue = draft.sections[0].body;
    const targets = [{
        targetOrdinal: 1,
        path: targetPath,
        oldSha256: repair.hashDraft(targetValue),
        valueType: 'string'
    }];
    const request = {
        ...header,
        templateSha256: ordinalFormat.templateSha(header),
        requestSalt: 'b'.repeat(32),
        identitySha256: 'c'.repeat(64),
        candidateEnvelopeSha256: 'd'.repeat(64),
        draftSha256: repair.hashDraft(draft),
        targets
    };
    request.requestToken = sha(JSON.stringify({
        domain: ordinalFormat.tokenDomain(request),
        requestSalt: request.requestSalt,
        identitySha256: request.identitySha256,
        candidateEnvelopeSha256: request.candidateEnvelopeSha256,
        draftSha256: request.draftSha256,
        orderedTargetsSha256: repair.hashDraft(request.targets)
    })).slice(0, 16);
    return request;
}

test('Task 1: Node and Python protocol codecs agree on ordinal static-prefix-v2 and preserve historical schemas', () => {
    const currentHeader = ordinalFormat.wireHeader();
    assert.equal(currentHeader.contract, 'reader-target-ordinal-patch');
    assert.equal(currentHeader.schemaFingerprint, EXPECTED_V2_FP);
    assert.equal(codec.declaredSchema(currentHeader.contract, 'reader-target-ordinal-patch', currentHeader.schemaFingerprint).templateLayout,
        'static-prefix-v2');

    const priorHeader = ordinalFormat.priorModernWireHeader();
    assert.deepEqual(priorHeader, {
        contract: 'reader-target-ordinal-patch',
        schemaFingerprint: PRIOR_FP
    });
    assert.equal(codec.hasValidHeader(priorHeader, 'reader-target-ordinal-patch'), true);
    assert.equal(codec.isCurrentHeader(priorHeader, 'reader-target-ordinal-patch'), false);
    assert.equal(codec.declaredSchema(priorHeader.contract, 'reader-target-ordinal-patch', PRIOR_FP).templateLayout, undefined);

    const legacyHeader = ordinalFormat.oldWireHeader();
    assert.deepEqual(legacyHeader, {
        contract: 'reader-target-ordinal-patch-v1',
        version: 1
    });
    assert.equal(codec.hasValidHeader(legacyHeader, 'reader-target-ordinal-patch'), true);
    assert.equal(codec.isCurrentHeader(legacyHeader, 'reader-target-ordinal-patch'), false);

    // reader-legacy-records.json must stay byte-exact for historical cold replay.
    assert.equal(sha(legacyRecords.ordinal.template), LEGACY_TPL_SHA);
    assert.equal(legacyRecords.ordinal.templateSha256, LEGACY_TPL_SHA);

    const pyCheck = JSON.parse(execFileSync('bash', ['scripts/python-runtime.sh', '-c', [
        'import json, sys',
        'sys.path.insert(0, "scripts")',
        'import protocol_codec as pc',
        'print(json.dumps({',
        '  "current": pc.record_header("reader-target-ordinal-patch", "reader-target-ordinal-patch"),',
        '  "prior": pc.historical_header("reader-target-ordinal-patch", "bounded-existing-nodes", "' + PRIOR_FP + '"),',
        '  "legacy": pc.historical_header("reader-target-ordinal-patch", "bounded-existing-nodes", None),',
        '  "priorValid": pc.has_valid_header({"contract": "reader-target-ordinal-patch", "schemaFingerprint": "' + PRIOR_FP + '"}, "reader-target-ordinal-patch"),',
        '  "priorCurrent": pc.is_current_header({"contract": "reader-target-ordinal-patch", "schemaFingerprint": "' + PRIOR_FP + '"}, "reader-target-ordinal-patch"),',
        '  "registeredCount": len(pc.registered_headers("reader-target-ordinal-patch"))',
        '}))'
    ].join('\n')], { cwd: ROOT, encoding: 'utf8' }));

    assert.deepEqual(pyCheck.current, currentHeader);
    assert.deepEqual(pyCheck.prior, priorHeader);
    assert.deepEqual(pyCheck.legacy, legacyHeader);
    assert.equal(pyCheck.priorValid, true);
    assert.equal(pyCheck.priorCurrent, false);
    assert.equal(pyCheck.registeredCount, 3);
});

test('Task 1: three-generation template, header, tokenDomain, and completionWireHeader dispatch is exact', () => {
    const legacy = ordinalFormat.oldWireHeader();
    const prior = ordinalFormat.priorModernWireHeader();
    const current = ordinalFormat.wireHeader();

    // Legacy v1
    assert.equal(ordinalFormat.isModernWire(legacy), false);
    assert.equal(ordinalFormat.isCurrentWire(legacy), false);
    assert.equal(ordinalFormat.templateSha(legacy), LEGACY_TPL_SHA);
    assert.equal(ordinalFormat.template(legacy), legacyRecords.ordinal.template);
    assert.equal(ordinalFormat.tokenDomain(legacy), 'reader-target-ordinal-patch-v1');
    assert.deepEqual(ordinalFormat.recordHeader(legacy), { contract: 'reader-target-ordinal-patch-v1' });
    assert.deepEqual(ordinalFormat.compilationHeader(legacy), { contract: 'reader-target-ordinal-compilation-v1' });
    assert.deepEqual(ordinalFormat.standardPatchHeader(legacy), { version: 1 });

    // Historical 334889bc... (2026-11-03..2026-11-27)
    assert.equal(ordinalFormat.isModernWire(prior), true);
    assert.equal(ordinalFormat.isCurrentWire(prior), false);
    assert.equal(ordinalFormat.templateSha(prior), PRIOR_TPL_SHA);
    assert.deepEqual(ordinalFormat.tokenDomain(prior), prior);
    assert.deepEqual(ordinalFormat.recordHeader(prior), codec.recordHeader('reader-target-ordinal-record', 'reader-target-ordinal-record'));
    assert.deepEqual(ordinalFormat.compilationHeader(prior), codec.recordHeader('reader-target-ordinal-compilation', 'reader-target-ordinal-compilation'));
    assert.deepEqual(ordinalFormat.standardPatchHeader(prior), codec.recordHeader('reader-node-patch', 'reader-node-patch'));

    // Current static-prefix-v2
    assert.equal(ordinalFormat.isModernWire(current), true);
    assert.equal(ordinalFormat.isCurrentWire(current), true);
    assert.equal(ordinalFormat.templateSha(current), ordinal.TEMPLATE_SHA);
    assert.notEqual(ordinalFormat.templateSha(current), PRIOR_TPL_SHA);
    assert.notEqual(ordinalFormat.templateSha(current), LEGACY_TPL_SHA);
    assert.deepEqual(ordinalFormat.tokenDomain(current), current);

    // completionWireHeader + matchesStage accept legacy, prior 334889bc..., and current v2; reject tampered headers.
    const modernCompHeader = codec.recordHeader('reader-target-ordinal-compilation', 'reader-target-ordinal-compilation');
    const priorCompletion = { ...modernCompHeader, ordinalProtocol: prior };
    const currentCompletion = { ...modernCompHeader, ordinalProtocol: current };
    const legacyCompletion = { contract: 'reader-target-ordinal-compilation-v1' };
    assert.deepEqual(ordinalFormat.completionWireHeader(priorCompletion), prior);
    assert.deepEqual(ordinalFormat.completionWireHeader(currentCompletion), current);
    assert.deepEqual(ordinalFormat.completionWireHeader(legacyCompletion), legacy);

    assert.equal(ordinalFormat.matchesStage(
        { ordinalPatchContract: prior.contract, ordinalPatchSchemaFingerprint: prior.schemaFingerprint },
        { contracts: { readerTargetOrdinalPatch: prior.contract } },
        priorCompletion
    ), true);
    assert.equal(ordinalFormat.matchesStage(
        { ordinalPatchContract: current.contract, ordinalPatchSchemaFingerprint: current.schemaFingerprint },
        { contracts: { readerTargetOrdinalPatch: current.contract } },
        currentCompletion
    ), true);
    assert.equal(ordinalFormat.matchesStage(
        { ordinalPatchContract: current.contract, ordinalPatchSchemaFingerprint: current.schemaFingerprint },
        { contracts: { readerTargetOrdinalPatch: current.contract } },
        priorCompletion
    ), false);

    // Modern completion must reject legacy v1 ordinalProtocol, unknown fingerprint, or extra keys.
    for (const badProtocol of [
        legacy,
        { contract: current.contract, schemaFingerprint: '0'.repeat(64) },
        { ...prior, extra: true },
        null
    ]) {
        assert.throws(() => ordinalFormat.completionWireHeader({ ...modernCompHeader, ordinalProtocol: badProtocol }),
            /Current completion lacks its exact request format/);
    }
});

test('Task 1: static-prefix-v2 template enforces KV-cache prefix ordering, Wave-9 rules, and object/string JSON examples', () => {
    const tpl = ordinalFormat.template();
    const currentHeader = ordinalFormat.wireHeader();

    // Every placeholder appears exactly once.
    const placeholders = ['mechanicalContract', 'evidence', 'targets', 'feedback', 'requestToken'];
    for (const name of placeholders) {
        const matches = tpl.match(new RegExp(`\\{\\{${name}\\}\\}`, 'g')) || [];
        assert.equal(matches.length, 1, `placeholder {{${name}}} must appear exactly once`);
    }

    // Strict ordering: static prefix -> mechanicalContract -> evidence -> targets -> feedback -> requestToken at very end.
    const idx = Object.fromEntries(placeholders.map(name => [name, tpl.indexOf(`{{${name}}}`)]));
    assert.ok(idx.mechanicalContract < idx.evidence, 'mechanicalContract before evidence');
    assert.ok(idx.evidence < idx.targets, 'evidence before targets');
    assert.ok(idx.targets < idx.feedback, 'targets before feedback');
    assert.ok(idx.feedback < idx.requestToken, 'feedback before requestToken');
    assert.ok(tpl.endsWith('本次请求标识（必须原样填入响应 JSON 的 requestToken 字段）：{{requestToken}}'),
        'requestToken must be placed at the very end of the template');

    // Static prefix before the first placeholder must contain zero placeholders and exceed 1,024 tokens.
    const staticPrefix = tpl.slice(0, tpl.indexOf('{{'));
    assert.ok(!staticPrefix.includes('{{'), 'static prefix must have no dynamic placeholders');
    assert.ok(staticPrefix.length >= 1600, `static prefix should be >=1600 chars for >1024 tokens, got ${staticPrefix.length}`);
    const cjkChars = (staticPrefix.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = staticPrefix.length - cjkChars;
    const conservativeTokenEstimate = Math.round(0.75 * cjkChars + 0.35 * otherChars);
    assert.ok(conservativeTokenEstimate >= 1024,
        `conservative static prefix token estimate must be >= 1024, got ${conservativeTokenEstimate} (len=${staticPrefix.length}, cjk=${cjkChars})`);

    // Static prefix embeds exact current header, both string & object value examples, and Wave-9 rules.
    assert.ok(staticPrefix.includes(JSON.stringify(currentHeader.contract)));
    assert.ok(staticPrefix.includes(JSON.stringify(currentHeader.schemaFingerprint)));
    assert.ok(staticPrefix.includes('"targetOrdinal":1,"value":"'));
    assert.ok(staticPrefix.includes('"targetOrdinal":2,"value":{"tableIndex":1,'));
    assert.ok(staticPrefix.includes('grounding'));
    assert.ok(staticPrefix.includes('rollout'));
    assert.ok(staticPrefix.includes('alone'));
    assert.ok(staticPrefix.includes('noisy'));
    assert.ok(staticPrefix.includes('950 汉字'));
    assert.ok(staticPrefix.includes('####'));
    assert.ok(staticPrefix.includes('source_quotes'));
    assert.ok(staticPrefix.includes('implementationSpecs'));

    // Multi-round KV cache stability: two rounds of the same paper share everything up through {{evidence}},
    // and naturalResourceProse overlay appends strictly at the tail without altering the static prefix.
    const render = ({ token, targets, feedback, evidence, mech, natural = false }) => {
        const vals = { requestToken: token, targets, feedback, evidence, mechanicalContract: mech };
        return resourceProse.renderPrompt(
            tpl.replace(/\{\{(requestToken|targets|feedback|evidence|mechanicalContract)\}\}/g, (_, k) => vals[k]),
            natural
        );
    };
    const stableEvidence = 'TABLE_1: Metric A = 91.2%\n'.repeat(200);
    const stableMech = '至少 5–9 节，散文不少于 4500 汉字。';
    const round1 = render({ token: '0123456789abcdef', targets: '[{"targetOrdinal":1}]', feedback: '修第1节', evidence: stableEvidence, mech: stableMech, natural: true });
    const round2 = render({ token: 'fedcba9876543210', targets: '[{"targetOrdinal":1},{"targetOrdinal":2}]', feedback: '修第2节', evidence: stableEvidence, mech: stableMech, natural: true });
    const sharedPrefixEnd = round1.indexOf(stableEvidence) + stableEvidence.length;
    assert.ok(sharedPrefixEnd > staticPrefix.length + 4000);
    assert.equal(round1.slice(0, sharedPrefixEnd), round2.slice(0, sharedPrefixEnd));
    assert.equal(round1.slice(0, staticPrefix.length), staticPrefix);
});

test('Task 1: compileReaderTargetOrdinalPatch compiles legacy, prior 334889bc..., and v2 requests and rejects cross-generation mixes', () => {
    const draft = buildMinimalCurrentDraft();
    for (const header of [ordinalFormat.oldWireHeader(), ordinalFormat.priorModernWireHeader(), ordinalFormat.wireHeader()]) {
        const request = buildSyntheticOrdinalRequest(header, draft);
        const rawAck = JSON.stringify({
            ...header,
            requestToken: request.requestToken,
            replacements: [{ targetOrdinal: 1, value: '修复后的正文内容。' }]
        });
        const compiled = ordinal.compileReaderTargetOrdinalPatch(draft, request, rawAck);
        assert.equal(compiled.after.sections[0].body, '修复后的正文内容。');
        assert.equal(compiled.proof.templateSha256, ordinalFormat.templateSha(header));
    }

    // 1-char trailing-truncation recovery works for BOTH prior 334889bc... (cold replay safety) and current v2.
    for (const header of [ordinalFormat.priorModernWireHeader(), ordinalFormat.wireHeader()]) {
        const request = buildSyntheticOrdinalRequest(header, draft);
        const truncatedAck = JSON.stringify({
            ...header,
            schemaFingerprint: header.schemaFingerprint.slice(0, -1),
            requestToken: request.requestToken,
            replacements: [{ targetOrdinal: 1, value: '单字符尾缺失恢复测试。' }]
        });
        const compiled = ordinal.compileReaderTargetOrdinalPatch(draft, request, truncatedAck);
        assert.equal(compiled.after.sections[0].body, '单字符尾缺失恢复测试。');
    }

    // Cross-generation templateSha256 or ACK header mismatch is strictly rejected.
    const priorReq = buildSyntheticOrdinalRequest(ordinalFormat.priorModernWireHeader(), draft);
    const currentHeader = ordinalFormat.wireHeader();
    const wrongTplPriorReq = { ...priorReq, templateSha256: ordinal.TEMPLATE_SHA };
    const priorAck = JSON.stringify({
        ...ordinalFormat.priorModernWireHeader(),
        requestToken: priorReq.requestToken,
        replacements: [{ targetOrdinal: 1, value: '新正文' }]
    });
    assert.throws(() => ordinal.compileReaderTargetOrdinalPatch(draft, wrongTplPriorReq, priorAck), /invalid original request/);
    const crossHeaderAck = JSON.stringify({
        ...currentHeader,
        requestToken: priorReq.requestToken,
        replacements: [{ targetOrdinal: 1, value: '新正文' }]
    });
    assert.throws(() => ordinal.compileReaderTargetOrdinalPatch(draft, priorReq, crossHeaderAck), /wrong request nonce/);
});

test('Task 1: live 2026-11-27 ordinal completions in deep-analysis-result.json cold-replay cleanly', {
    skip: !fs.existsSync(path.join(ROOT, 'data/current/deep-analysis-result.json'))
}, () => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/current/deep-analysis-result.json'), 'utf8'));
    const ordinalPapers = (data.papers || []).filter(p => p.analysisManifest?.stages?.apiReaderArticle?.ordinalCompletionProof);
    for (const paper of ordinalPapers) {
        const before = JSON.stringify(paper);
        assert.equal(ordinal.validateCompletion(paper), true, `validateCompletion failed for ${paper.arxivId}`);
        assert.equal(JSON.stringify(paper), before, `validateCompletion must not mutate ${paper.arxivId}`);
    }
});

test('Task 2: hexEditDistanceIsOne accepts exact Levenshtein distance 1 lowercase hex edits and rejects everything else', () => {
    const expected = codec.schemaFingerprint('reader-draft');
    const flipHex = ch => (ch === '0' ? '1' : '0');

    // Deletions (63 chars): start, middle, end
    assert.equal(recordFormat.hexEditDistanceIsOne(expected.slice(1), expected), true);
    assert.equal(recordFormat.hexEditDistanceIsOne(expected.slice(0, 31) + expected.slice(32), expected), true);
    assert.equal(recordFormat.hexEditDistanceIsOne(expected.slice(0, -1), expected), true);

    // Insertions (65 chars): start, middle, end
    assert.equal(recordFormat.hexEditDistanceIsOne('a' + expected, expected), true);
    assert.equal(recordFormat.hexEditDistanceIsOne(expected.slice(0, 20) + 'f' + expected.slice(20), expected), true);
    assert.equal(recordFormat.hexEditDistanceIsOne(expected + '0', expected), true);

    // Substitutions (64 chars): start, middle, end
    assert.equal(recordFormat.hexEditDistanceIsOne(flipHex(expected[0]) + expected.slice(1), expected), true);
    assert.equal(recordFormat.hexEditDistanceIsOne(expected.slice(0, 32) + flipHex(expected[32]) + expected.slice(33), expected), true);
    assert.equal(recordFormat.hexEditDistanceIsOne(expected.slice(0, -1) + flipHex(expected[63]), expected), true);

    // Rejections: exact match (distance 0), distance >= 2, transposition, uppercase, non-hex, wrong length
    const firstDiffPairIdx = [...expected].findIndex((ch, i) => i + 1 < expected.length && ch !== expected[i + 1]);
    assert.ok(firstDiffPairIdx >= 0);
    const transposed = expected.slice(0, firstDiffPairIdx) + expected[firstDiffPairIdx + 1] + expected[firstDiffPairIdx] + expected.slice(firstDiffPairIdx + 2);
    const casesToReject = [
        expected, // distance 0
        expected.slice(0, -2), // 2 deletions (len 62)
        expected + 'ab', // 2 insertions (len 66)
        flipHex(expected[0]) + expected.slice(1, 30) + flipHex(expected[30]) + expected.slice(31), // 2 substitutions
        flipHex(expected[0]) + expected.slice(1, -1), // 1 sub + 1 del (len 63)
        transposed, // adjacent transposition = Levenshtein distance 2
        'f'.repeat(64), // random 64-char hex
        expected.slice(0, 10) + expected[10].toUpperCase() + expected.slice(11), // uppercase
        expected.slice(0, -1) + 'g', // non-hex char
        expected.slice(0, -1) + ' ', // whitespace
        '',
        null,
        undefined,
        12345
    ];
    for (const bad of casesToReject) {
        assert.equal(recordFormat.hexEditDistanceIsOne(bad, expected), false, `should reject ${JSON.stringify(bad)}`);
    }
});

test('Task 2: normalizeCurrentDraftFingerprintTypo safely normalizes 1-char copy typos without mutating input or weakening cold replay', () => {
    const currentFp = codec.schemaFingerprint('reader-draft');
    const flipHex = ch => (ch === '0' ? '1' : '0');
    const validBase = buildMinimalCurrentDraft();
    const validWithSpecs = buildMinimalCurrentDraft({
        implementationSpecs: {
            trainingData: '原文未披露',
            computeHardware: '原文未披露',
            keyHyperparams: '原文未披露',
            inferenceCost: '原文未披露',
            openSourceArtifacts: '原文未披露',
            appendixHighlights: '原文未披露'
        }
    });

    const typoVariants = [
        { editKind: 'deletion', fp: currentFp.slice(0, -1) },
        { editKind: 'deletion', fp: currentFp.slice(0, 15) + currentFp.slice(16) },
        { editKind: 'insertion', fp: currentFp.slice(0, 40) + 'a' + currentFp.slice(40) },
        { editKind: 'substitution', fp: currentFp.slice(0, 12) + flipHex(currentFp[12]) + currentFp.slice(13) }
    ];

    for (const base of [validBase, validWithSpecs]) {
        for (const variant of typoVariants) {
            const typoDraft = { ...base, schemaFingerprint: variant.fp };
            const rawBefore = JSON.stringify(typoDraft);

            // Default cold-replay-safe entrypoints MUST STILL REJECT!
            assert.throws(() => recordFormat.draftFormat(typoDraft), /格式头未登记或字段混用/);
            assert.throws(() => recordFormat.draftFormat(typoDraft, { allowCurrentDraftFingerprintTypoNormalization: false }), /格式头未登记或字段混用/);
            assert.equal(recordFormat.isIntegratedDraft(typoDraft), false);
            assert.throws(() => recordFormat.draftFields(typoDraft), /格式头未登记或字段混用/);

            // Dedicated live helper normalizes cleanly without mutating the original object.
            const res = recordFormat.normalizeCurrentDraftFingerprintTypo(typoDraft);
            assert.equal(res.typoFixed, true);
            assert.equal(res.editKind, variant.editKind);
            assert.equal(res.originalFingerprint, variant.fp);
            assert.equal(res.canonicalFingerprint, currentFp);
            assert.equal(res.normalized.schemaFingerprint, currentFp);
            assert.notEqual(res.normalized, typoDraft);
            assert.equal(JSON.stringify(typoDraft), rawBefore, 'original draft object must not be mutated');

            // Opt-in draftFormat succeeds and reports typo provenance without mutating caller input.
            const fmt = recordFormat.draftFormat(typoDraft, { allowCurrentDraftFingerprintTypoNormalization: true });
            assert.equal(fmt.current, true);
            assert.equal(fmt.modern, true);
            assert.equal(fmt.editorialProfile, recordFormat.STRUCTURED_EDITORIAL);
            assert.equal(fmt.header.schemaFingerprint, currentFp);
            assert.equal(fmt.fingerprintTypoFixed, true);
            assert.equal(fmt.originalFingerprint, variant.fp);
            assert.equal(JSON.stringify(typoDraft), rawBefore);
        }
    }

    // Exact match returns typoFixed: false and standard 6-key draftFormat output.
    const exactRes = recordFormat.normalizeCurrentDraftFingerprintTypo(validBase);
    assert.equal(exactRes.typoFixed, false);
    assert.equal(exactRes.canonicalFingerprint, currentFp);
    const exactFmt = recordFormat.draftFormat(validBase, { allowCurrentDraftFingerprintTypoNormalization: true });
    assert.equal(exactFmt.fingerprintTypoFixed, undefined);
    assert.equal(exactFmt.current, true);
});

test('Task 2: historical, unknown, mixed, distance>=2, and malformed drafts are strictly rejected even with opt-in enabled', () => {
    const currentFp = codec.schemaFingerprint('reader-draft');
    const flipHex = ch => (ch === '0' ? '1' : '0');
    const oneCharTypo = currentFp.slice(0, -1);
    const twoCharTypo = currentFp.slice(0, -2);
    const base = buildMinimalCurrentDraft();

    // Historical registered fingerprints must stay historical (never promoted to current!).
    for (const histFp of [recordFormat.OLD_DRAFT_FP, recordFormat.V4_DRAFT_FP, recordFormat.V5_DRAFT_FP]) {
        const histDraft = { ...base, schemaFingerprint: histFp };
        const norm = recordFormat.normalizeCurrentDraftFingerprintTypo(histDraft);
        assert.equal(norm.typoFixed, false);
        assert.equal(norm.normalized.schemaFingerprint, histFp);
        const fmt = recordFormat.draftFormat(histDraft, { allowCurrentDraftFingerprintTypoNormalization: true });
        assert.equal(fmt.current, false);
        assert.equal(fmt.header.schemaFingerprint, histFp);

        // 1-char typo of a historical fingerprint must NOT normalize to current or pass!
        const histTypo = { ...base, schemaFingerprint: histFp.slice(0, -1) };
        assert.equal(recordFormat.normalizeCurrentDraftFingerprintTypo(histTypo).typoFixed, false);
        assert.throws(() => recordFormat.draftFormat(histTypo, { allowCurrentDraftFingerprintTypoNormalization: true }), /格式头未登记或字段混用/);
    }

    const missingSections = buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo });
    delete missingSections.sections;

    const rejectedDrafts = [
        buildMinimalCurrentDraft({ schemaFingerprint: twoCharTypo }),
        buildMinimalCurrentDraft({ schemaFingerprint: 'f'.repeat(64) }),
        buildMinimalCurrentDraft({ schemaFingerprint: flipHex(currentFp[0]) + currentFp.slice(1, -1) }),
        buildMinimalCurrentDraft({ contract: 'other-contract', schemaFingerprint: oneCharTypo }),
        buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo, version: 3 }),
        buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo, schemaVersion: 1 }),
        buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo, policyVersion: 1 }),
        buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo, unknownExtra: 'x' }),
        buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo, sourceBindingsContract: 'api-reader-source-bindings-v4' }),
        buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo, sections: 'not-an-array' }),
        buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo, readerTitle: 42 }),
        buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo, implementationSpecs: [] }),
        missingSections,
        Object.create(buildMinimalCurrentDraft({ schemaFingerprint: oneCharTypo }))
    ];

    for (const bad of rejectedDrafts) {
        assert.equal(recordFormat.normalizeCurrentDraftFingerprintTypo(bad).typoFixed, false);
        assert.throws(() => recordFormat.draftFormat(bad, { allowCurrentDraftFingerprintTypoNormalization: true }), /格式头未登记或字段混用/);
    }
});

test('R2-Fix-1 P0 #1: real ordinal.renderPrompt(...) + deepAnalyzer.buildReaderRequestMessages places evidence + images before targets, feedback, and requestToken', async t => {
    const os = require('node:os');
    const zlib = require('node:zlib');
    const Config = require('../scripts/config');
    const daily = require('../scripts/lib/daily-fresh-source-plan');
    const fresh = require('../scripts/lib/fresh-analysis-context');
    const engine = require('../scripts/analysis-engine');
    const deepAnalyzer = require('../scripts/deep-analyzer');

    const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(
        path.join(ROOT, 'tests/fixtures/reader-target-ordinal-paid-20261027-real.json.gz')
    )));
    const fixtureCase = bundle.fixture.cases[1];
    const reqPayload = JSON.parse(Buffer.from(fixtureCase.realOldRequest.rawBase64, 'base64'));
    const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r2-fix1-ordinal-split-'));
    const origRunsDir = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = tmpRoot;
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = origRunsDir;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
    t.mock.method(engine, 'paperAnalysisLockHeld', () => true);

    const runDir = path.join(tmpRoot, reqPayload.identity.freshAnalysis.runId);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runDir, 'run.json'), Buffer.from(bundle.fixture.runManifestRawBase64, 'base64'));
    fs.chmodSync(path.join(runDir, 'run.json'), 0o600);
    const sourceDir = path.join(runDir, 'sources', reqPayload.identity.freshAnalysis.paperId, 'generation-000001');
    fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
    for (const [name, record] of Object.entries(fixtureCase.sourceFiles)) {
        const raw = record.rawBase64 ? Buffer.from(record.rawBase64, 'base64') : fs.readFileSync(record.path);
        fs.writeFileSync(path.join(sourceDir, name), raw, { mode: 0o600 });
    }
    const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({
        ...JSON.parse(Buffer.from(bundle.fixture.runManifestRawBase64, 'base64')),
        runDir
    }));
    const paper = { arxivId: reqPayload.identity.paperId, analysisManifest: { stages: {} } };
    const directory = path.join(runDir, 'reader-attempts');
    fs.mkdirSync(directory, { mode: 0o700 });
    const draft = structuredClone(reqPayload.draft);
    const identity = structuredClone(reqPayload.identity);
    const repairContext = { draftSha256: repair.hashDraft(draft), targets: structuredClone(reqPayload.repairTargets) };
    repair.saveFailedCandidate(directory, identity, {
        status: 'failed',
        draft,
        rawDraft: JSON.stringify(draft),
        attempts: 1,
        fullAttempts: 1,
        transportFailures: 0,
        noProgress: 0,
        validationFailureStreak: 1,
        failureSignature: 'synthetic-ordinal-v2-split',
        issues: []
    });

    const { renderedPrompt, requestToken } = await daily.withDailyFreshAnalysisContext(plan, async () => {
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, daily.readDailyFreshSource(plan, paper));
        return daily.withDailyFreshPaperSource(plan, paper, () => {
            const cap = ordinal.prepare({ paper, identity, directory, draft, repairContext });
            return {
                requestToken: ordinal.requestContract(cap).requestToken,
                renderedPrompt: ordinal.renderPrompt(cap, {
                    mechanicalContract: 'STABLE_MECHANICAL_CONTRACT',
                    evidence: 'STABLE_SOURCE_EVIDENCE_PAYLOAD',
                    feedback: 'VOLATILE_VALIDATION_FEEDBACK'
                })
            };
        });
    }, { refreshReaderDiagnostics: true });
    assert.equal(typeof renderedPrompt, 'string');
    assert.match(requestToken, /^[a-f0-9]{16}$/);

    const fakeImg = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const messages = deepAnalyzer.buildReaderRequestMessages(renderedPrompt, 'VIS', [fakeImg]);
    assert.equal(messages.length, 1);
    const blocks = messages[0].content;
    assert.equal(blocks.length, 4, 'ordinal-v2 prompt must split into 4 content blocks when images are attached');

    // Block 0: static prefix + mechanicalContract + stable evidence (BEFORE volatile targets/feedback/requestToken)
    assert.equal(blocks[0].type, 'text');
    assert.ok(blocks[0].text.includes('STABLE_MECHANICAL_CONTRACT'));
    assert.ok(blocks[0].text.includes('STABLE_SOURCE_EVIDENCE_PAYLOAD'));
    assert.equal(blocks[0].text.includes('VOLATILE_VALIDATION_FEEDBACK'), false);
    assert.equal(blocks[0].text.includes('"currentValue":'), false);
    assert.equal(blocks[0].text.includes(requestToken), false);
    assert.equal(blocks[0].text.includes('本次请求标识（必须原样填入响应 JSON 的 requestToken 字段）：'), false);

    // Block 1 & 2: visibility notice + images
    assert.equal(blocks[1].text, 'VIS');
    assert.deepEqual(blocks[2], fakeImg);

    // Block 3: volatile targets -> feedback -> requestToken AFTER images
    assert.equal(blocks[3].type, 'text');
    assert.ok(blocks[3].text.startsWith('\n当前授权目标（只允许修改此处列出的 targetOrdinal，并严格匹配各目标 valueType）：'));
    assert.ok(blocks[3].text.includes('"targetOrdinal":1'));
    assert.ok(blocks[3].text.includes('"currentValue":'));
    assert.ok(blocks[3].text.includes('VOLATILE_VALIDATION_FEEDBACK'));
    assert.ok(blocks[3].text.includes(`本次请求标识（必须原样填入响应 JSON 的 requestToken 字段）：${requestToken}`));
    assert.ok(blocks[3].text.indexOf('"currentValue":') < blocks[3].text.indexOf('VOLATILE_VALIDATION_FEEDBACK'));
    assert.ok(blocks[3].text.indexOf('VOLATILE_VALIDATION_FEEDBACK') < blocks[3].text.indexOf(requestToken));
});

test('R2-Fix-1 P0 #2: live parseApiReaderArticleResult (opt-in) & generateApiReaderArticleDetailed normalize 1-char schemaFingerprint typos while cold-replay rejects', async t => {
    const os = require('node:os');
    const deepAnalyzer = require('../scripts/deep-analyzer');
    const publicProbe = require('../scripts/lib/public-resource-probe');

    const makeParagraphs = (prefix, topics) => topics.map((topic, idx) => (
        `#### ${prefix}要点${['一', '二', '三', '四'][idx]}\n\n`
        + `${prefix}聚焦${topic}展开详细拆解，作者在公开语音评测基准里固定前端采样率、梅尔频谱窗长与声码器权重，避免无关变量污染对比结论。`
        + `具体到${topic}对应的声学时序建模环节，系统逐帧追踪频谱能量分布、音素边界定位与码本索引分配在长短句上的变化趋势，`
        + `以此辨别压缩失真究竟源于浅层卷积感受野受限，还是源于多层量化器在高频清辅音处出现的码本坍缩与能量衰减。`
        + `结合${prefix}针对${topic}的逐项核验，读者能够理解该框架为何既能压低长序列重建误差累积，又能维持单路径前向推理的轻量开销，`
        + `并在迁移到低信噪比录音或未见说话人音色之前清晰界定当前方案的适用范围与潜在风险。`
    )).join('\n\n');

    const validDraft = {
        ...codec.recordHeader(codec.contract('reader-draft'), 'reader-draft'),
        readerTitle: '面向低码率语音重建的自适应残差量化架构',
        oneSentenceThesis: '本文提出自适应门控残差量化方案以缓解低码率语音重建中的音色失真与高频衰减，并在公开语料上验证其稳定性。',
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: [],
        implementationSpecs: {
            trainingData: '采用公开多说话人朗读语料库并按说话人严格划分训练与验证子集。',
            computeHardware: '原文未披露具体训练卡型号与总训练卡时统计。',
            keyHyperparams: '固定十六千赫兹采样与残差量化层数，使用余弦学习率退火调度。',
            inferenceCost: '解码阶段按帧流式执行单路径前向计算，不引入额外搜索开销。',
            openSourceArtifacts: '原文未给出公开代码仓库或预训练权重下载链接。',
            appendixHighlights: '附录整理了码本利用率统计与低信噪比退化样例说明。'
        },
        sections: [
            {
                kind: 'problem',
                heading: '低码率神经语音编码的高频衰减与码本坍缩',
                body: makeParagraphs('问题界定', ['低码率频谱细节流失', '多层码本利用率失衡', '跨说话人音色漂移', '流式窗口因果约束'])
            },
            {
                kind: 'method_overview',
                heading: '自适应门控残差量化编码解码总体流程',
                body: makeParagraphs('框架总览', ['多尺度卷积声学编码', '帧级动态码本路由', '残差误差逐级补偿', '轻量流式声码器重构'])
            },
            {
                kind: 'component',
                heading: '动态门控路由与码本熵正则机制剖析',
                body: makeParagraphs('核心机制', ['能量敏感门控打分', '死码本周期重激活', '相位一致性频域损失', '梯度直通估计稳定性'])
            },
            {
                kind: 'result',
                heading: '公开语音语料上的客观质量与码率权衡',
                body: makeParagraphs('实验观察', ['不同码率档位重建对比', '移除门控路由消融验证', '跨说话人泛化稳定性评估', '长句连续合成听感复核'])
            },
            {
                kind: 'limitation',
                heading: '强混响噪声与端侧部署边界的未决约束',
                body: makeParagraphs('局限梳理', ['远场强混响环境未覆盖', '极低比特率韵律平直化', '多语种非母语口音缺口', '嵌入式定点量化待验证'])
            }
        ]
    };

    const sourceText = 'We evaluate adaptive residual vector quantization for low-bitrate speech reconstruction across public corpora.';
    const artifacts = {
        parserVersion: 'unstructured-text-signals-v1',
        tables: [],
        formulas: [],
        figures: [],
        flattenedTextSha256: sha(sourceText)
    };
    artifacts.payloadSha256 = publicProbe.stableFingerprint(artifacts);
    const parseOpts = {
        arxivId: '2611.99922',
        availableFigureOrdinals: [],
        requireIntegratedTables: false,
        minimumIntegratedTables: 0,
        requiredProfile: recordFormat.INTEGRATED,
        compileCurrent: true,
        requireSourceBindings: true,
        requireImplementationSpecs: true,
        structuredArtifacts: artifacts,
        sourceText
    };

    const currentFp = codec.schemaFingerprint('reader-draft');
    const flipHex = ch => (ch === '0' ? '1' : '0');
    const mutatedSubstitution = JSON.stringify({
        ...validDraft,
        schemaFingerprint: currentFp.slice(0, 10) + flipHex(currentFp[10]) + currentFp.slice(11)
    });
    const mutatedDeletion = JSON.stringify({
        ...validDraft,
        schemaFingerprint: currentFp.slice(0, -1)
    });
    const mutatedTwoChars = JSON.stringify({
        ...validDraft,
        schemaFingerprint: flipHex(currentFp[0]) + currentFp.slice(1, 20) + flipHex(currentFp[20]) + currentFp.slice(21)
    });

    // 1. Default & explicit cold-replay parseApiReaderArticleResult MUST REJECT mutated fingerprints!
    assert.throws(() => deepAnalyzer.parseApiReaderArticleResult(mutatedSubstitution, parseOpts), /格式头未登记或字段混用/);
    assert.throws(() => deepAnalyzer.parseApiReaderArticleResult(mutatedDeletion, parseOpts), /格式头未登记或字段混用/);
    assert.throws(() => deepAnalyzer.parseApiReaderArticleResult(mutatedSubstitution, {
        ...parseOpts,
        allowCurrentDraftFingerprintTypoNormalization: false
    }), /格式头未登记或字段混用/);

    // 2. Explicit opt-in parseApiReaderArticleResult normalizes 1-char typos and compiles current plan, while rejecting distance>=2.
    const parsedSub = deepAnalyzer.parseApiReaderArticleResult(mutatedSubstitution, {
        ...parseOpts,
        allowCurrentDraftFingerprintTypoNormalization: true
    });
    assert.equal(parsedSub.plan.contract, 'beginner-researcher');
    assert.equal(parsedSub.plan.schemaFingerprint, codec.schemaFingerprint('beginner-researcher'));
    assert.equal(parsedSub.qualityMetrics.blockingIssueCount, 0);

    const parsedDel = deepAnalyzer.parseApiReaderArticleResult(mutatedDeletion, {
        ...parseOpts,
        allowCurrentDraftFingerprintTypoNormalization: true
    });
    assert.equal(parsedDel.plan.schemaFingerprint, codec.schemaFingerprint('beginner-researcher'));

    assert.throws(() => deepAnalyzer.parseApiReaderArticleResult(mutatedTwoChars, {
        ...parseOpts,
        allowCurrentDraftFingerprintTypoNormalization: true
    }), /格式头未登记或字段混用/);

    // 3. Live generateApiReaderArticleDetailed (generateApiReaderArticleDetailedUnlocked) succeeds on 1-char mutated LLM response
    //    AND preserves verbatim original paid response bytes in disposition ledger!
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r2-fix1-live-typo-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const dispositions = [];
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    let generated;
    try {
        generated = await deepAnalyzer.generateApiReaderArticleDetailed(
            { arxivId: '2611.99922', title: 'Adaptive Residual Quantization for Speech' },
            '',
            sourceText,
            {
                sourceText,
                structuredArtifacts: artifacts,
                readerAttemptsDir: tmpDir,
                readerMaterializeFigures: async () => [],
                readerRecordDisposition: entry => dispositions.push(entry),
                readerMaxAttempts: 2,
                readerCallModel: async () => mutatedSubstitution
            }
        );
    } finally {
        console.log = origLog;
    }

    assert.equal(generated.attempts, 1);
    assert.equal(generated.fullAttempts, 1);
    assert.equal(generated.plan.schemaFingerprint, codec.schemaFingerprint('beginner-researcher'));
    assert.ok(
        logs.some(line => line.includes('自动纠正当前 reader-draft schemaFingerprint 单字符抄写偏差 (substitution)')),
        'must log auto-correction editKind'
    );
    assert.equal(dispositions.length, 1);
    assert.equal(dispositions[0].disposition, 'accepted');
    assert.equal(dispositions[0].outputTextSha256, sha(mutatedSubstitution), 'ledger SHA must match verbatim paid response');
    assert.equal(dispositions[0].responseText, mutatedSubstitution, 'ledger responseText must remain verbatim un-mutated raw bytes');
});

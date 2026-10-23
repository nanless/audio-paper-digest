'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');

function sample(t) {
    // Synthetic normal-loop fixture: no production draft, paid response or ledger.
    const signed = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const draft = signed.draft;
    for (const section of draft.sections) {
        section.body = section.body.split(/\n\s*\n/).filter(block => !/^\|/m.test(block)).join('\n\n');
    }
    draft.sections[7].body += '\n\n[[TABLE_1]]';
    draft.tableBindings = [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }];
    const matrix = [['Method', 'SDR'], ['Ours', '0.10.1']];
    const source = { ordinal: 1, caption: 'Main results', recoveryStatus: 'complete',
        sourceDomSha256: 'a'.repeat(64), matrix, headerRows: [0], bodyRows: [1],
        cells: matrix.flatMap((row, r) => row.map((text, c) => ({ row: r, column: c, text,
            header: r === 0, rowspan: 1, colspan: 1, sourceDomSha256: 'a'.repeat(64) }))) };
    const structuredArtifacts = { ...signed.sourceDetails.structuredArtifacts, tables: [source] };
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-patch-feedback-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const paper = { arxivId: '2609.99969', title: '离线局部补丁拒绝反馈' };
    const options = { sourceText: `${signed.sourceDetails.text}\nMethod SDR Ours 0.10.1`,
        structuredArtifacts, readerAttemptsDir: directory, readerMaxAttempts: 6,
        reviewFeedback: '保留当前对照条件。',
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
    const saved = () => JSON.parse(fs.readFileSync(path.join(directory,
        fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))), 'utf8')).payload;
    const rewriteSaved = mutate => {
        const filename = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
        const envelope = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
        mutate(envelope.payload);
        repair.saveFailedCandidate(directory, envelope.identity, envelope.payload);
    };
    return { draft, paper, options, saved, rewriteSaved };
}

test('补丁成功应用后不再把旧拒绝带入新候选的局部请求', async t => {
    const f = sample(t);
    const prompts = [];
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed(f.paper, '', '', {
        ...f.options, readerCallModel: async messages => {
            if (++calls === 1) return JSON.stringify(f.draft);
            const prompt = messages[0].content[0].text;
            prompts.push(prompt);
            if (calls === 4) throw new Error('offline applied boundary');
            const envelope = targets(prompt);
            const target = envelope.targets.find(item => item.path.endsWith('/body'));
            return JSON.stringify({ version: 1, draftSha256: envelope.draftSha256,
                replacements: [{ path: target.path, oldSha256: calls === 2 ? '0'.repeat(64) : target.oldSha256,
                    value: `${target.value}\n\n本段保留当前比较条件。` }] });
        }
    }), /offline applied boundary/);
    assert.equal(calls, 4);
    assert.match(prompts[1], /上一局部补丁拒绝诊断/);
    assert.doesNotMatch(prompts[2], /上一局部补丁拒绝诊断|Reader patch rejected:/);
    assert.notEqual(targets(prompts[2]).draftSha256, targets(prompts[1]).draftSha256);
    assert.deepEqual(targets(prompts[2]).targets.map(item => item.path), targets(prompts[1]).targets.map(item => item.path));
    assert.equal(f.saved().patchRejectionFeedback, undefined);
    assert.equal(f.saved().lastContentError, undefined);
    assert.equal(f.saved().attempts, 3);
    assert.equal(f.saved().fullAttempts, 1);
});

test('重复同一补丁拒绝仍按原停滞阈值停止，不增加请求', async t => {
    const f = sample(t);
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed(f.paper, '', '', {
        ...f.options, readerCallModel: async messages => {
            if (++calls === 1) return JSON.stringify(f.draft);
            const envelope = targets(messages[0].content[0].text);
            const target = envelope.targets[0];
            return JSON.stringify({ version: 1, draftSha256: envelope.draftSha256,
                replacements: [{ path: target.path, oldSha256: '0'.repeat(64), value: target.value }] });
        }
    }), error => error.code === 'READER_REPAIR_NO_PROGRESS');
    assert.equal(calls, 3);
    assert.equal(f.saved().attempts, 3);
    assert.equal(f.saved().fullAttempts, 1);
    assert.equal(f.saved().validationFailureStreak, 2);
    assert.equal(f.saved().lastContentError, undefined);
});

test('冷恢复诊断只接受有界字符串，旧诊断路径不授予当前目标', async t => {
    const f = sample(t);
    let first = true;
    const generate = readerCallModel => deep.generateApiReaderArticleDetailed(f.paper, '', '', {
        ...f.options, readerCallModel
    });
    await assert.rejects(generate(async () => {
        if (first) { first = false; return JSON.stringify(f.draft); }
        throw new Error('offline initial boundary');
    }), /offline initial boundary/);
    for (const value of [{ message: 'Reader patch rejected: object' }, ['Reader patch rejected: array'], 42]) {
        f.rewriteSaved(record => { record.patchRejectionFeedback = value; });
        await assert.rejects(generate(async messages => {
            assert.doesNotMatch(messages[0].content[0].text, /上一局部补丁拒绝诊断|rejected: object|rejected: array/);
            throw new Error('offline invalid diagnostic');
        }), /offline invalid diagnostic/);
    }
    const diagnostic = `Reader patch rejected: /sections/99/body; received=old; expected-current=obsolete; ${'x'.repeat(4000)}TAIL`;
    f.rewriteSaved(record => { record.patchRejectionFeedback = diagnostic; });
    await assert.rejects(generate(async messages => {
        const prompt = messages[0].content[0].text;
        assert.ok(prompt.includes(diagnostic.slice(0, 3000)));
        assert.doesNotMatch(prompt, /TAIL/);
        assert.match(prompt, /旧诊断中的路径、received 与 expected-current 仅解释上次拒绝，不授予修改目标/);
        assert.deepEqual(targets(prompt).targets.map(item => item.path), ['/tableBindings/0', '/sections/7/body']);
        throw new Error('offline bounded diagnostic');
    }), /offline bounded diagnostic/);
    assert.equal(f.saved().patchRejectionFeedback.length, 3000);
    assert.equal(f.saved().lastContentError, undefined);
    assert.equal(f.saved().attempts, 1);
    assert.equal(f.saved().fullAttempts, 1);
});

test('独立诊断不影响原余额准入、截断升级或任何计数', () => {
    const beforeIssues = [{ path: '/sections/2/body', code: 'reader_workflow_leakage', message: '写作指令泄漏，当前 2 处' }];
    const input = { candidateRevalidated: true, identity: { maxAttempts: 3 }, maxAttempts: 3, attemptLimit: 3,
        currentIssues: [{ path: '/tableBindings/0', code: 'reader_invalid_source_quotes', message: '原表逐字引文未覆盖全部数字与单位' }],
        recovered: { attempts: 2, fullAttempts: 1, noProgress: 1, validationFailureStreak: 2,
            issues: beforeIssues, failureSignature: repair.hashRecoveryIssues(beforeIssues),
            validationFailureSignature: repair.validationFailureSignature(beforeIssues) } };
    assert.equal(repair.canContinueRevalidatedIssuesWithinBudget(input), true);
    input.recovered.patchRejectionFeedback = 'Reader patch rejected: old diagnostic only';
    const before = structuredClone(input);
    assert.equal(repair.canContinueRevalidatedIssuesWithinBudget(input), true);
    assert.deepEqual(input, before);
    const escalate = recovery => deep.shouldEscalateApiReaderRepairBudget(recovery, { version: 3 }, 8000, 16000, 3);
    assert.equal(escalate(input.recovered), false);
    input.recovered.lastContentError = { code: 'MODEL_OUTPUT_TRUNCATED', requestKind: 'patch', outputTokens: 8000, maxOutputTokens: 8000 };
    assert.equal(escalate(input.recovered), true);
    assert.equal(repair.canContinueRevalidatedIssuesWithinBudget(input), false, '原内容错误停止门继续生效');
});

function targets(prompt) {
    const start = prompt.indexOf('{"draftSha256":');
    assert.ok(start >= 0);
    return JSON.parse(prompt.slice(start, prompt.indexOf('\n', start)));
}

for (const failure of ['stale-node', 'short-draft']) {
    test(`正常归一化重建问题后仍向下次局部请求提供拒绝反馈：${failure}`, async t => {
        const f = sample(t);
        const prompts = [];
        let calls = 0;
        let expectedFeedback;
        const generate = readerCallModel => deep.generateApiReaderArticleDetailed(f.paper, '', '', {
            ...f.options, readerCallModel
        });
        await assert.rejects(generate(async (messages, _tokens, request) => {
            calls++;
            if (calls === 1) return JSON.stringify(f.draft);
            assert.equal(request.usageContext.stage, 'apiReaderRepair');
            const prompt = messages[0].content[0].text;
            prompts.push(prompt);
            if (calls === 2) {
                const envelope = targets(prompt);
                assert.doesNotMatch(prompt, /上一局部补丁拒绝诊断/);
                const target = envelope.targets[0];
                return JSON.stringify({ version: 1,
                    draftSha256: failure === 'short-draft' ? envelope.draftSha256.slice(0, 62) : envelope.draftSha256,
                    replacements: [{ path: target.path,
                        oldSha256: failure === 'stale-node' ? '0'.repeat(64) : target.oldSha256,
                        value: target.value }] });
            }
            expectedFeedback = f.saved().issues.find(issue => issue.message.startsWith('Reader patch rejected:')).message;
            throw new Error('offline request boundary');
        }), /offline request boundary/);
        assert.equal(calls, 3);
        assert.equal(f.saved().attempts, 2);
        assert.equal(f.saved().fullAttempts, 1);
        assert.equal(f.saved().transportFailures, 1);
        assert.deepEqual(targets(prompts[1]), targets(prompts[0]), '拒绝反馈不能扩展当前目标或改写SHA');
        assert.match(prompts[1], /source_table|原表/);
        assert.ok(prompts[1].includes(expectedFeedback), '第二局部prompt必须保留上次真实拒绝原因');
        assert.notEqual(repair.shaText(prompts[1]), repair.shaText(prompts[0]));
        assert.match(prompts[1], /保留当前对照条件/);
        for (const target of targets(prompts[1]).targets) {
            assert.equal(target.oldSha256, repair.hashDraft(target.value));
        }

        let resumedPrompt;
        await assert.rejects(generate(async (messages, _tokens, request) => {
            assert.equal(request.usageContext.contentAttempt, 3);
            resumedPrompt = messages[0].content[0].text;
            throw new Error('offline resumed boundary');
        }), /offline resumed boundary/);
        assert.ok(resumedPrompt.includes(expectedFeedback), '正常冷续跑也必须保留原付费拒绝诊断');
        assert.deepEqual(targets(resumedPrompt), targets(prompts[1]));
        assert.equal(f.saved().attempts, 2);
        assert.equal(f.saved().fullAttempts, 1);
        assert.equal(f.saved().transportFailures, 2);
    });
}

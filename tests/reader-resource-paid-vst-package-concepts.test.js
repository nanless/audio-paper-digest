'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer'), repair = require('../scripts/lib/reader-repair');
const saved = require('./fixtures/reader-paid-vst-package-concepts.json');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const concept = '代码开源、包可下载与系统可运行是三件事';
const wrap = body => ({ sections: [{ kind: 'synthesis', body }] });
const issues = body => deep.readerResourceClaimIssues(wrap(body), saved.resourceIdentity, saved.sourceText);

test('actual paid software fragment is an owner-free distinction; stored third_party resources retain exact identities', () => {
    const before = JSON.stringify(saved);
    assert.equal(sha(saved.sourceText), '89760035f6b05b5dca1a03a007cef9581fb4f1f1368fe582523f62688084ec56');
    const { identitySha256, ...body } = saved.resourceIdentity;
    assert.equal(deep.stableFingerprint(body), identitySha256);
    assert.ok(body.resources.length > 0 && body.resources.every(resource => resource.type === 'third_party'));
    assert.deepEqual(deep.readerResourceClaimIssues(saved.draft, saved.resourceIdentity, saved.sourceText), []);
    assert.deepEqual(issues(saved.draft.sections[13].body), []);
    assert.equal(JSON.stringify(saved), before);
});

test('distinction scope cannot hide ownership, denied or revoked distinction, hypotheses with actual availability, or extra code claims', () => {
    for (const text of [
        '本文' + concept + '。', '作者拥有的' + concept + '。',
        '作者否认“' + concept + '”。', '“' + concept + '”这个说法不成立。',
        concept + '，这个区分是错误的。', concept + '，上述区分已被撤回。',
        '假设' + concept + '，但本文代码已经开源。',
        concept + '：三者已经公开可用。',
        concept + '：但本文代码已经开源。',
        '本文代码已经开源。' + concept + '。',
        saved.draft.sections[13].body + '本文代码已经开源。',
        '本文代码开源，包可下载，系统可运行。'
    ]) assert.ok(issues(text).length, text);
    // Denial and a bare hypothetical remain nonclaims, without becoming availability evidence.
    assert.deepEqual(issues('本文代码尚未确认开源，包也未确认可下载。'), []);
});

test('actual paid saved candidate still fails strict public source parsing when numeric quote invention is disabled', () => {
    assert.equal(saved.attempts, 1); assert.equal(saved.fullAttempts, 1);
    assert.ok(repair.parseRecoveryDraft(saved.draft));
    assert.ok(repair.parseRepairableDraft(saved.draft));
    const tableIssues = repair.collectDraftIssues(saved.draft, null, {
        sourceText: saved.sourceText, structuredArtifacts: saved.structuredArtifacts
    });
    assert.ok(tableIssues.some(issue => issue.path === '/tableBindings/2'));
    assert.ok(tableIssues.some(issue => issue.path === '/tableBindings/3'));
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(saved.draft), {
        arxivId: saved.paperId, availableFigureOrdinals: [1, 2], requireIntegratedTables: true,
        minimumIntegratedTables: 2, requiredVersion: 3, requireSourceBindings: true,
        allowDeterministicQuoteRepair: false, allowDeterministicUnsupportedClaimPruning: true,
        enforceResourceAvailabilityClaims: true, verifiedResourceIdentity: saved.resourceIdentity,
        structuredArtifacts: saved.structuredArtifacts, sourceText: saved.sourceText
    }), /tableBindings\[2\].*关键数字缺少 exact quote\/cell 证据: 8, 2/);
});

test('first-turn full fallback is !recovered, whereas the same saved payload resumes existing local repair without resetting 1/1', () => {
    const before = JSON.stringify(saved);
    const payload = { draft: saved.draft, rawDraft: saved.rawDraft, issues: saved.issues,
        attempts: saved.attempts, fullAttempts: saved.fullAttempts };
    assert.equal(deep.readerIssuesRequireFullSourceBindingRetry(null, saved.draft, 1, saved.issues), true);
    assert.equal(deep.readerIssuesRequireFullSourceBindingRetry(payload, saved.draft, 1, saved.issues), false);
    const context = repair.buildRepairContext(saved.draft, saved.issues, saved.sourceText,
        saved.sourceText, { availableFigureOrdinals: [1, 2], structuredArtifacts: saved.structuredArtifacts });
    assert.deepEqual(context.targets.map(target => target.path), [
        '/sections/9/body', '/tableBindings/2', '/tableBindings/3'
    ]);
    assert.equal(context.atomicOperation, null);
    assert.equal(JSON.stringify(saved), before);
});

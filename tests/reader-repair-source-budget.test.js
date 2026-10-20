'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vm = require('node:vm');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const pdf = require('../scripts/lib/reader-sealed-pdf-quote-evidence');
const { loadPrompt } = require('../scripts/utils');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-repair-source-budget-2610.24108.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const evidence = budget => deep.buildApiReaderEvidenceContext('', fixture.sourceText,
    fixture.structuredArtifacts, fixture.paperId, null, fixture.readerResources,
    fixture.naturalResourceProse, budget);

test('real saved repair shares its evidence budget with the full PDF supplement without changing targets or initial evidence', t => {
    // The real, separately verified PDF projection is a transport fixture here;
    // this test grants no source or publication capability.
    t.mock.method(pdf, 'document', () => structuredClone(fixture.pdfDocument));
    const original = evidence();
    assert.equal(original.length, fixture.originalEvidenceChars);
    assert.equal(sha(original), fixture.originalEvidenceSha256);
    const options = { structuredArtifacts: fixture.structuredArtifacts,
        availableFigureOrdinals: fixture.draft.figurePlacements.map(item => item.figureOrdinal) };
    const before = JSON.stringify(fixture);
    const old = repair.buildRepairContext(fixture.draft, fixture.issues, original, fixture.sourceText, options);
    let requestedBudget;
    const current = repair.buildRepairContext(fixture.draft, fixture.issues, original, fixture.sourceText, {
        ...options, sourceEvidenceBudget: fixture.limits.evidence,
        sourceEvidenceForBudget: maximum => { requestedBudget = maximum; return evidence(maximum); }
    });
    assert.deepEqual(current.targets, old.targets);
    assert.equal(current.draftSha256, old.draftSha256);
    assert.equal(current.targetGuidance, old.targetGuidance);
    assert.ok(requestedBudget > 4000 && requestedBudget < fixture.limits.evidence);
    assert.ok(current.evidence.length <= requestedBudget);
    assert.ok(current.evidence.includes(deep.buildApiReaderArtifactEvidence(
        fixture.structuredArtifacts, fixture.paperId)));
    const prompt = context => loadPrompt('prompts/api-reader-repair-v13.md', {
        title: fixture.title, arxivId: fixture.paperId,
        validationFeedback: [context.targetGuidance, ...fixture.issues.map(issue => issue.message)].join('\n'),
        repairTargets: JSON.stringify({ draftSha256: context.draftSha256, targets: context.targets }),
        sourceEvidence: context.evidence, operationProtocol: repair.repairOperationProtocol(context),
        mechanicalContract: require('../scripts/lib/reader-contract').buildReaderContractNotice()
    });
    assert.ok(prompt(old).length > fixture.limits.context);
    assert.ok(prompt(current).length <= fixture.limits.context);
    assert.ok(current.targetGuidance.includes(JSON.stringify(
        fixture.pdfDocument.normalizedFullText.slice(0, 60000)).slice(1, -1)));
    assert.equal(sha(evidence()), fixture.originalEvidenceSha256);
    assert.equal(JSON.stringify(fixture), before);
});

test('an already fitting repair preserves the original bytes and never rebuilds evidence', () => {
    const original = 'Original complete source and resource context.';
    assert.equal(repair.budgetReaderRepairSourceEvidence(original, 'Bounded PDF quote', {
        sourceEvidenceBudget: 8000, sourceEvidenceForBudget: () => { throw Error('must not rebuild'); }
    }), original);
});

test('the production repair closure keeps the verified paper resources when options has no readerResources', () => {
    // Exercise the actual production callback without entering API/image I/O.
    const program = fs.readFileSync(path.join(__dirname, '../scripts/deep-analyzer.js'), 'utf8');
    const callbacks = [...program.matchAll(/sourceEvidenceForBudget: (budget => buildApiReaderEvidenceContext\([\s\S]*?naturalResourceProse, budget\)),\n/g)];
    assert.equal(callbacks.length, 1);
    const options = { sourceText: fixture.sourceText, structuredArtifacts: fixture.structuredArtifacts };
    let seenResources;
    const callback = vm.runInNewContext(`(${callbacks[0][1]})`, {
        options, paper: { arxivId: fixture.paperId, apiReaderResources: fixture.readerResources },
        getPaperArxivId: paper => paper.arxivId, readerCapabilityPolicy: null,
        verifiedReaderResources: fixture.readerResources, naturalResourceProse: fixture.naturalResourceProse,
        buildApiReaderEvidenceContext: (...args) => {
            seenResources = args[5];
            return deep.buildApiReaderEvidenceContext(...args);
        }
    });
    const rebuilt = callback(120000);
    assert.equal(options.readerResources, undefined);
    assert.equal(seenResources, fixture.readerResources);
    assert.equal(rebuilt, evidence(120000));
});

test('an impossible or untrusted source allocation fails before a request rather than slicing a table or raising the limit', () => {
    const original = 'Original '.repeat(1000), extra = 'PDF '.repeat(1200);
    for (const options of [
        { sourceEvidenceBudget: 8000 },
        { sourceEvidenceBudget: 8000, sourceEvidenceForBudget: () => 'x' },
        { sourceEvidenceBudget: 10000, sourceEvidenceForBudget: () => original },
        { sourceEvidenceBudget: 10000, sourceEvidenceForBudget: () => null },
        { sourceEvidenceBudget: 180001, sourceEvidenceForBudget: () => original }
    ]) assert.throws(() => repair.budgetReaderRepairSourceEvidence(original, extra, options), {
        code: 'READER_REPAIR_SOURCE_CONTEXT_BUDGET'
    });
});

test('a repair display budget cannot exceed the original source budget or silently discard structured source records', () => {
    assert.throws(() => evidence(180001), /预算无效/);
    assert.throws(() => evidence(4000), /证据超出硬上限/);
});

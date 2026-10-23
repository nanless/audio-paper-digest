'use strict';
const test = require('node:test');
const assert = require('node:assert');
const manifest = require('../scripts/manifest-new');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const repair = require('../scripts/lib/reader-repair');
const operator = require('../scripts/lib/daily-reader-operator-correction');
const facts = require('../scripts/lib/daily-fact-review');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t, count = 2) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'manifest-preparation-'));
    const previous = { dailyFreshSourceRunsDir: Config.FILES.dailyFreshSourceRunsDir,
        deepAnalysisResult: Config.FILES.deepAnalysisResult };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    Config.FILES.deepAnalysisResult = path.join(root, 'formal.json');
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root, { recursive: true, force: true }); });
    const papers = Array.from({ length: count }, (_, index) => ({ arxivId: `2610.${90000 + index}`,
        error: 'Saved Reader failure', analysisManifest: { stages: {} } }));
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'manifest-preparation', papers });
    const sourceText = 'Official methods report mean squared error against the frozen teacher. '.repeat(180);
    await daily.captureDailyFreshSources(plan, { concurrency: 1,
        capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(options, {
            fetchText: async id => ({ text: sourceText, source: 'html', sourceId: id,
                url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-10-11T00:00:00.000Z', imageInfos: [], warnings: [] }),
            fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${id}`, fetchedAt: '2026-10-11T00:00:01.000Z' })
        }) });
    for (const paper of papers) {
        const details = daily.readDailyFreshSource(plan, paper);
        paper.sourceSha256 = details.freshSourceDescriptor.sourceSha256;
        paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256 };
        daily.withDailyFreshAnalysisContext(plan, () => require('../scripts/lib/fresh-analysis-context')
            .attachFreshSourceRecord(paper, paper.analysisManifest, details));
    }
    const draft = { version: 3, readerTitle: 'Synthetic saved failure', oneSentenceThesis: 'Material preparation only.',
        sections: require('../scripts/lib/reader-draft-order').READER_SECTION_KINDS
            .map(kind => ({ kind, heading: kind, body: kind.repeat(130) })),
        conceptBridges: Array.from({ length: 4 }, () => ({})), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    const identities = papers.map(paper => ({ paperId: paper.arxivId, sourceSha256: paper.sourceSha256,
        freshAnalysis: daily.withDailyFreshAnalysisContext(plan, () => require('../scripts/lib/fresh-analysis-context').freshAnalysisIdentity(paper.arxivId)),
        inputFingerprint: 'synthetic saved input, not current input qualification' }));
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft), issues: [{ path: null, message: 'synthetic failure' }],
        attempts: 1, fullAttempts: 1, noProgress: 0, failureSignature: 'synthetic' };
    const candidateFiles = identities.map(identity => repair.saveFailedCandidate(plan.readerAttemptsDir, identity, payload));
    const specs = papers.map(paper => ({ paperId: paper.arxivId,
        replacements: [{ path: '/sections/0/body', value: draft.sections[0].body + ' bounded correction' }] }));
    const specFile = path.join(root, 'specs.json');
    const write = () => fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ batchDate: plan.batchDate,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers }));
    write(); fs.writeFileSync(specFile, JSON.stringify(specs));
    return { root, plan, papers, draft, identities, payload, candidateFiles, specs, specFile, sourceText, write };
}

function capturedMain(t, argv) {
    const lines = [];
    const mock = t.mock.method(console, 'log', value => lines.push(String(value)));
    try { return { code: manifest.main(argv), lines }; } finally { mock.mock.restore(); }
}

test('findCandidate 用 exact ID + freshAnalysis.runId/sourceOnly 选择', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const repair = require('../scripts/lib/reader-repair.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-candidates-'));
    const old = repair.readFailedCandidateEnvelope;
    try {
        const files = ['a'.repeat(64) + '.json', 'b'.repeat(64) + '.json'];
        for (const name of files) fs.writeFileSync(path.join(dir, name), '{}');
        repair.readFailedCandidateEnvelope = (attemptsDir, _unused, file) => {
            const isOther = file.includes('a'.repeat(64));
            return {
                envelope: {
                    identity: {
                        paperId: isOther ? '2610.12345' : '2610.1234',
                        sourceSha256: 'c'.repeat(64),
                        freshAnalysis: { runId: isOther ? 'run-other' : 'run-ok', sourceOnly: true }
                    },
                    payload: { draft: {} }
                }
            };
        };
        const found = require('../scripts/manifest-new.js').findCandidate(dir, '2610.1234', 'run-ok', 'c'.repeat(64));
        assert.ok(found);
        assert.ok(found.absolutePath.includes('b'.repeat(64)));
    } finally {
        repair.readFailedCandidateEnvelope = old;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('validateSpec 拒绝非法论文/路径/空值', () => {
    assert.throws(() => manifest.validateSpec({}), /paperId/);
    assert.throws(() => manifest.validateSpec({ paperId: '2610.12345' }), /replacements/);
    assert.throws(() => manifest.validateSpec({ paperId: '2610.12345', replacements: [{ path: '/sections/0/body', value: '' }] }), /value/);
    assert.throws(() => manifest.validateSpec({ paperId: '2610.12345', replacements: [{ path: '/bad', value: 'x' }] }), /path/);
});

test('nodeAt 支持节点路径并拒绝未知路径', () => {
    const draft = { sections: [{ body: 'a' }], tableBindings: [{ tableIndex: 1 }] };
    assert.strictEqual(manifest.nodeAt(draft, '/sections/0/body'), 'a');
    assert.strictEqual(manifest.nodeAt(draft, '/tableBindings/0'), draft.tableBindings[0]);
    assert.throws(() => manifest.nodeAt(draft, '/figurePlacements/0/explanation'), /节点/);
});

test('真实封存来源与安全候选：dry/write在任何输出和写入前共核完整尾集及重复', async t => {
    const f = await fixture(t);
    const before = fs.readFileSync(Config.FILES.deepAnalysisResult);
    for (const specs of [[f.specs[0]], [f.specs[0], f.specs[0]], [...f.specs, { ...f.specs[0], paperId: '2610.99999' }]]) {
        fs.writeFileSync(f.specFile, JSON.stringify(specs));
        for (const mode of ['--dry-run', '--write']) {
            const lines = [], mock = t.mock.method(console, 'log', value => lines.push(String(value)));
            try { assert.throws(() => manifest.main(['--spec', f.specFile, mode, '--json']), /完整失败集|重复|duplicate/i); }
            finally { mock.mock.restore(); }
            assert.deepStrictEqual(lines, [], 'invalid tail must not print a successful preparation');
        }
        assert.ok(!fs.readdirSync(f.root).some(name => name.startsWith('operator-corrections-')));
    }
    assert.deepStrictEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), before);
});

test('真实安全envelope：候选歧义/损坏/错源均拒绝，不按mtime挑旧稿或吞错', async t => {
    const f = await fixture(t, 1), identity = f.identities[0];
    assert.ok(manifest.findCandidate(f.plan.readerAttemptsDir, f.papers[0].arxivId, f.plan.runId, identity.sourceSha256));
    const branch = repair.saveFailedCandidate(f.plan.readerAttemptsDir, { ...identity, inputFingerprint: 'other branch' }, f.payload);
    fs.utimesSync(branch, new Date(0), new Date(0));
    assert.throws(() => manifest.findCandidate(f.plan.readerAttemptsDir, f.papers[0].arxivId, f.plan.runId, identity.sourceSha256), /歧义|多个|ambiguous/i);
    fs.unlinkSync(branch);
    const broken = path.join(f.plan.readerAttemptsDir, 'f'.repeat(64) + '.json');
    fs.writeFileSync(broken, '{', { mode: 0o600 });
    assert.throws(() => manifest.findCandidate(f.plan.readerAttemptsDir, f.papers[0].arxivId, f.plan.runId, identity.sourceSha256), /candidate|候选/i);
    fs.unlinkSync(broken);
    assert.throws(() => manifest.findCandidate(f.plan.readerAttemptsDir, f.papers[0].arxivId, f.plan.runId, 'a'.repeat(64)), /source|来源/i);
    for (const mode of ['--dry-run', '--write']) {
        const bytes = fs.readFileSync(f.candidateFiles[0]), value = JSON.parse(bytes);
        value.payload.draft = null; value.payloadSha256 = repair.hashDraft(value.payload);
        fs.writeFileSync(f.candidateFiles[0], JSON.stringify(value), { mode: 0o600 });
        assert.throws(() => capturedMain(t, ['--spec', f.specFile, mode]), /draft|草稿/i);
        fs.writeFileSync(f.candidateFiles[0], bytes);
    }
});

test('完整尾集正常准备仍可write，JSON明确未核当前身份/付费链且正式consumer重核', async t => {
    const f = await fixture(t), before = f.candidateFiles.map(file => fs.readFileSync(file));
    const dry = JSON.parse(capturedMain(t, ['--spec', f.specFile, '--json']).lines.join('\n'));
    assert.strictEqual(dry.tailCheck, 'passed');
    assert.strictEqual(dry.candidateIdentity, 'not_checked'); assert.strictEqual(dry.paidOrigin, 'not_checked');
    const written = JSON.parse(capturedMain(t, ['--spec', f.specFile, '--write', '--json']).lines.join('\n'));
    assert.strictEqual(written.tailCheck, dry.tailCheck); assert.strictEqual(written.records.length, 2);
    assert.strictEqual(written.paidOrigin, 'not_checked'); assert.ok(fs.existsSync(written.manifestFile));
    // Synthetic failed envelopes have no paid HTTP receipt. Preparation does
    // not grant completion; the real consumer still checks source and patch.
    await operator.withCorrections(written.manifestFile, f.plan, f.papers, () => {});
    f.candidateFiles.forEach((file, index) => assert.deepStrictEqual(fs.readFileSync(file), before[index]));
    const recordFile = JSON.parse(fs.readFileSync(written.manifestFile)).correctionFiles[0];
    const record = JSON.parse(fs.readFileSync(recordFile)); record.sourceDescriptor.sourceSha256 = 'a'.repeat(64);
    fs.writeFileSync(recordFile, JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(operator.withCorrections(written.manifestFile, f.plan, f.papers, () => assert.fail('bad source admitted')), /sources/);
});

test('真实feedback Map核四来源：正式tail与manifest共用，重复/坏源先拒绝', async t => {
    const f = await fixture(t, 1), paper = f.papers[0];
    paper.analysisCheckpoint = require('./valid-analysis-fixture').validAnalysisText();
    const deep = require('../scripts/deep-analyzer');
    const sourceDirectory = path.join(f.plan.sourcesDir, paper.arxivId, 'generation-000001');
    const feedback = { contract: facts.CONTRACT, paperId: paper.arxivId, runId: f.plan.runId, batchDate: f.plan.batchDate,
        sourceFiles: Object.fromEntries(['source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json']
            .map(name => [name, sha(fs.readFileSync(path.join(sourceDirectory, name)))])),
        coreAnalysisSha256: sha(paper.analysisCheckpoint), coreSummarySha256: sha(deep.extractSectionByTitle(paper.analysisCheckpoint, '核心摘要')),
        coreFeedback: '', readerFeedback: 'Correct only the rejected Reader sentence.', rejectedCoreClaims: [],
        rejectedReaderClaims: ['synthetic rejected sentence'], sourceQuotes: ['Official methods report mean squared error against the frozen teacher.'] };
    const feedbackFile = path.join(f.root, 'feedback.json'); fs.writeFileSync(feedbackFile, JSON.stringify(feedback)); f.write();
    const map = manifest.readOperatorFeedbackFiles([feedbackFile]);
    assert.ok(map instanceof Map); assert.strictEqual(map.size, 1);
    const tail = operator.inspectDailyOperatorTail(f.plan, f.papers, map);
    assert.deepStrictEqual(tail.failedIds, [paper.arxivId]);
    assert.throws(() => manifest.readOperatorFeedbackFiles([feedbackFile, feedbackFile]), /两份|重复/);
    for (const mode of ['--dry-run', '--write']) {
        const report = JSON.parse(capturedMain(t, ['--spec', f.specFile, '--fact-feedback-file', feedbackFile, mode, '--json']).lines.join('\n'));
        assert.strictEqual(report.feedbackCount, 1); assert.strictEqual(report.tailCheck, 'passed');
        if (report.manifestFile) await operator.withCorrections(report.manifestFile, f.plan, f.papers, () => {}, { factFeedbacks: map });
    }
    const bad = { ...feedback, sourceFiles: { ...feedback.sourceFiles, 'source.pdf': 'a'.repeat(64) } };
    fs.writeFileSync(feedbackFile, JSON.stringify(bad));
    for (const mode of ['--dry-run', '--write']) assert.throws(() => capturedMain(t,
        ['--spec', f.specFile, '--fact-feedback-file', feedbackFile, mode]), /来源SHA/);
    assert.throws(() => operator.inspectDailyOperatorTail(f.plan, f.papers, {}), /Map|map/);
    assert.throws(() => operator.inspectDailyOperatorTail(f.plan, f.papers, new Map([['2610.99999', feedback]])), /batch|批次/);
    assert.throws(() => operator.inspectDailyOperatorTail(f.plan, [paper, paper], map), /duplicate/);
});

test('dry/write对超过十篇的真实原封存小批尾集使用相同人数门', async t => {
    const f = await fixture(t, 11);
    for (const mode of ['--dry-run', '--write']) assert.throws(() => capturedMain(t, ['--spec', f.specFile, mode]), /上限|limit/);
});

test('CLI拒绝缺值参数，不能把flag解释成文件路径', () => {
    for (const argv of [['--spec'], ['--spec', '--write'], ['--fact-feedback-file'], ['--fact-feedback-file', '--json']])
        assert.throws(() => manifest.main(argv), /需要|须|路径|参数/);
});


test('typed spec：binding 对象经正常 dry/write 原样保存，正文 JSON 字样不解码', async t => {
    const f = await fixture(t, 1);
    const binding = { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: ['Official methods report mean squared error against the frozen teacher.'] };
    f.draft.tableBindings = [{ ...binding, sourceQuotes: ['Original exact source quotation.'] }];
    f.payload.rawDraft = JSON.stringify(f.draft);
    repair.saveFailedCandidate(f.plan.readerAttemptsDir, f.identities[0], f.payload);
    const body = '  {"literal":"保留正文的 JSON 字样与原始空白"}\n第二行原样。  ';
    const spec = { paperId: f.papers[0].arxivId, replacements: [
        { path: '/tableBindings/0', value: binding }, { path: '/sections/0/body', value: body }
    ] };
    manifest.validateSpec(spec);
    fs.writeFileSync(f.specFile, JSON.stringify(spec));
    const beforeFormal = fs.readFileSync(Config.FILES.deepAnalysisResult);
    const beforeCandidate = fs.readFileSync(f.candidateFiles[0]);
    const dry = JSON.parse(capturedMain(t, ['--spec', f.specFile, '--dry-run', '--json']).lines.join('\n'));
    assert.strictEqual(dry.tailCheck, 'passed');
    const written = JSON.parse(capturedMain(t, ['--spec', f.specFile, '--write', '--json']).lines.join('\n'));
    const recordFile = JSON.parse(fs.readFileSync(written.manifestFile)).correctionFiles[0];
    const record = JSON.parse(fs.readFileSync(recordFile));
    assert.deepStrictEqual(record.draft.tableBindings[0], binding);
    assert.strictEqual(record.draft.sections[0].body, body);
    assert.strictEqual(record.patch.replacements[0].oldSha256, repair.hashDraft(f.draft.tableBindings[0]));
    assert.deepStrictEqual(record.patch.replacements[0].value, binding);
    assert.strictEqual(record.patch.replacements[1].value, body);
    assert.strictEqual(record.patch.replacements[1].oldSha256, repair.hashDraft(f.draft.sections[0].body));
    const expected = structuredClone(f.draft); expected.tableBindings[0] = binding; expected.sections[0].body = body;
    assert.deepStrictEqual(record.draft, expected, 'all non-target nodes must retain their original values');
    assert.deepStrictEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), beforeFormal);
    assert.deepStrictEqual(fs.readFileSync(f.candidateFiles[0]), beforeCandidate);
});

test('typed spec：文本字段仍须非空字符串，单节点拒绝字符串编码、null、array 与标量', () => {
    const validate = (pointer, value) => manifest.validateSpec({ paperId: '2610.12345',
        replacements: [{ path: pointer, value }] });
    for (const pointer of ['/sections/0/body', '/conceptBridges/0/explanation']) {
        for (const value of ['', ' \n ', null, [], {}, 0, true, undefined])
            assert.throws(() => validate(pointer, value), /value/);
        assert.doesNotThrow(() => validate(pointer, ' {"literal":"not decoded"} '));
    }
    for (const collection of ['sections', 'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']) {
        const pointer = `/${collection}/0`;
        assert.doesNotThrow(() => validate(pointer, { existingNode: 'typed value' }));
        for (const value of ['', 'text', '{"tableIndex":1}', null, [], [1], 0, true, undefined])
            assert.throws(() => validate(pointer, value), /value/);
    }
});

test('typed spec：保持原 1–8 节点、根与路径边界，实际补丁继续拒绝越界重叠和危险节点', () => {
    const replacement = { path: '/tableBindings/0', value: { tableIndex: 1 } };
    for (const count of [0, 9]) assert.throws(() => manifest.validateSpec({ paperId: '2610.12345',
        replacements: Array.from({ length: count }, () => replacement) }), /1–8/);
    for (const pointer of ['/readerTitle', '/oneSentenceThesis', '/sections', '/tableBindings',
        '/conceptBridges', '/figurePlacements', '/formulaBindings', '/unrelated/0', '/sections/00/body',
        '/sections/-1/body', '/sections/0/heading', '/tableBindings/0/sourceQuotes', '/__proto__/0']) {
        assert.throws(() => manifest.validateSpec({ paperId: '2610.12345',
            replacements: [{ path: pointer, value: {} }] }), /path/);
    }
    const draft = { sections: [{ body: 'old body' }], tableBindings: [{ tableIndex: 1 }] };
    const preview = replacements => {
        const spec = { paperId: '2610.12345', replacements };
        manifest.validateSpec(spec);
        return manifest.buildSpecPreview({ paper: { arxivId: spec.paperId }, draft, spec,
            found: { absolutePath: '/unused-candidate.json', envelopeSha256: 'a'.repeat(64) }, sourceDescriptor: {} });
    };
    assert.throws(() => preview([{ path: '/tableBindings/1', value: { tableIndex: 2 } }]), /节点不存在/);
    assert.throws(() => preview([replacement, replacement]), /duplicate|overlap/i);
    assert.throws(() => preview([{ path: '/sections/0', value: { body: 'new body' } },
        { path: '/sections/0/body', value: 'new body' }]), /duplicate|overlap/i);
    assert.throws(() => preview([{ path: '/tableBindings/0', value: JSON.parse('{"constructor":{}}') }]), /unsafe key/);
    assert.throws(() => preview([{ path: '/tableBindings/0/body', value: 'not a permitted text field' }]),
        /not allowed|节点|data.*argument|undefined/i);
});

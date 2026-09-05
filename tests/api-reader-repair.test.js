const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    REPAIR_VERSION, hashDraft, parseRepairableDraft, collectDraftIssues, buildRepairTargets,
    applyReaderPatch, buildRepairContext, loadFailedCandidate, saveFailedCandidate, retireFailedCandidate
} = require('../scripts/lib/reader-repair.js');

function fixture() {
    const kinds = ['background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const draft = { version: 3, readerTitle: '从声音输入到执行输出的机制解释',
        oneSentenceThesis: '语音方法依次处理输入表征与条件约束，实验需保持对照设置一致，再解释指标变化支持的有限结论。',
        sections: kinds.map((kind, index) => ({ kind, heading: `声音处理中步骤 ${index + 1} 的输入输出如何衔接？`,
            body: `这一部分解释声音处理的${kind}环节，先限定输入信号，再描述信息如何沿组件传递。`.repeat(6) })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: ['声学表示', '语义条件'], sectionKind: 'method_overview',
            marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            explanation: '声学表示保存输入信号的发音结构，语义条件限定合理的内容范围，两者分工使预测既遵循声音证据也满足当前任务约束。'
        })), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    draft.sections[3].body += '\n\n' + draft.conceptBridges.map(item => item.marker).join('\n\n');
    return draft;
}

function patchFor(draft, replacements) {
    return { version: 1, draftSha256: hashDraft(draft), replacements: replacements.map(([pointer, value]) => {
        let old = draft;
        for (const part of pointer.slice(1).split('/')) old = old[part];
        return { path: pointer, oldSha256: hashDraft(old), value };
    }) };
}

function temporary(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-repair-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function failed(draft = fixture()) {
    return { status: 'failed', draft, rawDraft: JSON.stringify(draft), issues: [{ path: null, message: '仍未通过最终门禁' }],
        attempts: 1, fullAttempts: 1, noProgress: 0, failureSignature: 'failure' };
}

test('local replacements preserve every unselected node and reject stale/unauthorized patches', () => {
    const draft = fixture();
    const original = JSON.stringify(draft);
    const pointer = '/sections/2/body';
    const patch = patchFor(draft, [[pointer, '修正后的完整小节正文']]);
    const merged = applyReaderPatch(draft, patch, [pointer]);
    assert.equal(JSON.stringify(draft), original);
    assert.equal(merged.sections[2].body, '修正后的完整小节正文');
    for (let index = 0; index < draft.sections.length; index++) {
        if (index !== 2) assert.equal(hashDraft(merged.sections[index]), hashDraft(draft.sections[index]));
    }
    for (const field of ['conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']) {
        assert.equal(hashDraft(merged[field]), hashDraft(draft[field]));
    }
    assert.throws(() => applyReaderPatch(draft, { ...patch, draftSha256: '0'.repeat(64) }, [pointer]), /stale/);
    const staleNode = structuredClone(patch); staleNode.replacements[0].oldSha256 = '0'.repeat(64);
    assert.throws(() => applyReaderPatch(draft, staleNode, [pointer]), /stale node/);
    assert.throws(() => applyReaderPatch(draft, patch, []), /unauthorized/);
});

test('patch rejects duplicate, overlapping, prototype, unknown and out-of-range paths', () => {
    const draft = fixture();
    const patch = patchFor(draft, [['/sections/0/body', '修复']]);
    patch.replacements.push(structuredClone(patch.replacements[0]));
    assert.throws(() => applyReaderPatch(draft, patch, ['/sections/0/body']), /duplicate/);
    const overlap = patchFor(draft, [['/sections/0', draft.sections[0]], ['/sections/0/body', '修复']]);
    assert.throws(() => applyReaderPatch(draft, overlap, overlap.replacements.map(item => item.path)), /overlapping/);
    for (const pointer of ['/sections/99', '/sections/-1', '/sections/01', '/sections/0/kind', '/version', '/__proto__/polluted']) {
        const bad = { version: 1, draftSha256: hashDraft(draft), replacements: [{ path: pointer, oldSha256: 'x', value: {} }] };
        assert.throws(() => applyReaderPatch(draft, bad, [pointer]), /not allowed|out of bounds/);
    }
    const unsafe = JSON.parse('{"version":1,"__proto__":{"polluted":true}}');
    assert.throws(() => applyReaderPatch(draft, unsafe, []), /unsafe key/);
    const badValue = patchFor(draft, [['/sections/0', JSON.parse('{"constructor":{}}')]]);
    assert.throws(() => applyReaderPatch(draft, badValue, ['/sections/0']), /unsafe key/);
    assert.equal({}.polluted, undefined);
});

test('draft shape distinguishes a bounded full retry from patchable nodes', () => {
    assert.ok(parseRepairableDraft(JSON.stringify(fixture())));
    assert.equal(parseRepairableDraft('broken JSON'), null);
    for (const change of [draft => { draft.sections = []; }, draft => { draft.version = 2; },
        draft => { draft.extra = true; }, draft => { delete draft.formulaBindings; }]) {
        const draft = fixture(); change(draft); assert.equal(parseRepairableDraft(draft), null);
    }
});

test('patch cannot introduce or alter a figure whose pixels were absent from the repair request', () => {
    const draft = fixture();
    draft.figurePlacements.push({ figureOrdinal: 2, marker: '[[FIGURE_2]]', targetKind: 'result', focusPoints: [] });
    const patch = patchFor(draft, [['/sections/7/body', '图前说明\n\n[[FIGURE_2]]\n\n图后解释']]);
    assert.throws(() => applyReaderPatch(draft, patch, ['/sections/7/body'], { availableFigureOrdinals: [1] }), /pixels/);
    assert.doesNotThrow(() => applyReaderPatch(draft, patch, ['/sections/7/body'], { availableFigureOrdinals: [2] }));
});

test('independent diagnostics expose multiple bad nodes and bind their associated markers', () => {
    const draft = fixture();
    draft.sections[0].body = '太短';
    draft.sections[1].body = '也太短';
    draft.sections[3].body = draft.sections[3].body.replace('[[CONCEPT_BRIDGE_2]]', '');
    const issues = collectDraftIssues(draft, new Error('读者标题必须是 8-80 字符'));
    for (const pointer of ['/sections/0/body', '/sections/1/body', '/conceptBridges/1']) {
        assert.ok(issues.some(issue => issue.path === pointer));
    }
    const targets = buildRepairTargets(draft, issues);
    assert.ok(targets.some(target => target.path === '/readerTitle'));
    assert.ok(targets.some(target => target.path === '/sections/3/body'));
    const context = buildRepairContext(draft, issues, '完整来源', '完整来源');
    assert.equal(context.draftSha256, hashDraft(draft));
    assert.equal(context.evidenceMode, 'full-evidence-local-output');
    assert.equal(context.evidence, '完整来源');
});

test('deterministic table selections expose the binding and its marker section as patch targets', () => {
    const draft = fixture();
    draft.tableBindings.push({ tableIndex: 1, selection: { sourceTableOrdinal: 2, sourceRows: [0, 1], sourceColumns: [0, 2] } });
    draft.sections[7].body += '\n\n[[TABLE_1]]';
    const targets = buildRepairTargets(draft, [{ path: null, message: 'tableBindings[0] 来源列无效' }]);
    assert.ok(targets.some(target => target.path === '/tableBindings/0'));
    assert.ok(targets.some(target => target.path === '/sections/7/body'));
    draft.sections[7].body = draft.sections[7].body.replace('[[TABLE_1]]', '');
    assert.ok(collectDraftIssues(draft).some(issue => issue.path === '/tableBindings/0'));
});

test('all malformed quote bindings, marker-only tables and insufficient length are diagnosed in one pass', () => {
    const draft = fixture();
    draft.tableBindings = [1, 2].map(tableIndex => ({ tableIndex, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [{ renderedRow: 0, renderedColumn: 0, quoteIndex: 0, value: '数据集' }], sourceQuotes: ['3.093.09'] }));
    draft.sections[7].body += '\n\n[[TABLE_1]]'; draft.sections[8].body += '\n\n[[TABLE_2]]';
    const issues = collectDraftIssues(draft, new Error('读者文章存在未绑定的 TABLE marker'), { sourceText: '原文中实际的连续证据很长，但这里只列出了一个数字 3.093.09。' });
    for (const index of [0, 1]) {
        assert.ok(issues.some(issue => issue.path === `/tableBindings/${index}` && /cellBindings 必须是 \[\]/.test(issue.message)));
        assert.ok(issues.some(issue => issue.path === `/tableBindings/${index}` && /sourceQuotes 的索引/.test(issue.message)));
    }
    assert.ok(issues.some(issue => /实际Markdown表 0 张/.test(issue.message)));
    assert.ok(issues.some(issue => issue.code === 'reader_length_preflight' && issue.diagnosticOnly));
    const targets = buildRepairTargets(draft, issues);
    for (const pointer of ['/tableBindings/0', '/tableBindings/1', '/sections/7/body', '/sections/8/body', '/sections/0/body']) {
        assert.ok(targets.some(target => target.path === pointer), pointer);
    }
    assert.equal(targets.some(target => /^\/sections\/\d+$/.test(target.path)), false, 'body diagnostics never duplicate whole section targets');
    assert.throws(() => applyReaderPatch(draft, patchFor(draft,
        targets.filter(target => target.path.endsWith('/body')).slice(0, 9).map(target => [target.path, target.value])),
    targets.map(target => target.path)), /invalid shape/, 'expanded allowlist does not raise the 8-node patch cap');
});

test('malformed internal concept values produce diagnostics rather than exceptions', () => {
    for (const terms of ['声学表示', { term: '声学表示' }, null]) {
        const draft = fixture(); draft.conceptBridges[0].terms = terms;
        assert.ok(parseRepairableDraft(draft));
        const issues = collectDraftIssues(draft, new Error('conceptBridges[0].terms 非法'));
        assert.ok(issues.some(issue => issue.path === '/conceptBridges/0' && /terms 必须/.test(issue.message)));
    }
});

test('a section-shape repair target subsumes its body without duplicate prompt context', () => {
    const draft = fixture();
    const targets = buildRepairTargets(draft, [{ path: '/sections/0/body', message: 'sections[0].body 需要修改' },
        { path: '/sections/0', message: 'sections[0].heading 需要修改' }]);
    assert.ok(targets.some(target => target.path === '/sections/0'));
    assert.ok(!targets.some(target => target.path === '/sections/0/body'));
});

test('candidate storage is atomic, private, input-specific, and never a success receipt', t => {
    const directory = temporary(t);
    const identity = { version: REPAIR_VERSION, input: 'a', source: 'b', model: 'c', prompt: 'd' };
    assert.equal(loadFailedCandidate(directory, identity), null);
    const filename = saveFailedCandidate(directory, identity, failed());
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.deepEqual(loadFailedCandidate(directory, identity), failed());
    for (const field of ['input', 'source', 'model', 'prompt']) {
        assert.equal(loadFailedCandidate(directory, { ...identity, [field]: 'changed' }), null);
    }
    assert.deepEqual(fs.readdirSync(directory), [path.basename(filename)]);
    assert.throws(() => saveFailedCandidate(directory, identity, { ...failed(), status: 'complete' }), /cannot certify/);
    const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'));
    envelope.payload.draft.sections[0].body = 'unsigned modification';
    fs.writeFileSync(filename, JSON.stringify(envelope));
    assert.throws(() => loadFailedCandidate(directory, identity), /Corrupt/);
});

test('candidate rejects symlink directories/files, altered identity and damaged JSON', t => {
    const directory = temporary(t);
    const identity = { model: 'm' };
    const targetDirectory = path.join(directory, 'target'); fs.mkdirSync(targetDirectory);
    const linked = path.join(directory, 'linked'); fs.symlinkSync(targetDirectory, linked);
    assert.throws(() => saveFailedCandidate(linked, identity, failed()), /Unsafe/);
    const filename = saveFailedCandidate(directory, identity, failed());
    const envelope = JSON.parse(fs.readFileSync(filename, 'utf8')); envelope.identity.model = 'changed';
    fs.writeFileSync(filename, JSON.stringify(envelope));
    assert.throws(() => loadFailedCandidate(directory, identity), /drifted/);
    fs.writeFileSync(filename, '{not JSON');
    assert.throws(() => loadFailedCandidate(directory, identity), /refused/);
    fs.unlinkSync(filename);
    const target = path.join(targetDirectory, 'target.json'); fs.writeFileSync(target, '{}', { mode: 0o600 });
    fs.symlinkSync(target, filename);
    assert.throws(() => loadFailedCandidate(directory, identity), /refused/);
    assert.throws(() => saveFailedCandidate(directory, identity, failed()), /Unsafe/);
    assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});

test('resolved failures are recoverably retired and cannot resurrect as a candidate', t => {
    const directory = temporary(t);
    const identity = { input: 'same signed input' };
    const original = saveFailedCandidate(directory, identity, failed());
    const bytes = fs.readFileSync(original);
    assert.equal(retireFailedCandidate(directory, { input: 'different input' }), null);
    assert.ok(fs.existsSync(original));
    const retired = retireFailedCandidate(directory, identity);
    assert.match(retired, /\.resolved\.json$/);
    assert.equal(fs.statSync(retired).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(retired), bytes);
    assert.equal(fs.existsSync(original), false);
    assert.equal(loadFailedCandidate(directory, identity), null);
    assert.equal(retireFailedCandidate(directory, identity), null);
});

test('production loop bounds malformed full replies and persists the failure', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    let calls = 0;
    await assert.rejects(generateApiReaderArticleDetailed({ arxivId: '2609.99991', title: '离线故障' }, 'canonical', '', {
        sourceText: 'source', readerAttemptsDir: directory,
        readerRecordDisposition: () => {},
        readerCallModel: async messages => {
            calls++;
            assert.ok(messages[0].content[0].text.includes(require('../scripts/lib/reader-source-diagnostics.js').readerNumericSpellingGuidance()));
            return 'invalid JSON';
        }, readerMaterializeFigures: async () => []
    }));
    assert.equal(calls, 2);
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
    assert.equal(envelope.payload.status, 'failed');
    assert.equal(envelope.payload.attempts, 2);
    assert.equal(envelope.payload.draft, null);
});

test('production resume requests only a patch and still rejects incomplete merged prose', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const paper = { arxivId: '2609.99992', title: '离线恢复' };
    const draft = fixture(); draft.readerTitle = '短'; draft.sections[0].body = '太短';
    const base = { sourceText: 'source', readerAttemptsDir: directory, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
    let initialCalls = 0;
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '完整论文证据', {
        ...base, readerMaxAttempts: 2, readerCallModel: async () => {
            if (++initialCalls === 1) return JSON.stringify(draft);
            throw new Error('simulated interruption before patch response');
        }
    }), /simulated interruption/);
    let calls = 0;
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '完整论文证据', {
        ...base, readerMaxAttempts: 2, readerCallModel: async (messages, budget, options) => {
            calls++;
            assert.ok(budget <= 8000);
            assert.equal(options.usageContext.stage, 'apiReaderRepair');
            const prompt = messages[0].content[0].text;
            assert.ok(prompt.includes(require('../scripts/lib/reader-source-diagnostics.js').readerNumericSpellingGuidance()));
            assert.match(prompt, /允许修改的节点/);
            assert.doesNotMatch(prompt, /现有 canonical 分析/);
            return JSON.stringify(patchFor(draft, [['/readerTitle', '声音表示如何与语义条件连接起来']]));
        }
    }), /body 至少/);
    assert.equal(calls, 1);
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
    assert.equal(envelope.payload.attempts, 2);
    assert.equal(envelope.payload.draft.sections[0].body, '太短');
    assert.equal(envelope.payload.draft.readerTitle, '声音表示如何与语义条件连接起来');
});

test('production recovery persists canonical section/table pairs with raw-to-canonical SHA mappings', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order.js');
    const directory = temporary(t);
    const paper = { arxivId: '2609.99981', title: '离线排序恢复' };
    const draft = fixture(); draft.readerTitle = '短';
    const row = label => `\n\n| 方法 | 得分 |\n| --- | --- |\n| ${label} | 20 |`;
    draft.sections[7].body += row('result');
    draft.sections[8].body += row('ablation');
    draft.sections[6].body += row('setup');
    [draft.sections[6], draft.sections[7], draft.sections[8]] = [draft.sections[7], draft.sections[8], draft.sections[6]];
    draft.tableBindings = ['result', 'ablation', 'setup'].map((quote, index) => ({ tableIndex: index + 1,
        sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [`${quote} source quote`] }));
    draft.conceptBridges.reverse();
    const normalized = normalizeReaderDraftOrder(draft);
    const base = { sourceText: 'source', readerAttemptsDir: directory, readerMaterializeFigures: async () => [],
        readerRecordDisposition: () => {}, readerMaxAttempts: 2 };
    let calls = 0;
    await assert.rejects(generateApiReaderArticleDetailed(paper, '', '', { ...base, readerCallModel: async () => {
        if (++calls === 1) return JSON.stringify(draft);
        throw new Error('offline transport interruption');
    } }), /offline transport interruption/);
    const filename = path.join(directory, fs.readdirSync(directory)[0]);
    const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.deepEqual(stored.payload.draft, normalized.draft);
    assert.deepEqual(stored.payload.draftOrderMappings, [normalized.mapping]);
    assert.equal(stored.payload.attempts, 1);
    assert.equal(stored.payload.fullAttempts, 1);
    assert.equal(stored.identity.draftOrderContract, 'reader-draft-order-v2');
    assert.deepEqual(stored.payload.draftOrderMappings[0].conceptBridges.map(item => item.rawIndex), [3, 2, 1, 0]);
    await assert.rejects(generateApiReaderArticleDetailed(paper, '', '', { ...base, readerCallModel: async messages => {
        assert.match(messages[0].content[0].text, new RegExp(hashDraft(normalized.draft)));
        return JSON.stringify(patchFor(normalized.draft, [['/readerTitle', '短']]));
    } }), /读者标题/);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).payload.draftOrderMappings, [normalized.mapping]);
});

test('an exhausted candidate receives a free full-parser replay: valid retires, invalid cannot request again', async t => {
    const { generateApiReaderArticleDetailed, parseApiReaderArticleResult } = require('../scripts/deep-analyzer.js');
    const crypto = require('node:crypto');
    const directory = temporary(t), paper = { arxivId: '2609.99980', title: '离线耗尽验证' };
    const sourceText = '在统一数据协议与输入条件下，基线和完整方法的报告得分均为1.0，仅用于当前离线对照。';
    const artifacts = { tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex') };
    artifacts.payloadSha256 = hashDraft(artifacts);
    const base = { sourceText, structuredArtifacts: artifacts, readerAttemptsDir: directory,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {}, readerMaxAttempts: 1 };
    const invalid = fixture(); invalid.readerTitle = '短';
    await assert.rejects(generateApiReaderArticleDetailed(paper, '', '', {
        ...base, readerCallModel: async () => JSON.stringify(invalid)
    }), /读者标题/);
    let calls = 0;
    const noMoreCalls = async () => { calls++; throw new Error('must not call'); };
    await assert.rejects(generateApiReaderArticleDetailed(paper, '', '', {
        ...base, readerCallModel: noMoreCalls
    }), /exhausted/);
    assert.equal(calls, 0);
    const valid = fixture();
    valid.sections.forEach((section, index) => {
        section.body = [
            `进入第${index + 1}个教学阶段时，先固定这一阶段的输入、输出和失败现象。读者需要知道当前处理的是哪一类信号，它经过什么变换，以及哪个可观测结果才能证明这步确实工作。`,
            `第${index + 1}个环节对应的类型是${section.kind}，它不单独追求一个更好看的数字，而是把控制变量、基线、指标方向和证据来源放在同一口径下。只有比较条件一致，后续差异才有解释价值。`,
            `在第${index + 1}个环节的方法层面应沿着数据流检查：原始观测先变成可学习表示，组件再选择或融合证据，目标函数最后把这些选择投影到任务输出。任何一环没有说清，初学者都会把相关性错当成因果。`,
            `第${index + 1}个环节的实验层面则要同时读正面结果与反例。最强结果能说明当前设置下的净收益，未胜出项、未报告方差和缺失的跨域测试则限定该结论能走多远。这些边界不是附注，而是论证的一部分。`,
            `因此，第${index + 1}个教学阶段最终要交给下一节的不是一句重复摘要，而是一份可执行的核对清单：哪些事实来自原文，哪些解释需要消融，哪些判断还缺对照或测量。沿着这份清单，文章才能逐步收紧中心问题。`,
            `完成第${index + 1}个阶段的比较后，还要说明观测条件发生变化时哪些推断需要重新核对。数据采样与部署环境不完全一致时，当前证据仍然有用，但必须结合新的基线实验确定模型是否保留原有优势。`
        ].join('\n\n');
    });
    valid.conceptBridges.forEach((bridge, index) => { bridge.terms = [`语义锚点${index + 1}`, `声学证据${index + 1}`];
        bridge.explanation = `语义锚点${index + 1}负责限定当前候选的意义范围，声学证据${index + 1}负责核对发音与时序细节。两者搭配后才能把语义排除与声学定位连成可检验的决策链。`; });
    valid.sections[3].body += '\n\n' + valid.conceptBridges.map(item => item.marker).join('\n\n');
    [6, 7].forEach((sectionIndex, index) => {
        valid.sections[sectionIndex].body += '\n\n下表比较统一数据协议中的报告值，输入条件和基线保持一致，得分越高越好。\n\n'
            + '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n'
            + `| ${index ? '完整方法' : '基线'} | 统一设置 | 测试集 | 越高越好 | 1.0 | 仅支持当前口径 |\n\n`
            + `第${index + 1}张表中数字只能支持当前数据和控制条件下的比较，原始输入范围与评估样本规模都必须保持一致。它没有覆盖的反例、方差、跨域条件和部署成本仍然是结论边界，不能从一行数字向外推广。`;
        valid.tableBindings.push({ tableIndex: index + 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: [sourceText] });
    });
    assert.doesNotThrow(() => parseApiReaderArticleResult(JSON.stringify(valid), { sourceText, structuredArtifacts: artifacts,
        requiredVersion: 3, requireSourceBindings: true, requireIntegratedTables: true, minimumIntegratedTables: 2 }));
    const reordered = structuredClone(valid);
    reordered.conceptBridges.reverse();
    const parserOptions = { sourceText, structuredArtifacts: artifacts, requiredVersion: 3,
        requireSourceBindings: true, requireIntegratedTables: true, minimumIntegratedTables: 2 };
    assert.deepEqual(parseApiReaderArticleResult(JSON.stringify(reordered), parserOptions),
        parseApiReaderArticleResult(JSON.stringify(valid), parserOptions));
    for (const badMarker of ['[[CONCEPT_BRIDGE_2]]', '[[CONCEPT_BRIDGE_5]]', 'invalid']) {
        const invalidBridges = structuredClone(valid);
        invalidBridges.conceptBridges[0].marker = badMarker;
        assert.throws(() => parseApiReaderArticleResult(JSON.stringify(invalidBridges), parserOptions),
            /conceptBridges\[0\].*未形成有效术语桥/);
    }
    const filename = path.join(directory, fs.readdirSync(directory)[0]);
    const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'));
    saveFailedCandidate(directory, envelope.identity, { ...envelope.payload, draft: valid, rawDraft: JSON.stringify(valid),
        noProgress: 2, failureSignature: 'old implementation failure' });
    const result = await generateApiReaderArticleDetailed(paper, '', '', { ...base, readerCallModel: noMoreCalls });
    assert.equal(calls, 0); assert.equal(result.attempts, 1);
    assert.equal(result.resumedCandidate, true); assert.match(result.retiredCandidate, /resolved\.json$/);
});

test('production stops unchanged patches and refuses another call on exhausted recovery', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const paper = { arxivId: '2609.99993', title: '离线无进展' };
    const draft = fixture(); draft.readerTitle = '短';
    let calls = 0;
    const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaterializeFigures: async () => [],
        readerRecordDisposition: () => {},
        readerCallModel: async () => (++calls === 1 ? JSON.stringify(draft)
            : JSON.stringify(patchFor(draft, [['/readerTitle', '短']]))) };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /连续无进展/);
    assert.equal(calls, 3);
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /exhausted/);
    assert.equal(calls, 3);
});

test('transport failure preserves the latest candidate and source drift starts a separate identity', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const paper = { arxivId: '2609.99994', title: '离线网络故障' };
    const draft = fixture(); draft.readerTitle = '短';
    const dispositions = [];
    let calls = 0;
    const options = { sourceText: 'source-a', readerAttemptsDir: directory, readerMaterializeFigures: async () => [],
        readerRecordDisposition: event => dispositions.push(event),
        readerCallModel: async () => {
            calls++;
            if (calls === 1) return JSON.stringify(draft);
            throw new Error('simulated connection reset');
        } };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /connection reset/);
    const firstFilename = fs.readdirSync(directory)[0];
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, firstFilename), 'utf8'));
    assert.equal(envelope.payload.attempts, 1);
    assert.equal(envelope.payload.fullAttempts, 1);
    assert.equal(envelope.payload.transportFailures, 1);
    assert.equal(hashDraft(envelope.payload.draft), hashDraft(draft));
    assert.equal(dispositions.length, 1);
    assert.equal(dispositions[0].disposition, 'rejected');
    assert.equal(dispositions[0].outputTextSha256, require('../scripts/lib/reader-repair.js').shaText(JSON.stringify(draft)));
    let seenStage;
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', {
        ...options, sourceText: 'source-b',
        readerCallModel: async (_messages, _budget, requestOptions) => {
            seenStage = requestOptions.usageContext.stage;
            throw new Error('simulated source-b interruption');
        }
    }), /source-b interruption/);
    assert.equal(seenStage, 'apiReaderArticle');
    assert.equal(fs.readdirSync(directory).length, 2);
    assert.equal(fs.readFileSync(path.join(directory, firstFilename), 'utf8'), JSON.stringify(envelope));
});

test('changed pixel evidence refuses candidate reuse before another model request', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const candidateDirectory = path.join(directory, 'candidates');
    const imagePath = path.join(directory, 'figure.png');
    fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=', 'base64'));
    const url = 'https://arxiv.org/html/2609.99995/figure.png';
    const sourceEvidence = `FIGURE_1: 论文的真实方法图\nFIGURE_1_URL: ${url}`;
    const paper = { arxivId: '2609.99995', title: '离线像素变化' };
    const draft = fixture(); draft.readerTitle = '短';
    let calls = 0;
    const options = { sourceText: 'source', readerAttemptsDir: candidateDirectory, readerRecordDisposition: () => {},
        readerMaxAttempts: 2, readerCallModel: async () => {
            if (++calls === 1) return JSON.stringify(draft);
            throw new Error('simulated interruption before patch response');
        },
        readerMaterializeFigures: async () => [{ url, cachePath: imagePath, assetSha256: 'a'.repeat(64) }] };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', sourceEvidence, options), /simulated interruption/);
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', sourceEvidence, {
        ...options, readerMaxAttempts: 2,
        readerMaterializeFigures: async () => [{ url, cachePath: imagePath, assetSha256: 'b'.repeat(64) }]
    }), /image evidence drifted/);
    assert.equal(calls, 2);
});

test('two initial network failures do not consume received-content or malformed-root budgets', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const paper = { arxivId: '2609.99996', title: '初次生成网络恢复' };
    const draft = fixture(); draft.readerTitle = '短';
    let calls = 0;
    const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 1,
        readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
        readerCallModel: async (_messages, _budget, requestOptions) => {
            calls++;
            assert.equal(requestOptions.usageContext.stage, 'apiReaderArticle');
            assert.equal(requestOptions.usageContext.contentAttempt, 1);
            if (calls <= 2) throw new Error('simulated initial network failure');
            return JSON.stringify(draft);
        } };
    for (let iteration = 1; iteration <= 2; iteration++) {
        await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /network failure/);
        assert.equal(calls, iteration, 'one transport failure ends the current invocation');
        const envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
        assert.equal(envelope.payload.attempts, 0);
        assert.equal(envelope.payload.fullAttempts, 0);
        assert.equal(envelope.payload.noProgress, 0);
        assert.equal(envelope.payload.transportFailures, iteration);
    }
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /标题/);
    assert.equal(calls, 3);
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
    assert.equal(envelope.payload.attempts, 1);
    assert.equal(envelope.payload.fullAttempts, 1);
    assert.equal(envelope.payload.transportFailures, 2);
});

test('network failure during a patch preserves the candidate and resumes a patch with the same content attempt', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const paper = { arxivId: '2609.99997', title: '局部修复网络恢复' };
    const draft = fixture(); draft.readerTitle = '短'; draft.sections[0].body = '太短';
    const stages = [];
    let calls = 0;
    const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 2,
        readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
        readerCallModel: async (_messages, _budget, requestOptions) => {
            calls++;
            stages.push([requestOptions.usageContext.stage, requestOptions.usageContext.contentAttempt]);
            if (calls === 1) return JSON.stringify(draft);
            if (calls === 2) throw new Error('simulated patch connection failure');
            return JSON.stringify(patchFor(draft, [['/readerTitle', '声音表示如何与语义条件连接起来']]));
        } };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /connection failure/);
    let envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
    assert.equal(envelope.payload.attempts, 1);
    assert.equal(envelope.payload.noProgress, 0);
    assert.equal(envelope.payload.transportFailures, 1);
    assert.equal(hashDraft(envelope.payload.draft), hashDraft(draft));
    assert.ok(envelope.payload.issues.some(issue => /标题/.test(issue.message)));
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /body 至少/);
    assert.equal(calls, 3);
    assert.deepEqual(stages, [['apiReaderArticle', 1], ['apiReaderRepair', 2], ['apiReaderRepair', 2]]);
    envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
    assert.equal(envelope.payload.attempts, 2);
    assert.equal(envelope.payload.fullAttempts, 1);
    assert.equal(envelope.payload.transportFailures, 1);
    assert.equal(envelope.payload.draft.readerTitle, '声音表示如何与语义条件连接起来');
    assert.equal(envelope.payload.draft.sections[0].body, '太短');
});

test('changing the actual content-attempt budget changes candidate identity', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const paper = { arxivId: '2609.99998', title: '预算身份检查' };
    const draft = fixture(); draft.readerTitle = '短';
    const options = { sourceText: 'source', readerAttemptsDir: directory, readerRecordDisposition: () => {},
        readerMaterializeFigures: async () => [] };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', {
        ...options, readerMaxAttempts: 1, readerCallModel: async () => JSON.stringify(draft)
    }), /标题/);
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', {
        ...options, readerMaxAttempts: 2, readerCallModel: async (_messages, _tokens, requestOptions) => {
            assert.equal(requestOptions.usageContext.stage, 'apiReaderArticle');
            throw new Error('budget-specific fresh request');
        }
    }), /budget-specific fresh request/);
    assert.equal(fs.readdirSync(directory).length, 2);
    const budgets = fs.readdirSync(directory).map(filename => JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8')).identity.maxAttempts);
    assert.deepEqual(budgets.sort(), [1, 2]);
});

test('received truncated or incomplete full responses consume content and full budgets across invocations', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    for (const code of ['MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE']) {
        const directory = temporary(t);
        const paper = { arxivId: '2609.99989', title: '已收到截断内容的预算' };
        let calls = 0;
        const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 3,
            readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
            readerCallModel: async () => {
                calls++;
                throw Object.assign(new Error(`${code}: simulated provider output termination`), {
                    code, retryable: false, outputTokens: 24000, maxOutputTokens: 24000,
                    partialText: '{"version":3,"sections":['
                });
            } };
        for (let iteration = 1; iteration <= 2; iteration++) {
            await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), error => error.code === code);
            assert.equal(calls, iteration, 'a terminated response ends this invocation');
            const envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
            assert.equal(envelope.payload.attempts, iteration, `${code} must consume received-content budget`);
            assert.equal(envelope.payload.fullAttempts, iteration, `${code} must consume full-response budget`);
            assert.equal(envelope.payload.transportFailures || 0, 0);
            assert.equal(envelope.payload.draft, null, 'partial output must never become a candidate');
        }
        await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /root JSON|exhausted/);
        assert.equal(calls, 2, 'the third invocation cannot purchase another identical full response');
    }
});

test('received truncated or incomplete patch responses consume content budget without modifying the prior candidate', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    for (const code of ['MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE']) {
        const directory = temporary(t);
        const paper = { arxivId: '2609.99988', title: '补丁截断内容预算' };
        const draft = fixture(); draft.readerTitle = '短';
        let calls = 0;
        const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 2,
            readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
            readerCallModel: async () => {
                if (++calls === 1) return JSON.stringify(draft);
                throw Object.assign(new Error(`${code}: simulated patch output termination`), {
                    code, retryable: false, outputTokens: 8000, maxOutputTokens: 8000,
                    partialText: '{"version":1,"replacements":['
                });
            } };
        await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), error => error.code === code);
        assert.equal(calls, 2);
        const envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
        assert.equal(envelope.payload.attempts, 2, `${code} patch must consume its received-content attempt`);
        assert.equal(envelope.payload.fullAttempts, 1, 'patch truncation is not a full-response attempt');
        assert.equal(envelope.payload.transportFailures || 0, 0);
        assert.equal(hashDraft(envelope.payload.draft), hashDraft(draft));
        await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /exhausted/);
        assert.equal(calls, 2, 'exhausted content budget prevents another patch request');
    }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    REPAIR_VERSION, hashDraft, parseRepairableDraft, collectDraftIssues, buildRepairTargets,
    applyReaderPatch, buildRepairContext, loadFailedCandidate, saveFailedCandidate, retireFailedCandidate,
    validationFailureSignature, validationFailureHasNoProgress,
    TABLE_COUNT_ISSUE_CODE, readTableCountIssue, hashRecoveryIssues,
    classifyTableBindingOrderIssue, readTableBindingOrderIssue,
    classifyTableBindingOrderError, readTableBindingOrderError
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

function countRepairFixture(tableCount = 3, bindingCount = 3) {
    const draft = fixture();
    for (let index = 0; index < tableCount; index++) {
        const sectionIndex = [6, 7, 8, 8][index];
        draft.sections[sectionIndex].body += `\n\n表 ${index + 1} 比较相同条件下的结果与指标方向。\n\n`
            + '| 方法 | 条件 | 指标 A | 指标 B | 指标 C |\n| --- | --- | --- | --- | --- |\n'
            + `| 方法 ${index + 1} | 统一设置 | 10 | 20 | 30 |\n\n`
            + '该结果只适用于当前测试条件，其他数据分布仍需验证。';
    }
    draft.tableBindings = Array.from({ length: bindingCount }, (_, index) => ({
        tableIndex: index + 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: [`source quote ${index + 1} is long enough for binding`]
    }));
    return draft;
}

function countIssue(actualCount = 3, message = '表格不足，请补齐。') {
    return { path: null, code: TABLE_COUNT_ISSUE_CODE, requiredCount: 4, actualCount, message };
}

test('局部替换保留每个未选中的节点，拒绝过期或未授权的补丁', () => {
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
    let staleError;
    try { applyReaderPatch(draft, staleNode, [pointer]); } catch (error) { staleError = error; }
    assert.equal(staleError?.code, 'READER_PATCH_STALE_NODE_SHA');
    assert.equal(staleError?.readerIssue?.path, pointer);
    assert.equal(staleError?.readerIssue?.code, 'reader_patch_stale_node_sha');
    assert.match(staleError?.message || '', new RegExp(`received=${'0'.repeat(64)}`));
    assert.match(staleError?.message || '', new RegExp(`expected-current=${patch.replacements[0].oldSha256}`));
    assert.equal(JSON.stringify(draft), original, 'stale patch must not change any candidate byte');
    assert.throws(() => applyReaderPatch(draft, patch, []), /unauthorized/);
});

test('过期节点恢复按当前候选 SHA 重建精确目标', () => {
    const draft = fixture();
    const pointer = '/sections/8/body';
    const stale = '0'.repeat(64);
    const targets = buildRepairTargets(draft, [{ path: null,
        message: `Reader patch rejected: Reader patch has stale node SHA: ${pointer}; received=${stale}` }]);
    assert.deepEqual(targets.map(target => target.path), [pointer]);
    assert.equal(targets[0].oldSha256, hashDraft(draft.sections[8].body));
    assert.notEqual(targets[0].oldSha256, stale);
});

test('阻塞性标记的修复不会扩大成只作诊断的表格改写', () => {
    const draft = fixture();
    draft.conceptBridges[2].sectionKind = 'problem';
    const marker = draft.conceptBridges[2].marker;
    draft.sections[3].body = draft.sections[3].body.replace(marker, '');
    draft.sections[4].body += `\n\n${marker}`;
    draft.tableBindings = [0, 1, 2, 3].map(index => ({ tableIndex: index + 1,
        sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [],
        sourceQuotes: [`diagnostic quote ${index}`] }));
    const issues = [
        { path: '/conceptBridges/2', message: 'conceptBridges[2] marker 必须唯一独占一段并位于声明 kind 小节' },
        ...draft.tableBindings.map((_binding, index) => ({ path: `/tableBindings/${index}`,
            diagnosticOnly: true, message: `tableBindings[${index}] sourceQuotes 仅供诊断` }))
    ];
    const targets = buildRepairTargets(draft, issues);
    assert.deepEqual(targets.map(target => target.path), [
        '/sections/4/body', '/sections/2/body'
    ]);
    assert.ok(targets.length <= 8);
    assert.ok(targets.every(target => target.oldSha256 === hashDraft(
        draft.sections[Number(target.path.match(/sections\/(\d+)/)[1])].body
    )));

    const diagnosticOnly = buildRepairTargets(draft, [issues.at(-1)]);
    assert.ok(diagnosticOnly.some(target => target.path === '/tableBindings/3'),
        'diagnostics remain actionable when no blocking issue exists');
});

test('多个重复的概念标记仍在补丁约定范围内，且只授权正文', () => {
    const draft = fixture();
    for (const bridge of draft.conceptBridges) {
        draft.sections[3].body = draft.sections[3].body.replace(bridge.marker, '');
    }
    const placements = [
        { sectionKind: 'component', sections: [3, 4] },
        { sectionKind: 'ablation', sections: [4, 8] },
        { sectionKind: 'reproduction', sections: [5, 10] },
        { sectionKind: 'synthesis', sections: [5, 11] }
    ];
    placements.forEach((placement, index) => {
        const bridge = draft.conceptBridges[index];
        bridge.sectionKind = placement.sectionKind;
        placement.sections.forEach(sectionIndex => {
            draft.sections[sectionIndex].body += `\n\n${bridge.marker}`;
        });
    });
    const issues = [
        { path: null, message: '读者文章 conceptBridges[0] 未形成有效术语桥'
            + '（markerOccurrences=2；已有marker必须唯一独占一段且位于声明小节）' },
        ...draft.conceptBridges.map((_bridge, index) => ({ path: `/conceptBridges/${index}`,
            message: `conceptBridges[${index}] marker 必须唯一独占一段并位于声明 kind 小节` })),
        { path: null, message: 'Reader patch rejected: Reader patch has invalid shape or stale draft SHA' }
    ];
    const paths = buildRepairTargets(draft, issues).map(target => target.path);
    assert.deepEqual(paths, [
        '/sections/3/body', '/sections/4/body', '/sections/8/body',
        '/sections/5/body', '/sections/10/body', '/sections/11/body'
    ]);
    assert.equal(paths.length, 6);
    assert.ok(paths.every(pointer => pointer.startsWith('/sections/')));
    const currentIssues = structuredClone(issues);
    currentIssues[0].message = currentIssues[0].message
        .replace('未形成有效术语桥', '的占位标记、解释长度或所在小节不符合要求')
        .replace('已有marker必须唯一独占一段且位于声明小节',
            '已有占位标记须在指定小节中独占一段，且全文只能出现一次');
    assert.deepEqual(buildRepairTargets(draft, currentIssues).map(target => target.path), paths);
    const legacyDiagnosticPaths = buildRepairTargets(draft, [issues[0]]).map(target => target.path);
    assert.deepEqual(legacyDiagnosticPaths, ['/sections/3/body', '/sections/4/body']);
    assert.deepEqual(buildRepairTargets(draft, [currentIssues[0]]).map(target => target.path),
        legacyDiagnosticPaths);
});

test('混合的阻塞诊断最多只能授权补丁协议允许的节点数，不会再多了', () => {
    const draft = fixture();
    ['background', 'related_work', 'problem', 'component'].forEach((sectionKind, index) => {
        draft.conceptBridges[index].sectionKind = sectionKind;
    });
    const issues = [
        { path: null, message: 'readerTitle 必须改为论文特有标题' },
        ...draft.conceptBridges.map((_bridge, index) => ({ path: `/conceptBridges/${index}`,
            message: `conceptBridges[${index}] marker 必须唯一独占一段并位于声明 kind 小节` }))
    ];
    const paths = buildRepairTargets(draft, issues).map(target => target.path);
    assert.equal(paths.length, 8);
    assert.equal(paths[0], '/readerTitle');
});

test('补丁拒绝重复、重叠、原型、未知和越界的路径', () => {
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

test('草稿形态区分有上限的整篇重试和可打补丁的节点', () => {
    assert.ok(parseRepairableDraft(JSON.stringify(fixture())));
    assert.equal(parseRepairableDraft('broken JSON'), null);
    for (const change of [draft => { draft.sections = []; }, draft => { draft.version = 2; },
        draft => { draft.extra = true; }, draft => { delete draft.formulaBindings; }]) {
        const draft = fixture(); change(draft); assert.equal(parseRepairableDraft(draft), null);
    }
});

test('修复请求里没有像素的图，补丁不能新增也不能改动', () => {
    const draft = fixture();
    draft.figurePlacements.push({ figureOrdinal: 2, marker: '[[FIGURE_2]]', targetKind: 'result', focusPoints: [] });
    const patch = patchFor(draft, [['/sections/7/body', '图前说明\n\n[[FIGURE_2]]\n\n图后解释']]);
    assert.throws(() => applyReaderPatch(draft, patch, ['/sections/7/body'], { availableFigureOrdinals: [1] }), /pixels/);
    assert.doesNotThrow(() => applyReaderPatch(draft, patch, ['/sections/7/body'], { availableFigureOrdinals: [2] }));
});

test('独立诊断能暴露多个问题节点，并绑定各自关联的标记', () => {
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

test('结果确定的表格选择会把绑定及其标记所在小节暴露为补丁目标', () => {
    const draft = fixture();
    draft.tableBindings.push({ tableIndex: 1, selection: { sourceTableOrdinal: 2, sourceRows: [0, 1], sourceColumns: [0, 2] } });
    draft.sections[7].body += '\n\n[[TABLE_1]]';
    const targets = buildRepairTargets(draft, [{ path: null, message: 'tableBindings[0] 来源列无效' }]);
    assert.ok(targets.some(target => target.path === '/tableBindings/0'));
    assert.ok(targets.some(target => target.path === '/sections/7/body'));
    draft.sections[7].body = draft.sections[7].body.replace('[[TABLE_1]]', '');
    assert.ok(collectDraftIssues(draft).some(issue => issue.path === '/tableBindings/0'));
});

test('图位置错位的修复会同时暴露绑定、声明的小节和实际标记小节', () => {
    const draft = fixture();
    draft.figurePlacements.push({ figureOrdinal: 4, marker: '[[FIGURE_4]]',
        targetKind: 'result', focusPoints: ['先看横轴与纵轴分别编码什么', '再比较各条件的相对变化方向'] });
    draft.sections[10].body += '\n\n图前导读已经基于真实像素说明应按什么顺序观察且长度满足要求。'
        + '\n\n[[FIGURE_4]]\n\n图后解释只总结已经写出的观察与证据边界，不增加任何新的像素事实。';
    const issues = collectDraftIssues(draft, new Error(
        '读者文章 figurePlacements[0]（Figure 4）图片的插入位置、相邻导读与解释段，或观察点不符合要求'
    ));
    const paths = buildRepairTargets(draft, issues).map(target => target.path);
    for (const pointer of ['/figurePlacements/0', '/sections/7/body', '/sections/10/body']) {
        assert.ok(paths.includes(pointer), pointer);
    }
});

test('未解决的量化中文数字只指向它所属计数的小节，而不是所有正文', () => {
    const draft = fixture();
    draft.sections[0].body += '停顿一次后继续。';
    draft.sections[10].body += '建议再跑一次四特征叠加实验。';
    const targets = buildRepairTargets(draft, [{ path: null,
        message: '读者文章文风校验失败: quantitative_chinese_numeral:一次' }]);
    assert.deepEqual(targets.map(target => target.path), ['/sections/10/body']);
});

test('NFKC 归一化之后的量化内容仍指向精确的全角标点小节', () => {
    const draft = fixture();
    draft.sections[11].body += '待验证的问题有三：一是延迟，二是成本，三是泛化。';
    const targets = buildRepairTargets(draft, [{ path: null,
        message: '读者文章文风校验失败: quantitative_chinese_numeral:三:一' }]);
    assert.deepEqual(targets.map(target => target.path), ['/sections/11/body']);
});

test('比较单位文案只定位到精确小节，不授权表格绑定', () => {
    const draft = fixture();
    const excerpt = '该表后的解释是：WER 从 30.65 降至 29.41，体现可懂度提升。';
    draft.sections[8].body += `\n\n${excerpt}`;
    draft.tableBindings = [0, 1, 2, 3].map(index => ({ tableIndex: index + 1,
        sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [],
        sourceQuotes: [`长度足够的来源证据句 ${index} 用于验证修复目标不会扩散。`] }));
    const targets = buildRepairTargets(draft, [{ path: null,
        message: `读者文章文风校验失败: comparison_unit_missing:${excerpt}` }]);
    assert.deepEqual(targets.map(target => target.path), ['/sections/8/body']);
});

test('即使还有其它诊断，损坏的正文片段也只指向它所在的那个小节', () => {
    const draft = fixture();
    const excerpt = '但在降级条件下受环境噪声影响更大，因此绝对分更低，但相对排序仍然合理';
    draft.sections[7].body += `\n\n${excerpt}。`;
    const targets = buildRepairTargets(draft, [
        { path: null, message: `读者文章文风校验失败: broken_prose:${excerpt}` },
        { path: '/tableBindings/0', diagnosticOnly: true, message: 'tableBindings[0] 诊断' }
    ]);
    assert.ok(targets.some(target => target.path === '/sections/7/body'));
});

test('有歧义的选择表头修复只指向那个小的绑定节点', () => {
    const draft = fixture();
    draft.tableBindings.push({ tableIndex: 1, selection: {
        sourceTableOrdinal: 4, sourceRows: [3, 4], sourceColumns: [0, 1] } });
    draft.sections[7].body += '\n\n[[TABLE_1]]';
    const issue = '读者文章 tableBindings[0] selection 第一行必须是原表头，其余行必须是数据行；'
        + 'sourceTableOrdinal=4，原表明示表头行=[0,1]，当前选择行=[3,4]。只修改本 binding 的 sourceRows，不能改写正文或原表。';
    const targets = buildRepairTargets(draft, [{ path: null, message: issue }]);
    assert.deepEqual(targets.map(target => target.path), ['/tableBindings/0']);
});

test('所有格式错误的引用绑定、只有标记的表格和长度不足，一次全部诊断出来', () => {
    const draft = fixture();
    draft.tableBindings = [1, 2].map(tableIndex => ({ tableIndex, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [{ renderedRow: 0, renderedColumn: 0, quoteIndex: 0, value: '数据集' }], sourceQuotes: ['3.093.09'] }));
    draft.sections[7].body += '\n\n[[TABLE_1]]'; draft.sections[8].body += '\n\n[[TABLE_2]]';
    const issues = collectDraftIssues(draft, new Error('读者文章存在未绑定的 TABLE marker'), { sourceText: '原文中实际的连续证据很长，但这里只列出了一个数字 3.093.09。' });
    for (const index of [0, 1]) {
        assert.ok(issues.some(issue => issue.path === `/tableBindings/${index}` && /cellBindings 必须是 \[\]/.test(issue.message)));
        assert.ok(issues.some(issue => issue.path === `/tableBindings/${index}` && /sourceQuotes 中以下数组项/.test(issue.message)));
    }
    assert.ok(issues.some(issue => /实际Markdown表 0 张/.test(issue.message)));
    assert.ok(issues.some(issue => issue.code === 'reader_length_preflight' && issue.diagnosticOnly));
    const targets = buildRepairTargets(draft, issues);
    for (const pointer of ['/tableBindings/0', '/tableBindings/1', '/sections/7/body', '/sections/8/body']) {
        assert.ok(targets.some(target => target.path === pointer), pointer);
    }
    assert.equal(targets.some(target => target.path === '/sections/0/body'), false,
        'diagnostic-only length expansion waits until blocking table issues are fixed');
    assert.ok(targets.length <= 8, 'one repair request remains within the patch-node limit');
    assert.equal(targets.some(target => /^\/sections\/\d+$/.test(target.path)), false, 'body diagnostics never duplicate whole section targets');
});

test('内部概念值不合法时给出诊断，而不是抛异常', () => {
    for (const terms of ['声学表示', { term: '声学表示' }, null]) {
        const draft = fixture(); draft.conceptBridges[0].terms = terms;
        assert.ok(parseRepairableDraft(draft));
        const issues = collectDraftIssues(draft, new Error('conceptBridges[0].terms 非法'));
        assert.ok(issues.some(issue => issue.path === '/conceptBridges/0' && /terms 必须/.test(issue.message)));
    }
});

test('小节形态的修复目标包含其正文，但不重复提示上下文', () => {
    const draft = fixture();
    const targets = buildRepairTargets(draft, [{ path: '/sections/0/body', message: 'sections[0].body 需要修改' },
        { path: '/sections/0', message: 'sections[0].heading 需要修改' }]);
    assert.ok(targets.some(target => target.path === '/sections/0'));
    assert.ok(!targets.some(target => target.path === '/sections/0/body'));
});

test('候选存储是原子的、私有的、按输入区分的，本身不是成功凭证', t => {
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

test('候选拒绝符号链接目录或文件、被改动的身份和损坏的 JSON', t => {
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
    assert.throws(() => saveFailedCandidate(directory, identity, failed()), /Unsafe|ELOOP|symbolic/i);
    assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});

test('已解决的失败可以恢复地退场，不会重新变成候选', t => {
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

test('生产循环对格式错误的整篇回复设上限，并落盘失败', async t => {
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

test('生产续跑只请求补丁，合并后正文不完整仍然拒绝', async t => {
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
            assert.ok(budget <= 16000);
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

test('生产恢复落盘正式的小节/表格配对，并记录原始到正式的 SHA 映射', async t => {
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
    assert.equal(stored.identity.draftOrderContract, 'reader-draft-order-v4');
    assert.deepEqual(stored.payload.draftOrderMappings[0].conceptBridges.map(item => item.rawIndex), [3, 2, 1, 0]);
    await assert.rejects(generateApiReaderArticleDetailed(paper, '', '', { ...base, readerCallModel: async messages => {
        assert.match(messages[0].content[0].text, new RegExp(hashDraft(normalized.draft)));
        return JSON.stringify(patchFor(normalized.draft, [['/readerTitle', '短']]));
    } }), /读者标题/);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).payload.draftOrderMappings, [normalized.mapping]);
});

test('用尽的候选可以免费重跑一次完整解析：有效就退场，无效就不能再请求', async t => {
    const { generateApiReaderArticleDetailed, parseApiReaderArticleResult,
        stableFingerprint } = require('../scripts/deep-analyzer.js');
    const crypto = require('node:crypto');
    const directory = temporary(t), paper = { arxivId: '2609.99980', title: '离线耗尽验证' };
    const sourceText = '在统一数据协议与输入条件下，基线和完整方法的报告得分均为1.0，仅用于当前离线对照。';
    const artifacts = { parserVersion: 'unstructured-text-signals-v1', tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex') };
    artifacts.payloadSha256 = stableFingerprint(artifacts);
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
            /conceptBridges\[0\].*的占位标记、解释长度或所在小节不符合要求/);
    }
    const filename = path.join(directory, fs.readdirSync(directory)[0]);
    const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'));
    saveFailedCandidate(directory, envelope.identity, { ...envelope.payload, draft: valid, rawDraft: JSON.stringify(valid),
        noProgress: 2, failureSignature: 'old implementation failure' });
    const result = await generateApiReaderArticleDetailed(paper, '', '', { ...base, readerCallModel: noMoreCalls });
    assert.equal(calls, 0); assert.equal(result.attempts, 1);
    assert.equal(result.resumedCandidate, true); assert.match(result.retiredCandidate, /resolved\.json$/);
});

test('生产遇到没带来变化的补丁就停下，恢复用尽后不再调用', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const paper = { arxivId: '2609.99993', title: '离线无进展' };
    const draft = fixture(); draft.readerTitle = '短';
    let calls = 0;
    const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaterializeFigures: async () => [],
        readerRecordDisposition: () => {},
        readerCallModel: async () => (++calls === 1 ? JSON.stringify(draft)
            : JSON.stringify(patchFor(draft, [['/readerTitle', '短']]))) };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /连续无进展|同一组校验问题连续两次未改善/);
    assert.equal(calls, 2);
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /exhausted/);
    assert.equal(calls, 2);
});

test('不同的格式错误补丁会消耗尝试次数，但不会误判成草稿未变的无进展而耗尽', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const paper = { arxivId: '2609.99972', title: '损坏补丁恢复' };
    const draft = fixture(); draft.readerTitle = '短';
    let calls = 0;
    const base = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 6,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', {
        ...base,
        readerCallModel: async () => {
            calls += 1;
            if (calls === 1) return JSON.stringify(draft);
            if (calls === 2) return '{"version":1,"replacements":[}';
            if (calls === 3) return '{"version":1,"replacements":[';
            throw new Error('stop after two distinct malformed patches');
        }
    }), /stop after two distinct malformed patches/);
    assert.equal(calls, 4, 'distinct malformed patches must not trip no-progress before another request');
    const active = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    let envelope = JSON.parse(fs.readFileSync(path.join(directory, active), 'utf8'));
    assert.equal(envelope.payload.attempts, 3);
    assert.equal(envelope.payload.noProgress, 0);
    assert.equal(envelope.payload.validationFailureStreak, 1);

    let resumedCalls = 0;
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', {
        ...base,
        readerCallModel: async (_messages, _tokens, requestOptions) => {
            resumedCalls += 1;
            assert.equal(requestOptions.usageContext.stage, 'apiReaderRepair');
            assert.equal(requestOptions.usageContext.contentAttempt, 4);
            throw new Error('resumed patch request observed');
        }
    }), /resumed patch request observed/);
    assert.equal(resumedCalls, 1, 'recovery must reach the model instead of preflight exhaustion');
    envelope = JSON.parse(fs.readFileSync(path.join(directory, active), 'utf8'));
    assert.equal(envelope.payload.attempts, 3, 'transport failure does not consume a content attempt');
    assert.equal(envelope.payload.noProgress, 0);
});

test('Reader 补丁解析器只补回被省略的外层数组或根对象结束符', () => {
    const { parseReaderPatchJson } = require('../scripts/lib/reader-repair.js');
    const patch = {
        version: 1,
        draftSha256: 'a'.repeat(64),
        replacements: [{
            path: '/readerTitle', oldSha256: 'b'.repeat(64), value: '完整标题'
        }]
    };
    const complete = JSON.stringify(patch);
    assert.deepEqual(parseReaderPatchJson(complete), patch);
    assert.deepEqual(parseReaderPatchJson(complete.slice(0, -1)), patch,
        'a complete replacements array may receive its omitted root delimiter');
    assert.deepEqual(parseReaderPatchJson(complete.slice(0, -2)), patch,
        'a complete final replacement may receive only the omitted array/root delimiters');
    assert.throws(() => parseReaderPatchJson(complete.slice(0, -3)), SyntaxError,
        'the parser must not close an incomplete replacement object');
    assert.throws(() => parseReaderPatchJson('{"version":1,"draftSha256":"unterminated'), SyntaxError);
    assert.throws(() => parseReaderPatchJson('{"version":tru'), SyntaxError);
    assert.throws(() => parseReaderPatchJson('{"version":1,"replacements":[],'), SyntaxError);
    assert.throws(() => parseReaderPatchJson('{"version":1,"replacements":[}'), SyntaxError);
});

test('全局宽表修复只指向一个诊断出的小节和绑定配对', () => {
    const { buildRepairTargets } = require('../scripts/lib/reader-repair.js');
    const draft = fixture();
    draft.sections[0].body += '\n\n表 1 的比较问题与解释足够长，供局部修复定位。\n\n'
        + '| 方法 | 条件 | 指标甲 | 指标乙 | 说明 |\n'
        + '| --- | --- | --- | --- | --- |\n'
        + '| A | clean | 1 | 2 | baseline |\n\n'
        + '表 1 的结果说明保留成立范围，且不会替代完整来源门禁。';
    draft.sections[1].body += '\n\n表 2 的比较问题与解释足够长，供局部修复定位。\n\n'
        + '| 方法 | 条件 | 指标甲 | 指标乙 | 说明 |\n'
        + '| --- | --- | --- | --- | --- |\n'
        + '| B | noisy | 3 | 4 | candidate |\n\n'
        + '表 2 的结果说明保留成立范围，且不会替代完整来源门禁。';
    draft.tableBindings = [
        { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['first source quote is long enough'] },
        { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['second source quote is long enough'] }
    ];
    const targets = buildRepairTargets(draft, [
        { path: null, message: '读者文章至少需要 2 张 5 列以上的宽表' },
        { path: '/tableBindings/1', diagnosticOnly: true,
            message: 'tableBindings[1] sourceQuotes 未提供全文连续原句' },
        { path: '/tableBindings/0', diagnosticOnly: true,
            message: 'tableBindings[0] sourceQuotes 未提供全文连续原句' }
    ]);
    assert.deepEqual(targets.map(target => target.path), [
        '/tableBindings/0', '/sections/0/body'
    ]);
    const fallbackTargets = buildRepairTargets(draft, [
        { path: null, message: '读者文章至少需要 2 张 5 列以上的宽表' }
    ]);
    assert.deepEqual(fallbackTargets.map(target => target.path), [
        '/tableBindings/0', '/sections/0/body'
    ], 'even without a per-table diagnostic the global gate must stay on one table pair');
});

test('全局宽表修复优先选最小小节里单独存在的窄表', () => {
    const { buildRepairTargets } = require('../scripts/lib/reader-repair.js');
    const draft = fixture();
    const table = (name, columns) => {
        const headers = Array.from({ length: columns }, (_value, index) => `列${index + 1}`);
        return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n`
            + `| ${headers.map((header, index) => `${name}${index + 1}`).join(' | ')} |`;
    };
    draft.sections[0].body += `\n\n${table('甲', 4)}\n\n${table('乙', 4)}`;
    draft.sections[1].body += `\n\n${table('丙', 5)}\n\n${table('丁', 4)}`;
    draft.sections[2].body += `\n\n${table('戊', 4)}`;
    draft.tableBindings = Array.from({ length: 5 }, (_value, index) => ({
        tableIndex: index + 1,
        sourceType: 'source_quotes',
        sourceTableOrdinal: null,
        cellBindings: [],
        sourceQuotes: [`source quote ${index + 1} is long enough for binding`]
    }));
    const targets = buildRepairTargets(draft, [
        { path: null, message: '读者文章至少需要 2 张 5 列以上的宽表' }
    ]);
    assert.deepEqual(targets.map(target => target.path), [
        '/tableBindings/4', '/sections/2/body'
    ]);
});

test('缺失叙述表格的修复只指向最后一个小节和缺失的绑定', () => {
    const draft = fixture();
    for (const [offset, sectionIndex] of [6, 7, 8].entries()) {
        draft.sections[sectionIndex].body += `\n\n表 ${offset + 1} 的比较问题与解释足够长，供局部补表修复定位。\n\n`
            + '| 方法 | 条件 | 指标 | 说明 |\n'
            + '| --- | --- | --- | --- |\n'
            + `| 方法${offset + 1} | clean | ${offset + 1} | evidence |\n\n`
            + `表 ${offset + 1} 的结果说明保留成立范围，并交代这张表不能支持的结论。`;
    }
    draft.tableBindings = [0, 1, 2, 3].map(index => ({ tableIndex: index + 1,
        sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [],
        sourceQuotes: [`source quote ${index} is long enough for binding`] }));
    const targets = buildRepairTargets(draft, [{ path: null,
        message: '读者文章至少需要 4 张有表前说明和表后解释的 Markdown 表，当前 3 张' }]);
    assert.deepEqual(targets.map(target => target.path), [
        '/sections/8/body', '/tableBindings/3'
    ]);
});

test('最小叙述表格修复原子地追加一张表和一条绑定', () => {
    const draft = fixture();
    const block = (name, value) => `\n\n${name} 比较相同条件下的两组结果与指标方向。\n\n`
        + '| 方法 | 条件 | 指标 A | 指标 B | 指标 C |\n| --- | --- | --- | --- | --- |\n'
        + `| ${name} | 设置 ${value} | ${value}0 | ${value}00 | ${value}000 |\n\n`
        + `${name} 的净收益只适用于该测试条件，其他数据分布仍需单独验证。`;
    for (const [offset, sectionIndex] of [6, 7, 8].entries()) {
        draft.sections[sectionIndex].body += block(`已有表 ${offset + 1}`, String(offset + 1));
    }
    draft.tableBindings = [0, 1, 2].map(index => ({ tableIndex: index + 1,
        sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [],
        sourceQuotes: [`source quote ${index + 1} is long enough for binding`] }));
    const issues = [{ path: null,
        message: '读者文章至少需要 4 张有表前说明和表后解释的 Markdown 表，当前 3 张' }];
    const context = buildRepairContext(draft, issues, '完整来源');
    assert.equal(context.atomicOperation.kind, 'append_narrative_table_v1');
    assert.deepEqual(context.targets.map(target => target.path), ['/sections/8/body', '/tableBindings']);
    const bindings = [...structuredClone(draft.tableBindings), {
        tableIndex: 4, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: ['new source quote is long enough for binding']
    }];
    const merged = applyReaderPatch(draft, patchFor(draft, [
        ['/sections/8/body', draft.sections[8].body + block('新增表 4', '4')],
        ['/tableBindings', bindings]
    ]), context.targets.map(target => target.path), { atomicOperation: context.atomicOperation });
    assert.equal(merged.tableBindings.length, 4);
    assert.equal(merged.tableBindings[3].tableIndex, 4);
});

test('最小叙述表格恢复绑定一篇已写好的结尾表格，不改写它', () => {
    const draft = fixture();
    const block = (name, value) => `\n\n${name} 比较相同条件下的两组结果与指标方向。\n\n`
        + '| 方法 | 条件 | 指标 A | 指标 B | 指标 C |\n| --- | --- | --- | --- | --- |\n'
        + `| ${name} | 设置 ${value} | ${value}0 | ${value}00 | ${value}000 |\n\n`
        + `${name} 的净收益只适用于该测试条件，其他数据分布仍需单独验证。`;
    for (const [offset, sectionIndex] of [6, 7, 8, 8].entries()) {
        draft.sections[sectionIndex].body += block(`正文表 ${offset + 1}`, String(offset + 1));
    }
    draft.tableBindings = [0, 1, 2].map(index => ({ tableIndex: index + 1,
        sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [],
        sourceQuotes: [`source quote ${index + 1} is long enough for binding`] }));
    const context = buildRepairContext(draft, [{ path: null,
        message: '读者文章至少需要 4 张有表前说明和表后解释的 Markdown 表，当前 3 张' }], '完整来源');
    assert.equal(context.atomicOperation.kind, 'bind_trailing_narrative_table_v1');
    assert.deepEqual(context.targets.map(target => target.path), ['/tableBindings']);
    const beforeBody = draft.sections[8].body;
    const bindings = [...structuredClone(draft.tableBindings), {
        tableIndex: 4, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: ['new source quote is long enough for binding']
    }];
    const merged = applyReaderPatch(draft, patchFor(draft, [['/tableBindings', bindings]]),
        ['/tableBindings'], { atomicOperation: context.atomicOperation });
    assert.equal(merged.sections[8].body, beforeBody);
    assert.equal(merged.tableBindings.length, 4);
});

test('带码的计数诊断保留旧的修复目标，以及两份已保存的失败对比', () => {
    const draft = countRepairFixture();
    const legacy = { path: null, message: '读者文章至少需要 4 张有表前说明和表后解释的 Markdown 表，当前 3 张' };
    const natural = countIssue();
    const misleading = countIssue(3, 'tableBindings[0] source-binding v4 readerTitle 需要重建宽表');
    const original = buildRepairContext(draft, [legacy], '完整来源');
    for (const issue of [natural, misleading]) {
        const context = buildRepairContext(draft, [issue], '完整来源');
        assert.deepEqual(context.targets, original.targets);
        assert.deepEqual(context.atomicOperation, original.atomicOperation);
        assert.equal(hashRecoveryIssues([issue]), hashDraft([legacy]));
        assert.equal(validationFailureSignature([issue]), validationFailureSignature([legacy]));
    }
    assert.deepEqual(original.targets.map(target => target.path), ['/sections/8/body', '/tableBindings']);
    assert.equal(original.atomicOperation.kind, 'append_narrative_table_v1');
    assert.notEqual(hashDraft([natural]), hashDraft([misleading]), 'generic object hashes retain exact message bytes');
});

test('计数进展取决于上报的计数和必需阈值，而不是文案里的数字', () => {
    const first = countIssue(1, '需要4张表，目前1张');
    const improved = countIssue(2, 'tableBindings[9] 当前999，仍缺888');
    const stalled = countIssue(2, '另一种自然说法，没有数字');
    const regressed = countIssue(1, '已完成99张');
    assert.equal(validationFailureHasNoProgress(validationFailureSignature([first]),
        validationFailureSignature([improved])), false);
    assert.equal(validationFailureHasNoProgress(validationFailureSignature([improved]),
        validationFailureSignature([stalled])), true);
    assert.equal(validationFailureHasNoProgress(validationFailureSignature([improved]),
        validationFailureSignature([regressed])), true);
    assert.equal(hashRecoveryIssues([improved]), hashRecoveryIssues([stalled]));
    assert.notEqual(hashRecoveryIssues([first]), hashRecoveryIssues([improved]));
    assert.notEqual(validationFailureSignature([first]),
        validationFailureSignature([{ ...first, requiredCount: 5 }]));
});

test('格式错误的带码计数不能借用旧数字，也不能授权按文案选出的修复节点', () => {
    const draft = countRepairFixture();
    const legacyText = '读者文章至少需要 4 张有表前说明和表后解释的 Markdown 表，当前 3 张；tableBindings[0] source-binding v4';
    const invalid = [
        { requiredCount: undefined }, { actualCount: undefined }, { requiredCount: '4' },
        { actualCount: '3' }, { requiredCount: 4.5 }, { actualCount: -1 },
        { actualCount: Number.MAX_SAFE_INTEGER + 1 }, { requiredCount: 0 },
        { actualCount: 4 }, { actualCount: 5 }, { requiredCount: Infinity }, { actualCount: NaN }
    ];
    for (const fields of invalid) {
        const issue = { ...countIssue(3, legacyText), ...fields };
        assert.equal(readTableCountIssue(issue), null);
        const context = buildRepairContext(draft, [issue], '完整来源');
        assert.equal(context.atomicOperation, null);
        assert.deepEqual(context.targets, []);
        const otherMessage = { ...issue, message: '当前1，仍缺999，tableBindings[9]' };
        assert.equal(hashRecoveryIssues([issue]), hashRecoveryIssues([otherMessage]));
        assert.equal(validationFailureSignature([issue]), validationFailureSignature([otherMessage]));
        assert.equal(validationFailureHasNoProgress(validationFailureSignature([issue]),
            validationFailureSignature([otherMessage])), true);
    }
    assert.equal(readTableCountIssue({ ...countIssue(), code: 'another_issue', message: legacyText }), null);
});

test('有效计数保留结构回退目标，只作诊断的计数不选任何目标', () => {
    const draft = countRepairFixture();
    draft.sections[8].kind = 'component';
    const legacy = { path: null, message: '读者文章至少需要 4 张有表前说明和表后解释的 Markdown 表，当前 3 张' };
    const expected = buildRepairTargets(draft, [legacy]);
    assert.ok(expected.length > 0);
    for (const message of ['表格不足', 'tableBindings[0] readerTitle source-binding v4 主结果表覆盖不足']) {
        const context = buildRepairContext(draft, [countIssue(3, message)], '完整来源');
        assert.equal(context.atomicOperation, null);
        assert.deepEqual(context.targets, expected);
    }
    const noTables = countRepairFixture(0, 4);
    assert.deepEqual(buildRepairTargets(noTables, [countIssue(0)]).map(target => target.path), [
        '/tableBindings/0', '/tableBindings/1', '/tableBindings/2', '/tableBindings/3',
        '/sections/5/body', '/sections/6/body', '/sections/7/body', '/sections/8/body'
    ]);
    const diagnostic = { ...countIssue(3, 'tableBindings[0] 主结果表覆盖不足'), diagnosticOnly: true };
    const context = buildRepairContext(countRepairFixture(), [diagnostic], '完整来源');
    assert.equal(context.atomicOperation, null);
    assert.deepEqual(context.targets, []);
    const other = { path: '/sections/2/body', message: '这个小节需要修正。' };
    assert.deepEqual(buildRepairTargets(draft, [diagnostic, other]).map(target => target.path), ['/sections/2/body']);
});

test('带类型的上报计数 3 仍绑定第四张已写好的表，不改写其正文', () => {
    const draft = countRepairFixture(4, 3);
    const context = buildRepairContext(draft, [countIssue(3)], '完整来源');
    assert.equal(context.atomicOperation.kind, 'bind_trailing_narrative_table_v1');
    assert.deepEqual(context.targets.map(target => target.path), ['/tableBindings']);
    const bindings = [...structuredClone(draft.tableBindings), {
        tableIndex: 4, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: ['new source quote is long enough for binding']
    }];
    const merged = applyReaderPatch(draft, patchFor(draft, [['/tableBindings', bindings]]),
        ['/tableBindings'], { atomicOperation: context.atomicOperation });
    assert.deepEqual(merged.sections, draft.sections);
    assert.deepEqual(merged.tableBindings.slice(0, 3), draft.tableBindings);
});

test('有效计数没有原子操作可用时，生产请求一个有限的结构补丁', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    const draft = signed.draft;
    for (const section of draft.sections) {
        section.body = section.body.split(/\n\s*\n/).filter(block => !/^\|/m.test(block)).join('\n\n');
    }
    draft.tableBindings = [];
    const options = { sourceText: signed.sourceDetails.text,
        structuredArtifacts: signed.sourceDetails.structuredArtifacts,
        readerAttemptsDir: temporary(t), readerMaxAttempts: 2,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
    const sourceEvidence = [1, 2, 3, 4].map(index => `TABLE_${index}: 离线数量要求`).join('\n');
    let calls = 0;
    const expectedPaths = ['/sections/5/body', '/sections/6/body', '/sections/7/body', '/sections/8/body'];
    await assert.rejects(deep.generateApiReaderArticleDetailed(
        { arxivId: '2609.99971', title: '离线数量回退修复' }, '', sourceEvidence, {
            ...options, readerCallModel: async messages => {
                calls += 1;
                if (calls === 1) return JSON.stringify(draft);
                assert.equal(calls, 2);
                const prompt = messages[0].content[0].text;
                const targetStart = prompt.indexOf('{"draftSha256":');
                assert.ok(targetStart >= 0, 'the patch request includes the authorized target envelope');
                const targetEnd = prompt.indexOf('\n', targetStart);
                const envelope = JSON.parse(prompt.slice(targetStart, targetEnd < 0 ? undefined : targetEnd));
                assert.deepEqual(envelope.targets.map(target => target.path), expectedPaths);
                assert.equal(envelope.atomicOperation, undefined);
                return JSON.stringify(patchFor(draft, expectedPaths.map(pointer => [pointer,
                    draft.sections[Number(pointer.split('/')[2])].body])));
            }
        }
    ), /至少需要 4 张 Markdown 表/);
    assert.equal(calls, 2, 'one initial response and one bounded patch use the existing attempt budget');
    const files = fs.readdirSync(options.readerAttemptsDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const stored = JSON.parse(fs.readFileSync(path.join(options.readerAttemptsDir, files[0]), 'utf8'));
    assert.equal(stored.payload.fullAttempts, 1);
    assert.equal(stored.payload.attempts, 2);
    assert.equal(stored.payload.issues.filter(issue => issue.code === TABLE_COUNT_ISSUE_CODE).length, 1);
});

test('收集带码计数错误时只产出一条诊断，不会吞掉另一个解析失败', () => {
    const { validateApiReaderTableNarratives } = require('../scripts/deep-analyzer.js');
    let error;
    try { validateApiReaderTableNarratives('', 4); } catch (caught) { error = caught; }
    assert.equal(error.code, TABLE_COUNT_ISSUE_CODE);
    assert.equal(error.requiredCount, 4);
    assert.equal(error.actualCount, 0);
    assert.deepEqual(collectDraftIssues(null, error), error.readerIssues);
    const parserError = new Error('公式来源不匹配');
    parserError.readerIssues = [{ ...countIssue(), diagnosticOnly: true }];
    const collected = collectDraftIssues(null, parserError);
    assert.equal(collected.length, 2);
    assert.equal(collected[0].message, '公式来源不匹配');
    assert.equal(collected[1].diagnosticOnly, true);
    const draft = countRepairFixture();
    assert.deepEqual(buildRepairTargets(draft, collected), buildRepairTargets(draft, [collected[0]]));
});

test('生产的计数反馈和补丁拒绝保留都不读带码诊断的措辞', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const repair = require('../scripts/lib/reader-repair.js');
    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    const draft = signed.draft;
    draft.sections.forEach(section => {
        section.body = section.body.split(/\n\s*\n/).filter(block => !/^\|/m.test(block)).join('\n\n');
    });
    draft.tableBindings = [];
    const directory = temporary(t);
    const misleading = 'Reader patch tableBindings[0] source-binding v4 readerTitle misleading_count_text';
    const originalCollect = repair.collectDraftIssues;
    repair.collectDraftIssues = (...args) => originalCollect(...args).map(issue => (
        issue.code === TABLE_COUNT_ISSUE_CODE ? { ...issue, message: misleading } : issue
    ));
    let calls = 0;
    try {
        await assert.rejects(deep.generateApiReaderArticleDetailed(
            { arxivId: '2609.99972', title: '离线数量文案与补丁失败' }, '',
            [1, 2, 3, 4].map(index => `TABLE_${index}: 离线数量要求`).join('\n'), {
                sourceText: signed.sourceDetails.text, structuredArtifacts: signed.sourceDetails.structuredArtifacts,
                readerAttemptsDir: directory, readerMaxAttempts: 2,
                readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
                readerCallModel: async messages => {
                    if (++calls === 1) return JSON.stringify(draft);
                    const prompt = messages[0].content[0].text;
                    assert.doesNotMatch(prompt, /misleading_count_text/);
                    assert.match(prompt, /目前识别到 0 张/);
                    return '{broken';
                }
            }
        ));
    } finally {
        repair.collectDraftIssues = originalCollect;
    }
    assert.equal(calls, 2);
    const filename = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const stored = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    assert.equal(stored.payload.issues.filter(issue => issue.code === TABLE_COUNT_ISSUE_CODE).length, 1);
    assert.ok(stored.payload.issues.some(issue => issue.message.startsWith('Reader patch rejected:')));
});

test('旧版恢复字节先核验再谈计数兼容，绝不改写', t => {
    const directory = temporary(t);
    const identity = { version: REPAIR_VERSION, paperId: '2609.99970' };
    const legacy = { path: null, message: '读者文章至少需要 4 张有表前说明和表后解释的 Markdown 表，当前 3 张' };
    const payload = { ...failed(countRepairFixture()), issues: [legacy],
        failureSignature: hashDraft([legacy]), validationFailureSignature: validationFailureSignature([legacy]) };
    const filename = saveFailedCandidate(directory, identity, payload);
    const bytes = fs.readFileSync(filename);
    const recovered = loadFailedCandidate(directory, identity);
    assert.deepEqual(recovered, payload);
    assert.deepEqual(fs.readFileSync(filename), bytes);
    assert.equal(buildRepairContext(recovered.draft, recovered.issues, '').atomicOperation.kind,
        'append_narrative_table_v1');
    const tampered = JSON.parse(bytes);
    tampered.payload.issues = [countIssue()];
    assert.equal(hashRecoveryIssues(tampered.payload.issues), payload.failureSignature);
    fs.writeFileSync(filename, JSON.stringify(tampered));
    const tamperedBytes = fs.readFileSync(filename);
    assert.throws(() => loadFailedCandidate(directory, identity), /Corrupt or drifted/);
    assert.deepEqual(fs.readFileSync(filename), tamperedBytes, 'rejected records are not repaired or re-signed');
    tampered.payloadSha256 = hashDraft(tampered.payload);
    fs.writeFileSync(filename, JSON.stringify(tampered));
    assert.deepEqual(loadFailedCandidate(directory, identity).issues, [countIssue()]);
    tampered.payload.issues[0].actualCount = 4;
    tampered.payloadSha256 = hashDraft(tampered.payload);
    fs.writeFileSync(filename, JSON.stringify(tampered));
    assert.throws(() => loadFailedCandidate(directory, identity), /Corrupt or drifted/);
});

test('生产归一化忽略带类型的计数文案，但保留不相干的问题修复', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const repair = require('../scripts/lib/reader-repair.js');
    const draft = fixture();
    draft.readerTitle = '短';
    const countSurface = '训练采用两阶段课程，使用模型Transformer，采样率为16kHz，准确率 90 高于 80。';
    draft.sections[0].body += `\n\n${countSurface}`;
    draft.sections[1].body += '\n\n另一个实验采用三阶段训练。';
    draft.conceptBridges[0].explanation += '两阶段课程限定采样条件。';
    const countMessage = 'quantitative_chinese_numeral:两阶段；technical_term_adhesion:模型Transformer；'
        + 'numeric_typography:16kHz；comparison_unit_missing:准确率 90 高于 80';
    const originalCollect = repair.collectDraftIssues;
    repair.collectDraftIssues = (...args) => [...originalCollect(...args), countIssue(3, countMessage),
        { path: null, diagnosticOnly: true, message: 'quantitative_chinese_numeral:三阶段' }];
    const directory = temporary(t);
    let calls = 0;
    let beforePatch;
    try {
        await assert.rejects(deep.generateApiReaderArticleDetailed(
            { arxivId: '2609.99973', title: '离线数量诊断规范化边界' }, '', '', {
                sourceText: '', readerAttemptsDir: directory, readerMaxAttempts: 2,
                readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
                readerCallModel: async messages => {
                    if (++calls === 1) return JSON.stringify(draft);
                    const filename = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
                    beforePatch = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8')).payload.draft;
                    const prompt = messages[0].content[0].text;
                    const start = prompt.indexOf('{"draftSha256":');
                    const end = prompt.indexOf('\n', start);
                    const envelope = JSON.parse(prompt.slice(start, end < 0 ? undefined : end));
                    const target = envelope.targets.find(item => item.path === '/readerTitle');
                    assert.ok(target);
                    return JSON.stringify({ version: 1, draftSha256: envelope.draftSha256,
                        replacements: [{ path: target.path, oldSha256: target.oldSha256, value: '短' }] });
                }
            }
        ), /读者标题/);
    } finally {
        repair.collectDraftIssues = originalCollect;
    }
    assert.equal(calls, 2);
    const filename = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const stored = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    assert.equal(stored.payload.draft.sections[0].body, beforePatch.sections[0].body);
    assert.equal(stored.payload.draft.conceptBridges[0].explanation, beforePatch.conceptBridges[0].explanation);
    assert.equal(stored.payload.draft.sections[1].body,
        beforePatch.sections[1].body.replace('三阶段', ' 3 个阶段'));
});

test('缺失结果表的修复把一张稳定的实验表及其绑定挪到结果小节', () => {
    const draft = fixture();
    const table = index => `\n\n表 ${index} 的比较条件。\n\n`
        + '| 配置项 | 数值 | 单位 |\n| --- | --- | --- |\n'
        + `| 设置 ${index} | ${index} | 步 |\n\n表 ${index} 的解释与边界。`;
    draft.sections[6].body += table(1) + table(2) + table(3) + table(4);
    draft.tableBindings = [0, 1, 2, 3].map(index => ({
        tableIndex: index + 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: [`source quote ${index + 1} is long enough`]
    }));
    const targets = buildRepairTargets(draft, [
        { path: null, message: '读者文章主结果表覆盖不足：原论文 TABLE_2/TABLE_9 明确提供定量结果' },
        { path: null, code: 'reader_result_table_missing',
            message: '读者文章主结果表覆盖不足：原论文 TABLE_2/TABLE_9 明确提供定量结果' },
        { path: '/tableBindings/0', diagnosticOnly: true,
            message: 'tableBindings[0] sourceQuotes 仅供诊断' }
    ]);
    assert.deepEqual(targets.map(target => target.path), [
        '/sections/6/body', '/sections/7/body', '/tableBindings/3'
    ]);
    const context = buildRepairContext(draft, [
        { path: null, code: 'reader_result_table_missing',
            message: '读者文章主结果表覆盖不足：原论文 TABLE_2/TABLE_9 明确提供定量结果' }
    ], '完整来源');
    assert.equal(context.atomicOperation.kind, 'relocate_result_table_v1');
    assert.deepEqual(context.atomicOperation.requiredReplacementPaths, targets.map(target => target.path));

    const allowed = context.targets.map(target => target.path);
    assert.throws(() => applyReaderPatch(draft, patchFor(draft, [[
        '/sections/6/body', draft.sections[6].body.replace('配置项', '结果指标')
    ]]), allowed, { atomicOperation: context.atomicOperation }), /every required atomic target/);

    const wrongPatch = patchFor(draft, [
        ['/sections/6/body', draft.sections[6].body.replace('配置项', '结果指标')],
        ['/sections/7/body', `${draft.sections[7].body}\n\n这里补充结果说明，但仍未放入数字表。`],
        ['/tableBindings/3', structuredClone(draft.tableBindings[3])]
    ]);
    assert.throws(() => applyReaderPatch(draft, wrongPatch, allowed, {
        atomicOperation: context.atomicOperation
    }), /atomic table-move postconditions/);

    const tableMarkdownToMove = table(4);
    assert.ok(draft.sections[6].body.endsWith(tableMarkdownToMove));
    const resultBlock = '\n\n表 4 的主结果比较条件。\n\n'
        + '| 方法 | 条件 | 指标 A | 指标 B |\n| --- | --- | --- | --- |\n'
        + '| 方法 4 | 设置 40 | 400 | 4000 |\n\n表 4 的结果解释与边界。';
    const validPatch = patchFor(draft, [
        ['/sections/6/body', draft.sections[6].body.slice(0, -tableMarkdownToMove.length)],
        ['/sections/7/body', `${draft.sections[7].body}${resultBlock}`],
        ['/tableBindings/3', structuredClone(draft.tableBindings[3])]
    ]);
    const merged = applyReaderPatch(draft, validPatch, allowed, {
        atomicOperation: context.atomicOperation
    });
    assert.equal((merged.sections[6].body.match(/^\|/gm) || []).length,
        (draft.sections[6].body.match(/^\|/gm) || []).length - 3);
    assert.ok(merged.sections[7].body.includes('| 方法 4 | 设置 40 | 400 | 4000 |'));
});

test('补上缺失的结果表会填掉此前的绑定缺口，但不搬动设置证据', () => {
    const draft = fixture();
    const block = (name, value) => `\n\n| 方法 | 指标 | 条件 | 结果 A | 结果 B | 结果 C |\n| --- | --- | --- | --- | --- | --- |\n| ${name} | ${value} | 对照 ${value} | ${value}00 | ${value}000 | ${value}0000 |`;
    draft.sections[6].body += block('设置表', '10');
    draft.sections[7].body += block('已有结果', '20');
    draft.tableBindings = [
        { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['设置表原文证据'] },
        { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['已有结果原文证据'] },
        { tableIndex: 3, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: ['缺失结果原文证据'] }
    ];
    const context = buildRepairContext(draft, [{ code: 'reader_result_table_missing',
        message: '读者文章主结果表覆盖不足：原论文 TABLE_1 明确提供定量结果' }], '完整来源');
    const operation = context.atomicOperation;
    assert.equal(operation.kind, 'add_result_table_v1');
    assert.equal(operation.bindingIndex, 2);
    const added = block('补充结果', '30');
    const merged = applyReaderPatch(draft, patchFor(draft, [
        ['/sections/7/body', `${draft.sections[7].body}${added}`],
        ['/tableBindings/2', structuredClone(draft.tableBindings[2])]
    ]), context.targets.map(target => target.path), { atomicOperation: operation });
    assert.equal((merged.sections[6].body.match(/^\|/gm) || []).length,
        (draft.sections[6].body.match(/^\|/gm) || []).length);
    assert.equal((merged.sections[7].body.match(/^\|/gm) || []).length,
        (draft.sections[7].body.match(/^\|/gm) || []).length + 3);
});

test('表格和绑定流已经关闭时，结果表搬迁仍然生效', () => {
    const draft = fixture();
    const block = (name, value) => `\n\n| 方法 | 指标 | 条件 | 结果 A | 结果 B | 结果 C |\n| --- | --- | --- | --- | --- | --- |\n| ${name} | ${value} | 对照 ${value} | ${value}00 | ${value}000 | ${value}0000 |`;
    draft.sections[6].body += block('设置表', '10') + block('设置表2', '11');
    draft.sections[7].body += block('已有结果', '20');
    draft.tableBindings = [0, 1, 2].map(index => ({
        tableIndex: index + 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: [`表 ${index + 1} 原文证据`]
    }));
    const context = buildRepairContext(draft, [{ code: 'reader_result_table_missing',
        message: '读者文章主结果表覆盖不足：原论文 TABLE_1 明确提供定量结果' }], '完整来源');
    const operation = context.atomicOperation;
    assert.equal(operation.kind, 'relocate_result_table_v1');
    assert.equal(operation.donorGlobalTableIndex, 2);
    const tableMarkdownToMove = block('设置表2', '11');
    const moved = block('设置表2', '11');
    const binding = structuredClone(draft.tableBindings[1]);
    const merged = applyReaderPatch(draft, patchFor(draft, [
        ['/sections/6/body', draft.sections[6].body.slice(0, -tableMarkdownToMove.length)],
        ['/sections/7/body', `${moved}${draft.sections[7].body}`],
        ['/tableBindings/1', binding]
    ]), context.targets.map(target => target.path), { atomicOperation: operation });
    assert.equal((merged.sections[6].body.match(/^\|/gm) || []).length,
        (draft.sections[6].body.match(/^\|/gm) || []).length - 3);
    assert.equal((merged.sections[7].body.match(/^\|/gm) || []).length,
        (draft.sections[7].body.match(/^\|/gm) || []).length + 3);
});

test('结果表修复不会把选择标记当成 Markdown 来源小节', () => {
    const draft = fixture();
    draft.sections[6].body += '\n\n[[TABLE_1]]';
    draft.tableBindings = [{
        tableIndex: 1,
        selection: { sourceTableOrdinal: 1, sourceRows: [0, 1], sourceColumns: [0, 1] }
    }];
    const issues = [{ code: 'reader_result_table_missing',
        message: '读者文章主结果表覆盖不足：原论文 TABLE_1 明确提供定量结果' }];
    const context = buildRepairContext(draft, issues, '完整来源');
    assert.equal(context.atomicOperation, null);
    assert.ok(context.targets.length > 0);
});

test('归一化校验签名在两次草稿变化之后叫停同一个绑定问题', async t => {
    const first = [{ path: null, message: '读者文章 tableBindings[0] 关键数字缺少 exact quote/cell 证据: 200；未绑定单元格（行列从 0 开始，表头为第 0 行）：row=1,column=1 text="dev 划分约 200–430 utterances" missing=200。' }];
    const second = [{ path: null, message: '读者文章 tableBindings[0] 关键数字缺少 exact quote/cell 证据: 430；未绑定单元格（行列从 0 开始，表头为第 0 行）：row=1,column=1 text="dev 划分约 200–430 utterances" missing=430。' }];
    assert.equal(validationFailureSignature(first), validationFailureSignature(second));
    assert.notEqual(validationFailureSignature(first), validationFailureSignature([{ path: null,
        message: '读者文章 tableBindings[1] 关键数字缺少 exact quote/cell 证据: 430；未绑定单元格（行列从 0 开始，表头为第 0 行）：row=2,column=1 text="test 430" missing=430。' }]));

    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t); const paper = { arxivId: '2609.99978', title: '同门禁变化草稿' };
    const draft = fixture(); draft.readerTitle = '短';
    const changedTitle = '短短';
    let calls = 0;
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', {
        sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 6,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async () => {
            calls++;
            return calls === 1 ? JSON.stringify(draft)
                : JSON.stringify(patchFor(draft, [['/readerTitle', changedTitle]]));
        }
    }), /同一组校验问题连续两次未改善/);
    assert.equal(calls, 2);
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0])));
    assert.equal(envelope.payload.validationFailureStreak, 2);
    assert.equal(envelope.payload.noProgress, 1,
        'the patch changed the draft, but the exact unchanged issue still counts as no progress');
});

test('校验签名保留单调改善的缺口，忽略易变的措辞', () => {
    const issue = (current, remaining, wording = '当前') => [{ path: null, code: 'reader_length_preflight',
        message: `读者文章篇幅预估：${wording} ${current}，仍缺 ${remaining}。` }];
    const first = validationFailureSignature(issue(200, 120));
    const improved = validationFailureSignature(issue(260, 60));
    const stalled = validationFailureSignature(issue(260, 60, '现有'));
    const regressed = validationFailureSignature(issue(220, 100));
    assert.notEqual(first, improved, 'comparable deficits remain in the persisted signature');
    assert.equal(validationFailureHasNoProgress(first, improved), false);
    assert.equal(validationFailureHasNoProgress(improved, stalled), true,
        'wording changes cannot disguise an unchanged deficit');
    assert.equal(validationFailureHasNoProgress(improved, regressed), true,
        'a regression is not progress merely because its numbers changed');
});

test('公开的候选保存不能凭一个裸字段造出实现许可', t => {
    const directory = temporary(t); const identity = { paperId: '2609.99976', sourceSha256: 'a'.repeat(64) };
    assert.throws(() => saveFailedCandidate(directory, identity, { status: 'failed', draft: fixture(),
        rawDraft: '', issues: [], attempts: 1, fullAttempts: 1, noProgress: 0, failureSignature: '',
        implementationRepairAllowance: 1 }), /recovery-revision proof/);
});

test('自洽的伪造修订字段不能造出实现许可证明', t => {
    const directory = temporary(t); const identity = { paperId: '2609.99975',
        freshAnalysis: { runId: '11111111-1111-4111-8111-111111111111', paperId: '2609.99975' } };
    const audit = { contract: 'fake-revision-contract', runId: identity.freshAnalysis.runId,
        paperId: identity.paperId, fromIdentitySha256: 'a'.repeat(64), toIdentitySha256: hashDraft(identity),
        oldPayloadSha256: 'b'.repeat(64), oldEnvelopeSha256: 'c'.repeat(64),
        archivedName: `${'a'.repeat(64)}.migrated-22222222-2222-4222-8222-222222222222.json`,
        changedFields: ['parserImplementationSha256'] };
    const body = { contract: 'reader-implementation-repair-allowance-v1',
        fromIdentitySha256: audit.fromIdentitySha256, toIdentitySha256: hashDraft(identity),
        oldPayloadSha256: audit.oldPayloadSha256, revisionAuditSha256: hashDraft(audit),
        changedFields: ['parserImplementationSha256'] };
    const proof = { ...body, allowanceSha256: hashDraft(body) };
    assert.throws(() => saveFailedCandidate(directory, identity, { status: 'failed', draft: fixture(), rawDraft: '',
        issues: [], attempts: 6, fullAttempts: 2, noProgress: 2, failureSignature: 'failed',
        readerRecoveryRevisions: [audit], implementationRepairAllowanceProof: proof }), /valid recovery-revision proof/);
});

test('校验问题变了可以继续，传输错误不计入连续次数', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t); const paper = { arxivId: '2609.99977', title: '门禁变化继续修复' };
    const draft = fixture(); draft.readerTitle = '短'; draft.sections[0].body = '太短';
    const titled = structuredClone(draft); titled.readerTitle = '声音表示如何与语义条件连接起来';
    let calls = 0;
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', {
        sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 3,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async () => {
            calls++;
            if (calls === 1) return JSON.stringify(draft);
            if (calls === 2) return JSON.stringify(patchFor(draft, [['/readerTitle', titled.readerTitle]]));
            throw new Error('transport after changed issue');
        }
    }), /transport after changed issue/);
    assert.equal(calls, 3);
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0])));
    assert.equal(envelope.payload.validationFailureStreak, 1);
    assert.equal(envelope.payload.transportFailures, 1);
});

test('传输失败保留最新候选，来源漂移则另起一个身份', async t => {
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

test('像素证据变了就拒绝复用候选，不再发起模型请求', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const candidateDirectory = path.join(directory, 'candidates');
    const imagePath = path.join(directory, 'figure.png');
    fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=', 'base64'));
    const pixelSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex');
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
        readerMaterializeFigures: async () => [{ ordinal: 1, url, cachePath: imagePath, assetSha256: pixelSha256 }] };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', sourceEvidence, options), /simulated interruption/);
    fs.appendFileSync(imagePath, 'changed pixels');
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', sourceEvidence, {
        ...options, readerMaxAttempts: 2,
        readerMaterializeFigures: async () => [{ ordinal: 1, url, cachePath: imagePath, assetSha256: pixelSha256 }]
    }), /cache bytes differ/);
    assert.equal(calls, 2);
});

test('直连来源范围单独保存临时的像素绑定，回调图片一变就拒绝', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
    const directory = temporary(t); const paper = { arxivId: '2609.99985', title: '直接来源临时像素' };
    const url = 'https://arxiv.org/html/2609.99985/figure.png';
    const sourceEvidence = `FIGURE_1: 仅当前请求可见的图\nFIGURE_1_URL: ${url}`;
    const invalid = fixture(); invalid.readerTitle = '短';
    const sourceDetails = { paperId: 'arxiv:2609.99985', source: 'html', sourceId: '2609.99985', text: 'source',
        structuredArtifacts: { tables: [], formulas: [], figures: [] } };
    let calls = 0;
    const invoke = async (pixels, callModel) => direct.withDirectRewriteAnalysisSource({
        paperId: 'arxiv:2609.99985', route: 'arxiv-fresh-fetch', sourceDetails,
        readerAttemptsDir: directory,
        materializeReaderFigures: async figures => figures.map(figure => ({ ...figure,
            rawBytes: Buffer.from(pixels), assetSha256: require('node:crypto').createHash('sha256').update(pixels).digest('hex'),
            assetMediaType: 'image/png' }))
    }, () => generateApiReaderArticleDetailed(paper, 'canonical', sourceEvidence, {
        sourceText: 'source', readerMaxAttempts: 1, readerRecordDisposition: () => {}, readerCallModel: callModel
    }));
    await assert.rejects(invoke('first ephemeral pixels', async () => {
        calls += 1; return JSON.stringify(invalid);
    }), /读者标题/);
    const stored = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
    assert.deepEqual(Object.keys(stored.payload.ephemeralImageEvidence).sort(), ['directSupplementaryEvidence', 'imageEvidence']);
    assert.doesNotMatch(JSON.stringify(stored.payload.ephemeralImageEvidence), /rawBytes|base64|cachePath|tempPath/);
    await assert.rejects(invoke('changed ephemeral pixels', async () => {
        calls += 1; throw new Error('must not make a model call after ephemeral drift');
    }), /ephemeral image evidence drifted/);
    assert.equal(calls, 1);
});

test('历史直连允许一次预检抓取，推迟候选退场，并以零次 LLM 调用续跑', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');
    const signed = require('./reader-signed-draft-fixture.js').fixture();
    const directory = temporary(t);
    const id = signed.paper.arxivId;
    const paperId = `arxiv:${id}`;
    const sourceDetails = { paperId, source: 'html', sourceId: id,
        text: signed.sourceDetails.text, imageInfos: [],
        structuredArtifacts: signed.sourceDetails.structuredArtifacts };
    const sourceEvidence = deep.buildApiReaderEvidenceContext(
        '', sourceDetails.text, sourceDetails.structuredArtifacts, id
    );
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=',
        'base64'
    );
    const pixelSha256 = require('node:crypto').createHash('sha256').update(png).digest('hex');
    let materializations = 0;
    const invoke = readerCallModel => direct.withDirectRewriteAnalysisSource({
        paperId, route: 'arxiv-fresh-fetch', sourceDetails,
        sourceSnapshotSha256: 'b'.repeat(64), readerAttemptsDir: directory,
        deferReaderCandidateCommit: true,
        materializeReaderFigures: async figures => {
            materializations += 1;
            return figures.map(figure => ({ ...figure, rawBytes: png,
                assetSha256: pixelSha256, assetMediaType: 'image/png' }));
        }
    }, () => deep.generateApiReaderArticleDetailed(
        { directPaperId: paperId, arxivId: id, title: 'Transactional Reader' },
        '', sourceEvidence, { sourceText: sourceDetails.text,
            structuredArtifacts: sourceDetails.structuredArtifacts,
            readerMaxAttempts: 1, readerRecordDisposition: () => {}, readerCallModel }
    ));
    let modelCalls = 0;
    const first = await invoke(async () => { modelCalls += 1; return JSON.stringify(signed.draft); });
    assert.equal(modelCalls, 1);
    assert.equal(materializations, 1, 'Reader preflight fetches Figure pixels exactly once');
    const injected = deep.injectApiReaderFigures(first, sourceDetails.structuredArtifacts, id);
    const receipts = deep.bindDirectApiReaderFiguresToEvidence(
        injected.figures, first.imageEvidence
    );
    assert.equal(materializations, 1, 'accepted Reader post-processing performs zero additional network fetches');
    assert.deepEqual(receipts.map(item => item.assetSha256), [pixelSha256]);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.json')).length, 1,
        'accepted draft remains recoverable before the Reader stage checkpoint commits');
    const second = await invoke(async () => { modelCalls += 1; throw new Error('must not call model'); });
    assert.equal(modelCalls, 1, 'recovery replays the accepted candidate with zero LLM calls');
    assert.equal(second.resumedCandidate, true);
    const retired = deep.commitDeferredReaderCandidate(second);
    assert.match(retired, /\.resolved\.json$/);
    assert.equal(fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 0);
});

test('最初两次网络失败不消耗已收内容或格式错误根对象的额度', async t => {
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

test('历史流程里模型之前的图片临时故障仍可重试，不产生候选也不发起 LLM 请求', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const directory = temporary(t); const url = 'https://arxiv.org/html/2509.24457v1/conf_conv.png';
    const sourceEvidence = `FIGURE_1: confidence intervals\nFIGURE_1_URL: ${url}`;
    let modelCalls = 0;
    const transient = new TypeError('fetch failed');
    transient.code = 'EPHEMERAL_FIGURE_FETCH_TRANSIENT';
    transient.retryable = true; transient.ephemeralFigureFetch = true; transient.attempts = 3;
    await assert.rejects(generateApiReaderArticleDetailed(
        { arxivId: '2509.24457', title: 'Speech quality metrics' }, 'canonical', sourceEvidence, {
            sourceText: 'source', readerAttemptsDir: directory, readerRecordDisposition: () => {},
            readerMaterializeFigures: async () => { throw transient; },
            readerCallModel: async () => { modelCalls += 1; throw new Error('must not call model'); }
        }
    ), error => error === transient && error.retryable === true && error.attempts === 3);
    assert.equal(modelCalls, 0);
    assert.deepEqual(fs.readdirSync(directory), [], 'pre-model failure cannot create a Reader candidate');

    const permanent = new Error('arXiv Figure download failed: HTTP 404');
    await assert.rejects(generateApiReaderArticleDetailed(
        { arxivId: '2509.24457', title: 'Speech quality metrics' }, 'canonical', sourceEvidence, {
            sourceText: 'source', readerAttemptsDir: directory, readerRecordDisposition: () => {},
            readerMaterializeFigures: async () => { throw permanent; },
            readerCallModel: async () => { modelCalls += 1; throw new Error('must not call model'); }
        }
    ), error => error === permanent && error.retryable !== true);
    assert.equal(modelCalls, 0); assert.deepEqual(fs.readdirSync(directory), []);
});

test('打补丁时网络失败会保留候选，并用同一次内容尝试继续打补丁', async t => {
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

test('实际的内容尝试额度一变，候选身份就跟着变', async t => {
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

test('收到截断或不完整的整篇回复会跨多次调用消耗内容和整篇额度', async t => {
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

test('收到截断或不完整的补丁回复只消耗内容额度，不改动此前的候选', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const configuration = require('../scripts/config.js').ANALYSIS_CONFIG;
    const priorRepairMaxTokens = configuration.apiReaderRepairMaxTokens;
    configuration.apiReaderRepairMaxTokens = 8000;
    t.after(() => { configuration.apiReaderRepairMaxTokens = priorRepairMaxTokens; });
    for (const code of ['MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE']) {
        const directory = temporary(t);
        const paper = { arxivId: '2609.99988', title: '补丁截断内容预算' };
        const draft = fixture(); draft.readerTitle = '短';
        let calls = 0;
        const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 2,
            readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
            readerCallModel: async (_messages, tokens) => {
                if (++calls === 1) return JSON.stringify(draft);
                throw Object.assign(new Error(`${code}: simulated patch output termination`), {
                    code, retryable: false, outputTokens: tokens, maxOutputTokens: tokens,
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
        if (code === 'MODEL_OUTPUT_TRUNCATED') {
            await assert.rejects(generateApiReaderArticleDetailed(
                paper, 'canonical', '', options
            ), error => error.code === code);
            assert.equal(calls, 3, 'an exact base truncation purchases one larger patch response');
            const retried = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
            assert.equal(retried.payload.attempts, 3);
            assert.equal(retried.payload.lastContentError.maxOutputTokens, 16000);
            await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /exhausted/);
            assert.equal(calls, 3, 'a retry-budget truncation cannot purchase another response');
        } else {
            await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /exhausted/);
            assert.equal(calls, 2, 'non-budget incomplete output has no escalation allowance');
        }
    }
});

test('非最后一次的补丁在 8000 token 处精确截断时，立刻用掉那个唯一的 16000 token 槽位', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const configuration = require('../scripts/config.js').ANALYSIS_CONFIG;
    const priorRepairMaxTokens = configuration.apiReaderRepairMaxTokens;
    configuration.apiReaderRepairMaxTokens = 8000;
    t.after(() => { configuration.apiReaderRepairMaxTokens = priorRepairMaxTokens; });
    const directory = temporary(t);
    const paper = { arxivId: '2609.99987', title: '局部截断自适应预算' };
    const draft = fixture(); draft.readerTitle = '短'; draft.sections[0].body = '太短';
    const calls = [];
    const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 3,
        readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
        readerCallModel: async (_messages, tokens, requestOptions) => {
            calls.push({ stage: requestOptions.usageContext.stage, tokens });
            if (calls.length === 1) return JSON.stringify(draft);
            if (calls.length === 2) {
                throw Object.assign(new Error('repair output hit its exact token ceiling'), {
                    code: 'MODEL_OUTPUT_TRUNCATED', retryable: false,
                    outputTokens: tokens, maxOutputTokens: tokens,
                    partialText: '{"version":1,"replacements":['
                });
            }
            return JSON.stringify(patchFor(draft, [
                ['/readerTitle', '声音表示如何与语义条件连接起来']
            ]));
        } };
    await assert.rejects(
        generateApiReaderArticleDetailed(paper, 'canonical', '', options),
        error => error.code === 'MODEL_OUTPUT_TRUNCATED'
    );
    const active = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const afterTruncation = JSON.parse(fs.readFileSync(path.join(directory, active), 'utf8'));
    assert.equal(afterTruncation.identity.repairMaxTokens, 8000,
        'candidate identity keeps the base budget for implementation-only migration');
    assert.equal(afterTruncation.payload.attempts, 2);
    assert.equal(afterTruncation.payload.fullAttempts, 1);
    assert.equal(afterTruncation.payload.lastContentError.requestKind, 'patch');
    await assert.rejects(
        generateApiReaderArticleDetailed(paper, 'canonical', '', options),
        /body 至少/
    );
    assert.deepEqual(calls, [
        { stage: 'apiReaderArticle', tokens: 48000 },
        { stage: 'apiReaderRepair', tokens: 8000 },
        { stage: 'apiReaderRepair', tokens: 16000 }
    ]);
    const afterRetry = JSON.parse(fs.readFileSync(path.join(directory, active), 'utf8'));
    assert.equal(afterRetry.payload.draft.readerTitle, '声音表示如何与语义条件连接起来');
    assert.equal(afterRetry.payload.draft.sections[0].body, '太短');
    assert.equal(afterRetry.payload.attempts, 3);
    assert.equal(afterRetry.payload.fullAttempts, 1, 'the resumed invocation made zero full Reader requests');
});

test('最后一次普通尝试在 8000 处截断时，只得到一次有上限的 16000 重试槽位', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const configuration = require('../scripts/config.js').ANALYSIS_CONFIG;
    const priorRepairMaxTokens = configuration.apiReaderRepairMaxTokens;
    configuration.apiReaderRepairMaxTokens = 8000;
    t.after(() => { configuration.apiReaderRepairMaxTokens = priorRepairMaxTokens; });
    const directory = temporary(t);
    const paper = { arxivId: '2609.99971', title: '末尾截断恢复' };
    const draft = fixture(); draft.readerTitle = '短'; draft.sections[0].body = '太短';
    const calls = [];
    const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 2,
        readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
        readerCallModel: async (_messages, tokens, requestOptions) => {
            calls.push({ stage: requestOptions.usageContext.stage, tokens });
            if (calls.length === 1) return JSON.stringify(draft);
            if (calls.length === 2) {
                throw Object.assign(new Error('final ordinary patch hit 8000'), {
                    code: 'MODEL_OUTPUT_TRUNCATED', retryable: false,
                    outputTokens: tokens, maxOutputTokens: tokens,
                    partialText: '{"version":1,"replacements":['
                });
            }
            return JSON.stringify(patchFor(draft, [
                ['/readerTitle', '声音表示如何与语义条件连接起来']
            ]));
        } };
    await assert.rejects(
        generateApiReaderArticleDetailed(paper, 'canonical', '', options),
        error => error.code === 'MODEL_OUTPUT_TRUNCATED'
    );
    await assert.rejects(
        generateApiReaderArticleDetailed(paper, 'canonical', '', options),
        /body 至少/
    );
    assert.deepEqual(calls, [
        { stage: 'apiReaderArticle', tokens: 48000 },
        { stage: 'apiReaderRepair', tokens: 8000 },
        { stage: 'apiReaderRepair', tokens: 16000 }
    ]);
    const active = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, active), 'utf8'));
    assert.equal(envelope.payload.attempts, 3);
    assert.equal(envelope.payload.fullAttempts, 1);
    assert.equal(envelope.payload.lastContentError, undefined);
    assert.equal(envelope.payload.implementationRepairAllowanceLineage,
        'reader-implementation-repair-lineage-v1');
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /exhausted/);
    assert.equal(calls.length, 3, 'the one larger retry cannot be repeated');
});

test('实现谱系的槽位在 8000 处截断后，不能再叠加第二个 16000 槽位', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const configuration = require('../scripts/config.js').ANALYSIS_CONFIG;
    const priorRepairMaxTokens = configuration.apiReaderRepairMaxTokens;
    configuration.apiReaderRepairMaxTokens = 8000;
    t.after(() => { configuration.apiReaderRepairMaxTokens = priorRepairMaxTokens; });
    const directory = temporary(t);
    const paper = { arxivId: '2609.99969', title: '实现额度不得叠加' };
    const draft = fixture(); draft.readerTitle = '短';
    let calls = 0;
    const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 2,
        readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
        readerCallModel: async (_messages, tokens) => {
            calls += 1;
            if (calls === 1) return JSON.stringify(draft);
            throw Object.assign(new Error('implementation slot hit its base ceiling'), {
                code: 'MODEL_OUTPUT_TRUNCATED', retryable: false,
                outputTokens: tokens, maxOutputTokens: tokens
            });
        } };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options),
        error => error.code === 'MODEL_OUTPUT_TRUNCATED');
    const active = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, active), 'utf8'));
    saveFailedCandidate(directory, envelope.identity, {
        ...envelope.payload,
        implementationRepairAllowanceLineage: 'reader-implementation-repair-lineage-v1'
    });
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /exhausted/);
    assert.equal(calls, 2, 'the consumed implementation lineage blocks a stacked 16000 response');
});

test('最后槽位的 16000 回复之前发生传输失败，保留同一次重试且不消耗内容', async t => {
    const { generateApiReaderArticleDetailed } = require('../scripts/deep-analyzer.js');
    const configuration = require('../scripts/config.js').ANALYSIS_CONFIG;
    const priorRepairMaxTokens = configuration.apiReaderRepairMaxTokens;
    configuration.apiReaderRepairMaxTokens = 8000;
    t.after(() => { configuration.apiReaderRepairMaxTokens = priorRepairMaxTokens; });
    const directory = temporary(t);
    const paper = { arxivId: '2609.99970', title: '末尾截断网络恢复' };
    const draft = fixture(); draft.readerTitle = '短';
    const calls = [];
    const options = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 2,
        readerRecordDisposition: () => {}, readerMaterializeFigures: async () => [],
        readerCallModel: async (_messages, tokens, requestOptions) => {
            calls.push({ stage: requestOptions.usageContext.stage, tokens });
            if (calls.length === 1) return JSON.stringify(draft);
            if (calls.length === 2) {
                throw Object.assign(new Error('final ordinary patch hit 8000'), {
                    code: 'MODEL_OUTPUT_TRUNCATED', retryable: false,
                    outputTokens: tokens, maxOutputTokens: tokens
                });
            }
            if (calls.length === 3) throw new Error('temporary connection reset');
            throw Object.assign(new Error('bounded 16000 output still truncated'), {
                code: 'MODEL_OUTPUT_TRUNCATED', retryable: false,
                outputTokens: tokens, maxOutputTokens: tokens
            });
        } };
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options),
        error => error.code === 'MODEL_OUTPUT_TRUNCATED');
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options),
        /connection reset/);
    let active = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    let envelope = JSON.parse(fs.readFileSync(path.join(directory, active), 'utf8'));
    assert.equal(envelope.payload.attempts, 2, 'transport receives no content and cannot consume the extra slot');
    assert.equal(envelope.payload.lastContentError.maxOutputTokens, 8000,
        'the exact base truncation proof survives a transport-only failure');
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options),
        error => error.code === 'MODEL_OUTPUT_TRUNCATED');
    active = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    envelope = JSON.parse(fs.readFileSync(path.join(directory, active), 'utf8'));
    assert.equal(envelope.payload.attempts, 3);
    assert.equal(envelope.payload.lastContentError.maxOutputTokens, 16000);
    assert.equal(envelope.payload.implementationRepairAllowanceLineage,
        'reader-implementation-repair-lineage-v1');
    await assert.rejects(generateApiReaderArticleDetailed(paper, 'canonical', '', options), /exhausted/);
    assert.deepEqual(calls.map(call => call.tokens), [48000, 8000, 16000, 16000]);
});

// 固定下来的完整输出，取自本实现之前的提交 fcee227。
const tableOrderCases = [
  {
    "name": "missing-binding",
    "draft": {
      "sections": [
        {
          "kind": "result",
          "heading": "results",
          "body": "| Method | Value |\n| --- | --- |\n| result | 12 |"
        },
        {
          "kind": "ablation",
          "heading": "ablations",
          "body": "| Method | Value |\n| --- | --- |\n| ablation | 12 |"
        },
        {
          "kind": "experiment_setup",
          "heading": "setup",
          "body": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
        }
      ],
      "tableBindings": [
        {
          "tableIndex": 1,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "result quote"
          ]
        },
        {
          "tableIndex": 2,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "ablation quote"
          ]
        }
      ],
      "conceptBridges": [],
      "figurePlacements": [],
      "formulaBindings": []
    },
    "issues": [
      {
        "path": null,
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/1/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/2/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/0",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/1",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/1/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/2/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": null,
        "diagnosticOnly": true,
        "message": "Reader 表格清单尚未闭合：正文实际Markdown表 3 张、selection 0 项、tableBindings 2 项。source_quotes/artifact_table 都必须有对应的实际Markdown；由完整parser决定现有确定性quote补绑定能否恢复。"
      },
      {
        "path": null,
        "code": "reader_length_preflight",
        "diagnosticOnly": true,
        "message": "Reader 篇幅预估为 0 个汉字（标题、正文和术语桥；不含绑定JSON），最终门禁为 5000–18000；目前估计至少还需 5000 字。修复表格时同时扩写已有方法、执行顺序或实验比较段落，保留正确事实。此项仅预检提示，最终中文字数以完整parser组装后为准。"
      }
    ],
    "hash": "b646d527cca526c97135889c1f6385b0fb1feff6c2bc8721e06bdc3df545b202",
    "signature": "reader-validation-v2:{\"gateSha256\":\"9874dfa458270cdc5bc3f7b318fdbb6f893846a8b0fe3847052807ae70e37356\",\"deficits\":[]}",
    "targets": [
      {
        "path": "/sections/0/body",
        "oldSha256": "2af3a3a507da29cae23de040d24bf9d22f539f0482ebac8158f3fc453ff84619",
        "value": "| Method | Value |\n| --- | --- |\n| result | 12 |"
      },
      {
        "path": "/sections/1/body",
        "oldSha256": "3d50e64455a27e0078ec870d5802b8c395e271b45f21032943813f4e19d97515",
        "value": "| Method | Value |\n| --- | --- |\n| ablation | 12 |"
      },
      {
        "path": "/sections/2/body",
        "oldSha256": "b1181025c52101f4a5de20ebd42b80db6f6bc1395054749da131b03bbdcc1cad",
        "value": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
      },
      {
        "path": "/tableBindings/0",
        "oldSha256": "a90ae6ff2034028f66a803e82bc967961af8752e437531212ad03ce36402a419",
        "value": {
          "tableIndex": 1,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "result quote"
          ]
        }
      },
      {
        "path": "/tableBindings/1",
        "oldSha256": "3f6cdbbd47e13be51749f950d1a10a00e2ac7d17356e190ad2f9337c5fdd50cb",
        "value": {
          "tableIndex": 2,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "ablation quote"
          ]
        }
      }
    ]
  },
  {
    "name": "extra-table",
    "draft": {
      "sections": [
        {
          "kind": "result",
          "heading": "results",
          "body": "| Method | Value |\n| --- | --- |\n| result | 12 |"
        },
        {
          "kind": "ablation",
          "heading": "ablations",
          "body": "| Method | Value |\n| --- | --- |\n| ablation | 12 |\n\n| Method | Value |\n| --- | --- |\n| extra-table | 12 |"
        },
        {
          "kind": "experiment_setup",
          "heading": "setup",
          "body": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
        }
      ],
      "tableBindings": [
        {
          "tableIndex": 1,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "result quote"
          ]
        },
        {
          "tableIndex": 2,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "ablation quote"
          ]
        },
        {
          "tableIndex": 3,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "setup quote"
          ]
        }
      ],
      "conceptBridges": [],
      "figurePlacements": [],
      "formulaBindings": []
    },
    "issues": [
      {
        "path": null,
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/1/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/1/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/2/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/0",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/1",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/2",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/1/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/2/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/tableBindings/2",
        "message": "tableBindings[2] sourceQuotes 中以下数组项不是全文中12–4000字符的连续原句：0；不要只摘独立数值或把引文写成对象。原文双写数值可留在引文中，正文写法仍须通过既有来源门禁。",
        "diagnosticOnly": true
      },
      {
        "path": null,
        "diagnosticOnly": true,
        "message": "Reader 表格清单尚未闭合：正文实际Markdown表 4 张、selection 0 项、tableBindings 3 项。source_quotes/artifact_table 都必须有对应的实际Markdown；由完整parser决定现有确定性quote补绑定能否恢复。"
      },
      {
        "path": null,
        "code": "reader_length_preflight",
        "diagnosticOnly": true,
        "message": "Reader 篇幅预估为 0 个汉字（标题、正文和术语桥；不含绑定JSON），最终门禁为 5000–18000；目前估计至少还需 5000 字。修复表格时同时扩写已有方法、执行顺序或实验比较段落，保留正确事实。此项仅预检提示，最终中文字数以完整parser组装后为准。"
      }
    ],
    "hash": "7d949b59d2f566f0ee0757706bb4111aec7904bc0c663f08a30d7c068fb875de",
    "signature": "reader-validation-v2:{\"gateSha256\":\"d1cda6ba01760f39d4e917b86667ce2d963bb31adfec739bd8ebe8d43023014f\",\"deficits\":[]}",
    "targets": [
      {
        "path": "/sections/0/body",
        "oldSha256": "2af3a3a507da29cae23de040d24bf9d22f539f0482ebac8158f3fc453ff84619",
        "value": "| Method | Value |\n| --- | --- |\n| result | 12 |"
      },
      {
        "path": "/sections/1/body",
        "oldSha256": "c0ec514ed548efe8cbc93bbb660b386e01f902bf11109eb12dc431ceb9b03cfb",
        "value": "| Method | Value |\n| --- | --- |\n| ablation | 12 |\n\n| Method | Value |\n| --- | --- |\n| extra-table | 12 |"
      },
      {
        "path": "/sections/2/body",
        "oldSha256": "b1181025c52101f4a5de20ebd42b80db6f6bc1395054749da131b03bbdcc1cad",
        "value": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
      },
      {
        "path": "/tableBindings/0",
        "oldSha256": "a90ae6ff2034028f66a803e82bc967961af8752e437531212ad03ce36402a419",
        "value": {
          "tableIndex": 1,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "result quote"
          ]
        }
      },
      {
        "path": "/tableBindings/1",
        "oldSha256": "3f6cdbbd47e13be51749f950d1a10a00e2ac7d17356e190ad2f9337c5fdd50cb",
        "value": {
          "tableIndex": 2,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "ablation quote"
          ]
        }
      },
      {
        "path": "/tableBindings/2",
        "oldSha256": "a27cfe18a414e9c96e84b917820ee373e1c7a1d23d3284e6716715f24d45ffdd",
        "value": {
          "tableIndex": 3,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "setup quote"
          ]
        }
      }
    ]
  },
  {
    "name": "equal-count-marker-ambiguity",
    "draft": {
      "sections": [
        {
          "kind": "result",
          "heading": "results",
          "body": "[[TABLE_3]]"
        },
        {
          "kind": "ablation",
          "heading": "ablations",
          "body": "| Method | Value |\n| --- | --- |\n| ablation | 12 |"
        },
        {
          "kind": "experiment_setup",
          "heading": "setup",
          "body": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
        }
      ],
      "tableBindings": [
        {
          "tableIndex": 1,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "result quote"
          ]
        },
        {
          "tableIndex": 2,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "ablation quote"
          ]
        },
        {
          "tableIndex": 3,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "setup quote"
          ]
        }
      ],
      "conceptBridges": [],
      "figurePlacements": [],
      "formulaBindings": []
    },
    "issues": [
      {
        "path": null,
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/1/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/2/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/0",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/1",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/2",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/1/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/2/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/tableBindings/2",
        "message": "tableBindings[2] sourceQuotes 中以下数组项不是全文中12–4000字符的连续原句：0；不要只摘独立数值或把引文写成对象。原文双写数值可留在引文中，正文写法仍须通过既有来源门禁。",
        "diagnosticOnly": true
      },
      {
        "path": "/tableBindings/2",
        "message": "tableBindings[2] 使用 source_quotes 时正文必须直接写 Markdown 表，不能使用 [[TABLE_3]]；同步修改 sections[0].body 与本绑定项"
      },
      {
        "path": "/sections/0/body",
        "message": "sections[0].body 的 [[TABLE_3]] 没有selection绑定，需由模型按原文写出完整Markdown表；tableBindings[2]本身不会生成表格"
      },
      {
        "path": null,
        "diagnosticOnly": true,
        "message": "Reader 表格清单尚未闭合：正文实际Markdown表 2 张、selection 0 项、tableBindings 3 项。source_quotes/artifact_table 都必须有对应的实际Markdown；由完整parser决定现有确定性quote补绑定能否恢复。"
      },
      {
        "path": null,
        "code": "reader_length_preflight",
        "diagnosticOnly": true,
        "message": "Reader 篇幅预估为 0 个汉字（标题、正文和术语桥；不含绑定JSON），最终门禁为 5000–18000；目前估计至少还需 5000 字。修复表格时同时扩写已有方法、执行顺序或实验比较段落，保留正确事实。此项仅预检提示，最终中文字数以完整parser组装后为准。"
      }
    ],
    "hash": "dee92789afef243bfc4a8ebb7fb6ac9283983510545a5f73179ff8ec4ab3e401",
    "signature": "reader-validation-v2:{\"gateSha256\":\"5513f9ec192463f4ef190458b56714e7d5851cdeade58213a98853d50ba14f85\",\"deficits\":[]}",
    "targets": [
      {
        "path": "/sections/0/body",
        "oldSha256": "93add3e38e13eddb57102c19d9a8e75480d68b7ae722c53305247a76213f5959",
        "value": "[[TABLE_3]]"
      },
      {
        "path": "/sections/1/body",
        "oldSha256": "3d50e64455a27e0078ec870d5802b8c395e271b45f21032943813f4e19d97515",
        "value": "| Method | Value |\n| --- | --- |\n| ablation | 12 |"
      },
      {
        "path": "/sections/2/body",
        "oldSha256": "b1181025c52101f4a5de20ebd42b80db6f6bc1395054749da131b03bbdcc1cad",
        "value": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
      },
      {
        "path": "/tableBindings/0",
        "oldSha256": "a90ae6ff2034028f66a803e82bc967961af8752e437531212ad03ce36402a419",
        "value": {
          "tableIndex": 1,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "result quote"
          ]
        }
      },
      {
        "path": "/tableBindings/1",
        "oldSha256": "3f6cdbbd47e13be51749f950d1a10a00e2ac7d17356e190ad2f9337c5fdd50cb",
        "value": {
          "tableIndex": 2,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "ablation quote"
          ]
        }
      },
      {
        "path": "/tableBindings/2",
        "oldSha256": "a27cfe18a414e9c96e84b917820ee373e1c7a1d23d3284e6716715f24d45ffdd",
        "value": {
          "tableIndex": 3,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "setup quote"
          ]
        }
      }
    ]
  },
  {
    "name": "same-section-duplicate-path",
    "draft": {
      "sections": [
        {
          "kind": "result",
          "heading": "results",
          "body": "| Method | Value |\n| --- | --- |\n| result | 12 |\n\n| Method | Value |\n| --- | --- |\n| second-result | 12 |"
        },
        {
          "kind": "ablation",
          "heading": "ablations",
          "body": "| Method | Value |\n| --- | --- |\n| ablation | 12 |"
        },
        {
          "kind": "experiment_setup",
          "heading": "setup",
          "body": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
        }
      ],
      "tableBindings": [
        {
          "tableIndex": 1,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "result quote"
          ]
        },
        {
          "tableIndex": 2,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "ablation quote"
          ]
        },
        {
          "tableIndex": 3,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "setup quote"
          ]
        }
      ],
      "conceptBridges": [],
      "figurePlacements": [],
      "formulaBindings": []
    },
    "issues": [
      {
        "path": null,
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/1/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/2/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/0",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/1",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/2",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/1/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/2/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/tableBindings/2",
        "message": "tableBindings[2] sourceQuotes 中以下数组项不是全文中12–4000字符的连续原句：0；不要只摘独立数值或把引文写成对象。原文双写数值可留在引文中，正文写法仍须通过既有来源门禁。",
        "diagnosticOnly": true
      },
      {
        "path": null,
        "diagnosticOnly": true,
        "message": "Reader 表格清单尚未闭合：正文实际Markdown表 4 张、selection 0 项、tableBindings 3 项。source_quotes/artifact_table 都必须有对应的实际Markdown；由完整parser决定现有确定性quote补绑定能否恢复。"
      },
      {
        "path": null,
        "code": "reader_length_preflight",
        "diagnosticOnly": true,
        "message": "Reader 篇幅预估为 0 个汉字（标题、正文和术语桥；不含绑定JSON），最终门禁为 5000–18000；目前估计至少还需 5000 字。修复表格时同时扩写已有方法、执行顺序或实验比较段落，保留正确事实。此项仅预检提示，最终中文字数以完整parser组装后为准。"
      }
    ],
    "hash": "aec9bd3e884249bddb666bf6a5b872c1dac26fa50dcb5b8c509c5464d51ae95e",
    "signature": "reader-validation-v2:{\"gateSha256\":\"3a780c6181997ddf885629b5245b266c5f9cad0a2fc12bb05721a55b66e5a901\",\"deficits\":[]}",
    "targets": [
      {
        "path": "/sections/0/body",
        "oldSha256": "ae924cff2a1741996b08bb523661715a83daac7fe22193125c8d478588d6f977",
        "value": "| Method | Value |\n| --- | --- |\n| result | 12 |\n\n| Method | Value |\n| --- | --- |\n| second-result | 12 |"
      },
      {
        "path": "/sections/1/body",
        "oldSha256": "3d50e64455a27e0078ec870d5802b8c395e271b45f21032943813f4e19d97515",
        "value": "| Method | Value |\n| --- | --- |\n| ablation | 12 |"
      },
      {
        "path": "/sections/2/body",
        "oldSha256": "b1181025c52101f4a5de20ebd42b80db6f6bc1395054749da131b03bbdcc1cad",
        "value": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
      },
      {
        "path": "/tableBindings/0",
        "oldSha256": "a90ae6ff2034028f66a803e82bc967961af8752e437531212ad03ce36402a419",
        "value": {
          "tableIndex": 1,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "result quote"
          ]
        }
      },
      {
        "path": "/tableBindings/1",
        "oldSha256": "3f6cdbbd47e13be51749f950d1a10a00e2ac7d17356e190ad2f9337c5fdd50cb",
        "value": {
          "tableIndex": 2,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "ablation quote"
          ]
        }
      },
      {
        "path": "/tableBindings/2",
        "oldSha256": "a27cfe18a414e9c96e84b917820ee373e1c7a1d23d3284e6716715f24d45ffdd",
        "value": {
          "tableIndex": 3,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "setup quote"
          ]
        }
      }
    ]
  },
  {
    "name": "missing-table-selection-binding",
    "draft": {
      "sections": [
        {
          "kind": "result",
          "heading": "results",
          "body": "| Method | Value |\n| --- | --- |\n| result | 12 |"
        },
        {
          "kind": "ablation",
          "heading": "ablations",
          "body": "| Method | Value |\n| --- | --- |\n| ablation | 12 |"
        },
        {
          "kind": "experiment_setup",
          "heading": "setup",
          "body": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
        }
      ],
      "tableBindings": [
        {
          "tableIndex": 1,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "result quote"
          ]
        },
        {
          "tableIndex": 2,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "ablation quote"
          ]
        },
        {
          "tableIndex": 3,
          "sourceType": "source_quotes",
          "sourceTableOrdinal": null,
          "cellBindings": [],
          "sourceQuotes": [
            "setup quote"
          ]
        },
        {
          "tableIndex": 4,
          "selection": {
            "sourceTableOrdinal": 4,
            "sourceRows": [
              0,
              1
            ],
            "sourceColumns": [
              0,
              1
            ]
          }
        }
      ],
      "conceptBridges": [],
      "figurePlacements": [],
      "formulaBindings": []
    },
    "issues": [
      {
        "path": null,
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/1/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/2/body",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/0",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/1",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/2",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/tableBindings/3",
        "message": "Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格"
      },
      {
        "path": "/sections/0/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/1/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/sections/2/body",
        "message": "小节 body 至少 120 字符"
      },
      {
        "path": "/tableBindings/2",
        "message": "tableBindings[2] sourceQuotes 中以下数组项不是全文中12–4000字符的连续原句：0；不要只摘独立数值或把引文写成对象。原文双写数值可留在引文中，正文写法仍须通过既有来源门禁。",
        "diagnosticOnly": true
      },
      {
        "path": "/tableBindings/3",
        "message": "tableBindings[3] 的 [[TABLE_4]] 必须在正文中唯一独占一段"
      },
      {
        "path": null,
        "code": "reader_length_preflight",
        "diagnosticOnly": true,
        "message": "Reader 篇幅预估为 0 个汉字（标题、正文和术语桥；不含绑定JSON），最终门禁为 5000–18000；目前估计至少还需 5000 字。修复表格时同时扩写已有方法、执行顺序或实验比较段落，保留正确事实。此项仅预检提示，最终中文字数以完整parser组装后为准。"
      }
    ],
    "hash": "163af4d5b98d73db2cd07f3715f73e5c608dc69200f1462ed31e0a0cbcafac6a",
    "signature": "reader-validation-v2:{\"gateSha256\":\"1c9faacd7ba9b1a0b40290811ca66fb8934bec844a0131a119132c5e2fa3e30a\",\"deficits\":[]}",
    "targets": [
      {
        "path": "/sections/2/body",
        "oldSha256": "b1181025c52101f4a5de20ebd42b80db6f6bc1395054749da131b03bbdcc1cad",
        "value": "| Method | Value |\n| --- | --- |\n| setup | 12 |"
      },
      {
        "path": "/tableBindings/3",
        "oldSha256": "f4ebdec83f7deb4b069f151e9fdb392032f0c5522389f1a2d7a168dd34922fc0",
        "value": {
          "tableIndex": 4,
          "selection": {
            "sourceTableOrdinal": 4,
            "sourceRows": [
              0,
              1
            ],
            "sourceColumns": [
              0,
              1
            ]
          }
        }
      }
    ]
  }
];

const tableOrderCode = 'reader_table_binding_order_ambiguous';
const oldTableOrderMessage = 'Reader 正文重排前表格与绑定无法唯一闭合；请按当前 candidate 正文顺序补齐 tableBindings 与 selection marker，禁止猜测或丢弃表格';
const newTableOrderMessage = '重排正文前，表格与来源记录不能一一对应。请按当前草稿的正文顺序核对 tableBindings 和 TABLE 占位符，不猜测缺失数据，也不丢弃已有来源的表格。';
const noTableOrderTargetMessage = '没有可安全修复的表格对应节点，已保留失败草稿；本次未发送模型请求';

function tableOrderIssue(path = null, extra = {}) {
    return { path, message: newTableOrderMessage, code: tableOrderCode, ...extra };
}

function tableOrderError(children, extra = {}) {
    return Object.assign(new Error(newTableOrderMessage), {
        code: 'READER_DRAFT_ORDER_AMBIGUOUS', readerIssues: children, ...extra
    });
}

function storedReaderFailure(directory) {
    const names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    assert.equal(names.length, 1);
    const filename = path.join(directory, names[0]);
    const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(envelope.payloadSha256, hashDraft(envelope.payload));
    assert.deepEqual(loadFailedCandidate(directory, envelope.identity), envelope.payload);
    return { filename, ...envelope };
}

test('真实排序异常保留五组旧完整诊断的顺序、重复路径、比较值与修复节点', async t => {
    const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order.js');
    for (const row of tableOrderCases) {
        await t.test(row.name, () => {
            const draft = structuredClone(row.draft);
            const original = JSON.stringify(draft);
            let error;
            try { normalizeReaderDraftOrder(draft); } catch (caught) { error = caught; }
            assert.ok(error instanceof Error);
            assert.equal(error.code, 'READER_DRAFT_ORDER_AMBIGUOUS');
            assert.equal(error.message, newTableOrderMessage);
            const issues = collectDraftIssues(draft, error);
            // 只有这句固定的旧生产文案会同时得到新的展示字段和带类型的 code。
            const expected = row.issues.map(issue => issue.message === oldTableOrderMessage
                ? { ...issue, message: newTableOrderMessage, code: tableOrderCode } : issue);
            assert.equal(JSON.stringify(issues), JSON.stringify(expected));
            assert.equal(hashRecoveryIssues(issues), row.hash);
            assert.equal(validationFailureSignature(issues), row.signature);
            assert.equal(JSON.stringify(buildRepairTargets(draft, issues)), JSON.stringify(row.targets));
            assert.equal(JSON.stringify(draft), original);
        });
    }
    const reference = tableOrderCases[0].issues.filter(issue => issue.path !== null
        && issue.message === oldTableOrderMessage).map(issue => ({ ...issue, diagnosticOnly: true }));
    assert.equal(hashRecoveryIssues(reference), '81e0cc6a665cb2c34454df631f17317c7b3c674705235d506e6077c0e175ac18');
    assert.equal(validationFailureSignature(reference), 'reader-validation-v2:{"gateSha256":"4480ef335d1d0c4536baa7be3e9340905f7a69f615e8ae7ee04f4cce4da05c42","deficits":[]}');
    assert.deepEqual(buildRepairTargets(tableOrderCases[0].draft, reference), []);
    assert.equal(hashRecoveryIssues(reference.map(issue => ({ ...issue, message: newTableOrderMessage,
        code: tableOrderCode }))), hashRecoveryIssues(reference));
});

test('完整旧句与结构化诊断只接受规范路径，参考项和显式代码冲突没有操作权限', () => {
    const validPaths = [null, '/sections/0/body', '/sections/123/body', '/tableBindings/0', '/tableBindings/9007199254740991'];
    for (const path of validPaths) {
        const typed = tableOrderIssue(path);
        const legacy = { path, message: oldTableOrderMessage };
        for (const issue of [typed, legacy]) {
            assert.equal(classifyTableBindingOrderIssue(issue).actionable, true);
            assert.equal(classifyTableBindingOrderIssue(issue).ignoreMessageForRepair, true);
            assert.equal(readTableBindingOrderIssue(issue), issue);
            const reference = { ...issue, diagnosticOnly: true };
            assert.equal(readTableBindingOrderIssue(reference), reference);
            assert.equal(classifyTableBindingOrderIssue(reference).actionable, false);
        }
    }
    const badPaths = [undefined, 0, {}, '/sections/01/body', '/tableBindings/-1', '/sections/1/body\n',
        '/sections/1/body\r', '/sections/1/body ', '/tableBindings/9007199254740992', '/readerTitle', '/tableBindings'];
    for (const path of badPaths) {
        for (const issue of [{ path, message: newTableOrderMessage, code: tableOrderCode }, { path, message: oldTableOrderMessage }]) {
            assert.equal(classifyTableBindingOrderIssue(issue).actionable, false);
            assert.equal(readTableBindingOrderIssue(issue), null);
            assert.deepEqual(buildRepairTargets(fixture(), [issue]), []);
        }
    }
    const absentPath = tableOrderIssue(); delete absentPath.path;
    assert.equal(classifyTableBindingOrderIssue(absentPath).kind, 'invalid-typed');
    for (const diagnosticOnly of [undefined, 'true', 0, null]) {
        assert.equal(classifyTableBindingOrderIssue(tableOrderIssue(null, { diagnosticOnly })).kind, 'invalid-typed');
    }
    for (const code of [undefined, null, '']) {
        assert.equal(classifyTableBindingOrderIssue({ path: null, message: oldTableOrderMessage, code }).kind, 'legacy');
    }
    for (const code of [0, false, ' ', 'other', NaN]) {
        const issue = { path: '/sections/0/body', message: oldTableOrderMessage, code };
        assert.equal(classifyTableBindingOrderIssue(issue).kind, 'code-conflict');
        assert.deepEqual(buildRepairTargets(fixture(), [issue]), []);
    }
    for (const message of [`前缀${oldTableOrderMessage}`, `${oldTableOrderMessage}后缀`, newTableOrderMessage]) {
        assert.equal(classifyTableBindingOrderIssue({ path: null, message }).kind, 'unrelated');
    }
});

test('异常适配核验实际 Error 和全部子项，持久对象与无效异常不能借旧句重新授权', () => {
    const children = [tableOrderIssue('/sections/0/body'), tableOrderIssue('/sections/0/body')];
    const valid = tableOrderError(children);
    const result = readTableBindingOrderError(valid);
    assert.equal(result.validOrderError, true);
    assert.equal(result.actionable, true);
    assert.equal(result.readerIssues, children);
    assert.deepEqual(result.summary, tableOrderIssue());
    assert.equal(readTableBindingOrderError(oldTableOrderMessage).validOrderError, true);
    assert.equal(readTableBindingOrderError(new Error(oldTableOrderMessage)).validOrderError, true);
    for (const object of [tableOrderIssue(), { path: null, message: oldTableOrderMessage },
        { code: valid.code, message: valid.message, readerIssues: children }]) {
        assert.equal(readTableBindingOrderError(object), null);
        assert.equal(classifyTableBindingOrderError(object).kind, 'unrelated');
    }
    for (const error of [tableOrderError([]), tableOrderError([tableOrderIssue('/sections/01/body')]),
        tableOrderError([tableOrderIssue(null, { diagnosticOnly: true })]),
        tableOrderError(children, { diagnosticOnly: true }), tableOrderError(children, { diagnosticOnly: undefined }),
        tableOrderError([tableOrderIssue(null, { message: '不同说明' })]),
        tableOrderError([children[0], { path: null, message: oldTableOrderMessage }]),
        Object.assign(new Error(oldTableOrderMessage), { readerIssues: [] })]) {
        assert.equal(readTableBindingOrderError(error), null);
        const classified = classifyTableBindingOrderError(error);
        assert.equal(classified.kind, 'invalid-error');
        assert.equal(classified.ignoreMessageForRepair, true);
        assert.equal(classifyTableBindingOrderIssue(classified.summary).actionable, false);
    }
    const actualTyped = Object.assign(new Error('数字 2、formulaBindings、readerTitle 都不能授予权限'), {
        path: '/sections/1/body', code: tableOrderCode, diagnosticOnly: true
    });
    const snapshot = classifyTableBindingOrderError(actualTyped).summary;
    assert.deepEqual(Object.keys(snapshot), Object.getOwnPropertyNames(actualTyped).filter(key => key !== 'stack'));
    assert.equal(snapshot.message, actualTyped.message);
    assert.equal(snapshot.path, actualTyped.path);
    assert.equal(classifyTableBindingOrderError(actualTyped).actionable, false);
    const missingPath = Object.assign(new Error(oldTableOrderMessage), { code: tableOrderCode });
    const missingResult = classifyTableBindingOrderError(missingPath);
    assert.equal(missingResult.kind, 'invalid-typed');
    assert.equal(Object.hasOwn(missingResult.summary, 'path'), false);
    assert.equal(classifyTableBindingOrderError(Object.assign(new Error(oldTableOrderMessage), {
        path: '/readerTitle'
    })).kind, 'invalid-legacy');
});

test('失效或冲突异常的本组子项仅作为嵌套证据，独立真实节点诊断仍可修复', () => {
    const child = tableOrderIssue('/sections/1/body');
    const other = { path: '/readerTitle', message: 'readerTitle 不符合标题长度要求' };
    const bad = tableOrderError([child, other, child]);
    const oldWithChildren = Object.assign(new Error(oldTableOrderMessage), { readerIssues: [child, other, child] });
    const conflict = Object.assign(new Error(oldTableOrderMessage), { code: 'other', readerIssues: [child, other, child] });
    for (const error of [bad, oldWithChildren, conflict]) {
        const issues = collectDraftIssues(null, error);
        assert.equal(issues[0].readerIssues, error.readerIssues);
        assert.deepEqual(issues.slice(1), [other]);
        assert.deepEqual(buildRepairTargets(fixture(), issues).map(target => target.path), ['/readerTitle']);
        assert.equal(child.diagnosticOnly, undefined);
        assert.equal(child.code, tableOrderCode);
    }
    const valid = tableOrderError([child, child]);
    assert.deepEqual(collectDraftIssues(null, valid), [tableOrderIssue(), child, child]);
});

test('比较只稳定本组说明，保留字段、键序、重复和直接子项以外的证据变化', () => {
    const draft = countRepairFixture();
    const original = [tableOrderIssue('/sections/6/body', { bindingPath: '/tableBindings/1', extra: 7 }),
        tableOrderIssue('/sections/6/body', { extra: 8 })];
    const changed = original.map(issue => ({ ...issue, message: '数字 999、公式、figurePlacements、正文不足 3 字' }));
    assert.equal(hashRecoveryIssues(changed), hashRecoveryIssues(original));
    assert.equal(validationFailureSignature(changed), validationFailureSignature(original));
    assert.deepEqual(buildRepairTargets(draft, changed), buildRepairTargets(draft, original));
    for (const variant of [[original[1], original[0]], [{ ...original[0], extra: 9 }, original[1]]]) {
        assert.notEqual(hashRecoveryIssues(variant), hashRecoveryIssues(original));
        // 现有的校验检查会按 path/code/message 排序，并忽略多余字段。
        assert.equal(validationFailureSignature(variant), validationFailureSignature(original));
    }
    for (const variant of [original.slice(0, 1), [{ ...original[0], path: '/sections/7/body' }, original[1]]]) {
        assert.notEqual(hashRecoveryIssues(variant), hashRecoveryIssues(original));
        assert.notEqual(validationFailureSignature(variant), validationFailureSignature(original));
    }
    const nested = { path: null, code: 'READER_DRAFT_ORDER_AMBIGUOUS', message: '总说明 1', readerIssues: [
        tableOrderIssue('/sections/01/body', { message: '坏路径 1', readerIssues: [{ message: '深层 1' }] }),
        { path: '/readerTitle', code: 'unrelated', message: '真实其他问题 1' }, 1,
        { path: null, code: tableOrderCode, message: 12 }
    ] };
    const same = structuredClone(nested); same.message = '总说明 999'; same.readerIssues[0].message = '坏路径 999';
    assert.equal(hashRecoveryIssues([nested]), hashRecoveryIssues([same]));
    assert.equal(validationFailureSignature([nested]), validationFailureSignature([same]));
    for (const mutate of [issue => { issue.readerIssues[0].path = '/sections/02/body'; },
        issue => { issue.readerIssues[0].readerIssues[0].message = '深层 2'; },
        issue => { issue.readerIssues[1].message = '真实其他问题 2'; },
        issue => { issue.readerIssues.reverse(); }, issue => { issue.readerIssues[3].message = 13; }]) {
        const variant = structuredClone(nested); mutate(variant);
        assert.notEqual(hashRecoveryIssues([nested]), hashRecoveryIssues([variant]));
        // 嵌套的证据算进恢复哈希，不属于原来的校验检查。
        assert.equal(validationFailureSignature([nested]), validationFailureSignature([variant]));
    }
});

test('无效、冲突和参考表格诊断不能从路径别名或文字取得通用、原子和整篇修复', () => {
    const draft = countRepairFixture();
    const malicious = 'readerTitle、formulaBindings、figurePlacements、tableBindings 缺失，必须保留结果表；正文仅 2 字，quantitative_chinese_numeral:两阶段';
    const issues = [tableOrderIssue('/sections/6/body', { diagnosticOnly: true, message: malicious,
        bindingPath: '/tableBindings/0' }), tableOrderIssue('/readerTitle', { message: malicious }),
        { path: '/sections/6/body', message: oldTableOrderMessage, code: 'unknown', bindingPath: '/tableBindings/0' },
        { path: '/sections/6/body\n', message: oldTableOrderMessage },
        { path: null, code: 'READER_DRAFT_ORDER_AMBIGUOUS', message: malicious, readerIssues: [tableOrderIssue()] }];
    for (const issue of issues) {
        const context = buildRepairContext(draft, [issue], 'TABLE_1: 真实来源', '原文');
        assert.deepEqual(context.targets, []);
        assert.equal(context.atomicOperation, null);
        assert.deepEqual(context.figureOrdinals, []);
    }
    const positive = buildRepairTargets(draft, [...issues, { path: '/readerTitle', message: 'readerTitle 太短' }]);
    assert.deepEqual(positive.map(target => target.path), ['/readerTitle']);
    const many = structuredClone(draft);
    many.sections.forEach(section => { section.body += '\n\n| 项目 | 值 |\n| --- | --- |\n| 结果 | 1 |'; });
    assert.equal(buildRepairTargets(many, [tableOrderIssue()]).length, 8);
});

test('保存前拒绝实际 JSON 序列化扩大权限，原目录和候选字节保持不变', async t => {
    const cases = [
        { path: null, message: oldTableOrderMessage, diagnosticOnly: undefined },
        { path: null, message: oldTableOrderMessage, code: NaN },
        { path: null, message: oldTableOrderMessage, readerIssues: undefined }
    ];
    const refusal = '保存后诊断字段会变化，可能扩大修复范围；请保留有效字段后重试。';
    for (const [index, issue] of cases.entries()) {
        await t.test(`实际序列化反例 ${index + 1}`, tt => {
            const root = temporary(tt), directory = path.join(root, 'not-created');
            const identity = { paperId: '2609.99870', input: index };
            assert.equal(classifyTableBindingOrderIssue(issue).actionable, false);
            assert.equal(classifyTableBindingOrderIssue(JSON.parse(JSON.stringify(issue))).actionable, true);
            assert.throws(() => saveFailedCandidate(directory, identity, { ...failed(), issues: [issue] }),
                error => error.message === refusal);
            assert.equal(fs.existsSync(directory), false);
            const filename = saveFailedCandidate(root, identity, { ...failed(), issues: [{ path: null, message: oldTableOrderMessage }] });
            const bytes = fs.readFileSync(filename), names = fs.readdirSync(root);
            assert.throws(() => saveFailedCandidate(root, identity, { ...failed(), issues: [issue] }),
                error => error.message === refusal);
            assert.deepEqual(fs.readFileSync(filename), bytes);
            assert.deepEqual(fs.readdirSync(root), names);
        });
    }
    const directory = temporary(t);
    for (const [index, issue] of [{ path: null, message: oldTableOrderMessage }, tableOrderIssue(),
        tableOrderIssue(null, { diagnosticOnly: true }), { path: '/readerTitle', message: '独立标题诊断' }].entries()) {
        const identity = { input: index };
        saveFailedCandidate(directory, identity, { ...failed(), issues: [issue] });
        assert.deepEqual(loadFailedCandidate(directory, identity).issues, [issue]);
    }
});

test('旧候选原始字节先认证，新增 typed 只校验直接主项，不递归认证嵌套证据', t => {
    const directory = temporary(t), identity = { input: 'raw authentication' };
    const old = { ...failed(), issues: [{ path: null, message: oldTableOrderMessage }] };
    const filename = saveFailedCandidate(directory, identity, old), bytes = fs.readFileSync(filename);
    assert.deepEqual(loadFailedCandidate(directory, identity), old);
    assert.deepEqual(fs.readFileSync(filename), bytes);
    const envelope = JSON.parse(bytes); envelope.payload.issues = [tableOrderIssue()];
    fs.writeFileSync(filename, JSON.stringify(envelope), { mode: 0o600 });
    assert.throws(() => loadFailedCandidate(directory, identity), /Corrupt/);
    envelope.payloadSha256 = hashDraft(envelope.payload);
    fs.writeFileSync(filename, JSON.stringify(envelope), { mode: 0o600 });
    assert.deepEqual(loadFailedCandidate(directory, identity).issues, [tableOrderIssue()]);
    envelope.payload.issues = [tableOrderIssue('/sections/01/body')];
    envelope.payloadSha256 = hashDraft(envelope.payload);
    fs.writeFileSync(filename, JSON.stringify(envelope), { mode: 0o600 });
    assert.throws(() => loadFailedCandidate(directory, identity), /Corrupt/);
    const nested = { path: null, code: 'READER_DRAFT_ORDER_AMBIGUOUS', message: '原始失效异常',
        readerIssues: [tableOrderIssue('/sections/01/body')] };
    envelope.payload.issues = [nested]; envelope.payloadSha256 = hashDraft(envelope.payload);
    fs.writeFileSync(filename, JSON.stringify(envelope), { mode: 0o600 });
    assert.deepEqual(loadFailedCandidate(directory, identity).issues, [nested]);
    assert.deepEqual(buildRepairTargets(fixture(), [nested]), []);
});

function withoutSignedTables() {
    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    for (const section of signed.draft.sections) {
        section.body = section.body.split(/\n\s*\n/).filter(block => !/^\|/m.test(block)).join('\n\n');
    }
    signed.draft.tableBindings = [];
    return signed;
}

test('真实来源单元格错误继续生成诊断，本组异常的数字说明不能伪造来源错误', () => {
    const deep = require('../scripts/deep-analyzer.js');
    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    signed.draft.sections[7].body = signed.draft.sections[7].body.replace('| 1.0 |', '| 9.876 |');
    let actual;
    try { deep.parseApiReaderArticleResult(JSON.stringify(signed.draft), {
        requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
        requireSourceBindings: true, allowDeterministicQuoteRepair: true,
        sourceText: signed.sourceDetails.text, structuredArtifacts: signed.sourceDetails.structuredArtifacts
    }); } catch (error) { actual = error; }
    assert.ok(actual instanceof Error);
    assert.match(actual.message, /单元格|原表|source/i);
    const options = { sourceText: signed.sourceDetails.text, structuredArtifacts: signed.sourceDetails.structuredArtifacts };
    const realIssues = collectDraftIssues(signed.draft, actual, options);
    assert.ok(realIssues.some(issue => issue.code === 'reader_source_cell_diagnostic'));
    assert.ok(buildRepairTargets(signed.draft, realIssues).length > 0);
    const spoof = Object.assign(new Error(actual.message), { code: 'READER_DRAFT_ORDER_AMBIGUOUS', readerIssues: [] });
    const isolated = collectDraftIssues(signed.draft, spoof, options);
    assert.equal(isolated.some(issue => issue.code === 'reader_source_cell_diagnostic'), false);
    actual.readerIssues = [tableOrderIssue('/sections/7/body', { diagnosticOnly: true })];
    const independent = collectDraftIssues(signed.draft, actual, options);
    assert.ok(independent.some(issue => issue.code === 'reader_source_cell_diagnostic'));
    assert.equal(independent[0].message, actual.message);
});

test('真实歧义生成中断后只续修已有表格节点，完整解析器继续拒绝未合格正文', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const directory = temporary(t), draft = countRepairFixture();
    [draft.sections[6], draft.sections[7]] = [draft.sections[7], draft.sections[6]];
    draft.tableBindings[1].tableIndex = 1;
    const paper = { arxivId: '2609.99871', title: '表格顺序离线续修' };
    const base = { sourceText: 'source', readerAttemptsDir: directory, readerMaxAttempts: 2,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
    let initialCalls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed(paper, '', '', { ...base, readerCallModel: async () => {
        if (++initialCalls === 1) return JSON.stringify(draft);
        throw new Error('离线中断，尚未返回局部修复');
    } }), /离线中断/);
    assert.equal(initialCalls, 2);
    const stored = storedReaderFailure(directory);
    assert.equal(stored.payload.attempts, 1);
    assert.equal(stored.payload.fullAttempts, 1);
    assert.equal(stored.payload.transportFailures, 1);
    const expectedPaths = ['/sections/6/body', '/sections/7/body', '/sections/8/body',
        '/tableBindings/0', '/tableBindings/1', '/tableBindings/2'];
    let resumedCalls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed(paper, '', '', { ...base,
        readerCallModel: async (messages, _budget, options) => {
            resumedCalls++;
            assert.equal(options.usageContext.stage, 'apiReaderRepair');
            const line = messages[0].content[0].text.split('\n').find(line => line.startsWith('{"draftSha256":'));
            const envelope = JSON.parse(line);
            assert.deepEqual(envelope.targets.map(target => target.path), expectedPaths);
            const binding = { ...stored.payload.draft.tableBindings[1], tableIndex: 2 };
            return JSON.stringify(patchFor(stored.payload.draft, [['/tableBindings/1', binding]]));
        }
    }), error => error.code !== 'READER_DRAFT_ORDER_AMBIGUOUS');
    assert.equal(resumedCalls, 1);
    const after = storedReaderFailure(directory).payload;
    assert.equal(after.attempts, 2);
    assert.equal(after.fullAttempts, 1);
    assert.equal(after.transportFailures, 1);
    assert.ok(after.draftOrderMappings.length > 0);
    assert.equal(after.status, 'failed');
});

test('实际生成和续跑没有表格修复节点时不新增请求，并保留同轮次数与最新错误记录', async t => {
    const deep = require('../scripts/deep-analyzer.js'), repair = require('../scripts/lib/reader-repair.js');
    const signed = withoutSignedTables(), directory = temporary(t);
    const originalCollector = repair.collectDraftIssues;
    t.after(() => { repair.collectDraftIssues = originalCollector; });
    let injectedMetadata = false, parserFailures = 0, latestPayload;
    // 这里故意注入一条合法诊断，但它没有对应的 0/0 结构。
    // 真正的生产代码不会发这条诊断；归一化和完整解析流程照常执行。
    repair.collectDraftIssues = (draft, error, options) => {
        const real = originalCollector(draft, error, options);
        assert.ok(real.some(issue => issue.code === TABLE_COUNT_ISSUE_CODE));
        assert.equal(draft.tableBindings.length, 0);
        assert.equal(require('../scripts/lib/reader-draft-order.js').locateReaderDraftTables(draft).length, 0);
        parserFailures++;
        if (!injectedMetadata && fs.existsSync(directory) && fs.readdirSync(directory).some(name => /^[a-f0-9]{64}\.json$/.test(name))) {
            const stored = storedReaderFailure(directory);
            latestPayload = { ...stored.payload,
                lastContentError: { message: '本轮最新正文错误', code: 'latest-content' },
                lastTransportError: '本轮最新传输错误' };
            saveFailedCandidate(directory, stored.identity, latestPayload);
            injectedMetadata = true;
        }
        return [tableOrderIssue(null, { message: 'readerTitle 和公式 2 不得从说明生成修复' })];
    };
    const paper = { arxivId: '2609.99872', title: '无节点离线派发边界' };
    const base = { sourceText: signed.sourceDetails.text, structuredArtifacts: signed.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory, readerMaxAttempts: 2,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed(paper, '', '', { ...base,
        readerCallModel: async () => { calls++; return JSON.stringify(signed.draft); }
    }), error => error.message === noTableOrderTargetMessage);
    assert.equal(calls, 1);
    assert.ok(parserFailures >= 2);
    assert.equal(injectedMetadata, true);
    const beforeResume = storedReaderFailure(directory).payload;
    assert.equal(beforeResume.attempts, 1, 'the paid first request must not roll back to entry attempts=0');
    assert.equal(beforeResume.fullAttempts, 1);
    assert.equal(beforeResume.transportFailures, 0);
    assert.deepEqual(beforeResume.lastContentError, { message: '本轮最新正文错误', code: 'latest-content' });
    assert.equal(beforeResume.lastTransportError, '本轮最新传输错误');
    const stateFields = ['attempts', 'fullAttempts', 'transportFailures', 'noProgress', 'failureSignature',
        'validationFailureSignature', 'validationFailureStreak', 'implementationRepairAllowanceProof',
        'implementationRepairAllowanceLineage', 'consumedImplementationAllowanceSha256',
        'imageEvidence', 'providerImageExclusions', 'readerRecoveryRevisions'];
    for (const key of stateFields) assert.deepEqual(beforeResume[key], latestPayload[key], key);
    await assert.rejects(deep.generateApiReaderArticleDetailed(paper, '', '', { ...base,
        readerCallModel: async () => { calls++; throw new Error('不应到达模型请求'); }
    }), error => error.message === noTableOrderTargetMessage);
    assert.equal(calls, 1);
    const afterResume = storedReaderFailure(directory).payload;
    for (const key of [...stateFields, 'lastContentError', 'lastTransportError']) {
        assert.deepEqual(afterResume[key], beforeResume[key]);
    }
});

test('真实独立标题错误仍取得局部请求，本组参考诊断不阻断原修复派发', async t => {
    const deep = require('../scripts/deep-analyzer.js'), repair = require('../scripts/lib/reader-repair.js');
    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    signed.draft.readerTitle = '短';
    const originalCollector = repair.collectDraftIssues;
    t.after(() => { repair.collectDraftIssues = originalCollector; });
    repair.collectDraftIssues = (draft, error, options) => {
        const real = originalCollector(draft, error, options);
        assert.match(error.message, /读者标题/);
        return [...real, tableOrderIssue(null, { diagnosticOnly: true })];
    };
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2609.99873', title: '独立标题真实派发' }, '', '', {
        sourceText: signed.sourceDetails.text, structuredArtifacts: signed.sourceDetails.structuredArtifacts,
        readerAttemptsDir: temporary(t), readerMaxAttempts: 2, readerRecordDisposition: () => {},
        readerMaterializeFigures: async () => [], readerCallModel: async (_messages, _budget, options) => {
            if (++calls === 1) return JSON.stringify(signed.draft);
            assert.equal(options.usageContext.stage, 'apiReaderRepair');
            throw new Error('独立标题请求已到达');
        }
    }), /独立标题请求已到达/);
    assert.equal(calls, 2);
});

test('普通诊断对象和无效或参考实际 Error 保留原证据，但不能让附带本组子项重新授权', () => {
    const child = tableOrderIssue('/sections/1/body');
    const sourceChild = { path: '/readerTitle', message: 'readerTitle 太短，真实独立节点错误' };
    const object = { path: '/readerTitle', code: tableOrderCode, message: oldTableOrderMessage,
        readerIssues: [child, sourceChild, child], extra: '原字段' };
    const objectIssues = collectDraftIssues(null, object);
    assert.equal(objectIssues[0], object);
    assert.deepEqual(Object.keys(objectIssues[0]), Object.keys(object));
    assert.deepEqual(objectIssues.slice(1), [sourceChild]);
    assert.deepEqual(buildRepairTargets(fixture(), objectIssues).map(target => target.path), ['/readerTitle']);
    const badTyped = Object.assign(new Error(oldTableOrderMessage), {
        path: '/readerTitle', code: tableOrderCode, readerIssues: [child, sourceChild, child]
    });
    const badLegacy = Object.assign(new Error(oldTableOrderMessage), {
        path: '/readerTitle', readerIssues: [child, sourceChild, child]
    });
    const typedReference = Object.assign(new Error(newTableOrderMessage), {
        path: null, code: tableOrderCode, diagnosticOnly: true, readerIssues: [child, sourceChild, child]
    });
    const legacyReference = Object.assign(new Error(oldTableOrderMessage), {
        path: '/sections/1/body', diagnosticOnly: true, readerIssues: [child, sourceChild, child]
    });
    for (const error of [badTyped, badLegacy, typedReference, legacyReference]) {
        const issues = collectDraftIssues(null, error);
        assert.equal(issues[0].readerIssues, error.readerIssues);
        assert.deepEqual(issues.slice(1), [sourceChild]);
        assert.deepEqual(buildRepairTargets(fixture(), issues).map(target => target.path), ['/readerTitle']);
        assert.equal(classifyTableBindingOrderIssue(issues[0]).actionable, false);
    }
    const countConflict = Object.assign(new Error(oldTableOrderMessage), { code: TABLE_COUNT_ISSUE_CODE,
        requiredCount: 4, actualCount: 3, readerIssues: [{ path: null, code: TABLE_COUNT_ISSUE_CODE,
            message: oldTableOrderMessage, requiredCount: 4, actualCount: 3 }] });
    const conflictIssues = collectDraftIssues(null, countConflict);
    assert.equal(conflictIssues.length, 1);
    assert.equal(conflictIssues[0].code, TABLE_COUNT_ISSUE_CODE);
    assert.equal(conflictIssues[0].readerIssues, countConflict.readerIssues);
    assert.equal(classifyTableBindingOrderIssue(conflictIssues[0]).kind, 'code-conflict');
    const context = buildRepairContext(countRepairFixture(), conflictIssues, 'TABLE_1: 原来源');
    assert.deepEqual(context.targets, []);
    assert.equal(context.atomicOperation, null);
});

test('无目标真实续跑保留实际迁移的未用凭证，消耗后也不会恢复旧凭证', async t => {
    const crypto = require('node:crypto'), Config = require('../scripts/config.js');
    const fresh = require('../scripts/lib/fresh-analysis-context.js');
    const revision = require('../scripts/lib/reader-recovery-revision.js');
    const deep = require('../scripts/deep-analyzer.js'), repair = require('../scripts/lib/reader-repair.js');
    const root = temporary(t), previousRoot = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = root;
    t.after(() => { Config.FILES.freshRewriteRunsDir = previousRoot; });
    const runId = crypto.randomUUID(), runDir = path.join(root, runId), paperId = '2609.99874';
    fs.mkdirSync(runDir, { mode: 0o700 });
    const sourceText = 'This offline source describes controlled acoustic observations without numerical claims. '.repeat(
        Math.ceil((Config.ANALYSIS_CONFIG.fullTextMinCharsForFull + 1) / 85) + 1);
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    // 这是一份真实的旧版缓存固定数据，原来的加载器能读它；
    // 它不是新版保存的 HTML/PDF 产物，也不是可发布的来源包。
    const artifactBody = { figures: [], flattenedTextSha256: sha(sourceText), formulas: [],
        parserVersion: 'offline-empty-source-v1', tables: [], version: 1 };
    const artifacts = { ...artifactBody, payloadSha256: sha(JSON.stringify(artifactBody)) };
    const sourceExpectations = { [paperId]: { sourceSha256: sha(sourceText), structuredArtifactsSha256: artifacts.payloadSha256 } };
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ version: 1, contract: 'fresh-rewrite-run-v1',
        runId, paperIds: [paperId], sourceExpectations }), { mode: 0o600 });
    const scope = { runId, runDir, sourceExpectations, refreshReaderDiagnostics: true };
    const draft = withoutSignedTables().draft;
    draft.sections[4].body = draft.sections[4].body.replace('[[FORMULA_1]]', '');
    draft.formulaBindings = [];
    const directory = path.join(runDir, 'reader-attempts'), paper = { arxivId: paperId, title: '实际未用恢复凭证' };
    const originalCollector = repair.collectDraftIssues;
    t.after(() => { repair.collectDraftIssues = originalCollector; });
    repair.collectDraftIssues = (candidate, error, options) => {
        const real = originalCollector(candidate, error, options);
        assert.ok(real.some(issue => issue.code === TABLE_COUNT_ISSUE_CODE));
        assert.equal(candidate.tableBindings.length, 0);
        return [tableOrderIssue()];
    };
    let calls = 0;
    const options = { sourceText, structuredArtifacts: artifacts, readerAttemptsDir: directory,
        readerMaxAttempts: 2, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async () => { calls++; return JSON.stringify(draft); } };
    await fresh.withFreshAnalysisContext(scope, async () => {
        await fresh.fetchFreshSource(paperId, async () => ({ source: 'html', sourceId: paperId, text: sourceText,
            structuredArtifacts: artifacts }));
        await assert.rejects(deep.generateApiReaderArticleDetailed(paper, '', '', options),
            error => error.message === noTableOrderTargetMessage);
        assert.equal(calls, 1);
        const original = storedReaderFailure(directory);
        assert.equal(original.payload.attempts, 1);
        const oldIdentity = { ...original.identity, repairImplementationSha256: '0'.repeat(64) };
        saveFailedCandidate(directory, oldIdentity, original.payload);
        fs.unlinkSync(original.filename); // 只把隔离出来的测试候选移进迁移输入。
        const migrated = revision.loadReaderRecoveryRevision(directory, original.identity);
        const proof = migrated.implementationRepairAllowanceProof;
        assert.match(proof.allowanceSha256, /^[a-f0-9]{64}$/);
        assert.equal(migrated.attempts, 1);
        assert.equal(migrated.fullAttempts, 1);
        assert.ok(fs.existsSync(path.join(directory, migrated.readerRecoveryRevisions[0].archivedName)));
        await assert.rejects(deep.generateApiReaderArticleDetailed(paper, '', '', options),
            error => error.message === noTableOrderTargetMessage);
        const guarded = storedReaderFailure(directory).payload;
        assert.equal(calls, 1);
        assert.deepEqual(guarded.implementationRepairAllowanceProof, proof);
        assert.equal(guarded.attempts, 1);
        assert.equal(guarded.fullAttempts, 1);
        saveFailedCandidate(directory, original.identity, { ...guarded, implementationRepairAllowanceProof: null });
        await assert.rejects(deep.generateApiReaderArticleDetailed(paper, '', '', options),
            error => error.message === noTableOrderTargetMessage);
        const consumed = storedReaderFailure(directory).payload;
        assert.equal(calls, 1);
        assert.equal(consumed.implementationRepairAllowanceProof, null);
        assert.ok(consumed.consumedImplementationAllowanceSha256.includes(proof.allowanceSha256));
        assert.equal(consumed.attempts, 1);
        assert.equal(consumed.fullAttempts, 1);
    });
});

test('真实来源错误和本组参考项共同存在时，生成仍进入原来源修复请求', async t => {
    const deep = require('../scripts/deep-analyzer.js'), repair = require('../scripts/lib/reader-repair.js');
    const signed = require('./reader-signed-draft-fixture.js').fixture({ noFigures: true });
    signed.draft.sections[7].body = signed.draft.sections[7].body.replace('| 1.0 |', '| 9.876 |');
    const originalCollector = repair.collectDraftIssues;
    t.after(() => { repair.collectDraftIssues = originalCollector; });
    repair.collectDraftIssues = (draft, error, options) => {
        const real = originalCollector(draft, error, options);
        assert.ok(real.some(issue => issue.code === 'reader_source_cell_diagnostic'));
        return [...real, tableOrderIssue(null, { diagnosticOnly: true })];
    };
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2609.99875', title: '真实来源错误继续派发' }, '', '', {
        sourceText: signed.sourceDetails.text, structuredArtifacts: signed.sourceDetails.structuredArtifacts,
        readerAttemptsDir: temporary(t), readerMaxAttempts: 2, readerMaterializeFigures: async () => [],
        readerRecordDisposition: () => {}, readerCallModel: async () => {
            if (++calls === 1) return JSON.stringify(signed.draft);
            throw new Error('真实来源修复已到达');
        }
    }), /真实来源修复已到达/);
    assert.equal(calls, 2);
});

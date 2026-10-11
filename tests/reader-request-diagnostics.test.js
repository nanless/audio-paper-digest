const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashDraft } = require('../scripts/lib/reader-repair.js');

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
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-diagnostic-test-'));
    const defaults = require('../scripts/config.js').FILES.apiReaderAttemptsDir;
    const sha = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const snapshot = root => {
        const rows = [];
        const visit = current => {
            if (!fs.existsSync(current)) return;
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink()) { rows.push([path.relative(root, current), 'link', fs.readlinkSync(current)]); return; }
            if (stat.isDirectory()) { rows.push([path.relative(root, current), 'directory']); for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name)); }
            else rows.push([path.relative(root, current), sha(fs.readFileSync(current))]);
        };
        visit(root); return rows;
    };
    const before = snapshot(defaults);
    t.after(() => { try { assert.deepEqual(snapshot(defaults), before, '默认 Reader 运行目录必须保持'); }
        finally { fs.rmSync(directory, { recursive: true, force: true }); } });
    return directory;
}

test('真实修复响应在正文解析前逐字保存，坏补丁也保留', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const draft = fixture(); draft.readerTitle = '短';
    const raw = '{"version":1,"replacements":[}';
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2610.90001', title: '诊断测试' }, 'canonical', '', {
        sourceText: 'source', readerAttemptsDir: directory,
        readerMaterializeFigures: async () => [], readerRecordDisposition() {},
        readerCallModel: async () => {
            calls++;
            if (calls === 1) return JSON.stringify(draft);
            if (calls === 2) return raw;
            throw new Error('本地停止后续请求');
        }
    }), /本地停止后续请求/);
    assert.equal(calls, 3);
    const diagnostics = path.join(directory, 'request-diagnostics');
    const responsePath = fs.readdirSync(diagnostics).find(name => name.endsWith('.response.json'));
    const response = JSON.parse(fs.readFileSync(path.join(diagnostics, responsePath), 'utf8'));
    assert.equal(response.rawResponse, raw);
    const requestPath = path.join(diagnostics, responsePath.replace('.response.json', '.request.json'));
    const requestBytes = fs.readFileSync(requestPath);
    const request = JSON.parse(requestBytes);
    const crypto = require('node:crypto');
    const sha = text => crypto.createHash('sha256').update(text).digest('hex');
    assert.equal(response.requestSha256, sha(requestBytes));
    assert.equal(response.outputTextSha256, sha(raw));
    assert.equal(request.draftSha256, hashDraft(request.draft));
    assert.equal(request.promptSha256, sha(request.prompt));
    assert.ok(request.repairTargets.length > 0);
    assert.equal(fs.statSync(requestPath).mode & 0o777, 0o600);
});
test('诊断写入失败停止正常修复请求且保留原始错误', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    for (const suffix of ['.request.json', '.response.json', 'directory']) {
        const directory = temporary(t);
        const paper = { arxivId: '2610.90002', title: '写入失败' };
        const draft = fixture(); draft.readerTitle = '短';
        const base = { sourceText: 'source', readerAttemptsDir: directory,
            readerMaterializeFigures: async () => [], readerRecordDisposition() {} };
        let initial = 0;
        await assert.rejects(deep.generateApiReaderArticleDetailed(paper, 'canonical', '', {
            ...base, readerCallModel: async () => {
                if (++initial === 1) return JSON.stringify(draft);
                throw new Error('保存初始草稿后停止');
            }
        }), /保存初始草稿后停止/);
        const open = fs.openSync, write = fs.writeFileSync, close = fs.closeSync, sync = fs.fsyncSync;
        const files = new Map();
        const original = Object.assign(new Error('本地诊断写入失败'), { code: 'EIO' });
        let calls = 0;
        try {
            fs.openSync = function(filename, ...args) { const fd = open.call(this, filename, ...args); files.set(fd, String(filename)); return fd; };
            fs.writeFileSync = function(target, ...args) {
                if (files.get(target)?.includes('request-diagnostics') && files.get(target).endsWith(suffix)) throw original;
                return write.call(this, target, ...args);
            };
            fs.fsyncSync = function(fd) { if (suffix === 'directory' && files.get(fd)?.endsWith('request-diagnostics')) throw original; return sync.call(this, fd); };
            await assert.rejects(deep.generateApiReaderArticleDetailed(paper, 'canonical', '', {
                ...base, readerCallModel: async () => { calls++; return JSON.stringify(patchFor(draft, [['/readerTitle', '有效长度的论文导读标题']])); }
            }), error => error.code === 'READER_DIAGNOSTIC_FAILED' && error.scope === 'run'
                && error.retryable === false && error.cause === original);
        } finally { fs.openSync = open; fs.writeFileSync = write; fs.closeSync = close; fs.fsyncSync = sync; }
        assert.equal(calls, suffix === '.response.json' ? 1 : 0);
    }
});
test('有效修复补丁原文与请求完整对应，下一轮使用已修正草稿', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const draft = fixture(); draft.readerTitle = '短';
    const raw = JSON.stringify(patchFor(draft, [['/readerTitle', '从声音输入到执行输出的机制解释']]));
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2610.90003', title: '正常诊断' }, 'canonical', '', {
        sourceText: 'source', readerAttemptsDir: directory,
        readerMaterializeFigures: async () => [], readerRecordDisposition() {},
        readerCallModel: async messages => {
            calls++;
            if (calls === 1) return JSON.stringify(draft);
            if (calls === 2) return raw;
            assert.match(JSON.stringify(messages), /中文字数/);
            throw new Error('有效补丁后正常继续，停止本地请求');
        }
    }), /有效补丁后正常继续/);
    assert.equal(calls, 3);
    const diagnostics = path.join(directory, 'request-diagnostics');
    const response = JSON.parse(fs.readFileSync(path.join(diagnostics, fs.readdirSync(diagnostics).find(name => name.endsWith('.response.json'))), 'utf8'));
    assert.equal(response.rawResponse, raw);
    const requests = fs.readdirSync(diagnostics).filter(name => name.endsWith('.request.json')).map(name => JSON.parse(fs.readFileSync(path.join(diagnostics, name), 'utf8')));
    assert.ok(requests.some(request => request.draft.readerTitle === '从声音输入到执行输出的机制解释'));
});
test('服务方拒图后，诊断保存两次实际输入并将响应绑定最终输入', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const directory = temporary(t);
    const imagePath = path.join(directory, 'figure.png');
    fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=', 'base64'));
    const crypto = require('node:crypto');
    const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const url = 'https://arxiv.org/html/2610.90004/figure.png';
    const draft = fixture(); draft.sections[0].body = '太短 [[FIGURE_1]]';
    draft.figurePlacements.push({ figureOrdinal: 1, marker: '[[FIGURE_1]]', targetKind: 'background', focusPoints: [] });
    let repairs = 0;
    const raw = '{"version":1,"replacements":[}';
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2610.90004', title: '实际拒图' }, 'canonical', `FIGURE_1: 方法图\nFIGURE_1_URL: ${url}`, {
        sourceText: 'source', readerAttemptsDir: directory, readerRecordDisposition() {},
        readerMaterializeFigures: async () => [{ ordinal: 1, url, cachePath: imagePath, assetSha256: sha(fs.readFileSync(imagePath)) }],
        readerCallModel: async (messages, budget, options) => {
            if (options.usageContext.stage === 'apiReaderArticle') return JSON.stringify(draft);
            const hasPixels = JSON.stringify(messages).includes('data:image/');
            if (hasPixels) { const error = new Error('HTTP 400: invalid image data'); error.status = 400; throw error; }
            if (++repairs === 1) return raw;
            throw new Error('拒图后的坏补丁已保存，停止本地请求');
        }
    }), /拒图后的坏补丁已保存/);
    const dir = path.join(directory, 'request-diagnostics');
    const requests = fs.readdirSync(dir).filter(name => name.endsWith('.request.json')).map(name => ({name, bytes:fs.readFileSync(path.join(dir,name)), value:JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))}));
    assert.ok(requests.some(item => item.value.images.length === 1));
    const responses = fs.readdirSync(dir).filter(name => name.endsWith('.response.json')).map(name => JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')));
    assert.equal(responses.length,1);
    const final = requests.find(item => sha(item.bytes) === responses[0].requestSha256);
    assert.ok(final);
    assert.equal(final.value.images.length,0);
    assert.equal(responses[0].rawResponse,raw);
    const before = requests.find(item => item.value.images.length === 1);
    assert.notEqual(before.value.inputMessagesSha256, final.value.inputMessagesSha256);
    assert.notEqual(before.value.visibilityNotice, final.value.visibilityNotice);
});

test('分类诊断缺少 message 时仍保存付费响应和尝试', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const repair = require('../scripts/lib/reader-repair.js');
    const directory = temporary(t);
    const draft = fixture(); draft.readerTitle = '短';
    const raw = '{"version":1,"replacements":[}';
    const collect = repair.collectDraftIssues;
    const classification = { path: null, code: 'reader_classification_only', diagnosticOnly: true };
    // 增加诊断边界故障，原解析器及诊断仍实际执行。
    let collections = 0;
    repair.collectDraftIssues = (...args) => {
        const issues = collect(...args);
        return ++collections === 1 ? issues : [...issues, classification];
    };
    let calls = 0;
    try {
        await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2610.90009', title: '分类诊断' }, 'canonical', '', {
            sourceText: 'source', readerAttemptsDir: directory,
            readerMaterializeFigures: async () => [], readerRecordDisposition() {},
            readerCallModel: async () => {
                calls++;
                if (calls === 1) return JSON.stringify(draft);
                if (calls === 2) return raw;
                const savedName = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
                const saved = JSON.parse(fs.readFileSync(path.join(directory, savedName))).payload;
                assert.ok(saved.issues.some(issue => issue.code === classification.code && issue.message === ''));
                throw new Error('保存完成后受控停止');
            }
        }), /保存完成后受控停止/);
    } finally { repair.collectDraftIssues = collect; }
    assert.equal(calls, 3);
    const name = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const payload = JSON.parse(fs.readFileSync(path.join(directory, name))).payload;
    assert.equal(payload.attempts, 2);
    assert.deepEqual(payload.draft, draft);
    assert.equal(payload.rawDraft, JSON.stringify(draft));
    const diagnostics = path.join(directory, 'request-diagnostics');
    const responseName = fs.readdirSync(diagnostics).find(name => name.endsWith('.response.json'));
    const response = JSON.parse(fs.readFileSync(path.join(diagnostics, responseName)));
    assert.equal(response.rawResponse, raw);
    assert.equal(response.outputTextSha256, require('node:crypto').createHash('sha256').update(raw).digest('hex'));
});

test('未声明图片标记进入下一次局部请求，只授权所在正文', async t => {
    const deep = require('../scripts/deep-analyzer.js');
    const crypto = require('node:crypto');
    const directory = temporary(t);
    const imagePath = path.join(directory, 'offline-pixel.png');
    const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(imagePath, pixels);
    const url = 'https://arxiv.org/html/2610.90008/figure.png';
    const draft = fixture();
    draft.sections[4].body += '\n\n[[FIGURE_2]]';
    const originalDraft = JSON.stringify(draft);
    const stopped = Object.assign(new Error('已截获下一次局部请求'), { retryable: false, scope: 'run' });
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed(
        { arxivId: '2610.90008', title: '未装配图的局部诊断' }, 'canonical',
        `FIGURE_2: 本地测试像素\nFIGURE_2_URL: ${url}`, {
            sourceText: '离线来源', readerAttemptsDir: directory,
            readerMaterializeFigures: async () => [{ ordinal: 2, url, cachePath: imagePath,
                assetSha256: crypto.createHash('sha256').update(pixels).digest('hex') }],
            readerRecordDisposition() {},
            readerCallModel: async (messages, budget, options) => {
                calls++;
                if (calls === 1) {
                    assert.equal(options.usageContext.stage, 'apiReaderArticle');
                    return originalDraft;
                }
                assert.equal(options.usageContext.stage, 'apiReaderRepair');
                assert.match(JSON.stringify(messages), /未声明的图片标记/);
                assert.match(JSON.stringify(messages), /sections\[4\]/);
                const diagnosticDirectory = path.join(directory, 'request-diagnostics');
                const requestFile = fs.readdirSync(diagnosticDirectory).find(name => name.endsWith('.request.json'));
                const request = JSON.parse(fs.readFileSync(path.join(diagnosticDirectory, requestFile)));
                assert.deepEqual(request.repairTargets.map(target => target.path), ['/sections/4/body']);
                assert.match(request.draft.sections[4].body, /\[\[FIGURE_2\]\]/);
                assert.deepEqual(request.draft.figurePlacements, []);
                throw stopped;
            }
        }), /已截获下一次局部请求/);
    assert.equal(calls, 2);
    assert.equal(JSON.stringify(draft), originalDraft);
});

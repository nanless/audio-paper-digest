'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const discovery = require('../scripts/lib/conference-discovery.js');
const filter = require('../scripts/lib/conference-filter.js');
const evidenceApi = require('../scripts/lib/conference-filter-evidence.js');
const ledger = require('../scripts/lib/conference-source-ledger.js');
const runner = require('../scripts/conference-filter-run.js');
const Config = require('../scripts/config.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const { loadLegacyFilter } = require('./helpers/conference-filter-evidence-fixture.js');
const utils = require('../scripts/utils.js');

const filterId = '11111111-1111-4111-8111-111111111111';
const lockToken = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-09-06T00:00:00.000Z';
const evidenceRunId = '55555555-5555-4555-8555-555555555555';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pid = value => paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value });

function chatResponse(text, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
    return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage };
}
function responsesResponse(text) {
    return { status: 'completed', output_text: text,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
}
function truncatedResponsesResponse() {
    return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
        usage: { input_tokens: 10, output_tokens: 1000, total_tokens: 1010,
            output_tokens_details: { reasoning_tokens: 997 } } };
}

async function serverFixture(t, replies = []) {
    const calls = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', async () => {
            const call = { url: request.url, headers: request.headers,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
            calls.push(call);
            const reply = replies.length ? replies.shift() : { body: chatResponse('{"decision":"included","reason":"Audio is primary."}') };
            if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
            response.writeHead(reply.statusCode || 200, { 'content-type': 'application/json' });
            response.end(reply.raw === undefined ? JSON.stringify(reply.body) : reply.raw);
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { calls, endpoint: `http://127.0.0.1:${server.address().port}/v1` };
}

function fixture(t, endpoint, metadata = null, model = 'fixture-filter-model', filterApi = filter) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-filter-runner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dirs = Object.fromEntries(['catalogs', 'reports', 'evidence', 'specs', 'filters']
        .map(name => [name, path.join(root, name)]));
    for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { mode: 0o700 });
    metadata ||= [{ arnumber: '100', title: 'Speech enhancement with diffusion' },
        { arnumber: '200', title: 'Image segmentation only' }];
    const metadataBytes = Buffer.from(JSON.stringify(metadata)); const metadataFile = path.join(root, 'metadata.json');
    fs.writeFileSync(metadataFile, metadataBytes, { mode: 0o600 });
    const pdfCatalog = metadata.map(record => {
        const filename = `${record.title}.pdf`; const bytes = Buffer.from(`%PDF-1.4\n${record.arnumber}\n`);
        fs.writeFileSync(path.join(root, filename), bytes, { mode: 0o600 });
        return { path: filename, sha256: sha(bytes), size: bytes.length };
    }).sort((a, b) => a.path.localeCompare(b.path));
    const pdfByTitle = new Map(pdfCatalog.map(item => [path.basename(item.path, '.pdf'), item]));
    const manifest = { contract: discovery.CONTRACT, version: discovery.VERSION, adapter: 'icassp',
        conference: { id: 'icassp-2026', year: 2026 },
        metadataSnapshot: { file: metadataFile, sha256: sha(metadataBytes), size: metadataBytes.length }, pdfRoot: root,
        pdfCatalogSha256: ledger.stableHash(pdfCatalog), pdfCatalog, members: metadata.map((record, metadataIndex) => ({
            identity: { type: 'icassp-arnumber', value: record.arnumber }, metadataIndex, title: record.title,
            numericAlias: null, match: { kind: 'exact', candidates: [pdfByTitle.get(record.title)] }
        })), memberSetSha256: '' };
    manifest.memberSetSha256 = ledger.memberSetSha256(manifest.members);
    const report = discovery.buildReport(manifest);
    fs.writeFileSync(path.join(dirs.catalogs, 'catalog.json'), discovery.canonicalBytes(manifest), { mode: 0o600 });
    fs.writeFileSync(path.join(dirs.reports, 'report.json'), discovery.canonicalBytes(report), { mode: 0o600 });
    const discoveryHandle = discovery.loadDiscoveryHandle(path.join(dirs.catalogs, 'catalog.json'),
        path.join(dirs.reports, 'report.json'));
    evidenceApi.prepareEvidence({ evidenceRunsRoot: dirs.evidence, runId: evidenceRunId, discoveryHandle,
        apply: true, limit: metadata.length, extract: (itemRoot, { request }) => {
            const text = Buffer.from('Abstract\nThis audio study provides sufficiently detailed experimental evidence and reproducible evaluation for the conference filtering fixture.\nIntroduction\nBody.');
            const artifacts = Buffer.from(`${JSON.stringify({ pages: [{ page: 1, textStart: 0, textEnd: text.length }] }, null, 2)}\n`);
            const receipt = Buffer.from('{"fixture":true}\n');
            fs.writeFileSync(path.join(itemRoot, 'text.txt'), text); fs.writeFileSync(path.join(itemRoot, 'artifacts.json'), artifacts);
            fs.writeFileSync(path.join(itemRoot, 'extraction-receipt.json'), receipt);
            return { paperId: request.paperId, sourceIdentity: request.sourceIdentity, pdf: { sha256: request.source.pdf.sha256 },
                text: { file: 'text.txt', sha256: sha(text) }, artifacts: { file: 'artifacts.json', sha256: sha(artifacts) },
                receipt: { file: 'extraction-receipt.json', fileSha256: sha(receipt), receiptSha256: 'a'.repeat(64) },
                verification: { verificationSha256: 'b'.repeat(64) } };
        } });
    const evidenceHandle = evidenceApi.loadEvidenceHandle({ evidenceRunsRoot: dirs.evidence, runId: evidenceRunId, discoveryHandle });
    const tagCatalogPath = path.join(root, 'tag-catalog.json'); fs.writeFileSync(tagCatalogPath, '{"version":"fixture"}\n', { mode: 0o600 });
    const spec = filterApi.buildProductionSpec({ endpoint, model,
        tagCatalogSha256: sha(fs.readFileSync(tagCatalogPath)), discoveryHandle, evidenceHandle });
    fs.writeFileSync(path.join(dirs.specs, 'spec.json'), `${JSON.stringify(spec)}\n`, { mode: 0o600 });
    filterApi.prepareFilter({ filterRoot: dirs.filters, discoveryHandle, evidenceHandle, spec, filterId, now: stamp });
    const files = { conferenceDiscoveryCatalogDir: dirs.catalogs, conferenceDiscoveryReportDir: dirs.reports,
        conferenceFilterEvidenceRunsDir: dirs.evidence, conferenceFilterSpecsDir: dirs.specs,
        conferenceFiltersDir: dirs.filters, tagCatalogFile: tagCatalogPath,
        llmAccountPoolState: path.join(root, 'account-pool.json') };
    const env = { PAPER_ANALYZER_ENDPOINT: endpoint, PAPER_ANALYZER_API_KEY: 'fixture-key', PAPER_ANALYZER_MODEL: model };
    return { root, dirs, spec, files, env, discoveryHandle, evidenceHandle };
}

function args(extra = []) {
    return ['--apply', '--catalog', 'catalog.json', '--report', 'report.json', '--spec', 'spec.json',
        '--evidence-run', evidenceRunId, '--filter', filterId, '--owner', 'runner.1', ...extra];
}

function onlyJson(directory) {
    const names = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
    assert.equal(names.length, 1); return path.join(directory, names[0]);
}

test('生产 runner 用真实的公共传输，并保留绑定的意图、原始回复和用量', async t => {
    const service = await serverFixture(t, [{ body: chatResponse('{"decision":"included","reason":"Primary contribution is speech enhancement."}') }]);
    const f = fixture(t, service.endpoint);
    const result = await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(result.processed[0].status, 'included'); assert.equal(service.calls.length, 1);
    assert.equal(f.spec.contract, 'conference-filter-spec-v6'); assert.equal(f.spec.version, 6);
    assert.equal(state.contract, 'conference-filter-v6'); assert.equal(state.version, 6);
    assert.equal(state.input.tagCatalogSha256, f.spec.tagCatalogSha256);
    assert.equal(Object.hasOwn(state.input, 'taxonomyRegistrySha256'), false);
    assert.equal(service.calls[0].url, '/v1/chat/completions'); assert.equal(service.calls[0].headers.authorization, 'Bearer fixture-key');
    assert.equal(service.calls[0].body.messages.length, 1);
    assert.equal(service.calls[0].body.messages[0].role, 'user');
    const root = path.join(f.dirs.filters, filterId);
    const intent = JSON.parse(fs.readFileSync(onlyJson(path.join(root, 'llm-intents'))));
    const envelope = JSON.parse(Buffer.from(intent.envelope.data, 'base64'));
    assert.equal(service.calls[0].body.messages[0].content, filter.renderDailyFilterPrompt(envelope));
    assert.doesNotMatch(service.calls[0].body.messages[0].content, /conference-filter-llm-request/);
    assert.equal(envelope.contract, 'conference-filter-llm-request-v3'); assert.equal(envelope.version, 3);
    assert.equal(envelope.filter.tagCatalogSha256, f.spec.tagCatalogSha256);
    assert.equal(Object.hasOwn(envelope.filter, 'taxonomyRegistrySha256'), false);
    assert.equal(envelope.paperId, pid('100')); assert.equal(envelope.metadataRecord.arnumber, '100');
    assert.equal(envelope.discovery.metadataIndex, 0); assert.equal(envelope.sourceSha256, state.decisions[pid('100')].sourceSha256);
    const artifactFile = onlyJson(path.join(root, 'decisions')); const artifact = JSON.parse(fs.readFileSync(artifactFile));
    const receipt = JSON.parse(fs.readFileSync(onlyJson(path.join(root, 'llm-responses'))));
    assert.equal(artifact.request.sha256, intent.request.sha256);
    assert.equal(artifact.transportReceiptSha256, receipt.transportReceiptSha256);
    assert.equal(receipt.usageLedgerBindings.length, 1);
    assert.equal(receipt.usageLedgerBindings[0].persistence, 'unavailable');
    assert.deepEqual(artifact.result.usage, { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    // 完整重新绑定测试副本，确保拒绝来自格式门而非遗漏的对象哈希。
    for (const mutate of [
        copy => { copy.filter.taxonomyRegistrySha256 = copy.filter.tagCatalogSha256; },
        copy => { copy.filter.taxonomyRegistrySha256 = null; },
        copy => { copy.version = 2; },
        copy => { copy.contract = 'conference-filter-llm-request-v2'; },
        copy => { copy.contract = 'conference-filter-llm-request-v4'; }
    ]) {
        const copy = structuredClone(envelope); mutate(copy);
        const requestBody = { ...copy }; delete requestBody.requestSha256;
        copy.requestSha256 = filter.stableHash(requestBody);
        const bytes = Buffer.from(JSON.stringify(copy));
        const changedIntent = { ...intent, requestEnvelopeSha256: copy.requestSha256,
            envelope: { encoding: 'base64', size: bytes.length, sha256: sha(bytes), data: bytes.toString('base64') } };
        const intentBody = { ...changedIntent }; delete intentBody.intentSha256;
        changedIntent.intentSha256 = filter.stableHash(intentBody);
        assert.throws(() => filter.normalizeLlmIntent(changedIntent), /不能混用新旧词表哈希字段|LLM request contract\/version mismatch/);
    }
    const legacy = { ...intent, contract: 'conference-filter-llm-intent-v1', version: 1 }; delete legacy.envelope;
    assert.throws(() => filter.normalizeLlmIntent(legacy), /unknown or missing fields|contract\/version mismatch/);
    assert.equal(filter.runLlmDecision, undefined);
    assert.equal(runner.productionLlmConfig, undefined);
    await assert.rejects(() => runner.main(args(), { files: f.files, env: f.env, transportRequestFn: async () => ({}) }),
        /transport injection is forbidden/);
});

test('正式筛选按数量上限处理一批候选，完整复核一次状态，并保存逐篇状态更新的前后 SHA 对应关系', async t => {
    const service = await serverFixture(t, [
        { body: chatResponse('{"decision":"included","reason":"Speech enhancement is primary."}') },
        { body: chatResponse('{"decision":"excluded","reason":"Audio is incidental."}') },
        { body: chatResponse('{"decision":"included","reason":"Music generation is primary."}') }
    ]);
    const metadata = [
        { arnumber: '100', title: 'Speech enhancement with diffusion' },
        { arnumber: '200', title: 'Audio tagging benchmark' },
        { arnumber: '300', title: 'Music generation with transformers' }
    ];
    const f = fixture(t, service.endpoint, metadata);
    const stateFile = path.join(f.dirs.filters, filterId, 'state.json');
    const originalOpen = fs.openSync; let stateReads = 0;
    fs.openSync = function (filename, flags, ...rest) {
        if (filename === stateFile && (flags & fs.constants.O_RDONLY) === fs.constants.O_RDONLY) stateReads += 1;
        return originalOpen.call(this, filename, flags, ...rest);
    };
    let result;
    try { result = await runner.main(args(['--limit', '3']), { files: f.files, env: f.env }); }
    finally { fs.openSync = originalOpen; }
    assert.equal(result.processed.length, 3); assert.equal(service.calls.length, 3);
    assert.equal(stateReads, 1, '每次执行筛选程序只读取一次状态文件，复核状态、历史记录和生成文件的对应关系');
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(state.completion.status, 'complete');
    assert.equal(state.attempts.length, 3);
    for (let index = 0; index < state.attempts.length; index += 1) {
        const attempt = state.attempts[index];
        assert.equal(attempt.priorStateSha256,
            index === 0 ? attempt.patch.expectedStateSha256 : state.attempts[index - 1].nextStateSha256);
        assert.equal(attempt.nextStateSha256,
            index === state.attempts.length - 1 ? state.stateSha256 : state.attempts[index + 1].priorStateSha256);
    }
    assert.equal(fs.readdirSync(path.join(f.dirs.filters, filterId, 'llm-intents')).length, 3);
    assert.equal(fs.readdirSync(path.join(f.dirs.filters, filterId, 'llm-responses')).length, 3);
    const noWork = await runner.main(args(['--limit', '3']), { files: f.files, env: {} });
    assert.deepEqual(noWork.processed, [], '筛选已完成且没有待处理论文时，不读取模型凭证');
});

test('保存的 OpenAI Responses 请求使用与日更相同的单条用户提示', async t => {
    const service = await serverFixture(t, [{ body: responsesResponse('理由：语音增强是核心任务。\n结论：相关') }]);
    const f = fixture(t, `${service.endpoint}/responses`, null, 'fixture-filter-model');
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const intent = JSON.parse(fs.readFileSync(onlyJson(path.join(f.dirs.filters, filterId, 'llm-intents'))));
    const body = JSON.parse(Buffer.from(intent.request.data, 'base64'));
    assert.equal(body.input.length, 1);
    assert.equal(body.input[0].role, 'user');
    assert.match(body.input[0].content[0].text, /论文标题：Speech enhancement with diffusion/);
    assert.doesNotMatch(body.input[0].content[0].text, /conference-filter-llm-request/);
});

test('保存的 OpenAI Responses 重试请求沿用日更的 4096 token 下限与尝试次数上限', async t => {
    const service = await serverFixture(t, [
        { body: truncatedResponsesResponse() },
        { body: truncatedResponsesResponse() },
        { body: truncatedResponsesResponse() },
        { body: responsesResponse('理由：语音增强是核心任务。\n结论：相关') }
    ]);
    const f = fixture(t, `${service.endpoint}/responses`,
        [{ arnumber: '100', title: 'Speech enhancement with diffusion' }], 'fixture-filter-model');
    const previousBackoff = Config.FILTER_CONFIG.conferenceRetryBackoffMs;
    Config.FILTER_CONFIG.conferenceRetryBackoffMs = 0;
    try {
        await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await runner.main(args(['--limit', '1', '--retry-failed']), { files: f.files, env: f.env });
        }
    } finally { Config.FILTER_CONFIG.conferenceRetryBackoffMs = previousBackoff; }
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.deepEqual(service.calls.map(call => call.body.max_output_tokens), [1000, 4096, 4096, 4096]);
    assert.equal(state.decisions[pid('100')].status, 'included', state.decisions[pid('100')].reason);
    assert.equal(state.attempts.filter(attempt => attempt.paperId === pid('100')).length, 4);
});

test('模型响应只给出部分用量时，保存失败记录及已知用量', async t => {
    const service = await serverFixture(t, [{ body: chatResponse('{"decision":"included","reason":"Audio."}',
        { prompt_tokens: 5, completion_tokens: 2 }) }]);
    const f = fixture(t, service.endpoint);
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(state.decisions[pid('100')].status, 'failed');
    assert.equal(state.decisions[pid('100')].reason, 'LLM_USAGE_PARTIAL_OR_UNAVAILABLE');
    assert.deepEqual(state.decisions[pid('100')].usage,
        { requests: 1, inputTokens: 5, outputTokens: 2, totalTokens: null });
});

test('此前的传输用量拿不到时，显式重试仍然可以收尾', async t => {
    const service = await serverFixture(t, [{ raw: 'not-json' },
        { body: chatResponse('{"decision":"included","reason":"Audio is primary."}') }]);
    const f = fixture(t, service.endpoint, [{ arnumber: '100', title: 'Speech enhancement' }]);
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const previous = Config.FILTER_CONFIG.conferenceRetryBackoffMs;
    Config.FILTER_CONFIG.conferenceRetryBackoffMs = 0;
    try {
        await runner.main(args(['--limit', '1', '--retry-failed']), { files: f.files, env: f.env });
    } finally { Config.FILTER_CONFIG.conferenceRetryBackoffMs = previous; }
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(service.calls.length, 2); assert.equal(state.decisions[pid('100')].status, 'included');
    assert.deepEqual(state.decisions[pid('100')].usage,
        { requests: 2, inputTokens: null, outputTokens: null, totalTokens: null });
});

test('待处理论文排在失败重试之前，失败的工作必须显式且有限地重试', async t => {
    const service = await serverFixture(t, [
        { body: chatResponse('not-json') },
        { body: chatResponse('{"decision":"excluded","reason":"Not an audio contribution."}') }
    ]);
    const f = fixture(t, service.endpoint);
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(state.decisions[pid('100')].status, 'failed');
    assert.equal(state.decisions[pid('200')].status, 'excluded'); assert.equal(service.calls.length, 2);
    await runner.main(args(), { files: f.files, env: f.env });
    assert.equal(service.calls.length, 2);
    assert.equal(filter.selectNextCandidate(state, { retryFailed: false, retryBackoffMs: 0 }), null);
    assert.equal(filter.selectNextCandidate(state, { retryFailed: true, retryBackoffMs: 0 }), pid('100'));
    assert.equal(filter.selectNextCandidate(state, { retryFailed: true, maxAttempts: 1, retryBackoffMs: 0 }), null);
    assert.equal(filter.selectNextCandidate(state, { retryFailed: true, retryBackoffMs: Number.MAX_SAFE_INTEGER }), null);
});

test('请求之后崩溃，恢复时不会产生第二次计费调用', async t => {
    await t.test('传输凭证缺失会变成带类型的不可得证据', async t => {
        const service = await serverFixture(t); const f = fixture(t, service.endpoint);
        const original = fs.openSync; let injected = false;
        fs.openSync = function (filename, ...rest) {
            if (!injected && String(filename).includes('/llm-responses/')) { injected = true; const error = new Error('EIO'); error.code = 'EIO'; throw error; }
            return original.call(this, filename, ...rest);
        };
        try { await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /EIO/); }
        finally { fs.openSync = original; }
        await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
        const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
        assert.equal(service.calls.length, 1); assert.equal(state.decisions[pid('100')].status, 'failed');
        assert.match(state.decisions[pid('100')].reason, /^LLM_TRANSPORT_UNAVAILABLE:INTERRUPTED_/);
    });
    await t.test('筛选决定文件保存失败后，复用已保存的回复', async t => {
        const service = await serverFixture(t); const f = fixture(t, service.endpoint);
        const original = fs.openSync; let injected = false;
        fs.openSync = function (filename, ...rest) {
            if (!injected && String(filename).includes('/decisions/llm-')) { injected = true; const error = new Error('EIO'); error.code = 'EIO'; throw error; }
            return original.call(this, filename, ...rest);
        };
        try { await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /EIO/); }
        finally { fs.openSync = original; }
        await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
        assert.equal(service.calls.length, 1);
        assert.equal(filter.readFilter({ filterRoot: f.dirs.filters, filterId }).decisions[pid('100')].status, 'included');
    });
    await t.test('状态文件保存失败后，直接应用已保存的筛选决定', async t => {
        const service = await serverFixture(t); const f = fixture(t, service.endpoint);
        const original = fs.renameSync; let injected = false;
        fs.renameSync = function (source, target) {
            if (!injected && String(target).endsWith('/state.json')) { injected = true; const error = new Error('EIO'); error.code = 'EIO'; throw error; }
            return original.call(this, source, target);
        };
        try { await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /EIO/); }
        finally { fs.renameSync = original; }
        await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
        assert.equal(service.calls.length, 1);
        assert.equal(filter.readFilter({ filterRoot: f.dirs.filters, filterId }).decisions[pid('100')].status, 'included');
    });
});

test('并发的活跃 runner 不能抢跑一次已付费请求', async t => {
    const service = await serverFixture(t, [{ delayMs: 100,
        body: chatResponse('{"decision":"included","reason":"Audio is primary."}') }]);
    const f = fixture(t, service.endpoint);
    const first = runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /locked by a live process/);
    await first; assert.equal(service.calls.length, 1);
});

test('请求端点不符或已保存的来源元数据被改动时，拒绝继续请求', async t => {
    const service = await serverFixture(t); const other = await serverFixture(t); const f = fixture(t, service.endpoint);
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files,
        env: { ...f.env, PAPER_ANALYZER_ENDPOINT: other.endpoint } }), /endpoint differs/);
    assert.equal(service.calls.length + other.calls.length, 0);
    const original = fs.openSync; let injected = false;
    fs.openSync = function (filename, ...rest) {
        if (!injected && String(filename).includes('/decisions/llm-')) { injected = true; const error = new Error('EIO'); error.code = 'EIO'; throw error; }
        return original.call(this, filename, ...rest);
    };
    try { await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /EIO/); }
    finally { fs.openSync = original; }
    const intentFile = onlyJson(path.join(f.dirs.filters, filterId, 'llm-intents'));
    const intent = JSON.parse(fs.readFileSync(intentFile)); const request = JSON.parse(Buffer.from(intent.request.data, 'base64'));
    const envelope = JSON.parse(Buffer.from(intent.envelope.data, 'base64')); envelope.metadataRecord.title = 'tampered';
    envelope.discovery.metadataRecordSha256 = filter.stableHash(envelope.metadataRecord);
    const envelopeBody = { ...envelope }; delete envelopeBody.requestSha256; envelope.requestSha256 = filter.stableHash(envelopeBody);
    const envelopeBytes = Buffer.from(JSON.stringify(envelope));
    intent.envelope = { encoding: 'base64', size: envelopeBytes.length, sha256: sha(envelopeBytes), data: envelopeBytes.toString('base64') };
    request.messages[0].content = filter.renderDailyFilterPrompt(envelope);
    const requestBytes = Buffer.from(JSON.stringify(request));
    intent.request = { encoding: 'base64', size: requestBytes.length, sha256: sha(requestBytes), data: requestBytes.toString('base64') };
    intent.requestEnvelopeSha256 = envelope.requestSha256; const intentBody = { ...intent }; delete intentBody.intentSha256;
    intent.intentSha256 = filter.stableHash(intentBody); fs.writeFileSync(intentFile, `${JSON.stringify(intent, null, 2)}\n`);
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }),
        /source metadata|effective metadata record/);
    assert.equal(service.calls.length, 1);
});

test('换提示词版本后，按 v1 prompt SHA 准备的旧 spec 仍然可用', async t => {
    const service = await serverFixture(t);
    const f = fixture(t, service.endpoint);
    const legacyFilterId = '33333333-3333-4333-8333-333333333333';
    const legacyPromptSha256 = filter.LEGACY_LLM_FILTER_PROMPT_SHA256_LIST[0];
    const legacySpec = { ...f.spec, promptSha256: legacyPromptSha256 };
    fs.writeFileSync(path.join(f.dirs.specs, 'spec-legacy.json'), `${JSON.stringify(legacySpec)}\n`, { mode: 0o600 });
    filter.prepareFilter({ filterRoot: f.dirs.filters, discoveryHandle: f.discoveryHandle,
        evidenceHandle: f.evidenceHandle, spec: legacySpec, filterId: legacyFilterId, now: stamp });
    const legacyArgs = args(['--limit', '1']).map(value => value === filterId ? legacyFilterId
        : value === 'spec.json' ? 'spec-legacy.json' : value);
    const result = await runner.main(legacyArgs, { files: f.files, env: f.env });
    assert.equal(result.processed[0].status, 'included');
    assert.equal(service.calls.length, 1);
    // 新请求必须用 v2 正文：只有 v2 写「则要结合标题和摘要判断」，v1 写「则须结合标题与摘要判断」。
    assert.match(service.calls[0].body.messages[0].content, /则要结合标题和摘要判断/);
    assert.doesNotMatch(service.calls[0].body.messages[0].content, /则须结合标题与摘要判断/);
});

test('没有登记的 prompt SHA 仍在传输之前被拒绝', async t => {
    const service = await serverFixture(t);
    const f = fixture(t, service.endpoint);
    const bogusFilterId = '44444444-4444-4444-8444-444444444444';
    const bogusSpec = { ...f.spec, promptSha256: '0'.repeat(64) };
    fs.writeFileSync(path.join(f.dirs.specs, 'spec-bogus.json'), `${JSON.stringify(bogusSpec)}\n`, { mode: 0o600 });
    filter.prepareFilter({ filterRoot: f.dirs.filters, discoveryHandle: f.discoveryHandle,
        evidenceHandle: f.evidenceHandle, spec: bogusSpec, filterId: bogusFilterId, now: stamp });
    const bogusArgs = args(['--limit', '1']).map(value => value === filterId ? bogusFilterId
        : value === 'spec.json' ? 'spec-bogus.json' : value);
    await assert.rejects(() => runner.main(bogusArgs, { files: f.files, env: f.env }),
        /does not bind built-in production policy and prompt/);
    assert.equal(service.calls.length, 0);
});

test('换提示词版本后，v1 正文写下的持久意图仍能恢复', async t => {
    const service = await serverFixture(t);
    const f = fixture(t, service.endpoint);
    const original = fs.openSync; let injected = false;
    fs.openSync = function (filename, ...rest) {
        if (!injected && String(filename).includes('/decisions/llm-')) {
            injected = true; const error = new Error('EIO'); error.code = 'EIO'; throw error;
        }
        return original.call(this, filename, ...rest);
    };
    try { await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /EIO/); }
    finally { fs.openSync = original; }
    const intentFile = onlyJson(path.join(f.dirs.filters, filterId, 'llm-intents'));
    const intent = JSON.parse(fs.readFileSync(intentFile));
    const request = JSON.parse(Buffer.from(intent.request.data, 'base64'));
    const envelope = JSON.parse(Buffer.from(intent.envelope.data, 'base64'));
    // 把持久意图里的请求正文换回 v1 渲染结果，模拟升级之前中断的那次运行。
    request.messages[0].content = filter.renderFrozenDailyFilterPrompt(envelope);
    const requestBytes = Buffer.from(JSON.stringify(request));
    intent.request = { encoding: 'base64', size: requestBytes.length,
        sha256: sha(requestBytes), data: requestBytes.toString('base64') };
    const intentBody = { ...intent }; delete intentBody.intentSha256;
    intent.intentSha256 = filter.stableHash(intentBody);
    fs.writeFileSync(intentFile, `${JSON.stringify(intent, null, 2)}\n`);
    // 保存的传输凭证对应旧 intent SHA；这里也更新它，使恢复测试能继续检查修改后的请求。
    const receiptFile = onlyJson(path.join(f.dirs.filters, filterId, 'llm-responses'));
    const receipt = JSON.parse(fs.readFileSync(receiptFile));
    receipt.intentSha256 = intent.intentSha256;
    const receiptBody = { ...receipt }; delete receiptBody.transportReceiptSha256;
    receipt.transportReceiptSha256 = filter.stableHash(receiptBody);
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    const result = await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    assert.equal(result.processed[0].status, 'included');
});

test('锁回收对存活持有者一律拒绝，对已死且过期的持有者则安全回收', async t => {
    const service = await serverFixture(t); const f = fixture(t, service.endpoint);
    const directory = path.join(f.dirs.filters, filterId); const lock = path.join(directory, 'operation.lock');
    function writeLock(processId) {
        fs.mkdirSync(lock, { mode: 0o700 });
        const body = { contract: filter.LOCK_OWNER_CONTRACT, version: filter.LOCK_OWNER_VERSION, owner: 'fixture.lock', pid: processId,
            hostname: os.hostname(), token: lockToken, startedAt: stamp, heartbeatAt: stamp, leaseMs: filter.LOCK_STALE_MS };
        const record = { ...body, ownerSha256: filter.stableHash(body) };
        fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        const old = new Date(Date.now() - filter.LOCK_STALE_MS - 60_000);
        fs.utimesSync(path.join(lock, 'owner.json'), old, old); fs.utimesSync(lock, old, old);
    }
    writeLock(process.pid);
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /locked by a live process/);
    fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
    fs.symlinkSync(f.root, lock);
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /unsafe|canonical/);
    fs.unlinkSync(lock);
    writeLock(99999999);
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    assert.equal(service.calls.length, 1);
});

test('过大的请求在传输之前就被拒绝，来源返回的坏字节不会抄进理由', async t => {
    await t.test('过大的元数据', async t => {
        const service = await serverFixture(t); const huge = 'x'.repeat(filter.MAX_LLM_REQUEST_BYTES + 1024);
        const f = fixture(t, service.endpoint, [{ arnumber: '100', title: 'Speech', supplemental: huge }]);
        await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /durable evidence limit/);
        assert.equal(service.calls.length, 0);
    });
    await t.test('格式错误的原始回复', async t => {
        const service = await serverFixture(t, [{ raw: 'provider-secret-fragment:not-json' }]); const f = fixture(t, service.endpoint);
        await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
        const decision = filter.readFilter({ filterRoot: f.dirs.filters, filterId }).decisions[pid('100')];
        assert.equal(decision.status, 'failed'); assert.doesNotMatch(decision.reason, /provider-secret-fragment/);
    });
});

test('runner 命令行解析器拒绝不安全或有歧义的重试控制项', () => {
    assert.throws(() => runner.parseArgs(['--apply', '--catalog', '../x.json']), /safe|Missing|Use/);
    assert.throws(() => runner.parseArgs(['--dry-run', '--catalog', 'x.json']), /must be --apply/);
    assert.throws(() => runner.parseArgs([...args(), '--retry-failed', '--retry-failed']), /Use/);
    assert.equal(runner.parseArgs([...args(), '--retry-failed']).retryFailed, true);
    assert.throws(() => filter.parseLlmDecisionText('{"decision":"included","reason":"x","extra":1}'), /unknown or missing/);
    assert.throws(() => filter.parseLlmDecisionText('```json\n{}\n```'), /strict JSON/);
});


// 配置仅供原生成器的离线替身使用，不向任何模型服务发请求。
function legacyLlmConfig(f) {
    const endpoint = f.env.PAPER_ANALYZER_ENDPOINT, model = f.env.PAPER_ANALYZER_MODEL;
    const apiType = utils.detectApiType(endpoint, model);
    return { endpoint, model, apiType, apiUrl: utils.buildApiUrl(apiType, endpoint),
        apiKeys: ['fixture-key'], headers: utils.buildHeaders(apiType, 'fixture-key', ''),
        accountPoolStateFile: f.files.llmAccountPoolState, timeoutMs: Config.FILTER_CONFIG.timeoutMs,
        maxTokens: Config.FILTER_CONFIG.maxTokens, maxResponseBytes: Config.FILTER_CONFIG.conferenceMaxResponseBytes,
        temperature: Config.FILTER_CONFIG.temperature };
}
function mockLegacyFilter(calls) {
    return loadLegacyFilter(async (...request) => {
        calls.push(request);
        const body = chatResponse('{"decision":"included","reason":"Offline fixture: speech is primary."}');
        return { statusCode: 200, body, raw: JSON.stringify(body) };
    });
}

test('原 v5 生成器的已保存响应在同 UUID 恢复，不重复请求且不改写原证明', async t => {
    const service = await serverFixture(t); const originalCalls = [];
    const legacy = mockLegacyFilter(originalCalls);
    const f = fixture(t, service.endpoint, null, 'fixture-filter-model', legacy);
    const stateFile = path.join(f.dirs.filters, filterId, 'state.json');
    const specFile = path.join(f.dirs.specs, 'spec.json'); const originalSpecBytes = fs.readFileSync(specFile);
    const initialState = fs.readFileSync(stateFile); assert.equal(JSON.parse(initialState).version, 5);
    assert.deepEqual(filter.prepareFilter({ filterRoot: f.dirs.filters, filterId,
        discoveryHandle: f.discoveryHandle, evidenceHandle: f.evidenceHandle, spec: f.spec, now: stamp }), JSON.parse(initialState));
    assert.deepEqual(fs.readFileSync(stateFile), initialState);
    assert.throws(() => filter.writeFilterSpec({ specRoot: f.dirs.specs, specName: 'new-legacy.json', spec: f.spec }),
        /新筛选配置必须使用当前记录格式/);
    assert.equal(fs.existsSync(path.join(f.dirs.specs, 'new-legacy.json')), false);
    const freshId = '33333333-3333-4333-8333-333333333333';
    assert.throws(() => filter.prepareFilter({ filterRoot: f.dirs.filters, filterId: freshId,
        discoveryHandle: f.discoveryHandle, evidenceHandle: f.evidenceHandle, spec: f.spec, now: stamp }), /ENOENT/);
    assert.equal(fs.existsSync(path.join(f.dirs.filters, freshId)), false);
    const originalOpen = fs.openSync; let interrupted = false;
    fs.openSync = function (filename, ...rest) {
        if (!interrupted && String(filename).includes('/decisions/llm-')) {
            interrupted = true; const error = new Error('fixture legacy artifact interrupted'); error.code = 'EIO'; throw error;
        }
        return originalOpen.call(this, filename, ...rest);
    };
    try {
        await assert.rejects(() => legacy.advanceProductionLlmDecisions({ filterRoot: f.dirs.filters, filterId,
            discoveryHandle: f.discoveryHandle, evidenceHandle: f.evidenceHandle, spec: f.spec,
            owner: 'legacy.capture', llm: legacyLlmConfig(f), limit: 1 }), /legacy artifact interrupted/);
    } finally { fs.openSync = originalOpen; }
    assert.equal(originalCalls.length, 1); assert.deepEqual(fs.readFileSync(stateFile), initialState);
    const intentFile = onlyJson(path.join(f.dirs.filters, filterId, 'llm-intents'));
    const responseFile = onlyJson(path.join(f.dirs.filters, filterId, 'llm-responses'));
    const intentBytes = fs.readFileSync(intentFile), responseBytes = fs.readFileSync(responseFile);
    const intent = JSON.parse(intentBytes), envelope = JSON.parse(Buffer.from(intent.envelope.data, 'base64'));
    assert.equal(f.spec.contract, 'conference-filter-spec-v5'); assert.equal(f.spec.version, 5);
    assert.equal(envelope.contract, 'conference-filter-llm-request-v2'); assert.equal(envelope.version, 2);
    assert.equal(envelope.filter.taxonomyRegistrySha256, f.spec.taxonomyRegistrySha256);
    assert.equal(Object.hasOwn(envelope.filter, 'tagCatalogSha256'), false);
    assert.equal(sha(Buffer.from(intent.envelope.data, 'base64')), intent.envelope.sha256);
    const envelopeBody = { ...envelope }; delete envelopeBody.requestSha256;
    assert.equal(filter.stableHash(envelopeBody), envelope.requestSha256);
    const result = await runner.main(args(['--limit', '2']), { files: f.files, env: f.env });
    const restoredState = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(result.processed.length, 2); assert.equal(service.calls.length, 1);
    assert.equal(originalCalls.length, 1, '原替身请求只发生一次，恢复已保存响应不再请求');
    assert.equal(restoredState.contract, 'conference-filter-v5'); assert.equal(restoredState.version, 5);
    assert.equal(restoredState.filterId, filterId); assert.equal(restoredState.completion.status, 'complete');
    assert.deepEqual(fs.readFileSync(specFile), originalSpecBytes);
    assert.deepEqual(fs.readFileSync(intentFile), intentBytes); assert.deepEqual(fs.readFileSync(responseFile), responseBytes);
    const handle = filter.loadSelectionHandle(f.dirs.filters, filterId, f.discoveryHandle);
    assert.equal(filter.selectionHandleSnapshot(handle).version, 5);
    const completedStateBytes = fs.readFileSync(stateFile);
    assert.deepEqual((await runner.main(args(), { files: f.files, env: {} })).processed, []);
    assert.deepEqual(fs.readFileSync(stateFile), completedStateBytes); assert.equal(service.calls.length, 1);
    const artifactFile = path.join(f.dirs.filters, filterId, 'decisions', restoredState.attempts[0].decisionArtifactName);
    const artifactBytes = fs.readFileSync(artifactFile);
    fs.writeFileSync(artifactFile, Buffer.concat([artifactBytes, Buffer.from(' ')]));
    assert.throws(() => filter.readFilter({ filterRoot: f.dirs.filters, filterId }), /decision artifact replay drifted/);
});

test('原 v5 未完成 intent 无响应时保留未知结果，不重复请求', async t => {
    const service = await serverFixture(t);
    const originalCalls = [], legacy = mockLegacyFilter(originalCalls);
    const f = fixture(t, service.endpoint, [{ arnumber: '100', title: 'Speech enhancement' }],
        'fixture-filter-model', legacy);
    const originalOpen = fs.openSync; let interrupted = false;
    fs.openSync = function (filename, ...rest) {
        if (!interrupted && String(filename).includes('/llm-responses/')) {
            interrupted = true; const error = new Error('fixture legacy response interrupted'); error.code = 'EIO'; throw error;
        }
        return originalOpen.call(this, filename, ...rest);
    };
    try {
        await assert.rejects(() => legacy.advanceProductionLlmDecisions({ filterRoot: f.dirs.filters, filterId,
            discoveryHandle: f.discoveryHandle, evidenceHandle: f.evidenceHandle, spec: f.spec,
            owner: 'legacy.capture', llm: legacyLlmConfig(f), limit: 1 }), /legacy response interrupted/);
    } finally { fs.openSync = originalOpen; }
    const intentFile = onlyJson(path.join(f.dirs.filters, filterId, 'llm-intents'));
    const intentBytes = fs.readFileSync(intentFile);
    const result = await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const restoredState = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(originalCalls.length, 1); assert.equal(service.calls.length, 0);
    assert.equal(restoredState.version, 5);
    assert.equal(restoredState.decisions[pid('100')].status, 'failed');
    assert.match(restoredState.decisions[pid('100')].reason, /^LLM_TRANSPORT_UNAVAILABLE:INTERRUPTED_/);
    assert.deepEqual(fs.readFileSync(intentFile), intentBytes);
});

test('认证失败时先保存失败记录，再停止批量筛选，其余候选保持待处理', async t => {
    const service = await serverFixture(t, [{ statusCode: 401, body: { error: { message: 'invalid key' } } }]);
    const f = fixture(t, service.endpoint);
    await assert.rejects(() => runner.main(args(), { files: f.files, env: f.env }),
        error => error.scope === 'run' && error.code === 'LLM_ACCOUNT_AUTH_ERROR' && error.retryable === false);
    assert.equal(service.calls.length, 1);
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(state.decisions[pid('100')].status, 'failed');
    assert.equal(state.decisions[pid('200')].status, 'pending');
    assert.equal(state.attempts.length, 1);
    const directory = path.join(f.dirs.filters, filterId);
    assert.equal(fs.existsSync(path.join(directory, 'operation.lock')), false);
    const receipt = JSON.parse(fs.readFileSync(onlyJson(path.join(directory, 'llm-responses'))));
    assert.equal(receipt.statusCode, 401);
    assert.equal(receipt.usage.requests, 1);
});

test('公共封装的运行级配置异常保留原始诊断并停止派发', async t => {
    const service = await serverFixture(t); const f = fixture(t, service.endpoint);
    const env = { ...f.env, PAPER_ANALYZER_FALLBACK_API_KEYS: 'second-fixture-key' };
    await assert.rejects(() => runner.main(args(), { files: f.files, env }), error => {
        assert.equal(error.code, 'LLM_ACCOUNT_POOL_CONFIG_ERROR');
        assert.equal(error.scope, 'run'); assert.equal(error.category, 'config');
        assert.equal(error.retryable, false);
        assert.match(error.message, /备用 API key 只允许用于 OpenCode Go/);
        return true;
    });
    assert.equal(service.calls.length, 0);
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(state.decisions[pid('100')].reason, 'LLM_TRANSPORT_UNAVAILABLE:LLM_ACCOUNT_POOL_CONFIG_ERROR');
    assert.equal(state.decisions[pid('200')].status, 'pending');
    assert.equal(state.attempts.length, 1);
});

test('单篇输出格式失败不阻止后续候选', async t => {
    const service = await serverFixture(t, [{ body: chatResponse('not a decision') }]);
    const f = fixture(t, service.endpoint);
    await runner.main(args(), { files: f.files, env: f.env });
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(service.calls.length, 2);
    assert.equal(state.decisions[pid('100')].reason, 'LLM_RESPONSE_INVALID');
    assert.equal(state.decisions[pid('200')].status, 'included');
});

for (const interruptedStage of ['receipt', 'decision']) {
    for (const entry of ['batch', 'single']) {
        test(`运行级故障在 ${interruptedStage} 后中断，${entry} 恢复保存失败并停止`, async t => {
            const service = await serverFixture(t); const f = fixture(t, service.endpoint);
            const env = { ...f.env, PAPER_ANALYZER_FALLBACK_API_KEYS: 'second-fixture-key' };
            const originalOpen = fs.openSync; const originalRename = fs.renameSync; let interrupted = false;
            fs.openSync = function (filename, ...rest) {
                if (interruptedStage === 'receipt' && !interrupted && String(filename).includes('/decisions/llm-')) {
                    interrupted = true; throw new Error('测试：决定写入中断');
                }
                return originalOpen.call(this, filename, ...rest);
            };
            fs.renameSync = function (source, target) {
                if (interruptedStage === 'decision' && !interrupted && String(target).endsWith('/state.json')) {
                    interrupted = true; throw new Error('测试：状态写入中断');
                }
                return originalRename.call(this, source, target);
            };
            try { await assert.rejects(() => runner.main(args(), { files: f.files, env }), /写入中断/); }
            finally { fs.openSync = originalOpen; fs.renameSync = originalRename; }
            assert.equal(interrupted, true);
            const receiptFile = onlyJson(path.join(f.dirs.filters, filterId, 'llm-responses'));
            const receiptBytes = fs.readFileSync(receiptFile);
            const resume = entry === 'batch' ? () => runner.main(args(), { files: f.files, env: f.env })
                : () => filter.advanceProductionLlmDecision({ filterRoot: f.dirs.filters, filterId,
                    discoveryHandle: f.discoveryHandle, evidenceHandle: f.evidenceHandle, spec: f.spec,
                    paperId: pid('100'), owner: 'resume.fixture', llm: legacyLlmConfig(f) });
            await assert.rejects(resume, error => error.scope === 'run' && error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR');
            assert.deepEqual(fs.readFileSync(receiptFile), receiptBytes);
            assert.equal(service.calls.length, 0);
            const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
            assert.equal(state.decisions[pid('100')].status, 'failed');
            assert.equal(state.decisions[pid('200')].status, 'pending');
            assert.equal(state.attempts.length, 1);
            assert.equal(fs.existsSync(path.join(f.dirs.filters, filterId, 'operation.lock')), false);
        });
    }
}

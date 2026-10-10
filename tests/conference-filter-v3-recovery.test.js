'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const discovery = require('../scripts/lib/conference-discovery.js');
const versions = require('../scripts/lib/prompt-text-versions');
const currentPromptPath = versions.LLM_FILTER_PROMPT_PATH;
versions.LLM_FILTER_PROMPT_PATH = 'prompts/filter-v3.md';
const filter = require('../scripts/lib/conference-filter.js');
const evidenceApi = require('../scripts/lib/conference-filter-evidence.js');
const ledger = require('../scripts/lib/conference-source-ledger.js');
const runner = require('../scripts/conference-filter-run.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const utils = require('../scripts/utils.js');

const filterId = '11111111-1111-4111-8111-111111111111';
const stamp = '2026-09-06T00:00:00.000Z';
const evidenceRunId = '55555555-5555-4555-8555-555555555555';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');


function chatResponse(text, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
    return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage };
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


test('旧 v3 会议请求仍按原提示词核验，重算自校验也不能接受篡改正文或来源', async t => {
    const service = await serverFixture(t);
    const fixtureData = fixture(t, service.endpoint);
    const originalOpen = fs.openSync;
    let interrupted = false;
    fs.openSync = function(filename, ...rest) {
        if (!interrupted && String(filename).includes('/decisions/llm-')) {
            interrupted = true;
            throw Object.assign(new Error('本地保存决定中断'), { code: 'EIO' });
        }
        return originalOpen.call(this, filename, ...rest);
    };
    try {
        await assert.rejects(runner.main(args(['--limit', '1']), {
            files: fixtureData.files, env: fixtureData.env
        }), /本地保存决定中断/);
    } finally { fs.openSync = originalOpen; }
    assert.equal(interrupted, true);
    assert.equal(service.calls.length, 1);
    const intentFile = onlyJson(path.join(fixtureData.dirs.filters, filterId, 'llm-intents'));
    const originalIntentBytes = fs.readFileSync(intentFile);
    const intent = JSON.parse(originalIntentBytes);
    const envelope = JSON.parse(Buffer.from(intent.envelope.data, 'base64'));
    const oldTemplate = utils.loadPrompt('prompts/filter-v3.md', {
        title: '{title}', abstract: '{abstract}', categories: '{categories}'
    });
    assert.equal(envelope.filter.promptSha256, sha(oldTemplate));
    versions.LLM_FILTER_PROMPT_PATH = currentPromptPath;
    delete require.cache[require.resolve('../scripts/lib/conference-filter.js')];
    const currentApi = require('../scripts/lib/conference-filter.js');
    assert.deepEqual(currentApi.normalizeLlmIntent(intent), intent);
    const beforeState = fs.readFileSync(path.join(fixtureData.dirs.filters, filterId, 'state.json'));
    const checked = currentApi.readFilter({ filterRoot: fixtureData.dirs.filters, filterId });
    assert.equal(checked.filterId, filterId);
    assert.deepEqual(fs.readFileSync(path.join(fixtureData.dirs.filters, filterId, 'state.json')), beforeState);
    assert.deepEqual(fs.readFileSync(intentFile), originalIntentBytes);
    function replaceByteRecord(object, field, value) {
        const bytes = Buffer.from(JSON.stringify(value));
        object[field] = { encoding: 'base64', size: bytes.length, sha256: sha(bytes), data: bytes.toString('base64') };
    }
    function recomputeIntent(value) {
        const body = { ...value };
        delete body.intentSha256;
        value.intentSha256 = currentApi.stableHash(body);
    }
    const mixedVersions = structuredClone(intent);
    const mixedRequest = JSON.parse(Buffer.from(mixedVersions.request.data, 'base64'));
    mixedRequest.messages[0].content = currentApi.renderDailyFilterPrompt(envelope);
    replaceByteRecord(mixedVersions, 'request', mixedRequest);
    recomputeIntent(mixedVersions);
    assert.throws(() => currentApi.normalizeLlmIntent(mixedVersions), /单用户日更筛选提示/,
        '声明旧 v3 模板时不能改用新 v4 正文');
    const reverseMixed = structuredClone(intent);
    const reverseEnvelope = structuredClone(envelope);
    reverseEnvelope.filter.promptSha256 = sha(Buffer.from(utils.loadPrompt(currentPromptPath, {
        title: '{title}', abstract: '{abstract}', categories: '{categories}',
    })));
    const reverseEnvelopeBody = { ...reverseEnvelope };
    delete reverseEnvelopeBody.requestSha256;
    reverseEnvelope.requestSha256 = currentApi.stableHash(reverseEnvelopeBody);
    replaceByteRecord(reverseMixed, 'envelope', reverseEnvelope);
    reverseMixed.requestEnvelopeSha256 = reverseEnvelope.requestSha256;
    recomputeIntent(reverseMixed);
    assert.throws(() => currentApi.normalizeLlmIntent(reverseMixed), /单用户日更筛选提示/,
        '声明新 v4 模板时不能保留旧 v3 正文');
    const bodyChanged = structuredClone(intent);
    const request = JSON.parse(Buffer.from(bodyChanged.request.data, 'base64'));
    request.messages[0].content += '\n擅自改变原请求的结论条件';
    replaceByteRecord(bodyChanged, 'request', request);
    recomputeIntent(bodyChanged);
    assert.throws(() => currentApi.normalizeLlmIntent(bodyChanged), /单用户日更筛选提示/);
    const sourceChanged = structuredClone(intent);
    const changedEnvelope = JSON.parse(Buffer.from(sourceChanged.envelope.data, 'base64'));
    changedEnvelope.metadataRecord.title = '与原来源不符的标题';
    changedEnvelope.discovery.metadataRecordSha256 = currentApi.stableHash(changedEnvelope.metadataRecord);
    const envelopeBody = { ...changedEnvelope };
    delete envelopeBody.requestSha256;
    changedEnvelope.requestSha256 = currentApi.stableHash(envelopeBody);
    replaceByteRecord(sourceChanged, 'envelope', changedEnvelope);
    sourceChanged.requestEnvelopeSha256 = changedEnvelope.requestSha256;
    recomputeIntent(sourceChanged);
    assert.throws(() => currentApi.normalizeLlmIntent(sourceChanged), /effective metadata|单用户/);
    assert.deepEqual(fs.readFileSync(intentFile), originalIntentBytes);
});

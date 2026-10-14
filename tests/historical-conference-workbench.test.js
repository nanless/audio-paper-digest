'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const api = require('../scripts/lib/historical-direct-page-staging.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function renderedFixture() {
    const code = `
import sys,json,hashlib,importlib.util
sys.path[:0]=['scripts','tests/python']
from test_publish_to_blog import llm_api_publication_fixture
spec=importlib.util.spec_from_file_location('history_renderer','scripts/historical-page-render.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
paper=llm_api_publication_fixture();paper.pop('arxivId');paper.pop('abstract')
paper['directPaperId']='conference:icassp:2026:icassp-arnumber:100'
paper['analysis']+='\\n\\n## 标签\\n#语音识别 #Transformer #低资源\\n主任务标签: #语音识别\\n主方法标签: #Transformer\\n补充标签: #低资源'
paper['analysisManifest']['stages']['scoringAudit']['outputAnalysisSha256']=hashlib.sha256(paper['analysis'].encode()).hexdigest()
result=module.render_packet({'directStaging':True,'paper':paper,'cohortDate':'2026-09-04'})
print(json.dumps({'paper':paper,'result':result},ensure_ascii=False))
`;
    return JSON.parse(execFileSync('bash', ['scripts/python-runtime.sh', '-c', code], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024
    }));
}
function input() {
    const fixture = renderedFixture();
    return {
        item: { paperId: fixture.paper.directPaperId, route: { kind: 'conference-local-pdf' } },
        sourceDescriptor: { textSha256: fixture.paper.sourceSha256 }, analysis: fixture.paper,
        page: { cohortDate: '2026-09-04' }, markdown: fixture.result.markdown,
        assets: fixture.result.assets.map(asset => {
            const bytes = Buffer.from(asset.base64, 'base64');
            return { bytes, record: { path: asset.path, sha256: hash(bytes), size: bytes.length } };
        })
    };
}
function editJson(request, name, change) {
    const asset = request.assets.find(value => value.record.path.endsWith('/' + name));
    const value = JSON.parse(asset.bytes.toString('utf8')); change(value);
    asset.bytes = Buffer.from(JSON.stringify(value) + '\n');
    asset.record.sha256 = hash(asset.bytes); asset.record.size = asset.bytes.length;
}
function copy(request) {
    const cloned = structuredClone(request);
    for (const asset of cloned.assets) asset.bytes = Buffer.from(asset.bytes);
    return cloned;
}

test('真实共享 Python 导出通过 Node 来源核验，原摘要和公开 URL 缺失如实记录', () => {
    const request = input();
    const snapshot = JSON.stringify(request.analysis);
    api.validateConferenceWorkbenchAssets(request);
    assert.equal(JSON.stringify(request.analysis), snapshot);
    const context = JSON.parse(request.assets.find(asset => asset.record.path.endsWith('/rethink-context.json')).bytes);
    assert.equal(context.abstractStatus, 'unavailable');
    assert.equal(context.abstract, null);
    assert.equal(context.publicUrlAvailability, 'unavailable');
    assert.equal(context.recordUrl, null);
    assert.equal(context.pdfUrl, null);
    assert.equal(request.assets.length, 4);
    assert.doesNotMatch(request.markdown, /paper_digest_arxiv_/);
});

test('重签名附属文件不能更换论文、封存来源或上下文可得性，额外 JSON 不获准', () => {
    const original = input();
    const foreign = copy(original);
    editJson(foreign, 'citation.json', citation => { citation.paperId = 'conference:icassp:2026:icassp-arnumber:999'; });
    assert.throws(() => api.validateConferenceWorkbenchAssets(foreign), /真实论文身份/);
    const invented = copy(original);
    editJson(invented, 'rethink-context.json', context => { context.abstractStatus = 'available'; });
    assert.throws(() => api.validateConferenceWorkbenchAssets(invented), /原摘要可得状态/);
    const added = copy(original);
    added.assets.push({ bytes: Buffer.from('{}\n'), record: { path: api.conferenceWorkbenchRoot(added.item, added.page) + 'extra.json', sha256: hash('{}\n'), size: 3 } });
    assert.throws(() => api.validateConferenceWorkbenchAssets(added), /四个固定/);
    const wrongSource = copy(original); wrongSource.sourceDescriptor.textSha256 = 'a'.repeat(64);
    assert.throws(() => api.validateConferenceWorkbenchAssets(wrongSource), /全文 SHA/);
    const foreignPath = copy(original);
    foreignPath.assets[0].record.path = foreignPath.assets[0].record.path.replace('conference-', 'conference-other-');
    assert.throws(() => api.validateConferenceWorkbenchAssets(foreignPath), /四个固定/);
    const removed = copy(original); removed.assets.pop();
    assert.throws(() => api.validateConferenceWorkbenchAssets(removed), /四个固定/);
    const changedBib = copy(original);
    const bib = changedBib.assets.find(asset => asset.record.path.endsWith('/citation.bib'));
    bib.bytes = Buffer.from(bib.bytes.toString('utf8').replace('Researcher A', 'Researcher B'));
    bib.record.sha256 = hash(bib.bytes); bib.record.size = bib.bytes.length;
    assert.throws(() => api.validateConferenceWorkbenchAssets(changedBib), /BibTeX 与真实/);
});

test('真实附属文件进入暂存清单并可冷恢复，重签名的异篇引用仍被拒绝', t => {
    const request = input();
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'historical-conference-exports-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const item = { ...request.item, runId: '11111111-1111-4111-8111-111111111111', projectionSha256: hash('projection'),
        pages: [{ pageKey: `page:${hash('page')}`, pagePath: 'content/posts/conference.md', primaryUrl: 'https://example.test/conference/',
            cohortDate: request.page.cohortDate, scope: { type: 'conference', key: 'icassp-2026' },
            pageContentSha256: hash('old page'), mapping: 'local-conference-source', historicalArxivLink: null }] };
    const sourceDescriptor = { ...request.sourceDescriptor, paperId: item.paperId,
        structuredArtifactsSha256: 'c'.repeat(64), sourceSnapshotSha256: 'd'.repeat(64) };
    const artifact = { paperId: item.paperId, runId: item.runId, route: item.route.kind,
        analysisFileSha256: 'e'.repeat(64), analysisRecordSha256: api.stableHash(request.analysis),
        sourceSnapshotSha256: sourceDescriptor.sourceSnapshotSha256 };
    const options = { item, sourceDescriptor, artifact, publicationSource: null, analysis: request.analysis,
        directory, stagingInputSha256: hash('input'), stagingBindingSha256: hash('binding'),
        dependencies: { rendererImplementationSha256: 'f'.repeat(64), renderDirectPage: () => ({ markdown: request.markdown,
            assets: request.assets.map(asset => ({ path: asset.record.path, base64: asset.bytes.toString('base64') })) }) } };
    const staged = api.stageDirectPages(options);
    assert.equal(staged.assets.length, 4);
    assert.equal(api.stageDirectPages(options).manifestSha256, staged.manifestSha256);
    const citation = staged.assets.find(asset => asset.path.endsWith('/citation.json'));
    const target = path.join(directory, 'assets', citation.path);
    const forged = JSON.parse(fs.readFileSync(target)); forged.paperId += '-foreign';
    const bytes = Buffer.from(JSON.stringify(forged) + '\n'); fs.writeFileSync(target, bytes);
    citation.sha256 = hash(bytes); citation.size = bytes.length;
    staged.assetSetSha256 = api.stableHash(staged.assets);
    const { manifestSha256: _old, ...body } = staged; staged.manifestSha256 = api.stableHash(body);
    fs.writeFileSync(path.join(directory, 'page-staging-manifest.json'), JSON.stringify(staged) + '\n');
    assert.throws(() => api.stageDirectPages(options), /会议引用 JSON 与真实论文身份/);
});

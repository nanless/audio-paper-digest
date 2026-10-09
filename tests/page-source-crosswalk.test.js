'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/page-source-crosswalk.js');
const cli = require('../scripts/page-source-crosswalk.js');
const authorityApi = require('../scripts/lib/paper-source-authority.js');
const archiveCrawlAuthorityApi = require('../scripts/lib/historical-archive-crawl-authority.js');
const localCrawlAuthorityApi = require('../scripts/lib/historical-local-crawl-authority.js');
const conferenceCrawlAuthorityApi = require('../scripts/lib/historical-conference-crawl-authority.js');
const identityApi = require('../scripts/lib/paper-identity.js');
const contextApi = require('../scripts/lib/conference-source-context.js');
const arxivAdapter = require('../scripts/lib/arxiv-source-authority.js');
const arxivCli = require('../scripts/arxiv-source-authority.js');
const conflictResolver = require('../scripts/lib/history-conflict-identity.js');
const conflictCli = require('../scripts/history-conflict-identity.js');
const deep = require('../scripts/deep-analyzer.js');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const stamp = '2026-09-06T00:00:00.000Z';

function spawnLockHolder(directory) {
    const child = spawn(process.execPath, ['-e', [
        'const api=require(process.argv[1]);',
        'api.acquireLock(process.argv[2], "signal.test.owner", new Date().toISOString());',
        'process.stdout.write("READY\\n");',
        'setInterval(() => {}, 1000);'
    ].join(''), path.join(__dirname, '..', 'scripts', 'lib', 'page-source-crosswalk.js'), directory], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const ready = new Promise((resolve, reject) => {
        let stdout = '', stderr = '';
        const timer = setTimeout(() => reject(new Error(`lock holder timed out: ${stderr}`)), 5000);
        child.stdout.on('data', chunk => {
            stdout += chunk;
            if (stdout.includes('READY\n')) { clearTimeout(timer); resolve(); }
        });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('exit', (code, signal) => {
            if (!stdout.includes('READY\n')) {
                clearTimeout(timer); reject(new Error(`lock holder exited before ready: ${code}/${signal}: ${stderr}`));
            }
        });
    });
    return { child, ready };
}

function spawnStateWriter(crosswalkRoot, crosswalkId, decisionName) {
    const child = spawn(process.execPath, ['-e', [
        'const fs=require("node:fs"); const path=require("node:path");',
        'const api=require(process.argv[1]); const root=process.argv[2]; const id=process.argv[3];',
        'const target=path.join(root,id,"state.json"); const rename=fs.renameSync; let announced=false;',
        'fs.renameSync=(from,to)=>{ if(to===target&&!announced){announced=true;',
        'process.stdout.write("WRITE_WINDOW\\n"); const until=Date.now()+250; while(Date.now()<until){} }',
        'return rename(from,to); };',
        'api.applyDecisionFile({crosswalkRoot:root,crosswalkId:id,decisionName:process.argv[4],owner:"signal.writer"});',
        'setInterval(() => {},1000);'
    ].join(''), path.join(__dirname, '..', 'scripts', 'lib', 'page-source-crosswalk.js'),
    crosswalkRoot, crosswalkId, decisionName], { stdio: ['ignore', 'pipe', 'pipe'] });
    const inWindow = new Promise((resolve, reject) => {
        let stdout = '', stderr = '';
        const timer = setTimeout(() => reject(new Error(`state writer timed out: ${stderr}`)), 5000);
        child.stdout.on('data', chunk => {
            stdout += chunk;
            if (stdout.includes('WRITE_WINDOW\n')) { clearTimeout(timer); resolve(); }
        });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('exit', (code, signal) => {
            if (!stdout.includes('WRITE_WINDOW\n')) {
                clearTimeout(timer); reject(new Error(`state writer exited before window: ${code}/${signal}: ${stderr}`));
            }
        });
    });
    return { child, inWindow };
}

function writeArxivAuthority(root, name = 'authority.json') {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const fulltextName = 'paper.txt'; const text = `${'authenticated source text '.repeat(1200)}\n`;
    fs.writeFileSync(path.join(root, fulltextName), text, { mode: 0o600 }); const fulltextSha256 = sha(text);
    const snapshotName = 'snapshot.json'; const snapshotBody = { contract: authorityApi.ARXIV_SNAPSHOT_CONTRACT,
        version: authorityApi.VERSION, paperId: 'arxiv:2601.00001', arxivId: '2601.00001',
        officialUrl: 'https://arxiv.org/abs/2601.00001', fulltextSha256 };
    const snapshot = { ...snapshotBody, snapshotSha256: authorityApi.stableHash(snapshotBody) };
    const snapshotBytes = authorityApi.prettyBytes(snapshot); fs.writeFileSync(path.join(root, snapshotName), snapshotBytes, { mode: 0o600 });
    const receiptName = 'source-receipt.json'; const receiptBody = { contract: authorityApi.ARXIV_RECEIPT_CONTRACT,
        version: authorityApi.VERSION, snapshotName, snapshotFileSha256: sha(snapshotBytes),
        snapshotSha256: snapshot.snapshotSha256, fulltextName, fulltextSha256 };
    const receipt = { ...receiptBody, receiptSha256: authorityApi.stableHash(receiptBody) };
    const receiptBytes = authorityApi.prettyBytes(receipt); fs.writeFileSync(path.join(root, receiptName), receiptBytes, { mode: 0o600 });
    const identity = { contract: identityApi.CONTRACT, kind: 'arxiv', canonicalId: 'arxiv:2601.00001',
        arxivId: '2601.00001', conference: null, externalId: null,
        source: { status: 'official', url: 'https://arxiv.org/abs/2601.00001' }, citation: null };
    const body = { contract: authorityApi.CONTRACT, version: authorityApi.VERSION, paperId: identity.canonicalId,
        identity, identitySha256: identityApi.identitySha256(identity),
        identityRecordSha256: identityApi.recordSha256(identity), evidenceKind: 'arxiv-official-fulltext',
        proof: { snapshotName, snapshotFileSha256: sha(snapshotBytes), snapshotSha256: snapshot.snapshotSha256,
            receiptName, receiptFileSha256: sha(receiptBytes), receiptSha256: receipt.receiptSha256,
            fulltextName, fulltextSha256 } };
    const authority = { ...body, authoritySha256: authorityApi.stableHash(body) };
    fs.writeFileSync(path.join(root, name), authorityApi.prettyBytes(authority), { mode: 0o600 });
    return authorityApi.loadAuthorityHandle({ authorityRoot: root, authorityName: name });
}

function useConferenceHint(f, value = '100') {
    const paper = f.ledger.pages.find(page => page.kind === 'paper');
    paper.identityHints = { status: 'single', candidates: [
        { scheme: 'icassp-arnumber', value, sources: ['frontmatter:paper_digest_icassp_arnumber'] }
    ] };
    rehashPage(paper); rehashLedger(f.ledger);
    const ledgerBytes = api.prettyBytes(f.ledger);
    fs.writeFileSync(path.join(f.inventory, f.ledgerName), ledgerBytes, { mode: 0o600 });
    const receiptBody = structuredClone(f.receipt); delete receiptBody.receiptSha256;
    receiptBody.ledger.fileSha256 = sha(ledgerBytes);
    receiptBody.ledger.ledgerSha256 = f.ledger.ledgerSha256;
    receiptBody.ledger.pageSetSha256 = f.ledger.pageSetSha256;
    f.receipt = { ...receiptBody, receiptSha256: api.stableHash(receiptBody) };
    fs.writeFileSync(path.join(f.inventory, f.receiptName), api.prettyBytes(f.receipt), { mode: 0o600 });
}
function useOpenReviewHint(f, value = 'AbCdef_12') {
    const paper = f.ledger.pages.find(page => page.kind === 'paper');
    paper.identityHints = { status: 'single', candidates: [
        { scheme: 'openreview-forum-id', value, sources: ['body:openreview-link'] }
    ] };
    rehashPage(paper); rehashLedger(f.ledger);
    const ledgerBytes = api.prettyBytes(f.ledger);
    fs.writeFileSync(path.join(f.inventory, f.ledgerName), ledgerBytes, { mode: 0o600 });
    const receiptBody = structuredClone(f.receipt); delete receiptBody.receiptSha256;
    receiptBody.ledger.fileSha256 = sha(ledgerBytes); receiptBody.ledger.ledgerSha256 = f.ledger.ledgerSha256;
    receiptBody.ledger.pageSetSha256 = f.ledger.pageSetSha256;
    f.receipt = { ...receiptBody, receiptSha256: api.stableHash(receiptBody) };
    fs.writeFileSync(path.join(f.inventory, f.receiptName), api.prettyBytes(f.receipt), { mode: 0o600 });
}

function useArxivConflictHints(f, secondScheme = 'arxiv') {
    const paper = f.ledger.pages.find(page => page.kind === 'paper');
    paper.identityHints = { status: secondScheme === 'arxiv' ? 'conflict' : 'multiple', candidates: [
        { scheme: 'arxiv', value: '2601.00001', sources: ['filename'] },
        secondScheme === 'arxiv'
            ? { scheme: 'arxiv', value: '2601.00002', sources: ['frontmatter:paper_digest_arxiv_id'] }
            : { scheme: secondScheme, value: 'Forum_000002', sources: ['body:openreview-link'] }
    ] };
    rehashPage(paper); rehashLedger(f.ledger);
    const ledgerBytes = api.prettyBytes(f.ledger);
    fs.writeFileSync(path.join(f.inventory, f.ledgerName), ledgerBytes, { mode: 0o600 });
    const receiptBody = structuredClone(f.receipt); delete receiptBody.receiptSha256;
    receiptBody.ledger.fileSha256 = sha(ledgerBytes);
    receiptBody.ledger.ledgerSha256 = f.ledger.ledgerSha256;
    receiptBody.ledger.pageSetSha256 = f.ledger.pageSetSha256;
    f.receipt = { ...receiptBody, receiptSha256: api.stableHash(receiptBody) };
    fs.writeFileSync(path.join(f.inventory, f.receiptName), api.prettyBytes(f.receipt), { mode: 0o600 });
}

function writeConferenceAuthority(t, root, value = '100', name = 'conference-authority.json') {
    const fixture = productionPlanFixture(t, { value });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const context = contextApi.buildConferenceSourceContext({ planHandle: fixture.planHandle,
        paperId: fixture.paperId, sourceRoot: fixture.sourceRoot });
    const sourceContextName = 'conference-context.json';
    const contextBytes = authorityApi.prettyBytes(context);
    fs.writeFileSync(path.join(root, sourceContextName), contextBytes, { mode: 0o600 });
    const identity = { contract: identityApi.CONTRACT, kind: 'conference', canonicalId: fixture.paperId,
        arxivId: null, conference: { slug: 'icassp', year: 2026 },
        externalId: { scheme: 'icassp-arnumber', value }, source: { status: 'unavailable', url: null }, citation: null };
    const proof = { sourceContextName, sourceContextFileSha256: sha(contextBytes),
        sourceContextSha256: authorityApi.stableHash(context), sourceSnapshotSha256: context.sourceSnapshotSha256,
        observationBindingSha256: context.observationBindingSha256,
        planAuthorityBindingSha256: context.productionAuthorization.binding.bindingSha256,
        fulltextSha256: sha(Buffer.from(context.text, 'utf8')) };
    const body = { contract: authorityApi.CONTRACT, version: authorityApi.VERSION, paperId: fixture.paperId,
        identity, identitySha256: identityApi.identitySha256(identity), identityRecordSha256: identityApi.recordSha256(identity),
        evidenceKind: 'conference-plan-source-context', proof };
    const authority = { ...body, authoritySha256: authorityApi.stableHash(body) };
    fs.writeFileSync(path.join(root, name), authorityApi.prettyBytes(authority), { mode: 0o600 });
    const handle = authorityApi.loadAuthorityHandle({ authorityRoot: root, authorityName: name,
        conferencePlanHandle: fixture.planHandle, conferenceSourceRoot: fixture.sourceRoot });
    const bundle = { handle, name, sourceContextName, fixture };
    bundle.resolver = reference => { assert.equal(reference.authorityName, name); return bundle.handle; };
    return bundle;
}

function eio(stage) {
    const error = new Error(`${stage} injected EIO`); error.code = 'EIO'; return error;
}
function writeOperationLock(directory, { pid = 99999999, hostname = os.hostname(), startedAt = '2000-01-01T00:00:00.000Z',
    heartbeatAt = startedAt, token = ids[9], extra = false } = {}) {
    const lock = path.join(directory, 'operation.lock'); fs.mkdirSync(lock, { mode: 0o700 });
    const body = { contract: api.LOCK_OWNER_CONTRACT, version: 1, owner: 'fixture.owner', pid,
        hostname, token, startedAt, heartbeatAt, leaseMs: api.LOCK_STALE_MS };
    const owner = { ...body, ownerSha256: api.stableHash(body) };
    const ownerFile = path.join(lock, 'owner.json'); fs.writeFileSync(ownerFile, api.prettyBytes(owner), { mode: 0o600 });
    if (extra) fs.writeFileSync(path.join(lock, 'unexpected'), 'x');
    if (startedAt.startsWith('2000-')) {
        const old = new Date('2000-01-01T00:00:00.000Z'); fs.utimesSync(ownerFile, old, old); fs.utimesSync(lock, old, old);
    }
    return { lock, ownerFile, owner };
}

function rehashPage(page) {
    const snapshotBody = structuredClone(page);
    delete snapshotBody.outboundPostLinks; delete snapshotBody.snapshotSha256; delete snapshotBody.recordSha256;
    page.snapshotSha256 = api.stableHash(snapshotBody);
    const recordBody = structuredClone(page); delete recordBody.recordSha256;
    page.recordSha256 = api.stableHash(recordBody);
}
function rehashLedger(ledger) {
    ledger.pageSetSha256 = api.stableHash(ledger.pages);
    const body = structuredClone(ledger); delete body.ledgerSha256;
    ledger.ledgerSha256 = api.stableHash(body);
}

function record(pathname, kind, content) {
    const markerValues = kind === 'paper' ? { paper_digest_page_type: 'paper', paper_digest_pipeline_owned: true } : {};
    const primaryUrl = `https://example.test/blog/posts/${path.basename(pathname, '.md')}/`;
    const pageId = `page:${api.stableHash({ contract: 'historical-page-id-v1', path: pathname, primaryUrl })}`;
    const body = { pageId, path: pathname, gitBlobOid: sha(`blob:${pathname}`).slice(0, 40),
        contentBytes: content.length + 10, contentSha256: sha(content),
        frontmatterBytes: 10, frontmatterSha256: sha(`frontmatter:${pathname}`),
        bodyBytes: content.length, bodySha256: sha(`body:${pathname}`),
        primaryUrl, aliases: [], kind,
        scope: { type: 'daily', key: '2026-01-01' }, legacy: { tags: ['语音识别'], categories: ['论文速递'],
            marker: { pipelineOwned: kind === 'paper' ? true : null, declaredPageType: kind === 'paper' ? 'paper' : null,
                fieldNames: Object.keys(markerValues).sort(), fieldsSha256: api.stableHash(markerValues) } },
        publishedDate: '2026-01-01', cohortDate: '2026-01-01', legacyTaskKey: null,
        draft: false, published: true,
        identityHints: { status: kind === 'paper' ? 'single' : 'none', candidates: kind === 'paper'
            ? [{ scheme: 'arxiv', value: '2601.00001', sources: ['filename'] }] : [] },
        outboundPostLinks: [], publicationEvidenceRefs: kind === 'paper' ? [
            { field: 'paper_digest_api_reader_contract', valueType: 'string', value: null,
                valueSha256: api.stableHash('beginner-researcher-v3') },
            { field: 'paper_digest_arxiv_id', valueType: 'string', value: '2601.00001',
                valueSha256: api.stableHash('2601.00001') },
            { field: 'paper_digest_page_type', valueType: 'string', value: 'paper',
                valueSha256: api.stableHash('paper') }
        ] : [], legacyTaxonomyCandidates: [
            { taxonomy: 'tags', term: '语音识别', status: 'unverified',
                candidateUrl: 'https://example.test/blog/tags/%E8%AF%AD%E9%9F%B3%E8%AF%86%E5%88%AB/', method: 'legacy-term-normalization-v1' },
            { taxonomy: 'categories', term: '论文速递', status: 'unverified',
                candidateUrl: 'https://example.test/blog/categories/%E8%AE%BA%E6%96%87%E9%80%9F%E9%80%92/', method: 'legacy-term-normalization-v1' }
        ] };
    const snapshotBody = structuredClone(body); delete snapshotBody.outboundPostLinks;
    const withSnapshot = { ...body, snapshotSha256: api.stableHash(snapshotBody) };
    return { ...withSnapshot, recordSha256: api.stableHash(withSnapshot) };
}
function historicalBundle(root) {
    // 明确的旧 v3 合成样本，用于字段及状态反例；不是原扫描器捕获的产物。
    const inventory = path.join(root, 'inventory'); fs.mkdirSync(inventory);
    const pages = [record('content/posts/2026-01-01-paper-2601-00001.md', 'paper', 'SECRET OLD BODY'),
        record('content/posts/2026-01-01.md', 'daily-summary', 'summary')].sort((a, b) => a.path.localeCompare(b.path));
    const paper = pages.find(page => page.kind === 'paper'); const summary = pages.find(page => page.kind === 'daily-summary');
    paper.outboundPostLinks = [{ ordinal: 1, linkType: 'markdown-inline', sourceByteStart: 0, sourceByteEnd: 4,
        targetRawSha256: sha('/blog/posts/2026-01-01/'), targetUrl: summary.primaryUrl, status: 'resolved',
        targetPath: summary.path, targetPageId: summary.pageId, targetRecordSha256: summary.snapshotSha256 }];
    const paperBody = structuredClone(paper); delete paperBody.recordSha256;
    paper.recordSha256 = api.stableHash(paperBody);
    const trackedPages = pages.map(page => ({ path: page.path, blobOid: page.gitBlobOid }));
    const hugoPages = pages.map(page => ({ path: page.path, permalink: page.primaryUrl }));
    const source = { branch: 'main', head: 'a'.repeat(40), clean: true, statusSha256: sha(''), remoteName: 'origin',
        remoteIdentitySha256: sha('remote'), baseUrl: 'https://example.test/blog/',
        remoteMain: { availability: 'unavailable', oid: null, ref: 'refs/remotes/origin/main' },
        hugoConfig: { path: 'hugo.yaml', sha256: sha('config') }, contentRoot: 'content/posts',
        hugoRuntime: { version: 'hugo v0.fixture', pageSetSha256: api.stableHash(hugoPages),
            publishedPageSetSha256: api.stableHash(hugoPages), pageCount: hugoPages.length,
            publishedPageCount: hugoPages.length },
        gitObjectFormat: 'sha1', contentTreeOid: 'b'.repeat(40),
        trackedPages: { count: trackedPages.length, setSha256: api.stableHash(trackedPages) } };
    const policy = { contract: 'historical-page-scan-policy-v3', bodyRetention: 'sha256-only',
        identityHints: 'frontmatter-filename-explicit-links-v1', outboundLinks: 'strict-balanced-inline-occurrences-v3',
        linkOffsetUnit: 'utf8-byte-body-relative',
        taxonomyRoutes: 'unverified-candidates-v2', publicationEvidence: 'schema-checked-hash-default-whitelist-v3',
        targetRecordBinding: 'target-page-snapshot-sha256-v1' };
    const outboundPostLinks = pages.flatMap(page => page.outboundPostLinks.map(link => (
        { sourcePageId: page.pageId, sourcePath: page.path, ...link }
    )));
    const counts = { pages: 2, papers: 1, dailySummaries: 1, conferenceSummaries: 0, conferenceTasks: 0,
        unknown: 0, urlCollisions: 0, outboundPostLinks: 1, resolvedOutboundPostLinks: 1,
        unresolvedOutboundPostLinks: 0, ambiguousOutboundPostLinks: 0 };
    const ledgerBody = { contract: api.LEDGER_CONTRACT, version: 1, source, policy, pages, urlCollisions: [],
        outboundPostLinks, outboundPostLinksSha256: api.stableHash(outboundPostLinks), counts,
        pageSetSha256: api.stableHash(pages) };
    const ledger = { ...ledgerBody, ledgerSha256: api.stableHash(ledgerBody) };
    const ledgerBytes = api.prettyBytes(ledger); const ledgerName = 'history.json';
    const receiptBody = { contract: api.LEDGER_RECEIPT_CONTRACT, version: 1, ledger: { name: ledgerName,
        fileSha256: sha(ledgerBytes), ledgerSha256: ledger.ledgerSha256, pageSetSha256: ledger.pageSetSha256,
        pageCount: pages.length }, repositorySnapshotSha256: api.stableHash(source) };
    const receipt = { ...receiptBody, receiptSha256: api.stableHash(receiptBody) };
    fs.writeFileSync(path.join(inventory, ledgerName), ledgerBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(inventory, 'history.receipt.json'), api.prettyBytes(receipt), { mode: 0o600 });
    return { inventory, ledger, receipt, ledgerName, receiptName: 'history.receipt.json' };
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'page-source-crosswalk-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, crosswalk: path.join(root, 'crosswalk'), ...historicalBundle(root) };
}
function load(f) {
    return api.loadHistoricalInventoryHandle({ inventoryRoot: f.inventory, ledgerName: f.ledgerName, receiptName: f.receiptName });
}

test('合成扫描 v3 与 v4 样本按原格式读取，拒绝字段混用和错误原摘要', t => {
    const f = fixture(t);
    const ledgerFile = path.join(f.inventory, f.ledgerName);
    const receiptFile = path.join(f.inventory, f.receiptName);
    const originalLedger = fs.readFileSync(ledgerFile), originalReceipt = fs.readFileSync(receiptFile);
    assert.deepEqual(api.inventoryHandleSnapshot(load(f)).ledger.policy, f.ledger.policy);
    assert.deepEqual(fs.readFileSync(ledgerFile), originalLedger);
    assert.deepEqual(fs.readFileSync(receiptFile), originalReceipt);
    const current = structuredClone(f.ledger);
    current.policy = { contract: 'historical-page-scan-policy-v4', bodyRetention: 'sha256-only',
        identityHints: 'frontmatter-filename-explicit-links-v1', outboundLinks: 'strict-balanced-inline-occurrences-v3',
        linkOffsetUnit: 'utf8-byte-body-relative', tagRoutes: 'unverified-candidates-v2',
        publicationEvidence: 'schema-checked-hash-default-whitelist-v4',
        targetRecordBinding: 'target-page-snapshot-sha256-v1' };
    const paper = current.pages.find(page => page.kind === 'paper');
    paper.publicationEvidenceRefs.push({ field: 'paper_digest_tags_contract', valueType: 'string', value: null,
        valueSha256: api.stableHash('paper-taxonomy-flat-tags-compat-v1') });
    paper.publicationEvidenceRefs.sort((a, b) => a.field.localeCompare(b.field));
    rehashPage(paper); rehashLedger(current);
    assert.deepEqual(api.validateHistoricalLedger(current), current);
    const legacy = structuredClone(current); legacy.policy = structuredClone(f.ledger.policy); rehashLedger(legacy);
    assert.throws(() => api.validateHistoricalLedger(legacy), /publication evidence field\/type is unsupported/);
    const mixed = structuredClone(current), mixedPaper = mixed.pages.find(page => page.kind === 'paper');
    mixedPaper.publicationEvidenceRefs.push({ field: 'paper_digest_taxonomy_concepts', valueType: 'null', value: null,
        valueSha256: api.stableHash(null) });
    mixedPaper.publicationEvidenceRefs.sort((a, b) => a.field.localeCompare(b.field));
    rehashPage(mixedPaper); rehashLedger(mixed);
    assert.throws(() => api.validateHistoricalLedger(mixed), /新旧标签字段/);
    const badSha = structuredClone(mixed); badSha.ledgerSha256 = sha('wrong original ledger');
    assert.throws(() => api.validateHistoricalLedger(badSha), /ledger self-SHA drifted/);
    const unknown = structuredClone(current); unknown.policy.contract = 'historical-page-scan-policy-unknown'; rehashLedger(unknown);
    assert.throws(() => api.validateHistoricalLedger(unknown), /历史页面扫描策略不受支持/);
    const badReceipt = JSON.parse(originalReceipt);
    badReceipt.ledger.fileSha256 = sha('wrong original bytes');
    fs.writeFileSync(receiptFile, api.prettyBytes(badReceipt));
    assert.throws(() => load(f), /receipt self-SHA drifted/);
});

test('不透明清单加载器复核规范账目与凭证，拒绝伪造句柄或字节漂移', t => {
    const f = fixture(t); const handle = load(f); const snapshot = api.inventoryHandleSnapshot(handle);
    assert.equal(snapshot.ledger.pages.length, 2); assert.equal(snapshot.receipt.ledger.name, f.ledgerName);
    const paper = snapshot.ledger.pages.find(page => page.kind === 'paper');
    assert.equal(paper.outboundPostLinks[0].status, 'resolved');
    assert.equal(paper.outboundPostLinks[0].targetPageId,
        snapshot.ledger.pages.find(page => page.kind === 'daily-summary').pageId);
    assert.throws(() => api.inventoryHandleSnapshot({}), /authenticated historical inventory handle/);
    fs.appendFileSync(path.join(f.inventory, f.ledgerName), ' ');
    assert.throws(() => load(f), /canonical|exact ledger|self-SHA/);
    fs.writeFileSync(path.join(f.inventory, f.ledgerName), api.prettyBytes(f.ledger), { mode: 0o600 });
    const changed = structuredClone(f.receipt); changed.repositorySnapshotSha256 = sha('changed');
    fs.writeFileSync(path.join(f.inventory, f.receiptName), api.prettyBytes(changed), { mode: 0o600 });
    assert.throws(() => load(f), /repository snapshot|self-SHA/);

    const injected = structuredClone(f.ledger); injected.pages[0].legacy.body = 'SECRET OLD BODY';
    const { recordSha256: _record, ...pageBody } = injected.pages[0];
    injected.pages[0].recordSha256 = api.stableHash(pageBody); injected.pageSetSha256 = api.stableHash(injected.pages);
    const { ledgerSha256: _ledger, ...ledgerBody } = injected; injected.ledgerSha256 = api.stableHash(ledgerBody);
    const injectedBytes = api.prettyBytes(injected);
    const receiptBody = { contract: api.LEDGER_RECEIPT_CONTRACT, version: 1, ledger: { name: 'injected.json',
        fileSha256: sha(injectedBytes), ledgerSha256: injected.ledgerSha256, pageSetSha256: injected.pageSetSha256,
        pageCount: injected.pages.length }, repositorySnapshotSha256: api.stableHash(injected.source) };
    fs.writeFileSync(path.join(f.inventory, 'injected.json'), injectedBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(f.inventory, 'injected.receipt.json'),
        api.prettyBytes({ ...receiptBody, receiptSha256: api.stableHash(receiptBody) }), { mode: 0o600 });
    assert.throws(() => api.loadHistoricalInventoryHandle({ inventoryRoot: f.inventory, ledgerName: 'injected.json',
        receiptName: 'injected.receipt.json' }), /historical page legacy has unknown or missing fields/);

    const wrongTarget = structuredClone(f.ledger); const wrongPaper = wrongTarget.pages.find(page => page.kind === 'paper');
    wrongPaper.outboundPostLinks[0].targetRecordSha256 = sha('wrong target');
    const wrongPageBody = structuredClone(wrongPaper); delete wrongPageBody.recordSha256;
    wrongPaper.recordSha256 = api.stableHash(wrongPageBody);
    wrongTarget.outboundPostLinks = wrongTarget.pages.flatMap(page => page.outboundPostLinks.map(link => (
        { sourcePageId: page.pageId, sourcePath: page.path, ...link }
    )));
    wrongTarget.outboundPostLinksSha256 = api.stableHash(wrongTarget.outboundPostLinks);
    wrongTarget.pageSetSha256 = api.stableHash(wrongTarget.pages);
    const wrongLedgerBody = structuredClone(wrongTarget); delete wrongLedgerBody.ledgerSha256;
    wrongTarget.ledgerSha256 = api.stableHash(wrongLedgerBody);
    assert.throws(() => api.validateHistoricalLedger(wrongTarget), /target binding/);

    const leaked = structuredClone(f.ledger); const leakedPaper = leaked.pages.find(page => page.kind === 'paper');
    const contractEvidence = leakedPaper.publicationEvidenceRefs.find(
        evidence => evidence.field === 'paper_digest_api_reader_contract');
    contractEvidence.value = '/Users/private/reader-secret';
    contractEvidence.valueSha256 = api.stableHash(contractEvidence.value);
    rehashPage(leakedPaper); rehashLedger(leaked);
    assert.throws(() => api.validateHistoricalLedger(leaked), /must be hash-only/);

    const invalidEnum = structuredClone(f.ledger); const invalidPaper = invalidEnum.pages.find(page => page.kind === 'paper');
    const pageTypeEvidence = invalidPaper.publicationEvidenceRefs.find(
        evidence => evidence.field === 'paper_digest_page_type');
    pageTypeEvidence.value = 'https://user:secret@example.test/path';
    pageTypeEvidence.valueSha256 = api.stableHash(pageTypeEvidence.value);
    rehashPage(invalidPaper); rehashLedger(invalidEnum);
    assert.throws(() => api.validateHistoricalLedger(invalidEnum), /preserved publication string is invalid/);
});

test('Python 根据合成旧清单生成的配对字节可由 Node 完整读取', t => {
    const f = fixture(t); const output = path.join(f.root, 'python-inventory'); fs.mkdirSync(output);
    const input = path.join(f.root, 'python-input.json'); fs.writeFileSync(input, JSON.stringify(f.ledger));
    const script = [
        'import json,sys',
        'sys.path.insert(0, sys.argv[1])',
        'from historical_page_scan import build_receipt',
        'ledger=json.load(open(sys.argv[2], encoding="utf-8"))',
        'ledger_bytes,receipt,receipt_bytes=build_receipt(ledger, "python.json")',
        'open(sys.argv[3], "wb").write(ledger_bytes)',
        'open(sys.argv[4], "wb").write(receipt_bytes)',
    ].join(';');
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script, path.join(__dirname, '..', 'scripts'),
        input, path.join(output, 'python.json'), path.join(output, 'python.receipt.json')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const handle = api.loadHistoricalInventoryHandle({ inventoryRoot: output, ledgerName: 'python.json',
        receiptName: 'python.receipt.json' });
    assert.equal(api.inventoryHandleSnapshot(handle).ledger.ledgerSha256, f.ledger.ledgerSha256);
});

function bindRouteTestLedger(ledger) {
    for (const page of ledger.pages) {
        const body = structuredClone(page);
        delete body.outboundPostLinks; delete body.snapshotSha256; delete body.recordSha256;
        page.snapshotSha256 = api.stableHash(body);
    }
    const byId = new Map(ledger.pages.map(page => [page.pageId, page]));
    for (const page of ledger.pages) {
        for (const link of page.outboundPostLinks) if (link.status === 'resolved') {
            link.targetRecordSha256 = byId.get(link.targetPageId).snapshotSha256;
        }
        const body = structuredClone(page); delete body.recordSha256;
        page.recordSha256 = api.stableHash(body);
    }
    ledger.outboundPostLinks = ledger.pages.flatMap(page => page.outboundPostLinks.map(link => (
        { sourcePageId: page.pageId, sourcePath: page.path, ...link }
    )));
    ledger.outboundPostLinksSha256 = api.stableHash(ledger.outboundPostLinks);
    rehashLedger(ledger);
}

test('真实 Python 新扫描和原实现两版扫描经配对凭证进入 Node，原字节及所有绑定保持', t => {
    const f = fixture(t), output = path.join(f.root, 'actual-python-scans');
    fs.mkdirSync(output, { mode: 0o700 });
    const project = path.join(__dirname, '..');
    const script = [
        'import json,runpy,shutil,sys',
        'from pathlib import Path',
        'from unittest import mock',
        'root=Path(sys.argv[1]); output=Path(sys.argv[2])',
        'sys.path.insert(0,str(root/"scripts")); sys.path.insert(0,str(root/"tests/helpers"))',
        'import historical_page_scan as current',
        'from historical_page_scan_original_fixture import load_original_page_scan',
        'original=load_original_page_scan()',
        'tests=runpy.run_path(str(root/"tests/python/test_historical_page_scan.py"))',
        'case=tests["HistoricalPageScanTest"]()',
        'try:',
        '    case.setUp()',
        '    for label,module,policy in [("current",current,current.SCAN_POLICY),("v3",original,original.LEGACY_SCAN_POLICY),("v4",original,original.SCAN_POLICY)]:',
        '        with mock.patch.object(module,"SCAN_POLICY",policy):',
        '            ledger=module.scan_historical_pages(case.repo,require_clean_main=True)',
        '            module.write_inventory_pair(output/label,"history.json","history.receipt.json",ledger,expected_repo=case.repo)',
        '    shutil.copytree(case.repo,output/"fixture-blog")',
        'finally:',
        '    if hasattr(case,"temporary"): case.tearDown()',
    ].join('\n');
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script, project, output], {
        cwd: project, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    let current;
    for (const label of ['current', 'v3', 'v4']) {
        const inventoryRoot = path.join(output, label);
        const ledgerFile = path.join(inventoryRoot, 'history.json'), receiptFile = path.join(inventoryRoot, 'history.receipt.json');
        const ledgerRaw = fs.readFileSync(ledgerFile), receiptRaw = fs.readFileSync(receiptFile);
        const prior = JSON.parse(ledgerRaw), priorReceipt = JSON.parse(receiptRaw);
        const handle = api.loadHistoricalInventoryHandle({ inventoryRoot, ledgerName: 'history.json', receiptName: 'history.receipt.json' });
        const snapshot = api.inventoryHandleSnapshot(handle);
        assert.deepEqual(snapshot.ledger, prior);
        assert.deepEqual(snapshot.receipt, priorReceipt);
        assert.equal(snapshot.ledgerFileSha256, sha(ledgerRaw));
        assert.equal(snapshot.receiptFileSha256, sha(receiptRaw));
        assert.equal(snapshot.receipt.ledger.fileSha256, sha(ledgerRaw));
        assert.equal(snapshot.ledger.pages.length, 4);
        assert.equal(snapshot.ledger.pageSetSha256, api.stableHash(prior.pages));
        assert.deepEqual(fs.readFileSync(ledgerFile), ledgerRaw);
        assert.deepEqual(fs.readFileSync(receiptFile), receiptRaw);
        if (label === 'current') {
            const oldV5 = structuredClone(prior);
            oldV5.policy.contract = 'historical-page-scan-policy-v5';
            oldV5.policy.identityHints = 'frontmatter-filename-explicit-links-v1';
            rehashLedger(oldV5);
            const unchanged = JSON.stringify(oldV5);
            assert.deepEqual(api.validateHistoricalLedger(oldV5), oldV5);
            assert.equal(JSON.stringify(oldV5), unchanged);
        }
        const newFormat = label === 'current';
        assert.equal(prior.policy.contract, 'historical-page-scan-policy-' + (newFormat ? 'v6' : label));
        for (const page of prior.pages) {
            assert.equal(page.contentSha256, sha(fs.readFileSync(path.join(output, 'fixture-blog', page.path))));
            assert.equal(Object.hasOwn(page, 'legacyTagRouteCandidates'), newFormat);
            assert.equal(Object.hasOwn(page, 'legacyTaxonomyCandidates'), !newFormat);
            for (const candidate of page[newFormat ? 'legacyTagRouteCandidates' : 'legacyTaxonomyCandidates']) {
                assert.equal(Object.hasOwn(candidate, 'routeGroup'), newFormat);
                assert.equal(Object.hasOwn(candidate, 'taxonomy'), !newFormat);
                assert.equal(candidate.status, 'unverified');
            }
        }
        const byId = new Map(prior.pages.map(page => [page.pageId, page]));
        for (const link of prior.outboundPostLinks) if (link.status === 'resolved') {
            assert.equal(link.targetRecordSha256, byId.get(link.targetPageId).snapshotSha256);
        }
        if (newFormat) current = prior;
    }
    for (const value of [null, structuredClone(current.pages[0].legacyTagRouteCandidates)]) {
        const mixed = structuredClone(current);
        mixed.pages[0].legacyTaxonomyCandidates = value;
        bindRouteTestLedger(mixed);
        assert.throws(() => api.validateHistoricalLedger(mixed), /页面不能混用新旧标签链接候选字段/);
    }
    for (const value of [null, 'tags']) {
        const mixed = structuredClone(current);
        const candidate = mixed.pages.flatMap(page => page.legacyTagRouteCandidates).find(route => route.routeGroup === 'tags');
        candidate.taxonomy = value;
        bindRouteTestLedger(mixed);
        assert.throws(() => api.validateHistoricalLedger(mixed), /候选不能混用新旧路由分组字段/);
        const broken = structuredClone(mixed); broken.ledgerSha256 = sha('bad original self');
        assert.throws(() => api.validateHistoricalLedger(broken), /ledger self-SHA drifted/);
    }
    const wrong = structuredClone(current);
    wrong.policy = JSON.parse(fs.readFileSync(path.join(output, 'v4', 'history.json'))).policy;
    bindRouteTestLedger(wrong);
    assert.throws(() => api.validateHistoricalLedger(wrong), /与扫描策略不一致/);
    const unknown = structuredClone(current); unknown.policy.contract = 'historical-page-scan-policy-unknown';
    bindRouteTestLedger(unknown);
    assert.throws(() => api.validateHistoricalLedger(unknown), /历史页面扫描策略不受支持/);
    const inventoryRoot = path.join(output, 'current');
    fs.appendFileSync(path.join(inventoryRoot, 'history.json'), ' ');
    assert.throws(() => api.loadHistoricalInventoryHandle({ inventoryRoot, ledgerName: 'history.json', receiptName: 'history.receipt.json' }),
        /receipt does not bind the exact ledger/);
});

test('prepare 只挑出没有标题与正文的论文页，试运行不写盘，apply 使用安全模式', t => {
    const f = fixture(t); const roots = { inventoryRoot: f.inventory, crosswalkRoot: f.crosswalk };
    const args = ['prepare', '--dry-run', '--ledger', f.ledgerName, '--receipt', f.receiptName, '--crosswalk', ids[0]];
    const dry = cli.main(args, { roots, now: stamp });
    assert.equal(dry.status, 'dry-run'); assert.equal(dry.total, 1); assert.equal(fs.existsSync(f.crosswalk), false);
    const applied = cli.main(['prepare', '--apply', ...args.slice(2)], { roots, now: stamp });
    assert.equal(applied.status, 'prepared');
    const directory = path.join(f.crosswalk, ids[0]);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, 'decisions')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, 'state.json')).mode & 0o777, 0o600);
    const stateBytes = fs.readFileSync(path.join(directory, 'state.json'));
    assert.doesNotMatch(stateBytes.toString(), /SECRET OLD BODY|title/i);
    const state = api.readCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0] });
    assert.equal(Object.values(state.assignments)[0].status, 'pending'); assert.deepEqual(state.identityGroups, []);
    assert.equal(Object.keys(state.assignments)[0], f.ledger.pages.find(page => page.kind === 'paper').pageId);
    const status = cli.main(['status', '--crosswalk', ids[0]], { roots });
    assert.equal(status.status, 'valid'); assert.equal(status.pending, 1);
});

test('prepare 回滚注入的 EIO，且只恢复可核验的已知半成品', t => {
    const f = fixture(t); const handle = load(f);
    for (const [offset, stage] of ['afterDirectoryCreate', 'afterDecisionsCreate', 'afterStateWrite'].entries()) {
        const crosswalkId = ids[offset + 3];
        assert.throws(() => api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
            crosswalkId, now: stamp, apply: true, testHooks: { [stage]: () => { throw eio(stage); } } }),
        /injected EIO/);
        const recovered = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
            crosswalkId, now: stamp, apply: true });
        assert.equal(recovered.completion.pending, 1);
        assert.equal(api.readCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId }).stateSha256,
            recovered.stateSha256);
    }

    const emptyId = ids[6]; const emptyDirectory = path.join(f.crosswalk, emptyId);
    fs.mkdirSync(emptyDirectory, { mode: 0o700 });
    assert.equal(api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: emptyId, now: stamp, apply: true }).completion.pending, 1);

    const decisionsId = ids[7]; const decisionsDirectory = path.join(f.crosswalk, decisionsId);
    fs.mkdirSync(decisionsDirectory, { mode: 0o700 });
    fs.mkdirSync(path.join(decisionsDirectory, 'decisions'), { mode: 0o700 });
    assert.equal(api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: decisionsId, now: stamp, apply: true }).completion.pending, 1);

    const stateId = ids[8]; const stateDirectory = path.join(f.crosswalk, stateId);
    fs.mkdirSync(stateDirectory, { mode: 0o700 });
    const initial = api.buildInitialState(handle, { crosswalkId: stateId, now: stamp });
    fs.writeFileSync(path.join(stateDirectory, 'state.json'), api.prettyBytes(initial), { mode: 0o600 });
    assert.equal(api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: stateId, now: stamp, apply: true }).stateSha256, initial.stateSha256);

    const unknownId = ids[9]; const unknownDirectory = path.join(f.crosswalk, unknownId);
    fs.mkdirSync(unknownDirectory, { mode: 0o700 }); fs.writeFileSync(path.join(unknownDirectory, 'unknown'), 'x');
    assert.throws(() => api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: unknownId, now: stamp, apply: true }), /unknown content/);

    const linkedId = ids[10]; const linkedDirectory = path.join(f.crosswalk, linkedId);
    fs.mkdirSync(linkedDirectory, { mode: 0o700 }); fs.symlinkSync(f.inventory, path.join(linkedDirectory, 'decisions'));
    assert.throws(() => api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: handle,
        crosswalkId: linkedId, now: stamp, apply: true }), /unsafe directory/);
});

test('决定写入绑定 CAS、只追加，并以精确操作证据保证幂等', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildDecisionArtifact({ state, pageKey, operationId: ids[1], actorId: 'reviewer.1',
        status: 'needs-review', reason: 'source identity needs explicit authority', now: stamp });
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'review.json', artifact });
    const handle = api.loadDecisionHandle(decisionFile);
    const updated = api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle: handle,
        owner: 'worker.1', now: stamp });
    assert.equal(updated.completion.needsReview, 1); assert.equal(updated.attempts.length, 1);
    const viaCli = cli.main(['apply', '--crosswalk', ids[0], '--decision', 'review.json', '--owner', 'worker.1'],
        { roots: { inventoryRoot: f.inventory, crosswalkRoot: f.crosswalk }, now: stamp });
    assert.equal(viaCli.status, 'updated'); assert.equal(viaCli.attempts, 1);
    assert.equal(api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle: handle,
        owner: 'worker.1', now: stamp }).attempts.length, 1);
    const different = { ...artifact, result: { status: 'blocked', reason: 'different' } };
    different.artifactSha256 = api.stableHash(Object.fromEntries(Object.entries(different).filter(([key]) => key !== 'artifactSha256')));
    const secondFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'different.json', artifact: different });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionHandle: api.loadDecisionHandle(secondFile), owner: 'worker' }), /different decision evidence/);
    const staleState = api.buildInitialState(load(f), { crosswalkId: ids[0], now: stamp });
    const stale = api.buildDecisionArtifact({ state: staleState, pageKey, operationId: ids[2], actorId: 'reviewer',
        status: 'conflict', reason: 'conflict', now: stamp });
    const staleFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'stale.json', artifact: stale });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionHandle: api.loadDecisionHandle(staleFile), owner: 'worker' }), /compare-and-swap/);
    fs.appendFileSync(decisionFile, ' ');
    assert.throws(() => api.readCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0] }), /replay drifted/);
});

test('操作锁绝不抢占存活 PID，拒绝刚死、符号链接、多余或被篡改的证据', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildDecisionArtifact({ state, pageKey, operationId: ids[1], actorId: 'reviewer',
        status: 'needs-review', reason: 'review', now: stamp });
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'review.json', artifact }); const decisionHandle = api.loadDecisionHandle(decisionFile);
    const directory = path.join(f.crosswalk, ids[0]); const lockPath = path.join(directory, 'operation.lock');

    const live = api.acquireLock(directory, 'live.owner', stamp);
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /locked by a live process/);
    api.releaseLock(live); assert.equal(fs.existsSync(lockPath), false);

    const fresh = new Date().toISOString(); writeOperationLock(directory, { startedAt: fresh, heartbeatAt: fresh });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /dead process but is not stale/);
    fs.rmSync(lockPath, { recursive: true });

    fs.symlinkSync(f.inventory, lockPath);
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /not a canonical directory/);
    fs.unlinkSync(lockPath);

    writeOperationLock(directory, { extra: true });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /unknown or missing evidence/);
    fs.rmSync(lockPath, { recursive: true });

    const tampered = writeOperationLock(directory);
    const changed = { ...tampered.owner, owner: 'changed.owner' };
    fs.writeFileSync(tampered.ownerFile, api.prettyBytes(changed), { mode: 0o600 });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp }), /self-SHA drifted/);
});

test('只有本机已死 PID 留下的、经核验的过期锁才会被回收', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildDecisionArtifact({ state, pageKey, operationId: ids[1], actorId: 'reviewer',
        status: 'needs-review', reason: 'review', now: stamp });
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'review.json', artifact }); const decisionHandle = api.loadDecisionHandle(decisionFile);
    const directory = path.join(f.crosswalk, ids[0]); const stale = writeOperationLock(directory);
    const updated = api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp });
    assert.equal(updated.completion.needsReview, 1); assert.equal(updated.attempts.length, 1);
    assert.equal(fs.existsSync(stale.lock), false);
    assert.equal(fs.existsSync(path.join(directory, 'operation.lock.reclaim')), false);
});

test('只有严格的同主机已死持有者才允许本地抓取恢复能力绕过租约', t => {
    const f = fixture(t); api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true });
    const directory = path.join(f.crosswalk, ids[0]); const lockPath = path.join(directory, 'operation.lock');
    const fresh = new Date().toISOString();
    const policies = [api.HISTORICAL_LOCAL_CRAWL_BATCH_LOCK_RECOVERY,
        api.HISTORICAL_CONFERENCE_CRAWL_BATCH_LOCK_RECOVERY];
    for (const [index, recoveryPolicy] of policies.entries()) {
        writeOperationLock(directory, { pid: 99999999, startedAt: fresh, heartbeatAt: fresh });
        assert.throws(() => api.acquireLock(directory, 'ordinary.worker', stamp), /not stale/);
        const handle = api.acquireLock(directory, `local.worker.${index}`, stamp, { recoveryPolicy });
        api.releaseLock(handle); assert.equal(fs.existsSync(lockPath), false);
    }

    writeOperationLock(directory, { pid: 99999999, startedAt: fresh, heartbeatAt: fresh });
    assert.throws(() => api.acquireLock(directory, 'forged.worker', stamp,
        { recoveryPolicy: Symbol('historical-local-crawl-batch-local-dead-owner-recovery-v1') }), /not stale/);
    fs.rmSync(lockPath, { recursive: true });

    writeOperationLock(directory, { pid: process.pid, startedAt: fresh, heartbeatAt: fresh });
    assert.throws(() => api.acquireLock(directory, 'live.worker', stamp,
        { recoveryPolicy: api.HISTORICAL_LOCAL_CRAWL_BATCH_LOCK_RECOVERY }), /live process/);
    fs.rmSync(lockPath, { recursive: true });

    writeOperationLock(directory, { pid: 99999999, hostname: `${os.hostname()}-remote`, startedAt: fresh, heartbeatAt: fresh });
    assert.throws(() => api.acquireLock(directory, 'remote.worker', stamp,
        { recoveryPolicy: api.HISTORICAL_LOCAL_CRAWL_BATCH_LOCK_RECOVERY }), /not stale/);
    fs.rmSync(lockPath, { recursive: true });

    fs.mkdirSync(lockPath, { mode: 0o700 });
    assert.throws(() => api.acquireLock(directory, 'empty.worker', stamp,
        { recoveryPolicy: api.HISTORICAL_LOCAL_CRAWL_BATCH_LOCK_RECOVERY }), /unknown or missing evidence/);
    fs.rmSync(lockPath, { recursive: true });

    const malformed = writeOperationLock(directory, { pid: 99999999, startedAt: fresh, heartbeatAt: fresh });
    fs.writeFileSync(malformed.ownerFile, api.prettyBytes({ ...malformed.owner, owner: 'mutated.owner' }), { mode: 0o600 });
    assert.throws(() => api.acquireLock(directory, 'malformed.worker', stamp,
        { recoveryPolicy: api.HISTORICAL_LOCAL_CRAWL_BATCH_LOCK_RECOVERY }), /self-SHA drifted/);
});

test('远端锁只有在租约到期且核验通过后才回收', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildDecisionArtifact({ state, pageKey, operationId: ids[1], actorId: 'reviewer',
        status: 'needs-review', reason: 'review', now: stamp });
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'review.json', artifact }); const decisionHandle = api.loadDecisionHandle(decisionFile);
    const directory = path.join(f.crosswalk, ids[0]); const stale = writeOperationLock(directory, {
        hostname: `${os.hostname()}-remote`
    });
    const updated = api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle,
        owner: 'worker', now: stamp });
    assert.equal(updated.completion.needsReview, 1);
    assert.equal(fs.existsSync(stale.lock), false);
    assert.equal(fs.existsSync(path.join(directory, 'operation.lock.reclaim')), false);
});

test('SIGINT 只释放子进程持有的锁，规范状态字节保持不变', async t => {
    const f = fixture(t); api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true });
    const directory = path.join(f.crosswalk, ids[0]);
    const stateFile = path.join(directory, 'state.json'); const stateBytes = fs.readFileSync(stateFile);
    const holder = spawnLockHolder(directory);
    t.after(() => { if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill('SIGKILL'); });
    await holder.ready;
    assert.equal(fs.existsSync(path.join(directory, 'operation.lock')), true);
    holder.child.kill('SIGINT');
    const [code, signal] = await once(holder.child, 'exit');
    assert.deepEqual({ code, signal }, { code: 130, signal: null });
    assert.equal(fs.existsSync(path.join(directory, 'operation.lock')), false);
    assert.deepEqual(fs.readFileSync(stateFile), stateBytes);
    assert.equal(fs.readdirSync(directory).some(name => /^\.state\..+\.tmp$/.test(name)), false);
});

test('SIGTERM 走同样的精确持有者清理，并以 143 退出', async t => {
    const f = fixture(t); api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[2], now: stamp, apply: true });
    const directory = path.join(f.crosswalk, ids[2]); const holder = spawnLockHolder(directory);
    t.after(() => { if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill('SIGKILL'); });
    await holder.ready; holder.child.kill('SIGTERM');
    const [code, signal] = await once(holder.child, 'exit');
    assert.deepEqual({ code, signal }, { code: 143, signal: null });
    assert.equal(fs.existsSync(path.join(directory, 'operation.lock')), false);
});

test('同步替换状态期间收到 SIGINT 也不会撕裂原子状态', async t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk,
        inventoryHandle: load(f), crosswalkId: ids[5], now: stamp, apply: true });
    const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildDecisionArtifact({ state, pageKey, operationId: ids[6], actorId: 'reviewer',
        status: 'needs-review', reason: 'signal-window', now: stamp });
    api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[5],
        decisionName: 'signal-window.json', artifact });
    const writer = spawnStateWriter(f.crosswalk, ids[5], 'signal-window.json');
    t.after(() => { if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill('SIGKILL'); });
    await writer.inWindow;
    writer.child.kill('SIGINT');
    const [code, signal] = await once(writer.child, 'exit');
    assert.deepEqual({ code, signal }, { code: 130, signal: null });
    const replayed = api.readCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[5] });
    assert.equal(replayed.attempts.length, 1);
    assert.equal(replayed.assignments[pageKey].status, 'needs-review');
    const directory = path.join(f.crosswalk, ids[5]);
    assert.equal(fs.existsSync(path.join(directory, 'operation.lock')), false);
    assert.equal(fs.readdirSync(directory).some(name => /^\.state\..+\.tmp$/.test(name)), false);
});

test('SIGINT 拒绝替换持有者文件 inode，也拒绝并发替换锁持有者', async t => {
    await t.test('持有者 inode 被换成字节相同的文件', async tt => {
        const f = fixture(tt); api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
            crosswalkId: ids[3], now: stamp, apply: true });
        const directory = path.join(f.crosswalk, ids[3]); const lockPath = path.join(directory, 'operation.lock');
        const holder = spawnLockHolder(directory);
        tt.after(() => { if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill('SIGKILL'); });
        await holder.ready;
        const ownerPath = path.join(lockPath, 'owner.json'); const ownerBytes = fs.readFileSync(ownerPath);
        fs.renameSync(ownerPath, path.join(directory, 'displaced-owner.json'));
        fs.writeFileSync(ownerPath, ownerBytes, { mode: 0o600 });
        holder.child.kill('SIGINT');
        const [code] = await once(holder.child, 'exit');
        assert.equal(code, 130); assert.equal(fs.existsSync(lockPath), true);
        assert.deepEqual(fs.readFileSync(ownerPath), ownerBytes);
    });

    await t.test('操作锁目录被另一个存活持有者替换', async tt => {
        const f = fixture(tt); api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
            crosswalkId: ids[4], now: stamp, apply: true });
        const directory = path.join(f.crosswalk, ids[4]); const lockPath = path.join(directory, 'operation.lock');
        const holder = spawnLockHolder(directory);
        tt.after(() => { if (holder.child.exitCode === null && holder.child.signalCode === null) holder.child.kill('SIGKILL'); });
        await holder.ready;
        fs.renameSync(lockPath, path.join(directory, 'displaced-operation.lock'));
        const replacement = writeOperationLock(directory, { pid: process.pid,
            startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
        const replacementBytes = fs.readFileSync(replacement.ownerFile);
        holder.child.kill('SIGINT');
        const [code] = await once(holder.child, 'exit');
        assert.equal(code, 130); assert.equal(fs.existsSync(lockPath), true);
        assert.deepEqual(fs.readFileSync(replacement.ownerFile), replacementBytes);
    });
});

test('自造的 arXiv 夹具无法在核心 API 或独立 CLI 进程中授权已核验的决定', t => {
    const f = fixture(t); const authorityRoot = path.join(f.root, 'authorities');
    const authorityHandle = writeArxivAuthority(authorityRoot);
    const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    assert.throws(() => api.buildDecisionArtifact({ state, pageKey, actorId: 'reviewer', status: 'verified',
        reason: 'forged', now: stamp }), /authenticated paper source authority/);
    assert.throws(() => api.buildVerifiedDecisionArtifact({ state, pageKey, authorityHandle,
        operationId: ids[1], actorId: 'reviewer', now: stamp }), /production-authorized/);
    const roots = { inventoryRoot: f.inventory, crosswalkRoot: f.crosswalk, authorityRoot };
    assert.throws(() => cli.main(['apply-verified', '--crosswalk', ids[0], '--decision', 'verified.json',
        '--authority', 'authority.json', '--owner', 'worker'], { roots, now: stamp }), /fixture bundles cannot verify history/);
    const child = spawnSync(process.execPath, ['-e', [
        'const cli=require(process.argv[1]);',
        'const roots=JSON.parse(process.argv[2]);',
        'try { cli.main(["apply-verified","--crosswalk",process.argv[3],"--decision","verified.json",',
        '"--authority","authority.json","--owner","worker"], { roots }); process.exit(0); }',
        'catch (error) { console.error(error.message); process.exit(9); }'
    ].join(''), path.join(__dirname, '..', 'scripts', 'page-source-crosswalk.js'), JSON.stringify(roots), ids[0]],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    assert.equal(child.status, 9); assert.match(child.stderr, /fixture bundles cannot verify history/);

    // 早期宽松实现写下的状态，
    // 不能被当成合法记录带进生产环境的最终凭证。
    const snapshot = authorityApi.authorityHandleSnapshot(authorityHandle);
    const sourceAuthority = { paperId: snapshot.authority.paperId, identity: snapshot.authority.identity,
        identitySha256: snapshot.authority.identitySha256, identityRecordSha256: snapshot.authority.identityRecordSha256,
        authorityContract: snapshot.authority.contract, authorityName: snapshot.authorityName,
        authorityFileSha256: snapshot.authorityFileSha256, authoritySha256: snapshot.authority.authoritySha256,
        evidenceKind: snapshot.authority.evidenceKind, fulltextSha256: snapshot.fulltextSha256,
        sourceSnapshotSha256: snapshot.sourceSnapshotSha256 };
    const decisionBody = { contract: api.DECISION_CONTRACT, version: 1, crosswalkId: ids[0], operationId: ids[1],
        expectedStateSha256: state.stateSha256, pageKey, pagePath: state.assignments[pageKey].pagePath,
        pageContentSha256: state.assignments[pageKey].pageContentSha256, actorId: 'legacy.writer',
        result: { status: 'verified', reason: 'legacy fixture' }, sourceAuthority, createdAt: stamp };
    const decision = { ...decisionBody, artifactSha256: api.stableHash(decisionBody) };
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'legacy-verified.json', artifact: decision });
    const legacy = structuredClone(state);
    legacy.assignments[pageKey] = { ...legacy.assignments[pageKey], status: 'verified', reason: 'legacy fixture',
        decisionArtifactSha256: decision.artifactSha256, sourceAuthority };
    legacy.completion = api.completionFor(legacy.assignments);
    legacy.identityGroups = api.identityGroupsFor(legacy.assignments);
    legacy.identityGroupsSha256 = api.stableHash(legacy.identityGroups);
    const attempt = { operationId: ids[1], decisionName: path.basename(decisionFile),
        decisionFileSha256: sha(fs.readFileSync(decisionFile)), decisionArtifactSha256: decision.artifactSha256,
        pageKey, fromStatus: 'pending', toStatus: 'verified', reason: 'legacy fixture', actorId: 'legacy.writer',
        sourceAuthority, recordedAt: stamp, priorStateSha256: state.stateSha256, nextStateSha256: '' };
    legacy.attempts.push(attempt);
    const digestBody = structuredClone(legacy); delete digestBody.stateSha256;
    digestBody.attempts = digestBody.attempts.map(({ nextStateSha256: _next, ...item }) => item);
    legacy.stateSha256 = api.stableHash(digestBody); attempt.nextStateSha256 = legacy.stateSha256;
    const checkedLegacy = api.assertCrosswalkState(legacy);
    fs.writeFileSync(path.join(f.crosswalk, ids[0], 'state.json'), api.prettyBytes(checkedLegacy), { mode: 0o600 });
    assert.throws(() => api.finalizeCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], authorityRoot }),
        /production-authorized/);
    assert.equal(fs.existsSync(path.join(f.crosswalk, ids[0], 'final-receipt.json')), false);
});

test('arXiv 官方适配器授权可以驱动已核验的来源对照 CLI 路径', async t => {
    const f = fixture(t); const authorityRoot = path.join(f.root, 'authorities');
    const originalFetch = deep.fetchArxivTextDetailedUncached;
    t.after(() => { deep.fetchArxivTextDetailedUncached = originalFetch; });
    const text = `${'official methods experiments results limitations and references '.repeat(300)}\n`;
    const flattenedTextSha256 = sha(text);
    const artifactBody = { version: 1, source: 'arxiv_html', tables: [], formulas: [], flattenedTextSha256 };
    deep.fetchArxivTextDetailedUncached = async () => ({ text, source: 'html', sourceId: '2601.00001',
        htmlAvailability: 'available', htmlAttempts: 1, warnings: [], imageInfos: [],
        structuredArtifacts: { ...artifactBody, payloadSha256: sha(JSON.stringify(artifactBody)) } });
    const produced = await arxivAdapter.prepareArxivSourceAuthority({ authorityRoot, arxivId: '2601.00001',
        authorityName: 'arxiv-2601.00001.json', apply: true, now: stamp, operationId: ids[2] });
    const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true });
    const pageKey = Object.keys(state.assignments)[0];
    assert.equal(authorityApi.authorityHandleSnapshot(produced.authorityHandle).productionAuthorized, true);
    const output = await arxivCli.main(['--apply', '--id', '2601.00001', '--authority', 'arxiv-2601.00001.json',
        '--crosswalk', ids[0], '--page-key', pageKey, '--decision', 'official-verified.json', '--owner', 'official.adapter'],
    { files: { paperSourceAuthorityDir: authorityRoot, pageSourceCrosswalkDir: f.crosswalk } });
    assert.equal(output.productionAuthorized, true); assert.equal(output.crosswalk.verified, 1);
    assert.equal(output.crosswalk.completion, 'complete');
});

test('显式冲突解决器只接受已存在、非标题且带精确生产授权的提示', async t => {
    const f = fixture(t); useArxivConflictHints(f); const authorityRoot = path.join(f.root, 'authorities');
    const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true });
    const pageKey = Object.keys(state.assignments)[0];
    const originalFetch = deep.fetchArxivTextDetailedUncached;
    t.after(() => { deep.fetchArxivTextDetailedUncached = originalFetch; });
    let calls = 0; const text = `${'official conflict resolution source evidence '.repeat(400)}\n`;
    const flattenedTextSha256 = sha(text);
    const artifactBody = { version: 1, source: 'arxiv_html', tables: [], formulas: [], flattenedTextSha256 };
    deep.fetchArxivTextDetailedUncached = async id => {
        calls += 1;
        return { text, source: 'html', sourceId: id, htmlAvailability: 'available', htmlAttempts: 1,
            warnings: [], imageInfos: [], structuredArtifacts: { ...artifactBody,
                payloadSha256: sha(JSON.stringify(artifactBody)) } };
    };
    const common = ['--apply', '--crosswalk', ids[0], '--page-key', pageKey, '--scheme', 'arxiv',
        '--authority', 'arxiv-2601.00001.json', '--decision', 'resolved.json', '--owner', 'operator.1',
        '--operation-id', ids[1]];
    await assert.rejects(conflictCli.main([...common.slice(0, 7), '--value', '2601.99999', ...common.slice(7)],
        { files: { paperSourceAuthorityDir: authorityRoot, pageSourceCrosswalkDir: f.crosswalk } }),
    /not exactly one existing page hint/);
    assert.equal(calls, 0, 'invalid operator selection must fail before network access');

    const output = await conflictCli.main([...common.slice(0, 7), '--value', '2601.00001', ...common.slice(7)],
        { files: { paperSourceAuthorityDir: authorityRoot, pageSourceCrosswalkDir: f.crosswalk } });
    assert.equal(calls, 1); assert.equal(output.status, 'resolved');
    assert.equal(output.productionAuthorized, true); assert.equal(output.verified, 1);
    const updated = api.readCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0] });
    assert.equal(updated.assignments[pageKey].sourceAuthority.paperId, 'arxiv:2601.00001');
    assert.match(updated.assignments[pageKey].reason, /Operator selected existing non-title hint/);
});

test('冲突解决器拒绝单页、仅有持久化授权，以及授权与选择不匹配的情况', async t => {
    const single = fixture(t);
    const singleState = api.prepareCrosswalk({ crosswalkRoot: single.crosswalk, inventoryHandle: load(single),
        crosswalkId: ids[0], now: stamp, apply: true });
    const singlePageKey = Object.keys(singleState.assignments)[0];
    assert.throws(() => conflictResolver.assertConflictSelection({ state: singleState, pageKey: singlePageKey,
        selectedHint: { scheme: 'arxiv', value: '2601.00001' } }), /only allowed for conflict\/multiple/);

    const f = fixture(t); useArxivConflictHints(f, 'openreview-forum-id');
    const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[2], now: stamp, apply: true });
    const pageKey = Object.keys(state.assignments)[0];
    const durable = writeArxivAuthority(path.join(f.root, 'legacy-authority'));
    assert.throws(() => conflictResolver.buildConflictVerifiedDecisionArtifact({ state, pageKey,
        selectedHint: { scheme: 'arxiv', value: '2601.00001' }, authorityHandle: durable,
        operationId: ids[3], actorId: 'operator.2', now: stamp }), /production-authorized/);

    const authorityRoot = path.join(f.root, 'production-authority');
    const originalFetch = deep.fetchArxivTextDetailedUncached;
    t.after(() => { deep.fetchArxivTextDetailedUncached = originalFetch; });
    const text = `${'official mismatch source evidence '.repeat(500)}\n`; const flattenedTextSha256 = sha(text);
    const artifactBody = { version: 1, source: 'arxiv_html', tables: [], formulas: [], flattenedTextSha256 };
    deep.fetchArxivTextDetailedUncached = async id => ({ text, source: 'html', sourceId: id,
        htmlAvailability: 'available', htmlAttempts: 1, warnings: [], imageInfos: [],
        structuredArtifacts: { ...artifactBody, payloadSha256: sha(JSON.stringify(artifactBody)) } });
    const production = await arxivAdapter.prepareArxivSourceAuthority({ authorityRoot, arxivId: '2601.00001',
        authorityName: 'arxiv-2601.00001.json', apply: true, now: stamp, operationId: ids[4] });
    assert.throws(() => conflictResolver.buildConflictVerifiedDecisionArtifact({ state, pageKey,
        selectedHint: { scheme: 'openreview-forum-id', value: 'Forum_000002' },
        authorityHandle: production.authorityHandle, operationId: ids[5], actorId: 'operator.2', now: stamp }),
    /does not exactly match/);
});

test('归档抓取身份授权可以结清一条精确的归档 arXiv 提示，但不会升级为全文授权', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true });
    const dataRoot = path.join(f.root, 'data'); const archiveDirectory = path.join(dataRoot, 'archive', '2026-01-01');
    const identityRoot = path.join(f.root, 'archive-identities'); fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
    const record = { arxivId: '2601.00001', paper_id: '2601.00001', title: 'Retained crawl title',
        abstract: 'Retained crawler metadata only.', authors: ['Author'], categories: ['cs.SD'], source: 'arxiv', sources: ['arxiv'] };
    fs.writeFileSync(path.join(archiveDirectory, 'filtered-papers.json'), JSON.stringify({ papers: [record] }), { mode: 0o600 });
    const index = archiveCrawlAuthorityApi.scanRetainedFilteredPapers({ dataRoot });
    const prepared = archiveCrawlAuthorityApi.prepareArchiveCrawlAuthority({ identityRoot, dataRoot, arxivId: '2601.00001',
        match: index.matches.get('2601.00001')[0], apply: true });
    const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildVerifiedDecisionArtifact({ state, pageKey, authorityHandle: prepared.authorityHandle,
        operationId: ids[1], actorId: 'archive-crawl.test', now: stamp });
    assert.equal(artifact.sourceAuthority.authorityContract, archiveCrawlAuthorityApi.CONTRACT);
    assert.equal(artifact.sourceAuthority.evidenceKind, archiveCrawlAuthorityApi.EVIDENCE_KIND);
    assert.equal('fulltextSha256' in artifact.sourceAuthority, false);
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'archive-crawl-exact.json', artifact });
    const applied = api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionHandle: api.loadDecisionHandle(decisionFile, { authorityHandle: prepared.authorityHandle }),
        owner: 'archive-crawl.test', now: stamp });
    assert.equal(applied.assignments[pageKey].status, 'verified');
    assert.throws(() => authorityApi.authorityHandleSnapshot(prepared.authorityHandle), /authenticated paper source authority/);
});

test('当前本地抓取授权的收尾分别走本地、旧版和快照三个根目录', t => {
    const f = fixture(t); const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const dataRoot = path.join(f.root, 'data'); const current = path.join(dataRoot, 'current'); const authorityRoot = path.join(f.root, 'paper-authorities');
    const identityRoot = path.join(f.root, 'local-identities'); const snapshotRoot = path.join(f.root, 'local-snapshots'); const legacyRoot = path.join(f.root, 'legacy-identities');
    fs.mkdirSync(current, { recursive: true, mode: 0o700 }); fs.mkdirSync(authorityRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(current, 'papers.json'), JSON.stringify({ papers: { '2601.00001': {
        arxivId: '2601.00001', title: 'not identity evidence', analysis: { generated: true } } } }), { mode: 0o600 });
    const match = localCrawlAuthorityApi.scanLocalCrawlPapers({ dataRoot }).matches.get('2601.00001')[0];
    const prepared = localCrawlAuthorityApi.prepareLocalCrawlAuthority({ identityRoot, snapshotRoot, dataRoot, arxivId: '2601.00001', match, apply: true });
    const artifact = api.buildVerifiedDecisionArtifact({ state, pageKey, authorityHandle: prepared.authorityHandle,
        operationId: ids[1], actorId: 'local-crawl.test', now: stamp });
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionName: 'local-crawl.json', artifact });
    api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionHandle: api.loadDecisionHandle(decisionFile,
        { authorityHandle: prepared.authorityHandle }), owner: 'local-crawl.test', now: stamp });
    const finalized = api.finalizeCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], authorityRoot,
        archiveIdentityRoot: legacyRoot, archiveDataRoot: dataRoot, localCrawlIdentityRoot: identityRoot,
        localCrawlSnapshotRoot: snapshotRoot, localCrawlDataRoot: dataRoot });
    assert.equal(finalized.receipt.verified, 1);
    fs.writeFileSync(path.join(current, 'papers.json'), JSON.stringify({ papers: { '2602.00001': { arxivId: '2602.00001' } } }), { mode: 0o600 });
    assert.equal(api.readFinalReceipt({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], authorityRoot,
        archiveIdentityRoot: legacyRoot, archiveDataRoot: dataRoot, localCrawlIdentityRoot: identityRoot,
        localCrawlSnapshotRoot: snapshotRoot, localCrawlDataRoot: dataRoot }).receipt.receiptSha256, finalized.receipt.receiptSha256);
});

test('留存的本地会议抓取元数据与 PDF 授权可核验一条精确的 OpenReview 页面提示', t => {
    const f = fixture(t); useOpenReviewHint(f); const dataRoot = path.join(f.root, 'data');
    const current = path.join(dataRoot, 'current'); const pdfRoot = path.join(dataRoot, 'pdfs', 'icml2026');
    fs.mkdirSync(current, { recursive: true, mode: 0o700 }); fs.mkdirSync(pdfRoot, { recursive: true, mode: 0o700 });
    const id = 'AbCdef_12'; const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    fs.writeFileSync(path.join(current, 'icml_2026_deep_analysis.json'), JSON.stringify({ papers: [{ id, title: 'Metadata only', fullText: 'not authority content' }] }), { mode: 0o600 });
    fs.writeFileSync(path.join(pdfRoot, `${id}.pdf`), pdf, { mode: 0o600 });
    for (const name of ['icassp_2026_deep_analyzers.json', 'iclr_2026_deep_analyzers.json']) {
        fs.writeFileSync(path.join(current, name), JSON.stringify({ papers: [] }), { mode: 0o600 });
    }
    const match = conferenceCrawlAuthorityApi.scanRetainedConferenceCrawlers({ dataRoot })
        .matches.get(`openreview-forum-id:${id}`)[0];
    const prepared = conferenceCrawlAuthorityApi.prepareConferenceCrawlAuthority({ identityRoot: path.join(f.root, 'conference-identities'), dataRoot, match, apply: true });
    const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f), crosswalkId: ids[0], now: stamp, apply: true });
    const pageKey = Object.keys(state.assignments)[0]; const artifact = api.buildVerifiedDecisionArtifact({ state, pageKey,
        authorityHandle: prepared.authorityHandle, operationId: ids[1], actorId: 'conference.local', now: stamp });
    assert.equal(artifact.sourceAuthority.authorityContract, conferenceCrawlAuthorityApi.CONTRACT);
    assert.equal(artifact.sourceAuthority.pdfSha256, match.pdfSha256);
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], decisionName: 'conference-local.json', artifact });
    const applied = api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], owner: 'conference.local', now: stamp,
        decisionHandle: api.loadDecisionHandle(decisionFile, { authorityHandle: prepared.authorityHandle }) });
    assert.equal(applied.assignments[pageKey].status, 'verified');
    assert.equal(conferenceCrawlAuthorityApi.replayAuthorityHandle(prepared.authorityHandle, { requireProduction: true }), prepared.authorityHandle);
});

test('已核验的会议决定复核锁定字节，最终凭证要求实时生产授权', t => {
    const f = fixture(t); useConferenceHint(f); const authorityRoot = path.join(f.root, 'authorities');
    const production = writeConferenceAuthority(t, authorityRoot);
    const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildVerifiedDecisionArtifact({ state, pageKey, authorityHandle: production.handle,
        operationId: ids[1], actorId: 'reviewer', now: stamp });
    const decisionFile = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'verified.json', artifact });
    assert.throws(() => api.loadDecisionHandle(decisionFile), /authenticated source authority/);
    const staleHandle = api.loadDecisionHandle(decisionFile, { authorityHandle: production.handle });
    const decisionBytes = fs.readFileSync(decisionFile); fs.renameSync(decisionFile, `${decisionFile}.old`);
    fs.writeFileSync(decisionFile, decisionBytes, { mode: 0o600 });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionHandle: staleHandle, owner: 'worker', now: stamp }), /decision file changed/);
    const authorityFile = path.join(authorityRoot, production.name); const authorityBytes = fs.readFileSync(authorityFile);
    fs.renameSync(authorityFile, `${authorityFile}.old`); fs.writeFileSync(authorityFile, authorityBytes, { mode: 0o600 });
    const authorityStaleDecision = api.loadDecisionHandle(decisionFile, { authorityHandle: production.handle });
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionHandle: authorityStaleDecision, owner: 'worker', now: stamp }), /changed after handle creation/);
    production.handle = authorityApi.loadAuthorityHandle({ authorityRoot, authorityName: production.name,
        conferencePlanHandle: production.fixture.planHandle, conferenceSourceRoot: production.fixture.sourceRoot });
    const updated = api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionHandle: api.loadDecisionHandle(decisionFile, { authorityHandle: production.handle }),
        owner: 'worker', now: stamp });
    assert.equal(updated.completion.status, 'complete'); assert.equal(updated.completion.verified, 1);
    assert.equal(updated.identityGroups.length, 1); assert.deepEqual(updated.identityGroups[0].pageKeys, [pageKey]);
    const result = api.finalizeCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], authorityRoot,
        authorityResolver: production.resolver });
    assert.equal(result.receipt.contract, api.FINAL_RECEIPT_CONTRACT);
    assert.equal(fs.statSync(result.receiptFile).mode & 0o777, 0o600);
    assert.throws(() => api.readFinalReceipt({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], authorityRoot }),
        /live authenticated plan handle|could not replay/);
    assert.equal(api.readFinalReceipt({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], authorityRoot,
        authorityResolver: production.resolver })
        .receipt.receiptSha256, result.receipt.receiptSha256);
    assert.equal(api.finalizeCrosswalk({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], authorityRoot,
        authorityResolver: production.resolver })
        .receipt.receiptSha256, result.receipt.receiptSha256);
    assert.equal(api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }).completion.status, 'complete');

    const titleOnly = structuredClone(state); titleOnly.source.papers[0].identityHints.candidates[0].sources = ['title'];
    assert.throws(() => api.buildVerifiedDecisionArtifact({ state: titleOnly, pageKey, authorityHandle: production.handle,
        actorId: 'reviewer' }), /title-only/);

    const conflict = structuredClone(state);
    conflict.source.papers[0].identityHints = { status: 'conflict', candidates: [
        { scheme: 'icassp-arnumber', value: '100', sources: ['filename'] },
        { scheme: 'icassp-arnumber', value: '101', sources: ['frontmatter:paper_id'] }
    ] };
    conflict.source.paperPageSetSha256 = api.stableHash(conflict.source.papers);
    const conflictBody = structuredClone(conflict); delete conflictBody.stateSha256;
    conflict.stateSha256 = api.stableHash(conflictBody);
    assert.throws(() => api.buildVerifiedDecisionArtifact({ state: conflict, pageKey, authorityHandle: production.handle,
        actorId: 'reviewer' }), /single unambiguous/);

    const tamperedReceipt = structuredClone(result.receipt);
    tamperedReceipt.identityGroups[0].identityRecordSha256 = 'f'.repeat(64);
    tamperedReceipt.identityGroupsSha256 = api.stableHash(tamperedReceipt.identityGroups);
    const tamperedBody = structuredClone(tamperedReceipt); delete tamperedBody.receiptSha256;
    tamperedReceipt.receiptSha256 = api.stableHash(tamperedBody);
    fs.writeFileSync(result.receiptFile, api.prettyBytes(tamperedReceipt), { mode: 0o600 });
    assert.throws(() => api.readFinalReceipt({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], authorityRoot,
        authorityResolver: production.resolver }), /groupSha256 drifted/);
    fs.writeFileSync(result.receiptFile, api.prettyBytes(result.receipt), { mode: 0o600 });
    fs.appendFileSync(path.join(authorityRoot, production.sourceContextName), ' ');
    assert.throws(() => api.readFinalReceipt({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0], authorityRoot,
        authorityResolver: production.resolver }), /proof file\/SHA drifted|canonical pretty JSON/);
});

test('跨页的同一规范身份归为一个确定分组，冲突记录一律拒绝', t => {
    const f = fixture(t); useConferenceHint(f); const authorityRoot = path.join(f.root, 'authorities');
    const production = writeConferenceAuthority(t, authorityRoot);
    const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true }); const pageKey = Object.keys(state.assignments)[0];
    const artifact = api.buildVerifiedDecisionArtifact({ state, pageKey, authorityHandle: production.handle,
        operationId: ids[1], actorId: 'reviewer', now: stamp });
    const secondKey = `page:${sha('second page')}`; const assignments = {
        [pageKey]: { ...state.assignments[pageKey], status: 'verified', reason: 'verified',
            decisionArtifactSha256: artifact.artifactSha256, sourceAuthority: artifact.sourceAuthority },
        [secondKey]: { pagePath: 'content/posts/second.md', pageContentSha256: sha('second'),
            status: 'verified', reason: 'verified', decisionArtifactSha256: artifact.artifactSha256,
            sourceAuthority: structuredClone(artifact.sourceAuthority) }
    };
    const groups = api.identityGroupsFor(assignments);
    assert.equal(groups.length, 1); assert.deepEqual(groups[0].pageKeys, [pageKey, secondKey].sort());
    const inconsistent = structuredClone(assignments);
    inconsistent[secondKey].sourceAuthority.identity.source = {
        status: 'official', url: 'https://example.test/papers/100'
    };
    inconsistent[secondKey].sourceAuthority.identityRecordSha256 = identityApi.recordSha256(
        inconsistent[secondKey].sourceAuthority.identity);
    assert.throws(() => api.identityGroupsFor(inconsistent), /conflicting identity record/);
    assert.equal(state.completion.pending, 1);
});

test('路径、链接、重复 JSON 和 CLI 语法有问题时直接失败，不写盘', t => {
    const f = fixture(t); const roots = { inventoryRoot: f.inventory, crosswalkRoot: f.crosswalk };
    assert.throws(() => cli.parseArgs(['prepare', '--dry-run', '--ledger', '../x.json', '--receipt', 'r.json']));
    assert.throws(() => cli.parseArgs(['status', '--crosswalk', '../x']));
    const linked = path.join(f.inventory, 'linked.json'); fs.symlinkSync(path.join(f.inventory, f.ledgerName), linked);
    assert.throws(() => api.loadHistoricalInventoryHandle({ inventoryRoot: f.inventory, ledgerName: 'linked.json',
        receiptName: f.receiptName }), /regular single-link/);
    fs.writeFileSync(path.join(f.inventory, 'duplicate.json'), '{"contract":"x","contract":"x"}\n');
    assert.throws(() => api.loadHistoricalInventoryHandle({ inventoryRoot: f.inventory, ledgerName: 'duplicate.json',
        receiptName: f.receiptName }), /duplicate JSON key/);
    assert.equal(fs.existsSync(f.crosswalk), false);
    const dry = cli.main(['prepare', '--dry-run', '--ledger', f.ledgerName, '--receipt', f.receiptName,
        '--crosswalk', ids[0]], { roots, now: stamp });
    assert.equal(dry.status, 'dry-run'); assert.equal(fs.existsSync(f.crosswalk), false);
});

// 下面两条断言守的是历史清单与 Python 扫描器之间的跨语言哈希一致性。两边各自算
// 一遍 pageSetSha256 / ledgerSha256 / receiptSha256，只有把同一份数据序列化成同一
// 串字节才算通过。现在没事靠的是两个隐含前提，前提失效不会报错，只会静默分歧。
const NON_BMP_KEY = /[\u{10000}-\u{10FFFF}]/u;

function collectKeys(value, prefix = 'root', found = []) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectKeys(item, `${prefix}[${index}]`, found));
    } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            if (NON_BMP_KEY.test(key) || /[^\x20-\x7e]/.test(key)) found.push(`${prefix}/${key}`);
            collectKeys(item, `${prefix}/${key}`, found);
        }
    }
    return found;
}

test('被哈希的历史清单键全部是 ASCII，非 ASCII 只出现在值里', t => {
    const f = fixture(t);
    const current = structuredClone(f.ledger);
    current.policy = { contract: 'historical-page-scan-policy-v5', bodyRetention: 'sha256-only',
        identityHints: 'frontmatter-filename-explicit-links-v1', outboundLinks: 'strict-balanced-inline-occurrences-v3',
        linkOffsetUnit: 'utf8-byte-body-relative', tagRoutes: 'unverified-candidates-v3',
        publicationEvidence: 'schema-checked-hash-default-whitelist-v4',
        targetRecordBinding: 'target-page-snapshot-sha256-v1' };
    rehashLedger(current);
    // 前提：清单、凭证、策略与 crosswalk 状态（含 counts 的 pending/needsReview）里
    // 所有被哈希的 map，键都是固定 ASCII 字面量。键一旦出现非 BMP 字符，JS 的 UTF-16
    // 码元排序与 Python 的码点排序就会给出不同顺序（U+1F600 的代理对首元 D83D 小于
    // U+FFFD），排序后的键进哈希，两端 SHA 分歧，表现为「ledger self-SHA drifted /
    // page set SHA drifted」而两边都自认正确。
    const state = api.buildInitialState(load(f), { crosswalkId: ids[0], now: stamp });
    assert.ok('pending' in state.completion && 'needsReview' in state.completion,
        'state.completion 必须带 pending/needsReview，否则这条断言没覆盖到被哈希的 counts 键');
    assert.deepEqual(collectKeys({ ledger: f.ledger, receipt: f.receipt, current, state }),
        [], '被哈希的键集合里出现了非 ASCII 键；非 BMP 键会让 JS 的码元序与 Python 的码点序分歧，跨语言哈希不再一致');
    assert.deepEqual(collectKeys({ [String.fromCodePoint(0x1F600)]: 1, ok: { [String.fromCodePoint(0x1F642)]: 2 } }).length,
        2, '键遍历器必须能认出注入的 emoji 键；认不出就说明这条断言是空的');
    // 值里本来就有中文（legacy 标签术语），用它确认断言区分的是键而不是值。
    const term = f.ledger.pages.flatMap(page => page.legacyTaxonomyCandidates).map(candidate => candidate.term);
    assert.ok(term.some(value => /[^\x20-\x7e]/.test(value)), '样本值里应当有中文，否则这条断言测不到「键与值的区别」');
});

test('历史页 crosswalk 的 number 证据前提：整型浮点双向拒绝，forceFloat 分支不可达', t => {
    const f = fixture(t);
    const withNumber = (value, valueType = 'number') => {
        const ledger = structuredClone(f.ledger);
        const paper = ledger.pages.find(page => page.kind === 'paper');
        const entry = paper.publicationEvidenceRefs.find(item => item.field === 'paper_digest_api_reader_contract');
        entry.valueType = valueType; entry.value = value; entry.valueSha256 = api.stableHash(value);
        rehashPage(paper); rehashLedger(ledger);
        return ledger;
    };
    // 前提：valueType == "number" 只接受非整型浮点。整数取值的浮点必须落到
    // valueType == "integer"（Python 的 _json_value 也是这么转的）。破坏它的后果：
    // JS 的 pythonJson 会走 forceFloat 分支把 7 写成 "7.0"，Python 的 json.dumps
    // 写 "7"，两端稳定哈希分歧（见下面的 intHash/floatHash 对比）。
    const integerLedger = withNumber(7);
    assert.throws(() => api.validateHistoricalLedger(integerLedger),
        /number publication evidence has the wrong value type/,
        'number 证据里的整数值必须被拒绝，否则 JS 的 forceFloat 分支会被走到，跨语言哈希分歧');
    assert.deepEqual(api.validateHistoricalLedger(withNumber(7.5)), withNumber(7.5),
        '非整型浮点才是 number 分支唯一可达的输入');

    const project = path.join(__dirname, '..');
    const floatInput = path.join(f.root, 'number-evidence-float.json');
    const intInput = path.join(f.root, 'number-evidence-int.json');
    fs.writeFileSync(floatInput, JSON.stringify(withNumber(7.5)));
    fs.writeFileSync(intInput, JSON.stringify(integerLedger));
    const script = [
        'import json,sys',
        'sys.path.insert(0, sys.argv[1])',
        'from historical_page_scan import validate_ledger, _publication_evidence, _page_snapshot_body, stable_hash',
        'validate_ledger(json.load(open(sys.argv[2], encoding="utf-8")))',
        // 整数值那份清单的 SHA 是 Node 用 forceFloat 算的（值写成 7.0），Python 复算
        // 得到的是 7，两边不一致。先用 Python 自己的口径把摘要补一致，才能把校验推进
        // 到证据类型分支，看到 Python 拒绝的是类型而不是摘要。
        'def rehash(ledger):',
        '    for page in ledger["pages"]:',
        '        page["snapshotSha256"]=stable_hash(_page_snapshot_body(page))',
        '        page["recordSha256"]=stable_hash({k:v for k,v in page.items() if k!="recordSha256"})',
        '    ledger["pageSetSha256"]=stable_hash(ledger["pages"])',
        '    ledger["ledgerSha256"]=stable_hash({k:v for k,v in ledger.items() if k!="ledgerSha256"})',
        '    return ledger',
        'rejected=None',
        'try:',
        '    validate_ledger(rehash(json.load(open(sys.argv[3], encoding="utf-8"))))',
        'except Exception as exc:',
        '    rejected=str(exc)',
        'frontmatter={"paper_digest_score":7.0,"paper_digest_reader_quality":6.5}',
        'int_evidence={"field":"paper_digest_score","valueType":"number","value":7,"valueSha256":"0"*64}',
        'float_evidence={"field":"paper_digest_score","valueType":"number","value":7.5,"valueSha256":"0"*64}',
        'print(json.dumps({"floatAccepted":True,"intRejected":rejected,',
        '    "frontmatterTypes":[[e["field"],e["valueType"],e["value"]] for e in _publication_evidence(frontmatter)],',
        '    "intHash":stable_hash(int_evidence),"floatHash":stable_hash(float_evidence)},ensure_ascii=False))',
    ].join('\n');
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script, path.join(project, 'scripts'),
        floatInput, intInput], { cwd: project, encoding: 'utf8' });
    assert.equal(result.status, 0, `Python 侧复核失败：${result.stderr}`);
    const python = JSON.parse(result.stdout);
    assert.equal(python.floatAccepted, true);
    assert.match(String(python.intRejected), /number publication evidence has the wrong value type/,
        'Python 的 number 分支也必须拒绝整数值，否则两端对同一份证据的取舍不同');
    assert.deepEqual(python.frontmatterTypes,
        [['paper_digest_reader_quality', 'number', 6.5], ['paper_digest_score', 'integer', 7]],
        'frontmatter 里的 7.0 必须先转成 integer，6.5 才留在 number');
    const intEvidence = { field: 'paper_digest_score', valueType: 'number', value: 7, valueSha256: '0'.repeat(64) };
    const floatEvidence = { field: 'paper_digest_score', valueType: 'number', value: 7.5, valueSha256: '0'.repeat(64) };
    assert.equal(python.floatHash, api.stableHash(floatEvidence),
        'number 分支唯一可达的输入（非整型浮点）两端必须同哈希');
    assert.notEqual(python.intHash, api.stableHash(intEvidence),
        '这就是要守的分歧：整数值走 number 分支时 JS 写 7.0、Python 写 7，两端稳定哈希不同');
});

function primaryHandoffFixture(t) {
    const f = fixture(t);
    const primary = require('../scripts/lib/historical-daily-primary-arxiv-binding.js');
    const catalogApi = require('../scripts/lib/historical-direct-rewrite-input-catalog.js');
    const projectionApi = require('../scripts/lib/historical-conference-page-projections.js');
    const planner = require('../scripts/lib/historical-direct-rewrite-plan.js');
    const page = f.ledger.pages.find(item => item.kind === 'paper');
    f.blog = path.join(f.root, 'blog');
    const pageFile = path.join(f.blog, page.path);
    fs.mkdirSync(path.dirname(pageFile), { recursive: true });
    const pageText = '---\ntitle: 临时测试论文\n---\n'
        + '✅ **7.0/10** | 前50% | #语音识别 | [arxiv](https://arxiv.org/abs/2601.00001v1)\n\n'
        + 'Reference: https://openreview.net/forum?id=AbCdef_12\n';
    fs.writeFileSync(pageFile, pageText);
    page.contentSha256 = sha(pageText);
    page.identityHints = { status: 'multiple', candidates: [
        { scheme: 'arxiv', value: '2601.00001', sources: ['body:arxiv-link', 'filename'] },
        { scheme: 'openreview-forum-id', value: 'AbCdef_12', sources: ['body:openreview-link'] }
    ] };
    rehashPage(page); rehashLedger(f.ledger);
    const ledgerBytes = api.prettyBytes(f.ledger);
    fs.writeFileSync(path.join(f.inventory, f.ledgerName), ledgerBytes);
    const receiptBody = structuredClone(f.receipt);
    delete receiptBody.receiptSha256;
    receiptBody.ledger.fileSha256 = sha(ledgerBytes);
    receiptBody.ledger.ledgerSha256 = f.ledger.ledgerSha256;
    receiptBody.ledger.pageSetSha256 = f.ledger.pageSetSha256;
    f.receipt = { ...receiptBody, receiptSha256: api.stableHash(receiptBody) };
    fs.writeFileSync(path.join(f.inventory, f.receiptName), api.prettyBytes(f.receipt));
    const state = api.prepareCrosswalk({ crosswalkRoot: f.crosswalk, inventoryHandle: load(f),
        crosswalkId: ids[0], now: stamp, apply: true });
    const binding = primary.build({ blogRoot: f.blog, page: state.source.papers[0] });
    const catalog = catalogApi.normalizeCatalog({
        contract: catalogApi.CONTRACT, version: catalogApi.VERSION, scope: catalogApi.SCOPE,
        scopeBinding: {
            inventoryPath: path.join(f.inventory, f.ledgerName), inventorySha256: sha(ledgerBytes),
            inventoryLedgerSha256: f.ledger.ledgerSha256, inventoryPageSetSha256: f.ledger.pageSetSha256,
            arxivPageCount: 1, singleArxivPageCount: 0, dailyPrimaryArxivBindingCount: 1,
            dailyIcmlPosterBindingCount: 0, dailyIcmlPosterRoutableBindingCount: 0, conferencePageCount: 0
        },
        inputs: [{ path: path.join(f.root, 'empty-conference.json'), sha256: sha('empty'), selectedPapers: 0 }],
        summary: {
            arxivPapers: 1, arxivPages: 1, singleArxivPages: 0, dailyPrimaryArxivBindings: 1,
            conferencePapers: 0, dailyIcmlPosterBindings: 0, dailyIcmlPosterRoutableBindings: 0,
            canonicalRecords: 1, sourceRecords: 0, conferenceSourceSets: {}
        },
        dailyPrimaryArxivBindings: [binding], dailyPrimaryArxivBindingSetSha256: api.stableHash([binding]),
        dailyIcmlPosterBindings: [], dailyIcmlPosterBindingSetSha256: api.stableHash([]),
        dailyIcmlPosterRoutableBindings: [], dailyIcmlPosterRoutableBindingSetSha256: api.stableHash([]),
        icmlPosterAuthoritySha256: null, entries: [{ paperId: 'arxiv:2601.00001', sources: [] }]
    });
    const catalogFileSha256 = sha(JSON.stringify(catalog));
    const projection = projectionApi.buildConferencePageMappings({ catalog, catalogFileSha256,
        inventory: f.ledger, blogRoot: f.blog });
    const plan = planner.buildDirectRewritePlan({ catalog, catalogFileSha256, inventory: f.ledger,
        conferencePageProjections: projection, blogRoot: f.blog });
    const handoffRoot = path.join(f.root, 'handoffs');
    const written = planner.writeArxivFreshFailureHandoff({ root: handoffRoot, plan,
        paperId: 'arxiv:2601.00001', generation: 1, error: new Error('来源获取失败'), observedAt: stamp });
    const handoffName = path.basename(written.filename);
    const options = {
        crosswalkRoot: f.crosswalk, crosswalkId: ids[0], owner: 'primary.handoff.test',
        handoffRoot, handoffNames: [handoffName], authorityRoot: path.join(f.root, 'authority'),
        batchRoot: path.join(f.root, 'batch'), blogRoot: f.blog, inventoryRoot: f.inventory
    };
    let fetchCalls = 0;
    const originalFetch = deep.fetchArxivTextDetailedUncached;
    t.after(() => { deep.fetchArxivTextDetailedUncached = originalFetch; });
    const text = 'official primary paper methods and results '.repeat(400);
    const structured = { version: 1, source: 'arxiv_html', tables: [], formulas: [], flattenedTextSha256: sha(text) };
    deep.fetchArxivTextDetailedUncached = async id => {
        fetchCalls++;
        return { text, source: 'html', sourceId: id, htmlAvailability: 'available', htmlAttempts: 1,
            warnings: [], imageInfos: [], structuredArtifacts: {
                ...structured, payloadSha256: sha(JSON.stringify(structured))
            } };
    };
    return { ...f, state, pageFile, pageText, binding, plan, planner, written, handoffName, options,
        fetchCalls: () => fetchCalls };
}

test('主评分行的新失败交接经真实批次与 crosswalk 决策完成', async t => {
    const f = primaryHandoffFixture(t);
    const batch = require('../scripts/lib/historical-arxiv-batch.js');
    const loaded = f.planner.readArxivFreshFailureHandoff({ root: f.options.handoffRoot, handoffName: f.handoffName });
    assert.equal(loaded.handoff.version, 2);
    assert.deepEqual(loaded.handoff.dailyPrimaryArxivBindings, [f.binding]);
    const result = await batch.runSingleHintBatch(f.options);
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.equal(result.processedPages, 1);
    assert.equal(f.fetchCalls(), 1);
    const state = api.readCrosswalk(f.options);
    assert.equal(state.assignments[f.binding.pageKey].status, 'verified');
    const artifact = JSON.parse(fs.readFileSync(path.join(f.crosswalk, ids[0], 'decisions', state.attempts[0].decisionName)));
    assert.equal(artifact.version, 2);
    assert.deepEqual(artifact.primaryArxivBinding, f.binding);
    assert.equal(artifact.sourceAuthority.paperId, 'arxiv:2601.00001');
    assert.equal((await batch.runSingleHintBatch(f.options)).status, 'complete');
    assert.equal(f.fetchCalls(), 1);
});

test('主评分行交接在请求前拒绝原页、评分行证明和完整候选集的变化', async t => {
    const f = primaryHandoffFixture(t);
    const batch = require('../scripts/lib/historical-arxiv-batch.js');
    fs.writeFileSync(f.pageFile, f.pageText.replace('7.0/10', '8.0/10'));
    await assert.rejects(batch.runSingleHintBatch(f.options), /frozen page bytes differ/);
    fs.writeFileSync(f.pageFile, f.pageText);
    const original = fs.readFileSync(f.written.filename);
    const handoff = JSON.parse(original);
    const proof = handoff.dailyPrimaryArxivBindings[0];
    proof.semanticLineSha256 = sha('另一行');
    const proofBody = structuredClone(proof); delete proofBody.bindingSha256;
    proof.bindingSha256 = api.stableHash(proofBody);
    const deterministic = {
        contract: handoff.contract, version: handoff.version, dailyPrimaryArxivBindings: handoff.dailyPrimaryArxivBindings,
        planSha256: handoff.planSha256, catalogFileSha256: handoff.catalogFileSha256, inventory: handoff.inventory,
        paperId: handoff.paperId, runId: handoff.runId, arxivId: handoff.arxivId, generation: handoff.generation,
        failure: handoff.failure, pageBindings: handoff.pageBindings, pageBindingSetSha256: handoff.pageBindingSetSha256
    };
    handoff.handoffKey = api.stableHash(deterministic);
    const body = structuredClone(handoff); delete body.handoffSha256;
    handoff.handoffSha256 = api.stableHash(body);
    const changedName = f.planner.arxivFreshFailureHandoffName(handoff);
    fs.writeFileSync(path.join(f.options.handoffRoot, changedName), api.prettyBytes(handoff));
    await assert.rejects(batch.runSingleHintBatch({ ...f.options, handoffNames: [changedName] }), /原始字节或候选来源/);
    const changedState = structuredClone(f.state);
    changedState.source.papers[0].identityHints.candidates[1].value = 'Another_12';
    changedState.source.paperPageSetSha256 = api.stableHash(changedState.source.papers);
    const stateBody = structuredClone(changedState); delete stateBody.stateSha256;
    changedState.stateSha256 = api.stableHash(stateBody);
    api.assertCrosswalkState(changedState);
    const stateFile = path.join(f.crosswalk, ids[0], 'state.json');
    fs.writeFileSync(stateFile, api.prettyBytes(changedState));
    await assert.rejects(batch.runSingleHintBatch(f.options), /完整冻结候选集合/);
    assert.equal(f.fetchCalls(), 0);
    assert.equal(fs.existsSync(f.options.authorityRoot), false);
});

test('主评分行决定落盘后应用前再次重核原页，拒绝替换且保留 pending', async t => {
    const f = primaryHandoffFixture(t);
    const produced = await arxivAdapter.prepareArxivSourceAuthority({ authorityRoot: f.options.authorityRoot,
        arxivId: '2601.00001', authorityName: 'arxiv-2601.00001.json', apply: true });
    assert.throws(() => api.buildVerifiedDecisionArtifact({ state: f.state, pageKey: f.binding.pageKey,
        authorityHandle: produced.authorityHandle, actorId: 'primary.test' }), /single unambiguous/);
    const artifact = api.buildVerifiedDecisionArtifact({ state: f.state, pageKey: f.binding.pageKey,
        authorityHandle: produced.authorityHandle, actorId: 'primary.test', primaryArxivBinding: f.binding,
        blogRoot: f.blog, inventoryRoot: f.inventory });
    const filename = api.writeDecisionArtifact({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionName: 'primary.json', artifact });
    const handle = api.loadDecisionHandle(filename, { authorityHandle: produced.authorityHandle,
        blogRoot: f.blog, inventoryRoot: f.inventory });
    fs.writeFileSync(f.pageFile, f.pageText.replace('2601.00001v1', '2601.00002v1'));
    assert.throws(() => api.applyDecision({ crosswalkRoot: f.crosswalk, crosswalkId: ids[0],
        decisionHandle: handle, owner: 'primary.test' }), /frozen page bytes differ/);
    assert.equal(api.readCrosswalk(f.options).assignments[f.binding.pageKey].status, 'pending');
});

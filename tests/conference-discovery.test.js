'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const discovery = require('../scripts/lib/conference-discovery.js');
const cli = require('../scripts/conference-discover.js');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-discovery-'));
    const pdf = path.join(root, 'pdf'); const catalogs = path.join(root, 'catalogs'); const reports = path.join(root, 'reports');
    fs.mkdirSync(pdf, { mode: 0o700 }); fs.mkdirSync(catalogs, { mode: 0o700 }); fs.mkdirSync(reports, { mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, pdf, catalogs, reports, metadata: path.join(root, 'metadata.json') };
}

function writePdf(root, relative, content = 'fixture') {
    const filename = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, `%PDF-1.7\n${content}`, { mode: 0o600 });
    return filename;
}

function writeJson(filename, value) {
    fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
}

function writeCanonical(filename, value) {
    fs.writeFileSync(filename, discovery.canonicalBytes(value), { mode: 0o600 });
}

test('ICASSP 冻结元数据和目录字节，并报告精确、归一化、有歧义、未匹配四种结果，但不做核实', t => {
    const f = fixture(t);
    writeJson(f.metadata, [
        { arnumber: '100', title: 'Exact Paper' },
        { arnumber: '200', title: 'Normalized: Paper!' },
        { arnumber: '300', title: 'Duplicate Paper' },
        { arnumber: '400', title: 'No PDF' }
    ]);
    writePdf(f.pdf, 'Exact Paper.pdf', 'exact');
    writePdf(f.pdf, 'normalized paper.pdf', 'normalized');
    writePdf(f.pdf, 'a/Duplicate Paper.pdf', 'duplicate-a');
    writePdf(f.pdf, 'b/Duplicate Paper.pdf', 'duplicate-b');
    writePdf(f.pdf, 'orphan.pdf', 'orphan');
    const { manifest, report } = discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.equal(manifest.contract, discovery.CONTRACT);
    assert.deepEqual(manifest.members.map(member => member.match.kind), ['exact', 'normalized', 'ambiguous', 'unmatched']);
    assert.equal(Object.hasOwn(manifest.members[0], 'status'), false);
    assert.equal(Object.hasOwn(manifest.members[0], 'verified'), false);
    assert.equal(manifest.metadataSnapshot.sha256, sha(fs.readFileSync(f.metadata)));
    assert.equal(manifest.pdfCatalog.length, 5);
    assert.equal(report.candidateManifestSha256, sha(discovery.canonicalBytes(manifest)));
    assert.deepEqual(report.counts, { metadataRecords: 4, pdfFiles: 5, exact: 1, normalized: 1, ambiguous: 1, unmatched: 1, orphanPdfFiles: 1 });
});

test('多个 ICASSP 标题指向同一份精确 PDF 时算有歧义，不自动绑定', t => {
    const f = fixture(t);
    writeJson(f.metadata, [{ arnumber: '1', title: 'Same' }, { arnumber: '2', title: 'Same' }]);
    writePdf(f.pdf, 'Same.pdf');
    const result = discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.deepEqual(result.manifest.members.map(member => member.match.kind), ['ambiguous', 'ambiguous']);
});

test('ICLR 用 forum_id，并且只认根目录下精确的 <id>.pdf，绝不按标题或嵌套文件名匹配', t => {
    const f = fixture(t);
    writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'A title' }, { forum_id: 'XyZ987_65', title: 'AbCdef_12' }]);
    writePdf(f.pdf, 'AbCdef_12.pdf');
    writePdf(f.pdf, 'nested/XyZ987_65.pdf');
    writePdf(f.pdf, 'A title.pdf');
    const result = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.deepEqual(result.manifest.members.map(member => member.match.kind), ['exact', 'unmatched']);
    assert.deepEqual(result.manifest.members[0].identity, { type: 'openreview-forum-id', value: 'AbCdef_12' });
});

test('ICML 记录一个可选的数字别名，但主身份和匹配键只用 OpenReview ID', t => {
    const f = fixture(t);
    writeJson(f.metadata, { conference: 'ICML 2026', papers: [
        { id: 'OpenRv_123', paper_number: 63469, title: 'Paper title' },
        { forum_id: 'ForumX_456', id: 65000, title: '63469' }
    ] });
    writePdf(f.pdf, 'OpenRv_123.pdf');
    writePdf(f.pdf, '63469.pdf');
    const result = discovery.discoverConference({ adapter: 'icml', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.equal(result.manifest.members[0].numericAlias, '65000');
    assert.equal(result.manifest.members[0].identity.value, 'ForumX_456');
    assert.equal(result.manifest.members[0].match.kind, 'unmatched');
    assert.equal(result.manifest.members[1].numericAlias, '63469');
    assert.equal(result.manifest.members[1].identity.value, 'OpenRv_123');
    assert.equal(result.manifest.members[1].match.kind, 'exact');
});

test('官方论文集锁定会议身份，PDF 只按精确的 metadata.pdfFile 匹配', t => {
    const f = fixture(t);
    writeJson(f.metadata, { conference: { id: 'cvpr-2026', year: 2026 }, papers: [
        { id: 'CVPR.2026-001_camera', title: 'Exact official PDF', authors: ['A. Author', 'B. Author'],
            abstract: 'An official abstract.', pdfFile: 'papers/CVPR_001.pdf',
            recordUrl: 'https://openaccess.thecvf.com/content/CVPR2026/html/Author_Exact.html',
            pdfUrl: 'https://openaccess.thecvf.com/content/CVPR2026/papers/Author_Exact.pdf', doi: null, track: 'Main' },
        { id: 'CVPR-2026.002', title: 'No local PDF', authors: ['C. Author'], abstract: '', pdfFile: null,
            recordUrl: 'https://openaccess.thecvf.com/content/CVPR2026/html/Author_Missing.html',
            pdfUrl: null, doi: '10.1109/CVPR.2026.2', track: null }
    ] });
    writePdf(f.pdf, 'papers/CVPR_001.pdf', 'exact official file');
    writePdf(f.pdf, 'CVPR.2026-001_camera.pdf', 'identity-name must not match');
    writePdf(f.pdf, 'Exact official PDF.pdf', 'title-name must not match');
    writePdf(f.pdf, 'CVPR-2026.002.pdf', 'null pdfFile must not match');
    const result = discovery.discoverConference({ adapter: 'official-proceedings', conferenceId: 'cvpr-2026',
        year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.deepEqual(result.manifest.conference, { id: 'cvpr-2026', year: 2026 });
    assert.deepEqual(result.manifest.members.map(member => [member.identity, member.pdfFile, member.match.kind]), [
        [{ type: 'conference-paper-id', value: 'CVPR-2026.002' }, null, 'unmatched'],
        [{ type: 'conference-paper-id', value: 'CVPR.2026-001_camera' }, 'papers/CVPR_001.pdf', 'exact']
    ]);
    assert.deepEqual(result.manifest.members[1].match.candidates.map(candidate => candidate.path), ['papers/CVPR_001.pdf']);
    assert.equal(result.report.counts.orphanPdfFiles, 3);
    assert.throws(() => discovery.discoverConference({ adapter: 'official-proceedings', year: 2026,
        metadataFile: f.metadata, pdfRoot: f.pdf }), /requires conferenceId/);
    assert.throws(() => discovery.discoverConference({ adapter: 'official-proceedings', conferenceId: 'acl-2026',
        year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /must match conferenceId and year/);
    assert.throws(() => discovery.discoverConference({ adapter: 'official-proceedings', conferenceId: 'cvpr-2026',
        year: 2025, metadataFile: f.metadata, pdfRoot: f.pdf }), /must match conferenceId and year/);
});

test('官方论文集的元数据结构、标识、URL 和 PDF 路径不合法时直接失败', t => {
    const f = fixture(t);
    const record = { id: 'ACL.2026-main.1', title: 'Paper', authors: ['Author'], abstract: '', pdfFile: null,
        recordUrl: 'https://aclanthology.org/2026.acl-long.1/', pdfUrl: null, doi: null, track: 'Long' };
    const discover = snapshot => {
        writeJson(f.metadata, snapshot);
        return discovery.discoverConference({ adapter: 'official-proceedings', conferenceId: 'acl-2026',
            year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    };
    assert.equal(discover({ conference: { id: 'acl-2026', year: 2026 }, papers: [record] }).manifest.members.length, 1);
    const collaboration = structuredClone(record);
    collaboration.authors = Array.from({ length: 102 }, (_, index) => `Author ${index + 1}`);
    assert.equal(discover({ conference: { id: 'acl-2026', year: 2026 }, papers: [collaboration] })
        .manifest.members.length, 1);
    const unbounded = structuredClone(record);
    unbounded.authors = Array.from({ length: 1001 }, (_, index) => `Author ${index + 1}`);
    assert.throws(() => discover({ conference: { id: 'acl-2026', year: 2026 }, papers: [unbounded] }),
        /at most 1000 names/);
    for (const mutate of [
        value => { value.extra = true; },
        value => { value.papers[0].extra = true; },
        value => { value.papers[0].id = 'ACL/2026/1'; },
        value => { value.papers[0].pdfFile = '../paper.pdf'; },
        value => { value.papers[0].recordUrl = 'http://aclanthology.org/2026.acl-long.1/'; },
        value => { value.papers[0].authors = []; }
    ]) {
        const snapshot = { conference: { id: 'acl-2026', year: 2026 }, papers: [structuredClone(record)] };
        mutate(snapshot);
        assert.throws(() => discover(snapshot));
    }
});

test('拒绝重复身份、冲突的 ID 或别名、重复的 JSON 键以及非标准身份', t => {
    const f = fixture(t);
    writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }, { forum_id: 'AbCdef_12', title: 'Two' }]);
    assert.throws(() => discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /duplicate primary identities/);
    writeJson(f.metadata, { papers: [{ forum_id: 'AbCdef_12', id: 'OtherID_99', title: 'One' }] });
    assert.throws(() => discovery.discoverConference({ adapter: 'icml', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /conflicting OpenReview/);
    writeJson(f.metadata, { papers: [{ id: 'AbCdef_12', paper_number: 1, numericAlias: 2, title: 'One' }] });
    assert.throws(() => discovery.discoverConference({ adapter: 'icml', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /conflicting numeric aliases/);
    fs.writeFileSync(f.metadata, '[{"arnumber":"1","arnumber":"2","title":"One"}]', { mode: 0o600 });
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /duplicate JSON key/);
    writeJson(f.metadata, [{ arnumber: '001', title: 'One' }]);
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /canonical positive integer/);
});

test('拒绝符号链接、硬链接、FIFO、损坏的 PDF、不安全的元数据和相对来源路径', t => {
    const f = fixture(t); writeJson(f.metadata, [{ arnumber: '1', title: 'One' }]);
    const original = writePdf(f.pdf, 'one.pdf');
    fs.symlinkSync(original, path.join(f.pdf, 'linked.pdf'));
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /symbolic link/);
    fs.unlinkSync(path.join(f.pdf, 'linked.pdf'));
    fs.linkSync(original, path.join(f.pdf, 'hard.pdf'));
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /hard-linked|single-link/);
    fs.unlinkSync(path.join(f.pdf, 'hard.pdf'));
    execFileSync('mkfifo', [path.join(f.pdf, 'pipe')]);
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /non-regular/);
    fs.unlinkSync(path.join(f.pdf, 'pipe'));
    fs.writeFileSync(original, 'not a pdf');
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /standard PDF header/);
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: 'relative.json', pdfRoot: f.pdf }), /absolute filename/);
    const hardMetadata = path.join(f.root, 'hard-metadata.json'); fs.linkSync(f.metadata, hardMetadata);
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /single-link/);
});

test('命令行预演不写任何东西；实际执行用 O_EXCL 写绑定产物，遇到冲突就回滚预留', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const base = ['--adapter', 'iclr', '--year', '2026', '--metadata', f.metadata, '--pdf-root', f.pdf];
    const files = { conferenceDiscoveryCatalogDir: f.catalogs, conferenceDiscoveryReportDir: f.reports };
    const dry = cli.main(['--dry-run', ...base], { files });
    assert.equal(dry.status, 'dry-run'); assert.deepEqual(fs.readdirSync(f.catalogs), []); assert.deepEqual(fs.readdirSync(f.reports), []);
    const candidate = path.join(f.catalogs, 'candidate.json'); const report = path.join(f.reports, 'report.json');
    const applied = cli.main(['--apply', ...base, '--candidate-output', 'candidate.json', '--report-output', 'report.json'], { files });
    assert.equal(applied.status, 'written');
    assert.equal(JSON.parse(fs.readFileSync(report)).candidateManifestSha256, sha(fs.readFileSync(candidate)));
    assert.equal(fs.statSync(candidate).mode & 0o777, 0o600);
    assert.throws(() => cli.main(['--apply', ...base, '--candidate-output', 'candidate.json', '--report-output', 'other.json'], { files }), /EEXIST/);
    assert.equal(fs.existsSync(path.join(f.reports, 'other.json')), false);
    assert.throws(() => cli.parseCommand(['--apply', ...base, '--candidate-output', 'candidate.json']), /requires/);
    assert.throws(() => cli.parseCommand(['--dry-run', ...base, '--candidate-output', 'candidate.json', '--report-output', 'report.json']), /must not specify/);
    for (const unsafe of ['/tmp/x.json', '../x.json', 'nested/x.json', 'X.json']) {
        assert.throws(() => cli.parseCommand(['--apply', ...base, '--candidate-output', unsafe, '--report-output', 'report.json']), /safe direct/);
    }
});

test('命令行要求并透传精确的官方会议 ID，同时保留旧版参数', () => {
    const base = ['--adapter', 'official-proceedings', '--year', '2026', '--metadata', '/tmp/metadata.json', '--pdf-root', '/tmp/pdf'];
    assert.throws(() => cli.parseCommand(['--dry-run', ...base]), /requires --conference-id/);
    const parsed = cli.parseCommand(['--dry-run', ...base, '--conference-id', 'ijcai-ecai-2026']);
    assert.equal(parsed.conferenceId, 'ijcai-ecai-2026');
    assert.throws(() => cli.parseCommand(['--dry-run', ...base, '--conference-id', 'IJCAI 2026']), /normalized/);
    assert.throws(() => cli.parseCommand(['--dry-run', ...base, '--conference-id', 'ijcai-ecai-2025']), /exact --year/);
    assert.equal(Object.hasOwn(cli.parseCommand(['--dry-run', '--adapter', 'iclr', '--year', '2026',
        '--metadata', '/tmp/metadata.json', '--pdf-root', '/tmp/pdf']), 'conferenceId'), false);
});

test('实际执行拒绝把输出写到目录根之内', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const result = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.throws(() => cli.writeOutputsOnce({ catalogDir: f.pdf, catalogName: 'candidate.json', candidate: result.manifest,
        reportDir: f.reports, reportName: 'report.json', report: result.report, forbiddenRoot: result.manifest.pdfRoot }), /must not be inside pdfRoot/);
});

test('严格的打包校验会复核每个来源、候选、基数、计数和成员集合绑定', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const original = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.equal(discovery.validateDiscoveryBundle(original.manifest, original.report).catalogSha256,
        original.report.candidateManifestSha256);

    const expectRejected = (mutateManifest, mutateReport, pattern) => {
        const manifest = JSON.parse(JSON.stringify(original.manifest)); mutateManifest?.(manifest);
        const report = discovery.buildReport(manifest); mutateReport?.(report);
        assert.throws(() => discovery.validateDiscoveryBundle(manifest, report), pattern);
    };
    expectRejected(manifest => { manifest.pdfCatalogSha256 = sha('forged'); }, null, /pdfCatalog SHA drifted/);
    expectRejected(manifest => { manifest.members[0].match.candidates[0].size += 1; }, null, /exactly match/);
    expectRejected(manifest => { manifest.members[0].match.candidates = []; }, null, /cardinality/);
    expectRejected(manifest => { manifest.members[0].match.kind = 'normalized'; }, null, /cannot be replayed/);
    expectRejected(manifest => { manifest.members[0].metadataIndex = 4; }, null, /metadata indexes/);
    expectRejected(manifest => { manifest.members[0].identity = { type: 'icassp-arnumber', value: '42' }; }, null, /identity type.*adapter/);
    expectRejected(manifest => { manifest.members[0].numericAlias = '42'; }, null, /only supported by the icml/);
    expectRejected(manifest => { manifest.memberSetSha256 = sha('forged'); }, null, /member set SHA drifted/);
    expectRejected(null, report => { report.metadataSnapshotSha256 = sha('other metadata'); }, /source SHA bindings/);
    expectRejected(null, report => { report.counts.exact = 0; }, /counts drifted/);
    expectRejected(manifest => { manifest.extra = true; }, null, /unknown or missing fields/);
    const reportDrift = structuredClone(original.report); reportDrift.candidateManifestSha256 = sha('forged');
    assert.throws(() => discovery.validateDiscoveryBundle(original.manifest, reportDrift), /canonical candidate manifest bytes/);
});

test('加载后的发现句柄要求成对的正式文件，无法伪造，并返回防御性快照', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const result = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    const catalogName = 'iclr-2026.json'; const reportName = 'iclr-2026.report.json';
    const catalogFile = path.join(f.catalogs, catalogName); const reportFile = path.join(f.reports, reportName);
    writeCanonical(catalogFile, result.manifest); writeCanonical(reportFile, result.report);
    const handle = discovery.loadDiscoveryHandle({ catalogDir: f.catalogs, catalogName, reportDir: f.reports, reportName });
    assert.deepEqual(Object.keys(handle), []);
    const first = discovery.discoveryHandleSnapshot(handle);
    assert.equal(first.catalogSha256, result.report.candidateManifestSha256);
    assert.equal(first.candidateManifest.members[0].identity.value, 'AbCdef_12');
    first.candidateManifest.members[0].identity.value = 'Mutated_12';
    assert.equal(discovery.discoveryHandleSnapshot(handle).candidateManifest.members[0].identity.value, 'AbCdef_12');
    assert.throws(() => discovery.discoveryHandleSnapshot(Object.freeze(Object.create(null))), /authenticated loaded/);
    assert.equal(discovery.discoveryHandleSnapshot(discovery.loadDiscoveryHandle(catalogFile, reportFile)).catalogSha256,
        result.report.candidateManifestSha256);

    fs.writeFileSync(catalogFile, JSON.stringify(result.manifest), { mode: 0o600 });
    assert.throws(() => discovery.loadDiscoveryHandle(catalogFile, reportFile), /exact canonical bytes/);
});

test('加载后的发现句柄拒绝交叉配对的上报、重复的键和被改动的描述符', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const result = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    const catalogFile = path.join(f.catalogs, 'catalog.json'); const reportFile = path.join(f.reports, 'report.json');
    writeCanonical(catalogFile, result.manifest);
    const wrongReport = structuredClone(result.report); wrongReport.candidateManifestSha256 = sha('different catalog');
    writeCanonical(reportFile, wrongReport);
    assert.throws(() => discovery.loadDiscoveryHandle(catalogFile, reportFile), /canonical candidate manifest bytes/);
    fs.writeFileSync(reportFile, '{"contract":"conference-discovery-report-v1","contract":"other"}\n', { mode: 0o600 });
    assert.throws(() => discovery.loadDiscoveryHandle(catalogFile, reportFile), /duplicate JSON key/);

    const tampered = JSON.parse(JSON.stringify(result.manifest)); tampered.members[0].match.candidates[0].sha256 = sha('tampered pdf');
    writeCanonical(catalogFile, tampered); writeCanonical(reportFile, discovery.buildReport(tampered));
    assert.throws(() => discovery.loadDiscoveryHandle(catalogFile, reportFile), /exactly match/);
});

function cleanupFixture(t) {
    const f = fixture(t);
    writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]);
    writePdf(f.pdf, 'AbCdef_12.pdf');
    const args = ['--apply', '--adapter', 'iclr', '--year', '2026', '--metadata', f.metadata,
        '--pdf-root', f.pdf, '--candidate-output', 'candidate.json', '--report-output', 'report.json'];
    return { ...f, candidate: path.join(f.catalogs, 'candidate.json'), report: path.join(f.reports, 'report.json'),
        run: () => cli.main(args, { files: { conferenceDiscoveryCatalogDir: f.catalogs, conferenceDiscoveryReportDir: f.reports } }) };
}

test('发现公开入口写失败时保留替换后的普通文件、符号链接和目录', t => {
    for (const kind of ['file', 'symlink', 'directory']) {
        const f = cleanupFixture(t); const originalWrite = fs.writeFileSync;
        const winner = Buffer.from('另一写入者的完整候选文件');
        const target = path.join(f.root, 'winner.json'); originalWrite(target, winner);
        const originalError = Object.assign(new Error('测试发现输出短写'), { code: 'EIO' });
        let injected = false;
        const mocked = t.mock.method(fs, 'writeFileSync', (fd, bytes, ...rest) => {
            if (typeof fd !== 'number' || injected) return originalWrite(fd, bytes, ...rest);
            injected = true; fs.writeSync(fd, Buffer.from(bytes), 0, 4, 0);
            if (kind === 'directory') { fs.renameSync(f.catalogs, `${f.catalogs}-held`); fs.mkdirSync(f.catalogs); }
            else fs.unlinkSync(f.candidate);
            if (kind === 'symlink') fs.symlinkSync(target, f.candidate);
            else originalWrite(f.candidate, winner);
            throw originalError;
        });
        let failure;
        try { f.run(); } catch (error) { failure = error; } finally { mocked.mock.restore(); }
        assert.deepEqual(fs.readFileSync(f.candidate), winner);
        assert.deepEqual(fs.readFileSync(target), winner);
        assert.equal(failure.cause, originalError); assert.equal(failure.code, 'EIO');
        assert.ok(failure.cleanupError instanceof AggregateError);
        assert.equal(fs.existsSync(f.report), false);
        if (kind === 'symlink') assert.equal(fs.lstatSync(f.candidate).isSymbolicLink(), true);
        if (kind === 'directory') assert.equal(fs.existsSync(path.join(`${f.catalogs}-held`, 'candidate.json')), true);
    }
});

test('发现公开入口短写后清理本人文件，重试生成可重放的候选与报告', t => {
    const f = cleanupFixture(t); const originalWrite = fs.writeFileSync;
    const originalError = Object.assign(new Error('测试发现短写重试'), { code: 'EIO' });
    const mocked = t.mock.method(fs, 'writeFileSync', (fd, bytes, ...rest) => {
        if (typeof fd !== 'number') return originalWrite(fd, bytes, ...rest);
        fs.writeSync(fd, Buffer.from(bytes), 0, 4, 0); throw originalError;
    });
    try { assert.throws(f.run, error => error === originalError); } finally { mocked.mock.restore(); }
    assert.equal(fs.existsSync(f.candidate), false); assert.equal(fs.existsSync(f.report), false);
    assert.equal(f.run().status, 'written');
    const handle = discovery.loadDiscoveryHandle(f.candidate, f.report);
    assert.equal(discovery.discoveryHandleSnapshot(handle).candidateManifest.members.length, 1);
});

test('发现公开入口同时保留写入故障和清理权限故障', t => {
    const f = cleanupFixture(t); const originalWrite = fs.writeFileSync;
    const originalError = Object.assign(new Error('测试发现写入故障'), { code: 'EIO' });
    const cleanupError = Object.assign(new Error('测试发现清理权限故障'), { code: 'EACCES' });
    const write = t.mock.method(fs, 'writeFileSync', (fd, bytes, ...rest) => {
        if (typeof fd !== 'number') return originalWrite(fd, bytes, ...rest);
        fs.writeSync(fd, Buffer.from(bytes), 0, 4, 0); throw originalError;
    });
    const unlink = t.mock.method(fs, 'unlinkSync', () => { throw cleanupError; });
    try {
        assert.throws(f.run, error => {
            assert.equal(error.cause, originalError);
            assert.ok(error.cleanupError.errors.includes(cleanupError)); return true;
        });
    } finally { write.mock.restore(); unlink.mock.restore(); }
    assert.equal(fs.existsSync(f.candidate), true);
});

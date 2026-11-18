'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'scripts', 'lib');
const WORKER_SCRIPT = path.join(LIB_DIR, 'publish-node-replay-worker.js');

const workerModule = require(WORKER_SCRIPT);
const contract = require('../scripts/analysis-contract');
const codec = require('../scripts/lib/protocol-codec');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const deep = require('../scripts/deep-analyzer');
const order = require('../scripts/lib/reader-draft-order');
const repair = require('../scripts/lib/reader-repair');
const compiler = require('../scripts/lib/reader-tables');
const pdfEvidence = require('../scripts/lib/reader-table-pdf-evidence');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function runStandaloneCli(cliName, payloadBuf, envExtra = {}) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'standalone-cli-parity-'));
    const inputPath = path.join(dir, 'input.json');
    fs.writeFileSync(inputPath, payloadBuf, { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(inputPath, 'r');
    try {
        const res = spawnSync(
            process.execPath,
            [path.join(LIB_DIR, cliName), '3'],
            {
                cwd: ROOT,
                stdio: ['ignore', 'pipe', 'pipe', fd],
                env: {
                    ...Object.fromEntries(
                        Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS' && k !== 'NODE_PATH')
                    ),
                    VERIFY_PROJECT_DISABLE_FILE_LOGS: '1',
                    ...envExtra
                },
                timeout: 30000
            }
        );
        return {
            returncode: res.status,
            stdout: (res.stdout || Buffer.alloc(0)).toString('utf8'),
            stderr: (res.stderr || Buffer.alloc(0)).toString('utf8')
        };
    } finally {
        try { fs.closeSync(fd); } catch {}
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

class LiveWorkerHarness {
    constructor(envExtra = {}) {
        this.dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'worker-harness-'));
        fs.chmodSync(this.dir, 0o700);
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = Buffer.alloc(0);
        this.child = spawn(
            process.execPath,
            [WORKER_SCRIPT, '3'],
            {
                cwd: ROOT,
                stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
                env: {
                    ...Object.fromEntries(
                        Object.entries(process.env).filter(([k]) => k !== 'NODE_OPTIONS' && k !== 'NODE_PATH')
                    ),
                    VERIFY_PROJECT_DISABLE_FILE_LOGS: '1',
                    ...envExtra
                }
            }
        );
        this.protocolPipe = this.child.stdio[3];
        this.protocolPipe.on('data', chunk => {
            this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
            while (true) {
                const idx = this.buffer.indexOf(0x0a);
                if (idx === -1) break;
                const line = this.buffer.subarray(0, idx).toString('utf8');
                this.buffer = this.buffer.subarray(idx + 1);
                if (!line.trim()) continue;
                const msg = JSON.parse(line);
                const waiter = this.pending.get(msg.id);
                if (waiter) {
                    this.pending.delete(msg.id);
                    waiter.resolve({
                        returncode: msg.returncode,
                        stdout: Buffer.from(msg.stdoutBase64, 'base64').toString('utf8'),
                        stderr: Buffer.from(msg.stderrBase64, 'base64').toString('utf8'),
                        stdoutTruncated: msg.stdoutTruncated,
                        stderrTruncated: msg.stderrTruncated
                    });
                }
            }
        });
    }

    async request(cliName, payloadOrOptions, maxOutputBytes = 1024 * 1024) {
        const id = this.nextId++;
        let inputPath;
        let cleanupPath = null;
        if (Buffer.isBuffer(payloadOrOptions) || typeof payloadOrOptions === 'string') {
            inputPath = path.join(this.dir, `req-${id}.json`);
            cleanupPath = inputPath;
            fs.writeFileSync(inputPath, payloadOrOptions, { mode: 0o600, flag: 'wx' });
        } else {
            inputPath = payloadOrOptions.inputPath;
        }
        const cliPath = payloadOrOptions?.cliPath || path.join(LIB_DIR, cliName);
        try {
            const promise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`Worker request ${id} timed out`));
                }, 30000);
                this.pending.set(id, {
                    resolve: val => { clearTimeout(timer); resolve(val); },
                    reject: err => { clearTimeout(timer); reject(err); }
                });
            });
            this.child.stdin.write(
                JSON.stringify({ id, cli: cliName, cliPath, inputPath, maxOutputBytes }) + '\n'
            );
            return await promise;
        } finally {
            if (cleanupPath) {
                try { fs.unlinkSync(cleanupPath); } catch {}
            }
        }
    }

    async close() {
        if (this.child.exitCode === null) {
            const exited = new Promise(resolve => this.child.once('close', resolve));
            this.child.stdin.end();
            await exited;
        }
        fs.rmSync(this.dir, { recursive: true, force: true });
    }
}

async function buildSealedDailyFixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'worker-daily-fixture-'));
    const previousRunsDir = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previousRunsDir;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const text = 'The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(100).trim();
    const s = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: text });
    const matrix = [['Method', 'A', 'B', 'C', 'D', 'E'], Array(6).fill('Proprietary Models'), ['Baseline', '1.0', '1.0', '1.0', '1.0', '1.0']];
    const table = { ordinal: 1, recoveryStatus: 'complete', sourceDomSha256: 'a'.repeat(64), headerRows: [0], bodyRows: [1, 2], matrix, cells: [] };
    for (const [r, row] of matrix.entries()) {
        if (r === 1) {
            table.cells.push({ row: r, column: 0, text: row[0], rowspan: 1, colspan: 6, header: false, sourceDomSha256: 'b'.repeat(64) });
        } else {
            for (const [c, value] of row.entries()) {
                table.cells.push({ row: r, column: c, text: value, rowspan: 1, colspan: 1, header: r === 0, sourceDomSha256: repair.shaText(`cell${r}:${c}`) });
            }
        }
    }
    const { payloadSha256: _ignored, ...body } = s.sourceDetails.structuredArtifacts;
    const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
    const artifactBody = sortKeys({ ...body, tables: [table], formulas: [] });
    const artifacts = { ...artifactBody, payloadSha256: repair.shaText(JSON.stringify(artifactBody)) };

    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-10-11',
        batchId: 'worker-parity-span',
        papers: [{ arxivId: s.paper.arxivId, title: 'Worker parity merged HTML row' }]
    });
    const authorHtml = '<div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span><span class="ltx_contact ltx_role_affiliation">University A</span></span></div>';
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: args => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(args, {
            fetchText: async id => ({
                text,
                structuredArtifacts: artifacts,
                source: 'html',
                sourceId: id,
                url: `https://arxiv.org/html/${id}`,
                fetchedAt: '2026-10-11T00:00:00.000Z',
                imageInfos: [],
                warnings: [],
                html: authorHtml
            }),
            fetchPdf: async id => ({
                bytes: Buffer.from('%PDF-1.7\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${id}`,
                fetchedAt: '2026-10-11T00:00:01.000Z'
            })
        })
    });
    const source = daily.readDailyFreshSource(plan, s.paper);
    const draft = s.draft;
    draft.formulaBindings = [];
    draft.sections[4].body = draft.sections[4].body.replace(/\s*\[\[FORMULA_1\]\]/g, '');
    draft.sections[7].body = draft.sections[7].body.replace(/\| 比较条件[\s\S]*?仅支持当前口径 \|/, '[[TABLE_2]]');
    draft.tableBindings[1] = { tableIndex: 2, completeTable: { sourceTableOrdinal: 1 } };
    const prepared = order.normalizeReaderDraftOrder(draft, { structuredArtifacts: artifacts }).draft;
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(prepared), {
        requiredVersion: 3,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2,
        requireSourceBindings: true,
        allowDeterministicQuoteRepair: true,
        sourceText: text,
        structuredArtifacts: artifacts,
        availableFigureOrdinals: []
    });
    const paper = s.paper;
    paper.authors = ['Alice Brown'];
    const parser = require('../scripts/lib/reader-author-parser');
    let builtAuthors;
    daily.withDailyFreshAnalysisContext(plan, () => {
        fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source);
        builtAuthors = parser.resolveVerifiedReaderAuthors(paper, source);
    });
    Object.assign(paper, {
        apiReaderArticle: parsed.article,
        apiReaderPlan: parsed.plan,
        apiReaderAuthors: builtAuthors
    });
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = artifacts.payloadSha256;
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    Object.assign(stage, {
        formulaBindingCount: 0,
        structuredArtifactsSha256: artifacts.payloadSha256,
        qualityMetrics: parsed.qualityMetrics,
        sourceBindingsSha256: parsed.plan.sourceBindingsSha256,
        articleSha256: repair.shaText(parsed.article),
        planSha256: daily.stableHash(parsed.plan),
        readerAuthorIdentitySha256: builtAuthors.identitySha256,
        readerAuthorsSha256: daily.stableHash(builtAuthors)
    });
    paper.apiReaderArticleSha256 = stage.articleSha256;
    paper.apiReaderPlanSha256 = stage.planSha256;

    return { root, plan, paper, source, text };
}

function buildPdfSelectionCase() {
    const matrix = [['Method', 'Score'], ['Base', '1.25'], ['Ours', '2.50']];
    const table = {
        ordinal: 1,
        recoveryStatus: 'complete',
        sourceDomSha256: 'a'.repeat(64),
        matrix,
        headerRows: [0],
        bodyRows: [1, 2],
        cells: matrix.flatMap((row, r) => row.map((cellText, c) => ({
            row: r,
            column: c,
            rowspan: 1,
            colspan: 1,
            text: cellText,
            sourceDomSha256: sha256(`${r}:${c}:${cellText}`)
        })))
    };
    const artifacts = { tables: [table] };
    const declaration = { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 2], sourceColumns: [0, 1] } };
    const rendered = compiler.renderReaderTableSelection(declaration, artifacts);
    const cellBindings = rendered.binding.cellBindings.map(cell => {
        const orig = table.cells.find(item => item.row === cell.sourceRow && item.column === cell.sourceColumn);
        return {
            ...cell,
            sourceText: orig.text,
            sourceDomSha256: orig.sourceDomSha256,
            renderedText: orig.text
        };
    });
    const proof = {
        ...codec.recordHeader('reader-sealed-pdf-table-grid', 'reader-sealed-pdf-table-grid'),
        sourceTableOrdinal: 1,
        sourceTableDomSha256: table.sourceDomSha256,
        sourceTableSha256: 'd'.repeat(64),
        pageNumber: 1,
        displayMatrix: matrix,
        evidenceSha256: 'e'.repeat(64)
    };
    const proofFormat = require('../scripts/lib/reader-proof-format');
    const sortObj = item => Array.isArray(item) ? item.map(sortObj) : item && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map(k => [k, sortObj(item[k])])) : item;
    const cellBindingsSha256 = sha256(JSON.stringify(sortObj(rendered.binding.cellBindings)));
    const sealedPdfTableSelection = {
        ...proofFormat.header('reader-compiled-pdf-table-selection'),
        tableIndex: 1,
        sourceTableOrdinal: 1,
        sourceTableDomSha256: table.sourceDomSha256,
        sourceTableSha256: proof.sourceTableSha256,
        pdfEvidenceSha256: proof.evidenceSha256,
        sourceRows: [0, 2],
        sourceColumns: [0, 1],
        cellBindingsSha256
    };
    const binding = {
        ...rendered.binding,
        sourceType: 'artifact_table',
        sourceTableOrdinal: 1,
        sourceTableDomSha256: table.sourceDomSha256,
        cellBindings,
        sealedPdfTableEvidence: proof,
        sealedPdfTableSelection
    };
    return { artifacts, binding, proof };
}

test('全部 6 个只读重放 CLI 在合法输入与篡改输入上与独立子进程逐字节一致，且复用同一常驻 PID', async t => {
    const f = await buildSealedDailyFixture(t);
    const worker = new LiveWorkerHarness();
    t.after(() => worker.close());
    const initialPid = worker.child.pid;
    assert.ok(initialPid > 0);

    const validSummary = contract.extractSection(require('./valid-analysis-fixture').validAnalysisText(), '核心摘要');
    const selectionCase = buildPdfSelectionCase();
    const scoringHeader = codec.recordHeader('daily-scoring-refresh-publication-check', 'daily-scoring-refresh-publication-check');

    const cases = [
        {
            cli: 'core-summary-semantic-replay-cli.js',
            valid: JSON.stringify({ summary: validSummary, sourceText: '' }),
            invalid: JSON.stringify({ summary: validSummary, sourceText: '', unexpected: true })
        },
        {
            cli: 'reader-dom-span-replay-cli.js',
            valid: JSON.stringify({ paper: f.paper, article: f.paper.apiReaderArticle, sealedBundleRoot: f.plan.sourcesDir }),
            invalid: JSON.stringify({ paper: { ...f.paper, sourceSha256: '0'.repeat(64) }, article: f.paper.apiReaderArticle, sealedBundleRoot: f.plan.sourcesDir })
        },
        {
            cli: 'reader-pdf-selection-replay-cli.js',
            valid: JSON.stringify(selectionCase),
            invalid: JSON.stringify({ ...selectionCase, binding: { ...selectionCase.binding, tableIndex: 99 } })
        },
        {
            cli: 'reader-resource-claims-replay-cli.js',
            valid: JSON.stringify({ paper: f.paper, sourceText: f.text, resourcePresentation: true }),
            invalid: JSON.stringify({ paper: f.paper, sourceText: f.text + ' tampered', resourcePresentation: true })
        },
        {
            cli: 'reader-author-replay-cli.js',
            valid: JSON.stringify({
                ...codec.recordHeader('reader-author-replay-batch', 'reader-author-replay-batch'),
                items: [{ paper: f.paper, sourceDetails: f.source, sealedBundleRoot: f.plan.sourcesDir }]
            }),
            invalid: JSON.stringify({
                ...codec.recordHeader('reader-author-replay-batch', 'reader-author-replay-batch'),
                items: [{ paper: { ...f.paper, sourceSha256: '0'.repeat(64) }, sourceDetails: f.source, sealedBundleRoot: f.plan.sourcesDir }]
            })
        },
        {
            cli: 'daily-scoring-refresh-checkpoint-cli.js',
            valid: JSON.stringify({ ...scoringHeader, papers: [f.paper] }),
            invalid: JSON.stringify({ ...scoringHeader, papers: [{ ...f.paper, dailyScoringRefreshCheckpoint: {} }] })
        }
    ];

    for (const item of cases) {
        const standaloneOk = runStandaloneCli(item.cli, item.valid);
        const workerOk = await worker.request(item.cli, item.valid);
        assert.equal(standaloneOk.returncode, 0, `${item.cli} standalone valid failed: ${standaloneOk.stdout} ${standaloneOk.stderr}`);
        assert.equal(workerOk.returncode, standaloneOk.returncode, `${item.cli} valid returncode parity`);
        assert.equal(workerOk.stdout, standaloneOk.stdout, `${item.cli} valid stdout parity`);

        const standaloneBad = runStandaloneCli(item.cli, item.invalid);
        const workerBad = await worker.request(item.cli, item.invalid);
        assert.notEqual(standaloneBad.returncode, 0, `${item.cli} standalone invalid must fail`);
        assert.equal(workerBad.returncode, standaloneBad.returncode, `${item.cli} invalid returncode parity`);
        assert.equal(workerBad.stdout, standaloneBad.stdout, `${item.cli} invalid stdout parity`);
    }

    assert.equal(worker.child.pid, initialPid, 'worker process stayed alive and handled all 12 requests without respawning');
});

test('常驻 worker 每次请求均从磁盘冷读封存原文件，零内存跨请求缓存', async t => {
    const f = await buildSealedDailyFixture(t);
    const worker = new LiveWorkerHarness();
    t.after(() => worker.close());

    const arxivId = String(f.paper.arxivId).replace(/v\d+$/, '');
    const sourceTxtPath = path.join(f.plan.sourcesDir, arxivId, 'generation-000001', 'source.txt');
    const originalSourceBytes = fs.readFileSync(sourceTxtPath);

    const authorBatchPayload = JSON.stringify({
        ...codec.recordHeader('reader-author-replay-batch', 'reader-author-replay-batch'),
        items: [{ paper: f.paper, sourceDetails: f.source, sealedBundleRoot: f.plan.sourcesDir }]
    });
    const domSpanPayload = JSON.stringify({
        paper: f.paper,
        article: f.paper.apiReaderArticle,
        sealedBundleRoot: f.plan.sourcesDir
    });

    const firstAuthor = await worker.request('reader-author-replay-cli.js', authorBatchPayload);
    assert.equal(firstAuthor.returncode, 0);
    assert.equal(firstAuthor.stdout, '{"verified":true}');

    const firstSpan = await worker.request('reader-dom-span-replay-cli.js', domSpanPayload);
    assert.equal(firstSpan.returncode, 0);
    assert.deepEqual(JSON.parse(firstSpan.stdout), { keys: [[2, 1, 1], [2, 1, 2], [2, 1, 3], [2, 1, 4], [2, 1, 5]] });

    // Tamper sealed source.txt on disk between requests to the SAME worker process.
    fs.chmodSync(sourceTxtPath, 0o600);
    fs.writeFileSync(sourceTxtPath, Buffer.concat([originalSourceBytes, Buffer.from('\ntampered-on-disk')]), { mode: 0o600 });
    try {
        const secondAuthor = await worker.request('reader-author-replay-cli.js', authorBatchPayload);
        assert.equal(secondAuthor.returncode, 1);
        assert.equal(secondAuthor.stdout, '{"verified":false}');

        const secondSpan = await worker.request('reader-dom-span-replay-cli.js', domSpanPayload);
        assert.equal(secondSpan.returncode, 1);
        assert.equal(secondSpan.stdout, '{"keys":[]}');
    } finally {
        fs.writeFileSync(sourceTxtPath, originalSourceBytes, { mode: 0o600 });
    }

    // Restoring original sealed bytes allows fresh cold read to pass again.
    const thirdAuthor = await worker.request('reader-author-replay-cli.js', authorBatchPayload);
    assert.equal(thirdAuthor.returncode, 0);
    assert.equal(thirdAuthor.stdout, '{"verified":true}');
});

test('常驻 worker 拒绝 0644、硬链接、符号链接、空输入、错路径与全部网络入口', async t => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'worker-input-guards-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const worker = new LiveWorkerHarness();
    t.after(() => worker.close());

    const validSummary = contract.extractSection(require('./valid-analysis-fixture').validAnalysisText(), '核心摘要');
    const body = JSON.stringify({ summary: validSummary, sourceText: '' });

    // 1. 0644 world-readable input rejected
    const publicFile = path.join(dir, 'public.json');
    fs.writeFileSync(publicFile, body, { mode: 0o600 });
    fs.chmodSync(publicFile, 0o644);
    assert.throws(() => workerModule.openVerifiedPrivateInputFd(publicFile), /0600/);
    const resPublic = await worker.request('core-summary-semantic-replay-cli.js', { inputPath: publicFile });
    assert.equal(resPublic.returncode, 1);
    assert.match(JSON.parse(resPublic.stdout).issue, /0600/);

    // 2. Hardlinked input (nlink === 2) rejected
    const linkedFile = path.join(dir, 'linked.json');
    const aliasFile = path.join(dir, 'alias.json');
    fs.writeFileSync(linkedFile, body, { mode: 0o600 });
    fs.linkSync(linkedFile, aliasFile);
    assert.throws(() => workerModule.openVerifiedPrivateInputFd(linkedFile), /single-link/);
    const resLinked = await worker.request('core-summary-semantic-replay-cli.js', { inputPath: linkedFile });
    assert.equal(resLinked.returncode, 1);

    // 3. Symlink input rejected (O_NOFOLLOW + lstat)
    const targetFile = path.join(dir, 'target.json');
    const symlinkFile = path.join(dir, 'symlink.json');
    fs.writeFileSync(targetFile, body, { mode: 0o600 });
    fs.symlinkSync(targetFile, symlinkFile);
    assert.throws(() => workerModule.openVerifiedPrivateInputFd(symlinkFile), /non-symlink/);
    const resSymlink = await worker.request('core-summary-semantic-replay-cli.js', { inputPath: symlinkFile });
    assert.equal(resSymlink.returncode, 1);

    // 4. Mismatched cliPath rejected
    const resWrongPath = await worker.request('core-summary-semantic-replay-cli.js', {
        inputPath: targetFile,
        cliPath: path.join(dir, 'core-summary-semantic-replay-cli.js')
    });
    assert.equal(resWrongPath.returncode, 1);
    assert.equal(resWrongPath.stdout, '');
    assert.match(resWrongPath.stderr, /CLI path mismatch/);

    // 5. Permanent network denial covers net, tls, http, https, http2, dgram, fetch
    const netCheck = spawnSync(
        process.execPath,
        [
            '-e',
            `
            const w = require(${JSON.stringify(WORKER_SCRIPT)});
            w.installPermanentNetworkDenial();
            const probes = [
                () => require('node:net').connect(80),
                () => require('node:net').createConnection(80),
                () => new (require('node:net').Socket)().connect(80),
                () => require('node:tls').connect(443),
                () => require('node:http').request('http://example.invalid'),
                () => require('node:http').get('http://example.invalid'),
                () => require('node:https').request('https://example.invalid'),
                () => require('node:https').get('https://example.invalid'),
                () => require('node:http2').connect('https://example.invalid'),
                () => require('node:dgram').createSocket('udp4').send('x', 53, '127.0.0.1'),
                () => globalThis.fetch('https://example.invalid')
            ];
            for (const fn of probes) {
                let blocked = false;
                try { fn(); } catch (err) { blocked = /forbids network access/.test(err.message); }
                if (!blocked) throw new Error('Network entry was not blocked');
            }
            process.stdout.write('blocked=' + probes.length);
            `
        ],
        { cwd: ROOT, encoding: 'utf8' }
    );
    assert.equal(netCheck.status, 0, netCheck.stderr);
    assert.equal(netCheck.stdout, 'blocked=11');
});

test('常驻 worker 跨请求严格还原 process.env 与 process.exitCode，且诊断流安全处理 Uint8Array 与 buffer 编码', async t => {
    // 1. Direct unit check of normalizeDiagnosticChunk for Uint8Array views and encoding === 'buffer'
    const backing = Buffer.from('xxHELLOyy', 'utf8');
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 2, 5);
    assert.equal(workerModule.normalizeDiagnosticChunk(view, undefined).toString('utf8'), 'HELLO');
    assert.equal(workerModule.normalizeDiagnosticChunk(Buffer.from('RAWBUF'), 'buffer').toString('utf8'), 'RAWBUF');
    assert.equal(workerModule.normalizeDiagnosticChunk('STR_WITH_BUFFER_ENC', 'buffer').toString('utf8'), 'STR_WITH_BUFFER_ENC');

    // 2. Live worker subprocess check across sequential requests on the same PID:
    //    - Request 1 simulates loadProjectEnv()-style PD_*/PAPER_ANALYZER_* overwrites,
    //      adds extra keys, mutates process.exitCode = 42, and writes Uint8Array + encoding='buffer'
    //      to process.stdout.write / process.stderr.write.
    //    - Request 2 verifies the exact same worker PID sees restored initial process.env and process.exitCode === 0.
    const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'worker-env-diag-isolation-'));
    t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
    const isolatedScripts = path.join(tmpRoot, 'scripts');
    const isolatedLib = path.join(isolatedScripts, 'lib');
    fs.mkdirSync(isolatedLib, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'PD_CALLER_SENTINEL=from-dotenv-file\nPAPER_ANALYZER_API_KEY=dotenv-secret\n', { mode: 0o600 });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'env-loader.js'), path.join(isolatedScripts, 'env-loader.js'));
    fs.copyFileSync(WORKER_SCRIPT, path.join(isolatedLib, 'publish-node-replay-worker.js'));

    const probeCliPath = path.join(isolatedLib, 'core-summary-semantic-replay-cli.js');
    fs.writeFileSync(
        probeCliPath,
        `'use strict';
const fs = require('node:fs');
const path = require('node:path');
function formatReplayError(e) {
    return { exitCode: 1, stdout: JSON.stringify({ issue: String(e.message || e) }) };
}
function runReplayFd(fd) {
    const input = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (input.mutate) {
        require('../env-loader').loadProjectEnv(path.join(__dirname, '..', '..', '.env'));
        process.env.EXTRA_LEAKED_VAR = 'should-not-survive';
        process.exitCode = 42;
        const raw = Buffer.from('__UINT8_SLICE__', 'utf8');
        const sub = new Uint8Array(raw.buffer, raw.byteOffset + 2, 11);
        process.stdout.write(sub);
        process.stderr.write(Buffer.from('|BUF_ENC|'), 'buffer');
        process.stdout.write('STR_BUF_ENC', 'buffer');
        return { exitCode: 0, stdout: JSON.stringify({ pid: process.pid, mutated: true }) };
    }
    return {
        exitCode: 0,
        stdout: JSON.stringify({
            pid: process.pid,
            sentinel: process.env.PD_CALLER_SENTINEL ?? null,
            apiKey: process.env.PAPER_ANALYZER_API_KEY ?? null,
            extra: process.env.EXTRA_LEAKED_VAR ?? null,
            disableFileLogs: process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS ?? null,
            exitCodeDuringRun: process.exitCode ?? 0
        })
    };
}
module.exports = { runReplayFd, formatReplayError };
`,
        'utf8'
    );

    const reqDir = path.join(tmpRoot, 'reqs');
    fs.mkdirSync(reqDir, { mode: 0o700 });
    const child = spawn(
        process.execPath,
        [path.join(isolatedLib, 'publish-node-replay-worker.js'), '3'],
        {
            cwd: tmpRoot,
            stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
            env: {
                PATH: process.env.PATH || '',
                HOME: process.env.HOME || '',
                PD_CALLER_SENTINEL: 'caller-original-value'
            }
        }
    );
    t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
    });

    const responses = [];
    let buf = Buffer.alloc(0);
    child.stdio[3].on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        let idx;
        while ((idx = buf.indexOf(0x0a)) !== -1) {
            const line = buf.subarray(0, idx).toString('utf8');
            buf = buf.subarray(idx + 1);
            if (line.trim()) responses.push(JSON.parse(line));
        }
    });

    const sendReq = async (id, payloadObj) => {
        const p = path.join(reqDir, `r-${id}.json`);
        fs.writeFileSync(p, JSON.stringify(payloadObj), { mode: 0o600, flag: 'wx' });
        const beforeCount = responses.length;
        child.stdin.write(JSON.stringify({
            id,
            cli: 'core-summary-semantic-replay-cli.js',
            cliPath: probeCliPath,
            inputPath: p,
            maxOutputBytes: 65536
        }) + '\n');
        while (responses.length <= beforeCount) {
            await new Promise(r => setTimeout(r, 10));
        }
        fs.unlinkSync(p);
        return responses[responses.length - 1];
    };

    const r1 = await sendReq(1, { mutate: true });
    assert.equal(r1.returncode, 0);
    const out1 = JSON.parse(Buffer.from(r1.stdoutBase64, 'base64').toString('utf8'));
    const diag1 = Buffer.from(r1.stderrBase64, 'base64').toString('utf8');
    assert.equal(diag1, 'UINT8_SLICE|BUF_ENC|STR_BUF_ENC');

    const r2 = await sendReq(2, { mutate: false });
    assert.equal(r2.returncode, 0);
    const out2 = JSON.parse(Buffer.from(r2.stdoutBase64, 'base64').toString('utf8'));
    assert.equal(out2.pid, out1.pid, 'same persistent worker handled both requests');
    assert.equal(out2.sentinel, 'caller-original-value', 'PD_* caller env restored after loadProjectEnv()');
    assert.equal(out2.apiKey, null, '.env PAPER_ANALYZER_API_KEY deleted between requests');
    assert.equal(out2.extra, null, 'extra process.env key deleted between requests');
    assert.equal(out2.disableFileLogs, '1', 'VERIFY_PROJECT_DISABLE_FILE_LOGS preserved');
    assert.equal(out2.exitCodeDuringRun, 0, 'process.exitCode reset to 0 before next request');

    const closed = new Promise(resolve => child.once('close', code => resolve(code)));
    child.stdin.end();
    assert.equal(await closed, 0, 'worker exits cleanly with exitCode 0 on stdin end');
});

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const metadataApi = require('../scripts/lib/arxiv-metadata-source.js');
const sidecars = require('../scripts/lib/historical-arxiv-publication-metadata.js');
const freshSource = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
const freshRun = require('../scripts/lib/fresh-rewrite-run.js');
const cli = require('../scripts/historical-arxiv-publication-metadata.js');

const ID = '2601.00001';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
        .map(key => [key, canonical(value[key])]));
    return value;
}
const canonicalJson = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
function atom(id = ID, abstract = 'Official source abstract with enough exact words for publication.',
    updated = '2026-01-02T00:00:00Z', published = '2026-01-01T00:00:00Z', version = 1) {
    return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><opensearch:startIndex>0</opensearch:startIndex><opensearch:itemsPerPage>1</opensearch:itemsPerPage><entry><id>http://arxiv.org/abs/${id}v${version}</id><updated>${updated}</updated><published>${published}</published><title>Official title</title><summary>${abstract}</summary><author><name>Author One</name></author><category term="cs.SD"/></entry></feed>`;
}
function official(id = ID, abstract, updated, published, version, querySourceId = id,
    observedAt = '2026-01-04T00:00:00.000Z') {
    const result = metadataApi.parseOfficialArxivMetadataResponse(id,
        atom(id, abstract, updated, published, version), { querySourceId });
    return { ...result, proof: { ...result.proof, observedAt } };
}
async function fixture(t, suffix = '', sourceId = ID) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `publication-metadata-${suffix}`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, 'sources'); const sidecarRoot = path.join(root, 'sidecars');
    const text = ['Official title', suffix === 'different-source'
        ? 'Different sealed source bytes without an Abstract marker.'
        : 'Body without a deterministic abstract marker.', '1 Introduction', 'Body'].join('\n');
    await freshSource.captureFreshArxivRewriteSource({ rootDir: sourceRoot, arxivId: ID, generation: 1,
        now: '2026-01-03T00:00:00.000Z' }, {
        fetchText: async () => ({ source: 'html', sourceId, text, title: 'Official title',
            url: `https://arxiv.org/html/${sourceId}`, fetchedAt: '2026-01-03T00:00:00.000Z' }),
        fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.4\nfixture\n%%EOF\n'), sourceId,
            url: `https://arxiv.org/pdf/${sourceId}.pdf`, fetchedAt: '2026-01-03T00:00:01.000Z',
            ...(sourceId !== ID ? { currentPdfUnavailable: true, currentPdfStatus: 404 } : {}) }),
        extractPdfText: async () => ({ text, title: 'Official title', fetchedAt: '2026-01-03T00:00:01.000Z' })
    });
    return { root, sourceRoot, sidecarRoot };
}

test('publication metadata sidecar seals raw Atom and replays every source/record/abstract SHA', async t => {
    const f = await fixture(t); const result = sidecars.sealPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1, officialResult: official(),
        now: '2026-01-04T00:00:00.000Z' });
    assert.equal(result.status, 'sealed');
    assert.equal(result.abstract, 'Official source abstract with enough exact words for publication.');
    assert.equal(result.proof.contract, sidecars.CONTRACT);
    assert.equal(result.proof.entryVersion, 1);
    assert.equal(result.proof.entryUpdatedAt, '2026-01-02T00:00:00.000Z');
    assert.equal(result.proof.observedAt, '2026-01-04T00:00:00.000Z');
    assert.equal(result.proof.sourceLatestCapturedAt, '2026-01-03T00:00:01.000Z');
    assert.equal(result.proof.querySourceId, ID);
    assert.equal(result.proof.abstractSha256, sha(result.abstract));
    assert.deepEqual(result.authors, ['Author One']);
    assert.deepEqual(Object.keys(result.metadata).sort(), ['abstract', 'arxivId', 'authors', 'categories',
        'fetchedAt', 'paper_id', 'source', 'sources', 'title']);
    assert.equal(result.proof.metadataRecordSha256, freshRun.stableHash(result.metadata),
        'proof-only version/time fields must not change the metadata record hash contract');
    const recovered = sidecars.sealPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1, officialResult: official() });
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.proof.manifestSha256, result.proof.manifestSha256);
    assert.deepEqual(recovered.authors, ['Author One']);
});

test('verified legacy Atom author whitespace is normalized only in the returned view', async t => {
    const f = await fixture(t, 'author-whitespace');
    const raw = atom().replace('<name>Author One</name>', '<name>  Author One  </name>');
    const parsed = metadataApi.parseOfficialArxivMetadataResponse(ID, raw, { querySourceId: ID });
    const officialResult = { ...parsed, proof: { ...parsed.proof,
        observedAt: '2026-01-04T00:00:00.000Z' } };
    const sealed = sidecars.sealPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1, officialResult,
        now: '2026-01-04T00:00:00.000Z' });
    const atomFile = path.join(sealed.directory, sidecars.ATOM_NAME);
    const metadataFile = path.join(sealed.directory, sidecars.METADATA_NAME);
    const before = { atom: fs.readFileSync(atomFile), metadata: fs.readFileSync(metadataFile) };
    assert.deepEqual(sealed.authors, ['Author One']);
    assert.deepEqual(sealed.metadata.authors, ['  Author One  ']);
    const replayed = sidecars.readPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1 });
    assert.deepEqual(replayed.authors, ['Author One']);
    assert.deepEqual(fs.readFileSync(atomFile), before.atom);
    assert.deepEqual(fs.readFileSync(metadataFile), before.metadata);
});

test('publication metadata sidecar rejects semantic observed-time and raw entry-version drift', async t => {
    const observed = await fixture(t, 'observed-drift');
    sidecars.sealPublicationMetadata({ rootDir: observed.sidecarRoot, sourceRoot: observed.sourceRoot,
        arxivId: ID, generation: 1, officialResult: official() });
    const manifestFile = path.join(sidecars.sidecarDirectory(observed.sidecarRoot, ID, 1), sidecars.MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.atom.observedAt = '2027-01-05T00:00:00.000Z';
    fs.writeFileSync(manifestFile, canonicalJson(manifest), { mode: 0o600 });
    assert.throws(() => sidecars.readPublicationMetadata({ rootDir: observed.sidecarRoot,
        sourceRoot: observed.sourceRoot, arxivId: ID, generation: 1 }), /seal predates|observation/i);

    const version = await fixture(t, 'raw-version-drift');
    sidecars.sealPublicationMetadata({ rootDir: version.sidecarRoot, sourceRoot: version.sourceRoot,
        arxivId: ID, generation: 1, officialResult: official() });
    const atomFile = path.join(sidecars.sidecarDirectory(version.sidecarRoot, ID, 1), sidecars.ATOM_NAME);
    fs.writeFileSync(atomFile, fs.readFileSync(atomFile, 'utf8').replace(`${ID}v1`, `${ID}v2`), { mode: 0o600 });
    assert.throws(() => sidecars.readPublicationMetadata({ rootDir: version.sidecarRoot,
        sourceRoot: version.sourceRoot, arxivId: ID, generation: 1 }), /drift|response/i);
});

test('publication metadata sidecar accepts only Atom state no newer than its sealed source', async t => {
    const early = await fixture(t, 'early');
    assert.equal(sidecars.sealPublicationMetadata({ rootDir: early.sidecarRoot, sourceRoot: early.sourceRoot,
        arxivId: ID, generation: 1, officialResult: official() }).status, 'sealed');
    const late = await fixture(t, 'late');
    assert.throws(() => sidecars.sealPublicationMetadata({ rootDir: late.sidecarRoot, sourceRoot: late.sourceRoot,
        arxivId: ID, generation: 1,
        officialResult: official(ID, undefined, '2026-01-04T00:00:00Z') }), /newer than the sealed source/);
    const versioned = await fixture(t, 'versioned', `${ID}v1`);
    assert.throws(() => sidecars.sealPublicationMetadata({ rootDir: versioned.sidecarRoot,
        sourceRoot: versioned.sourceRoot, arxivId: ID, generation: 1,
        officialResult: official(ID, undefined, undefined, undefined, 2, `${ID}v2`) }), /version|query/i);
    assert.equal(sidecars.sealPublicationMetadata({ rootDir: versioned.sidecarRoot,
        sourceRoot: versioned.sourceRoot, arxivId: ID, generation: 1,
        officialResult: official(ID, undefined, undefined, undefined, 1, `${ID}v1`,
            '2026-01-02T00:00:00.000Z') }).status, 'sealed',
    'an exact versioned query may safely predate the source capture');
    const impossible = await fixture(t, 'impossible-versioned-time', `${ID}v1`);
    assert.throws(() => sidecars.sealPublicationMetadata({ rootDir: impossible.sidecarRoot,
        sourceRoot: impossible.sourceRoot, arxivId: ID, generation: 1,
        officialResult: official(ID, undefined, undefined, undefined, 1, `${ID}v1`,
            '2026-01-01T00:00:00.000Z') }), /newer than its observation time/);
    const stale = await fixture(t, 'stale');
    assert.throws(() => sidecars.sealPublicationMetadata({ rootDir: stale.sidecarRoot,
        sourceRoot: stale.sourceRoot, arxivId: ID, generation: 1,
        officialResult: official(ID, undefined, undefined, undefined, 1, ID,
            '2026-01-02T00:00:00.000Z') }), /predates the versionless sealed source/);
});

for (const target of [sidecars.ATOM_NAME, sidecars.METADATA_NAME, sidecars.MANIFEST_NAME]) {
    test(`publication metadata sidecar rejects ${target} byte drift`, async t => {
        const f = await fixture(t, target); sidecars.sealPublicationMetadata({ rootDir: f.sidecarRoot,
            sourceRoot: f.sourceRoot, arxivId: ID, generation: 1, officialResult: official() });
        const filename = path.join(sidecars.sidecarDirectory(f.sidecarRoot, ID, 1), target);
        fs.appendFileSync(filename, target === sidecars.ATOM_NAME ? '<!-- drift -->' : ' ');
        assert.throws(() => sidecars.readPublicationMetadata({ rootDir: f.sidecarRoot,
            sourceRoot: f.sourceRoot, arxivId: ID, generation: 1 }), /drift|canonical|response/i);
    });
}

test('publication metadata sidecar rejects wrong paper, proof, historical source version, and extra files', async t => {
    const f = await fixture(t); const wrong = official('2601.00002');
    assert.throws(() => sidecars.sealPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1, officialResult: wrong }), /belongs|replayed|response|query source ID/i);
    const drifted = official(); drifted.proof.fileSha256 = sha('wrong');
    assert.throws(() => sidecars.sealPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1, officialResult: drifted }), /proof/);
    sidecars.sealPublicationMetadata({ rootDir: f.sidecarRoot, sourceRoot: f.sourceRoot,
        arxivId: ID, generation: 1, officialResult: official() });
    fs.writeFileSync(path.join(sidecars.sidecarDirectory(f.sidecarRoot, ID, 1), 'extra'), 'x', { mode: 0o600 });
    assert.throws(() => sidecars.readPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1 }), /unexpected files/);
});

test('publication metadata sidecar rejects source generation bytes, manifest, snapshot, and text drift', async t => {
    const f = await fixture(t); sidecars.sealPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1, officialResult: official() });
    const sourceManifest = path.join(f.sourceRoot, ID, 'generation-000001', 'source-manifest.json');
    const driftedManifest = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'));
    driftedManifest.capturedAt = '2026-01-03T00:00:02.000Z';
    fs.writeFileSync(sourceManifest, canonicalJson(driftedManifest), { mode: 0o600 });
    assert.throws(() => sidecars.readPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1 }), /manifest|canonical|drift|bind/i);

    const other = await fixture(t, 'different-source');
    assert.throws(() => sidecars.readPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: other.sourceRoot, arxivId: ID, generation: 1 }), /source generation/i);
    const corrupt = await fixture(t, 'corrupt-source');
    const otherText = path.join(corrupt.sourceRoot, ID, 'generation-000001', 'source.txt');
    fs.appendFileSync(otherText, 'drift');
    assert.throws(() => sidecars.readPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: corrupt.sourceRoot, arxivId: ID, generation: 1 }), /source text drifted/i);
    assert.throws(() => sidecars.readPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: other.sourceRoot, arxivId: ID, generation: 2 }), /ENOENT|generation/i);
});

test('publication metadata sidecar rejects public permissions and hard-linked evidence', async t => {
    const f = await fixture(t); sidecars.sealPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1, officialResult: official() });
    const directory = sidecars.sidecarDirectory(f.sidecarRoot, ID, 1);
    const atomFile = path.join(directory, sidecars.ATOM_NAME);
    fs.chmodSync(atomFile, 0o644);
    assert.throws(() => sidecars.readPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1 }), /permissions/);
    fs.chmodSync(atomFile, 0o600);
    fs.linkSync(atomFile, path.join(f.root, 'atom-hardlink.xml'));
    assert.throws(() => sidecars.readPublicationMetadata({ rootDir: f.sidecarRoot,
        sourceRoot: f.sourceRoot, arxivId: ID, generation: 1 }), /unsafe.*Atom/i);
});

test('reusable historical Atom requires its raw bytes, official proof, and exact metadata record', async t => {
    const f = await fixture(t); const runs = path.join(f.root, 'runs'); fs.mkdirSync(runs, { mode: 0o700 });
    const runId = '11111111-1111-4111-8111-111111111111'; const directory = path.join(runs, runId);
    fs.mkdirSync(directory, { mode: 0o700 }); const result = official();
    const inputs = { contract: freshRun.INPUT_CONTRACT, version: 1, runId, date: '2026-01-01', papers: [result.metadata] };
    const legacyProof = { ...result.proof }; delete legacyProof.querySourceId;
    const run = { createdAt: '2026-01-02T00:00:00.000Z', metadataSources: { historicalRawMetadata: legacyProof } };
    fs.writeFileSync(path.join(directory, `metadata-${ID}.atom.xml`), result.rawBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'inputs.json'), JSON.stringify(inputs), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run), { mode: 0o600 });
    const reused = sidecars.findReusableOfficialAtom({ freshRewriteRoot: runs, arxivId: ID });
    assert.equal(reused.reusedFromRunId, runId); assert.equal(reused.proof.fileSha256, result.proof.fileSha256);
    assert.equal(reused.proof.observedAt, result.proof.observedAt);
    assert.equal(reused.proof.querySourceId, ID);
    assert.throws(() => sidecars.validateOfficialCompatibility({ sourceRoot: f.sourceRoot,
        arxivId: ID, generation: 1, officialResult: { ...reused,
            proof: { ...reused.proof, observedAt: '2026-01-02T00:00:00.000Z' } } }), /predates/);
    delete run.metadataSources.historicalRawMetadata.observedAt;
    fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run), { mode: 0o600 });
    assert.equal(sidecars.findReusableOfficialAtom({ freshRewriteRoot: runs, arxivId: ID }), null,
        'versionless legacy run.createdAt is not an identity-bound observation proof');
    run.metadataSources.historicalRawMetadata.observedAt = result.proof.observedAt;
    run.metadataSources.historicalRawMetadata.recordSha256 = sha('wrong');
    fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run), { mode: 0o600 });
    assert.equal(sidecars.findReusableOfficialAtom({ freshRewriteRoot: runs, arxivId: ID }), null);
});

test('publication metadata CLI parsing and parser-failure selection are plan-scoped and fail closed', () => {
    const parsed = cli.parseArgs(['--apply', '--plan', '/tmp/plan.json', '--generation', '1',
        '--all-parser-failures', '--concurrency', '3']);
    assert.equal(parsed.planFile, '/tmp/plan.json'); assert.equal(parsed.allParserFailures, true);
    assert.throws(() => cli.parseArgs(['--apply', '--generation', '1', '--all-parser-failures']), /Use/);
    const reads = [];
    const ids = cli.parserFailureIds('/tmp/source', 1, ['2601.00001', '2601.00002'], {
        freshSource: { readFreshArxivRewriteSource: ({ arxivId }) => {
            reads.push(arxivId); return { text: arxivId.endsWith('1') ? 'valid' : 'ambiguous' };
        } }, runner: { extractSealedArxivAbstract: text => {
            if (text === 'ambiguous') {
                const error = new Error('no boundary'); error.code = 'HISTORICAL_DIRECT_REWRITE_EXECUTION_INTEGRITY'; throw error;
            }
            return 'ok';
        } }
    });
    assert.deepEqual(ids, ['2601.00002']); assert.deepEqual(reads, ['2601.00001', '2601.00002']);
    assert.throws(() => cli.parserFailureIds('/tmp/source', 1, ['2601.00001'], {
        freshSource: { readFreshArxivRewriteSource: () => { throw new Error('source drift'); } },
        runner: { extractSealedArxivAbstract: () => 'ok' }
    }), /source drift/);
    assert.throws(() => cli.parserFailureIds('/tmp/source', 1, ['2601.00001'], {
        freshSource: { readFreshArxivRewriteSource: () => ({ text: 'anything' }) },
        runner: { extractSealedArxivAbstract: () => { throw new TypeError('implementation bug'); } }
    }), /implementation bug/);
});

test('publication metadata CLI dry-run/apply stay plan-scoped and use only injected official transport', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'publication-metadata-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const planFile = path.join(root, 'plan.json'); fs.writeFileSync(planFile, '{}', { mode: 0o600 });
    const plan = { queue: [
        { paperId: 'arxiv:2601.00001', route: { kind: 'arxiv-fresh-fetch', arxivId: '2601.00001' } },
        { paperId: 'arxiv:2601.00002', route: { kind: 'arxiv-fresh-fetch', arxivId: '2601.00002' } }
    ] };
    const files = { freshArxivFetchedSourcesDir: path.join(root, 'sources'),
        historicalArxivPublicationMetadataDir: path.join(root, 'sidecars'),
        freshRewriteRunsDir: path.join(root, 'runs') };
    for (const directory of Object.values(files)) fs.mkdirSync(directory, { mode: 0o700 });
    const outputs = []; const oldLog = console.log; console.log = value => outputs.push(value); t.after(() => { console.log = oldLog; });
    const common = { files, config: { FILES: files }, projections: { readStableJson: () => ({ value: plan }) },
        planApi: { normalizePlan: value => value },
        freshSource: { readFreshArxivRewriteSource: ({ arxivId }) => ({ text: arxivId.endsWith('1') ? 'valid' : 'ambiguous' }) },
        runner: { extractSealedArxivAbstract: text => {
            if (text === 'ambiguous') { const error = new Error('no boundary');
                error.code = 'HISTORICAL_DIRECT_REWRITE_EXECUTION_INTEGRITY'; throw error; }
            return 'abstract';
        } }
    };
    const fakeSidecars = { sidecarDirectory: (_root, id) => path.join(root, 'sidecars', id),
        readPublicationMetadata: () => { throw new Error('not expected'); },
        findReusableOfficialAtom: () => null,
        querySourceIdForSource: ({ arxivId }) => arxivId,
        sealPublicationMetadata: () => ({ status: 'sealed', proof: { manifestSha256: sha('manifest') } }) };
    const dry = await cli.main(['--dry-run', '--plan', planFile, '--generation', '1', '--all-parser-failures'], {
        ...common, sidecars: fakeSidecars, metadata: { fetchOfficialArxivMetadata: () => { throw new Error('network forbidden'); } }
    });
    assert.equal(dry.total, 1); assert.equal(dry.networkRequired, 1);
    const all = await cli.main(['--dry-run', '--plan', planFile, '--generation', '1'], {
        ...common, sidecars: fakeSidecars,
        metadata: { fetchOfficialArxivMetadata: () => { throw new Error('network forbidden'); } }
    });
    assert.equal(all.total, 2); assert.equal(all.networkRequired, 2);
    let fetches = 0;
    const applied = await cli.main(['--apply', '--plan', planFile, '--generation', '1',
        '--paper-ids', '2601.00002'], { ...common, sidecars: fakeSidecars,
        fetchOfficialArxivMetadata: async (id, options) => { fetches += 1; assert.equal(options.querySourceId, id); return { official: true }; },
        metadata: { fetchOfficialArxivMetadata: () => { throw new Error('wrong transport'); } } });
    assert.equal(fetches, 1); assert.equal(applied.fetched, 1); assert.equal(applied.status, 'complete');
});

test('publication metadata batch retains a transient failure, seals peers, exits partial, and resumes idempotently', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'publication-metadata-partial-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const planFile = path.join(root, 'plan.json'); fs.writeFileSync(planFile, '{}', { mode: 0o600 });
    const ids = ['2601.00001', '2601.00002'];
    const plan = { queue: ids.map(arxivId => ({ paperId: `arxiv:${arxivId}`,
        route: { kind: 'arxiv-fresh-fetch', arxivId } })) };
    const files = { freshArxivFetchedSourcesDir: path.join(root, 'sources'),
        historicalArxivPublicationMetadataDir: path.join(root, 'sidecars'),
        freshRewriteRunsDir: path.join(root, 'runs') };
    for (const directory of Object.values(files)) fs.mkdirSync(directory, { mode: 0o700 });
    const directoryFor = id => path.join(files.historicalArxivPublicationMetadataDir, id, 'generation-000001');
    const sealedIds = [];
    const fakeSidecars = {
        sidecarDirectory: (_root, id) => directoryFor(id),
        readPublicationMetadata: ({ arxivId }) => ({ proof: { paperId: `arxiv:${arxivId}` } }),
        findReusableOfficialAtom: () => null,
        querySourceIdForSource: ({ arxivId }) => arxivId,
        sealPublicationMetadata: ({ arxivId }) => {
            fs.mkdirSync(directoryFor(arxivId), { recursive: true, mode: 0o700 });
            sealedIds.push(arxivId);
            return { status: 'sealed', proof: { manifestSha256: sha(`manifest:${arxivId}`) } };
        }
    };
    const common = { files, config: { FILES: files }, sidecars: fakeSidecars,
        projections: { readStableJson: () => ({ value: plan }) }, planApi: { normalizePlan: value => value } };
    let failFirst = true; const fetched = [];
    const fetchOfficialArxivMetadata = async id => {
        fetched.push(id);
        if (id === ids[0] && failFirst) {
            const error = new Error('bounded Atom transport failure');
            error.code = 'ARXIV_METADATA_NETWORK_TRANSIENT'; error.retryable = true; error.attempts = 3;
            throw error;
        }
        return { official: id };
    };
    const oldLog = console.log; console.log = () => {};
    t.after(() => { console.log = oldLog; });
    const first = await cli.main(['--apply', '--plan', planFile, '--generation', '1', '--concurrency', '2'], {
        ...common, fetchOfficialArxivMetadata
    });
    assert.equal(first.status, 'partial'); assert.equal(first.failed, 1);
    assert.equal(first.sealed, 1); assert.equal(first.fetched, 1);
    assert.deepEqual(first.results.map(item => [item.paperId, item.status]), [
        [`arxiv:${ids[0]}`, 'failed'], [`arxiv:${ids[1]}`, 'sealed']
    ]);
    assert.equal(first.results[0].retryable, true); assert.equal(first.results[0].attempts, 3);
    assert.equal(cli.partialExitCode(first), 1);
    assert.equal(fs.existsSync(directoryFor(ids[0])), false, 'failed paper cannot leave a sidecar directory');
    assert.equal(fs.existsSync(directoryFor(ids[1])), true);

    failFirst = false;
    const second = await cli.main(['--apply', '--plan', planFile, '--generation', '1', '--concurrency', '2'], {
        ...common, fetchOfficialArxivMetadata
    });
    assert.equal(second.status, 'complete'); assert.equal(second.failed, 0);
    assert.equal(second.sealed, 1); assert.equal(second.recovered, 1);
    assert.equal(cli.partialExitCode(second), 0);
    assert.deepEqual(sealedIds, [ids[1], ids[0]], 'the recovered peer is never resealed');
    assert.deepEqual(fetched, [ids[0], ids[1], ids[0]], 'resume fetches only the previously failed paper');

    fs.rmSync(directoryFor(ids[0]), { recursive: true, force: true });
    await assert.rejects(cli.main(['--apply', '--plan', planFile, '--generation', '1',
        '--paper-ids', ids[0]], { ...common,
        fetchOfficialArxivMetadata: async () => { throw new TypeError('implementation bug'); } }),
    /implementation bug/, 'unexpected implementation failures remain fail-closed');
});

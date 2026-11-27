'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const Config = require('../scripts/config.js');
const protocolCodec = require('../scripts/lib/protocol-codec.js');
const paperExemptions = require('../scripts/lib/analysis-contract-paper-exemptions.js');
const analysisContract = require('../scripts/analysis-contract.js');
const deepAnalyzer = require('../scripts/deep-analyzer.js');
const deepArxivSourceFetch = require('../scripts/lib/deep-arxiv-source-fetch.js');
const deepPrimarySections = require('../scripts/lib/deep-primary-sections.js');
const paperPageStaging = require('../scripts/lib/paper-page-staging.js');
const impact = require('../scripts/impact.js');
const { collectWorkflowImplementationFiles } = require('../scripts/lib/workflow-implementation-files.js');

function runPythonJson(pythonCode, args = []) {
    const stdout = execFileSync(
        'bash',
        ['scripts/python-runtime.sh', '-c', pythonCode, ...args],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return JSON.parse(stdout);
}

describe('R4-W3.1: config/runtime-paths.json shared JS/Python SSOT parity', () => {
    it('loads config/runtime-paths.json identically in Node and Python with 100% resolved path parity', () => {
        const rawSpec = JSON.parse(
            fs.readFileSync(path.join(REPO_ROOT, 'config', 'runtime-paths.json'), 'utf8')
        );
        assert.deepEqual(Config.RUNTIME_PATHS, rawSpec);

        const pyData = runPythonJson(`
import json, sys
sys.path.insert(0, "scripts")
import path_config as pc
print(json.dumps({
    "RUNTIME_PATHS": pc.RUNTIME_PATHS,
    "PROJECT_ROOT": str(pc.PROJECT_ROOT),
    "DATA_DIR": str(pc.DATA_DIR),
    "CURRENT_DIR": str(pc.CURRENT_DIR),
    "ARCHIVE_DIR": str(pc.ARCHIVE_DIR),
    "RUNTIME_DIR": str(pc.RUNTIME_DIR),
    "LOGS_DIR": str(pc.LOGS_DIR),
    "LLM_ACCOUNT_POOL_STATE_FILE": str(pc.LLM_ACCOUNT_POOL_STATE_FILE),
    "LLM_USAGE_DIR": str(pc.LLM_USAGE_DIR),
    "LLM_USAGE_DAILY_DIR": str(pc.LLM_USAGE_DAILY_DIR),
    "LLM_RESPONSE_RECOVERY_DIR": str(pc.LLM_RESPONSE_RECOVERY_DIR),
    "FRESH_REWRITE_RUNS_DIR": str(pc.FRESH_REWRITE_RUNS_DIR),
    "DAILY_FRESH_SOURCE_RUNS_DIR": str(pc.DAILY_FRESH_SOURCE_RUNS_DIR),
    "DAILY_SCORING_REFRESH_RECOVERY_DIR": str(pc.DAILY_SCORING_REFRESH_RECOVERY_DIR),
    "DAILY_RENDER_OBSERVATIONS_DIR": str(pc.DAILY_RENDER_OBSERVATIONS_DIR),
    "DAILY_DEPLOYMENT_OBSERVATIONS_DIR": str(pc.DAILY_DEPLOYMENT_OBSERVATIONS_DIR),
    "DAILY_REPUBLICATION_RUNS_DIR": str(pc.DAILY_REPUBLICATION_RUNS_DIR),
    "DAILY_PODCAST_DIR": str(pc.DAILY_PODCAST_DIR),
    "HISTORICAL_PAGE_INVENTORY_DIR": str(pc.HISTORICAL_PAGE_INVENTORY_DIR),
    "CONFERENCE_STAGING_SOURCE_DIR": str(pc.CONFERENCE_STAGING_SOURCE_DIR),
    "BLOG_REVIEW_CHECKPOINTS_DIR": str(pc.BLOG_REVIEW_CHECKPOINTS_DIR),
    "DAILY_REPUBLICATION_MARKER_DIRNAME": pc.DAILY_REPUBLICATION_MARKER_DIRNAME,
    "PUBLICATION_ACTIVATION_DIRNAME": pc.PUBLICATION_ACTIVATION_DIRNAME,
    "RESEARCHER_SIDECAR_RELATIVE_ROOT": str(pc.RESEARCHER_SIDECAR_RELATIVE_ROOT),
    "DEFAULT_BLOG_BASE_PATH": pc.DEFAULT_BLOG_BASE_PATH,
    "PAPERS_FILE": str(pc.PAPERS_FILE),
    "PAPERS_LEGACY_FILE": str(pc.PAPERS_LEGACY_FILE),
    "RAW_CANDIDATES_FILE": str(pc.RAW_CANDIDATES_FILE),
    "FETCH_CHECKPOINT_FILE": str(pc.FETCH_CHECKPOINT_FILE),
    "FILTER_DECISIONS_FILE": str(pc.FILTER_DECISIONS_FILE),
    "FILTERED_PAPERS_FILE": str(pc.FILTERED_PAPERS_FILE),
    "DEEP_ANALYSIS_RESULT_FILE": str(pc.DEEP_ANALYSIS_RESULT_FILE),
    "DEEP_ANALYSIS_RESULT_LEGACY_FILE": str(pc.DEEP_ANALYSIS_RESULT_LEGACY_FILE),
    "VISUAL_SUMMARY_MANIFEST_DIR": str(pc.VISUAL_SUMMARY_MANIFEST_DIR),
    "VISUAL_SUMMARY_ASSET_DIR": str(pc.VISUAL_SUMMARY_ASSET_DIR),
    "DIGEST_COVER_MANIFEST_DIR": str(pc.DIGEST_COVER_MANIFEST_DIR),
    "DIGEST_COVER_ASSET_DIR": str(pc.DIGEST_COVER_ASSET_DIR),
    "ANALYSIS_WAIVER_DIR": str(pc.ANALYSIS_WAIVER_DIR),
    "POST_PUBLISH_VISUAL_WAIVER_DIR": str(pc.POST_PUBLISH_VISUAL_WAIVER_DIR),
    "DIGEST_RUN_REPORT_DIR": str(pc.DIGEST_RUN_REPORT_DIR),
    "ANALYZED_FILE": str(pc.ANALYZED_FILE),
    "ANALYZED_LEGACY_FILE": str(pc.ANALYZED_LEGACY_FILE),
}, ensure_ascii=False))
`);

        assert.deepEqual(pyData.RUNTIME_PATHS, rawSpec);

        const pairs = [
            ['PROJECT_ROOT', Config.PROJECT_ROOT],
            ['DATA_DIR', Config.DATA_DIR],
            ['CURRENT_DIR', Config.CURRENT_DIR],
            ['ARCHIVE_DIR', Config.ARCHIVE_DIR],
            ['RUNTIME_DIR', Config.RUNTIME_DIR],
            ['LOGS_DIR', Config.LOGS_DIR],
            ['LLM_ACCOUNT_POOL_STATE_FILE', Config.FILES.llmAccountPoolState],
            ['LLM_USAGE_DIR', Config.FILES.llmUsageDir],
            ['LLM_USAGE_DAILY_DIR', Config.FILES.llmUsageDailyDir],
            ['LLM_RESPONSE_RECOVERY_DIR', Config.FILES.llmResponseRecoveryDir],
            ['FRESH_REWRITE_RUNS_DIR', Config.FILES.freshRewriteRunsDir],
            ['DAILY_FRESH_SOURCE_RUNS_DIR', Config.FILES.dailyFreshSourceRunsDir],
            ['DAILY_SCORING_REFRESH_RECOVERY_DIR', Config.FILES.dailyScoringRefreshRecoveryDir],
            ['DAILY_RENDER_OBSERVATIONS_DIR', Config.FILES.dailyRenderObservationsDir],
            ['DAILY_DEPLOYMENT_OBSERVATIONS_DIR', Config.FILES.dailyDeploymentObservationsDir],
            ['DAILY_REPUBLICATION_RUNS_DIR', Config.FILES.dailyRepublicationRunsDir],
            ['DAILY_PODCAST_DIR', Config.FILES.dailyPodcastDir],
            ['HISTORICAL_PAGE_INVENTORY_DIR', Config.FILES.historicalPageInventoryDir],
            ['CONFERENCE_STAGING_SOURCE_DIR', Config.FILES.conferenceStagingSourceDir],
            ['BLOG_REVIEW_CHECKPOINTS_DIR', Config.FILES.blogReviewCheckpointsDir],
            ['PAPERS_FILE', Config.FILES.papers],
            ['PAPERS_LEGACY_FILE', Config.FILES.papersLegacy],
            ['RAW_CANDIDATES_FILE', Config.FILES.rawCandidates],
            ['FETCH_CHECKPOINT_FILE', Config.FILES.fetchCheckpoint],
            ['FILTER_DECISIONS_FILE', Config.FILES.filterDecisions],
            ['FILTERED_PAPERS_FILE', Config.FILES.filteredPapers],
            ['DEEP_ANALYSIS_RESULT_FILE', Config.FILES.deepAnalysisResult],
            ['DEEP_ANALYSIS_RESULT_LEGACY_FILE', Config.FILES.deepAnalysisResultLegacy],
            ['VISUAL_SUMMARY_MANIFEST_DIR', Config.FILES.visualSummaryManifestDir],
            ['VISUAL_SUMMARY_ASSET_DIR', Config.FILES.visualSummaryAssetDir],
            ['DIGEST_COVER_MANIFEST_DIR', Config.FILES.digestCoverManifestDir],
            ['DIGEST_COVER_ASSET_DIR', Config.FILES.digestCoverAssetDir],
            ['ANALYSIS_WAIVER_DIR', Config.FILES.analysisWaiverDir],
            ['POST_PUBLISH_VISUAL_WAIVER_DIR', Config.FILES.postPublishVisualWaiverDir],
            ['DIGEST_RUN_REPORT_DIR', Config.FILES.digestRunReportDir],
            ['ANALYZED_FILE', Config.FILES.analyzed],
            ['ANALYZED_LEGACY_FILE', Config.FILES.analyzedLegacy]
        ];
        for (const [pyKey, nodeValue] of pairs) {
            assert.equal(pyData[pyKey], nodeValue, `Node/Python path mismatch on ${pyKey}`);
        }
        assert.equal(pyData.DAILY_REPUBLICATION_MARKER_DIRNAME, rawSpec.currentDirs.blogRepublications);
        assert.equal(pyData.PUBLICATION_ACTIVATION_DIRNAME, rawSpec.currentDirs.blogPublicationActivations);
        assert.equal(pyData.RESEARCHER_SIDECAR_RELATIVE_ROOT, rawSpec.blogRelativePaths.researcherSidecarRoot);
        assert.equal(pyData.DEFAULT_BLOG_BASE_PATH, Config.resolveBlogBasePath(undefined));
    });

    it('dynamically loads modified runtime-paths.json and rejects traversal/malformed JSON in both Node and Python', t => {
        const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r4-runtime-paths-'));
        t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

        const customSpec = structuredClone(Config.RUNTIME_PATHS);
        customSpec.currentFiles.papers = 'custom-papers.json';
        customSpec.runtimeEntries.dailyFreshSourceRuns = 'custom-fresh-runs';
        customSpec.runtimeEntries.llmUsageDaily = 'custom-usage-daily';
        const customFile = path.join(tmp, 'runtime-paths.json');
        fs.writeFileSync(customFile, JSON.stringify(customSpec, null, 2), 'utf8');

        const nodeLoaded = Config.loadRuntimePathsSpec(customFile);
        const pyLoaded = runPythonJson(
            'import json, sys; sys.path.insert(0, "scripts"); import path_config as pc; print(json.dumps(pc.load_runtime_paths_spec(sys.argv[1])))',
            [customFile]
        );
        assert.equal(nodeLoaded.currentFiles.papers, 'custom-papers.json');
        assert.equal(nodeLoaded.runtimeEntries.dailyFreshSourceRuns, 'custom-fresh-runs');
        assert.equal(nodeLoaded.runtimeEntries.llmUsageDaily, 'custom-usage-daily');
        assert.deepEqual(pyLoaded, nodeLoaded);

        // Negative: path traversal rejected in both languages
        const badSpec = structuredClone(customSpec);
        badSpec.runtimeEntries.llmUsage = '../escape';
        const badFile = path.join(tmp, 'bad-runtime-paths.json');
        fs.writeFileSync(badFile, JSON.stringify(badSpec), 'utf8');
        assert.throws(() => Config.loadRuntimePathsSpec(badFile), /非法路径段/);
        assert.throws(() => runPythonJson(
            'import sys; sys.path.insert(0, "scripts"); import path_config as pc; pc.load_runtime_paths_spec(sys.argv[1])',
            [badFile]
        ));

        // Negative: malformed JSON rejected in both languages
        const corruptFile = path.join(tmp, 'corrupt-runtime-paths.json');
        fs.writeFileSync(corruptFile, '{broken', 'utf8');
        assert.throws(() => Config.loadRuntimePathsSpec(corruptFile), /无法读取或解析/);
        assert.throws(() => runPythonJson(
            'import sys; sys.path.insert(0, "scripts"); import path_config as pc; pc.load_runtime_paths_spec(sys.argv[1])',
            [corruptFile]
        ));
    });

    it('validates unknown extra keys in every section of config/runtime-paths.json symmetrically in Node and Python', t => {
        const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r4-runtime-paths-extra-'));
        t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

        // Positive: valid relative-path extra keys across sections load identically in Node and Python
        const validExtraSpec = structuredClone(Config.RUNTIME_PATHS);
        validExtraSpec.dirs.customExtraDir = 'data/custom-extra';
        validExtraSpec.currentFiles.customExtraFile = 'custom-extra.json';
        validExtraSpec.currentDirs.customExtraSubdir = 'custom-subdir';
        validExtraSpec.runtimeEntries.customExtraRuntime = 'custom-runtime-entry';
        validExtraSpec.projectEntries.customExtraProject = 'config/custom-extra.json';
        validExtraSpec.blogRelativePaths.customExtraBlog = 'static/custom-extra';
        const validExtraFile = path.join(tmp, 'valid-extra.json');
        fs.writeFileSync(validExtraFile, JSON.stringify(validExtraSpec, null, 2), 'utf8');

        const nodeLoaded = Config.loadRuntimePathsSpec(validExtraFile);
        const pyLoaded = runPythonJson(
            'import json, sys; sys.path.insert(0, "scripts"); import path_config as pc; print(json.dumps(pc.load_runtime_paths_spec(sys.argv[1])))',
            [validExtraFile]
        );
        assert.deepEqual(nodeLoaded, validExtraSpec);
        assert.deepEqual(pyLoaded, nodeLoaded);

        // Negative: invalid/traversal extra keys in EVERY section fail closed in Node and Python
        const sections = Object.keys(Config.RUNTIME_PATHS);
        const badValues = ['../escape', 'safe/../escape', 'safe/./dot', '/abs/path', 'win\\sep', '', 123];
        for (const section of sections) {
            for (const [idx, badValue] of badValues.entries()) {
                const badSpec = structuredClone(Config.RUNTIME_PATHS);
                badSpec[section].extraKey = badValue;
                const badFile = path.join(tmp, `bad-${section}-${idx}.json`);
                fs.writeFileSync(badFile, JSON.stringify(badSpec), 'utf8');
                assert.throws(
                    () => Config.loadRuntimePathsSpec(badFile),
                    /非法路径段|非空相对路径/,
                    `Node must reject invalid extra key ${section}.extraKey=${JSON.stringify(badValue)}`
                );
            }
            // Spot-check Python parity per section for traversal in extra key
            const pyBadSpec = structuredClone(Config.RUNTIME_PATHS);
            pyBadSpec[section].extraKey = '../escape';
            const pyBadFile = path.join(tmp, `py-bad-${section}.json`);
            fs.writeFileSync(pyBadFile, JSON.stringify(pyBadSpec), 'utf8');
            assert.throws(() => runPythonJson(
                'import sys; sys.path.insert(0, "scripts"); import path_config as pc; pc.load_runtime_paths_spec(sys.argv[1])',
                [pyBadFile]
            ), `Python must reject traversal extra key in ${section}`);
        }

        // Negative: __proto__ extra key with traversal must fail closed and safe __proto__ must not pollute prototype
        const protoBadRaw = JSON.stringify(Config.RUNTIME_PATHS).replace(
            '"llmUsage":"llm-usage"',
            '"llmUsage":"llm-usage","__proto__":"../escape"'
        );
        const protoBadFile = path.join(tmp, 'proto-bad.json');
        fs.writeFileSync(protoBadFile, protoBadRaw, 'utf8');
        assert.throws(() => Config.loadRuntimePathsSpec(protoBadFile), /非法路径段/);

        const protoSafeRaw = JSON.stringify(Config.RUNTIME_PATHS).replace(
            '"llmUsage":"llm-usage"',
            '"llmUsage":"llm-usage","__proto__":"safe-proto-entry"'
        );
        const protoSafeFile = path.join(tmp, 'proto-safe.json');
        fs.writeFileSync(protoSafeFile, protoSafeRaw, 'utf8');
        const protoLoaded = Config.loadRuntimePathsSpec(protoSafeFile);
        assert.equal(Object.prototype.hasOwnProperty.call(protoLoaded.runtimeEntries, '__proto__'), true);
        assert.equal(protoLoaded.runtimeEntries['__proto__'], 'safe-proto-entry');
        assert.equal(Object.getPrototypeOf(protoLoaded.runtimeEntries), Object.prototype);
    });

    it('workflow-implementation-files.js includes config/runtime-paths.json for config.js & path_config.py and rejects missing/symlink files', t => {
        for (const entry of [
            'scripts/config.js',
            'scripts/path_config.py',
            'scripts/analysis-engine.js',
            'scripts/publish-to-blog.py'
        ]) {
            const closure = collectWorkflowImplementationFiles({ root: REPO_ROOT, entryFiles: [entry] });
            assert.equal(
                closure.includes('config/runtime-paths.json'),
                true,
                `${entry} closure must include config/runtime-paths.json`
            );
        }

        // Isolated fixture validating regular-file / symlink enforcement & no global leakage
        const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r4-runtime-paths-closure-'));
        t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
        const write = (rel, content) => {
            const target = path.join(tmp, rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content);
        };
        write(
            'scripts/lib/workflow-implementation-files.js',
            fs.readFileSync(require.resolve('../scripts/lib/workflow-implementation-files.js'))
        );
        write('scripts/config.js', "'use strict'; // fixture config\n");
        write('scripts/path_config.py', '# fixture path_config\n');
        write('scripts/js-consumer.js', "require('./config.js');\n");
        write('scripts/py-consumer.py', 'import path_config\n');
        write('scripts/unrelated.js', "'use strict';\n");
        write('config/runtime-paths.json', '{}\n');

        for (const entry of ['scripts/js-consumer.js', 'scripts/py-consumer.py']) {
            const files = collectWorkflowImplementationFiles({ root: tmp, entryFiles: [entry] });
            assert.equal(files.includes('config/runtime-paths.json'), true, `${entry} must include config/runtime-paths.json`);
        }
        const unrelatedBefore = collectWorkflowImplementationFiles({ root: tmp, entryFiles: ['scripts/unrelated.js'] });
        assert.equal(unrelatedBefore.includes('config/runtime-paths.json'), false);

        const runtimePathsFile = path.join(tmp, 'config/runtime-paths.json');
        // Symlink must be rejected
        const outside = path.join(tmp, 'outside.json');
        fs.writeFileSync(outside, '{}\n');
        fs.unlinkSync(runtimePathsFile);
        fs.symlinkSync(outside, runtimePathsFile);
        for (const entry of ['scripts/js-consumer.js', 'scripts/py-consumer.py']) {
            assert.throws(
                () => collectWorkflowImplementationFiles({ root: tmp, entryFiles: [entry] }),
                /regular project file/
            );
        }

        // Missing file must be rejected for config/path_config owners, while unrelated entry still passes
        fs.unlinkSync(runtimePathsFile);
        for (const entry of ['scripts/js-consumer.js', 'scripts/py-consumer.py']) {
            assert.throws(
                () => collectWorkflowImplementationFiles({ root: tmp, entryFiles: [entry] }),
                /Implementation file is missing/
            );
        }
        assert.deepEqual(
            collectWorkflowImplementationFiles({ root: tmp, entryFiles: ['scripts/unrelated.js'] }),
            unrelatedBefore
        );
    });
});

describe('R4-P1-2: paper-page-staging.js & impact.js reference scripts/tutorial_payload_verifier_core.py', () => {
    it('tracks scripts/tutorial_payload_verifier_core.py in RENDERER_ENTRY_FILES and BLOG_REVIEW_ENTRIES', () => {
        assert.equal(
            paperPageStaging.RENDERER_ENTRY_FILES.includes('scripts/tutorial_payload_verifier_core.py'),
            true,
            'RENDERER_ENTRY_FILES must include scripts/tutorial_payload_verifier_core.py'
        );
        assert.equal(
            paperPageStaging.RENDERER_ENTRY_FILES.includes('manual/scripts/tutorial_payload_verifier.py'),
            false,
            'RENDERER_ENTRY_FILES must not include retired manual/scripts/tutorial_payload_verifier.py'
        );
        assert.equal(
            paperPageStaging.rendererImplementationFiles().includes('scripts/tutorial_payload_verifier_core.py'),
            true,
            'rendererImplementationFiles() must include scripts/tutorial_payload_verifier_core.py'
        );

        const closures = impact.collectFingerprintClosures({ fresh: true });
        const rendererClosure = closures.find(item => item.id === 'paperPageRenderer');
        const reviewClosure = closures.find(item => item.id === 'blogReviewProtocol');
        assert.ok(rendererClosure && reviewClosure);
        assert.equal(rendererClosure.files.has('scripts/tutorial_payload_verifier_core.py'), true);
        assert.equal(reviewClosure.files.has('scripts/tutorial_payload_verifier_core.py'), true);

        const impactSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'impact.js'), 'utf8');
        const stagingSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'paper-page-staging.js'), 'utf8');
        assert.equal(impactSrc.includes('scripts/tutorial_payload_verifier_core.py'), true);
        assert.equal(impactSrc.includes('manual/scripts/tutorial_payload_verifier.py'), false);
        assert.equal(stagingSrc.includes('manual/scripts/tutorial_payload_verifier.py'), false);

        const coreImpact = impact.impactOf('scripts/tutorial_payload_verifier_core.py');
        const impactIds = coreImpact.fingerprintImpacts.map(item => item.id);
        assert.equal(impactIds.includes('paperPageRenderer'), true);
        assert.equal(impactIds.includes('blogReviewProtocol'), true);
    });
});

describe('R4-W3.2: protocol-codec.js serverCatalogPaths() & catalogPaths() parity with Python', () => {
    it('matches Python protocol_codec.py server_catalog_paths() and catalog_paths() 100% in exact order', () => {
        const pyPaths = runPythonJson(`
import json, sys
sys.path.insert(0, "scripts")
import protocol_codec as pc
print(json.dumps({
    "all": [str(p) for p in pc.catalog_paths()],
    "server": [str(p) for p in pc.server_catalog_paths()],
}))
`);
        const jsAll = protocolCodec.catalogPaths();
        const jsServer = protocolCodec.serverCatalogPaths();

        assert.deepEqual(jsAll, pyPaths.all);
        assert.deepEqual(jsServer, pyPaths.server);
        assert.ok(jsAll.length > jsServer.length, 'native clients-*.json catalogs must be excluded from serverCatalogPaths');
        assert.ok(
            jsServer.every(filename => !path.basename(filename).startsWith('clients-')),
            'serverCatalogPaths must exclude all clients-*.json files'
        );
        assert.ok(
            jsServer.some(filename => path.basename(filename) === 'clients.json'),
            'serverCatalogPaths must retain shared clients.json'
        );
        assert.ok(
            jsServer.some(filename => path.basename(filename) === 'tags.json'),
            'serverCatalogPaths must retain shared tags.json'
        );
    });

    it('filters clients-*.json and rejects symlinked directories identically to Python', t => {
        const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r4-proto-paths-'));
        t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
        const realDir = path.join(tmp, 'protocols');
        fs.mkdirSync(realDir);
        for (const name of ['zeta.json', 'clients-reading.json', 'clients.json', 'alpha.json', 'README.txt']) {
            fs.writeFileSync(path.join(realDir, name), '{"protocols":[]}\n', 'utf8');
        }
        const py = runPythonJson(
            'import json, sys; sys.path.insert(0, "scripts"); import protocol_codec as pc; print(json.dumps({"all":[str(p) for p in pc.catalog_paths(sys.argv[1])],"server":[str(p) for p in pc.server_catalog_paths(sys.argv[1])]}))',
            [realDir]
        );
        assert.deepEqual(protocolCodec.catalogPaths(realDir), py.all);
        assert.deepEqual(protocolCodec.serverCatalogPaths(realDir), py.server);
        assert.deepEqual(
            protocolCodec.serverCatalogPaths(realDir).map(p => path.basename(p)),
            ['alpha.json', 'clients.json', 'zeta.json']
        );

        const symlinkDir = path.join(tmp, 'symlink-protocols');
        fs.symlinkSync(realDir, symlinkDir);
        assert.throws(() => protocolCodec.serverCatalogPaths(symlinkDir), /符号链接/);
    });
});

describe('R4-W3.3: analysis-contract.js manual/ lazy-loading & 43+ exemptions quarantine', () => {
    it('never loads any manual/scripts/*.js module on require() or non-manual API calls in a fresh Node process', () => {
        const script = `
const contract = require('./scripts/analysis-contract.js');
const keys = Object.keys(contract);
const tables = contract.extractMarkdownTables('| Method | WER ↓ |\\n| --- | --- |\\n| A | 1.2% |');
const missing = contract.getMissingRequiredSections('## 评分\\n8.0');
const fresh = contract.validateFreshAuthoringRecordConsistency({}, {});
const payload = contract.validateTutorialPayloadRecordConsistency({}, {});
const takeover = contract.validateManualTakeoverManifest({}, '');
const loadedManualBefore = Object.keys(require.cache).filter(p => p.includes('/manual/'));
console.log(JSON.stringify({
    exportCount: keys.length,
    tableCount: tables.length,
    missingCount: missing.length,
    fresh,
    payload,
    takeover,
    loadedManualBefore
}));
`;
        const stdout = execFileSync(process.execPath, ['-e', script], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const result = JSON.parse(stdout);
        assert.deepEqual(result.loadedManualBefore, [], 'Requiring analysis-contract.js must not load manual/scripts/*');
        assert.equal(result.tableCount, 1);
        assert.ok(result.missingCount > 0);
        assert.equal(result.fresh, null);
        assert.equal(result.payload, null);
        assert.equal(result.takeover, null);
    });

    it('lazily resolves manual exported constants on explicit property access or destructuring', () => {
        const script = `
const {
    CURRENT_MODEL_POLICY,
    MANUAL_RESEARCH_CONTRACT,
    FRESH_AUTHORING_CONTRACT,
    FRESH_AUTHORING_MODE,
    MANUAL_TUTORIAL_PAYLOAD_CONTRACT
} = require('./scripts/analysis-contract.js');
const loadedManualAfter = Object.keys(require.cache)
    .filter(p => p.includes('/manual/'))
    .map(p => p.split('/manual/')[1])
    .sort();
console.log(JSON.stringify({
    CURRENT_MODEL_POLICY,
    MANUAL_RESEARCH_CONTRACT,
    FRESH_AUTHORING_CONTRACT,
    FRESH_AUTHORING_MODE,
    MANUAL_TUTORIAL_PAYLOAD_CONTRACT,
    loadedManualAfter
}));
`;
        const stdout = execFileSync(process.execPath, ['-e', script], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const result = JSON.parse(stdout);
        for (const key of [
            'CURRENT_MODEL_POLICY',
            'MANUAL_RESEARCH_CONTRACT',
            'FRESH_AUTHORING_CONTRACT',
            'FRESH_AUTHORING_MODE',
            'MANUAL_TUTORIAL_PAYLOAD_CONTRACT'
        ]) {
            assert.equal(typeof result[key], 'string', `${key} must resolve to a non-empty string`);
            assert.ok(result[key].length > 0, `${key} must be non-empty`);
        }
        assert.ok(result.loadedManualAfter.includes('scripts/manual-agent-policy.js'));
        assert.ok(result.loadedManualAfter.includes('scripts/manual-research-contract.js'));
        assert.ok(result.loadedManualAfter.includes('scripts/manual-fresh-authoring-contract.js'));
        assert.ok(result.loadedManualAfter.includes('scripts/manual-tutorial-payload.js'));
    });

    it('quarantines single-paper exemptions into analysis-contract-paper-exemptions.js and substantially reduces analysis-contract.js LOC', () => {
        const contractSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'analysis-contract.js'), 'utf8');
        const contractLines = contractSrc.split('\n').length;
        assert.ok(contractLines < 4500, `analysis-contract.js expected < 4500 LOC after quarantine, got ${contractLines}`);
        assert.ok(
            paperExemptions.QUARANTINED_EXEMPTION_FUNCTIONS.length >= 43,
            `expected >= 43 quarantined functions, got ${paperExemptions.QUARANTINED_EXEMPTION_FUNCTIONS.length}`
        );
        for (const fnName of [
            'sourceBackedIdentityColumns',
            'sourceBoundListeningScoreRegression',
            'sourceBoundRenderedDurationShortfall',
            'hasSourceBoundSymbolAndTrajectoryHandoff',
            'hasExplicitArtifactHandoff'
        ]) {
            assert.ok(paperExemptions.QUARANTINED_EXEMPTION_FUNCTIONS.includes(fnName));
            assert.equal(
                new RegExp(`^function ${fnName}\\(`, 'm').test(contractSrc),
                false,
                `${fnName} should no longer be inline in scripts/analysis-contract.js`
            );
        }

        const preservedExports = [
            'hasBoundFormerLatterComparison',
            'hasBoundDisjointIntervalComparison',
            'hasConditionalMetricDeltaDirection',
            'stripSymbolicPatternRelation',
            'hasSymbolicGeometryMethodChain',
            'hasScopedSymbolicDemonstration',
            'sourceSoftwareFunctionalValidationResult',
            'hasCompleteSoftwareFunctionalValidationResult',
            'hasBlockLayoutProductChain',
            'hasPosteriorUpdateProductChain',
            'hasConcreteProductHandoff',
            'hasExplicitArtifactHandoff',
            'hasCachedCausalStateHandoff',
            'hasOfflineOperationalBoundary',
            'hasNaturalScopedBoundary',
            'hasGeneratedInputModelHeadChain',
            'hasExplicitNaturalProductChain',
            'hasConcreteUnnumberedMethodChain'
        ];
        for (const name of preservedExports) {
            assert.equal(typeof analysisContract[name], 'function', `analysis-contract.js must still export ${name}`);
        }
        assert.equal(
            analysisContract.hasBoundFormerLatterComparison(
                '在 WER比较，本文模型为 8.2%，基线模型为 10.5%，前者更低'
            ),
            true
        );
        assert.equal(
            analysisContract.hasBoundFormerLatterComparison(
                '假设 WER比较，本文模型为 8.2%，基线模型为 10.5%，前者更低'
            ),
            false
        );

        const closure = collectWorkflowImplementationFiles({
            root: REPO_ROOT,
            entryFiles: ['scripts/analysis-contract.js']
        });
        assert.ok(closure.includes('scripts/lib/analysis-contract-paper-exemptions.js'));
        assert.equal(closure.some(file => file.startsWith('manual/')), false);
    });
});

describe('R4-W3.4: deep-analyzer.js cohesive extraction (deep-arxiv-source-fetch & deep-primary-sections)', () => {
    it('preserves 100% re-export identity (===), zero circular dependency, and LOC reduction', () => {
        const fetchSharedExports = [
            'classifyArxivSourceFailure',
            'safeImageLabel',
            'fetchArxivText',
            'fetchArxivTextDetailed',
            'fetchArxivTextDetailedUncached',
            'fetchArxivHtmlTextDetailedUncached',
            'extractArxivPdfTextDetailedFromBytes',
            'fetchArxivPdfUncached',
            'fetchArxivImageUrls'
        ];
        for (const symbol of fetchSharedExports) {
            assert.equal(typeof deepAnalyzer[symbol], 'function', `deep-analyzer missing ${symbol}`);
            assert.equal(
                deepAnalyzer[symbol],
                deepArxivSourceFetch[symbol],
                `${symbol} must share exact reference identity with deep-arxiv-source-fetch.js`
            );
        }

        const sectionsSharedExports = [
            'cleanGapFillPrefix',
            'recoveryFailureStatus',
            'normalizeAnalysisStructure',
            'getCoreSummaryDetailIssue',
            'getRepairableAnalysisStructureIssues',
            'sourceTextLikelyHasTables',
            'analysisNeedsExperimentTableRepair'
        ];
        for (const symbol of sectionsSharedExports) {
            assert.equal(typeof deepAnalyzer[symbol], 'function', `deep-analyzer missing ${symbol}`);
            assert.equal(
                deepAnalyzer[symbol],
                deepPrimarySections[symbol],
                `${symbol} must share exact reference identity with deep-primary-sections.js`
            );
        }

        // Runtime module graph: neither extracted module may pull in deep-analyzer.js
        const deepResolved = require.resolve('../scripts/deep-analyzer.js');
        for (const rel of [
            'scripts/lib/deep-arxiv-source-fetch.js',
            'scripts/lib/deep-primary-sections.js'
        ]) {
            const abs = require.resolve(path.join(REPO_ROOT, rel));
            const visited = new Set();
            const queue = [require.cache[abs]];
            while (queue.length > 0) {
                const current = queue.shift();
                if (!current || visited.has(current.filename)) continue;
                visited.add(current.filename);
                for (const child of current.children || []) queue.push(child);
            }
            assert.equal(visited.has(deepResolved), false, `${rel} must not transitively require deep-analyzer.js`);
        }

        // Implementation closure includes both extracted files
        const closure = collectWorkflowImplementationFiles({
            root: REPO_ROOT,
            entryFiles: ['scripts/deep-analyzer.js']
        });
        assert.ok(closure.includes('scripts/lib/deep-arxiv-source-fetch.js'));
        assert.ok(closure.includes('scripts/lib/deep-primary-sections.js'));

        // LOC reduced substantially from 15,900
        const deepLines = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'deep-analyzer.js'), 'utf8').split('\n').length;
        assert.ok(deepLines < 15100, `deep-analyzer.js expected < 15100 LOC after extraction, got ${deepLines}`);
    });

    it('preserves pure behavior in deep-primary-sections.js and deep-arxiv-source-fetch.js offline', () => {
        assert.equal(deepPrimarySections.findTableOmissionMarker('结果如下，详见原文表 2。'), '详见原文表');
        assert.equal(deepPrimarySections.findTableOmissionMarker('表中保留完整结果，不省略任何基线。'), null);
        assert.equal(deepPrimarySections.cleanGapFillPrefix('前置说明\n## 评分\n8.5/10'), '## 评分\n8.5/10');
        assert.equal(deepPrimarySections.cleanGapFillPrefix('无评分章节'), null);
        assert.equal(
            deepPrimarySections.recoveryFailureStatus(deepPrimarySections.contractRejectedError('bad')),
            'contract_rejected'
        );
        assert.equal(deepPrimarySections.recoveryFailureStatus(new Error('timeout')), 'transient_failure');

        assert.equal(deepArxivSourceFetch.classifyArxivSourceFailure('permanent_miss', false), 'permanent');
        assert.equal(deepArxivSourceFetch.classifyArxivSourceFailure('transient_failure', false), 'transient');
        assert.equal(deepArxivSourceFetch.classifyArxivSourceFailure('permanent_miss', true), 'transient');
        assert.equal(deepArxivSourceFetch.isRetryableImageStatus(429), true);
        assert.equal(deepArxivSourceFetch.isRetryableImageStatus(404), false);
        assert.equal(deepArxivSourceFetch.safeImageLabel('https://arxiv.org/html/2611.00001v1/x1.png'), 'x1.png');
        assert.equal(
            deepArxivSourceFetch.sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])),
            'image/png'
        );
    });
});

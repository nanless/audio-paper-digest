#!/usr/bin/env node
'use strict';

/** Build an ephemeral publisher input from a signed production V6 spec. */
const fs = require('fs');
const path = require('path');
if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('manual-v6-publication-adapter.js');
}
const Config = require('./config.js');
const { writeFileAtomic, normalizedId } = require('./utils.js');
const { manualSha256 } = require('./analysis-contract.js');
const {
    buildManualRecord,
    buildStagePromptBindings,
    validateManualV6AssemblerProvenance
} = require('./manual-deep-analysis.js');

const V6_COMPATIBILITY_MODE = 'signed-v6-task-evidence-override-v1';

function parseArgs(argv) {
    const out = {};
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!['--date', '--spec', '--output'].includes(key) || !value) {
            throw new Error('用法: --date YYYY-MM-DD --spec SPEC.json --output /tmp/FILE.json');
        }
        out[key.slice(2)] = value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date || '')) throw new Error('--date 非法');
    if (!out.spec || !out.output) throw new Error('--spec/--output 必填');
    return out;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const specPath = path.resolve(args.spec);
    const outputPath = path.resolve(args.output);
    const spec = readJson(specPath);
    if (spec.v5BridgeMode !== V6_COMPATIBILITY_MODE
        || spec.runtimeMode !== 'production' || spec.date !== args.date) {
        throw new Error('只接受当前日期带签名兼容标记的 production V6 spec');
    }
    validateManualV6AssemblerProvenance(spec, { date: args.date, runtimeMode: 'production' });
    const filtered = readJson(Config.FILES.filteredPapers);
    const metadata = new Map(filtered.papers.map(paper => [normalizedId(paper), paper]));
    const promptBindings = buildStagePromptBindings();
    const papers = Object.entries(spec.papers).map(([paperId, paperSpec]) => {
        const paper = metadata.get(paperId);
        if (!paper) throw new Error(`${paperId} 缺少 filtered metadata`);
        const record = buildManualRecord(paper, paperSpec, args.date, promptBindings, {
            manualDepthContractVersion: 'full-text-evidence-v6',
            externalResourceVerification: null,
            manualProvenance: {
                specVersion: 6,
                fullTextManifestSha256: spec.fullTextManifest.sha256,
                recordsSourcesSha256: manualSha256(spec.recordsSources),
                specRootSha256: spec.rootSha256,
                runtimeMode: 'production'
            }
        });
        // The adapter is the only publisher entry point allowed to emit this
        // marker.  It is copied into the already-equal V6 provenance witnesses
        // so publish_common can require both the production V6 proof and the
        // explicit compatibility authorization before bypassing legacy V4/V5
        // takeover fields.  No canonical file is read or written here.
        record.manualV6CompatibilityMode = V6_COMPATIBILITY_MODE;
        record.manualV6Provenance.v5BridgeMode = V6_COMPATIBILITY_MODE;
        record.analysisManifest.manualTakeover.v6Provenance = {
            ...record.manualV6Provenance
        };
        record.analysisManifest.sourceAcquisition.v5BridgeMode = V6_COMPATIBILITY_MODE;
        return record;
    });
    writeFileAtomic(outputPath, JSON.stringify({ papers }, null, 2));
    console.log(JSON.stringify({ outputPath, paperCount: papers.length }));
    return { outputPath, papers };
}

if (require.main === module) {
    try { run(); } catch (error) {
        console.error(`Manual V6 publication adapter 失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { parseArgs, run };

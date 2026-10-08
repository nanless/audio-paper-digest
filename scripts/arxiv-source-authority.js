#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const api = require('./lib/arxiv-source-authority.js');
const crosswalk = require('./lib/page-source-crosswalk.js');

const USAGE = '--dry-run|--apply --id YYMM.NNNNN --authority arxiv-YYMM.NNNNN.json [--crosswalk UUID --page-key page:SHA --decision NAME.json --owner OWNER]';
function parseArgs(argv) {
    const [mode, ...rest] = argv;
    if (!['--dry-run', '--apply'].includes(mode)) throw new Error(`用法：${USAGE}`);
    const values = {};
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index]; const value = rest[index + 1];
        if (!['--id', '--authority', '--crosswalk', '--page-key', '--decision', '--owner'].includes(flag)
            || value === undefined || Object.hasOwn(values, flag)) throw new Error(`用法：${USAGE}`);
        values[flag] = value;
    }
    if (!/^\d{4}\.\d{4,5}$/.test(String(values['--id'] || ''))) throw new Error('--id must be a normalized versionless arXiv ID');
    if (!api.SAFE_AUTHORITY_NAME.test(String(values['--authority'] || ''))) throw new Error('--authority 必须是不带子目录的安全 arXiv 来源文件名');
    const composite = ['--crosswalk', '--page-key', '--decision', '--owner'].filter(flag => values[flag] !== undefined);
    if (composite.length && composite.length !== 4) throw new Error('--crosswalk、--page-key、--decision、--owner 必须一起给出');
    if (composite.length) {
        if (!values['--crosswalk']?.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i)
            || !/^page:[a-f0-9]{64}$/.test(values['--page-key'])
            || !crosswalk.SAFE_JSON_NAME.test(values['--decision'])
            || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(values['--owner'])) throw new Error(`用法：${USAGE}`);
        if (mode !== '--apply') throw new Error('组合 crosswalk 已核验决定时必须用 --apply');
    }
    return { apply: mode === '--apply', arxivId: values['--id'], authorityName: values['--authority'],
        crosswalkId: values['--crosswalk'] || null, pageKey: values['--page-key'] || null,
        decisionName: values['--decision'] || null, owner: values['--owner'] || null };
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('arxiv-source-authority.js');
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
        || Object.keys(runtime).some(key => !['files'].includes(key))) {
        throw new Error('arXiv 来源句柄命令行只接受配置好的 files，禁止注入传输或时间参数');
    }
    const options = parseArgs(argv); const files = runtime.files || Config.FILES;
    if (typeof files.paperSourceAuthorityDir !== 'string' || !path.isAbsolute(files.paperSourceAuthorityDir)
        || (options.crosswalkId && (typeof files.pageSourceCrosswalkDir !== 'string' || !path.isAbsolute(files.pageSourceCrosswalkDir)))) {
        throw new Error('paperSourceAuthorityDir 必须是配置里的绝对路径');
    }
    const result = await api.prepareArxivSourceAuthority({ authorityRoot: files.paperSourceAuthorityDir,
        ...options, requireLiveAuthorization: Boolean(options.crosswalkId) });
    let crosswalkState = null;
    if (options.crosswalkId) {
        const state = crosswalk.readCrosswalk({ crosswalkRoot: files.pageSourceCrosswalkDir,
            crosswalkId: options.crosswalkId });
        const artifact = crosswalk.buildVerifiedDecisionArtifact({ state, pageKey: options.pageKey,
            authorityHandle: result.authorityHandle, actorId: options.owner });
        const decisionFile = crosswalk.writeDecisionArtifact({ crosswalkRoot: files.pageSourceCrosswalkDir,
            crosswalkId: options.crosswalkId, decisionName: options.decisionName, artifact });
        const decisionHandle = crosswalk.loadDecisionHandle(decisionFile, { authorityHandle: result.authorityHandle });
        crosswalkState = crosswalk.applyDecision({ crosswalkRoot: files.pageSourceCrosswalkDir,
            crosswalkId: options.crosswalkId, decisionHandle, owner: options.owner });
    }
    const output = { status: result.status, paperId: result.paperId, authorityName: result.authorityName,
        officialUrl: result.officialUrl, artifacts: result.artifacts,
        productionAuthorized: result.authority?.productionAuthorized ?? false,
        crosswalk: crosswalkState ? { crosswalkId: crosswalkState.crosswalkId,
            verified: crosswalkState.completion.verified, total: crosswalkState.completion.total,
            completion: crosswalkState.completion.status } : null };
    console.log(JSON.stringify(output)); return output;
}
if (require.main === module) main().catch(error => { console.error(`[arxiv-source-authority] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, main };

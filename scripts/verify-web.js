#!/usr/bin/env node
'use strict';
// 发布后网页核验：
//   - 按生成清单批量请求目标日汇总页与单篇，检查 HTTP 200 与标题；
//   - 可选查询 GitHub Pages 部署状态（gh CLI 优先，失败时降级提示）；
//   - 结果原子写入 data/current/web-verification-<date>.json（0600）。
// CLI 全部输出经注入的 print 走 stdout；--json 模式每行都是可解析的 JSON。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync: defaultSpawnSync } = require('node:child_process');
const doctor = require('./doctor.js');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'data', 'current');
const SITE_TITLE_MARKER = '语音/音乐/音频论文速递';
const ARTIFACT_VERSION = 1;

function readEnv() {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return {};
    return require('./lib/env-schema').parseEnvText(fs.readFileSync(file, 'utf8'));
}

function defaultBaseUrl(env = {}) {
    return String(env.PAPER_DIGEST_BLOG_URL
        || 'https://nanless.github.io/audio-paper-digest-blog/posts').replace(/\/+$/, '');
}

function pageUrls(date, env, manifest) {
    const base = defaultBaseUrl(env);
    const files = manifest && Array.isArray(manifest.files) ? manifest.files : [];
    return files
        .filter(file => file && file.deleted !== true)
        .map(file => String(file.path || ''))
        .filter(file => file.startsWith('content/posts/') && file.endsWith('.md'))
        .map(file => ({ file, url: `${base}/${file.slice('content/posts/'.length, -'.md'.length)}/` }));
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&#x27;/gi, "'")
        .replace(/&nbsp;/gi, ' ');
}

function titleOf(html) {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
    return match ? decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim() : null;
}

function titleMatches(title, marker = SITE_TITLE_MARKER) {
    if (!title) return false;
    return String(title).includes(marker);
}

async function fetchPage(url, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000;
    const signal = options.signal
        || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(timeoutMs) : undefined);
    const response = await fetchImpl(url, { redirect: 'follow', signal });
    const html = await response.text();
    return { status: response.status, title: titleOf(html), finalUrl: response.url || null };
}

function atomicWriteJson(targetPath, value) {
    const directory = path.dirname(targetPath);
    fs.mkdirSync(directory, { recursive: true });
    let existing = null;
    try {
        existing = fs.lstatSync(targetPath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    if (existing?.isSymbolicLink()) {
        throw new Error(`网页核验结果路径是符号链接，拒绝写入: ${targetPath}`);
    }
    const temporary = path.join(directory,
        `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
        fd = fs.openSync(temporary, flags, 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fs.fsyncSync(fd);
    } catch (error) {
        try { fs.unlinkSync(temporary); } catch (_error) { /* 清理失败不掩盖原错误 */ }
        throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    try {
        fs.renameSync(temporary, targetPath);
    } catch (error) {
        try { fs.unlinkSync(temporary); } catch (_error) { /* 清理失败不掩盖原错误 */ }
        throw error;
    }
    try { fs.chmodSync(targetPath, 0o600); } catch (_error) { /* 某些文件系统不支持 chmod */ }
    return targetPath;
}

function artifactPath(currentDir, date) {
    return path.join(currentDir, `web-verification-${date}.json`);
}

function writeVerificationArtifact(currentDir, date, artifact) {
    return atomicWriteJson(artifactPath(currentDir, date), artifact);
}

async function verify(date, options = {}) {
    const env = options.env || readEnv();
    const currentDir = options.currentDir || CURRENT;
    const manifestFile = path.join(currentDir, `blog-generation-manifest-${date}.json`);
    if (!fs.existsSync(manifestFile)) throw new Error(`找不到生成清单：${manifestFile}`);
    const manifestBytes = fs.readFileSync(manifestFile);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest && manifest.date && manifest.date !== date) throw new Error(`生成清单日期 ${manifest.date} 与 --date ${date} 不一致`);
    const generationManifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
    const allPages = pageUrls(date, env, manifest);
    const expected = allPages.length;
    let pages = allPages;
    if (Number.isInteger(options.limit) && options.limit > 0) pages = pages.slice(0, options.limit);
    const marker = options.siteTitleMarker || SITE_TITLE_MARKER;
    const results = [];
    for (const page of pages) {
        try {
            const fetched = await fetchPage(page.url, options);
            const normalize = value => String(value || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
            const redirectOk = !fetched.finalUrl || normalize(fetched.finalUrl) === normalize(page.url);
            const slug = path.basename(page.url.replace(/\/$/, ''));
            const isSummary = /^\d{4}-\d{2}-\d{2}$/.test(slug);
            const dateInTitle = fetched.title ? fetched.title.includes(date) : false;
            const titleOk = fetched.status === 200 && titleMatches(fetched.title, marker)
                && (isSummary ? dateInTitle : String(fetched.title || '').replace(marker, '').trim().length > 4);
            results.push({ ...page, ...fetched, titleOk, redirectOk, ok: titleOk && redirectOk });
        } catch (error) {
            results.push({ ...page, status: null, title: null, titleOk: false, ok: false, error: error.message });
        }
    }
    const failed = results.filter(item => !item.ok).length + (results.length === 0 ? 1 : 0);
    const ok = results.filter(item => item.ok).length;
    const summary = {
        schemaVersion: ARTIFACT_VERSION,
        createdAt: new Date().toISOString(),
        date,
        partial: failed > 0 || results.length === 0 || results.length < expected,
        deploy: options.deploy || null,
        publicationOid: options.deploy || null,
        generationManifestSha256,
        expected,
        checked: results.length,
        ok,
        failed,
        results
    };
    if (!options.noWrite) writeVerificationArtifact(currentDir, date, summary);
    return summary;
}

function deployRepository(env = {}) {
    return env.PAPER_DIGEST_BLOG_REPO_RUN || env.GITHUB_REPOSITORY || 'nanless/audio-paper-digest-blog';
}

function normalizeDeployRun(run) {
    const status = String(run.status || '').toLowerCase();
    const conclusion = String(run.conclusion || '').toLowerCase();
    return {
        available: true,
        oid: run.headSha || run.head_sha || null,
        status,
        conclusion: conclusion || null,
        url: run.url || run.html_url || null,
        workflowName: run.workflowName || run.name || run.path || null,
        runId: run.databaseId || run.id || null,
        terminal: status === 'completed'
    };
}

// gh CLI 输出或公开 Actions API 的 workflow_runs 数组都走同一套归一化。
function parseDeployRuns(runs, oid, options = {}) {
    if (!Array.isArray(runs)) return { available: true, oid, message: '部署接口返回格式无法解析。' };
    const pagesRuns = runs.filter(run => {
        const name = String(run?.workflowName || run?.name || run?.path || '');
        if (name && !/(pages|hugo|deploy)/i.test(name)) return false;
        const event = String(run?.event || '');
        if (event && !['push', 'workflow_dispatch', 'dynamic'].includes(event)) return false;
        return true;
    });
    const match = pagesRuns.find(run => String(run?.headSha || run?.head_sha || '') === String(oid));
    if (!match) {
        return { available: true, oid, message: `未找到 oid=${oid} 的 Pages 部署记录（可能尚未触发或需要 --wait）。` };
    }
    return { ...normalizeDeployRun(match), repository: options.repository || null };
}

function deployStatus(oid, options = {}) {
    const runGh = options.spawnSync || defaultSpawnSync;
    const repository = options.repository || deployRepository(options.env || {});
    const result = runGh('gh', [
        'run', 'list', '-R', repository, '-L', '20',
        '--json', 'headSha,status,conclusion,url,workflowName,event,databaseId'
    ], { encoding: 'utf8', timeout: 30000 });
    if (!result || result.error || result.status !== 0) {
        return {
            available: false,
            degraded: true,
            oid,
            message: 'gh CLI 不可用或未登录；请到 GitHub Actions 手动确认部署。'
        };
    }
    try {
        const runs = JSON.parse(result.stdout || '[]');
        return parseDeployRuns(runs, oid, { repository });
    } catch (error) {
        return {
            available: false,
            degraded: true,
            oid,
            message: `解析 gh 输出失败：${error.message}`
        };
    }
}

function validateReceiptBinding({ receipt, manifestSha256, deployOid } = {}) {
    if (!receipt || typeof receipt !== 'object') throw new Error('审查凭证必须是对象');
    const receiptManifest = receipt.generationManifestSha256 || receipt.manifestSha256;
    if (receiptManifest && manifestSha256 && receiptManifest !== manifestSha256) throw new Error('审查凭证的生成清单 SHA 与当前清单不一致');
    const receiptOid = receipt.publicationCommit || receipt.remoteVerifiedOid || receipt.reviewedCommit;
    if (deployOid && receiptOid && receiptOid !== deployOid) throw new Error('--deploy OID 与审查凭证记录不一致');
    return { receiptManifest: receiptManifest || null, receiptOid: receiptOid || null };
}

async function waitForDeploy(oid, options = {}) {
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const intervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 10000;
    const waitMs = Number.isFinite(options.waitSeconds) ? options.waitSeconds * 1000 : 120000;
    const deadline = Date.now() + waitMs;
    let deploy = deployStatus(oid, options);
    const snapshots = [deploy];
    while (Date.now() < deadline && deploy && deploy.available && deploy.status !== 'completed') {
        await sleep(intervalMs);
        deploy = deployStatus(oid, options);
        snapshots.push(deploy);
    }
    return { deploy, snapshots };
}

function deployExitCode(deploy, options = {}) {
    if (!deploy) return 0;
    if (!deploy.available) return options.allowDegraded ? 0 : 1;
    if (deploy.status === 'completed') return deploy.conclusion === 'success' ? 0 : 1;
    // 排队/进行中/超时：只有显式 --allow-degraded 才放行。
    return options.allowDegraded ? 0 : 1;
}

function parseVerifyArgs(argv = []) {
    const options = {
        date: null,
        limit: null,
        deploy: null,
        json: false,
        timeoutMs: 20000,
        allowDegraded: false,
        allowPartial: false,
        receipt: null,
        wait: false,
        waitSeconds: 120,
        pollIntervalMs: 10000,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--date') options.date = argv[++index] || null;
        else if (value === '--limit') options.limit = Number(argv[++index]);
        else if (value === '--deploy') options.deploy = argv[++index] || null;
        else if (value === '--json') options.json = true;
        else if (value === '--timeout-ms') options.timeoutMs = Number(argv[++index]) || 20000;
        else if (value === '--allow-degraded') options.allowDegraded = true;
        else if (value === '--allow-partial') options.allowPartial = true;
        else if (value === '--receipt') options.receipt = argv[++index] || null;
        else if (value === '--wait') options.wait = true;
        else if (value === '--wait-seconds') {
            const seconds = Number(argv[++index]);
            options.waitSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 120;
        } else if (value === '--poll-interval-ms') {
            const interval = Number(argv[++index]);
            options.pollIntervalMs = Number.isFinite(interval) && interval >= 0 ? interval : 10000;
        } else if (value === '--help') options.help = true;
        else throw new Error(`未知参数：${value}`);
    }
    return options;
}

const USAGE = '用法: node scripts/verify-web.js --date YYYY-MM-DD [--limit N] [--deploy OID] [--receipt RECEIPT.json] [--wait] [--allow-degraded] [--allow-partial] [--json]';

// 可测 CLI：所有副作用（目录、fetch、gh、时钟、输出）都从 deps 注入。
async function runVerifyWebCli(argv = [], deps = {}) {
    const print = typeof deps.print === 'function' ? deps.print : line => console.log(line);
    const printError = typeof deps.printError === 'function'
        ? deps.printError : line => console.error(line);
    const currentDir = deps.currentDir || CURRENT;
    const fetchImpl = deps.fetchImpl || globalThis.fetch;
    const spawnSyncImpl = deps.spawnSync || defaultSpawnSync;
    const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const env = deps.env || readEnv();

    let options;
    try {
        options = parseVerifyArgs(argv);
    } catch (error) {
        printError(`[verify-web] ${error.message}`);
        return 2;
    }
    if (options.help || !options.date) {
        print(USAGE);
        return options.help ? 0 : 2;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
        printError('[verify-web] --date 必须是 YYYY-MM-DD');
        return 2;
    }
    if (options.wait && !options.deploy) {
        printError('[verify-web] --wait 需要同时提供 --deploy OID');
        return 2;
    }

    let deploy = null;
    try {
        if (options.deploy) {
            deploy = deployStatus(options.deploy, {
                spawnSync: spawnSyncImpl,
                repository: options.repository || deployRepository(env)
            });
            if (options.wait) {
                const waited = await waitForDeploy(options.deploy, {
                    spawnSync: spawnSyncImpl,
                    repository: options.repository || deployRepository(env),
                    sleep,
                    pollIntervalMs: options.pollIntervalMs,
                    waitSeconds: options.waitSeconds
                });
                deploy = waited.deploy;
                if (options.json) {
                    // --json 模式下每个轮询快照单独一行，保证每行都能 JSON.parse。
                    for (const snapshot of waited.snapshots) {
                        print(JSON.stringify({ type: 'deploy', oid: options.deploy, ...snapshot }));
                    }
                } else {
                    for (const snapshot of waited.snapshots.slice(1)) {
                        print(`[verify-web] 部署状态：${snapshot.available
                            ? `${snapshot.status} ${snapshot.conclusion || ''}`.trim()
                            : snapshot.message}`);
                    }
                }
            }
        }
        const summary = await verify(options.date, {
            env,
            currentDir,
            fetchImpl,
            timeoutMs: options.timeoutMs,
            limit: options.limit,
            deploy
        });
        // 自动绑定当前批次的审查凭证（存在时强制），防止旧 OID/旧清单被当成验收证据。
        let receiptPath = options.receipt;
        if (!receiptPath) {
            const candidate = path.join(currentDir, `blog-review-receipt-${options.date}.json`);
            if (fs.existsSync(candidate)) receiptPath = candidate;
        }
        if (receiptPath) {
            if (!fs.existsSync(receiptPath)) throw new Error(`审查凭证不存在：${receiptPath}`);
            validateReceiptBinding({
                receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8')),
                manifestSha256: summary.generationManifestSha256,
                deployOid: options.deploy
            });
        }
        const deployOk = Boolean(deploy && deploy.available && deploy.status === 'completed' && deploy.conclusion === 'success');
        if (options.limit && summary.checked < summary.expected) summary.partial = true;
        if (!deployOk) summary.partial = true;
        if (summary.partial) writeVerificationArtifact(currentDir, options.date, summary);
        if (options.json) {
            print(JSON.stringify({ type: 'summary', ...summary }));
            if (deploy) {
                print(JSON.stringify({
                    type: 'deploy-final',
                    oid: options.deploy,
                    deploy
                }));
            }
        } else {
            for (const result of summary.results) {
                print(`${result.ok ? '✅' : '❌'} ${result.status || '-'} ${result.url}  ${result.title || result.error || ''}`);
            }
            print(`合计：${summary.ok}/${summary.checked} 通过，${summary.failed} 失败；结果已写入 ${artifactPath(currentDir, options.date)}`);
            if (deploy) {
                print(`部署：${deploy.available
                    ? `${deploy.status || ''} ${deploy.conclusion || ''} ${deploy.url || deploy.message || ''}`.trim()
                    : deploy.message}`);
            }
        }
        const partialFailed = summary.partial && !options.allowPartial && !options.allowDegraded;
        return summary.failed > 0 || deployExitCode(deploy, options) !== 0 || partialFailed ? 1 : 0;
    } catch (error) {
        printError(`[verify-web] ${error.message}`);
        return 2;
    }
}

async function main(argv = process.argv.slice(2)) {
    try {
        require('./env-loader').requireExternalRuntime('verify-web.js');
    } catch (error) {
        console.error(`[verify-web] ${error.message}`);
        return 1;
    }
    const code = await runVerifyWebCli(argv);
    process.exitCode = code;
    return code;
}

module.exports = {
    ARTIFACT_VERSION,
    SITE_TITLE_MARKER,
    pageUrls,
    titleOf,
    titleMatches,
    fetchPage,
    artifactPath,
    atomicWriteJson,
    writeVerificationArtifact,
    verify,
    deployRepository,
    parseDeployRuns,
    deployStatus,
    waitForDeploy,
    deployExitCode,
    parseVerifyArgs,
    runVerifyWebCli,
    main
};

if (require.main === module) {
    main()
        .then(code => {
            // 运行守卫的拒绝分支在 main 内直接 return 1，必须在这里落成退出码；
            // 否则 Node 正常退出 0，会被误读成“已通过”。
            process.exitCode = Number.isInteger(code) ? code : 2;
        })
        .catch(error => {
            console.error(`[verify-web] ${error.message}`);
            process.exitCode = 2;
        });
}

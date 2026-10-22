#!/usr/bin/env node
'use strict';
// 发布后网页核验：按生成清单批量请求目标日汇总页与单篇，检查 HTTP 200 与标题；可查 Pages 部署状态。
const fs = require('node:fs');
const path = require('node:path');
const doctor = require('./doctor.js');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'data', 'current');

function readEnv() {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return {};
    return require('./lib/env-schema').parseEnvText(fs.readFileSync(file, 'utf8'));
}

function pageUrls(date, env, manifest) {
    const base = String(env.PAPER_DIGEST_BLOG_URL || 'https://nanless.github.io/audio-paper-digest-blog/posts').replace(/\/$/, '');
    const files = manifest && Array.isArray(manifest.files) ? manifest.files : [];
    return files
        .filter(file => file && file.deleted !== true)
        .map(file => String(file.path || ''))
        .filter(file => file.startsWith('content/posts/') && file.endsWith('.md'))
        .map(file => ({ file, url: `${base}/${file.slice('content/posts/'.length, -'.md'.length)}/` }));
}

function titleOf(html) {
    const match = /<title>([^<]*)<\/title>/i.exec(String(html || ''));
    return match ? match[1].trim() : null;
}

async function fetchPage(url, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const signal = options.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(options.timeoutMs || 20000) : undefined);
    const response = await fetchImpl(url, { redirect: 'follow', signal });
    const html = await response.text();
    return { status: response.status, title: titleOf(html) };
}

async function verify(date, options = {}) {
    const env = options.env || readEnv();
    const currentDir = options.currentDir || CURRENT;
    const manifestFile = path.join(currentDir, `blog-generation-manifest-${date}.json`);
    if (!fs.existsSync(manifestFile)) throw new Error(`找不到生成清单：${manifestFile}`);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    let pages = pageUrls(date, env, manifest);
    if (Number.isInteger(options.limit) && options.limit > 0) pages = pages.slice(0, options.limit);
    const results = [];
    for (const page of pages) {
        try {
            const fetched = await fetchPage(page.url, options);
            const titleOk = fetched.status === 200 && Boolean(fetched.title) && fetched.title.includes('语音/音乐/音频论文速递');
            results.push({ ...page, ...fetched, titleOk, ok: titleOk });
        } catch (error) {
            results.push({ ...page, status: null, title: null, ok: false, error: error.message });
        }
    }
    const summary = { date, deploy: options.deploy || null, checked: results.length, ok: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length + (results.length === 0 ? 1 : 0), results };
    if (!options.noWrite) {
        fs.mkdirSync(currentDir, { recursive: true });
        fs.writeFileSync(path.join(currentDir, `web-verification-${date}.json`), JSON.stringify(summary, null, 2));
    }
    return summary;
}

function deployRepository() { return process.env.PAPER_DIGEST_BLOG_REPO_RUN || 'nanless/audio-paper-digest-blog'; }

function deployStatus(oid, options = {}) {
    const { spawnSync } = require('node:child_process');
    const runGh = options.spawnSync || spawnSync;
    const result = runGh('gh', ['run', 'list', '-R', options.repository || deployRepository(), '-L', '20', '--json', 'headSha,status,conclusion,url'], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) return { available: false, message: 'gh CLI 不可用或未登录；请到 GitHub Actions 手动确认部署。' };
    try {
        const runs = JSON.parse(result.stdout || '[]');
        if (!oid) return { available: false, message: '--deploy 需要完整提交 OID。' };
        const match = runs.find(run => String(run.headSha || '') === String(oid));
        return match ? { available: true, ...match } : { available: true, message: `未找到 oid=${oid} 的部署记录（可能尚未触发或需 wait）。` };
    } catch (error) {
        return { available: false, message: `解析 gh 输出失败：${error.message}` };
    }
}

async function waitForDeploy(oid, options = {}) {
    const spawnSyncImpl = options.spawnSync;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const intervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 10000;
    const waitMs = Number.isFinite(options.waitSeconds) ? options.waitSeconds * 1000 : 120000;
    const deadline = Date.now() + waitMs;
    let deploy = deployStatus(oid, { spawnSync: spawnSyncImpl, repository: options.repository });
    const snapshots = [deploy];
    while (Date.now() < deadline && deploy && deploy.available && deploy.status !== 'completed') {
        await sleep(intervalMs);
        deploy = deployStatus(oid, { spawnSync: spawnSyncImpl, repository: options.repository });
        snapshots.push(deploy);
    }
    return { deploy, snapshots };
}

async function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('verify-web.js'); } catch (error) { console.error(`[verify-web] ${error.message}`); return Promise.resolve(1); }

    const options = { date: null, limit: null, deploy: null, json: false, timeoutMs: 20000, allowDegraded: false, wait: false, waitSeconds: 120 };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--date') options.date = argv[++index] || null;
        else if (value === '--limit') options.limit = Number(argv[++index]);
        else if (value === '--deploy') options.deploy = argv[++index] || null;
        else if (value === '--json') options.json = true;
        else if (value === '--timeout-ms') options.timeoutMs = Number(argv[++index]) || 20000;
        else if (value === '--allow-degraded') options.allowDegraded = true;
        else if (value === '--wait') options.wait = true;
        else if (value === '--wait-seconds') { const seconds = Number(argv[++index]); options.waitSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 120; }
        else if (value === '--help') options.help = true;
        else throw new Error(`未知参数：${value}`);
    }
    if (options.help || !options.date) { console.log('用法: node scripts/verify-web.js --date YYYY-MM-DD [--limit N] [--deploy OID] [--allow-degraded] [--json]'); return options.help ? 0 : 2; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error('--date 必须是 YYYY-MM-DD');
    let deploy = options.deploy ? deployStatus(options.deploy, { spawnSync: options.spawnSync, repository: options.repository }) : null;
    const summary = await verify(options.date, { limit: options.limit, timeoutMs: options.timeoutMs, deploy });
    if (options.deploy && options.wait) {
        const waited = await waitForDeploy(options.deploy, {
            spawnSync: options.spawnSync, repository: options.repository,
            pollIntervalMs: options.pollIntervalMs, sleep: options.sleep, waitSeconds: options.waitSeconds
        });
        deploy = waited.deploy;
        if (!options.json) for (const snapshot of waited.snapshots.slice(1)) console.log(`[verify-web] 部署状态：${snapshot.available ? `${snapshot.status} ${snapshot.conclusion || ''}` : snapshot.message}`);
    }
    if (options.json) console.log(JSON.stringify({ ...summary, deploy }, null, 2));
    else {
        for (const result of summary.results) {
            console.log(`${result.ok ? '✅' : '❌'} ${result.status || '-'} ${result.url}  ${result.title || result.error || ''}`);
        }
        console.log(`合计：${summary.ok}/${summary.checked} 通过，${summary.failed} 失败；结果已写入 data/current/web-verification-${options.date}.json`);
        if (deploy) console.log(`部署：${deploy.available ? `${deploy.status || ''} ${deploy.conclusion || ''} ${deploy.url || deploy.message || ''}` : deploy.message}`);
    }
    const deploySucceeded = Boolean(deploy && deploy.available && deploy.status === 'completed' && deploy.conclusion === 'success');
    const deployFailed = Boolean(deploy && !deploySucceeded && !options.allowDegraded);
    if (!options.json && deployFailed) console.log('部署核验失败：目标提交没有成功完成 Pages build/deploy。');
    return summary.failed > 0 || deployFailed ? 1 : 0;
}

module.exports = { pageUrls, titleOf, fetchPage, verify, deployStatus, waitForDeploy, main };

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => { console.error(`[verify-web] ${error.message}`); process.exitCode = 2; });
}

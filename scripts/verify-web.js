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
const formats = require('./lib/protocol-codec');
const ARTIFACT_FORMAT = 'web-verification';

function hasVerificationArtifactFormat(value) {
    return formats.hasValidHeader(value, ARTIFACT_FORMAT, Object.hasOwn(value || {}, 'schemaVersion') ? 'schemaVersion' : 'contract');
}

function readEnv() {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return {};
    try { require('./env-loader').loadProjectEnv(); } catch (_error) { /* 只读命令允许降级为直接解析 */ }
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
        ...formats.recordHeader(ARTIFACT_FORMAT, ARTIFACT_FORMAT),
        createdAt: new Date().toISOString(),
        date,
        partial: failed > 0 || results.length === 0 || results.length < expected,
        deploy: options.deploy || null,
        publicationOid: options.deployOid || null,
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

// 固定 Pages workflow 画像。workflow 文件改变时这里必须显式更新，不能放宽成“看起来像就通过”；
// 这套 SHA 与 step 序列和 scripts/github_pages_deployment.py 的固定观察策略一致。
const WORKFLOW_PROFILE = {
    path: '.github/workflows/hugo.yaml',
    branch: 'main',
    event: 'push',
    workflowName: 'Deploy Hugo to Pages',
    sha256: 'cbf3a52e317973a4273f5c64c0a8d4e1c5dda2ee709f0e4ad12863c78cc5fe0d',
    roles: [
        { role: 'unit', steps: [[5, 'Unit checks']] },
        { role: 'build', steps: [[6, 'Build and verify'], [7, 'Upload artifact']] },
        { role: 'deploy', steps: [[2, 'Deploy to GitHub Pages']] }
    ]
};

const RUN_LIST_FIELDS = 'headSha,status,conclusion,url,workflowName,event,databaseId,headBranch';
const RUN_VIEW_FIELDS = 'attempt,event,headBranch,headSha,status,conclusion,workflowName,url,jobs';

function workflowFailure(code, message, nextStep, extra = {}) {
    return { available: true, verified: false, code, message, nextStep, ...extra };
}

function workflowUnavailable(message, nextStep) {
    return { available: false, degraded: true, verified: false, code: 'gh_unavailable', message, nextStep };
}

function runGhSafe(runGh, args, options) {
    try {
        return runGh('gh', args, options) || { status: null, error: new Error('gh 没有返回结果') };
    } catch (error) {
        return { status: null, error };
    }
}

// 纯函数：解析 gh run list 输出并按提交精确选 run；多匹配或身份不符一律拒绝。
function parseWorkflowRunList(stdout, oid, profile = WORKFLOW_PROFILE) {
    let runs;
    try {
        runs = JSON.parse(String(stdout || ''));
    } catch (_error) {
        return { ok: false, code: 'api_invalid', message: 'gh run list 输出不是 JSON。' };
    }
    if (!Array.isArray(runs)) return { ok: false, code: 'api_invalid', message: 'gh run list 输出不是数组。' };
    const matches = runs.filter(run => run && String(run.headSha || '') === String(oid));
    if (matches.length === 0) {
        return {
            ok: false, code: 'run_not_found',
            message: `未找到提交 ${oid} 触发的 Pages workflow run。`,
            nextStep: '确认发布提交已推送并触发 push workflow；仍在排队时可稍后重试或使用 --wait。'
        };
    }
    if (matches.length > 1) {
        return {
            ok: false, code: 'run_ambiguous',
            message: `提交 ${oid} 对应 ${matches.length} 个 workflow run，无法确定唯一部署记录。`,
            nextStep: '到 GitHub Actions 手动确认本次发布对应的 run，并清理重复触发后再核验。'
        };
    }
    const run = matches[0];
    const identity = {
        workflowName: String(run.workflowName || run.name || ''),
        event: String(run.event || ''),
        headBranch: String(run.headBranch || '')
    };
    if (identity.workflowName !== profile.workflowName || identity.event !== profile.event
        || identity.headBranch !== profile.branch) {
        return {
            ok: false, code: 'run_identity',
            message: `提交 ${oid} 的 run 不是固定 Pages 工作流：${identity.workflowName || '(未知)'} ${identity.event || ''} ${identity.headBranch || ''}`.trim(),
            nextStep: `把提交推到 ${profile.branch} 并通过 push 触发 ${profile.workflowName}；不要用其它 workflow 的 run 替代。`
        };
    }
    const runId = run.databaseId ?? run.id ?? null;
    if (!runId) {
        return {
            ok: false, code: 'run_identity',
            message: `提交 ${oid} 的 run 缺少 databaseId，无法读取 jobs。`,
            nextStep: '升级 gh CLI 后重试，或到 GitHub Actions 页面手动核对。'
        };
    }
    return {
        ok: true,
        run: {
            runId,
            oid: String(run.headSha),
            status: String(run.status || ''),
            conclusion: run.conclusion ? String(run.conclusion) : null,
            url: run.url || run.html_url || null,
            workflowName: identity.workflowName,
            event: identity.event,
            headBranch: identity.headBranch,
            runAttempt: run.attempt ?? null
        }
    };
}

// 纯函数：解析 gh run view --json 输出。
function parseWorkflowRunDetail(stdout) {
    let value;
    try {
        value = JSON.parse(String(stdout || ''));
    } catch (_error) {
        return { ok: false, code: 'api_invalid', message: 'gh run view 输出不是 JSON。' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.jobs)) {
        return { ok: false, code: 'api_invalid', message: 'gh run view 输出缺少 jobs 数组。' };
    }
    return { ok: true, run: value, jobs: value.jobs };
}

// 纯函数：run 本身的提交、分支、事件和工作流身份 + 终态；不做任何宽松匹配。
function validateWorkflowRun(run, oid, profile = WORKFLOW_PROFILE) {
    if (!run || typeof run !== 'object') return { ok: false, code: 'api_invalid', message: 'run 详情不是对象。' };
    if (String(run.headSha || '') !== String(oid)) {
        return {
            ok: false, code: 'run_identity',
            message: `run 的 headSha=${run.headSha || '(空)'} 与核验提交 ${oid} 不一致。`,
            nextStep: '用本次实际发布提交重新运行，不能把其它提交的部署当成本次证据。'
        };
    }
    if (String(run.headBranch || '') !== profile.branch) {
        return { ok: false, code: 'run_identity', message: `run 的 headBranch=${run.headBranch || '(空)'} 不是 ${profile.branch}。` };
    }
    if (String(run.event || '') !== profile.event) {
        return { ok: false, code: 'run_identity', message: `run 的 event=${run.event || '(空)'} 不是 ${profile.event}。` };
    }
    if (String(run.workflowName || '') !== profile.workflowName) {
        return { ok: false, code: 'run_identity', message: `run 的 workflow=${run.workflowName || '(空)'} 不是 ${profile.workflowName}。` };
    }
    const status = String(run.status || '');
    const conclusion = String(run.conclusion || '');
    if (status !== 'completed') {
        return {
            ok: false, code: 'run_pending', message: `run 尚未完成（status=${status || '(空)'}）。`,
            nextStep: '等待 workflow 完成，或在命令中加 --wait 并确认等待时间足够。'
        };
    }
    if (conclusion !== 'success') {
        return {
            ok: false, code: 'run_failed', message: `run 结论为 ${conclusion || '(空)'}，不是 success。`,
            nextStep: '读取失败 job 日志修复后重新发布并核验，不能沿用本次失败部署。'
        };
    }
    return { ok: true, run: { ...run, status, conclusion } };
}

// 纯函数：解码 contents API 的 base64 内容，核对 git blob OID、大小与固定 SHA-256。
function parseWorkflowSource(stdout, oid, profile = WORKFLOW_PROFILE) {
    let value;
    try {
        value = JSON.parse(String(stdout || ''));
    } catch (_error) {
        return { ok: false, code: 'api_invalid', message: 'workflow 文件接口输出不是 JSON。' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, code: 'workflow_identity', message: 'workflow 文件接口输出不是对象。' };
    }
    if (value.path !== profile.path) {
        return { ok: false, code: 'workflow_identity', message: `workflow 路径=${value.path || '(空)'}，期望 ${profile.path}。` };
    }
    if (value.type !== undefined && value.type !== 'file') {
        return { ok: false, code: 'workflow_identity', message: `workflow 路径不是普通文件（type=${value.type}）。` };
    }
    if (value.encoding !== 'base64' || typeof value.content !== 'string') {
        return { ok: false, code: 'workflow_identity', message: 'workflow 文件接口未返回 base64 内容。' };
    }
    const encoded = value.content.replace(/\s+/g, '');
    if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        return { ok: false, code: 'workflow_identity', message: 'workflow 文件 base64 内容不合法。' };
    }
    const raw = Buffer.from(encoded, 'base64');
    if (raw.toString('base64') !== encoded) {
        return { ok: false, code: 'workflow_identity', message: 'workflow 文件 base64 内容无法精确还原。' };
    }
    if (typeof value.size === 'number' && raw.length !== value.size) {
        return { ok: false, code: 'workflow_identity', message: `workflow 文件大小 ${raw.length} 与接口声明 ${value.size} 不一致。` };
    }
    const gitBlobOid = crypto.createHash('sha1')
        .update(`blob ${raw.length}\0`).update(raw).digest('hex');
    if (typeof value.sha === 'string' && value.sha !== gitBlobOid) {
        return { ok: false, code: 'workflow_identity', message: `workflow 文件 git blob OID=${value.sha} 与实际 ${gitBlobOid} 不一致。` };
    }
    const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
    if (sha256 !== profile.sha256) {
        return {
            ok: false, code: 'workflow_profile_mismatch',
            message: `workflow 文件 SHA-256=${sha256} 与固定画像 ${profile.sha256} 不一致。`,
            nextStep: '如果 workflow 是有意修改，先更新 scripts/verify-web.js 的 WORKFLOW_PROFILE（SHA 与 step 序列）并审阅；否则说明部署用了非预期 workflow，不能通过。'
        };
    }
    return {
        ok: true,
        source: { path: profile.path, commit: String(oid), gitBlobOid, bytes: raw.length, sha256, profileMatched: true }
    };
}

// 纯函数：要求固定 job 角色全部成功，并逐项核对 step 编号、名称与结论。
function validateWorkflowJobs(jobs, oid, profile = WORKFLOW_PROFILE) {
    if (!Array.isArray(jobs) || jobs.length === 0) {
        return { ok: false, code: 'jobs_incomplete', message: 'run 没有可读取的 jobs。' };
    }
    const byRole = new Map();
    for (const job of jobs) {
        const role = String(job?.name || '');
        const definition = profile.roles.find(item => item.role === role);
        if (!definition) {
            return { ok: false, code: 'role_profile', message: `出现画像外 job：${role || '(空)'}。` };
        }
        if (byRole.has(role)) return { ok: false, code: 'role_profile', message: `job ${role} 重复出现。` };
        byRole.set(role, job);
    }
    const missing = profile.roles.filter(item => !byRole.has(item.role)).map(item => item.role);
    if (missing.length) {
        return { ok: false, code: 'jobs_incomplete', message: `缺少必需 job：${missing.join('、')}。` };
    }
    const normalized = [];
    for (const definition of profile.roles) {
        const job = byRole.get(definition.role);
        if (job.headSha !== undefined && job.headSha !== null && String(job.headSha) !== String(oid)) {
            return { ok: false, code: 'job_identity', message: `job ${definition.role} 的 headSha 与提交 ${oid} 不一致。` };
        }
        if (job.headBranch !== undefined && job.headBranch !== null && String(job.headBranch) !== profile.branch) {
            return { ok: false, code: 'job_identity', message: `job ${definition.role} 的 headBranch 不是 ${profile.branch}。` };
        }
        if (String(job.status || '') !== 'completed') {
            return { ok: false, code: 'job_pending', message: `job ${definition.role} 尚未完成（status=${job.status || '(空)'}）。` };
        }
        if (String(job.conclusion || '') !== 'success') {
            return { ok: false, code: 'job_failed', message: `job ${definition.role} 结论为 ${job.conclusion || '(空)'}，不是 success。` };
        }
        const steps = Array.isArray(job.steps) ? job.steps : [];
        const requiredSteps = [];
        for (const [number, name] of definition.steps) {
            const matches = steps.filter(step => Number(step?.number) === number);
            if (matches.length !== 1) {
                return { ok: false, code: 'step_identity', message: `job ${definition.role} 缺少唯一的第 ${number} 步（${name}）。` };
            }
            const step = matches[0];
            if (String(step.name || '') !== name) {
                return { ok: false, code: 'step_identity', message: `job ${definition.role} 第 ${number} 步是 ${step.name || '(空)'}，期望 ${name}。` };
            }
            if (String(step.status || '') !== 'completed' || String(step.conclusion || '') !== 'success') {
                return { ok: false, code: 'step_failed', message: `job ${definition.role} 第 ${number} 步 ${name} 未成功（${step.status || ''} ${step.conclusion || ''}）。` };
            }
            requiredSteps.push({ number, name, status: String(step.status), conclusion: String(step.conclusion) });
        }
        normalized.push({
            role: definition.role,
            id: job.databaseId ?? job.id ?? null,
            headSha: job.headSha ?? oid,
            status: String(job.status),
            conclusion: String(job.conclusion),
            requiredSteps
        });
    }
    return { ok: true, jobs: normalized };
}

// 组合核验：run 选择 → run 详情 → workflow 源文件 → build/deploy（及 unit）job 与 step。
// gh 不可用、输出无法解析或任一身份不匹配都显式失败，不伪造通过。
function verifyWorkflowSource(oid, options = {}) {
    const repository = options.repository || deployRepository(options.env || {});
    const profile = { ...WORKFLOW_PROFILE, ...(options.profile || {}) };
    const runGh = options.spawnSync || defaultSpawnSync;
    const spawnOptions = { encoding: 'utf8', timeout: 30000 };

    let run = options.run && options.run.runId ? {
        runId: options.run.runId,
        oid: options.run.oid || oid,
        status: options.run.status || '',
        conclusion: options.run.conclusion || null,
        url: options.run.url || null,
        workflowName: options.run.workflowName || profile.workflowName,
        event: profile.event,
        headBranch: profile.branch,
        runAttempt: options.run.runAttempt ?? null
    } : null;
    if (!run) {
        const listed = runGhSafe(runGh, ['run', 'list', '-R', repository, '-L', '20', '--json', RUN_LIST_FIELDS], spawnOptions);
        if (!listed || listed.error || listed.status !== 0) {
            return workflowUnavailable(
                'gh CLI 不可用、未登录或 run list 查询失败；无法取得部署 workflow 证据。',
                '先运行 gh auth status 并确认 gh 可用，或到 GitHub Actions 手动核对；该核验不能以诊断模式放行。');
        }
        const selection = parseWorkflowRunList(listed.stdout, oid, profile);
        if (!selection.ok) return workflowFailure(selection.code, selection.message, selection.nextStep);
        run = selection.run;
    }
    if (String(run.oid || '') !== String(oid)) {
        return workflowFailure('run_identity', `run 的提交 ${run.oid || '(空)'} 与核验提交 ${oid} 不一致。`,
            '用本次实际发布提交重新核验。');
    }

    const detailResult = runGhSafe(runGh, ['run', 'view', String(run.runId), '-R', repository, '--json', RUN_VIEW_FIELDS], spawnOptions);
    if (!detailResult || detailResult.error || detailResult.status !== 0) {
        return workflowUnavailable(
            `读取 run ${run.runId} 的详情失败；不能确认 job 与 step。`,
            '重试 gh run view，或到 GitHub Actions 页面手动核对 build/deploy job；不能据此宣告上线。');
    }
    const detail = parseWorkflowRunDetail(detailResult.stdout);
    if (!detail.ok) return workflowFailure(detail.code, detail.message, '检查 gh 版本与 --json 字段支持后重试。');
    if (detail.run.databaseId !== undefined && detail.run.databaseId !== null
        && String(detail.run.databaseId) !== String(run.runId)) {
        return workflowFailure('run_identity',
            `gh run view 返回的 run ${detail.run.databaseId} 与选定 run ${run.runId} 不一致。`,
            '重试 gh run view，或到 GitHub Actions 手动核对 run 编号。');
    }
    const runCheck = validateWorkflowRun(detail.run, oid, profile);
    if (!runCheck.ok) return workflowFailure(runCheck.code, runCheck.message, runCheck.nextStep);

    const sourceResult = runGhSafe(runGh, ['api', `repos/${repository}/contents/${profile.path}?ref=${oid}`], spawnOptions);
    if (!sourceResult || sourceResult.error || sourceResult.status !== 0) {
        return workflowUnavailable(
            `读取 ${profile.path}@${oid} 失败；无法核对 workflow 源文件。`,
            '确认 gh 具备仓库读取权限（gh auth status），或到 GitHub 手动核对 workflow 文件；该核验不能以诊断模式放行。');
    }
    const source = parseWorkflowSource(sourceResult.stdout, oid, profile);
    if (!source.ok) return workflowFailure(source.code, source.message, source.nextStep);

    const jobsCheck = validateWorkflowJobs(detail.jobs, oid, profile);
    if (!jobsCheck.ok) return workflowFailure(jobsCheck.code, jobsCheck.message, jobsCheck.nextStep);

    return {
        available: true,
        verified: true,
        repository,
        oid,
        run: {
            runId: run.runId,
            oid: String(oid),
            status: String(detail.run.status || run.status),
            conclusion: String(detail.run.conclusion || run.conclusion),
            url: detail.run.url || run.url || null,
            workflowName: String(detail.run.workflowName || profile.workflowName),
            event: String(detail.run.event || profile.event),
            headBranch: String(detail.run.headBranch || profile.branch),
            runAttempt: detail.run.attempt ?? run.runAttempt ?? null
        },
        workflowSource: source.source,
        jobs: jobsCheck.jobs,
        checks: {
            run: 'verified',
            commit: 'verified',
            workflowSource: 'verified',
            jobs: 'verified',
            steps: 'verified'
        }
    };
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
        const parsed = parseDeployRuns(runs, oid, { repository });
        if (parsed && parsed.available && parsed.status === 'completed' && parsed.conclusion === 'success') {
            // run 成功只保留为观察事实；完整部署必须另外取得明确的 jobs 证据。
            const unverifiedJobs = message => ({ ...parsed, jobVerified: false, degraded: true, message });
            if (!parsed.runId) return unverifiedJobs('部署 run 缺少 runId，无法核验 jobs。');
            let jobsResult;
            try {
                jobsResult = runGh('gh', ['run', 'view', String(parsed.runId), '-R', repository, '--json', 'jobs'], { encoding: 'utf8', timeout: 30000 });
            } catch (_error) {
                return unverifiedJobs('读取部署 jobs 失败，不能证明部署完成。');
            }
            if (!jobsResult || jobsResult.error || jobsResult.status !== 0) {
                return unverifiedJobs('部署 jobs 查询失败或超时，不能证明部署完成。');
            }
            if (jobsResult.status === 0) {
                try {
                    const jobs = JSON.parse(jobsResult.stdout || '{}').jobs;
                    if (Array.isArray(jobs) && jobs.length) {
                        const deployJobs = jobs.filter(job => /(pages|deploy)/i.test(String(job.name || job.workflowName || '')));
                        if (!deployJobs.length) {
                            return { ...parsed, conclusion: 'failure', jobVerified: false, message: '未找到 Pages deploy job，不能证明部署完成。' };
                        }
                        const badJob = deployJobs.find(job => String(job.conclusion || '').toLowerCase() !== 'success');
                        if (badJob) {
                            return { ...parsed, conclusion: 'failure', jobVerified: false, jobConclusion: badJob.conclusion || null, message: `部署 job 未成功：${badJob.name || 'deploy'}` };
                        }
                        return { ...parsed, jobVerified: true, jobConclusion: 'success' };
                    }
                    return { ...parsed, conclusion: 'failure', jobVerified: false, message: '无法读取部署 jobs，不能证明 Pages deploy 成功。' };
                } catch (_error) {
                    return unverifiedJobs('解析部署 jobs 失败，不能证明部署完成。');
                }
            }
        }
        return parsed;
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
    if (!/^[0-9a-f]{64}$/i.test(String(receiptManifest || ''))) throw new Error('审查凭证缺少合法的 generationManifestSha256');
    if (!manifestSha256 || receiptManifest !== manifestSha256) throw new Error('审查凭证的生成清单 SHA 与当前清单不一致');
    const publicationCommit = receipt.publicationCommit;
    const remoteVerifiedOid = receipt.remoteVerifiedOid;
    if (!/^[0-9a-f]{40}$/i.test(String(publicationCommit || ''))) throw new Error('审查凭证缺少合法的 publicationCommit');
    if (!/^[0-9a-f]{40}$/i.test(String(remoteVerifiedOid || ''))) throw new Error('审查凭证缺少合法的 remoteVerifiedOid');
    if (String(publicationCommit) !== String(remoteVerifiedOid)) throw new Error('审查凭证的 publicationCommit 与 remoteVerifiedOid 不一致');
    if (deployOid && String(deployOid).toLowerCase() !== String(publicationCommit).toLowerCase()) throw new Error('--deploy OID 与审查凭证记录不一致');
    return { receiptManifest, receiptOid: publicationCommit };
}

async function waitForDeploy(oid, options = {}) {
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const intervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 10000;
    const waitMs = Number.isFinite(options.waitSeconds) ? options.waitSeconds * 1000 : 120000;
    const deadline = Date.now() + waitMs;
    let deploy = deployStatus(oid, options);
    const snapshots = [deploy];
    while (Date.now() < deadline && deploy && deploy.available && deploy.status !== 'completed') {
        await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
        deploy = deployStatus(oid, options);
        snapshots.push(deploy);
    }
    return { deploy, snapshots };
}

function deployExitCode(deploy, options = {}) {
    if (!deploy) return options.workflowSource ? 1 : 0;
    // 显式要求 workflow 源核验时，--allow-degraded 也不能把缺失/不符的证据升级成通过。
    if (options.workflowSource && deploy.workflowSourceVerified !== true) return 1;
    if (!deploy.available) return options.allowDegraded ? 0 : 1;
    if (deploy.status === 'completed') {
        if (deploy.conclusion !== 'success') return 1;
        return deploy.jobVerified === true || options.allowDegraded ? 0 : 1;
    }
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
        workflowSource: false,
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--date') options.date = argv[++index] || null;
        else if (value === '--limit') options.limit = Number(argv[++index]);
        else if (value === '--deploy') { const oid = argv[++index] || ''; if (!/^[0-9a-f]{40}$/i.test(oid)) throw new Error('--deploy 必须是 40 位十六进制 OID'); options.deploy = oid; }
        else if (value === '--workflow-source') options.workflowSource = true;
        else if (value === '--json') options.json = true;
        else if (value === '--timeout-ms') options.timeoutMs = Number(argv[++index]) || 20000;
        else if (value === '--allow-degraded') options.allowDegraded = true;
        else if (value === '--allow-partial') options.allowPartial = true;
        else if (value === '--receipt') { const file = argv[++index] || ''; if (!file) throw new Error('--receipt 需要文件路径'); options.receipt = file; }
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

const USAGE = '用法: node scripts/verify-web.js --date YYYY-MM-DD [--limit N] [--deploy OID] [--workflow-source] [--receipt RECEIPT.json] [--wait] [--wait-seconds N] [--poll-interval-ms N] [--timeout-ms N] [--allow-degraded] [--allow-partial] [--json]';

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
    if (options.workflowSource && !options.deploy) {
        printError('[verify-web] --workflow-source 需要同时提供 --deploy OID');
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
        // --workflow-source：在 HTTP 核验前确认该提交对应的 Pages run、workflow 源文件与 job/step 序列。
        let workflow = null;
        if (options.workflowSource) {
            workflow = verifyWorkflowSource(options.deploy, {
                spawnSync: spawnSyncImpl,
                repository: options.repository || deployRepository(env),
                run: deploy,
                profile: deps.workflowProfile
            });
            deploy = {
                ...(deploy || {}),
                workflowSourceVerified: workflow.verified === true,
                workflowSource: workflow.workflowSource || null,
                workflowJobs: workflow.jobs || null,
                workflowChecks: workflow.checks || null,
                workflowError: workflow.verified ? null : {
                    code: workflow.code || 'workflow_unverified',
                    message: workflow.message || null,
                    nextStep: workflow.nextStep || null
                }
            };
            if (options.json) {
                print(JSON.stringify({ type: 'workflow-source', oid: options.deploy, ...workflow }));
            } else if (workflow.verified) {
                print(`[verify-web] workflow 源：${workflow.workflowSource.sha256} @ ${workflow.workflowSource.commit}；`
                    + `${workflow.jobs.map(job => `${job.role}(${job.requiredSteps.map(step => step.name).join('→')})`).join(' / ')} 通过`);
            } else {
                print(`[verify-web] workflow 源核验失败（${workflow.code || 'unknown'}）：${workflow.message}`);
                if (workflow.nextStep) print(`[verify-web] 下一步：${workflow.nextStep}`);
            }
        }
        const summary = await verify(options.date, {
            env,
            currentDir,
            fetchImpl,
            timeoutMs: options.timeoutMs,
            limit: options.limit,
            deploy,
            deployOid: options.deploy,
            noWrite: true
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
        } else {
            summary.partial = true; // 无审查凭证不能作为完整验收证据
        }
        const deployOk = Boolean(deploy && deploy.available && deploy.status === 'completed' && deploy.conclusion === 'success' && deploy.jobVerified === true);
        const workflowOk = !options.workflowSource || Boolean(deploy && deploy.workflowSourceVerified === true);
        if (options.limit && summary.checked < summary.expected) summary.partial = true;
        if (!deployOk || !workflowOk) summary.partial = true;
        // 所有校验完成后再写 artifact，避免绑定失败留下“通过”证据。
        writeVerificationArtifact(currentDir, options.date, summary);
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
        const partialFailed = summary.partial && !options.allowPartial;
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
    ARTIFACT_FORMAT,
    hasVerificationArtifactFormat,
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
    WORKFLOW_PROFILE,
    parseWorkflowRunList,
    parseWorkflowRunDetail,
    validateWorkflowRun,
    parseWorkflowSource,
    validateWorkflowJobs,
    verifyWorkflowSource,
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

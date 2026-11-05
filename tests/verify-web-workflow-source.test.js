'use strict';
// 离线用例：gh 输出解析、提交/workflow/step 不匹配必须拒绝，以及 --workflow-source 的
// artifact 与退出码。所有网络与子进程都从 stub 注入，不访问 GitHub。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const verifyWeb = require('../scripts/verify-web');

const DATE = '2099-02-03';
const OID = 'a'.repeat(40);
const OTHER_OID = 'b'.repeat(40);
const REPOSITORY = 'nanless/audio-paper-digest-blog';
const WORKFLOW_TEXT = [
    'name: Deploy Hugo to Pages',
    'on:',
    '  push:',
    '    branches: ["main"]',
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: Build and verify',
    ''
].join('\n');
const PROFILE = {
    ...verifyWeb.WORKFLOW_PROFILE,
    sha256: crypto.createHash('sha256').update(WORKFLOW_TEXT).digest('hex'),
    roles: [
        { role: 'unit', steps: [[5, 'Unit checks']] },
        { role: 'build', steps: [[6, 'Build and verify'], [7, 'Upload artifact']] },
        { role: 'deploy', steps: [[2, 'Deploy to GitHub Pages']] }
    ]
};

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-web-workflow-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeManifest(dir, date, slugs) {
    fs.writeFileSync(path.join(dir, `blog-generation-manifest-${date}.json`), JSON.stringify({
        date,
        files: slugs.map(slug => ({ path: `content/posts/${slug}.md` }))
    }));
}

function writeReceipt(dir, date, oid = OID) {
    const manifestFile = path.join(dir, `blog-generation-manifest-${date}.json`);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex');
    fs.writeFileSync(path.join(dir, `blog-review-receipt-${date}.json`), JSON.stringify({
        generationManifestSha256: sha, publicationCommit: oid, remoteVerifiedOid: oid
    }));
}

function pageFetch() {
    return async () => ({
        status: 200,
        url: null,
        text: async () => `<title>语音/音乐/音频论文速递 ${DATE} 汇总</title>`
    });
}

function sourceResponse(text = WORKFLOW_TEXT, profile = PROFILE) {
    const raw = Buffer.from(text, 'utf8');
    return {
        type: 'file',
        path: profile.path,
        sha: crypto.createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex'),
        size: raw.length,
        encoding: 'base64',
        content: raw.toString('base64')
    };
}

function jobsFixture(oid = OID) {
    return [
        {
            databaseId: 11, name: 'unit', status: 'completed', conclusion: 'success',
            headSha: oid, headBranch: 'main',
            steps: [
                { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
                { number: 5, name: 'Unit checks', status: 'completed', conclusion: 'success' }
            ]
        },
        {
            databaseId: 12, name: 'build', status: 'completed', conclusion: 'success',
            headSha: oid, headBranch: 'main',
            steps: [
                { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
                { number: 6, name: 'Build and verify', status: 'completed', conclusion: 'success' },
                { number: 7, name: 'Upload artifact', status: 'completed', conclusion: 'success' }
            ]
        },
        {
            databaseId: 13, name: 'deploy', status: 'completed', conclusion: 'success',
            headSha: oid, headBranch: 'main',
            steps: [
                { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
                { number: 2, name: 'Deploy to GitHub Pages', status: 'completed', conclusion: 'success' }
            ]
        }
    ];
}

function runListFixture(oid = OID, extra = {}) {
    return [{
        headSha: oid,
        status: 'completed',
        conclusion: 'success',
        url: `https://github.com/${REPOSITORY}/actions/runs/1`,
        workflowName: 'Deploy Hugo to Pages',
        event: 'push',
        databaseId: 1,
        headBranch: 'main',
        ...extra
    }];
}

function runDetailFixture(oid = OID, jobs = jobsFixture(oid), extra = {}) {
    return {
        attempt: 1,
        event: 'push',
        headBranch: 'main',
        headSha: oid,
        status: 'completed',
        conclusion: 'success',
        workflowName: 'Deploy Hugo to Pages',
        url: `https://github.com/${REPOSITORY}/actions/runs/1`,
        jobs,
        ...extra
    };
}

function ghStub({ runs, detail, source, listFailure, viewFailure, apiFailure } = {}) {
    return (command, args = []) => {
        assert.strictEqual(command, 'gh');
        if (args[0] === 'run' && args[1] === 'list') {
            if (listFailure) return listFailure;
            return { status: 0, stdout: JSON.stringify(runs === undefined ? runListFixture() : runs) };
        }
        if (args[0] === 'run' && args[1] === 'view') {
            if (viewFailure) return viewFailure;
            return { status: 0, stdout: JSON.stringify(detail === undefined ? runDetailFixture() : detail) };
        }
        if (args[0] === 'api') {
            if (apiFailure) return apiFailure;
            return { status: 0, stdout: JSON.stringify(source === undefined ? sourceResponse() : source) };
        }
        throw new Error(`未预期的 gh 调用：${args.join(' ')}`);
    };
}

function cliBase(dir, gh) {
    return {
        currentDir: dir,
        env: { PAPER_DIGEST_BLOG_URL: 'https://example.com/posts', PAPER_DIGEST_BLOG_REPO_RUN: REPOSITORY },
        fetchImpl: pageFetch(),
        spawnSync: gh,
        workflowProfile: PROFILE,
        print: () => {},
        printError: () => {}
    };
}

function artifact(dir, date = DATE) {
    const file = path.join(dir, `web-verification-${date}.json`);
    assert.ok(fs.existsSync(file), `缺少 artifact: ${file}`);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('parseWorkflowRunList 精确按提交选 run，缺失/歧义/身份不符都拒绝', () => {
    const selected = verifyWeb.parseWorkflowRunList(JSON.stringify(runListFixture()), OID, PROFILE);
    assert.strictEqual(selected.ok, true);
    assert.strictEqual(selected.run.runId, 1);
    assert.strictEqual(selected.run.oid, OID);

    const missing = verifyWeb.parseWorkflowRunList(JSON.stringify(runListFixture(OTHER_OID)), OID, PROFILE);
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.code, 'run_not_found');
    assert.ok(missing.nextStep);

    const ambiguous = verifyWeb.parseWorkflowRunList(JSON.stringify([
        ...runListFixture(), ...runListFixture(OID, { databaseId: 2 })
    ]), OID, PROFILE);
    assert.strictEqual(ambiguous.code, 'run_ambiguous');

    for (const extra of [{ workflowName: 'Other workflow' }, { event: 'workflow_dispatch' }, { headBranch: 'dev' }]) {
        const wrong = verifyWeb.parseWorkflowRunList(JSON.stringify(runListFixture(OID, extra)), OID, PROFILE);
        assert.strictEqual(wrong.ok, false, JSON.stringify(extra));
        assert.strictEqual(wrong.code, 'run_identity');
    }

    const noId = verifyWeb.parseWorkflowRunList(JSON.stringify(runListFixture(OID, { databaseId: null })), OID, PROFILE);
    assert.strictEqual(noId.code, 'run_identity');
    assert.strictEqual(verifyWeb.parseWorkflowRunList('{bad', OID, PROFILE).code, 'api_invalid');
});

test('validateWorkflowRun 拒绝提交/分支/事件/工作流不符与未成功 run', () => {
    assert.strictEqual(verifyWeb.validateWorkflowRun(runDetailFixture(), OID, PROFILE).ok, true);
    assert.strictEqual(verifyWeb.validateWorkflowRun(runDetailFixture(OTHER_OID), OID, PROFILE).code, 'run_identity');
    assert.strictEqual(verifyWeb.validateWorkflowRun(runDetailFixture(OID, jobsFixture(), { headBranch: 'dev' }), OID, PROFILE).code, 'run_identity');
    assert.strictEqual(verifyWeb.validateWorkflowRun(runDetailFixture(OID, jobsFixture(), { event: 'pull_request' }), OID, PROFILE).code, 'run_identity');
    assert.strictEqual(verifyWeb.validateWorkflowRun(runDetailFixture(OID, jobsFixture(), { workflowName: 'Other' }), OID, PROFILE).code, 'run_identity');
    assert.strictEqual(verifyWeb.validateWorkflowRun(runDetailFixture(OID, jobsFixture(), { status: 'in_progress', conclusion: null }), OID, PROFILE).code, 'run_pending');
    assert.strictEqual(verifyWeb.validateWorkflowRun(runDetailFixture(OID, jobsFixture(), { conclusion: 'failure' }), OID, PROFILE).code, 'run_failed');
});

test('parseWorkflowSource 核对 path/git blob OID/大小/SHA-256，不放宽未知编码', () => {
    const decoded = verifyWeb.parseWorkflowSource(JSON.stringify(sourceResponse()), OID, PROFILE);
    assert.strictEqual(decoded.ok, true);
    assert.strictEqual(decoded.source.sha256, PROFILE.sha256);
    assert.strictEqual(decoded.source.commit, OID);
    assert.match(decoded.source.gitBlobOid, /^[0-9a-f]{40}$/);

    const changed = verifyWeb.parseWorkflowSource(JSON.stringify(sourceResponse('name: other\n')), OID, PROFILE);
    assert.strictEqual(changed.ok, false);
    assert.strictEqual(changed.code, 'workflow_profile_mismatch');
    assert.ok(changed.nextStep);

    assert.strictEqual(verifyWeb.parseWorkflowSource(JSON.stringify({ ...sourceResponse(), path: '.github/workflows/other.yaml' }), OID, PROFILE).code, 'workflow_identity');
    assert.strictEqual(verifyWeb.parseWorkflowSource(JSON.stringify({ ...sourceResponse(), size: 1 }), OID, PROFILE).code, 'workflow_identity');
    assert.strictEqual(verifyWeb.parseWorkflowSource(JSON.stringify({ ...sourceResponse(), sha: '0'.repeat(40) }), OID, PROFILE).code, 'workflow_identity');
    assert.strictEqual(verifyWeb.parseWorkflowSource(JSON.stringify({ ...sourceResponse(), encoding: 'utf-8' }), OID, PROFILE).code, 'workflow_identity');
    assert.strictEqual(verifyWeb.parseWorkflowSource(JSON.stringify({ ...sourceResponse(), content: '***' }), OID, PROFILE).code, 'workflow_identity');
    assert.strictEqual(verifyWeb.parseWorkflowSource(JSON.stringify({ ...sourceResponse(), type: 'symlink' }), OID, PROFILE).code, 'workflow_identity');
});

test('validateWorkflowJobs 要求必需 job 成功且 step 编号、名称、结论逐一匹配', () => {
    const ok = verifyWeb.validateWorkflowJobs(jobsFixture(), OID, PROFILE);
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(ok.jobs.map(job => job.role), ['unit', 'build', 'deploy']);
    assert.deepStrictEqual(ok.jobs[1].requiredSteps.map(step => step.name), ['Build and verify', 'Upload artifact']);

    assert.strictEqual(verifyWeb.validateWorkflowJobs(jobsFixture().filter(job => job.name !== 'deploy'), OID, PROFILE).code, 'jobs_incomplete');
    assert.strictEqual(verifyWeb.validateWorkflowJobs(jobsFixture(), OID, PROFILE).ok, true);

    const failedJob = jobsFixture();
    failedJob[2] = { ...failedJob[2], conclusion: 'failure' };
    assert.strictEqual(verifyWeb.validateWorkflowJobs(failedJob, OID, PROFILE).code, 'job_failed');

    const wrongHead = jobsFixture();
    wrongHead[1] = { ...wrongHead[1], headSha: OTHER_OID };
    assert.strictEqual(verifyWeb.validateWorkflowJobs(wrongHead, OID, PROFILE).code, 'job_identity');

    const wrongNumber = jobsFixture();
    wrongNumber[1] = {
        ...wrongNumber[1],
        steps: wrongNumber[1].steps.map(step => step.number === 6 ? { ...step, number: 8 } : step)
    };
    assert.strictEqual(verifyWeb.validateWorkflowJobs(wrongNumber, OID, PROFILE).code, 'step_identity');

    const wrongName = jobsFixture();
    wrongName[1] = {
        ...wrongName[1],
        steps: wrongName[1].steps.map(step => step.number === 7 ? { ...step, name: 'Upload something' } : step)
    };
    assert.strictEqual(verifyWeb.validateWorkflowJobs(wrongName, OID, PROFILE).code, 'step_identity');

    const failedStep = jobsFixture();
    failedStep[1] = {
        ...failedStep[1],
        steps: failedStep[1].steps.map(step => step.number === 6 ? { ...step, conclusion: 'failure' } : step)
    };
    assert.strictEqual(verifyWeb.validateWorkflowJobs(failedStep, OID, PROFILE).code, 'step_failed');

    const extraJob = jobsFixture();
    extraJob.push({ name: 'lint', status: 'completed', conclusion: 'success', steps: [] });
    assert.strictEqual(verifyWeb.validateWorkflowJobs(extraJob, OID, PROFILE).code, 'role_profile');
});

test('verifyWorkflowSource: 成功的 run/workflow/jobs 组合给出完整证据', () => {
    const result = verifyWeb.verifyWorkflowSource(OID, {
        repository: REPOSITORY,
        profile: PROFILE,
        spawnSync: ghStub()
    });
    assert.strictEqual(result.available, true);
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.run.runId, 1);
    assert.strictEqual(result.workflowSource.path, PROFILE.path);
    assert.strictEqual(result.workflowSource.commit, OID);
    assert.deepStrictEqual(result.checks, {
        run: 'verified', commit: 'verified', workflowSource: 'verified', jobs: 'verified', steps: 'verified'
    });
    assert.deepStrictEqual(result.jobs.map(job => job.role), ['unit', 'build', 'deploy']);
});

test('verifyWorkflowSource: gh 不可用、run 缺失、源文件不符都明确失败并给出下一步', () => {
    const unavailable = verifyWeb.verifyWorkflowSource(OID, {
        repository: REPOSITORY,
        profile: PROFILE,
        spawnSync: () => ({ status: 1, stdout: '', stderr: 'gh: not found' })
    });
    assert.strictEqual(unavailable.available, false);
    assert.strictEqual(unavailable.verified, false);
    assert.strictEqual(unavailable.code, 'gh_unavailable');
    assert.ok(unavailable.nextStep);

    const throws = verifyWeb.verifyWorkflowSource(OID, {
        repository: REPOSITORY,
        profile: PROFILE,
        spawnSync: () => { throw new Error('spawn failed'); }
    });
    assert.strictEqual(throws.code, 'gh_unavailable');

    const notFound = verifyWeb.verifyWorkflowSource(OID, {
        repository: REPOSITORY,
        profile: PROFILE,
        spawnSync: ghStub({ runs: runListFixture(OTHER_OID) })
    });
    assert.strictEqual(notFound.available, true);
    assert.strictEqual(notFound.verified, false);
    assert.strictEqual(notFound.code, 'run_not_found');
    assert.ok(notFound.nextStep);

    const changedSource = verifyWeb.verifyWorkflowSource(OID, {
        repository: REPOSITORY,
        profile: PROFILE,
        spawnSync: ghStub({ source: sourceResponse('name: other\n') })
    });
    assert.strictEqual(changedSource.verified, false);
    assert.strictEqual(changedSource.code, 'workflow_profile_mismatch');

    const apiFailure = verifyWeb.verifyWorkflowSource(OID, {
        repository: REPOSITORY,
        profile: PROFILE,
        spawnSync: ghStub({ apiFailure: { status: 1, stdout: '' } })
    });
    assert.strictEqual(apiFailure.code, 'gh_unavailable');

    const wrongRunOid = verifyWeb.verifyWorkflowSource(OID, {
        repository: REPOSITORY,
        profile: PROFILE,
        run: { runId: 1, oid: OTHER_OID, status: 'completed', conclusion: 'success' },
        spawnSync: ghStub()
    });
    assert.strictEqual(wrongRunOid.code, 'run_identity');
});

test('CLI --workflow-source 成功时写入 0600 artifact 并记录 workflow 源与 step', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [DATE]);
    writeReceipt(dir, DATE);
    const lines = [];
    const code = await verifyWeb.runVerifyWebCli([
        '--date', DATE, '--deploy', OID, '--workflow-source', '--json'
    ], {
        ...cliBase(dir, ghStub()),
        print: line => lines.push(line),
        printError: line => { throw new Error(`不应有错误输出: ${line}`); }
    });
    assert.strictEqual(code, 0);
    const parsed = lines.map(line => JSON.parse(line));
    const workflowLine = parsed.find(item => item.type === 'workflow-source');
    assert.strictEqual(workflowLine.verified, true);
    const saved = artifact(dir);
    assert.strictEqual(saved.contract, verifyWeb.ARTIFACT_FORMAT);
    assert.strictEqual(saved.partial, false);
    assert.strictEqual(saved.deploy.workflowSourceVerified, true);
    assert.strictEqual(saved.deploy.workflowSource.sha256, PROFILE.sha256);
    assert.deepStrictEqual(saved.deploy.workflowJobs.map(job => job.role), ['unit', 'build', 'deploy']);
    assert.strictEqual(saved.deploy.workflowError, null);
});

test('CLI --workflow-source 的 workflow 不符时 fail-closed，诊断开关也不能放行', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [DATE]);
    writeReceipt(dir, DATE);
    for (const flags of [[], ['--allow-partial'], ['--allow-degraded', '--allow-partial']]) {
        const lines = [];
        const code = await verifyWeb.runVerifyWebCli([
            '--date', DATE, '--deploy', OID, '--workflow-source', '--json', ...flags
        ], {
            ...cliBase(dir, ghStub({ source: sourceResponse('name: other\n') })),
            print: line => lines.push(line),
            printError: () => {}
        });
        assert.strictEqual(code, 1, `flags=${flags.join(' ') || 'default'} 不得把 workflow 不符写成通过`);
        const saved = artifact(dir);
        assert.strictEqual(saved.partial, true);
        assert.strictEqual(saved.deploy.workflowSourceVerified, false);
        assert.strictEqual(saved.deploy.workflowError.code, 'workflow_profile_mismatch');
        const summary = lines.map(line => JSON.parse(line)).find(item => item.type === 'summary');
        assert.strictEqual(summary.partial, true);
    }
});

test('CLI --workflow-source 在 gh 不可用时非零并保留可读的下一步', async t => {
    const dir = tempDir(t);
    writeManifest(dir, DATE, [DATE]);
    writeReceipt(dir, DATE);
    const errors = [];
    const code = await verifyWeb.runVerifyWebCli([
        '--date', DATE, '--deploy', OID, '--workflow-source', '--allow-degraded', '--allow-partial'
    ], {
        ...cliBase(dir, () => ({ status: 1, stdout: '', stderr: 'gh: not found' })),
        print: () => {},
        printError: line => errors.push(line)
    });
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(errors, []);
    const saved = artifact(dir);
    assert.strictEqual(saved.partial, true);
    assert.strictEqual(saved.deploy.workflowSourceVerified, false);
    assert.strictEqual(saved.deploy.workflowError.code, 'gh_unavailable');
    assert.ok(saved.deploy.workflowError.nextStep);
});

test('--workflow-source 缺 --deploy 是参数错误；deployExitCode 不接受未核验的 workflow', async () => {
    const code = await verifyWeb.runVerifyWebCli(['--date', DATE, '--workflow-source'], {
        currentDir: '/nonexistent', print: () => {}, printError: () => {}
    });
    assert.strictEqual(code, 2);
});

test('deployExitCode 在要求 workflow 源时必须有 workflowSourceVerified=true', () => {
    const run = { available: true, status: 'completed', conclusion: 'success', jobVerified: true };
    assert.strictEqual(verifyWeb.deployExitCode(run, {}), 0);
    assert.strictEqual(verifyWeb.deployExitCode(run, { workflowSource: true }), 1);
    assert.strictEqual(verifyWeb.deployExitCode({ ...run, workflowSourceVerified: true }, { workflowSource: true }), 0);
    assert.strictEqual(verifyWeb.deployExitCode({ ...run, workflowSourceVerified: false }, { workflowSource: true, allowDegraded: true }), 1);
});

'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');
const renderer = require('../scripts/lib/reader-inline-svg');
const deep = require('../scripts/deep-analyzer');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const Config = require('../scripts/config');
const projectRoot = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const errorJson = JSON.stringify({ contract: 'reader-inline-svg-error-v1',
    code: 'unsupported_dependency', reason: 'external_css_icon_glyph' });
function svg(body) {
    return '<svg id="fixture" width="160" height="80" viewBox="0 0 160 80">'
        + '<foreignObject width="160" height="80">' + body + '</foreignObject></svg>';
}
function resource(inlineSvg) {
    const bytes = Buffer.from(inlineSvg);
    return { kind: 'inline_svg', mediaType: 'image/svg+xml', inlineSvg,
        inlineSvgBytes: bytes.length, inlineSvgSha256: sha(bytes) };
}
const dependent = () => resource(svg('<span class="ltx_inline-block fas fa-fire" aria-hidden="true"></span>'));
function rendererWithProcess(result) {
    const filename = require.resolve('../scripts/lib/reader-inline-svg');
    const isolated = new Module(filename, module);
    const originalRequire = isolated.require.bind(isolated);
    isolated.filename = filename;
    isolated.paths = Module._nodeModulePaths(path.dirname(filename));
    isolated.require = name => name === 'node:child_process' ? { spawn: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        child.kill = () => true;
        child.stdin.once('finish', () => queueMicrotask(() => {
            child.stdout.end(result.stdout || ''); child.stderr.end(result.stderr || '');
            if (result.error) child.emit('error', result.error);
            child.emit('close', result.code);
        }));
        return child;
    } } : originalRequire(name);
    isolated._compile(fs.readFileSync(filename, 'utf8'), filename);
    return isolated.exports;
}

test('独立Python子进程仅以65、精确错误JSON、空stdout声明源图缺依赖', async () => {
    const input = dependent(); const before = structuredClone(input);
    const child = spawnSync('bash', [path.join(projectRoot, 'scripts/python-runtime.sh'),
        path.join(projectRoot, 'scripts/reader_inline_svg.py')],
    { cwd: projectRoot, input: input.inlineSvg, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 65);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr.trim(), errorJson);
    await assert.rejects(renderer.renderOfficialInlineSvg(input), error =>
        error.code === 'READER_INLINE_SVG_UNSUPPORTED_DEPENDENCY'
        && renderer.isUnsupportedDependencyFailure(error)
        && deep.isPermanentApiReaderFigureFailure(error));
    assert.deepEqual(input, before);
});

test('错退出码、非规范JSON和夹带stdout均不能授权省略', async () => {
    for (const processResult of [
        { code: 64, stderr: errorJson },
        { code: 65, stderr: errorJson, stdout: 'partial pixels' },
        { code: 65, stderr: errorJson + '\nother diagnostic' },
        { code: 65, stderr: JSON.stringify({ contract: 'reader-inline-svg-error-v1', code: 'unsupported_dependency', reason: 'other' }) },
        { code: 65, stderr: 'runtime unavailable' }
    ]) {
        const isolated = rendererWithProcess(processResult);
        await assert.rejects(isolated.renderOfficialInlineSvg(dependent()), error =>
            error.code === 'READER_INLINE_SVG_INTEGRITY' && !isolated.isUnsupportedDependencyFailure(error));
    }
});

test('危险属性、外部资源及SHA漂移仍阻断，不能借图标依赖隐藏', async () => {
    for (const input of [
        resource(svg('<span class="fas fa-fire" onclick="x"></span>')),
        resource(svg('<span class="fas fa-fire" style="background:url(https://example.invalid/a)"></span>')),
        { ...dependent(), inlineSvgSha256: '0'.repeat(64) }
    ]) await assert.rejects(renderer.renderOfficialInlineSvg(input), error =>
        error.code === 'READER_INLINE_SVG_INTEGRITY'
        && !renderer.isUnsupportedDependencyFailure(error)
        && !deep.isPermanentApiReaderFigureFailure(error));
});

test('伪造code、浏览器缺失、超时和子进程错误保持阻断', async () => {
    const forged = Object.assign(new Error('invented'), { code: 'READER_INLINE_SVG_UNSUPPORTED_DEPENDENCY' });
    for (const error of [forged, new Error('当前没有可用的受控浏览器运行时'),
        new Error('内联 SVG 渲染超过 60 秒'), Object.assign(new Error('spawn failed'), { code: 'EMFILE' })]) {
        assert.equal(renderer.isUnsupportedDependencyFailure(error), false);
        assert.equal(deep.isPermanentApiReaderFigureFailure(error), false);
    }
    for (const result of [{ code: 1, stderr: 'browser runtime unavailable' },
        { code: null, error: Object.assign(new Error('spawn failed'), { code: 'EMFILE' }) }]) {
        const isolated = rendererWithProcess(result);
        await assert.rejects(isolated.renderOfficialInlineSvg(dependent()), error =>
            error.code === 'READER_INLINE_SVG_INTEGRITY' && !isolated.isUnsupportedDependencyFailure(error));
    }
});

test('正常日更材料化只省略已鉴别的源依赖，环境错误仍原样传播', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'inline-svg-unavailable-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const id = '2610.90083', input = dependent();
    const text = 'Synthetic sealed methods and experimental limitations. '.repeat(100);
    const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [],
        figures: [{ ordinal: 1, caption: 'Synthetic method diagram', recoveryStatus: 'complete',
            sourceDomSha256: sha(input.inlineSvg), images: [input] }] };
    artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-09', batchId: 'inline-unavailable', papers: [{ arxivId: id }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1,
        capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(options, {
            fetchText: async () => ({ text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`,
                structuredArtifacts: artifacts, fetchedAt: '2026-10-09T00:00:00.000Z', imageInfos: [], warnings: [] }),
            fetchPdf: async () => ({ bytes: Buffer.from('%PDF-1.7\nSynthetic\n%%EOF\n'),
                url: `https://arxiv.org/pdf/${id}`, fetchedAt: '2026-10-09T00:00:01.000Z' })
        }) });
    const directory = path.join(plan.sourcesDir, id, 'generation-000001');
    const snapshot = () => Object.fromEntries(fs.readdirSync(directory).map(name => [name, sha(fs.readFileSync(path.join(directory, name)))]));
    const before = snapshot();
    const figure = { ordinal: 1, url: renderer.inlineSvgSourceDescriptor(input, id).url };
    assert.deepEqual(await daily.ephemeralReaderFigures(id, [figure], plan), []);
    assert.deepEqual(snapshot(), before);
    const error = new Error('environment renderer failed');
    t.mock.method(renderer, 'renderOfficialInlineSvg', async () => { throw error; });
    await assert.rejects(daily.ephemeralReaderFigures(id, [figure], plan), actual => actual === error);
    assert.deepEqual(snapshot(), before);
});

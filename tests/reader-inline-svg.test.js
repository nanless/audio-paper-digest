'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const originalSealedRun = process.env.PD_READER_REAL_SOURCE_RUN;
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
const layoutErrorJson = JSON.stringify({ contract: 'reader-inline-svg-error-v1',
    code: 'unsupported_dependency', reason: 'external_latexml_layout_css' });
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
const layoutDependent = () => resource(svg('<span class="ltx_foreignobject_container"><span class="ltx_foreignobject_content"><cite>Actual citation</cite></span></span>')
    .replace('<foreignObject ', '<foreignObject style="--ltx-fo-width:10em;--ltx-fo-height:2em;--ltx-fo-depth:0em;font-size:10pt;" '));
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
        { code: 65, stderr: 'runtime unavailable' },
        { code: 65, stderr: layoutErrorJson, stdout: 'partial pixels' },
        { code: 64, stderr: layoutErrorJson },
        { code: 65, stderr: JSON.stringify({ reason: 'external_latexml_layout_css', contract: 'reader-inline-svg-error-v1', code: 'unsupported_dependency' }) },
        { code: 65, stderr: JSON.stringify({ contract: 'reader-inline-svg-error-v1', code: 'unsupported_dependency', reason: 'external_latexml_layout_css', extra: true }) }
    ]) {
        const isolated = rendererWithProcess(processResult);
        await assert.rejects(isolated.renderOfficialInlineSvg(dependent()), error =>
            error.code === 'READER_INLINE_SVG_INTEGRITY' && !isolated.isUnsupportedDependencyFailure(error));
    }
});

test('新的LaTeXML布局依赖只接受真实严格子进程声明，保留独立原因', async () => {
    const input = layoutDependent(), before = structuredClone(input);
    const child = spawnSync('bash', [path.join(projectRoot, 'scripts/python-runtime.sh'), path.join(projectRoot, 'scripts/reader_inline_svg.py')],
        { cwd: projectRoot, input: input.inlineSvg, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 65); assert.equal(child.stdout, ''); assert.equal(child.stderr.trim(), layoutErrorJson);
    await assert.rejects(renderer.renderOfficialInlineSvg(input), error =>
        error.unsupportedDependencyReason === 'external_latexml_layout_css'
        && renderer.isUnsupportedDependencyFailure(error) && deep.isPermanentApiReaderFigureFailure(error));
    assert.deepEqual(input, before);
    const forged = Object.assign(new Error('invented CSS reason'), {code:'READER_INLINE_SVG_UNSUPPORTED_DEPENDENCY',
        unsupportedDependencyReason:'external_latexml_layout_css'});
    assert.equal(renderer.isUnsupportedDependencyFailure(forged), false);
    assert.equal(deep.isPermanentApiReaderFigureFailure(forged), false);
});

test('原封存三张pre/cite依赖图逐项进入真实布局缺失原因且字节不变', {skip:!originalSealedRun}, async () => {
    for (const [id, ordinal] of [['2610.20830',5],['2610.20327',4],['2610.20263',3]]) {
        const file=path.join(originalSealedRun,'sources',id,'generation-000001/source-runtime.json');
        const before=fs.readFileSync(file), runtime=JSON.parse(before);
        const input=runtime.structuredArtifacts.figures.find(f=>f.ordinal===ordinal).images.find(i=>i.kind==='inline_svg');
        await assert.rejects(renderer.renderOfficialInlineSvg(input),error=>
            error.unsupportedDependencyReason==='external_latexml_layout_css' && renderer.isUnsupportedDependencyFailure(error)
            && deep.isPermanentApiReaderFigureFailure(error));
        assert.equal(sha(fs.readFileSync(file)),sha(before));
    }
});

test('已有真实已付inlineSVG逐张重渲染保持原像素SHA与候选身份', {skip:!originalSealedRun}, async () => {
    let seen=0;
    for(const name of fs.readdirSync(path.join(originalSealedRun,'reader-attempts')).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))) {
        const candidateFile=path.join(originalSealedRun,'reader-attempts',name), before=fs.readFileSync(candidateFile), candidate=JSON.parse(before);
        for(const evidence of candidate.payload?.imageEvidence||[]) {
            if(!evidence.inlineSvgSourceSha256 || evidence.status!=='ready') continue;
            const id=candidate.identity.paperId.replace(/v\d+$/,''), sourceFile=path.join(originalSealedRun,'sources',id,'generation-000001/source-runtime.json');
            const sourceBytes=fs.readFileSync(sourceFile), runtime=JSON.parse(sourceBytes);
            const input=runtime.structuredArtifacts.figures.find(f=>f.ordinal===evidence.ordinal).images.find(i=>i.kind==='inline_svg');
            const pixels=await renderer.renderOfficialInlineSvg(input);
            assert.equal(pixels.assetSha256,evidence.sourceSha256,`${id} Figure ${evidence.ordinal} paid pixels`);
            assert.equal(pixels.inlineSvgSourceSha256,evidence.inlineSvgSourceSha256);
            assert.equal(sha(fs.readFileSync(sourceFile)),sha(sourceBytes)); seen++;
        }
        assert.equal(sha(fs.readFileSync(candidateFile)),sha(before));
    }
    assert.ok(seen>0,'real paid inlineSVG evidence exists');
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
    const id = '2610.90083', input = layoutDependent();
    const intact = resource('<svg id="intact" width="160" height="80" viewBox="0 0 160 80"><rect width="100" height="60" fill="blue"/><text x="10" y="30">Original 42</text></svg>');
    const text = 'Synthetic sealed methods and experimental limitations. '.repeat(100);
    const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [],
        figures: [{ ordinal: 1, caption: 'Synthetic method diagram', recoveryStatus: 'complete',
            sourceDomSha256: sha(input.inlineSvg), images: [input] },
            { ordinal: 2, caption: 'Intact original diagram', recoveryStatus: 'complete',
                sourceDomSha256: sha(intact.inlineSvg), images: [intact] }] };
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
    const figures = [figure, {ordinal:2,url:renderer.inlineSvgSourceDescriptor(intact,id).url}];
    const rendered = await daily.ephemeralReaderFigures(id, figures, plan);
    assert.deepEqual(rendered.map(item=>item.ordinal), [2]);
    assert.equal(sha(rendered[0].rawBytes), rendered[0].assetSha256);
    assert.equal(rendered[0].inlineSvgSourceSha256, intact.inlineSvgSha256);
    assert.deepEqual(snapshot(), before);
    const error = new Error('environment renderer failed');
    t.mock.method(renderer, 'renderOfficialInlineSvg', async () => { throw error; });
    await assert.rejects(daily.ephemeralReaderFigures(id, [figure], plan), actual => actual === error);
    assert.deepEqual(snapshot(), before);
});

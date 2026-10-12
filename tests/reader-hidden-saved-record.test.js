const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture: createReaderSample } = require('./reader-signed-draft-fixture');
const { hasValidApiReaderV3Records } = require('../scripts/analysis-engine');

for (const kind of ['concept', 'formula', 'figure']) {
    test(`旧完整签名记录中的隐藏 ${kind} 内容不能取得公开资格`, () => {
        const { paper } = createReaderSample();
        assert.equal(hasValidApiReaderV3Records(paper), true);
        let block;
        if (kind === 'concept') block = paper.apiReaderPlan.conceptBridges[0].explanation;
        if (kind === 'formula') block = `\\[${paper.apiReaderPlan.formulaBindings[0].latex.trim()}\\]`;
        if (kind === 'figure') block = paper.apiReaderArticle.match(/!\[[^\n]*\]\([^\n]*\)/)[0];
        assert.ok(paper.apiReaderArticle.includes(block));
        paper.apiReaderArticle = paper.apiReaderArticle.replace(block, `<!--\n\n${block}\n\n-->`);
        const sha = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
        paper.apiReaderArticleSha256 = sha;
        paper.analysisManifest.stages.apiReaderArticle.articleSha256 = sha;
        assert.equal(hasValidApiReaderV3Records(paper), false);
    });
}


test('括号URL对应真实结构化原图的受控资格记录仍通过', () => {
    const deep = require('../scripts/deep-analyzer');
    const sample = createReaderSample();
    const { paper } = sample;
    const url = 'https://arxiv.org/html/2609.12345v1/figure(1).png';
    const artifacts = structuredClone(sample.sourceDetails.structuredArtifacts);
    artifacts.figures[0].images[0].url = url;
    const { payloadSha256: previousPayloadSha, ...artifactBody } = artifacts;
    artifacts.payloadSha256 = deep.stableFingerprint(artifactBody);
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(sample.draft), {
        requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
        availableFigureOrdinals: [1], requireSourceBindings: true,
        allowDeterministicQuoteRepair: true, structuredArtifacts: artifacts,
        sourceText: sample.sourceDetails.text });
    assert.equal(deep.getApiReaderFigureInventory(artifacts, '2609.12345')[0].url, url);
    // 本例单独核验已保存记录；下一个测试另走公开解析与装图入口。
    const oldUrl = paper.apiReaderFigures[0].url;
    paper.apiReaderArticle = paper.apiReaderArticle.replace(`](${oldUrl})`, `](${url})`);
    paper.apiReaderFigures[0].url = url;
    paper.apiReaderPlan = parsed.plan;
    const hash = deep.stableFingerprint;
    paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 = artifacts.payloadSha256;
    paper.analysisManifest.stages.apiReaderArticle.structuredArtifactsSha256 = artifacts.payloadSha256;
    paper.analysisManifest.stages.apiReaderArticle.sourceBindingsSha256 = parsed.plan.sourceBindingsSha256;
    paper.apiReaderArticleSha256 = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
    paper.apiReaderPlanSha256 = hash(parsed.plan);
    Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
        articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256,
        figuresSha256: hash(paper.apiReaderFigures) });
    assert.equal(hasValidApiReaderV3Records(paper), true);
});
test('同行反引号包住原图只是代码示例，不能取得原图展示资格', () => {
    const { paper } = createReaderSample();
    const image = paper.apiReaderArticle.match(/!\[[^\n]*\]\([^\n]*\)/)[0];
    paper.apiReaderArticle = paper.apiReaderArticle.replace(image, '`' + image + '`');
    const sha = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
    paper.apiReaderArticleSha256 = sha;
    paper.analysisManifest.stages.apiReaderArticle.articleSha256 = sha;
    assert.equal(hasValidApiReaderV3Records(paper), false);
});

test('实际公开解析和装图支持平衡括号URL，并继续拒绝未知图片和重复URL', () => {
    const fs = require('node:fs');
    const Module = require('node:module');
    const file = require.resolve('./reader-signed-draft-fixture');
    const sampleModule = new Module(file, module);
    sampleModule.filename = file;
    sampleModule.paths = module.paths;
    const source = fs.readFileSync(file, 'utf8');
    sampleModule._compile(source.replace('/figure.png', '/figure(1).png'), file);
    const sample = sampleModule.exports.fixture();
    assert.equal(hasValidApiReaderV3Records(sample.paper), true);
    const deep = require('../scripts/deep-analyzer');
    const options = { requiredVersion: 3, requireIntegratedTables: true,
        minimumIntegratedTables: 2, availableFigureOrdinals: [1], requireSourceBindings: true,
        allowDeterministicQuoteRepair: true, structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        sourceText: sample.sourceDetails.text };
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(sample.draft), options);
    const rendered = deep.injectApiReaderFigures(parsed, options.structuredArtifacts, '2609.12345');
    assert.equal(rendered.figures.length, 1);
    assert.match(rendered.article, /figure\(1\)\.png/);
    for (const extra of [
        '![未知原图](https://arxiv.org/html/2609.12345v1/unknown.png)',
        rendered.article.match(/!\[[^\n]*\]\([^\n]*\)/)[0]
    ]) {
        assert.throws(() => deep.injectApiReaderFigures({ ...rendered, article: rendered.article + '\n\n' + extra },
            options.structuredArtifacts, '2609.12345'));
    }
});

test('整段术语解释的行内代码示例不能算展示，局部代码和可见引用仍保留', () => {
    const deep = require('../scripts/deep-analyzer');
    for (const kind of ['whole-code', 'partial-code', 'visible-quote']) {
        const { paper } = createReaderSample();
        const bridge = paper.apiReaderPlan.conceptBridges[0];
        const original = bridge.explanation;
        let replacement;
        if (kind === 'whole-code') replacement = '`' + original + '`';
        if (kind === 'partial-code') replacement = original.replace(bridge.terms[0], '`' + bridge.terms[0] + '`');
        if (kind === 'visible-quote') replacement = '> ' + original;
        paper.apiReaderArticle = paper.apiReaderArticle.replace(original, replacement);
        if (kind !== 'whole-code') bridge.explanation = replacement;
        paper.apiReaderArticleSha256 = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
        paper.apiReaderPlanSha256 = deep.stableFingerprint(paper.apiReaderPlan);
        Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
            articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256 });
        assert.equal(hasValidApiReaderV3Records(paper), kind !== 'whole-code');
    }
});
test('多行原始TeX中的合法缩进保持原字节和公开资格，隐藏副本仍拒绝', () => {
    const fs = require('node:fs');
    const Module = require('node:module');
    const file = require.resolve('./reader-signed-draft-fixture');
    const sampleModule = new Module(file, module);
    sampleModule.filename = file;
    sampleModule.paths = module.paths;
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes("latex:'y=x.'"));
    sampleModule._compile(source.replace("latex:'y=x.'", "latex:'y=\\n    x.'"), file);
    const { paper } = sampleModule.exports.fixture();
    const block = `\\[${paper.apiReaderPlan.formulaBindings[0].latex.trim()}\\]`;
    assert.match(block, /\n    x/);
    assert.equal(hasValidApiReaderV3Records(paper), true);
    paper.apiReaderArticle = paper.apiReaderArticle.replace(block, '<!--\n\n' + block + '\n\n-->');
    const sha = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
    paper.apiReaderArticleSha256 = sha;
    paper.analysisManifest.stages.apiReaderArticle.articleSha256 = sha;
    assert.equal(hasValidApiReaderV3Records(paper), false);
});

test('跨行代码中的图和解释不计展示，空段落后的原图仍可见', () => {
    const deep = require('../scripts/deep-analyzer');
    for (const kind of ['image', 'concept']) {
        for (const blank of [false, true]) {
            const { paper } = createReaderSample();
            const value = kind === 'image' ? paper.apiReaderArticle.match(/!\[[^\n]*\]\([^\n]*\)/)[0]
                : paper.apiReaderPlan.conceptBridges[0].explanation;
            const gap = blank ? '\n\n' : '\n';
            paper.apiReaderArticle = paper.apiReaderArticle.replace(value, '`' + gap + value + gap + '`');
            paper.apiReaderArticleSha256 = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
            paper.analysisManifest.stages.apiReaderArticle.articleSha256 = paper.apiReaderArticleSha256;
            assert.equal(hasValidApiReaderV3Records(paper), blank);
            if (kind === 'image' && !blank) {
                assert.throws(() => deep.injectApiReaderFigures({ article: paper.apiReaderArticle, plan: paper.apiReaderPlan },
                    createReaderSample().sourceDetails.structuredArtifacts, '2609.12345'));
            }
        }
    }
});

test('反斜杠转义的叹号不是原图，偶数反斜杠保留实际图片', () => {
    for (const count of [1, 2]) {
        const { paper } = createReaderSample();
        const image = paper.apiReaderArticle.match(/!\[[^\n]*\]\([^\n]*\)/)[0];
        paper.apiReaderArticle = paper.apiReaderArticle.replace(image, '\\'.repeat(count) + image);
        const sha = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
        paper.apiReaderArticleSha256 = sha;
        paper.analysisManifest.stages.apiReaderArticle.articleSha256 = sha;
        assert.equal(hasValidApiReaderV3Records(paper), count === 2);
    }
});

test('转义后的反引号不形成代码段，可见图片仍对应原来源', () => {
    const { paper } = createReaderSample();
    const image = paper.apiReaderArticle.match(/!\[[^\n]*\]\([^\n]*\)/)[0];
    paper.apiReaderArticle = paper.apiReaderArticle.replace(image, '\\`\n' + image + '\n\\`');
    const sha = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
    paper.apiReaderArticleSha256 = sha;
    paper.analysisManifest.stages.apiReaderArticle.articleSha256 = sha;
    assert.equal(hasValidApiReaderV3Records(paper), true);
});
test('可见引用里的围栏和原样HTML仍不能展示原图，普通引用图保持可见', () => {
    for (const wrap of [value => '> ```text\n> ' + value + '\n> ```',
        value => '> <script>\n> ' + value + '\n> </script>', value => '> ' + value]) {
        const { paper } = createReaderSample();
        const image = paper.apiReaderArticle.match(/!\[[^\n]*\]\([^\n]*\)/)[0];
        const replacement = wrap(image);
        paper.apiReaderArticle = paper.apiReaderArticle.replace(image, replacement);
        const sha = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
        paper.apiReaderArticleSha256 = sha;
        paper.analysisManifest.stages.apiReaderArticle.articleSha256 = sha;
        assert.equal(hasValidApiReaderV3Records(paper), replacement === '> ' + image);
    }
});

test('引用中的普通HTML块和缩进代码不展示图，普通引用图仍可见', () => {
    for (const wrap of [value => '> <custom-box>\n> ' + value + '\n> </custom-box>',
        value => '>     ' + value, value => '> ' + value]) {
        const { paper } = createReaderSample();
        const image = paper.apiReaderArticle.match(/!\[[^\n]*\]\([^\n]*\)/)[0];
        const replacement = wrap(image);
        paper.apiReaderArticle = paper.apiReaderArticle.replace(image, replacement);
        const sha = crypto.createHash('sha256').update(paper.apiReaderArticle).digest('hex');
        paper.apiReaderArticleSha256 = sha;
        paper.analysisManifest.stages.apiReaderArticle.articleSha256 = sha;
        assert.equal(hasValidApiReaderV3Records(paper), replacement === '> ' + image);
    }
});

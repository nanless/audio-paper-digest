'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
    extractVisibleDisplayFormulaBlocks,
    hasValidIntegratedApiReaderRecords
} = require('../scripts/analysis-engine.js');
const manifest = require('../scripts/manifest-new.js');
const repair = require('../scripts/lib/reader-repair.js');
const { fixture: signedReaderFixture, sign: resealSignedReader } = require('./reader-signed-draft-fixture.js');

const HUGO_AVAILABLE = spawnSync('hugo', ['version'], { stdio: 'ignore' }).status === 0;

function renderWithHugoPassthrough(markdownMap) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hugo-formula-parity-'));
    try {
        fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'layouts', '_default'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'hugo.yaml'), [
            'markup:',
            '  goldmark:',
            '    extensions:',
            '      passthrough:',
            '        enable: true',
            '        delimiters:',
            '          block: [["\\\\[", "\\\\]"]]',
            '          inline: [["\\\\(", "\\\\)"]]',
            '    renderer:',
            '      unsafe: true',
            ''
        ].join('\n'));
        fs.writeFileSync(path.join(dir, 'layouts', '_default', 'single.html'), '{{ .Content }}');
        for (const [slug, md] of Object.entries(markdownMap)) {
            fs.writeFileSync(path.join(dir, 'content', `${slug}.md`), `---\ntitle: ${slug}\n---\n${md}\n`);
        }
        execFileSync('hugo', ['--source', dir, '--destination', path.join(dir, 'public'), '--quiet']);
        const out = {};
        for (const slug of Object.keys(markdownMap)) {
            out[slug] = fs.readFileSync(path.join(dir, 'public', slug.toLowerCase(), 'index.html'), 'utf8');
        }
        return out;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('extractVisibleDisplayFormulaBlocks: 图片 alt 内未闭合转义 \\[ 与 TeX 双反引号不吞掉后续展示公式', () => {
    const formula1 = '\\[e_{\\text{audio}} = f_{\\text{CLAP}}(a_i)\\]';
    const formula2 = '\\[s_i = \\text{sim}\\!\\left(e_{\\text{audio}}, \\text{``a\'\' and ``b\'\'}\\right)\\]';
    const formula3 = '\\[a =\n    b+c\\]';
    const article = [
        '方法概览如下图所示：',
        '![原论文 Figure 3：frozen CLAP \\[Wu et al.(2023)Wu, Chen,…](https://arxiv.org/html/2611.24410#S3.F3.pic1)',
        '音频编码公式如下：',
        formula1,
        '文本提示对比公式如下：',
        formula2,
        '多行缩进公式如下：',
        formula3
    ].join('\n\n');

    assert.deepEqual(extractVisibleDisplayFormulaBlocks(article), [formula1, formula2, formula3]);
});

test('hasValidIntegratedApiReaderRecords: 图注含未闭合 \\[ 且前置行内代码含 `\\[` 时公式绑定仍完整通过', () => {
    const { paper } = signedReaderFixture();
    const originalImage = paper.apiReaderArticle.match(/!\[[^\n]*\]\([^\n]*\)/)[0];
    const formulaBlock = `\\[${paper.apiReaderPlan.formulaBindings[0].latex}\\]`;
    assert.ok(paper.apiReaderArticle.includes(formulaBlock));

    const truncatedAltImage = `![原论文 Figure 3：frozen CLAP \\[Wu et al.(2023)Wu, Chen,…](${paper.apiReaderFigures[0].url})`;
    const withoutOriginalImage = paper.apiReaderArticle.replace(originalImage, '行内标记示例 `\\[` 仅作符号说明。');
    paper.apiReaderArticle = withoutOriginalImage.replace(
        formulaBlock,
        `${truncatedAltImage}\n\n${formulaBlock}`
    );
    resealSignedReader(paper);
    assert.equal(hasValidIntegratedApiReaderRecords(paper), true);
});

test('extractVisibleDisplayFormulaBlocks: 负例与 Goldmark passthrough 顺序边界', () => {
    const inlineUnclosedThenFormula = '散文提及起始定界符 `\\[` 后给出展示公式：\n\n\\[e = mc^2\\]';
    assert.deepEqual(extractVisibleDisplayFormulaBlocks(inlineUnclosedThenFormula), ['\\[e = mc^2\\]']);

    const nonVisibleFormulas = [
        '成对行内代码：`\\[x = 1\\]` 与带空格的 ` \\[z = 3\\] `。',
        '![alt \\[8\\]](https://arxiv.org/html/x/fig.png)',
        '```\n\\[y = 2\\]\n```'
    ].join('\n\n');
    assert.deepEqual(extractVisibleDisplayFormulaBlocks(nonVisibleFormulas), []);

    const unclosedProseBeforeImage = '散文中出现未闭合 \\[ 符号 ![alt](https://arxiv.org/html/x/fig.png) 后续无闭合。';
    assert.deepEqual(extractVisibleDisplayFormulaBlocks(unclosedProseBeforeImage), []);

    const passthroughBeforeBang = '散文 \\[x=1+![a\\]](https://arxiv.org/html/x/fig.png)';
    assert.deepEqual(extractVisibleDisplayFormulaBlocks(passthroughBeforeBang), ['\\[x=1+![a\\]']);
    if (HUGO_AVAILABLE) {
        const rendered = renderWithHugoPassthrough({ passthroughbeforebang: passthroughBeforeBang });
        assert.ok(rendered.passthroughbeforebang.includes('\\[x=1+![a\\]'));
    }
});

test('extractVisibleDisplayFormulaBlocks: 双/三反斜杠 HTML 活公式失败关闭，四/五反斜杠字面量忽略', () => {
    assert.deepEqual(extractVisibleDisplayFormulaBlocks('\\\\[x=1\\\\]'), ['\\\\[x=1\\\\]']);
    assert.deepEqual(extractVisibleDisplayFormulaBlocks('\\\\\\[x=1\\\\\\]'), ['\\\\\\[x=1\\\\\\]']);
    assert.deepEqual(extractVisibleDisplayFormulaBlocks('\\\\[x=1 unclosed'), ['\\\\[x=1 unclosed']);

    assert.deepEqual(extractVisibleDisplayFormulaBlocks('\\\\\\\\[x=1\\\\\\\\]\n\n\\[e = mc^2\\]'), ['\\[e = mc^2\\]']);
    assert.deepEqual(extractVisibleDisplayFormulaBlocks('\\\\\\\\\\[x=1\\\\\\\\\\]\n\n\\[e = mc^2\\]'), ['\\[e = mc^2\\]']);

    const { paper } = signedReaderFixture();
    paper.apiReaderArticle += '\n\n\\\\[x=1\\\\]';
    const articleSha = require('node:crypto').createHash('sha256').update(paper.apiReaderArticle).digest('hex');
    paper.apiReaderArticleSha256 = articleSha;
    paper.analysisManifest.stages.apiReaderArticle.articleSha256 = articleSha;
    assert.equal(hasValidIntegratedApiReaderRecords(paper), false);
});

test('extractVisibleDisplayFormulaBlocks: 行内/转义/块级 HTML 注释与图片 [alt] 内 passthrough 优先级完全对齐 Hugo Goldmark', () => {
    const cases = {
        midlinecommentacrossblank: {
            md: '前文 <!--\n\n\\[live=1\\]\n\n--> 后文 \\[e=mc^2\\]',
            expected: ['\\[live=1\\]', '\\[e=mc^2\\]']
        },
        midlinecommentclosedsamepara: {
            md: '前文 <!--\n\\[hidden=1\\]\n--> 后文 \\[e=mc^2\\]',
            expected: ['\\[e=mc^2\\]']
        },
        midlinecommentunclosed: {
            md: '前文 <!-- \\[live=1\\]',
            expected: ['\\[live=1\\]']
        },
        escapedcommentlinestart: {
            md: '\\<!-- \\[live=1\\] -->',
            expected: ['\\[live=1\\]']
        },
        escapedcommentmidline: {
            md: '前文 \\<!-- \\[live=1\\] -->',
            expected: ['\\[live=1\\]']
        },
        mathbeforeinlinecomment: {
            md: '散文 \\[x=1+<!--\\]-->',
            expected: ['\\[x=1+<!--\\]']
        },
        blockcommentsamelinetail: {
            md: '<!-- comment --> \\[e=mc^2\\]',
            expected: ['\\[e=mc^2\\]']
        },
        blockcommentmultiline: {
            md: '<!--\n\\[hidden=1\\]\n-->\n\n\\[e=mc^2\\]',
            expected: ['\\[e=mc^2\\]']
        },
        abruptshortcomment: {
            md: '<!-->\n\n\\[live=1\\]',
            expected: ['\\[live=1\\]']
        },
        altpassthroughsteal: {
            md: '![alt \\[Wu](https://arxiv.org/html/x/fig.png)+1\\]',
            expected: ['\\[Wu](https://arxiv.org/html/x/fig.png)+1\\]']
        },
        altpassthroughsamepara: {
            md: '![alt \\[Wu](https://arxiv.org/html/x/fig.png) \\[e=mc^2\\]',
            expected: ['\\[Wu](https://arxiv.org/html/x/fig.png) \\[e=mc^2\\]']
        },
        altpairedpassthrough: {
            md: '![alt \\[8\\]](https://arxiv.org/html/x/fig.png) \\[e=mc^2\\]',
            expected: ['\\[e=mc^2\\]']
        },
        altpairedunbalancedbracket: {
            md: '![alt \\[a ] b\\]](https://arxiv.org/html/x/fig.png) \\[e=mc^2\\]',
            expected: ['\\[e=mc^2\\]']
        },
        divrawcommentmultiline: {
            md: '正文。\n\n<div>\n<!--\n</div>\n\n\\[bound=1\\]\n\n<div>\n-->\n</div>',
            expected: []
        },
        divrawcommentsingleline: {
            md: '正文。\n\n<div><!--</div>\n\n\\[bound=1\\]\n\n<div>--></div>',
            expected: []
        },
        divrawbacktickcomment: {
            md: '正文。\n\n<div>\n`<!--`\n</div>\n\n\\[bound=1\\]\n\n<div>--></div>',
            expected: []
        },
        quoteexitedrawcomment: {
            md: '> <!--\n\n\\[bound=1\\]\n\n<div>--></div>',
            expected: []
        },
        multicommenttype2line: {
            md: '<!-- a --> <!--\n\\[bound=1\\]\n-->\n\n\\[live=2\\]',
            expected: ['\\[live=2\\]']
        },
        scriptliteralcommentnotleaked: {
            md: '<script>\n<!--\n</script>\n\n\\[e=mc^2\\]',
            expected: ['\\[e=mc^2\\]']
        }
    };

    for (const [slug, { md, expected }] of Object.entries(cases)) {
        assert.deepEqual(extractVisibleDisplayFormulaBlocks(md), expected, `case ${slug}`);
    }

    if (HUGO_AVAILABLE) {
        const rendered = renderWithHugoPassthrough(
            Object.fromEntries(Object.entries(cases).map(([slug, item]) => [slug, item.md]))
        );
        for (const [slug, { expected }] of Object.entries(cases)) {
            for (const formula of expected) {
                assert.ok(rendered[slug].includes(formula), `Hugo should contain ${formula} in ${slug}`);
            }
        }
    }
});

test('extractVisibleDisplayFormulaBlocks: CommonMark 主题分隔线、列表容器缩进、续行图片、平衡括号 alt、未闭合 ![ 与跨块边界对齐 Hugo Goldmark', () => {
    const cases = {
        thematichr: {
            md: '---\n    \\[y = 2\\]',
            expected: []
        },
        quotedthematichr: {
            md: '> ---\n>     \\[y = 2\\]',
            expected: []
        },
        setextunderline: {
            md: 'Heading\n===\n    \\[y = 2\\]\n\nSubheading\n---\n    \\[z = 3\\]',
            expected: []
        },
        listmultiparagraphbullet: {
            md: '- item\n\n    \\[e = mc^2\\]',
            expected: ['\\[e = mc^2\\]']
        },
        listmultiparagraphordered: {
            md: '1. item\n\n    \\[e = mc^2\\]',
            expected: ['\\[e = mc^2\\]']
        },
        listindentedcode6: {
            md: '- item\n\n      \\[code = 1\\]',
            expected: []
        },
        listindentedfence: {
            md: '- item\n    ~~~\n    \\[x=1\\]\n    ~~~',
            expected: []
        },
        nestedlistitems: {
            md: '- outer\n    - inner \\[0, 1)\n    - inner2 \\[e = mc^2\\]',
            expected: ['\\[e = mc^2\\]']
        },
        contlineimage: {
            md: '方法概览如下：\n    ![alt \\[Wu](https://arxiv.org/html/x/fig.png)\n\n\\[e = mc^2\\]',
            expected: ['\\[e = mc^2\\]']
        },
        balancedaltimage: {
            md: '![Figure 1 [0, 1] \\[Wu](https://arxiv.org/html/x/fig(1).png "title (1)")\n\n\\[e = mc^2\\]',
            expected: ['\\[e = mc^2\\]']
        },
        unclosedbang: {
            md: '散文感叹号 ![ 未闭合以及 ![alt](https://arxiv.org/html/x/fig.png 未闭合\n\n\\[e = mc^2\\]',
            expected: ['\\[e = mc^2\\]']
        },
        orderedlistandquote: {
            md: [
                '1. 第一项 \\[0, 1)',
                '2. 第二项 `\\[skip\\]`',
                '',
                '> 引用第一段 \\[0, 1)',
                '>',
                '> 引用第二段',
                '',
                '`code` # not-a-heading `\\[x\\]`',
                '',
                '\\[e = mc^2\\]'
            ].join('\n'),
            expected: ['\\[e = mc^2\\]']
        },
        crossblockhalfopen: {
            md: [
                '## 标题区间 \\[0, 1)',
                '',
                '散文半开区间 \\[0, 1) 不闭合。',
                '',
                '- 列表半开区间 \\[0, 1)',
                '- 另一列表项',
                '',
                '| 列 A | 列 B |',
                '| --- | --- |',
                '| \\[0, 1) | \\[e = mc^2\\] |'
            ].join('\n'),
            expected: ['\\[e = mc^2\\]']
        },
        blankinsideformula: {
            md: '\\[\na = 1\n\nb = 2\n\\]',
            expected: []
        }
    };

    for (const [slug, { md, expected }] of Object.entries(cases)) {
        assert.deepEqual(extractVisibleDisplayFormulaBlocks(md), expected, `case ${slug}`);
    }

    if (HUGO_AVAILABLE) {
        const rendered = renderWithHugoPassthrough(
            Object.fromEntries(Object.entries(cases).map(([slug, item]) => [slug, item.md]))
        );
        assert.match(rendered.thematichr, /<hr>\s*<pre><code>\\\[y = 2\\\]/);
        assert.match(rendered.quotedthematichr, /<blockquote>\s*<hr>\s*<pre><code>\\\[y = 2\\\]/);
        assert.match(rendered.listindentedcode6, /<pre><code>\\\[code = 1\\\]/);
        assert.match(rendered.listindentedfence, /<pre[^>]*><code>\\\[x=1\\\]/);
        assert.doesNotMatch(rendered.blankinsideformula, /\\\[/);
        for (const slug of [
            'listmultiparagraphbullet',
            'listmultiparagraphordered',
            'nestedlistitems',
            'contlineimage',
            'balancedaltimage',
            'unclosedbang',
            'orderedlistandquote',
            'crossblockhalfopen'
        ]) {
            assert.ok(rendered[slug].includes('\\[e = mc^2\\]'), `Hugo should render formula in ${slug}`);
        }
    }
});

test('manifest-new.findCandidate: 按当前 parser/repair 实现哈希消歧旧候选，全旧候选与双当前候选均拒绝', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'manifest-impl-disambiguate-'));
    try {
        const runId = '4538acd8-023b-40b5-85bb-e8a28d82383f';
        const sourceSha256 = '9'.repeat(64);
        const currentParserSha = manifest.currentReaderParserImplementationSha256();
        const currentRepairSha = repair.readerRepairImplementationSha256();
        const baseDraft = {
            version: 3,
            readerTitle: 'Disambiguation test',
            oneSentenceThesis: 'Test candidate selection.',
            sections: [{ kind: 'background', heading: 'h', body: 'b' }],
            conceptBridges: [],
            figurePlacements: [],
            tableBindings: [],
            formulaBindings: []
        };
        const payload = tag => ({
            status: 'failed',
            draft: { ...baseDraft, oneSentenceThesis: tag },
            rawDraft: JSON.stringify({ ...baseDraft, oneSentenceThesis: tag }),
            issues: [{ path: null, message: 'synthetic' }],
            attempts: 1,
            fullAttempts: 1,
            noProgress: 0,
            failureSignature: 'sig'
        });

        const staleFile1 = repair.saveFailedCandidate(dir, {
            paperId: '2611.23089v1',
            sourceSha256,
            freshAnalysis: { runId, sourceOnly: true },
            inputFingerprint: 'old-svg-fingerprint-1',
            parserImplementationSha256: '7'.repeat(64),
            repairImplementationSha256: currentRepairSha
        }, payload('stale-1'));

        const staleFile2 = repair.saveFailedCandidate(dir, {
            paperId: '2611.23089v1',
            sourceSha256,
            freshAnalysis: { runId, sourceOnly: true },
            inputFingerprint: 'old-svg-fingerprint-2',
            parserImplementationSha256: '8'.repeat(64),
            repairImplementationSha256: currentRepairSha
        }, payload('stale-2'));

        assert.notEqual(staleFile1, staleFile2);
        assert.throws(
            () => manifest.findCandidate(dir, '2611.23089', runId, sourceSha256),
            /2611\.23089 存在多个活动候选，当前输入身份未核，不能消除歧义/
        );

        const currentFile = repair.saveFailedCandidate(dir, {
            paperId: '2611.23089v1',
            sourceSha256,
            freshAnalysis: { runId, sourceOnly: true },
            inputFingerprint: 'current-svg-fingerprint',
            parserImplementationSha256: currentParserSha,
            repairImplementationSha256: currentRepairSha
        }, payload('current'));

        const found = manifest.findCandidate(dir, '2611.23089', runId, sourceSha256);
        assert.ok(found);
        assert.equal(path.resolve(found.absolutePath), path.resolve(currentFile));
        assert.equal(found.envelope.payload.draft.oneSentenceThesis, 'current');

        repair.saveFailedCandidate(dir, {
            paperId: '2611.23089v1',
            sourceSha256,
            freshAnalysis: { runId, sourceOnly: true },
            inputFingerprint: 'second-current-branch',
            parserImplementationSha256: currentParserSha,
            repairImplementationSha256: currentRepairSha
        }, payload('current-2'));

        assert.throws(
            () => manifest.findCandidate(dir, '2611.23089', runId, sourceSha256),
            /2611\.23089 存在多个活动候选，当前输入身份未核，不能消除歧义/
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('manifest-new.currentReaderParserImplementationSha256: 与 deep-analyzer.js 共用单源 reader-implementation-fingerprint', () => {
    const scriptsDir = path.resolve(__dirname, '../scripts');
    const deepSource = fs.readFileSync(path.join(scriptsDir, 'deep-analyzer.js'), 'utf8');
    assert.match(deepSource, /require\('\.\/lib\/reader-implementation-fingerprint'\)\.currentReaderParserImplementationSha256\(/);
    const fingerprintMod = require('../scripts/lib/reader-implementation-fingerprint');
    const expectedSha = fingerprintMod.currentReaderParserImplementationSha256({ workflow: 'daily' });
    assert.match(expectedSha, /^[a-f0-9]{64}$/);
    assert.equal(manifest.currentReaderParserImplementationSha256(), expectedSha);
});

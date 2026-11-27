'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const deep = require('../scripts/deep-analyzer.js');
const { loadPrompt } = require('../scripts/utils.js');
const evidence = require('../scripts/lib/prompt-evidence.js');
const history = require('../scripts/lib/prompt-history.js');
const readerResourceClaims = require('../scripts/lib/reader-resource-claims.js');
const readerIdentityFormat = require('../scripts/lib/reader-identity-format.js');
const publicProbe = require('../scripts/lib/public-resource-probe.js');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function loadDeepInternals() {
    const target = path.join(ROOT, 'scripts/deep-analyzer.js');
    const source = fs.readFileSync(target, 'utf8');
    const instance = new Module(target, module);
    instance.filename = target;
    instance.paths = Module._nodeModulePaths(path.dirname(target));
    instance._compile(
        source + '\nmodule.exports.__r2w1 = { findTableOmissionMarker, hasOmissionMarkers, getExperimentTableRepairIssue, checkAndFixTables, buildReaderRequestMessages };',
        target
    );
    return instance.exports.__r2w1;
}

const PRE_EDIT_BLOBS = [
    {
        stage: 'apiReaderArticle',
        relativePath: 'prompts/current/api-reader-article.md',
        blobOid: 'c826b83189d8a8451e5f3124c26d5f72467ae182',
        wholeSha256: 'c775eb556d41770c6f97760d45dcde9408ebf30cef16b885f31233127277b635',
        templateSha256: '1f9a8ce34252ccac10906a0c016e412b70c1eb0bb083bca6725031192ed4627d'
    },
    {
        stage: 'apiReaderRepair',
        relativePath: 'prompts/current/api-reader-repair.md',
        blobOid: 'e6b1428ee03141f2562418a1122c6f4e8538952e',
        wholeSha256: '8c1184f1a48a40947f0e59b85f69282eeecf4ac0873dc12f024f38d6de9ddc8f',
        templateSha256: '372efd80b50ff3bcd14478eaa132833445d0ce9c11a476829cda6d4e29ab76d6'
    },
    {
        stage: 'primaryAnalysis',
        relativePath: 'prompts/current/deep-analysis.md',
        blobOid: '8c1f436da1a8a7b61e942ce04c6915450e7bc106',
        wholeSha256: 'f0637c8c6da5fd4ab5f58ecd8eff6325646e3e3549ad0c9c98e2daff232e076c',
        templateSha256: '76768d404986b3e9becf324566623371cae929a75415b4b630cfc91e64baf50f'
    },
    {
        stage: 'tableRepair',
        relativePath: 'prompts/current/table-fill.md',
        blobOid: '488a439b4e1b0c4c4129e9950214b54a1b854435',
        wholeSha256: 'bac61576a7279482dd67543c7e1b1fee25f793d2dbc93685a402cfa45d333c9d',
        templateSha256: '28cb0cde480141ee837cc01f6c04ab834df6090f64d81a067dc00c1878e165d1'
    },
    {
        stage: 'coreSummaryRepair',
        relativePath: 'prompts/current/core-summary-repair.md',
        blobOid: 'f1e4deff0af998e2121a5e27a532902ba5fb1100',
        wholeSha256: 'db5a6ebd281004beef54e95ec88219014470e3c38079c183c4df9436a528b3dd',
        templateSha256: '353e637e4c71c797147ca47d4fa040d216622d45e51b53fa7359c8aa7d421b3a'
    },
    {
        stage: 'structureRepair',
        relativePath: 'prompts/current/structure-repair.md',
        blobOid: '0c479066fccf30691d44ec91848da590596262ea',
        wholeSha256: 'c6dc992d877b06c6d7e49cab5ea506d8bb9ab80df08898d2ee10483e4483ce3e',
        templateSha256: 'f571165c7320742b1dc0240e1b9c3e51ad0191251c403189411603c8c5619c35'
    },
    {
        stage: 'revision',
        relativePath: 'prompts/current/gap-fill.md',
        blobOid: 'e43485e69317c6331b055104ceb3575aa46ef1bc',
        wholeSha256: '3868e1cf8b1ad7defcc0fb57601d8d4d16db89b76ca6122c9d7ec3df15db9478',
        templateSha256: '197ca911d25665259bba462ff77069f4bd2360f23b508aaba9dcc1e61eea0774'
    },
    {
        stage: 'imageSupplement',
        relativePath: 'prompts/current/image-supplement.md',
        blobOid: 'ef550af7db8bd972d87434d746d89deffd0ad8f5',
        wholeSha256: 'a2b5ff411d69ec1637915ac89b1b9759562b78d8ab6a89cdc32f4710c1ffe8a6',
        templateSha256: '9134c4e06a8f1728ac7da0858dedf23eff60d39c858199159daf48bf6c67bf18'
    }
];

describe('R2-W1: Pre-edit Git blob registration & cold replay', () => {
    it('registers all 8 pre-edit prompt blobs sorted in git-prompt-evidence-index.json and resolves them cold', () => {
        const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/lib/git-prompt-evidence-index.json'), 'utf8'));
        const keys = Object.keys(index.blobs);
        assert.deepEqual(keys, [...keys].sort(), 'index.blobs keys must stay strictly sorted');

        for (const item of PRE_EDIT_BLOBS) {
            const entry = index.blobs[item.wholeSha256];
            assert.ok(entry, `missing blob registration for ${item.relativePath}`);
            assert.equal(entry.blobOid, item.blobOid);
            assert.ok(entry.paths.includes(item.relativePath));

            const gitBytes = execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', 'cat-file', 'blob', item.blobOid], { cwd: ROOT });
            assert.equal(sha(gitBytes), item.wholeSha256);
            assert.equal(history.promptTemplateSha256(gitBytes.toString('utf8')), item.templateSha256);

            assert.deepEqual(
                evidence.readDeclaredPromptEvidenceBytes(item.relativePath, item.wholeSha256),
                gitBytes
            );
            const stageMatch = evidence.declaredStagePromptTemplateEvidence(item.stage, item.templateSha256);
            assert.ok(stageMatch, `stage ${item.stage} pre-edit template SHA must resolve`);
            assert.equal(stageMatch.fileSha256, item.wholeSha256);
            assert.deepEqual(stageMatch.bytes, gitBytes);

            // Current working tree file must now differ from pre-edit bytes
            const currentBytes = fs.readFileSync(path.join(ROOT, item.relativePath));
            assert.notEqual(sha(currentBytes), item.wholeSha256, `${item.relativePath} should contain R2-W1 updates`);
        }
    });
});

describe('R2-W1: Prompt alignment & KV-cache layout invariants', () => {
    it('closes all blog:review contract gaps & prompt-vs-validator mismatches in api-reader-article.md', () => {
        const text = loadPrompt('prompts/current/api-reader-article.md', {
            title: 'T',
            arxivId: '2611.00001',
            mechanicalContract: 'M',
            sourceEvidence: 'E',
            validationFeedback: 'V',
            previousDraft: '无'
        });

        // (a) Sub-table vs full-table attribution
        assert.match(text, /原文完整 Table X（本精简表未列出）/);
        assert.match(text, /以横线表示\/加粗/);
        assert.match(text, /同组最优\/最高/);

        // (b) No blanket / cross-table superlatives
        assert.match(text, /各列最高\/全表最好\/均为最高\/每行在其目标上最好/);
        assert.match(text, /Table A.*Table B/);

        // (c) Pixel-over-prose & print discrepancy disclosure
        assert.match(text, /全面高于/);
        assert.match(text, /100%/);
        assert.match(text, /重复标签.*≠ 100%|占比总和 ≠ 100%/);

        // (d) Source-paper arithmetic sanity check
        assert.match(text, /原文如此报告，存在字面算术出入，原文未解释/);
        assert.match(text, /TP > predicted/);

        // (e) High-frequency banned bare English words + length floor + counted-unit formatting + verbatim schemaFingerprint
        for (const banned of [
            'grounding', 'grounded', 'rollout', 'alone', 'noisy', 'trade-off',
            'lookahead', 'pipeline', 'baseline', 'critic', 'scaling',
            'alignment', 'pending', 'backchannel', 'embodied'
        ]) {
            assert.ok(text.includes(banned), `api-reader-article.md should list banned word ${banned}`);
        }
        assert.match(text, /5,000–18,000 汉字/);
        assert.match(text, /4,000,000.*400 万/);
        assert.match(text, /schemaFingerprint.*逐字符原样复制.*64 位/);

        // (f) Self-inflicted negation trap removed & echoing reworded disclaimer passes reader-resource-claims.js
        assert.equal(text.includes('区分代码开源、权重可下载、系统可运行三件事'), false);
        assert.ok(text.includes('区分代码是否开源、权重是否提供下载、系统是否可直接运行三件事'));

        const sourceText = 'We evaluate our audio encoder on LibriSpeech without releasing artifacts.';
        const body = {
            ...readerIdentityFormat.header('resources'),
            sourceTextSha256: sha(Buffer.from(sourceText, 'utf8')),
            resources: []
        };
        const identity = { ...body, identitySha256: publicProbe.stableFingerprint(body) };
        const draft = {
            readerTitle: '声学编码分析',
            oneSentenceThesis: '本文分析编码器性能，复现时需核对资源状态。',
            sections: [{
                kind: 'limitation',
                heading: '复现边界',
                body: '复现前需区分代码是否开源、权重是否提供下载、系统是否可直接运行三件事，目前原文未披露相关链接。'
            }]
        };
        assert.deepEqual(readerResourceClaims.readerResourceClaimIssues(draft, identity, sourceText), []);
    });

    it('reorders api-reader-repair.md static JSON output schema above <repair_input> for KV prefix caching', () => {
        const rawTemplate = loadPrompt('prompts/current/api-reader-repair.md', {});
        const schemaIdx = rawTemplate.indexOf('"contract":"reader-node-patch"');
        const inputIdx = rawTemplate.indexOf('<repair_input>');
        const closeInputIdx = rawTemplate.indexOf('</repair_input>');
        const protoIdx = rawTemplate.indexOf('{operationProtocol}');
        assert.ok(schemaIdx > 0 && inputIdx > schemaIdx, 'JSON schema must precede <repair_input>');
        assert.ok(closeInputIdx > inputIdx && protoIdx > closeInputIdx, '{operationProtocol} stays after </repair_input>');

        // Verify static prefix exceeds 2,800 chars (>= 90% of template) and renders cleanly with zero warnings
        const firstDyn = rawTemplate.indexOf('{title}');
        assert.ok(firstDyn >= 2800, `Expected static prefix >= 2800 chars, got ${firstDyn}`);
        assert.ok(firstDyn / rawTemplate.length >= 0.90, `Expected static prefix ratio >= 90%, got ${(firstDyn / rawTemplate.length * 100).toFixed(1)}%`);

        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            const rendered = loadPrompt('prompts/current/api-reader-repair.md', {
                title: 'T',
                arxivId: '2611.00001',
                mechanicalContract: 'M',
                sourceEvidence: 'E',
                repairTargets: 'R',
                validationFeedback: 'F',
                operationProtocol: '无'
            });
            assert.equal(rendered.includes('{operationProtocol}'), false);
        } finally {
            console.warn = origWarn;
        }
        assert.deepEqual(warnings, []);
    });

    it('aligns deep-analysis.md, gap-fill.md, core-summary-repair.md, structure-repair.md, and image-supplement.md', () => {
        const deepPrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/deep-analysis.md'), 'utf8');
        assert.match(deepPrompt, /严禁自算差值.*增删末尾零/);
        assert.match(deepPrompt, /严禁给原文裸数值硬加 `%`/);
        assert.match(deepPrompt, /原文如此报告，存在字面算术出入，原文未解释/);
        assert.match(deepPrompt, /第一列表头必须明确包含标准识别词（如“方法\/模型\/系统\/数据集\/设置\/配置\/条件\/任务”）/);
        assert.match(deepPrompt, /消融对照行与负结果\/退化行/);

        const gapPrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/gap-fill.md'), 'utf8');
        assert.ok(gapPrompt.includes('{tagPromptText}'), 'gap-fill.md must retain {tagPromptText}');
        assert.match(gapPrompt, /不自算差值、不增删末尾零、不给原文裸数值硬加 `%`/);
        assert.match(gapPrompt, /原文如此报告，存在字面算术出入，原文未解释/);

        const coreRepair = fs.readFileSync(path.join(ROOT, 'prompts/current/core-summary-repair.md'), 'utf8');
        const coreInput = coreRepair.slice(coreRepair.indexOf('<paper_input>'));
        assert.ok(coreInput.indexOf('{textForAnalysis}') < coreInput.indexOf('{existingSummary}'));
        assert.ok(coreInput.indexOf('{existingSummary}') < coreInput.indexOf('{summaryIssue}'));

        const structRepair = fs.readFileSync(path.join(ROOT, 'prompts/current/structure-repair.md'), 'utf8');
        const structInput = structRepair.slice(structRepair.indexOf('<paper_input>'));
        assert.ok(structInput.indexOf('{textForAnalysis}') < structInput.indexOf('{missingSections}'));
        assert.ok(structInput.indexOf('{missingSections}') < structInput.indexOf('{validationFeedback}'));
        assert.ok(structInput.indexOf('{validationFeedback}') < structInput.indexOf('{existingAnalysis}'));

        const imgPrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/image-supplement.md'), 'utf8');
        assert.equal(imgPrompt.includes('毒舌点评'), false, 'retired 毒舌点评 must be removed');
        assert.ok(imgPrompt.includes('客观指出局限与证据缺口'));
    });
});

describe('R2-W1: table-fill.md {tableIssue} plumbing, tightened hasOmissionMarkers, and buildReaderRequestMessages', () => {
    const internals = loadDeepInternals();

    it('reorders table-fill.md for KV caching and renders {tableIssue} cleanly with empty fallback', () => {
        const raw = loadPrompt('prompts/current/table-fill.md', {});
        const input = raw.slice(raw.indexOf('<paper_input>'));
        assert.ok(input.indexOf('{textForAnalysis}') < input.indexOf('{resultsSection}'));
        assert.ok(input.indexOf('{resultsSection}') < input.indexOf('{tableIssue}'));
        assert.match(raw, /方法\/模型\/系统\/数据集\/设置\/配置\/条件\/任务/);

        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            const rendered = loadPrompt('prompts/current/table-fill.md', {
                title: 'T',
                arxivId: '2611.00001',
                textForAnalysis: 'SRC',
                resultsSection: 'RES',
                tableIssue: ''
            });
            assert.equal(rendered.includes('{tableIssue}'), false);
        } finally {
            console.warn = origWarn;
        }
        assert.deepEqual(warnings, []);
    });

    it('tightens hasOmissionMarkers: ignores normal citations when table exists and non-table prose 省略, catches real table omissions', () => {
        const tableMd = '| 方法 | WER ↓ |\n| --- | ---: |\n| 基线 | 5.6 |\n| 本文 | 4.8 |';

        // Normal citations WITH an existing Markdown table -> NOT omission
        assert.equal(internals.hasOmissionMarkers(`主方法优于基线（见表 1）。\n\n${tableMd}`), false);
        assert.equal(internals.hasOmissionMarkers(`主方法优于基线(见表 2)。\n\n${tableMd}`), false);
        assert.equal(internals.hasOmissionMarkers(`具体数值详见表 1。\n\n${tableMd}`), false);

        // Normal citations WITHOUT a Markdown table -> STILL omission
        assert.equal(internals.hasOmissionMarkers('主方法优于基线（见表 1）。'), true);
        assert.equal(internals.hasOmissionMarkers('主方法优于基线(见表 1)。'), true);
        assert.equal(internals.hasOmissionMarkers('具体数值详见表 1。'), true);

        // Non-table prose 省略 -> NOT omission (with or without table)
        assert.equal(internals.hasOmissionMarkers('推理阶段省略该步骤后速度提升 1.3 倍。'), false);
        assert.equal(internals.hasOmissionMarkers('文本截断处以省略号表示。'), false);
        assert.equal(internals.hasOmissionMarkers(`模型不省略帧间依赖且未省略任何消融数据。\n\n${tableMd}`), false);

        // Real table-omission markers -> STILL caught even when a Markdown table is present
        for (const marker of ['此处省略', '其余省略', '部分省略', '见原文表', '详见原文表', '表格详见原文', '其余数据已省略', '省略其余行']) {
            assert.equal(internals.hasOmissionMarkers(`${tableMd}\n\n${marker}。`), true, `Must catch ${marker}`);
        }
    });

    it('plumbs exact depthIssue into checkAndFixTables prompt {tableIssue} and skips clean tables with normal citations', async () => {
        const makeAnalysis = resultsBody => [
            '## 评分', '7.5/10',
            '## 机器摘要', 'document_type: 方法研究',
            '## 实验结果', resultsBody,
            '## 细节详述', '细节说明。'
        ].join('\n\n');

        // 1. Clean table + normal citation (见表 1) + non-table prose 省略该步骤 -> NO repair needed
        const cleanAnalysis = makeAnalysis([
            '本节比较主方法与强基线在相同测试集上的 WER 差异（见表 1），同时分析省略该步骤后的退化表现。',
            '| 方法 | WER ↓ |\n| --- | ---: |\n| 强基线 | 5.6 |\n| 本文方法 | 5.1 |\n| 移除门控（消融） | 5.4 |',
            '相比强基线，本文方法将 WER 降低 0.5；移除门控后性能出现退化，说明门控模块具有明确贡献，但该结论仅限于当前近场语音测试集。'
        ].join('\n\n'));
        assert.equal(internals.getExperimentTableRepairIssue(cleanAnalysis, 'Table 1 ablation baseline degrades on noisy subset.'), null);
        assert.equal(deep.analysisNeedsExperimentTableRepair(cleanAnalysis, 'Table 1 ablation baseline degrades on noisy subset.'), false);

        let called = false;
        const untouched = await internals.checkAndFixTables(
            { arxivId: '2611.00010', title: 'Clean Table Paper' },
            cleanAnalysis,
            'Table 1 ablation baseline degrades on noisy subset.',
            'SRC',
            { callModelFn: async () => { called = true; return ''; } }
        );
        assert.equal(called, false);
        assert.equal(untouched, cleanAnalysis);

        // 2. Table missing standard column-1 identifier noun -> exact depthIssue plumbed into {tableIssue}!
        const badHeaderAnalysis = makeAnalysis([
            '本节比较不同候选方案在相同公开测试集上的 WER 指标表现与基线差异。',
            '| 代号 | WER ↓ |\n| --- | ---: |\n| A | 5.6 |\n| B | 5.1 |\n| C | 5.4 |',
            '相比基线方案 A，本文方案 B 降低 0.5，但在远场噪声子集上出现性能退化，因此结论仅限于当前测试集。'
        ].join('\n\n'));
        const issue = internals.getExperimentTableRepairIssue(badHeaderAnalysis, 'Table 1 baseline WER comparison.');
        assert.ok(issue && issue.includes('缺少方法、数据集或设置识别列'), `Unexpected issue: ${issue}`);
        assert.equal(deep.analysisNeedsExperimentTableRepair(badHeaderAnalysis, 'Table 1 baseline WER comparison.'), true);

        let capturedPrompt = '';
        const fixed = await internals.checkAndFixTables(
            { arxivId: '2611.00011', title: 'Bad Header Paper' },
            badHeaderAnalysis,
            'Table 1 baseline WER comparison.',
            'SOURCE_EVIDENCE_BLOCK',
            {
                callModelFn: async messages => {
                    capturedPrompt = messages[0].content;
                    return [
                        '## 实验结果',
                        '',
                        '本节比较本文方法与强基线在相同公开测试集上的 WER 差异。',
                        '',
                        '| 方法 | WER ↓ |',
                        '| --- | ---: |',
                        '| 强基线 | 5.6 |',
                        '| 本文方法 | 5.1 |',
                        '| 简化变体 | 5.4 |',
                        '',
                        '相比强基线，本文方法降低 0.5，但简化变体出现性能退化，该结论仅限于当前测试集。'
                    ].join('\n');
                }
            }
        );
        assert.ok(capturedPrompt.includes(issue), 'checkAndFixTables must pass depthIssue into {tableIssue}');
        assert.equal(capturedPrompt.includes('{tableIssue}'), false, 'no unresolved {tableIssue} allowed');
        assert.ok(
            capturedPrompt.indexOf('SOURCE_EVIDENCE_BLOCK') < capturedPrompt.indexOf(issue),
            'KV-cache ordering: source evidence must appear before dynamic tableIssue'
        );
        assert.ok(fixed.includes('| 方法 | WER ↓ |'));
    });

    it('expands buildReaderRequestMessages splitMarkers to place images after stable evidence in repair templates', () => {
        const fakeImages = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];

        for (const marker of [
            '\n代码校验反馈：',
            '\n上一版完整 JSON 草稿',
            '\n允许修改的内容与当前草稿SHA：',
            '\n当前授权目标（只允许修改此处列出的 targetOrdinal，并严格匹配各目标 valueType）：',
            '\n当前授权目标：',
            '\n核验反馈（逐项消除下列问题）：',
            '\n核验反馈：',
            '\n当前检查和修法：'
        ]) {
            const prompt = `静态指令与稳定论文证据${marker}\n动态变化内容`;
            const messages = internals.buildReaderRequestMessages(prompt, '可见性说明', fakeImages);
            assert.equal(messages.length, 1);
            const parts = messages[0].content;
            assert.equal(parts.length, 4, `marker ${JSON.stringify(marker)} must split into 4 content blocks`);
            assert.equal(parts[0].text, '静态指令与稳定论文证据');
            assert.equal(parts[1].text, '可见性说明');
            assert.deepEqual(parts[2], fakeImages[0]);
            assert.equal(parts[3].text, `${marker}\n动态变化内容`);
        }

        // Real api-reader-repair.md rendered prompt places images right after {sourceEvidence}, before volatile targets & feedback
        const repairPrompt = loadPrompt('prompts/current/api-reader-repair.md', {
            title: 'Test Paper',
            arxivId: '2611.00012',
            mechanicalContract: 'CONTRACT',
            sourceEvidence: 'STABLE_SOURCE_EVIDENCE',
            repairTargets: 'VOLATILE_TARGETS',
            validationFeedback: 'VOLATILE_FEEDBACK',
            operationProtocol: '无'
        });
        const repairMsgs = internals.buildReaderRequestMessages(repairPrompt, 'IMG_NOTICE', fakeImages);
        assert.equal(repairMsgs[0].content.length, 4);
        assert.ok(repairMsgs[0].content[0].text.includes('STABLE_SOURCE_EVIDENCE'));
        assert.equal(repairMsgs[0].content[0].text.includes('VOLATILE_TARGETS'), false);
        assert.equal(repairMsgs[0].content[0].text.includes('VOLATILE_FEEDBACK'), false);
        assert.deepEqual(repairMsgs[0].content[2], fakeImages[0]);
        assert.ok(repairMsgs[0].content[3].text.includes('VOLATILE_TARGETS'));
        assert.ok(repairMsgs[0].content[3].text.includes('VOLATILE_FEEDBACK'));

        // Zero images keeps single combined prompt text block (no spurious split)
        const zeroImgMsgs = internals.buildReaderRequestMessages(repairPrompt, 'NO_IMG', []);
        assert.equal(zeroImgMsgs[0].content.length, 2);
        assert.equal(zeroImgMsgs[0].content[0].text, repairPrompt);
    });
});

describe('R2-Fix-1: P0 #3 tableContextText plumbing & P1 #4 editorial-quality bare-table precision guards', () => {
    const editorial = require('../scripts/editorial-quality.js');
    const readerFormat = require('../scripts/lib/reader-record-format.js');
    const codec = require('../scripts/lib/protocol-codec.js');
    const STRUCTURED = readerFormat.STRUCTURED_EDITORIAL;

    const instructTtsTable = [
        '| System | IF ↑ | CER ↓ | DNSMOS ↑ | Avg ↑ |',
        '| --- | --- | --- | --- | --- |',
        '| Teacher: IF | 82.1 | 2.53 | 2.98 | 0.70 |',
        '| Teacher: WER | 71.0 | 1.94 | 3.25 | 0.70 |',
        '| InstructTTS-OPD | 81.1 | 2.25 | 3.28 | 0.82 |'
    ].join('\n');

    it('(a) completeTable omitted by omitReaderSelectedTablesForProseCheck preserves bare-table context via tableContextText (InstructTTS-OPD end-to-end)', () => {
        const resultHeading = '单目标教师与多目标融合的对比实验';
        const proseAfterTable = '融合中完整 OPD 取 IF 81.1，低于 IF 教师的 82.1，CER 取 2.25，高于 WER 教师的 1.94，DNSMOS 取 3.28，Avg 取 0.82 为全表最高。';
        const fullArticle = [
            `### ${resultHeading}`,
            '',
            '下表在统一语音合成评测集上对照单目标教师与融合模型的四项客观指标，比较各方在指令遵循与可懂度之间的平衡。',
            '',
            instructTtsTable,
            '',
            proseAfterTable
        ].join('\n');
        const sections = [{ kind: 'result', heading: resultHeading, body: '' }];

        const omittedView = deep.omitReaderSelectedTablesForProseCheck(fullArticle, [1]);
        assert.equal(omittedView.includes('| Teacher: IF |'), false, 'selected table must be omitted from prose view');

        // Without tableContextText, omitted table blinds the checker (reproduces the pre-fix Catch-22).
        const blindQuality = deep.validateReaderEditorialQuality(omittedView, sections, {
            editorialProfile: STRUCTURED,
            skipTableCommentaryAlignment: true
        });
        assert.ok(
            blindQuality.issues.some(item => item.code === 'comparison_unit_missing'),
            'without tableContextText, omitted table should trigger comparison_unit_missing'
        );

        // With tableContextText: fullArticle, validateReaderEditorialQuality passes cleanly.
        const contextQuality = deep.validateReaderEditorialQuality(omittedView, sections, {
            editorialProfile: STRUCTURED,
            skipTableCommentaryAlignment: true,
            tableContextText: fullArticle
        });
        assert.deepEqual(
            contextQuality.issues.filter(item => item.code === 'comparison_unit_missing'),
            []
        );

        // Full end-to-end parseApiReaderArticleResult with a real completeTable binding.
        const matrix = [
            ['System', 'IF ↑', 'CER ↓', 'DNSMOS ↑', 'Avg ↑'],
            ['Teacher: IF', '82.1', '2.53', '2.98', '0.70'],
            ['Teacher: WER', '71.0', '1.94', '3.25', '0.70'],
            ['InstructTTS-OPD', '81.1', '2.25', '3.28', '0.82']
        ];
        const tableArtifact = {
            ordinal: 1,
            caption: 'Table 1: Main comparison between single-objective teachers and InstructTTS-OPD.',
            matrix,
            headerRows: [0],
            cells: matrix.flatMap((row, r) => row.map((text, c) => ({
                row: r,
                column: c,
                text,
                rowspan: 1,
                colspan: 1,
                header: r === 0,
                sourceDomSha256: sha(`opd-t1-${r}-${c}-${text}`)
            }))),
            recoveryStatus: 'complete',
            sourceDomSha256: sha('opd-table-1-dom')
        };
        const sourceText = 'Table 1 compares Teacher: IF (82.1, 2.53, 2.98, 0.70), Teacher: WER (71.0, 1.94, 3.25, 0.70), and InstructTTS-OPD (81.1, 2.25, 3.28, 0.82).';
        const artifacts = {
            parserVersion: 'structured-html-tables-v1',
            tables: [tableArtifact],
            formulas: [],
            figures: [],
            flattenedTextSha256: sha(sourceText)
        };
        artifacts.payloadSha256 = publicProbe.stableFingerprint(artifacts);

        const makeParagraphs = (prefix, topics) => topics.map((topic, idx) => (
            `#### ${prefix}要点${['一', '二', '三', '四'][idx]}\n\n`
            + `${prefix}围绕${topic}展开细致拆解，研究团队在公开语音合成评测流程里固定采样率、梅尔频谱窗长与声码器参数，避免无关工程改动干扰对比结论。`
            + `具体到${topic}所对应的声学表征环节，作者记录了韵律停顿、情感起伏、基频包络与音素边界对齐在长短句上的联动变化，`
            + `并指出单目标偏好微调往往只放大某一条奖励信号而挤压其余维度，因此在多属性控制任务里极易出现顾此失彼的现象。`
            + `结合${prefix}对${topic}的逐层复核，读者可以分辨出收益究竟来自策略采样本身的分布贴合，还是来自多教师协同监督带来的梯度平衡，`
            + `也能据此判断该设计在换用不同说话人音色或复杂文本指令时可能遇到的声学退化风险与适用边界。`
        )).join('\n\n');

        const draft = {
            ...codec.recordHeader(codec.contract('reader-draft'), 'reader-draft'),
            readerTitle: '多目标在策略蒸馏化解语音合成指令与清晰度冲突',
            oneSentenceThesis: '本文通过多教师在策略蒸馏协同优化语音合成的指令遵循、清晰度与听感质量，在统一评测表中取得最高综合均值。',
            conceptBridges: [],
            figurePlacements: [],
            tableBindings: [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }],
            formulaBindings: [],
            implementationSpecs: {
                trainingData: '采用公开中英文指令语音合成语料并按说话人划分验证集。',
                computeHardware: '原文未披露具体训练卡型号与总卡时开销。',
                keyHyperparams: '固定声码器与梅尔频谱帧移，按策略蒸馏损失联合更新声学解码器。',
                inferenceCost: '推理阶段只运行单个融合学生模型，无需同时加载多位教师。',
                openSourceArtifacts: '原文未提供公开代码仓库或模型权重下载地址。',
                appendixHighlights: '附录补充单目标教师与消融变体的定性样例与错误归因分析。'
            },
            sections: [
                {
                    kind: 'problem',
                    heading: '语音合成中指令遵循与清晰度的目标拉扯',
                    body: makeParagraphs('问题拆解', ['多属性指令冲突', '单一偏好微调退化', '韵律表现与发音准确失衡', '离线蒸馏分布偏移'])
                },
                {
                    kind: 'method_overview',
                    heading: '面向多目标权衡的在策略教师蒸馏框架',
                    body: makeParagraphs('整体设计', ['学生自采样轨迹构建', '双教师并行打分机制', '梯度方向投影协调', '动态权重退火策略'])
                },
                {
                    kind: 'component',
                    heading: '冲突梯度投影与声学稳定性约束细节',
                    body: makeParagraphs('机制剖析', ['指令教师奖励信号提取', '清晰度教师逐帧监督对齐', '语音自然度判别滤波', '训练步长与平滑更新控制'])
                },
                {
                    kind: 'result',
                    heading: resultHeading,
                    body: [
                        '#### 综合对比表与数值解读',
                        '',
                        '下表在统一语音合成评测集上对照两位单目标教师与完整融合学生模型的四项核心客观指标，检验多目标蒸馏能否在不明显牺牲清晰度的前提下兼顾指令遵循与自然度。',
                        '',
                        '[[TABLE_1]]',
                        '',
                        `${proseAfterTable} 这组结果表明单一目标教师各自存在明显短板，指令教师清晰度偏弱而识别教师指令遵循偏低，融合模型在三类指标之间取得了更均衡的综合表现，并未依赖单维度极端刷分。`,
                        '',
                        makeParagraphs('结果分析', ['单目标教师短板归因', '融合策略综合收益边界'])
                    ].join('\n\n')
                },
                {
                    kind: 'limitation',
                    heading: '评测范围与多语言泛化上的未决问题',
                    body: makeParagraphs('边界审视', ['跨语种复杂指令覆盖局限', '噪声录音场景鲁棒性缺失', '多教师同步训练显存压力', '主观盲听评测规模约束'])
                }
            ]
        };

        const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), {
            arxivId: '2611.99911',
            availableFigureOrdinals: [],
            requireIntegratedTables: true,
            minimumIntegratedTables: 1,
            requiredProfile: readerFormat.INTEGRATED,
            compileCurrent: true,
            requireSourceBindings: true,
            requireImplementationSpecs: true,
            structuredArtifacts: artifacts,
            sourceText
        });
        assert.ok(parsed.article.includes('| InstructTTS-OPD | 81.1 | 2.25 | 3.28 | 0.82 |'));
        assert.equal(parsed.qualityMetrics.blockingIssueCount, 0);
    });

    it('(b) lowercase English "if" in table header "| Cost if enabled |" NEVER exempts WER bare numbers', () => {
        const tableWithLowerIf = [
            '### 开销与识别误差',
            '',
            '| Config | Cost if enabled |',
            '| --- | --- |',
            '| Baseline | 12.4 |',
            '| Ours | 8.3 |',
            '',
            '在公开测试集上，本文方法将 WER 从 12.4 降至 8.3。'
        ].join('\n');
        assert.equal(
            editorial.findMissingComparisonUnits(tableWithLowerIf, { editorialProfile: STRUCTURED }).length,
            1
        );

        const withExplicitConditionPct = [
            '### 开销与识别误差',
            '',
            '| Config | Cost if enabled |',
            '| --- | --- |',
            '| Baseline | 12.4 |',
            '| Ours | 8.3 |',
            '',
            '在 100% 干净语音条件下，本文方法将 WER 从 12.4 降至 8.3。'
        ].join('\n');
        assert.equal(
            editorial.findMissingComparisonUnits(withExplicitConditionPct, { editorialProfile: STRUCTURED }).length,
            1
        );
    });

    it('(c) Table 1 bare IF NEVER exempts Table 2 %-suffixed WER (even with identical numbers, same or different H3 sections)', () => {
        const sameSectionCollidingValues = [
            '### 主实验结果',
            '',
            '| System | IF ↑ |',
            '| --- | --- |',
            '| Baseline | 12.4 |',
            '| Ours | 8.3 |',
            '',
            '| System | WER ↓ |',
            '| --- | --- |',
            '| Baseline | 12.4% |',
            '| Ours | 8.3% |',
            '',
            '本文方法将 WER 从 12.4 降至 8.3。'
        ].join('\n');
        assert.equal(
            editorial.findMissingComparisonUnits(sameSectionCollidingValues, { editorialProfile: STRUCTURED }).length,
            1
        );

        const crossSectionLeak = [
            '### 主实验结果',
            '',
            instructTtsTable,
            '',
            '融合中完整 OPD 取 IF 81.1，低于 IF 教师的 82.1，CER 取 2.25，高于 WER 教师的 1.94。',
            '',
            '### 消融分析',
            '',
            '| Variant | WER ↓ |',
            '| --- | --- |',
            '| Base | 2.53% |',
            '| Full | 2.25% |',
            '',
            '消融实验显示，CER 从 2.53 降至 2.25，且 WER 从 2.53 降至 2.25。'
        ].join('\n');
        const crossFindings = editorial.findMissingComparisonUnits(crossSectionLeak, { editorialProfile: STRUCTURED });
        assert.equal(crossFindings.length, 1, 'Section 1 bare CER/IF table must NOT exempt Section 2');
        assert.match(crossFindings[0].match, /消融实验显示/);
    });

    it('(d) "WER（%）与准确率评估" NEVER exempts %-suffixed tables, unrelated metrics in same sentence/section, or another H3 section', () => {
        // (d1) Unrelated metric (准确率) in same section must STILL be caught.
        const unrelatedSameSection = [
            '### 实验设置与主结果',
            '',
            '本节采用 WER（%）与准确率评估各模型表现。',
            '',
            '相比基线，本文方法将准确率从 80 提高到 90。'
        ].join('\n');
        assert.equal(
            editorial.findMissingComparisonUnits(unrelatedSameSection, { editorialProfile: STRUCTURED }).length,
            1
        );

        // (d2) Unrelated metric (准确率) in the VERY SAME sentence as WER（%） must STILL be caught.
        const unrelatedSameSentence = '在 WER（%）与准确率评估中，本文方法将准确率从 80 提高到 90。';
        assert.equal(
            editorial.findMissingComparisonUnits(unrelatedSameSentence, { editorialProfile: STRUCTURED }).length,
            1
        );

        // (d3) Plain "WER（%）" mention NEVER overrides a section whose WER table uses %-suffixed cells.
        const percentTableOverrideAttempt = [
            '### 主实验结果',
            '',
            '本节采用 WER（%）与准确率评估各系统。',
            '',
            '| Model | WER ↓ |',
            '| --- | --- |',
            '| Baseline | 12.4% |',
            '| Ours | 8.3% |',
            '',
            '相比基线，本文方法将 WER 从 12.4 降至 8.3。'
        ].join('\n');
        assert.equal(
            editorial.findMissingComparisonUnits(percentTableOverrideAttempt, { editorialProfile: STRUCTURED }).length,
            1
        );

        // (d4) "WER（%）" in Section 1 NEVER exempts bare WER in Section 2.
        const crossSectionDecl = [
            '### 主实验结果',
            '',
            '本节采用 WER（%）与准确率评估各系统。',
            '',
            '### 消融分析',
            '',
            '移除门控后，WER 从 8.3 升至 12.4。'
        ].join('\n');
        const crossDeclFindings = editorial.findMissingComparisonUnits(crossSectionDecl, { editorialProfile: STRUCTURED });
        assert.equal(crossDeclFindings.length, 1);
        assert.match(crossDeclFindings[0].match, /移除门控后/);
    });
});

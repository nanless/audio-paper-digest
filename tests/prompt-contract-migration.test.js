'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const registry = require('../scripts/lib/prompt-contracts');
const legacy = require('../scripts/lib/prompt-legacy-codec');
const evidence = require('../scripts/lib/prompt-evidence');
const history = require('../scripts/lib/prompt-history');
const root = path.resolve(__dirname, '..');
const baseline = '05ab504df7f84da3b8d961878323cfa161f23eb0';
const git = (...args) => execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', ...args], { cwd: root });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('current templates preserve original text apart from the declared changes; all original Git identities remain exact', () => {
    assert.equal(registry.CURRENT_PROMPT_FILES.length, 16);
    for (const current of registry.CURRENT_PROMPT_FILES) {
        assert.match(current, /^prompts\/current\/[a-z-]+\.md$/);
        const original = legacy.currentPathPredecessors[current];
        assert.ok(original);
        const actual = evidence.readPromptEvidenceBytes(current);
        const originalBytes = git('show', `${baseline}:${original}`);
        if (current === 'prompts/current/api-reader-article.md') {
            const header = require('../scripts/lib/protocol-codec').record('reader-draft');
            const expected = originalBytes.toString().replace('"version": 3,',
                '"contract": "' + header.contract + '",\n  "schemaFingerprint": "' + header.schemaFingerprint + '",')
                .replace('（`reader-complete-table-declaration-v1`）', '')
                .replace('原文没说明的梯度路径不要猜。',
                    '原文没说明的梯度路径不要猜。凡是写「原文没有报告/未说明」的地方，同一段里必须补上这个缺口影响哪一步、'
                    + '读者可以用什么替代做法绕过（例如改用相邻表中已报告的量、按已披露的超参数自行补做、或先验证哪一个前提）；'
                    + '只写「没有报告」，读者就会恰好停在最需要继续的地方。')
                .replace('介绍组合机制时，紧接着说清每个术语各指什么、怎么分工、为什么搭配、组合后多了什么作用。',
                    '介绍组合机制时，紧接着说清每个术语各指什么、怎么分工、为什么搭配、组合后多了什么作用。'
                    + '相邻段落刚刚解释过的术语，组合说明只用一句话接住它在这个组合里的额外作用，不要把同一层定义再写一遍。')
                .replace('比较先说明双方为何可以放在一起：',
                    '同一个结果数值只在一个小节里给出，其余小节讲条件、机制或行动；结论边界只写结论在什么数据、'
                    + '标注和部署条件下成立，何时值得尝试只写行动顺序，两处都不要把结果数字再念一遍。同一篇里同一个指标数值'
                    + '出现在超过五个小节，读者会直接跳过后面几节。\n\n比较先说明双方为何可以放在一起：')
                .replace('段落数不固定，也不用逐行复述。',
                    '段落数不固定，也不用逐行复述。不要用「表中可见」「由表可知」这类套话开头，也不要按行把单元格数字再念一遍；'
                    + '表后只说这张表支撑了哪个判断、在什么条件下不成立、以及读者应当拿它和哪一组结果对照。')
                .replace('最多 4 张，也可以一张都不选。',
                    '最多 4 张。本次确实收到像素、又存在可装配的原图时至少要声明一张；'
                    + '只有完全没有可装配原图时才允许 `figurePlacements` 为空，空数组会被代码直接拒绝。')
                .replace('`figurePlacements` 可以为空，最多 4 项。',
                    '`figurePlacements` 最多 4 项；收到像素且存在可装配原图时不能为空。')
                .replace('先看图例，确认对象、条件和时间范围，分清分布曲线和单样本标记；颜色一样不代表对象一样。',
                    '先看图例，确认对象、条件和时间范围，分清分布曲线和单样本标记；颜色一样不代表对象一样，'
                    + '不要把代表测试条件的图例颜色同方法行名混为一谈。描述柱体实心或斜纹填充（如 p <= 0.05 实心与 p > 0.05 斜纹）'
                    + '以及子图横纵轴、行与列对应关系时，使用“全部”“所有”“只有”“唯一”等排他量词前必须逐组核对无例外。')
                .replace('把有连续原句支持的时长比较放正文；无证据的SD或数值不能进入表格。',
                    '把有连续原句支持的时长比较放正文；无证据的SD或数值不能进入表格。构造 source_quotes 表时，'
                    + '列头若写单位符号（如 %、s、GiB），对应来源行须有逐字单位证据；若原表或原句只写裸数字而未逐行重复单位，'
                    + '应绑定原表（selection、completeTable 或 artifact_table），或在 source_quotes 列头不加括号单位符号而在表前说明交代量纲，'
                    + '并保持代码要求的最低表数（可用原表不少于 4 张时至少 4 张），同时确保每张表紧邻的表后解释只对应本表行列与数值。')
                .replace('`sections` 必须包含 12–18 个小节，起草时建议安排 14–16 节。输出 JSON 前实际数一次数组项数；'
                    + '少于 12 节或超过 18 节都不能输出。',
                    '`sections` 的节数以本次代码要求为准（见 `{mechanicalContract}`）。先看这篇论文实际有哪些阶段值得展开：'
                    + '只有一个方法、一组结果、没有训练过程的论文，就不要为了凑节数把同一个组件拆成两节，也不要为每张表单独开一节。')
                .replace('必须覆盖 `background`、`related_work`、`method_overview`、`training`、`experiment_setup`、'
                    + '`result`、`limitation`、`reproduction` 和 `synthesis`。`training` 不代表一定有神经网络训练。'
                    + '没有训练时，在该节明确说明，并讲清 PCA/SVD、优化器、规则、检索、仿真或已有模型推理的实际计算过程。',
                    '必须覆盖 `problem`、`method_overview`、`result`、`limitation` 和 `synthesis` 五个阶段。'
                    + '其余阶段按论文证据取舍：`background` 只在读者确实缺少必要背景时写，`related_work` 只在原文有实质对比时写，'
                    + '`training` 只在有训练或构造过程时写（没有训练就不开这一节，不要用一节来说明「本文没有训练」），'
                    + '`experiment_setup` 与 `reproduction` 只在原文交代了协议或复现信息时写，`ablation` 只在有消融或负结果时写。'
                    + '开了某一节就要讲满，不要留 200 字的空壳小节。`training` 不代表一定有神经网络训练，有 PCA/SVD、优化器、'
                    + '规则、检索、仿真或已有模型推理的实际计算过程。');
            assert.notEqual(expected, originalBytes.toString());
            assert.equal(actual.toString(), expected);
        } else if (['prompts/current/api-reader-fact-local.md', 'prompts/current/api-reader-concept-terms.md'].includes(current)) {
            const fact = current.endsWith('/api-reader-fact-local.md');
            const header = require('../scripts/lib/protocol-codec').record(fact ? 'reader-fact-sentence-patch' : 'reader-concept-term-patch');
            const expected = originalBytes.toString().replace('{"version":1,"draftSha256"',
                JSON.stringify(header).slice(0, -1) + ',"draftSha256"')
                .replace('# Reader 已核验事实原句修订 v3', '# 已核验事实的原句修订');
            assert.notEqual(expected, originalBytes.toString());
            assert.equal(actual.toString(), expected);
        } else if (current === 'prompts/current/api-reader-repair.md') {
            const header = require('../scripts/lib/protocol-codec').record('reader-node-patch');
            const expected = originalBytes.toString()
                .replace('只在已授权正文及绑定节点内按同一原表或完整连续结果句恢复语义行列，缺证据时保留失败，不补造对应关系。',
                    '只在已授权正文及绑定节点内按同一原表或完整连续结果句恢复语义行列，缺证据时保留失败，不补造对应关系。'
                    + '构造或修订 source_quotes 表时，列头单位（如 %、s、GiB）须在对应来源行有逐字单位证据；'
                    + '原文只写裸数字而未逐行重复单位时优先绑定原表，或不在 source_quotes 列头加括号单位符号，'
                    + '同时守住最低表数要求（可用原表不少于 4 张时至少保留 4 张表），并确保每张表紧邻的表后评述只对应本表行列与数值。'
                    + '描述图例颜色、柱体实心或斜纹填充（如 p <= 0.05 实心与 p > 0.05 斜纹）及子图行列轴向时，'
                    + '使用“全部”“所有”“只有”“唯一”前须逐组核对无例外，不把条件图例颜色同方法行名混为一谈。')
                .replace('{"version":1,"draftSha256"',
                    JSON.stringify(header).slice(0, -1) + ',"draftSha256"');
            assert.notEqual(expected, originalBytes.toString());
            assert.equal(actual.toString(), expected);
        } else if (current === 'prompts/current/primary-fact-local-repair.md') {
            const expected = originalBytes.toString().replace('主文局部事实纠错 v1', '主文局部事实纠错')
                .replace('"contract":"primary-local-fact-repair-v1"',
                    '"contract":"primary-local-fact-repair","schemaFingerprint":"{schemaFingerprint}"');
            assert.equal(actual.toString(), expected);
        } else if (current === 'prompts/current/structure-repair.md') {
            assert.equal(actual.toString(), originalBytes.toString()
                .replace('实验表格不符合 `evidence-rich-v2` 的数量、行列和解释要求', '实验表格不符合数量、行列和解释要求')
                .replace('核心摘要用 6–9 句完整中文句子', '核心摘要用 6–12 句完整中文句子'));
        } else if (current === 'prompts/current/deep-analysis.md') {
            assert.equal(actual.toString(), originalBytes.toString()
                .replace('正文写 6–9 句', '正文写 6–12 句'));
        } else if (current === 'prompts/current/scoring-audit.md') {
            const header = require('../scripts/lib/scoring-record-format').currentEvidenceProfileHeader();
            assert.equal(actual.toString(), originalBytes.toString().replace('    "version": 1,',
                `    "contract": "${header.contract}",\n    "schemaFingerprint": "${header.schemaFingerprint}",`));
        } else if (current === 'prompts/current/core-summary-repair.md') {
            // 2026-11-09：方法链要求写成可执行顺序词与产物交接（2611.06345 真实失败）。
            assert.equal(actual.toString(), originalBytes.toString().replace(
                '方法说明包含 2–4 个步骤，写清各步的职责，以及前一步的输出怎样进入下一步。',
                '方法说明包含 2–4 个步骤，用“先”“再”“最后”这类顺序词把步骤串起来，写清各步的职责，'
                + '以及前一步的输出怎样进入下一步：用“提取”“输出”“送入”这类词写出产物的具体名称，'
                + '并说明它被哪一步接收、用来做什么。')
                // 2026-11-14：用户要求调整判定口径，句数上限 6–9 → 6–12（deepseek
                // 开 max 后稳定落在 10–12 句，字数与定量比较要求不变）。
                .replace('摘要正文写 6–9 句', '摘要正文写 6–12 句'));
        } else assert.deepEqual(actual, originalBytes, current);
        assert.deepEqual(evidence.readPromptEvidenceBytes(original, { expectedSha256: sha(originalBytes) }), originalBytes);
        assert.equal(fs.existsSync(path.join(root, original)), false);
        assert.throws(() => evidence.readPromptEvidenceBytes(original, { expectedSha256: 'f'.repeat(64) }));
    }
    for (const stage of ['visualSummary', 'digestCover']) {
        const original = legacy.originalCurrent[stage];
        const bytes = git('show', `${baseline}:${original.path}`);
        assert.deepEqual(evidence.readPromptEvidenceBytes(original.path, { expectedSha256: sha(bytes) }), bytes);
        assert.equal(fs.existsSync(path.join(root, original.path)), false);
        assert.throws(() => registry.currentTextStagePromptPath(stage), /没有登记/);
    }
});

test('central historical codec exactly preserves every original declaration and budget', () => {
    // Execute only the exact former, pure registry module from the original Git
    // commit; no production module, request, data writer or caller JSON is run.
    const scope = { module: { exports: {} } };
    vm.runInNewContext(git('show', `${baseline}:scripts/lib/prompt-text-versions.js`).toString(), scope);
    const previous = scope.module.exports;
    for (const stage of Object.keys(previous.PROMPT_FILE_VERSIONS)) {
        for (const declared of legacy.legacyDeclarations(stage)) {
            assert.equal(registry.promptFilePathForContract(stage, declared), previous.promptFilePathForContract(stage, declared));
        }
        if (Object.hasOwn(registry.PROMPT_FILE_VERSIONS, stage))
            assert.equal(registry.currentPromptTextContract(stage), 'analysis-prompt-text');
        else assert.throws(() => registry.currentPromptTextContract(stage), /没有登记/);
        assert.equal(registry.promptStageMaxTokens(stage, registry.CURRENT_PROMPT_CONTRACT,
            { configured: 64000, localRepair: 16000, legacyCoreSummary: 8000 }), 64000);
        assert.throws(() => registry.promptFilePathForContract(stage, 'unregistered-prompt-declaration'));
        assert.throws(() => registry.promptStageMaxTokens(stage, 'unregistered-prompt-declaration', { configured: 64000 }));
    }
    for (const row of require('../scripts/lib/prompt-legacy-records.json').stages) {
        const original = row.contract;
        const wide = ['analysis-prompt-text-v3', 'analysis-prompt-text-v4', 'analysis-prompt-text-v5'];
        const summary = [...wide, 'analysis-prompt-text-v6', 'analysis-prompt-text-v7'];
        const expected = ['revision', 'structureRepair'].includes(row.stage) && !wide.includes(original) ? 16000
            : row.stage === 'coreSummaryRepair' && !summary.includes(original) ? 8000 : 64000;
        assert.equal(registry.promptStageMaxTokens(row.stage, original,
            { configured: 64000, localRepair: 16000, legacyCoreSummary: 8000 }), expected, row.stage + original);
    }
});

test('stable content declarations cannot borrow another stage or unknown SHA', () => {
    const article = registry.currentTextStagePromptPath('apiReaderArticle');
    const repair = registry.currentTextStagePromptPath('apiReaderRepair');
    const template = file => history.promptTemplateSha256(evidence.readPromptEvidenceBytes(file).toString());
    assert.ok(evidence.declaredPromptTemplateEvidence(article, template(article)));
    assert.equal(evidence.declaredPromptTemplateEvidence(article, template(repair)), null);
    assert.equal(evidence.declaredPromptTemplateEvidence(article, 'f'.repeat(64)), null);
    assert.throws(() => registry.promptFilePathForContract('unknownStage', registry.CURRENT_PROMPT_CONTRACT));
});

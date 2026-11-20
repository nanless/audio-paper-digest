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
                .replace('核心摘要用 6–9 句完整中文句子，汉字与中文标点合计 320–600 个；',
                    '核心摘要用 10–26 句完整中文句子，汉字与中文标点合计 700–1400 个（目标 850–1150 个），'
                    + '分成 3–4 个以段首粗体引导词开头的自然段（段间空行分隔，不使用 `#` 标题或独立编号行），'
                    + '完整交代问题与瓶颈、核心思路与方法架构、关键实验与核心代价及适用边界与深读导览；')
                .replace('同一核心数字最多在摘要和实验各出现一次，', '核心实验数字主要集中在摘要和实验结果中，'));
        } else if (current === 'prompts/current/deep-analysis.md') {
            assert.equal(actual.toString(), originalBytes.toString()
                .replace('正文使用完整句子和自然段落，句子长短可以变化。核心摘要解释问题、方法、主要结果及限制，方法解释组件与数据流，创新说明与已有方法的差异。实验展开比较，细节说明复现条件，局限集中讨论尚不能成立的结论。同一核心数字最多在摘要和实验各出现一次，不在其他章节换说法重复。',
                    '正文使用完整句子和自然段落，句子长短可以变化。核心摘要作为全景导读摘要完整交代问题瓶颈、方法架构、主基准对比与核心代价及适用边界，方法解释组件与数据流，创新说明与已有方法的差异。实验展开比较，细节说明复现条件，局限集中讨论尚不能成立的结论。核心实验数字主要集中在摘要与实验结果中，不在其他章节换说法反复堆砌。')
                .replace('正文写 6–9 句，汉字与中文标点合计 320–600 个，组成连续段落，说明任务的输入、输出和难点。解释 2–4 个方法步骤各自的职责，以及上一步输出怎样进入下一步，再交代相对已有方法的关键差异和实际意义。\n\n至少说明 1 个原文关键定量结果。在同一句中写清比较对象、评测设置或数据集、指标、数值与方向。不能用模型名、版本号、年份、参数量、样本量或训练超参数代替实验结果。原文确无可核对的定量结果时，原样写“原文未提供可核对的关键定量结果”。\n\n说明结论的适用范围、失败条件或尚未验证的范围，以及原文报告的训练、推理或部署成本。没有披露成本时，原样写“原文未披露训练、推理或部署成本”。这里只选最重要的 1–2 组关键结果；一组比较须保留双方数值、单位、精度和条件，必要的成本数值也要保留，不能为限制数字个数删去比较对象或开销。表格放在实验结果中，不重复整张表。',
                    '撰写信息饱满、结构清晰的全景导读摘要，让读者只读一遍即可完整把握整篇论文。正文写 10–26 句，汉字与中文标点合计 700–1400 个（起草目标 850–1150 个），分成 3–4 个自然段，段落之间只用一个空行分隔，段内不拆行或列点。严禁在核心摘要内使用 `#`、`##`、`###` 等 Markdown 标题、独立编号粗体标题行（如 `1. **...**`）或水平分隔线；统一采用段首粗体引导词直接顶格开启以下 4 段式（或紧凑 3 段式）自然段落（段首不加 `-`、`*` 或 `1.` 等列表编号）：\n\n- `**问题与瓶颈：**` 说明具体任务的输入与输出信号规格，点明现有主流路线在物理、统计或架构上的真实失效症结，拒绝空泛套话“难以兼顾”。\n- `**核心思路与方法架构：**` 先用一句话点破核心洞察，再顺着信号或表征流自然讲清关键模块分工、码率/帧率/维度/模型规模、训练与冻结边界，以及为什么这样设计能够解决前述瓶颈。方法机制单句不超过 520 字，跨句自然衔接，不要写成生硬的“先…输出…送入…”流水账或连续堆砌“称为…”。\n- `**关键实验与核心代价：**` 给出主基准对最强可比基线的核心定量对比，写清评测数据集或设置、原文指标名称与方向、本文与基线的具体数值——允许在同一自然段内跨 1–3 句自然展开比较条件与多组关键指标，不必把所有要素硬塞进同一个长句；不能用模型名、版本号、年份、参数量、样本量或训练超参数代替实验结果（原文确无可核对的定量结果时，原样写“原文未提供可核对的关键定量结果”）。同时交代关键消融发现及付出的具体代价（如某子集词错率回升、参数开销、实时率 RTF 或推理时延）；若为纯理论、诊断或免训练评测论文，如实说明计算方式即可，无需机械背诵“原文未披露训练、推理或部署成本”。凡写出的实验与成本数值均须在原文有据可查，严格保持原文精度、正负号与百分号，绝不编造或四舍五入。\n- `**适用边界与深读导览：**` 点明结论成立的具体条件或尚未覆盖的场景，并用一句话指明读者若想深究哪部分公式推导、架构细节或消融分析可查阅下方长文对应章节。须用凝练概括语言独立撰写摘要，严禁从长文直接整段复制 80 字及以上的相同文字，也不在摘要中嵌入 Markdown 表格。'));
        } else if (current === 'prompts/current/scoring-audit.md') {
            const header = require('../scripts/lib/scoring-record-format').currentEvidenceProfileHeader();
            assert.equal(actual.toString(), originalBytes.toString().replace('    "version": 1,',
                `    "contract": "${header.contract}",\n    "schemaFingerprint": "${header.schemaFingerprint}",`));
        } else if (current === 'prompts/current/core-summary-repair.md') {
            assert.equal(actual.toString(), originalBytes.toString()
                .replace('摘要正文写 6–9 句，汉字与中文标点合计 320–600 个。起草时以 420–520 个中文字符为目标，给必要的结果、边界和成本留出篇幅；最终仍按 320–600 个要求检查。先按当前请求给出的实际字符数安排总篇幅。修复缺项时优先替换已有不完整或重复的说明，不把每个补充说明作为新句追加。保护已经正确的事实、比较对象、条件、指标、数字、单位、方向、边界和成本，可以在不改变这些信息的前提下压缩重复表达；若纠错反馈明确要求某句逐字保留，则该句必须原样保留。句子长短按论文内容安排，不套用固定句数分工或排比模板。用连贯的文字说明任务的输入、输出和实际难点，再解释方法怎样解决问题。方法说明包含 2–4 个步骤，写清各步的职责，以及前一步的输出怎样进入下一步。还要说明这个方法与已有方法的关键差异、这些差异意味着什么，不要只列组件名称。\n\n只修复“当前摘要问题”里指出的缺陷。没有被指出问题的量化结果、边界和成本事实及条件要保留，不增删数字或改变单位、方向。必要时可以合并重复的自然语言说明；明确要求逐字保留的句子不得重述、删改或合并。不要修改评分、标签、作者、方法、实验等其他章节，也不要复制整张表格。',
                    '摘要正文写 10–26 句，汉字与中文标点合计 700–1400 个。起草时以 850–1150 个中文字符为目标，将核心摘要写成信息饱满、结构清晰的全景导读摘要，让读者只读一遍就能完整把握整篇论文；最终按 700–1400 个汉字与中文标点、10–26 句、3–4 个自然段检查。段落之间严格使用一个空行分隔，段内写成连贯散文，不拆行或列点。严禁在核心摘要内使用 `#`、`##`、`###` 等 Markdown 标题、独立编号标题行（如 `1. **...**`）或水平分隔线；统一使用段首粗体引导词直接顶格组织 4 段式（或紧凑 3 段式）自然段落（段首不加 `-`、`*` 或 `1.` 等列表编号）：\n\n1. `**问题与瓶颈：**` 交代具体任务输入与输出信号规格，指出现有主流路线在物理、统计或架构上的真实失效症结，拒绝空泛“难以兼顾”。\n2. `**核心思路与方法架构：**` 一句话点破核心洞察，再顺着信号或表征流讲清关键模块分工、码率/帧率/维度/模型规模、训练与冻结边界，以及为什么这样设计能解决瓶颈。方法机制单句不超过 520 字，允许跨句自然表达信号传递与相互作用，不必生硬堆砌“先…输出…送入…”或连写多个“称为…”。\n3. `**关键实验与核心代价：**` 给出主基准对最强可比基线的核心定量对比（含评测设置/数据集、原文指标名与方向、本文与基线具体数值），允许在同一自然段内跨 1–3 句自然展开比较条件与多组关键指标；同时交代关键消融发现与付出的具体代价（如指标回升、参数开销、实时率 RTF 等）。纯理论、诊断或免训练评测论文如实说明实际计算方式即可，不再强求机械背诵“原文未披露训练、推理或部署成本”。\n4. `**适用边界与深读导览：**` 点明结论成立条件或未覆盖场景，并用一句话指明读者若想深究哪部分公式推导、架构细节或消融分析可阅读下方长文对应部分。请用凝练概括语言撰写摘要，严禁从长文直接整段复制 80 字及以上的相同段落。\n\n修复缺项时优先替换已有不完整或重复的说明，不把每个补充说明机械附在末尾。保护已经正确的事实、比较对象、条件、指标、数字、单位、方向、边界和代价；若纠错反馈明确要求某句逐字保留，则该句必须原样保留。不要修改评分、标签、作者、方法、实验等其他章节，也不要复制整张表格。')
                .replace('原文提供了关键定量结果时，至少说明 1 个。当前程序按单句检查比较对象、评测设置或数据集、指标、数值与方向，因此这些信息仍须在同一句中明确。句首和要素顺序可以按内容安排，不必套用固定句式。写出原文指标名称，不用“分”“更高”或“多项指标”代替指标。',
                    '原文提供了关键定量结果时，必须给出主基准对最强可比基线的核心定量对比。允许在同一段内跨 1–3 句自然展开评测设置或数据集、比较对象、原文指标名称、双方具体数值与高低或变化方向，不必把五个要素硬塞进同一个超长单句。写出原文指标名称，不用“分”“更高”或“多项指标”代替指标。')
                .replace('比较通常采用本文方法与基线。', '比较通常采用本文方法与最强可比基线。')
                .replace('不要把 `0.85` 写成 `85.00`。', '不要把 `0.85` 写成 `85.00` 或 `85%`。')
                .replace('### 适用范围与开销\n\n说明结论在哪些条件下适用、哪些条件可能失败，或哪些范围尚未验证。写明具体条件，不只笼统地说“仍有局限”。\n\n原文报告了训练、推理或部署成本时，说明实际开销和测量条件，例如硬件、计算量、显存、延迟或吞吐。只有提供的原文证据确实没有披露这些成本时，才原样写“原文未披露训练、推理或部署成本”。已经披露的成本不能写成未知。\n\n提交前核对每组比较的对象、设置、指标、数字、单位和方向是否对应同一份原文证据。句子长短可以变化，前后自然衔接；不要把这些信息写成字段串，也不使用统一的开头或结尾。',
                    '### 核心代价、适用边界与深读导览\n\n说明结论在哪些条件下成立、哪些条件可能退化或失效，或哪些范围尚未验证，写明具体条件而不只笼统写“仍有局限”，并用一句话自然引导读者按需查阅下方长文中的核心推导、架构细节或消融分析。\n\n如实交代关键消融发现以及方法付出的具体代价或资源开销（例如硬件、计算量、参数量、显存、延迟、吞吐、实时率 RTF 或特定指标回落）；若为纯理论、诊断或免训练评测工作，直接说明其闭式求解、统计检验或冻结推理方式即可，不必机械背诵“原文未披露训练、推理或部署成本”，但凡写出的真实开销数值必须在原文中有据可查且精度一致。\n\n提交前核对段数（3–4 段，空行分隔，段首粗体引导词，无 `#` 标题）、字数（700–1400 个汉字与中文标点，目标 850–1150 个）、句数（10–26 句）以及每组比较的对象、设置、指标、数字精度、百分号与方向是否严格对应原文证据。'));
        } else if (current === 'prompts/current/gap-fill.md') {
            assert.equal(actual.toString(), originalBytes.toString()
                .replace('未提供的信息写“未提及”或“未说明”，不按常见做法补造。',
                    '未提供的信息写“未提及”或“未说明”，不按常见做法补造。核心摘要须保持全景导读摘要规格（10–26 句，汉字与中文标点 700–1400 个，目标 850–1150 个，3–4 个以段首粗体引导词开头的自然段，段间空行分隔，禁止 `#` 标题或独立编号行），完整覆盖问题与瓶颈、核心思路与方法架构、主基准对比与核心代价（免训练或理论工作如实说明计算方式，无需套用固定未披露套话）以及适用边界与深读导览，不要把长摘要压缩回短单段；所有摘要数值须与原文精度和百分号严格一致。'));
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

test('pre-edit Reader prompt Git blobs remain resolvable by template and whole-file SHA256', () => {
    const preEditCases = [
        {
            stage: 'apiReaderArticle',
            relativePath: 'prompts/current/api-reader-article.md',
            blobOid: 'ac05c8a2fbb62fbfcbfa26975ba8527fdd1c13af',
            wholeSha256: '8fd01908770424562dc68532725b1568b84b29f0eaefc8e63f97bcb7b7ba320d',
            templateSha256: '3d987ea345aee21223f30d514588ee9e2b2f5da7e8cb03894db921809de1cf18'
        },
        {
            stage: 'apiReaderRepair',
            relativePath: 'prompts/current/api-reader-repair.md',
            blobOid: '689c351b7641287148c3cf8bb8d46218abc1eb46',
            wholeSha256: '0037cfe5a2efa88683fcc6d2b1b599d680874b2c8d5fcde1acfec25ce2217e04',
            templateSha256: 'd00b3878979ae2849618cecf4bb8b519fae5292bb154a90281dfac726e3b0598'
        }
    ];
    for (const item of preEditCases) {
        const expectedBytes = git('cat-file', 'blob', item.blobOid);
        assert.equal(sha(expectedBytes), item.wholeSha256);
        assert.equal(history.promptTemplateSha256(expectedBytes.toString('utf8')), item.templateSha256);

        const stageMatch = evidence.declaredStagePromptTemplateEvidence(item.stage, item.templateSha256);
        assert.ok(stageMatch, `${item.stage} pre-edit template SHA256 must resolve`);
        assert.equal(stageMatch.path, item.relativePath);
        assert.equal(stageMatch.fileSha256, item.wholeSha256);
        assert.equal(stageMatch.templateSha256, item.templateSha256);
        assert.deepEqual(stageMatch.bytes, expectedBytes);

        assert.deepEqual(
            evidence.readDeclaredPromptEvidenceBytes(item.relativePath, item.wholeSha256),
            expectedBytes
        );
        assert.deepEqual(
            history.promptBytesForSha256(item.stage, item.wholeSha256),
            expectedBytes
        );
        assert.deepEqual(
            history.historicalPromptTemplateBytesForSha256(item.templateSha256),
            expectedBytes
        );
    }
});

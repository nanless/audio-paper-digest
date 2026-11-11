# 人工验收清单：需要真实材料的关键测试

这份清单把「只有在真实付费材料、封存来源或私有运行目录上才能验证」的测试集中登记下来，给出材料准备、执行命令、通过标准和建议频率。自动测试套件里它们默认跳过，本清单就是它们的常设执行入口。

## 为什么这些测试默认跳过

这些测试验证的是真实材料上的行为：付费模型的原始响应能不能重放、封存 PDF 的每一格能不能对上原表、已签稿的修正会不会改到授权范围之外、会议旧代次的页面字节是否保持不变。仓库里没有这些材料，也不允许用构造数据冒充，所以测试在材料缺失时主动跳过，CI 因此保持全绿。

跳过的代价是：**这些路径在 CI 里没有持续覆盖**。代码改动破坏付费稿复用、表格单位判定或旧代次重放时，CI 可能照样通过。本清单要求按下面的频率，在有材料的验收机上手动跑一遍。

跳过和失败的区别要记清：

- 变量和材料都没准备 → 测试跳过，报告里 `skipped` 增加。
- 变量已设置但材料不对（路径不存在、SHA 不符、父稿绑定变了）→ 测试直接失败，不会静默跳过。

第二点是有意设计：只设变量、不核对材料，测试会立刻失败，而不是先跳过再报告全绿。

## 环境变量放在哪里

在验收用的 shell 里 `export`，不要写进项目 `.env`。项目 `.env` 会被每个批次加载；这些变量只属于测试进程，写进 `.env` 后会在无关任务里生效，还会随着批次环境带进生产运行。

```bash
export PD_READER_REAL_SOURCE_RUN=/path/to/acceptance/sealed-run
node --test tests/reader-bounded-source-adaptations.test.js
```

变量值来自以下材料类别，不要在清单或提交里写真实的本机路径：

| 材料类别 | 从哪里取得 |
|---|---|
| 日更封存运行 | 某次日更的 `daily-fresh-source-runs/<运行 ID>/`，含 `run.json` 与每篇 `sources/<编号>/generation-000001/` 下的 `source.txt`、`source.pdf`、`source-runtime.json`、`source-manifest.json` |
| 付费候选档 | 同一次运行的 `reader-attempts/` 下的候选、退休档与回执 |
| 封存 PDF 的逐格证据 | 由同一次运行封存的 `source.pdf` 和该批表格/单位证据派生；不接受另行重抓的 PDF |
| 会议页面代次 | `conference-publications/<会议>/<进程>/generation.json` 及其页面文件 |
| 审计回执 | 当次发布或审查留下的图片/图注审计材料与 Hugo 输出 |

## 分组执行

9 组共 49 个环境变量（其中 `MFLOW_DISPLAY_CURRENT_FILE` 不带 `PD_` 前缀）。每组先准备材料、再设置变量，跑完确认 `skipped` 为 0，才算这组通过。

### G1 日更封存来源与四文件重放

**验证目标**：同一份封存来源（文本、PDF、运行时元数据、清单）能被 Reader、PDF 证据和修复反馈按原字节重放，不读新抓取或旧缓存，也不会写回原文件。

**材料**：一次完整日更的封存运行目录，以及该批被封存的官方 PDF。

**变量与测试**：

| 变量 | 测试 |
|---|---|
| `PD_READER_REAL_SOURCE_RUN` | `tests/reader-bounded-source-adaptations.test.js`、`tests/reader-inline-svg.test.js`、`tests/python/test_reader_inline_static_html.py` |
| `PD_GENERIC_PDF_REAL_SOURCE_ROOT` | `tests/reader-pdf-quote-binding.test.js`、`tests/reader-sealed-pdf-quote-evidence.test.js`、`tests/reader-sealed-pdf-table-evidence.test.js`、`tests/python/test_reader_sealed_pdf_quote_evidence.py`、`tests/python/test_reader_sealed_pdf_table_evidence.py` |
| `PD_GENERIC_PDF_DISPATCH_REAL_SOURCE_ROOT` | `tests/reader-generic-pdf-dispatch.test.js` |
| `PD_READER_REPAIR_PDF_REAL_SOURCE_DIR` | `tests/reader-repair-pdf-source-context.test.js` |

```bash
export PD_READER_REAL_SOURCE_RUN=/path/to/sealed-run
export PD_GENERIC_PDF_REAL_SOURCE_ROOT=/path/to/sealed-run/sources/PAPER_ID/generation-000001
export PD_GENERIC_PDF_DISPATCH_REAL_SOURCE_ROOT=/path/to/sealed-run
export PD_READER_REPAIR_PDF_REAL_SOURCE_DIR=/path/to/sealed-run
node --test tests/reader-bounded-source-adaptations.test.js tests/reader-inline-svg.test.js \
  tests/reader-pdf-quote-binding.test.js tests/reader-sealed-pdf-quote-evidence.test.js \
  tests/reader-sealed-pdf-table-evidence.test.js tests/reader-generic-pdf-dispatch.test.js \
  tests/reader-repair-pdf-source-context.test.js
bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "test_reader_inline_static_html.py"
bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "test_reader_sealed_pdf_*.py"
```

**通过标准**：全部用例通过，`skipped` 为 0；测试内的原字节 SHA 断言通过（它们会核对来源没有被改写）；没有网络请求（这些测试自己禁网）。

**建议频率**：每次改动发布链来源读取、PDF 证据或 Reader 修复后各跑一次；每季度至少一次。

### G2 真实 PDF 引文、表格与列单位

**验证目标**：从真实 PDF 派生的引文、完整平表、条件行带、合并表头和列单位能逐格对上原表，改值或借单位都会被拒。

**材料**：真实封存 PDF，以及由发布流程生成的逐格/逐列证据；部分用例需要当时的数据文件与证明清单。

**变量与测试**：

| 变量 | 测试 |
|---|---|
| `PD_PDF_QUOTE_REAL_PROOFS` + `PD_GENERIC_PDF_REAL_DATA_FILE` | `tests/python/test_reader_pdf_quote_publish_boundary.py`、`tests/python/test_reader_publish_source_compatibility.py` |
| `PD_GENERIC_PDF_REAL_DATA_FILE` | 同上第二个文件 |
| `PD_READER_PDF_SELECTION_REAL_EVIDENCE` | `tests/reader-compiled-pdf-selection.test.js`、`tests/python/test_reader_pdf_selection_publish.py` |
| `PD_COMPLETE_PDF_REAL_INPUT_DIR` | `tests/python/test_reader_pdf_complete_flat_table.py` |
| `PD_FLAT_CONDITION_PDF_REAL_INPUT` | `tests/python/test_reader_pdf_flat_condition_bands.py` |
| `PD_MERGED_CONDITION_PDF_REAL_INPUT` | `tests/python/test_reader_pdf_merged_condition_column.py` |
| `PD_HIERARCHICAL_PDF_REAL_INPUT` | `tests/python/test_reader_authenticated_pdf_hierarchical_table.py` |
| `PD_PDF_COLUMN_REAL_SOURCE_ROOT` + `PD_PDF_COLUMN_REAL_DRAFT` | `tests/reader-sealed-pdf-column-units.test.js`、`tests/python/test_reader_sealed_pdf_column_units.py` |

```bash
export PD_PDF_QUOTE_REAL_PROOFS=/path/to/accepted-proofs
export PD_GENERIC_PDF_REAL_DATA_FILE=/path/to/accepted-data.json
export PD_READER_PDF_SELECTION_REAL_EVIDENCE=/path/to/selection-evidence
export PD_COMPLETE_PDF_REAL_INPUT_DIR=/path/to/complete-flat-pdf-input
export PD_FLAT_CONDITION_PDF_REAL_INPUT=/path/to/flat-condition-pdf
export PD_MERGED_CONDITION_PDF_REAL_INPUT=/path/to/merged-condition-pdf
export PD_HIERARCHICAL_PDF_REAL_INPUT=/path/to/hierarchical-pdf
export PD_PDF_COLUMN_REAL_SOURCE_ROOT=/path/to/column-source-root
export PD_PDF_COLUMN_REAL_DRAFT=/path/to/paid-draft.json
node --test tests/reader-compiled-pdf-selection.test.js tests/reader-sealed-pdf-column-units.test.js
for name in test_reader_pdf_quote_publish_boundary test_reader_publish_source_compatibility \
  test_reader_pdf_selection_publish test_reader_pdf_complete_flat_table \
  test_reader_pdf_flat_condition_bands test_reader_pdf_merged_condition_column \
  test_reader_authenticated_pdf_hierarchical_table test_reader_sealed_pdf_column_units; do
  bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "$name.py"
done
```

**通过标准**：逐格坐标、数值、单位和表头都通过校验；被篡改的证明、借来的单位、错列和错行都被拒绝；原 PDF 与证据字节不变。

**建议频率**：每次改动表格/单位/PDF 证据抽取后；发布新一批真实稿前跑相关子集。

### G3 已签稿修正与人工入口

**验证目标**：已签 Reader 的术语/事实修正、旧批次人工入口和 operator 收尾只改授权节点，原父稿、费用与计数不变。

**材料**：当年的真实付费候选（退休档与回执）、完整父稿、对应事实反馈包、旧批次根描述符。

**变量与测试**：

| 变量 | 测试 |
|---|---|
| `PD_SIGNED_READER_CORRECTION_MANIFEST` + `PD_SIGNED_READER_CORRECTION_FEEDBACK` | `tests/daily-reader-signed-correction.test.js` |
| `PD_SIGNED_READER_V2_ACTUAL` | `tests/daily-reader-signed-fact-correction.test.js` |
| `PD_SIGNED_READER_PRODUCER_ACTUAL` | `tests/daily-reader-signed-producer-compatibility.test.js` |
| `PD_TEST_LEGACY_BATCH_ROOT_DESCRIPTOR` | `tests/daily-reader-legacy-batch-root.test.js`、`tests/daily-reader-signed-producer-compatibility.test.js` |
| `PD_READER_OPERATOR_FEEDBACK_AUDIT_DIR` | `tests/daily-reader-operator-correction.test.js` |
| `PD_READER_OPERATOR_REAL_DRAFTS` | `tests/daily-reader-operator-correction.test.js` |
| `PD_OPERATOR_ORDINAL_REAL_EVIDENCE` | `tests/daily-reader-operator-ordinal-cold.test.js`、`tests/python/test_daily_operator_ordinal_cold.py` |
| `PD_OPERATOR_ZERO_RECORD_REAL_MANIFEST` | `tests/daily-reader-operator-zero-record-completion.test.js` |
| `PD_OPERATOR_AUTHORS_ACTUAL_MANIFEST` | `tests/reader-operator-author-preservation.test.js` |

```bash
export PD_SIGNED_READER_CORRECTION_MANIFEST=/path/to/manifest.json
export PD_SIGNED_READER_CORRECTION_FEEDBACK=/path/to/feedback.json
export PD_SIGNED_READER_V2_ACTUAL=/path/to/actual-v2
export PD_SIGNED_READER_PRODUCER_ACTUAL=/path/to/producer-actual
export PD_TEST_LEGACY_BATCH_ROOT_DESCRIPTOR=/path/to/legacy-batch-descriptor.json
export PD_READER_OPERATOR_FEEDBACK_AUDIT_DIR=/path/to/operator-feedback
export PD_READER_OPERATOR_REAL_DRAFTS=/path/to/operator-drafts
export PD_OPERATOR_ORDINAL_REAL_EVIDENCE=/path/to/ordinal-evidence.json
export PD_OPERATOR_ZERO_RECORD_REAL_MANIFEST=/path/to/zero-record-manifest.json
export PD_OPERATOR_AUTHORS_ACTUAL_MANIFEST=/path/to/author-manifest.json
node --test tests/daily-reader-signed-correction.test.js tests/daily-reader-signed-fact-correction.test.js \
  tests/daily-reader-signed-producer-compatibility.test.js tests/daily-reader-legacy-batch-root.test.js \
  tests/daily-reader-operator-correction.test.js tests/daily-reader-operator-ordinal-cold.test.js \
  tests/daily-reader-operator-zero-record-completion.test.js tests/reader-operator-author-preservation.test.js
bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "test_daily_operator_ordinal_cold.py"
```

**通过标准**：修正只落在授权的 1–8 个既有节点内；父稿 CAS、来源、费用、尝试次数原样保留；越权补丁和冒名反馈被拒。

**建议频率**：每次改动签名修正、人工清单或 operator 入口后；每次真实人工收尾之后补跑一次。

### G4 事实反馈、局部修复与反馈史

**验证目标**：真实的付费请求与反馈能驱动定向局部修复；失败包、预请求恢复和历史完成记录都按原字节核对。

**材料**：真实局部请求与反馈包、对应论文的封存来源、已保存的失败包与完成记录。

**变量与测试**：

| 变量 | 测试 |
|---|---|
| `PD_READER_FACT_LOCAL_REQUEST_DIR` + `PD_READER_FACT_LOCAL_FEEDBACK_DIR` | `tests/reader-fact-local-bridge.test.js`、`tests/reader-fact-local-prompt.test.js` |
| 再加 `PD_READER_FACT_LOCAL_SOURCE_PROJECT`、`PD_READER_FACT_LOCAL_PAPER_SNAPSHOT` | `tests/reader-fact-local-bridge.test.js` 第二组 |
| `PD_READER_FACT_PRE_REQUEST_REAL_RECORD` | `tests/reader-fact-pre-request-recovery.test.js` |
| `PD_READER_FEEDBACK_METADATA_REAL_EVIDENCE` | `tests/reader-feedback-ordinal-history.test.js` |

```bash
export PD_READER_FACT_LOCAL_REQUEST_DIR=/path/to/fact-local-requests
export PD_READER_FACT_LOCAL_FEEDBACK_DIR=/path/to/fact-local-feedback
export PD_READER_FACT_LOCAL_SOURCE_PROJECT=/path/to/source-project
export PD_READER_FACT_LOCAL_PAPER_SNAPSHOT=/path/to/paper-snapshot.json
export PD_READER_FACT_PRE_REQUEST_REAL_RECORD=/path/to/pre-request-record.json
export PD_READER_FEEDBACK_METADATA_REAL_EVIDENCE=/path/to/feedback-metadata.json
node --test tests/reader-fact-local-bridge.test.js tests/reader-fact-local-prompt.test.js \
  tests/reader-fact-pre-request-recovery.test.js tests/reader-feedback-ordinal-history.test.js
```

**通过标准**：请求只包含获准原句与证据；未覆盖时停止而不是发请求；历史父稿与完成记录逐字保留。

**建议频率**：每次改动事实反馈协议、局部修复或恢复入口后；每次真实纠错完成后。

### G5 核心摘要重放与完成资格

**验证目标**：真实付费摘要能按原请求重放并重验，不追加费用；已完成论文的旧失败标记不会挡住当前资格。

**材料**：真实的付费核心摘要请求/响应、对应的阶段论文集合、`data/current/deep-analysis-result.json` 中仍保留的论文记录。

**变量与测试**：

| 变量 | 测试 |
|---|---|
| `PD_CORE_SUMMARY_REPLAY_REAL_AUDIT` | `tests/core-summary-semantic-replay-cli.test.js`、`tests/python/test_core_summary_semantic_replay.py` |
| `PD_CORE_SUMMARY_REPLAY_REAL_STAGE_PAPERS` | `tests/core-summary-semantic-replay-cli.test.js` 第二组 |
| `PD_COMPLETED_ELIGIBILITY_REAL_PROJECT` | `tests/completed-analysis-eligibility.test.js`（要求 `data/current` 里仍有 2610.04690 的记录） |

另有一组按文件存在性跳过的用例（`tests/core-summary-daily-20261029-real.test.js`，4 处），需要那次批次保存的付费诊断与 checkpoint；这些是路径判断，不设变量。

```bash
export PD_CORE_SUMMARY_REPLAY_REAL_AUDIT=/path/to/core-summary-audit
export PD_CORE_SUMMARY_REPLAY_REAL_STAGE_PAPERS=/path/to/stage-papers
export PD_COMPLETED_ELIGIBILITY_REAL_PROJECT=/path/to/project
node --test tests/core-summary-semantic-replay-cli.test.js tests/completed-analysis-eligibility.test.js \
  tests/core-summary-daily-20261029-real.test.js
bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "test_core_summary_semantic_replay.py"
```

**通过标准**：只重验原响应，不出现新请求；其余十二节与评分、标签、次数、费用不变；通过后仍进入正常整篇检查。

**建议频率**：每次改动核心摘要校验或完成资格判定后；每个真实批次收尾时抽一组。

### G6 会议出版视图与私有代次

**验证目标**：会议页面的旧/新代次字节投影与出版视图一致；被拒页面的上下文重建不改变原文件。

**材料**：某次真实会议发布的代次目录 `conference-publications/<会议>/<进程>/generation.json` 与页面文件。

**变量与测试**：没有环境变量，按代次文件是否存在判断。

```bash
bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "test_conference_publication_figure_view.py"
```

**通过标准**：两条真实代次用例执行而不是跳过；页面投影与旧/新代次字节一致；构造的坏输入仍被拒。

**建议频率**：每次会议发布收尾后；每次改动会议页面渲染或出版视图后。

### G7 来源项目与展示回归

**验证目标**：真实来源项目上的术语、数量级、符号显示、表格标签、引文空白和保存稿重放都保持原值，不因展示整理改写事实。

**材料**：对应论文的封存来源项目、真实付费稿、保存稿与原请求。

**变量与测试**：

| 变量 | 测试 |
|---|---|
| `PD_READER_CONCEPT_TERMS_SOURCE_PROJECT` | `tests/reader-concept-terms-repair.test.js` |
| `PD_DECIMAL_MAGNITUDE_SOURCE_PROJECT` | `tests/reader-decimal-magnitude.test.js` |
| `PD_READER_NORM_SOURCE_PROJECT` + `PD_READER_NORM_PAID_FILE` | `tests/reader-norm-symbol-display.test.js` |
| `PD_MINIMAL_SOURCE_PROJECT` | `tests/reader-real-minimal-context.test.js` |
| `PD_READER_QUOTE_REQUEST_DIR` + `PD_READER_QUOTE_SOURCE_PROJECT` | `tests/reader-source-quote-whitespace.test.js` |
| `PD_READER_TABLE_LABEL_SOURCE_PROJECT` | `tests/reader-table-narrative-labels.test.js` |
| `PD_SAVED_PDF_REPLAY_RECORDS` + `PD_SAVED_PDF_REPLAY_SOURCE_ROOT` | `tests/reader-saved-pdf-proof-replay.test.js` |
| `PD_READER_SCIENTIFIC_DOM_REAL_EVIDENCE` | `tests/source-scientific-cell-display.test.js`、`tests/python/test_scientific_source_cell_display.py` |
| `PD_SOURCE_MULTIPLIER_ACTUAL` | `tests/python/test_reader_source_multiplier_display.py` |
| `PD_SOURCE_CELL_DISPLAY_ACTUAL` | `tests/python/test_source_cell_math_display.py` |
| `MFLOW_DISPLAY_CURRENT_FILE` | `tests/mflow-source-display.test.js`、`tests/python/test_mflow_source_display.py` |

```bash
export PD_READER_CONCEPT_TERMS_SOURCE_PROJECT=/path/to/source-project
export PD_DECIMAL_MAGNITUDE_SOURCE_PROJECT=/path/to/source-project
export PD_READER_NORM_SOURCE_PROJECT=/path/to/source-project
export PD_READER_NORM_PAID_FILE=/path/to/paid-file.json
export PD_MINIMAL_SOURCE_PROJECT=/path/to/source-project
export PD_READER_QUOTE_REQUEST_DIR=/path/to/quote-requests
export PD_READER_QUOTE_SOURCE_PROJECT=/path/to/source-project
export PD_READER_TABLE_LABEL_SOURCE_PROJECT=/path/to/source-project
export PD_SAVED_PDF_REPLAY_RECORDS=/path/to/saved-records.json
export PD_SAVED_PDF_REPLAY_SOURCE_ROOT=/path/to/sealed-source-root
export PD_READER_SCIENTIFIC_DOM_REAL_EVIDENCE=/path/to/scientific-evidence
export PD_SOURCE_MULTIPLIER_ACTUAL=1
export PD_SOURCE_CELL_DISPLAY_ACTUAL=1
export MFLOW_DISPLAY_CURRENT_FILE=/path/to/current-paid.json
node --test tests/reader-concept-terms-repair.test.js tests/reader-decimal-magnitude.test.js \
  tests/reader-norm-symbol-display.test.js tests/reader-real-minimal-context.test.js \
  tests/reader-source-quote-whitespace.test.js tests/reader-table-narrative-labels.test.js \
  tests/reader-saved-pdf-proof-replay.test.js tests/source-scientific-cell-display.test.js \
  tests/mflow-source-display.test.js
for name in test_scientific_source_cell_display test_reader_source_multiplier_display \
  test_source_cell_math_display test_mflow_source_display; do
  bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "$name.py"
done
```

**通过标准**：展示整理只改显示层，原来源、数字、单位和引文不变；该拒绝的借用与改写仍被拒。

**建议频率**：每次改动展示投影、术语或单位规则后。

### G8 图片、图注与 Hugo 审计

**验证目标**：真实图片/图注审计材料在 Hugo 实际输出上仍通过共享与会议门；私有封存 CHiME 来源的单元格与规则摘要保持一致。

**材料**：带审计回执的图片/图注材料、Hugo 构建产物、封存 CHiME 来源目录。

**变量与测试**：

| 变量 | 测试 |
|---|---|
| `PD_SOURCE_FIGURE_CAPTION_REAL_AUDIT` | `tests/python/test_source_figure_caption_literal_dollars.py` 的 2 条审计用例 |
| `PD_SOURCE_FIGURE_CAPTION_HUGO_REAL_AUDIT` | 同文件的 4 条 Hugo 审计用例 |
| `PD_PDF_CHIME_REAL_SOURCE_DIR` | `tests/python/test_reader_pdf_visual_audit_cache.py` |

```bash
export PD_SOURCE_FIGURE_CAPTION_REAL_AUDIT=/path/to/caption-audit
export PD_SOURCE_FIGURE_CAPTION_HUGO_REAL_AUDIT=/path/to/hugo-audit
export PD_PDF_CHIME_REAL_SOURCE_DIR=/path/to/chime-sealed-source
bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "test_source_figure_caption_literal_dollars.py"
bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "test_reader_pdf_visual_audit_cache.py"
```

**通过标准**：真实 Hugo 输出与审计材料一致；换 URL、改属性等负例仍被拒；图片像素与规则摘要不变。

**建议频率**：每次改动图片/图注出版或 Hugo 门后；每次升级 Hugo 版本后。

### G9 本地运行目录（无变量，按路径判断）

**验证目标**：目标序号补丁、结构最终重放和标签父包完成都能在本地真实运行数据上按原字节重放。

**材料**：`data/current/deep-analysis-result.json`、32310 的封存四文件来源与当前批次绑定、`daily-20261016-full` 下的标签父包与预览记录。

**测试**：`tests/reader-target-ordinal-paid-20261027-real.test.js`、`tests/structure-final-source-replay-20261027-real.test.js`、`tests/reader-tag-parent-completion.test.js`。

```bash
node --test tests/reader-target-ordinal-paid-20261027-real.test.js \
  tests/structure-final-source-replay-20261027-real.test.js tests/reader-tag-parent-completion.test.js
```

**通过标准**：真实用例执行而不是跳过（目标序号 3 组、结构重放 1 条、标签父包 1 条）；原请求、原失败、费用与父稿字节不变。

**建议频率**：每次改动目标序号补丁、结构重放或标签父包逻辑后；换批次后重跑，确认绑定仍成立。

## 当前材料状态

以下是 2026-11-12 在开发机上的只读核对结果。状态只说明「材料在不在、绑定还在不在」，不代表已经执行过验收；变量一律未设置。

| 组 | 状态 | 依据 |
|---|---|---|
| G1 日更封存来源 | 材料在，变量未设 | 本机有 37 个日更封存运行目录；需选定一次运行再设变量 |
| G2 真实 PDF 引文/表格 | 待确认 | 逐格证据随封存运行保存；需挑选一批带完整证据的运行 |
| G3 已签稿修正/人工入口 | 待确认 | 运行目录下有 `reader-attempts`；具体付费档是否仍在需按 run 确认 |
| G4 事实反馈/局部修复 | 待确认 | 依赖具体论文的请求与反馈包，需按当时记录确认 |
| G5 核心摘要/完成资格 | 不具备 | `data/current` 里当前没有 2610.04690 的记录，设置变量会直接失败 |
| G6 会议出版视图 | 材料在，代次待确认 | 本机有 20 个会议 publication 目录 |
| G7 来源项目与展示回归 | 待确认 | 需要按论文准备来源项目与付费稿 |
| G8 图片/图注/Hugo 审计 | 待确认 | 依赖当时发布的审计回执与 Hugo 输出 |
| G9 本地运行目录 | 部分具备 | 32310 的封存运行存在，但 `data/current` 当前未绑定该论文，结构重放用例仍会跳过 |

## 执行与排错

一次完整的验收按组顺序执行，每组记录：变量、测试文件、通过/失败/跳过数、执行时间。判据是 `skipped` 为 0 且 `fail` 为 0；只有跳过说明材料没准备好，不算通过。

遇到失败先看材料，不要先改测试：

- 路径不存在或权限不对 → 重新导出材料，保持变量指向的目录可读。
- SHA 或父稿绑定不符 → 材料已被改动或过期；回退到原封存副本，不能改写原文件去凑断言。
- 网络或模型错误 → 这些测试默认禁网；出现网络失败说明被测路径漏了打桩，按实现缺陷处理。

这些用例按各自实现使用临时目录或只读访问，并对原封存来源做 SHA 校验；执行前后可用文件 SHA 或版本控制核对原来源没有被改写。

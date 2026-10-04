# 论文解读的局部修复

~~~
请修复下方尚未通过检查的论文解读。只修改代码允许的节点，保留正确的事实、原表数值、单位，以及图和公式的对应关系。事实依据来自论文证据，待修片段不能作为事实来源。修复完成后，代码仍会检查整篇文章的来源和质量。

论文：{title}
arXiv：{arxivId}
本次代码检查的数量、长度和修改范围：
{mechanicalContract}

介绍组合术语时，要解释各自的分工和搭配原因。表格前后须有相邻的解释段，数字和单位都要能在原文中核对。数字来自 `TABLE_J` 矩阵且对应 `TABLE_J_SELECTION` 为 `eligible=true` 时，必须改用 `selection`，正文只保留独占一段的 `[[TABLE_N]]`。不要把 DOM 表格数字抄成 Markdown，再用 `source_quotes` 说明来源；展平的全文未必包含这些单元格。不得自行计算差值、百分比、换算值或添加单位。公式只用原文编号对应的占位符，图像描述只依据此次实际收到的像素。

当前校验问题和有来源的外部修订反馈：
{validationFeedback}

允许修改的节点（`path`、`oldSha256`、`value`）与当前完整草稿的 SHA：
{repairTargets}

论文证据：
{sourceEvidence}

你看到的是允许修改的片段，其他节点由代码原样保留。不要据此推断其他内容缺失，也不要重建全文。按下面格式输出一个 JSON 对象，不输出完整文章、Markdown 代码块或其他字段：
{"version":1,"draftSha256":"原样复制给定完整草稿SHA","replacements":[{"path":"原样复制允许路径","oldSha256":"原样复制该节点旧SHA","value":"替换后的完整节点值，类型与旧值一致"}]}

一次替换 1–8 个允许修改的节点，不增删数组项。每个路径只能出现一次，不能同时修改父路径和子路径，也不能修改未获允许的路径。修改 `section.body` 时，给出该小节的完整正文；修改来源记录时，给出完整对象。不要为满足字数或表格要求添加无来源的事实、占位文字或重复句。正文表格及其来源记录必须一致。

表格只能使用以下 3 种结构中的一种，不能混合字段或正文形式。N 表示最终文章的第 N 张表，J 表示原始 `TABLE_J` 的编号：

1. 正文整理表：{"tableIndex":N,"sourceType":"source_quotes","sourceTableOrdinal":null,"cellBindings":[],"sourceQuotes":["全文中的连续原句字符串"]}。
   `cellBindings` 必须是空数组 `[]`，不能放入 `quoteIndex`、`value` 或单元格坐标。`sourceQuotes` 的每项都是 12–4000 字符的连续原句字符串，不能只写裸数字或写成对象。数字和单位均需原文支持。
   该模式不会自动生成表格。请在对应 `section.body` 中直接写标准 Markdown 表，包含表头、分隔行和全部数据行，并用它替换原来的 `[[TABLE_N]]`。不要保留 `TABLE` 占位符，表前和表后仍须有独立解释段。
2. 原表自动选择：{"tableIndex":N,"selection":{"sourceTableOrdinal":J,"sourceRows":[0,1],"sourceColumns":[0,1]}}。
   仅在 `TABLE_J_SELECTION` 明确为 `eligible=true`，且选择的行列符合给定矩阵时使用。正文独占一段写 `[[TABLE_N]]`，代码会在此处显示原表。该对象不能再含 `sourceType`、`cellBindings` 或 `sourceQuotes`。`eligible=false` 时，只能按第 1 种模式整理有充分原句支持的正文表，不能尝试修复原始矩阵。
3. 旧式原表逐格绑定：{"tableIndex":N,"sourceType":"artifact_table","sourceTableOrdinal":J,"cellBindings":[{"renderedRow":0,"renderedColumn":0,"sourceRow":0,"sourceColumn":0}],"sourceQuotes":[]}。
   正文直接写 Markdown 表，每个显示单元格须逐字匹配原始 DOM 单元格，并记录完整对应关系。上面的 `cellBindings` 只示意一个单元格，实际记录必须覆盖表头和全部数据格。该模式也不能使用 `TABLE` 占位符。

若修改要求给出了 `atomicOperation.kind=relocate_result_table_v1`，须在一次修改中完成表格搬移。从 `donorSectionPath` 删除恰好 1 张原表或 `[[TABLE_N]]`，再在 `destinationSectionPath` 的结果或消融小节插入恰好 1 张带数字的 Markdown 表。新表放在目标小节的现有表格或 `[[TABLE_N]]` 之前，继承 `donorGlobalTableIndex`；不能追加到已有 `[[TABLE_2]]`、`[[TABLE_3]]` 等占位符之后，也不能修改 `tableBindings` 中对应记录的 `tableIndex`。三个 `requiredReplacementPaths` 必须全部输出。目标正文要保留表前的比较问题，以及表后对差异和适用条件的解释。

若修改要求给出了 `atomicOperation.kind=add_result_table_v1`，说明正文少了一张已经声明来源的表。不要搬移或复制已有表，也不要把配置表改名。只修改 `destinationSectionPath` 的结果或消融小节，以及 `bindingPath` 对应的 `source_quotes` 记录。在正文中新增恰好 1 张含至少 4 个原文数字的标准 Markdown 结果表，使 Markdown 表格总数等于 `tableBindings` 数量，并按 `tableIndex` 放在正确位置。所有数字、单位、基线和实际策略都须由论文证据中的连续原句逐字支持。当前引用若只是配置说明，应在允许的 `bindingPath` 中换成主结果原句，不能把配置数字当作结果。两个 `requiredReplacementPaths` 必须全部输出，新表前后保留比较问题，以及对差异和适用条件的解释。

若反馈同时指出多张表的结构错误和篇幅不足，应一起修正相关来源记录和正文，再选适量允许的小节补足机制、执行过程或公平比较的解释。最多修改 8 个节点，来源记录和正文各算一个。列出全部可扩写小节不代表要求重写全部内容。保留正确事实和其他已通过的内容，不要只修第一张表，或仅删除占位符就提交。
~~~

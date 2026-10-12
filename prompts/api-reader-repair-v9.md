# 论文解读的局部修复

~~~
请修复下面这篇还没通过检查的论文解读。只改代码列出的允许修改项，正确的事实、原表数值、单位，以及图和公式的对应关系都保留。事实依据只能来自论文证据，待修片段本身不能当事实来源。修完之后，代码还会检查整篇文章的来源和质量。

论文：{title}
arXiv：{arxivId}
本次代码检查的数量、长度和修改范围：
{mechanicalContract}

介绍组合术语时，要解释各自的分工和为什么这样搭配。表格前后要有相邻的解释段，数字和单位都要能在原文里核对。数字来自 `TABLE_J` 矩阵时，`selection` 只能选择 `TABLE_J_SELECTION` 明确标为 `eligible=true` 的合法行列。`completeTable` 独立按完整原矩阵及原始 DOM 核验，`eligible=false` 不禁止完整原表；这两种模式的正文只保留唯一独占一段的 `[[TABLE_N]]`。不要把 DOM 表格数字抄成 Markdown 再用 `source_quotes` 说明来源；展平的全文未必包含这些单元格。差值、百分比、换算值不能自己算，单位也不能自己加。公式只用原文编号对应的占位符，图像描述只依据这次实际收到的像素。

表格输出方式以本提示词和本轮授权路径为准。论文证据中的 `TABLE_J_SELECTION.action` 若要求手写 Markdown、逐格填写 `cellBindings` 或不用 `TABLE` 标记，那是在说明旧式 `artifact_table` 兼容方式，不会禁止这里的 `completeTable`。展示完整原表时，若本轮同时授权该表来源记录和对应正文，优先明确声明 `completeTable`，正文使用唯一独占一段的 `[[TABLE_N]]`，由程序按完整原始 DOM 矩阵生成全部行列。原矩阵、`eligible` 与失败原因仍是有效证据，数字、单位和所有来源检查不变。没有这两个授权时不能转换模式；已有合法完整原表标记且仅修本轮已授权来源编号时，仍按第 2 种模式保留正文。不得借旧说明或这条优先规则改未授权字段。

当前校验问题和有来源的外部修订反馈：
{validationFeedback}

允许修改的内容（`path`、`oldSha256`、`value`）与当前完整草稿的 SHA：
{repairTargets}

论文证据：
{sourceEvidence}

如果本次 `atomicOperation.kind` 明确为 `delete_top_level_program_metadata_v1`，只使用这一种输出格式：
{"version":1,"rawSha256":"原样复制本次原始草稿 SHA","deleteFields":["sourceBindingsContract","sourceBindingsSha256"]}
这两项是程序管理的顶层元数据，不是正文事实。模型必须明确请求删除两项，不能输出 replacements 或完整文章，不能改其他字段、数组、图表、公式和正文。代码只在原始 JSON 完整、没有重复顶层键、八个必要字段齐全且额外字段恰好是这两项时授权；字段里的 SHA 不是来源证明。代码逐字保留其他内容，再执行全部原有文章及来源检查。未明确授权这种操作时，仍按下文的替换格式修复，绝不能自行删字段。

没有授权顶层元数据删除时，以下是普通替换允许修改的片段，其他字段和数组项由代码原样保留。不要据此推断其他内容缺失，也不要重建全文。按下面格式输出一个 JSON 对象，不输出完整文章、Markdown 代码块或其他字段：
{"version":1,"draftSha256":"原样复制给定完整草稿 SHA","replacements":[{"path":"原样复制允许路径","oldSha256":"原样复制该修改项的旧 SHA","value":"替换后的完整值，类型与旧值一致"}]}

普通替换一次修改 1–8 个允许修改项。除下面明确授权的整组表格来源记录（tableBindings）的补齐操作外，数组项不增不减。每个路径只能出现一次；父路径和子路径不能同时改，未获允许的路径也不能改。改 `section.body` 就给该小节的完整正文，改来源记录就给完整对象。不要为了凑字数或表格要求添加无来源的事实、占位文字或重复句。正文表格和它的来源记录必须一致。

表格只能使用以下 4 种结构中的一种，不能混合字段或正文形式。N 表示最终文章的第 N 张表，J 表示原始 `TABLE_J` 的编号：

1. 正文整理表：{"tableIndex":N,"sourceType":"source_quotes","sourceTableOrdinal":null,"cellBindings":[],"sourceQuotes":["全文中的连续原句字符串"]}。
   `cellBindings` 必须是空数组 `[]`，`quoteIndex`、`value` 或单元格坐标都不能放。`sourceQuotes` 的每一项都是 12–4000 字符的连续原句字符串，不能只写裸数字，也不能写成对象。数字和单位都要有原文支持。
   这个模式不会自动生成表格。请在对应的 `section.body` 里直接写标准 Markdown 表，含表头、分隔行和全部数据行，用它替换原来的 `[[TABLE_N]]`。`TABLE` 占位符不要保留，表前表后仍要有独立解释段。
2. 完整原表声明（`reader-complete-table-declaration-v1`）：`{"tableIndex":N,"completeTable":{"sourceTableOrdinal":J}}`。首次从旧 Markdown 或其他模式改成完整原表时，必须同时获准修改该来源记录和对应正文，并在正文放唯一独占一段的 `[[TABLE_N]]`。若当前已经是 `completeTable`，且正文已有唯一独占一段的对应标记，只修本轮已授权的来源记录编号时，正文可逐字保持原样，不需要额外正文授权。程序从真实原矩阵生成全部行列及逐格绑定，不填手写数字、不选子集、不混入其他字段。`eligible=false` 仅禁止 selection，完整原表仍须通过原始 DOM、单位、数字和正文全部检查。旧坏稿不会自动升级；不得将标记从未授权或未知字段自动搬入正文。旧模式没有对应正文授权时不能改成此模式，整组补来源记录的操作仍保持原来仅匹配已有 Markdown 的限制。

3. 原表自动选择：{"tableIndex":N,"selection":{"sourceTableOrdinal":J,"sourceRows":[0,1],"sourceColumns":[0,1]}}。
   只有在 `TABLE_J_SELECTION` 明确为 `eligible=true`，而且选择的行列符合给定矩阵时才用。正文独占一段写 `[[TABLE_N]]`，代码会在这里显示原表。这个对象不能再带 `sourceType`、`cellBindings` 或 `sourceQuotes`。当前原表 `eligible=false` 时，可改选本次证据中其他合格原表，或按第 2 种模式展示完整原表，或按第 1 种模式整理有充分原句支持的正文表，不要修改原始矩阵。
4. 旧式原表逐格绑定：{"tableIndex":N,"sourceType":"artifact_table","sourceTableOrdinal":J,"cellBindings":[{"renderedRow":0,"renderedColumn":0,"sourceRow":0,"sourceColumn":0}],"sourceQuotes":[]}。
   正文直接写 Markdown 表，每个显示单元格都要逐字匹配原始 DOM 单元格，并记下完整对应关系。上面的 `cellBindings` 只示意一个单元格，实际记录要覆盖表头和全部数据格。这个模式同样不能用 `TABLE` 占位符。

修改要求给出 `atomicOperation.kind=complete_existing_table_bindings_v1` 时，正文已经有完整表格，但来源记录数量不足。本次只替换获准的 `/tableBindings` 完整数组，不改正文、不删表或移动表，不重新生成全文。新数组长度必须为 `expectedTableCount`，每项按现有正文表序连续编号；旧项仅允许修正 `mutableBindingIndices` 明确列出的数组索引（从0开始），其余旧项原样保留。新增项恰好补足缺口，已有正文为Markdown表，本次只能用与其逐格对应的artifact_table或有完整逐字原句支持的source_quotes；不能改成需要新增正文标记的selection。全部数字和单位仍须由真实DOM单元格或全文连续原句支持。不能为凑记录复制错绑引文、推断新数字或用别的实验补证据。整个数组仍用当前给定 `oldSha256`，已有正文和绑定的SHA不能伪造。后续完整解析器会核对全部来源、顺序、表格和正文要求。

修改要求给出 `atomicOperation.kind=relocate_result_table_v1` 时，表格搬移要在一次修改里完成。从 `donorSectionPath` 删掉恰好 1 张原表或 `[[TABLE_N]]`，再在 `destinationSectionPath` 的结果或消融小节插入恰好 1 张带数字的 Markdown 表。新表放在目标小节现有表格或 `[[TABLE_N]]` 之前，继承 `donorGlobalTableIndex`；不能追加到已有的 `[[TABLE_2]]`、`[[TABLE_3]]` 等占位符后面，也不能改 `tableBindings` 里对应记录的 `tableIndex`。三个 `requiredReplacementPaths` 必须全部输出。目标正文要保留表前的比较问题，以及表后对差异和适用条件的解释。

修改要求给出 `atomicOperation.kind=add_result_table_v1` 时，说明正文少了一张已经声明来源的表。已有表不要搬移或复制，配置表也不要改名。只改 `destinationSectionPath` 的结果或消融小节，以及 `bindingPath` 对应的 `source_quotes` 记录。在正文里新增恰好 1 张含至少 4 个原文数字的标准 Markdown 结果表，本次只补这一张，剩余已声明的缺表在后续修复中逐项补齐，不得改动其他旧表或来源记录，并按 `tableIndex` 放在正确位置。所有数字、单位、基线和实际策略都要由论文证据中的连续原句逐字支持。当前引用如果只是配置说明，就在允许的 `bindingPath` 里换成主结果原句，不能把配置数字当结果。两个 `requiredReplacementPaths` 必须全部输出，新表前后保留比较问题，以及差异和适用条件的解释。

反馈同时指出多张表的结构错误和篇幅不足时，相关来源记录和正文一起修，再从允许的小节里挑适量几处补上机制、执行过程或公平比较的解释。最多改 8 个修改项，来源记录和正文各算一个修改项。列出全部可扩写小节，不等于要求重写全部内容。正确的事实和其他已通过的内容都保留；不要只修第一张表，也不要只删掉占位符就提交。

选择表格前逐项核对 `TABLE_J_INDEX_RULES` 和 `TABLE_J_SHAPE`：rows=16 表示合法行索引0..15，不是0..16；columns同理。每张原表单独核对，不能沿用另一张表的维度。sourceRows/sourceColumns各至少2项、整数且不重复；只选择本次证据实际展示的单元格，sourceRows中只含一个原表头和至少一个数据行。修复反馈给出的当前数组、非法索引和重复索引是待修对象，不是合法示例；不要原样回传。
source_quotes 中的单位只可来自与该数值同一语境的逐字原句。多行列头 mean(SD),s 不会给后续全部裸数字提供逐值单位证据；不要手补单位、换成无单位列头或删掉训练/部署成本来绕过检查。不能逐值绑定时，保留有证据的列和成本事实，把有连续原句支持的时长比较放正文；无证据的SD或数值不能进入表格。
FORMULA/BRIDGE标记必须独占一段且只出现一次；公式的targetKind、术语组合解释的sectionKind，必须分别与标记实际所在小节的kind一致。若位置和声明不一致，依据原文选择移动标记或修正允许修改的绑定，不能保持错误声明或改变公式含义。
~~~

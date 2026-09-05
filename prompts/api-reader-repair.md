# Reader 受限局部修复

~~~
你正在修复一份尚未通过代码验收的 Reader 草稿。只改代码给出的允许节点，并保留正确事实、原表数值、单位、图像及公式身份。证据是事实来源，目标片段只是待修正文。修复后代码仍会对完整文章执行全部来源与质量门禁。

论文：{title}
arXiv：{arxivId}
本次代码生成的机械契约：
{mechanicalContract}

术语须讲分工及组合原因。表格有相邻论证，数字及单位必须可重放。公式只用原文ordinal marker。图像仅能描述此次实际收到的像素。

当前校验问题和有来源的外部修订反馈：
{validationFeedback}

允许修改的节点（path、oldSha256、value）与当前完整草稿SHA：
{repairTargets}

论文证据：
{sourceEvidence}

你只看到了允许修改的片段；其他节点由代码原样保留。不得推断其他片段缺失并重建全文。必须用下面协议输出一个JSON对象，不得输出全文、Markdown fence或其他字段：
{"version":1,"draftSha256":"原样复制给定完整草稿SHA","replacements":[{"path":"原样复制允许路径","oldSha256":"原样复制该节点旧SHA","value":"替换后的完整节点值，类型与旧值一致"}]}

一次只替换1–8个允许节点，不能新增/删除数组项，不能输出重复、父子重叠或未允许路径。修复section.body时输出该小节完整正文；修复绑定项时输出该项完整对象。不得为了通过字数/表格门禁添加无来源事实、占位话或重复句。表格正文与绑定项必须同时保持一致。

表格只有以下3种互斥结构，禁止混合。这里N表示最终文章第N张表，J表示原始TABLE_J编号：

1. 正文整理表：{"tableIndex":N,"sourceType":"source_quotes","sourceTableOrdinal":null,"cellBindings":[],"sourceQuotes":["全文中的连续原句字符串"]}。
   cellBindings必须原样是空数组[]，不得放入quoteIndex、value或任何单元格坐标。sourceQuotes每项为12–4000字符原句字符串，不能只写裸数字，不能写对象。数字与单位需要原文支持。
   该模式不生成表格：必须在对应section.body直接写标准Markdown表（表头、分隔行、所有数据行）。把原来的[[TABLE_N]]替换为实际Markdown；不得保留TABLE marker。表格前后保留独立解释段。
2. 原表自动选择：{"tableIndex":N,"selection":{"sourceTableOrdinal":J,"sourceRows":[0,1],"sourceColumns":[0,1]}}。
   仅TABLE_J_SELECTION明确eligible=true且原表行列符合已给矩阵时使用。正文独占[[TABLE_N]]，代码才会注入原表。该对象不能再含sourceType、cellBindings或sourceQuotes。eligible=false时改用第1种完整正文整理表，不能尝试修复原始矩阵。
3. 旧式原表逐格绑定：{"tableIndex":N,"sourceType":"artifact_table","sourceTableOrdinal":J,"cellBindings":[{"renderedRow":0,"renderedColumn":0,"sourceRow":0,"sourceColumn":0}],"sourceQuotes":[]}。
   正文直接写Markdown，每个渲染单元格都须逐字匹配原始DOM单元格且完整映射。上面的cellBindings只是单格格式示意，实际须覆盖表头与所有数据格。该模式也不能使用TABLE marker。

若当前反馈同时包含多个表的结构错误与篇幅不足，本次补丁应同时修正相应表绑定及正文，并选适量允许的小节补足机制/执行过程/公平比较的解释。最多8个替换节点；绑定项和正文各算一个节点。已给出所有可扩写正文不表示要重写所有小节。优先保留正确事实与其他已通过内容，不要只修第一张表或只删marker就提交。
~~~

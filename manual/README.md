# 旧记录核验与独立人工审查

[English](README.en.md)

本目录不是新的论文写作入口。第一次维护项目时，先区分两个用途：核验旧记录当时采用的来源和签名，以及对当前页面开展受控的独立审查。它们都不能替代三条正常生产流程。

整批 Manual 写作、任务分派、任务规格 `spec` 和结果记录 `records` 的生产链已退役。新任务统一使用 [日更、会议与历史三流程](../docs/three-workflows.md)。

先按 [正常批次轮次](../docs/three-workflows.md#全批轮次与失败集合) 完整处理选定集合，后续只续可重试失败项。多轮后剩下少量顽固论文时，按 [持续授权](../AGENTS.md#持续授权以效率和效果为准) 选择受控修正或独立审查，无需逐篇再问。真实来源、原失败稿、修改范围、费用和失败记录仍须绑定并保留。

`manualHandoff` 只是建议报告：它指出哪些论文可能需要人工处理，不会自动取得来源能力或增加机器请求额度。

本目录保留用于核验旧来源、作者策略、签名、正文与教程合同的模块，它们同时也是现行生产代码。`scripts/analysis-contract.js` 在日更正文校验中引入人工代理策略、研究合同、教程合同编排、新写作合同和教程载荷；正式数据验证脚本 `scripts/validate-data-files.js` 另引入来源身份模块；发布器的审查实现入口包含 `manual/scripts/manual-review-blog.py` 和 `manual/scripts/tutorial_payload_verifier.py`。

只读的是旧记录核验所依据的历史字节，不是这些模块本身。`manual/scripts` 下除 `assemble-manual-review-attestation.py` 和 `manual-signature-contract.js` 外，其余 12 个模块都在审查协议指纹和页面生成器实现指纹的依赖闭包内，改动会改变这两项指纹，本批审查凭证须按新指纹重签。改动后必须回归 `npm run verify`，并重跑受影响的当前批次审查；内容未变的已通过页面不会因此重审。

旧合同 Prompt 已从工作树移除，核验时通过受控 Git 索引取回原字节并核对原声明 SHA，不补签旧结果；旧编辑规范和结构说明通过独立的原文件证据目录读取。

本目录在工作树里共 62 个文件，受 Git 跟踪的是 40 个：2 篇 README、14 个脚本、11 个 JavaScript 测试、7 个 Python 测试、4 份 fixtures 和 2 个测试 helper。另外 22 个是本机忽略产物（21 个 `__pycache__` 下的 `.pyc` 和 1 个 `.DS_Store`），不属于仓库内容。统计这里的文件数量时按 40 计。

### 现在怎样阅读本目录

学习当前论文解读的写法，先读[共同写作约定](../docs/writing-guide.md)和[Reader 写作与来源要求](../docs/reader-writing.md)。术语首次解释实际作用，再使用准确名称；概念、计算、比较条件和图表要能连成完整论证，段落间留空行，语气朴实平和。受控修订的具体范围与预算仍按[Reader 恢复](../docs/reader-explicit-retry.md)核验。

旧编辑规范及教程结构说明已从工作树移除，原始字节保存在 Git 物件中。[原文件证据目录](../config/original-file-evidence.json)登记固定逻辑路径、原文件校验值和实际 Git 物件。核验旧稿时，程序只读取同一路径下已登记的原字节，并重新计算整个文件的 SHA-256；不会把现行规范或刚修改的程序文件替换成旧凭证的依据。

历史规范中的“当前”、章节、长度和任务角色只解释其原记录，不能推广为现在的 Reader 写作要求。结构说明中登记的旧 JavaScript 只按原字节核验旧记录；同一路径的现行模块仍在生产里执行，登记的历史 SHA 与当前文件不同是正常状态，不能用它判断当前文件是否被改动。需要学习现行写法时，使用上面的写作约定与 Reader 指南。

新建独立审查必须实际配置 `gpt-6.1-sol`、`high`，声明和逐页身份使用现行格式，各自带实际结构指纹；逐页记录实际负责的独立审查助手，不能仅填写模型名。旧 `gpt-5.6-terra/high` 声明只用于读取原记录。审查声明以 `scripts/manual_agent_policy.py` 为准，不改变三流程论文分析所配置的 Muse 模型；分析清单的模型规则在 `manual/scripts/manual-agent-policy.js`，其中 `manual-agents-sol-high-v2` 是分析侧现行标识，不要按发布侧规则改写。

独立单页审查仍使用以下共享补救入口：

```bash
npm run blog:manual-plan -- --date YYYY-MM-DD
npm run blog:manual-attest -- --date YYYY-MM-DD ...
npm run blog:manual-review -- --date YYYY-MM-DD ...
```

填写新单页审查材料时，`scripts/manual_agent_policy.py` 中的 `current_review_subagent_fields()` 提供实际登记的格式字段。它只提供格式和所需模型设置；`taskName`、单页范围、隔离记录和审查意见必须来自实际工作。

参数及审查材料以对应程序的解析器和当前页面生成清单为准；上述省略号须补齐实际参数。人工内容修正须绑定本篇已核验来源、原失败稿SHA及明确修改范围，修正后仍经过正常正文、Reader、评分、标签、来源和发布审查。真实审查与图片证据必须绑定最终页面字节，不能改完整性要求、手填成功或伪造模型审查记录。

独立审查的 `files` 只记录文章 Markdown 的真实语义与逐图审查；相同路径和内容 SHA 的原通过页使用真实 `cacheReuse`。混合生成清单中的引用资料、词表及受控论文图另记 `machineAssets`，签发和推送时从正式来源及已审引用页重建核验，最终发布凭证仍覆盖完整清单。站内原图地址只接受当前清单中路径、字节 SHA 均匹配的受控论文图，不接受一般相对地址。它们不需要也不能伪造人工审查身份，详见[凭证格式](../docs/data-format.md#审查记录与远端发布)。

兼容测试通过 `npm run test:compat` 运行；完整验收仍是 `npm run verify`，会同时运行三流程和旧记录核验测试。

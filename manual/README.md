# 旧记录核验与独立人工审查

整批 Manual v5/v6/shadow 写作、任务分派、spec 和 records 生产已退役。新任务统一使用 [日更、会议与历史三流程](../docs/three-workflows.md)。先按 [正常批次轮次](../docs/three-workflows.md#全批轮次与失败集合) 完整处理选定集合，后续只续可重试失败项；只有多轮后剩下少量顽固论文且用户已明确授权时，才进行受控修正或独立审查，保留真实来源、原稿、费用和失败记录。`manualHandoff` 仅给出建议，不自动取得权限或增加请求额度。

本目录保留 `analysis-contract.js`、正式数据验证和发布器实际调用的旧来源、作者策略、签名、正文与教程合同核验模块。旧合同 Prompt 已从工作树移除，核验时通过受控 Git 索引取回原字节并核对原声明 SHA，不补签旧结果；两份冻结的编辑依据文件继续保留原字节，不能改写。

### 现在怎样阅读本目录

学习当前论文解读的写法，先读[共同写作约定](../docs/writing-guide.md)和[Reader 写作与来源要求](../docs/reader-writing.md)。术语首次解释实际作用，再使用准确名称；概念、计算、比较条件和图表要能连成完整论证，段落间留空行，语气朴实平和。受控修订的具体范围与预算仍按[Reader 恢复](../docs/reader-explicit-retry.md)核验。

`docs/editorial-reference-contract.md` 和 `docs/editorial-reference-contract-v2.md` 是旧记录绑定的冻结协议证据。里面的“当前”、长度、章节和任务角色须按其原版本理解，不能推广为现行 Reader 规则，也不表示旧整批 Manual 写作入口重新开放。现代导读另作导航，不复制一份新旧混杂的第三协议，不修改原文件 SHA 或旧凭证。

新建独立审查必须实际配置 `gpt-6.1-sol`、`high`，使用 v4 声明及 `manual-agents-sol-high-v2`；逐页记录真实子代理身份，不能仅填写模型名。旧 `gpt-5.6-terra/high` 声明只用于读取原记录。规则以 `scripts/manual_agent_policy.py` 为准，不改变三流程论文分析所配置的 Muse 模型。

独立单页审查仍使用以下共享补救入口：

```bash
npm run blog:manual-plan -- --date YYYY-MM-DD
npm run blog:manual-attest -- --date YYYY-MM-DD ...
npm run blog:manual-review -- --date YYYY-MM-DD ...
```

参数及审查材料以对应程序的解析器和当前页面生成清单为准；上述省略号须补齐实际参数。人工内容修正须绑定本篇已核验来源、原失败稿SHA及明确修改范围，修正后仍经过正常正文、Reader、评分、标签、来源和发布审查。真实审查与图片证据必须绑定最终页面字节，不能改完整性要求、手填成功或伪造模型审查记录。

独立审查 v4 的 `files` 只记录文章 Markdown 的真实语义与逐图审查；相同路径和内容 SHA 的原通过页使用真实 `cacheReuse`。混合生成清单中的引用资料、词表及受控论文图另记 `machineAssets`，签发和推送时从正式来源及已审引用页重建核验，最终发布凭证仍覆盖完整清单。站内原图地址只接受当前清单中路径、字节 SHA 均匹配的受控论文图，不接受一般相对地址。它们不需要也不能伪造人工审查身份，详见[凭证格式](../docs/data-format.md#审查记录与远端发布)。

兼容测试通过 `npm run test:compat` 运行；完整验收仍是 `npm run verify`，会同时运行三流程和旧记录核验测试。

# Audio Paper Digest 操作手册

只维护日更、官方会议和历史博客更新三条生产流程。执行限制见 [AGENTS.md](AGENTS.md)，实际代码与 Prompt 对应见 [三流程表](docs/three-workflows.md)，配置参数见 [安装配置](docs/setup.md)。

## 运行前

1. 核对 `pwd`，统一工作区为 `/Users/francis7999/code/github_repos/audio-paper-digest`，执行 `npm run workspace:role -- status`；角色保持 `daily`。历史操作通过已配置跨角色开关运行，不进入废弃工作区。
2. Node/Python/依赖有效，项目 `.env` 0600，主副模型按项目配置统一 `muse-spark-1.3-contributor`，Muse/arXiv强制项目HTTP CONNECT。
3. 确认真实博客仓库与目标页面没有人工修改冲突，检查其他生成、审查与发布进程，三流程错峰运行。
4. 所有脚本、检查和测试在沙箱外执行，不绕过环境、角色或来源检查，不把 `data/`、日志、缓存、密钥纳入Git。

## 批次与失败恢复顺序

先让本次选定论文全部按正常流程处理，等整轮结果保存后，再只处理仍可重试的失败集合；默认最多 3 轮。通过当前资格核验的成功项保留，原来源、阶段检查点、Reader 草稿与费用沿用。并发和批次轮数不增加单阶段或 Reader 的原预算；运行级故障和温和停止都会阻止新轮。

多轮后只剩少量顽固项，才进行受控人工修正：核对真实来源、原失败稿、具体反馈和修改范围，再交回正常校验及博客审查。`manualHandoff` 只报告建议，不改状态或授予新请求额度。共享参数与三流程边界见 [批次规则](docs/three-workflows.md#全批轮次与失败集合)，有界付费追加见 [Reader 恢复](docs/reader-explicit-retry.md)。

## 1. 日更

```bash
npm run digest:prepare -- YYYY-MM-DD
# 仅用户已明确取消视觉时：npm run digest:prepare -- YYYY-MM-DD --no-visuals
# digest:api 完全等价
```

仅北京时间当天允许从抓取开始。默认入口要求实际遇到各来源以前获取过的论文：保留已核验的原窗口，向前重叠覆盖旧编号及时间见证，完整处理每页与窗口后才进入模型流程；缺完整旧证明、时间漂移或未遇见证须停止，详见 [抓取边界](docs/daily-fetch-boundary.md)。入口执行候选抓取、关键词预筛、LLM筛选、当次官方HTML/PDF封存、分析、Reader、评分、标签、生成、审查与推送；最后继续完成部署、网页及视觉验收。

当次封存位于 `data/runtime/daily-fresh-source-runs/<runId>/sources/<arxivId>/generation-000001/`；分析只读其中TXT、PDF、元数据和清单。图片仅在当前调用的系统临时目录准备。来源缺失或SHA不符须在模型请求前停止。

```bash
npm run deep -- --date YYYY-MM-DD
npm run batch
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader
./run-daily-digest.sh YYYY-MM-DD --from generate
./run-daily-digest.sh YYYY-MM-DD --from review
./run-daily-digest.sh YYYY-MM-DD --from push
```

日更恢复命令不重新抓取历史日期，也不补建来源或读取旧缓存。日更分析和 Reader 刷新按上述批次轮次恢复；Reader 刷新未传 `--concurrency` 时使用配置并发，默认5，显式范围1–60；总轮数默认3，可用 `--rounds N` 覆写为1–10。Reader 只续明确可重试项，来源计划、运行级或存储故障停止新派发。显式追加有限付费重试须使用绑定当前来源、失败草稿与额度的清单，见 [恢复预算](docs/reader-explicit-retry.md)。人工修正只能使用已授权、来源绑定的受控恢复入口；不得把失败伪装成成功、清零费用或重试次数。

`reanalyze` 是显式强制全量重分析，会保留归档并停用旧候选；本次每篇只在首次准备时执行获准的重置，后续失败轮继续原候选和预算，选定重分析同样不按轮重复重置。普通恢复优先同入口和原稿。

## 2. 官方会议

```text
conference:acquire → conference:discover → 全文证据与每会筛选
  → conference:process → conference:publish:generate
  → conference:publish:review → conference:publish:push
  → conference:publish:verify
```

参数、官方会议来源、账本、导入、并发、来源升级与断点恢复见 [会议工作流](docs/conference-workflow.md)。唯一分析入口是 `conference:process`，内部调用公共 `analysis-engine.js`，不再提供独立execution/analyze/postprocess旧CLI。

论文必须有真实会议身份、官方PDF、来源SHA及能力记录。只有PDF时不能推断HTML DOM能力，不为会议补造arXiv ID。图像/公式仍按真实PDF像素核验。页面及JSON/BibTeX/RIS/上下文使用同一展示与导出核心，缺失摘要或公开URL如实标示。

## 3. 历史博客更新

```text
history:inventory / conference-local-sources → history:inputs
  → conference-projections → history:plan → history:sources
  → history:metadata → history:run → history:aggregate
  → history:publication: plan → generate → review → publish → status
```

完整参数见 [历史重写](docs/history-rewrite.md)与[独立历史发布](docs/history-direct-publication.md)。历史按冻结页面范围去重，同篇只分析一次；每轮arXiv重新获取官方TXT/PDF/运行元数据/清单，保留的会议元数据和PDF必须SHA核验。旧分析、旧博客、旧图片不进入写作输入。

独立发布要求完整来源/页面覆盖、当前Git基线、审查与精确差异证明。`publish --apply` 统一在共享博客锁内激活、提交、推送和OID验证。禁止用旧 `activate --apply` 绕过凭证。

暂停后 `history:resume -- --plan ...` 继续当前直接计划；旧已存在来源任务通过 `history:resume -- status|analyze --run-id ...` 恢复，不能新建旧任务、重新获取来源或重置预算。旧状态适配仅为已有断点核验，不是另一条生产链。

ICML/OpenReview替代PDF默认拒绝；唯一用户授权例外 `conference:icml:2026:openreview-forum-id:n1mAjfRDZ6` 仍核验固定SSRN标题、作者、DOI、获取凭证与PDF SHA，必须说明非camera-ready；不可推广。

## 共享内容与Prompt

三条流程共用 `analysis-engine.js`、`deep-analyzer.js`、当前Prompt登记、Reader/评分/标签与来源守卫。正式分析13个一级标题用于机器解析；Reader使用 `beginner-researcher-v3` 与 `api-reader-source-bindings-v4`，要求12–18节、5000–18000中文字、4–10组机制术语解释。

表格单元格对应原DOM或完整数字/单位引文，公式由结构化原TeX写入；作者机构逐项绑定来源，资源宣称与当前可达状态/类型一致。八维评分按文档类型判断，同一缺陷不重复扣分，总分代码重算封顶10。当前标签必须中文首选且含明确主任务/主方法，既定英文专名须有中文别名。

当前Prompt路径以 `scripts/lib/prompt-text-versions.js` 为准，读取第一个围栏代码块。旧提示词正文不再保存在工作树；`scripts/lib/git-prompt-evidence-index.json` 只登记原路径、Git blob OID 和整文件 SHA。旧记录通过受控读取器从 Git 取回原字节，复核整文件及首围栏模板 SHA，并保留原声明、来源、检查点和付费记录；缺失或不符就停止，不能用当前正文补签旧结果。新请求只读取当前登记的 18 份 Prompt。新共享代码变化进入传递依赖指纹，不靠手工漏项清单。

## 审查、发布与完成

日更发布顺序：

```bash
npm run blog:generate -- --date YYYY-MM-DD
npm run blog:review -- --date YYYY-MM-DD
npm run blog:push -- --date YYYY-MM-DD
```

审查只读最终文件，逐页通过记录按路径和内容SHA复用；当前批次仍执行程序与Hugo检查并生成新凭证。发布器变化后重新生成，但不强制重审字节未变页面。审查Git基线、远端身份、来源、页面清单或凭证不符必须阻断。

普通内容拒稿先保存审计并继续本批其余页面，最后汇总阻断；服务、存储、字节变化或凭证损坏停止新派发并等待在途结果。修正后再正常审查，失败项不能写通过凭证；分析轮次参数不授权同次审查反复请求拒稿页。

推送仅提交凭证允许的精确差异，并核对远端main OID。宣告完成前，还须确认对应提交或保留本批已审字节的后续提交已成功build/deploy，逐页HTTP200、正式URL与标题一致，并保存核验记录。

视觉只在远端验证后规划。实际生成由内置image_gen完成，项目脚本只规划/登记/核验；调用前用 `visual:prepare` 输出的绝对参考路径，逐图目检后 `record --qa-attested true`。只有用户明确取消且记录仍有效的本次发布豁免，才省略视觉。

```bash
npm run digest:status -- --date YYYY-MM-DD
npm run verify
```

最后推送、图片登记或豁免后重读状态。状态报告不自动检查部署与网页；不能据其complete单独宣告上线。`verify` 执行固定Hugo、三流程和旧记录兼容全部JS/Python测试、语法和只读数据检查，只有CI/干净检出显式允许空数据。

整批Manual作者任务、旧拆分分析链和社交渠道发布已退役；单篇独立审查及旧记录来源/签名/正文核验留在 [兼容目录](manual/README.md)。

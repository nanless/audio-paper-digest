# Audio Paper Digest

统一处理语音、音乐、音频论文，只维护日更、官方会议和历史博客更新三条流程。

## 你会得到什么

基于真实全文与来源证据的中文长文、八维评分、作者机构、资源状态、引用资料和博客页面。三条流程共享分析引擎、Reader、当前 Prompt、标签、正文审查和展示组件。

## 默认行为

默认路线是 LLM/API。日更获取当天官方 arXiv/HuggingFace 候选；会议获取官方会议版本；历史更新按冻结页面范围准备来源并重写。来源适配、页面范围与发布凭证保持各自身份。

整批 Manual/人工流程和微信、飞书、小红书发布已退役。受控单篇人工修正、独立人工审查仍是三条流程的失败恢复能力；`manual/` 仅保留旧记录核验和独立审查，不再提供另一条写作流程。

## 5 分钟开始

1. 使用本工作区 `/Users/francis7999/code/github_repos/audio-paper-digest`，先核对 `npm run workspace:role -- status`。
2. 安装 Node 与 Python 依赖，配置项目 `.env`，步骤见 [安装与配置](docs/setup.md)。
3. 主、副模型统一使用项目指定的 `muse-spark-1.3-contributor`，Muse 和 arXiv 必须经项目 HTTP CONNECT 代理。
4. 确认真实博客仓库及工作区无目标页面冲突，再选择下面的流程。

## 核心命令

| 任务 | 入口 | 操作说明 |
|---|---|---|
| 北京时间当天日更 | `npm run digest:prepare -- YYYY-MM-DD` | [操作手册](SKILL.md) |
| 已发布完整日批的呈现更新 | `npm run blog:generate -- --date YYYY-MM-DD --republish UUID`，再正常审查、推送 | [受控重发布](docs/data-format.md#同来源同分析的日批重发布) |
| 官方会议候选获取与筛选 | `npm run conference:acquire`、`conference:discover`、`conference:filter:run` | [会议流程](docs/conference-workflow.md) |
| 会议全文分析、Reader 和私有页面 | `npm run conference:process -- --apply ...` | [会议流程](docs/conference-workflow.md) |
| 已有完整会议的页面更新 | 先核对原 process 并重暂存完整单篇与汇总；未发布 ID 再正常生成、审查和推送 | [会议页面恢复与已发布边界](docs/conference-workflow.md#已有完整会议只更新页面) |
| 历史来源准备、计划、重写 | `npm run history:inputs`、`history:plan`、`history:sources`、`history:run` | [历史更新](docs/history-rewrite.md) |
| 历史生成、审查、发布 | `npm run history:publication -- plan\|generate\|review\|publish\|status ...` | [历史发布](docs/history-direct-publication.md) |
| 完整离线验证 | `npm run verify` | [维护与验证](docs/maintenance.md) |

命令参数以 `package.json` 和各入口解析器为准；示例中的省略号须按对应流程文档补齐，不是可直接运行的参数。

完整会议的旧稿先统一走正常后处理，失败集合在显式 `conference:migrate-process --retry-failed` 恢复中分轮处理。保留原父稿和费用；上游合格时刷新 Reader，资源状态影响评分时先正常复核评分，上游或旧模型输入有问题时正常完整分析，成功项不重复付费。具体参数与中断恢复见[会议页面更新](docs/conference-workflow.md#已有完整会议只更新页面)。

会议 `conference:process` 外层并发默认1、`conference:migrate-process` 默认3，均可显式设置 `--concurrency N`（1–60）。Reader 仍受原 `PD_API_READER_CONCURRENCY` 限制，正常完整分析修订最多占用原主分析配置下的3槽，每篇内部并发仍为1；调度并发不改变来源计划、模型、请求额度或整批轮次。

会议沿用共享摘要修复、Reader 和资源检查，同时保留真实会议身份与封存来源上下文。已保存的新合格稿先复验再决定是否请求模型，不能因接口修复重复付费，也不能用继承父稿掩盖新失败。

PDF 表格证据也通过来源适配进入同一 Reader：只有原表范围、表头或明确表注、行列及单位可以唯一对应时，程序才派生可重放证明。会议和历史 PDF 不伪装成日更 HTML DOM；原表未注明的单位不能从别处借用。详见[共享来源边界](docs/three-workflows.md)。

旧付费候选可在硬禁新模型请求的临时副本中正常复验，通过完整资格才保存；原次数和失败继续保留。会议固定子运行额度与批次重试窗口分别核验，代码升级不自动增加付费许可。

## 怎样才算完成

正式分析、来源、评分和标签核验通过；最终页面通过程序、正文、图片和 Hugo 审查；精确差异推送后验证远端 `main`；对应部署成功，逐页 HTTP 200、正式地址和标题一致，并保留记录。视觉任务须完成，或存在与本次发布绑定的用户明确豁免。

用户明确选择 `--no-visuals` 时，发布后只建立用于绑定豁免的任务清单，不准备图片或调用生图。封存来源的临时图片模式仅核对已签图片身份（包括内联 SVG），参考图片列表为空；规划失败按[恢复说明](docs/troubleshooting.md#11-视觉-pending-或-record-失败)处理，不回滚已验证的博客发布。

`digest:status` 只核验数据与已存发布凭证，不能代替网站部署和页面检查。

日更抓取会从核验过的上次记录派生各来源旧论文见证，向前重叠补抓，并实际核对旧编号及时间；完整处理每页和覆盖窗口后才进入筛选与分析。已获取但未发布的论文仍可参与补更，只有正式已发布页用于去重。详见 [抓取边界](docs/daily-fetch-boundary.md)。

## 失败后从哪里继续

首轮先让本次选定论文全部走正常流程，再只对可重试失败集合继续正常轮次，默认最多 3 轮。通过当前核验的成功项保留，原来源、草稿、次数和费用继续沿用。日更用 `deep`、`batch` 或批量 Reader 刷新；会议用原 `conference:process`；历史用同计划 `history:run`，暂停后先 `history:resume`。会议跨调用的 `--retry-failed` 仍是原重试窗口的显式恢复选项。

定向事实纠错会在请求前保存已核验的来源与反馈义务。保留的旧成功正文不能抵消本次未完成的纠错或最新失败；只有正常完整检查真正通过才清除失败状态，未完成项继续阻断发布，不自动增加请求额度。

Reader-only 完成核验只读重放真实父子反馈的签发上下文；恢复旧父阶段前须有完整主检查点，保存前保护原主文、摘要、评分和标签。失败保留原上游和真实诊断，详见[反馈恢复边界](docs/reader-explicit-retry.md#已完成主文的独立-reader-事实反馈)。

整轮后先区分正文缺陷、校验误报和额度耗尽。共性误报须用封存原文与真实失败稿复现，在生产任务停止后统一修复并运行正反回归，再继续失败集合。修改校验实现不新增付费额度，也不能让尚未通过完整检查的稿件直接发布；详见 [Reader 检查与恢复](docs/reader-writing.md)。

博客审查也先完成整批页面，再处理失败集合。已通过且路径与内容 SHA 不变的页面永久复用原结果；修正审查协议后，只有保存的旧协议与当前协议均合法且确实不同的内容失败页进入正常重审。原失败和费用记录保留，不为误报改动正确事实，也不手填通过。详见 [发布数据与审查凭证](docs/data-format.md)。

独立人工审查将文章语义与受控资产核验分开，最终仍覆盖完整发布清单；引用资料、词表和论文图不能省略或伪装成人工已审。新审查须实际使用 `gpt-6.1-sol/high` 并登记真实 v4 身份，见[独立审查边界](manual/README.md)。图像审查按已核验来源区分送审位置、DOM 条目与作者印刷图号，保留真实图文冲突的检查。

多轮后只剩少量顽固失败，才按真实失败稿和来源做受控人工修正，并重新通过正常校验及发布审查；不能把失败手工标成成功。日更人工清单须覆盖完整失败集合，每篇限定原节点，数量扩展只能依据原封存大批次且硬限15篇，详见 [人工修正约束](docs/reader-explicit-retry.md#少量顽固稿的来源绑定人工修正)。轮次、预算和人工建议的区别见 [统一批次恢复](docs/three-workflows.md#全批轮次与失败集合)。已签名日更稿沿用同一显式入口：v1 只修确定性中文术语，v2 只修受拒原句内的精确有界范围；都保留原退休付费稿和完整父稿 CAS、重放真实修改历史、不增加模型请求，见[签名稿修正](docs/reader-explicit-retry.md#已签稿的有界事实修正-v2)。

历史日期不从日更抓取阶段重跑；不手改检查点，不自动切换模型或写作流程。

## 架构概览

```text
日更来源 ─┐
会议来源 ─┼→ 来源封存/身份适配 → 公共分析引擎 → Reader/评分/标签
历史范围 ─┘             → 共享展示与引用资料 → 生成 → 审查 → 推送 → 上线核验
```

[三流程代码、Prompt 和文档对应表](docs/three-workflows.md)列出共享核心与必要适配。工作树只保留当前 18 份 Prompt；旧正文按原 SHA 从 Git 历史读取，核验已付费断点，保留原声明和费用记录。

仅修核心摘要时，公共选定论文入口接受独立 `coreFeedbackFiles`：先在锁内保存来源绑定的原反馈，再只修该节，逐字保护其余十二节。后续评分和必要 Reader 正常复核；普通续跑仍沿用同一范围，保留原历史与费用。已清理临时检查点的完成稿先核验原完整父稿与来源，仅在核心恢复中保留已完成上游，不伪造历史中间稿；详见[恢复说明](docs/reader-explicit-retry.md)。

三条流程的标签统一采用[新版研究方向目录](https://nanless.github.io/audio-paper-digest-blog/tags/)的386项九维体系。总目录完整保留；文章只显示实际所选标签及其父级路径，父级不算额外命中，也不展示空分类或兄弟方向。词表升级、旧记录只读核验及站点快照同步见[标签规则](docs/tag-display-policy.md#三条流程共用的目录与呈现)。

源Markdown保留多级分类块供审查和离线阅读；单篇网页已有经核验的页头分类时只显示一次，汇总仍逐篇显示，缺失或异常边界标记不能成为删除Reader正文的理由，见[页面呈现与更新规则](docs/tag-display-policy.md#已发布页面切换到当前呈现)。

## 文档导航

- [AGENTS.md](AGENTS.md)：执行边界、来源与发布规则。
- [SKILL.md](SKILL.md)：三流程操作入口和恢复要求。
- [文档索引](docs/README.md)：配置、Reader、标签、来源和故障处理。
- [脚本索引](scripts/README.md)：公共模块、入口与检查点。

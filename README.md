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
| 官方会议候选获取与筛选 | `npm run conference:acquire`、`conference:discover`、`conference:filter:run` | [会议流程](docs/conference-workflow.md) |
| 会议全文分析、Reader 和私有页面 | `npm run conference:process -- --apply ...` | [会议流程](docs/conference-workflow.md) |
| 历史来源准备、计划、重写 | `npm run history:inputs`、`history:plan`、`history:sources`、`history:run` | [历史更新](docs/history-rewrite.md) |
| 历史生成、审查、发布 | `npm run history:publication -- plan\|generate\|review\|publish\|status ...` | [历史发布](docs/history-direct-publication.md) |
| 完整离线验证 | `npm run verify` | [维护与验证](docs/maintenance.md) |

命令参数以 `package.json` 和各入口解析器为准；示例中的省略号须按对应流程文档补齐，不是可直接运行的参数。

## 怎样才算完成

正式分析、来源、评分和标签核验通过；最终页面通过程序、正文、图片和 Hugo 审查；精确差异推送后验证远端 `main`；对应部署成功，逐页 HTTP 200、正式地址和标题一致，并保留记录。视觉任务须完成，或存在与本次发布绑定的用户明确豁免。

`digest:status` 只核验数据与已存发布凭证，不能代替网站部署和页面检查。

日更抓取会从核验过的上次记录派生各来源旧论文见证，向前重叠补抓，并实际核对旧编号及时间；完整处理每页和覆盖窗口后才进入筛选与分析。已获取但未发布的论文仍可参与补更，只有正式已发布页用于去重。详见 [抓取边界](docs/daily-fetch-boundary.md)。

## 失败后从哪里继续

首轮先让本次选定论文全部走正常流程，再只对可重试失败集合继续正常轮次，默认最多 3 轮。通过当前核验的成功项保留，原来源、草稿、次数和费用继续沿用。日更用 `deep`、`batch` 或批量 Reader 刷新；会议用原 `conference:process`；历史用同计划 `history:run`，暂停后先 `history:resume`。会议跨调用的 `--retry-failed` 仍是原重试窗口的显式恢复选项。

定向事实纠错会在请求前保存已核验的来源与反馈义务。保留的旧成功正文不能抵消本次未完成的纠错或最新失败；只有正常完整检查真正通过才清除失败状态，未完成项继续阻断发布，不自动增加请求额度。

整轮后先区分正文缺陷、校验误报和额度耗尽。共性误报须用封存原文与真实失败稿复现，在生产任务停止后统一修复并运行正反回归，再继续失败集合。修改校验实现不新增付费额度，也不能让尚未通过完整检查的稿件直接发布；详见 [Reader 检查与恢复](docs/reader-writing.md)。

博客审查也先完成整批页面，再处理失败集合。已通过且路径与内容 SHA 不变的页面永久复用原结果；修正审查协议后，只有保存的旧协议与当前协议均合法且确实不同的内容失败页进入正常重审。原失败和费用记录保留，不为误报改动正确事实，也不手填通过。详见 [发布数据与审查凭证](docs/data-format.md)。

多轮后只剩少量顽固失败，才按真实失败稿和来源做受控人工修正，并重新通过正常校验及发布审查；不能把失败手工标成成功。日更人工清单须覆盖完整失败集合，每篇限定原节点，数量扩展只能依据原封存大批次且硬限15篇，详见 [人工修正约束](docs/reader-explicit-retry.md#少量顽固稿的来源绑定人工修正)。轮次、预算和人工建议的区别见 [统一批次恢复](docs/three-workflows.md#全批轮次与失败集合)。 已签名成功稿的确定性中文术语尾修使用独立的显式受控入口，保留原退休付费稿并按完整父稿 CAS 重验，见[签名稿术语尾修](docs/reader-explicit-retry.md#已签名日更稿的术语尾修)。

历史日期不从日更抓取阶段重跑；不手改检查点，不自动切换模型或写作流程。

## 架构概览

```text
日更来源 ─┐
会议来源 ─┼→ 来源封存/身份适配 → 公共分析引擎 → Reader/评分/标签
历史范围 ─┘             → 共享展示与引用资料 → 生成 → 审查 → 推送 → 上线核验
```

[三流程代码、Prompt 和文档对应表](docs/three-workflows.md)列出共享核心与必要适配。工作树只保留当前 18 份 Prompt；旧正文按原 SHA 从 Git 历史读取，核验已付费断点，保留原声明和费用记录。

## 文档导航

- [AGENTS.md](AGENTS.md)：执行边界、来源与发布规则。
- [SKILL.md](SKILL.md)：三流程操作入口和恢复要求。
- [文档索引](docs/README.md)：配置、Reader、标签、来源和故障处理。
- [脚本索引](scripts/README.md)：公共模块、入口与检查点。

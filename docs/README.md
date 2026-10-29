# 文档导航

这里既有网站生产流程，也有两端应用的使用和验收说明。先按你要做的事选择入口，不必先通读所有协议。日更、官方会议和历史博客更新是三条生产流程，默认调用 LLM/API；打开已发布内容和恢复个人资料不会自动重跑这些流程。

## 第一次使用

只使用应用，先读[Mac 使用说明](../apps/macos/README.md)或[Android 使用说明](../apps/android/README.md)，不必配置生产项目的 `.env`。维护网站时，先读[项目首页](../README.md)选择任务，再按[安装与配置](setup.md)准备环境。[操作手册](../SKILL.md)给出执行顺序，[AGENTS.md](../AGENTS.md)列出不能绕过的来源、预算与发布规则。

| 你想了解什么 | 阅读位置 |
|---|---|
| 三条流程如何共用分析、Reader 和发布能力 | [三流程与共享核心](three-workflows.md) |
| 三条流程的来源、共享算法、恢复与发布责任 | [流程与恢复规则](workflow-sharing-plan.md) |
| Mac 阅读、PDF 对照、个人研究与 Zotero 存档 | [Mac 使用说明](../apps/macos/README.md)；设计背景见[工作台规划](desktop-research-workbench-plan.md) |
| Mac 应用的功能与实现范围 | [需求说明](mac-app-requirements.md)与[构建及使用说明](../apps/macos/README.md) |
| Mac 的测试范围和验收项目 | [验证说明](mac-app-validation.md)、[验收矩阵](mac-app-acceptance.md)、[审查说明](mac-app-review-log.md) |
| Mac 数据接入与 Zotero 归档 | [网站数据适配](mac-app-data.md)与[Zotero 接口](mac-app-zotero.md) |
| 坚果云同步、版本续传与资料恢复 | [云端资料与备份](mac-app-cloud.md) |
| Mac ZIP/DMG、校验和与发行步骤 | [发行准备](mac-app-release.md) |
| Android 使用、构建与跨端功能 | [功能说明](android-app-plan.md)、[构建说明](../apps/android/README.md)与[功能映射](android-feature-parity.md) |
| Android 的 Zotero、坚果云与 Mac 资料互通 | [Zotero 接入](android-zotero-research.md)、[完整备份](android-cloud-contract.md)与[跨端格式](android-cloud-portable-fixtures.md) |
| 两端如何读取网站目录和已发布页面 | 当前使用[网站数据适配](mac-app-data.md)；[静态数据接口](desktop-data-contract.md)中的 `desktop/v1` 是后续接口设计 |
| Mac 界面、单栏阅读与 PDF 双栏 | [界面设计](macos-interface-design-research.md) |
| Reader、SHA、CAS、检查点和凭证是什么 | [常见术语](writing-guide.md#术语先解释再统一称呼) |
| 文档与论文讲解怎样写得清楚 | [写作约定](writing-guide.md) |

## 运行一项任务

| 任务 | 操作说明 |
|---|---|
| 当天日更、日更阶段恢复 | [操作手册](../SKILL.md#1-日更)、[补抓边界](daily-fetch-boundary.md)、[锁内来源检查](locked-source-validation.md) |
| 官方会议获取、筛选、分析、发布 | [会议流程](conference-workflow.md) |
| 从原文重新分析历史博客并保留 URL | [历史来源与重写](history-rewrite.md) |
| 历史结果的最终审查、发布和网页验收 | [历史发布](history-direct-publication.md) |
| 下载原文、导读和引用资料 | [博客阅读资料](blog-reading-tools.md) |

## 处理失败与旧记录

先保留失败、来源、检查点和费用。正常分析先完成整轮，再仅续可重试失败集合；不会因为增加轮数而自动获得新的 Reader 额度。

| 问题 | 权威说明 |
|---|---|
| 批次轮数、失败集合与人工接手建议 | [共享批次规则](three-workflows.md#全批轮次与失败集合) |
| 停止正在运行的任务 | [停止说明](analysis-stop.md) |
| 按报错定位恢复入口、费用落盘故障与本地冷核超时 | [故障排查](troubleshooting.md)、[异常响应记录](data-format.md#请求开始终态与异常响应保全) |
| Reader 原付费稿核验、有界追加及已授权修正 | [Reader 恢复](reader-explicit-retry.md) |
| 会议原窗口耗尽后，按持续授权登记剩余失败集合 | [会议后续窗口](conference-workflow.md#原额度耗尽后的独立付费恢复)、[记录格式](data-format.md#会议独立追加窗口) |
| 会议博客完整审查后有正文、格式或图片拒稿 | [正常 Reader 维护与独立出版视图](conference-workflow.md#博客拒稿后的正常-reader-维护)、[维护记录](data-format.md#会议博客审查后的-reader-维护记录) |
| 会议只做统一后处理、认证来源事实的零请求纠正 | [来源纠正](conference-workflow.md#认证来源事实的零请求纠正)；资源与核心清单分开，原失败、次数及费用保留 |
| 旧数据、旧协议与旧提示词如何核验 | [兼容规则](compatibility.md)、[旧记录与独立人工审查](../manual/README.md) |

## 维护代码与查阅协议

| 要修改或核对什么 | 权威说明 |
|---|---|
| 命令、入口与公共模块 | [脚本索引](../scripts/README.md)、[三流程对应表](three-workflows.md) |
| 修改、定向检查、完整验证和提交 | [维护指南](maintenance.md) |
| 当前 18 份提示词与旧记录原字节核验 | [Prompt 索引](../prompts/README.md)、[Prompt 修改](maintenance.md#prompt-修改) |
| Reader 的结构、表格、公式与解释要求 | [Reader 写作](reader-writing.md) |
| 数据、字段与发布凭证 | [数据格式](data-format.md) |
| 三流程标签、多级路径、旧签名与站点版本同步 | [统一标签规则](tag-display-policy.md#三条流程共用的目录与呈现) |
| 词表的设计背景与历史决策 | [标签设计](tag-system-design.md) |
| 日更耗时观测、性能诊断与优化范围 | [性能说明](daily-performance.md) |
| 代码清理、兼容保留、文档与提示词维护 | [维护约定](repository-maintenance-review.md) |

完成验收包括对应发布提交的部署、全部目标页面及用户本次要求的视觉范围。状态报告和 Git 推送分别核验；省略视觉须登记与当前发布绑定的有效豁免。

- [新人上手：执行顺序与故障入口](onboarding.md)

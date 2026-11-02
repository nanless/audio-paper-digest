# 文档导航

**中文** · [English](README.en.md)

这里收录论文速递网站、内容生产流程和两端阅读应用的说明。先按要完成的任务选择入口，再读相关细节；不必先通读全部协议。文档中的命令、来源和发布限制以实际程序与 [AGENTS.md](../AGENTS.md)为依据。

## 第一次接触项目

[项目导读](project-guide.md)先解释论文来源、分析、解读、博客和阅读应用的关系。[项目首页](../README.md)帮助选择任务，[新人上手](onboarding.md)给出一次当天日更的准备、运行、结果与故障入口。

只阅读内容时，使用[网站](https://nanless.github.io/audio-paper-digest-blog/)或安装 [Mac](../apps/macos/README.md)、[Android](../apps/android/README.md)工作台，不需要配置生产项目的 `.env`。日更、官方会议和历史博客更新是三条默认调用语言模型服务（LLM/API）的内容生产流程；阅读已有内容和恢复个人资料不会自动运行它们。

遇到陌生简称，可查[术语说明](writing-guide.md#术语先解释再统一称呼)。编辑文档时，结合[把技术写清楚](../skills/clear-technical-writing/SKILL.md)与[项目写作约定](writing-guide.md)，保留真实条件、证据和执行范围。

## 阅读论文与使用工作台

| 想做什么 | 阅读位置 |
|---|---|
| 下载原论文、导读和引用资料 | [网页阅读资料](blog-reading-tools.md) |
| 安装并使用 Mac 应用 | [Mac 使用说明](../apps/macos/README.md) |
| 安装并使用 Android 应用 | [Android 使用说明](../apps/android/README.md) |
| 理解收藏、网站分类和时间分区 | [收藏说明](favorite-collections.md) |
| 比较两端功能和窗口适配 | [Android 功能映射](android-feature-parity.md)、[界面设计](macos-interface-design-research.md) |
| 理解个人研究与产品取舍 | [工作台规划](desktop-research-workbench-plan.md)，其中后续目标与当前实现分别说明 |

1.3.0 的分类浏览、两端界面、正式包、升级与公开下载范围，见[1.3.0 记录](workbench-1.3.0-review.md)。其他版本的验收保留各自的时间、环境和范围，不能据此推定当前包重新完成了全部真实服务测试。

### 查应用实现、备份与存档

| 主题 | 阅读位置 |
|---|---|
| Mac 功能要求 | [需求说明](mac-app-requirements.md) |
| Mac 数据读取和个人模型记录 | [网站数据与恢复](mac-app-data.md) |
| Mac Zotero 连接、归档与续传 | [Zotero 接口](mac-app-zotero.md) |
| Mac 云端版本备份与恢复 | [云端资料与备份](mac-app-cloud.md) |
| Mac 测试、逐项状态与验收 | [验证说明](mac-app-validation.md)、[验收矩阵](mac-app-acceptance.md)、[当前状态](mac-app-acceptance-status.md)、[审查说明](mac-app-review-log.md) |
| Mac 安装包和图标 | [发行准备](mac-app-release.md)、[图标说明](mac-app-icon-design.md)、[图标源资产](../apps/macos/Assets/README.md) |
| Android 产品与实现范围 | [功能说明](android-app-plan.md) |
| Android Zotero 与完整备份 | [Zotero 接入](android-zotero-research.md)、[完整备份](android-cloud-contract.md) |
| 跨端备份格式与实际验证 | [跨端格式](android-cloud-portable-fixtures.md)、[Android 验证](android-validation.md) |
| 客户端安全与许可 | [安全说明](client-security-audit.md)、[Android 许可清单说明](../apps/android/licenses.README.md) |
| 后续静态数据接口设计 | [desktop/v1 数据合同](desktop-data-contract.md)，当前并未部署该接口 |
| 两端共用的测试样稿与显示资源 | [样稿准备与使用边界](../prototypes/macos-research/README.md) |

## 运行一项内容生产任务

维护网站时，先按[安装与配置](setup.md)准备环境，再按[操作手册](../SKILL.md)进入对应流程。三条流程怎样调用共同代码、保存不同来源，见[三流程与共享核心](three-workflows.md)；责任与设计取舍见[流程维护说明](workflow-sharing-plan.md)。

| 任务 | 操作说明 |
|---|---|
| 当天日更与阶段恢复 | [日更操作](../SKILL.md#1-日更)、[补抓边界](daily-fetch-boundary.md)、[锁内来源核验](locked-source-validation.md) |
| 官方会议获取、筛选、分析与发布 | [会议流程](conference-workflow.md) |
| 从原文更新旧博客并保留地址 | [历史来源与更新](history-rewrite.md) |
| 历史结果的审查、发布和网页验收 | [历史发布](history-direct-publication.md) |
| 只更新完整日批的页面呈现 | [同来源同分析的重发布](data-format.md#同来源同分析的日批重发布) |

## 处理失败与旧记录

先保留失败、来源、阶段结果和费用。正常分析完成整轮后，才只续可重试的失败论文；增加外层轮数不自动增加解读写作的请求额度。

| 问题 | 说明与入口 |
|---|---|
| 批次轮数与人工接手建议 | [共享批次规则](three-workflows.md#全批轮次与失败集合) |
| 停止正在运行的分析 | [停止说明](analysis-stop.md) |
| 按报错查原因与继续方法 | [故障排查](troubleshooting.md) |
| 费用记录保存失败 | [请求开始、终态与异常响应](data-format.md#请求开始终态与异常响应保全) |
| 解读长文的原付费稿复验、追加窗口或人工修正 | [解读恢复](reader-explicit-retry.md) |
| 会议原窗口耗尽 | [会议后续窗口](conference-workflow.md#原额度耗尽后的独立付费恢复)、[记录格式](data-format.md#会议独立追加窗口) |
| 会议博客正文或图片被拒 | [正常解读维护](conference-workflow.md#博客拒稿后的正常-reader-维护)、[维护记录](data-format.md#会议博客审查后的-reader-维护记录) |
| 会议只做后处理或按真实来源零请求纠正 | [来源纠正](conference-workflow.md#认证来源事实的零请求纠正)，资源与核心清单分别核对 |
| 旧数据、旧协议和原提示词 | [兼容规则](compatibility.md)、[旧记录与独立人工审查](../manual/README.md) |

持续付费授权允许执行者登记必要后续窗口，原来源、次数和费用仍分别保留。旧来源核验、只读重放或历史审查记录，不能自行授予新的模型请求或发布权限。

## 修改代码、写作或查协议

| 想核对什么 | 阅读位置 |
|---|---|
| 当前命令、入口与公共模块 | [脚本索引](../scripts/README.md)、[三流程表](three-workflows.md) |
| 修改、验证、中文提交与推送 | [维护指南](maintenance.md) |
| 当前 18 份提示词和旧原字节 | [提示词索引](../prompts/README.md)、[提示词修改](maintenance.md#prompt-修改) |
| 解读长文的结构与来源要求 | [解读写作](reader-writing.md) |
| 怎样解释、分段、用图和维护双语 | [写作约定](writing-guide.md)、[写作 skill](../skills/clear-technical-writing/SKILL.md) |
| 字段、清单与发布凭证 | [数据格式](data-format.md) |
| 多级分类、旧签名与站点目录同步 | [统一分类规则](tag-display-policy.md#三条流程共用的目录与呈现) |
| 分类词表的设计背景 | [标签设计](tag-system-design.md) |
| 耗时测量与优化范围 | [性能说明](daily-performance.md) |
| 兼容保留与文档维护原则 | [维护约定](repository-maintenance-review.md) |

## 阅读历史评审记录

历史记录用于理解当时发现的问题、采用的修改和真实验证范围。它们不是另一套现行操作入口。

- 工作台版本：[1.1.0](workbench-1.1.0-review.md)、[1.2.1](workbench-1.2.1-review.md)、[1.3.0](workbench-1.3.0-review.md)。
- 工作台设计与使用：[2026年11月1日可用性评审](workbench-usability-review-20261101.md)。
- 公共流程与维护：[共享流程评审](shared-workflow-review.md)、[仓库维护说明](repository-maintenance-review.md)。

写作和文档维护直接使用[项目写作约定](writing-guide.md)、[技术写作方法](../skills/clear-technical-writing/SKILL.md)与[维护约定](repository-maintenance-review.md)。已经结束的逐文件整理报告保留在 Git 历史中，避免过时的路径、行号和检查计数混入现行指南。

## 什么时候可以报告完成

完成内容生产任务，还须核验对应提交的部署和全部目标页面。状态报告、Git 推送与网页上线分别判断。

日更持续遵循用户“以后不再生图”的要求，登记与当前发布绑定的有效豁免；原论文图仍正常核验和审查。只有用户另行明确改变要求，才执行该批次对应生图任务。
